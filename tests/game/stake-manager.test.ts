/**
 * Unit tests for `server/game/stake-manager.ts`.
 *
 * Pairs the real `AsteroidRegistry` (so registry/stake mutations can
 * be observed end-to-end) with optional in-memory `BetEscrowLike` and
 * `HomeStationStore` doubles. Covers: miner-state lazy creation,
 * home-station set/restore (including persistence), stake/unstake
 * (cap, multiple asteroids, total propagation), bet processing
 * (20% cap, no-op-on-fail), bet burn, defender pending-yield,
 * drill-power and defense-power formulas (smoke-tested against the
 * shared types-test asserted values), the 50% stake-weighted yield
 * share, raid bookkeeping, loyalty-day refresh.
 *
 * Numerical values come from `STAKE_TIERS` in `types.ts` and are
 * already exhaustively tested in `types.test.ts` — these tests verify
 * the manager wires them up correctly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AsteroidDefinition, ResourceType } from '../../config/asteroids.js';
import { AsteroidRegistry } from '../../server/game/asteroid-registry.js';
import type {
  BetEscrowLike,
  GameLogger,
  HomeStationStore,
  PendingYieldStore,
  YieldLedger,
} from '../../server/game/interfaces.js';
import { StakeManager } from '../../server/game/stake-manager.js';
import { calculateDefensePower, calculateEffectiveDrillPower } from '../../server/game/types.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function def(id: string, resource: ResourceType = 'carbon'): AsteroidDefinition {
  return {
    id,
    name: `Asteroid ${id}`,
    resource,
    sector: 'Belt-A',
    position: { x: 0, y: 0, z: 0 },
    baseDiscoveryTimeMs: 5 * 60 * 1000,
    baseRewardMultiplier: 1,
    description: 'test',
  };
}

interface Harness {
  manager: StakeManager;
  registry: AsteroidRegistry;
}

function makeHarness(
  opts: {
    betEscrow?: BetEscrowLike;
    homeStationStore?: HomeStationStore;
    pendingYieldStore?: PendingYieldStore;
    yieldLedger?: YieldLedger;
    asteroids?: AsteroidDefinition[];
    quarryEnabled?: boolean;
    drillPowerBound?: { freeBase: number; perStakeToken: number };
  } = {},
): Harness {
  const registry = new AsteroidRegistry({
    asteroids: opts.asteroids ?? [def('A'), def('B'), def('C', 'gold')],
    logger: silentLogger,
  });
  const manager = new StakeManager({
    registry,
    betEscrow: opts.betEscrow,
    homeStationStore: opts.homeStationStore,
    pendingYieldStore: opts.pendingYieldStore,
    yieldLedger: opts.yieldLedger,
    quarryEnabled: opts.quarryEnabled,
    ...(opts.drillPowerBound && { drillPowerBound: opts.drillPowerBound }),
    logger: silentLogger,
  });
  return { manager, registry };
}

/** In-memory `YieldLedger` double recording append-only events. */
function fakeYieldLedger(seedBalances: Record<string, number> = {}): YieldLedger & {
  credits: Array<[string, string, number]>;
  claims: Array<[string, number]>;
  redeems: Array<[string, number]>;
} {
  const credits: Array<[string, string, number]> = [];
  const claims: Array<[string, number]> = [];
  const redeems: Array<[string, number]> = [];
  return {
    credits,
    claims,
    redeems,
    recordCredit(wallet, asteroidId, amount) {
      credits.push([wallet, asteroidId, amount]);
    },
    recordClaim(wallet, amount) {
      claims.push([wallet, amount]);
    },
    recordRedeem(wallet, amount) {
      redeems.push([wallet, amount]);
    },
    getAllBalances() {
      return new Map(Object.entries(seedBalances));
    },
  };
}

