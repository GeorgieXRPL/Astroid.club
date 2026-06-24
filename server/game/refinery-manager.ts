/**
 * Refinery manager for astroid.club.
 *
 * Ported from `Black-Gold-main/server/game/vault-manager.ts` per
 * `docs/PORTING_NOTES.md`. The 70/30 yield split, miner-contribution
 * scoring, hourly distribution cadence, and proportional payout math
 * are byte-identical to BG.
 *
 * Architectural changes:
 *
 * 1. **Class instead of free functions.** BG used a functional style
 *    (`createVaultManager()` returning a state object, then free
 *    functions taking `state` as the first arg). astroid.club packages
 *    the state and operations into a `RefineryManager` class to match
 *    the rest of the game-module style and to make DI / construction
 *    options consistent.
 *
 * 2. **Resource-explicit contribution updates.** The
 *    `updateMinerContribution` call takes a `ResourceType` directly
 *    (rather than a boolean flag) for the carbon-class loyalty bonus
 *    check — same semantics, no flag-shaped argument.
 *
 * Theme renames per glossary:
 *
 * - `MineVault` → `AsteroidRefinery` (in types.ts)
 * - `vault` → `refinery` throughout
 * - `VaultDistributionResult` → `RefineryDistributionResult`
 * - `vaultShare` → `refineryShare` (split output field)
 * - `hashrateSeconds` → `drillPowerSeconds` (MinerContribution field)
 * - `hashrateMultiplier` → `drillPowerMultiplier` (StakeTier field)
 * - `currentHashrate` → `currentDrillPower` (parameter)
 * - Token symbol in log strings → `"$ASTROID"` (configurable)
 */

import type { ResourceType } from '../../config/asteroids.js';

import type { GameLogger } from './interfaces.js';
import type { AsteroidRefinery, MinerContribution, RefineryDistributionResult } from './types.js';
import { getStakeTier } from './types.js';

/** Yield-split shares — preserved verbatim from BG. */
const FINDER_SHARE_PERCENT = 0.7;
const REFINERY_SHARE_PERCENT = 0.3;

/** Minimum refinery balance required to trigger distribution. */
const MIN_DISTRIBUTION_AMOUNT = 1;

/** Default distribution cadence (1 hour) — preserved verbatim from BG. */
const DEFAULT_DISTRIBUTION_INTERVAL_MS = 60 * 60 * 1000;

/** Carbon-class loyalty bonus: +10% after 7 days at the home station. */
const CARBON_LOYALTY_BONUS = 0.1;
const CARBON_LOYALTY_DAYS_REQUIRED = 7;

/** Configuration accepted by the refinery manager. */
export interface RefineryManagerConfig {
  /** Distribution cadence in ms. Defaults to 1 hour. */
  distributionIntervalMs?: number;
  /** Token symbol for log lines. Defaults to "$ASTROID". */
  tokenSymbol?: string;
  logger?: GameLogger;
}

/** Result of `calculateYieldSplit` — finder gets 70%, refinery gets 30%. */
export interface YieldSplit {
  /** Floor of `total * 0.7`. */
  finderShare: number;
  /** Floor of `total * 0.3`. */
  refineryShare: number;
}

/** Aggregate stats for a single refinery. */
export interface RefineryStats {
  balance: number;
  pendingDistribution: number;
  totalDistributed: number;
  distributionCount: number;
  contributorCount: number;
  lastDistribution: Date;
}

/** Estimated payout share if distribution happened right now. */
export interface PendingShareEstimate {
  amount: number;
  /** Percent share, 0-100. */
  sharePercent: number;
}

/**
 * Manages per-asteroid refineries: the 30%-of-yield pools that
 * accumulate from each discovery and pay out hourly to active miners,
 * weighted by drill-power-seconds × stake-tier × loyalty × time-active.
 *
 * Refineries are created lazily — first access to an asteroid id
 * registers a fresh `AsteroidRefinery` row. There is no concept of
 * "registering" an asteroid up front (matches BG).
 */
export class RefineryManager {
  private readonly refineries: Map<string, AsteroidRefinery> = new Map();
  private readonly distributionIntervalMs: number;
  private readonly tokenSymbol: string;
  private readonly log: GameLogger;
  private lastDistributionCheck: Date;

