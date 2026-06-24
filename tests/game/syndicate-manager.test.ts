/**
 * Unit tests for `server/game/syndicate-manager.ts`.
 *
 * Uses a minimal in-memory `StakeManagerLike` test double rather than
 * the real `StakeManager` — these tests are about syndicate logic
 * (validation, role hierarchy, member caps, treasury, invites,
 * leadership transfer, disband cascade), not stake mechanics. The
 * stake double exposes just enough surface for the creation-cost burn
 * to verify it unstakes from the largest stakes first.
 */

import { describe, expect, it } from 'vitest';

import type { GameLogger, StakeManagerLike } from '../../server/game/interfaces.js';
import { SyndicateManager } from '../../server/game/syndicate-manager.js';
import { SYNDICATE_CREATION_COST } from '../../server/game/types.js';
import type { MinerGameState, StakeRecord } from '../../server/game/types.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const FOUNDER = 'wallet_founder';
const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';
const CAROL = 'wallet_carol';

/**
 * Minimal stake manager double. Backed by a `Map<wallet, Map<asteroidId, amount>>`.
 * Implements only the methods syndicate-manager calls; throws on any other
 * surface so tests can't accidentally smuggle in untested dependencies.
 */
class FakeStakeManager implements StakeManagerLike {
  private readonly stakes = new Map<string, Map<string, number>>();

  setStake(wallet: string, asteroidId: string, amount: number): void {
    let walletStakes = this.stakes.get(wallet);
    if (!walletStakes) {
      walletStakes = new Map();
      this.stakes.set(wallet, walletStakes);
    }
    walletStakes.set(asteroidId, amount);
  }

  getTotalStake(wallet: string): number {
    let total = 0;
    const walletStakes = this.stakes.get(wallet);
    if (!walletStakes) return 0;
    for (const amount of walletStakes.values()) total += amount;
    return total;
  }

  getWalletStakes(wallet: string): StakeRecord[] {
    const walletStakes = this.stakes.get(wallet);
    if (!walletStakes) return [];
    const out: StakeRecord[] = [];
    for (const [asteroidId, amount] of walletStakes) {
      out.push({
        walletAddress: wallet,
        asteroidId,
        amount,
        stakedAt: new Date(),
        isHomeStation: false,
        loyaltyDays: 0,
      });
    }
    return out;
  }

  unstake(wallet: string, asteroidId: string, amount: number): void {
    const walletStakes = this.stakes.get(wallet);
    if (!walletStakes) return;
    const current = walletStakes.get(asteroidId) ?? 0;
    walletStakes.set(asteroidId, Math.max(0, current - amount));
  }

  getMinerState(): MinerGameState {
    throw new Error('not used by syndicate manager');
  }
  getDefensePower(): number {
    throw new Error('not used by syndicate manager');
  }
  getStakeAtAsteroid(): number {
    throw new Error('not used by syndicate manager');
  }
  processBet(): boolean {
    throw new Error('not used by syndicate manager');
  }
  burnBet(): void {
    throw new Error('not used by syndicate manager');
  }
  returnBetWithWinnings(): void {
    throw new Error('not used by syndicate manager');
  }
  addPendingYield(): void {
    throw new Error('not used by syndicate manager');
  }
}

function makeMgr(stake?: FakeStakeManager): {
  mgr: SyndicateManager;
  stake: FakeStakeManager;
} {
  const stakeManager = stake ?? new FakeStakeManager();
  // Default: founder has plenty of stake to pay creation cost.
  stakeManager.setStake(FOUNDER, 'A', SYNDICATE_CREATION_COST + 500);
  return {
    mgr: new SyndicateManager({
      stakeManager,
      logger: silentLogger,
    }),
    stake: stakeManager,
  };
}

