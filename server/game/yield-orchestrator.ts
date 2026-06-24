/**
 * Yield orchestrator for astroid.club.
 *
 * Ported from `Black-Gold-main/server/game/reward-orchestrator.ts`
 * per `docs/PORTING_NOTES.md`. Connects discovery events to the
 * 70/30 yield split, share-based per-miner payouts (with finder
 * bonus), and the hourly refinery distribution.
 *
 * Architectural changes vs. BG:
 *
 * 1. **Class instead of free functions + module-level state.** BG
 *    used a singleton `state` and free `handleNewDiscovery` /
 *    `processRewardPayout` etc. astroid.club packages everything
 *    into a `YieldOrchestrator` class with full DI.
 *
 * 2. **Pool / timeout flow dropped.** BG had a cryptographic
 *    pool-mining flow with a "timeout discovery" path
 *    (`handleTimeoutDiscovery`) that paid out closest-hash winners
 *    with a rollover jackpot. astroid.club discoveries are time-
 *    based (`baseDiscoveryTimeMs` per asteroid), so there is no
 *    pool, no shares from a `PoolManager`, and no timeout flow.
 *    Caller still passes optional `shares` representing per-miner
 *    contribution percentages — math is identical when present, and
 *    the legacy "100% to finder" fallback is preserved when absent.
 *
 * 3. **No direct chain transfers.** BG called `sendReward` from
 *    `solana/rewards` directly, bypassing the distribution service's
 *    chain hook. astroid.club routes ALL payouts through the same
 *    chain hook pattern: when `chainEnabled === true`, fire
 *    `onYieldPayout(wallet, amount, asteroidId)`; when disabled,
 *    credit `stakeManager.addPendingYield`. Code paths intact, on-
 *    chain side effects fully gated.
 *
 * 4. **`handleDefenderSpoils` skipped.** astroid.club's
 *    `RaidEngine.distributeDefenderSpoils` already handles defender
 *    payouts via `addPendingYield`. Routing this twice would
 *    double-credit defenders.
 *
 * 5. **Per-resource multipliers preserved.** Carbon 1.0×, Silver 1.2×,
 *    Oil 1.3×, Gold 1.5× — the audited table — exposed as a configurable
 *    constant. Stacked with each asteroid's own
 *    `definition.baseRewardMultiplier` (the per-asteroid tuning knob
 *    that BG didn't have).
 *
 * 6. **Seedable randomness.** The variance roll is taken from a
 *    `random` function passed via config (defaults to `Math.random`).
 *    Tests pass `() => 0.5` for deterministic zero-variance.
 */

import type { AsteroidDefinition, ResourceType } from '../../config/asteroids.js';

import type { DistributionService } from './distribution-service.js';
import type { EmissionGovernor, EmissionStatus } from './emission-governor.js';
import type { AsteroidRegistryLike, GameLogger, StakeManagerLike } from './interfaces.js';
import type { RaidVaultManager } from './raid-vault.js';

/** Per-resource yield multipliers — preserved verbatim from BG. */
export const DEFAULT_RESOURCE_MULTIPLIERS: Record<ResourceType, number> = {
  carbon: 1.0,
  silver: 1.2,
  oil: 1.3,
  gold: 1.5,
};

/** Yield knobs — preserved verbatim from BG (`REWARD_CONFIG`). */
export const YIELD_CONFIG = {
  /** Percent of total yield distributed to miners by share. */
  MINER_POOL_PERCENT: 70,
  /** Percent that goes to the asteroid refinery (legacy hourly distribution). */
  REFINERY_SHARE_PERCENT: 30,
  /**
   * Percent of each discovery routed into the persistent, raidable raid vault
   * (vault mode). The remainder is paid to miners per-discovery. Default 20%
   * (kept deliberately beefy so the treasury is a worthwhile raid target);
   * operator-tunable via env `RAID_VAULT_PERCENT`.
   */
  RAID_VAULT_PERCENT: 20,
  /** Finder bonus: extra percent ON TOP of the finder's share. */
  FINDER_BONUS_PERCENT: 20,
  /** Base yield per discovery, before resource and per-asteroid multipliers. */
  BASE_YIELD_PER_DISCOVERY: 100,
  /** ±20% variance applied to each discovery's yield. */
  YIELD_VARIANCE: 0.2,
} as const;

/** Per-miner contribution share supplied by the caller. */
export interface MinerShareInfo {
  walletAddress: string;
  /** Drill-power-seconds equivalent (informational). */
  drillPowerSeconds: number;
  /** Percent of the miner pool this wallet earns, 0–100. */
  sharePercent: number;
}

