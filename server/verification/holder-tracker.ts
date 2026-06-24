/**
 * Holder-eligibility tracker with flash-loan mitigation.
 *
 * Ported from `Black-Gold-main/server/solana/holder.ts` per
 * `docs/PORTING_NOTES.md`. The split is:
 *
 * - **This file (pure logic).** In-memory observation history per
 *   wallet, deterministic eligibility decisions, no RPC, no chain
 *   imports. Unit-testable without Solana mocks.
 * - **`server/chain/holder.ts` (chain adapter, sub-slice 2).** Reads
 *   on-chain SPL balances and feeds them into a `HolderTracker`.
 *   Lives behind `ChainOps` so it can only run when
 *   `CHAIN_ENABLED=true`.
 *
 * **Divergence from BG (intentional).** BG's flash-loan guard was
 * dead code: the check was `if (holdDuration < 10min &&
 * consecutiveVerifications < 2)`. By the second observation
 * `consecutiveVerifications` was already incremented to 2, so the
 * `&&` never triggered and every wallet whose balance crossed the
 * threshold was eligible immediately. astroid.club fixes this:
 *
 * - Default semantic is now `OR`: a wallet is blocked while the
 *   hold time is under the threshold AND the consecutive observation
 *   count is under the threshold. Either passing unblocks.
 * - `minConsecutiveObservations` defaults to 5 (BG hard-coded 2,
 *   which combined with `OR` would still effectively block until
 *   10 minutes elapsed). With 5, an active wallet observed every
 *   ~2 minutes bypasses the time gate after ~10 minutes; an
 *   instantaneous flash-loan attacker observed once is blocked.
 *
 * Both knobs are configurable so operators can tune. Default values
 * are deliberately stricter than BG; the guard now actually guards.
 *
 * **Grace period.** First observation of a wallet establishes its
 * tracking record but is **not** eligible — there is no historical
 * data, so there's nothing to verify. BG allowed first-observation
 * to pass; we don't, because that's exactly the flash-loan attack
 * vector. Operators who want a grace period (e.g. for new users
 * who just bought tokens) should buffer the first observation
 * UI-side and retry after a delay.
 *
 * **Read-only.** This module never moves funds. It mutates only its
 * own in-memory map. Safe to call from any layer at any time.
 */

import type { GameLogger } from '../game/interfaces.js';

/**
 * Configuration for `HolderTracker`. All fields optional with
 * documented defaults. Mutating these mid-flight is supported
 * (operators flipping defaults via admin tooling).
 */
export interface HolderTrackerConfig {
  /**
   * Minimum continuous hold time, in milliseconds, before a wallet
   * is eligible (combined with `minConsecutiveObservations` via
   * OR).
   *
   * Default: `600_000` (10 minutes; matches BG's `MIN_HOLD_TIME_MS`).
   */
  minHoldMs?: number;

  /**
   * Minimum consecutive observations above the threshold before a
   * wallet is eligible (combined with `minHoldMs` via OR).
   *
   * Default: `5`. BG hard-coded 2; we default to 5 because the
   * port's OR semantic makes 2 effectively redundant with the time
   * gate.
   */
  minConsecutiveObservations?: number;

  /** Optional logger. Defaults to a silent stub. */
  logger?: GameLogger;

  /**
   * Optional clock injection for deterministic tests. Defaults to
   * `Date.now`. The tracker calls this whenever it needs the
   * current time.
   */
  now?: () => number;
}

/**
 * Per-wallet observation history. Reset whenever the wallet's
 * balance falls below the required threshold, so a hostile actor
 * cannot accumulate eligibility by repeated below-threshold
 * observations.
 */
export interface BalanceObservation {
  /** Wall-clock ms epoch when the balance was first seen above threshold. */
  firstSeenAboveThresholdMs: number;
  /** Most recently observed balance (above threshold). */
  lastBalance: number;
  /** How many consecutive above-threshold observations we have. */
  consecutiveObservations: number;
}

/**
 * Eligibility decision returned from `recordObservation`. Always
 * includes diagnostic context so callers can surface useful UI
 * (e.g. "you'll be eligible in 4 minutes").
 */
export interface EligibilityDecision {
  /** Wallet at the moment of decision. */
  walletAddress: string;
  /** Final eligibility verdict. */
  eligible: boolean;
  /** Whether the raw balance meets `requiredBalance` (no time gate). */
  meetsBalanceRequirement: boolean;
  /**
   * Reason eligibility was denied, when `eligible === false`.
   * Absent when eligible.
   */
  reason?: 'below_threshold' | 'flash_loan_guard';
  /** Hold duration so far, in ms (0 on first observation). */
  holdDurationMs: number;
  /** Time remaining before the time gate would pass, in ms. */
  remainingHoldMs: number;
  /** Consecutive observation count after this call (1 on first). */
  consecutiveObservations: number;
  /** Observed balance (passed through from caller). */
  balance: number;
  /** Required balance threshold (passed through from caller). */
  requiredBalance: number;
}

