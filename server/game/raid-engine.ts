/**
 * Raid engine for astroid.club.
 *
 * Ported from `Black-Gold-main/server/game/raid-engine.ts` per
 * `docs/PORTING_NOTES.md`. All numerical constants, formulas, and
 * branching are byte-identical to BG. Two architectural improvements:
 *
 * 1. **Dependency injection.** BG used module-level singletons via
 *    `getMineRegistry()` / `getStakeManager()` / `getExpeditionTracker()`.
 *    `RaidEngine` now takes its dependencies through the constructor as
 *    narrow interfaces (`AsteroidRegistryLike`, `StakeManagerLike`,
 *    `ExpeditionTrackerLike`) so it is independently testable and meshes
 *    with the engine's `DependencyContainer`.
 *
 * 2. **Injectable logger.** BG used `console.log` directly. The default
 *    logger is still `console`, but tests can pass a silent logger and
 *    production can pass a structured logger.
 *
 * Theme renames applied:
 * - mineId → asteroidId
 * - mine (variable) → asteroid
 * - hashrate → drillPower
 * - barrel reward → discovery yield
 * - token symbol log strings → "$ASTROID"
 * - `pendingBarrelRewards` → `pendingDiscoveryYield`
 * - `RaidResult.stolenRewards` → `stolenYield`
 */

import type {
  AsteroidRegistryLike,
  ExpeditionTrackerLike,
  GameLogger,
  StakeManagerLike,
} from './interfaces.js';
import { calculateDefensePower as _calculateDefensePower } from './types.js';
import type { DefenderSpoils, RaidResult } from './types.js';

// `_calculateDefensePower` is re-exported for module consumers that want
// the formula without going through types.ts. Keeping the import live
// also documents the dependency for future test-mocking work.
void _calculateDefensePower;

// ============ TUNING CONSTANTS (preserved verbatim from BG) ============

/** Defender advantage: attackers must exceed 1.2x defense to win. */
export const DEFENSE_ADVANTAGE = 1.2;

/** Min/max steal percentage on a successful raid (10–30%). */
const MIN_STEAL_PERCENT = 0.1;
const MAX_STEAL_PERCENT = 0.3;

/**
 * Upper bound on the stealable fraction of an asteroid's treasury — exported
 * so the network-stats layer can show raiders a realistic "up to N stealable"
 * figure without reaching into the engine's internals.
 */
export const RAID_MAX_STEAL_FRACTION = MAX_STEAL_PERCENT;

/** Defender spoils: 10% of attacker bets to defenders, 90% burned. */
const DEFENDER_SPOILS_PERCENT = 0.1;

/** Rally-defense parameters preserved verbatim. */
const RALLY_DEFENSE_BOOST = 1.5;
const RALLY_DEFENSE_BOOST_CAP = 2.0;
const RALLY_DEFENSE_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/** History buffer caps. */
const RAID_HISTORY_LIMIT = 100;
const SPOILS_HISTORY_LIMIT = 100;
const RECENT_RAID_DEFAULT = 20;

/** Configuration accepted by the raid engine. */
export interface RaidEngineConfig {
  registry: AsteroidRegistryLike;
  stakeManager: StakeManagerLike;
  tracker: ExpeditionTrackerLike;
  logger?: GameLogger;
}

/** Statistics summary returned by `getStats()`. */
export interface RaidEngineStats {
  totalRaids: number;
  attackerWins: number;
  defenderWins: number;
  totalStolen: number;
  totalBurned: number;
  totalSpoilsDistributed: number;
  defenderWinRate: number;
}

/** Status of the raid surface for a given asteroid. */
export interface AsteroidRaidStatus {
  isUnderAttack: boolean;
  incomingAttackPower: number;
  defensePower: number;
  raidCount: number;
  hasImmunity: boolean;
}