describe('SyndicateManager createSyndicate validation', () => {
  it('rejects empty name', () => {
    const { mgr } = makeMgr();
    expect(mgr.createSyndicate(FOUNDER, '', 'TAG')).toEqual({
      success: false,
      error: 'Name is required',
    });
  });

  it('rejects whitespace-only name', () => {
    const { mgr } = makeMgr();
    expect(mgr.createSyndicate(FOUNDER, '   ', 'TAG').success).toBe(false);
  });

  it('rejects names over 24 chars', () => {
    const { mgr } = makeMgr();
    expect(mgr.createSyndicate(FOUNDER, 'A'.repeat(25), 'TAG').error).toMatch(/24 characters/);
  });

  it('rejects names with disallowed characters', () => {
    const { mgr } = makeMgr();
    expect(mgr.createSyndicate(FOUNDER, 'Bad!Name', 'TAG').error).toMatch(/can only contain/);
  });

  it('accepts allowed name characters (letters, numbers, spaces, _, -)', () => {
    const { mgr } = makeMgr();
    expect(mgr.createSyndicate(FOUNDER, 'Astro Miners_2026-Crew', 'AM').success).toBe(true);
  });

  it('rejects empty tag', () => {
    const { mgr } = makeMgr();
    expect(mgr.createSyndicate(FOUNDER, 'Name', '').error).toMatch(/Tag is required/);
  });

  it('rejects 1-char tag (below 2)', () => {
    const { mgr } = makeMgr();
    expect(mgr.createSyndicate(FOUNDER, 'Name', 'A').error).toMatch(/2-4 characters/);
  });

  it('rejects 5-char tag (above 4)', () => {
    const { mgr } = makeMgr();
    expect(mgr.createSyndicate(FOUNDER, 'Name', 'TOOMUCH').error).toMatch(/2-4 characters/);
  });

  it('rejects tag with non-alphanumeric chars', () => {
    const { mgr } = makeMgr();
    expect(mgr.createSyndicate(FOUNDER, 'Name', 'A!').error).toMatch(/letters and numbers/);
  });

  it('rejects duplicate (case-insensitive) tags', () => {
    const { mgr, stake } = makeMgr();
    stake.setStake(ALICE, 'A', SYNDICATE_CREATION_COST);
    expect(mgr.createSyndicate(FOUNDER, 'First', 'tag').success).toBe(true);
    expect(mgr.createSyndicate(ALICE, 'Second', 'TAG').error).toMatch(/already taken/);
  });

  it('rejects re-creation by an already-syndicated founder', () => {
    const { mgr } = makeMgr();
    expect(mgr.createSyndicate(FOUNDER, 'First', 'AAA').success).toBe(true);
    expect(mgr.createSyndicate(FOUNDER, 'Second', 'BBB').error).toMatch(
      /must leave your current syndicate/,
    );
  });

  it('rejects when founder has insufficient stake', () => {
    const stake = new FakeStakeManager();
    stake.setStake(FOUNDER, 'A', 100);
    const mgr = new SyndicateManager({ stakeManager: stake, logger: silentLogger });
    expect(mgr.createSyndicate(FOUNDER, 'Name', 'TAG').error).toMatch(/Requires 1000.*to create/);
  });
});

describe('SyndicateManager createSyndicate burn behaviour', () => {
  it('burns from the largest stake first', () => {
    const stake = new FakeStakeManager();
    // Largest stake (B) should be hit first.
    stake.setStake(FOUNDER, 'A', 200);
    stake.setStake(FOUNDER, 'B', 1500);
    stake.setStake(FOUNDER, 'C', 100);
    const mgr = new SyndicateManager({ stakeManager: stake, logger: silentLogger });

    expect(mgr.createSyndicate(FOUNDER, 'Name', 'TAG').success).toBe(true);

    // 1000 burned from B (largest), A and C untouched.
    expect(stake.getTotalStake(FOUNDER)).toBe(200 + 500 + 100);
  });

  it('cascades the burn across multiple stakes when needed', () => {
    const stake = new FakeStakeManager();
    stake.setStake(FOUNDER, 'A', 600);
    stake.setStake(FOUNDER, 'B', 500);
    stake.setStake(FOUNDER, 'C', 200);
    const mgr = new SyndicateManager({ stakeManager: stake, logger: silentLogger });

    expect(mgr.createSyndicate(FOUNDER, 'Name', 'TAG').success).toBe(true);
    // 1300 - 1000 = 300 should remain. Cascade order: A=600 (-600 -> 0),
    // B=500 (-400 -> 100), C=200 (untouched). Total = 0 + 100 + 200 = 300.
    expect(stake.getTotalStake(FOUNDER)).toBe(300);
  });

  it('records totalBurned in stats', () => {
    const { mgr } = makeMgr();
    mgr.createSyndicate(FOUNDER, 'Name', 'TAG');
    expect(mgr.getStats().totalBurned).toBe(SYNDICATE_CREATION_COST);
    expect(mgr.getStats().totalCreated).toBe(1);
  });
});

