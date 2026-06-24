/**
 * Unit tests for `server/game/expedition-tracker.ts`.
 *
 * Covers the BG-equivalent surface: createExpedition (success + every
 * validation rejection), joinExpedition (success + rejection paths),
 * completeExpedition / leaveExpedition / startReturn / cleanup, and the
 * read-side helpers (getExpedition, getActiveExpeditions,
 * getExpeditionsTargeting, getTotalAttackPower, checkExpiredExpeditions,
 * getStats).
 *
 * Uses small in-memory test doubles for `AsteroidRegistryLike`,
 * `StakeManagerLike`, and `CooldownManagerLike` so the tracker is
 * exercised end-to-end without dragging in any not-yet-ported subsystems.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AsteroidDefinition, ResourceType } from '../../config/asteroids.js';
import { CooldownManager } from '../../server/game/cooldowns.js';
import { ExpeditionTracker } from '../../server/game/expedition-tracker.js';
import type {
  AsteroidRegistryLike,
  GameLogger,
  StakeManagerLike,
} from '../../server/game/interfaces.js';
import type { AsteroidState, MinerGameState } from '../../server/game/types.js';
import { calculateAttackPower } from '../../server/game/types.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------- Test doubles ----------

function makeAsteroidDef(id: string, resource: ResourceType = 'gold'): AsteroidDefinition {
  return {
    id,
    name: `Asteroid ${id}`,
    resource,
    sector: 'Belt-A',
    position: { x: 0, y: 0, z: 0 },
    baseDiscoveryTimeMs: 60_000,
    baseRewardMultiplier: 1,
    description: `Test asteroid ${id}.`,
  };
}

function makeAsteroidState(id: string, resource: ResourceType = 'gold'): AsteroidState {
  return {
    definition: makeAsteroidDef(id, resource),
    activeMiners: new Set(),
    totalDrillPower: 0,
    totalStake: 0,
    currentDiscovery: 0,
    totalDiscoveries: 0,
    lastDiscoveryTime: null,
    difficulty: 1,
    target: '',
    incomingRaids: [],
    defenseBuff: null,
    attackDebuff: null,
    discoveryHeader: '',
    isStellarStrikeActive: false,
    syndicateMultiplier: 1,
    solarFlareMultiplier: 1,
    meteorDebuff: null,
  };
}

class FakeRegistry implements AsteroidRegistryLike {
  private readonly asteroids = new Map<string, AsteroidState>();
  private readonly immune = new Set<string>();
  public readonly addedRaids: Array<{ asteroidId: string; expeditionId: string }> = [];
  public readonly removedRaids: Array<{ asteroidId: string; expeditionId: string }> = [];

  addAsteroid(state: AsteroidState): void {
    this.asteroids.set(state.definition.id, state);
  }

  setImmune(asteroidId: string, immune: boolean): void {
    if (immune) this.immune.add(asteroidId);
    else this.immune.delete(asteroidId);
  }

  getAsteroid(asteroidId: string): AsteroidState | undefined {
    return this.asteroids.get(asteroidId);
  }
  hasRaidImmunity(asteroidId: string): boolean {
    return this.immune.has(asteroidId);
  }
  applyAttackDebuff(_asteroidId: string): void {}
  applyDefenseBuff(_asteroidId: string): void {}
  addIncomingRaid(asteroidId: string, expeditionId: string): void {
    this.addedRaids.push({ asteroidId, expeditionId });
    const a = this.asteroids.get(asteroidId);
    if (a) a.incomingRaids.push(expeditionId);
  }
  removeIncomingRaid(asteroidId: string, expeditionId: string): void {
    this.removedRaids.push({ asteroidId, expeditionId });
    const a = this.asteroids.get(asteroidId);
    if (a) a.incomingRaids = a.incomingRaids.filter((id) => id !== expeditionId);
  }
  updateAsteroidStake(asteroidId: string, stakeDelta: number): void {
    const a = this.asteroids.get(asteroidId);
    if (a) a.totalStake = Math.max(0, a.totalStake + stakeDelta);
  }
}

class FakeStakeManager implements StakeManagerLike {
  private readonly miners = new Map<string, MinerGameState>();
  private readonly stakes = new Map<string, number>(); // wallet:asteroid -> amount
  public readonly burnedBets: Array<{ wallet: string; asteroidId: string; amount: number }> = [];
  public readonly processedBets: Array<{ wallet: string; asteroidId: string; amount: number }> = [];
  public allowBets = true;

  setStake(wallet: string, asteroidId: string, amount: number): void {
    this.stakes.set(`${wallet}:${asteroidId}`, amount);
  }

  setMiner(wallet: string, state: Partial<MinerGameState> = {}): MinerGameState {
    const merged: MinerGameState = {
      walletAddress: wallet,
      homeStationAsteroidId: state.homeStationAsteroidId ?? null,
      activeAsteroidId: state.activeAsteroidId ?? null,
      currentExpeditionId: state.currentExpeditionId ?? null,
      totalStake: state.totalStake ?? 0,
      cooldowns: state.cooldowns ?? [],
      loyaltyDays: state.loyaltyDays ?? 0,
      homeStationJoinedAt: state.homeStationJoinedAt ?? null,
    };
    this.miners.set(wallet, merged);
    return merged;
  }

  getMinerState(walletAddress: string): MinerGameState {
    let m = this.miners.get(walletAddress);
    if (!m) m = this.setMiner(walletAddress);
    return m;
  }

  getDefensePower(_walletAddress: string, _asteroidId: string): number {
    return 0;
  }

  getStakeAtAsteroid(walletAddress: string, asteroidId: string): number {
    return this.stakes.get(`${walletAddress}:${asteroidId}`) ?? 0;
  }

  processBet(walletAddress: string, asteroidId: string, amount: number): boolean {
    if (!this.allowBets) return false;
    this.processedBets.push({ wallet: walletAddress, asteroidId, amount });
    return true;
  }

  burnBet(walletAddress: string, asteroidId: string, amount: number): void {
    this.burnedBets.push({ wallet: walletAddress, asteroidId, amount });
  }

  returnBetWithWinnings(): void {}
  addPendingYield(): void {}
  unstake(): void {}

  getTotalStake(walletAddress: string): number {
    let total = 0;
    const prefix = `${walletAddress}:`;
    for (const [key, amount] of this.stakes) {
      if (key.startsWith(prefix)) total += amount;
    }
    return total;
  }

  getWalletStakes(): never[] {
    return [];
  }
}

// ---------- Fixtures ----------

interface Harness {
  tracker: ExpeditionTracker;
  registry: FakeRegistry;
  stakes: FakeStakeManager;
  cooldowns: CooldownManager;
}

function makeHarness(): Harness {
  const registry = new FakeRegistry();
  const stakes = new FakeStakeManager();
  const cooldowns = new CooldownManager({ logger: silentLogger });

  registry.addAsteroid(makeAsteroidState('SRC'));
  registry.addAsteroid(makeAsteroidState('TGT'));
  registry.addAsteroid(makeAsteroidState('TGT2'));

  const tracker = new ExpeditionTracker({
    registry,
    stakeManager: stakes,
    cooldownManager: cooldowns,
    logger: silentLogger,
  });

  return { tracker, registry, stakes, cooldowns };
}

const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';

describe('ExpeditionTracker.createExpedition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a valid expedition with the right shape and side effects', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 200);
    h.stakes.setMiner(ALICE, { homeStationAsteroidId: 'SRC', activeAsteroidId: 'SRC' });

    const exp = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 50, 10);

    expect(exp).not.toBeNull();
    expect(exp?.attackers).toEqual([ALICE]);
    expect(exp?.sourceAsteroidId).toBe('SRC');
    expect(exp?.targetAsteroidId).toBe('TGT');
    expect(exp?.status).toBe('active');
    expect(exp?.attackPower).toBeCloseTo(calculateAttackPower(50, 200), 10);
    expect(exp?.bets.get(ALICE)).toBe(10);

    expect(h.registry.addedRaids).toEqual([{ asteroidId: 'TGT', expeditionId: exp?.id }]);
    expect(h.stakes.processedBets).toEqual([{ wallet: ALICE, asteroidId: 'SRC', amount: 10 }]);

    expect(h.cooldowns.hasCooldown(ALICE, 'expedition_start')).toBe(true);

    const miner = h.stakes.getMinerState(ALICE);
    expect(miner.currentExpeditionId).toBe(exp?.id);
    expect(miner.activeAsteroidId).toBe('TGT');

    expect(h.tracker.getAttackerExpedition(ALICE)?.id).toBe(exp?.id);
    expect(h.tracker.getActiveExpeditions()).toHaveLength(1);
  });

  it('rejects when the source asteroid is unknown', () => {
    const h = makeHarness();
    expect(h.tracker.createExpedition(ALICE, 'NOPE', 'TGT', 50)).toBeNull();
    expect(h.tracker.getActiveExpeditions()).toHaveLength(0);
  });

  it('rejects when the target asteroid is unknown', () => {
    const h = makeHarness();
    expect(h.tracker.createExpedition(ALICE, 'SRC', 'NOPE', 50)).toBeNull();
  });

  it('rejects raiding your own asteroid', () => {
    const h = makeHarness();
    expect(h.tracker.createExpedition(ALICE, 'SRC', 'SRC', 50)).toBeNull();
  });

  it('rejects when target has raid immunity', () => {
    const h = makeHarness();
    h.registry.setImmune('TGT', true);
    expect(h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 50)).toBeNull();
  });

  it('rejects when the wallet is already on an expedition', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);
    h.stakes.setMiner(ALICE);
    expect(h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 50)).not.toBeNull();
    expect(h.tracker.createExpedition(ALICE, 'SRC', 'TGT2', 50)).toBeNull();
    expect(h.tracker.getActiveExpeditions()).toHaveLength(1);
  });

  it('rejects while expedition_start cooldown is active', () => {
    const h = makeHarness();
    h.cooldowns.applyCooldown(ALICE, 'expedition_start');
    expect(h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 50)).toBeNull();
  });

  it('rejects while expedition_recovery cooldown is active', () => {
    const h = makeHarness();
    h.cooldowns.applyCooldown(ALICE, 'expedition_recovery');
    expect(h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 50)).toBeNull();
  });

  it('rejects when stake-manager refuses the bet', () => {
    const h = makeHarness();
    h.stakes.allowBets = false;
    expect(h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 50, 5)).toBeNull();
    expect(h.tracker.getActiveExpeditions()).toHaveLength(0);
    expect(h.cooldowns.hasCooldown(ALICE, 'expedition_start')).toBe(false);
  });
});

describe('ExpeditionTracker.joinExpedition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets a second attacker join and adds attack power', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);
    h.stakes.setStake(BOB, 'SRC', 50);

    const exp = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100);
    expect(exp).not.toBeNull();
    const initialPower = exp!.attackPower;

    const ok = h.tracker.joinExpedition(exp!.id, BOB, 80, 5);
    expect(ok).toBe(true);

    expect(exp!.attackers).toEqual([ALICE, BOB]);
    expect(exp!.bets.get(BOB)).toBe(5);
    expect(exp!.attackPower).toBeCloseTo(initialPower + calculateAttackPower(80, 50), 10);
    expect(h.tracker.getAttackerExpedition(BOB)?.id).toBe(exp!.id);
  });

  it('rejects joining an unknown or non-active expedition', () => {
    const h = makeHarness();
    expect(h.tracker.joinExpedition('nope', BOB, 50)).toBe(false);
  });

  it('rejects joining when wallet is already on an expedition', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);

    const exp1 = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100)!;
    // ALICE tries to join her own expedition again
    expect(h.tracker.joinExpedition(exp1.id, ALICE, 100)).toBe(false);
  });

  it('rejects joining while expedition_start cooldown is active', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);
    const exp = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100)!;

    h.cooldowns.applyCooldown(BOB, 'expedition_start');
    expect(h.tracker.joinExpedition(exp.id, BOB, 50)).toBe(false);
  });

  it('rejects joining when bet processing fails', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);
    const exp = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100)!;

    h.stakes.allowBets = false;
    expect(h.tracker.joinExpedition(exp.id, BOB, 50, 1)).toBe(false);
    expect(exp.attackers).toEqual([ALICE]);
  });
});

describe('ExpeditionTracker resolution + bookkeeping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('completeExpedition (success) marks completed, removes raid, applies recovery cooldown', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);
    h.stakes.setMiner(ALICE, { homeStationAsteroidId: 'SRC' });

    const exp = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100)!;
    h.tracker.completeExpedition(exp.id, true);

    expect(exp.status).toBe('completed');
    expect(h.registry.removedRaids).toContainEqual({ asteroidId: 'TGT', expeditionId: exp.id });
    expect(h.cooldowns.hasCooldown(ALICE, 'expedition_recovery')).toBe(true);
    expect(h.tracker.getAttackerExpedition(ALICE)).toBeUndefined();

    const miner = h.stakes.getMinerState(ALICE);
    expect(miner.currentExpeditionId).toBeNull();
    expect(miner.activeAsteroidId).toBe('SRC');
  });

  it('completeExpedition (failure) marks failed', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);
    const exp = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100)!;
    h.tracker.completeExpedition(exp.id, false);
    expect(exp.status).toBe('failed');
  });

  it('startReturn flips status and routes attackers home', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);
    const exp = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100)!;

    h.tracker.startReturn(exp.id);

    expect(exp.status).toBe('returning');
    expect(h.stakes.getMinerState(ALICE).activeAsteroidId).toBe('SRC');
  });

  it('leaveExpedition burns bet, applies recovery cooldown, removes wallet from expedition', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);
    h.stakes.setStake(BOB, 'SRC', 100);
    h.stakes.setMiner(ALICE, { homeStationAsteroidId: 'SRC' });
    h.stakes.setMiner(BOB, { homeStationAsteroidId: 'SRC' });

    const exp = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100, 7)!;
    h.tracker.joinExpedition(exp.id, BOB, 100, 3);

    expect(h.tracker.leaveExpedition(BOB)).toBe(true);

    expect(exp.attackers).toEqual([ALICE]);
    expect(exp.bets.has(BOB)).toBe(false);
    expect(h.stakes.burnedBets).toContainEqual({
      wallet: BOB,
      asteroidId: 'SRC',
      amount: 3,
    });
    expect(h.cooldowns.hasCooldown(BOB, 'expedition_recovery')).toBe(true);
  });

  it('leaveExpedition with last attacker cancels the expedition entirely', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);

    const exp = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100, 5)!;
    expect(h.tracker.leaveExpedition(ALICE)).toBe(true);

    expect(h.tracker.getExpedition(exp.id)).toBeUndefined();
    expect(h.registry.removedRaids).toContainEqual({ asteroidId: 'TGT', expeditionId: exp.id });
    expect(h.stakes.burnedBets).toContainEqual({ wallet: ALICE, asteroidId: 'SRC', amount: 5 });
  });

  it('leaveExpedition returns false when wallet has no expedition', () => {
    const h = makeHarness();
    expect(h.tracker.leaveExpedition(ALICE)).toBe(false);
  });

  it('getExpeditionsTargeting + getTotalAttackPower aggregate active raids', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);
    h.stakes.setStake(BOB, 'SRC', 100);

    const e1 = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100)!;
    const e2 = h.tracker.createExpedition(BOB, 'SRC', 'TGT', 100)!;

    expect(h.tracker.getExpeditionsTargeting('TGT')).toHaveLength(2);
    expect(h.tracker.getTotalAttackPower('TGT')).toBeCloseTo(e1.attackPower + e2.attackPower, 10);
    expect(h.tracker.getTotalAttackPower('TGT2')).toBe(0);
  });

  it('checkExpiredExpeditions surfaces only past-expiry active expeditions', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);
    h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100);

    expect(h.tracker.checkExpiredExpeditions()).toHaveLength(0);

    // Advance just past the 2h max duration.
    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1);
    expect(h.tracker.checkExpiredExpeditions()).toHaveLength(1);
  });

  it('cleanup drops resolved expeditions whose original expiresAt is past the 1h window', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);
    h.stakes.setStake(BOB, 'SRC', 100);

    const e1 = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100)!;
    const e2 = h.tracker.createExpedition(BOB, 'SRC', 'TGT2', 100)!;

    h.tracker.completeExpedition(e1.id, true);
    // e2 stays active.

    // Advance 4h: e1.expiresAt (originally now+2h) is now 2h in the past,
    // which is older than the 1h cleanup window.
    vi.advanceTimersByTime(4 * 60 * 60 * 1000);
    h.tracker.cleanup();

    expect(h.tracker.getExpedition(e1.id)).toBeUndefined();
    expect(h.tracker.getExpedition(e2.id)).toBeDefined();
  });

  it('getStats counts active/completed/failed correctly', () => {
    const h = makeHarness();
    h.stakes.setStake(ALICE, 'SRC', 100);
    h.stakes.setStake(BOB, 'SRC', 100);

    const e1 = h.tracker.createExpedition(ALICE, 'SRC', 'TGT', 100)!;
    const e2 = h.tracker.createExpedition(BOB, 'SRC', 'TGT2', 100)!;

    h.tracker.completeExpedition(e1.id, true);
    h.tracker.completeExpedition(e2.id, false);

    expect(h.tracker.getStats()).toEqual({ active: 0, completed: 1, failed: 1 });
  });
});
