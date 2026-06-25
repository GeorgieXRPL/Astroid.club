/**
 * Tests for `HolderChainAdapter` (chain-side balance reader and
 * `ChainOps.impls` adapter).
 *
 * Strategy: inject a fake `BalanceReader` so no network is touched.
 * The fake can be configured to return canned values, throw, or
 * count calls. Combined with an injected clock, this gives us
 * deterministic coverage of:
 *
 * - Cache hit / miss / expiry behavior.
 * - Eligibility flow (adapter → tracker → boolean).
 * - Error propagation (no silent fallback to stale cache).
 * - Cache invalidation.
 *
 * The `SolanaBalanceReader` is exercised separately by a tiny
 * smoke test that asserts construction with a fake fetch
 * (skipped network call).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type BalanceReader,
  HolderChainAdapter,
  SolanaBalanceReader,
} from '../../server/chain/holder.js';
import type { HoldStartEstimator } from '../../server/chain/prewarm.js';
import type { GameLogger } from '../../server/game/interfaces.js';
import { HolderTracker } from '../../server/verification/holder-tracker.js';

const ALICE = 'AliceWalletAddress11111111111111111111111111';
const BOB = 'BobWalletAddress2222222222222222222222222222';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

class FakeReader implements BalanceReader {
  public calls: string[] = [];
  constructor(public balances: Map<string, number | Error>) {}
  async getTokenBalance(walletAddress: string): Promise<number> {
    this.calls.push(walletAddress);
    const v = this.balances.get(walletAddress);
    if (v instanceof Error) throw v;
    if (v === undefined) return 0;
    return v;
  }
}

class FakeClock {
  constructor(public ms: number = 1_000_000) {}
  now = (): number => this.ms;
  advance = (deltaMs: number) => {
    this.ms += deltaMs;
  };
}

class FakeEstimator implements HoldStartEstimator {
  public calls: Array<{ wallet: string; balance: number; required: number }> = [];
  constructor(public answers: Map<string, number | null | Error>) {}
  async estimateHoldStartMs(
    walletAddress: string,
    currentBalance: number,
    requiredBalance: number,
  ): Promise<number | null> {
    this.calls.push({ wallet: walletAddress, balance: currentBalance, required: requiredBalance });
    const v = this.answers.get(walletAddress);
    if (v instanceof Error) throw v;
    return v ?? null;
  }
}

function makeAdapter(opts?: {
  balances?: Map<string, number | Error>;
  requiredBalance?: number;
  cacheTtlMs?: number;
  minHoldMs?: number;
  minConsecutiveObservations?: number;
  estimator?: HoldStartEstimator;
}) {
  const clock = new FakeClock();
  const reader = new FakeReader(opts?.balances ?? new Map());
  const tracker = new HolderTracker({
    minHoldMs: opts?.minHoldMs ?? 600_000,
    minConsecutiveObservations: opts?.minConsecutiveObservations ?? 5,
    logger: silentLogger,
    now: clock.now,
  });
  const adapter = new HolderChainAdapter({
    reader,
    tracker,
    requiredBalance: opts?.requiredBalance ?? 100,
    cacheTtlMs: opts?.cacheTtlMs ?? 30_000,
    estimator: opts?.estimator,
    logger: silentLogger,
    now: clock.now,
  });
  return { adapter, reader, tracker, clock };
}

// =============================================================================
// getHolderBalance: cache behavior
// =============================================================================

describe('HolderChainAdapter.getHolderBalance: cache', () => {
  it('returns the reader value on first call', async () => {
    const { adapter, reader } = makeAdapter({ balances: new Map([[ALICE, 250]]) });
    const v = await adapter.getHolderBalance(ALICE);
    expect(v).toBe(250);
    expect(reader.calls).toEqual([ALICE]);
  });

  it('returns the cached value within TTL without hitting the reader', async () => {
    const { adapter, reader, clock } = makeAdapter({ balances: new Map([[ALICE, 250]]) });
    await adapter.getHolderBalance(ALICE);
    clock.advance(29_999); // just under TTL
    const v = await adapter.getHolderBalance(ALICE);
    expect(v).toBe(250);
    expect(reader.calls.length).toBe(1);
  });

  it('hits the reader again after TTL expires', async () => {
    const { adapter, reader, clock } = makeAdapter({ balances: new Map([[ALICE, 250]]) });
    await adapter.getHolderBalance(ALICE);
    clock.advance(30_001); // just past TTL
    await adapter.getHolderBalance(ALICE);
    expect(reader.calls.length).toBe(2);
  });

  it('different wallets are cached independently', async () => {
    const { adapter, reader } = makeAdapter({
      balances: new Map([
        [ALICE, 100],
        [BOB, 200],
      ]),
    });
    expect(await adapter.getHolderBalance(ALICE)).toBe(100);
    expect(await adapter.getHolderBalance(BOB)).toBe(200);
    expect(await adapter.getHolderBalance(ALICE)).toBe(100); // cached
    expect(await adapter.getHolderBalance(BOB)).toBe(200); // cached
    expect(reader.calls.length).toBe(2);
  });

  it('cacheTtlMs=0 disables caching entirely', async () => {
    const { adapter, reader } = makeAdapter({
      balances: new Map([[ALICE, 250]]),
      cacheTtlMs: 0,
    });
    await adapter.getHolderBalance(ALICE);
    await adapter.getHolderBalance(ALICE);
    await adapter.getHolderBalance(ALICE);
    expect(reader.calls.length).toBe(3);
    expect(adapter.cacheSize()).toBe(0);
  });

  it('reader errors propagate up (no silent fallback to stale cache)', async () => {
    const { adapter, reader, clock } = makeAdapter({
      balances: new Map<string, number | Error>([[ALICE, 250]]),
    });
    await adapter.getHolderBalance(ALICE); // populate cache
    clock.advance(30_001); // expire
    reader.balances.set(ALICE, new Error('rpc 500'));
    await expect(adapter.getHolderBalance(ALICE)).rejects.toThrow(/rpc 500/);
  });

  it('failed reads are NOT cached', async () => {
    const { adapter, reader } = makeAdapter({
      balances: new Map<string, number | Error>([[ALICE, new Error('rpc 500')]]),
    });
    await expect(adapter.getHolderBalance(ALICE)).rejects.toThrow();
    await expect(adapter.getHolderBalance(ALICE)).rejects.toThrow();
    expect(reader.calls.length).toBe(2);
    expect(adapter.cacheSize()).toBe(0);
  });

  it('invalidateCache(wallet) drops only that wallet', async () => {
    const { adapter, reader } = makeAdapter({
      balances: new Map([
        [ALICE, 100],
        [BOB, 200],
      ]),
    });
    await adapter.getHolderBalance(ALICE);
    await adapter.getHolderBalance(BOB);
    adapter.invalidateCache(ALICE);
    await adapter.getHolderBalance(ALICE);
    await adapter.getHolderBalance(BOB);
    expect(reader.calls).toEqual([ALICE, BOB, ALICE]); // BOB still cached
  });

  it('clearCache() drops every wallet', async () => {
    const { adapter } = makeAdapter({
      balances: new Map([
        [ALICE, 100],
        [BOB, 200],
      ]),
    });
    await adapter.getHolderBalance(ALICE);
    await adapter.getHolderBalance(BOB);
    expect(adapter.cacheSize()).toBe(2);
    adapter.clearCache();
    expect(adapter.cacheSize()).toBe(0);
  });
});

// =============================================================================
// verifyHolderQualified: eligibility flow
// =============================================================================

describe('HolderChainAdapter.verifyHolderQualified', () => {
  it('returns false on first observation (flash-loan guard active)', async () => {
    const { adapter } = makeAdapter({ balances: new Map([[ALICE, 250]]) });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
  });

  it('returns false when balance is below required', async () => {
    const { adapter } = makeAdapter({
      balances: new Map([[ALICE, 50]]),
      requiredBalance: 100,
    });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
  });

  it('returns true once the time gate passes', async () => {
    const { adapter, clock } = makeAdapter({
      balances: new Map([[ALICE, 250]]),
      minHoldMs: 600_000,
      minConsecutiveObservations: 50,
      cacheTtlMs: 0, // ensure each call hits the reader
    });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
    clock.advance(600_001);
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(true);
  });

  it('returns true once the consecutive gate passes', async () => {
    const { adapter } = makeAdapter({
      balances: new Map([[ALICE, 250]]),
      minHoldMs: 1_000_000_000,
      minConsecutiveObservations: 3,
      cacheTtlMs: 0,
    });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(true);
  });

  it('returns false when balance drops below threshold (resets tracking)', async () => {
    const balances = new Map<string, number | Error>([[ALICE, 250]]);
    const { adapter, clock, tracker } = makeAdapter({
      balances,
      minHoldMs: 600_000,
      minConsecutiveObservations: 5,
      cacheTtlMs: 0,
    });
    // Build up history via 5 consecutive observations.
    await adapter.verifyHolderQualified(ALICE);
    await adapter.verifyHolderQualified(ALICE);
    await adapter.verifyHolderQualified(ALICE);
    await adapter.verifyHolderQualified(ALICE);
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(true);

    // Drop balance below threshold.
    balances.set(ALICE, 50);
    clock.advance(1);
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
    expect(tracker.getHistory(ALICE)).toBeUndefined();

    // Restore — back to first-observation state.
    balances.set(ALICE, 250);
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
  });

  it('uses the cached balance if within TTL (no extra reader call per verify)', async () => {
    const { adapter, reader, clock } = makeAdapter({
      balances: new Map([[ALICE, 250]]),
      minHoldMs: 1_000,
      minConsecutiveObservations: 50,
    });
    await adapter.verifyHolderQualified(ALICE);
    clock.advance(2_000); // past time gate, but within cache TTL
    await adapter.verifyHolderQualified(ALICE);
    expect(reader.calls.length).toBe(1);
  });
});

// =============================================================================
// verifyHolderQualified: pre-warm integration
// =============================================================================

describe('HolderChainAdapter.verifyHolderQualified: pre-warm', () => {
  it('passes the time gate on first verify when the estimator returns a long-ago hold-start', async () => {
    // The whole point of pre-warming: a wallet that has held for
    // weeks on chain qualifies on the FIRST click instead of paying
    // the full minHoldMs wait in the gateway's RAM.
    const clock = new FakeClock();
    const oneHourAgo = clock.ms - 60 * 60_000;
    const reader = new FakeReader(new Map([[ALICE, 1000]]));
    const tracker = new HolderTracker({
      minHoldMs: 600_000,
      minConsecutiveObservations: 50,
      logger: silentLogger,
      now: clock.now,
    });
    const estimator = new FakeEstimator(new Map([[ALICE, oneHourAgo]]));
    const adapter = new HolderChainAdapter({
      reader,
      tracker,
      requiredBalance: 100,
      estimator,
      logger: silentLogger,
      now: clock.now,
    });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(true);
    expect(estimator.calls.length).toBe(1);
    expect(estimator.calls[0]?.wallet).toBe(ALICE);
  });

  it('falls through to the standard first-observation flow when the estimator returns null', async () => {
    const estimator = new FakeEstimator(new Map([[ALICE, null]]));
    const { adapter } = makeAdapter({
      balances: new Map([[ALICE, 1000]]),
      requiredBalance: 100,
      estimator,
    });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
    expect(estimator.calls.length).toBe(1);
  });

  it('does not call the estimator when balance is below threshold', async () => {
    const estimator = new FakeEstimator(new Map());
    const { adapter } = makeAdapter({
      balances: new Map([[ALICE, 50]]),
      requiredBalance: 100,
      estimator,
    });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
    expect(estimator.calls.length).toBe(0);
  });

  it('does not call the estimator on subsequent verifies (history already exists)', async () => {
    const clock = new FakeClock();
    const oneHourAgo = clock.ms - 60 * 60_000;
    const reader = new FakeReader(new Map([[ALICE, 1000]]));
    const tracker = new HolderTracker({
      minHoldMs: 600_000,
      logger: silentLogger,
      now: clock.now,
    });
    const estimator = new FakeEstimator(new Map([[ALICE, oneHourAgo]]));
    const adapter = new HolderChainAdapter({
      reader,
      tracker,
      requiredBalance: 100,
      estimator,
      cacheTtlMs: 0,
      logger: silentLogger,
      now: clock.now,
    });
    await adapter.verifyHolderQualified(ALICE);
    await adapter.verifyHolderQualified(ALICE);
    await adapter.verifyHolderQualified(ALICE);
    expect(estimator.calls.length).toBe(1);
  });

  it('continues normally when the estimator throws (best-effort)', async () => {
    const estimator = new FakeEstimator(
      new Map<string, number | null | Error>([[ALICE, new Error('helius 500')]]),
    );
    const { adapter } = makeAdapter({
      balances: new Map([[ALICE, 1000]]),
      requiredBalance: 100,
      estimator,
    });
    // Estimator throws, but the adapter swallows so the verify
    // still produces a verdict (just the standard first-obs deny).
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
    expect(estimator.calls.length).toBe(1);
  });

  it('still resets tracking on a threshold dip after pre-warm', async () => {
    // Pre-warm establishes a long hold history, but a subsequent
    // dip below threshold MUST clear the seeded record. Otherwise
    // a hostile sequence (transfer in → pre-warm → transfer out →
    // transfer in again) would let an attacker keep the seeded
    // hold-start stuck in the past.
    const clock = new FakeClock();
    const balances = new Map<string, number | Error>([[ALICE, 1000]]);
    const reader = new FakeReader(balances);
    const tracker = new HolderTracker({
      minHoldMs: 600_000,
      logger: silentLogger,
      now: clock.now,
    });
    const estimator = new FakeEstimator(new Map([[ALICE, clock.ms - 60 * 60_000]]));
    const adapter = new HolderChainAdapter({
      reader,
      tracker,
      requiredBalance: 100,
      estimator,
      cacheTtlMs: 0,
      logger: silentLogger,
      now: clock.now,
    });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(true); // pre-warmed
    balances.set(ALICE, 50); // dip
    clock.advance(1);
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
    expect(tracker.getHistory(ALICE)).toBeUndefined();
    balances.set(ALICE, 1000); // restored
    clock.advance(1);
    // Pre-warm fires AGAIN because there's no history. With the
    // same seeded answer the wallet immediately re-qualifies. The
    // attacker doesn't gain anything: the on-chain history they
    // can't fabricate is the source of truth.
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(true);
    expect(estimator.calls.length).toBe(2);
  });

  it('omitting the estimator preserves BG-style first-observation behaviour', async () => {
    const { adapter } = makeAdapter({
      balances: new Map([[ALICE, 1000]]),
      requiredBalance: 100,
      // No estimator passed.
    });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
  });
});

// =============================================================================
// verifyHolderQualified: dynamic (pegged) threshold provider
// =============================================================================

describe('HolderChainAdapter.verifyHolderQualified: requiredBalanceProvider', () => {
  function makePeggedAdapter(provider: () => number, opts?: { balance?: number; floor?: number }) {
    const clock = new FakeClock();
    const reader = new FakeReader(new Map([[ALICE, opts?.balance ?? 1_000_000]]));
    const tracker = new HolderTracker({
      minHoldMs: 0,
      minConsecutiveObservations: 1,
      logger: silentLogger,
      now: clock.now,
    });
    const adapter = new HolderChainAdapter({
      reader,
      tracker,
      requiredBalance: opts?.floor ?? 100,
      requiredBalanceProvider: provider,
      cacheTtlMs: 0,
      logger: silentLogger,
      now: clock.now,
    });
    return { adapter, clock };
  }

  it('uses the provider value over the static floor when it is positive', async () => {
    // Balance 1.0M; pegged requirement 1.25M ⇒ below threshold ⇒ ineligible,
    // even though it is far above the static floor of 100.
    const { adapter } = makePeggedAdapter(() => 1_250_000, { balance: 1_000_000, floor: 100 });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
  });

  it('qualifies when the balance clears the live pegged requirement', async () => {
    const { adapter } = makePeggedAdapter(() => 1_250_000, { balance: 2_000_000, floor: 100 });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(true);
  });

  it('falls back to the static floor when the provider returns 0 (oracle cold)', async () => {
    // Provider yields 0 (no live quote) ⇒ the 100-token floor applies, so a
    // 1.0M balance qualifies.
    const { adapter } = makePeggedAdapter(() => 0, { balance: 1_000_000, floor: 100 });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(true);
  });

  it('falls back to the static floor when the provider returns a non-finite value', async () => {
    const { adapter } = makePeggedAdapter(() => Number.NaN, { balance: 50, floor: 100 });
    // Floor 100 applies; balance 50 < 100 ⇒ ineligible.
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false);
  });

  it('tracks a moving peg between verifies (token count scales with price)', async () => {
    let required = 2_000_000; // expensive while $ASTROID is cheap
    const clock = new FakeClock();
    const reader = new FakeReader(new Map([[ALICE, 1_500_000]]));
    const tracker = new HolderTracker({
      minHoldMs: 0,
      minConsecutiveObservations: 1,
      logger: silentLogger,
      now: clock.now,
    });
    const adapter = new HolderChainAdapter({
      reader,
      tracker,
      requiredBalance: 100,
      requiredBalanceProvider: () => required,
      cacheTtlMs: 0,
      logger: silentLogger,
      now: clock.now,
    });
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(false); // 1.5M < 2.0M
    required = 1_000_000; // price/MC rose ⇒ fewer tokens needed
    clock.advance(1);
    expect((await adapter.verifyHolderQualified(ALICE)).qualified).toBe(true); // 1.5M ≥ 1.0M
  });
});

// =============================================================================
// verifyHolderQualified: structured result (remainingHoldMs for the countdown)
// =============================================================================

describe('HolderChainAdapter.verifyHolderQualified: result shape', () => {
  it('reports remainingHoldMs while inside the hold window (flash_loan_guard)', async () => {
    const { adapter } = makeAdapter({
      balances: new Map([[ALICE, 250]]),
      requiredBalance: 100,
      minHoldMs: 600_000,
      minConsecutiveObservations: 50,
    });
    const r = await adapter.verifyHolderQualified(ALICE);
    expect(r.qualified).toBe(false);
    expect(r.reason).toBe('flash_loan_guard');
    expect(r.remainingHoldMs).toBe(600_000); // full window on first observation
  });

  it('reports 0 remaining and no reason once qualified', async () => {
    const { adapter, clock } = makeAdapter({
      balances: new Map([[ALICE, 250]]),
      requiredBalance: 100,
      minHoldMs: 600_000,
      minConsecutiveObservations: 50,
      cacheTtlMs: 0,
    });
    await adapter.verifyHolderQualified(ALICE);
    clock.advance(600_001);
    const r = await adapter.verifyHolderQualified(ALICE);
    expect(r.qualified).toBe(true);
    expect(r.remainingHoldMs).toBe(0);
    expect(r.reason).toBeUndefined();
  });

  it('does not surface a countdown for a below-threshold wallet', async () => {
    const { adapter } = makeAdapter({
      balances: new Map([[ALICE, 50]]),
      requiredBalance: 100,
    });
    const r = await adapter.verifyHolderQualified(ALICE);
    expect(r.qualified).toBe(false);
    expect(r.reason).toBe('below_threshold');
    expect(r.remainingHoldMs).toBe(0); // buy more, not wait
  });
});

// =============================================================================
// Configuration validation
// =============================================================================

describe('HolderChainAdapter constructor validation', () => {
  it('throws on negative requiredBalance', () => {
    const reader = new FakeReader(new Map());
    const tracker = new HolderTracker({ logger: silentLogger });
    expect(
      () =>
        new HolderChainAdapter({
          reader,
          tracker,
          requiredBalance: -1,
          logger: silentLogger,
        }),
    ).toThrow(/requiredBalance/);
  });

  it('throws on Infinity requiredBalance', () => {
    const reader = new FakeReader(new Map());
    const tracker = new HolderTracker({ logger: silentLogger });
    expect(
      () =>
        new HolderChainAdapter({
          reader,
          tracker,
          requiredBalance: Number.POSITIVE_INFINITY,
          logger: silentLogger,
        }),
    ).toThrow(/requiredBalance/);
  });

  it('throws on negative cacheTtlMs', () => {
    const reader = new FakeReader(new Map());
    const tracker = new HolderTracker({ logger: silentLogger });
    expect(
      () =>
        new HolderChainAdapter({
          reader,
          tracker,
          requiredBalance: 100,
          cacheTtlMs: -1,
          logger: silentLogger,
        }),
    ).toThrow(/cacheTtlMs/);
  });
});

// =============================================================================
// SolanaBalanceReader: smoke (no real network)
// =============================================================================

describe('SolanaBalanceReader', () => {
  it('constructs without error given a valid mint and rpc URL', () => {
    expect(
      () =>
        new SolanaBalanceReader({
          rpcUrl: 'https://api.devnet.solana.com',
          mintAddress: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          decimals: 9,
        }),
    ).not.toThrow();
  });

  it('reads via Helius when API key is set (uses injected fetch)', async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tokens: [
              {
                mint: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                amount: 1_500_000_000, // 1.5 with 9 decimals
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const reader = new SolanaBalanceReader({
      rpcUrl: 'https://api.devnet.solana.com',
      mintAddress: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      decimals: 9,
      heliusApiKey: 'fake-key',
      isDevnet: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      logger: silentLogger,
    });
    const balance = await reader.getTokenBalance(ALICE);
    expect(balance).toBe(1.5);
    expect(fakeFetch).toHaveBeenCalledOnce();
    expect(fakeFetch).toHaveBeenCalledWith(expect.stringContaining('api-devnet.helius.xyz'));
    expect(fakeFetch).toHaveBeenCalledWith(expect.stringContaining(ALICE));
  });

  it('Helius returns 0 when the wallet does not hold the mint', async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ tokens: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const reader = new SolanaBalanceReader({
      rpcUrl: 'https://api.devnet.solana.com',
      mintAddress: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      heliusApiKey: 'fake-key',
      isDevnet: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      logger: silentLogger,
    });
    expect(await reader.getTokenBalance(ALICE)).toBe(0);
  });

  it('Helius prefers per-token decimals from the response over the configured fallback', async () => {
    // Regression: pump.fun mints use 6 decimals but operators frequently
    // ship `.env.local` with the conventional 9. The reader must trust
    // the on-chain decimals reported by Helius rather than silently
    // dividing by 10^9 and gating legitimate holders out.
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tokens: [
              {
                mint: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                amount: 1_728_530_219_250, // 1,728,530.21925 at 6 decimals
                decimals: 6,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const reader = new SolanaBalanceReader({
      rpcUrl: 'https://api.devnet.solana.com',
      mintAddress: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      decimals: 9, // Deliberate mismatch: env says 9, mint really is 6.
      heliusApiKey: 'fake-key',
      isDevnet: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      logger: silentLogger,
    });
    const balance = await reader.getTokenBalance(ALICE);
    expect(balance).toBeCloseTo(1_728_530.21925, 5);
  });

  it('Helius falls back to configured decimals when response omits decimals', async () => {
    // Defense: if a future Helius response shape drops the `decimals`
    // field, we still need a number — fall back to the env value rather
    // than NaN'ing out.
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tokens: [
              {
                mint: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                amount: 2_500_000_000, // 2.5 at 9 decimals (env fallback)
                // decimals intentionally omitted
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const reader = new SolanaBalanceReader({
      rpcUrl: 'https://api.devnet.solana.com',
      mintAddress: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      decimals: 9,
      heliusApiKey: 'fake-key',
      isDevnet: true,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      logger: silentLogger,
    });
    expect(await reader.getTokenBalance(ALICE)).toBe(2.5);
  });
});