describe('SyndicateManager invites + acceptance', () => {
  it('only leaders/officers can invite', () => {
    const { mgr, stake } = makeMgr();
    stake.setStake(ALICE, 'A', SYNDICATE_CREATION_COST + 1);
    mgr.createSyndicate(FOUNDER, 'Name', 'TAG');
    mgr.invitePlayer(FOUNDER, ALICE);
    mgr.acceptInvite(ALICE, mgr.getAllSyndicates()[0]!.id);

    // ALICE is just a member: can't invite.
    expect(mgr.invitePlayer(ALICE, BOB).error).toMatch(/Only leaders and officers/);
  });

  it('cannot invite players already in a syndicate', () => {
    const { mgr, stake } = makeMgr();
    stake.setStake(ALICE, 'A', SYNDICATE_CREATION_COST + 1);
    mgr.createSyndicate(FOUNDER, 'NameA', 'AAA');
    mgr.createSyndicate(ALICE, 'NameB', 'BBB');
    expect(mgr.invitePlayer(FOUNDER, ALICE).error).toMatch(/already in a syndicate/);
  });

  it('lists pending invites', () => {
    const { mgr } = makeMgr();
    mgr.createSyndicate(FOUNDER, 'Name', 'TAG');
    mgr.invitePlayer(FOUNDER, ALICE);
    expect(mgr.getPendingInvites(ALICE)).toHaveLength(1);
    expect(mgr.getPendingInvites(ALICE)[0]?.tag).toBe('TAG');
  });

  it('accepting an invite adds the member and clears all other invites', () => {
    const { mgr, stake } = makeMgr();
    stake.setStake(ALICE, 'A', SYNDICATE_CREATION_COST + 1);
    mgr.createSyndicate(FOUNDER, 'Name1', 'AAA');
    mgr.createSyndicate(ALICE, 'Name2', 'BBB');

    mgr.invitePlayer(FOUNDER, BOB);
    mgr.invitePlayer(ALICE, BOB);
    expect(mgr.getPendingInvites(BOB)).toHaveLength(2);

    const synA = mgr.getAllSyndicates().find((s) => s.tag === 'AAA')!;
    expect(mgr.acceptInvite(BOB, synA.id).success).toBe(true);
    expect(mgr.getMemberSyndicate(BOB)?.tag).toBe('AAA');
    // Other invite should also be cleared.
    expect(mgr.getPendingInvites(BOB)).toHaveLength(0);
  });

  it('declineInvite drops only the targeted invite', () => {
    const { mgr, stake } = makeMgr();
    stake.setStake(ALICE, 'A', SYNDICATE_CREATION_COST + 1);
    mgr.createSyndicate(FOUNDER, 'Name1', 'AAA');
    mgr.createSyndicate(ALICE, 'Name2', 'BBB');
    mgr.invitePlayer(FOUNDER, BOB);
    mgr.invitePlayer(ALICE, BOB);
    const synA = mgr.getAllSyndicates().find((s) => s.tag === 'AAA')!;
    mgr.declineInvite(BOB, synA.id);
    expect(mgr.getPendingInvites(BOB)).toHaveLength(1);
    expect(mgr.getPendingInvites(BOB)[0]?.tag).toBe('BBB');
  });

  it('rejects invite acceptance when already a member', () => {
    const { mgr, stake } = makeMgr();
    stake.setStake(ALICE, 'A', SYNDICATE_CREATION_COST + 1);
    mgr.createSyndicate(FOUNDER, 'Name1', 'AAA');
    // Invite ALICE BEFORE she creates her own syndicate so the invite lands.
    mgr.invitePlayer(FOUNDER, ALICE);
    const synA = mgr.getAllSyndicates().find((s) => s.tag === 'AAA')!;
    // Now ALICE creates her own syndicate; the prior invite remains pending.
    mgr.createSyndicate(ALICE, 'Name2', 'BBB');
    expect(mgr.acceptInvite(ALICE, synA.id).error).toMatch(/leave your current syndicate/);
  });
});

