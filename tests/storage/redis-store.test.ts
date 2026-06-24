/**
 * Unit tests for `server/storage/redis-store.ts`.
 *
 * Exercises both adapter views (`homeStation`, `pendingYield`) against a
 * fake ioredis client so the tests need no live Redis. Verifies the
 * hash layout (two keys), value (de)serialisation, the boot-restore
 * filter (drop zero/NaN), and the resilience contract (a Redis error
 * never propagates to the caller).
 */

import { describe, expect, it } from 'vitest';

import type { GameLogger } from '../../server/game/interfaces.js';
import { RedisGameStore, type RedisClientLike } from '../../server/storage/redis-store.js';

const silentLogger: GameLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Minimal in-memory hash store mimicking the ioredis methods used. */
function fakeRedis(): RedisClientLike & { hashes: Map<string, Map<string, string>> } {
  const hashes = new Map<string, Map<string, string>>();
  const hash = (key: string) => {
    let h = hashes.get(key);
    if (!h) {
      h = new Map();
      hashes.set(key, h);
    }
    return h;
  };
  return {
    hashes,
    async hset(key, field, value) {
      hash(key).set(field, value);
      return 1;
    },
    async hget(key, field) {
      return hash(key).get(field) ?? null;
    },
    async hdel(key, field) {
      return hash(key).delete(field) ? 1 : 0;
    },
    async hgetall(key) {
      return Object.fromEntries(hash(key));
    },
    async quit() {
      return 'OK';
    },
  };
}

const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';

describe('RedisGameStore construction', () => {
  it('throws when neither url nor client is provided', () => {
    expect(() => new RedisGameStore({ logger: silentLogger })).toThrow(/url.*client/i);
  });
});

describe('RedisGameStore home station', () => {
  it('round-trips a home station and isolates the hash key', async () => {
    const client = fakeRedis();
    const store = new RedisGameStore({ client, logger: silentLogger });
    await store.homeStation.set(ALICE, 'asteroid-1');
    expect(await store.homeStation.get(ALICE)).toBe('asteroid-1');
    expect(client.hashes.get('astroid:home-station')?.get(ALICE)).toBe('asteroid-1');
    expect(await store.homeStation.get(BOB)).toBeNull();
  });

  it('honours a custom key prefix', async () => {
    const client = fakeRedis();
    const store = new RedisGameStore({ client, keyPrefix: 'test', logger: silentLogger });
    await store.homeStation.set(ALICE, 'asteroid-9');
    expect(client.hashes.get('test:home-station')?.get(ALICE)).toBe('asteroid-9');
  });
});

describe('RedisGameStore pending yield', () => {
  it('persists, reads back, and deletes amounts', async () => {
    const client = fakeRedis();
    const store = new RedisGameStore({ client, logger: silentLogger });
    await store.pendingYield.set(ALICE, 114);
    await store.pendingYield.set(BOB, 7);
    const all = await store.pendingYield.getAll();
    expect(all.get(ALICE)).toBe(114);
    expect(all.get(BOB)).toBe(7);

    await store.pendingYield.delete(ALICE);
    expect((await store.pendingYield.getAll()).has(ALICE)).toBe(false);
  });

  it('drops zero / non-finite balances on getAll', async () => {
    const client = fakeRedis();
    client.hashes.set(
      'astroid:pending-yield',
      new Map([
        [ALICE, '0'],
        [BOB, '42'],
        ['carol', 'not-a-number'],
      ]),
    );
    const store = new RedisGameStore({ client, logger: silentLogger });
    const all = await store.pendingYield.getAll();
    expect(all.size).toBe(1);
    expect(all.get(BOB)).toBe(42);
  });
});

