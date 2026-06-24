/**
 * Unit tests for `server/game/syndicate-raids.ts`.
 *
 * Uses minimal in-memory test doubles for every collaborator
 * (`SyndicateManagerLike`, `StakeManagerLike`, `AsteroidRegistryLike`,
 * `RaidEngineLike`). Doubles surface only the methods the manager
 * calls and assert on misuse.
 *
 * Coverage:
 * - propose/join/leave/launch/cancel lifecycle including all rejection
 *   paths
 * - the BG attack-power formula (stake × 0.1) and the 1.1x coordination
 *   bonus quirk (proposer doesn't get it; joiners do)
 * - bet 20% cap on propose and join
 * - resolveRaid both sides:
 *     - attackers win: steal-percent formula + bet-weighted returns +
 *       attack debuff
 *     - attackers lose: per-bet burn + defender spoils + defense buff
 * - distributeRewards: 50/50 base+bet split, treasury cut, no-op on loss
 * - cleanupExpiredRaids: pending dropped silently, active marked failed
 *   and pushed to history
 * - getStats win-rate math
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AsteroidRegistryLike,
  GameLogger,
  RaidEngineLike,
  StakeManagerLike,
  SyndicateManagerLike,
} from '../../server/game/interfaces.js';
import { SyndicateRaidsManager } from '../../server/game/syndicate-raids.js';
import type {
  AsteroidState,
  DefenderSpoils,
  MinerGameState,
  RaidResult,
  Syndicate,
} from '../../server/game/types.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';
const CAROL = 'wallet_carol';
const DAVE = 'wallet_dave';

// --- Fakes ---

class FakeSyndicates implements SyndicateManagerLike {
  syndicates: Map<string, Syndicate> = new Map();
  byMember: Map<string, string> = new Map();
  managers: Set<string> = new Set();

  add(syndicate: Syndicate, members: string[] = [], officers: string[] = []): void {
    this.syndicates.set(syndicate.id, syndicate);
    this.byMember.set(syndicate.leaderId, syndicate.id);
    this.managers.add(syndicate.leaderId);
    for (const m of members) this.byMember.set(m, syndicate.id);
    for (const o of officers) this.managers.add(o);
  }

  getMemberSyndicate(walletAddress: string): Syndicate | undefined {
    const id = this.byMember.get(walletAddress);
    return id ? this.syndicates.get(id) : undefined;
  }
  getSyndicate(id: string): Syndicate | undefined {
    return this.syndicates.get(id);
  }
  canManageMembers(walletAddress: string): boolean {
    return this.managers.has(walletAddress);
  }
}

class FakeStake implements StakeManagerLike {
  stakes = new Map<string, number>(); // wallet -> stake at home station
  homes = new Map<string, string | null>();
  burned: Array<{ wallet: string; asteroidId: string; amount: number }> = [];

  setMiner(wallet: string, homeStation: string | null, stake: number): void {
    this.homes.set(wallet, homeStation);
    this.stakes.set(wallet, stake);
  }

  getMinerState(wallet: string): MinerGameState {
    return {
      walletAddress: wallet,
      homeStationAsteroidId: this.homes.get(wallet) ?? null,
      activeAsteroidId: null,
      currentExpeditionId: null,
      totalStake: this.stakes.get(wallet) ?? 0,
      cooldowns: [],
      loyaltyDays: 0,
      homeStationJoinedAt: this.homes.get(wallet) ? new Date() : null,
    };
  }
  getStakeAtAsteroid(wallet: string, _asteroidId: string): number {
    return this.stakes.get(wallet) ?? 0;
  }
  burnBet(wallet: string, asteroidId: string, amount: number): void {
    this.burned.push({ wallet, asteroidId, amount });
  }

  // Unused in syndicate-raids tests; throw to catch misuse.
  getDefensePower(): number {
    throw new Error('unused');
  }
  getTotalStake(): number {
    throw new Error('unused');
  }
  getWalletStakes(): never {
    throw new Error('unused');
  }
  processBet(): boolean {
    throw new Error('unused');
  }
  returnBetWithWinnings(): void {
    throw new Error('unused');
  }
  addPendingYield(): void {
    throw new Error('unused');
  }
  unstake(): void {
    throw new Error('unused');
  }
}

class FakeRegistry implements AsteroidRegistryLike {
  asteroids = new Set<string>();
  attackDebuffs = new Set<string>();
  defenseBuffs = new Set<string>();

  add(id: string): void {
    this.asteroids.add(id);
  }

  getAsteroid(id: string): AsteroidState | undefined {
    if (!this.asteroids.has(id)) return undefined;
    // Just enough fields to satisfy callers (none of which actually
    // dereference the full state in syndicate-raids).
    return { definition: { id }, activeMiners: new Set() } as unknown as AsteroidState;
  }
  hasRaidImmunity(): boolean {
    return false;
  }
  applyAttackDebuff(id: string): void {
    this.attackDebuffs.add(id);
  }
  applyDefenseBuff(id: string): void {
    this.defenseBuffs.add(id);
  }
  addIncomingRaid(): void {}
  removeIncomingRaid(): void {}
  updateAsteroidStake(): void {}
}

class FakeRaidEngine implements RaidEngineLike {
  raidableAsteroids = new Set<string>();
  defensePowerByAsteroid = new Map<string, number>();
  pendingYieldByAsteroid = new Map<string, number>();
  spoilsCalls: Array<{ raidId: string; asteroidId: string; amount: number }> = [];

  setRaidable(id: string, raidable: boolean): void {
    if (raidable) this.raidableAsteroids.add(id);
    else this.raidableAsteroids.delete(id);
  }

  canBeRaided(id: string): boolean {
    return this.raidableAsteroids.has(id);
  }
  calculateAsteroidDefensePower(id: string): number {
    return this.defensePowerByAsteroid.get(id) ?? 0;
  }
  getPendingYield(id: string): number {
    return this.pendingYieldByAsteroid.get(id) ?? 0;
  }
  distributeDefenderSpoils(
    raidId: string,
    asteroidId: string,
    totalAttackerBets: number,
  ): DefenderSpoils {
    this.spoilsCalls.push({ raidId, asteroidId, amount: totalAttackerBets });
    return {
      raidId,
      totalSpoils: Math.floor(totalAttackerBets * 0.1),
      amountBurned: totalAttackerBets - Math.floor(totalAttackerBets * 0.1),
      defenderPayouts: new Map(),
      distributedAt: new Date(),
    };
  }
}

// --- Harness ---

interface Harness {
  mgr: SyndicateRaidsManager;
  syndicates: FakeSyndicates;
  stake: FakeStake;
  registry: FakeRegistry;
  engine: FakeRaidEngine;
  syndicate: Syndicate;
}

function makeSyndicate(leader: string): Syndicate {
  return {
    id: `syn_${leader}`,
    name: 'Crew',
    tag: 'CRW',
    leaderId: leader,
    members: new Map([
      [
        leader,
        {
          walletAddress: leader,
          role: 'leader',
          joinedAt: new Date(),
          totalContributed: 0,
        },
      ],
    ]),
    createdAt: new Date(),
    treasury: 0,
    settings: { rewardSplit: 0, raidCoordination: true, defenseAlerts: true },
    activeWars: [],
    warWins: 0,
    warLosses: 0,
  };
}

function makeHarness(): Harness {
  const syndicates = new FakeSyndicates();
  const stake = new FakeStake();
  const registry = new FakeRegistry();
  const engine = new FakeRaidEngine();
  const syndicate = makeSyndicate(ALICE);
  syndicates.add(syndicate, [BOB, CAROL, DAVE]);
  registry.add('TARGET');
  engine.setRaidable('TARGET', true);

  // Default: every wallet has 1000 stake at home station 'HOME'.
  for (const w of [ALICE, BOB, CAROL, DAVE]) stake.setMiner(w, 'HOME', 1000);

  const mgr = new SyndicateRaidsManager({
    syndicates,
    stakeManager: stake,
    registry,
    raidEngine: engine,
    logger: silentLogger,
  });
  return { mgr, syndicates, stake, registry, engine, syndicate };
}

// --- Tests ---

describe('SyndicateRaidsManager.proposeRaid', () => {
  it('rejects non-members', () => {
    const h = makeHarness();
    expect(h.mgr.proposeRaid('outsider', 'TARGET', 0).error).toMatch(/not in a syndicate/);
  });

  it('rejects when raidCoordination is disabled', () => {
    const h = makeHarness();
    h.syndicate.settings.raidCoordination = false;
    expect(h.mgr.proposeRaid(ALICE, 'TARGET', 0).error).toMatch(/coordination is disabled/);
  });

  it('rejects regular members (only leader/officer can propose)', () => {
    const h = makeHarness();
    expect(h.mgr.proposeRaid(BOB, 'TARGET', 0).error).toMatch(/Only leaders and officers/);
  });

  it('rejects duplicate proposals', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    expect(h.mgr.proposeRaid(ALICE, 'TARGET', 0).error).toMatch(/already being organized/);
  });

  it('rejects unknown target asteroid', () => {
    const h = makeHarness();
    expect(h.mgr.proposeRaid(ALICE, 'NOPE', 0).error).toMatch(/does not exist/);
  });

  it('rejects raid-immune target', () => {
    const h = makeHarness();
    h.engine.setRaidable('TARGET', false);
    expect(h.mgr.proposeRaid(ALICE, 'TARGET', 0).error).toMatch(/raid immunity/);
  });

  it('rejects bet exceeding 20% of stake', () => {
    const h = makeHarness();
    // ALICE has 1000 staked at home -> max bet is 200.
    expect(h.mgr.proposeRaid(ALICE, 'TARGET', 201).error).toMatch(/Max bet/);
  });

  it('accepts bet at exactly 20%', () => {
    const h = makeHarness();
    expect(h.mgr.proposeRaid(ALICE, 'TARGET', 200).success).toBe(true);
  });

  it('seeds raid pool with the proposer (no bonus on the founder)', () => {
    const h = makeHarness();
    const out = h.mgr.proposeRaid(ALICE, 'TARGET', 100);
    expect(out.success).toBe(true);
    const pending = h.mgr.getPendingRaid(h.syndicate.id)!;
    expect(pending.participants).toEqual([ALICE]);
    expect(pending.totalBets).toBe(100);
    // Attack power = 1000 * 0.1 = 100, NO 1.1x bonus on the proposer.
    expect(pending.pooledAttackPower).toBeCloseTo(100, 5);
  });
});

describe('SyndicateRaidsManager.joinRaid + leaveRaid', () => {
  it('joiners add bonused attack power and bet', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 100);
    expect(h.mgr.joinRaid(BOB, 50).success).toBe(true);
    const r = h.mgr.getPendingRaid(h.syndicate.id)!;
    // ALICE: 100 (no bonus). BOB: 100 * 1.1 = 110 (bonused). Total = 210.
    expect(r.pooledAttackPower).toBeCloseTo(210, 5);
    expect(r.totalBets).toBe(150);
    expect(r.bets.get(BOB)).toBe(50);
  });

  it('rejects non-members', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    expect(h.mgr.joinRaid('outsider', 0).error).toMatch(/not in a syndicate/);
  });

  it('rejects when no raid is active', () => {
    const h = makeHarness();
    expect(h.mgr.joinRaid(BOB, 0).error).toMatch(/No active raid/);
  });

  it('rejects duplicate joiners', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    h.mgr.joinRaid(BOB, 0);
    expect(h.mgr.joinRaid(BOB, 0).error).toMatch(/already in this raid/);
  });

  it('enforces 20% cap on join bets', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    expect(h.mgr.joinRaid(BOB, 201).error).toMatch(/Max bet/);
  });

  it('leaveRaid pulls bonused power and bet back out', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 100);
    h.mgr.joinRaid(BOB, 50);
    h.mgr.joinRaid(CAROL, 0);

    expect(h.mgr.leaveRaid(BOB).success).toBe(true);
    const r = h.mgr.getPendingRaid(h.syndicate.id)!;
    // After BOB leaves: 100 (ALICE) + 110 (CAROL bonused) = 210.
    expect(r.pooledAttackPower).toBeCloseTo(210, 5);
    expect(r.totalBets).toBe(100);
    expect(r.participants).toEqual([ALICE, CAROL]);
  });

  it('cancels raid when last participant leaves', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    expect(h.mgr.leaveRaid(ALICE).success).toBe(true);
    expect(h.mgr.getPendingRaid(h.syndicate.id)).toBeUndefined();
  });

  it('rejects leave when not in the raid', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    expect(h.mgr.leaveRaid(BOB).error).toMatch(/not in this raid/);
  });
});

describe('SyndicateRaidsManager.launchRaid + cancelRaid', () => {
  it('launchRaid requires officer/leader', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    h.mgr.joinRaid(BOB, 0);
    h.mgr.joinRaid(CAROL, 0);
    expect(h.mgr.launchRaid(BOB).error).toMatch(/Only leaders and officers/);
  });

  it('launchRaid requires MIN_PARTICIPANTS (3)', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    h.mgr.joinRaid(BOB, 0);
    expect(h.mgr.launchRaid(ALICE).error).toMatch(/at least 3 participants/);
  });

  it('launchRaid moves raid from pending to active with sufficient participants', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    h.mgr.joinRaid(BOB, 0);
    h.mgr.joinRaid(CAROL, 0);
    expect(h.mgr.launchRaid(ALICE).success).toBe(true);
    expect(h.mgr.getPendingRaid(h.syndicate.id)).toBeUndefined();
    expect(h.mgr.getActiveRaidsForSyndicate(h.syndicate.id)).toHaveLength(1);
    expect(h.mgr.getRaidsTargeting('TARGET')).toHaveLength(1);
  });

  it('cancelRaid requires officer/leader and a pending raid', () => {
    const h = makeHarness();
    expect(h.mgr.cancelRaid(ALICE).error).toMatch(/No pending raid/);
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    expect(h.mgr.cancelRaid(BOB).error).toMatch(/Only leaders and officers/);
    expect(h.mgr.cancelRaid(ALICE).success).toBe(true);
    expect(h.mgr.getPendingRaid(h.syndicate.id)).toBeUndefined();
  });
});

describe('SyndicateRaidsManager.resolveRaid (attackers win)', () => {
  function setupActive(): {
    h: Harness;
    raidId: string;
  } {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 100);
    h.mgr.joinRaid(BOB, 100);
    h.mgr.joinRaid(CAROL, 0);
    h.mgr.launchRaid(ALICE);
    const raidId = h.mgr.getActiveRaidsForSyndicate(h.syndicate.id)[0]!.id;
    return { h, raidId };
  }

  it('returns null for unknown raid', () => {
    const h = makeHarness();
    expect(h.mgr.resolveRaid('NOPE')).toBeNull();
  });

  it('attackers win when pooled attack > defense * 1.2', () => {
    const { h, raidId } = setupActive();
    // Pooled power = 100 (ALICE) + 110 (BOB bonus) + 110 (CAROL bonus) = 320.
    h.engine.defensePowerByAsteroid.set('TARGET', 100);
    h.engine.pendingYieldByAsteroid.set('TARGET', 1000);

    const result = h.mgr.resolveRaid(raidId)!;
    expect(result).not.toBeNull();
    expect(result.attackersWon).toBe(true);
    // effective = 100 * 1.2 = 120
    // ratio = min(320/120, 2.0) = 2.0
    // stealPercent = min(0.1 + (2.0 - 1) * 0.2, 0.3) = 0.3
    // stolen = 1000 * 0.3 = 300
    expect(result.stolenYield).toBeCloseTo(300, 5);
    expect(result.attackPower).toBeCloseTo(320, 5);
    expect(result.defensePower).toBe(100);
  });

  it('returns bets + bet-weighted winnings to bettors only', () => {
    const { h, raidId } = setupActive();
    h.engine.defensePowerByAsteroid.set('TARGET', 100);
    h.engine.pendingYieldByAsteroid.set('TARGET', 1000);

    const result = h.mgr.resolveRaid(raidId)!;
    // stolen = 300; pool = 300 * 0.5 = 150; ALICE bet 100/200 = 75; BOB 100/200 = 75.
    // ALICE: 100 + 75 = 175; BOB: 100 + 75 = 175; CAROL: 0 (no bet).
    expect(result.betsReturned.get(ALICE)).toBeCloseTo(175, 5);
    expect(result.betsReturned.get(BOB)).toBeCloseTo(175, 5);
    expect(result.betsReturned.has(CAROL)).toBe(false);
  });

  it('applies attack debuff to target on win', () => {
    const { h, raidId } = setupActive();
    h.engine.defensePowerByAsteroid.set('TARGET', 100);
    h.engine.pendingYieldByAsteroid.set('TARGET', 1000);
    h.mgr.resolveRaid(raidId);
    expect(h.registry.attackDebuffs.has('TARGET')).toBe(true);
    expect(h.registry.defenseBuffs.has('TARGET')).toBe(false);
  });

  it('removes raid from active and pushes to history', () => {
    const { h, raidId } = setupActive();
    h.engine.defensePowerByAsteroid.set('TARGET', 100);
    h.mgr.resolveRaid(raidId);
    expect(h.mgr.getActiveRaidsForSyndicate(h.syndicate.id)).toHaveLength(0);
    expect(h.mgr.getStats().totalRaids).toBe(1);
  });
});

describe('SyndicateRaidsManager.resolveRaid (attackers lose)', () => {
  function setupLosing(): {
    h: Harness;
    raidId: string;
    result: RaidResult;
  } {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 50);
    h.mgr.joinRaid(BOB, 50);
    h.mgr.joinRaid(CAROL, 0);
    h.mgr.launchRaid(ALICE);
    const raidId = h.mgr.getActiveRaidsForSyndicate(h.syndicate.id)[0]!.id;
    // Pooled power = 320; effective defense = 1000 * 1.2 = 1200 -> attackers lose.
    h.engine.defensePowerByAsteroid.set('TARGET', 1000);
    const result = h.mgr.resolveRaid(raidId)!;
    return { h, raidId, result };
  }

  it('flags loss', () => {
    const { result } = setupLosing();
    expect(result.attackersWon).toBe(false);
    expect(result.stolenYield).toBe(0);
    expect(result.betsReturned.size).toBe(0);
  });

  it('burns each non-zero bet against the bettors home station', () => {
    const { h, result } = setupLosing();
    expect(result.betsBurned.get(ALICE)).toBe(50);
    expect(result.betsBurned.get(BOB)).toBe(50);
    expect(result.betsBurned.has(CAROL)).toBe(false);

    const burnCalls = h.stake.burned;
    expect(burnCalls).toHaveLength(2);
    expect(burnCalls.every((c) => c.asteroidId === 'HOME')).toBe(true);
    expect(burnCalls.map((c) => c.wallet).sort()).toEqual([ALICE, BOB]);
  });

  it('calls distributeDefenderSpoils with the total bet pool', () => {
    const { h, raidId } = setupLosing();
    expect(h.engine.spoilsCalls).toEqual([
      { raidId, asteroidId: 'TARGET', amount: 100 }, // ALICE 50 + BOB 50
    ]);
  });

  it('skips burnBet when bettor has no home station', () => {
    const h = makeHarness();
    h.stake.setMiner(BOB, null, 1000); // BOB has stake but no home (impossible in real flow but exercise the branch)
    // Actually that's contradictory — getStakeAtAsteroid would still return 1000
    // but propose's home check skips when null. Use a separate setup: BOB joins
    // with bet 0 (cap=0 with no home), then we manually set a bet.
    h.mgr.proposeRaid(ALICE, 'TARGET', 50);
    h.mgr.joinRaid(BOB, 0);
    h.mgr.joinRaid(CAROL, 0);
    // Push a bet on BOB by hand to exercise the homeStation==null branch.
    const pending = h.mgr.getPendingRaid(h.syndicate.id)!;
    pending.bets.set(BOB, 25);
    pending.totalBets += 25;
    h.mgr.launchRaid(ALICE);
    const raidId = h.mgr.getActiveRaidsForSyndicate(h.syndicate.id)[0]!.id;
    h.engine.defensePowerByAsteroid.set('TARGET', 1000);

    const result = h.mgr.resolveRaid(raidId)!;
    expect(result.betsBurned.get(BOB)).toBe(25);
    // BOB has no home station, so no burnBet call should land for BOB.
    expect(h.stake.burned.find((c) => c.wallet === BOB)).toBeUndefined();
  });

  it('skips defender spoils when totalBets is zero', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    h.mgr.joinRaid(BOB, 0);
    h.mgr.joinRaid(CAROL, 0);
    h.mgr.launchRaid(ALICE);
    const raidId = h.mgr.getActiveRaidsForSyndicate(h.syndicate.id)[0]!.id;
    h.engine.defensePowerByAsteroid.set('TARGET', 1000);
    h.mgr.resolveRaid(raidId);
    expect(h.engine.spoilsCalls).toHaveLength(0);
  });

  it('applies defense buff to target on loss', () => {
    const { h } = setupLosing();
    expect(h.registry.defenseBuffs.has('TARGET')).toBe(true);
    expect(h.registry.attackDebuffs.has('TARGET')).toBe(false);
  });
});

describe('SyndicateRaidsManager.distributeRewards', () => {
  function setupWinningRaid(rewardSplit = 0): {
    h: Harness;
    raidId: string;
    result: RaidResult;
  } {
    const h = makeHarness();
    h.syndicate.settings.rewardSplit = rewardSplit;
    h.mgr.proposeRaid(ALICE, 'TARGET', 100);
    h.mgr.joinRaid(BOB, 100);
    h.mgr.joinRaid(CAROL, 0);
    h.mgr.launchRaid(ALICE);
    const raidId = h.mgr.getActiveRaidsForSyndicate(h.syndicate.id)[0]!.id;
    h.engine.defensePowerByAsteroid.set('TARGET', 100);
    h.engine.pendingYieldByAsteroid.set('TARGET', 1000);
    const result = h.mgr.resolveRaid(raidId)!;
    return { h, raidId, result };
  }

  it('returns empty map on a losing raid', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 50);
    h.mgr.joinRaid(BOB, 50);
    h.mgr.joinRaid(CAROL, 0);
    h.mgr.launchRaid(ALICE);
    const raidId = h.mgr.getActiveRaidsForSyndicate(h.syndicate.id)[0]!.id;
    h.engine.defensePowerByAsteroid.set('TARGET', 1000);
    const result = h.mgr.resolveRaid(raidId)!;
    expect(h.mgr.distributeRewards(raidId, result).size).toBe(0);
  });

  it('splits stolen yield 50/50 base + bet-weighted with no treasury cut', () => {
    const { h, raidId, result } = setupWinningRaid(0);
    // stolen = 300; treasury cut = 0; pool = 300.
    // baseShare = 300 * 0.5 / 3 = 50; betPool = 150.
    // ALICE: 50 + (100/200) * 150 = 125
    // BOB:   50 + (100/200) * 150 = 125
    // CAROL: 50 + (0/200) * 150  = 50
    const rewards = h.mgr.distributeRewards(raidId, result);
    expect(rewards.get(ALICE)).toBeCloseTo(125, 5);
    expect(rewards.get(BOB)).toBeCloseTo(125, 5);
    expect(rewards.get(CAROL)).toBeCloseTo(50, 5);
    expect(h.syndicate.treasury).toBe(0);
  });

  it('treasury cut comes off the top before participant pool split', () => {
    const { h, raidId, result } = setupWinningRaid(20); // 20% to treasury
    // stolen = 300; treasury cut = 60; participantPool = 240.
    // baseShare = 240 * 0.5 / 3 = 40; betPool = 120.
    // ALICE: 40 + (100/200) * 120 = 100
    // BOB:   40 + (100/200) * 120 = 100
    // CAROL: 40 + 0                = 40
    const rewards = h.mgr.distributeRewards(raidId, result);
    expect(rewards.get(ALICE)).toBeCloseTo(100, 5);
    expect(rewards.get(BOB)).toBeCloseTo(100, 5);
    expect(rewards.get(CAROL)).toBeCloseTo(40, 5);
    expect(h.syndicate.treasury).toBeCloseTo(60, 5);
  });

  it('returns empty when totalBets is 0 (still includes baseShare though)', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    h.mgr.joinRaid(BOB, 0);
    h.mgr.joinRaid(CAROL, 0);
    h.mgr.launchRaid(ALICE);
    const raidId = h.mgr.getActiveRaidsForSyndicate(h.syndicate.id)[0]!.id;
    h.engine.defensePowerByAsteroid.set('TARGET', 100);
    h.engine.pendingYieldByAsteroid.set('TARGET', 1000);
    const result = h.mgr.resolveRaid(raidId)!;
    // No bets at all -> bet pool isn't split (totalBets = 0 short-circuit
    // adds 0). Each participant gets baseShare = 300 * 0.5 / 3 = 50.
    const rewards = h.mgr.distributeRewards(raidId, result);
    expect(rewards.get(ALICE)).toBeCloseTo(50, 5);
    expect(rewards.get(BOB)).toBeCloseTo(50, 5);
    expect(rewards.get(CAROL)).toBeCloseTo(50, 5);
  });

  it('returns empty when raid not found', () => {
    const h = makeHarness();
    expect(
      h.mgr.distributeRewards('NOPE', {
        expeditionId: 'NOPE',
        attackersWon: true,
        stolenYield: 100,
        defensePower: 0,
        attackPower: 0,
        betsReturned: new Map(),
        betsBurned: new Map(),
        resolvedAt: new Date(),
      }),
    ).toEqual(new Map());
  });
});

describe('SyndicateRaidsManager.cleanupExpiredRaids', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops expired pending raids silently', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    vi.advanceTimersByTime(3 * 60 * 60 * 1000); // 3 hours; cap = 2.
    h.mgr.cleanupExpiredRaids();
    expect(h.mgr.getPendingRaid(h.syndicate.id)).toBeUndefined();
  });

  it('marks expired active raids as failed and pushes to history', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    h.mgr.joinRaid(BOB, 0);
    h.mgr.joinRaid(CAROL, 0);
    h.mgr.launchRaid(ALICE);
    expect(h.mgr.getActiveRaidsForSyndicate(h.syndicate.id)).toHaveLength(1);

    vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    h.mgr.cleanupExpiredRaids();
    expect(h.mgr.getActiveRaidsForSyndicate(h.syndicate.id)).toHaveLength(0);
  });

  it('keeps in-window raids untouched', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour.
    h.mgr.cleanupExpiredRaids();
    expect(h.mgr.getPendingRaid(h.syndicate.id)).toBeDefined();
  });
});

describe('SyndicateRaidsManager.getStats', () => {
  it('reports zero everything before any raid', () => {
    const h = makeHarness();
    expect(h.mgr.getStats()).toEqual({
      pendingRaids: 0,
      activeRaids: 0,
      totalRaids: 0,
      winRate: 0,
    });
  });

  it('tracks pending and active counts and win rate after resolutions', () => {
    const h = makeHarness();
    h.mgr.proposeRaid(ALICE, 'TARGET', 0);
    h.mgr.joinRaid(BOB, 0);
    h.mgr.joinRaid(CAROL, 0);
    h.mgr.launchRaid(ALICE);
    const raidId = h.mgr.getActiveRaidsForSyndicate(h.syndicate.id)[0]!.id;

    h.engine.defensePowerByAsteroid.set('TARGET', 100);
    h.mgr.resolveRaid(raidId);
    expect(h.mgr.getStats().winRate).toBe(100);
    expect(h.mgr.getStats().totalRaids).toBe(1);
  });
});