describe('SyndicateManager membership mutations', () => {
  function setup(): {
    mgr: SyndicateManager;
    syndicateId: string;
  } {
    const { mgr } = makeMgr();
    const out = mgr.createSyndicate(FOUNDER, 'Crew', 'CRW');
    const syndicateId = out.syndicateId!;
    for (const w of [ALICE, BOB, CAROL]) {
      mgr.invitePlayer(FOUNDER, w);
      mgr.acceptInvite(w, syndicateId);
    }
    return { mgr, syndicateId };
  }

  it('member can leave', () => {
    const { mgr } = setup();
    expect(mgr.leaveSyndicate(ALICE).success).toBe(true);
    expect(mgr.getMemberSyndicate(ALICE)).toBeUndefined();
  });

  it('leader cannot leave with members remaining', () => {
    const { mgr } = setup();
    expect(mgr.leaveSyndicate(FOUNDER).error).toMatch(/transfer leadership or disband/);
  });

  it('leader auto-disbands when leaving as last member', () => {
    const { mgr } = makeMgr();
    mgr.createSyndicate(FOUNDER, 'Solo', 'SLO');
    expect(mgr.leaveSyndicate(FOUNDER).success).toBe(true);
    expect(mgr.getMemberSyndicate(FOUNDER)).toBeUndefined();
    expect(mgr.getAllSyndicates()).toHaveLength(0);
  });

  it('leader can kick anyone but themselves', () => {
    const { mgr } = setup();
    expect(mgr.kickMember(FOUNDER, FOUNDER).error).toMatch(/Cannot kick yourself/);
    expect(mgr.kickMember(FOUNDER, ALICE).success).toBe(true);
    expect(mgr.getMemberSyndicate(ALICE)).toBeUndefined();
  });

  it('officer can only kick regular members', () => {
    const { mgr } = setup();
    mgr.promoteMember(FOUNDER, ALICE);
    mgr.promoteMember(FOUNDER, BOB);
    // ALICE (officer) cannot kick BOB (also officer).
    expect(mgr.kickMember(ALICE, BOB).error).toMatch(/only kick regular members/);
    // ALICE can kick CAROL (member).
    expect(mgr.kickMember(ALICE, CAROL).success).toBe(true);
  });

  it('regular member cannot kick anyone', () => {
    const { mgr } = setup();
    expect(mgr.kickMember(ALICE, BOB).error).toMatch(/Only leaders and officers can kick/);
  });

  it('promote enforces officer cap (5)', () => {
    const stake = new FakeStakeManager();
    stake.setStake(FOUNDER, 'A', SYNDICATE_CREATION_COST + 1);
    const mgr = new SyndicateManager({ stakeManager: stake, logger: silentLogger });
    mgr.createSyndicate(FOUNDER, 'Big', 'BIG');
    const syndicateId = mgr.getAllSyndicates()[0]!.id;
    const wallets: string[] = [];
    for (let i = 0; i < 6; i++) {
      const w = `member_${i}`;
      wallets.push(w);
      mgr.invitePlayer(FOUNDER, w);
      mgr.acceptInvite(w, syndicateId);
    }
    // First 5 promote OK; 6th fails.
    for (let i = 0; i < 5; i++) expect(mgr.promoteMember(FOUNDER, wallets[i]!).success).toBe(true);
    expect(mgr.promoteMember(FOUNDER, wallets[5]!).error).toMatch(/Maximum 5 officers/);
  });

  it('demote requires officer role', () => {
    const { mgr } = setup();
    expect(mgr.demoteMember(FOUNDER, ALICE).error).toMatch(/not an officer/);
    mgr.promoteMember(FOUNDER, ALICE);
    expect(mgr.demoteMember(FOUNDER, ALICE).success).toBe(true);
    expect(mgr.getMemberRole(ALICE)).toBe('member');
  });

  it('only leader can promote/demote', () => {
    const { mgr } = setup();
    mgr.promoteMember(FOUNDER, ALICE);
    expect(mgr.promoteMember(ALICE, BOB).error).toMatch(/Only the leader/);
    expect(mgr.demoteMember(ALICE, ALICE).error).toMatch(/Only the leader/);
  });

  it('transferLeadership swaps roles correctly', () => {
    const { mgr } = setup();
    expect(mgr.transferLeadership(FOUNDER, ALICE).success).toBe(true);
    expect(mgr.getMemberRole(ALICE)).toBe('leader');
    expect(mgr.getMemberRole(FOUNDER)).toBe('officer');
    expect(mgr.getMemberSyndicate(ALICE)?.leaderId).toBe(ALICE);
  });

  it('transferLeadership rejects non-members', () => {
    const { mgr } = setup();
    expect(mgr.transferLeadership(FOUNDER, 'wallet_outsider').error).toMatch(
      /must be a syndicate member/,
    );
  });
});