/** In-memory `PendingYieldStore` double that records write-through calls. */
function fakePendingYieldStore(seed: Record<string, number> = {}): PendingYieldStore & {
  map: Map<string, number>;
  setCalls: Array<[string, number]>;
  deleteCalls: string[];
} {
  const map = new Map<string, number>(Object.entries(seed));
  const setCalls: Array<[string, number]> = [];
  const deleteCalls: string[] = [];
  return {
    map,
    setCalls,
    deleteCalls,
    set(wallet, amount) {
      setCalls.push([wallet, amount]);
      map.set(wallet, amount);
    },
    delete(wallet) {
      deleteCalls.push(wallet);
      map.delete(wallet);
    },
    getAll() {
      return new Map(map);
    },
  };
}

const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';

describe('StakeManager miner state', () => {
  it('lazily creates miner state on first access', () => {
    const { manager } = makeHarness();
    const s = manager.getMinerState(ALICE);
    expect(s.walletAddress).toBe(ALICE);
    expect(s.homeStationAsteroidId).toBeNull();
    expect(s.totalStake).toBe(0);
    expect(s.cooldowns).toEqual([]);
  });

  it('returns the same instance on subsequent calls', () => {
    const { manager } = makeHarness();
    const a = manager.getMinerState(ALICE);
    const b = manager.getMinerState(ALICE);
    expect(a).toBe(b);
  });

  it('getAllMinerStates lists every wallet that has been touched', () => {
    const { manager } = makeHarness();
    manager.getMinerState(ALICE);
    manager.getMinerState(BOB);
    expect(
      manager
        .getAllMinerStates()
        .map((s) => s.walletAddress)
        .sort(),
    ).toEqual([ALICE, BOB].sort());
  });
});

describe('StakeManager home station', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('setHomeStation rejects unknown asteroid ids', () => {
    const { manager } = makeHarness();
    expect(manager.setHomeStation(ALICE, 'NOPE')).toBe(false);
    expect(manager.getMinerState(ALICE).homeStationAsteroidId).toBeNull();
  });

  it('setHomeStation populates miner state and persists to the store', () => {
    let stored: { wallet: string; asteroidId: string } | null = null;
    const store: HomeStationStore = {
      set: (wallet, asteroidId) => {
        stored = { wallet, asteroidId };
      },
      get: () => null,
    };
    const { manager } = makeHarness({ homeStationStore: store });
    expect(manager.setHomeStation(ALICE, 'A')).toBe(true);

    const state = manager.getMinerState(ALICE);
    expect(state.homeStationAsteroidId).toBe('A');
    // Setting home does not start mining: activeAsteroidId stays null until an
    // explicit joinAsteroid registers the miner.
    expect(state.activeAsteroidId).toBeNull();
    expect(state.homeStationJoinedAt).toBeInstanceOf(Date);
    expect(state.loyaltyDays).toBe(0);
    expect(stored).toEqual({ wallet: ALICE, asteroidId: 'A' });
  });

  it('restoreHomeStation reads from the store and applies it to miner state', async () => {
    const store: HomeStationStore = {
      set: () => {},
      get: () => 'B',
    };
    const { manager } = makeHarness({ homeStationStore: store });
    const restored = await manager.restoreHomeStation(ALICE);
    expect(restored).toBe('B');
    expect(manager.getMinerState(ALICE).homeStationAsteroidId).toBe('B');
    // Restoring home on reconnect must NOT mark the player as actively mining;
    // they aren't registered in the mine registry until they join.
    expect(manager.getMinerState(ALICE).activeAsteroidId).toBeNull();
  });

  it('restoreHomeStation returns null when nothing is stored', async () => {
    const { manager } = makeHarness();
    expect(await manager.restoreHomeStation(ALICE)).toBeNull();
  });

  it('restoreHomeStation swallows store errors and returns null', async () => {
    const store: HomeStationStore = {
      set: () => {},
      get: () => {
        throw new Error('boom');
      },
    };
    const { manager } = makeHarness({ homeStationStore: store });
    expect(await manager.restoreHomeStation(ALICE)).toBeNull();
  });
});

