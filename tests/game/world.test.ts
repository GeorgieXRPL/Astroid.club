/**
 * Integration tests for `server/game/world.ts`.
 *
 * The world is the composition root that wires every game module
 * together. These tests drive realistic player flows end-to-end
 * (connect → set home → stake → join → drill → expedition →
 * claim) so that any regression in one module that breaks the
 * neighbouring module is caught here, not just in unit tests.
 *
 * No real timers — `autoStartTimers` defaults to false. The world's
 * `tick()` is invoked manually where needed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AsteroidDefinition } from '../../config/asteroids.js';
import type { GameLogger } from '../../server/game/interfaces.js';
import { GameWorld } from '../../server/game/world.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ALICE = '11111111111111111111111111111111';
const BOB = '22222222222222222222222222222222';
const CAROL = '33333333333333333333333333333333';

const HOME: AsteroidDefinition = {
  id: 'home',
  name: 'Ceres Outpost',
  resource: 'carbon',
  sector: 'Inner Belt',
  position: { x: 0, y: 0, z: 0 },
  baseDiscoveryTimeMs: 5 * 60 * 1000,
  baseRewardMultiplier: 1.0,
  description: 'A reliable trickle of iron and ice.',
};

const RICH: AsteroidDefinition = {
  id: 'rich',
  name: 'Eros Spike',
  resource: 'gold',
  sector: 'Inner Belt',
  position: { x: 1, y: 0, z: 0 },
  baseDiscoveryTimeMs: 20 * 60 * 1000,
  baseRewardMultiplier: 1.5,
  description: 'Rare strikes, prime raid target.',
};

function makeWorld(): GameWorld {
  return new GameWorld({
    asteroids: [HOME, RICH],
    logger: silentLogger,
    chainEnabled: false,
  });
}

describe('GameWorld construction and lifecycle', () => {
  it('constructs every module and reports them on the public surface', () => {
    const w = makeWorld();
    expect(w.registry).toBeDefined();
    expect(w.cooldowns).toBeDefined();
    expect(w.betEscrow).toBeDefined();
    expect(w.stakeManager).toBeDefined();
    expect(w.expeditions).toBeDefined();
    expect(w.raidEngine).toBeDefined();
    expect(w.refinery).toBeDefined();
    expect(w.distribution).toBeDefined();
    expect(w.yieldOrchestrator).toBeDefined();
    expect(w.syndicates).toBeDefined();
    expect(w.syndicateRaids).toBeDefined();
    expect(w.antiCheat).toBeDefined();
  });

  it('start() and stop() are idempotent and safe in any order', () => {
    const w = makeWorld();
    expect(() => w.start()).not.toThrow();
    expect(() => w.start()).not.toThrow();
    expect(() => w.stop()).not.toThrow();
    expect(() => w.stop()).not.toThrow();
    expect(() => w.stop()).not.toThrow(); // safe before start
  });

  it('autoStartTimers=false leaves no real intervals scheduled', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const w = new GameWorld({
      asteroids: [HOME],
      logger: silentLogger,
      autoStartTimers: false,
    });
    w.start();
    expect(setSpy).not.toHaveBeenCalled();
    w.stop();
    setSpy.mockRestore();
  });

  it('tick() runs cleanup helpers without throwing on empty state', () => {
    const w = makeWorld();
    expect(() => w.tick()).not.toThrow();
  });
});

describe('GameWorld auth gating', () => {
  let w: GameWorld;
  beforeEach(() => {
    w = makeWorld();
  });

  it('rejects every player action before connectPlayer succeeds', () => {
    expect(w.joinAsteroid(ALICE, 'home').ok).toBe(false);
    expect(w.leaveAsteroid(ALICE).ok).toBe(false);
    expect(w.setHomeStation(ALICE, 'home').ok).toBe(false);
    expect(w.reportDrillPower(ALICE, 100).ok).toBe(false);
    expect(w.stake(ALICE, 'home', 100).ok).toBe(false);
    expect(w.unstake(ALICE, 'home', 100).ok).toBe(false);
    expect(w.startExpedition(ALICE, 'rich', 0).ok).toBe(false);
    expect(w.leaveExpedition(ALICE).ok).toBe(false);
    expect(w.rallyDefense(ALICE, 'home', 0).ok).toBe(false);
    expect(w.claimPendingYield(ALICE).ok).toBe(false);
  });

  it('all rejection codes are not_authenticated', () => {
    const r = w.joinAsteroid(ALICE, 'home');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_authenticated');
  });

  it('disconnectPlayer flips authentication off', async () => {
    await w.connectPlayer(ALICE);
    expect(w.joinAsteroid(ALICE, 'home').ok).toBe(true);
    w.disconnectPlayer(ALICE);
    expect(w.joinAsteroid(ALICE, 'home').ok).toBe(false);
  });
});

describe('GameWorld connect snapshot', () => {
  it('returns the asteroid catalog and zero defaults for a new wallet', async () => {
    const w = makeWorld();
    const r = await w.connectPlayer(ALICE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.walletAddress).toBe(ALICE);
    expect(r.data.homeStationAsteroidId).toBeNull();
    expect(r.data.activeAsteroidId).toBeNull();
    expect(r.data.totalStake).toBe(0);
    expect(r.data.pendingYield).toBe(0);
    expect(r.data.asteroids.map((a) => a.id).sort()).toEqual(['home', 'rich']);
  });

  it('rejects empty walletAddress', async () => {
    const w = makeWorld();
    const r = await w.connectPlayer('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_input');
  });

  it('getMinerSnapshot returns current state on subsequent reads', async () => {
    const w = makeWorld();
    await w.connectPlayer(ALICE);
    w.setHomeStation(ALICE, 'home');
    w.stake(ALICE, 'home', 500);
    const snap = w.getMinerSnapshot(ALICE);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.data.homeStationAsteroidId).toBe('home');
    expect(snap.data.totalStake).toBe(500);
  });

  it('getMinerSnapshot rejects unknown wallets', () => {
    const w = makeWorld();
    const snap = w.getMinerSnapshot(ALICE);
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.code).toBe('not_authenticated');
  });
});

describe('GameWorld asteroid join/leave', () => {
  let w: GameWorld;
  beforeEach(async () => {
    w = makeWorld();
    await w.connectPlayer(ALICE);
  });

  it('joins a known asteroid', () => {
    const r = w.joinAsteroid(ALICE, 'home');
    expect(r.ok).toBe(true);
    expect(w.registry.getMinerLocation(ALICE)).toBe('home');
  });

  it('rejects an unknown asteroid id', () => {
    const r = w.joinAsteroid(ALICE, 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unknown_asteroid');
  });

  it('moves the player when joining a different asteroid', () => {
    w.joinAsteroid(ALICE, 'home');
    w.joinAsteroid(ALICE, 'rich');
    expect(w.registry.getMinerLocation(ALICE)).toBe('rich');
  });

  it('leaveAsteroid clears the player location and active id', () => {
    w.joinAsteroid(ALICE, 'home');
    w.leaveAsteroid(ALICE);
    expect(w.registry.getMinerLocation(ALICE)).toBeUndefined();
    expect(w.stakeManager.getMinerState(ALICE).activeAsteroidId).toBeNull();
  });

  it('joining registers the player with the distribution service', () => {
    w.joinAsteroid(ALICE, 'home');
    expect(w.distribution.getActiveMinerCount()).toBe(1);
    w.leaveAsteroid(ALICE);
    expect(w.distribution.getActiveMinerCount()).toBe(0);
  });
});

describe('GameWorld home station', () => {
  let w: GameWorld;
  beforeEach(async () => {
    w = makeWorld();
    await w.connectPlayer(ALICE);
  });

  it('sets the home station and persists in miner state', () => {
    const r = w.setHomeStation(ALICE, 'home');
    expect(r.ok).toBe(true);
    expect(w.stakeManager.getMinerState(ALICE).homeStationAsteroidId).toBe('home');
  });

  it('rejects unknown asteroid', () => {
    const r = w.setHomeStation(ALICE, 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unknown_asteroid');
  });

  it('applies a cooldown on success that blocks the next switch', () => {
    expect(w.setHomeStation(ALICE, 'home').ok).toBe(true);
    const r = w.setHomeStation(ALICE, 'rich');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('cooldown_active');
  });
});

describe('GameWorld drill power reporting', () => {
  let w: GameWorld;
  beforeEach(async () => {
    w = makeWorld();
    await w.connectPlayer(ALICE);
    w.joinAsteroid(ALICE, 'home');
  });

  it('records the effective drill power in the registry total', () => {
    const r = w.reportDrillPower(ALICE, 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.effective).toBeGreaterThanOrEqual(100);
    const asteroid = w.registry.getAsteroid('home');
    expect(asteroid?.totalDrillPower).toBeGreaterThanOrEqual(100);
  });

  it('rejects negative drill power', () => {
    const r = w.reportDrillPower(ALICE, -1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_input');
  });

  it('rejects when not joined to an asteroid', () => {
    w.leaveAsteroid(ALICE);
    const r = w.reportDrillPower(ALICE, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('rejected');
  });

  it('subsequent reports replace, not add (delta diff is correct)', () => {
    w.reportDrillPower(ALICE, 100);
    w.reportDrillPower(ALICE, 200);
    const asteroid = w.registry.getAsteroid('home');
    expect(asteroid?.totalDrillPower).toBeGreaterThanOrEqual(200);
    expect(asteroid?.totalDrillPower).toBeLessThan(400);
  });

  it('mirrors into the distribution service', () => {
    w.reportDrillPower(ALICE, 150);
    const miner = w.distribution.getActiveMiner(ALICE);
    expect(miner?.currentDrillPower).toBe(150);
  });
});

describe('GameWorld stake / unstake', () => {
  let w: GameWorld;
  beforeEach(async () => {
    w = makeWorld();
    await w.connectPlayer(ALICE);
  });

  it('stakes at an asteroid and bumps total', () => {
    const r = w.stake(ALICE, 'home', 500);
    expect(r.ok).toBe(true);
    expect(w.stakeManager.getStakeAtAsteroid(ALICE, 'home')).toBe(500);
    expect(w.stakeManager.getMinerState(ALICE).totalStake).toBe(500);
  });

  it('rejects zero or negative amounts', () => {
    expect(w.stake(ALICE, 'home', 0).ok).toBe(false);
    expect(w.stake(ALICE, 'home', -1).ok).toBe(false);
  });

  it('rejects an unknown asteroid', () => {
    const r = w.stake(ALICE, 'nope', 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unknown_asteroid');
  });

  it('unstake reduces the stake', () => {
    w.stake(ALICE, 'home', 500);
    const r = w.unstake(ALICE, 'home', 200);
    expect(r.ok).toBe(true);
    expect(w.stakeManager.getStakeAtAsteroid(ALICE, 'home')).toBe(300);
  });

  it('unstake on missing stake reports rejected', () => {
    const r = w.unstake(ALICE, 'home', 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('rejected');
  });
});

describe('GameWorld staking with Quarry enabled (on-chain custody)', () => {
  let w: GameWorld;
  beforeEach(async () => {
    w = new GameWorld({
      asteroids: [HOME, RICH],
      logger: silentLogger,
      chainEnabled: true,
      quarryEnabled: true,
    });
    await w.connectPlayer(ALICE);
  });

  it('rejects in-game stake, directing to the on-chain flow', () => {
    const r = w.stake(ALICE, 'home', 500);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('use_onchain_staking');
    // The in-game mirror is untouched — on-chain is the source of truth.
    expect(w.stakeManager.getStakeAtAsteroid(ALICE, 'home')).toBe(0);
  });

  it('rejects in-game unstake, directing to the on-chain flow', () => {
    const r = w.unstake(ALICE, 'home', 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('use_onchain_staking');
  });

  it('reports Quarry as enabled on the stake manager', () => {
    expect(w.stakeManager.isQuarryEnabled()).toBe(true);
  });
});

describe('GameWorld expeditions', () => {
  let w: GameWorld;
  beforeEach(async () => {
    w = makeWorld();
    await w.connectPlayer(ALICE);
    w.setHomeStation(ALICE, 'home');
    w.stake(ALICE, 'home', 1000);
    w.joinAsteroid(ALICE, 'home');
    w.reportDrillPower(ALICE, 100);
  });

  it('starts a no-bet expedition against another asteroid', () => {
    const r = w.startExpedition(ALICE, 'rich', 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.expeditionId).toBeTruthy();
    expect(w.expeditions.getActiveExpeditions().length).toBe(1);
  });

  it('rejects negative bet', () => {
    const r = w.startExpedition(ALICE, 'rich', -1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_input');
  });

  it('rejects when no home station is set', async () => {
    const w2 = makeWorld();
    await w2.connectPlayer(BOB);
    const r = w2.startExpedition(BOB, 'rich', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('home_station_required');
  });

  it('leaveExpedition aborts the active expedition', () => {
    w.startExpedition(ALICE, 'rich', 0);
    const r = w.leaveExpedition(ALICE);
    expect(r.ok).toBe(true);
    expect(w.expeditions.getAttackerExpedition(ALICE)).toBeUndefined();
  });

  it('leaveExpedition rejects when not on an expedition', () => {
    const r = w.leaveExpedition(ALICE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('rejected');
  });
});

describe('GameWorld rally defense', () => {
  let w: GameWorld;
  beforeEach(async () => {
    w = makeWorld();
    await w.connectPlayer(ALICE);
    w.setHomeStation(ALICE, 'home');
    w.stake(ALICE, 'home', 1000);
  });

  it('rejects negative tokenCost', () => {
    const r = w.rallyDefense(ALICE, 'home', -1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_input');
  });

  it('rallies successfully when the wallet has enough stake', () => {
    const r = w.rallyDefense(ALICE, 'home', 100);
    expect(r.ok).toBe(true);
    expect(w.registry.getAsteroid('home')?.defenseBuff).toBeDefined();
  });

  it('rejects when the wallet has insufficient stake', () => {
    const r = w.rallyDefense(ALICE, 'home', 10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('rejected');
  });

  it('rejects an unknown asteroid', () => {
    const r = w.rallyDefense(ALICE, 'nope', 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('rejected');
  });
});

describe('GameWorld pending yield', () => {
  let w: GameWorld;
  beforeEach(async () => {
    w = makeWorld();
    await w.connectPlayer(ALICE);
  });

  it('defaults to zero', () => {
    const r = w.claimPendingYield(ALICE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.claimed).toBe(0);
  });

  it('drains the pending yield after a claim', () => {
    w.stakeManager.addPendingYield(ALICE, 'home', 500);
    expect(w.stakeManager.getPendingYield(ALICE)).toBe(500);
    const r = w.claimPendingYield(ALICE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.claimed).toBe(500);
    expect(w.stakeManager.getPendingYield(ALICE)).toBe(0);
  });
});

describe('GameWorld network stats', () => {
  it('aggregates totals across asteroids and players', async () => {
    const w = makeWorld();
    await w.connectPlayer(ALICE);
    await w.connectPlayer(BOB);
    await w.connectPlayer(CAROL);

    w.stake(ALICE, 'home', 100);
    w.stake(BOB, 'home', 200);
    w.stake(CAROL, 'rich', 300);
    w.joinAsteroid(ALICE, 'home');
    w.reportDrillPower(ALICE, 50);

    const stats = w.getNetworkStats();
    expect(stats.totalMiners).toBe(1);
    expect(stats.totalStake).toBe(600);
    expect(stats.totalDrillPower).toBeGreaterThanOrEqual(50);
    expect(stats.asteroids).toHaveLength(2);
  });
});

describe('GameWorld YieldPayoutListener routing (chain disabled)', () => {
  it('does NOT invoke the onYieldPayout callback when chainEnabled=false', () => {
    const onYieldPayout = vi.fn();
    const w = new GameWorld({
      asteroids: [HOME],
      logger: silentLogger,
      chainEnabled: false,
      onYieldPayout,
    });

    // Simulate a yield route by calling addPendingYield directly: this
    // is exactly the path stakeManager takes when chain is disabled.
    w.stakeManager.addPendingYield(ALICE, 'home', 500);
    expect(onYieldPayout).not.toHaveBeenCalled();
  });
});

describe('GameWorld YieldPayoutListener routing (chain enabled)', () => {
  it('routes yield-orchestrator payouts through the callback', async () => {
    const onYieldPayout = vi.fn();
    const w = new GameWorld({
      asteroids: [HOME],
      logger: silentLogger,
      chainEnabled: true,
      onYieldPayout,
    });
    await w.connectPlayer(ALICE);

    // Drive a discovery payout at an asteroid (no shares supplied so
    // 100% of the miner pool goes to the finder).
    const outcome = w.yieldOrchestrator.processDiscovery({
      asteroidId: 'home',
      finderWallet: ALICE,
      discoveryNumber: 1,
    });
    expect(outcome.totalYield).toBeGreaterThan(0);
    expect(onYieldPayout).toHaveBeenCalled();
  });
});

describe('GameWorld discovery sweep (mining trigger)', () => {
  // Deterministic posture: zero-variance yield (random=0.5) and a
  // reference drill power of 1 so timing math is exact.
  function discoveryWorld(payoutsOnChain = false, onYieldPayout?: () => void): GameWorld {
    return new GameWorld({
      asteroids: [HOME, RICH],
      logger: silentLogger,
      chainEnabled: payoutsOnChain,
      payoutsOnChain,
      discoveryReferenceDrillPower: 1,
      discoveryRandom: () => 0.5,
      ...(onYieldPayout && { onYieldPayout }),
    });
  }

  it('resolves no discovery before enough mining time elapses', async () => {
    const w = discoveryWorld();
    await w.connectPlayer(ALICE);
    w.joinAsteroid(ALICE, 'home');
    w.reportDrillPower(ALICE, 10);

    const t0 = 1_000_000;
    w.runDiscoverySweep(t0); // establish baseline
    // HOME threshold = 300_000ms × 1. 10 drill power × 10_000ms = 100_000 < threshold.
    w.runDiscoverySweep(t0 + 10_000);
    expect(w.stakeManager.getPendingYield(ALICE)).toBe(0);
  });

  it('credits IOU ledger when a discovery resolves (ledger posture)', async () => {
    const w = discoveryWorld();
    await w.connectPlayer(ALICE);
    w.joinAsteroid(ALICE, 'home');
    w.reportDrillPower(ALICE, 10);

    const t0 = 1_000_000;
    w.runDiscoverySweep(t0);
    // 10 drill power × 60_000ms = 600_000 >= threshold 300_000 → 1 discovery (cap=1).
    w.runDiscoverySweep(t0 + 60_000);

    // totalYield = 100 (base × carbon 1.0 × asteroid 1.0 × variance 1.0).
    // Vault mode: vault cut = 20% (20) → raid vault; miner pool = 80; sole
    // finder gets 80 + 20% bonus (16) = 96.
    expect(w.stakeManager.getPendingYield(ALICE)).toBe(96);
    expect(w.raidVault.getBalance('home')).toBe(20);
    expect(w.getNetworkStats().totalDiscoveries).toBe(1);
  });

  it('broadcasts discovery_found when a discovery resolves', async () => {
    const w = discoveryWorld();
    const events: Array<{ event: string; data: unknown }> = [];
    w.setBroadcaster((event, data) => events.push({ event, data }));
    await w.connectPlayer(ALICE);
    w.joinAsteroid(ALICE, 'home');
    w.reportDrillPower(ALICE, 10);

    const t0 = 1_000_000;
    w.runDiscoverySweep(t0);
    w.runDiscoverySweep(t0 + 60_000);

    const found = events.filter((e) => e.event === 'discovery_found');
    expect(found).toHaveLength(1);
    expect(found[0]?.data).toMatchObject({
      asteroidId: 'home',
      finderWallet: ALICE,
      discoveryNumber: 1,
      totalYield: 100,
      finderYield: 96,
      minerCount: 1,
      foundAt: t0 + 60_000,
    });
  });

  it('does not pay the in-game ledger when payouts route on-chain', async () => {
    const onYieldPayout = vi.fn();
    const w = discoveryWorld(true, onYieldPayout);
    await w.connectPlayer(ALICE);
    w.joinAsteroid(ALICE, 'home');
    w.reportDrillPower(ALICE, 10);

    const t0 = 1_000_000;
    w.runDiscoverySweep(t0);
    w.runDiscoverySweep(t0 + 60_000);

    expect(onYieldPayout).toHaveBeenCalled();
    expect(w.stakeManager.getPendingYield(ALICE)).toBe(0);
  });

  it('does nothing when no miners are active', () => {
    const w = discoveryWorld();
    const t0 = 1_000_000;
    w.runDiscoverySweep(t0);
    w.runDiscoverySweep(t0 + 10_000_000);
    expect(w.getNetworkStats().totalDiscoveries).toBe(0);
  });

  it('honours discoveryEnabled=false', async () => {
    const w = new GameWorld({
      asteroids: [HOME],
      logger: silentLogger,
      discoveryEnabled: false,
      discoveryReferenceDrillPower: 1,
      discoveryRandom: () => 0.5,
    });
    await w.connectPlayer(ALICE);
    w.joinAsteroid(ALICE, 'home');
    w.reportDrillPower(ALICE, 10);

    const t0 = 1_000_000;
    w.runDiscoverySweep(t0);
    w.runDiscoverySweep(t0 + 10_000_000);
    expect(w.stakeManager.getPendingYield(ALICE)).toBe(0);
  });
});

describe('GameWorld IOU bridge debit/refund', () => {
  it('rejects bridgeDebit before authentication', () => {
    const w = makeWorld();
    const r = w.bridgeDebit(ALICE, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_authenticated');
  });

  it('rejects non-positive amounts', async () => {
    const w = makeWorld();
    await w.connectPlayer(ALICE);
    expect(w.bridgeDebit(ALICE, 0).ok).toBe(false);
    expect(w.bridgeDebit(ALICE, -5).ok).toBe(false);
    expect(w.bridgeDebit(ALICE, Number.NaN).ok).toBe(false);
  });

  it('debits in-game credits when the balance covers the amount', async () => {
    const w = makeWorld();
    await w.connectPlayer(ALICE);
    w.stakeManager.addPendingYield(ALICE, 'home', 100);

    const r = w.bridgeDebit(ALICE, 40);
    expect(r.ok).toBe(true);
    expect(w.stakeManager.getPendingYield(ALICE)).toBe(60);
  });

  it('rejects (without debiting) when credits are insufficient', async () => {
    const w = makeWorld();
    await w.connectPlayer(ALICE);
    w.stakeManager.addPendingYield(ALICE, 'home', 30);

    const r = w.bridgeDebit(ALICE, 40);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('rejected');
    expect(w.stakeManager.getPendingYield(ALICE)).toBe(30);
  });

  it('bridgeRefund restores a previously debited amount', async () => {
    const w = makeWorld();
    await w.connectPlayer(ALICE);
    w.stakeManager.addPendingYield(ALICE, 'home', 100);

    expect(w.bridgeDebit(ALICE, 40).ok).toBe(true);
    expect(w.stakeManager.getPendingYield(ALICE)).toBe(60);

    w.bridgeRefund(ALICE, 40);
    expect(w.stakeManager.getPendingYield(ALICE)).toBe(100);
  });
});

describe('GameWorld meteor strikes', () => {
  /** Deterministic RNG replaying a queue then repeating the last value. */
  function seq(values: number[]): () => number {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)] ?? 0;
  }

  /** A world whose meteor engine always spawns (chance=1) on the first candidate. */
  function meteorWorld(): GameWorld {
    return new GameWorld({
      asteroids: [HOME, RICH],
      logger: silentLogger,
      chainEnabled: false,
      meteor: {
        spawnChancePerTick: 1,
        warningMs: 90_000,
        vaultSkimPercent: 50,
        yieldPenaltyPercent: 40,
        yieldPenaltyMs: 300_000,
        deflectCostFraction: 0.1,
        minDeflectCost: 10,
        random: seq([0, 0]),
      },
    });
  }

  it('spawns an incoming meteor against a funded asteroid and broadcasts it', () => {
    const w = meteorWorld();
    w.raidVault.add('home', 1000);
    const events: Array<{ event: string; data: unknown }> = [];
    w.setBroadcaster((event, data) => events.push({ event, data }));

    const { spawned } = w.runMeteorSweep(1_000_000);
    expect(spawned).not.toBeNull();
    expect(spawned!.asteroidId).toBe('home');
    expect(spawned!.deflectCost).toBe(100); // 10% of 1000
    expect(events.some((e) => e.event === 'meteor_incoming')).toBe(true);
    expect(w.meteors.getActive()).toHaveLength(1);
  });

  it('deflectMeteor spends credits, routes them into the vault, and clears the threat', async () => {
    const w = meteorWorld();
    w.raidVault.add('home', 1000);
    await w.connectPlayer(ALICE);
    w.stakeManager.addPendingYield(ALICE, 'home', 500);

    // Spawn anchored to real time so the warning window is genuinely open
    // (deflectMeteor validates against the wall clock).
    const { spawned } = w.runMeteorSweep(Date.now());
    const id = spawned!.id;

    const r = w.deflectMeteor(ALICE, id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.cost).toBe(100);
    // Credits spent, payment routed into the vault (1000 + 100).
    expect(w.stakeManager.getPendingYield(ALICE)).toBe(400);
    expect(w.raidVault.getBalance('home')).toBe(1100);
    expect(w.meteors.getActive()).toHaveLength(0);
  });

  it('rejects deflection when the wallet cannot cover the cost', async () => {
    const w = meteorWorld();
    w.raidVault.add('home', 1000);
    await w.connectPlayer(ALICE);
    w.stakeManager.addPendingYield(ALICE, 'home', 50); // < 100 cost

    const { spawned } = w.runMeteorSweep(Date.now());
    const r = w.deflectMeteor(ALICE, spawned!.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('insufficient_credits');
    // Nothing spent; meteor still inbound.
    expect(w.stakeManager.getPendingYield(ALICE)).toBe(50);
    expect(w.meteors.getActive()).toHaveLength(1);
  });

  it('an undeflected meteor strikes: skims the vault and applies a yield penalty', () => {
    const w = meteorWorld();
    w.raidVault.add('home', 1000);
    const events: Array<{ event: string; data: unknown }> = [];
    w.setBroadcaster((event, data) => events.push({ event, data }));

    const { spawned } = w.runMeteorSweep(1_000_000);
    const impact = spawned!.impactAt.getTime();
    // No deflection. Advance to impact.
    const { struck } = w.runMeteorSweep(impact);
    expect(struck.length).toBeGreaterThanOrEqual(1);
    // 50% of 1000 skimmed -> 500 remains.
    expect(w.raidVault.getBalance('home')).toBe(500);
    // 40% discovery-yield penalty is active.
    expect(w.registry.getMeteorYieldMultiplier('home')).toBeCloseTo(0.6, 5);
    expect(events.some((e) => e.event === 'meteor_resolved')).toBe(true);
  });

  it('the yield penalty actually reduces a discovery payout', async () => {
    const w = new GameWorld({
      asteroids: [HOME, RICH],
      logger: silentLogger,
      chainEnabled: false,
      discoveryEnabled: true,
      discoveryReferenceDrillPower: 1,
      discoveryRandom: () => 0.5,
      meteor: {
        spawnChancePerTick: 1,
        warningMs: 90_000,
        vaultSkimPercent: 0,
        yieldPenaltyPercent: 50,
        yieldPenaltyMs: 600_000,
        random: seq([0, 0]),
      },
    });
    await w.connectPlayer(ALICE);
    w.joinAsteroid(ALICE, 'home');
    w.reportDrillPower(ALICE, 10);

    const t0 = 1_000_000;
    w.runDiscoverySweep(t0); // establish the time anchor (no discovery yet)

    // Strike home so a 50% yield penalty is active.
    w.raidVault.add('home', 1000);
    const { spawned } = w.runMeteorSweep(t0);
    w.runMeteorSweep(spawned!.impactAt.getTime());
    expect(w.registry.getMeteorYieldMultiplier('home')).toBeCloseTo(0.5, 5);

    // Drive a discovery: total = 100 × 0.5 penalty = 50; vault cut 20% (10),
    // miner pool 40; sole finder gets 40 + 20% bonus (8) = 48.
    const before = w.stakeManager.getPendingYield(ALICE);
    w.runDiscoverySweep(t0 + 60_000);
    expect(w.stakeManager.getPendingYield(ALICE)).toBeGreaterThan(before);
    // The per-discovery payout is roughly half of the unpenalised 96.
    expect(w.stakeManager.getPendingYield(ALICE) - before).toBeLessThan(96);
  });
});
