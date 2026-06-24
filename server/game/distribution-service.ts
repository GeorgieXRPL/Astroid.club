/**
 * Distribution service for astroid.club.
 *
 * Ported from `Black-Gold-main/server/game/distribution-service.ts`
 * per `docs/PORTING_NOTES.md`. Schedules contribution-tracking ticks
 * and hourly refinery distributions, fans out payouts either to the
 * in-memory pending-yield ledger (when CHAIN_ENABLED=false) or to a
 * registered chain callback (when CHAIN_ENABLED=true).
 *
 * Architectural changes vs. BG:
 *
 * 1. **Class instead of free functions + module-level state.** BG
 *    used a free-function module with a hidden singleton state
 *    object. astroid.club packages everything into a class so
 *    multiple game worlds can run independently and tests can
 *    construct fresh instances per case.
 *
 * 2. **Explicit CHAIN_ENABLED gating.** BG always called the
 *    registered `onRewardPayout` callback. astroid.club inspects an
 *    explicit `chainEnabled` flag:
 *      - `chainEnabled: true`  → fire `onYieldPayout` callback per
 *        payout. Boot layer is expected to wire a real SPL transfer.
 *      - `chainEnabled: false` → skip the callback and call
 *        `stakeManager.addPendingYield(wallet, asteroidId, amount)`.
 *        Users `claimPendingYield()` later via a separate route.
 *    This keeps the code paths intact (BG-equivalent) while
 *    completely disabling on-chain side effects when chain is off.
 *
 * 3. **Resource-explicit miner state.** The contribution updater takes
 *    a `ResourceType` (rather than a boolean flag) and passes it
 *    through to the refinery (already done in the
 *    refinery slice).
 *
 * Theme renames per glossary:
 *
 * - `vaultManager` → `refinery` (the `RefineryManager` instance)
 * - `mineId` → `asteroidId`
 * - `currentHashrate` → `currentDrillPower`
 * - `VaultDistributionResult` → `RefineryDistributionResult`
 * - `getMinerPendingReward` → `getMinerPendingYield`
 * - `handleDiscovery` returns `{ finderShare, refineryShare }`
 * - `onRewardPayout` → `onYieldPayout`
 */

import type { ResourceType } from '../../config/asteroids.js';

import type { GameLogger, StakeManagerLike } from './interfaces.js';
import type { RefineryManager, YieldSplit } from './refinery-manager.js';
import type { RefineryDistributionResult } from './types.js';

/** Default contribution tick cadence — preserved from BG. */
const DEFAULT_TICK_INTERVAL_MS = 30 * 1000;
/** Default cadence for the "should we distribute now?" check — preserved. */
const DEFAULT_DISTRIBUTION_CHECK_INTERVAL_MS = 60 * 1000;

/** A miner the service is currently tracking for hourly contribution scoring. */
export interface ActiveMiner {
  walletAddress: string;
  asteroidId: string;
  /** Drill power in current units. */
  currentDrillPower: number;
  stakeAmount: number;
  loyaltyDays: number;
  resource: ResourceType;
  /** Last time `tickContributions` rolled this miner forward. */
  lastUpdate: Date;
}

/** Subset of `ActiveMiner` that callers can pass to `updateMinerStats`. */
export interface ActiveMinerUpdate {
  drillPower?: number;
  stakeAmount?: number;
  loyaltyDays?: number;
  asteroidId?: string;
  resource?: ResourceType;
}

/** Callback fired once per `performDistribution()` invocation. */
export type DistributionListener = (results: RefineryDistributionResult[]) => void;
/** Callback fired per payout; only invoked when `chainEnabled === true`. */
export type YieldPayoutListener = (
  walletAddress: string,
  amount: number,
  asteroidId: string,
) => void;

export interface DistributionServiceConfig {
  refinery: RefineryManager;
  stakeManager: StakeManagerLike;
  /**
   * When `true`, payouts are routed to the registered
   * `onYieldPayout` callback (boot layer should wire it to a real
   * SPL transfer). When `false` (the default), payouts are credited
   * to `stakeManager.addPendingYield` and the callback is skipped.
   */
  chainEnabled?: boolean;
  /** Defaults to 30 seconds (BG cadence). */
  tickIntervalMs?: number;
  /** Defaults to 60 seconds (BG cadence). */
  distributionCheckIntervalMs?: number;
  onDistribution?: DistributionListener;
  onYieldPayout?: YieldPayoutListener;
  logger?: GameLogger;
}