describe('StakeManager stake / unstake', () => {
  it('rejects non-positive amounts', () => {
    const { manager } = makeHarness();
    expect(manager.stake(ALICE, 'A', 0)).toBe(false);
    expect(manager.stake(ALICE, 'A', -50)).toBe(false);
  });

  it('rejects unknown asteroid', () => {
    const { manager } = makeHarness();
    expect(manager.stake(ALICE, 'NOPE', 100)).toBe(false);
  });

  it('first stake auto-sets home station', () => {
    const { manager } = makeHarness();
    expect(manager.stake(ALICE, 'A', 100)).toBe(true);
    expect(manager.getMinerState(ALICE).homeStationAsteroidId).toBe('A');
  });

  it('subsequent stakes at the same asteroid accumulate', () => {
    const { manager } = makeHarness();
    manager.stake(ALICE, 'A', 100);
    manager.stake(ALICE, 'A', 50);
    expect(manager.getStakeAtAsteroid(ALICE, 'A')).toBe(150);
    expect(manager.getMinerState(ALICE).totalStake).toBe(150);
  });

  it('stakes at multiple asteroids stay separate but sum into totalStake', () => {
    const { manager } = makeHarness();
    manager.stake(ALICE, 'A', 100);
    manager.stake(ALICE, 'B', 200);
    expect(manager.getStakeAtAsteroid(ALICE, 'A')).toBe(100);
    expect(manager.getStakeAtAsteroid(ALICE, 'B')).toBe(200);
    expect(manager.getTotalStake(ALICE)).toBe(300);
  });

  it('stake propagates to the registry totalStake', () => {
    const { manager, registry } = makeHarness();
    manager.stake(ALICE, 'A', 100);
    manager.stake(BOB, 'A', 50);
    expect(registry.getAsteroid('A')?.totalStake).toBe(150);
  });

  it('unstake removes amount and clears the row when stake hits zero', () => {
    const { manager, registry } = makeHarness();
    manager.stake(ALICE, 'A', 100);
    expect(manager.unstake(ALICE, 'A', 60)).toBe(true);
    expect(manager.getStakeAtAsteroid(ALICE, 'A')).toBe(40);

    expect(manager.unstake(ALICE, 'A', 1000)).toBe(true); // capped at remaining
    expect(manager.getStakeAtAsteroid(ALICE, 'A')).toBe(0);
    expect(manager.getWalletStakes(ALICE)).toHaveLength(0);
    expect(registry.getAsteroid('A')?.totalStake).toBe(0);
  });

  it('requestUnstake rejects when no stakes exist', () => {
    const { manager } = makeHarness();
    expect(manager.requestUnstake(ALICE, 'A', 100)).toEqual({
      success: false,
      error: 'No stakes found',
    });
  });

  it('requestUnstake rejects when no stake at the requested asteroid', () => {
    const { manager } = makeHarness();
    manager.stake(ALICE, 'A', 100);
    expect(manager.requestUnstake(ALICE, 'B', 100).error).toContain('No stake at this asteroid');
  });

  it('requestUnstake surfaces a warning when the wallet has locked bets', () => {
    const lockedAmount = 25;
    const escrow: BetEscrowLike = {
      hasLockedBets: () => true,
      getLockedBetAmount: () => lockedAmount,
    };
    const { manager } = makeHarness({ betEscrow: escrow });
    manager.stake(ALICE, 'A', 100);
    const result = manager.requestUnstake(ALICE, 'A', 50);
    expect(result.success).toBe(true);
    expect(result.warning).toContain(`${lockedAmount}`);
    expect(result.warning).toContain('$ASTROID');
  });
});