  constructor(config: RefineryManagerConfig = {}) {
    this.distributionIntervalMs = config.distributionIntervalMs ?? DEFAULT_DISTRIBUTION_INTERVAL_MS;
    this.tokenSymbol = config.tokenSymbol ?? '$ASTROID';
    this.log = config.logger ?? defaultLogger();
    this.lastDistributionCheck = new Date();
  }

  // --------- Refinery state ---------

  /** Build a fresh refinery row for an asteroid. */
  initializeRefinery(asteroidId: string): AsteroidRefinery {
    const refinery: AsteroidRefinery = {
      asteroidId,
      balance: 0,
      pendingDistribution: 0,
      lastDistributionTime: new Date(),
      hourlyContributions: new Map(),
      totalDistributed: 0,
      distributionCount: 0,
    };
    this.refineries.set(asteroidId, refinery);
    return refinery;
  }

  /** Get an existing refinery or create a fresh one for the asteroid. */
  getOrCreateRefinery(asteroidId: string): AsteroidRefinery {
    const existing = this.refineries.get(asteroidId);
    if (existing) return existing;
    return this.initializeRefinery(asteroidId);
  }

  /** Read the refinery for an asteroid (does NOT create). */
  getRefinery(asteroidId: string): AsteroidRefinery | undefined {
    return this.refineries.get(asteroidId);
  }

  // --------- Yield split ---------

  /**
   * Split a discovery's total yield into finder share (70%) and
   * refinery share (30%). Both values are floored — the `Math.floor`
   * pair is BG's exact behaviour, which can drop sub-1-token dust on
   * uneven totals.
   */
  calculateYieldSplit(totalYield: number): YieldSplit {
    return {
      finderShare: Math.floor(totalYield * FINDER_SHARE_PERCENT),
      refineryShare: Math.floor(totalYield * REFINERY_SHARE_PERCENT),
    };
  }

  // --------- Refinery accumulation ---------

  /**
   * Add a discovery's refinery share to an asteroid's refinery
   * balance. Returns the new balance. Auto-creates the refinery row
   * if it didn't exist.
   */
  addToRefinery(asteroidId: string, amount: number): number {
    const refinery = this.getOrCreateRefinery(asteroidId);
    refinery.balance += amount;
    refinery.pendingDistribution += amount;
    this.log.info(
      `[Refinery] Added ${amount} ${this.tokenSymbol} to ${asteroidId} refinery. ` +
        `Balance: ${refinery.balance}`,
    );
    return refinery.balance;
  }

  /**
   * Remove up to `amount` from an asteroid's refinery balance (e.g. a
   * successful raid steals from the treasury). Clamped at 0 and reflected in
   * the still-undistributed `pendingDistribution` so the hourly payout can't
   * hand out tokens that were already carried off. Returns the amount
   * actually debited.
   */
  debit(asteroidId: string, amount: number): number {
    const refinery = this.refineries.get(asteroidId);
    if (!refinery || amount <= 0) return 0;
    const taken = Math.min(amount, refinery.balance);
    refinery.balance -= taken;
    refinery.pendingDistribution = Math.max(0, refinery.pendingDistribution - taken);
    this.log.info(
      `[Refinery] Debited ${taken} ${this.tokenSymbol} from ${asteroidId} refinery (raid). ` +
        `Balance: ${refinery.balance}`,
    );
    return taken;
  }

