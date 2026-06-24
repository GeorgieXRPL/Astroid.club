/**
 * Discovery engine for astroid.club — the "mining algorithm" trigger.
 *
 * The economy plumbing (yield sizing, 70/30 finder/refinery split,
 * share-based payouts, refinery distribution) already lives in
 * `YieldOrchestrator` / `DistributionService` / `RefineryManager`. What
 * was missing — and what this module supplies — is the loop that decides
 * *when* a discovery (a found "seed") resolves at an asteroid and *who*
 * the finder is. Without it, `processDiscovery` is never called and no
 * yield is ever produced.
 *
 * Model (probabilistic find — a "% chance per seed", not a fixed clock):
 *
 *   - Each asteroid has a `baseDiscoveryTimeMs` (5/8/10/20 min by resource
 *     class). At a reference total drill power, that's the *expected* time
 *     between discoveries — but each tick is an independent dice roll, so
 *     a seed might land early or take a while (sweepstakes-style variance).
 *   - Each tick, the expected number of discoveries is
 *       expected = (totalDrillPower × deltaMs) / (baseDiscoveryTimeMs ×
 *                   referenceDrillPower)
 *     We resolve `floor(expected)` guaranteed discoveries plus one more
 *     with probability equal to the fractional remainder (a Bernoulli
 *     trial), capped per tick for safety. More drill power / more miners
 *     raises the per-tick chance proportionally.
 *   - For a solo miner at the reference power, the per-tick find chance is
 *     `deltaMs / baseDiscoveryTimeMs` — e.g. on a 60s tick: carbon (5 min)
 *     ≈ 20%/min, silver (8 min) ≈ 12.5%/min, oil (10 min) ≈ 10%/min, gold
 *     (20 min) ≈ 5%/min.
 *   - The **finder** is one active miner, chosen at random weighted by
 *     each miner's drill power (the player doing the most work is the most
 *     likely finder).
 *   - **Shares** for the 70% miner pool are each active miner's drill
 *     power as a percent of the asteroid's total, handed to
 *     `YieldOrchestrator.processDiscovery`.
 *
 * The engine holds no per-asteroid memory — each tick is a fresh,
 * memoryless roll (matching the geometric "chance per attempt" model).
 * It returns the resolved discoveries; the caller (GameWorld) pays them
 * out and records stats. Inject `random` and drive `tick` with explicit
 * `deltaMs` for deterministic tests.
 */

import type { GameLogger } from './interfaces.js';
import type { MinerShareInfo } from './yield-orchestrator.js';

/** A miner currently active at an asteroid, with their effective drill power. */
export interface DiscoveryMiner {
  walletAddress: string;
  /** Effective drill power (post stake-tier multipliers). */
  drillPower: number;
}

/** Per-asteroid mining snapshot fed to the engine each tick. */
export interface AsteroidMiningState {
  asteroidId: string;
  /** From `AsteroidDefinition.baseDiscoveryTimeMs`. */
  baseDiscoveryTimeMs: number;
  /** Active miners at this asteroid this tick. */
  miners: DiscoveryMiner[];
}

/** A discovery the engine resolved this tick. */
export interface ResolvedDiscovery {
  asteroidId: string;
  /** The active miner credited as the finder (gets the bonus). */
  finderWallet: string;
  /** Per-miner drill-power shares for the 70% pool (sharePercent 0–100). */
  shares: MinerShareInfo[];
}

export interface DiscoveryEngineConfig {
  /**
   * Reference total drill power: the power at which an asteroid's
   * *expected* time between discoveries equals its `baseDiscoveryTimeMs`.
   * Tune via `DISCOVERY_REFERENCE_DRILL_POWER` to match typical
   * drill-power magnitudes (set it to the expected solo drill power so a
   * lone miner finds on the design cadence). Default 1.
   */
  referenceDrillPower?: number;
  /**
   * Safety cap on discoveries resolved per asteroid per tick. Bounds
   * payouts if the reference power is mis-tuned or many miners pile onto
   * one rock. Default 1.
   */
  maxDiscoveriesPerAsteroidPerTick?: number;
  /** RNG for the find roll + finder selection. Defaults to `Math.random`. */
  random?: () => number;
  logger?: GameLogger;
}

