/**
 * Expedition tracker for astroid.club.
 *
 * Ported from `Black-Gold-main/server/game/expedition-tracker.ts` per
 * `docs/PORTING_NOTES.md`. Lifecycle, validation, and state transitions
 * are byte-identical to BG. Theme renames applied throughout (mineId →
 * asteroidId, hashrate → drillPower, homeBaseMineId → homeStationAsteroidId).
 *
 * Architectural changes:
 *
 * 1. **Dependency injection.** BG used module-level singletons via
 *    `getMineRegistry()` / `getStakeManager()` / `getCooldownManager()`.
 *    `ExpeditionTracker` now takes its dependencies through the
 *    constructor as narrow `*Like` interfaces.
 *
 * 2. **Injectable logger.** BG used `console.log` directly. The default
 *    is still `console`; tests can pass a silent logger.
 *
 * Implements `ExpeditionTrackerLike` so `RaidEngine` and other consumers
 * can depend on the narrow interface rather than the concrete class.
 */

import { v4 as uuidv4 } from 'uuid';

import type {
  AsteroidRegistryLike,
  CooldownManagerLike,
  ExpeditionTrackerLike,
  GameLogger,
  StakeManagerLike,
} from './interfaces.js';
import type { Expedition } from './types.js';
import { calculateAttackPower } from './types.js';

/**
 * Default maximum expedition duration in milliseconds. A raid normally resolves
 * the moment the target makes a discovery (so defenders get a rally window);
 * this is the *fallback* so a raid on an idle target still settles. Softened
 * from BG's 2 hours to 10 minutes so raids never hang with no payoff. Tunable
 * per-deployment via `ExpeditionTrackerConfig.maxDurationMs`.
 */
const MAX_EXPEDITION_DURATION_MS = 10 * 60 * 1000;

/** Cleanup window for completed/failed expeditions (1 hour). Preserved from BG. */
const CLEANUP_OLDER_THAN_MS = 60 * 60 * 1000;

/** Configuration accepted by the expedition tracker. */
export interface ExpeditionTrackerConfig {
  registry: AsteroidRegistryLike;
  stakeManager: StakeManagerLike;
  cooldownManager: CooldownManagerLike;
  /**
   * Fallback max raid duration in ms (idle targets settle after this even with
   * no discovery). Defaults to {@link MAX_EXPEDITION_DURATION_MS} (10 min).
   */
  maxDurationMs?: number;
  logger?: GameLogger;
}

/** Status counts returned by `getStats()`. */
export interface ExpeditionStats {
  active: number;
  completed: number;
  failed: number;
}

/**
 * Manages expedition lifecycle from creation to resolution.
 *
 * An expedition models a raid group on its way from a source asteroid to
 * a target. Each attacker can only be on one expedition at a time. Bets
 * are processed up-front (escrow); cooldowns are applied on start and
 * recovery.
 */
export class ExpeditionTracker implements ExpeditionTrackerLike {
  private readonly registry: AsteroidRegistryLike;
  private readonly stakeManager: StakeManagerLike;
  private readonly cooldownManager: CooldownManagerLike;
  private readonly maxDurationMs: number;
  private readonly log: GameLogger;

  /** Active expeditions by ID. */
  private readonly expeditions: Map<string, Expedition> = new Map();

  /** Reverse index: which expedition an attacker is currently on. */
  private readonly attackerExpeditions: Map<string, string> = new Map();

  constructor(config: ExpeditionTrackerConfig) {
    this.registry = config.registry;
    this.stakeManager = config.stakeManager;
    this.cooldownManager = config.cooldownManager;
    this.maxDurationMs = config.maxDurationMs ?? MAX_EXPEDITION_DURATION_MS;
    this.log = config.logger ?? defaultLogger();
  }

