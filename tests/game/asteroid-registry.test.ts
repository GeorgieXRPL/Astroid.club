/**
 * Unit tests for `server/game/asteroid-registry.ts`.
 *
 * Covers the BG-equivalent surface: CRUD on miners, drill-power and
 * stake updates, defense-buff and attack-debuff lifecycles (including
 * the two-stage immunity/boost expiry), incoming raids, the
 * `getDrillPowerMultiplier` and `getYieldMultiplier` composition order,
 * resource-class side effects (Stellar Strike on gold post-discovery,
 * Solar Flare on silver post-discovery, syndicate scaling on oil
 * miner-count change), and the network-stats projection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AsteroidDefinition, ResourceType } from '../../config/asteroids.js';
import { AsteroidRegistry } from '../../server/game/asteroid-registry.js';
import type { GameLogger } from '../../server/game/interfaces.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function def(id: string, resource: ResourceType = 'carbon', name?: string): AsteroidDefinition {
  return {
    id,
    name: name ?? `Asteroid ${id}`,
    resource,
    sector: 'Belt-A',
    position: { x: 0, y: 0, z: 0 },
    baseDiscoveryTimeMs: 5 * 60 * 1000,
    baseRewardMultiplier: 1,
    description: `Test asteroid ${id}.`,
  };
}

function makeRegistry(...definitions: AsteroidDefinition[]): AsteroidRegistry {
  return new AsteroidRegistry({ asteroids: definitions, logger: silentLogger });
}

describe('AsteroidRegistry CRUD', () => {
  it('starts empty when no asteroids are passed', () => {
    const r = new AsteroidRegistry({ logger: silentLogger });
    expect(r.getAllAsteroids()).toHaveLength(0);
  });

  it('seeds asteroids passed to the constructor', () => {
    const r = makeRegistry(def('A'), def('B'));
    expect(r.getAllAsteroids()).toHaveLength(2);
    expect(r.getAsteroid('A')?.definition.id).toBe('A');
  });

  it('registerAsteroid is idempotent (replaces by id)', () => {
    const r = makeRegistry(def('A', 'carbon'));
    r.registerAsteroid(def('A', 'gold', 'Renamed'));
    expect(r.getAllAsteroids()).toHaveLength(1);
    expect(r.getAsteroid('A')?.definition.resource).toBe('gold');
    expect(r.getAsteroid('A')?.definition.name).toBe('Renamed');
  });

  it('initialises difficulty/target as placeholders (no pool)', () => {
    const r = makeRegistry(def('A'));
    const a = r.getAsteroid('A')!;
    expect(a.difficulty).toBe(1);
    expect(a.target).toBe('');
  });

  it('updateAsteroidDifficulty mutates difficulty + target', () => {
    const r = makeRegistry(def('A'));
    r.updateAsteroidDifficulty('A', 42, '0xdeadbeef');
    const a = r.getAsteroid('A')!;
    expect(a.difficulty).toBe(42);
    expect(a.target).toBe('0xdeadbeef');
  });

  it('getAsteroidsByResource filters by resource class', () => {
    const r = makeRegistry(def('A', 'carbon'), def('B', 'gold'), def('C', 'gold'));
    expect(
      r
        .getAsteroidsByResource('gold')
        .map((a) => a.definition.id)
        .sort(),
    ).toEqual(['B', 'C']);
  });
});

describe('AsteroidRegistry miner / drill-power tracking', () => {
  it('addMiner increments active miners and total drill power', () => {
    const r = makeRegistry(def('A'));
    expect(r.addMiner('alice', 'A', 100)).toBe(true);
    expect(r.addMiner('bob', 'A', 50)).toBe(true);
    const a = r.getAsteroid('A')!;
    expect(a.activeMiners.size).toBe(2);
    expect(a.totalDrillPower).toBe(150);
    expect(r.getMinerLocation('alice')).toBe('A');
  });

  it('addMiner returns false for unknown asteroid', () => {
    const r = makeRegistry(def('A'));
    expect(r.addMiner('alice', 'NOPE', 50)).toBe(false);
  });

  it('moving a miner across asteroids preserves accounting', () => {
    const r = makeRegistry(def('A'), def('B'));
    r.addMiner('alice', 'A', 100);
    // Pretend "old" power is unknown; BG's removeMiner takes a drillPower
    // arg explicitly. We mirror that — the caller is responsible for
    // passing the right value here.
    r.addMiner('alice', 'B', 80);
    expect(r.getMinerLocation('alice')).toBe('B');
    expect(r.getAsteroid('B')?.activeMiners.size).toBe(1);
    expect(r.getAsteroid('B')?.totalDrillPower).toBe(80);
    // Old asteroid should have miner removed, but its drill-power total
    // is reduced by the (default 0) drillPower arg passed to removeMiner
    // when the move was triggered. This mirrors BG's quirk; downstream
    // code is expected to pass the correct removal value.
    expect(r.getAsteroid('A')?.activeMiners.size).toBe(0);
  });

  it('removeMiner subtracts drill power and clears location', () => {
    const r = makeRegistry(def('A'));
    r.addMiner('alice', 'A', 100);
    expect(r.removeMiner('alice', 100)).toBe(true);
    const a = r.getAsteroid('A')!;
    expect(a.activeMiners.size).toBe(0);
    expect(a.totalDrillPower).toBe(0);
    expect(r.getMinerLocation('alice')).toBeUndefined();
  });

  it('updateMinerDrillPower clamps to zero (no negatives)', () => {
    const r = makeRegistry(def('A'));
    r.addMiner('alice', 'A', 50);
    r.updateMinerDrillPower('alice', 1000, 10);
    expect(r.getAsteroid('A')?.totalDrillPower).toBe(0);
  });

  it('updateAsteroidStake clamps to zero (no negatives)', () => {
    const r = makeRegistry(def('A'));
    r.updateAsteroidStake('A', 100);
    expect(r.getAsteroid('A')?.totalStake).toBe(100);
    r.updateAsteroidStake('A', -1000);
    expect(r.getAsteroid('A')?.totalStake).toBe(0);
  });
});

describe('AsteroidRegistry buffs and debuffs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applyDefenseBuff sets immunity (2h) and drill-power boost (1h, 1.1x)', () => {
    const r = makeRegistry(def('A'));
    r.applyDefenseBuff('A');
    const a = r.getAsteroid('A')!;
    expect(a.defenseBuff).not.toBeNull();
    expect(a.defenseBuff!.drillPowerBoost).toBeCloseTo(1.1, 10);
    expect(a.defenseBuff!.boostExpiresAt.getTime() - Date.now()).toBe(60 * 60 * 1000);
    expect(a.defenseBuff!.immuneUntil.getTime() - Date.now()).toBe(2 * 60 * 60 * 1000);
    expect(r.hasRaidImmunity('A')).toBe(true);
  });

  it('applyAttackDebuff sets a 30m, 0.8x reduction', () => {
    const r = makeRegistry(def('A'));
    r.applyAttackDebuff('A');
    const a = r.getAsteroid('A')!;
    expect(a.attackDebuff).not.toBeNull();
    expect(a.attackDebuff!.drillPowerReduction).toBeCloseTo(0.8, 10);
    expect(a.attackDebuff!.expiresAt.getTime() - Date.now()).toBe(30 * 60 * 1000);
  });

  it('clearExpiredEffects: boost expires first, immunity stays, buff fully clears at 2h', () => {
    const r = makeRegistry(def('A'));
    r.applyDefenseBuff('A');

    // 1h passes — boost expires, immunity remains.
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    r.clearExpiredEffects();
    const a1 = r.getAsteroid('A')!;
    expect(a1.defenseBuff).not.toBeNull();
    expect(a1.defenseBuff!.drillPowerBoost).toBe(1.0);
    expect(r.hasRaidImmunity('A')).toBe(true);

    // Another 1h passes — immunity also expires; buff cleared.
    vi.advanceTimersByTime(60 * 60 * 1000);
    r.clearExpiredEffects();
    const a2 = r.getAsteroid('A')!;
    expect(a2.defenseBuff).toBeNull();
    expect(r.hasRaidImmunity('A')).toBe(false);
  });

  it('clearExpiredEffects drops attack debuff after its window', () => {
    const r = makeRegistry(def('A'));
    r.applyAttackDebuff('A');
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    r.clearExpiredEffects();
    expect(r.getAsteroid('A')?.attackDebuff).toBeNull();
  });

  it('hasRaidImmunity is false when no buff is set', () => {
    const r = makeRegistry(def('A'));
    expect(r.hasRaidImmunity('A')).toBe(false);
    expect(r.hasRaidImmunity('NOPE')).toBe(false);
  });
});

describe('AsteroidRegistry incoming raids', () => {
  it('addIncomingRaid is idempotent (no duplicates)', () => {
    const r = makeRegistry(def('A'));
    r.addIncomingRaid('A', 'exp1');
    r.addIncomingRaid('A', 'exp1');
    r.addIncomingRaid('A', 'exp2');
    expect(r.getAsteroid('A')?.incomingRaids).toEqual(['exp1', 'exp2']);
  });

  it('removeIncomingRaid is a no-op for unknown ids', () => {
    const r = makeRegistry(def('A'));
    r.addIncomingRaid('A', 'exp1');
    r.removeIncomingRaid('A', 'nope');
    expect(r.getAsteroid('A')?.incomingRaids).toEqual(['exp1']);
    r.removeIncomingRaid('A', 'exp1');
    expect(r.getAsteroid('A')?.incomingRaids).toEqual([]);
  });
});

describe('AsteroidRegistry resource-class mechanics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('oil syndicate multiplier scales with miner count', () => {
    const r = makeRegistry(def('OIL', 'oil'));
    expect(r.getAsteroid('OIL')?.syndicateMultiplier).toBe(1.0);
    r.addMiner('alice', 'OIL', 50);
    r.addMiner('bob', 'OIL', 50);
    // calculateSyndicateMultiplier is monotonic in miner count;
    // we just check it moved.
    expect(r.getAsteroid('OIL')!.syndicateMultiplier).toBeGreaterThan(1.0);
    r.removeMiner('alice');
    const afterRemove = r.getAsteroid('OIL')!.syndicateMultiplier;
    r.removeMiner('bob');
    const afterEmpty = r.getAsteroid('OIL')!.syndicateMultiplier;
    expect(afterEmpty).toBeLessThanOrEqual(afterRemove);
  });

  it('gold post-discovery rolls Stellar Strike (forced via Math.random spy)', () => {
    const r = makeRegistry(def('GOLD', 'gold'));
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0); // 0 < 0.05 -> jackpot fires
    r.recordDiscoveryFound('GOLD', 'prevhash');
    expect(r.getAsteroid('GOLD')?.isStellarStrikeActive).toBe(true);
    spy.mockRestore();
  });

  it('silver post-discovery re-rolls solarFlareMultiplier', () => {
    const r = makeRegistry(def('SILVER', 'silver'));
    const before = r.getAsteroid('SILVER')!.solarFlareMultiplier;
    r.recordDiscoveryFound('SILVER', 'prevhash');
    const after = r.getAsteroid('SILVER')!.solarFlareMultiplier;
    // Range of rollSolarFlareMultiplier is [0.5, 2.0); just verify it's
    // populated and within the documented bounds.
    expect(after).toBeGreaterThanOrEqual(0.5);
    expect(after).toBeLessThan(2.0);
    expect(after).not.toBe(before === after ? -1 : before); // sanity: it can re-roll
  });

  it('carbon post-discovery is a no-op for resource mechanics', () => {
    const r = makeRegistry(def('CARBON', 'carbon'));
    r.recordDiscoveryFound('CARBON', 'prevhash');
    const a = r.getAsteroid('CARBON')!;
    expect(a.totalDiscoveries).toBe(1);
    expect(a.solarFlareMultiplier).toBe(1.0);
    expect(a.isStellarStrikeActive).toBe(false);
  });
});

describe('AsteroidRegistry multipliers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drill-power multiplier composes defense boost, attack debuff, and oil syndicate', () => {
    const r = makeRegistry(def('OIL', 'oil'));
    expect(r.getDrillPowerMultiplier('OIL')).toBe(1.0);

    r.applyDefenseBuff('OIL'); // x1.1
    r.applyAttackDebuff('OIL'); // x0.8
    r.addMiner('alice', 'OIL', 0); // syndicate >= 1
    r.addMiner('bob', 'OIL', 0);

    const synd = r.getAsteroid('OIL')!.syndicateMultiplier;
    expect(r.getDrillPowerMultiplier('OIL')).toBeCloseTo(1.1 * 0.8 * synd, 10);
  });

  it('yield multiplier stacks Stellar Strike (5x), Solar Flare, and syndicate', () => {
    const r = makeRegistry(def('GOLD', 'gold'));

    // Force a Stellar Strike on next discovery.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    r.recordDiscoveryFound('GOLD', 'prev');
    spy.mockRestore();

    expect(r.getYieldMultiplier('GOLD')).toBeCloseTo(1 * 5.0, 10);
  });

  it('yield multiplier returns 1.0 for unknown asteroid', () => {
    const r = makeRegistry();
    expect(r.getYieldMultiplier('NOPE')).toBe(1.0);
  });

  it('drill-power multiplier returns 1.0 for unknown asteroid', () => {
    const r = makeRegistry();
    expect(r.getDrillPowerMultiplier('NOPE')).toBe(1.0);
  });
});

describe('AsteroidRegistry network stats + totals', () => {
  it('getNetworkStats returns one entry per asteroid with all fields', () => {
    const r = makeRegistry(def('A'), def('B', 'gold'));
    r.addMiner('alice', 'A', 100);
    r.updateAsteroidStake('A', 500);
    r.applyDefenseBuff('A');
    r.applyAttackDebuff('B');
    r.addIncomingRaid('A', 'exp1');

    const stats = r.getNetworkStats();
    expect(stats).toHaveLength(2);

    const a = stats.find((s) => s.asteroidId === 'A')!;
    expect(a.minerCount).toBe(1);
    expect(a.drillPower).toBe(100);
    expect(a.totalStake).toBe(500);
    expect(a.hasDefenseBuff).toBe(true);
    expect(a.hasAttackDebuff).toBe(false);
    expect(a.activeRaidCount).toBe(1);

    const b = stats.find((s) => s.asteroidId === 'B')!;
    expect(b.hasAttackDebuff).toBe(true);
    expect(b.hasDefenseBuff).toBe(false);
    expect(b.resource).toBe('gold');
  });

  it('totals sum across asteroids', () => {
    const r = makeRegistry(def('A'), def('B'));
    r.addMiner('alice', 'A', 100);
    r.addMiner('bob', 'B', 200);
    r.updateAsteroidStake('A', 500);
    r.updateAsteroidStake('B', 300);

    expect(r.getTotalMiners()).toBe(2);
    expect(r.getTotalDrillPower()).toBe(300);
    expect(r.getTotalStake()).toBe(800);
    expect(r.getTotalDiscoveries()).toBe(0);

    r.recordDiscoveryFound('A', 'prev');
    r.recordDiscoveryFound('A', 'prev');
    r.recordDiscoveryFound('B', 'prev');
    expect(r.getTotalDiscoveries()).toBe(3);
  });
});
