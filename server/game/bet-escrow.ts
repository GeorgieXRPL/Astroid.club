/**
 * Bet escrow ledger for astroid.club.
 *
 * Ported from `Black-Gold-main/server/game/bet-escrow.ts` per
 * `docs/PORTING_NOTES.md`. The bet-pool lifecycle (create → place →
 * locked → resolve → cleanup), the lookup indexes (by raid, by
 * wallet), and the resolution math (90% burn / 10% defender share,
 * weighted by stake) are byte-identical to BG.
 *
 * Architectural change: BG's class did two things — track bets in
 * memory **and** build Solana transactions (deposit, payout, burn) via
 * `@solana/web3.js` and `@solana/spl-token`. astroid.club splits those
 * concerns:
 *
 * - This file holds the **pure in-memory ledger** with zero chain
 *   dependencies. It can be unit tested without Solana mocks and is
 *   the source of truth for `BetEscrowLike.hasLockedBets` /
 *   `getLockedBetAmount` queries.
 * - The chain-side counterpart (transaction building, on-chain verify,
 *   payouts, burns) lives in a future `bet-escrow-chain.ts` slice.
 *   Wallet flow when `CHAIN_ENABLED=true`: route handler builds tx,
 *   user signs, server verifies signature, then calls `placeBet(...,
 *   txSignature)`. When `CHAIN_ENABLED=false`: the route handler skips
 *   build/sign/verify and calls `placeBet(..., 'NOOP_<betId>')`
 *   directly — the ledger doesn't care.
 *
 * BG quirk preserved: `placeBet` accepts a `'defender'` side but only
 * `'attacker'` bets are added to the pool's `attackerBets` map and
 * counted in `totalAttackerBets`. Defender stakes are tracked
 * elsewhere (stake manager) and supplied to `resolveRaid` separately.
 */

import type { BetEscrowLike, GameLogger } from './interfaces.js';

/** Lifecycle status of an individual bet. */
export type BetStatus = 'pending' | 'locked' | 'won' | 'lost' | 'returned' | 'burned';

/** A single bet placed by a wallet on a raid. */
export interface BetRecord {
  id: string;
  raidId: string;
  walletAddress: string;
  asteroidId: string;
  amount: number;
  side: 'attacker' | 'defender';
  status: BetStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  /** Deposit tx signature (real signature when chain enabled, placeholder otherwise). */
  txSignature: string | null;
  /** Return / burn tx signature, populated by the chain layer post-resolve. */
  returnTxSignature: string | null;
}

/** All bets staked on a single raid. */
export interface RaidBetPool {
  raidId: string;
  targetAsteroidId: string;
  sourceAsteroidId: string;
  /** wallet -> bet record. BG quirk: only `'attacker'` bets land here. */
  attackerBets: Map<string, BetRecord>;
  totalAttackerBets: number;
  status: 'active' | 'resolved';
  createdAt: Date;
  resolvedAt: Date | null;
  winningSide: 'attacker' | 'defender' | null;
}

/** Settlement summary returned by `resolveRaid`. */
export interface EscrowResolution {
  raidId: string;
  winningSide: 'attacker' | 'defender';
  totalBurned: number;
  totalReturnedToWinners: number;
  totalDistributedToDefenders: number;
  /** Attackers who won their bets back (wallet -> amount). */
  winnerPayouts: Map<string, number>;
  /** Defenders' weighted share of the 10% spoils (wallet -> amount). */
  defenderPayouts: Map<string, number>;
}

/** Aggregate escrow statistics. */
export interface EscrowStats {
  activeRaids: number;
  totalLockedBets: number;
  totalBettors: number;
  /** Reported as configured even when no real chain is wired. */
  escrowWallet: string | null;
}

/** Configuration accepted by the bet escrow. */
export interface BetEscrowConfig {
  /**
   * Address of the escrow wallet on Solana. Used for stats reporting
   * and (in the future chain slice) as the destination for deposits.
   * Optional in the in-memory ledger; null is fine.
   */
  escrowWallet?: string | null;
  /** Token symbol for log lines. Defaults to "$ASTROID". */
  tokenSymbol?: string;
  logger?: GameLogger;
}

/**
 * Burn share of lost bets — preserved verbatim from BG. The defender
 * share is implicitly `(1 - BURN_SHARE_OF_LOSING_BETS)` and is computed
 * per-bet as `bet.amount - burnAmount` (BG used subtraction rather
 * than a separate constant; we do too, so a defender-only constant
 * would be unused noise).
 */
const BURN_SHARE_OF_LOSING_BETS = 0.9;
/** Default cleanup window for resolved pools (24h) — preserved verbatim from BG. */
const DEFAULT_CLEANUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * In-memory bet ledger. Tracks raid-bet pools, individual bet records,
 * and resolution outcomes. Implements `BetEscrowLike` so the stake
 * manager can query locked bets.
 */
