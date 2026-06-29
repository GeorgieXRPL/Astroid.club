/**
 * Stake manager for astroid.club.
 *
 * Ported from `Black-Gold-main/server/game/stake-manager.ts` per
 * `docs/PORTING_NOTES.md`. All formulas (effective drill power, defense
 * power, stake-tier thresholds, the 20% bet cap, the 50% stake-weighted
 * yield share) are byte-identical to BG.
 *
 * Architectural changes:
 *
 * 1. **Dependency injection.** BG's manager called
 *    `getMineRegistry()`, `getBetEscrowManager()`, and
 *    `getRedisStore()` directly. astroid.club takes them through the
 *    constructor as narrow `*Like` interfaces. The bet-escrow and
 *    home-station-store dependencies default to no-op / in-memory
 *    stubs so the manager works standalone in tests and the bet-escrow
 *    slice can land later without churning consumers.
 *
 * 2. **No env reads.** BG decided "Quarry on-chain mode vs simulation
 *    mode" via `process.env.QUARRY_ADDRESS`. We accept an explicit
 *    `quarryEnabled` flag instead — runtime config lives in
 *    `server/config/runtime.ts` and is wired in by the boot layer, not
 *    here.
 *
 * 3. **No project-specific token strings.** Logged token symbol is
 *    configurable via `tokenSymbol` (defaults to `"$ASTROID"`).
 *
 * Implements `StakeManagerLike` so RaidEngine and ExpeditionTracker
 * consume only the narrow surface.
 */

import type { ResourceType } from '../../config/asteroids.js';

import type {
  AsteroidRegistryLike,
  BetEscrowLike,
  GameLogger,
  HomeStationStore,
  PendingYieldStore,
  StakeManagerLike,
  YieldLedger,
} from './interfaces.js';
import type { MinerGameState, StakeRecord, StakeTier } from './types.js';
import { calculateDefensePower, calculateEffectiveDrillPower, getStakeTier } from './types.js';

/** Result of `requestUnstake`. */
export interface UnstakeResult {
  success: boolean;
  /** Set when the request was rejected; explains why. */
  error?: string;
  /** Set on success when the wallet still has locked bets the player should know about. */
  warning?: string;
}

/** Configuration accepted by the stake manager. */
export interface StakeManagerConfig {
  /** Required: the asteroid registry (used for stake-total and definition lookups). */
  registry: AsteroidRegistryLike;
  /** Optional bet-escrow integration for unstake warnings. Defaults to a no-op. */
  betEscrow?: BetEscrowLike;
  /** Optional home-station persistence. Defaults to an in-memory store. */
  homeStationStore?: HomeStationStore;
  /**
   * Optional durable current-balance mirror for pending yield (a cache,
   * e.g. Redis). When set, `addPendingYield`/`claimPendingYield` write
   * through (fire-and-forget) and `restorePendingYield()` can reload on
   * boot. When unset, credits live only in memory and a restart wipes
   * them.
   */
  pendingYieldStore?: PendingYieldStore;
  /**
   * Optional append-only, auditable ledger for pending yield (the
   * production posture, e.g. Postgres/Supabase). When set, every credit
   * and claim is recorded as an immutable event and the boot-time
   * restore derives balances from the event log. Preferred over
   * `pendingYieldStore` for restore when both are present.
   */
  yieldLedger?: YieldLedger;
  /** Whether on-chain Quarry custody is wired up. Defaults to false. */
  quarryEnabled?: boolean;
  /**
   * Optional stake-derived bound on base drill power. Drill power has no
   * proof-of-work, so if it were taken from the client a wallet could report
   * the hard cap (10M) regardless of stake and dominate shared-asteroid yield
   * splits and raid attack power — and, worse, two similarly-staked players
   * could look 1000× apart purely based on who maxed the input box. When this
   * bound is set, the self-reported value is IGNORED and base drill is DERIVED
   * deterministically as `freeBase + stake × perStakeToken` (everyone gets a
   * free baseline; the rest scales with their staked position), then the tier
   * multiplier applies on top. This makes drill behave like defense — a pure
   * function of stake. Unset = no bound: the self-reported base is used as-is
   * (legacy behaviour; used by tests).
   */
  drillPowerBound?: { freeBase: number; perStakeToken: number };
  /** Token symbol used in user-facing log strings. Defaults to "$ASTROID". */
  tokenSymbol?: string;
  logger?: GameLogger;
}

/** 20% bet-cap as a fraction of stake — preserved verbatim from BG. */
const BET_CAP_FRACTION = 0.2;

/**
 * Stake-weighted share of yield that goes to stakers (the other half is
 * distributed by drill-power contribution). Preserved verbatim from BG.
 */
const STAKER_YIELD_SHARE = 0.5;

/**
 * Tracks per-wallet stake records, miner game state, pending yield, and
 * raid bookkeeping. Token custody itself happens elsewhere (Quarry
 * on-chain or a future astroid.club staking module); this class is the
 * in-memory game-side mirror.
 */
