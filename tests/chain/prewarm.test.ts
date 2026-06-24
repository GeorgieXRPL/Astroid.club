/**
 * Tests for `OnChainHoldEstimator` (server/chain/prewarm.ts).
 *
 * Strategy: stub `fetch` with hand-crafted Helius enriched-transaction
 * payloads so we get deterministic, network-free coverage of:
 *
 * - Continuous-hold path (no dips in the lookback window) — returns
 *   the oldest fetched transaction's timestamp.
 * - Recent-dip path — returns the timestamp of the transfer that
 *   pushed balance back above threshold.
 * - Outbound-only path — handles wallets that have only ever sent.
 * - Empty / non-array responses — return null gracefully.
 * - Network failures — propagate to the caller.
 * - Caching — null and non-null results both cache.
 * - Cap on `maxLookback` (Helius 100/page).
 * - Mint filter (transfers for unrelated mints are ignored).
 *
 * These tests assert on the algorithm's invariants without needing
 * a real Helius account.
 */

import { describe, expect, it, vi } from 'vitest';

import { OnChainHoldEstimator } from '../../server/chain/prewarm.js';
import type { GameLogger } from '../../server/game/interfaces.js';

const ALICE = 'AliceWalletAddress11111111111111111111111111';
const BOB = 'BobWalletAddress2222222222222222222222222222';
const ASTROID_MINT = '8NwtzwGm4CV8Hm4fJXR69ac1MxDYuSaN3A9HVyikpump';
const OTHER_MINT = 'OtherMintAddress3333333333333333333333333333';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

class FakeClock {
  constructor(public ms: number = 1_700_000_000_000) {}
  now = (): number => this.ms;
  advance = (deltaMs: number) => {
    this.ms += deltaMs;
  };
}

interface FakeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount?: number;
  mint?: string;
}

interface FakeTransaction {
  signature?: string;
  timestamp?: number;
  tokenTransfers?: FakeTransfer[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeFetch(payload: FakeTransaction[] | { error: string; status?: number }) {
  return vi.fn(async (_url: string) => {
    if (Array.isArray(payload)) return jsonResponse(payload);
    return jsonResponse({ error: payload.error }, payload.status ?? 500);
  });
}

function makeEstimator(opts?: {
  payload?: FakeTransaction[];
  fetchImpl?: ReturnType<typeof vi.fn>;
  cacheTtlMs?: number;
  maxLookback?: number;
  clock?: FakeClock;
}) {
  const clock = opts?.clock ?? new FakeClock();
  const fetchImpl = opts?.fetchImpl ?? fakeFetch(opts?.payload ?? []);
  const estimator = new OnChainHoldEstimator({
    mintAddress: ASTROID_MINT,
    heliusApiKey: 'fake-key',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    logger: silentLogger,
    cacheTtlMs: opts?.cacheTtlMs ?? 300_000,
    maxLookback: opts?.maxLookback,
    now: clock.now,
  });
  return { estimator, fetchImpl, clock };
}

// =============================================================================
// Construction
// =============================================================================

describe('OnChainHoldEstimator construction', () => {
  it('throws when mintAddress is empty', () => {
    expect(() => new OnChainHoldEstimator({ mintAddress: '', heliusApiKey: 'x' })).toThrow(
      /mintAddress/,
    );
  });

  it('throws when heliusApiKey is empty', () => {
    expect(() => new OnChainHoldEstimator({ mintAddress: ASTROID_MINT, heliusApiKey: '' })).toThrow(
      /heliusApiKey/,
    );
  });

  it('throws on negative cacheTtlMs', () => {
    expect(
      () =>
        new OnChainHoldEstimator({
          mintAddress: ASTROID_MINT,
          heliusApiKey: 'x',
          cacheTtlMs: -1,
        }),
    ).toThrow(/cacheTtlMs/);
  });

  it('clamps maxLookback to [1, 100]', async () => {
    // Indirect verification: pass a huge value, then assert the
    // emitted URL caps at limit=100.
    const stubFetch = vi.fn(async (_url: string) => jsonResponse([]));
    const e = new OnChainHoldEstimator({
      mintAddress: ASTROID_MINT,
      heliusApiKey: 'k',
      maxLookback: 9_999,
      fetchImpl: stubFetch as unknown as typeof fetch,
    });
    await e.estimateHoldStartMs(ALICE, 1, 1);
    const url = stubFetch.mock.calls[0]?.[0] ?? '';
    expect(url).toContain('limit=100');
  });
});

// =============================================================================
// Algorithm: continuous hold
// =============================================================================

describe('OnChainHoldEstimator: continuous hold', () => {
  it('returns the oldest fetched timestamp when wallet never dipped below threshold', async () => {
    // Wallet currently holds 1000. Looking back: 3 inbound transfers
    // each adding 100, all months ago. Reverse-simulating gives us
    // 1000 → 900 → 800 → 700, all >= threshold (500). No dip in
    // the window → return oldest tx's timestamp.
    const oldestTs = 1_690_000_000;
    const payload: FakeTransaction[] = [
      {
        signature: 'sig3',
        timestamp: 1_695_000_000,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 100, mint: ASTROID_MINT }],
      },
      {
        signature: 'sig2',
        timestamp: 1_692_500_000,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 100, mint: ASTROID_MINT }],
      },
      {
        signature: 'sig1',
        timestamp: oldestTs,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 100, mint: ASTROID_MINT }],
      },
    ];
    const { estimator } = makeEstimator({ payload });
    const r = await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(r).toBe(oldestTs * 1000);
  });

  it('handles a wallet that has only ever received', async () => {
    const oldestTs = 1_680_000_000;
    const payload: FakeTransaction[] = [
      {
        timestamp: 1_695_000_000,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 50, mint: ASTROID_MINT }],
      },
      {
        timestamp: oldestTs,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 1000, mint: ASTROID_MINT }],
      },
    ];
    const { estimator } = makeEstimator({ payload });
    const r = await estimator.estimateHoldStartMs(ALICE, 1050, 500);
    expect(r).toBe(oldestTs * 1000);
  });
});