  /**
   * Create a new expedition launched by `attackerWallet` from
   * `sourceAsteroidId` against `targetAsteroidId`. Returns null on any
   * validation failure (BG-compatible: same error log lines, same return
   * signal). When `betAmount > 0`, the bet is processed via the stake
   * manager and stored on the expedition.
   */
  createExpedition(
    attackerWallet: string,
    sourceAsteroidId: string,
    targetAsteroidId: string,
    attackerDrillPower: number,
    betAmount: number = 0,
  ): Expedition | null {
    const sourceAsteroid = this.registry.getAsteroid(sourceAsteroidId);
    if (!sourceAsteroid) {
      this.log.info(`[ExpeditionTracker] Source asteroid ${sourceAsteroidId} not found`);
      return null;
    }

    const targetAsteroid = this.registry.getAsteroid(targetAsteroidId);
    if (!targetAsteroid) {
      this.log.info(`[ExpeditionTracker] Target asteroid ${targetAsteroidId} not found`);
      return null;
    }

    if (sourceAsteroidId === targetAsteroidId) {
      this.log.info(`[ExpeditionTracker] Cannot raid your own asteroid`);
      return null;
    }

    const cooldownError = this.cooldownManager.checkAction(attackerWallet, 'expedition_start');
    if (cooldownError) {
      this.log.info(`[ExpeditionTracker] ${cooldownError}`);
      return null;
    }

    const recoveryError = this.cooldownManager.checkAction(attackerWallet, 'expedition_recovery');
    if (recoveryError) {
      this.log.info(`[ExpeditionTracker] ${recoveryError}`);
      return null;
    }

    if (this.attackerExpeditions.has(attackerWallet)) {
      this.log.info(`[ExpeditionTracker] ${attackerWallet} already on expedition`);
      return null;
    }

    if (this.registry.hasRaidImmunity(targetAsteroidId)) {
      this.log.info(`[ExpeditionTracker] ${targetAsteroid.definition.name} has raid immunity`);
      return null;
    }

    if (betAmount > 0) {
      const ok = this.stakeManager.processBet(attackerWallet, sourceAsteroidId, betAmount);
      if (!ok) {
        this.log.info(`[ExpeditionTracker] Bet processing failed for ${attackerWallet}`);
        return null;
      }
    }

    const stakeAmount = this.stakeManager.getStakeAtAsteroid(attackerWallet, sourceAsteroidId);
    const attackPower = calculateAttackPower(attackerDrillPower, stakeAmount);

    const now = new Date();
    const expedition: Expedition = {
      id: uuidv4(),
      attackers: [attackerWallet],
      sourceAsteroidId,
      targetAsteroidId,
      startedAt: now,
      expiresAt: new Date(now.getTime() + this.maxDurationMs),
      status: 'active',
      bets: new Map([[attackerWallet, betAmount]]),
      attackPower,
    };

    this.expeditions.set(expedition.id, expedition);
    this.attackerExpeditions.set(attackerWallet, expedition.id);

    this.registry.addIncomingRaid(targetAsteroidId, expedition.id);
    this.cooldownManager.applyCooldown(attackerWallet, 'expedition_start');

    // Update miner state in-place — BG's pattern. Note: this mutates the
    // object owned by the stake manager and assumes the stake manager
    // holds a stable reference; we preserve the convention here.
    const minerState = this.stakeManager.getMinerState(attackerWallet);
    minerState.currentExpeditionId = expedition.id;
    minerState.activeAsteroidId = targetAsteroidId;

    this.log.info(
      `[ExpeditionTracker] Expedition ${expedition.id} created: ` +
        `${sourceAsteroid.definition.name} -> ${targetAsteroid.definition.name} ` +
        `(Attack Power: ${attackPower.toFixed(2)}, Bet: ${betAmount})`,
    );

    return expedition;
  }