export class StakeManager implements StakeManagerLike {
  private readonly registry: AsteroidRegistryLike;
  private readonly betEscrow: BetEscrowLike;
  private readonly homeStationStore: HomeStationStore;
  private readonly pendingYieldStore: PendingYieldStore | undefined;
  private readonly yieldLedger: YieldLedger | undefined;
  private readonly tokenSymbol: string;
  private readonly quarryEnabled: boolean;
  private readonly drillPowerBound: { freeBase: number; perStakeToken: number } | undefined;
  private readonly log: GameLogger;

  /** Stakes by wallet address. */
  private readonly stakes: Map<string, StakeRecord[]> = new Map();
  /** Miner game state by wallet. */
  private readonly minerStates: Map<string, MinerGameState> = new Map();
  /** Pending yield from defender spoils and other sources (wallet -> amount). */
  private readonly pendingYield: Map<string, number> = new Map();
  /** Active raids by wallet (for tracking only; doesn't block actions). */
  private readonly activeRaidsByWallet: Map<string, Set<string>> = new Map();
  /** Asteroid -> count of currently-incoming attacks (for tracking). */
  private readonly asteroidsUnderAttack: Map<string, number> = new Map();
  /**
   * On-chain Quarry stake per wallet (a single global $ASTROID amount).
   * Only used when `quarryEnabled`: it is the source of truth for the
   * stake-tier multipliers, reconciled from chain reads by the boot/gateway
   * layer (`setOnChainStake`). The legacy per-asteroid `stakes` map is empty
   * in this mode because the in-game `stake` message is rejected.
   */
  private readonly onChainStake: Map<string, number> = new Map();

  /**
   * Lifetime mining rewards a wallet has ever been credited (gross, never
   * decremented). Drives the player "rewards accumulator" so a claim/redeem
   * doesn't erase the record of what was earned. Seeded from the ledger on
   * restore and incremented by `addPendingYield`.
   */
  private readonly lifetimeEarned: Map<string, number> = new Map();
  /**
   * Lifetime rewards a wallet has moved on-chain (bridged/redeemed). Together
   * with `lifetimeEarned` and the current pending balance this answers
   * "what's claimable vs. what's already been claimed". Seeded from the
   * ledger on restore and incremented by `redeemPendingYield`.
   */
  private readonly lifetimeRedeemed: Map<string, number> = new Map();

  constructor(config: StakeManagerConfig) {
    this.registry = config.registry;
    this.betEscrow = config.betEscrow ?? noopBetEscrow();
    this.homeStationStore = config.homeStationStore ?? new InMemoryHomeStationStore();
    this.pendingYieldStore = config.pendingYieldStore;
    this.yieldLedger = config.yieldLedger;
    this.tokenSymbol = config.tokenSymbol ?? '$ASTROID';
    this.quarryEnabled = config.quarryEnabled ?? false;
    this.drillPowerBound = config.drillPowerBound;
    this.log = config.logger ?? defaultLogger();

    this.log.info(
      this.quarryEnabled
        ? '[StakeManager] Quarry integration enabled'
        : '[StakeManager] Running in simulation mode (no Quarry)',
    );
  }

  // --------- Miner state ---------

  /** Get or create the miner's game state. */
  getMinerState(walletAddress: string): MinerGameState {
    let state = this.minerStates.get(walletAddress);
    if (!state) {
      state = {
        walletAddress,
        homeStationAsteroidId: null,
        activeAsteroidId: null,
        currentExpeditionId: null,
        totalStake: 0,
        cooldowns: [],
        loyaltyDays: 0,
        homeStationJoinedAt: null,
      };
      this.minerStates.set(walletAddress, state);
    }
    return state;
  }

  /** All miner states (used for daily loyalty refresh, debugging, snapshots). */
  getAllMinerStates(): MinerGameState[] {
    return Array.from(this.minerStates.values());
  }

  // --------- Home station ---------

  /**
   * Set a wallet's home-station asteroid. Returns false if the asteroid
   * is unknown. Persists to the configured home-station store with
   * fire-and-forget semantics (matches BG: errors are logged, not
   * surfaced to the caller).
   */
  setHomeStation(walletAddress: string, asteroidId: string): boolean {
    const asteroid = this.registry.getAsteroid(asteroidId);
    if (!asteroid) {
      this.log.info(`[StakeManager] Asteroid ${asteroidId} not found`);
      return false;
    }

    const state = this.getMinerState(walletAddress);
    state.homeStationAsteroidId = asteroidId;
    // Setting a home station does NOT start mining. activeAsteroidId is set
    // only by joinAsteroid (which also registers the miner in the registry and
    // distribution). Setting it here would make the snapshot claim the player
    // is mining at home while the registry has no record of them — the UI shows
    // "Leave"/active, the player earns nothing, and report_drill_power fails
    // with "must join an asteroid first".
    state.homeStationJoinedAt = new Date();
    state.loyaltyDays = 0;

    Promise.resolve(this.homeStationStore.set(walletAddress, asteroidId)).catch((err) => {
      this.log.error('[StakeManager] Failed to persist home station:', err);
    });

    this.log.info(
      `[StakeManager] ${walletAddress} set home station to ${asteroid.definition.name}`,
    );
    return true;
  }