describe('SyndicateManager settings + treasury', () => {
  it('updateSettings rejects rewardSplit out of range', () => {
    const { mgr } = makeMgr();
    mgr.createSyndicate(FOUNDER, 'Name', 'TAG');
    expect(mgr.updateSettings(FOUNDER, { rewardSplit: 31 }).error).toMatch(/0-30%/);
    expect(mgr.updateSettings(FOUNDER, { rewardSplit: -1 }).error).toMatch(/0-30%/);
  });

  it('updateSettings accepts valid rewardSplit and toggles', () => {
    const { mgr } = makeMgr();
    mgr.createSyndicate(FOUNDER, 'Name', 'TAG');
    expect(
      mgr.updateSettings(FOUNDER, {
        rewardSplit: 25,
        raidCoordination: false,
        defenseAlerts: false,
      }).success,
    ).toBe(true);
    const s = mgr.getMemberSyndicate(FOUNDER)!.settings;
    expect(s.rewardSplit).toBe(25);
    expect(s.raidCoordination).toBe(false);
    expect(s.defenseAlerts).toBe(false);
  });

  it('non-leader cannot update settings', () => {
    const { mgr } = makeMgr();
    mgr.createSyndicate(FOUNDER, 'Name', 'TAG');
    mgr.invitePlayer(FOUNDER, ALICE);
    mgr.acceptInvite(ALICE, mgr.getAllSyndicates()[0]!.id);
    expect(mgr.updateSettings(ALICE, { rewardSplit: 10 }).error).toMatch(/Only the leader/);
  });

  it('depositToTreasury bumps treasury and member contribution', () => {
    const { mgr } = makeMgr();
    mgr.createSyndicate(FOUNDER, 'Name', 'TAG');
    mgr.invitePlayer(FOUNDER, ALICE);
    mgr.acceptInvite(ALICE, mgr.getAllSyndicates()[0]!.id);
    expect(mgr.depositToTreasury(ALICE, 250).success).toBe(true);
    const s = mgr.getMemberSyndicate(ALICE)!;
    expect(s.treasury).toBe(250);
    expect(s.members.get(ALICE)!.totalContributed).toBe(250);
  });

  it('depositToTreasury rejects non-members and non-positive amounts', () => {
    const { mgr } = makeMgr();
    expect(mgr.depositToTreasury(ALICE, 100).error).toMatch(/not in a syndicate/);
    mgr.createSyndicate(FOUNDER, 'Name', 'TAG');
    expect(mgr.depositToTreasury(FOUNDER, 0).error).toMatch(/positive/);
    expect(mgr.depositToTreasury(FOUNDER, -1).error).toMatch(/positive/);
  });

  it('withdrawFromTreasury enforces leader-only and balance limits', () => {
    const { mgr } = makeMgr();
    mgr.createSyndicate(FOUNDER, 'Name', 'TAG');
    mgr.invitePlayer(FOUNDER, ALICE);
    mgr.acceptInvite(ALICE, mgr.getAllSyndicates()[0]!.id);
    mgr.depositToTreasury(ALICE, 500);

    expect(mgr.withdrawFromTreasury(ALICE, 100, BOB).error).toMatch(/Only the leader/);
    expect(mgr.withdrawFromTreasury(FOUNDER, 1000, BOB).error).toMatch(/Invalid amount/);
    expect(mgr.withdrawFromTreasury(FOUNDER, 100, BOB).success).toBe(true);
    expect(mgr.getMemberSyndicate(FOUNDER)!.treasury).toBe(400);
  });
});