  /**
   * Update a miner's contribution to this hour's distribution pool.
   * Call periodically (e.g. once per tick) for every active miner.
   * Takes a `resource: ResourceType` directly (rather than a boolean
   * flag) — same semantics, simpler signature.
   */
  updateMinerContribution(args: {
    asteroidId: string;
    walletAddress: string;
    currentDrillPower: number;
    stakeAmount: number;
    loyaltyDays: number;
    resource: ResourceType;
    deltaSeconds: number;
  }): void {
    const refinery = this.getOrCreateRefinery(args.asteroidId);
    const stakeTier = getStakeTier(args.stakeAmount);

    const isCarbon = args.resource === 'carbon';
    const loyaltyBonus =
      isCarbon && args.loyaltyDays >= CARBON_LOYALTY_DAYS_REQUIRED ? CARBON_LOYALTY_BONUS : 0;

    const existing = refinery.hourlyContributions.get(args.walletAddress);
    if (existing) {
      existing.drillPowerSeconds += args.currentDrillPower * args.deltaSeconds;
      existing.stakeTierMultiplier = stakeTier.drillPowerMultiplier;
      existing.loyaltyBonus = loyaltyBonus;
      existing.timeActiveSeconds += args.deltaSeconds;
    } else {
      const contribution: MinerContribution = {
        walletAddress: args.walletAddress,
        drillPowerSeconds: args.currentDrillPower * args.deltaSeconds,
        stakeTierMultiplier: stakeTier.drillPowerMultiplier,
        loyaltyBonus,
        timeActiveSeconds: args.deltaSeconds,
      };
      refinery.hourlyContributions.set(args.walletAddress, contribution);
    }
  }

  // --------- Scoring + distribution ---------

  /**
   * Compute a miner's score for the hourly payout. Formula preserved
   * verbatim from BG:
   *
   *   score = (drill_power_seconds / total_drill_power_seconds)
   *         × stake_tier_multiplier
   *         × (1 + loyalty_bonus)
   *         × min(1, time_active_seconds / 3600)
   */
  calculateMinerScore(contribution: MinerContribution, totalDrillPowerSeconds: number): number {
    if (totalDrillPowerSeconds === 0) return 0;
    const drillPowerShare = contribution.drillPowerSeconds / totalDrillPowerSeconds;
    const stakeFactor = contribution.stakeTierMultiplier;
    const loyaltyFactor = 1 + contribution.loyaltyBonus;
    const timeFactor = Math.min(1, contribution.timeActiveSeconds / 3600);
    return drillPowerShare * stakeFactor * loyaltyFactor * timeFactor;
  }

  /**
   * Distribute one asteroid's pending refinery balance to its
   * contributors. Returns null when there's nothing to distribute,
   * no contributors, zero drill-power, or zero total score (any
   * one of those short-circuits identically to BG).
   *
   * On success, mutates the refinery state: decrements balance,
   * resets pending to 0, bumps totalDistributed and distributionCount,
   * stamps lastDistributionTime, and clears the contributions map for
   * the next hour.
   */
  distributeRefinery(asteroidId: string): RefineryDistributionResult | null {
    const refinery = this.refineries.get(asteroidId);
    if (!refinery) return null;

    if (refinery.pendingDistribution < MIN_DISTRIBUTION_AMOUNT) {
      this.log.info(
        `[Refinery] ${asteroidId}: Nothing to distribute ` +
          `(pending: ${refinery.pendingDistribution})`,
      );
      return null;
    }

    if (refinery.hourlyContributions.size === 0) {
      this.log.info(`[Refinery] ${asteroidId}: No contributors this hour`);
      return null;
    }

    let totalDrillPowerSeconds = 0;
    for (const c of refinery.hourlyContributions.values()) {
      totalDrillPowerSeconds += c.drillPowerSeconds;
    }
    if (totalDrillPowerSeconds === 0) {
      this.log.info(`[Refinery] ${asteroidId}: No drill power contributed this hour`);
      return null;
    }

    const scores = new Map<string, number>();
    let totalScore = 0;
    for (const [wallet, c] of refinery.hourlyContributions.entries()) {
      const score = this.calculateMinerScore(c, totalDrillPowerSeconds);
      scores.set(wallet, score);
      totalScore += score;
    }
    if (totalScore === 0) {
      this.log.info(`[Refinery] ${asteroidId}: Total score is zero`);
      return null;
    }

    const amountToDistribute = refinery.pendingDistribution;
    const payouts = new Map<string, number>();
    let actualDistributed = 0;
    for (const [wallet, score] of scores.entries()) {
      const sharePercent = score / totalScore;
      const payout = Math.floor(amountToDistribute * sharePercent);
      if (payout > 0) {
        payouts.set(wallet, payout);
        actualDistributed += payout;
      }
    }

    refinery.balance -= actualDistributed;
    refinery.pendingDistribution = 0;
    refinery.totalDistributed += actualDistributed;
    refinery.distributionCount += 1;
    refinery.lastDistributionTime = new Date();
    refinery.hourlyContributions.clear();

    const result: RefineryDistributionResult = {
      asteroidId,
      totalDistributed: actualDistributed,
      minerCount: payouts.size,
      payouts,
      distributedAt: new Date(),
    };

    this.log.info(
      `[Refinery] ${asteroidId}: Distributed ${actualDistributed} ${this.tokenSymbol} ` +
        `to ${payouts.size} miners`,
    );
    return result;
  }