  /**
   * Restore a previously-persisted home station. Resolves to the
   * asteroid id if a value was found and applied, otherwise null.
   */
  async restoreHomeStation(walletAddress: string): Promise<string | null> {
    try {
      const homeId = await Promise.resolve(this.homeStationStore.get(walletAddress));
      if (!homeId) return null;
      const state = this.getMinerState(walletAddress);
      state.homeStationAsteroidId = homeId;
      // Do NOT set activeAsteroidId here. Restoring the home station only
      // re-establishes the player's base — it does not register them as an
      // active miner in the registry/distribution. Pretending they're mining
      // (activeAsteroidId = home) makes the reconnect snapshot claim "mining
      // at home"; the client then skips the join and every report_drill_power
      // fails with "must join an asteroid first". activeAsteroidId is set only
      // by an explicit joinAsteroid, which also registers the miner.
      this.log.info(
        `[StakeManager] Restored home station for ${walletAddress.slice(0, 8)}...: ${homeId}`,
      );
      return homeId;
    } catch (error) {
      this.log.error('[StakeManager] Failed to restore home station:', error);
      return null;
    }
  }

  // --------- Stake / unstake ---------

  /** Stake `amount` at an asteroid. Returns false on validation failure. */
  stake(walletAddress: string, asteroidId: string, amount: number): boolean {
    if (amount <= 0) {
      this.log.info(`[StakeManager] Invalid stake amount: ${amount}`);
      return false;
    }
    const asteroid = this.registry.getAsteroid(asteroidId);
    if (!asteroid) {
      this.log.info(`[StakeManager] Asteroid ${asteroidId} not found`);
      return false;
    }

    const state = this.getMinerState(walletAddress);
    if (!state.homeStationAsteroidId) {
      this.setHomeStation(walletAddress, asteroidId);
    }

    let walletStakes = this.stakes.get(walletAddress);
    if (!walletStakes) {
      walletStakes = [];
      this.stakes.set(walletAddress, walletStakes);
    }

    const existingIndex = walletStakes.findIndex((s) => s.asteroidId === asteroidId);
    if (existingIndex >= 0) {
      walletStakes[existingIndex]!.amount += amount;
    } else {
      const record: StakeRecord = {
        walletAddress,
        asteroidId,
        amount,
        stakedAt: new Date(),
        isHomeStation: asteroidId === state.homeStationAsteroidId,
        loyaltyDays: 0,
      };
      walletStakes.push(record);
    }

    state.totalStake += amount;
    this.registry.updateAsteroidStake(asteroidId, amount);

    const tier = getStakeTier(this.getStakeAtAsteroid(walletAddress, asteroidId));
    this.log.info(
      `[StakeManager] ${walletAddress} staked ${amount} at ${asteroid.definition.name} ` +
        `(Tier: ${tier.name}, Total: ${this.getStakeAtAsteroid(walletAddress, asteroidId)})`,
    );
    return true;
  }

  /**
   * User-facing unstake. Always succeeds when the stake exists (BG
   * model: token custody is on-chain, the game is just the mirror).
   * Surfaces a warning when the wallet still has locked bets via the
   * configured `BetEscrowLike`.
   */
  requestUnstake(walletAddress: string, asteroidId: string, amount: number): UnstakeResult {
    const walletStakes = this.stakes.get(walletAddress);
    if (!walletStakes) return { success: false, error: 'No stakes found' };

    const stakeIndex = walletStakes.findIndex((s) => s.asteroidId === asteroidId);
    if (stakeIndex < 0) return { success: false, error: 'No stake at this asteroid' };

    const stake = walletStakes[stakeIndex]!;
    let effective = amount;
    if (effective > stake.amount) effective = stake.amount;

    const hasActiveBets = this.betEscrow.hasLockedBets(walletAddress);
    const lockedBetAmount = this.betEscrow.getLockedBetAmount(walletAddress);

    const ok = this.processUnstake(walletAddress, asteroidId, effective);
    if (ok && hasActiveBets) {
      return {
        success: true,
        warning:
          `You have ${lockedBetAmount} ${this.tokenSymbol} locked in active raid bets. ` +
          `Unstaking reduces your defense power but bets remain locked.`,
      };
    }
    return { success: ok };
  }

  /**
   * Direct unstake (no bet warning). Used by internal flows: bet
   * burns, rally-defense costs, raid resolution. Implements
   * `StakeManagerLike.unstake`.
   */
  unstake(walletAddress: string, asteroidId: string, amount: number): boolean {
    return this.processUnstake(walletAddress, asteroidId, amount);
  }