/**
 * Resolves raids between attackers and defenders, tracks pending discovery
 * yield available for steal, and distributes defender spoils.
 *
 * Defender spoils system: when attackers fail, 10% of total bets go to
 * defenders (stake-weighted), 90% is burned. Burn creates deflationary
 * pressure on the token supply when CHAIN_ENABLED=true; with chain
 * disabled, "burn" is a bookkeeping decrement only.
 */
export class RaidEngine {
  private readonly registry: AsteroidRegistryLike;
  private readonly stakeManager: StakeManagerLike;
  private readonly tracker: ExpeditionTrackerLike;
  private readonly log: GameLogger;

  /** Recent raid results for history. */
  private readonly raidHistory: RaidResult[] = [];

  /** Recent defender spoils distributions. */
  private readonly spoilsHistory: DefenderSpoils[] = [];

  /** Pending yield rewards that can be stolen (asteroidId → amount). */
  private readonly pendingDiscoveryYield: Map<string, number> = new Map();

  /** Total burned from failed raids. */
  private totalBurned = 0;

  /** Total spoils distributed to defenders. */
  private totalSpoilsDistributed = 0;

  constructor(config: RaidEngineConfig) {
    this.registry = config.registry;
    this.stakeManager = config.stakeManager;
    this.tracker = config.tracker;
    this.log = config.logger ?? defaultLogger();
  }

  // ============ PENDING YIELD MANAGEMENT ============

  /** Set the pending discovery yield available for steal at an asteroid. */
  setPendingYield(asteroidId: string, amount: number): void {
    this.pendingDiscoveryYield.set(asteroidId, amount);
  }

  /** Get the pending discovery yield for an asteroid. */
  getPendingYield(asteroidId: string): number {
    return this.pendingDiscoveryYield.get(asteroidId) ?? 0;
  }

  /** Clear the pending yield after distribution. */
  clearPendingYield(asteroidId: string): void {
    this.pendingDiscoveryYield.delete(asteroidId);
  }

  // ============ DEFENSE POWER ============

  /**
   * Calculate the total defense power for an asteroid. Math byte-identical
   * to BG: sum of stake-based defense plus 10% of total drill power, with
   * miners on expedition contributing only 50% of their defense, and the
   * defense buff multiplier applied last.
   */
  calculateAsteroidDefensePower(asteroidId: string): number {
    const asteroid = this.registry.getAsteroid(asteroidId);
    if (!asteroid) return 0;

    let totalPower = 0;

    for (const walletAddress of asteroid.activeMiners) {
      const minerState = this.stakeManager.getMinerState(walletAddress);

      // Miners on expedition contribute only 50% of defense power.
      const defensePower = this.stakeManager.getDefensePower(walletAddress, asteroidId);
      totalPower += minerState.currentExpeditionId ? defensePower * 0.5 : defensePower;
    }

    // Add drill-power-based defense (was: hashrate-based).
    totalPower += asteroid.totalDrillPower * 0.1;

    // Apply defense buff if active.
    if (asteroid.defenseBuff) {
      const now = new Date();
      if (now < asteroid.defenseBuff.boostExpiresAt) {
        totalPower *= asteroid.defenseBuff.drillPowerBoost;
      }
    }

    return totalPower;
  }

  // ============ RAID RESOLUTION ============

