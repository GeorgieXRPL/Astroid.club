/**
 * Asteroid registry for astroid.club.
 *
 * Ported from `Black-Gold-main/server/game/mine-registry.ts` per
 * `docs/PORTING_NOTES.md`. The state model, all resource-mechanic
 * branches (Stellar Strike on gold, Solar Flare on silver, syndicate
 * scaling on oil), defense/attack buff durations and percentages, and
 * the multiplier composition order are byte-identical to BG.
 *
 * Architectural changes:
 *
 * 1. **No hash-pool.** BG's `MineRegistry` consumed
 *    `server/pool/difficulty.ts` to dynamically recompute
 *    per-asteroid difficulty whenever miners joined/left. astroid.club
 *    does not run a Bitcoin-style PoW pool — the `difficulty` and
 *    `target` fields on `AsteroidState` are kept as informational
 *    placeholders (so the data model stays compatible) but nothing
 *    recomputes them. `updateAsteroidDifficulty(...)` is preserved as
 *    a manual setter for if/when difficulty is reintroduced via a
 *    different system.
 *
 * 2. **Dependency injection.** No module-level singleton; construct
 *    directly with optional `{ asteroids, logger }`. Implements
 *    `AsteroidRegistryLike` so RaidEngine and ExpeditionTracker depend
 *    on the narrow interface.
 *
 * 3. **Empty-by-default.** BG's constructor seeded the registry from
 *    the `MINES` constant. Our `ASTEROIDS` array is intentionally empty
 *    in this phase (creative pass deferred), so the constructor accepts
 *    an explicit `asteroids` list and exposes `registerAsteroid` so
 *    tests and bootstrap code can populate the registry without
 *    hardcoded data.
 */

import type { AsteroidDefinition, ResourceType } from '../../config/asteroids.js';

import type { AsteroidRegistryLike, GameLogger } from './interfaces.js';
import type { AsteroidNetworkStats, AsteroidState } from './types.js';
import {
  calculateSyndicateMultiplier,
  rollSolarFlareMultiplier,
  rollStellarStrikeJackpot,
} from './types.js';

/** Configuration accepted by the asteroid registry. */
export interface AsteroidRegistryConfig {
  /** Initial set of asteroid definitions to seed the registry with. */
  asteroids?: AsteroidDefinition[];
  logger?: GameLogger;
}

/**
 * Post-defense raid-immunity window (minutes). Tunable per-deployment via
 * RAID_IMMUNITY_MIN; defaults to 30 (softened from BG's 2h so an asteroid
 * re-enters the raid pool sooner and the loop stays active).
 */