  /** Internal unstake worker. Always succeeds when the row exists. */
  private processUnstake(walletAddress: string, asteroidId: string, amount: number): boolean {
    const walletStakes = this.stakes.get(walletAddress);
    if (!walletStakes) return false;

    const stakeIndex = walletStakes.findIndex((s) => s.asteroidId === asteroidId);
    if (stakeIndex < 0) return false;

    const stake = walletStakes[stakeIndex]!;
    let effective = amount;
    if (effective > stake.amount) effective = stake.amount;

    stake.amount -= effective;
    if (stake.amount <= 0) {
      walletStakes.splice(stakeIndex, 1);
    }

    const state = this.getMinerState(walletAddress);
    state.totalStake -= effective;

    this.registry.updateAsteroidStake(asteroidId, -effective);

    this.log.info(`[StakeManager] ${walletAddress} unstaked ${effective} from ${asteroidId}`);
    return true;
  }

  // --------- Raid bookkeeping ---------

  registerActiveRaid(walletAddress: string, raidId: string): void {
    let raids = this.activeRaidsByWallet.get(walletAddress);
    if (!raids) {
      raids = new Set();
      this.activeRaidsByWallet.set(walletAddress, raids);
    }
    raids.add(raidId);
    this.log.info(`[StakeManager] Registered active raid ${raidId} for ${walletAddress}`);
  }

  unregisterActiveRaid(walletAddress: string, raidId: string): void {
    const raids = this.activeRaidsByWallet.get(walletAddress);
    if (!raids) return;
    raids.delete(raidId);
    if (raids.size === 0) this.activeRaidsByWallet.delete(walletAddress);
    this.log.info(`[StakeManager] Unregistered active raid ${raidId} for ${walletAddress}`);
  }

  registerAsteroidUnderAttack(asteroidId: string): void {
    const current = this.asteroidsUnderAttack.get(asteroidId) ?? 0;
    this.asteroidsUnderAttack.set(asteroidId, current + 1);
    this.log.info(`[StakeManager] Asteroid ${asteroidId} under attack (count: ${current + 1})`);
  }

  unregisterAsteroidAttack(asteroidId: string): void {
    const current = this.asteroidsUnderAttack.get(asteroidId) ?? 0;
    if (current <= 1) {
      this.asteroidsUnderAttack.delete(asteroidId);
    } else {
      this.asteroidsUnderAttack.set(asteroidId, current - 1);
    }
    this.log.info(
      `[StakeManager] Asteroid ${asteroidId} attack ended (remaining: ${Math.max(0, current - 1)})`,
    );
  }

  isAsteroidUnderAttack(asteroidId: string): boolean {
    return (this.asteroidsUnderAttack.get(asteroidId) ?? 0) > 0;
  }

  getActiveRaidCount(walletAddress: string): number {
    return this.activeRaidsByWallet.get(walletAddress)?.size ?? 0;
  }

  hasActiveRaids(walletAddress: string): boolean {
    return this.getActiveRaidCount(walletAddress) > 0;
  }

  /** Pass-through to the configured bet-escrow implementation. */
  getLockedBetAmount(walletAddress: string): number {
    return this.betEscrow.getLockedBetAmount(walletAddress);
  }

  isQuarryEnabled(): boolean {
    return this.quarryEnabled;
  }

  // --------- On-chain stake reconciliation (Quarry) ---------

  /**
   * Set a wallet's reconciled on-chain Quarry stake (whole $ASTROID). This
   * is the source of truth for the stake-tier multipliers when
   * `quarryEnabled`; the gateway calls it after a verified stake/unstake and
   * on connect. A non-positive amount clears the entry (fully unstaked).
   * No-op (logged) when Quarry is not enabled, so it can't corrupt the
   * legacy in-game stake mirror.
   */
  setOnChainStake(walletAddress: string, amount: number): void {
    if (!this.quarryEnabled) return;
    const normalized = Number.isFinite(amount) && amount > 0 ? amount : 0;
    const previous = this.onChainStake.get(walletAddress) ?? 0;
    if (normalized <= 0) {
      this.onChainStake.delete(walletAddress);
    } else {
      this.onChainStake.set(walletAddress, normalized);
    }
    if (normalized !== previous) {
      const tier = getStakeTier(normalized);
      this.log.info(
        `[StakeManager] Reconciled on-chain stake for ${walletAddress.slice(0, 8)}…: ` +
          `${normalized} ${this.tokenSymbol} (Tier: ${tier.name}, drill ×${tier.drillPowerMultiplier})`,
      );
    }
  }

  /** A wallet's reconciled on-chain stake (0 when none / Quarry disabled). */
  getOnChainStake(walletAddress: string): number {
    return this.onChainStake.get(walletAddress) ?? 0;
  }

