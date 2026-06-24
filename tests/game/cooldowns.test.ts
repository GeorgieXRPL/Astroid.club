/**
 * Unit tests for `server/game/cooldowns.ts`.
 *
 * Mirrors BG's behaviour for hasCooldown / getRemainingCooldown /
 * applyCooldown / clearCooldown / clearAllCooldowns / cleanupExpired /
 * checkAction. Uses Vitest fake timers to keep tests deterministic.
 *
 * Numerical durations come from `COOLDOWN_DURATIONS` in `types.ts`:
 *
 *   - home_station_switch:      24h (24 * 60 * 60 * 1000 ms)
 *   - expedition_start:          1h (60 * 60 * 1000 ms)
 *   - expedition_recovery:      30m (30 * 60 * 1000 ms)
 *   - rally_defense:             1h (60 * 60 * 1000 ms)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CooldownManager } from '../../server/game/cooldowns.js';
import type { GameLogger } from '../../server/game/interfaces.js';
import { COOLDOWN_DURATIONS } from '../../server/game/types.js';

const WALLET = 'wallet_alice';
const OTHER = 'wallet_bob';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('CooldownManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports no cooldown for an unknown wallet', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    expect(cm.hasCooldown(WALLET, 'expedition_start')).toBe(false);
    expect(cm.getRemainingCooldown(WALLET, 'expedition_start')).toBe(0);
    expect(cm.checkAction(WALLET, 'expedition_start')).toBeNull();
  });

  it('applies a cooldown and reports it as active until it expires', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    cm.applyCooldown(WALLET, 'expedition_start');

    expect(cm.hasCooldown(WALLET, 'expedition_start')).toBe(true);
    expect(cm.getRemainingCooldown(WALLET, 'expedition_start')).toBe(
      COOLDOWN_DURATIONS.expedition_start,
    );

    vi.advanceTimersByTime(COOLDOWN_DURATIONS.expedition_start - 1);
    expect(cm.hasCooldown(WALLET, 'expedition_start')).toBe(true);
    expect(cm.getRemainingCooldown(WALLET, 'expedition_start')).toBe(1);

    vi.advanceTimersByTime(2);
    expect(cm.hasCooldown(WALLET, 'expedition_start')).toBe(false);
    expect(cm.getRemainingCooldown(WALLET, 'expedition_start')).toBe(0);
  });

  it('replaces an existing cooldown of the same type instead of stacking', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    cm.applyCooldown(WALLET, 'expedition_start');

    vi.advanceTimersByTime(30 * 60 * 1000);
    cm.applyCooldown(WALLET, 'expedition_start');

    expect(cm.getRemainingCooldown(WALLET, 'expedition_start')).toBe(
      COOLDOWN_DURATIONS.expedition_start,
    );
    expect(cm.getActiveCooldowns(WALLET)).toHaveLength(1);
  });

  it('keeps cooldowns of different types independent', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    cm.applyCooldown(WALLET, 'expedition_start');
    cm.applyCooldown(WALLET, 'expedition_recovery');

    expect(cm.hasCooldown(WALLET, 'expedition_start')).toBe(true);
    expect(cm.hasCooldown(WALLET, 'expedition_recovery')).toBe(true);
    expect(cm.getActiveCooldowns(WALLET)).toHaveLength(2);

    vi.advanceTimersByTime(COOLDOWN_DURATIONS.expedition_recovery + 1);

    expect(cm.hasCooldown(WALLET, 'expedition_recovery')).toBe(false);
    expect(cm.hasCooldown(WALLET, 'expedition_start')).toBe(true);
  });

  it('clears a specific cooldown without affecting others', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    cm.applyCooldown(WALLET, 'expedition_start');
    cm.applyCooldown(WALLET, 'rally_defense');

    cm.clearCooldown(WALLET, 'rally_defense');

    expect(cm.hasCooldown(WALLET, 'expedition_start')).toBe(true);
    expect(cm.hasCooldown(WALLET, 'rally_defense')).toBe(false);
  });

  it('clearCooldown is a no-op for unknown wallets / types', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    expect(() => cm.clearCooldown(WALLET, 'expedition_start')).not.toThrow();

    cm.applyCooldown(WALLET, 'expedition_start');
    cm.clearCooldown(WALLET, 'rally_defense');
    expect(cm.hasCooldown(WALLET, 'expedition_start')).toBe(true);
  });

  it('clears all cooldowns for a wallet without touching others', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    cm.applyCooldown(WALLET, 'expedition_start');
    cm.applyCooldown(WALLET, 'expedition_recovery');
    cm.applyCooldown(OTHER, 'expedition_start');

    cm.clearAllCooldowns(WALLET);

    expect(cm.getActiveCooldowns(WALLET)).toHaveLength(0);
    expect(cm.hasCooldown(OTHER, 'expedition_start')).toBe(true);
  });

  it('cleanupExpired drops past cooldowns and prunes empty wallets', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    cm.applyCooldown(WALLET, 'expedition_recovery'); // 30m
    cm.applyCooldown(WALLET, 'expedition_start'); //     1h
    cm.applyCooldown(OTHER, 'expedition_recovery'); //  30m

    vi.advanceTimersByTime(COOLDOWN_DURATIONS.expedition_recovery + 1);

    cm.cleanupExpired();

    expect(cm.getActiveCooldowns(WALLET)).toHaveLength(1);
    expect(cm.hasCooldown(WALLET, 'expedition_start')).toBe(true);
    expect(cm.hasCooldown(WALLET, 'expedition_recovery')).toBe(false);

    expect(cm.getActiveCooldowns(OTHER)).toHaveLength(0);
  });

  it('checkAction returns null when allowed', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    expect(cm.checkAction(WALLET, 'expedition_start')).toBeNull();
  });

  it('checkAction returns a human-readable label including hours+minutes', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    cm.applyCooldown(WALLET, 'expedition_start'); // 1h

    const msg = cm.checkAction(WALLET, 'expedition_start');
    expect(msg).not.toBeNull();
    expect(msg).toContain('start an expedition');
    expect(msg).toMatch(/\d+h \d+m|\d+m/);
  });

  it('checkAction uses the rethemed home_station_switch label', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    cm.applyCooldown(WALLET, 'home_station_switch');

    const msg = cm.checkAction(WALLET, 'home_station_switch');
    expect(msg).toContain('switch your home station');
  });

  it('checkAction uses the recovery label for expedition_recovery', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    cm.applyCooldown(WALLET, 'expedition_recovery');

    const msg = cm.checkAction(WALLET, 'expedition_recovery');
    expect(msg).toContain('start another expedition');
  });

  it('checkAction uses the rally label for rally_defense', () => {
    const cm = new CooldownManager({ logger: silentLogger });
    cm.applyCooldown(WALLET, 'rally_defense');

    const msg = cm.checkAction(WALLET, 'rally_defense');
    expect(msg).toContain('rally defense');
  });
});