const RAID_IMMUNITY_MIN = (() => {
  const n = Number(process.env.RAID_IMMUNITY_MIN);
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();

/** Defense-buff tuning constants. */
const DEFENSE_BUFF = {
  /** Raid-immunity window after a successful defense (env: RAID_IMMUNITY_MIN, default 30m). */
  IMMUNITY_MS: RAID_IMMUNITY_MIN * 60 * 1000,
  /** 10% drill-power boost on top of immunity. */
  DRILL_POWER_BOOST: 1.1,
  /** 1-hour drill-power boost window (now outlasts the shorter immunity window). */
  BOOST_MS: 60 * 60 * 1000,
} as const;

/** Attack-debuff tuning constants — preserved verbatim from BG. */
const ATTACK_DEBUFF = {
  /** 20% drill-power reduction (multiplier of 0.8). */
  DRILL_POWER_REDUCTION: 0.8,
  /** 30-minute debuff window. */
  DURATION_MS: 30 * 60 * 1000,
} as const;

/** Stellar-Strike yield multiplier when active on a gold-class asteroid. */
const STELLAR_STRIKE_YIELD_MULTIPLIER = 5.0;

/**
 * Tracks per-asteroid live state: active miners, drill power, stake,
 * discovery progression, buffs/debuffs, and incoming raids.
 *
 * Implements `AsteroidRegistryLike` — RaidEngine and ExpeditionTracker
 * consume only that narrow interface.
 */
export class AsteroidRegistry implements AsteroidRegistryLike {
  private readonly asteroids: Map<string, AsteroidState> = new Map();
  /** wallet -> asteroidId. */
  private readonly minerLocations: Map<string, string> = new Map();
  private readonly log: GameLogger;

  constructor(config: AsteroidRegistryConfig = {}) {
    this.log = config.logger ?? defaultLogger();
    if (config.asteroids) {
      for (const def of config.asteroids) {
        this.registerAsteroid(def);
      }
    }
    this.log.info(`[AsteroidRegistry] Initialized with ${this.asteroids.size} asteroids`);
  }

  /**
   * Add an asteroid definition to the registry. BG seeded from a static
   * `MINES` constant in its constructor; astroid.club exposes this as a
   * public method since `ASTEROIDS` is intentionally empty in this
   * phase. Idempotent: a second call with the same id replaces the
   * existing state.
   */
  registerAsteroid(definition: AsteroidDefinition): AsteroidState {
    const state = createAsteroidState(definition);
    this.asteroids.set(definition.id, state);
    this.log.info(
      `[AsteroidRegistry] ${definition.name} registered ` +
        `(target=${definition.baseDiscoveryTimeMs / 60000}min)`,
    );
    return state;
  }

  // --------- AsteroidRegistryLike ---------

  getAsteroid(asteroidId: string): AsteroidState | undefined {
    return this.asteroids.get(asteroidId);
  }

  hasRaidImmunity(asteroidId: string): boolean {
    const a = this.asteroids.get(asteroidId);
    if (!a || !a.defenseBuff) return false;
    return new Date() < a.defenseBuff.immuneUntil;
  }

  applyDefenseBuff(asteroidId: string): void {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) return;
    const now = new Date();
    asteroid.defenseBuff = {
      asteroidId,
      immuneUntil: new Date(now.getTime() + DEFENSE_BUFF.IMMUNITY_MS),
      drillPowerBoost: DEFENSE_BUFF.DRILL_POWER_BOOST,
      boostExpiresAt: new Date(now.getTime() + DEFENSE_BUFF.BOOST_MS),
    };
    this.log.info(`[AsteroidRegistry] Defense buff applied to ${asteroid.definition.name}`);
  }

  applyAttackDebuff(asteroidId: string): void {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) return;
    asteroid.attackDebuff = {
      asteroidId,
      drillPowerReduction: ATTACK_DEBUFF.DRILL_POWER_REDUCTION,
      expiresAt: new Date(Date.now() + ATTACK_DEBUFF.DURATION_MS),
    };
    this.log.info(`[AsteroidRegistry] Attack debuff applied to ${asteroid.definition.name}`);
  }

  /**
   * Apply a meteor-strike discovery-yield penalty for `durationMs`. While
   * active, `getMeteorYieldMultiplier` returns `1 - penaltyPercent/100`, which
   * the yield orchestrator multiplies into each discovery's payout. Re-applying
   * extends/refreshes the window with the larger penalty.
   */
  applyMeteorYieldPenalty(asteroidId: string, penaltyPercent: number, durationMs: number): void {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) return;
    const clampedPct = Math.max(0, Math.min(100, penaltyPercent));
    const multiplier = 1 - clampedPct / 100;
    const expiresAt = new Date(Date.now() + Math.max(0, durationMs));
    const existing = asteroid.meteorDebuff;
    asteroid.meteorDebuff = {
      asteroidId,
      yieldMultiplier:
        existing && existing.yieldMultiplier < multiplier ? existing.yieldMultiplier : multiplier,
      expiresAt: existing && existing.expiresAt > expiresAt ? existing.expiresAt : expiresAt,
    };
    this.log.info(
      `[AsteroidRegistry] Meteor yield penalty applied to ${asteroid.definition.name} ` +
        `(×${asteroid.meteorDebuff.yieldMultiplier.toFixed(2)} for ${Math.round(durationMs / 1000)}s)`,
    );
  }

  /**
   * Discovery-yield multiplier from an active meteor penalty (1.0 when none).
   * Read by the yield orchestrator so a struck asteroid pays less while the
   * penalty window is open.
   */
  getMeteorYieldMultiplier(asteroidId: string, now: Date = new Date()): number {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid || !asteroid.meteorDebuff) return 1.0;
    if (now >= asteroid.meteorDebuff.expiresAt) return 1.0;
    return asteroid.meteorDebuff.yieldMultiplier;
  }

  addIncomingRaid(asteroidId: string, expeditionId: string): void {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) return;
    if (!asteroid.incomingRaids.includes(expeditionId)) {
      asteroid.incomingRaids.push(expeditionId);
    }
  }

  removeIncomingRaid(asteroidId: string, expeditionId: string): void {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) return;
    asteroid.incomingRaids = asteroid.incomingRaids.filter((id) => id !== expeditionId);
  }

  // --------- Read-side queries ---------

  /** All asteroid states currently registered. */
  getAllAsteroids(): AsteroidState[] {
    return Array.from(this.asteroids.values());
  }

  /** Filter to asteroids matching a resource class. */
  getAsteroidsByResource(resource: ResourceType): AsteroidState[] {
    return this.getAllAsteroids().filter((a) => a.definition.resource === resource);
  }

  /** The asteroid a miner is currently at, if any. */
  getMinerLocation(walletAddress: string): string | undefined {
    return this.minerLocations.get(walletAddress);
  }

  /** Total miners across all asteroids (counts each wallet at most once). */
  getTotalMiners(): number {
    return this.minerLocations.size;
  }

  /** Sum of `totalDrillPower` across every registered asteroid. */
  getTotalDrillPower(): number {
    let total = 0;
    for (const a of this.asteroids.values()) total += a.totalDrillPower;
    return total;
  }

  /** Sum of `totalStake` across every registered asteroid. */
  getTotalStake(): number {
    let total = 0;
    for (const a of this.asteroids.values()) total += a.totalStake;
    return total;
  }

  /** Sum of `totalDiscoveries` across every registered asteroid. */
  getTotalDiscoveries(): number {
    let total = 0;
    for (const a of this.asteroids.values()) total += a.totalDiscoveries;
    return total;
  }

  /** Snapshot of network stats for every asteroid (for HUDs / API). */
  getNetworkStats(): AsteroidNetworkStats[] {
    return this.getAllAsteroids().map((a) => ({
      asteroidId: a.definition.id,
      asteroidName: a.definition.name,
      resource: a.definition.resource,
      minerCount: a.activeMiners.size,
      drillPower: a.totalDrillPower,
      totalStake: a.totalStake,
      discoveriesFound: a.totalDiscoveries,
      difficulty: a.difficulty,
      lastDiscoveryTime: a.lastDiscoveryTime,
      hasDefenseBuff: a.defenseBuff !== null,
      hasAttackDebuff: a.attackDebuff !== null,
      activeRaidCount: a.incomingRaids.length,
      // Filled in by GameWorld.getNetworkStats (refinery + raid state live
      // outside the registry); placeholders keep the registry self-contained.
      refineryBalance: 0,
      stealableYield: 0,
      defensePower: 0,
    }));
  }

  // --------- Miner / drill-power tracking ---------

  /** Move a miner to an asteroid (auto-removing them from any prior asteroid). */
  addMiner(walletAddress: string, asteroidId: string, drillPower: number = 0): boolean {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) {
      this.log.info(`[AsteroidRegistry] Asteroid ${asteroidId} not found`);
      return false;
    }

    const previous = this.minerLocations.get(walletAddress);
    if (previous && previous !== asteroidId) {
      this.removeMiner(walletAddress);
    }

    asteroid.activeMiners.add(walletAddress);
    asteroid.totalDrillPower += drillPower;
    this.minerLocations.set(walletAddress, asteroidId);

    this.updateResourceMechanics(asteroid);

    this.log.info(
      `[AsteroidRegistry] Miner ${walletAddress} joined ${asteroid.definition.name} ` +
        `(${asteroid.activeMiners.size} miners, ${asteroid.totalDrillPower} drill power)`,
    );
    return true;
  }

  /** Remove a miner from their current asteroid. */
  removeMiner(walletAddress: string, drillPower: number = 0): boolean {
    const asteroidId = this.minerLocations.get(walletAddress);
    if (!asteroidId) return false;
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) return false;

    asteroid.activeMiners.delete(walletAddress);
    asteroid.totalDrillPower = Math.max(0, asteroid.totalDrillPower - drillPower);
    this.minerLocations.delete(walletAddress);

    this.updateResourceMechanics(asteroid);

    this.log.info(
      `[AsteroidRegistry] Miner ${walletAddress} left ${asteroid.definition.name} ` +
        `(${asteroid.activeMiners.size} miners remaining)`,
    );
    return true;
  }

  /** Adjust a miner's drill power at their current asteroid. */
  updateMinerDrillPower(walletAddress: string, oldDrillPower: number, newDrillPower: number): void {
    const asteroidId = this.minerLocations.get(walletAddress);
    if (!asteroidId) return;
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) return;
    asteroid.totalDrillPower = Math.max(
      0,
      asteroid.totalDrillPower - oldDrillPower + newDrillPower,
    );
  }

  /** Adjust an asteroid's total stake by a delta (positive or negative). */
  updateAsteroidStake(asteroidId: string, stakeDelta: number): void {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) return;
    asteroid.totalStake = Math.max(0, asteroid.totalStake + stakeDelta);
  }

  /** Manual difficulty/target setter (no pool to recompute against). */
  updateAsteroidDifficulty(asteroidId: string, difficulty: number, target: string): void {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) return;
    asteroid.difficulty = difficulty;
    asteroid.target = target;
  }

  /**
   * Record a discovery being found at an asteroid. Increments counters,
   * stamps the time, regenerates the discovery header, and triggers any
   * resource-specific post-discovery rolls (Stellar Strike on gold,
   * Solar Flare on silver).
   */
  recordDiscoveryFound(asteroidId: string, previousHash: string): void {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) return;
    asteroid.totalDiscoveries++;
    asteroid.currentDiscovery++;
    asteroid.lastDiscoveryTime = new Date();
    asteroid.discoveryHeader = generateDiscoveryHeader(asteroidId, previousHash);
    this.updatePostDiscoveryMechanics(asteroid);
  }

  /**
   * Drop expired buffs/debuffs from all asteroids. Two-stage logic: the
   * defense buff has separate immunity and boost windows. With the default
   * 30m immunity / 1h boost, immunity lifts first (the asteroid is raidable
   * again) while the drill-power boost lingers; if instead the boost expires
   * first it's reduced to 1.0 while immunity continues. Only when both
   * windows are past does the buff clear entirely.
   */
  clearExpiredEffects(): void {
    const now = new Date();
    for (const asteroid of this.asteroids.values()) {
      if (asteroid.defenseBuff) {
        const buff = asteroid.defenseBuff;
        if (now >= buff.immuneUntil && now >= buff.boostExpiresAt) {
          asteroid.defenseBuff = null;
        } else if (now >= buff.boostExpiresAt) {
          buff.drillPowerBoost = 1.0;
        }
      }
      if (asteroid.attackDebuff && now >= asteroid.attackDebuff.expiresAt) {
        asteroid.attackDebuff = null;
      }
      if (asteroid.meteorDebuff && now >= asteroid.meteorDebuff.expiresAt) {
        asteroid.meteorDebuff = null;
      }
    }
  }

  /**
   * Effective drill-power multiplier for an asteroid. Composes:
   * defense-buff boost (if still in window), attack-debuff reduction
   * (if still in window), and oil-asteroid syndicate multiplier.
   * Order preserved from BG.
   */
  getDrillPowerMultiplier(asteroidId: string): number {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) return 1.0;
    let multiplier = 1.0;
    const now = new Date();
    if (asteroid.defenseBuff && now < asteroid.defenseBuff.boostExpiresAt) {
      multiplier *= asteroid.defenseBuff.drillPowerBoost;
    }
    if (asteroid.attackDebuff && now < asteroid.attackDebuff.expiresAt) {
      multiplier *= asteroid.attackDebuff.drillPowerReduction;
    }
    if (asteroid.definition.resource === 'oil') {
      multiplier *= asteroid.syndicateMultiplier;
    }
    return multiplier;
  }

  /**
   * Effective yield multiplier for an asteroid. Starts at the
   * definition's `baseRewardMultiplier` and stacks Stellar Strike (gold,
   * 5x), Solar Flare (silver), and syndicate (oil). Order preserved.
   */
  getYieldMultiplier(asteroidId: string): number {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) return 1.0;
    let multiplier = asteroid.definition.baseRewardMultiplier;
    if (asteroid.definition.resource === 'gold' && asteroid.isStellarStrikeActive) {
      multiplier *= STELLAR_STRIKE_YIELD_MULTIPLIER;
    }
    if (asteroid.definition.resource === 'silver') {
      multiplier *= asteroid.solarFlareMultiplier;
    }
    if (asteroid.definition.resource === 'oil') {
      multiplier *= asteroid.syndicateMultiplier;
    }
    return multiplier;
  }

  /** Current target hex for the asteroid (placeholder — no pool). */
  getAsteroidTarget(asteroidId: string): string | undefined {
    return this.asteroids.get(asteroidId)?.target;
  }

  /** Configured target discovery time in ms. */
  getAsteroidTargetTime(asteroidId: string): number | undefined {
    return this.asteroids.get(asteroidId)?.definition.baseDiscoveryTimeMs;
  }

  // --------- Internals ---------

  /** Re-run resource-class scaling that depends on miner count (oil only). */
  private updateResourceMechanics(asteroid: AsteroidState): void {
    if (asteroid.definition.resource === 'oil') {
      asteroid.syndicateMultiplier = calculateSyndicateMultiplier(asteroid.activeMiners.size);
    }
  }

  /** Roll resource-class outcomes that fire on each new discovery. */
  private updatePostDiscoveryMechanics(asteroid: AsteroidState): void {
    switch (asteroid.definition.resource) {
      case 'gold':
        asteroid.isStellarStrikeActive = rollStellarStrikeJackpot();
        if (asteroid.isStellarStrikeActive) {
          this.log.info(
            `[AsteroidRegistry] STELLAR STRIKE! Jackpot at ${asteroid.definition.name}!`,
          );
        }
        break;
      case 'silver':
        asteroid.solarFlareMultiplier = rollSolarFlareMultiplier();
        break;
      default:
        break;
    }
  }
}

