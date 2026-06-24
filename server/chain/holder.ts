/**
 * Holder chain adapter — reads $ASTROID balances from Solana and
 * feeds them into the in-memory `HolderTracker` for eligibility
 * decisions.
 *
 * Read-only: this module never sends transactions, never moves
 * funds, never signs anything. The only chain interaction is
 * `getParsedTokenAccountsByOwner` (or Helius DAS REST). The
 * `ChainOps` facade still gates these reads behind
 * `CHAIN_ENABLED=true`; this module is only constructed by
 * `server/index.ts` when chain is on.
 *
 * Layered design:
 *
 * - `BalanceReader` (interface) — the only thing the adapter
 *   knows how to call. Pure async function. Easy to fake in tests.
 * - `SolanaBalanceReader` (impl) — production reader. Uses Helius
 *   DAS REST when `HELIUS_API_KEY` is present (faster, indexed),
 *   falls back to standard JSON-RPC `getParsedTokenAccountsByOwner`
 *   otherwise. The only file that imports `@solana/web3.js`.
 * - `HolderChainAdapter` — wires a `BalanceReader` and a
 *   `HolderTracker` together, adds a small read-through cache
 *   (30s default, matches BG's `CACHE_DURATION_MS`), and exposes
 *   the two `ChainOps.impls` callbacks (`getHolderBalance`,
 *   `verifyHolderQualified`).
 *
 * Cache invariant: the cache only stores SUCCESSFUL reads. Errors
 * propagate to the caller, who logs and returns the disabled
 * sentinel. We never silently fall back to a stale cached value
 * — that lets attackers extend the validity window of a stale
 * balance simply by causing transient RPC errors. BG did fall
 * back; we don't.
 */

import { Connection, PublicKey } from '@solana/web3.js';

import type { GameLogger } from '../game/interfaces.js';
import type { HolderTracker } from '../verification/holder-tracker.js';

import type { HoldStartEstimator } from './prewarm.js';

// ---------------------------------------------------------------------------
// BalanceReader interface
// ---------------------------------------------------------------------------

/**
 * Reads the $ASTROID balance for a wallet. Implementations may use
 * Helius DAS, raw RPC, or any other backend. Returns the balance
 * in human-readable token units (NOT raw amount).
 */
