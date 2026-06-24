/**
 * Unit tests for `server/game/bet-escrow.ts`.
 *
 * Covers the BG-equivalent surface: pool creation (including
 * duplicate-id rejection), bet placement (active/resolved gating,
 * one-bet-per-wallet rule, attacker-vs-defender side accounting),
 * BetEscrowLike queries (hasLockedBets, getLockedBetAmount,
 * getActiveBets), resolution math (winner returns, 90% burn / 10%
 * defender split, stake-weighted defender payouts including the
 * floor-rounding behaviour), pool cleanup, and aggregate stats.
 *
 * Numerical constants under test: `BURN_SHARE_OF_LOSING_BETS = 0.9`
 * and `DEFENDER_SHARE_OF_LOSING_BETS = 0.1`. These are preserved
 * verbatim from BG.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BetEscrow } from '../../server/game/bet-escrow.js';
import type { GameLogger } from '../../server/game/interfaces.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ALICE = 'wallet_alice';
const BOB = 'wallet_bob';
const CAROL = 'wallet_carol';

function makeEscrow(): BetEscrow {
  return new BetEscrow({ logger: silentLogger });
}

describe('BetEscrow construction', () => {
  it('reports null escrow wallet when none is configured', () => {
    const e = makeEscrow();
    expect(e.getEscrowWallet()).toBeNull();
  });

  it('reports the configured escrow wallet', () => {
    const e = new BetEscrow({ escrowWallet: 'ESCROW_PUBKEY', logger: silentLogger });
    expect(e.getEscrowWallet()).toBe('ESCROW_PUBKEY');
  });
});

describe('BetEscrow pool lifecycle', () => {
  it('createRaidPool returns a fresh active pool', () => {
    const e = makeEscrow();
    const pool = e.createRaidPool('r1', 'TGT', 'SRC');
    expect(pool.raidId).toBe('r1');
    expect(pool.targetAsteroidId).toBe('TGT');
    expect(pool.sourceAsteroidId).toBe('SRC');
    expect(pool.status).toBe('active');
    expect(pool.totalAttackerBets).toBe(0);
    expect(pool.attackerBets.size).toBe(0);
    expect(e.getRaidPool('r1')).toBe(pool);
  });

  it('createRaidPool throws on duplicate raidId', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'TGT', 'SRC');
    expect(() => e.createRaidPool('r1', 'TGT', 'SRC')).toThrow(/already exists/);
  });

  it('getActiveRaidPools / getAllRaidPools partition correctly', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T1', 'S1');
    e.createRaidPool('r2', 'T2', 'S2');
    expect(e.getActiveRaidPools()).toHaveLength(2);
    expect(e.getAllRaidPools()).toHaveLength(2);

    e.placeBet('r1', ALICE, 'S1', 50, 'attacker', 'sig1');
    e.resolveRaid('r1', 'attacker', new Map());

    expect(e.getActiveRaidPools()).toHaveLength(1);
    expect(e.getActiveRaidPools()[0]?.raidId).toBe('r2');
    expect(e.getAllRaidPools()).toHaveLength(2);
  });
});

describe('BetEscrow placeBet', () => {
  it('throws when raid pool is unknown', () => {
    const e = makeEscrow();
    expect(() => e.placeBet('nope', ALICE, 'A', 50, 'attacker', 'sig')).toThrow(/not found/);
  });

  it('throws when raid pool is already resolved', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.resolveRaid('r1', 'attacker', new Map());
    expect(() => e.placeBet('r1', ALICE, 'S', 50, 'attacker', 'sig')).toThrow(
      /no longer accepting bets/,
    );
  });

  it('throws on duplicate wallet bet on the same pool', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.placeBet('r1', ALICE, 'S', 50, 'attacker', 'sig1');
    expect(() => e.placeBet('r1', ALICE, 'S', 25, 'attacker', 'sig2')).toThrow(/already has a bet/);
  });

  it('records attacker bets in the pool and bumps totalAttackerBets', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.placeBet('r1', ALICE, 'S', 50, 'attacker', 'sig1');
    e.placeBet('r1', BOB, 'S', 30, 'attacker', 'sig2');

    const pool = e.getRaidPool('r1')!;
    expect(pool.totalAttackerBets).toBe(80);
    expect(pool.attackerBets.size).toBe(2);
    expect(pool.attackerBets.get(ALICE)?.amount).toBe(50);
  });

  it('preserves BG quirk: defender bets are recorded but NOT pooled', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    const bet = e.placeBet('r1', ALICE, 'T', 25, 'defender', 'sig1');

    expect(bet.side).toBe('defender');
    expect(e.getBet(bet.id)?.side).toBe('defender');

    const pool = e.getRaidPool('r1')!;
    expect(pool.totalAttackerBets).toBe(0);
    expect(pool.attackerBets.size).toBe(0);

    // BetEscrowLike still surfaces the defender bet as locked.
    expect(e.hasLockedBets(ALICE)).toBe(true);
    expect(e.getLockedBetAmount(ALICE)).toBe(25);
  });

  it('opaque txSignature is preserved on the record', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    const bet = e.placeBet('r1', ALICE, 'S', 50, 'attacker', 'NOOP_abc');
    expect(bet.txSignature).toBe('NOOP_abc');
    expect(bet.returnTxSignature).toBeNull();
  });

  it('createdAt is populated and resolvedAt is null until resolution', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    const bet = e.placeBet('r1', ALICE, 'S', 50, 'attacker', 'sig');
    expect(bet.createdAt).toBeInstanceOf(Date);
    expect(bet.resolvedAt).toBeNull();
    expect(bet.status).toBe('locked');
  });
});

describe('BetEscrow BetEscrowLike queries', () => {
  it('hasLockedBets / getLockedBetAmount: empty wallet', () => {
    const e = makeEscrow();
    expect(e.hasLockedBets(ALICE)).toBe(false);
    expect(e.getLockedBetAmount(ALICE)).toBe(0);
    expect(e.getActiveBets(ALICE)).toEqual([]);
  });

  it('aggregates locked bets across multiple pools', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T1', 'S1');
    e.createRaidPool('r2', 'T2', 'S2');
    e.placeBet('r1', ALICE, 'S1', 25, 'attacker', 's1');
    e.placeBet('r2', ALICE, 'S2', 75, 'attacker', 's2');

    expect(e.hasLockedBets(ALICE)).toBe(true);
    expect(e.getLockedBetAmount(ALICE)).toBe(100);
    expect(e.getActiveBets(ALICE)).toHaveLength(2);
  });

  it('resolved bets stop counting toward locked totals', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.placeBet('r1', ALICE, 'S', 60, 'attacker', 'sig');
    expect(e.getLockedBetAmount(ALICE)).toBe(60);

    e.resolveRaid('r1', 'attacker', new Map());
    expect(e.hasLockedBets(ALICE)).toBe(false);
    expect(e.getLockedBetAmount(ALICE)).toBe(0);
    expect(e.getActiveBets(ALICE)).toEqual([]);
  });
});

describe('BetEscrow resolveRaid', () => {
  it('throws when raid pool is unknown', () => {
    const e = makeEscrow();
    expect(() => e.resolveRaid('nope', 'attacker', new Map())).toThrow(/not found/);
  });

  it('throws when called twice on the same raid', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.resolveRaid('r1', 'attacker', new Map());
    expect(() => e.resolveRaid('r1', 'defender', new Map())).toThrow(/already resolved/);
  });

  it('attackers win: every bet is returned, none burned', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.placeBet('r1', ALICE, 'S', 100, 'attacker', 'a');
    e.placeBet('r1', BOB, 'S', 60, 'attacker', 'b');

    const r = e.resolveRaid('r1', 'attacker', new Map());

    expect(r.totalBurned).toBe(0);
    expect(r.totalDistributedToDefenders).toBe(0);
    expect(r.totalReturnedToWinners).toBe(160);
    expect(r.winnerPayouts.get(ALICE)).toBe(100);
    expect(r.winnerPayouts.get(BOB)).toBe(60);
    expect(r.defenderPayouts.size).toBe(0);

    expect(e.getBet(e.getRaidPool('r1')!.attackerBets.get(ALICE)!.id)?.status).toBe('won');
  });

  it('defenders win: 90% of every bet burned, 10% to defenders', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.placeBet('r1', ALICE, 'S', 100, 'attacker', 'a');
    e.placeBet('r1', BOB, 'S', 50, 'attacker', 'b');

    // CAROL is the only defender.
    const r = e.resolveRaid('r1', 'defender', new Map([[CAROL, 1000]]));

    // ALICE 100: floor(100*0.9)=90 burned, 10 to defenders.
    // BOB 50:   floor(50*0.9)=45 burned, 5 to defenders.
    expect(r.totalBurned).toBe(135);
    expect(r.totalDistributedToDefenders).toBe(15);
    expect(r.totalReturnedToWinners).toBe(0);
    expect(r.winnerPayouts.size).toBe(0);
    // CAROL gets 100% of the spoils.
    expect(r.defenderPayouts.get(CAROL)).toBe(15);

    expect(e.getBet(e.getRaidPool('r1')!.attackerBets.get(ALICE)!.id)?.status).toBe('lost');
  });

  it('defender spoils are weighted by stake', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.placeBet('r1', ALICE, 'S', 1000, 'attacker', 'a');

    // ALICE 1000: floor(1000*0.9)=900 burned, 100 to defenders.
    // CAROL has 3x BOB's stake -> CAROL gets 75, BOB gets 25.
    const r = e.resolveRaid(
      'r1',
      'defender',
      new Map([
        [BOB, 100],
        [CAROL, 300],
      ]),
    );

    expect(r.totalBurned).toBe(900);
    expect(r.totalDistributedToDefenders).toBe(100);
    expect(r.defenderPayouts.get(BOB)).toBe(25);
    expect(r.defenderPayouts.get(CAROL)).toBe(75);
  });

  it('floor-rounding can drop dust on uneven splits (BG quirk preserved)', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.placeBet('r1', ALICE, 'S', 100, 'attacker', 'a'); // pool = 10 to defenders

    // 3 equal-stake defenders: 10 / 3 = 3.33 → floor → 3 each → 9 total, 1 lost.
    const r = e.resolveRaid(
      'r1',
      'defender',
      new Map([
        [BOB, 1],
        [CAROL, 1],
        ['wallet_dave', 1],
      ]),
    );

    expect(r.totalDistributedToDefenders).toBe(10);
    expect(r.defenderPayouts.get(BOB)).toBe(3);
    expect(r.defenderPayouts.get(CAROL)).toBe(3);
    expect(r.defenderPayouts.get('wallet_dave')).toBe(3);
  });

  it('floor-to-zero entries leak in (BG quirk: `share > 0` check is pre-floor)', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.placeBet('r1', ALICE, 'S', 5, 'attacker', 'a'); // pool = floor(5*0.9)=4, defenders=1

    // 100 defenders with stake 1 each. Each share = (1/100)*1 = 0.01.
    // BG checks `if (share > 0)` against the unfloored value (0.01 > 0 = true),
    // then stores `Math.floor(0.01) = 0`. Result: all 100 defenders in the
    // map with value 0. Verbatim BG behaviour, preserved here.
    const stakes = new Map<string, number>();
    for (let i = 0; i < 100; i++) stakes.set(`def${i}`, 1);

    const r = e.resolveRaid('r1', 'defender', stakes);
    expect(r.defenderPayouts.size).toBe(100);
    for (const value of r.defenderPayouts.values()) {
      expect(value).toBe(0);
    }
  });

  it('defenders win with no attacker bets: empty resolution', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    const r = e.resolveRaid('r1', 'defender', new Map([[BOB, 100]]));
    expect(r.totalBurned).toBe(0);
    expect(r.totalDistributedToDefenders).toBe(0);
    expect(r.defenderPayouts.size).toBe(0);
  });

  it('defenders win with no defender stakes: 10% share is "lost" (BG behaviour)', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.placeBet('r1', ALICE, 'S', 100, 'attacker', 'a');

    const r = e.resolveRaid('r1', 'defender', new Map());

    expect(r.totalBurned).toBe(90);
    expect(r.totalDistributedToDefenders).toBe(10);
    // No defender stakes -> nothing is paid out -> 10 effectively "lost".
    expect(r.defenderPayouts.size).toBe(0);
  });

  it('marks the pool as resolved with winningSide and resolvedAt set', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.placeBet('r1', ALICE, 'S', 50, 'attacker', 'a');
    e.resolveRaid('r1', 'attacker', new Map());

    const pool = e.getRaidPool('r1')!;
    expect(pool.status).toBe('resolved');
    expect(pool.winningSide).toBe('attacker');
    expect(pool.resolvedAt).toBeInstanceOf(Date);
  });
});

describe('BetEscrow cleanupResolvedPools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps active pools regardless of age', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
    expect(e.cleanupResolvedPools()).toBe(0);
    expect(e.getRaidPool('r1')).toBeDefined();
  });

  it('drops resolved pools older than the configured window and removes their bets', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.placeBet('r1', ALICE, 'S', 50, 'attacker', 'sig');
    e.resolveRaid('r1', 'attacker', new Map());

    // Default 24h window.
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(e.cleanupResolvedPools()).toBe(1);
    expect(e.getRaidPool('r1')).toBeUndefined();
    expect(e.hasLockedBets(ALICE)).toBe(false);
    expect(e.getActiveBets(ALICE)).toEqual([]);
  });

  it('respects a custom maxAgeMs argument', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.resolveRaid('r1', 'attacker', new Map());

    vi.advanceTimersByTime(2 * 60 * 1000);
    // 1-minute window: resolved 2 minutes ago is past.
    expect(e.cleanupResolvedPools(60 * 1000)).toBe(1);
  });

  it('keeps resolved pools that are still inside the window', () => {
    const e = makeEscrow();
    e.createRaidPool('r1', 'T', 'S');
    e.resolveRaid('r1', 'attacker', new Map());
    vi.advanceTimersByTime(60 * 1000);
    expect(e.cleanupResolvedPools()).toBe(0);
    expect(e.getRaidPool('r1')).toBeDefined();
  });
});

describe('BetEscrow stats', () => {
  it('reports zero counts for an empty escrow', () => {
    const e = makeEscrow();
    const s = e.getStats();
    expect(s.activeRaids).toBe(0);
    expect(s.totalLockedBets).toBe(0);
    expect(s.totalBettors).toBe(0);
    expect(s.escrowWallet).toBeNull();
  });

  it('aggregates active pools only', () => {
    const e = new BetEscrow({ escrowWallet: 'ESCROW', logger: silentLogger });
    e.createRaidPool('r1', 'T1', 'S1');
    e.createRaidPool('r2', 'T2', 'S2');
    e.placeBet('r1', ALICE, 'S1', 50, 'attacker', 'a');
    e.placeBet('r1', BOB, 'S1', 30, 'attacker', 'b');
    e.placeBet('r2', ALICE, 'S2', 20, 'attacker', 'c');

    e.resolveRaid('r2', 'attacker', new Map());

    const s = e.getStats();
    expect(s.activeRaids).toBe(1); // r1 only; r2 resolved
    expect(s.totalLockedBets).toBe(80); // r1 attacker bets
    expect(s.totalBettors).toBe(2);
    expect(s.escrowWallet).toBe('ESCROW');
  });
});
