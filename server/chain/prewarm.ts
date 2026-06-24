/**
 * On-chain hold-time pre-warmer for the holder gate.
 *
 * Problem this solves:
 * - The in-memory `HolderTracker` measures hold time as
 *   "milliseconds since the gateway first saw this wallet at
 *   threshold". That metric is sound from a flash-loan-defense
 *   standpoint but unfair to legitimate long-time holders: a
 *   wallet that has held tokens for 30 days on chain still has
 *   to wait the full `minHoldMs` window the first time the
 *   gateway sees it (e.g. after a redeploy). To them it looks
 *   like an arbitrary cooldown.
 * - Drawing the timestamp directly from chain ("first acquired"
 *   timestamp) is *not* flash-loan safe: a hostile actor can
 *   borrow tokens, hold for a day, return, then borrow again and
 *   pretend they've held for a day continuously. We must verify
 *   *continuous* holdings, not just "was once held".
 *
 * Design:
 * - On first observation of a wallet that meets the balance
 *   threshold, walk the most recent N transfers involving the
 *   wallet and the $ASTROID mint, newest-first.
 * - Reverse-simulate balance from the current value: undo each
 *   inbound transfer (subtract from balance), undo each outbound
 *   transfer (add back to balance). After undoing transfer T, the
 *   reconstructed balance is the wallet's balance immediately
 *   before T executed.
 * - The first time that reconstructed balance falls below the
 *   threshold, the transfer that brought them above threshold (T
 *   itself, since we just undid it) is the moment continuous
 *   holding started. Return its block time.
 * - If we walk the entire window without finding a dip, the
 *   wallet has been continuously above threshold for at least
 *   that long; return the oldest fetched transaction's timestamp
 *   as a conservative lower bound. Operators tune `maxLookback`
 *   to trade RPC budget against reach.
 * - On any error or empty history, return `null` and let the
 *   caller fall through to the default first-observation flow.
 *
 * Read-only and gated:
 * - Constructed only when `CHAIN_ENABLED=true`,
 *   `HOLDER_PREWARM_ENABLED=true`, and `HELIUS_API_KEY` is set.
 *   Without Helius enriched-transaction support, the JSON-RPC
 *   path doesn't have ergonomic per-mint transfer history, so we
 *   simply don't pre-warm.
 * - Pure RPC; never sends transactions, never touches funds.
 *
 * Caching:
 * - Pre-warm runs once per wallet under normal flow (the next
 *   `getHistory` returns truthy and the adapter skips re-running
 *   it). The 5-minute estimator cache is defense-in-depth for
 *   pathological retry storms.
 */

import type { GameLogger } from '../game/interfaces.js';

// ---------------------------------------------------------------------------
// Public interface (so the adapter can be tested with fakes)
// ---------------------------------------------------------------------------

/**
 * Estimates the wall-clock millisecond timestamp at which the wallet
 * last crossed above `requiredBalance` and has been continuously
 * above ever since (over the lookback window). Returns `null` when
 * the estimator cannot make a confident determination — caller
 * treats `null` as "no pre-warm signal", not "ineligible".
 */
export interface HoldStartEstimator {
  estimateHoldStartMs(
    walletAddress: string,
    currentBalance: number,
    requiredBalance: number,
  ): Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Helius enriched-transaction types (subset we actually use)
// ---------------------------------------------------------------------------

interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  /** Human-readable amount (already divided by 10^decimals by Helius). */
  tokenAmount?: number;
  mint?: string;
}

interface HeliusEnrichedTransaction {
  signature?: string;
  /** Unix seconds (NOT milliseconds). */
  timestamp?: number;
  tokenTransfers?: HeliusTokenTransfer[];
}

// ---------------------------------------------------------------------------
// OnChainHoldEstimator
// ---------------------------------------------------------------------------

export interface OnChainHoldEstimatorConfig {
  /** $ASTROID SPL mint address. */
  mintAddress: string;
  /** Helius API key (required — JSON-RPC path is not supported). */
  heliusApiKey: string;
  /** When true, hits the devnet Helius host. Defaults to false. */
  isDevnet?: boolean;
  /** fetch override for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  logger?: GameLogger;
  /**
   * Maximum number of transactions to walk back. Hard-capped at
   * the Helius per-page limit (100). Default 100. Operators tune
   * this knob to trade RPC budget against reach: a wallet whose
   * threshold-crossing transfer happened more than 100 transfers
   * ago will report the oldest fetched transfer's timestamp
   * (conservative undercount) instead of the true crossing.
   */
  maxLookback?: number;
  /** Result cache TTL in ms. Default 300_000 (5 minutes). */
  cacheTtlMs?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface CacheEntry {
  result: number | null;
  expiresAt: number;
}

export class OnChainHoldEstimator implements HoldStartEstimator {
  private readonly mintAddressLower: string;
  private readonly heliusApiKey: string;
  private readonly isDevnet: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly log: GameLogger;
  private readonly maxLookback: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache: Map<string, CacheEntry> = new Map();