  /**
   * The stake amount to *display* for a wallet. Under Quarry this is the
   * reconciled on-chain stake (the legacy per-asteroid sim stake is always 0
   * in that mode); otherwise the in-game total. Used by snapshots so the UI
   * reflects the real staked position across reconnects.
   */
  getDisplayStake(walletAddress: string): number {
    if (this.quarryEnabled) return this.getOnChainStake(walletAddress);
    return this.getMinerState(walletAddress).totalStake;
  }

  /** Lifetime mining rewards ever credited to a wallet (gross). */
  getLifetimeEarned(walletAddress: string): number {
    return this.lifetimeEarned.get(walletAddress) ?? 0;
  }

  /** Lifetime rewards a wallet has moved on-chain (bridged/redeemed). */
  getLifetimeRedeemed(walletAddress: string): number {
    return this.lifetimeRedeemed.get(walletAddress) ?? 0;
  }

  /** Total lifetime rewards ever credited across all wallets (gross). */
  getTotalLifetimeEarned(): number {
    let total = 0;
    for (const v of this.lifetimeEarned.values()) total += v;
    return total;
  }

  /** Total lifetime rewards moved on-chain across all wallets. */
  getTotalLifetimeRedeemed(): number {
    let total = 0;
    for (const v of this.lifetimeRedeemed.values()) total += v;
    return total;
  }

  /**
   * Outstanding (unredeemed) credit liability across all wallets — the
   * redeemable claim against the treasury backing. The emission governor
   * tapers new issuance as this approaches the configured budget; redeeming
   * frees headroom back up (recirculation-aware).
   *
   * This is the *current* sum of pending balances, not a cumulative
   * (lifetimeEarned − lifetimeRedeemed) figure: credits that are claimed
   * or spent in-game (e.g. meteor deflection) leave the pending pool and
   * must stop counting as outstanding liability, otherwise the governor
   * would tighten forever and could eventually throttle yield to zero even
   * though little is actually redeemable.
   */
  getOutstandingCredits(): number {
    return this.getTotalPendingYield();
  }

  /**
   * The stake amount that applies to a wallet at a given asteroid for tier,
   * drill-power, defense, and yield-share purposes.
   *
   * - Legacy (simulation) mode: the per-asteroid amount from the in-game
   *   `stakes` mirror.
   * - Quarry mode: the wallet's single global on-chain stake, applied
   *   wherever the wallet is currently *present* — actively mining there or
   *   defending it as their home station. Elsewhere it is 0.
   */
  private effectiveStakeAt(walletAddress: string, asteroidId: string): number {
    if (!this.quarryEnabled) {
      const walletStakes = this.stakes.get(walletAddress);
      const stake = walletStakes?.find((s) => s.asteroidId === asteroidId);
      return stake?.amount ?? 0;
    }
    const global = this.onChainStake.get(walletAddress) ?? 0;
    if (global <= 0) return 0;
    const state = this.minerStates.get(walletAddress);
    if (!state) return 0;
    const present =
      asteroidId === state.activeAsteroidId || asteroidId === state.homeStationAsteroidId;
    return present ? global : 0;
  }

  /** Sum of effective stake across every miner present at an asteroid. */
  private getAsteroidEffectiveStakeTotal(asteroidId: string): number {
    let total = 0;
    for (const walletAddress of this.minerStates.keys()) {
      total += this.effectiveStakeAt(walletAddress, asteroidId);
    }
    return total;
  }

  // --------- Stake queries ---------

  getStakeAtAsteroid(walletAddress: string, asteroidId: string): number {
    return this.effectiveStakeAt(walletAddress, asteroidId);
  }

  getTotalStake(walletAddress: string): number {
    return this.getMinerState(walletAddress).totalStake;
  }

  getWalletStakes(walletAddress: string): StakeRecord[] {
    return this.stakes.get(walletAddress) ?? [];
  }

  getStakeTierAtAsteroid(walletAddress: string, asteroidId: string): StakeTier {
    return getStakeTier(this.getStakeAtAsteroid(walletAddress, asteroidId));
  }

  /**
   * Effective drill power for a miner at a given asteroid.
   *
   * When a {@link drillPowerBound} is configured (the production default) the
   * `baseDrillPower` argument is IGNORED and base drill is derived purely from
   * stake — `freeBase + stake × perStakeToken` — so drill is a deterministic
   * function of stake (like defense) and can't be inflated by self-reporting.
   * Without a bound the self-reported base is used as-is (legacy/tests).
   */
  getEffectiveDrillPower(
    walletAddress: string,
    baseDrillPower: number,
    asteroidId: string,
  ): number {
    const asteroid = this.registry.getAsteroid(asteroidId);
    if (!asteroid) return baseDrillPower;
    const stakeAmount = this.getStakeAtAsteroid(walletAddress, asteroidId);
    const state = this.getMinerState(walletAddress);
    const base = this.drillPowerBound
      ? this.deriveBaseDrillPower(stakeAmount)
      : baseDrillPower;
    return calculateEffectiveDrillPower(
      base,
      stakeAmount,
      state.loyaltyDays,
      asteroid.definition.resource,
    );
  }