/** Per-miner payout entry returned by `processDiscovery`. */
export interface MinerPayout {
  wallet: string;
  amount: number;
  /** True if this wallet is the discovery finder (gets the bonus). */
  isFinder: boolean;
}

/** Result of a discovery roll-up. */
export interface DiscoveryOutcome {
  /** Always true here — chain failures are reported via the listener. */
  success: boolean;
  /** Yield credited to the discovery's finder (base + bonus). */
  finderYield: number;
  /** Refinery share credited to the asteroid (legacy hourly pool; 0 in vault mode). */
  refineryYield: number;
  /** Persistent raid-vault cut credited to the asteroid (vault mode; 0 in legacy). */
  vaultYield: number;
  /** Sum of all components. */
  totalYield: number;
  /** Per-miner payouts (the miner pool, optionally share-weighted). */
  minerPayouts: MinerPayout[];
}

/** Aggregate stats for the orchestrator. */
export interface OrchestratorStats {
  totalDiscoveries: number;
  totalYieldDistributed: number;
  totalFinderYield: number;
  totalRefineryYield: number;
  lastDistribution: Date | null;
}

export interface YieldOrchestratorConfig {
  distribution: DistributionService;
  registry: AsteroidRegistryLike;
  stakeManager: StakeManagerLike;
  /**
   * When true, payouts route through `onYieldPayout`. When false,
   * payouts credit `stakeManager.addPendingYield`. Defaults to false
   * (mirrors `DistributionService` and the chain-flag plan).
   */
  chainEnabled?: boolean;
  /**
   * Per-payout chain hook. Only invoked when `chainEnabled === true`.
   * Boot layer wires this to a real SPL transfer.
   */
  onYieldPayout?: (walletAddress: string, amount: number, asteroidId: string) => void;
  /** Per-resource multipliers. Defaults to BG's table. */
  resourceMultipliers?: Record<ResourceType, number>;
  /**
   * Base yield per discovery before multipliers/variance. Operator retune
   * knob (env `YIELD_BASE_PER_DISCOVERY`). Defaults to
   * `YIELD_CONFIG.BASE_YIELD_PER_DISCOVERY` (100).
   */
  baseYieldPerDiscovery?: number;
  /** RNG used for the variance roll. Defaults to `Math.random`. */
  random?: () => number;
  /** Token symbol for log lines. Defaults to "$ASTROID". */
  tokenSymbol?: string;
  /**
   * Optional emission governor. When supplied, gross discovery yield is
   * scaled down as the outstanding credit liability approaches the treasury
   * backing budget (and/or a rolling daily cap), protecting the reserve at
   * scale. Omit to issue at full rate (legacy behaviour).
   */
  governor?: EmissionGovernor;
  /**
   * Optional persistent raid vault. When supplied, the orchestrator switches to
   * **vault mode**: a small `raidVaultPercent` cut of each discovery is routed
   * into the per-asteroid vault (a stable, raidable treasury) and the remainder
   * is paid to miners *per-discovery* — there is no hourly refinery pool to
   * drain. When omitted, the legacy 70/30 hourly-refinery model is used.
   */
  raidVault?: RaidVaultManager;
  /** Vault cut percent in vault mode. Defaults to `YIELD_CONFIG.RAID_VAULT_PERCENT`. */
  raidVaultPercent?: number;
  logger?: GameLogger;
}

/**
 * Coordinates discovery yield: rolls the total amount, splits 70/30,
 * routes the 70% miner pool through share-based finder + share
 * distribution (with finder bonus on top of base share), and the 30%
 * refinery share through the distribution service.
 */
export class YieldOrchestrator {
  private readonly distribution: DistributionService;
  private readonly registry: AsteroidRegistryLike;
  private readonly stakeManager: StakeManagerLike;
  private readonly chainEnabled: boolean;
  private readonly onYieldPayout?: YieldOrchestratorConfig['onYieldPayout'];
  private readonly resourceMultipliers: Record<ResourceType, number>;
  private readonly baseYieldPerDiscovery: number;
  private readonly random: () => number;
  private readonly tokenSymbol: string;
  private readonly governor?: EmissionGovernor;
  private readonly raidVault?: RaidVaultManager;
  private readonly raidVaultPercent: number;
  private readonly log: GameLogger;

  private readonly stats: OrchestratorStats = {
    totalDiscoveries: 0,
    totalYieldDistributed: 0,
    totalFinderYield: 0,
    totalRefineryYield: 0,
    lastDistribution: null,
  };

