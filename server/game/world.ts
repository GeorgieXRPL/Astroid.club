/**
 * `GameWorld` — composition root for astroid.club's server-side game.
 *
 * Owns one instance of every ported game module and exposes a small,
 * transport-agnostic API that a WebSocket gateway, REST handler, or
 * test harness can drive directly. Replaces Black-Gold's bespoke WS
 * server (`Black-Gold-main/server/index.ts` ~2,300 lines) with a
 * cleanly-typed core that the engine's `WSGateway` will call into in
 * the next slice.
 *
 * Design principles:
 *
 * 1. **Single ownership tree.** The world constructs (and is the only
 *    code that constructs) its modules. Every `*Like` interface is
 *    satisfied via DI here, so there is no module-level singleton or
 *    `getXManager()` chain — matches the rest of the port.
 *
 * 2. **Transport-agnostic.** Every player action returns a discriminated
 *    union `WorldResult<T>`. The gateway translates that into wire
 *    envelopes (`result` / `error`); tests assert on the result
 *    directly. No `WebSocket`, `IncomingMessage`, or zod imports.
 *
 * 3. **CHAIN_ENABLED is a flag, not a code path.** The world wires
 *    every on-chain side effect through `chainEnabled` so the same
 *    code runs locally and on mainnet. Defaults to `false`.
 *
 * 4. **Timer-free by default.** Periodic services (DistributionService,
 *    cleanup loops, anti-cheat cleanup) only start when `start()` is
 *    explicitly called. Tests pass a fresh world, drive it
 *    deterministically, and never touch real timers.
 *
 * Player-facing actions covered (BG message → world method):
 *
 * | Black-Gold message | World method                  |
 * | ------------------ | ----------------------------- |
 * | `connect`          | `connectPlayer`               |
 * | `join_mine`        | `joinAsteroid`                |
 * | `leave_mine`       | `leaveAsteroid`               |
 * | `set_home`         | `setHomeStation`              |
 * | `hashrate`         | `reportDrillPower`            |
 * | `stake`            | `stake`                       |
 * | `unstake`          | `unstake`                     |
 * | `start_expedition` | `startExpedition`             |
 * | `leave_expedition` | `leaveExpedition`             |
 * | `rally_defense`    | `rallyDefense`                |
 * | `stats`            | `getNetworkStats`             |
 * | (new)              | `claimPendingYield`           |
 * | (new)              | `getMinerSnapshot`            |
 *
 * Out of scope for this slice (next sub-slice or later):
 * - WebSocket transport, signed-action verification, rate-limit
 *   enforcement (the gateway owns those; the world exposes hooks).
 * - Bet placement and resolution (chain-gated; lands with the
 *   `bet-escrow-chain.ts` slice).
 * - Pool mining (`hashrate` / `submit` PoW shares — astroid.club is
 *   time-based, not PoW; permanently out).
 * - Admin console (separate slice, gated by `runtime.adminSecret`).
 */

import type { AsteroidDefinition } from '../../config/asteroids.js';
import { AntiCheatService } from '../verification/anti-cheat.js';

import { AsteroidRegistry } from './asteroid-registry.js';
import { BetEscrow } from './bet-escrow.js';
import { CooldownManager } from './cooldowns.js';
import { DiscoveryEngine, type AsteroidMiningState } from './discovery-engine.js';
import { DistributionService, type YieldPayoutListener } from './distribution-service.js';
import { EmissionGovernor, type EmissionGovernorConfig } from './emission-governor.js';
import { ExpeditionTracker } from './expedition-tracker.js';
import type {
  GameLogger,
  HomeStationStore,
  PendingYieldStore,
  RaidVaultStore,
  WagerSettlement,
  YieldLedger,
} from './interfaces.js';
import { MeteorEngine, type MeteorEngineConfig, type MeteorThreat } from './meteor-engine.js';
import { DEFENSE_ADVANTAGE, RAID_MAX_STEAL_FRACTION, RaidEngine } from './raid-engine.js';
import { RaidVaultManager } from './raid-vault.js';
import { RefineryManager } from './refinery-manager.js';
import { StakeManager } from './stake-manager.js';
import { SyndicateManager } from './syndicate-manager.js';
import { SyndicateRaidsManager } from './syndicate-raids.js';
import { getStakeTierProgress, type StakeTierProgress } from './types.js';
import type { CooldownType, Expedition, MinerGameState, RaidResult } from './types.js';
import { YieldOrchestrator } from './yield-orchestrator.js';

/**
 * Hard ceiling on a wallet's self-reported base drill power. Mirrors the
 * gateway's protocol-level cap (kept here independently to avoid a game→net
 * import). Effective power can still exceed this via stake-tier multipliers.
 */
const MAX_REPORTED_DRILL_POWER = 10_000_000;

/** Discriminated result returned by every player-facing action. */
export type WorldResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: WorldErrorCode; message: string };

/** Stable error codes. The gateway maps these into wire envelopes. */
export type WorldErrorCode =
  | 'invalid_input'
  | 'not_authenticated'
  | 'unknown_asteroid'
  | 'unknown_player'
  | 'home_station_required'
  | 'cooldown_active'
  | 'invalid_target'
  | 'rejected'
  | 'rate_limited'
  | 'sybil_flagged'
  | 'unknown_meteor'
  | 'insufficient_credits'
  | 'use_onchain_staking';

/** Snapshot returned by `connectPlayer` and `getMinerSnapshot`. */
export interface ConnectSnapshot {
  walletAddress: string;
  /**
   * The wallet's chat handle (display name), or null if unset. Not populated by
   * the world itself — the gateway augments it from the `HandleService` before
   * relaying, so identity/handle concerns stay out of core game state.
   */
  handle?: string | null;
  homeStationAsteroidId: string | null;
  activeAsteroidId: string | null;
  /**
   * The wallet's staked $ASTROID to display. Under Quarry this is the
   * reconciled on-chain stake (persists across reconnects); otherwise the
   * legacy in-game total.
   */
  totalStake: number;
  /**
   * Current drill-power stake tier and distance to the next one, with token
   * thresholds resolved at the live $ASTROID/USD price. Lets the arena show
   * "stake N more to reach Silver" without duplicating the tier math.
   */
  tier: StakeTierProgress;
  loyaltyDays: number;
  /** Claimable mining rewards (IOU credits) not yet moved on-chain. */
  pendingYield: number;
  /** Lifetime mining rewards ever earned (gross; never decreases). */
  lifetimeEarned: number;
  /** Lifetime rewards already moved on-chain (bridged/redeemed). */
  lifetimeRedeemed: number;
  /** True while the wallet is committed to an active raid expedition. */
  onExpedition: boolean;
  /**
   * Live details of the wallet's in-flight raid (null when not raiding). Lets
   * the arena show a "raid in progress" indicator with the target, the
   * attacker's strike power, and the defense it must beat.
   */
  activeExpedition: {
    targetAsteroidId: string;
    /** This expedition's total attack power. */
    attackPower: number;
    /** The target's current raw defense power. */
    defensePower: number;
    /** Attack power must exceed this (defense × the defender advantage) to win. */
    defenseToBeat: number;
    expiresAt: string;
  } | null;
  asteroids: ReadonlyArray<{
    id: string;
    name: string;
    /** Internal mechanic class (drives game logic). */
    resource: string;
    /** Cosmetic mineral flavor; falls back to capitalized resource. */
    flavor: string;
    /** Galactic sector for grouping (Near-Earth / Inner Belt / ...). */
    sector: string;
    /** Star-map position; the arena projects this into orbit params. */
    position: { x: number; y: number; z: number };
  }>;
}

/** Snapshot returned by `getNetworkStats`. */
export interface NetworkStatsSnapshot {
  totalMiners: number;
  totalDrillPower: number;
  totalStake: number;
  totalDiscoveries: number;
  activeExpeditions: number;
  asteroids: ReturnType<AsteroidRegistry['getNetworkStats']>;
}