describe('StakeManager bets', () => {
  it('processBet caps at 20% of stake', () => {
    const { manager } = makeHarness();
    manager.stake(ALICE, 'A', 100);
    expect(manager.processBet(ALICE, 'A', 20)).toBe(true);
    expect(manager.processBet(ALICE, 'A', 21)).toBe(false);
  });

  it('processBet returns false when wallet has zero stake', () => {
    const { manager } = makeHarness();
    expect(manager.processBet(ALICE, 'A', 1)).toBe(false);
  });

  it('burnBet unstakes the amount permanently', () => {
    const { manager } = makeHarness();
    manager.stake(ALICE, 'A', 100);
    manager.burnBet(ALICE, 'A', 30);
    expect(manager.getStakeAtAsteroid(ALICE, 'A')).toBe(70);
  });

  it('returnBetWithWinnings does not move stake (chain layer is responsible)', () => {
    const { manager } = makeHarness();
    manager.stake(ALICE, 'A', 100);
    manager.returnBetWithWinnings(ALICE, 'A', 10, 5);
    expect(manager.getStakeAtAsteroid(ALICE, 'A')).toBe(100);
  });
});

describe('StakeManager defense / drill power', () => {
  it('getDefensePower honours home-station bonus from calculateDefensePower', () => {
    const { manager } = makeHarness();
    manager.setHomeStation(ALICE, 'A');
    manager.stake(ALICE, 'A', 100);

    expect(manager.getDefensePower(ALICE, 'A')).toBeCloseTo(calculateDefensePower(100, true), 10);
    expect(manager.getDefensePower(ALICE, 'B')).toBeCloseTo(calculateDefensePower(0, false), 10);
  });

  it('getTotalDefensePower sums every staker at an asteroid', () => {
    const { manager } = makeHarness();
    // ALICE's home is A (defenders at home).
    manager.setHomeStation(ALICE, 'A');
    manager.stake(ALICE, 'A', 100);
    // BOB's home is B (so his stake at A is "away" defense — no 1.5x bonus).
    manager.setHomeStation(BOB, 'B');
    manager.stake(BOB, 'A', 200);

    const expected = calculateDefensePower(100, true) + calculateDefensePower(200, false);
    expect(manager.getTotalDefensePower('A')).toBeCloseTo(expected, 10);
  });

  it('getEffectiveDrillPower wires up the BG formula with the right resource class', () => {
    const { manager } = makeHarness();
    manager.stake(ALICE, 'C', 100); // 'C' is gold
    const expected = calculateEffectiveDrillPower(50, 100, 0, 'gold');
    expect(manager.getEffectiveDrillPower(ALICE, 50, 'C')).toBeCloseTo(expected, 10);
  });

  it('getEffectiveDrillPower returns base when asteroid is unknown', () => {
    const { manager } = makeHarness();
    expect(manager.getEffectiveDrillPower(ALICE, 50, 'NOPE')).toBe(50);
  });
});

describe('StakeManager drill-power anti-spoof bound', () => {
  it('is a no-op when no bound is configured (legacy behaviour)', () => {
    const { manager } = makeHarness();
    // 10M base with zero stake passes straight through (Base tier ×1).
    expect(manager.getEffectiveDrillPower(ALICE, 10_000_000, 'A')).toBe(10_000_000);
  });

  it('clamps a spoofed base to freeBase when the wallet has no stake', () => {
    const { manager } = makeHarness({ drillPowerBound: { freeBase: 5000, perStakeToken: 1 } });
    // No stake → max base = 5000; the reported 10M is clamped, then ×1 Base tier.
    expect(manager.getEffectiveDrillPower(ALICE, 10_000_000, 'A')).toBe(5000);
  });

  it('lets stake raise the allowed base, then applies the tier multiplier', () => {
    const { manager } = makeHarness({
      quarryEnabled: true,
      drillPowerBound: { freeBase: 5000, perStakeToken: 1 },
    });
    manager.setHomeStation(ALICE, 'A');
    manager.setOnChainStake(ALICE, 50_000); // Silver → 2.0× drill, max base = 5000 + 50000
    // Reported 1M base is clamped to 55,000, then ×2.0 Silver tier = 110,000.
    expect(manager.getEffectiveDrillPower(ALICE, 1_000_000, 'A')).toBe(110_000);
  });

  it('leaves an honest sub-baseline report unchanged', () => {
    const { manager } = makeHarness({ drillPowerBound: { freeBase: 5000, perStakeToken: 1 } });
    expect(manager.getEffectiveDrillPower(ALICE, 4000, 'A')).toBe(4000);
  });
});

