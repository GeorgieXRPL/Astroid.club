/**
 * Unit tests for `server/storage/postgres-store.ts`.
 *
 * Uses a fake pg client that records SQL + params and serves canned rows,
 * so the tests need no live Postgres. Verifies the home-station upsert,
 * the append-only event inserts (credit = +delta, claim = -delta), the
 * derived-balance restore query + parsing, and the resilience contract
 * (a DB error never propagates to the caller).
 */

import { describe, expect, it } from 'vitest';

import type { GameLogger } from '../../server/game/interfaces.js';
import { PostgresGameStore, type PgClientLike } from '../../server/storage/postgres-store.js';

const silentLogger: GameLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface Call {
  text: string;
  params: unknown[];
}

/** Fake pg client: records calls, returns canned rows keyed by SQL match. */
function fakePg(
  responder: (text: string, params: unknown[]) => Array<Record<string, unknown>> = () => [],
): PgClientLike & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return { rows: responder(text, params) };
    },
    async end() {},
  };
}

const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';

describe('PostgresGameStore construction', () => {
  it('throws when neither connectionString nor client is provided', () => {
    expect(() => new PostgresGameStore({ logger: silentLogger })).toThrow(
      /connectionString.*client/i,
    );
  });
});

describe('PostgresGameStore home station', () => {
  it('upserts on set and reads asteroid_id on get', async () => {
    const client = fakePg((text) =>
      text.includes('SELECT asteroid_id') ? [{ asteroid_id: 'asteroid-7' }] : [],
    );
    const store = new PostgresGameStore({ client, logger: silentLogger });

    await store.homeStation.set(ALICE, 'asteroid-7');
    const insert = client.calls[0]!;
    expect(insert.text).toMatch(/INSERT INTO home_stations/i);
    expect(insert.text).toMatch(/ON CONFLICT \(wallet\) DO UPDATE/i);
    expect(insert.params).toEqual([ALICE, 'asteroid-7']);

    expect(await store.homeStation.get(ALICE)).toBe('asteroid-7');
  });

  it('returns null when no home station row exists', async () => {
    const client = fakePg(() => []);
    const store = new PostgresGameStore({ client, logger: silentLogger });
    expect(await store.homeStation.get(BOB)).toBeNull();
  });
});

describe('PostgresGameStore yield ledger', () => {
  it('records a credit as a positive event with the asteroid id', async () => {
    const client = fakePg();
    const store = new PostgresGameStore({ client, logger: silentLogger });
    await store.ledger.recordCredit(ALICE, 'asteroid-1', 114);
    const call = client.calls[0]!;
    expect(call.text).toMatch(/INSERT INTO yield_events/i);
    expect(call.params).toEqual([ALICE, 'asteroid-1', 114, 'credit']);
  });

  it('records a claim as a negative event with no asteroid id', async () => {
    const client = fakePg();
    const store = new PostgresGameStore({ client, logger: silentLogger });
    await store.ledger.recordClaim(ALICE, 75);
    const call = client.calls[0]!;
    expect(call.params).toEqual([ALICE, null, -75, 'claim']);
  });

  it('records a redeem as a negative event tagged kind=redeem', async () => {
    const client = fakePg();
    const store = new PostgresGameStore({ client, logger: silentLogger });
    await store.ledger.recordRedeem(ALICE, 40);
    const call = client.calls[0]!;
    expect(call.text).toMatch(/INSERT INTO yield_events/i);
    expect(call.params).toEqual([ALICE, null, -40, 'redeem']);
  });

  it('skips zero-amount events (no row written)', async () => {
    const client = fakePg();
    const store = new PostgresGameStore({ client, logger: silentLogger });
    await store.ledger.recordCredit(ALICE, 'a', 0);
    await store.ledger.recordClaim(ALICE, 0);
    expect(client.calls).toHaveLength(0);
  });

  it('derives balances from the event sum and parses NUMERIC strings', async () => {
    // pg returns NUMERIC columns as strings — the store must Number() them.
    const client = fakePg((text) =>
      text.includes('SUM(delta)')
        ? [
            { wallet: ALICE, amount: '114' },
            { wallet: BOB, amount: '7.5' },
          ]
        : [],
    );
    const store = new PostgresGameStore({ client, logger: silentLogger });
    const balances = await store.ledger.getAllBalances();
    expect(balances.get(ALICE)).toBe(114);
    expect(balances.get(BOB)).toBe(7.5);
  });
});

