/**
 * Syndicate raids manager for astroid.club.
 *
 * Ported from `Black-Gold-main/server/game/syndicate-raids.ts` per
 * `docs/PORTING_NOTES.md`. Coordination bonus, participant minimum,
 * raid duration cap, attack-power formula, steal-percent formula,
 * defender-spoils + buff/debuff plumbing, and reward distribution
 * (50/50 base+bet split) are byte-identical to BG.
 *
 * Architectural changes:
 *
 * 1. **DI for every collaborator.** BG called `getSyndicateManager()`,
 *    `getStakeManager()`, `getMineRegistry()`, `getRaidEngine()` at
 *    method-call time. astroid.club takes them all via constructor
 *    using the narrow `*Like` interfaces.
 * 2. **Module-level singleton dropped.** Instantiate per game world
 *    instead of `getSyndicateRaidsManager()`.
 *
 * Theme renames per glossary:
 * - `targetMineId` → `targetAsteroidId`
 * - `mineId` → `asteroidId`
 * - `homeBaseMineId` → `homeStationAsteroidId`
 * - `getStakeAtMine` → `getStakeAtAsteroid`
 * - `getMineRegistry` → `AsteroidRegistryLike`
 * - `getPendingReward` → `getPendingYield`
 * - `calculateMineDefensePower` → `calculateAsteroidDefensePower`
 * - `stolenRewards` (RaidResult field) → `stolenYield`
 * - Token symbol in log strings → `"$ASTROID"` (configurable)
 *
 * BG quirk preserved: the lone *proposer's* attack power is added
 * once with no `SYNDICATE_POWER_BONUS`, while every joiner's power is
 * multiplied by `SYNDICATE_POWER_BONUS` (1.1x). This is BG's exact
 * behaviour and is verified in tests; we treat it as intentional —
 * "the bonus is for *coordinating* with someone, so the first member
 * doesn't get it yet".
 */

import type {
  AsteroidRegistryLike,
  GameLogger,
  RaidEngineLike,
  StakeManagerLike,
  SyndicateManagerLike,
} from './interfaces.js';
import type { RaidResult, SyndicateRaid } from './types.js';

/** 2 hours, preserved from BG. */
const MAX_RAID_DURATION_MS = 2 * 60 * 60 * 1000;

/** Minimum participants required to launch a syndicate raid. */
const MIN_PARTICIPANTS = 3;

/** Per-joiner coordination bonus, preserved from BG. */
const SYNDICATE_POWER_BONUS = 1.1;

/** Defender's natural advantage on the calculated defense power. */
const DEFENSE_ADVANTAGE_MULTIPLIER = 1.2;

/** Maximum bet as fraction of stake at home station — preserved from BG. */
const MAX_BET_FRACTION_OF_STAKE = 0.2;

/** Base attack-power formula: stake × this fraction. */
const ATTACK_POWER_PER_STAKE = 0.1;

/** Steal-percent formula constants — preserved verbatim from BG. */
const STEAL_PERCENT_BASE = 0.1;
const STEAL_PERCENT_PER_RATIO = 0.2;
const STEAL_PERCENT_CAP = 0.3;

/** Power-ratio cap when computing steal percent. */
const POWER_RATIO_CAP = 2.0;

/** Per-bet bonus weight in the post-win payout (50% bet-weighted). */
const BET_WEIGHTED_PAYOUT_FRACTION = 0.5;

/** History buffer size, preserved from BG. */
const RAID_HISTORY_LIMIT = 100;

/** Generic success/error result returned by every public mutation. */
export interface SyndicateRaidResult {
  success: boolean;
  raidId?: string;
  error?: string;
}

/** Aggregate stats reported by `getStats`. */
export interface SyndicateRaidsStats {
  pendingRaids: number;
  activeRaids: number;
  totalRaids: number;
  /** Win rate of resolved raids, 0-100. */
  winRate: number;
}

export interface SyndicateRaidsManagerConfig {
  syndicates: SyndicateManagerLike;
  stakeManager: StakeManagerLike;
  registry: AsteroidRegistryLike;
  raidEngine: RaidEngineLike;
  /** Token symbol for log lines. Defaults to "$ASTROID". */
  tokenSymbol?: string;
  logger?: GameLogger;
}