export class BetEscrow implements BetEscrowLike {
  private readonly raidPools: Map<string, RaidBetPool> = new Map();
  /** wallet -> set of bet ids. */
  private readonly betsByWallet: Map<string, Set<string>> = new Map();
  /** betId -> bet record. */
  private readonly bets: Map<string, BetRecord> = new Map();

  private readonly escrowWallet: string | null;
  private readonly tokenSymbol: string;
  private readonly log: GameLogger;

  constructor(config: BetEscrowConfig = {}) {
    this.escrowWallet = config.escrowWallet ?? null;
    this.tokenSymbol = config.tokenSymbol ?? '$ASTROID';
    this.log = config.logger ?? defaultLogger();
  }

  /** Get the configured escrow wallet (null when not yet configured). */
  getEscrowWallet(): string | null {
    return this.escrowWallet;
  }

  // --------- Pool lifecycle ---------

  /**
   * Create a new raid bet pool. Throws if a pool with the same raidId
   * already exists (BG behaviour: caller is expected to use a unique
   * raid id like a uuid).
   */
  createRaidPool(raidId: string, targetAsteroidId: string, sourceAsteroidId: string): RaidBetPool {
    if (this.raidPools.has(raidId)) {
      throw new Error(`Raid pool ${raidId} already exists`);
    }

    const pool: RaidBetPool = {
      raidId,
      targetAsteroidId,
      sourceAsteroidId,
      attackerBets: new Map(),
      totalAttackerBets: 0,
      status: 'active',
      createdAt: new Date(),
      resolvedAt: null,
      winningSide: null,
    };

    this.raidPools.set(raidId, pool);
    this.log.info(`[BetEscrow] Created raid pool: ${raidId}`);
    return pool;
  }

  /**
   * Record a placed bet. Throws on missing pool, resolved pool, or
   * duplicate wallet bet on the same raid. `txSignature` is opaque to
   * the ledger — caller passes a real signature (chain on) or a
   * placeholder like `'NOOP_<betId>'` (chain off).
   *
   * BG quirk preserved: bets with `side === 'defender'` are stored in
   * the bet ledger but NOT added to `attackerBets` / `totalAttackerBets`.
   * Defender side accounting is handled by the stake manager.
   */
  placeBet(
    raidId: string,
    walletAddress: string,
    asteroidId: string,
    amount: number,
    side: 'attacker' | 'defender',
    txSignature: string,
  ): BetRecord {
    const pool = this.raidPools.get(raidId);
    if (!pool) {
      throw new Error(`Raid pool ${raidId} not found`);
    }
    if (pool.status !== 'active') {
      throw new Error(`Raid ${raidId} is no longer accepting bets`);
    }
    if (pool.attackerBets.has(walletAddress)) {
      throw new Error(`Wallet ${walletAddress} already has a bet on raid ${raidId}`);
    }

    const betId = `bet_${raidId}_${walletAddress}_${Date.now()}`;
    const bet: BetRecord = {
      id: betId,
      raidId,
      walletAddress,
      asteroidId,
      amount,
      side,
      status: 'locked',
      createdAt: new Date(),
      resolvedAt: null,
      txSignature,
      returnTxSignature: null,
    };

    this.bets.set(betId, bet);

    if (side === 'attacker') {
      pool.attackerBets.set(walletAddress, bet);
      pool.totalAttackerBets += amount;
    }

    let walletBets = this.betsByWallet.get(walletAddress);
    if (!walletBets) {
      walletBets = new Set();
      this.betsByWallet.set(walletAddress, walletBets);
    }
    walletBets.add(betId);

    this.log.info(
      `[BetEscrow] Bet placed: ${walletAddress} bet ${amount} ${this.tokenSymbol} on ${side} ` +
        `for raid ${raidId}`,
    );
    return bet;
  }

  // --------- BetEscrowLike queries ---------

  hasLockedBets(walletAddress: string): boolean {
    const walletBets = this.betsByWallet.get(walletAddress);
    if (!walletBets) return false;
    for (const betId of walletBets) {
      const bet = this.bets.get(betId);
      if (bet && bet.status === 'locked') return true;
    }
    return false;
  }

  getLockedBetAmount(walletAddress: string): number {
    const walletBets = this.betsByWallet.get(walletAddress);
    if (!walletBets) return 0;
    let total = 0;
    for (const betId of walletBets) {
      const bet = this.bets.get(betId);
      if (bet && bet.status === 'locked') total += bet.amount;
    }
    return total;
  }

  /** All currently-locked bets for a wallet. */
  getActiveBets(walletAddress: string): BetRecord[] {
    const walletBets = this.betsByWallet.get(walletAddress);
    if (!walletBets) return [];
    const active: BetRecord[] = [];
    for (const betId of walletBets) {
      const bet = this.bets.get(betId);
      if (bet && bet.status === 'locked') active.push(bet);
    }
    return active;
  }