  constructor(config: OnChainHoldEstimatorConfig) {
    if (!config.mintAddress) {
      throw new Error('OnChainHoldEstimator: mintAddress is required');
    }
    if (!config.heliusApiKey) {
      throw new Error('OnChainHoldEstimator: heliusApiKey is required');
    }
    this.mintAddressLower = config.mintAddress.toLowerCase();
    this.heliusApiKey = config.heliusApiKey;
    this.isDevnet = config.isDevnet ?? false;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.log = config.logger ?? silentLogger();
    // Helius caps per-page at 100; we don't paginate (yet) so clamp.
    const requested = config.maxLookback ?? 100;
    this.maxLookback = Math.max(1, Math.min(100, requested));
    this.cacheTtlMs = config.cacheTtlMs ?? 300_000;
    this.now = config.now ?? (() => Date.now());

    if (this.cacheTtlMs < 0) {
      throw new Error(`OnChainHoldEstimator: cacheTtlMs must be >= 0 (got ${this.cacheTtlMs})`);
    }
  }

  async estimateHoldStartMs(
    walletAddress: string,
    currentBalance: number,
    requiredBalance: number,
  ): Promise<number | null> {
    if (!Number.isFinite(currentBalance) || currentBalance < 0) {
      throw new Error(
        `OnChainHoldEstimator: currentBalance must be finite >= 0 (got ${currentBalance})`,
      );
    }
    if (!Number.isFinite(requiredBalance) || requiredBalance < 0) {
      throw new Error(
        `OnChainHoldEstimator: requiredBalance must be finite >= 0 (got ${requiredBalance})`,
      );
    }

    const now = this.now();

    // Read-through cache. We cache `null` results too — if a wallet's
    // history doesn't yield a signal once, hammering Helius for the
    // same answer 30 seconds later isn't useful.
    if (this.cacheTtlMs > 0) {
      const cached = this.cache.get(walletAddress);
      if (cached && cached.expiresAt > now) {
        return cached.result;
      }
    }

    // Defensive: caller should check this, but if we somehow get
    // here below threshold, no pre-warm signal exists.
    if (currentBalance < requiredBalance) {
      this.cacheResult(walletAddress, null, now);
      return null;
    }

    let txs: HeliusEnrichedTransaction[];
    try {
      txs = await this.fetchTransfers(walletAddress);
    } catch (err) {
      // Don't cache failures — let the caller try again on the next
      // verify (typically a few seconds later, after a retry).
      this.log.warn(
        `[OnChainHoldEstimator] Helius fetch failed for ${walletAddress.slice(0, 8)}...: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }

    if (txs.length === 0) {
      this.cacheResult(walletAddress, null, now);
      return null;
    }

    // Reverse-simulate balance, walking newest -> oldest. After
    // undoing transfer T, `balance` is the balance at the moment
    // immediately before T fired.
    let balance = currentBalance;
    let result: number | null = null;

    for (const tx of txs) {
      const xfers = (tx.tokenTransfers ?? []).filter(
        (t) => typeof t.mint === 'string' && t.mint.toLowerCase() === this.mintAddressLower,
      );
      if (xfers.length === 0) continue;

      for (const t of xfers) {
        if (typeof t.tokenAmount !== 'number' || !Number.isFinite(t.tokenAmount)) continue;
        // Helius reports the OWNER address in fromUserAccount /
        // toUserAccount (not the token-account address). Match
        // against the wallet directly.
        if (t.toUserAccount === walletAddress) {
          balance -= t.tokenAmount; // undo inbound
        } else if (t.fromUserAccount === walletAddress) {
          balance += t.tokenAmount; // undo outbound
        }
        // (If the wallet is neither sender nor recipient, the
        // transfer doesn't move its balance — skip silently.)
      }

      if (balance < requiredBalance) {
        // Before this transfer the wallet was below threshold, so
        // this transfer is the moment they crossed back above.
        // Use its timestamp as the hold-start.
        if (typeof tx.timestamp === 'number') {
          result = tx.timestamp * 1_000;
        }
        break;
      }
    }

    if (result === null) {
      // Walked the entire window without finding a sub-threshold
      // moment. Wallet has been continuously above threshold for at
      // least the lookback window — use the oldest fetched tx's
      // timestamp as a conservative undercount of true hold time.
      const oldest = txs[txs.length - 1];
      if (oldest && typeof oldest.timestamp === 'number') {
        result = oldest.timestamp * 1_000;
      }
    }

    this.cacheResult(walletAddress, result, now);
    return result;
  }

  /** Drop the cached estimate for a single wallet. */
  invalidateCache(walletAddress: string): void {
    this.cache.delete(walletAddress);
  }

  /** Drop every cached estimate. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Diagnostics: current cache size. */
  cacheSize(): number {
    return this.cache.size;
  }

  // -------- internals --------

  private async fetchTransfers(walletAddress: string): Promise<HeliusEnrichedTransaction[]> {
    const base = this.isDevnet ? 'https://api-devnet.helius.xyz' : 'https://api.helius.xyz';
    const url =
      `${base}/v0/addresses/${walletAddress}/transactions` +
      `?api-key=${this.heliusApiKey}&limit=${this.maxLookback}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Helius transactions API error: ${response.status}`);
    }
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return [];
    const txs = data as HeliusEnrichedTransaction[];
    // Helius returns newest-first by default but we don't trust the
    // order — defensive descending sort by timestamp.
    return [...txs]
      .filter((t): t is HeliusEnrichedTransaction => t !== null && typeof t === 'object')
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }

  private cacheResult(wallet: string, result: number | null, now: number): void {
    if (this.cacheTtlMs <= 0) return;
    this.cache.set(wallet, { result, expiresAt: now + this.cacheTtlMs });
  }
}

function silentLogger(): GameLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}
