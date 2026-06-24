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

export interface PriceOracleLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface PriceOracleConfig {
  /** $ASTROID SPL mint address to price. */
  mint: string;
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly mint: string;
  private readonly apiKey: string | undefined;
  private readonly refreshMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: PriceOracleLogger;
  private readonly onPrice: ((price: number) => void) | undefined;

  constructor(config: PriceOracleConfig) {
    this.mint = config.mint;
    this.apiKey = config.apiKey;
    this.refreshMs = config.refreshMs ?? DEFAULT_REFRESH_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.log = config.logger ?? {};
    this.onPrice = config.onPrice;
  }

  /** Latest known price (0 until the first successful fetch). */
  getPrice(): number {
    return this.price;
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
      const url = `${JUP_PRICE_URL}?ids=${encodeURIComponent(this.mint)}`;
      const res = await this.fetchImpl(url, {
        headers: this.apiKey ? { 'x-api-key': this.apiKey } : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, { usdPrice?: number } | undefined>;
      const usdPrice = body?.[this.mint]?.usdPrice;
      if (typeof usdPrice === 'number' && Number.isFinite(usdPrice) && usdPrice > 0) {
        this.price = usdPrice;
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