  /**
   * Stake-derived base drill power: `freeBase + stake × perStakeToken`. Only
   * meaningful when a {@link drillPowerBound} is configured; returns 0
   * otherwise (the unbounded path never calls this).
   */
  private deriveBaseDrillPower(stakeAmount: number): number {
    if (!this.drillPowerBound) return 0;
    return (
      this.drillPowerBound.freeBase + Math.max(0, stakeAmount) * this.drillPowerBound.perStakeToken
    );
  }

  /** Defense power for a wallet at a given asteroid. Implements `StakeManagerLike.getDefensePower`. */
  getDefensePower(walletAddress: string, asteroidId: string): number {
    const stakeAmount = this.getStakeAtAsteroid(walletAddress, asteroidId);
    const state = this.getMinerState(walletAddress);
    const isHomeStation = state.homeStationAsteroidId === asteroidId;
    return calculateDefensePower(stakeAmount, isHomeStation);
  }

  /** Total defense power for an asteroid (sum across all stakers there). */
  getTotalDefensePower(asteroidId: string): number {
    let total = 0;
    // In Quarry mode the per-asteroid `stakes` map is empty, so iterate the
    // miner states (defense flows from the global on-chain stake of whoever
    // is present at the asteroid). Non-present wallets contribute 0.
    const wallets = this.quarryEnabled ? this.minerStates.keys() : this.stakes.keys();
    for (const walletAddress of wallets) {
      total += this.getDefensePower(walletAddress, asteroidId);
    }
    return total;
  }

  /** Increment loyalty days for every miner with a home station. Call once per day. */
  updateLoyaltyDays(): void {
    const now = new Date();
    for (const [walletAddress, state] of this.minerStates) {
      if (!state.homeStationJoinedAt || !state.homeStationAsteroidId) continue;
      const daysSinceJoin = Math.floor(
        (now.getTime() - state.homeStationJoinedAt.getTime()) / (24 * 60 * 60 * 1000),
      );
      state.loyaltyDays = daysSinceJoin;

      const stakes = this.stakes.get(walletAddress);
      if (!stakes) continue;
      for (const stake of stakes) {
        if (stake.asteroidId === state.homeStationAsteroidId) {
          stake.loyaltyDays = daysSinceJoin;
        }
      }
    }
  }

  /** All non-zero stake records at a given asteroid. */
  getAsteroidStakers(asteroidId: string): StakeRecord[] {
    if (this.quarryEnabled) {
      // Synthesize records from the global on-chain stake of present miners.
      const stakers: StakeRecord[] = [];
      for (const [walletAddress, state] of this.minerStates) {
        const amount = this.effectiveStakeAt(walletAddress, asteroidId);
        if (amount > 0) {
          stakers.push({
            walletAddress,
            asteroidId,
            amount,
            stakedAt: state.homeStationJoinedAt ?? new Date(0),
            isHomeStation: state.homeStationAsteroidId === asteroidId,
            loyaltyDays: state.loyaltyDays,
          });
        }
      }
      return stakers;
    }
    const stakers: StakeRecord[] = [];
    for (const [, stakes] of this.stakes) {
      const stake = stakes.find((s) => s.asteroidId === asteroidId);
      if (stake && stake.amount > 0) stakers.push(stake);
    }
    return stakers;
  }

  /**
   * Stake-weighted share of `totalYield` for a wallet at an asteroid.
   * Returns 0 when the asteroid has no stake at all (drill-power-only
   * distribution handled elsewhere). 50% of yield is stake-weighted —
   * preserved verbatim from BG.
   */
  calculateYieldShare(walletAddress: string, asteroidId: string, totalYield: number): number {
    const stakeAmount = this.getStakeAtAsteroid(walletAddress, asteroidId);
    // In Quarry mode the registry's `totalStake` is never updated (in-game
    // staking is disabled), so derive the denominator from the present
    // miners' effective on-chain stake instead.
    const totalStake = this.quarryEnabled
      ? this.getAsteroidEffectiveStakeTotal(asteroidId)
      : (this.registry.getAsteroid(asteroidId)?.totalStake ?? 0);
    if (totalStake <= 0) return 0;
    const stakeWeight = stakeAmount / totalStake;
    return totalYield * STAKER_YIELD_SHARE * stakeWeight;
  }

  // --------- Bets ---------

  /**
   * Validate a bet for a raid. Caps the bet at 20% of the wallet's
   * stake at the source asteroid. Returns false when the cap is
   * exceeded. Does NOT actually move tokens — that happens via the
   * bet-escrow module (or a no-op when `CHAIN_ENABLED=false`).
   */
  processBet(walletAddress: string, asteroidId: string, betAmount: number): boolean {
    const currentStake = this.getStakeAtAsteroid(walletAddress, asteroidId);
    const maxBet = currentStake * BET_CAP_FRACTION;
    if (betAmount > maxBet) {
      this.log.info(`[StakeManager] Bet ${betAmount} exceeds max ${maxBet} for ${walletAddress}`);
      return false;
    }
    return true;
  }

