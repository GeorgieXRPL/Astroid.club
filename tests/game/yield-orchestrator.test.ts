/**
 * Unit tests for `server/game/yield-orchestrator.ts`.
 *
 * Pairs a real `RefineryManager` + `DistributionService` so the 30%
 * refinery credit can be observed end-to-end. Uses a minimal
 * `AsteroidRegistryLike` and a `StakeManagerLike` spy to verify the
 * chain-disabled payout path. Variance is controlled via a fixed
 * `random: () => 0.5` for deterministic math (variance term collapses
 * to 1.0).
 *
 * Coverage:
 * - calculateDiscoveryYield: BASE × resourceMultiplier × asteroidMultiplier
 *   under deterministic variance, and the BG fallback for unknown asteroids
 * - processDiscovery share-based path: per-miner base share + finder bonus
 * - processDiscovery legacy fallback (no shares): 100% to finder
 * - chain-disabled vs. chain-enabled routing of payouts
 * - 30% refinery credit observable on the underlying refinery
 * - finder bonus configurable via `finderBonusPercent` arg
 * - Stats accumulation across multiple discoveries
 * - forceHourlyDistribution + attachDistributionListener stamp
 *   lastDistribution on non-empty results
 * - Custom resource multipliers override the defaults
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AsteroidDefinition } from '../../config/asteroids.js';
import { DistributionService } from '../../server/game/distribution-service.js';
import type {
  AsteroidRegistryLike,
  GameLogger,
  StakeManagerLike,
} from '../../server/game/interfaces.js';
import { RaidVaultManager } from '../../server/game/raid-vault.js';
import { RefineryManager } from '../../server/game/refinery-manager.js';
import type { AsteroidState } from '../../server/game/types.js';
import {
  DEFAULT_RESOURCE_MULTIPLIERS,
  YIELD_CONFIG,
  YieldOrchestrator,
} from '../../server/game/yield-orchestrator.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';
const CAROL = 'wallet_carol';

class FakeRegistry implements AsteroidRegistryLike {
  asteroids = new Map<string, AsteroidState>();

  add(def: AsteroidDefinition): void {
    this.asteroids.set(def.id, { definition: def } as unknown as AsteroidState);
  }

  getAsteroid(id: string): AsteroidState | undefined {
    return this.asteroids.get(id);
  }
  hasRaidImmunity(): boolean {
    return false;
  }
  applyAttackDebuff(): void {}
  applyDefenseBuff(): void {}
  addIncomingRaid(): void {}
  removeIncomingRaid(): void {}
  updateAsteroidStake(): void {}
}

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
  orchestrator: YieldOrchestrator;
  refinery: RefineryManager;
  distribution: DistributionService;
  stake: FakeStake;
  registry: FakeRegistry;
}

function def(
  id: string,
  resource: AsteroidDefinition['resource'],
  baseMultiplier = 1,
): AsteroidDefinition {
  return {
    id,
    name: `Asteroid ${id}`,
    resource,
    sector: 'Belt-A',
    position: { x: 0, y: 0, z: 0 },
    baseDiscoveryTimeMs: 5 * 60 * 1000,
    baseRewardMultiplier: baseMultiplier,
    description: 'test',
  };
}

function makeHarness(
  opts: {
    chainEnabled?: boolean;
    onYieldPayout?: (w: string, a: number, id: string) => void;
    random?: () => number;
  } = {},
): Harness {
  const refinery = new RefineryManager({ logger: silentLogger });
  const stake = new FakeStake();
  const distribution = new DistributionService({
    refinery,
    stakeManager: stake,
    chainEnabled: opts.chainEnabled,
    logger: silentLogger,
  });
  const registry = new FakeRegistry();
  registry.add(def('A', 'carbon', 1));
  registry.add(def('GOLD', 'gold', 1));
  registry.add(def('BIG', 'carbon', 2)); // baseRewardMultiplier=2

  const orchestrator = new YieldOrchestrator({
    distribution,
    registry,
    stakeManager: stake,
    chainEnabled: opts.chainEnabled,
    onYieldPayout: opts.onYieldPayout,
    random: opts.random ?? (() => 0.5), // variance roll = 1.0 (deterministic)
    logger: silentLogger,
  });
  return { orchestrator, refinery, distribution, stake, registry };
}

describe('YieldOrchestrator.calculateDiscoveryYield', () => {
  it('uses BASE × resource × asteroid multiplier under deterministic variance', () => {
    const { orchestrator } = makeHarness();
    // BASE=100, carbon=1.0, asteroidMultiplier=1, variance=1.0 -> 100
    expect(orchestrator.calculateDiscoveryYield('A')).toBe(100);
    // gold=1.5 -> floor(100*1.5*1*1.0) = 150
    expect(orchestrator.calculateDiscoveryYield('GOLD')).toBe(150);
    // carbon=1.0, baseRewardMultiplier=2 -> floor(100*1.0*2*1.0) = 200
    expect(orchestrator.calculateDiscoveryYield('BIG')).toBe(200);
  });

  it('falls back to BASE_YIELD_PER_DISCOVERY when asteroid is unknown', () => {
    const { orchestrator } = makeHarness();
    expect(orchestrator.calculateDiscoveryYield('NOPE')).toBe(
      YIELD_CONFIG.BASE_YIELD_PER_DISCOVERY,
    );
  });

  it('honours custom resource multipliers when supplied', () => {
    const refinery = new RefineryManager({ logger: silentLogger });
    const stake = new FakeStake();
    const distribution = new DistributionService({
      refinery,
      stakeManager: stake,
      logger: silentLogger,
    });
    const registry = new FakeRegistry();
    registry.add(def('A', 'carbon', 1));
    const orchestrator = new YieldOrchestrator({
      distribution,
      registry,
      stakeManager: stake,
      resourceMultipliers: { ...DEFAULT_RESOURCE_MULTIPLIERS, carbon: 2.5 },
      random: () => 0.5,
      logger: silentLogger,
    });
    expect(orchestrator.calculateDiscoveryYield('A')).toBe(250);
  });

  it('variance term respects the supplied RNG (low and high bounds)', () => {
    const lowOrch = makeHarness({ random: () => 0 });
    // variance = 1 + (0 * 2 - 1) * 0.2 = 0.8
    expect(lowOrch.orchestrator.calculateDiscoveryYield('A')).toBe(80);

    const highOrch = makeHarness({ random: () => 1 });
    // variance = 1 + (1 * 2 - 1) * 0.2 = 1.2
    expect(highOrch.orchestrator.calculateDiscoveryYield('A')).toBe(120);
  });
});

describe('YieldOrchestrator.processDiscovery (share-based)', () => {
  it('credits 30% refinery and computes per-miner base share + finder bonus', () => {
    const h = makeHarness();
    // total = 100; refinery = 30; minerPool = 70.
    const out = h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 1,
      shares: [
        { walletAddress: ALICE, drillPowerSeconds: 0, sharePercent: 50 }, // finder
        { walletAddress: BOB, drillPowerSeconds: 0, sharePercent: 30 },
        { walletAddress: CAROL, drillPowerSeconds: 0, sharePercent: 20 },
      ],
    });

    // ALICE base = floor(70 * 50/100) = 35; bonus = floor(35 * 20/100) = 7; total 42
    // BOB base   = floor(70 * 30/100) = 21
    // CAROL base = floor(70 * 20/100) = 14
    expect(out.totalYield).toBe(100);
    expect(out.refineryYield).toBe(30);
    expect(out.finderYield).toBe(42);
    expect(out.minerPayouts).toEqual([
      { wallet: ALICE, amount: 42, isFinder: true },
      { wallet: BOB, amount: 21, isFinder: false },
      { wallet: CAROL, amount: 14, isFinder: false },
    ]);
    expect(h.refinery.getRefinery('A')!.balance).toBe(30);
  });

  it('credits payouts to addPendingYield when chainEnabled=false', () => {
    const h = makeHarness();
    h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 1,
      shares: [
        { walletAddress: ALICE, drillPowerSeconds: 0, sharePercent: 50 },
        { walletAddress: BOB, drillPowerSeconds: 0, sharePercent: 50 },
      ],
    });
    // ALICE base=35, bonus=7 -> 42; BOB base=35.
    expect(h.stake.pendingCalls).toEqual([
      { wallet: ALICE, asteroidId: 'A', amount: 42 },
      { wallet: BOB, asteroidId: 'A', amount: 35 },
    ]);
  });

  it('routes through onYieldPayout when chainEnabled=true', () => {
    const onPayout = vi.fn();
    const h = makeHarness({ chainEnabled: true, onYieldPayout: onPayout });
    h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 1,
      shares: [
        { walletAddress: ALICE, drillPowerSeconds: 0, sharePercent: 50 },
        { walletAddress: BOB, drillPowerSeconds: 0, sharePercent: 50 },
      ],
    });
    expect(h.stake.pendingCalls).toHaveLength(0);
    expect(onPayout).toHaveBeenCalledTimes(2);
    expect(onPayout).toHaveBeenCalledWith(ALICE, 42, 'A');
    expect(onPayout).toHaveBeenCalledWith(BOB, 35, 'A');
  });

  it('configurable finder bonus overrides the default 20%', () => {
    const h = makeHarness();
    const out = h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 1,
      shares: [{ walletAddress: ALICE, drillPowerSeconds: 0, sharePercent: 100 }],
      finderBonusPercent: 50,
    });
    // base = 70; bonus = 35; total = 105.
    expect(out.finderYield).toBe(105);
  });

  it('skips zero-amount entries in the payout map', () => {
    const h = makeHarness();
    const out = h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 1,
      shares: [
        { walletAddress: ALICE, drillPowerSeconds: 0, sharePercent: 100 },
        { walletAddress: BOB, drillPowerSeconds: 0, sharePercent: 0 },
      ],
    });
    expect(out.minerPayouts.find((p) => p.wallet === BOB)).toBeUndefined();
  });

  it('finder with 0% share gets zero bonus (BG behaviour)', () => {
    const h = makeHarness();
    const out = h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 1,
      shares: [
        { walletAddress: ALICE, drillPowerSeconds: 0, sharePercent: 0 },
        { walletAddress: BOB, drillPowerSeconds: 0, sharePercent: 100 },
      ],
    });
    // ALICE base = 0, bonus = floor(0 * 20/100) = 0 -> excluded.
    expect(out.minerPayouts.map((p) => p.wallet)).toEqual([BOB]);
    expect(out.finderYield).toBe(0);
  });
});

describe('YieldOrchestrator.processDiscovery (legacy fallback)', () => {
  it('routes 100% of miner pool to finder when no shares are supplied', () => {
    const h = makeHarness();
    const out = h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 1,
    });
    expect(out.minerPayouts).toEqual([{ wallet: ALICE, amount: 70, isFinder: true }]);
    expect(out.finderYield).toBe(70);
    expect(h.stake.pendingCalls).toEqual([{ wallet: ALICE, asteroidId: 'A', amount: 70 }]);
  });

  it('legacy path also credits the 30% refinery share', () => {
    const h = makeHarness();
    h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 1,
    });
    expect(h.refinery.getRefinery('A')!.balance).toBe(30);
  });

  it('legacy path with empty shares array also falls back to 100% finder', () => {
    const h = makeHarness();
    const out = h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 1,
      shares: [],
    });
    expect(out.minerPayouts).toEqual([{ wallet: ALICE, amount: 70, isFinder: true }]);
  });
});

describe('YieldOrchestrator stats', () => {
  it('accumulates totalDiscoveries / totalYieldDistributed / totalRefineryYield', () => {
    const h = makeHarness();
    h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 1,
    });
    h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 2,
    });

    const stats = h.orchestrator.getStats();
    expect(stats.totalDiscoveries).toBe(2);
    // 70 each (legacy fallback) -> 140 total.
    expect(stats.totalYieldDistributed).toBe(140);
    expect(stats.totalFinderYield).toBe(140);
    expect(stats.totalRefineryYield).toBe(60); // 30 each
    expect(stats.lastDistribution).toBeNull();
  });

  it('returns a copy (mutation-safe)', () => {
    const h = makeHarness();
    const stats = h.orchestrator.getStats();
    stats.totalDiscoveries = 999;
    expect(h.orchestrator.getStats().totalDiscoveries).toBe(0);
  });
});

describe('YieldOrchestrator.forceHourlyDistribution + listener', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns delegate result and stamps lastDistribution on non-empty', () => {
    const h = makeHarness();
    h.refinery.addToRefinery('A', 100);
    h.refinery.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 1,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });

    const result = h.orchestrator.forceHourlyDistribution();
    expect(result).toHaveLength(1);
    expect(h.orchestrator.getStats().lastDistribution).toBeInstanceOf(Date);
  });

  it('attachDistributionListener stamps lastDistribution from the service callback', () => {
    const h = makeHarness();
    h.orchestrator.attachDistributionListener();

    h.refinery.addToRefinery('A', 100);
    h.refinery.updateMinerContribution({
      asteroidId: 'A',
      walletAddress: ALICE,
      currentDrillPower: 1,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'gold',
      deltaSeconds: 3600,
    });
    // Use the underlying distribution service directly so the listener
    // path (not the orchestrator's own force path) runs.
    h.distribution.performDistribution();
    expect(h.orchestrator.getStats().lastDistribution).toBeInstanceOf(Date);
  });

  it('lastDistribution stays null on empty distributions', () => {
    const h = makeHarness();
    h.orchestrator.attachDistributionListener();
    h.distribution.performDistribution(); // no refineries -> empty
    expect(h.orchestrator.getStats().lastDistribution).toBeNull();
  });
});

describe('YieldOrchestrator.processDiscovery (raid-vault mode)', () => {
  function makeVaultHarness(raidVaultPercent?: number): Harness & { vault: RaidVaultManager } {
    const refinery = new RefineryManager({ logger: silentLogger });
    const stake = new FakeStake();
    const distribution = new DistributionService({ refinery, stakeManager: stake, logger: silentLogger });
    const registry = new FakeRegistry();
    registry.add(def('A', 'carbon', 1));
    const vault = new RaidVaultManager({ logger: silentLogger });
    const orchestrator = new YieldOrchestrator({
      distribution,
      registry,
      stakeManager: stake,
      raidVault: vault,
      ...(raidVaultPercent !== undefined && { raidVaultPercent }),
      random: () => 0.5,
      logger: silentLogger,
    });
    return { orchestrator, refinery, distribution, stake, registry, vault };
  }

  it('routes the vault cut to the raid vault and the remainder to miners per-discovery', () => {
    const h = makeVaultHarness(); // default 20%
    // total = 100; vault = floor(100 * 20/100) = 20; miner pool = 80.
    const out = h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 1,
      shares: [
        { walletAddress: ALICE, drillPowerSeconds: 0, sharePercent: 100 }, // sole finder
      ],
    });
    // ALICE base = floor(80 * 100/100) = 80; bonus = floor(80 * 20/100) = 16; total 96.
    expect(out.totalYield).toBe(100);
    expect(out.vaultYield).toBe(20);
    expect(out.refineryYield).toBe(0);
    expect(out.finderYield).toBe(96);
    expect(h.vault.getBalance('A')).toBe(20);
    // No hourly refinery accumulation in vault mode.
    expect(h.refinery.getRefinery('A')).toBeUndefined();
  });

  it('does not drain on distribution — the vault persists across discoveries', () => {
    const h = makeVaultHarness();
    for (let i = 1; i <= 5; i++) {
      h.orchestrator.processDiscovery({
        asteroidId: 'A',
        finderWallet: ALICE,
        discoveryNumber: i,
        shares: [{ walletAddress: ALICE, drillPowerSeconds: 0, sharePercent: 100 }],
      });
    }
    // 20 per discovery × 5 = 100, accumulated and never auto-distributed.
    expect(h.vault.getBalance('A')).toBe(100);
    // Hourly distribution moves nothing (the refinery pool is empty).
    h.distribution.performDistribution();
    expect(h.vault.getBalance('A')).toBe(100);
  });

  it('honours a custom raidVaultPercent', () => {
    const h = makeVaultHarness(25); // 25% to vault, 75% miner pool
    const out = h.orchestrator.processDiscovery({
      asteroidId: 'A',
      finderWallet: ALICE,
      discoveryNumber: 1,
      shares: [{ walletAddress: ALICE, drillPowerSeconds: 0, sharePercent: 100 }],
    });
    expect(out.vaultYield).toBe(25);
    // miner pool = 75; finder = 75 + floor(75 * 20/100) = 75 + 15 = 90.
    expect(out.finderYield).toBe(90);
    expect(h.vault.getBalance('A')).toBe(25);
  });
});
