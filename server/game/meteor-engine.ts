/**
 * Meteor strike engine for astroid.club.
 *
 * Idle-miner gamification (roadmap §3.2): on the world tick, a meteor can
 * threaten a random eligible asteroid. The threat opens a **warning window**
 * during which active miners can **deflect** it by paying in-game credits — the
 * deflection payment is routed into the asteroid's raid vault, keeping the
 * treasury beefed up. If nobody deflects before impact, the meteor strikes:
 *
 *   - it **skims a % of the asteroid's raid vault** (lost value), and
 *   - it **reduces in-progress discovery yield** at that asteroid for a window.
 *
 * This engine is pure bookkeeping + deterministic rolls (RNG + clock are
 * injected). It owns NO money and applies NO effects itself: the `GameWorld`
 * orchestrates the vault debit/credit and the registry yield penalty, so all
 * side effects stay in one auditable place and the engine is trivially testable.
 */

import type { GameLogger } from './interfaces.js';

export type MeteorStatus = 'incoming' | 'deflected' | 'struck';

export interface MeteorThreat {
  id: string;
  asteroidId: string;
  spawnedAt: Date;
  /** Deadline: miners must deflect before this or the meteor strikes. */
  impactAt: Date;
  /** Percent of the asteroid's raid vault skimmed on a strike. */
  vaultSkimPercent: number;
  /** Percent reduction to discovery yield applied for `yieldPenaltyMs` on strike. */
  yieldPenaltyPercent: number;
  /** Duration of the post-strike yield penalty window. */
  yieldPenaltyMs: number;
  /** In-game credit cost to deflect (captured at spawn from the vault size). */
  deflectCost: number;
  status: MeteorStatus;
  /** Wallet that paid to deflect, if any. */
  deflectedBy?: string;
  resolvedAt?: Date;
  /** Amount actually skimmed from the vault on a strike (filled by the world). */
  skimmed?: number;
}

/** A candidate asteroid the engine may target. */
export interface MeteorCandidate {
  asteroidId: string;
  /** Current raid-vault balance — used to size the skim and deflect cost. */
  vaultBalance: number;
  /** Whether the asteroid currently has active miners (favored as targets). */
  hasActiveMiners: boolean;
}

export interface MeteorEngineConfig {
  /** Probability [0,1] that a meteor spawns on a given tick. Default 0.04. */
  spawnChancePerTick?: number;
  /** Warning window (ms) between spawn and impact. Default 90s. */
  warningMs?: number;
  /** Percent of the vault skimmed on a strike. Default 15. */
  vaultSkimPercent?: number;
  /** Percent reduction to discovery yield on a strike. Default 30. */
  yieldPenaltyPercent?: number;
  /** Duration (ms) of the post-strike yield penalty. Default 5min. */
  yieldPenaltyMs?: number;
  /** Deflect cost as a fraction of the vault balance at spawn. Default 0.10. */
  deflectCostFraction?: number;
  /** Minimum deflect cost (credits) regardless of vault size. Default 50. */
  minDeflectCost?: number;
  /** How many resolved meteors to retain for history. Default 20. */
  historyLimit?: number;
  /** RNG in [0,1). Defaults to Math.random. */
  random?: () => number;
  logger?: GameLogger;
}

const DEFAULTS = {
  // Sweeps run on the world maintenance tick (~60s). 0.04 ≈ one meteor every
  // ~25 min on average when eligible targets exist (was 0.15 ≈ one per ~7 min,
  // which felt too frequent). Tunable per deploy via METEOR_SPAWN_CHANCE.
  spawnChancePerTick: 0.04,
  warningMs: 90_000,
  vaultSkimPercent: 15,
  yieldPenaltyPercent: 30,
  yieldPenaltyMs: 5 * 60_000,
  deflectCostFraction: 0.1,
  minDeflectCost: 50,
  historyLimit: 20,
} as const;

export interface DeflectResult {
  ok: boolean;
  code?: 'unknown_meteor' | 'already_resolved' | 'expired';
  threat?: MeteorThreat;
  /** Cost the caller should charge the wallet (and route into the vault). */
  cost?: number;
}

export class MeteorEngine {
  private readonly active: Map<string, MeteorThreat> = new Map();
  private readonly history: MeteorThreat[] = [];
  private seq = 0;

  private readonly spawnChancePerTick: number;
  private readonly warningMs: number;
  private readonly vaultSkimPercent: number;
  private readonly yieldPenaltyPercent: number;
  private readonly yieldPenaltyMs: number;
  private readonly deflectCostFraction: number;
  private readonly minDeflectCost: number;
  private readonly historyLimit: number;
  private readonly random: () => number;
  private readonly log: GameLogger;