  /** Read a bet by id. */
  getBet(betId: string): BetRecord | undefined {
    return this.bets.get(betId);
  }

  // --------- Resolution ---------

  /**
   * Settle a raid: mark every attacker bet as won/lost, compute the
   * defender spoils pool (10% of lost bet value), and distribute it
   * weighted by `defenderStakes`. The defender share is floored per
   * recipient — this preserves BG's exact integer-rounding behaviour
   * (small dust may be lost on the floor; intentional and verified
   * in tests).
   */
  resolveRaid(
    raidId: string,
    winningSide: 'attacker' | 'defender',
    defenderStakes: Map<string, number>,
  ): EscrowResolution {
    const pool = this.raidPools.get(raidId);
    if (!pool) {
      throw new Error(`Raid pool ${raidId} not found`);
    }
    if (pool.status !== 'active') {
      throw new Error(`Raid ${raidId} already resolved`);
    }

    const resolution: EscrowResolution = {
      raidId,
      winningSide,
      totalBurned: 0,
      totalReturnedToWinners: 0,
      totalDistributedToDefenders: 0,
      winnerPayouts: new Map(),
      defenderPayouts: new Map(),
    };

    for (const [walletAddress, bet] of pool.attackerBets) {
      if (winningSide === 'attacker') {
        bet.status = 'won';
        bet.resolvedAt = new Date();
        resolution.totalReturnedToWinners += bet.amount;
        resolution.winnerPayouts.set(walletAddress, bet.amount);
      } else {
        bet.status = 'lost';
        bet.resolvedAt = new Date();
        const burnAmount = Math.floor(bet.amount * BURN_SHARE_OF_LOSING_BETS);
        const defenderShare = bet.amount - burnAmount;
        resolution.totalBurned += burnAmount;
        resolution.totalDistributedToDefenders += defenderShare;
      }
    }

    if (winningSide === 'defender' && resolution.totalDistributedToDefenders > 0) {
      const totalDefenderStake = Array.from(defenderStakes.values()).reduce((a, b) => a + b, 0);
      if (totalDefenderStake > 0) {
        for (const [walletAddress, stake] of defenderStakes) {
          const share = (stake / totalDefenderStake) * resolution.totalDistributedToDefenders;
          if (share > 0) {
            resolution.defenderPayouts.set(walletAddress, Math.floor(share));
          }
        }
      }
    }

    pool.status = 'resolved';
    pool.resolvedAt = new Date();
    pool.winningSide = winningSide;

    this.log.info(
      `[BetEscrow] Raid ${raidId} resolved: ${winningSide} won. ` +
        `Burned: ${resolution.totalBurned}, Returned: ${resolution.totalReturnedToWinners}, ` +
        `Defender spoils: ${resolution.totalDistributedToDefenders}`,
    );
    return resolution;
  }

  // --------- Inspection ---------

  getRaidPool(raidId: string): RaidBetPool | undefined {
    return this.raidPools.get(raidId);
  }

  getActiveRaidPools(): RaidBetPool[] {
    return Array.from(this.raidPools.values()).filter((p) => p.status === 'active');
  }

  getAllRaidPools(): RaidBetPool[] {
    return Array.from(this.raidPools.values());
  }

  /**
   * Drop resolved pools and their bets older than `maxAgeMs`. Returns
   * the number of pools removed. Default window: 24 hours, preserved
   * from BG.
   */
  cleanupResolvedPools(maxAgeMs: number = DEFAULT_CLEANUP_WINDOW_MS): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [raidId, pool] of this.raidPools) {
      if (pool.status !== 'resolved' || !pool.resolvedAt) continue;
      const age = now - pool.resolvedAt.getTime();
      if (age <= maxAgeMs) continue;

      for (const bet of pool.attackerBets.values()) {
        const walletBets = this.betsByWallet.get(bet.walletAddress);
        if (walletBets) {
          walletBets.delete(bet.id);
          if (walletBets.size === 0) {
            this.betsByWallet.delete(bet.walletAddress);
          }
        }
        this.bets.delete(bet.id);
      }

      this.raidPools.delete(raidId);
      cleaned++;
    }

    if (cleaned > 0) {
      this.log.info(`[BetEscrow] Cleaned up ${cleaned} old raid pools`);
    }
    return cleaned;
  }

  /** Aggregate stats across active raid pools. */
  getStats(): EscrowStats {
    let totalLockedBets = 0;
    let totalBettors = 0;
    for (const pool of this.raidPools.values()) {
      if (pool.status === 'active') {
        totalLockedBets += pool.totalAttackerBets;
        totalBettors += pool.attackerBets.size;
      }
    }
    return {
      activeRaids: this.getActiveRaidPools().length,
      totalLockedBets,
      totalBettors,
      escrowWallet: this.escrowWallet,
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