  /** Burn a bet (post-failed-raid). Removes the bet from the wallet's stake. */
  burnBet(walletAddress: string, asteroidId: string, betAmount: number): void {
    this.unstake(walletAddress, asteroidId, betAmount);
    this.log.info(`[StakeManager] Burned ${betAmount} from ${walletAddress} at ${asteroidId}`);
  }

  /**
   * Return a bet plus winnings to a wallet (post-successful-raid). On
   * a real chain this would mint/transfer from the raid pool; with
   * `CHAIN_ENABLED=false` this is just a log line + game-state effect
   * (winnings will land in pendingYield via raid-engine).
   */
  returnBetWithWinnings(
    walletAddress: string,
    _asteroidId: string,
    betAmount: number,
    winnings: number,
  ): void {
    this.log.info(
      `[StakeManager] Returned ${betAmount} + ${winnings} winnings to ${walletAddress}`,
    );
  }

  // --------- Pending yield ---------

  /** Add pending yield for a wallet (defender spoils, raid winnings, etc.). */
  addPendingYield(walletAddress: string, asteroidId: string, amount: number): void {
    const current = this.pendingYield.get(walletAddress) ?? 0;
    const total = current + amount;
    this.pendingYield.set(walletAddress, total);
    this.persistPendingYield(walletAddress, total);
    if (amount > 0) {
      this.lifetimeEarned.set(walletAddress, (this.lifetimeEarned.get(walletAddress) ?? 0) + amount);
    }
    if (this.yieldLedger && amount !== 0) {
      Promise.resolve(this.yieldLedger.recordCredit(walletAddress, asteroidId, amount)).catch(
        (err) => this.log.error('[StakeManager] Failed to record credit event:', err),
      );
    }
    this.log.info(
      `[StakeManager] Added ${amount} pending yield for ${walletAddress} ` +
        `(total pending: ${total})`,
    );
  }

  getPendingYield(walletAddress: string): number {
    return this.pendingYield.get(walletAddress) ?? 0;
  }

  /** Read and clear pending yield. Returns the amount that was queued. */
  claimPendingYield(walletAddress: string): number {
    const amount = this.pendingYield.get(walletAddress) ?? 0;
    this.pendingYield.delete(walletAddress);
    if (this.pendingYieldStore) {
      Promise.resolve(this.pendingYieldStore.delete(walletAddress)).catch((err) => {
        this.log.error('[StakeManager] Failed to clear persisted pending yield:', err);
      });
    }
    if (this.yieldLedger && amount > 0) {
      Promise.resolve(this.yieldLedger.recordClaim(walletAddress, amount)).catch((err) => {
        this.log.error('[StakeManager] Failed to record claim event:', err);
      });
    }
    if (amount > 0) {
      this.log.info(`[StakeManager] Claimed ${amount} pending yield for ${walletAddress}`);
    }
    return amount;
  }

  /**
   * Debit `amount` of pending yield when it is being moved on-chain
   * (bridged to IOU-ASTROID). Synchronous + balance-checked so two
   * concurrent bridge requests can't double-spend the same credits: the
   * in-memory balance drops before any async chain transfer is attempted.
   * Records a `redeem` ledger event (distinct from an in-game `claim`).
   * Returns false (no state change) when the wallet lacks `amount`.
   *
   * On a subsequent chain-transfer failure, the caller should refund via
   * `addPendingYield(wallet, 'bridge_refund', amount)`.
   */
  redeemPendingYield(walletAddress: string, amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const current = this.pendingYield.get(walletAddress) ?? 0;
    if (current < amount) return false;
    const remaining = current - amount;
    if (remaining > 0) {
      this.pendingYield.set(walletAddress, remaining);
      this.persistPendingYield(walletAddress, remaining);
    } else {
      this.pendingYield.delete(walletAddress);
      if (this.pendingYieldStore) {
        Promise.resolve(this.pendingYieldStore.delete(walletAddress)).catch((err) => {
          this.log.error('[StakeManager] Failed to clear persisted pending yield:', err);
        });
      }
    }
    this.lifetimeRedeemed.set(walletAddress, (this.lifetimeRedeemed.get(walletAddress) ?? 0) + amount);
    if (this.yieldLedger) {
      Promise.resolve(this.yieldLedger.recordRedeem(walletAddress, amount)).catch((err) => {
        this.log.error('[StakeManager] Failed to record redeem event:', err);
      });
    }
    this.log.info(
      `[StakeManager] Redeemed ${amount} pending yield to chain for ${walletAddress} ` +
        `(remaining: ${remaining})`,
    );
    return true;
  }

