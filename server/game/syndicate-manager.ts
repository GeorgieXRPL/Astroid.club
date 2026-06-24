/**
 * Syndicate manager for astroid.club.
 *
 * Ported from `Black-Gold-main/server/game/syndicate-manager.ts` per
 * `docs/PORTING_NOTES.md`. Validation rules, role hierarchy, member
 * caps, treasury constraints, and the 1000-token creation-burn flow
 * are byte-identical to BG.
 *
 * Architectural changes:
 *
 * 1. **DI for the stake manager.** BG called `getStakeManager()` at
 *    method-call time. astroid.club takes a `StakeManagerLike` via
 *    constructor, matching the rest of the game modules.
 * 2. **Module-level singleton dropped.** Instantiate per game world
 *    (or once at the boot layer) instead of `getSyndicateManager()`.
 *
 * Theme note: BG used `Syndicate` already, so very little visible
 * retheming. Only token-symbol log strings become configurable,
 * defaulting to `"$ASTROID"`. Internal field
 * `stake.mineId` becomes `stake.asteroidId` (already renamed in
 * `types.ts`).
 */

import type { GameLogger, StakeManagerLike, SyndicateManagerLike } from './interfaces.js';
import type { Syndicate, SyndicateMember, SyndicateRole, SyndicateSettings } from './types.js';
import { SYNDICATE_CREATION_COST } from './types.js';

const MAX_NAME_LENGTH = 24;
const MAX_TAG_LENGTH = 4;
const MIN_TAG_LENGTH = 2;
const MAX_MEMBERS = 50;
const MAX_OFFICERS = 5;
const MIN_TREASURY_SPLIT = 0;
const MAX_TREASURY_SPLIT = 30;

/** Generic success/error result shared by every public mutation. */
export interface SyndicateResult {
  success: boolean;
  syndicateId?: string;
  error?: string;
}

/** Aggregate stats reported by `getStats`. */
export interface SyndicateManagerStats {
  totalSyndicates: number;
  totalMembers: number;
  totalCreated: number;
  totalBurned: number;
  averageSize: number;
}

export interface SyndicateManagerConfig {
  /** Stake manager dependency for the creation-cost burn. */
  stakeManager: StakeManagerLike;
  /** Token symbol for log lines. Defaults to "$ASTROID". */
  tokenSymbol?: string;
  logger?: GameLogger;
}

/**
 * Manages player alliances (syndicates): creation, membership,
 * roles, treasury, and settings. Wars + raids are handled separately
 * by `SyndicateRaidsManager`.
 */
export class SyndicateManager implements SyndicateManagerLike {
  private readonly syndicates: Map<string, Syndicate> = new Map();
  /** wallet -> syndicate id. */
  private readonly memberToSyndicate: Map<string, string> = new Map();
  /** wallet -> set of syndicate ids that have invited them. */
  private readonly pendingInvites: Map<string, Set<string>> = new Map();
  /** Reserved (uppercase) tags to prevent duplicates. */
  private readonly reservedTags: Set<string> = new Set();
  private totalCreated = 0;
  private totalBurned = 0;

  private readonly stakeManager: StakeManagerLike;
  private readonly tokenSymbol: string;
  private readonly log: GameLogger;

  constructor(config: SyndicateManagerConfig) {
    this.stakeManager = config.stakeManager;
    this.tokenSymbol = config.tokenSymbol ?? '$ASTROID';
    this.log = config.logger ?? defaultLogger();
  }

  // --------- Validation helpers (private) ---------

