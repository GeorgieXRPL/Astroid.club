/**
 * Dependency interfaces consumed by the game modules.
 *
 * BG used module-level singletons (`getMineRegistry()`, `getStakeManager()`,
 * `getExpeditionTracker()`, `getCooldownManager()`). astroid.club replaces
 * those with constructor injection so each game module is independently
 * testable, can be swapped for in-memory test doubles, and meshes with the
 * engine's `DependencyContainer`. Each interface declares only the methods
 * the consumer module actually calls — narrowest possible surface for
 * mocking.
 *
 * The concrete implementations land in subsequent slices per
 * `docs/PORTING_NOTES.md`.
 */

import type {
  AsteroidState,
  CooldownType,
  DefenderSpoils,
  Expedition,
  MinerGameState,
  StakeRecord,
  Syndicate,
} from './types.js';

/** Subset of the asteroid registry needed by the raid + expedition modules. */
export interface AsteroidRegistryLike {
  /** Get the live state of an asteroid by ID. */
  getAsteroid(asteroidId: string): AsteroidState | undefined;
  /** Whether the asteroid currently has raid immunity. */
  hasRaidImmunity(asteroidId: string): boolean;
  /** Apply the post-raid attack debuff to the target asteroid. */
  applyAttackDebuff(asteroidId: string): void;
  /** Apply the post-defense buff to the target asteroid. */
  applyDefenseBuff(asteroidId: string): void;
  /** Track an incoming raid against the asteroid. */
  addIncomingRaid(asteroidId: string, expeditionId: string): void;
  /** Remove an incoming raid from the asteroid (raid resolved or cancelled). */
  removeIncomingRaid(asteroidId: string, expeditionId: string): void;
  /** Adjust an asteroid's `totalStake` by a delta (used by the stake manager). */
  updateAsteroidStake(asteroidId: string, stakeDelta: number): void;
  /**
   * Discovery-yield multiplier from an active meteor-strike penalty (1.0 when
   * none). Optional so lightweight fakes/tests need not implement it.
   */
  getMeteorYieldMultiplier?(asteroidId: string): number;
}

/** Subset of the stake manager needed by the raid + expedition modules. */
export interface StakeManagerLike {
  /** Get the miner's game state (for expedition gating, cooldowns, etc.). */
  getMinerState(walletAddress: string): MinerGameState;
  /** Get a wallet's defense power at a given asteroid. */
  getDefensePower(walletAddress: string, asteroidId: string): number;
  /** Get a wallet's stake at a given asteroid. */
  getStakeAtAsteroid(walletAddress: string, asteroidId: string): number;
  /** Get a wallet's total stake across every asteroid. */
  getTotalStake(walletAddress: string): number;
  /** Get every stake record for a wallet (used by the syndicate creation cost burn). */
  getWalletStakes(walletAddress: string): StakeRecord[];
  /**
   * Process a bet: deduct the bet amount from the wallet's stake (held in
   * escrow until the raid resolves). Returns true on success, false if the
   * wallet has insufficient stake or the bet exceeds policy caps.
   */
  processBet(walletAddress: string, asteroidId: string, amount: number): boolean;
  /** Burn a bet on a failed raid. */
  burnBet(walletAddress: string, asteroidId: string, amount: number): void;
  /** Return a bet plus winnings to a winning attacker. */
  returnBetWithWinnings(
    walletAddress: string,
    asteroidId: string,
    bet: number,
    winnings: number,
  ): void;
  /** Add a pending yield to a wallet's rewards (defender spoils). */
  addPendingYield(walletAddress: string, asteroidId: string, amount: number): void;
  /** Unstake a wallet's tokens (used for rally-defense cost). */
  unstake(walletAddress: string, asteroidId: string, amount: number): void;
  /**
   * Outstanding (unredeemed) credit liability across all wallets:
   * lifetime earned minus lifetime redeemed. Used by the emission governor
   * to taper issuance as the redeemable backing is approached. Optional so
   * lightweight test doubles don't have to implement it.
   */
  getOutstandingCredits?(): number;
}

/** Subset of the expedition tracker needed by the raid module. */
export interface ExpeditionTrackerLike {
  /** Look up an expedition by ID. */
  getExpedition(expeditionId: string): Expedition | undefined;
  /** Get all expeditions targeting a given asteroid. */
  getExpeditionsTargeting(asteroidId: string): Expedition[];
  /** Total incoming attack power against a given asteroid. */
  getTotalAttackPower(asteroidId: string): number;
  /** Mark an expedition complete with the winner. */
  completeExpedition(expeditionId: string, attackersWon: boolean): void;
}

/** Subset of the cooldown manager needed by the expedition tracker. */
export interface CooldownManagerLike {
  /**
   * Check if an action is currently allowed for a wallet. Returns null if
   * allowed, or a human-readable error message if blocked.
   */
  checkAction(walletAddress: string, type: CooldownType): string | null;
  /** Apply a cooldown of the given type to the wallet. */
  applyCooldown(walletAddress: string, type: CooldownType): void;
}