/**
 * Resolves discoveries probabilistically per tick. Holds no per-asteroid
 * memory — every tick is an independent, memoryless roll derived purely
 * from the snapshot passed to `tick`.
 */
export class DiscoveryEngine {
  private readonly referenceDrillPower: number;
  private readonly maxPerTick: number;
  private readonly random: () => number;
  private readonly log: GameLogger;

  constructor(config: DiscoveryEngineConfig = {}) {
    this.referenceDrillPower = Math.max(1e-9, config.referenceDrillPower ?? 1);
    this.maxPerTick = Math.max(1, Math.floor(config.maxDiscoveriesPerAsteroidPerTick ?? 1));
    this.random = config.random ?? Math.random;
    this.log = config.logger ?? defaultLogger();
  }

  /**
   * Roll each asteroid for discoveries over `deltaMs` of mining and
   * return the ones that resolved. `deltaMs <= 0` is a no-op.
   *
   * The expected count this tick is `(totalDrillPower × deltaMs) /
   * (baseDiscoveryTimeMs × referenceDrillPower)`; we take the integer
   * part as guaranteed finds and roll a Bernoulli trial on the
   * fractional part, capped at `maxDiscoveriesPerAsteroidPerTick`.
   */
  tick(deltaMs: number, states: AsteroidMiningState[]): ResolvedDiscovery[] {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return [];

    const resolved: ResolvedDiscovery[] = [];

    for (const state of states) {
      const totalDrillPower = state.miners.reduce(
        (sum, m) => sum + (m.drillPower > 0 ? m.drillPower : 0),
        0,
      );
      if (totalDrillPower <= 0 || state.baseDiscoveryTimeMs <= 0) continue;

      const expected =
        (totalDrillPower * deltaMs) / (state.baseDiscoveryTimeMs * this.referenceDrillPower);
      let count = Math.floor(expected);
      const fractional = expected - count;
      if (fractional > 0 && this.random() < fractional) count += 1;
      count = Math.min(count, this.maxPerTick);

      for (let i = 0; i < count; i += 1) {
        const discovery = this.resolveOne(state);
        if (discovery) resolved.push(discovery);
      }
    }

    return resolved;
  }

  /** Build a single resolved discovery: pick a finder + compute shares. */
  private resolveOne(state: AsteroidMiningState): ResolvedDiscovery | null {
    const contributors = state.miners.filter((m) => m.drillPower > 0);
    if (contributors.length === 0) return null;

    const totalPower = contributors.reduce((sum, m) => sum + m.drillPower, 0);
    const shares: MinerShareInfo[] = contributors.map((m) => ({
      walletAddress: m.walletAddress,
      drillPowerSeconds: m.drillPower,
      sharePercent: (m.drillPower / totalPower) * 100,
    }));

    const finderWallet = this.pickFinder(contributors, totalPower);
    this.log.info(
      `[DiscoveryEngine] Discovery resolved at ${state.asteroidId} ` +
        `(finder=${finderWallet.slice(0, 8)}…, miners=${contributors.length})`,
    );
    return { asteroidId: state.asteroidId, finderWallet, shares };
  }

  /** Weighted-random finder selection (probability ∝ drill power). */
  private pickFinder(contributors: DiscoveryMiner[], totalPower: number): string {
    let roll = this.random() * totalPower;
    for (const miner of contributors) {
      roll -= miner.drillPower;
      if (roll <= 0) return miner.walletAddress;
    }
    // Float fall-through: return the last contributor.
    return contributors[contributors.length - 1]!.walletAddress;
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
