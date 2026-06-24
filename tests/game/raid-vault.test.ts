/**
 * Unit tests for `server/game/raid-vault.ts`.
 *
 * The raid vault is the persistent, raidable per-asteroid treasury: it grows by
 * a per-discovery cut and only shrinks when a raid steals from it. It must never
 * be auto-distributed, so there is no "distribute" path to test — only add /
 * debit (clamped) / balance accounting.
 */

import { describe, expect, it } from 'vitest';

import type { GameLogger, RaidVaultStore } from '../../server/game/interfaces.js';
import { RaidVaultManager } from '../../server/game/raid-vault.js';

const silentLogger: GameLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeVault(): RaidVaultManager {
  return new RaidVaultManager({ logger: silentLogger });
}

/** In-memory `RaidVaultStore` double that records every write. */
function makeFakeStore(seed: Array<[string, number]> = []): RaidVaultStore & {
  readonly data: Map<string, number>;
  readonly writes: Array<[string, number]>;
} {
  const data = new Map<string, number>(seed);
  const writes: Array<[string, number]> = [];
  return {
    data,
    writes,
    set(asteroidId: string, balance: number) {
      writes.push([asteroidId, balance]);
      data.set(asteroidId, balance);
    },
    getAll() {
      return new Map(data);
    },
  };
}

describe('RaidVaultManager.add', () => {
  it('accumulates per asteroid and returns the new balance', () => {
    const v = makeVault();
    expect(v.add('A', 100)).toBe(100);
    expect(v.add('A', 50)).toBe(150);
    expect(v.getBalance('A')).toBe(150);
  });

  it('keeps balances isolated per asteroid', () => {
    const v = makeVault();
    v.add('A', 100);
    v.add('B', 30);
    expect(v.getBalance('A')).toBe(100);
    expect(v.getBalance('B')).toBe(30);
  });

  it('ignores non-positive amounts', () => {
    const v = makeVault();
    v.add('A', 100);
    expect(v.add('A', 0)).toBe(100);
    expect(v.add('A', -10)).toBe(100);
    expect(v.getBalance('A')).toBe(100);
  });
});

describe('RaidVaultManager.debit', () => {
  it('removes up to the requested amount and returns what was taken', () => {
    const v = makeVault();
    v.add('A', 100);
    expect(v.debit('A', 30)).toBe(30);
    expect(v.getBalance('A')).toBe(70);
  });

  it('clamps a debit larger than the balance to the balance', () => {
    const v = makeVault();
    v.add('A', 50);
    expect(v.debit('A', 999)).toBe(50);
    expect(v.getBalance('A')).toBe(0);
  });

  it('returns 0 for an empty or unknown asteroid', () => {
    const v = makeVault();
    expect(v.debit('A', 10)).toBe(0);
    v.add('A', 10);
    v.debit('A', 10);
    expect(v.debit('A', 10)).toBe(0);
  });

  it('ignores non-positive debit amounts', () => {
    const v = makeVault();
    v.add('A', 50);
    expect(v.debit('A', 0)).toBe(0);
    expect(v.debit('A', -5)).toBe(0);
    expect(v.getBalance('A')).toBe(50);
  });
});

describe('RaidVaultManager inspection', () => {
  it('getBalance is 0 for an unknown asteroid', () => {
    expect(makeVault().getBalance('NOPE')).toBe(0);
  });

  it('getAllBalances returns an isolated snapshot', () => {
    const v = makeVault();
    v.add('A', 10);
    v.add('B', 20);
    const snap = v.getAllBalances();
    expect(snap.get('A')).toBe(10);
    expect(snap.get('B')).toBe(20);
    // Mutating the snapshot must not affect the manager.
    snap.set('A', 999);
    expect(v.getBalance('A')).toBe(10);
  });

  it('getTotal sums every asteroid vault', () => {
    const v = makeVault();
    v.add('A', 10);
    v.add('B', 20);
    v.add('C', 5);
    expect(v.getTotal()).toBe(35);
  });
});

describe('RaidVaultManager persistence', () => {
  it('writes through to the store on add and debit', () => {
    const store = makeFakeStore();
    const v = new RaidVaultManager({ store, logger: silentLogger });
    v.add('A', 100);
    v.add('A', 50);
    v.debit('A', 30);
    expect(store.data.get('A')).toBe(120);
    // Each mutation persists the resulting balance (not the delta).
    expect(store.writes).toEqual([
      ['A', 100],
      ['A', 150],
      ['A', 120],
    ]);
  });

  it('does not persist no-op mutations (non-positive add / empty debit)', () => {
    const store = makeFakeStore();
    const v = new RaidVaultManager({ store, logger: silentLogger });
    v.add('A', 0);
    v.add('A', -5);
    v.debit('A', 10); // empty vault → nothing taken
    expect(store.writes).toEqual([]);
  });

  it('restore() reloads persisted balances into memory', async () => {
    const store = makeFakeStore([
      ['A', 500],
      ['B', 250],
    ]);
    const v = new RaidVaultManager({ store, logger: silentLogger });
    const count = await v.restore();
    expect(count).toBe(2);
    expect(v.getBalance('A')).toBe(500);
    expect(v.getBalance('B')).toBe(250);
    // Restored balances are raidable and keep persisting going forward.
    expect(v.debit('A', 100)).toBe(100);
    expect(store.data.get('A')).toBe(400);
  });

  it('restore() skips non-positive balances and is a no-op without a store', async () => {
    const store = makeFakeStore([
      ['A', 0],
      ['B', -10],
      ['C', 5],
    ]);
    const v = new RaidVaultManager({ store, logger: silentLogger });
    expect(await v.restore()).toBe(1);
    expect(v.getBalance('C')).toBe(5);
    expect(await makeVault().restore()).toBe(0);
  });
});
