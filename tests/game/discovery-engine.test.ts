/**
 * Unit tests for `server/game/discovery-engine.ts`.
 *
 * The discovery engine is the "mining algorithm" trigger: each tick it
 * rolls each asteroid for discoveries (a probabilistic "% chance per
 * seed" whose expected rate is tied to the asteroid's
 * `baseDiscoveryTimeMs`) and picks the finder + per-miner shares. These
 * tests drive it with explicit `deltaMs` and a seeded RNG so the
 * Bernoulli find roll and the weighted finder selection are exactly
 * assertable.
 *
 * RNG consumption order per asteroid: the fractional Bernoulli trial
 * (only when the expected count has a fractional part), then one
 * `random()` per resolved discovery for finder selection.
 *
 * Coverage:
 * - no finds without elapsed time or drill power
 * - integer expected count → that many guaranteed finds (no Bernoulli)
 * - fractional expected → Bernoulli hit/miss on the seeded roll
 * - higher drill power / lower reference power raises the expected count
 * - per-tick cap bounds the number of finds
 * - shares are drill-power-proportional; finder is drill-power-weighted
 * - headline solo rate sanity (carbon ≈ 20%/min at the reference power)
 */

import { describe, expect, it } from 'vitest';

import { DiscoveryEngine, type AsteroidMiningState } from '../../server/game/discovery-engine.js';
import type { GameLogger } from '../../server/game/interfaces.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';

function state(
  asteroidId: string,
  baseDiscoveryTimeMs: number,
  miners: { walletAddress: string; drillPower: number }[],
): AsteroidMiningState {
  return { asteroidId, baseDiscoveryTimeMs, miners };
}

/** Deterministic RNG that yields a fixed sequence (last value repeats). */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe('DiscoveryEngine — probabilistic resolution', () => {
  it('resolves nothing with no elapsed time', () => {
    const engine = new DiscoveryEngine({ logger: silentLogger });
    expect(engine.tick(0, [state('A', 1000, [{ walletAddress: ALICE, drillPower: 1 }])])).toEqual(
      [],
    );
  });

  it('resolves nothing without drill power', () => {
    const engine = new DiscoveryEngine({ logger: silentLogger });
    expect(
      engine.tick(10_000, [state('A', 1000, [{ walletAddress: ALICE, drillPower: 0 }])]),
    ).toEqual([]);
  });

  it('resolves the integer part of the expected count with no Bernoulli roll', () => {
    // expected = 1 × 2000 / (1000 × 1) = 2.0 (fractional part 0 → no Bernoulli)
    const engine = new DiscoveryEngine({
      logger: silentLogger,
      referenceDrillPower: 1,
      maxDiscoveriesPerAsteroidPerTick: 5,
      random: () => 0.999, // would fail a Bernoulli, proving none is rolled
    });
    const out = engine.tick(2000, [state('A', 1000, [{ walletAddress: ALICE, drillPower: 1 }])]);
    expect(out).toHaveLength(2);
    expect(out[0]!.finderWallet).toBe(ALICE);
  });

  it('rolls the fractional part as a Bernoulli trial (hit)', () => {
    // expected = 0.5 → Bernoulli with p=0.5; roll 0.4 < 0.5 → 1 find.
    const engine = new DiscoveryEngine({
      logger: silentLogger,
      referenceDrillPower: 1,
      random: seq(0.4),
    });
    const out = engine.tick(500, [state('A', 1000, [{ walletAddress: ALICE, drillPower: 1 }])]);
    expect(out).toHaveLength(1);
  });

  it('rolls the fractional part as a Bernoulli trial (miss)', () => {
    // expected = 0.5; roll 0.6 ≥ 0.5 → 0 finds.
    const engine = new DiscoveryEngine({
      logger: silentLogger,
      referenceDrillPower: 1,
      random: seq(0.6),
    });
    const out = engine.tick(500, [state('A', 1000, [{ walletAddress: ALICE, drillPower: 1 }])]);
    expect(out).toHaveLength(0);
  });

  it('raises the expected count with more drill power', () => {
    // total power 4 × 1000 / (1000 × 1) = 4.0 → 4 finds (cap 5).
    const engine = new DiscoveryEngine({
      logger: silentLogger,
      referenceDrillPower: 1,
      maxDiscoveriesPerAsteroidPerTick: 5,
      random: () => 0.5,
    });
    const out = engine.tick(1000, [
      state('A', 1000, [
        { walletAddress: ALICE, drillPower: 3 },
        { walletAddress: BOB, drillPower: 1 },
      ]),
    ]);
    expect(out).toHaveLength(4);
  });

  it('referenceDrillPower scales the expected count', () => {
    // ref 10 → expected = 1 × 1000 / (1000 × 10) = 0.1.
    const hit = new DiscoveryEngine({
      logger: silentLogger,
      referenceDrillPower: 10,
      random: seq(0.05),
    });
    expect(
      hit.tick(1000, [state('A', 1000, [{ walletAddress: ALICE, drillPower: 1 }])]),
    ).toHaveLength(1);

    const miss = new DiscoveryEngine({
      logger: silentLogger,
      referenceDrillPower: 10,
      random: seq(0.5),
    });
    expect(
      miss.tick(1000, [state('A', 1000, [{ walletAddress: ALICE, drillPower: 1 }])]),
    ).toHaveLength(0);
  });

  it('caps discoveries per asteroid per tick', () => {
    // expected = 10 × 1000 / (1000 × 1) = 10, capped at 1.
    const engine = new DiscoveryEngine({
      logger: silentLogger,
      referenceDrillPower: 1,
      maxDiscoveriesPerAsteroidPerTick: 1,
      random: () => 0.5,
    });
    const out = engine.tick(1000, [state('A', 1000, [{ walletAddress: ALICE, drillPower: 10 }])]);
    expect(out).toHaveLength(1);
  });

  it('approximates the headline solo find rate (~20%/min for a 5-min rock)', () => {
    // power 5000, ref 5000, base 5min, 60s tick → expected 0.2.
    const FIVE_MIN = 5 * 60 * 1000;
    const miners = [{ walletAddress: ALICE, drillPower: 5000 }];
    const hit = new DiscoveryEngine({
      logger: silentLogger,
      referenceDrillPower: 5000,
      random: seq(0.1),
    });
    expect(hit.tick(60_000, [state('A', FIVE_MIN, miners)])).toHaveLength(1);

    const miss = new DiscoveryEngine({
      logger: silentLogger,
      referenceDrillPower: 5000,
      random: seq(0.25),
    });
    expect(miss.tick(60_000, [state('A', FIVE_MIN, miners)])).toHaveLength(0);
  });
});