  constructor(config: MeteorEngineConfig = {}) {
    this.spawnChancePerTick = config.spawnChancePerTick ?? DEFAULTS.spawnChancePerTick;
    this.warningMs = config.warningMs ?? DEFAULTS.warningMs;
    this.vaultSkimPercent = config.vaultSkimPercent ?? DEFAULTS.vaultSkimPercent;
    this.yieldPenaltyPercent = config.yieldPenaltyPercent ?? DEFAULTS.yieldPenaltyPercent;
    this.yieldPenaltyMs = config.yieldPenaltyMs ?? DEFAULTS.yieldPenaltyMs;
    this.deflectCostFraction = config.deflectCostFraction ?? DEFAULTS.deflectCostFraction;
    this.minDeflectCost = config.minDeflectCost ?? DEFAULTS.minDeflectCost;
    this.historyLimit = config.historyLimit ?? DEFAULTS.historyLimit;
    this.random = config.random ?? Math.random;
    this.log = config.logger ?? defaultLogger();
  }

  /**
   * Roll for a new meteor this tick. Returns the spawned threat (so the world
   * can broadcast `meteor_incoming`) or null. Only one active meteor per
   * asteroid; candidates with active miners are strongly preferred so the
   * mechanic rewards participation. `nowMs` is injectable for deterministic
   * tests.
   */
  maybeSpawn(candidates: MeteorCandidate[], nowMs: number = Date.now()): MeteorThreat | null {
    if (candidates.length === 0) return null;
    if (this.random() >= this.spawnChancePerTick) return null;

    // Prefer asteroids with active miners; fall back to any candidate.
    const eligible = candidates.filter((c) => !this.active.has(c.asteroidId));
    if (eligible.length === 0) return null;
    const withMiners = eligible.filter((c) => c.hasActiveMiners);
    const pool = withMiners.length > 0 ? withMiners : eligible;
    const target = pool[Math.floor(this.random() * pool.length) % pool.length]!;

    const deflectCost = Math.max(
      this.minDeflectCost,
      Math.floor(target.vaultBalance * this.deflectCostFraction),
    );
    const threat: MeteorThreat = {
      id: `meteor_${++this.seq}_${Math.floor(nowMs)}`,
      asteroidId: target.asteroidId,
      spawnedAt: new Date(nowMs),
      impactAt: new Date(nowMs + this.warningMs),
      vaultSkimPercent: this.vaultSkimPercent,
      yieldPenaltyPercent: this.yieldPenaltyPercent,
      yieldPenaltyMs: this.yieldPenaltyMs,
      deflectCost,
      status: 'incoming',
    };
    this.active.set(threat.asteroidId, threat);
    this.log.info(
      `[MeteorEngine] ☄ Meteor ${threat.id} incoming on ${threat.asteroidId} ` +
        `(impact in ${Math.round(this.warningMs / 1000)}s, deflect cost ${deflectCost}).`,
    );
    return threat;
  }

  /**
   * Mark a meteor deflected. Validates it exists, is still incoming, and the
   * warning window hasn't closed. Returns the cost to charge (the world debits
   * the wallet and adds it to the vault). Does NOT move money itself.
   */
  deflect(meteorId: string, wallet: string, nowMs: number = Date.now()): DeflectResult {
    const threat = this.findActiveById(meteorId);
    if (!threat) return { ok: false, code: 'unknown_meteor' };
    if (threat.status !== 'incoming') return { ok: false, code: 'already_resolved', threat };
    if (nowMs >= threat.impactAt.getTime()) return { ok: false, code: 'expired', threat };

    threat.status = 'deflected';
    threat.deflectedBy = wallet;
    threat.resolvedAt = new Date(nowMs);
    this.active.delete(threat.asteroidId);
    this.pushHistory(threat);
    this.log.info(
      `[MeteorEngine] Meteor ${threat.id} on ${threat.asteroidId} DEFLECTED by ${wallet} ` +
        `(+${threat.deflectCost} to vault).`,
    );
    return { ok: true, threat, cost: threat.deflectCost };
  }

  /**
   * Resolve every meteor whose impact deadline has passed without deflection.
   * Returns the struck threats so the world can apply the vault skim + yield
   * penalty and broadcast `meteor_resolved`. Marks them `struck`.
   */
  resolveDue(nowMs: number = Date.now()): MeteorThreat[] {
    const struck: MeteorThreat[] = [];
    for (const threat of [...this.active.values()]) {
      if (threat.status === 'incoming' && nowMs >= threat.impactAt.getTime()) {
        threat.status = 'struck';
        threat.resolvedAt = new Date(nowMs);
        this.active.delete(threat.asteroidId);
        this.pushHistory(threat);
        struck.push(threat);
      }
    }
    return struck;
  }

  /** All currently-incoming meteors. */
  getActive(): MeteorThreat[] {
    return [...this.active.values()];
  }

  /** Most recently resolved meteors (newest first). */
  getRecent(limit = this.historyLimit): MeteorThreat[] {
    return this.history.slice(-limit).reverse();
  }

  private findActiveById(meteorId: string): MeteorThreat | undefined {
    for (const t of this.active.values()) if (t.id === meteorId) return t;
    return undefined;
  }

  private pushHistory(threat: MeteorThreat): void {
    this.history.push(threat);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
  }
}

function defaultLogger(): GameLogger {
  return {
    info: (msg, ...rest) => console.info(msg, ...rest),
    warn: (msg, ...rest) => console.warn(msg, ...rest),
    error: (msg, ...rest) => console.error(msg, ...rest),
  };
}