/**
 * In-memory eligibility tracker. Construct one per process; share
 * across `ChainOps.impls.verifyHolderQualified` and any internal
 * caller that needs an eligibility verdict.
 */
export class HolderTracker {
  private readonly minHoldMs: number;
  private readonly minConsecutiveObservations: number;
  private readonly log: GameLogger;
  private readonly now: () => number;
  private readonly history: Map<string, BalanceObservation> = new Map();

  constructor(config: HolderTrackerConfig = {}) {
    this.minHoldMs = config.minHoldMs ?? 600_000;
    this.minConsecutiveObservations = config.minConsecutiveObservations ?? 5;
    this.log = config.logger ?? silentLogger();
    this.now = config.now ?? (() => Date.now());

    if (this.minHoldMs < 0) {
      throw new Error(`HolderTracker: minHoldMs must be >= 0 (got ${this.minHoldMs})`);
    }
    if (this.minConsecutiveObservations < 1) {
      throw new Error(
        `HolderTracker: minConsecutiveObservations must be >= 1 ` +
          `(got ${this.minConsecutiveObservations})`,
      );
    }
  }

  /**
   * Record a balance observation and return an eligibility verdict
   * for this wallet at this moment. Mutates internal state.
   *
   * Behaviour:
   * - If `balance < requiredBalance`: tracking is reset for this
   *   wallet (the attacker cannot accumulate eligibility while
   *   below threshold) and `eligible: false` is returned with reason
   *   `below_threshold`.
   * - If first observation above threshold: tracking record is
   *   created, `consecutiveObservations` is 1, `eligible: false`
   *   with reason `flash_loan_guard`. There is no grace period.
   * - On subsequent observations, the wallet is eligible iff
   *   `holdDurationMs >= minHoldMs` OR
   *   `consecutiveObservations >= minConsecutiveObservations`.
   *
   * @param walletAddress base58 wallet (passed through opaquely).
   * @param balance observed balance (any unit; caller's choice).
   * @param requiredBalance threshold the balance must meet.
   */
  recordObservation(
    walletAddress: string,
    balance: number,
    requiredBalance: number,
  ): EligibilityDecision {
    if (!Number.isFinite(balance) || balance < 0) {
      throw new Error(`HolderTracker: balance must be finite >= 0 (got ${balance})`);
    }
    if (!Number.isFinite(requiredBalance) || requiredBalance < 0) {
      throw new Error(
        `HolderTracker: requiredBalance must be finite >= 0 (got ${requiredBalance})`,
      );
    }

    const meetsBalanceRequirement = balance >= requiredBalance;

    if (!meetsBalanceRequirement) {
      // Balance dropped below threshold: nuke any existing tracking
      // so a hostile actor cannot accumulate eligibility while
      // bouncing around the threshold.
      this.history.delete(walletAddress);
      return {
        walletAddress,
        eligible: false,
        meetsBalanceRequirement: false,
        reason: 'below_threshold',
        holdDurationMs: 0,
        remainingHoldMs: this.minHoldMs,
        consecutiveObservations: 0,
        balance,
        requiredBalance,
      };
    }

    const now = this.now();
    let history = this.history.get(walletAddress);

    if (!history) {
      history = {
        firstSeenAboveThresholdMs: now,
        lastBalance: balance,
        consecutiveObservations: 1,
      };
      this.history.set(walletAddress, history);
      this.log.info(
        `[HolderTracker] new wallet tracked: ${walletAddress.slice(0, 8)}... ` +
          `balance=${balance} threshold=${requiredBalance} (first observation; flash-loan guard active)`,
      );
    } else {
      history.lastBalance = balance;
      history.consecutiveObservations += 1;
    }

    const holdDurationMs = now - history.firstSeenAboveThresholdMs;
    const timeGatePassed = holdDurationMs >= this.minHoldMs;
    const consecGatePassed = history.consecutiveObservations >= this.minConsecutiveObservations;
    const eligible = timeGatePassed || consecGatePassed;

    if (!eligible) {
      const remainingHoldMs = Math.max(0, this.minHoldMs - holdDurationMs);
      this.log.info(
        `[HolderTracker] flash-loan guard: ${walletAddress.slice(0, 8)}... ` +
          `held ${Math.round(holdDurationMs / 1000)}s ` +
          `(${history.consecutiveObservations}/${this.minConsecutiveObservations} obs); ` +
          `${Math.round(remainingHoldMs / 1000)}s remaining`,
      );
      return {
        walletAddress,
        eligible: false,
        meetsBalanceRequirement: true,
        reason: 'flash_loan_guard',
        holdDurationMs,
        remainingHoldMs,
        consecutiveObservations: history.consecutiveObservations,
        balance,
        requiredBalance,
      };
    }

    return {
      walletAddress,
      eligible: true,
      meetsBalanceRequirement: true,
      holdDurationMs,
      remainingHoldMs: 0,
      consecutiveObservations: history.consecutiveObservations,
      balance,
      requiredBalance,
    };
  }