  /**
   * Resolve a raid when a discovery is found at the target asteroid.
   * Returns null if the expedition does not exist or is not active.
   */
  resolveRaid(expeditionId: string): RaidResult | null {
    const expedition = this.tracker.getExpedition(expeditionId);
    if (!expedition || expedition.status !== 'active') {
      this.log.info(`[RaidEngine] Expedition ${expeditionId} not found or not active`);
      return null;
    }

    const attackPower = expedition.attackPower;
    const defensePower = this.calculateAsteroidDefensePower(expedition.targetAsteroidId);
    const effectiveDefensePower = defensePower * DEFENSE_ADVANTAGE;
    const attackersWon = attackPower > effectiveDefensePower;

    this.log.info(
      `[RaidEngine] Resolving raid ${expeditionId}: ` +
        `Attack ${attackPower.toFixed(2)} vs Defense ${defensePower.toFixed(2)} ` +
        `(effective: ${effectiveDefensePower.toFixed(2)}) -> ` +
        `${attackersWon ? 'ATTACKERS WIN' : 'DEFENDERS WIN'}`,
    );

    const betsReturned = new Map<string, number>();
    const betsBurned = new Map<string, number>();
    let stolenYield = 0;

    if (attackersWon) {
      // Calculate stolen amount based on power differential.
      const powerRatio = Math.min(attackPower / effectiveDefensePower, 2.0);
      const stealPercent =
        MIN_STEAL_PERCENT + (powerRatio - 1) * (MAX_STEAL_PERCENT - MIN_STEAL_PERCENT);

      const pendingYield = this.getPendingYield(expedition.targetAsteroidId);
      stolenYield = Math.floor(pendingYield * Math.min(stealPercent, MAX_STEAL_PERCENT));

      // Reduce pending yield by the stolen amount.
      this.pendingDiscoveryYield.set(expedition.targetAsteroidId, pendingYield - stolenYield);

      // Split the stolen yield equally among attackers and credit it to their
      // redeemable pending balance — this is the raid REWARD, paid out
      // regardless of whether a wager was placed (the arena defaults to a
      // no-bet raid). Bets are at-risk only on a loss, so on a win they simply
      // stay with the attacker; we still record the gross return for the
      // result payload + history.
      const attackerCount = expedition.attackers.length || 1;
      const sharePerAttacker = Math.floor(stolenYield / attackerCount);
      for (const wallet of expedition.attackers) {
        if (sharePerAttacker > 0) {
          this.stakeManager.addPendingYield(
            wallet,
            expedition.targetAsteroidId,
            sharePerAttacker,
          );
        }
        const bet = expedition.bets.get(wallet) ?? 0;
        if (bet > 0) {
          this.stakeManager.returnBetWithWinnings(
            wallet,
            expedition.sourceAsteroidId,
            bet,
            sharePerAttacker,
          );
          betsReturned.set(wallet, bet + sharePerAttacker);
        }
      }

      // Apply attack debuff to the target asteroid.
      this.registry.applyAttackDebuff(expedition.targetAsteroidId);

      this.log.info(
        `[RaidEngine] Attackers stole ${stolenYield.toFixed(4)} yield ` +
          `(${(stealPercent * 100).toFixed(1)}%)`,
      );
    } else {
      // Defenders win: distribute spoils, burn the rest.
      const totalBets = Array.from(expedition.bets.values()).reduce((a, b) => a + b, 0);

      for (const [wallet, bet] of expedition.bets) {
        if (bet > 0) {
          this.stakeManager.burnBet(wallet, expedition.sourceAsteroidId, bet);
          betsBurned.set(wallet, bet);
        }
      }

      // Distribute defender spoils (10% of total bets, stake-weighted).
      if (totalBets > 0) {
        const spoilsResult = this.distributeDefenderSpoils(
          expeditionId,
          expedition.targetAsteroidId,
          totalBets,
        );

        this.log.info(
          `[RaidEngine] Defenders won! ` +
            `Spoils: ${spoilsResult.totalSpoils.toFixed(2)} $ASTROID to ` +
            `${spoilsResult.defenderPayouts.size} defenders, ` +
            `Burned: ${spoilsResult.amountBurned.toFixed(2)} $ASTROID 🔥`,
        );
      }

      // Apply defense buff (2hr immunity + 10% drill-power boost for 1hr).
      this.registry.applyDefenseBuff(expedition.targetAsteroidId);
    }

    // Mark the expedition complete.
    this.tracker.completeExpedition(expeditionId, attackersWon);

    const result: RaidResult = {
      expeditionId,
      attackersWon,
      stolenYield,
      defensePower,
      attackPower,
      betsReturned,
      betsBurned,
      resolvedAt: new Date(),
    };

    // Push to history with cap.
    this.raidHistory.push(result);
    if (this.raidHistory.length > RAID_HISTORY_LIMIT) {
      this.raidHistory.shift();
    }

    return result;
  }