  /**
   * Join an existing expedition. Same validation surface as BG: must be
   * 'active', wallet must not already be on an expedition, must pass the
   * `expedition_start` cooldown check (NOT `expedition_recovery` — BG
   * skips that on join, preserved here as intentional behaviour).
   */
  joinExpedition(
    expeditionId: string,
    attackerWallet: string,
    attackerDrillPower: number,
    betAmount: number = 0,
  ): boolean {
    const expedition = this.expeditions.get(expeditionId);
    if (!expedition || expedition.status !== 'active') {
      this.log.info(`[ExpeditionTracker] Expedition ${expeditionId} not found or not active`);
      return false;
    }

    if (this.attackerExpeditions.has(attackerWallet)) {
      this.log.info(`[ExpeditionTracker] ${attackerWallet} already on expedition`);
      return false;
    }

    const cooldownError = this.cooldownManager.checkAction(attackerWallet, 'expedition_start');
    if (cooldownError) {
      this.log.info(`[ExpeditionTracker] ${cooldownError}`);
      return false;
    }

    if (betAmount > 0) {
      const ok = this.stakeManager.processBet(
        attackerWallet,
        expedition.sourceAsteroidId,
        betAmount,
      );
      if (!ok) {
        return false;
      }
    }

    const stakeAmount = this.stakeManager.getStakeAtAsteroid(
      attackerWallet,
      expedition.sourceAsteroidId,
    );
    const additionalPower = calculateAttackPower(attackerDrillPower, stakeAmount);

    expedition.attackers.push(attackerWallet);
    expedition.bets.set(attackerWallet, betAmount);
    expedition.attackPower += additionalPower;

    this.attackerExpeditions.set(attackerWallet, expeditionId);
    this.cooldownManager.applyCooldown(attackerWallet, 'expedition_start');

    const minerState = this.stakeManager.getMinerState(attackerWallet);
    minerState.currentExpeditionId = expeditionId;
    minerState.activeAsteroidId = expedition.targetAsteroidId;

    this.log.info(
      `[ExpeditionTracker] ${attackerWallet} joined expedition ${expeditionId} ` +
        `(+${additionalPower.toFixed(2)} power, total: ${expedition.attackPower.toFixed(2)})`,
    );

    return true;
  }

  /** Look up an expedition by ID (also implements `ExpeditionTrackerLike`). */
  getExpedition(expeditionId: string): Expedition | undefined {
    return this.expeditions.get(expeditionId);
  }

  /** The expedition the wallet is currently on, if any. */
  getAttackerExpedition(walletAddress: string): Expedition | undefined {
    const expeditionId = this.attackerExpeditions.get(walletAddress);
    if (!expeditionId) return undefined;
    return this.expeditions.get(expeditionId);
  }

  /** All currently-active or returning expeditions. */
  getActiveExpeditions(): Expedition[] {
    return Array.from(this.expeditions.values()).filter((e) => e.status === 'active');
  }

  /** Active expeditions targeting a given asteroid (for raid resolution). */
  getExpeditionsTargeting(asteroidId: string): Expedition[] {
    return Array.from(this.expeditions.values()).filter(
      (e) => e.targetAsteroidId === asteroidId && e.status === 'active',
    );
  }

  /** Mark an expedition as 'returning' and route attackers home. */
  startReturn(expeditionId: string): void {
    const expedition = this.expeditions.get(expeditionId);
    if (!expedition) return;

    expedition.status = 'returning';

    for (const attacker of expedition.attackers) {
      const minerState = this.stakeManager.getMinerState(attacker);
      minerState.activeAsteroidId = expedition.sourceAsteroidId;
    }

    this.log.info(`[ExpeditionTracker] Expedition ${expeditionId} returning to base`);
  }