/** Stored history entry: a completed `SyndicateRaid` plus its `RaidResult`. */
type CompletedRaid = SyndicateRaid & { result?: RaidResult };

/**
 * Coordinates syndicate-wide raids. Lifecycle:
 *
 *   propose → (joins) → launch → resolve → distributeRewards
 *
 * Plus expiry/cleanup paths. The class is a pure in-memory engine; no
 * chain side effects.
 */
export class SyndicateRaidsManager {
  /** raidId -> active raid (post-launch). */
  private readonly activeRaids: Map<string, SyndicateRaid> = new Map();
  /** Bounded ring of completed raids for `getStats`. */
  private readonly raidHistory: CompletedRaid[] = [];
  /** syndicateId -> in-progress proposal awaiting launch. */
  private readonly pendingRaids: Map<string, SyndicateRaid> = new Map();

  private readonly syndicates: SyndicateManagerLike;
  private readonly stakeManager: StakeManagerLike;
  private readonly registry: AsteroidRegistryLike;
  private readonly raidEngine: RaidEngineLike;
  private readonly tokenSymbol: string;
  private readonly log: GameLogger;

  constructor(config: SyndicateRaidsManagerConfig) {
    this.syndicates = config.syndicates;
    this.stakeManager = config.stakeManager;
    this.registry = config.registry;
    this.raidEngine = config.raidEngine;
    this.tokenSymbol = config.tokenSymbol ?? '$ASTROID';
    this.log = config.logger ?? defaultLogger();
  }

  // --------- Internal helpers ---------