  constructor(config: YieldOrchestratorConfig) {
    this.distribution = config.distribution;
    this.registry = config.registry;
    this.stakeManager = config.stakeManager;
    this.chainEnabled = config.chainEnabled ?? false;
    this.onYieldPayout = config.onYieldPayout;
    this.resourceMultipliers = config.resourceMultipliers ?? DEFAULT_RESOURCE_MULTIPLIERS;
    this.baseYieldPerDiscovery = config.baseYieldPerDiscovery ?? YIELD_CONFIG.BASE_YIELD_PER_DISCOVERY;
    this.random = config.random ?? Math.random;
    this.tokenSymbol = config.tokenSymbol ?? '$ASTROID';
    this.governor = config.governor;
    this.raidVault = config.raidVault;
    this.raidVaultPercent = config.raidVaultPercent ?? YIELD_CONFIG.RAID_VAULT_PERCENT;
    this.log = config.logger ?? defaultLogger();
  }

  // --------- Yield calculation ---------

  /**
   * Compute the total yield for a discovery on the given asteroid.
   * Formula (preserved from BG):
   *
   *   yield = floor(BASE × resourceMultiplier × asteroidMultiplier × variance)
   *
   * `asteroidMultiplier` comes from `AsteroidDefinition.baseRewardMultiplier`
   * — astroid.club's per-asteroid tuning knob. BG only had the resource
   * multiplier; we stack the asteroid one on top for finer balance.
   *
   * Returns `BASE_YIELD_PER_DISCOVERY` when the asteroid is unknown
   * (BG's fallback behaviour).
   */
  calculateDiscoveryYield(asteroidId: string): number {
    const asteroid = this.registry.getAsteroid(asteroidId);
    if (!asteroid) return this.baseYieldPerDiscovery;

    const definition = asteroid.definition as AsteroidDefinition;
    const resourceMultiplier = this.resourceMultipliers[definition.resource] ?? 1.0;
    const asteroidMultiplier = definition.baseRewardMultiplier ?? 1.0;
    const variance = 1 + (this.random() * 2 - 1) * YIELD_CONFIG.YIELD_VARIANCE;
    // Active meteor-strike penalty (1.0 when none) reduces in-progress yield.
    const meteorMultiplier = this.registry.getMeteorYieldMultiplier?.(asteroidId) ?? 1.0;
    return Math.floor(
      this.baseYieldPerDiscovery *
        resourceMultiplier *
        asteroidMultiplier *
        meteorMultiplier *
        variance,
    );
  }

  // --------- Discovery flow ---------