/** Build an `AsteroidState` from a definition with placeholder difficulty. */
function createAsteroidState(definition: AsteroidDefinition): AsteroidState {
  return {
    definition,
    activeMiners: new Set(),
    totalDrillPower: 0,
    totalStake: 0,
    currentDiscovery: 1,
    totalDiscoveries: 0,
    lastDiscoveryTime: null,
    // BG used per-asteroid `DifficultyState` from the pool layer.
    // astroid.club doesn't run a pool; these stay as informational
    // placeholders. `updateAsteroidDifficulty` is the manual hook for
    // when difficulty is reintroduced via a different system.
    difficulty: 1,
    target: '',
    incomingRaids: [],
    defenseBuff: null,
    attackDebuff: null,
    meteorDebuff: null,
    discoveryHeader: createInitialDiscoveryHeader(definition.id),
    isStellarStrikeActive: false,
    syndicateMultiplier: 1.0,
    solarFlareMultiplier: 1.0,
  };
}

/** Initial discovery header — BG-compatible format. */
function createInitialDiscoveryHeader(asteroidId: string): string {
  const timestamp = Date.now().toString(16);
  const randomBytes = Math.random().toString(16).slice(2, 18);
  return `${asteroidId}:${timestamp}:${randomBytes}`;
}

/** Per-discovery header — BG-compatible format. */
function generateDiscoveryHeader(asteroidId: string, previousHash: string): string {
  const timestamp = Date.now().toString(16);
  const prevHashTrunc = previousHash.slice(0, 16);
  const randomBytes = Math.random().toString(16).slice(2, 10);
  return `${asteroidId}:${timestamp}:${prevHashTrunc}:${randomBytes}`;
}

/** Default `console`-based logger used when none is injected. */
function defaultLogger(): GameLogger {
  return {
    info: (msg, ...rest) => console.info(msg, ...rest),
    warn: (msg, ...rest) => console.warn(msg, ...rest),
    error: (msg, ...rest) => console.error(msg, ...rest),
  };
}