// =============================================================================
// Algorithm: recent dip
// =============================================================================

describe('OnChainHoldEstimator: recent dip', () => {
  it('returns the timestamp of the buyback that pushed balance above threshold', async () => {
    // Wallet currently holds 1000. Threshold = 500.
    // Most recent: inbound 800 (the buyback). Before that: outbound 600.
    // Reverse:
    //   start: balance=1000
    //   undo inbound 800 → balance=200 (BELOW threshold!)
    // So at the moment immediately before the buyback fired, the
    // wallet was below threshold. The buyback's timestamp is when
    // they crossed back above. Return THAT timestamp.
    const buybackTs = 1_697_000_000;
    const payload: FakeTransaction[] = [
      {
        signature: 'buyback',
        timestamp: buybackTs,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 800, mint: ASTROID_MINT }],
      },
      {
        signature: 'sell',
        timestamp: 1_696_000_000,
        tokenTransfers: [{ fromUserAccount: ALICE, tokenAmount: 600, mint: ASTROID_MINT }],
      },
      {
        signature: 'old-buy',
        timestamp: 1_690_000_000,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 800, mint: ASTROID_MINT }],
      },
    ];
    const { estimator } = makeEstimator({ payload });
    const r = await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(r).toBe(buybackTs * 1000);
  });

  it('walks past transfers that do not change the wallet`s balance', async () => {
    // Wallet currently holds 1000. Threshold = 500.
    // Newest transfer involves a different wallet (Bob), so it does
    // not affect the simulated balance — we simply skip it.
    const oldTs = 1_690_000_000;
    const payload: FakeTransaction[] = [
      {
        timestamp: 1_697_000_000,
        tokenTransfers: [
          {
            fromUserAccount: BOB,
            toUserAccount: 'someone-else',
            tokenAmount: 100,
            mint: ASTROID_MINT,
          },
        ],
      },
      {
        timestamp: oldTs,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 1000, mint: ASTROID_MINT }],
      },
    ];
    const { estimator } = makeEstimator({ payload });
    const r = await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(r).toBe(oldTs * 1000);
  });
});

// =============================================================================
// Mint isolation
// =============================================================================

