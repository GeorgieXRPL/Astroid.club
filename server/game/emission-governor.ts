/**
 * Emission governor — keeps mining reward issuance from outrunning the
 * redeemable treasury backing as the userbase grows.
 *
 * Two independent throttles, combined multiplicatively-safe (we take the
 * stricter of the two):
 *
 *   1. **Backing taper.** Every credit issued is a redeemable claim against
 *      the treasury. We track the OUTSTANDING liability (lifetime earned −
 *      lifetime redeemed) and taper new yield to zero as that liability
 *      approaches `budget`. The taper is linear over the top `taperFraction`
 *      band, so issuance slows smoothly rather than slamming shut. Because
 *      the input is *outstanding* (not cumulative) liability, redemptions
 *      free headroom back up — the system recirculates instead of hitting a
 *      permanent ceiling.
 *
 *   2. **Rolling daily cap.** A hard ceiling on credits issued per rolling
 *      24h window, smoothing burst issuance regardless of headroom.
 *
 * Set `budget` or `dailyCap` to 0 to disable that throttle. With both 0 the
 * governor is a no-op (scale always 1), preserving legacy behaviour.
 *
 * The governor is intentionally dependency-free and synchronous so it can sit
 * on the hot discovery path and be unit-tested in isolation.
 */
export interface EmissionGovernorConfig {
  /**
   * Static max outstanding (unredeemed) credit liability before issuance fully
   * stops, in $ASTROID credit units. Size this to the treasury backing you
   * have funded. 0 disables the static backing taper. Acts as the FLOOR /
   * fallback when `getBudget` is supplied but hasn't produced a value yet.
   */
  budget: number;
  /**
   * Optional DYNAMIC budget accessor. When supplied and it returns a positive
   * value, it overrides the static `budget` on every evaluation — used to peg
   * the backing taper to the LIVE treasury balance (e.g. treasury $ASTROID ×
   * 0.8) so issuance automatically tracks payable reserves as the treasury
   * grows or is drawn down. Returns ≤ 0 → fall back to the static `budget`.
   */
  getBudget?: () => number;
  /**
   * Fraction of the (effective) budget over which yield tapers from full →
   * zero. e.g. 0.25 means full yield until liability reaches 75% of budget,
   * then linear down to 0 at 100%. Clamped to (0, 1]. Default 0.25.
   */
  taperFraction?: number;
  /**
   * Max credits issued per rolling 24h window. 0 disables the daily cap.
   */
  dailyCap?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EmissionStatus {
  /** Current scale factor applied to gross yield, in [0, 1]. */
  scale: number;
  /** Outstanding liability used for the most recent computation. */
  outstanding: number;
  /** Configured backing budget (0 = disabled). */
  budget: number;
  /** Remaining headroom before issuance stops (max(0, budget − outstanding)). */
  headroom: number;
  /** Credits issued in the trailing 24h window. */
  dailyIssued: number;
  /** Configured rolling daily cap (0 = disabled). */
  dailyCap: number;
}

export class EmissionGovernor {
  private readonly staticBudget: number;
  private readonly getBudget?: () => number;
  private readonly taperFraction: number;
  private readonly dailyCap: number;
  private readonly now: () => number;

  /** Rolling window of (timestamp, amount) issuance records for the daily cap. */
  private readonly window: Array<{ t: number; amount: number }> = [];
  private windowSum = 0;

  constructor(config: EmissionGovernorConfig) {
    this.staticBudget = Math.max(0, config.budget);
    this.getBudget = config.getBudget;
    const tf = config.taperFraction ?? 0.25;
    this.taperFraction = Math.min(1, Math.max(0.0001, tf));
    this.dailyCap = Math.max(0, config.dailyCap ?? 0);
    this.now = config.now ?? Date.now;
  }

  /**
   * Effective backing budget: the live dynamic value when wired and positive,
   * otherwise the static floor.
   */
  private budget(): number {
    if (this.getBudget) {
      const dynamic = this.getBudget();
      if (Number.isFinite(dynamic) && dynamic > 0) return dynamic;
    }
    return this.staticBudget;
  }

  /** True if either throttle is active. */
  get enabled(): boolean {
    return this.getBudget !== undefined || this.staticBudget > 0 || this.dailyCap > 0;
  }

  /**
   * Scale factor in [0, 1] for a proposed gross yield, given the current
   * outstanding liability. Multiply gross yield by this before distributing.
   */
  scale(outstanding: number): number {
    return Math.min(this.backingScale(outstanding), this.dailyScale());
  }

  /**
   * Convenience: apply the scale to a gross amount and floor it.
   */
  apply(grossYield: number, outstanding: number): number {
    return Math.floor(grossYield * this.scale(outstanding));
  }

  /** Record that `amount` credits were actually issued (for the daily cap). */
  record(amount: number): void {
    if (amount <= 0) return;
    const t = this.now();
    this.window.push({ t, amount });
    this.windowSum += amount;
    this.prune(t);
  }

  getStatus(outstanding: number): EmissionStatus {
    this.prune(this.now());
    const budget = this.budget();
    return {
      scale: this.scale(outstanding),
      outstanding,
      budget,
      headroom: budget > 0 ? Math.max(0, budget - outstanding) : Infinity,
      dailyIssued: this.windowSum,
      dailyCap: this.dailyCap,
    };
  }

  private backingScale(outstanding: number): number {
    const budget = this.budget();
    if (budget <= 0) return 1;
    const headroom = budget - outstanding;
    if (headroom <= 0) return 0;
    const band = budget * this.taperFraction;
    if (headroom >= band) return 1;
    return headroom / band;
  }

  private dailyScale(): number {
    if (this.dailyCap <= 0) return 1;
    this.prune(this.now());
    return this.windowSum >= this.dailyCap ? 0 : 1;
  }

  private prune(now: number): void {
    const cutoff = now - DAY_MS;
    while (this.window.length > 0 && this.window[0]!.t < cutoff) {
      this.windowSum -= this.window.shift()!.amount;
    }
    if (this.windowSum < 0) this.windowSum = 0;
  }
}