  private generateId(): string {
    return `synraid_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Per-member base attack power: `stake_at_home_station × 0.1`.
   * Returns 0 when the wallet has no home station set.
   */
  private calculateMemberAttackPower(walletAddress: string): number {
    const state = this.stakeManager.getMinerState(walletAddress);
    if (!state.homeStationAsteroidId) return 0;
    const stake = this.stakeManager.getStakeAtAsteroid(walletAddress, state.homeStationAsteroidId);
    return stake * ATTACK_POWER_PER_STAKE;
  }

  // --------- Lifecycle: propose / join / leave / launch / cancel ---------

  /**
   * Propose a syndicate raid. Officers and leaders only. Sets the
   * proposer as the sole initial participant and starts the gathering
   * window. Returns the raidId on success.
   */
  proposeRaid(
    proposerWallet: string,
    targetAsteroidId: string,
    initialBet = 0,
  ): SyndicateRaidResult {
    const syndicate = this.syndicates.getMemberSyndicate(proposerWallet);
    if (!syndicate) return { success: false, error: 'You are not in a syndicate' };
    if (!syndicate.settings.raidCoordination) {
      return { success: false, error: 'Raid coordination is disabled for this syndicate' };
    }
    if (!this.syndicates.canManageMembers(proposerWallet)) {
      return { success: false, error: 'Only leaders and officers can propose raids' };
    }
    if (this.pendingRaids.has(syndicate.id)) {
      return { success: false, error: 'A raid is already being organized' };
    }
    if (!this.registry.getAsteroid(targetAsteroidId)) {
      return { success: false, error: 'Target asteroid does not exist' };
    }
    if (!this.raidEngine.canBeRaided(targetAsteroidId)) {
      return { success: false, error: 'Target asteroid has raid immunity' };
    }

    const proposerState = this.stakeManager.getMinerState(proposerWallet);
    if (proposerState.homeStationAsteroidId) {
      const stake = this.stakeManager.getStakeAtAsteroid(
        proposerWallet,
        proposerState.homeStationAsteroidId,
      );
      const maxBet = stake * MAX_BET_FRACTION_OF_STAKE;
      if (initialBet > maxBet) {
        return {
          success: false,
          error: `Max bet is ${maxBet} ${this.tokenSymbol} (20% of stake)`,
        };
      }
    }

    const id = this.generateId();
    const now = new Date();
    const raid: SyndicateRaid = {
      id,
      syndicateId: syndicate.id,
      targetAsteroidId,
      participants: [proposerWallet],
      pooledAttackPower: this.calculateMemberAttackPower(proposerWallet),
      totalBets: initialBet,
      bets: new Map([[proposerWallet, initialBet]]),
      startedAt: now,
      expiresAt: new Date(now.getTime() + MAX_RAID_DURATION_MS),
      status: 'active',
    };
    this.pendingRaids.set(syndicate.id, raid);

    this.log.info(
      `[SyndicateRaids] [${syndicate.tag}] proposed raid on ${targetAsteroidId} ` +
        `by ${proposerWallet} (bet: ${initialBet})`,
    );
    return { success: true, raidId: id };
  }

  /**
   * Join an in-progress raid proposal. Adds the joiner's attack power
   * (×1.1 coordination bonus) and bet to the pool.
   */
  joinRaid(walletAddress: string, betAmount = 0): SyndicateRaidResult {
    const syndicate = this.syndicates.getMemberSyndicate(walletAddress);
    if (!syndicate) return { success: false, error: 'You are not in a syndicate' };

    const raid = this.pendingRaids.get(syndicate.id);
    if (!raid) return { success: false, error: 'No active raid to join' };
    if (raid.participants.includes(walletAddress)) {
      return { success: false, error: 'You are already in this raid' };
    }

    const state = this.stakeManager.getMinerState(walletAddress);
    if (state.homeStationAsteroidId && betAmount > 0) {
      const stake = this.stakeManager.getStakeAtAsteroid(
        walletAddress,
        state.homeStationAsteroidId,
      );
      const maxBet = stake * MAX_BET_FRACTION_OF_STAKE;
      if (betAmount > maxBet) {
        return {
          success: false,
          error: `Max bet is ${maxBet} ${this.tokenSymbol} (20% of stake)`,
        };
      }
    }

    raid.participants.push(walletAddress);
    raid.pooledAttackPower +=
      this.calculateMemberAttackPower(walletAddress) * SYNDICATE_POWER_BONUS;
    raid.totalBets += betAmount;
    raid.bets.set(walletAddress, betAmount);

    this.log.info(
      `[SyndicateRaids] ${walletAddress} joined raid on ${raid.targetAsteroidId} ` +
        `(bet: ${betAmount}, total power: ${raid.pooledAttackPower.toFixed(0)})`,
    );
    return { success: true };
  }

  /** Leave a pending raid. If empty, the raid is cancelled. */
  leaveRaid(walletAddress: string): SyndicateRaidResult {
    const syndicate = this.syndicates.getMemberSyndicate(walletAddress);
    if (!syndicate) return { success: false, error: 'You are not in a syndicate' };

    const raid = this.pendingRaids.get(syndicate.id);
    if (!raid) return { success: false, error: 'No active raid' };

    const index = raid.participants.indexOf(walletAddress);
    if (index < 0) return { success: false, error: 'You are not in this raid' };

    raid.participants.splice(index, 1);
    raid.pooledAttackPower -=
      this.calculateMemberAttackPower(walletAddress) * SYNDICATE_POWER_BONUS;

    const bet = raid.bets.get(walletAddress) ?? 0;
    raid.totalBets -= bet;
    raid.bets.delete(walletAddress);

    if (raid.participants.length === 0) {
      this.pendingRaids.delete(syndicate.id);
      this.log.info(
        `[SyndicateRaids] Raid on ${raid.targetAsteroidId} cancelled (no participants)`,
      );
    }
    return { success: true };
  }

  /**
   * Launch a pending raid. Officers and leaders only. Requires
   * `MIN_PARTICIPANTS`. Moves the raid from pending to active.
   */
  launchRaid(leaderWallet: string): SyndicateRaidResult {
    const syndicate = this.syndicates.getMemberSyndicate(leaderWallet);
    if (!syndicate) return { success: false, error: 'You are not in a syndicate' };
    if (!this.syndicates.canManageMembers(leaderWallet)) {
      return { success: false, error: 'Only leaders and officers can launch raids' };
    }

    const raid = this.pendingRaids.get(syndicate.id);
    if (!raid) return { success: false, error: 'No pending raid to launch' };
    if (raid.participants.length < MIN_PARTICIPANTS) {
      return {
        success: false,
        error: `Need at least ${MIN_PARTICIPANTS} participants to launch`,
      };
    }

    this.pendingRaids.delete(syndicate.id);
    this.activeRaids.set(raid.id, raid);

    this.log.info(
      `[SyndicateRaids] [${syndicate.tag}] launched raid on ${raid.targetAsteroidId} ` +
        `with ${raid.participants.length} members ` +
        `(power: ${raid.pooledAttackPower.toFixed(0)})`,
    );
    return { success: true };
  }

  /** Cancel a pending raid. Officers and leaders only. */
  cancelRaid(walletAddress: string): SyndicateRaidResult {
    const syndicate = this.syndicates.getMemberSyndicate(walletAddress);
    if (!syndicate) return { success: false, error: 'You are not in a syndicate' };
    if (!this.syndicates.canManageMembers(walletAddress)) {
      return { success: false, error: 'Only leaders and officers can cancel raids' };
    }
    if (!this.pendingRaids.has(syndicate.id)) {
      return { success: false, error: 'No pending raid to cancel' };
    }
    this.pendingRaids.delete(syndicate.id);
    this.log.info(`[SyndicateRaids] [${syndicate.tag}] raid cancelled by ${walletAddress}`);
    return { success: true };
  }

  // --------- Resolution ---------

  /**
   * Resolve an active syndicate raid. Computes attack-vs-effective-defense,
   * applies the steal-percent formula on a win, distributes defender
   * spoils on a loss, and applies the appropriate buff/debuff.
   *
   * Steal-percent formula (preserved verbatim):
   *   powerRatio   = min(attackPower / effectiveDefensePower, 2.0)
   *   stealPercent = min(0.1 + (powerRatio - 1) × 0.2, 0.3)
   *   stolen       = pendingYield × stealPercent
   *
   * On loss: each attacker's bet is burned via `stakeManager.burnBet`
   * (only when the wallet has a home station; matches BG). Defender
   * spoils are paid via `raidEngine.distributeDefenderSpoils`.
   */
  resolveRaid(raidId: string): RaidResult | null {
    const raid = this.activeRaids.get(raidId);
    if (!raid) {
      this.log.info(`[SyndicateRaids] Raid ${raidId} not found`);
      return null;
    }

    const syndicate = this.syndicates.getSyndicate(raid.syndicateId);
    const defensePower = this.raidEngine.calculateAsteroidDefensePower(raid.targetAsteroidId);
    const effectiveDefensePower = defensePower * DEFENSE_ADVANTAGE_MULTIPLIER;
    const attackPower = raid.pooledAttackPower;
    const attackersWon = attackPower > effectiveDefensePower;

    this.log.info(
      `[SyndicateRaids] Resolving ${syndicate?.tag ?? 'Unknown'} raid: ` +
        `Attack ${attackPower.toFixed(0)} vs Defense ${defensePower.toFixed(0)} ` +
        `-> ${attackersWon ? 'WIN' : 'LOSE'}`,
    );

    const betsReturned = new Map<string, number>();
    const betsBurned = new Map<string, number>();
    let stolenYield = 0;

    if (attackersWon) {
      const pendingYield = this.raidEngine.getPendingYield(raid.targetAsteroidId);
      const powerRatio = Math.min(attackPower / effectiveDefensePower, POWER_RATIO_CAP);
      const stealPercent = STEAL_PERCENT_BASE + (powerRatio - 1) * STEAL_PERCENT_PER_RATIO;
      stolenYield = pendingYield * Math.min(stealPercent, STEAL_PERCENT_CAP);

      for (const [wallet, bet] of raid.bets) {
        if (bet > 0) {
          const share = (bet / raid.totalBets) * stolenYield * BET_WEIGHTED_PAYOUT_FRACTION;
          betsReturned.set(wallet, bet + share);
        }
      }
      this.registry.applyAttackDebuff(raid.targetAsteroidId);
    } else {
      for (const [wallet, bet] of raid.bets) {
        if (bet > 0) {
          const state = this.stakeManager.getMinerState(wallet);
          if (state.homeStationAsteroidId) {
            this.stakeManager.burnBet(wallet, state.homeStationAsteroidId, bet);
          }
          betsBurned.set(wallet, bet);
        }
      }
      if (raid.totalBets > 0) {
        this.raidEngine.distributeDefenderSpoils(raidId, raid.targetAsteroidId, raid.totalBets);
      }
      this.registry.applyDefenseBuff(raid.targetAsteroidId);
    }

    raid.status = 'completed';
    this.activeRaids.delete(raidId);

    const result: RaidResult = {
      expeditionId: raidId,
      attackersWon,
      stolenYield,
      defensePower,
      attackPower,
      betsReturned,
      betsBurned,
      resolvedAt: new Date(),
    };

    this.raidHistory.push({ ...raid, result });
    if (this.raidHistory.length > RAID_HISTORY_LIMIT) this.raidHistory.shift();
    return result;
  }

  /** Resolve every active raid targeting the given asteroid. */
  resolveAllRaids(asteroidId: string): RaidResult[] {
    const results: RaidResult[] = [];
    for (const [raidId, raid] of this.activeRaids) {
      if (raid.targetAsteroidId === asteroidId) {
        const r = this.resolveRaid(raidId);
        if (r) results.push(r);
      }
    }
    return results;
  }

  /**
   * Distribute the post-win pool to syndicate participants. Treasury
   * cut comes off the top per `syndicate.settings.rewardSplit`. The
   * remaining pool is split: 50% equal-share among participants, 50%
   * weighted by bet size. (BG-verbatim.)
   *
   * Returns wallet -> payout map. Skips entirely on losses or when
   * no yield was stolen.
   */
  distributeRewards(raidId: string, result: RaidResult): Map<string, number> {
    const raid = this.raidHistory.find((r) => r.id === raidId);
    if (!raid || !result.attackersWon || result.stolenYield <= 0) {
      return new Map();
    }
    const syndicate = this.syndicates.getSyndicate(raid.syndicateId);
    if (!syndicate) return new Map();

    const rewards = new Map<string, number>();
    const treasuryShare = result.stolenYield * (syndicate.settings.rewardSplit / 100);
    const participantPool = result.stolenYield - treasuryShare;
    const baseShare =
      (participantPool * (1 - BET_WEIGHTED_PAYOUT_FRACTION)) / raid.participants.length;
    const betPool = participantPool * BET_WEIGHTED_PAYOUT_FRACTION;

    for (const wallet of raid.participants) {
      let share = baseShare;
      if (raid.totalBets > 0) {
        const bet = raid.bets.get(wallet) ?? 0;
        share += (bet / raid.totalBets) * betPool;
      }
      rewards.set(wallet, share);
    }

    if (treasuryShare > 0) syndicate.treasury += treasuryShare;
    return rewards;
  }

  // --------- Inspection ---------

  getPendingRaid(syndicateId: string): SyndicateRaid | undefined {
    return this.pendingRaids.get(syndicateId);
  }

  /** Active raids launched by a given syndicate. */
  getActiveRaidsForSyndicate(syndicateId: string): SyndicateRaid[] {
    return Array.from(this.activeRaids.values()).filter((r) => r.syndicateId === syndicateId);
  }

  /** Active raids targeting a specific asteroid. */
  getRaidsTargeting(asteroidId: string): SyndicateRaid[] {
    return Array.from(this.activeRaids.values()).filter((r) => r.targetAsteroidId === asteroidId);
  }

  /**
   * Drop expired pending and active raids. Pending raids are removed
   * silently; active raids are marked `failed` and pushed onto the
   * history ring (BG behaviour).
   */
  cleanupExpiredRaids(): void {
    const now = Date.now();

    for (const [syndicateId, raid] of this.pendingRaids) {
      if (raid.expiresAt.getTime() < now) {
        this.pendingRaids.delete(syndicateId);
        this.log.info(`[SyndicateRaids] Pending raid expired for syndicate ${syndicateId}`);
      }
    }

    for (const [raidId, raid] of this.activeRaids) {
      if (raid.expiresAt.getTime() < now) {
        raid.status = 'failed';
        this.activeRaids.delete(raidId);
        this.raidHistory.push(raid);
        this.log.info(`[SyndicateRaids] Active raid ${raidId} expired`);
      }
    }
  }

  getStats(): SyndicateRaidsStats {
    let wins = 0;
    let total = 0;
    for (const raid of this.raidHistory) {
      if (raid.result) {
        total++;
        if (raid.result.attackersWon) wins++;
      }
    }
    return {
      pendingRaids: this.pendingRaids.size,
      activeRaids: this.activeRaids.size,
      totalRaids: total,
      winRate: total > 0 ? (wins / total) * 100 : 0,
    };
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