  /**
   * Process a discovery: roll the total yield, credit the 30%
   * refinery share, and split the 70% miner pool either share-based
   * (when `shares` provided) or 100% to finder (BG legacy fallback).
   * Finder gets a configurable bonus on TOP of their base share.
   *
   * Payouts route through the chain callback when `chainEnabled` is
   * true, otherwise through `stakeManager.addPendingYield`.
   *
   * `discoveryNumber` is informational (used in log lines and chain
   * memos when wired).
   */
  processDiscovery(args: {
    asteroidId: string;
    finderWallet: string;
    discoveryNumber: number;
    shares?: MinerShareInfo[];
    finderBonusPercent?: number;
  }): DiscoveryOutcome {
    const grossYield = this.calculateDiscoveryYield(args.asteroidId);

    // Emission governor: taper issuance as the outstanding redeemable
    // liability approaches the treasury backing (and/or a daily cap). Scaling
    // the TOTAL before the split keeps the 70/30 ratio intact.
    let totalYield = grossYield;
    if (this.governor?.enabled) {
      const outstanding = this.stakeManager.getOutstandingCredits?.() ?? 0;
      totalYield = this.governor.apply(grossYield, outstanding);
      if (totalYield < grossYield) {
        this.log.info(
          `[YieldOrchestrator] Emission governor scaled discovery yield ` +
            `${grossYield} → ${totalYield} ${this.tokenSymbol} (outstanding=${outstanding})`,
        );
      }
    }

    // Fully throttled: record nothing, distribute nothing. The discovery
    // still "happened" (the seed is consumed) but issues no new credits.
    if (totalYield <= 0) {
      this.stats.totalDiscoveries++;
      return {
        success: true,
        finderYield: 0,
        refineryYield: 0,
        vaultYield: 0,
        totalYield: 0,
        minerPayouts: [],
      };
    }

    // Split the discovery. Two models:
    //   - Vault mode (raidVault wired): a small persistent cut to the raidable
    //     vault; the rest is paid to miners per-discovery. No hourly pool, so
    //     the displayed treasury never silently drains.
    //   - Legacy mode: 70% miner pool + 30% hourly refinery.
    let refineryYield = 0;
    let vaultYield = 0;
    let minerPoolYield: number;

    if (this.raidVault) {
      vaultYield = Math.floor((totalYield * this.raidVaultPercent) / 100);
      minerPoolYield = totalYield - vaultYield;
      if (vaultYield > 0) {
        this.raidVault.add(args.asteroidId, vaultYield);
        this.stats.totalRefineryYield += vaultYield;
      }
    } else {
      refineryYield = Math.floor((totalYield * YIELD_CONFIG.REFINERY_SHARE_PERCENT) / 100);
      minerPoolYield = totalYield - refineryYield;
      // Credit the 30% to the refinery (also returns the BG-style split).
      this.distribution.handleDiscovery(args.asteroidId, totalYield);
      this.stats.totalRefineryYield += refineryYield;
    }

    const minerPayouts: MinerPayout[] = [];
    const bonusPercent = args.finderBonusPercent ?? YIELD_CONFIG.FINDER_BONUS_PERCENT;

    if (args.shares && args.shares.length > 0) {
      this.log.info(
        `[YieldOrchestrator] Share-based distribution to ${args.shares.length} miners ` +
          `(asteroid=${args.asteroidId}, total=${totalYield} ${this.tokenSymbol})`,
      );
      for (const share of args.shares) {
        const baseShare = Math.floor((minerPoolYield * share.sharePercent) / 100);
        const isFinder = share.walletAddress === args.finderWallet;
        const bonus = isFinder ? Math.floor((baseShare * bonusPercent) / 100) : 0;
        const amount = baseShare + bonus;
        if (amount > 0) {
          minerPayouts.push({ wallet: share.walletAddress, amount, isFinder });
        }
      }
    } else {
      // BG fallback: no shares means 100% to finder.
      this.log.info('[YieldOrchestrator] No shares supplied; legacy 100%-to-finder distribution');
      minerPayouts.push({
        wallet: args.finderWallet,
        amount: minerPoolYield,
        isFinder: true,
      });
    }

    for (const payout of minerPayouts) {
      this.routePayout(args.asteroidId, payout.wallet, payout.amount);
      this.stats.totalFinderYield += payout.amount;
      this.stats.totalYieldDistributed += payout.amount;
    }

    this.stats.totalDiscoveries++;
    this.governor?.record(totalYield);

    const finderPayout = minerPayouts.find((p) => p.isFinder);
    return {
      success: true,
      finderYield: finderPayout?.amount ?? 0,
      refineryYield,
      vaultYield,
      totalYield,
      minerPayouts,
    };
  }

  // --------- Manual triggers ---------

  /** Force the hourly refinery distribution. Returns delegate result. */
  forceHourlyDistribution(): ReturnType<DistributionService['performDistribution']> {
    this.log.info('[YieldOrchestrator] Forcing hourly distribution...');
    const result = this.distribution.performDistribution();
    if (result.length > 0) this.stats.lastDistribution = new Date();
    return result;
  }

  /**
   * Wire the orchestrator to the distribution service's
   * `onDistribution` listener so we can stamp `lastDistribution`
   * automatically. Call once at boot. Idempotent if called twice
   * (the second call wins).
   */
  attachDistributionListener(): void {
    this.distribution.setOnDistribution((results) => {
      if (results.length > 0) this.stats.lastDistribution = new Date();
      this.log.info(
        `[YieldOrchestrator] Hourly distribution completed for ${results.length} asteroids`,
      );
    });
  }

  // --------- Stats ---------

  getStats(): OrchestratorStats {
    return { ...this.stats };
  }

  /**
   * Emission governor health (scale, headroom, daily issuance), or null when
   * no governor is wired. Surfaced in the admin console.
   */
  getEmissionStatus(): EmissionStatus | null {
    if (!this.governor) return null;
    const outstanding = this.stakeManager.getOutstandingCredits?.() ?? 0;
    return this.governor.getStatus(outstanding);
  }

  // --------- Internal ---------

  /**
   * Route a single payout. Centralizes the chain-vs-no-chain decision
   * so both the share path and the legacy fallback go through the
   * same hook. When `chainEnabled` is true and the callback is
   * registered, fire it; otherwise credit pending yield.
   */
  private routePayout(asteroidId: string, walletAddress: string, amount: number): void {
    if (this.chainEnabled) {
      if (this.onYieldPayout) {
        this.onYieldPayout(walletAddress, amount, asteroidId);
      }
      return;
    }
    this.stakeManager.addPendingYield(walletAddress, asteroidId, amount);
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
