/**
 * Unit tests for the comp / holder-gate-bypass list (`CompWalletService`).
 *
 * Covers: env-seed + store load (unioned, deduped), live add/remove with
 * write-through to the store, base58 validation, and the synchronous `has()`
 * the holder gate relies on.
 */

import { describe, expect, it } from 'vitest';

import type { CompWalletStore } from '../../server/game/interfaces.js';
import { CompWalletService, isValidWalletAddress } from '../../server/verification/comp-wallets.js';

const WALLET_A = 'CUPxyEgEvw1Yi8n2C62SPVVYcMiMu4exMBrDz4eS8fXA';
const WALLET_B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

/** In-memory `CompWalletStore` that records every call for assertions. */
function fakeStore(initial: string[] = []): CompWalletStore & {
  data: Map<string, string | undefined>;
  adds: Array<{ wallet: string; note?: string }>;
  removes: string[];
} {
  const data = new Map<string, string | undefined>(initial.map((w) => [w, undefined]));
  const adds: Array<{ wallet: string; note?: string }> = [];
  const removes: string[] = [];
  return {
    data,
    adds,
    removes,
    list: () => [...data.keys()],
    add: (wallet, note) => {
      data.set(wallet, note);
      adds.push({ wallet, note });
    },
    remove: (wallet) => {
      data.delete(wallet);
      removes.push(wallet);
    },
  };
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('isValidWalletAddress', () => {
  it('accepts a 44-char base58 pubkey', () => {
    expect(isValidWalletAddress(WALLET_A)).toBe(true);
    expect(isValidWalletAddress(WALLET_B)).toBe(true);
  });

  it('rejects junk, empty, and non-string input', () => {
    expect(isValidWalletAddress('')).toBe(false);
    expect(isValidWalletAddress('not a wallet!')).toBe(false);
    expect(isValidWalletAddress('0OIl' + WALLET_A.slice(4))).toBe(false); // contains 0/O/I/l
    expect(isValidWalletAddress('short')).toBe(false);
    expect(isValidWalletAddress(undefined)).toBe(false);
    expect(isValidWalletAddress(12345)).toBe(false);
  });
});

describe('CompWalletService', () => {
  it('loads the env seed and store entries, unioned and deduped', async () => {
    const store = fakeStore([WALLET_A]);
    const svc = new CompWalletService({ store, logger: silent });
    await svc.load([WALLET_A, WALLET_B]); // WALLET_A overlaps the store

    expect(svc.has(WALLET_A)).toBe(true);
    expect(svc.has(WALLET_B)).toBe(true);
    expect(svc.size).toBe(2);
    expect(svc.list()).toEqual([WALLET_B, WALLET_A].sort());
  });

  it('ignores invalid seed entries', async () => {
    const svc = new CompWalletService({ logger: silent });
    await svc.load(['garbage', WALLET_A]);
    expect(svc.has(WALLET_A)).toBe(true);
    expect(svc.size).toBe(1);
  });

  it('adds to the in-memory set and writes through to the store', async () => {
    const store = fakeStore();
    const svc = new CompWalletService({ store, logger: silent });
    await svc.add(WALLET_A, 'team');

    expect(svc.has(WALLET_A)).toBe(true);
    expect(store.adds).toEqual([{ wallet: WALLET_A, note: 'team' }]);
    expect(store.data.get(WALLET_A)).toBe('team');
  });

  it('rejects an invalid wallet on add (and does not touch the store)', async () => {
    const store = fakeStore();
    const svc = new CompWalletService({ store, logger: silent });
    await expect(svc.add('nope')).rejects.toThrow(/invalid wallet/);
    expect(store.adds).toEqual([]);
    expect(svc.size).toBe(0);
  });

  it('removes from the set + store and reports prior presence', async () => {
    const store = fakeStore([WALLET_A]);
    const svc = new CompWalletService({ store, logger: silent });
    await svc.load();

    expect(await svc.remove(WALLET_A)).toBe(true);
    expect(svc.has(WALLET_A)).toBe(false);
    expect(store.removes).toEqual([WALLET_A]);

    // Removing again returns false (not present) but still persists the delete.
    expect(await svc.remove(WALLET_A)).toBe(false);
  });

  it('works in-memory only when no store is wired', async () => {
    const svc = new CompWalletService({ logger: silent });
    await svc.load([WALLET_B]);
    await svc.add(WALLET_A);
    expect(svc.list()).toEqual([WALLET_B, WALLET_A].sort());
    expect(await svc.remove(WALLET_B)).toBe(true);
    expect(svc.size).toBe(1);
  });

  it('survives a store load failure without throwing', async () => {
    const broken: CompWalletStore = {
      list: () => {
        throw new Error('db down');
      },
      add: () => {},
      remove: () => {},
    };
    const svc = new CompWalletService({ store: broken, logger: silent });
    await expect(svc.load([WALLET_A])).resolves.toBeUndefined();
    // Env seed still applied even though the store read failed.
    expect(svc.has(WALLET_A)).toBe(true);
  });
});
