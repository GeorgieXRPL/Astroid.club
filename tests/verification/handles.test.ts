/**
 * Unit tests for the chat-handle service + validator.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HandleStore } from '../../server/game/interfaces.js';
import { HandleError, HandleService, normalizeHandle } from '../../server/verification/handles.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function memStore(seed: Array<[string, string]> = []): {
  store: HandleStore;
  saved: Map<string, string>;
} {
  const saved = new Map<string, string>(seed);
  return {
    saved,
    store: {
      getAll: () => new Map(saved),
      set: vi.fn(async (wallet: string, handle: string) => {
        saved.set(wallet, handle);
      }),
    },
  };
}

describe('normalizeHandle', () => {
  it('trims and accepts valid handles', () => {
    expect(normalizeHandle('  Belt_Miner7  ')).toBe('Belt_Miner7');
  });

  it('rejects too-short / too-long names', () => {
    expect(() => normalizeHandle('ab')).toThrow(HandleError);
    expect(() => normalizeHandle('a'.repeat(21))).toThrow(HandleError);
  });

  it('rejects illegal characters', () => {
    expect(() => normalizeHandle('has space')).toThrow(HandleError);
    expect(() => normalizeHandle('emoji😀')).toThrow(HandleError);
    expect(() => normalizeHandle('dash-name')).toThrow(HandleError);
  });

  it('rejects reserved names (case-insensitively)', () => {
    expect(() => normalizeHandle('YOU')).toThrow(HandleError);
    expect(() => normalizeHandle('Admin')).toThrow(HandleError);
  });
});

describe('HandleService', () => {
  it('claims, reads back, and persists a handle', async () => {
    const { store, saved } = memStore();
    const svc = new HandleService({ store, logger: silentLogger });
    const result = await svc.set('WALLET_A', 'Nova');
    expect(result).toBe('Nova');
    expect(svc.get('WALLET_A')).toBe('Nova');
    expect(saved.get('WALLET_A')).toBe('Nova');
  });

  it('enforces case-insensitive uniqueness across wallets', async () => {
    const svc = new HandleService({ ...memStore(), logger: silentLogger });
    await svc.set('WALLET_A', 'Nova');
    await expect(svc.set('WALLET_B', 'nova')).rejects.toBeInstanceOf(HandleError);
    // A still owns it; B never got one.
    expect(svc.get('WALLET_A')).toBe('Nova');
    expect(svc.get('WALLET_B')).toBeNull();
  });

  it('lets a wallet change its own handle and frees the old name', async () => {
    const svc = new HandleService({ ...memStore(), logger: silentLogger });
    await svc.set('WALLET_A', 'Nova');
    await svc.set('WALLET_A', 'Quasar');
    expect(svc.get('WALLET_A')).toBe('Quasar');
    // The freed name can now be taken by someone else.
    await expect(svc.set('WALLET_B', 'Nova')).resolves.toBe('Nova');
  });

  it('re-claiming the same handle is an idempotent no-op', async () => {
    const { store } = memStore();
    const setSpy = store.set as ReturnType<typeof vi.fn>;
    const svc = new HandleService({ store, logger: silentLogger });
    await svc.set('WALLET_A', 'Nova');
    expect(setSpy).toHaveBeenCalledTimes(1);
    await svc.set('WALLET_A', 'Nova');
    // No second persist for the same value.
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it('loads persisted handles on boot', async () => {
    const { store } = memStore([
      ['WALLET_A', 'Nova'],
      ['WALLET_B', 'Quasar'],
    ]);
    const svc = new HandleService({ store, logger: silentLogger });
    await svc.load();
    expect(svc.get('WALLET_A')).toBe('Nova');
    expect(svc.get('WALLET_B')).toBe('Quasar');
    expect(svc.size).toBe(2);
    // Uniqueness holds after load.
    await expect(svc.set('WALLET_C', 'nova')).rejects.toBeInstanceOf(HandleError);
  });
});