/**
 * Subset of the bet-escrow manager needed by the stake manager. BG's
 * stake manager queries this on user-facing unstakes to surface a
 * "you have locked bets" warning. Bet escrow itself lands in a later
 * slice — until then, a no-op stub satisfies the interface.
 */
export interface BetEscrowLike {
  /** Whether the wallet has any currently-locked bets. */
  hasLockedBets(walletAddress: string): boolean;
  /** Total $ASTROID amount locked across the wallet's active bets. */
  getLockedBetAmount(walletAddress: string): number;
}

/**
 * Pluggable persistence for "which asteroid is this wallet's home
 * station". BG used a Redis-backed store directly; we accept any
 * implementation (in-memory, Redis via the engine's `RedisStorage`,
 * etc.) so the stake manager doesn't pin the storage layer.
 *
 * Methods may be sync or async; the stake manager awaits them.
 */
export interface HomeStationStore {
  /** Persist the wallet's home-station asteroid id. */
  set(walletAddress: string, asteroidId: string): Promise<void> | void;
  /** Read back a previously-persisted home-station id, or null. */
  get(walletAddress: string): Promise<string | null> | string | null;
}

/**
 * Pluggable persistence for in-game pending yield (the redeemable IOU
 * credit ledger). In the default in-memory build this is unset and
 * credits live only in the `StakeManager`'s `Map` — a restart wipes
 * them. Wiring a durable store (Redis) lets credits survive gateway
 * restarts and redeploys until they're claimed/redeemed.
 *
 * Writes are fire-and-forget (mirrors `HomeStationStore`): the in-memory
 * map stays the source of truth at runtime and the store is a durable
 * mirror restored on boot. Methods may be sync or async.
 */
export interface PendingYieldStore {
  /** Persist the wallet's current total pending yield. */
  set(walletAddress: string, amount: number): Promise<void> | void;
  /** Remove the wallet's pending yield (called after a claim). */
  delete(walletAddress: string): Promise<void> | void;
  /** Read every persisted wallet -> pending-yield amount. Used on boot. */
  getAll(): Promise<Map<string, number>> | Map<string, number>;
}

/**
 * Pluggable persistence for per-asteroid raid-vault treasuries. Without
 * it the vault lives only in the `RaidVaultManager`'s `Map`, so a gateway
 * restart/redeploy resets every asteroid's treasury to 0 (the "treasuries
 * vanished after a deploy" report). Wiring a durable store (Redis or
 * Postgres) lets accumulated treasuries survive restarts.
 *
 * Like {@link PendingYieldStore}, the in-memory map stays the runtime
 * source of truth and writes are fire-and-forget — a store blip must never
 * reject a discovery or raid. Balances are restored on boot. Methods may be
 * sync or async.
 */
export interface RaidVaultStore {
  /** Persist an asteroid's current vault balance (whole tokens). */
  set(asteroidId: string, balance: number): Promise<void> | void;
  /** Read every persisted asteroid -> vault balance. Used on boot. */
  getAll(): Promise<Map<string, number>> | Map<string, number>;
}

/**
 * Durable, AUDITABLE persistence for pending yield as an append-only
 * event log (the production posture — Postgres/Supabase). Where
 * `PendingYieldStore` mirrors only the *current balance* (a cache, e.g.
 * Redis), a `YieldLedger` records every credit/claim/redemption as an
 * immutable event and derives the balance from their sum. That history
 * is what lets a real-money sweepstakes reconcile against on-chain,
 * resolve disputes, and replay state.
 *
 * Writes are fire-and-forget from the game's perspective (the in-memory
 * Map stays the runtime source of truth); the ledger is the durable book
 * of record restored on boot. Methods may be sync or async.
 */
export interface YieldLedger {
  /** Append a positive credit event (a discovery/raid payout). */
  recordCredit(walletAddress: string, asteroidId: string, amount: number): Promise<void> | void;
  /** Append a negative claim event zeroing the wallet's balance. */
  recordClaim(walletAddress: string, amount: number): Promise<void> | void;
  /**
   * Append a negative `redeem` event debiting the wallet's in-game balance
   * when that value is moved on-chain (bridged to IOU-ASTROID / redeemed for
   * $ASTROID). Recorded as a distinct `kind` from `claim` so the audit trail
   * separates "banked in-game" from "converted to an on-chain token". The
   * caller passes the positive amount being redeemed; the ledger debits it.
   */
  recordRedeem(walletAddress: string, amount: number): Promise<void> | void;
  /**
   * Current balance per wallet, derived from the event log. Read on boot
   * to repopulate in-memory pending yield. Only positive balances.
   */
  getAllBalances(): Promise<Map<string, number>> | Map<string, number>;
  /**
   * Optional: lifetime gross totals per wallet derived from the event log —
   * `earned` (sum of credits) and `redeemed` (sum of claims + redemptions,
   * as positive amounts). Powers the player "rewards accumulator" so the
   * record of what was earned/claimed survives a restart. Stores that can't
   * cheaply compute this may omit it.
   */
  getLifetimeTotals?():
    | Promise<Map<string, { earned: number; redeemed: number }>>
    | Map<string, { earned: number; redeemed: number }>;
}

