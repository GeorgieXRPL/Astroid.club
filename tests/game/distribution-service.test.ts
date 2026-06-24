/**
 * Unit tests for `server/game/distribution-service.ts`.
 *
 * Pairs a real `RefineryManager` with a minimal `StakeManagerLike`
 * spy. Covers:
 * - active-miner registry (register, unregister, update stats)
 * - tickContributions (skip-under-1s threshold + per-miner forward)
 * - handleDiscovery (70/30 split, refinery credit)
 * - performDistribution payout routing on both chain modes
 *   - chainEnabled=false: credits stakeManager.addPendingYield
 *   - chainEnabled=true:  fires onYieldPayout, does NOT credit
 * - onDistribution listener fires only when non-empty results
 * - start/stop with fake timers (idempotent start, full lifecycle)
 * - getActiveMinerCount / getActiveMiner / inspection delegation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DistributionService, type ActiveMiner } from '../../server/game/distribution-service.js';
import type { GameLogger, StakeManagerLike } from '../../server/game/interfaces.js';
import { RefineryManager } from '../../server/game/refinery-manager.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';

class FakeStake implements StakeManagerLike {
  pendingCalls: Array<{ wallet: string; asteroidId: string; amount: number }> = [];

  addPendingYield(wallet: string, asteroidId: string, amount: number): void {
    this.pendingCalls.push({ wallet, asteroidId, amount });
  }

  getMinerState(): never {
    throw new Error('unused');
  }
  getDefensePower(): number {
    throw new Error('unused');
  }
  getStakeAtAsteroid(): number {
    throw new Error('unused');
  }
  getTotalStake(): number {
    throw new Error('unused');
  }
  getWalletStakes(): never[] {
    throw new Error('unused');
  }
  processBet(): boolean {
    throw new Error('unused');
  }
  burnBet(): void {
    throw new Error('unused');
  }
  returnBetWithWinnings(): void {
    throw new Error('unused');
  }
  unstake(): void {
    throw new Error('unused');
  }
}

interface Harness {
  service: DistributionService;
  refinery: RefineryManager;
  stake: FakeStake;
}

function makeHarness(opts: { chainEnabled?: boolean } = {}): Harness {
  const refinery = new RefineryManager({
    logger: silentLogger,
    distributionIntervalMs: 60 * 60 * 1000,
  });
  const stake = new FakeStake();
  const service = new DistributionService({
    refinery,
    stakeManager: stake,
    chainEnabled: opts.chainEnabled,
    logger: silentLogger,
  });
  return { service, refinery, stake };
}

describe('DistributionService active miner registry', () => {
  it('registers and reflects an active miner', () => {
    const { service } = makeHarness();
    service.registerActiveMiner(ALICE, 'A', 'gold', 100, 500, 3);
    expect(service.getActiveMinerCount()).toBe(1);
    const m = service.getActiveMiner(ALICE)!;
    expect(m.walletAddress).toBe(ALICE);
    expect(m.asteroidId).toBe('A');
    expect(m.resource).toBe('gold');
    expect(m.currentDrillPower).toBe(100);
    expect(m.stakeAmount).toBe(500);
    expect(m.loyaltyDays).toBe(3);
    expect(m.lastUpdate).toBeInstanceOf(Date);
  });

  it('register defaults', () => {
    const { service } = makeHarness();
    service.registerActiveMiner(ALICE, 'A', 'carbon');
    const m = service.getActiveMiner(ALICE)!;
    expect(m.currentDrillPower).toBe(0);
    expect(m.stakeAmount).toBe(0);
    expect(m.loyaltyDays).toBe(0);
  });

  it('unregisterActiveMiner drops the miner', () => {
    const { service } = makeHarness();
    service.registerActiveMiner(ALICE, 'A', 'carbon', 100);
    service.unregisterActiveMiner(ALICE);
    expect(service.getActiveMinerCount()).toBe(0);
    expect(service.getActiveMiner(ALICE)).toBeUndefined();
  });

  it('updateMinerStats patches only the supplied fields', () => {
    const { service } = makeHarness();
    service.registerActiveMiner(ALICE, 'A', 'carbon', 100, 500, 0);
    service.updateMinerStats(ALICE, { drillPower: 250, loyaltyDays: 7 });
    const m = service.getActiveMiner(ALICE)!;
    expect(m.currentDrillPower).toBe(250);
    expect(m.stakeAmount).toBe(500); // untouched
    expect(m.loyaltyDays).toBe(7);
  });

  it('updateMinerStats no-ops on unknown miner', () => {
    const { service } = makeHarness();
    expect(() => service.updateMinerStats('nobody', { drillPower: 100 })).not.toThrow();
    expect(service.getActiveMinerCount()).toBe(0);
  });
});

describe('DistributionService.tickContributions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips miners with < 1s since last update', () => {
    const { service, refinery } = makeHarness();
    service.registerActiveMiner(ALICE, 'A', 'gold', 100, 0, 0);
    vi.advanceTimersByTime(500); // 0.5s
    service.tickContributions();
    expect(refinery.getRefinery('A')).toBeUndefined(); // never created
  });

  it('rolls drill-power-seconds into the refinery on tick', () => {
    const { service, refinery } = makeHarness();
    service.registerActiveMiner(ALICE, 'A', 'gold', 100, 0, 0);
    vi.advanceTimersByTime(60 * 1000); // 60s
    service.tickContributions();

    const r = refinery.getRefinery('A')!;
    const c = r.hourlyContributions.get(ALICE)!;
    expect(c.drillPowerSeconds).toBe(100 * 60);
    expect(c.timeActiveSeconds).toBe(60);
  });

  it('updates lastUpdate after tick (further ticks accumulate from new baseline)', () => {
    const { service, refinery } = makeHarness();
    service.registerActiveMiner(ALICE, 'A', 'gold', 100, 0, 0);
    vi.advanceTimersByTime(60 * 1000);
    service.tickContributions();
    vi.advanceTimersByTime(30 * 1000);
    service.tickContributions();

    const c = refinery.getRefinery('A')!.hourlyContributions.get(ALICE)!;
    // 60s + 30s
    expect(c.drillPowerSeconds).toBe(100 * 90);
    expect(c.timeActiveSeconds).toBe(90);
  });

  it('processes multiple miners across asteroids', () => {
    const { service, refinery } = makeHarness();
    service.registerActiveMiner(ALICE, 'A', 'gold', 100);
    service.registerActiveMiner(BOB, 'B', 'carbon', 50);
    vi.advanceTimersByTime(60 * 1000);
    service.tickContributions();
    expect(refinery.getRefinery('A')!.hourlyContributions.get(ALICE)!.drillPowerSeconds).toBe(6000);
    expect(refinery.getRefinery('B')!.hourlyContributions.get(BOB)!.drillPowerSeconds).toBe(3000);
  });
});

describe('DistributionService.handleDiscovery', () => {
  it('returns the 70/30 yield split', () => {
    const { service } = makeHarness();
    expect(service.handleDiscovery('A', 100)).toEqual({
      finderShare: 70,
      refineryShare: 30,
    });
  });

  it('credits the refinery share to the asteroid', () => {
    const { service, refinery } = makeHarness();
    service.handleDiscovery('A', 1000);
    expect(refinery.getRefinery('A')!.balance).toBe(300);
  });

  it('does not create a refinery row when refineryShare is 0', () => {
    const { service, refinery } = makeHarness();
    service.handleDiscovery('A', 2); // floor(2*0.3) = 0
    expect(refinery.getRefinery('A')).toBeUndefined();
  });
});

describe('DistributionService.performDistribution (chain disabled)', () => {
  it('credits payouts to stakeManager.addPendingYield', () => {
    const { service, refinery, stake } = makeHarness({ chainEnabled: false });
    refinery.addToRefinery('A', 1000);
    refinery.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 100,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });

    const results = service.performDistribution();
    expect(results).toHaveLength(1);
    expect(stake.pendingCalls).toEqual([{ wallet: ALICE, asteroidId: 'A', amount: 1000 }]);
  });

  it('does NOT call the chain payout callback when chain is disabled', () => {
    const { refinery } = makeHarness();
    const stake = new FakeStake();
    const onPayout = vi.fn();
    const service = new DistributionService({
      refinery,
      stakeManager: stake,
      chainEnabled: false,
      onYieldPayout: onPayout,
      logger: silentLogger,
    });
    refinery.addToRefinery('A', 100);
    refinery.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 1,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });
    service.performDistribution();
    expect(onPayout).not.toHaveBeenCalled();
  });

  it('returns empty when nothing distributes (no listener / no payouts)', () => {
    const { service, stake } = makeHarness();
    const results = service.performDistribution();
    expect(results).toEqual([]);
    expect(stake.pendingCalls).toHaveLength(0);
  });
});

describe('DistributionService.performDistribution (chain enabled)', () => {
  it('fires onYieldPayout for every payout and skips addPendingYield', () => {
    const refinery = new RefineryManager({ logger: silentLogger });
    const stake = new FakeStake();
    const onPayout = vi.fn();
    const service = new DistributionService({
      refinery,
      stakeManager: stake,
      chainEnabled: true,
      onYieldPayout: onPayout,
      logger: silentLogger,
    });

    refinery.addToRefinery('A', 1000);
    refinery.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 100,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });
    refinery.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: BOB,
      currentDrillPower: 100,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });

    service.performDistribution();
    expect(stake.pendingCalls).toHaveLength(0);
    expect(onPayout).toHaveBeenCalledTimes(2);
    const paid = onPayout.mock.calls.map(
      ([wallet, amount, asteroidId]) => `${wallet}|${asteroidId}|${amount}`,
    );
    // floor(1000 * 0.5) = 500 each
    expect(paid.sort()).toEqual([`${ALICE}|A|500`, `${BOB}|A|500`]);
  });

  it('does NOT throw when chainEnabled but no callback is registered', () => {
    const refinery = new RefineryManager({ logger: silentLogger });
    const stake = new FakeStake();
    const service = new DistributionService({
      refinery,
      stakeManager: stake,
      chainEnabled: true,
      logger: silentLogger,
    });
    refinery.addToRefinery('A', 100);
    refinery.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 1,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });
    expect(() => service.performDistribution()).not.toThrow();
    expect(stake.pendingCalls).toHaveLength(0);
  });

  it('setOnYieldPayout swaps the listener', () => {
    const refinery = new RefineryManager({ logger: silentLogger });
    const stake = new FakeStake();
    const service = new DistributionService({
      refinery,
      stakeManager: stake,
      chainEnabled: true,
      logger: silentLogger,
    });
    const fnA = vi.fn();
    const fnB = vi.fn();
    service.setOnYieldPayout(fnA);
    service.setOnYieldPayout(fnB);

    refinery.addToRefinery('A', 100);
    refinery.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 1,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });
    service.performDistribution();
    expect(fnA).not.toHaveBeenCalled();
    expect(fnB).toHaveBeenCalledOnce();
  });
});

describe('DistributionService onDistribution listener', () => {
  it('fires once with all results when non-empty', () => {
    const { service, refinery } = makeHarness();
    const onDist = vi.fn();
    service.setOnDistribution(onDist);

    refinery.addToRefinery('A', 100);
    refinery.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 1,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });
    service.performDistribution();
    expect(onDist).toHaveBeenCalledOnce();
    expect(onDist.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it('does NOT fire when no asteroids distribute', () => {
    const { service } = makeHarness();
    const onDist = vi.fn();
    service.setOnDistribution(onDist);
    service.performDistribution();
    expect(onDist).not.toHaveBeenCalled();
  });
});

describe('DistributionService start / stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start spins up tick + check intervals', () => {
    const refinery = new RefineryManager({
      logger: silentLogger,
      distributionIntervalMs: 60 * 60 * 1000,
    });
    const stake = new FakeStake();
    const service = new DistributionService({
      refinery,
      stakeManager: stake,
      tickIntervalMs: 1000,
      distributionCheckIntervalMs: 1000,
      logger: silentLogger,
    });
    service.registerActiveMiner(ALICE, 'A', 'gold', 100);
    service.start();
    expect(service.isRunning()).toBe(true);

    // Advance 5 seconds → 5 ticks. Each tick rolls 1 second of activity
    // for ALICE into the refinery.
    vi.advanceTimersByTime(5 * 1000);
    const c = refinery.getRefinery('A')!.hourlyContributions.get(ALICE)!;
    expect(c.timeActiveSeconds).toBeGreaterThanOrEqual(4);

    service.stop();
    expect(service.isRunning()).toBe(false);
  });

  it('start is idempotent', () => {
    const { service } = makeHarness();
    service.start();
    service.start();
    expect(service.isRunning()).toBe(true);
    service.stop();
  });

  it('stop is safe even when not started', () => {
    const { service } = makeHarness();
    expect(() => service.stop()).not.toThrow();
    expect(service.isRunning()).toBe(false);
  });

  it('checkAndDistribute fires when refinery says shouldDistribute', () => {
    const refinery = new RefineryManager({
      logger: silentLogger,
      distributionIntervalMs: 1000, // 1s for the test
    });
    const stake = new FakeStake();
    const service = new DistributionService({
      refinery,
      stakeManager: stake,
      tickIntervalMs: 60 * 60 * 1000, // make tick irrelevant
      distributionCheckIntervalMs: 100,
      logger: silentLogger,
    });

    refinery.addToRefinery('A', 100);
    refinery.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 1,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });

    service.start();
    // Cross the 1-second cadence threshold so shouldDistribute() is true
    // when the next 100ms check fires.
    vi.advanceTimersByTime(2000);
    expect(stake.pendingCalls.length).toBeGreaterThan(0);
    service.stop();
  });
});

describe('DistributionService inspection delegation', () => {
  it('getDistributionStats delegates to refinery', () => {
    const { service, refinery } = makeHarness();
    expect(service.getDistributionStats('A')).toBeNull();
    refinery.addToRefinery('A', 100);
    const stats = service.getDistributionStats('A')!;
    expect(stats.balance).toBe(100);
  });

  it('getMinerPendingYield delegates to refinery', () => {
    const { service, refinery } = makeHarness();
    expect(service.getMinerPendingYield('A', ALICE)).toBeNull();
    refinery.addToRefinery('A', 100);
    refinery.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 1,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });
    const est = service.getMinerPendingYield('A', ALICE)!;
    expect(est.amount).toBeCloseTo(100, 5);
    expect(est.sharePercent).toBeCloseTo(100, 5);
  });
});

describe('DistributionService active miner type sanity', () => {
  it('ActiveMiner shape matches expected fields', () => {
    const { service } = makeHarness();
    service.registerActiveMiner(ALICE, 'A', 'gold', 100, 50, 1);
    const miner = service.getActiveMiner(ALICE) as ActiveMiner;
    expect(Object.keys(miner).sort()).toEqual(
      [
        'asteroidId',
        'currentDrillPower',
        'lastUpdate',
        'loyaltyDays',
        'resource',
        'stakeAmount',
        'walletAddress',
      ].sort(),
    );
  });
});