  /**
   * Spend in-game pending-yield credits as a gameplay cost (e.g. paying to
   * deflect a meteor). Unlike `redeemPendingYield`, this is NOT a claim: it does
   * not touch `lifetimeRedeemed` or the audit ledger — the credits are consumed
   * in-game and (by the caller) routed elsewhere (e.g. into the raid vault).
   * Returns false (no-op) when the balance is insufficient.
   */
  spendPendingYield(walletAddress: string, amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const current = this.pendingYield.get(walletAddress) ?? 0;
    if (current < amount) return false;
    const remaining = current - amount;
    if (remaining > 0) {
      this.pendingYield.set(walletAddress, remaining);
      this.persistPendingYield(walletAddress, remaining);
    } else {
      this.pendingYield.delete(walletAddress);
      if (this.pendingYieldStore) {
        Promise.resolve(this.pendingYieldStore.delete(walletAddress)).catch((err) => {
          this.log.error('[StakeManager] Failed to clear persisted pending yield:', err);
        });
      }
    }
    this.log.info(
      `[StakeManager] Spent ${amount} pending yield (gameplay cost) for ${walletAddress} ` +
        `(remaining: ${remaining})`,
    );
    return true;
  }

  /** Snapshot of every wallet's pending yield. */
  getAllPendingYield(): Map<string, number> {
    return new Map(this.pendingYield);
  }

  /** Total pending yield across the system. */
  getTotalPendingYield(): number {
    let total = 0;
    for (const amount of this.pendingYield.values()) total += amount;
    return total;
  }

  /**
   * Reload persisted pending yield into memory. Call once on boot (after
   * construction, before serving traffic) so redeemable IOU credits
   * survive a restart/redeploy. Prefers the auditable `yieldLedger`
   * (balances derived from the event log) and falls back to the
   * current-balance `pendingYieldStore` mirror. No-op when neither is
   * wired. Returns the number of wallets restored.
   */
  async restorePendingYield(): Promise<number> {
    const source = this.yieldLedger
      ? () => this.yieldLedger!.getAllBalances()
      : this.pendingYieldStore
        ? () => this.pendingYieldStore!.getAll()
        : null;
    if (!source) return 0;
    try {
      const all = await Promise.resolve(source());
      let restored = 0;
      for (const [wallet, amount] of all) {
        if (amount > 0) {
          this.pendingYield.set(wallet, amount);
          restored += 1;
        }
      }
      // Seed the lifetime accumulator from the auditable ledger so the
      // player "earned / redeemed" totals survive a restart, not just the
      // current claimable balance.
      if (this.yieldLedger?.getLifetimeTotals) {
        try {
          const totals = await Promise.resolve(this.yieldLedger.getLifetimeTotals());
          for (const [wallet, { earned, redeemed }] of totals) {
            if (earned > 0) this.lifetimeEarned.set(wallet, earned);
            if (redeemed > 0) this.lifetimeRedeemed.set(wallet, redeemed);
          }
        } catch (err) {
          this.log.error('[StakeManager] Failed to restore lifetime totals:', err);
        }
      }
      if (restored > 0) {
        this.log.info(`[StakeManager] Restored pending yield for ${restored} wallet(s)`);
      }
      return restored;
    } catch (error) {
      this.log.error('[StakeManager] Failed to restore pending yield:', error);
      return 0;
    }
  }

  /** Fire-and-forget write-through of a wallet's pending-yield total. */
  private persistPendingYield(walletAddress: string, total: number): void {
    if (!this.pendingYieldStore) return;
    Promise.resolve(this.pendingYieldStore.set(walletAddress, total)).catch((err) => {
      this.log.error('[StakeManager] Failed to persist pending yield:', err);
    });
  }

  // --------- Misc ---------

  /** Drop expired cooldowns from every miner state. */
  clearExpiredCooldowns(): void {
    const now = new Date();
    for (const [, state] of this.minerStates) {
      state.cooldowns = state.cooldowns.filter((cd) => cd.expiresAt > now);
    }
  }

  /** All known resource types referenced by current stakers (debugging). */
  getStakedResourceTypes(): ResourceType[] {
    const seen = new Set<ResourceType>();
    for (const stakes of this.stakes.values()) {
      for (const s of stakes) {
        const a = this.registry.getAsteroid(s.asteroidId);
        if (a) seen.add(a.definition.resource);
      }
    }
    return Array.from(seen);
  }
}

// --------- Default dependency stubs ---------

/** Bet-escrow stub used when no real implementation is wired up. */
function noopBetEscrow(): BetEscrowLike {
  return {
    hasLockedBets: () => false,
    getLockedBetAmount: () => 0,
  };
}

/** In-memory `HomeStationStore`. Default when nothing else is wired. */
class InMemoryHomeStationStore implements HomeStationStore {
  private readonly map: Map<string, string> = new Map();
  set(walletAddress: string, asteroidId: string): void {
    this.map.set(walletAddress, asteroidId);
  }
  get(walletAddress: string): string | null {
    return this.map.get(walletAddress) ?? null;
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