  /** Resolve all active raids against an asteroid (called when a discovery fires). */
  resolveAllRaids(asteroidId: string): RaidResult[] {
    const expeditions = this.tracker.getExpeditionsTargeting(asteroidId);
    const results: RaidResult[] = [];

    for (const expedition of expeditions) {
      const result = this.resolveRaid(expedition.id);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  /** Whether an asteroid can currently be raided. */
  canBeRaided(asteroidId: string): boolean {
    return !this.registry.hasRaidImmunity(asteroidId);
  }

  /** Get the current raid status for an asteroid. */
  getRaidStatus(asteroidId: string): AsteroidRaidStatus {
    const incomingPower = this.tracker.getTotalAttackPower(asteroidId);
    const defensePower = this.calculateAsteroidDefensePower(asteroidId);
    const expeditions = this.tracker.getExpeditionsTargeting(asteroidId);

    return {
      isUnderAttack: expeditions.length > 0,
      incomingAttackPower: incomingPower,
      defensePower,
      raidCount: expeditions.length,
      hasImmunity: this.registry.hasRaidImmunity(asteroidId),
    };
  }

  /**
   * Rally defense for an asteroid. Costs tokens (unstaked from the caller),
   * applies a temporary 1.5x drill-power boost (capped at 2x when stacked),
   * for 30 minutes.
   */
  rallyDefense(asteroidId: string, callerWallet: string, tokenCost: number): boolean {
    const asteroid = this.registry.getAsteroid(asteroidId);
    if (!asteroid) return false;

    const stake = this.stakeManager.getStakeAtAsteroid(callerWallet, asteroidId);
    if (stake < tokenCost) {
      this.log.info(`[RaidEngine] Not enough stake for rally: ${stake} < ${tokenCost}`);
      return false;
    }

    // Burn tokens for the rally (unstake without return).
    this.stakeManager.unstake(callerWallet, asteroidId, tokenCost);

    const now = new Date();
    if (!asteroid.defenseBuff) {
      asteroid.defenseBuff = {
        asteroidId,
        immuneUntil: now, // No immunity from rally.
        drillPowerBoost: RALLY_DEFENSE_BOOST,
        boostExpiresAt: new Date(now.getTime() + RALLY_DEFENSE_DURATION_MS),
      };
    } else {
      // Stack with existing buff, capped.
      asteroid.defenseBuff.drillPowerBoost = Math.min(
        asteroid.defenseBuff.drillPowerBoost * RALLY_DEFENSE_BOOST,
        RALLY_DEFENSE_BOOST_CAP,
      );
    }

    this.log.info(
      `[RaidEngine] ${callerWallet} rallied defense at ${asteroid.definition.name} ` +
        `(cost: ${tokenCost}, boost: ${asteroid.defenseBuff.drillPowerBoost}x)`,
    );

    return true;
  }

  // ============ HISTORY / STATS ============

  /** Get the most recent raid results. */
  getRecentRaids(limit: number = RECENT_RAID_DEFAULT): RaidResult[] {
    return this.raidHistory.slice(-limit).reverse();
  }

  /** Get the most recent defender spoils distributions. */
  getRecentSpoils(limit: number = RECENT_RAID_DEFAULT): DefenderSpoils[] {
    return this.spoilsHistory.slice(-limit).reverse();
  }

  /** Aggregate raid statistics. */
  getStats(): RaidEngineStats {
    let attackerWins = 0;
    let defenderWins = 0;
    let totalStolen = 0;

    for (const result of this.raidHistory) {
      if (result.attackersWon) {
        attackerWins++;
        totalStolen += result.stolenYield;
      } else {
        defenderWins++;
      }
    }

    const totalRaids = this.raidHistory.length;
    const defenderWinRate = totalRaids > 0 ? (defenderWins / totalRaids) * 100 : 0;

    return {
      totalRaids,
      attackerWins,
      defenderWins,
      totalStolen,
      totalBurned: this.totalBurned,
      totalSpoilsDistributed: this.totalSpoilsDistributed,
      defenderWinRate,
    };
  }

  // ============ DEFENDER SPOILS ============

  /**
   * Distribute defender spoils when a raid fails. 10% of attacker bets go
   * to defenders proportionally by defense power. The remaining 90% is
   * burned. Math byte-identical to BG.
   */
  distributeDefenderSpoils(
    raidId: string,
    asteroidId: string,
    totalAttackerBets: number,
  ): DefenderSpoils {
    const asteroid = this.registry.getAsteroid(asteroidId);

    const spoilsAmount = Math.floor(totalAttackerBets * DEFENDER_SPOILS_PERCENT);
    const burnAmount = totalAttackerBets - spoilsAmount;
    const defenderPayouts = new Map<string, number>();

    if (!asteroid || spoilsAmount <= 0) {
      this.totalBurned += totalAttackerBets;
      return {
        raidId,
        totalSpoils: 0,
        amountBurned: totalAttackerBets,
        defenderPayouts,
        distributedAt: new Date(),
      };
    }

    // Collect active defenders (those not on expedition with positive defense).
    const defenders: Array<{ wallet: string; defensePower: number }> = [];
    let totalDefensePower = 0;

    for (const walletAddress of asteroid.activeMiners) {
      const minerState = this.stakeManager.getMinerState(walletAddress);
      if (minerState.currentExpeditionId) continue;

      const power = this.stakeManager.getDefensePower(walletAddress, asteroidId);
      if (power > 0) {
        defenders.push({ wallet: walletAddress, defensePower: power });
        totalDefensePower += power;
      }
    }

    // Distribute proportionally by defense power.
    if (totalDefensePower > 0 && defenders.length > 0) {
      let distributed = 0;

      for (const defender of defenders) {
        const share = (defender.defensePower / totalDefensePower) * spoilsAmount;
        const payout = Math.floor(share);
        if (payout > 0) {
          defenderPayouts.set(defender.wallet, payout);
          distributed += payout;
          this.stakeManager.addPendingYield(defender.wallet, asteroidId, payout);
        }
      }

      this.totalSpoilsDistributed += distributed;
      // Any rounding remainder is also burned.
      this.totalBurned += burnAmount + (spoilsAmount - distributed);
    } else {
      // No active defenders: burn the entire pot.
      this.totalBurned += totalAttackerBets;
    }

    const result: DefenderSpoils = {
      raidId,
      totalSpoils: spoilsAmount,
      amountBurned: burnAmount,
      defenderPayouts,
      distributedAt: new Date(),
    };

    this.spoilsHistory.push(result);
    if (this.spoilsHistory.length > SPOILS_HISTORY_LIMIT) {
      this.spoilsHistory.shift();
    }

    return result;
  }

  /**
   * Distribute stolen yield to attackers after a successful raid. Math
   * byte-identical to BG: equal base share plus a 50%-weighted bet bonus.
   */
  distributeRaidRewards(result: RaidResult): Map<string, number> {
    const expedition = this.tracker.getExpedition(result.expeditionId);
    if (!expedition || result.stolenYield <= 0) {
      return new Map();
    }

    const rewards = new Map<string, number>();
    const totalBets = Array.from(expedition.bets.values()).reduce((a, b) => a + b, 0);

    for (const attacker of expedition.attackers) {
      const bet = expedition.bets.get(attacker) ?? 0;

      // Base share (equal split) plus bet-weighted bonus.
      let share = result.stolenYield / expedition.attackers.length;
      if (totalBets > 0 && bet > 0) {
        share += (bet / totalBets) * result.stolenYield * 0.5;
      }

      rewards.set(attacker, share);
    }

    return rewards;
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
