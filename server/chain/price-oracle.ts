/**
 * Live $ASTROID/USD price feed.
 *
 * Polls the Jupiter Price API V3 (`https://api.jup.ag/price/v3?ids=<mint>`) on
 * an interval and pushes each fresh quote to a callback. The drill-power stake
 * tiers use this so their *USD* cost stays stable while the token price moves:
 * the token threshold for a tier is `usdTarget / livePrice` (see
 * `setAstroidUsdPrice` in `server/game/types.ts`).
 *
 * Keyless requests on `api.jup.ag` are rate-limited (~0.5 rps); our default
 * 5-minute cadence is far under that. Set `JUP_API_KEY` to use an API key and
 * unlock higher limits. On any failure the last good price is retained, so a
 * transient outage never collapses the tier ladder.
 */

const JUP_PRICE_URL = 'https://api.jup.ag/price/v3';

/** Wrapped-SOL mint, used to price the holder gate in SOL terms. */
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface PriceOracleLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface PriceOracleConfig {
  /** $ASTROID SPL mint address to price. */
  mint: string;
  /**
   * Optional second mint (e.g. wrapped SOL) to track alongside $ASTROID in the
   * same request. Powers SOL-denominated pegs like the holder gate. The primary
   * `mint` price still drives success/failure; this one is best-effort.
   */
  solMint?: string;
  /** Optional Jupiter API key (sent as `x-api-key`). */
  apiKey?: string;
  /** Poll cadence in ms. Default 5 min. Set 0 to disable the interval. */
  refreshMs?: number;
  /** Injectable fetch (defaults to global `fetch`); handy for tests. */
  fetchImpl?: typeof fetch;
  logger?: PriceOracleLogger;
  /** Called with each fresh, positive price. */
  onPrice?: (price: number) => void;
}

const DEFAULT_REFRESH_MS = 5 * 60_000;

export class PriceOracle {
  private price = 0;
  private solPrice = 0;
  private lastUpdatedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly mint: string;
  private readonly solMint: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly refreshMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: PriceOracleLogger;
  private readonly onPrice: ((price: number) => void) | undefined;

  constructor(config: PriceOracleConfig) {
    this.mint = config.mint;
    this.solMint = config.solMint;
    this.apiKey = config.apiKey;
    this.refreshMs = config.refreshMs ?? DEFAULT_REFRESH_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.log = config.logger ?? {};
    this.onPrice = config.onPrice;
  }

  /** Latest known $ASTROID/USD price (0 until the first successful fetch). */
  getPrice(): number {
    return this.price;
  }

  /**
   * Latest known SOL/USD price (0 until the first successful fetch). Only
   * tracked when `solMint` was configured; otherwise stays 0.
   */
  getSolPrice(): number {
    return this.solPrice;
  }

  /**
   * Epoch ms of the last successful $ASTROID quote (0 if none yet). Lets the
   * admin console show oracle freshness — a stale feed means the holder gate is
   * running on the last known peg.
   */
  getUpdatedAt(): number {
    return this.lastUpdatedAt;
  }

  /** Fetch once, then poll on the configured interval. */
  async start(): Promise<void> {
    await this.refreshOnce();
    if (this.refreshMs > 0 && !this.timer) {
      this.timer = setInterval(() => {
        void this.refreshOnce();
      }, this.refreshMs);
      // Don't keep the event loop alive purely for price polling.
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fetch a single quote. Returns the price, or null on failure. */
  async refreshOnce(): Promise<number | null> {
    try {
      const ids = [this.mint, this.solMint]
        .filter((id): id is string => !!id)
        .map(encodeURIComponent)
        .join(',');
      const url = `${JUP_PRICE_URL}?ids=${ids}`;
      const res = await this.fetchImpl(url, {
        headers: this.apiKey ? { 'x-api-key': this.apiKey } : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, { usdPrice?: number } | undefined>;
      // SOL price is best-effort and never gates success: a missing/zero SOL
      // quote keeps the last good value (and the holder gate falls back to its
      // static floor while SOL is unknown).
      if (this.solMint) {
        const solUsd = body?.[this.solMint]?.usdPrice;
        if (typeof solUsd === 'number' && Number.isFinite(solUsd) && solUsd > 0) {
          this.solPrice = solUsd;
        }
      }
      const usdPrice = body?.[this.mint]?.usdPrice;
      if (typeof usdPrice === 'number' && Number.isFinite(usdPrice) && usdPrice > 0) {
        this.price = usdPrice;
        this.lastUpdatedAt = Date.now();
        this.onPrice?.(usdPrice);
        this.log.info?.(`[price-oracle] $ASTROID = $${usdPrice} (Jupiter)`);
        return usdPrice;
      }
      throw new Error('no usable usdPrice in response');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn?.(
        `[price-oracle] refresh failed: ${message}; keeping last ($${this.price || 'unknown'}).`,
      );
      return null;
    }
  }
}