describe('StakeManager yield share + pending yield', () => {
  it('calculateYieldShare returns 0 when asteroid has no stake', () => {
    const { manager } = makeHarness();
    expect(manager.calculateYieldShare(ALICE, 'A', 1000)).toBe(0);
  });

  it('calculateYieldShare distributes 50% by stake weight', () => {
    const { manager } = makeHarness();
    manager.stake(ALICE, 'A', 100);
    manager.stake(BOB, 'A', 300);
    // ALICE owns 1/4 of the stake; gets 0.5 * 0.25 * 1000 = 125
    expect(manager.calculateYieldShare(ALICE, 'A', 1000)).toBeCloseTo(125, 10);
    expect(manager.calculateYieldShare(BOB, 'A', 1000)).toBeCloseTo(375, 10);
  });

  it('addPendingYield + getPendingYield + claimPendingYield round-trips correctly', () => {
    const { manager } = makeHarness();
    manager.addPendingYield(ALICE, 'A', 50);
    manager.addPendingYield(ALICE, 'A', 25);
    expect(manager.getPendingYield(ALICE)).toBe(75);
    expect(manager.claimPendingYield(ALICE)).toBe(75);
    expect(manager.getPendingYield(ALICE)).toBe(0);
    expect(manager.claimPendingYield(ALICE)).toBe(0);
  });

  it('getAllPendingYield + getTotalPendingYield aggregate', () => {
    const { manager } = makeHarness();
    manager.addPendingYield(ALICE, 'A', 10);
    manager.addPendingYield(BOB, 'A', 20);
    expect(manager.getAllPendingYield().size).toBe(2);
    expect(manager.getTotalPendingYield()).toBe(30);
  });
});

describe('StakeManager pending-yield persistence', () => {
  it('writes the running total through to the store on addPendingYield', () => {
    const store = fakePendingYieldStore();
    const { manager } = makeHarness({ pendingYieldStore: store });
    manager.addPendingYield(ALICE, 'A', 50);
    manager.addPendingYield(ALICE, 'A', 25);
    // Each add persists the cumulative total, not the delta.
    expect(store.setCalls).toEqual([
      [ALICE, 50],
      [ALICE, 75],
    ]);
    expect(store.map.get(ALICE)).toBe(75);
  });

  it('deletes the persisted entry on claim', () => {
    const store = fakePendingYieldStore();
    const { manager } = makeHarness({ pendingYieldStore: store });
    manager.addPendingYield(ALICE, 'A', 40);
    manager.claimPendingYield(ALICE);
    expect(store.deleteCalls).toEqual([ALICE]);
    expect(store.map.has(ALICE)).toBe(false);
  });

  it('restorePendingYield reloads persisted balances into memory', async () => {
    const store = fakePendingYieldStore({ [ALICE]: 123, [BOB]: 7 });
    const { manager } = makeHarness({ pendingYieldStore: store });
    expect(manager.getPendingYield(ALICE)).toBe(0);
    const restored = await manager.restorePendingYield();
    expect(restored).toBe(2);
    expect(manager.getPendingYield(ALICE)).toBe(123);
    expect(manager.getPendingYield(BOB)).toBe(7);
  });

  it('restorePendingYield skips non-positive balances and returns 0 without a store', async () => {
    const store = fakePendingYieldStore({ [ALICE]: 0, [BOB]: 5 });
    const { manager } = makeHarness({ pendingYieldStore: store });
    expect(await manager.restorePendingYield()).toBe(1);
    expect(manager.getPendingYield(ALICE)).toBe(0);

    const { manager: noStore } = makeHarness();
    expect(await noStore.restorePendingYield()).toBe(0);
  });

  it('a store write failure never throws to the caller', () => {
    const failing: PendingYieldStore = {
      set: () => Promise.reject(new Error('redis down')),
      delete: () => Promise.reject(new Error('redis down')),
      getAll: () => new Map(),
    };
    const { manager } = makeHarness({ pendingYieldStore: failing });
    expect(() => manager.addPendingYield(ALICE, 'A', 10)).not.toThrow();
    expect(() => manager.claimPendingYield(ALICE)).not.toThrow();
    // In-memory value stays correct regardless of the store failure.
    expect(manager.getPendingYield(ALICE)).toBe(0);
  });
});