describe('RedisGameStore raid vault', () => {
  it('persists, reads back, and isolates the raid-vault hash key', async () => {
    const client = fakeRedis();
    const store = new RedisGameStore({ client, logger: silentLogger });
    await store.raidVault.set('asteroid-1', 1500);
    await store.raidVault.set('asteroid-2', 320);
    const all = await store.raidVault.getAll();
    expect(all.get('asteroid-1')).toBe(1500);
    expect(all.get('asteroid-2')).toBe(320);
    expect(client.hashes.get('astroid:raid-vault')?.get('asteroid-1')).toBe('1500');
  });

  it('drops zero / non-finite balances on getAll', async () => {
    const client = fakeRedis();
    client.hashes.set(
      'astroid:raid-vault',
      new Map([
        ['asteroid-1', '0'],
        ['asteroid-2', '900'],
        ['asteroid-3', 'NaN'],
      ]),
    );
    const store = new RedisGameStore({ client, logger: silentLogger });
    const all = await store.raidVault.getAll();
    expect(all.size).toBe(1);
    expect(all.get('asteroid-2')).toBe(900);
  });
});

describe('RedisGameStore escrow wagers', () => {
  it('persists a record, reads it back as unsettled, and deletes it', async () => {
    const client = fakeRedis();
    const store = new RedisGameStore({ client, logger: silentLogger });
    await store.escrow.put({
      wagerId: 'w1',
      wallet: 'ATK',
      amount: 100,
      status: 'active',
      retries: 0,
    });
    let unsettled = await store.escrow.getUnsettled();
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]).toMatchObject({ wagerId: 'w1', wallet: 'ATK', amount: 100, status: 'active' });
    // Round-trips through the dedicated hash key.
    expect(client.hashes.get('astroid:escrow-wager')?.has('w1')).toBe(true);

    await store.escrow.delete('w1');
    unsettled = await store.escrow.getUnsettled();
    expect(unsettled).toHaveLength(0);
  });

  it('round-trips settlement legs and excludes settled records', async () => {
    const client = fakeRedis();
    const store = new RedisGameStore({ client, logger: silentLogger });
    await store.escrow.put({
      wagerId: 'w2',
      wallet: 'ATK',
      amount: 100,
      status: 'settling',
      retries: 1,
      legs: [
        { kind: 'payout', wallet: 'DEF', amount: 10, done: true, signature: 'pay' },
        { kind: 'burn', amount: 90, done: false },
      ],
    });
    await store.escrow.put({
      wagerId: 'w3',
      wallet: 'X',
      amount: 5,
      status: 'settled',
      retries: 0,
    });
    const unsettled = await store.escrow.getUnsettled();
    expect(unsettled.map((r) => r.wagerId)).toEqual(['w2']);
    expect(unsettled[0]!.legs).toHaveLength(2);
    expect(unsettled[0]!.legs![0]).toMatchObject({ kind: 'payout', done: true });
  });
});

describe('RedisGameStore resilience', () => {
  it('swallows client errors and returns safe defaults', async () => {
    const boom = new Error('connection refused');
    const client: RedisClientLike = {
      hset: () => Promise.reject(boom),
      hget: () => Promise.reject(boom),
      hdel: () => Promise.reject(boom),
      hgetall: () => Promise.reject(boom),
      quit: () => Promise.reject(boom),
    };
    const errors: unknown[][] = [];
    const logger: GameLogger = { info: () => {}, warn: () => {}, error: (...a) => errors.push(a) };
    const store = new RedisGameStore({ client, logger });

    await expect(store.homeStation.set(ALICE, 'a')).resolves.toBeUndefined();
    await expect(store.homeStation.get(ALICE)).resolves.toBeNull();
    await expect(store.pendingYield.set(ALICE, 5)).resolves.toBeUndefined();
    await expect(store.pendingYield.delete(ALICE)).resolves.toBeUndefined();
    await expect(store.pendingYield.getAll()).resolves.toEqual(new Map());
    await expect(store.raidVault.set('asteroid-1', 5)).resolves.toBeUndefined();
    await expect(store.raidVault.getAll()).resolves.toEqual(new Map());
    await expect(store.close()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });
});