/** Configuration accepted by `GameWorld`. */
export interface GameWorldConfig {
  /** Initial set of asteroid definitions. May be empty for tests. */
  asteroids?: AsteroidDefinition[];
  /** When true, on-chain side-effect callbacks fire (gateway must wire). */
  chainEnabled?: boolean;
  /**
   * Whether discovery/refinery yield is paid as a real on-chain transfer
   * per event (`true`) or accrued to the in-game pending-yield ledger
   * (`false`). The sweepstakes/IOU model uses `false`: mining accrues
   * redeemable credits, and the only on-chain step is an explicit
   * redemption. Defaults to `chainEnabled` (back-compat with existing
   * tests); the boot layer passes `false` for the ledger/IOU posture.
   */
  payoutsOnChain?: boolean;
  /**
   * Whether on-chain Quarry custody is the source of truth for staking.
   * When true, the in-game `stake`/`unstake` messages are rejected (the
   * client must use the build-and-sign Quarry flow) and the in-game stake
   * mirror is reconciled from on-chain reads after `verify_stake_tx`.
   * Defaults to false (pure in-game simulation). The boot layer sets this
   * to true when the Quarry program addresses are configured.
   */
  quarryEnabled?: boolean;
  /** When false, the discovery trigger loop is disabled. Defaults to true. */
  discoveryEnabled?: boolean;
  /**
   * Total drill power at which an asteroid resolves one discovery per its
   * `baseDiscoveryTimeMs`. See `DiscoveryEngine`. Default 1.
   */
  discoveryReferenceDrillPower?: number;
  /** Safety cap on discoveries per asteroid per tick. Default 1. */
  discoveryMaxPerAsteroidPerTick?: number;
  /** RNG for finder selection + yield variance. Defaults to `Math.random`. */
  discoveryRandom?: () => number;
  /**
   * Base yield per discovery before multipliers/variance (operator retune
   * knob). Defaults to the orchestrator's built-in 100.
   */
  baseYieldPerDiscovery?: number;
  /**
   * Emission governor config. When provided (and a throttle is enabled),
   * discovery yield tapers as the outstanding redeemable liability nears the
   * treasury backing budget (and/or a rolling daily cap), protecting the
   * reserve under heavy load. Omit to issue at full rate.
   */
  emission?: EmissionGovernorConfig;
  /**
   * Percent of each discovery routed into the persistent, raidable raid vault
   * (the rest is paid to miners per-discovery). Defaults to 8%. Operator-tunable
   * via env `RAID_VAULT_PERCENT`.
   */
  raidVaultPercent?: number;
  /**
   * Meteor-strike mechanic tuning (spawn chance, warning window, vault skim,
   * yield penalty, deflect cost). Omit for defaults. Pass `{ spawnChancePerTick: 0 }`
   * to effectively disable spawns (used by tests that don't want random meteors).
   */
  meteor?: MeteorEngineConfig;
  /** Token symbol used in user-visible logs. Defaults to "$ASTROID". */
  tokenSymbol?: string;
  /**
   * Optional durable home-station persistence (e.g. Redis). When unset,
   * an in-memory store is used and home stations reset on restart.
   */
  homeStationStore?: HomeStationStore;
  /**
   * Optional durable current-balance mirror for pending yield (a cache,
   * e.g. Redis). When set, credits survive a restart/redeploy and are
   * reloaded by `restorePersistedState()`. When unset, credits are
   * in-memory only.
   */
  pendingYieldStore?: PendingYieldStore;
  /**
   * Optional append-only, auditable yield ledger (the production
   * posture, e.g. Postgres/Supabase). Preferred over `pendingYieldStore`
   * for boot restore when both are present.
   */
  yieldLedger?: YieldLedger;
  /**
   * Optional durable persistence for per-asteroid raid-vault treasuries
   * (Redis/Postgres). When set, accumulated treasuries survive a
   * restart/redeploy (restored by `restorePersistedState()`); when unset,
   * vaults are in-memory only and reset to 0 on restart.
   */
  raidVaultStore?: RaidVaultStore;
  /**
   * Optional anti-spoof bound on client-reported base drill power, forwarded
   * to the {@link StakeManager}. When set, the self-reported base drill is
   * clamped to `freeBase + stake × perStakeToken` so a wallet can't claim the
   * hard cap with little/no stake. Omit to keep the legacy unbounded behaviour.
   */
  drillPowerBound?: { freeBase: number; perStakeToken: number };
  /** Optional callback invoked per yield payout when `payoutsOnChain=true`. */
  onYieldPayout?: YieldPayoutListener;
  /**
   * Optional on-chain settlement hooks for raid-wager escrow, wired by the
   * boot layer to the durable `EscrowManager` when escrow is configured. The
   * in-memory `BetEscrow` ledger decides the game outcome; these hand the
   * resulting money movement to a restart-safe, retrying outbox. Unset means
   * resolution is in-memory only (no chain movement), e.g. local/devnet with
   * chain off.
   *
   * - `onWagerBooked`: a verified deposit is recorded as durable liability the
   *   instant the raid is booked (so a restart can refund an orphaned deposit).
   * - `onWagerSettle`: the resolved outcome (return / burn + defender spoils)
   *   handed to the outbox, which moves the real tokens with retry.
   */
  onWagerBooked?: (record: {
    wagerId: string;
    wallet: string;
    amount: number;
    expeditionId: string;
    targetAsteroid: string;
    depositSignature?: string;
  }) => void;
  onWagerSettle?: (plan: WagerSettlement) => void;
  /**
   * When true, anti-cheat starts its periodic cleanup interval and the
   * distribution service starts its tick loop on `start()`. Tests
   * default to false so timers stay deterministic.
   */
  autoStartTimers?: boolean;
  /**
   * Per-deployment cooldown duration overrides (milliseconds), forwarded to
   * the {@link CooldownManager}. Lets the boot layer soften/tune raid
   * cooldowns from env without a code change.
   */
  cooldownDurations?: Partial<Record<CooldownType, number>>;
  /**
   * Fallback max raid duration in ms (idle raids settle after this even with no
   * discovery at the target). Forwarded to the expedition tracker; defaults to
   * 10 minutes. Tunable from env in the boot layer.
   */
  expeditionMaxDurationMs?: number;
  logger?: GameLogger;
}

/** Composition root that owns one instance of every game module. */
export class GameWorld {
  // --- Module instances (constructed once, never replaced) ---
  readonly registry: AsteroidRegistry;
  readonly cooldowns: CooldownManager;
  readonly betEscrow: BetEscrow;
  readonly stakeManager: StakeManager;
  readonly expeditions: ExpeditionTracker;
  readonly raidEngine: RaidEngine;
  readonly refinery: RefineryManager;
  readonly raidVault: RaidVaultManager;
  readonly meteors: MeteorEngine;
  readonly distribution: DistributionService;
  readonly yieldOrchestrator: YieldOrchestrator;
  readonly discoveryEngine: DiscoveryEngine;
  readonly syndicates: SyndicateManager;
  readonly syndicateRaids: SyndicateRaidsManager;
  readonly antiCheat: AntiCheatService;

  // --- Config ---
  private readonly chainEnabled: boolean;
  private readonly payoutsOnChain: boolean;
  private readonly quarryEnabled: boolean;
  private readonly discoveryEnabled: boolean;
  private readonly tokenSymbol: string;
  private readonly autoStartTimers: boolean;
  private readonly log: GameLogger;
  private running = false;
  /** Wall-clock of the previous discovery sweep; seeds the next delta. */
  private lastDiscoverySweepAt: number = Date.now();

  /** wallet -> last-known authenticated state. Populated by `connectPlayer`. */
  private readonly authedWallets: Set<string> = new Set();

  /**
   * wallet -> last reported effective drill power. We track this on
   * the world (rather than the registry, which only stores per-asteroid
   * totals) so we can compute deltas for `updateMinerDrillPower` and
   * read the player's drill power when launching an expedition.
   */
  private readonly lastReportedDrillPower: Map<string, number> = new Map();

  /**
   * Optional server-push hook (wired by the gateway). Lets the world emit
   * gameplay events — raid started/resolved — to every connected client.
   * Unset in tests, where `emit` is a no-op.
   */
  private broadcaster?: (event: string, data: unknown) => void;

  /**
   * On-chain settlement hooks for raid-wager escrow (see {@link GameWorldConfig}).
   * Undefined when escrow isn't wired — resolution then only updates the
   * in-memory ledger.
   */
  private readonly onWagerBooked?: (record: {
    wagerId: string;
    wallet: string;
    amount: number;
    expeditionId: string;
    targetAsteroid: string;
    depositSignature?: string;
  }) => void;
  private readonly onWagerSettle?: (plan: WagerSettlement) => void;

  /**
   * expeditionId → the live chain-escrowed wager on it. Only populated for
   * raids launched with on-chain escrow (legacy stake-based bets are tracked
   * on the expedition itself). Drives {@link settleEscrowedWager} at
   * resolution and {@link forfeitEscrowedWager} on voluntary abandon.
   */
  private readonly expeditionWagers: Map<
    string,
    { wagerId: string; wallet: string; amount: number }
  > = new Map();