  private generateId(): string {
    return `syn_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  private validateName(name: string): { valid: boolean; error?: string } {
    if (!name || name.trim().length === 0) {
      return { valid: false, error: 'Name is required' };
    }
    if (name.length > MAX_NAME_LENGTH) {
      return { valid: false, error: `Name must be ${MAX_NAME_LENGTH} characters or less` };
    }
    if (!/^[a-zA-Z0-9 _-]+$/.test(name)) {
      return {
        valid: false,
        error: 'Name can only contain letters, numbers, spaces, underscores, and hyphens',
      };
    }
    return { valid: true };
  }

  private validateTag(tag: string): { valid: boolean; error?: string } {
    if (!tag || tag.trim().length === 0) {
      return { valid: false, error: 'Tag is required' };
    }
    if (tag.length < MIN_TAG_LENGTH || tag.length > MAX_TAG_LENGTH) {
      return {
        valid: false,
        error: `Tag must be ${MIN_TAG_LENGTH}-${MAX_TAG_LENGTH} characters`,
      };
    }
    if (!/^[a-zA-Z0-9]+$/.test(tag)) {
      return { valid: false, error: 'Tag can only contain letters and numbers' };
    }
    if (this.reservedTags.has(tag.toUpperCase())) {
      return { valid: false, error: 'Tag is already taken' };
    }
    return { valid: true };
  }

  // --------- Creation / disband ---------

  /**
   * Create a new syndicate. Costs 1000 tokens (preserved from BG),
   * burned by unstaking from the founder's largest stakes until the
   * cost is covered. Throws no errors — every failure is reported via
   * the result object's `error` field.
   */
  createSyndicate(founderWallet: string, name: string, tag: string): SyndicateResult {
    if (this.memberToSyndicate.has(founderWallet)) {
      return { success: false, error: 'You must leave your current syndicate first' };
    }

    const nameValidation = this.validateName(name);
    if (!nameValidation.valid) return { success: false, error: nameValidation.error };

    const tagValidation = this.validateTag(tag);
    if (!tagValidation.valid) return { success: false, error: tagValidation.error };

    const totalStake = this.stakeManager.getTotalStake(founderWallet);
    if (totalStake < SYNDICATE_CREATION_COST) {
      return {
        success: false,
        error: `Requires ${SYNDICATE_CREATION_COST} ${this.tokenSymbol} stake to create syndicate`,
      };
    }

    // Burn creation cost from largest stakes first (preserved BG order).
    const stakes = [...this.stakeManager.getWalletStakes(founderWallet)];
    if (stakes.length > 0) {
      stakes.sort((a, b) => b.amount - a.amount);
      let remaining = SYNDICATE_CREATION_COST;
      for (const stake of stakes) {
        if (remaining <= 0) break;
        const toUnstake = Math.min(stake.amount, remaining);
        this.stakeManager.unstake(founderWallet, stake.asteroidId, toUnstake);
        remaining -= toUnstake;
      }
    }
    this.totalBurned += SYNDICATE_CREATION_COST;

    const id = this.generateId();
    const upperTag = tag.toUpperCase();
    const founder: SyndicateMember = {
      walletAddress: founderWallet,
      role: 'leader',
      joinedAt: new Date(),
      totalContributed: 0,
    };
    const syndicate: Syndicate = {
      id,
      name: name.trim(),
      tag: upperTag,
      leaderId: founderWallet,
      members: new Map([[founderWallet, founder]]),
      createdAt: new Date(),
      treasury: 0,
      settings: {
        rewardSplit: 0,
        raidCoordination: true,
        defenseAlerts: true,
      },
      activeWars: [],
      warWins: 0,
      warLosses: 0,
    };

    this.syndicates.set(id, syndicate);
    this.memberToSyndicate.set(founderWallet, id);
    this.reservedTags.add(upperTag);
    this.totalCreated++;

    this.log.info(
      `[Syndicate] Created [${upperTag}] ${name} by ${founderWallet} ` +
        `(burned ${SYNDICATE_CREATION_COST} ${this.tokenSymbol})`,
    );
    return { success: true, syndicateId: id };
  }

  /**
   * Disband a syndicate. Only the leader may call. Frees the tag and
   * removes every member.
   */
  disbandSyndicate(leaderWallet: string): SyndicateResult {
    const syndicate = this.getMemberSyndicate(leaderWallet);
    if (!syndicate || syndicate.leaderId !== leaderWallet) {
      return { success: false, error: 'Only the leader can disband the syndicate' };
    }
    for (const walletAddress of syndicate.members.keys()) {
      this.memberToSyndicate.delete(walletAddress);
    }
    this.reservedTags.delete(syndicate.tag);
    this.syndicates.delete(syndicate.id);
    this.log.info(`[Syndicate] [${syndicate.tag}] ${syndicate.name} disbanded by ${leaderWallet}`);
    return { success: true };
  }

  // --------- Lookups ---------

  getSyndicate(syndicateId: string): Syndicate | undefined {
    return this.syndicates.get(syndicateId);
  }

  getMemberSyndicate(walletAddress: string): Syndicate | undefined {
    const syndicateId = this.memberToSyndicate.get(walletAddress);
    if (!syndicateId) return undefined;
    return this.syndicates.get(syndicateId);
  }

  getMemberRole(walletAddress: string): SyndicateRole | null {
    const syndicate = this.getMemberSyndicate(walletAddress);
    if (!syndicate) return null;
    return syndicate.members.get(walletAddress)?.role ?? null;
  }

  canManageMembers(walletAddress: string): boolean {
    const role = this.getMemberRole(walletAddress);
    return role === 'leader' || role === 'officer';
  }

  // --------- Invites ---------

  /** Invite a player. Officers and leaders only. */
  invitePlayer(inviterWallet: string, targetWallet: string): SyndicateResult {
    if (!this.canManageMembers(inviterWallet)) {
      return { success: false, error: 'Only leaders and officers can invite members' };
    }
    const syndicate = this.getMemberSyndicate(inviterWallet);
    if (!syndicate) return { success: false, error: 'You are not in a syndicate' };
    if (syndicate.members.size >= MAX_MEMBERS) {
      return { success: false, error: `Syndicate is full (max ${MAX_MEMBERS} members)` };
    }
    if (this.memberToSyndicate.has(targetWallet)) {
      return { success: false, error: 'Player is already in a syndicate' };
    }

    let invites = this.pendingInvites.get(targetWallet);
    if (!invites) {
      invites = new Set();
      this.pendingInvites.set(targetWallet, invites);
    }
    invites.add(syndicate.id);
    this.log.info(`[Syndicate] ${inviterWallet} invited ${targetWallet} to [${syndicate.tag}]`);
    return { success: true };
  }

  getPendingInvites(walletAddress: string): Syndicate[] {
    const invites = this.pendingInvites.get(walletAddress);
    if (!invites) return [];
    const out: Syndicate[] = [];
    for (const syndicateId of invites) {
      const s = this.syndicates.get(syndicateId);
      if (s) out.push(s);
    }
    return out;
  }

  acceptInvite(walletAddress: string, syndicateId: string): SyndicateResult {
    const invites = this.pendingInvites.get(walletAddress);
    if (!invites || !invites.has(syndicateId)) {
      return { success: false, error: 'No pending invite from this syndicate' };
    }
    if (this.memberToSyndicate.has(walletAddress)) {
      return { success: false, error: 'You must leave your current syndicate first' };
    }
    const syndicate = this.syndicates.get(syndicateId);
    if (!syndicate) {
      return { success: false, error: 'Syndicate no longer exists' };
    }
    if (syndicate.members.size >= MAX_MEMBERS) {
      return { success: false, error: 'Syndicate is full' };
    }

    const member: SyndicateMember = {
      walletAddress,
      role: 'member',
      joinedAt: new Date(),
      totalContributed: 0,
    };
    syndicate.members.set(walletAddress, member);
    this.memberToSyndicate.set(walletAddress, syndicateId);
    this.pendingInvites.delete(walletAddress);
    this.log.info(`[Syndicate] ${walletAddress} joined [${syndicate.tag}] ${syndicate.name}`);
    return { success: true };
  }

  declineInvite(walletAddress: string, syndicateId: string): void {
    const invites = this.pendingInvites.get(walletAddress);
    if (!invites) return;
    invites.delete(syndicateId);
    if (invites.size === 0) this.pendingInvites.delete(walletAddress);
  }

  // --------- Membership mutations ---------

  /**
   * Leave a syndicate. The leader can only leave if they're the last
   * member (auto-disbands) or after transferring leadership.
   */
  leaveSyndicate(walletAddress: string): SyndicateResult {
    const syndicate = this.getMemberSyndicate(walletAddress);
    if (!syndicate) return { success: false, error: 'You are not in a syndicate' };

    if (syndicate.leaderId === walletAddress) {
      if (syndicate.members.size > 1) {
        return {
          success: false,
          error: 'Leaders must transfer leadership or disband before leaving',
        };
      }
      return this.disbandSyndicate(walletAddress);
    }

    syndicate.members.delete(walletAddress);
    this.memberToSyndicate.delete(walletAddress);
    this.log.info(`[Syndicate] ${walletAddress} left [${syndicate.tag}]`);
    return { success: true };
  }

  /**
   * Kick a member. Leaders can kick anyone (except themselves).
   * Officers can kick only `member`-role players.
   */
  kickMember(kickerWallet: string, targetWallet: string): SyndicateResult {
    const syndicate = this.getMemberSyndicate(kickerWallet);
    if (!syndicate) return { success: false, error: 'You are not in a syndicate' };

    const kickerRole = this.getMemberRole(kickerWallet);
    const targetRole = this.getMemberRole(targetWallet);

    if (kickerRole === 'leader') {
      if (targetWallet === kickerWallet) {
        return { success: false, error: 'Cannot kick yourself' };
      }
    } else if (kickerRole === 'officer') {
      if (targetRole !== 'member') {
        return { success: false, error: 'Officers can only kick regular members' };
      }
    } else {
      return { success: false, error: 'Only leaders and officers can kick members' };
    }

    if (!syndicate.members.has(targetWallet)) {
      return { success: false, error: 'Player is not in your syndicate' };
    }

    syndicate.members.delete(targetWallet);
    this.memberToSyndicate.delete(targetWallet);
    this.log.info(`[Syndicate] ${kickerWallet} kicked ${targetWallet} from [${syndicate.tag}]`);
    return { success: true };
  }

  /** Promote a member to officer. Leader-only. Capped at `MAX_OFFICERS`. */
  promoteMember(leaderWallet: string, targetWallet: string): SyndicateResult {
    const syndicate = this.getMemberSyndicate(leaderWallet);
    if (!syndicate || syndicate.leaderId !== leaderWallet) {
      return { success: false, error: 'Only the leader can promote members' };
    }
    const member = syndicate.members.get(targetWallet);
    if (!member) return { success: false, error: 'Player is not in your syndicate' };
    if (member.role !== 'member') {
      return { success: false, error: 'Player is already an officer or leader' };
    }

    let officerCount = 0;
    for (const m of syndicate.members.values()) if (m.role === 'officer') officerCount++;
    if (officerCount >= MAX_OFFICERS) {
      return { success: false, error: `Maximum ${MAX_OFFICERS} officers allowed` };
    }

    member.role = 'officer';
    this.log.info(`[Syndicate] ${targetWallet} promoted to officer in [${syndicate.tag}]`);
    return { success: true };
  }

  /** Demote an officer to member. Leader-only. */
  demoteMember(leaderWallet: string, targetWallet: string): SyndicateResult {
    const syndicate = this.getMemberSyndicate(leaderWallet);
    if (!syndicate || syndicate.leaderId !== leaderWallet) {
      return { success: false, error: 'Only the leader can demote officers' };
    }
    const member = syndicate.members.get(targetWallet);
    if (!member) return { success: false, error: 'Player is not in your syndicate' };
    if (member.role !== 'officer') {
      return { success: false, error: 'Player is not an officer' };
    }
    member.role = 'member';
    this.log.info(`[Syndicate] ${targetWallet} demoted to member in [${syndicate.tag}]`);
    return { success: true };
  }

  /**
   * Transfer leadership. Old leader becomes officer, new leader takes
   * over. Both must be members of the syndicate.
   */
  transferLeadership(currentLeader: string, newLeader: string): SyndicateResult {
    const syndicate = this.getMemberSyndicate(currentLeader);
    if (!syndicate || syndicate.leaderId !== currentLeader) {
      return { success: false, error: 'Only the leader can transfer leadership' };
    }
    const newLeaderMember = syndicate.members.get(newLeader);
    if (!newLeaderMember) {
      return { success: false, error: 'New leader must be a syndicate member' };
    }

    const oldLeaderMember = syndicate.members.get(currentLeader);
    if (oldLeaderMember) oldLeaderMember.role = 'officer';
    newLeaderMember.role = 'leader';
    syndicate.leaderId = newLeader;

    this.log.info(`[Syndicate] Leadership of [${syndicate.tag}] transferred to ${newLeader}`);
    return { success: true };
  }

  // --------- Settings + treasury ---------

  /**
   * Update syndicate settings. Leader-only. `rewardSplit` must be in
   * `[MIN_TREASURY_SPLIT, MAX_TREASURY_SPLIT]` percent (preserved).
   * Other fields are passed through unchanged when present.
   */
  updateSettings(leaderWallet: string, settings: Partial<SyndicateSettings>): SyndicateResult {
    const syndicate = this.getMemberSyndicate(leaderWallet);
    if (!syndicate || syndicate.leaderId !== leaderWallet) {
      return { success: false, error: 'Only the leader can update settings' };
    }

    if (settings.rewardSplit !== undefined) {
      if (settings.rewardSplit < MIN_TREASURY_SPLIT || settings.rewardSplit > MAX_TREASURY_SPLIT) {
        return {
          success: false,
          error: `Reward split must be ${MIN_TREASURY_SPLIT}-${MAX_TREASURY_SPLIT}%`,
        };
      }
      syndicate.settings.rewardSplit = settings.rewardSplit;
    }
    if (settings.raidCoordination !== undefined) {
      syndicate.settings.raidCoordination = settings.raidCoordination;
    }
    if (settings.defenseAlerts !== undefined) {
      syndicate.settings.defenseAlerts = settings.defenseAlerts;
    }

    this.log.info(`[Syndicate] [${syndicate.tag}] settings updated`);
    return { success: true };
  }

  /**
   * Deposit to syndicate treasury. BG comment notes that production
   * would deduct from the wallet's balance — that hook is the
   * `CHAIN_ENABLED` chain layer's job. Here we credit the treasury
   * and bump the member's `totalContributed`.
   */
  depositToTreasury(walletAddress: string, amount: number): SyndicateResult {
    const syndicate = this.getMemberSyndicate(walletAddress);
    if (!syndicate) return { success: false, error: 'You are not in a syndicate' };
    if (amount <= 0) return { success: false, error: 'Amount must be positive' };

    syndicate.treasury += amount;
    const member = syndicate.members.get(walletAddress);
    if (member) member.totalContributed += amount;

    this.log.info(
      `[Syndicate] ${walletAddress} deposited ${amount} to [${syndicate.tag}] treasury`,
    );
    return { success: true };
  }

  /**
   * Withdraw from syndicate treasury. Leader-only. As with deposit,
   * the actual on-chain transfer to the recipient is the chain layer's
   * job — this method only debits the treasury.
   */
  withdrawFromTreasury(
    leaderWallet: string,
    amount: number,
    recipientWallet: string,
  ): SyndicateResult {
    const syndicate = this.getMemberSyndicate(leaderWallet);
    if (!syndicate || syndicate.leaderId !== leaderWallet) {
      return { success: false, error: 'Only the leader can withdraw from treasury' };
    }
    if (amount <= 0 || amount > syndicate.treasury) {
      return { success: false, error: 'Invalid amount' };
    }
    syndicate.treasury -= amount;
    this.log.info(
      `[Syndicate] ${leaderWallet} withdrew ${amount} from [${syndicate.tag}] ` +
        `treasury to ${recipientWallet}`,
    );
    return { success: true };
  }

  // --------- Browsing + stats ---------

  getAllSyndicates(): Syndicate[] {
    return Array.from(this.syndicates.values());
  }

  searchSyndicates(query: string): Syndicate[] {
    const lower = query.toLowerCase();
    return this.getAllSyndicates().filter(
      (s) => s.name.toLowerCase().includes(lower) || s.tag.toLowerCase().includes(lower),
    );
  }

  /** Top syndicates by member count or war wins. Limit defaults to 10. */
  getLeaderboard(sortBy: 'members' | 'wins' = 'members', limit = 10): Syndicate[] {
    const syndicates = this.getAllSyndicates();
    if (sortBy === 'members') {
      syndicates.sort((a, b) => b.members.size - a.members.size);
    } else {
      syndicates.sort((a, b) => b.warWins - a.warWins);
    }
    return syndicates.slice(0, limit);
  }

  getStats(): SyndicateManagerStats {
    let totalMembers = 0;
    for (const s of this.syndicates.values()) totalMembers += s.members.size;
    return {
      totalSyndicates: this.syndicates.size,
      totalMembers,
      totalCreated: this.totalCreated,
      totalBurned: this.totalBurned,
      averageSize: this.syndicates.size > 0 ? totalMembers / this.syndicates.size : 0,
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
