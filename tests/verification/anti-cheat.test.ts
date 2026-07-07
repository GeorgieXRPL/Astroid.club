/**
 * Unit tests for `server/verification/anti-cheat.ts`.
 *
 * Covers per-IP connection caps, per-wallet sliding-window action
 * rate limiting, exponential backoff on failures, sybil flagging
 * via IP-rotation detection, and maintenance helpers (cleanup,
 * unflag, reset). Threshold defaults match BG; tests assert each
 * numerical constant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GameLogger } from '../../server/game/interfaces.js';
import {
  ANONYMOUS_WALLET,
  AntiCheatService,
  type AntiCheatServiceConfig,
} from '../../server/verification/anti-cheat.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ALICE = 'wallet_alice_1234567890';
const BOB = 'wallet_bob___1234567890';
const CAROL = 'wallet_carol_1234567890';

function makeService(overrides: AntiCheatServiceConfig = {}): AntiCheatService {
  return new AntiCheatService({ logger: silentLogger, ...overrides });
}

describe('AntiCheatService construction', () => {
  it('does not auto-start the cleanup interval by default', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const svc = makeService();
    expect(setSpy).not.toHaveBeenCalled();
    svc.stop();
    setSpy.mockRestore();
  });

  it('starts the cleanup interval when autoStart is set', () => {
    vi.useFakeTimers();
    const svc = makeService({ autoStart: true, cleanupIntervalMs: 1000 });
    const before = svc.getStats().trackedWallets;
    expect(before).toBe(0);
    vi.advanceTimersByTime(1000);
    svc.stop();
    vi.useRealTimers();
  });

  it('stop() is idempotent and safe before start()', () => {
    const svc = makeService();
    expect(() => svc.stop()).not.toThrow();
    expect(() => svc.stop()).not.toThrow();
  });
});

describe('AntiCheatService connections', () => {
  let svc: AntiCheatService;
  beforeEach(() => {
    svc = makeService();
  });

  it('admits the first connection from a new IP', () => {
    expect(svc.checkConnection(ALICE, '1.1.1.1')).toBe(true);
    expect(svc.getStats().activeConnections).toBe(1);
    expect(svc.getStats().trackedIps).toBe(1);
  });

  it('admits up to maxConnectionsPerIp from the same IP', () => {
    expect(svc.checkConnection(ALICE, '1.1.1.1')).toBe(true);
    expect(svc.checkConnection(BOB, '1.1.1.1')).toBe(true);
    expect(svc.checkConnection(CAROL, '1.1.1.1')).toBe(true);
  });

  it('rejects the 4th simultaneous connection from one IP (default cap = 3)', () => {
    svc.checkConnection(ALICE, '1.1.1.1');
    svc.checkConnection(BOB, '1.1.1.1');
    svc.checkConnection(CAROL, '1.1.1.1');
    expect(svc.checkConnection('wallet_dave_1', '1.1.1.1')).toBe(false);
    const logs = svc.getRecentSuspiciousActivity();
    expect(logs.some((l) => l.type === 'CONNECTION_LIMIT')).toBe(true);
  });

  it('honours a custom maxConnectionsPerIp', () => {
    const tight = makeService({ maxConnectionsPerIp: 1 });
    expect(tight.checkConnection(ALICE, '2.2.2.2')).toBe(true);
    expect(tight.checkConnection(BOB, '2.2.2.2')).toBe(false);
  });

  it('recordDisconnect frees a slot under the cap', () => {
    svc.checkConnection(ALICE, '3.3.3.3');
    svc.checkConnection(BOB, '3.3.3.3');
    svc.checkConnection(CAROL, '3.3.3.3');
    expect(svc.checkConnection('wallet_dave_1', '3.3.3.3')).toBe(false);
    svc.recordDisconnect(ALICE, '3.3.3.3');
    expect(svc.checkConnection('wallet_dave_1', '3.3.3.3')).toBe(true);
  });

  it('recordDisconnect on an unknown IP does not throw or under-decrement', () => {
    expect(() => svc.recordDisconnect(ALICE, '9.9.9.9')).not.toThrow();
    expect(svc.getStats().activeConnections).toBe(0);
  });
});

describe('AntiCheatService action rate limiting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits up to maxActionsPerWindow within the window', () => {
    const svc = makeService();
    for (let i = 0; i < 10; i++) {
      expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(true);
    }
  });

  it('blocks the 11th action within the window with retryAfterMs', () => {
    const svc = makeService();
    for (let i = 0; i < 10; i++) svc.checkAction(ALICE, '1.1.1.1');
    const r = svc.checkAction(ALICE, '1.1.1.1');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Rate limit/);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('the window slides: actions allowed again after windowMs elapses', () => {
    const svc = makeService();
    for (let i = 0; i < 10; i++) svc.checkAction(ALICE, '1.1.1.1');
    expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(true);
  });

  it('honours a custom maxActionsPerWindow', () => {
    const svc = makeService({ maxActionsPerWindow: 2 });
    expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(true);
    expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(true);
    expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(false);
  });

  it('per-wallet windows are independent', () => {
    const svc = makeService({ maxActionsPerWindow: 2 });
    expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(true);
    expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(true);
    expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(false);
    expect(svc.checkAction(BOB, '1.1.1.1').allowed).toBe(true);
    expect(svc.checkAction(BOB, '1.1.1.1').allowed).toBe(true);
  });
});

describe('AntiCheatService backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('first failure sets a 1s backoff (default initialBackoffMs)', () => {
    const svc = makeService();
    svc.recordFailedAction(ALICE);
    const r = svc.checkAction(ALICE, '1.1.1.1');
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it('expires after backoff duration', () => {
    const svc = makeService();
    svc.recordFailedAction(ALICE);
    vi.advanceTimersByTime(1001);
    expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(true);
  });

  it('backoff doubles on each consecutive failure (1s -> 2s -> 4s -> 8s)', () => {
    const svc = makeService();
    svc.recordFailedAction(ALICE);
    let r = svc.checkAction(ALICE, '1.1.1.1');
    expect(r.retryAfterMs).toBeLessThanOrEqual(1000);

    vi.advanceTimersByTime(1001);
    svc.recordFailedAction(ALICE);
    r = svc.checkAction(ALICE, '1.1.1.1');
    expect(r.retryAfterMs).toBeGreaterThan(1000);
    expect(r.retryAfterMs).toBeLessThanOrEqual(2000);

    vi.advanceTimersByTime(2001);
    svc.recordFailedAction(ALICE);
    r = svc.checkAction(ALICE, '1.1.1.1');
    expect(r.retryAfterMs).toBeGreaterThan(2000);
    expect(r.retryAfterMs).toBeLessThanOrEqual(4000);

    vi.advanceTimersByTime(4001);
    svc.recordFailedAction(ALICE);
    r = svc.checkAction(ALICE, '1.1.1.1');
    expect(r.retryAfterMs).toBeGreaterThan(4000);
    expect(r.retryAfterMs).toBeLessThanOrEqual(8000);
  });

  it('caps at maxBackoffMs (default 60s)', () => {
    const svc = makeService();
    for (let i = 0; i < 20; i++) {
      svc.recordFailedAction(ALICE);
      vi.advanceTimersByTime(60_001);
    }
    svc.recordFailedAction(ALICE);
    const r = svc.checkAction(ALICE, '1.1.1.1');
    expect(r.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('recordSuccessfulAction clears backoff and failure count', () => {
    const svc = makeService();
    svc.recordFailedAction(ALICE);
    svc.recordFailedAction(ALICE);
    svc.recordSuccessfulAction(ALICE);
    expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(true);
  });

  it('resetBackoff returns false for unknown wallet, true after activity', () => {
    const svc = makeService();
    expect(svc.resetBackoff(ALICE)).toBe(false);
    svc.recordFailedAction(ALICE);
    expect(svc.resetBackoff(ALICE)).toBe(true);
    expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(true);
  });

  it('logs FAILED_ACTION at HIGH severity once failure count >= 5', () => {
    const svc = makeService();
    for (let i = 0; i < 4; i++) svc.recordFailedAction(ALICE);
    let logs = svc.getRecentSuspiciousActivity().filter((l) => l.type === 'FAILED_ACTION');
    expect(logs.every((l) => l.severity === 'MEDIUM')).toBe(true);

    svc.recordFailedAction(ALICE);
    logs = svc.getRecentSuspiciousActivity().filter((l) => l.type === 'FAILED_ACTION');
    expect(logs.some((l) => l.severity === 'HIGH')).toBe(true);
  });

  it('includes the failing action label and registered IP in the log detail', () => {
    const svc = makeService();
    svc.checkConnection(ANONYMOUS_WALLET, '9.9.9.9');
    svc.registerAuthenticatedConnection(ALICE, '9.9.9.9');
    svc.recordFailedAction(ALICE, 'start_expedition');
    const entry = svc
      .getRecentSuspiciousActivity()
      .find((l) => l.type === 'FAILED_ACTION');
    expect(entry?.details).toContain("on 'start_expedition'");
    // The IP is now resolvable (was logged as "unknown" before auth wiring).
    expect(entry?.ip).toBe('9.9.9.9');
  });
});

describe('AntiCheatService sybil flagging', () => {
  let svc: AntiCheatService;
  beforeEach(() => {
    svc = makeService();
  });

  it('does not flag below the IP threshold', () => {
    svc.checkConnection(ALICE, '1.1.1.1');
    svc.checkConnection(ALICE, '2.2.2.2');
    expect(svc.isWalletFlagged(ALICE)).toBe(false);
  });

  it('flags a wallet once it crosses maxIpsPerWallet (default 3) within an hour', () => {
    svc.checkConnection(ALICE, '1.1.1.1');
    svc.checkConnection(ALICE, '2.2.2.2');
    svc.checkConnection(ALICE, '3.3.3.3');
    expect(svc.isWalletFlagged(ALICE)).toBe(true);
    const status = svc.getWalletSybilStatus(ALICE);
    expect(status.flagged).toBe(true);
    expect(status.uniqueIps).toBe(3);
    expect(status.ips.sort()).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
  });

  it('repeat IPs do not contribute to the sybil count', () => {
    svc.checkConnection(ALICE, '1.1.1.1');
    svc.recordDisconnect(ALICE, '1.1.1.1');
    svc.checkConnection(ALICE, '1.1.1.1');
    svc.recordDisconnect(ALICE, '1.1.1.1');
    svc.checkConnection(ALICE, '1.1.1.1');
    expect(svc.isWalletFlagged(ALICE)).toBe(false);
    expect(svc.getWalletSybilStatus(ALICE).uniqueIps).toBe(1);
  });

  it('flagged wallets are still allowed to act (LOG-AND-ALLOW)', () => {
    svc.checkConnection(ALICE, '1.1.1.1');
    svc.checkConnection(ALICE, '2.2.2.2');
    svc.checkConnection(ALICE, '3.3.3.3');
    expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(true);
    const logs = svc.getRecentSuspiciousActivity();
    expect(logs.some((l) => l.type === 'SYBIL_FLAG')).toBe(true);
  });

  it('honours a custom maxIpsPerWallet', () => {
    const tight = makeService({ maxIpsPerWallet: 2, maxConnectionsPerIp: 5 });
    tight.checkConnection(ALICE, '1.1.1.1');
    expect(tight.isWalletFlagged(ALICE)).toBe(false);
    tight.checkConnection(ALICE, '2.2.2.2');
    expect(tight.isWalletFlagged(ALICE)).toBe(true);
  });

  it('unflagWallet returns false on never-flagged wallets, true after flag', () => {
    expect(svc.unflagWallet(ALICE)).toBe(false);
    svc.checkConnection(ALICE, '1.1.1.1');
    svc.checkConnection(ALICE, '2.2.2.2');
    svc.checkConnection(ALICE, '3.3.3.3');
    expect(svc.unflagWallet(ALICE)).toBe(true);
    expect(svc.isWalletFlagged(ALICE)).toBe(false);
    expect(svc.unflagWallet(ALICE)).toBe(false);
  });

  it('flagWallet flags directly for behavioral abuse (e.g. claim loops), with a CRITICAL log', () => {
    expect(svc.isWalletFlagged(ALICE)).toBe(false);
    svc.flagWallet(ALICE, 'claim-loop: 7 bridges in the last hour (cap 6)');
    expect(svc.isWalletFlagged(ALICE)).toBe(true);
    expect(svc.getWalletSybilStatus(ALICE).reason).toMatch(/claim-loop/);
    const logs = svc.getRecentSuspiciousActivity(100, 'CRITICAL');
    expect(logs.some((l) => l.type === 'SYBIL_FLAG' && l.walletAddress === ALICE)).toBe(true);
    // Idempotent: re-flagging doesn't clobber the original reason or double-log.
    const before = svc.getRecentSuspiciousActivity().length;
    svc.flagWallet(ALICE, 'another reason');
    expect(svc.getRecentSuspiciousActivity().length).toBe(before);
    expect(svc.getWalletSybilStatus(ALICE).reason).toMatch(/claim-loop/);
  });

  it('getWalletSybilStatus returns empty status for unknown wallets', () => {
    const status = svc.getWalletSybilStatus('wallet_unknown_xxxxxxx');
    expect(status).toEqual({ flagged: false, uniqueIps: 0, ips: [] });
  });

  it('never flags the anonymous pre-auth sentinel, even across many IPs', () => {
    // Pre-auth connections from unrelated visitors all share ANONYMOUS_WALLET;
    // feeding them into sybil tracking would falsely flag a fake identity.
    svc.checkConnection(ANONYMOUS_WALLET, '1.1.1.1');
    svc.checkConnection(ANONYMOUS_WALLET, '2.2.2.2');
    svc.checkConnection(ANONYMOUS_WALLET, '3.3.3.3');
    svc.checkConnection(ANONYMOUS_WALLET, '4.4.4.4');
    expect(svc.isWalletFlagged(ANONYMOUS_WALLET)).toBe(false);
    expect(svc.getWalletSybilStatus(ANONYMOUS_WALLET).uniqueIps).toBe(0);
    const logs = svc.getRecentSuspiciousActivity();
    expect(logs.some((l) => l.type === 'SYBIL_FLAG')).toBe(false);
  });

  it('registerAuthenticatedConnection feeds sybil tracking post-auth', () => {
    // The connection is admitted pre-auth as anonymous (no sybil tracking),
    // then the real wallet is registered once auth completes.
    svc.checkConnection(ANONYMOUS_WALLET, '1.1.1.1');
    svc.registerAuthenticatedConnection(ALICE, '1.1.1.1');
    svc.registerAuthenticatedConnection(ALICE, '2.2.2.2');
    svc.registerAuthenticatedConnection(ALICE, '3.3.3.3');
    expect(svc.isWalletFlagged(ALICE)).toBe(true);
    expect(svc.getWalletSybilStatus(ALICE).uniqueIps).toBe(3);
  });

  it('registerAuthenticatedConnection ignores the anonymous sentinel', () => {
    svc.registerAuthenticatedConnection(ANONYMOUS_WALLET, '1.1.1.1');
    expect(svc.getWalletSybilStatus(ANONYMOUS_WALLET).uniqueIps).toBe(0);
  });
});

describe('AntiCheatService stats and logging', () => {
  it('reports zero stats on a fresh service', () => {
    const svc = makeService();
    const stats = svc.getStats();
    expect(stats.activeConnections).toBe(0);
    expect(stats.trackedWallets).toBe(0);
    expect(stats.trackedIps).toBe(0);
    expect(stats.flaggedWallets).toBe(0);
    expect(stats.suspiciousEventsToday).toBe(0);
  });

  it('counts active connections, tracked wallets, tracked IPs, flagged wallets', () => {
    const svc = makeService();
    svc.checkConnection(ALICE, '1.1.1.1');
    svc.checkConnection(ALICE, '2.2.2.2');
    svc.checkConnection(ALICE, '3.3.3.3');
    svc.checkConnection(BOB, '4.4.4.4');
    const stats = svc.getStats();
    expect(stats.activeConnections).toBe(2); // ALICE keeps last IP
    expect(stats.trackedWallets).toBe(2);
    expect(stats.trackedIps).toBe(4);
    expect(stats.flaggedWallets).toBe(1);
  });

  it('groups suspicious events by type today', () => {
    const svc = makeService({ maxConnectionsPerIp: 1, maxActionsPerWindow: 1 });
    svc.checkConnection(ALICE, '1.1.1.1');
    svc.checkConnection(BOB, '1.1.1.1'); // CONNECTION_LIMIT
    svc.checkAction(CAROL, '2.2.2.2');
    svc.checkAction(CAROL, '2.2.2.2'); // RATE_LIMIT

    const stats = svc.getStats();
    expect(stats.suspiciousEventsByType.CONNECTION_LIMIT).toBeGreaterThanOrEqual(1);
    expect(stats.suspiciousEventsByType.RATE_LIMIT).toBeGreaterThanOrEqual(1);
  });

  it('getRecentSuspiciousActivity respects severity filter and limit', () => {
    const svc = makeService({ maxConnectionsPerIp: 1 });
    svc.checkConnection(ALICE, '1.1.1.1');
    svc.checkConnection(BOB, '1.1.1.1'); // MEDIUM CONNECTION_LIMIT
    svc.checkConnection(ALICE, '2.2.2.2');
    svc.checkConnection(ALICE, '3.3.3.3'); // CRITICAL SYBIL_FLAG

    const high = svc.getRecentSuspiciousActivity(100, 'HIGH');
    expect(high.every((l) => l.severity === 'HIGH' || l.severity === 'CRITICAL')).toBe(true);
    const limited = svc.getRecentSuspiciousActivity(1);
    expect(limited.length).toBeLessThanOrEqual(1);
  });

  it('caps the suspicious-activity log to maxLogEntries (FIFO)', () => {
    const svc = makeService({ maxLogEntries: 3, maxConnectionsPerIp: 0 });
    for (let i = 0; i < 5; i++) {
      svc.checkConnection(`wallet_x_${i}_xxxx`, `${i}.${i}.${i}.${i}`);
    }
    expect(svc.getRecentSuspiciousActivity(100).length).toBeLessThanOrEqual(3);
  });
});

describe('AntiCheatService cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cleanupExpiredEntries drops IPs older than 1h from wallet trackers', () => {
    const svc = makeService();
    svc.checkConnection(ALICE, '1.1.1.1');
    expect(svc.getWalletSybilStatus(ALICE).uniqueIps).toBe(1);

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    svc.cleanupExpiredEntries();
    expect(svc.getWalletSybilStatus(ALICE).uniqueIps).toBe(0);
  });

  it('cleanupExpiredEntries drops idle IP trackers older than 24h', () => {
    const svc = makeService();
    svc.checkConnection(ALICE, '1.1.1.1');
    svc.recordDisconnect(ALICE, '1.1.1.1');
    expect(svc.getStats().trackedIps).toBe(1);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    svc.cleanupExpiredEntries();
    expect(svc.getStats().trackedIps).toBe(0);
  });

  it('cleanupExpiredEntries drops rate-limit entries with windowStart older than 24h', () => {
    const svc = makeService();
    svc.checkAction(ALICE, '1.1.1.1');
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    svc.cleanupExpiredEntries();
    // After cleanup: a fresh window starts on the next checkAction.
    for (let i = 0; i < 10; i++) {
      expect(svc.checkAction(ALICE, '1.1.1.1').allowed).toBe(true);
    }
  });

  it('does not drop active IP trackers even when older than 24h', () => {
    const svc = makeService();
    svc.checkConnection(ALICE, '1.1.1.1');
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    svc.cleanupExpiredEntries();
    expect(svc.getStats().trackedIps).toBe(1);
  });
});