  constructor(config: GameWorldConfig = {}) {
    this.chainEnabled = config.chainEnabled ?? false;
    // Discovery/refinery payouts default to the same posture as the
    // platform chain flag (back-compat), but the boot layer overrides
    // this to `false` so mining accrues IOU credits in-game and the only
    // on-chain step is redemption.
    this.payoutsOnChain = config.payoutsOnChain ?? this.chainEnabled;
    this.quarryEnabled = config.quarryEnabled ?? false;
    this.discoveryEnabled = config.discoveryEnabled ?? true;
    this.tokenSymbol = config.tokenSymbol ?? '$ASTROID';
    this.autoStartTimers = config.autoStartTimers ?? false;
    this.log = config.logger ?? defaultLogger();
    this.onWagerBooked = config.onWagerBooked;
    this.onWagerSettle = config.onWagerSettle;

    // Layer 1: zero-dep modules.
    this.registry = new AsteroidRegistry({
      asteroids: config.asteroids ?? [],
      logger: this.log,
    });
    this.cooldowns = new CooldownManager({
      logger: this.log,
      durations: config.cooldownDurations,
    });
    this.betEscrow = new BetEscrow({ tokenSymbol: this.tokenSymbol, logger: this.log });
    this.antiCheat = new AntiCheatService({ logger: this.log });

    // Layer 2: stake manager depends on registry + bet-escrow.
    this.stakeManager = new StakeManager({
      registry: this.registry,
      betEscrow: this.betEscrow,
      tokenSymbol: this.tokenSymbol,
      quarryEnabled: config.quarryEnabled ?? false,
      homeStationStore: config.homeStationStore,
      pendingYieldStore: config.pendingYieldStore,
      yieldLedger: config.yieldLedger,
      ...(config.drillPowerBound && { drillPowerBound: config.drillPowerBound }),
      logger: this.log,
    });

    // Layer 3: expedition tracker depends on registry + stake + cooldowns.
    this.expeditions = new ExpeditionTracker({
      registry: this.registry,
      stakeManager: this.stakeManager,
      cooldownManager: this.cooldowns,
      ...(config.expeditionMaxDurationMs !== undefined && {
        maxDurationMs: config.expeditionMaxDurationMs,
      }),
      logger: this.log,
    });

    // Layer 4: raid engine depends on registry + stake + expeditions.
    this.raidEngine = new RaidEngine({
      registry: this.registry,
      stakeManager: this.stakeManager,
      tracker: this.expeditions,
      logger: this.log,
    });

    // Layer 5: economy services.
    this.refinery = new RefineryManager({
      tokenSymbol: this.tokenSymbol,
      logger: this.log,
    });
    // The persistent, raidable treasury. Funded by a small per-discovery cut
    // (see YieldOrchestrator vault mode); never auto-distributed, so it doesn't
    // silently drain like the hourly refinery pool.
    this.raidVault = new RaidVaultManager({
      tokenSymbol: this.tokenSymbol,
      ...(config.raidVaultStore && { store: config.raidVaultStore }),
      logger: this.log,
    });
    this.distribution = new DistributionService({
      refinery: this.refinery,
      stakeManager: this.stakeManager,
      chainEnabled: this.payoutsOnChain,
      ...(config.onYieldPayout && { onYieldPayout: config.onYieldPayout }),
      logger: this.log,
    });
    // Emission governor (reserve protection). Only constructed when a
    // throttle is actually configured, so default/test worlds issue at full
    // rate unless told otherwise.
    const governor =
      config.emission &&
      (config.emission.budget > 0 ||
        (config.emission.dailyCap ?? 0) > 0 ||
        config.emission.getBudget !== undefined)
        ? new EmissionGovernor(config.emission)
        : undefined;
    this.yieldOrchestrator = new YieldOrchestrator({
      distribution: this.distribution,
      registry: this.registry,
      stakeManager: this.stakeManager,
      chainEnabled: this.payoutsOnChain,
      ...(config.onYieldPayout && { onYieldPayout: config.onYieldPayout }),
      ...(config.discoveryRandom && { random: config.discoveryRandom }),
      ...(config.baseYieldPerDiscovery !== undefined && {
        baseYieldPerDiscovery: config.baseYieldPerDiscovery,
      }),
      ...(governor && { governor }),
      raidVault: this.raidVault,
      ...(config.raidVaultPercent !== undefined && { raidVaultPercent: config.raidVaultPercent }),
      tokenSymbol: this.tokenSymbol,
      logger: this.log,
    });
    this.yieldOrchestrator.attachDistributionListener();

    // The discovery trigger: turns elapsed mining time + drill power
    // into resolved discoveries, which `runDiscoverySweep()` pays out
    // through the orchestrator. Without this, no yield is ever produced.
    this.discoveryEngine = new DiscoveryEngine({
      ...(config.discoveryReferenceDrillPower !== undefined && {
        referenceDrillPower: config.discoveryReferenceDrillPower,
      }),
      ...(config.discoveryMaxPerAsteroidPerTick !== undefined && {
        maxDiscoveriesPerAsteroidPerTick: config.discoveryMaxPerAsteroidPerTick,
      }),
      ...(config.discoveryRandom && { random: config.discoveryRandom }),
      logger: this.log,
    });

    // Layer 6: syndicates.
    this.syndicates = new SyndicateManager({
      stakeManager: this.stakeManager,
      tokenSymbol: this.tokenSymbol,
      logger: this.log,
    });
    this.syndicateRaids = new SyndicateRaidsManager({
      syndicates: this.syndicates,
      stakeManager: this.stakeManager,
      registry: this.registry,
      raidEngine: this.raidEngine,
      tokenSymbol: this.tokenSymbol,
      logger: this.log,
    });

    // Layer 7: meteor strikes (idle-miner gamification). Threatens asteroids on
    // the tick; miners pay to deflect (→ vault) or eat a vault skim + yield hit.
    this.meteors = new MeteorEngine({
      ...(config.meteor ?? {}),
      ...(config.discoveryRandom && !config.meteor?.random && { random: config.discoveryRandom }),
      logger: this.log,
    });
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Reload durable state from the configured stores (Redis) into memory.
   * Call once on boot, before serving traffic, so redeemable IOU credits
   * (pending yield) survive a restart/redeploy. No-op when no durable
   * `pendingYieldStore` is wired. Home stations are restored lazily
   * per-wallet on `connectPlayer`, so they don't need a global pass here.
   */
  async restorePersistedState(): Promise<void> {
    const restored = await this.stakeManager.restorePendingYield();
    if (restored > 0) {
      this.log.info(`[GameWorld] restored pending yield for ${restored} wallet(s) from store`);
    }
    const vaults = await this.raidVault.restore();
    if (vaults > 0) {
      this.log.info(`[GameWorld] restored raid-vault treasury for ${vaults} asteroid(s) from store`);
    }
  }

  /** Start periodic services. Idempotent. Tests usually skip this. */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.autoStartTimers) {
      this.distribution.start();
      this.antiCheat.start();
    }
    this.lastDiscoverySweepAt = Date.now();
    this.log.info(
      `[GameWorld] started (chainEnabled=${this.chainEnabled}, ` +
        `payoutsOnChain=${this.payoutsOnChain}, discoveryEnabled=${this.discoveryEnabled}, ` +
        `autoStartTimers=${this.autoStartTimers})`,
    );
  }

  /** Stop periodic services. Idempotent. Safe to call before `start`. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.distribution.stop();
    this.antiCheat.stop();
    this.log.info('[GameWorld] stopped');
  }

  /**
   * Run periodic maintenance: cooldown sweep, asteroid effect expiry,
   * expedition cleanup, anti-cheat cleanup. The gateway calls this on
   * a 60s cadence in the BG model. Tests call it manually.
   */
  tick(): void {
    this.cooldowns.cleanupExpired();
    this.registry.clearExpiredEffects();
    this.expeditions.cleanup();
    this.antiCheat.cleanupExpiredEntries();
    this.betEscrow.cleanupResolvedPools();
    const discovered = this.runDiscoverySweep();
    this.resolveDueRaids(discovered);
    this.runMeteorSweep();
  }

  /**
   * Meteor lifecycle on the tick: resolve any meteor whose warning window has
   * closed without a deflection (skim the vault + apply a discovery-yield
   * penalty), then roll for a new incoming meteor against a random eligible
   * asteroid. Broadcasts `meteor_incoming` / `meteor_resolved` to clients.
   * `nowMs` is injectable for deterministic tests.
   */
  runMeteorSweep(nowMs: number = Date.now()): { spawned: MeteorThreat | null; struck: MeteorThreat[] } {
    // 1. Resolve due strikes first (so a just-expired meteor doesn't linger a tick).
    const struck = this.meteors.resolveDue(nowMs);
    for (const m of struck) {
      const balance = this.raidVault.getBalance(m.asteroidId);
      const skim = Math.floor((balance * m.vaultSkimPercent) / 100);
      const skimmed = skim > 0 ? this.raidVault.debit(m.asteroidId, skim) : 0;
      m.skimmed = skimmed;
      this.registry.applyMeteorYieldPenalty(m.asteroidId, m.yieldPenaltyPercent, m.yieldPenaltyMs);
      this.emit('meteor_resolved', {
        meteorId: m.id,
        asteroidId: m.asteroidId,
        deflected: false,
        skimmed,
        yieldPenaltyPercent: m.yieldPenaltyPercent,
        yieldPenaltyMs: m.yieldPenaltyMs,
        resolvedAt: (m.resolvedAt ?? new Date(nowMs)).toISOString(),
      });
    }

    // 2. Roll for a new meteor against eligible asteroids (those with a vault
    //    worth threatening or active miners to keep on their toes).
    const candidates = this.registry.getAllAsteroids().flatMap((a) => {
      const asteroidId = a.definition.id;
      const vaultBalance = this.raidVault.getBalance(asteroidId);
      const hasActiveMiners = a.activeMiners.size > 0;
      if (vaultBalance <= 0 && !hasActiveMiners) return [];
      return [{ asteroidId, vaultBalance, hasActiveMiners }];
    });
    const spawned = this.meteors.maybeSpawn(candidates, nowMs);
    if (spawned) {
      this.emit('meteor_incoming', {
        meteorId: spawned.id,
        asteroidId: spawned.asteroidId,
        impactAt: spawned.impactAt.toISOString(),
        deflectCost: spawned.deflectCost,
        vaultSkimPercent: spawned.vaultSkimPercent,
        yieldPenaltyPercent: spawned.yieldPenaltyPercent,
      });
    }
    return { spawned, struck };
  }

  /**
   * Wire a server-push broadcaster (the gateway). Once set, the world emits
   * `raid_started` / `raid_resolved` events to all connected clients. Safe to
   * call once at boot; later calls replace the hook.
   */
  setBroadcaster(fn: (event: string, data: unknown) => void): void {
    this.broadcaster = fn;
  }

  private emit(event: string, data: unknown): void {
    if (!this.broadcaster) return;
    try {
      this.broadcaster(event, data);
    } catch (err) {
      this.log.error(`[GameWorld] broadcast '${event}' failed:`, err);
    }
  }

  /**
   * Advance the discovery engine by the time elapsed since the last
   * sweep and pay out everything it resolves. Each active miner's
   * effective drill power feeds both the per-asteroid discovery rate and
   * the finder/share split. Resolved discoveries route through
   * `YieldOrchestrator.processDiscovery`, which (in the default ledger
   * posture) credits the in-game pending-yield ledger — the redeemable
   * IOU balance — and funds the asteroid refinery.
   *
   * `nowMs` is injectable so tests can drive deterministic time without
   * real clocks; production passes `Date.now()`.
   */
  runDiscoverySweep(nowMs: number = Date.now()): string[] {
    const deltaMs = nowMs - this.lastDiscoverySweepAt;
    this.lastDiscoverySweepAt = nowMs;
    if (!this.discoveryEnabled || deltaMs <= 0) return [];

    const states = this.collectMiningStates();
    if (states.length === 0) return [];

    const resolved = this.discoveryEngine.tick(deltaMs, states);
    const discovered = new Set<string>();
    for (const discovery of resolved) {
      const discoveryNumber =
        (this.registry.getAsteroid(discovery.asteroidId)?.totalDiscoveries ?? 0) + 1;
      const outcome = this.yieldOrchestrator.processDiscovery({
        asteroidId: discovery.asteroidId,
        finderWallet: discovery.finderWallet,
        discoveryNumber,
        shares: discovery.shares,
      });
      this.registry.recordDiscoveryFound(discovery.asteroidId, '');
      discovered.add(discovery.asteroidId);
      // Server-push so clients can play a reward cue and float the yield gained
      // without polling. Cheap and additive — the state already exists here.
      this.emit('discovery_found', {
        asteroidId: discovery.asteroidId,
        asteroidName:
          this.registry.getAsteroid(discovery.asteroidId)?.definition.name ?? discovery.asteroidId,
        finderWallet: discovery.finderWallet,
        discoveryNumber,
        totalYield: Math.round(outcome.totalYield),
        finderYield: Math.round(outcome.finderYield),
        minerCount: outcome.minerPayouts.length,
        foundAt: nowMs,
      });
    }
    return [...discovered];
  }

  /**
   * Resolve any raids that have come due, then notify clients. A raid resolves
   * when EITHER a discovery just fired at the target (the canonical trigger)
   * OR the expedition has passed its `expiresAt` (so low-activity targets
   * still settle). Before resolving an asteroid, we seed the stealable pot
   * from its accumulated refinery treasury, and on a successful steal we debit
   * that treasury — so raids redistribute existing value rather than minting
   * fresh supply. Returns every resolved raid (also broadcast as events).
   */
  resolveDueRaids(discoveredAsteroidIds: string[] = []): RaidResult[] {
    const targets = new Set<string>(discoveredAsteroidIds);
    for (const exp of this.expeditions.checkExpiredExpeditions()) {
      targets.add(exp.targetAsteroidId);
    }
    if (targets.size === 0) return [];

    const all: RaidResult[] = [];
    for (const asteroidId of targets) {
      // Only bother if something is actually targeting this asteroid.
      if (this.getExpeditionsTargeting(asteroidId).length === 0) continue;

      // Seed the stealable pot from the live raid vault so a win steals from
      // what raiders can see in the network panel.
      const treasury = this.raidVault.getBalance(asteroidId);
      this.raidEngine.setPendingYield(asteroidId, treasury);

      const results = this.raidEngine.resolveAllRaids(asteroidId);
      for (const r of results) {
        if (r.attackersWon && r.stolenYield > 0) {
          this.raidVault.debit(asteroidId, r.stolenYield);
        }
        this.emit('raid_resolved', {
          expeditionId: r.expeditionId,
          asteroidId,
          attackersWon: r.attackersWon,
          stolenYield: Math.round(r.stolenYield),
          attackPower: Math.round(r.attackPower),
          defensePower: Math.round(r.defensePower),
          resolvedAt: r.resolvedAt.toISOString(),
        });
        // Settle any on-chain escrowed wager for this raid (no-op if it was a
        // legacy stake-based or no-bet raid).
        this.settleEscrowedWager(r, asteroidId);
        all.push(r);
      }
    }
    return all;
  }

  /**
   * Settle the on-chain escrowed wager (if any) for a just-resolved raid.
   * Resolves the in-memory `BetEscrow` pool, then dispatches the real token
   * movement via the injected chain hooks:
   *   - attackers won  → return the full wager to the raider.
   *   - defenders won  → split the forfeited wager three ways (default
   *                      40% burn / 40% recirculate / 20% defender spoils):
   *                      the recirculated share is credited to OTHER asteroids'
   *                      raid vaults in-game (fresh stealable bounty) and moved
   *                      to the backing treasury on-chain; spoils go to the
   *                      stake-weighted defenders; the remainder is burned so
   *                      escrow nets to zero.
   * No-op for raids without an escrowed wager. The chain hooks are fire-and-
   * forget; when unset (chain off) only the in-memory ledger updates.
   */
  private settleEscrowedWager(result: RaidResult, targetAsteroidId: string): void {
    const wager = this.expeditionWagers.get(result.expeditionId);
    if (!wager) return;

    const winningSide: 'attacker' | 'defender' = result.attackersWon ? 'attacker' : 'defender';
    const defenderStakes = this.collectDefenderDefensePower(targetAsteroidId);

    let resolution;
    try {
      resolution = this.betEscrow.resolveRaid(wager.wagerId, winningSide, defenderStakes);
    } catch (err) {
      // Leave the mapping in place so a later resolution attempt can retry the
      // in-memory bookkeeping; do NOT dispatch a chain settlement we can't back.
      this.log.error(
        `[GameWorld] escrow resolution failed for wager ${wager.wagerId}: ${String(err)}`,
      );
      return;
    }
    // In-memory ledger resolved — now it's safe to drop the tracking entry and
    // hand the money movement to the durable outbox.
    this.expeditionWagers.delete(result.expeditionId);

    if (winningSide === 'attacker') {
      this.onWagerSettle?.({
        wagerId: wager.wagerId,
        returnTo: { wallet: wager.wallet, amount: wager.amount },
      });
      return;
    }

    // Defenders won: the forfeited wager is split three ways by the ledger
    // (defender spoils / recirculate / burn) so the parts sum EXACTLY to the
    // wager and escrow nets to zero. Credit the recirculated share to other
    // asteroids' vaults in-game; the chain leg moves the real tokens to the
    // treasury that backs them.
    const defenderPayouts: Array<{ wallet: string; amount: number }> = [];
    for (const [defenderWallet, amount] of resolution.defenderPayouts) {
      if (amount > 0) defenderPayouts.push({ wallet: defenderWallet, amount });
    }
    const recirculate = resolution.totalRecirculated;
    const burn = resolution.totalBurned;
    if (recirculate > 0) this.recirculateToVaults(targetAsteroidId, recirculate);
    this.onWagerSettle?.({
      wagerId: wager.wagerId,
      ...(burn > 0 && { burn }),
      ...(recirculate > 0 && { recirculate }),
      ...(defenderPayouts.length > 0 && { defenderPayouts }),
    });
  }

  /**
   * Credit a forfeited wager's recirculated share to the raid vaults of
   * asteroids OTHER than the one just defended — turning a lost raid into
   * fresh stealable bounty spread across the map. Distributed evenly, with the
   * rounding remainder assigned to the last recipient so the in-game credits
   * sum EXACTLY to `amount` (matching the on-chain transfer to the backing
   * treasury). Falls back to the target itself if it's the only asteroid.
   */
  private recirculateToVaults(defendedAsteroidId: string, amount: number): void {
    if (amount <= 0) return;
    const others = this.registry
      .getAllAsteroids()
      .map((a) => a.definition.id)
      .filter((id) => id !== defendedAsteroidId);
    if (others.length === 0) {
      this.raidVault.add(defendedAsteroidId, amount);
      return;
    }
    const per = Math.floor(amount / others.length);
    let allocated = 0;
    for (let i = 0; i < others.length; i++) {
      const share = i === others.length - 1 ? amount - allocated : per;
      if (share > 0) {
        this.raidVault.add(others[i]!, share);
        allocated += share;
      }
    }
  }

  /**
   * Active defenders at `asteroidId` and their defense power, for weighting
   * escrow spoils. Mirrors the raid engine's spoils eligibility: miners
   * currently on an expedition don't defend, and only positive power counts.
   */
  private collectDefenderDefensePower(asteroidId: string): Map<string, number> {
    const stakes = new Map<string, number>();
    const asteroid = this.registry.getAsteroid(asteroidId);
    if (!asteroid) return stakes;
    for (const walletAddress of asteroid.activeMiners) {
      const minerState = this.stakeManager.getMinerState(walletAddress);
      if (minerState.currentExpeditionId) continue;
      const power = this.stakeManager.getDefensePower(walletAddress, asteroidId);
      if (power > 0) stakes.set(walletAddress, power);
    }
    return stakes;
  }

  /**
   * Forfeit the on-chain escrowed wager (if any) when a raider voluntarily
   * abandons a raid: the full wager goes to the burn sink. No-op for raids
   * without an escrowed wager.
   */
  private forfeitEscrowedWager(expeditionId: string): void {
    const wager = this.expeditionWagers.get(expeditionId);
    if (!wager) return;
    try {
      // Bookkeep as a defender win with no defenders so the pool resolves.
      this.betEscrow.resolveRaid(wager.wagerId, 'defender', new Map());
    } catch (err) {
      this.log.error(
        `[GameWorld] escrow forfeit bookkeeping failed for ${wager.wagerId}: ${String(err)}`,
      );
      return;
    }
    this.expeditionWagers.delete(expeditionId);
    // Voluntary abandon → the full wager goes to the burn sink.
    this.onWagerSettle?.({ wagerId: wager.wagerId, burn: wager.amount });
  }

  /**
   * Group the distribution service's active miners by asteroid into the
   * snapshot the discovery engine consumes. Only asteroids with at least
   * one active miner are included.
   */
  private collectMiningStates(): AsteroidMiningState[] {
    const byAsteroid = new Map<string, AsteroidMiningState>();
    for (const miner of this.distribution.getActiveMiners()) {
      const baseDiscoveryTimeMs = this.registry.getAsteroid(miner.asteroidId)?.definition
        .baseDiscoveryTimeMs;
      if (baseDiscoveryTimeMs === undefined) continue;
      let state = byAsteroid.get(miner.asteroidId);
      if (!state) {
        state = { asteroidId: miner.asteroidId, baseDiscoveryTimeMs, miners: [] };
        byAsteroid.set(miner.asteroidId, state);
      }
      state.miners.push({
        walletAddress: miner.walletAddress,
        drillPower: miner.currentDrillPower,
      });
    }
    return Array.from(byAsteroid.values());
  }

  // ============================================================================
  // Connection lifecycle (gateway → world)
  // ============================================================================

  /**
   * Authenticate a wallet. Restores its persisted home station, returns
   * a snapshot for the client to bootstrap its UI. The gateway has
   * already verified the signature before calling this.
   */
  async connectPlayer(walletAddress: string): Promise<WorldResult<ConnectSnapshot>> {
    if (!walletAddress) {
      return fail('invalid_input', 'walletAddress is required');
    }
    this.authedWallets.add(walletAddress);
    this.stakeManager.getMinerState(walletAddress);
    await this.stakeManager.restoreHomeStation(walletAddress);
    return ok(this.snapshotForWallet(walletAddress));
  }

  /** Reverse `connectPlayer`: drops authentication marker. Game state persists. */
  disconnectPlayer(walletAddress: string): void {
    if (!walletAddress) return;
    this.authedWallets.delete(walletAddress);
    const lastPower = this.lastReportedDrillPower.get(walletAddress) ?? 0;
    this.registry.removeMiner(walletAddress, lastPower);
    this.distribution.unregisterActiveMiner(walletAddress);
    this.lastReportedDrillPower.delete(walletAddress);
    // Clear the active mining location too. We've already removed the miner
    // from the registry/distribution, so leaving a stale activeAsteroidId on
    // the persisted miner state would make the reconnect snapshot claim the
    // wallet is still mining there — the client then skips re-joining and
    // every report_drill_power fails ("must join an asteroid first"). Home
    // station / defense state is keyed off homeStationAsteroidId and is
    // unaffected.
    const state = this.stakeManager.getMinerState(walletAddress);
    if (state.activeAsteroidId) {
      state.activeAsteroidId = null;
    }
  }

  /**
   * Returns the current snapshot for an authenticated wallet. Useful
   * for full-state refresh after a reconnect or for periodic
   * heartbeats from the client.
   */
  getMinerSnapshot(walletAddress: string): WorldResult<ConnectSnapshot> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'wallet not authenticated');
    }
    return ok(this.snapshotForWallet(walletAddress));
  }

  // ============================================================================
  // Asteroid actions
  // ============================================================================

  /**
   * Join an asteroid as an active miner. Required before
   * `reportDrillPower`. Players can only be at one asteroid at a time;
   * joining a new one moves them.
   */
  joinAsteroid(walletAddress: string, asteroidId: string): WorldResult<void> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    const asteroid = this.registry.getAsteroid(asteroidId);
    if (!asteroid) {
      return fail('unknown_asteroid', `asteroid '${asteroidId}' not found`);
    }
    const previous = this.registry.getMinerLocation(walletAddress);
    const lastPower = this.lastReportedDrillPower.get(walletAddress) ?? 0;
    if (previous && previous !== asteroidId) {
      this.registry.removeMiner(walletAddress, lastPower);
    }
    this.registry.addMiner(walletAddress, asteroidId, 0);
    const state = this.stakeManager.getMinerState(walletAddress);
    state.activeAsteroidId = asteroidId;

    // Mirror into the distribution service so this miner accrues
    // drill-power-seconds toward the next refinery payout.
    this.distribution.registerActiveMiner(
      walletAddress,
      asteroidId,
      asteroid.definition.resource,
      lastPower,
      this.stakeManager.getStakeAtAsteroid(walletAddress, asteroidId),
      state.loyaltyDays,
    );
    return ok(undefined);
  }

  /** Leave the currently-joined asteroid. No-op if not joined. */
  leaveAsteroid(walletAddress: string): WorldResult<void> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    const lastPower = this.lastReportedDrillPower.get(walletAddress) ?? 0;
    this.registry.removeMiner(walletAddress, lastPower);
    this.distribution.unregisterActiveMiner(walletAddress);
    const state = this.stakeManager.getMinerState(walletAddress);
    state.activeAsteroidId = null;
    return ok(undefined);
  }

  /**
   * Set the wallet's home station. Cooldown-gated by
   * `home_station_switch` (BG: `home_base_switch`). Cooldown is
   * applied only on success.
   */
  setHomeStation(walletAddress: string, asteroidId: string): WorldResult<void> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    const cooldownMessage = this.cooldowns.checkAction(walletAddress, 'home_station_switch');
    if (cooldownMessage) return fail('cooldown_active', cooldownMessage);

    const success = this.stakeManager.setHomeStation(walletAddress, asteroidId);
    if (!success) return fail('unknown_asteroid', `asteroid '${asteroidId}' not found`);
    this.cooldowns.applyCooldown(walletAddress, 'home_station_switch');
    return ok(undefined);
  }

  /**
   * (Re)compute the player's effective drill power and register it. With the
   * production drill bound enabled the `drillPower` argument is IGNORED — drill
   * is derived from the wallet's stake (`freeBase + stake×perStakeToken`) and
   * tier — so this acts as a "sync" that picks up stake/tier changes. The
   * registry stores the effective value (after multipliers) so leaderboards
   * and yield/raid math reflect what miners actually contribute. The clamp
   * below only matters in the legacy unbounded mode used by tests.
   */
  reportDrillPower(walletAddress: string, drillPower: number): WorldResult<{ effective: number }> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    if (!Number.isFinite(drillPower) || drillPower < 0) {
      return fail('invalid_input', 'drillPower must be a non-negative number');
    }
    const asteroidId = this.registry.getMinerLocation(walletAddress);
    if (!asteroidId) return fail('rejected', 'must join an asteroid first');

    // Defensive clamp. The gateway already rejects over-cap values at the
    // protocol boundary, but clamp here too so no internal/test path can push
    // an absurd base power into the registry (it would dominate the network
    // total and warp discovery rates).
    const clamped = Math.min(drillPower, MAX_REPORTED_DRILL_POWER);

    const effective = this.stakeManager.getEffectiveDrillPower(
      walletAddress,
      clamped,
      asteroidId,
    );
    const previousPower = this.lastReportedDrillPower.get(walletAddress) ?? 0;
    this.registry.updateMinerDrillPower(walletAddress, previousPower, effective);
    this.lastReportedDrillPower.set(walletAddress, effective);

    // Mirror the value into the distribution service so it can accrue
    // per-second drill-power contributions for the next refinery
    // payout. BG did this implicitly via PoolManager; we surface it.
    this.distribution.updateMinerStats(walletAddress, {
      drillPower: effective,
      asteroidId,
    });
    return ok({ effective });
  }

  /**
   * The wallet's last-reported EFFECTIVE drill power (post stake-tier
   * multipliers) — i.e. what they currently contribute at their asteroid.
   * 0 if they've never reported or aren't mining. Used by the admin console.
   */
  getReportedDrillPower(walletAddress: string): number {
    return this.lastReportedDrillPower.get(walletAddress) ?? 0;
  }

  // ============================================================================
  // Stake actions
  // ============================================================================

  /** Stake `amount` $ASTROID at an asteroid. */
  stake(walletAddress: string, asteroidId: string, amount: number): WorldResult<void> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    // When on-chain Quarry custody is the source of truth, the in-game
    // simulation stake is disabled so the two can't diverge — the client
    // must use the build-and-sign Quarry flow (build_stake_tx) instead.
    if (this.quarryEnabled) {
      return fail(
        'use_onchain_staking',
        'Staking is on-chain. Use the Quarry staking panel (build_stake_tx) to stake $ASTROID.',
      );
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail('invalid_input', 'amount must be > 0');
    }
    const success = this.stakeManager.stake(walletAddress, asteroidId, amount);
    if (!success) return fail('unknown_asteroid', `failed to stake at '${asteroidId}'`);
    return ok(undefined);
  }

  /**
   * Reconcile a wallet's on-chain Quarry stake into the in-game state so it
   * drives the stake-tier multipliers (drill power, defense, yield share).
   * Called by the gateway after a verified stake/unstake and on connect.
   * No-op when Quarry is not enabled (the legacy in-game stake mirror is the
   * source of truth in that mode). Tolerates a negative/NaN amount (treated
   * as fully unstaked).
   */
  syncOnChainStake(walletAddress: string, amount: number): void {
    if (!this.quarryEnabled) return;
    this.stakeManager.setOnChainStake(walletAddress, amount);
  }

  /**
   * Unstake `amount` $ASTROID. Returns a `warning` field when the
   * wallet still has locked bets — the bet-escrow is consulted via
   * the `BetEscrowLike` interface threaded into `StakeManager`.
   */
  unstake(
    walletAddress: string,
    asteroidId: string,
    amount: number,
  ): WorldResult<{ warning?: string }> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    if (this.quarryEnabled) {
      return fail(
        'use_onchain_staking',
        'Unstaking is on-chain. Use the Quarry staking panel (build_unstake_tx) to withdraw $ASTROID.',
      );
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail('invalid_input', 'amount must be > 0');
    }
    const result = this.stakeManager.requestUnstake(walletAddress, asteroidId, amount);
    if (!result.success) {
      return fail('rejected', result.error ?? 'unstake rejected');
    }
    return ok(result.warning ? { warning: result.warning } : {});
  }

  // ============================================================================
  // IOU bridge (in-game credits -> on-chain IOU)
  // ============================================================================

  /**
   * Debit `amount` of the wallet's in-game IOU credits in preparation for
   * an on-chain bridge. Synchronous + balance-checked (via
   * `StakeManager.redeemPendingYield`) so concurrent bridges can't
   * double-spend. The gateway calls this BEFORE the chain transfer and
   * calls {@link bridgeRefund} if that transfer fails.
   */
  bridgeDebit(walletAddress: string, amount: number): WorldResult<void> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail('invalid_input', 'amount must be > 0');
    }
    const ok2 = this.stakeManager.redeemPendingYield(walletAddress, amount);
    if (!ok2) {
      return fail('rejected', 'insufficient in-game IOU credits to bridge');
    }
    return ok(undefined);
  }

  /**
   * Re-credit a previously {@link bridgeDebit}ed amount when the on-chain
   * transfer fails. Recorded as a compensating credit (asteroid
   * `bridge_refund`) so the ledger trail stays auditable.
   */
  bridgeRefund(walletAddress: string, amount: number): void {
    this.stakeManager.addPendingYield(walletAddress, 'bridge_refund', amount);
  }

  // ============================================================================
  // Expedition / raid actions
  // ============================================================================

  /**
   * Shared raid pre-flight: every reason a raid can be refused BEFORE any
   * side effect (so the wager-deposit flow can validate a raid without
   * charging a deposit, and `startExpedition` can reuse the same checks). On
   * success returns the resolved source (home) asteroid. Mirrors the reasons
   * `ExpeditionTracker.createExpedition` enforces, but surfaces a specific one.
   */
  private canStartExpedition(
    walletAddress: string,
    targetAsteroidId: string,
  ): WorldResult<{ sourceAsteroidId: string }> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    const state = this.stakeManager.getMinerState(walletAddress);
    if (!state.homeStationAsteroidId) {
      return fail('home_station_required', 'set a home station before raiding');
    }
    const sourceAsteroidId = state.homeStationAsteroidId;
    if (!this.registry.getAsteroid(targetAsteroidId)) {
      return fail('unknown_asteroid', 'that asteroid does not exist');
    }
    if (targetAsteroidId === sourceAsteroidId) {
      return fail('invalid_target', "you can't raid your own home station");
    }
    if (this.expeditions.getAttackerExpedition(walletAddress)) {
      return fail('rejected', "you're already on a raid — recall it before launching another");
    }
    const startCd = this.cooldowns.checkAction(walletAddress, 'expedition_start');
    if (startCd) return fail('cooldown_active', startCd);
    const recoveryCd = this.cooldowns.checkAction(walletAddress, 'expedition_recovery');
    if (recoveryCd) return fail('cooldown_active', recoveryCd);
    if (this.registry.hasRaidImmunity(targetAsteroidId)) {
      return fail(
        'rejected',
        'target just repelled a raid and is under defense immunity — try again later',
      );
    }
    return ok({ sourceAsteroidId });
  }

  /**
   * Side-effect-free raid pre-flight for the wager-deposit flow: returns the
   * same rejection a real `startExpedition` would, WITHOUT creating anything.
   * The gateway calls this before building a deposit so a player never
   * escrows tokens for a raid that would be refused (cooldown, immunity, …).
   */
  previewExpedition(walletAddress: string, targetAsteroidId: string): WorldResult<void> {
    const pre = this.canStartExpedition(walletAddress, targetAsteroidId);
    return pre.ok ? ok(undefined) : pre;
  }

  /**
   * Start an expedition against `targetAsteroidId`. The wallet's home
   * station is the source. `betAmount` of 0 is allowed (no-bet raid).
   *
   * When `escrow` is supplied, the wager is a VERIFIED on-chain deposit (the
   * gateway has already built the deposit tx, the wallet signed + submitted
   * it, and `ChainOps.verifyBetEscrowDeposit` confirmed it credited the
   * escrow). In that case the legacy stake-based bet path is skipped entirely
   * (`betAmount` is ignored / treated as 0) and the wager is tracked in the
   * `BetEscrow` ledger, settled on resolution via {@link settleEscrowedWager}.
   */
  startExpedition(
    walletAddress: string,
    targetAsteroidId: string,
    betAmount: number,
    escrow?: { wagerId: string; amount: number; txSignature: string },
  ): WorldResult<{ expeditionId: string; expiresAt: string }> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    if (!Number.isFinite(betAmount) || betAmount < 0) {
      return fail('invalid_input', 'betAmount must be >= 0');
    }
    if (escrow && (!Number.isFinite(escrow.amount) || escrow.amount <= 0)) {
      return fail('invalid_input', 'escrow wager must be > 0');
    }
    // An escrowed wager is custodied on-chain from the free wallet, so the
    // in-game stake bet is forced to 0 (no double-charge against stake).
    const stakeBet = escrow ? 0 : betAmount;

    const pre = this.canStartExpedition(walletAddress, targetAsteroidId);
    if (!pre.ok) return pre;
    const sourceAsteroidId = pre.data.sourceAsteroidId;

    // Stake-cap only applies to the legacy stake-based bet. Escrowed wagers
    // are bounded by the player's free wallet balance (enforced when the
    // deposit tx is built), not their stake.
    if (stakeBet > 0) {
      const stakeHere = this.stakeManager.getStakeAtAsteroid(walletAddress, sourceAsteroidId);
      const maxWager = Math.floor(stakeHere * 0.2);
      if (stakeBet > maxWager) {
        return fail(
          'rejected',
          stakeHere > 0
            ? `wager too high — max ${maxWager} $ASTROID (20% of the ${Math.round(stakeHere)} you have staked at your home station)`
            : 'no $ASTROID staked at your home station to wager — stake there first, or launch with a 0 wager',
        );
      }
    }

    const drillPower = this.lastReportedDrillPower.get(walletAddress) ?? 0;

    const expedition = this.expeditions.createExpedition(
      walletAddress,
      sourceAsteroidId,
      targetAsteroidId,
      drillPower,
      stakeBet,
    );
    if (!expedition) return fail('rejected', 'expedition could not be created');

    // Record the on-chain wager in the bet ledger now that the raid exists.
    // The deposit is already verified by the gateway; this only books it.
    if (escrow) {
      try {
        this.betEscrow.createRaidPool(escrow.wagerId, targetAsteroidId, sourceAsteroidId);
        this.betEscrow.placeBet(
          escrow.wagerId,
          walletAddress,
          targetAsteroidId,
          escrow.amount,
          'attacker',
          escrow.txSignature,
        );
        this.expeditionWagers.set(expedition.id, {
          wagerId: escrow.wagerId,
          wallet: walletAddress,
          amount: escrow.amount,
        });
        // Record the verified deposit as durable liability the instant the raid
        // is booked, so a restart mid-raid can refund the orphaned deposit.
        this.onWagerBooked?.({
          wagerId: escrow.wagerId,
          wallet: walletAddress,
          amount: escrow.amount,
          expeditionId: expedition.id,
          targetAsteroid: targetAsteroidId,
          depositSignature: escrow.txSignature,
        });
      } catch (err) {
        // Booking failed after a verified on-chain deposit — refund it rather
        // than strand the tokens. The expedition (already created) runs on as a
        // no-wager raid; settleEscrowedWager no-ops since expeditionWagers is
        // unset for it.
        this.log.error(
          `[GameWorld] failed to book escrowed wager for ${expedition.id}: ${String(err)} — refunding deposit`,
        );
        this.onWagerSettle?.({
          wagerId: escrow.wagerId,
          returnTo: { wallet: walletAddress, amount: escrow.amount },
        });
      }
    }

    this.emit('raid_started', {
      expeditionId: expedition.id,
      sourceAsteroidId: expedition.sourceAsteroidId,
      targetAsteroidId: expedition.targetAsteroidId,
      attackerWallet: walletAddress,
      betAmount: escrow ? escrow.amount : betAmount,
      expiresAt: expedition.expiresAt.toISOString(),
    });

    return ok({
      expeditionId: expedition.id,
      expiresAt: expedition.expiresAt.toISOString(),
    });
  }

  /** Voluntarily abandon the wallet's current expedition (forfeits bet). */
  leaveExpedition(walletAddress: string): WorldResult<void> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    // Capture the expedition id before leaving so we can forfeit its escrowed
    // wager (the tracker drops the attacker→expedition mapping on leave).
    const expeditionId = this.expeditions.getAttackerExpedition(walletAddress)?.id;
    const success = this.expeditions.leaveExpedition(walletAddress);
    if (!success) return fail('rejected', 'no active expedition');
    if (expeditionId) this.forfeitEscrowedWager(expeditionId);
    return ok(undefined);
  }

  /**
   * Rally defense at an asteroid for a `tokenCost` (charged against
   * the caller's stake). 30-minute defense buff, capped multiplier.
   */
  rallyDefense(walletAddress: string, asteroidId: string, tokenCost: number): WorldResult<void> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    if (!Number.isFinite(tokenCost) || tokenCost < 0) {
      return fail('invalid_input', 'tokenCost must be >= 0');
    }
    const success = this.raidEngine.rallyDefense(asteroidId, walletAddress, tokenCost);
    if (!success) return fail('rejected', 'rally defense rejected');
    return ok(undefined);
  }

  /**
   * Pay to deflect an incoming meteor. The deflection cost (in-game pending
   * yield credits) is consumed and routed straight into the target asteroid's
   * raid vault — so a deflected strike actively *grows* the treasury. Fails
   * (benignly) if the meteor is unknown/resolved/too-late or the wallet can't
   * cover the cost.
   */
  deflectMeteor(
    walletAddress: string,
    meteorId: string,
  ): WorldResult<{ asteroidId: string; cost: number; vaultBalance: number }> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    if (!meteorId) return fail('invalid_input', 'meteorId required');
    const threat = this.meteors.getActive().find((m) => m.id === meteorId);
    if (!threat) return fail('unknown_meteor', 'no such active meteor');
    if (threat.status !== 'incoming') return fail('rejected', 'meteor already resolved');
    if (Date.now() >= threat.impactAt.getTime()) {
      return fail('rejected', 'too late — the meteor already struck');
    }
    const cost = threat.deflectCost;
    if (this.stakeManager.getPendingYield(walletAddress) < cost) {
      return fail('insufficient_credits', `need ${cost} credits to deflect this meteor`);
    }
    if (!this.stakeManager.spendPendingYield(walletAddress, cost)) {
      return fail('insufficient_credits', `need ${cost} credits to deflect this meteor`);
    }
    const result = this.meteors.deflect(meteorId, walletAddress);
    if (!result.ok) {
      // Validated above, so this is effectively unreachable; refund defensively.
      this.stakeManager.addPendingYield(walletAddress, 'meteor_refund', cost);
      return fail('rejected', 'deflection failed');
    }
    this.raidVault.add(threat.asteroidId, cost);
    this.emit('meteor_resolved', {
      meteorId: threat.id,
      asteroidId: threat.asteroidId,
      deflected: true,
      deflectedBy: walletAddress,
      deflectCost: cost,
      resolvedAt: (threat.resolvedAt ?? new Date()).toISOString(),
    });
    return ok({
      asteroidId: threat.asteroidId,
      cost,
      vaultBalance: this.raidVault.getBalance(threat.asteroidId),
    });
  }

  // ============================================================================
  // Yield / queries
  // ============================================================================

  /** Claim the wallet's accumulated pending yield. Returns claimed amount. */
  claimPendingYield(walletAddress: string): WorldResult<{ claimed: number }> {
    if (!this.authedWallets.has(walletAddress)) {
      return fail('not_authenticated', 'connect first');
    }
    const claimed = this.stakeManager.claimPendingYield(walletAddress);
    return ok({ claimed });
  }

  /** Authenticated wallet addresses currently connected. Admin-only. */
  getAuthedWallets(): string[] {
    return Array.from(this.authedWallets);
  }

  /** Whether a wallet is currently authenticated. Admin-only. */
  isAuthed(walletAddress: string): boolean {
    return this.authedWallets.has(walletAddress);
  }

  /** Aggregate, public-facing network statistics. */
  getNetworkStats(): NetworkStatsSnapshot {
    const asteroids = this.registry.getNetworkStats();

    // Enrich every row with state the registry doesn't own: the accumulated
    // refinery treasury, the stealable raid pot, and live defense power — the
    // intel raiders need before committing to an attack.
    for (const a of asteroids) {
      // Treasury = the persistent raid vault (stable; not the hourly refinery
      // pool, which drains on distribution and confused raiders).
      a.refineryBalance = Math.round(this.raidVault.getBalance(a.asteroidId));
      // What a single successful raid could carry off right now: up to the
      // max steal fraction of the treasury.
      a.stealableYield = Math.floor(a.refineryBalance * RAID_MAX_STEAL_FRACTION);
      a.defensePower = Math.round(this.raidEngine.calculateAsteroidDefensePower(a.asteroidId));
    }

    // In Quarry mode the registry's in-game stake mirror is always 0 (the
    // in-game `stake` action is disabled), so report the AUTHORITATIVE
    // on-chain stake instead. Quarry is a single global position per wallet;
    // attribute each staker's amount to the asteroid they're actively mining
    // so the per-asteroid "Stake" column reflects who's parked where.
    let totalStake: number;
    if (this.quarryEnabled) {
      const byAsteroid = new Map<string, number>();
      let sum = 0;
      for (const state of this.stakeManager.getAllMinerStates()) {
        const stake = this.stakeManager.getOnChainStake(state.walletAddress);
        if (stake <= 0) continue;
        sum += stake;
        if (state.activeAsteroidId) {
          byAsteroid.set(
            state.activeAsteroidId,
            (byAsteroid.get(state.activeAsteroidId) ?? 0) + stake,
          );
        }
      }
      for (const a of asteroids) a.totalStake = byAsteroid.get(a.asteroidId) ?? 0;
      totalStake = sum;
    } else {
      totalStake = this.registry.getTotalStake();
    }

    return {
      totalMiners: this.registry.getTotalMiners(),
      totalDrillPower: this.registry.getTotalDrillPower(),
      totalStake,
      totalDiscoveries: this.registry.getTotalDiscoveries(),
      activeExpeditions: this.expeditions.getStats().active,
      asteroids,
    };
  }

  /** All expeditions targeting a given asteroid. Used by client UIs. */
  getExpeditionsTargeting(asteroidId: string): Expedition[] {
    return this.expeditions.getExpeditionsTargeting(asteroidId);
  }

  /**
   * Serializable raids overview for the admin console: every in-flight
   * expedition plus the most recent resolved outcomes. Returns plain numbers /
   * strings (no Maps or Dates) so it can be JSON-encoded directly.
   */
  getRaidsOverview(recentLimit = 12): {
    active: Array<{
      expeditionId: string;
      attacker: string;
      attackers: number;
      sourceAsteroidId: string;
      targetAsteroidId: string;
      attackPower: number;
      defensePower: number;
      bet: number;
      expiresAt: string;
    }>;
    recent: Array<{
      expeditionId: string;
      attackersWon: boolean;
      stolenYield: number;
      attackPower: number;
      defensePower: number;
      resolvedAt: string;
    }>;
  } {
    const active = this.expeditions.getActiveExpeditions().map((e) => {
      let bet = 0;
      for (const v of e.bets.values()) bet += v;
      return {
        expeditionId: e.id,
        attacker: e.attackers[0] ?? '',
        attackers: e.attackers.length,
        sourceAsteroidId: e.sourceAsteroidId,
        targetAsteroidId: e.targetAsteroidId,
        attackPower: Math.round(e.attackPower),
        defensePower: Math.round(
          this.raidEngine.calculateAsteroidDefensePower(e.targetAsteroidId),
        ),
        bet: Math.round(bet),
        expiresAt: e.expiresAt.toISOString(),
      };
    });
    const recent = this.raidEngine.getRecentRaids(recentLimit).map((r) => ({
      expeditionId: r.expeditionId,
      attackersWon: r.attackersWon,
      stolenYield: Math.round(r.stolenYield),
      attackPower: Math.round(r.attackPower),
      defensePower: Math.round(r.defensePower),
      resolvedAt: r.resolvedAt.toISOString(),
    }));
    return { active, recent };
  }

  /**
   * Serializable meteors overview for the admin console: incoming threats plus
   * the most recent resolved (deflected/struck) outcomes. Plain JSON only.
   */
  getMeteorsOverview(recentLimit = 12): {
    active: Array<{
      meteorId: string;
      asteroidId: string;
      deflectCost: number;
      vaultSkimPercent: number;
      yieldPenaltyPercent: number;
      impactAt: string;
    }>;
    recent: Array<{
      meteorId: string;
      asteroidId: string;
      status: MeteorThreat['status'];
      deflectedBy: string | null;
      skimmed: number;
      resolvedAt: string;
    }>;
  } {
    const active = this.meteors.getActive().map((m) => ({
      meteorId: m.id,
      asteroidId: m.asteroidId,
      deflectCost: Math.round(m.deflectCost),
      vaultSkimPercent: m.vaultSkimPercent,
      yieldPenaltyPercent: m.yieldPenaltyPercent,
      impactAt: m.impactAt.toISOString(),
    }));
    const recent = this.meteors.getRecent(recentLimit).map((m) => ({
      meteorId: m.id,
      asteroidId: m.asteroidId,
      status: m.status,
      deflectedBy: m.deflectedBy ?? null,
      skimmed: Math.round(m.skimmed ?? 0),
      resolvedAt: (m.resolvedAt ?? m.impactAt).toISOString(),
    }));
    return { active, recent };
  }

  // ============================================================================
  // Internals
  // ============================================================================

  private snapshotForWallet(walletAddress: string): ConnectSnapshot {
    const state: MinerGameState = this.stakeManager.getMinerState(walletAddress);
    const asteroids = this.registry.getAllAsteroids().map((a) => ({
      id: a.definition.id,
      name: a.definition.name,
      resource: a.definition.resource,
      flavor:
        a.definition.flavor ??
        a.definition.resource[0]!.toUpperCase() + a.definition.resource.slice(1),
      sector: a.definition.sector,
      position: a.definition.position,
    }));
    return {
      walletAddress,
      homeStationAsteroidId: state.homeStationAsteroidId,
      activeAsteroidId: state.activeAsteroidId,
      totalStake: this.stakeManager.getDisplayStake(walletAddress),
      tier: getStakeTierProgress(this.stakeManager.getDisplayStake(walletAddress)),
      loyaltyDays: state.loyaltyDays,
      pendingYield: this.stakeManager.getPendingYield(walletAddress),
      lifetimeEarned: this.stakeManager.getLifetimeEarned(walletAddress),
      lifetimeRedeemed: this.stakeManager.getLifetimeRedeemed(walletAddress),
      onExpedition: Boolean(state.currentExpeditionId),
      activeExpedition: this.activeExpeditionFor(walletAddress),
      asteroids,
    };
  }

  /** Build the live raid-in-progress payload for a wallet (null if not raiding). */
  private activeExpeditionFor(walletAddress: string): ConnectSnapshot['activeExpedition'] {
    const exp = this.expeditions.getAttackerExpedition(walletAddress);
    if (!exp || exp.status !== 'active') return null;
    const defensePower = this.raidEngine.calculateAsteroidDefensePower(exp.targetAsteroidId);
    return {
      targetAsteroidId: exp.targetAsteroidId,
      attackPower: Math.round(exp.attackPower),
      defensePower: Math.round(defensePower),
      defenseToBeat: Math.round(defensePower * DEFENSE_ADVANTAGE),
      expiresAt: exp.expiresAt.toISOString(),
    };
  }
}

// ----- Helpers (not exported; internal use only) -----

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

function fail(
  code: WorldErrorCode,
  message: string,
): { ok: false; code: WorldErrorCode; message: string } {
  return { ok: false, code, message };
}

function defaultLogger(): GameLogger {
  return {
    info: (msg, ...rest) => console.info(msg, ...rest),
    warn: (msg, ...rest) => console.warn(msg, ...rest),
    error: (msg, ...rest) => console.error(msg, ...rest),
  };
}