  /**
   * Seed the hold-start timestamp for a wallet that is about to be
   * observed for the first time. Used by chain-side pre-warming
   * (`server/chain/prewarm.ts`): when Helius transaction history
   * shows a wallet has been continuously above threshold for some
   * time already, the pre-warmer pre-seeds the tracker so the
   * subsequent `recordObservation` immediately satisfies the time
   * gate. Without pre-warming, every legitimate holder pays the
   * full `minHoldMs` wait the first time their wallet is observed
   * by the gateway, which is unfair to long-time holders whose
   * on-chain history already proves continuous holding.
   *
   * Behaviour:
   * - **Idempotent against existing history.** If the wallet
   *   already has a tracking record, this is a no-op (returns
   *   false). Never overrides an existing record — that would
   *   re-enable the very flash-loan vector the tracker exists to
   *   defend against (a hostile pre-warm path could reset the
   *   clock by feeding fabricated history).
   * - **Future timestamps clamped to now.** A `holdStartMs` newer
   *   than the current clock is silently treated as "now" — this
   *   makes the seed equivalent to a fresh first observation if
   *   the estimator returns garbage.
   * - **Counts as one observation.** The wallet is recorded with
   *   `consecutiveObservations: 1` and `lastBalance: balance`. The
   *   next `recordObservation` increments to 2 and computes
   *   `holdDurationMs = now - holdStartMs`. If that crosses
   *   `minHoldMs`, the wallet is eligible on the very next call.
   * - **Threshold dips still reset.** A subsequent
   *   below-threshold observation deletes the seeded record, just
   *   like for any other tracking entry. The seed is not sticky.
   *
   * @param walletAddress base58 wallet (passed through opaquely).
   * @param holdStartMs wall-clock ms epoch when continuous hold began.
   * @param balance current observed balance (must be finite >= 0).
   * @returns true if seeded; false if the wallet already had history.
   */
  seedHoldStart(walletAddress: string, holdStartMs: number, balance: number): boolean {
    if (!Number.isFinite(holdStartMs)) {
      throw new Error(`HolderTracker: holdStartMs must be finite (got ${holdStartMs})`);
    }
    if (!Number.isFinite(balance) || balance < 0) {
      throw new Error(`HolderTracker: balance must be finite >= 0 (got ${balance})`);
    }
    if (this.history.has(walletAddress)) {
      // Idempotent: existing history wins. Caller should check
      // `getHistory` before seeding if it cares about the outcome.
      return false;
    }
    const now = this.now();
    const clampedStart = Math.min(holdStartMs, now);
    this.history.set(walletAddress, {
      firstSeenAboveThresholdMs: clampedStart,
      lastBalance: balance,
      consecutiveObservations: 1,
    });
    this.log.info(
      `[HolderTracker] pre-warmed ${walletAddress.slice(0, 8)}... ` +
        `holdStartMs=${new Date(clampedStart).toISOString()} ` +
        `(${Math.round((now - clampedStart) / 1000)}s of inferred on-chain hold time)`,
    );
    return true;
  }

  /**
   * Read-only accessor for a wallet's current observation record.
   * Useful for diagnostics and admin dashboards. Returns
   * `undefined` if the wallet has never been observed above the
   * threshold (or its tracking has been reset).
   */
  getHistory(walletAddress: string): BalanceObservation | undefined {
    const h = this.history.get(walletAddress);
    if (!h) return undefined;
    return { ...h };
  }

  /** Forget tracking for a wallet (admin tooling, tests). */
  clear(walletAddress: string): void {
    this.history.delete(walletAddress);
  }

  /** Forget every tracked wallet (admin tooling, tests). */
  clearAll(): void {
    this.history.clear();
  }

  /** Number of wallets currently being tracked. */
  size(): number {
    return this.history.size;
  }
}

function silentLogger(): GameLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}