describe('StakeManager yield ledger (audit log)', () => {
  it('records a credit event with the originating asteroid on addPendingYield', () => {
    const ledger = fakeYieldLedger();
    const { manager } = makeHarness({ yieldLedger: ledger });
    manager.addPendingYield(ALICE, 'A', 50);
    manager.addPendingYield(ALICE, 'B', 25);
    // Each add records its own delta + asteroid (not the running total).
    expect(ledger.credits).toEqual([
      [ALICE, 'A', 50],
      [ALICE, 'B', 25],
    ]);
    expect(manager.getPendingYield(ALICE)).toBe(75);
  });

  it('records a claim event for the claimed amount', () => {
    const ledger = fakeYieldLedger();
    const { manager } = makeHarness({ yieldLedger: ledger });
    manager.addPendingYield(ALICE, 'A', 40);
    manager.claimPendingYield(ALICE);
    expect(ledger.claims).toEqual([[ALICE, 40]]);
  });

  it('does not record a claim event when there is nothing to claim', () => {
    const ledger = fakeYieldLedger();
    const { manager } = makeHarness({ yieldLedger: ledger });
    manager.claimPendingYield(ALICE);
    expect(ledger.claims).toEqual([]);
  });

  it('restorePendingYield prefers the ledger-derived balances', async () => {
    const ledger = fakeYieldLedger({ [ALICE]: 200, [BOB]: 13 });
    const { manager } = makeHarness({ yieldLedger: ledger });
    const restored = await manager.restorePendingYield();
    expect(restored).toBe(2);
    expect(manager.getPendingYield(ALICE)).toBe(200);
    expect(manager.getPendingYield(BOB)).toBe(13);
  });

  it('a ledger write failure never throws to the caller', () => {
    const failing: YieldLedger = {
      recordCredit: () => Promise.reject(new Error('db down')),
      recordClaim: () => Promise.reject(new Error('db down')),
      recordRedeem: () => Promise.reject(new Error('db down')),
      getAllBalances: () => new Map(),
    };
    const { manager } = makeHarness({ yieldLedger: failing });
    expect(() => manager.addPendingYield(ALICE, 'A', 10)).not.toThrow();
    expect(() => manager.claimPendingYield(ALICE)).not.toThrow();
  });
});

describe('StakeManager raid bookkeeping', () => {
  it('registerActiveRaid + unregisterActiveRaid round-trip', () => {
    const { manager } = makeHarness();
    manager.registerActiveRaid(ALICE, 'r1');
    manager.registerActiveRaid(ALICE, 'r2');
    expect(manager.getActiveRaidCount(ALICE)).toBe(2);
    expect(manager.hasActiveRaids(ALICE)).toBe(true);

    manager.unregisterActiveRaid(ALICE, 'r1');
    manager.unregisterActiveRaid(ALICE, 'r2');
    expect(manager.getActiveRaidCount(ALICE)).toBe(0);
    expect(manager.hasActiveRaids(ALICE)).toBe(false);
  });

  it('asteroid-under-attack count increments and decrements', () => {
    const { manager } = makeHarness();
    manager.registerAsteroidUnderAttack('A');
    manager.registerAsteroidUnderAttack('A');
    expect(manager.isAsteroidUnderAttack('A')).toBe(true);

    manager.unregisterAsteroidAttack('A');
    expect(manager.isAsteroidUnderAttack('A')).toBe(true);
    manager.unregisterAsteroidAttack('A');
    expect(manager.isAsteroidUnderAttack('A')).toBe(false);
  });

  it('getLockedBetAmount delegates to the bet-escrow stub', () => {
    const escrow: BetEscrowLike = {
      hasLockedBets: () => true,
      getLockedBetAmount: () => 42,
    };
    const { manager } = makeHarness({ betEscrow: escrow });
    expect(manager.getLockedBetAmount(ALICE)).toBe(42);
  });

  it('isQuarryEnabled defaults to false and reflects the config', () => {
    const { manager } = makeHarness();
    expect(manager.isQuarryEnabled()).toBe(false);
    const m2 = new StakeManager({
      registry: new AsteroidRegistry({ logger: silentLogger }),
      quarryEnabled: true,
      logger: silentLogger,
    });
    expect(m2.isQuarryEnabled()).toBe(true);
  });
});