export interface BalanceReader {
  /**
   * @returns balance in token units (e.g. `1.5` for 1.5 $ASTROID).
   * @throws on RPC errors. The adapter never swallows errors.
   */
  getTokenBalance(walletAddress: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// SolanaBalanceReader: production impl
// ---------------------------------------------------------------------------

export interface SolanaBalanceReaderConfig {
  /** Solana JSON-RPC endpoint (mainnet, devnet, or local). */
  rpcUrl: string;
  /** $ASTROID SPL mint address. */
  mintAddress: string;
  /** Mint decimals (default 9). */
  decimals?: number;
  /** Optional Helius API key — when set, DAS endpoint is preferred. */
  heliusApiKey?: string;
  /** Whether the rpcUrl is devnet (selects Helius API base). */
  isDevnet?: boolean;
  /**
   * Optional fetch override. Defaults to global `fetch`. Tests
   * supply a stub to avoid real network calls.
   */
  fetchImpl?: typeof fetch;
  logger?: GameLogger;
}

export class SolanaBalanceReader implements BalanceReader {
  private readonly mintAddress: string;
  private readonly mintPubkey: PublicKey;
  private readonly decimals: number;
  private readonly heliusApiKey: string | undefined;
  private readonly isDevnet: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly connection: Connection;
  private readonly log: GameLogger;

  constructor(config: SolanaBalanceReaderConfig) {
    this.mintAddress = config.mintAddress;
    this.mintPubkey = new PublicKey(config.mintAddress);
    this.decimals = config.decimals ?? 9;
    this.heliusApiKey = config.heliusApiKey;
    this.isDevnet = config.isDevnet ?? config.rpcUrl.includes('devnet');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    this.log = config.logger ?? silentLogger();
  }

  async getTokenBalance(walletAddress: string): Promise<number> {
    if (this.heliusApiKey) {
      try {
        return await this.readViaHelius(walletAddress);
      } catch (err) {
        this.log.warn(
          `[HolderChain] Helius read failed for ${walletAddress.slice(0, 8)}..., ` +
            `falling back to RPC: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return this.readViaRpc(walletAddress);
  }

  private async readViaHelius(walletAddress: string): Promise<number> {
    const base = this.isDevnet ? 'https://api-devnet.helius.xyz' : 'https://api.helius.xyz';
    const url = `${base}/v0/addresses/${walletAddress}/balances?api-key=${this.heliusApiKey}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Helius API error: ${response.status}`);
    }
    const data = (await response.json()) as {
      tokens?: Array<{ mint: string; amount: number; decimals?: number }>;
    };
    const tokenBalance = data.tokens?.find(
      (t) => t.mint.toLowerCase() === this.mintAddress.toLowerCase(),
    );
    if (!tokenBalance) return 0;
    // Trust Helius's per-token `decimals` over our configured value. The
    // env's `ASTROID_DECIMALS` is a fallback for the JSON-RPC path
    // (where the parsed account already gives us a `uiAmount`, see
    // `readViaRpc`) and for any future Helius response that omits the
    // field. Mismatches between configured and on-chain decimals are
    // a common foot-gun (pump.fun mints are 6 decimals; many config
    // examples assume 9), and silently scaling balances by the wrong
    // power of ten is the kind of bug that fails *quietly* by gating
    // legitimate holders out.
    const decimals =
      typeof tokenBalance.decimals === 'number' ? tokenBalance.decimals : this.decimals;
    return tokenBalance.amount / Math.pow(10, decimals);
  }

  private async readViaRpc(walletAddress: string): Promise<number> {
    const walletPubkey = new PublicKey(walletAddress);
    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(walletPubkey, {
      mint: this.mintPubkey,
    });
    if (tokenAccounts.value.length === 0) return 0;
    let total = 0;
    for (const acc of tokenAccounts.value) {
      const ui = acc.account.data.parsed.info.tokenAmount.uiAmount as number | null;
      if (typeof ui === 'number') total += ui;
    }
    return total;
  }
}

// ---------------------------------------------------------------------------
// HolderChainAdapter
// ---------------------------------------------------------------------------

export interface HolderChainAdapterConfig {
  /** RPC reader (production: SolanaBalanceReader). */
  reader: BalanceReader;
  /** Pure in-memory eligibility tracker. */
  tracker: HolderTracker;
  /** Required balance threshold (production: runtime.holderMinBalance). */
  requiredBalance: number;
  /**
   * Successful reads are cached for this many ms. Zero disables
   * caching. Default 30_000 (matches BG `CACHE_DURATION_MS`).
   */
  cacheTtlMs?: number;
  /**
   * Optional on-chain hold-start estimator (`server/chain/prewarm.ts`).
   * When provided, the first verify for a previously-untracked
   * wallet calls the estimator and seeds the tracker with the
   * inferred hold-start timestamp. This lets long-time holders
   * pass the time gate immediately without waiting the full
   * `minHoldMs` window. Omit (or pass `undefined`) to disable
   * pre-warming entirely.
   */
  estimator?: HoldStartEstimator;
  logger?: GameLogger;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface CacheEntry {
  balance: number;
  expiresAt: number;
}

export class HolderChainAdapter {
  private readonly reader: BalanceReader;
  private readonly tracker: HolderTracker;
  private readonly requiredBalance: number;
  private readonly cacheTtlMs: number;
  private readonly estimator: HoldStartEstimator | undefined;
  private readonly now: () => number;
  private readonly log: GameLogger;
  private readonly cache: Map<string, CacheEntry> = new Map();

  constructor(config: HolderChainAdapterConfig) {
    this.reader = config.reader;
    this.tracker = config.tracker;
    this.requiredBalance = config.requiredBalance;
    this.cacheTtlMs = config.cacheTtlMs ?? 30_000;
    this.estimator = config.estimator;
    this.now = config.now ?? (() => Date.now());
    this.log = config.logger ?? silentLogger();

    if (this.requiredBalance < 0 || !Number.isFinite(this.requiredBalance)) {
      throw new Error(
        `HolderChainAdapter: requiredBalance must be finite >= 0 (got ${this.requiredBalance})`,
      );
    }
    if (this.cacheTtlMs < 0) {
      throw new Error(`HolderChainAdapter: cacheTtlMs must be >= 0 (got ${this.cacheTtlMs})`);
    }
  }

  /**
   * Read the $ASTROID balance for a wallet, with read-through
   * caching. Errors from the reader propagate up.
   */
  async getHolderBalance(walletAddress: string): Promise<number> {
    const now = this.now();
    if (this.cacheTtlMs > 0) {
      const cached = this.cache.get(walletAddress);
      if (cached && cached.expiresAt > now) {
        return cached.balance;
      }
    }
    const balance = await this.reader.getTokenBalance(walletAddress);
    if (this.cacheTtlMs > 0) {
      this.cache.set(walletAddress, { balance, expiresAt: now + this.cacheTtlMs });
    }
    return balance;
  }

  /**
   * Read the wallet's balance and compute eligibility via the
   * tracker. The tracker observes the balance — including drops
   * below the threshold, which reset its history.
   *
   * Pre-warm path: when this is the first time the gateway has
   * seen this wallet AND the wallet currently meets the balance
   * threshold AND an `estimator` is wired, the adapter asks the
   * estimator for an on-chain hold-start timestamp (Helius
   * transaction-history walk) and seeds the tracker with it. The
   * subsequent `recordObservation` call therefore measures hold
   * duration against the seeded timestamp rather than `now`,
   * which lets long-time holders pass the time gate on the very
   * first verify. Estimator failures are logged at warn and the
   * adapter falls through to the normal first-observation flow.
   */
  async verifyHolderQualified(walletAddress: string): Promise<boolean> {
    const balance = await this.getHolderBalance(walletAddress);

    // Pre-warm only fires when (a) we have an estimator, (b) the
    // wallet meets the balance threshold (the estimator has nothing
    // to do otherwise), and (c) we have no existing tracking record
    // — i.e. this is genuinely a first observation. The
    // `seedHoldStart` call inside the tracker is itself idempotent
    // against existing history, but checking here avoids an
    // unnecessary RPC round trip.
    if (
      this.estimator !== undefined &&
      balance >= this.requiredBalance &&
      this.tracker.getHistory(walletAddress) === undefined
    ) {
      try {
        const holdStartMs = await this.estimator.estimateHoldStartMs(
          walletAddress,
          balance,
          this.requiredBalance,
        );
        if (holdStartMs !== null) {
          this.tracker.seedHoldStart(walletAddress, holdStartMs, balance);
        }
      } catch (err) {
        // Pre-warm is best-effort; on failure we fall through to
        // the standard first-observation flow (which simply costs
        // the user the full `minHoldMs` wait).
        this.log.warn(
          `[HolderChain] pre-warm failed for ${walletAddress.slice(0, 8)}...: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    const decision = this.tracker.recordObservation(walletAddress, balance, this.requiredBalance);
    if (!decision.eligible) {
      this.log.info(
        `[HolderChain] ${walletAddress.slice(0, 8)}... not eligible: ${decision.reason} ` +
          `(balance=${balance} required=${this.requiredBalance})`,
      );
    }
    return decision.eligible;
  }

  /** Drop the cached balance for a single wallet. */
  invalidateCache(walletAddress: string): void {
    this.cache.delete(walletAddress);
  }

  /** Drop every cached balance. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Diagnostics: current cache size. */
  cacheSize(): number {
    return this.cache.size;
  }
}

function silentLogger(): GameLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}