describe('SyndicateManager browsing helpers', () => {
  function seed(): SyndicateManager {
    const stake = new FakeStakeManager();
    stake.setStake(FOUNDER, 'A', 5000);
    stake.setStake(ALICE, 'A', 5000);
    stake.setStake(BOB, 'A', 5000);
    const mgr = new SyndicateManager({ stakeManager: stake, logger: silentLogger });
    mgr.createSyndicate(FOUNDER, 'Astro Crew', 'AC');
    mgr.createSyndicate(ALICE, 'Belt Bandits', 'BB');
    mgr.createSyndicate(BOB, 'Cosmic Diggers', 'CD');
    return mgr;
  }

  it('searchSyndicates is case-insensitive on name and tag', () => {
    const mgr = seed();
    expect(mgr.searchSyndicates('astro').map((s) => s.tag)).toEqual(['AC']);
    expect(mgr.searchSyndicates('cd').map((s) => s.tag)).toEqual(['CD']);
    expect(mgr.searchSyndicates('zzzz')).toHaveLength(0);
  });

  it('getLeaderboard sorts by members or wins with limit', () => {
    const mgr = seed();
    // Synthetically bump one syndicate's wins.
    const ac = mgr.searchSyndicates('astro')[0]!;
    ac.warWins = 5;
    expect(mgr.getLeaderboard('wins', 1).map((s) => s.tag)).toEqual(['AC']);
    expect(mgr.getLeaderboard('members', 3)).toHaveLength(3);
  });

  it('disband removes syndicate, members, and reservedTag', () => {
    const stake = new FakeStakeManager();
    stake.setStake(FOUNDER, 'A', 5000);
    stake.setStake(ALICE, 'A', 5000);
    const mgr = new SyndicateManager({ stakeManager: stake, logger: silentLogger });
    mgr.createSyndicate(FOUNDER, 'Name', 'TAG');
    mgr.invitePlayer(FOUNDER, ALICE);
    mgr.acceptInvite(ALICE, mgr.getAllSyndicates()[0]!.id);

    expect(mgr.disbandSyndicate(FOUNDER).success).toBe(true);
    expect(mgr.getMemberSyndicate(FOUNDER)).toBeUndefined();
    expect(mgr.getMemberSyndicate(ALICE)).toBeUndefined();

    // Tag should be re-usable after disband.
    expect(mgr.createSyndicate(FOUNDER, 'New Name', 'TAG').success).toBe(true);
  });

  it('getStats reflects creation, members, and totalBurned', () => {
    const mgr = seed();
    const stats = mgr.getStats();
    expect(stats.totalSyndicates).toBe(3);
    expect(stats.totalMembers).toBe(3);
    expect(stats.totalCreated).toBe(3);
    expect(stats.totalBurned).toBe(SYNDICATE_CREATION_COST * 3);
    expect(stats.averageSize).toBeCloseTo(1, 5);
  });
});