describe('OnChainHoldEstimator: mint filter', () => {
  it('ignores transfers for other mints', async () => {
    const oldestAstroidTs = 1_688_000_000;
    const payload: FakeTransaction[] = [
      {
        timestamp: 1_697_000_000,
        // Inbound on ANOTHER mint — must NOT affect the simulation.
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 999_999, mint: OTHER_MINT }],
      },
      {
        timestamp: oldestAstroidTs,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 1000, mint: ASTROID_MINT }],
      },
    ];
    const { estimator } = makeEstimator({ payload });
    const r = await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(r).toBe(oldestAstroidTs * 1000);
  });

  it('case-insensitively matches the mint', async () => {
    const ts = 1_690_000_000;
    const payload: FakeTransaction[] = [
      {
        timestamp: ts,
        tokenTransfers: [
          { toUserAccount: ALICE, tokenAmount: 1000, mint: ASTROID_MINT.toUpperCase() },
        ],
      },
    ];
    const { estimator } = makeEstimator({ payload });
    const r = await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(r).toBe(ts * 1000);
  });
});

// =============================================================================
// Empty / no-signal paths
// =============================================================================

describe('OnChainHoldEstimator: no signal', () => {
  it('returns null when Helius returns an empty array', async () => {
    const { estimator } = makeEstimator({ payload: [] });
    const r = await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(r).toBeNull();
  });

  it('treats a window with only foreign-mint transfers as continuous (oldest ts)', async () => {
    // Transactions exist, but none move the $ASTROID mint.
    // No mint-matching transfers → balance stays at 1000 (above
    // threshold) → no dip found → return oldest tx's timestamp.
    // We treat "tx exists in window but no relevant transfer" as
    // a valid lookback floor; this matches `continuous hold`.
    const payload: FakeTransaction[] = [
      {
        timestamp: 1_697_000_000,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 100, mint: OTHER_MINT }],
      },
    ];
    const { estimator } = makeEstimator({ payload });
    const r = await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(r).toBe(1_697_000_000 * 1000);
  });

  it('returns null below threshold (defensive)', async () => {
    const { estimator, fetchImpl } = makeEstimator({ payload: [] });
    const r = await estimator.estimateHoldStartMs(ALICE, 100, 500);
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('handles non-array Helius responses gracefully', async () => {
    const stubFetch = vi.fn(async (_url: string) => jsonResponse({ error: 'rate-limited' }));
    const e = new OnChainHoldEstimator({
      mintAddress: ASTROID_MINT,
      heliusApiKey: 'k',
      fetchImpl: stubFetch as unknown as typeof fetch,
      logger: silentLogger,
    });
    const r = await e.estimateHoldStartMs(ALICE, 1000, 500);
    expect(r).toBeNull();
  });
});

// =============================================================================
// Errors propagate
// =============================================================================