/**
 * Tracks active miners, rolls contribution snapshots into the refinery
 * every tick, and triggers `RefineryManager.distributeAllRefineries()`
 * once per `shouldDistribute()` window.
 *
 * The class doesn't own its own clock or timers by default — call
 * `start()` to spin up the intervals, or call `tickContributions()`
 * and `performDistribution()` manually from tests / the engine loop.
 */
export class DistributionService {
  private readonly refinery: RefineryManager;
  private readonly stakeManager: StakeManagerLike;
  private readonly chainEnabled: boolean;
  private readonly tickIntervalMs: number;
  private readonly distributionCheckIntervalMs: number;
  private readonly log: GameLogger;
  private onDistribution?: DistributionListener;
  private onYieldPayout?: YieldPayoutListener;

  private readonly activeMiners: Map<string, ActiveMiner> = new Map();
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private checkHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: DistributionServiceConfig) {
    this.refinery = config.refinery;
    this.stakeManager = config.stakeManager;
    this.chainEnabled = config.chainEnabled ?? false;
    this.tickIntervalMs = config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.distributionCheckIntervalMs =
      config.distributionCheckIntervalMs ?? DEFAULT_DISTRIBUTION_CHECK_INTERVAL_MS;
    this.onDistribution = config.onDistribution;
    this.onYieldPayout = config.onYieldPayout;
    this.log = config.logger ?? defaultLogger();
  }

  // --------- Lifecycle ---------

  /**
   * Spin up the tick + distribution-check intervals. Idempotent — a
   * second call while running logs and no-ops. Use `stop()` to tear
   * down.
   */
  start(): void {
    if (this.running) {
      this.log.info('[DistributionService] Already running');
      return;
    }
    this.tickHandle = setInterval(() => {
      this.tickContributions();
    }, this.tickIntervalMs);

    this.checkHandle = setInterval(() => {
      if (this.refinery.shouldDistribute()) {
        this.performDistribution();
      }
    }, this.distributionCheckIntervalMs);

    this.running = true;
    this.log.info(
      `[DistributionService] Started - contributions every ${this.tickIntervalMs / 1000}s, ` +
        `distribution checked every ${this.distributionCheckIntervalMs / 1000}s, ` +
        `chainEnabled=${this.chainEnabled}`,
    );
  }

  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.checkHandle) {
      clearInterval(this.checkHandle);
      this.checkHandle = null;
    }
    this.running = false;
    this.log.info('[DistributionService] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // --------- Active miner registry ---------

  /**
   * Track a miner. Subsequent `tickContributions()` calls will roll
   * their drill-power-seconds into the refinery's hourly pool.
   */
  registerActiveMiner(
    walletAddress: string,
    asteroidId: string,
    resource: ResourceType,
    drillPower = 0,
    stakeAmount = 0,
    loyaltyDays = 0,
  ): void {
    this.activeMiners.set(walletAddress, {
      walletAddress,
      asteroidId,
      currentDrillPower: drillPower,
      stakeAmount,
      loyaltyDays,
      resource,
      lastUpdate: new Date(),
    });
  }

  unregisterActiveMiner(walletAddress: string): void {
    this.activeMiners.delete(walletAddress);
  }

  /**
   * Patch the recorded stats for a miner. Used when drill power
   * changes (e.g. stake adjusted, buff applied). Silently no-ops if
   * the miner isn't currently registered.
   */
  updateMinerStats(walletAddress: string, updates: ActiveMinerUpdate): void {
    const miner = this.activeMiners.get(walletAddress);
    if (!miner) return;
    if (updates.drillPower !== undefined) miner.currentDrillPower = updates.drillPower;
    if (updates.stakeAmount !== undefined) miner.stakeAmount = updates.stakeAmount;
    if (updates.loyaltyDays !== undefined) miner.loyaltyDays = updates.loyaltyDays;
    if (updates.asteroidId !== undefined) miner.asteroidId = updates.asteroidId;
    if (updates.resource !== undefined) miner.resource = updates.resource;
    miner.lastUpdate = new Date();
  }

  getActiveMinerCount(): number {
    return this.activeMiners.size;
  }

  getActiveMiner(walletAddress: string): ActiveMiner | undefined {
    return this.activeMiners.get(walletAddress);
  }

  /**
   * Snapshot of every tracked active miner. Read-only view used by the
   * discovery engine to compute per-asteroid drill power and finder
   * shares. Returns fresh copies so callers can't mutate internal state.
   */
  getActiveMiners(): ActiveMiner[] {
    return Array.from(this.activeMiners.values(), (m) => ({ ...m }));
  }

  // --------- Tick + distribute ---------

  /**
   * Roll every tracked miner's elapsed-time contribution into the
   * refinery. Skips miners with `< 1` second since last update
   * (preserved BG behaviour to avoid noise on rapid tick storms).
   */
  tickContributions(): void {
    const now = new Date();
    for (const miner of this.activeMiners.values()) {
      const deltaMs = now.getTime() - miner.lastUpdate.getTime();
      const deltaSeconds = deltaMs / 1000;
      if (deltaSeconds < 1) continue;
      this.refinery.updateMinerContribution({
        asteroidId: miner.asteroidId,
        walletAddress: miner.walletAddress,
        currentDrillPower: miner.currentDrillPower,
        stakeAmount: miner.stakeAmount,
        loyaltyDays: miner.loyaltyDays,
        resource: miner.resource,
        deltaSeconds,
      });
      miner.lastUpdate = now;
    }
  }

  /**
   * Run the hourly distribution. Returns the per-asteroid results.
   * For each payout entry: when chain is enabled, fires
   * `onYieldPayout`; when disabled, credits `stakeManager.addPendingYield`.
   * Always fires `onDistribution(results)` if a listener is set and
   * any results came back.
   */
  performDistribution(): RefineryDistributionResult[] {
    this.log.info('[DistributionService] Running hourly distribution...');
    const results = this.refinery.distributeAllRefineries();

    for (const result of results) {
      for (const [wallet, amount] of result.payouts.entries()) {
        if (this.chainEnabled) {
          if (this.onYieldPayout) {
            this.onYieldPayout(wallet, amount, result.asteroidId);
          }
        } else {
          this.stakeManager.addPendingYield(wallet, result.asteroidId, amount);
        }
      }
    }

    if (this.onDistribution && results.length > 0) {
      this.onDistribution(results);
    }
    this.log.info(`[DistributionService] Completed ${results.length} asteroid distributions`);
    return results;
  }

  /** Alias for `performDistribution` — kept for parity with BG's API. */
  forceDistribution(): RefineryDistributionResult[] {
    return this.performDistribution();
  }

  /**
   * Credit the discovery's 30% share to the asteroid's refinery and
   * return the 70/30 split. The 70% finder share is the caller's
   * responsibility (raid-engine / expedition-tracker handles it).
   */
  handleDiscovery(asteroidId: string, totalYield: number): YieldSplit {
    const split = this.refinery.calculateYieldSplit(totalYield);
    if (split.refineryShare > 0) {
      this.refinery.addToRefinery(asteroidId, split.refineryShare);
    }
    return split;
  }

  // --------- Inspection helpers ---------

  /** Snapshot stats for an asteroid's refinery (delegates to the manager). */
  getDistributionStats(asteroidId: string): ReturnType<RefineryManager['getRefineryStats']> {
    return this.refinery.getRefineryStats(asteroidId);
  }

  /**
   * Estimated payout share for a wallet on the given asteroid if
   * distribution happened right now (delegates to the manager).
   */
  getMinerPendingYield(
    asteroidId: string,
    walletAddress: string,
  ): ReturnType<RefineryManager['getMinerPendingShare']> {
    return this.refinery.getMinerPendingShare(asteroidId, walletAddress);
  }

  // --------- Listener wiring ---------

  setOnDistribution(listener: DistributionListener | undefined): void {
    this.onDistribution = listener;
  }

  setOnYieldPayout(listener: YieldPayoutListener | undefined): void {
    this.onYieldPayout = listener;
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
