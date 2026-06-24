/**
 * Unit tests for `server/game/refinery-manager.ts`.
 *
 * Covers the BG-equivalent surface: yield split (70/30), refinery
 * accumulation, miner-contribution updates (incl. carbon-loyalty
 * bonus), the score formula, distribution behaviour (all early-exit
 * branches + the proportional-payout path), distribution cadence,
 * inspection helpers, and the per-miner pending-share estimator.
 *
 * Numerical values come from `STAKE_TIERS` in `types.ts` (already
 * exhaustively tested in `types.test.ts`); these tests verify the
 * manager wires them in correctly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GameLogger } from '../../server/game/interfaces.js';
import { RefineryManager } from '../../server/game/refinery-manager.js';
import type { MinerContribution } from '../../server/game/types.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';

function makeMgr(opts: { distributionIntervalMs?: number } = {}): RefineryManager {
  return new RefineryManager({
    logger: silentLogger,
    distributionIntervalMs: opts.distributionIntervalMs,
  });
}

describe('RefineryManager.calculateYieldSplit', () => {
  it('splits 70/30 with floor on each share', () => {
    const m = makeMgr();
    expect(m.calculateYieldSplit(100)).toEqual({ finderShare: 70, refineryShare: 30 });
    expect(m.calculateYieldSplit(0)).toEqual({ finderShare: 0, refineryShare: 0 });
  });

  it('floors both shares (BG behaviour: dust may be lost on uneven totals)', () => {
    const m = makeMgr();
    // 13 * 0.7 = 9.1 -> 9; 13 * 0.3 = 3.9 -> 3; sum = 12, dust = 1.
    expect(m.calculateYieldSplit(13)).toEqual({ finderShare: 9, refineryShare: 3 });
  });
});

describe('RefineryManager refinery state', () => {
  it('initializeRefinery creates a fresh row with default fields', () => {
    const m = makeMgr();
    const r = m.initializeRefinery('A');
    expect(r.asteroidId).toBe('A');
    expect(r.balance).toBe(0);
    expect(r.pendingDistribution).toBe(0);
    expect(r.totalDistributed).toBe(0);
    expect(r.distributionCount).toBe(0);
    expect(r.hourlyContributions.size).toBe(0);
    expect(r.lastDistributionTime).toBeInstanceOf(Date);
  });

  it('getOrCreateRefinery is idempotent', () => {
    const m = makeMgr();
    const a = m.getOrCreateRefinery('A');
    const b = m.getOrCreateRefinery('A');
    expect(a).toBe(b);
  });

  it('getRefinery returns undefined when nothing has been initialized', () => {
    const m = makeMgr();
    expect(m.getRefinery('A')).toBeUndefined();
    m.initializeRefinery('A');
    expect(m.getRefinery('A')).toBeDefined();
  });
});

describe('RefineryManager addToRefinery', () => {
  it('lazily creates the row on first add', () => {
    const m = makeMgr();
    const balance = m.addToRefinery('A', 30);
    expect(balance).toBe(30);
    const r = m.getRefinery('A')!;
    expect(r.balance).toBe(30);
    expect(r.pendingDistribution).toBe(30);
  });

  it('multiple adds accumulate into both balance and pending', () => {
    const m = makeMgr();
    m.addToRefinery('A', 10);
    m.addToRefinery('A', 25);
    const r = m.getRefinery('A')!;
    expect(r.balance).toBe(35);
    expect(r.pendingDistribution).toBe(35);
  });
});

describe('RefineryManager updateMinerContribution', () => {
  it('creates a fresh contribution on first update', () => {
    const m = makeMgr();
    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 100,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'carbon',
      deltaSeconds: 60,
    });
    const r = m.getRefinery('A')!;
    const c = r.hourlyContributions.get(ALICE)!;
    expect(c.drillPowerSeconds).toBe(100 * 60);
    expect(c.timeActiveSeconds).toBe(60);
    expect(c.loyaltyBonus).toBe(0);
    // Base tier (stake 0) defenseMultiplier = 1.0 -> drillPowerMultiplier = 1.0
    expect(c.stakeTierMultiplier).toBeCloseTo(1.0, 10);
  });

  it('subsequent updates accumulate drill-power-seconds and time', () => {
    const m = makeMgr();
    const args = {
      asteroidId: 'A' as const,
      walletAddress: ALICE,
      currentDrillPower: 100,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'carbon' as const,
      deltaSeconds: 60,
    };
    m.updateMinerContribution(args);
    m.updateMinerContribution(args);
    const c = m.getRefinery('A')!.hourlyContributions.get(ALICE)!;
    expect(c.drillPowerSeconds).toBe(100 * 60 * 2);
    expect(c.timeActiveSeconds).toBe(120);
  });

  it('carbon loyalty bonus kicks in at 7+ days', () => {
    const m = makeMgr();
    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 50,
      stakeAmount: 0,
      loyaltyDays: 6,
      resource: 'carbon',
      deltaSeconds: 30,
    });
    expect(m.getRefinery('A')!.hourlyContributions.get(ALICE)!.loyaltyBonus).toBe(0);

    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 50,
      stakeAmount: 0,
      loyaltyDays: 7,
      resource: 'carbon',
      deltaSeconds: 30,
    });
    expect(m.getRefinery('A')!.hourlyContributions.get(ALICE)!.loyaltyBonus).toBe(0.1);
  });

  it('non-carbon resources never get the loyalty bonus regardless of days', () => {
    const m = makeMgr();
    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 50,
      stakeAmount: 0,
      loyaltyDays: 365,
      resource: 'gold',
      deltaSeconds: 60,
    });
    expect(m.getRefinery('A')!.hourlyContributions.get(ALICE)!.loyaltyBonus).toBe(0);
  });

  it('stakeTierMultiplier reflects the current stake amount', () => {
    const m = makeMgr();
    // 5000 → Diamond → drillPowerMultiplier = 3.0
    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 100,
      stakeAmount: 1_000_000,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 30,
    });
    expect(m.getRefinery('A')!.hourlyContributions.get(ALICE)!.stakeTierMultiplier).toBeCloseTo(
      3.0,
      10,
    );
  });
});

describe('RefineryManager.calculateMinerScore', () => {
  it('returns 0 when totalDrillPowerSeconds is 0', () => {
    const m = makeMgr();
    const c: MinerContribution = {
      walletAddress: ALICE,
      drillPowerSeconds: 0,
      stakeTierMultiplier: 1.0,
      loyaltyBonus: 0,
      timeActiveSeconds: 0,
    };
    expect(m.calculateMinerScore(c, 0)).toBe(0);
  });

  it('formula matches BG: share × stakeFactor × (1 + loyalty) × min(1, t/3600)', () => {
    const m = makeMgr();
    const c: MinerContribution = {
      walletAddress: ALICE,
      drillPowerSeconds: 1800, // 30 minutes at drill power 1
      stakeTierMultiplier: 2.0,
      loyaltyBonus: 0.1,
      timeActiveSeconds: 1800,
    };
    // share = 1800 / 3600 = 0.5
    // stake = 2.0
    // loyalty = 1.1
    // time = min(1, 1800/3600) = 0.5
    // total = 0.5 * 2.0 * 1.1 * 0.5 = 0.55
    expect(m.calculateMinerScore(c, 3600)).toBeCloseTo(0.55, 10);
  });

  it('time factor caps at 1.0 (over-active miners do not over-earn)', () => {
    const m = makeMgr();
    const c: MinerContribution = {
      walletAddress: ALICE,
      drillPowerSeconds: 7200,
      stakeTierMultiplier: 1.0,
      loyaltyBonus: 0,
      timeActiveSeconds: 7200, // 2 hours
    };
    // share = 1, stake = 1, loyalty = 1, time = min(1, 7200/3600) = 1
    expect(m.calculateMinerScore(c, 7200)).toBeCloseTo(1.0, 10);
  });
});

describe('RefineryManager.distributeRefinery (early exits)', () => {
  it('returns null when refinery does not exist', () => {
    const m = makeMgr();
    expect(m.distributeRefinery('A')).toBeNull();
  });

  it('returns null when pending balance is below the minimum', () => {
    const m = makeMgr();
    m.getOrCreateRefinery('A'); // exists, but pending=0
    expect(m.distributeRefinery('A')).toBeNull();
  });

  it('returns null when refinery has balance but no contributors', () => {
    const m = makeMgr();
    m.addToRefinery('A', 100);
    expect(m.distributeRefinery('A')).toBeNull();
  });

  it('returns null when contributors have zero drill-power', () => {
    const m = makeMgr();
    m.addToRefinery('A', 100);
    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 0,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'carbon',
      deltaSeconds: 60,
    });
    expect(m.distributeRefinery('A')).toBeNull();
  });
});

describe('RefineryManager.distributeRefinery (happy path)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('distributes proportionally and clears state for the next hour', () => {
    const m = makeMgr();
    m.addToRefinery('A', 1000);

    // ALICE: 1h, drill power 100, no stake, no loyalty.
    // BOB:   1h, drill power 200, no stake, no loyalty.
    // Both have time factor 1, stake factor 1, loyalty 1 -> raw share == drill share.
    // ALICE: 100*3600 / (100*3600 + 200*3600) = 1/3
    // BOB:   2/3
    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 100,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });
    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: BOB,
      currentDrillPower: 200,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });

    const r = m.distributeRefinery('A')!;
    expect(r).not.toBeNull();
    expect(r.asteroidId).toBe('A');
    expect(r.minerCount).toBe(2);
    // Floor(1000 * 1/3) = 333, Floor(1000 * 2/3) = 666; sum = 999, dust = 1
    expect(r.payouts.get(ALICE)).toBe(333);
    expect(r.payouts.get(BOB)).toBe(666);
    expect(r.totalDistributed).toBe(999);

    const refinery = m.getRefinery('A')!;
    expect(refinery.balance).toBe(1); // 1000 - 999
    expect(refinery.pendingDistribution).toBe(0);
    expect(refinery.totalDistributed).toBe(999);
    expect(refinery.distributionCount).toBe(1);
    expect(refinery.hourlyContributions.size).toBe(0);
  });

  it('zero-payout miners (sub-1-token shares) are excluded from the payout map', () => {
    const m = makeMgr();
    m.addToRefinery('A', 5);

    // 100 miners each with equal contribution; 5/100 = 0.05 → floor = 0 → excluded.
    for (let i = 0; i < 100; i++) {
      m.updateMinerContribution({
        asteroidId: 'A',
        walletAddress: `wallet_${i}`,
        currentDrillPower: 1,
        stakeAmount: 0,
        loyaltyDays: 0,
        resource: 'gold',
        deltaSeconds: 3600,
      });
    }
    const r = m.distributeRefinery('A')!;
    expect(r).not.toBeNull();
    expect(r.payouts.size).toBe(0);
    expect(r.totalDistributed).toBe(0);
    // Pending was reset, so the dust is now uncollectable in this hour.
    expect(m.getRefinery('A')!.pendingDistribution).toBe(0);
  });

  it('distributeAllRefineries hits every refinery and updates lastDistributionCheck', () => {
    const m = makeMgr();
    m.addToRefinery('A', 100);
    m.addToRefinery('B', 200);
    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 10,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'carbon',
      deltaSeconds: 3600,
    });
    m.updateMinerContribution({
      asteroidId: 'B',
      walletAddress: BOB,
      currentDrillPower: 10,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'carbon',
      deltaSeconds: 3600,
    });

    const before = m.shouldDistribute();
    expect(before).toBe(false);

    vi.advanceTimersByTime(2 * 60 * 60 * 1000); // 2h
    expect(m.shouldDistribute()).toBe(true);

    const results = m.distributeAllRefineries();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.asteroidId).sort()).toEqual(['A', 'B']);

    // Distribute resets the cadence.
    expect(m.shouldDistribute()).toBe(false);
  });
});

describe('RefineryManager.shouldDistribute', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('false until the configured interval elapses', () => {
    const m = makeMgr({ distributionIntervalMs: 60 * 1000 });
    expect(m.shouldDistribute()).toBe(false);
    vi.advanceTimersByTime(59 * 1000);
    expect(m.shouldDistribute()).toBe(false);
    vi.advanceTimersByTime(2 * 1000);
    expect(m.shouldDistribute()).toBe(true);
  });

  it('markDistributionChecked resets the cadence', () => {
    const m = makeMgr({ distributionIntervalMs: 60 * 1000 });
    vi.advanceTimersByTime(120 * 1000);
    expect(m.shouldDistribute()).toBe(true);
    m.markDistributionChecked();
    expect(m.shouldDistribute()).toBe(false);
  });
});

describe('RefineryManager inspection helpers', () => {
  it('getRefineryStats returns null for unknown asteroid', () => {
    const m = makeMgr();
    expect(m.getRefineryStats('A')).toBeNull();
  });

  it('getRefineryStats reflects the underlying state', () => {
    const m = makeMgr();
    m.addToRefinery('A', 100);
    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 1,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });
    const stats = m.getRefineryStats('A')!;
    expect(stats.balance).toBe(100);
    expect(stats.pendingDistribution).toBe(100);
    expect(stats.contributorCount).toBe(1);
    expect(stats.totalDistributed).toBe(0);
  });

  it('getAllRefineryBalances + getTotalRefineryBalance aggregate', () => {
    const m = makeMgr();
    m.addToRefinery('A', 100);
    m.addToRefinery('B', 250);
    expect(m.getAllRefineryBalances().get('A')).toBe(100);
    expect(m.getAllRefineryBalances().get('B')).toBe(250);
    expect(m.getTotalRefineryBalance()).toBe(350);
  });
});

describe('RefineryManager.getMinerPendingShare', () => {
  it('returns null for unknown asteroid', () => {
    const m = makeMgr();
    expect(m.getMinerPendingShare('A', ALICE)).toBeNull();
  });

  it('returns zero share when miner has no contribution', () => {
    const m = makeMgr();
    m.addToRefinery('A', 100);
    expect(m.getMinerPendingShare('A', ALICE)).toEqual({ amount: 0, sharePercent: 0 });
  });

  it('returns proportional share when miner has contributed', () => {
    const m = makeMgr();
    m.addToRefinery('A', 1000);
    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 100,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });
    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: BOB,
      currentDrillPower: 100,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });
    const est = m.getMinerPendingShare('A', ALICE)!;
    expect(est.sharePercent).toBeCloseTo(50, 5);
    expect(est.amount).toBe(500);
  });

  it('returns zero share when total drill power is zero', () => {
    const m = makeMgr();
    m.addToRefinery('A', 100);
    m.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 0,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 60,
    });
    expect(m.getMinerPendingShare('A', ALICE)).toEqual({ amount: 0, sharePercent: 0 });
  });
});
