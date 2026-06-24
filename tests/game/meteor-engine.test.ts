/**
 * Unit tests for `server/game/meteor-engine.ts`.
 *
 * The engine is pure bookkeeping + deterministic rolls (RNG + clock injected),
 * so every branch is exercised without real timers. The engine moves no money
 * and applies no effects — it only decides *what* happens; the world applies it.
 */

import { describe, expect, it } from 'vitest';

import type { GameLogger } from '../../server/game/interfaces.js';
import { MeteorEngine, type MeteorCandidate } from '../../server/game/meteor-engine.js';

const silentLogger: GameLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Deterministic RNG that replays a queue, then repeats the last value. */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

function candidate(asteroidId: string, vaultBalance = 1000, hasActiveMiners = true): MeteorCandidate {
  return { asteroidId, vaultBalance, hasActiveMiners };
}

function makeEngine(random: () => number, overrides = {}): MeteorEngine {
  return new MeteorEngine({
    spawnChancePerTick: 0.15,
    warningMs: 90_000,
    vaultSkimPercent: 15,
    yieldPenaltyPercent: 30,
    deflectCostFraction: 0.1,
    minDeflectCost: 50,
    random,
    logger: silentLogger,
    ...overrides,
  });
}

describe('MeteorEngine.maybeSpawn', () => {
  it('does not spawn when the roll is above the spawn chance', () => {
    const e = makeEngine(seq([0.9]));
    expect(e.maybeSpawn([candidate('A')], 1000)).toBeNull();
    expect(e.getActive()).toHaveLength(0);
  });

  it('spawns when the roll is below the spawn chance', () => {
    const e = makeEngine(seq([0.05, 0]));
    const m = e.maybeSpawn([candidate('A', 1000)], 1_000_000);
    expect(m).not.toBeNull();
    expect(m!.asteroidId).toBe('A');
    expect(m!.status).toBe('incoming');
    expect(m!.impactAt.getTime()).toBe(1_000_000 + 90_000);
    expect(e.getActive()).toHaveLength(1);
  });

  it('returns null for an empty candidate list', () => {
    const e = makeEngine(seq([0.05, 0]));
    expect(e.maybeSpawn([], 1000)).toBeNull();
  });

  it('sizes the deflect cost from the vault, floored at the minimum', () => {
    const e = makeEngine(seq([0.05, 0]));
    // 10% of 1000 = 100 (> min 50).
    expect(e.maybeSpawn([candidate('A', 1000)], 1)!.deflectCost).toBe(100);
    const e2 = makeEngine(seq([0.05, 0]));
    // 10% of 100 = 10, floored to min 50.
    expect(e2.maybeSpawn([candidate('B', 100)], 1)!.deflectCost).toBe(50);
  });

  it('prefers candidates with active miners', () => {
    const e = makeEngine(seq([0.05, 0]));
    const m = e.maybeSpawn(
      [candidate('IDLE', 1000, false), candidate('BUSY', 1000, true)],
      1,
    );
    expect(m!.asteroidId).toBe('BUSY');
  });

  it('never spawns a second meteor on an already-threatened asteroid', () => {
    const e = makeEngine(seq([0.05, 0, 0.05, 0]));
    expect(e.maybeSpawn([candidate('A')], 1)).not.toBeNull();
    // Only A is a candidate and it's already threatened -> no eligible target.
    expect(e.maybeSpawn([candidate('A')], 2)).toBeNull();
  });
});

describe('MeteorEngine.deflect', () => {
  it('deflects an incoming meteor and reports the cost', () => {
    const e = makeEngine(seq([0.05, 0]));
    const m = e.maybeSpawn([candidate('A', 1000)], 1000)!;
    const r = e.deflect(m.id, 'wallet1', 1000 + 10_000);
    expect(r.ok).toBe(true);
    expect(r.cost).toBe(m.deflectCost);
    expect(r.threat!.status).toBe('deflected');
    expect(r.threat!.deflectedBy).toBe('wallet1');
    // No longer active; recorded in history.
    expect(e.getActive()).toHaveLength(0);
    expect(e.getRecent()[0]!.id).toBe(m.id);
  });

  it('rejects an unknown meteor', () => {
    const e = makeEngine(seq([0.9]));
    expect(e.deflect('nope', 'wallet1', 1).code).toBe('unknown_meteor');
  });

  it('rejects deflection after the impact deadline', () => {
    const e = makeEngine(seq([0.05, 0]));
    const m = e.maybeSpawn([candidate('A')], 1000)!;
    const r = e.deflect(m.id, 'wallet1', m.impactAt.getTime() + 1);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('expired');
  });

  it('rejects a second deflection of the same meteor', () => {
    const e = makeEngine(seq([0.05, 0]));
    const m = e.maybeSpawn([candidate('A')], 1000)!;
    e.deflect(m.id, 'wallet1', 1000 + 1);
    expect(e.deflect(m.id, 'wallet2', 1000 + 2).code).toBe('unknown_meteor');
  });
});

describe('MeteorEngine.resolveDue', () => {
  it('strikes meteors whose deadline has passed', () => {
    const e = makeEngine(seq([0.05, 0]));
    const m = e.maybeSpawn([candidate('A')], 1000)!;
    expect(e.resolveDue(m.impactAt.getTime() - 1)).toHaveLength(0); // not yet
    const struck = e.resolveDue(m.impactAt.getTime());
    expect(struck).toHaveLength(1);
    expect(struck[0]!.status).toBe('struck');
    expect(e.getActive()).toHaveLength(0);
    expect(e.getRecent()[0]!.status).toBe('struck');
  });

  it('does not strike a meteor that was already deflected', () => {
    const e = makeEngine(seq([0.05, 0]));
    const m = e.maybeSpawn([candidate('A')], 1000)!;
    e.deflect(m.id, 'wallet1', 1000 + 1);
    expect(e.resolveDue(m.impactAt.getTime() + 10_000)).toHaveLength(0);
  });
});