  /**
   * Mark an expedition complete. Same status convention as BG:
   * `'completed'` if attackers won, `'failed'` if defenders won. Recovery
   * cooldowns are applied to every attacker; miner state is reset back
   * to home station.
   */
  completeExpedition(expeditionId: string, success: boolean): void {
    const expedition = this.expeditions.get(expeditionId);
    if (!expedition) return;

    expedition.status = success ? 'completed' : 'failed';

    this.registry.removeIncomingRaid(expedition.targetAsteroidId, expeditionId);

    for (const attacker of expedition.attackers) {
      this.attackerExpeditions.delete(attacker);
      this.cooldownManager.applyCooldown(attacker, 'expedition_recovery');

      const minerState = this.stakeManager.getMinerState(attacker);
      minerState.currentExpeditionId = null;
      minerState.activeAsteroidId = minerState.homeStationAsteroidId;
    }

    this.log.info(
      `[ExpeditionTracker] Expedition ${expeditionId} ${success ? 'succeeded' : 'failed'}`,
    );
  }

  /**
   * An attacker leaves the expedition early. Their bet is forfeited
   * (burned via the stake manager). If no attackers remain, the
   * expedition is cancelled and removed entirely.
   */
  leaveExpedition(walletAddress: string): boolean {
    const expeditionId = this.attackerExpeditions.get(walletAddress);
    if (!expeditionId) return false;

    const expedition = this.expeditions.get(expeditionId);
    if (!expedition) return false;

    const index = expedition.attackers.indexOf(walletAddress);
    if (index >= 0) {
      expedition.attackers.splice(index, 1);
    }

    const bet = expedition.bets.get(walletAddress) ?? 0;
    if (bet > 0) {
      this.stakeManager.burnBet(walletAddress, expedition.sourceAsteroidId, bet);
    }
    expedition.bets.delete(walletAddress);

    this.attackerExpeditions.delete(walletAddress);

    if (expedition.attackers.length === 0) {
      this.registry.removeIncomingRaid(expedition.targetAsteroidId, expeditionId);
      this.expeditions.delete(expeditionId);
      this.log.info(`[ExpeditionTracker] Expedition ${expeditionId} cancelled (no attackers)`);
    }

    this.cooldownManager.applyCooldown(walletAddress, 'expedition_recovery');

    const minerState = this.stakeManager.getMinerState(walletAddress);
    minerState.currentExpeditionId = null;
    minerState.activeAsteroidId = minerState.homeStationAsteroidId;

    this.log.info(`[ExpeditionTracker] ${walletAddress} left expedition ${expeditionId}`);
    return true;
  }

  /** Active expeditions that have passed their `expiresAt` time. */
  checkExpiredExpeditions(): Expedition[] {
    const now = new Date();
    const expired: Expedition[] = [];
    for (const expedition of this.expeditions.values()) {
      if (expedition.status === 'active' && now >= expedition.expiresAt) {
        expired.push(expedition);
      }
    }
    return expired;
  }

  /** Total incoming attack power against an asteroid (active raids only). */
  getTotalAttackPower(asteroidId: string): number {
    let total = 0;
    for (const expedition of this.getExpeditionsTargeting(asteroidId)) {
      total += expedition.attackPower;
    }
    return total;
  }

  /** Status counts across all tracked expeditions. */
  getStats(): ExpeditionStats {
    let active = 0;
    let completed = 0;
    let failed = 0;

    for (const expedition of this.expeditions.values()) {
      switch (expedition.status) {
        case 'active':
        case 'returning':
          active++;
          break;
        case 'completed':
          completed++;
          break;
        case 'failed':
          failed++;
          break;
      }
    }

    return { active, completed, failed };
  }

  /** Drop completed/failed expeditions older than the cleanup window. */
  cleanup(): void {
    const cutoff = new Date(Date.now() - CLEANUP_OLDER_THAN_MS);
    let cleaned = 0;

    for (const [id, expedition] of this.expeditions) {
      const isResolved = expedition.status === 'completed' || expedition.status === 'failed';
      if (isResolved && expedition.expiresAt < cutoff) {
        this.expeditions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.log.info(`[ExpeditionTracker] Cleaned up ${cleaned} old expeditions`);
    }
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