describe('OnChainHoldEstimator: errors', () => {
  it('throws when Helius returns a non-2xx', async () => {
    const stubFetch = vi.fn(async (_url: string) => jsonResponse({ error: 'unauthorized' }, 401));
    const e = new OnChainHoldEstimator({
      mintAddress: ASTROID_MINT,
      heliusApiKey: 'k',
      fetchImpl: stubFetch as unknown as typeof fetch,
      logger: silentLogger,
    });
    await expect(e.estimateHoldStartMs(ALICE, 1000, 500)).rejects.toThrow(/401/);
  });

  it('throws on input validation (NaN balance)', async () => {
    const { estimator } = makeEstimator({ payload: [] });
    await expect(estimator.estimateHoldStartMs(ALICE, Number.NaN, 500)).rejects.toThrow(
      /currentBalance/,
    );
  });

  it('throws on input validation (negative requiredBalance)', async () => {
    const { estimator } = makeEstimator({ payload: [] });
    await expect(estimator.estimateHoldStartMs(ALICE, 1000, -1)).rejects.toThrow(/requiredBalance/);
  });

  it('does NOT cache failures', async () => {
    const stubFetch = vi.fn(async (_url: string) => jsonResponse({ error: 'rate-limited' }, 429));
    const e = new OnChainHoldEstimator({
      mintAddress: ASTROID_MINT,
      heliusApiKey: 'k',
      fetchImpl: stubFetch as unknown as typeof fetch,
      logger: silentLogger,
    });
    await expect(e.estimateHoldStartMs(ALICE, 1000, 500)).rejects.toThrow();
    await expect(e.estimateHoldStartMs(ALICE, 1000, 500)).rejects.toThrow();
    expect(stubFetch).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Caching
// =============================================================================

describe('OnChainHoldEstimator: caching', () => {
  it('caches a non-null result', async () => {
    const ts = 1_690_000_000;
    const payload: FakeTransaction[] = [
      {
        timestamp: ts,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 1000, mint: ASTROID_MINT }],
      },
    ];
    const { estimator, fetchImpl, clock } = makeEstimator({ payload });
    const a = await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    clock.advance(150_000);
    const b = await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(a).toBe(ts * 1000);
    expect(b).toBe(ts * 1000);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('caches a null result too (avoids hammering Helius for known-empty histories)', async () => {
    const { estimator, fetchImpl, clock } = makeEstimator({ payload: [] });
    await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    clock.advance(150_000);
    await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('refetches after the cache TTL expires', async () => {
    const { estimator, fetchImpl, clock } = makeEstimator({ payload: [], cacheTtlMs: 60_000 });
    await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    clock.advance(60_001);
    await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cacheTtlMs=0 disables caching', async () => {
    const { estimator, fetchImpl } = makeEstimator({ payload: [], cacheTtlMs: 0 });
    await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(estimator.cacheSize()).toBe(0);
  });

  it('different wallets cache independently', async () => {
    const payload: FakeTransaction[] = [
      {
        timestamp: 1_690_000_000,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 1000, mint: ASTROID_MINT }],
      },
    ];
    const { estimator, fetchImpl } = makeEstimator({ payload });
    await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    await estimator.estimateHoldStartMs(BOB, 1000, 500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('invalidateCache(wallet) drops only that wallet', async () => {
    const payload: FakeTransaction[] = [
      {
        timestamp: 1_690_000_000,
        tokenTransfers: [{ toUserAccount: ALICE, tokenAmount: 1000, mint: ASTROID_MINT }],
      },
    ];
    const { estimator, fetchImpl } = makeEstimator({ payload });
    await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(estimator.cacheSize()).toBe(1);
    estimator.invalidateCache(ALICE);
    expect(estimator.cacheSize()).toBe(0);
    await estimator.estimateHoldStartMs(ALICE, 1000, 500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// URL contract
// =============================================================================

describe('OnChainHoldEstimator: URL', () => {
  it('hits mainnet by default and devnet when isDevnet is true', async () => {
    const stubFetch = vi.fn(async (_url: string) => jsonResponse([]));
    const mainnet = new OnChainHoldEstimator({
      mintAddress: ASTROID_MINT,
      heliusApiKey: 'k',
      fetchImpl: stubFetch as unknown as typeof fetch,
    });
    await mainnet.estimateHoldStartMs(ALICE, 1, 1);
    expect(stubFetch.mock.calls[0]?.[0] ?? '').toContain('api.helius.xyz');

    stubFetch.mockClear();
    const devnet = new OnChainHoldEstimator({
      mintAddress: ASTROID_MINT,
      heliusApiKey: 'k',
      isDevnet: true,
      fetchImpl: stubFetch as unknown as typeof fetch,
    });
    await devnet.estimateHoldStartMs(ALICE, 1, 1);
    expect(stubFetch.mock.calls[0]?.[0] ?? '').toContain('api-devnet.helius.xyz');
  });

  it('embeds the wallet address and api-key in the URL', async () => {
    const stubFetch = vi.fn(async (_url: string) => jsonResponse([]));
    const e = new OnChainHoldEstimator({
      mintAddress: ASTROID_MINT,
      heliusApiKey: 'super-secret-key',
      fetchImpl: stubFetch as unknown as typeof fetch,
    });
    await e.estimateHoldStartMs(ALICE, 1, 1);
    const url = stubFetch.mock.calls[0]?.[0] ?? '';
    expect(url).toContain(ALICE);
    expect(url).toContain('api-key=super-secret-key');
    expect(url).toContain('/transactions');
  });
});