describe('StakeManager loyalty / cooldown maintenance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('updateLoyaltyDays updates miner + home-station stake records', () => {
    const { manager } = makeHarness();
    manager.stake(ALICE, 'A', 100); // sets home station to 'A'
    manager.stake(ALICE, 'B', 50); // not home

    vi.advanceTimersByTime(7.5 * 24 * 60 * 60 * 1000); // 7.5 days
    manager.updateLoyaltyDays();

    const state = manager.getMinerState(ALICE);
    expect(state.loyaltyDays).toBe(7);

    const stakes = manager.getWalletStakes(ALICE);
    const home = stakes.find((s) => s.asteroidId === 'A')!;
    const away = stakes.find((s) => s.asteroidId === 'B')!;
    expect(home.loyaltyDays).toBe(7);
    expect(away.loyaltyDays).toBe(0);
  });

  it('clearExpiredCooldowns drops past entries from miner state', () => {
    const { manager } = makeHarness();
    const state = manager.getMinerState(ALICE);
    state.cooldowns = [
      {
        walletAddress: ALICE,
        type: 'expedition_start',
        expiresAt: new Date(Date.now() - 1000),
      },
      {
        walletAddress: ALICE,
        type: 'expedition_recovery',
        expiresAt: new Date(Date.now() + 60 * 1000),
      },
    ];

    manager.clearExpiredCooldowns();
    expect(manager.getMinerState(ALICE).cooldowns).toHaveLength(1);
    expect(manager.getMinerState(ALICE).cooldowns[0]?.type).toBe('expedition_recovery');
  });

  it('getAsteroidStakers returns one record per stake (ignores zero-amount rows)', () => {
    const { manager } = makeHarness();
    manager.stake(ALICE, 'A', 100);
    manager.stake(BOB, 'A', 50);
    manager.unstake(ALICE, 'A', 100); // alice's row is removed

    expect(manager.getAsteroidStakers('A').map((s) => s.walletAddress)).toEqual([BOB]);
  });
});