describe('PostgresGameStore raid vault', () => {
  it('upserts a vault balance on set', async () => {
    const client = fakePg();
    const store = new PostgresGameStore({ client, logger: silentLogger });
    await store.raidVault.set('asteroid-1', 1500);
    const call = client.calls[0]!;
    expect(call.text).toMatch(/INSERT INTO raid_vaults/i);
    expect(call.text).toMatch(/ON CONFLICT \(asteroid_id\) DO UPDATE/i);
    expect(call.params).toEqual(['asteroid-1', 1500]);
  });

  it('reads back positive balances and parses NUMERIC strings', async () => {
    const client = fakePg((text) =>
      text.includes('FROM raid_vaults')
        ? [
            { asteroid_id: 'asteroid-1', balance: '1500' },
            { asteroid_id: 'asteroid-2', balance: '42.5' },
          ]
        : [],
    );
    const store = new PostgresGameStore({ client, logger: silentLogger });
    const all = await store.raidVault.getAll();
    expect(all.get('asteroid-1')).toBe(1500);
    expect(all.get('asteroid-2')).toBe(42.5);
  });
});

describe('PostgresGameStore escrow wagers', () => {
  it('upserts a record with legs serialized to JSON', async () => {
    const client = fakePg();
    const store = new PostgresGameStore({ client, logger: silentLogger });
    await store.escrow.put({
      wagerId: 'w1',
      wallet: 'ATK',
      amount: 100,
      expeditionId: 'e1',
      targetAsteroid: 'asteroid-2',
      depositSignature: 'sig',
      status: 'settling',
      legs: [{ kind: 'burn', amount: 90, done: false }],
      retries: 1,
      lastError: 'boom',
    });
    const call = client.calls[0]!;
    expect(call.text).toMatch(/INSERT INTO escrow_wagers/i);
    expect(call.text).toMatch(/ON CONFLICT \(wager_id\) DO UPDATE/i);
    expect(call.params[0]).toBe('w1');
    expect(call.params[6]).toBe('settling');
    // legs param is JSON-stringified for the ::jsonb cast.
    expect(call.params[7]).toBe(JSON.stringify([{ kind: 'burn', amount: 90, done: false }]));
    expect(call.params[8]).toBe(1);
  });

  it('reads back unsettled rows and parses NUMERIC + JSON legs', async () => {
    const client = fakePg((text) =>
      text.includes('FROM escrow_wagers')
        ? [
            {
              wager_id: 'w1',
              wallet: 'ATK',
              amount: '100',
              expedition_id: 'e1',
              target_asteroid: 'asteroid-2',
              deposit_sig: 'sig',
              status: 'settling',
              // pg returns jsonb as a parsed object already.
              legs: [{ kind: 'burn', amount: 90, done: false }],
              retries: 2,
              last_error: 'rpc',
            },
          ]
        : [],
    );
    const store = new PostgresGameStore({ client, logger: silentLogger });
    const rows = await store.escrow.getUnsettled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      wagerId: 'w1',
      wallet: 'ATK',
      amount: 100,
      status: 'settling',
      retries: 2,
      lastError: 'rpc',
    });
    expect(rows[0]!.legs).toEqual([{ kind: 'burn', amount: 90, done: false }]);
  });

  it('deletes a settled record by wager id', async () => {
    const client = fakePg();
    const store = new PostgresGameStore({ client, logger: silentLogger });
    await store.escrow.delete('w1');
    const call = client.calls[0]!;
    expect(call.text).toMatch(/DELETE FROM escrow_wagers WHERE wager_id/i);
    expect(call.params).toEqual(['w1']);
  });
});

describe('PostgresGameStore resilience', () => {
  it('swallows query errors and returns safe defaults', async () => {
    const boom = new Error('connection terminated');
    const client: PgClientLike = {
      query: () => Promise.reject(boom),
      end: () => Promise.reject(boom),
    };
    const errors: unknown[][] = [];
    const logger: GameLogger = { info: () => {}, warn: () => {}, error: (...a) => errors.push(a) };
    const store = new PostgresGameStore({ client, logger });

    await expect(store.homeStation.set(ALICE, 'a')).resolves.toBeUndefined();
    await expect(store.homeStation.get(ALICE)).resolves.toBeNull();
    await expect(store.ledger.recordCredit(ALICE, 'a', 5)).resolves.toBeUndefined();
    await expect(store.ledger.recordClaim(ALICE, 5)).resolves.toBeUndefined();
    await expect(store.ledger.recordRedeem(ALICE, 5)).resolves.toBeUndefined();
    await expect(store.ledger.getAllBalances()).resolves.toEqual(new Map());
    await expect(store.raidVault.set('asteroid-1', 5)).resolves.toBeUndefined();
    await expect(store.raidVault.getAll()).resolves.toEqual(new Map());
    await expect(store.close()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });
});