describe('DiscoveryEngine — shares + finder selection', () => {
  it('computes drill-power-proportional shares', () => {
    // expected = 4 (integer → no Bernoulli); inspect the first find's shares.
    const engine = new DiscoveryEngine({
      logger: silentLogger,
      referenceDrillPower: 1,
      maxDiscoveriesPerAsteroidPerTick: 5,
      random: () => 0.5,
    });
    const out = engine.tick(1000, [
      state('A', 1000, [
        { walletAddress: ALICE, drillPower: 3 },
        { walletAddress: BOB, drillPower: 1 },
      ]),
    ]);
    const shares = out[0]!.shares;
    const alice = shares.find((s) => s.walletAddress === ALICE)!;
    const bob = shares.find((s) => s.walletAddress === BOB)!;
    expect(alice.sharePercent).toBeCloseTo(75);
    expect(bob.sharePercent).toBeCloseTo(25);
  });

  it('selects the finder weighted by drill power (seeded RNG)', () => {
    // expected = 4 × 250 / (1000 × 1) = 1.0 (no Bernoulli). roll 0.9 ×
    // totalPower(4) = 3.6 → ALICE(3) leaves 0.6 → BOB(1) → BOB.
    const engine = new DiscoveryEngine({
      logger: silentLogger,
      referenceDrillPower: 1,
      random: () => 0.9,
    });
    const out = engine.tick(250, [
      state('A', 1000, [
        { walletAddress: ALICE, drillPower: 3 },
        { walletAddress: BOB, drillPower: 1 },
      ]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.finderWallet).toBe(BOB);
  });

  it('low roll selects the highest-power miner', () => {
    const engine = new DiscoveryEngine({
      logger: silentLogger,
      referenceDrillPower: 1,
      random: () => 0.1,
    });
    const out = engine.tick(250, [
      state('A', 1000, [
        { walletAddress: ALICE, drillPower: 3 },
        { walletAddress: BOB, drillPower: 1 },
      ]),
    ]);
    expect(out[0]!.finderWallet).toBe(ALICE);
  });
});