describe('StakeManager on-chain stake reconciliation (Quarry mode)', () => {
  it('on-chain stake drives the drill-power tier where the wallet is present', () => {
    const { manager } = makeHarness({ quarryEnabled: true });
    manager.setHomeStation(ALICE, 'A'); // A becomes active + home
    manager.setOnChainStake(ALICE, 50_000); // Silver tier → 2.0× drill

    // Present at A → tier applies; carbon loyalty 0 days adds no bonus.
    expect(manager.getEffectiveDrillPower(ALICE, 1000, 'A')).toBe(
      calculateEffectiveDrillPower(1000, 50_000, 0, 'carbon'),
    );
    expect(manager.getEffectiveDrillPower(ALICE, 1000, 'A')).toBe(2000);

    // Not present at B → no buff (Base tier).
    expect(manager.getStakeAtAsteroid(ALICE, 'B')).toBe(0);
    expect(manager.getEffectiveDrillPower(ALICE, 1000, 'B')).toBe(1000);
  });

  it('fully unstaking on-chain (amount 0) drops the wallet back to Base tier', () => {
    const { manager } = makeHarness({ quarryEnabled: true });
    manager.setHomeStation(ALICE, 'A');
    manager.setOnChainStake(ALICE, 1_000_000); // Diamond → 3.0×
    expect(manager.getEffectiveDrillPower(ALICE, 1000, 'A')).toBe(3000);

    manager.setOnChainStake(ALICE, 0);
    expect(manager.getStakeAtAsteroid(ALICE, 'A')).toBe(0);
    expect(manager.getEffectiveDrillPower(ALICE, 1000, 'A')).toBe(1000);
  });

  it('ignores the legacy in-game stake mirror entirely in Quarry mode', () => {
    const { manager } = makeHarness({ quarryEnabled: true });
    manager.setHomeStation(ALICE, 'A');
    manager.stake(ALICE, 'A', 1000); // in-game stake is the wrong source now
    expect(manager.getStakeAtAsteroid(ALICE, 'A')).toBe(0);
  });

  it('on-chain stake feeds defense and total defense at the present asteroid', () => {
    const { manager } = makeHarness({ quarryEnabled: true });
    manager.setHomeStation(ALICE, 'A');
    manager.setHomeStation(BOB, 'A');
    manager.setOnChainStake(ALICE, 500);
    manager.setOnChainStake(BOB, 1000);

    expect(manager.getDefensePower(ALICE, 'A')).toBe(calculateDefensePower(500, true));
    expect(manager.getTotalDefensePower('A')).toBe(
      calculateDefensePower(500, true) + calculateDefensePower(1000, true),
    );
  });

  it('setOnChainStake is a no-op when Quarry is disabled', () => {
    const { manager } = makeHarness(); // quarryEnabled defaults to false
    manager.setHomeStation(ALICE, 'A');
    manager.setOnChainStake(ALICE, 5000);
    expect(manager.getOnChainStake(ALICE)).toBe(0);
    // Legacy mirror is still the source of truth.
    expect(manager.getStakeAtAsteroid(ALICE, 'A')).toBe(0);
  });

  it('getDisplayStake reports on-chain stake under Quarry, in-game otherwise', () => {
    const quarry = makeHarness({ quarryEnabled: true }).manager;
    quarry.setOnChainStake(ALICE, 1000);
    expect(quarry.getDisplayStake(ALICE)).toBe(1000);

    const sim = makeHarness().manager; // quarry off
    sim.setHomeStation(ALICE, 'A');
    sim.stake(ALICE, 'A', 250);
    expect(sim.getDisplayStake(ALICE)).toBe(250);
  });
});

describe('StakeManager lifetime rewards accumulator', () => {
  it('tracks lifetime earned across multiple credits without decrementing', () => {
    const { manager } = makeHarness();
    manager.addPendingYield(ALICE, 'A', 100);
    manager.addPendingYield(ALICE, 'A', 40);
    expect(manager.getPendingYield(ALICE)).toBe(140);
    expect(manager.getLifetimeEarned(ALICE)).toBe(140);
    expect(manager.getLifetimeRedeemed(ALICE)).toBe(0);
  });

  it('records lifetime redeemed when credits are moved on-chain, leaving earned intact', () => {
    const { manager } = makeHarness();
    manager.addPendingYield(ALICE, 'A', 100);
    expect(manager.redeemPendingYield(ALICE, 60)).toBe(true);

    expect(manager.getPendingYield(ALICE)).toBe(40); // claimable remaining
    expect(manager.getLifetimeEarned(ALICE)).toBe(100); // earned never drops
    expect(manager.getLifetimeRedeemed(ALICE)).toBe(60); // what was claimed out
  });

  it('seeds lifetime totals from the ledger on restore', async () => {
    const totals = new Map([[ALICE, { earned: 500, redeemed: 200 }]]);
    const ledger: YieldLedger = {
      recordCredit: () => {},
      recordClaim: () => {},
      recordRedeem: () => {},
      getAllBalances: () => new Map([[ALICE, 300]]),
      getLifetimeTotals: () => totals,
    };
    const { manager } = makeHarness({ yieldLedger: ledger });
    await manager.restorePendingYield();

    expect(manager.getPendingYield(ALICE)).toBe(300);
    expect(manager.getLifetimeEarned(ALICE)).toBe(500);
    expect(manager.getLifetimeRedeemed(ALICE)).toBe(200);
  });
});