  /** Distribute every refinery. Updates the manager's lastDistributionCheck. */
  distributeAllRefineries(): RefineryDistributionResult[] {
    const results: RefineryDistributionResult[] = [];
    for (const asteroidId of this.refineries.keys()) {
      const result = this.distributeRefinery(asteroidId);
      if (result) results.push(result);
    }
    this.lastDistributionCheck = new Date();
    return results;
  }

  /** Whether the configured distribution interval has elapsed since the last run. */
  shouldDistribute(): boolean {
    return Date.now() - this.lastDistributionCheck.getTime() >= this.distributionIntervalMs;
  }

  /**
   * Force-update `lastDistributionCheck` to `now`. Useful for tests
   * and for reset-after-restart scenarios. Not exposed in BG; kept
   * private here is overly cautious — exposing for symmetry with
   * `shouldDistribute`.
   */
  markDistributionChecked(): void {
    this.lastDistributionCheck = new Date();
  }

  // --------- Inspection ---------

  /** Stats for a specific asteroid's refinery, or null if it doesn't exist. */
  getRefineryStats(asteroidId: string): RefineryStats | null {
    const refinery = this.refineries.get(asteroidId);
    if (!refinery) return null;
    return {
      balance: refinery.balance,
      pendingDistribution: refinery.pendingDistribution,
      totalDistributed: refinery.totalDistributed,
      distributionCount: refinery.distributionCount,
      contributorCount: refinery.hourlyContributions.size,
      lastDistribution: refinery.lastDistributionTime,
    };
  }

  /** Map of asteroidId -> current refinery balance. */
  getAllRefineryBalances(): Map<string, number> {
    const balances = new Map<string, number>();
    for (const [asteroidId, refinery] of this.refineries.entries()) {
      balances.set(asteroidId, refinery.balance);
    }
    return balances;
  }

  /** Sum of every refinery's balance. */
  getTotalRefineryBalance(): number {
    let total = 0;
    for (const refinery of this.refineries.values()) total += refinery.balance;
    return total;
  }

  /**
   * Estimate a wallet's payout if distribution happened right now.
   * Returns `{ amount: 0, sharePercent: 0 }` when the wallet has no
   * contribution. Returns null when the asteroid has no refinery.
   */
  getMinerPendingShare(asteroidId: string, walletAddress: string): PendingShareEstimate | null {
    const refinery = this.refineries.get(asteroidId);
    if (!refinery) return null;

    const contribution = refinery.hourlyContributions.get(walletAddress);
    if (!contribution) return { amount: 0, sharePercent: 0 };

    let totalDrillPowerSeconds = 0;
    for (const c of refinery.hourlyContributions.values()) {
      totalDrillPowerSeconds += c.drillPowerSeconds;
    }
    if (totalDrillPowerSeconds === 0) return { amount: 0, sharePercent: 0 };

    let totalScore = 0;
    let myScore = 0;
    for (const [wallet, c] of refinery.hourlyContributions.entries()) {
      const score = this.calculateMinerScore(c, totalDrillPowerSeconds);
      totalScore += score;
      if (wallet === walletAddress) myScore = score;
    }
    if (totalScore === 0) return { amount: 0, sharePercent: 0 };

    const sharePercent = (myScore / totalScore) * 100;
    const amount = Math.floor(refinery.pendingDistribution * (myScore / totalScore));
    return { amount, sharePercent };
  }
}

/** Default `console`-based logger used when none is injected. */
function defaultLogger(): GameLogger {
  return {
    info: (msg, ...rest) => console.info(msg, ...rest),
    warn: (msg, ...rest) => console.warn(msg, ...rest),
    error: (msg, ...rest) => console.error(msg, ...rest),
  };
}