/** Lifecycle status of a durable escrow wager record. */
export type EscrowWagerStatus = 'active' | 'settling' | 'settled' | 'failed';

/** One on-chain leg of a wager settlement, with its own completion flag. */
export interface EscrowSettlementLeg {
  kind: 'return' | 'burn' | 'payout';
  /** Recipient wallet for `return` / `payout` legs (omitted for `burn`). */
  wallet?: string;
  amount: number;
  done: boolean;
  signature?: string;
}

/**
 * Durable record of a single on-chain raid wager and (once resolved) its
 * settlement plan. This is the system-of-record for escrow LIABILITY: it
 * survives gateway restarts so funds custodied on-chain are never lost
 * track of, and the per-leg `done` flags let a failed settlement resume
 * exactly where it left off instead of double-paying.
 */
export interface EscrowWagerRecord {
  wagerId: string;
  /** The raider who deposited the wager. */
  wallet: string;
  /** Escrowed amount in whole $ASTROID. */
  amount: number;
  expeditionId?: string;
  targetAsteroid?: string;
  depositSignature?: string;
  status: EscrowWagerStatus;
  /** Settlement legs, populated once the raid resolves (or a refund starts). */
  legs?: EscrowSettlementLeg[];
  retries: number;
  lastError?: string;
}

/**
 * The resolved outcome of a wager, handed from the game world to the
 * durable escrow manager. Exactly one of `returnTo` / `burn` is the
 * primary disposition; `defenderPayouts` accompanies a `burn` on a
 * defender win (spoils split). All amounts are whole $ASTROID.
 */
export interface WagerSettlement {
  wagerId: string;
  /** Attacker won → return the full wager to this raider. */
  returnTo?: { wallet: string; amount: number };
  /** Defender win / forfeit → burn this amount (the deflationary sink). */
  burn?: number;
  /** Defender win → stake-weighted spoils paid to these defenders. */
  defenderPayouts?: Array<{ wallet: string; amount: number }>;
}

/**
 * Pluggable durable persistence for the escrow wager ledger / settlement
 * outbox. Without it escrow liability lives only in memory and a restart
 * mid-raid loses track of who is owed what while the treasury still holds
 * the tokens. Unlike the fire-and-forget caches, escrow writes are AWAITED
 * by the manager before a state transition is considered safe. Methods may
 * be sync or async.
 */
export interface EscrowStore {
  /** Insert or update a wager record (keyed by `wagerId`). */
  put(record: EscrowWagerRecord): Promise<void> | void;
  /** Remove a fully-settled record. */
  delete(wagerId: string): Promise<void> | void;
  /**
   * Every record that still needs action — `active` (awaiting resolution or
   * orphaned by a restart) and `settling` (mid-payout). Read once on boot to
   * reconcile. `settled` records are deleted; `failed` records are retained
   * for manual ops and also returned so the operator sees them.
   */
  getUnsettled(): Promise<EscrowWagerRecord[]> | EscrowWagerRecord[];
}

/**
 * Subset of the syndicate manager consumed by `SyndicateRaidsManager`.
 * Avoids a hard dependency on the concrete class so tests can supply a
 * minimal in-memory double.
 */
export interface SyndicateManagerLike {
  /** Look up which syndicate a wallet belongs to (undefined if none). */
  getMemberSyndicate(walletAddress: string): Syndicate | undefined;
  /** Look up a syndicate directly by id. */
  getSyndicate(syndicateId: string): Syndicate | undefined;
  /** Whether a wallet has officer/leader rights. */
  canManageMembers(walletAddress: string): boolean;
}

/**
 * Subset of the raid engine consumed by `SyndicateRaidsManager`. Lets
 * syndicate raids reuse the engine's defense-power calculation,
 * pending-yield read, and defender-spoils distribution without
 * depending on the concrete class.
 */
export interface RaidEngineLike {
  /** Whether the asteroid is currently raidable (no immunity, etc.). */
  canBeRaided(asteroidId: string): boolean;
  /** Total defense power summed across the asteroid's active defenders. */
  calculateAsteroidDefensePower(asteroidId: string): number;
  /** Pending yield (bankable but not-yet-distributed) on the asteroid. */
  getPendingYield(asteroidId: string): number;
  /** Distribute defender spoils after a failed attacker raid. */
  distributeDefenderSpoils(
    raidId: string,
    asteroidId: string,
    totalAttackerBets: number,
  ): DefenderSpoils;
}

/**
 * Optional logger. BG used `console.log` directly throughout the game
 * modules. astroid.club lets you inject any logger implementing this
 * narrow interface (defaults to `console`). Keeps logs available in dev
 * while letting tests run silent and production wire a structured logger.
 */
export interface GameLogger {
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

/**
 * @deprecated Renamed to `GameLogger`. Kept as a type alias for the brief
 * window where both `RaidEngine` and downstream callers might still
 * reference the old name. Will be removed in a follow-up slice.
 */
export type RaidLogger = GameLogger;
