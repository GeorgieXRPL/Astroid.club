/**
 * Cooldown manager for astroid.club.
 *
 * Ported from `Black-Gold-main/server/game/cooldowns.ts` per
 * `docs/PORTING_NOTES.md`. Logic is byte-identical to BG. Theme renames:
 *
 * - `home_base_switch` cooldown type → `home_station_switch`
 *   (handled in `types.ts`; this file uses the new key)
 * - User-visible action label "switch home base" → "switch your home station"
 *
 * Module-level singleton (`getCooldownManager` / `resetCooldownManager`)
 * removed in favour of constructor injection — see `interfaces.ts` and
 * `raid-engine.ts` for the broader pattern.
 */

import type { CooldownManagerLike, GameLogger } from './interfaces.js';
import type { Cooldown, CooldownType } from './types.js';
import { COOLDOWN_DURATIONS } from './types.js';

/** Configuration accepted by the cooldown manager. */
export interface CooldownManagerConfig {
  logger?: GameLogger;
  /**
   * Per-deployment overrides for {@link COOLDOWN_DURATIONS} (milliseconds).
   * Any omitted key falls back to the default. Wired from env in the boot
   * layer so cooldowns can be tuned without a code change.
   */
  durations?: Partial<Record<CooldownType, number>>;
}

/**
 * Tracks and enforces cooldowns for game actions: home-station switches,
 * expedition starts, expedition recovery, rally-defense reuse.
 *
 * Implements `CooldownManagerLike`, the narrow interface that
 * `ExpeditionTracker` and downstream callers consume.
 */
export class CooldownManager implements CooldownManagerLike {
  private readonly cooldowns: Map<string, Cooldown[]> = new Map();
  private readonly log: GameLogger;
  private readonly durations: Record<CooldownType, number>;

  constructor(config: CooldownManagerConfig = {}) {
    this.log = config.logger ?? defaultLogger();
    this.durations = { ...COOLDOWN_DURATIONS, ...config.durations };
  }

  /** Whether the wallet has an active cooldown of the given type. */
  hasCooldown(walletAddress: string, type: CooldownType): boolean {
    const walletCooldowns = this.cooldowns.get(walletAddress);
    if (!walletCooldowns) return false;

    const now = new Date();
    return walletCooldowns.some((cd) => cd.type === type && cd.expiresAt > now);
  }

  /** Remaining time on a cooldown in milliseconds (0 if none). */
  getRemainingCooldown(walletAddress: string, type: CooldownType): number {
    const walletCooldowns = this.cooldowns.get(walletAddress);
    if (!walletCooldowns) return 0;

    const now = new Date();
    const cooldown = walletCooldowns.find((cd) => cd.type === type && cd.expiresAt > now);
    if (!cooldown) return 0;

    return Math.max(0, cooldown.expiresAt.getTime() - now.getTime());
  }

  /** Apply a cooldown to a wallet, replacing any existing cooldown of the same type. */
  applyCooldown(walletAddress: string, type: CooldownType): void {
    let walletCooldowns = this.cooldowns.get(walletAddress);
    if (!walletCooldowns) {
      walletCooldowns = [];
      this.cooldowns.set(walletAddress, walletCooldowns);
    }

    // Replace any existing cooldown of the same type.
    const existingIndex = walletCooldowns.findIndex((cd) => cd.type === type);
    if (existingIndex >= 0) {
      walletCooldowns.splice(existingIndex, 1);
    }

    const duration = this.durations[type];
    const cooldown: Cooldown = {
      walletAddress,
      type,
      expiresAt: new Date(Date.now() + duration),
    };
    walletCooldowns.push(cooldown);

    this.log.info(
      `[CooldownManager] Applied ${type} cooldown to ${walletAddress} ` +
        `(expires in ${Math.round(duration / 60000)} minutes)`,
    );
  }

  /** Clear a specific cooldown (admin / testing). */
  clearCooldown(walletAddress: string, type: CooldownType): void {
    const walletCooldowns = this.cooldowns.get(walletAddress);
    if (!walletCooldowns) return;

    const index = walletCooldowns.findIndex((cd) => cd.type === type);
    if (index >= 0) {
      walletCooldowns.splice(index, 1);
    }
  }

  /** Clear every cooldown for a wallet. */
  clearAllCooldowns(walletAddress: string): void {
    this.cooldowns.delete(walletAddress);
  }

  /** All currently-active cooldowns for a wallet. */
  getActiveCooldowns(walletAddress: string): Cooldown[] {
    const walletCooldowns = this.cooldowns.get(walletAddress);
    if (!walletCooldowns) return [];

    const now = new Date();
    return walletCooldowns.filter((cd) => cd.expiresAt > now);
  }

  /** Drop expired cooldowns from internal state. Safe to call periodically. */
  cleanupExpired(): void {
    const now = new Date();
    let cleaned = 0;

    for (const [walletAddress, cooldowns] of this.cooldowns) {
      const before = cooldowns.length;
      const filtered = cooldowns.filter((cd) => cd.expiresAt > now);
      cleaned += before - filtered.length;

      if (filtered.length === 0) {
        this.cooldowns.delete(walletAddress);
      } else {
        this.cooldowns.set(walletAddress, filtered);
      }
    }

    if (cleaned > 0) {
      this.log.info(`[CooldownManager] Cleaned up ${cleaned} expired cooldowns`);
    }
  }

  /**
   * Check if an action is allowed (no active cooldown of that type).
   * Returns null if allowed, or a human-readable error message if blocked.
   * Implements `CooldownManagerLike.checkAction`.
   */
  checkAction(walletAddress: string, type: CooldownType): string | null {
    if (!this.hasCooldown(walletAddress, type)) {
      return null;
    }

    const remaining = this.getRemainingCooldown(walletAddress, type);
    const minutes = Math.ceil(remaining / 60000);
    const hours = Math.floor(minutes / 60);
    const timeStr = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;

    return `Cannot ${ACTION_LABELS[type]} for another ${timeStr}`;
  }
}

/** Player-facing labels used in `checkAction` error messages. */
const ACTION_LABELS: Record<CooldownType, string> = {
  home_station_switch: 'switch your home station',
  expedition_start: 'start an expedition',
  expedition_recovery: 'start another expedition',
  rally_defense: 'rally defense',
};

/** Default `console`-based logger used when none is injected. */
function defaultLogger(): GameLogger {
  return {
    info: (msg, ...rest) => console.info(msg, ...rest),
    warn: (msg, ...rest) => console.warn(msg, ...rest),
    error: (msg, ...rest) => console.error(msg, ...rest),
  };
}
