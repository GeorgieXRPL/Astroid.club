/**
 * Anti-cheat / anti-gaming security layer for astroid.club.
 *
 * Ported from `Black-Gold-main/server/verification/anticheat.ts` per
 * `docs/PORTING_NOTES.md`. Three layered defenses:
 *
 * 1. **Per-IP connection cap** — defaults to 3 concurrent connections
 *    per source IP. Allows legitimate multi-wallet setups while making
 *    botnet attacks expensive.
 *
 * 2. **Per-wallet action rate limiting** — sliding-window counter
 *    (default 10 actions per 60s) with exponential backoff on failed
 *    actions (1s → 2s → 4s → … capped at 60s). Reset on success.
 *
 * 3. **Sybil flagging** — wallets observed from `MAX_IPS_PER_WALLET`
 *    distinct IPs within a 1-hour window are flagged. Flagging
 *    doesn't block (defaults to LOG-AND-ALLOW); operators can review
 *    and unflag manually. Cleanup keeps memory bounded.
 *
 * Architectural changes vs. BG:
 *
 * - **Class with full DI.** BG had a singleton. astroid.club instances
 *   per game world (or once at boot).
 * - **`submission` → `action`** in the public API. BG's "submission"
 *   referred to PoW proof submissions; astroid.club applies these
 *   limits to ANY high-frequency wallet action (expedition starts,
 *   bet placement, raid joins, yield claims). The semantics are
 *   identical.
 * - **Configurable thresholds via constructor.** No env-var or
 *   `RATE_LIMIT_CONFIG` lookups; defaults match BG.
 * - **Severity tags as strings.** BG used emoji in console output;
 *   we use plain text so the injectable `GameLogger` doesn't have
 *   to render glyphs.
 *
 * No numerical changes — every threshold matches BG's defaults
 * exactly.
 */

import type { GameLogger } from '../game/interfaces.js';

// ---- Defaults preserved verbatim from BG `RATE_LIMIT_CONFIG`. ----

const DEFAULT_MAX_ACTIONS_PER_WINDOW = 10;
const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_MAX_BACKOFF_MS = 60 * 1000;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 3;
const DEFAULT_MAX_IPS_PER_WALLET = 3;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_LOG_ENTRIES = 10_000;

/**
 * Sentinel used for connections that haven't authenticated a wallet yet.
 * These share a single pseudo-identity, so they are deliberately excluded
 * from sybil tracking (the per-IP connection cap is the pre-auth defense).
 */
export const ANONYMOUS_WALLET = 'anonymous';

/** Severity classification for suspicious-activity log entries. */
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Type discriminator for suspicious-activity events. */
export type SuspiciousActivityType =
  | 'RATE_LIMIT'
  | 'SYBIL_FLAG'
  | 'CONNECTION_LIMIT'
  | 'BACKOFF_ACTIVE'
  | 'FAILED_ACTION'
  | 'RAPID_IP_CHANGE';

/** A single suspicious-activity log row. */
export interface SuspiciousActivityLog {
  timestamp: number;
  type: SuspiciousActivityType;
  walletAddress: string;
  ip: string;
  details: string;
  severity: Severity;
}

/** Result of `checkAction`. */
export interface ActionCheckResult {
  /** Whether the action is allowed to proceed. */
  allowed: boolean;
  /** Human-readable reason when blocked. */
  reason?: string;
  /** Time in ms until the next allowed action (when blocked). */
  retryAfterMs?: number;
}

/** Per-wallet rate limit state. */
interface RateLimitEntry {
  count: number;
  windowStart: number;
  failedCount: number;
  /** Absolute timestamp (ms) until backoff expires; undefined when none. */
  backoffUntil?: number;
}

/** Per-IP connection counter and metadata. */
interface IPTracker {
  ip: string;
  wallets: Set<string>;
  connectionCount: number;
  firstSeen: Date;
  flagged: boolean;
}

/** Per-wallet sybil-detection state. */
interface WalletTracker {
  walletAddress: string;
  /** ip -> first-seen timestamp (ms). */
  ips: Map<string, number>;
  activeConnections: number;
  flagged: boolean;
  flagReason?: string;
}

/** Aggregate stats reported by `getStats`. */
export interface AntiCheatStats {
  activeConnections: number;
  trackedWallets: number;
  trackedIps: number;
  flaggedWallets: number;
  suspiciousEventsToday: number;
  suspiciousEventsByType: Record<SuspiciousActivityType, number>;
}

/** Sybil status snapshot for a single wallet. */
export interface WalletSybilStatus {
  flagged: boolean;
  reason?: string;
  uniqueIps: number;
  ips: string[];
}

/** Constructor configuration. Every threshold has a BG-matching default. */
export interface AntiCheatServiceConfig {
  /** Max actions per window per wallet. Default: 10. */
  maxActionsPerWindow?: number;
  /** Sliding-window length in ms. Default: 60_000. */
  windowMs?: number;
  /** Initial backoff after first failure in ms. Default: 1000. */
  initialBackoffMs?: number;
  /** Multiplier per consecutive failure. Default: 2. */
  backoffMultiplier?: number;
  /** Max backoff cap in ms. Default: 60_000. */
  maxBackoffMs?: number;
  /** Max simultaneous connections per source IP. Default: 3. */
  maxConnectionsPerIp?: number;
  /** Threshold to flag a wallet for sybil within 1h window. Default: 3. */
  maxIpsPerWallet?: number;
  /** Periodic cleanup cadence in ms. Default: 60_000. */
  cleanupIntervalMs?: number;
  /** Max retained log rows. Default: 10_000. */
  maxLogEntries?: number;
  /**
   * Whether to start the periodic cleanup interval automatically.
   * Defaults to false; tests prefer manual `cleanupExpiredEntries()`.
   * Long-lived servers should pass `true` (or call `start()`).
   */
  autoStart?: boolean;
  logger?: GameLogger;
}

/**
 * Anti-cheat service. Maintains in-memory state for rate limiting,
 * connection tracking, and sybil detection. Pure in-memory; no
 * persistence (matches BG). Restarts wipe state — sybil flags must
 * be re-derived from observed traffic.
 */
export class AntiCheatService {
  // --- Configuration (immutable after construction) ---
  private readonly maxActionsPerWindow: number;
  private readonly windowMs: number;
  private readonly initialBackoffMs: number;
  private readonly backoffMultiplier: number;
  private readonly maxBackoffMs: number;
  private readonly maxConnectionsPerIp: number;
  private readonly maxIpsPerWallet: number;
  private readonly cleanupIntervalMs: number;
  private readonly maxLogEntries: number;
  private readonly log: GameLogger;

  // --- State ---
  private readonly rateLimits: Map<string, RateLimitEntry> = new Map();
  private readonly ipTrackers: Map<string, IPTracker> = new Map();
  private readonly walletTrackers: Map<string, WalletTracker> = new Map();
  /** wallet -> ip currently registered as connected. */
  private readonly activeConnections: Map<string, string> = new Map();
  private readonly suspiciousLogs: SuspiciousActivityLog[] = [];
  private cleanupHandle: ReturnType<typeof setInterval> | null = null;

  constructor(config: AntiCheatServiceConfig = {}) {
    this.maxActionsPerWindow = config.maxActionsPerWindow ?? DEFAULT_MAX_ACTIONS_PER_WINDOW;
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this.initialBackoffMs = config.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.backoffMultiplier = config.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    this.maxBackoffMs = config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxConnectionsPerIp = config.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
    this.maxIpsPerWallet = config.maxIpsPerWallet ?? DEFAULT_MAX_IPS_PER_WALLET;
    this.cleanupIntervalMs = config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.maxLogEntries = config.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES;
    this.log = config.logger ?? defaultLogger();

    if (config.autoStart) this.start();
  }

  /** Begin the periodic cleanup interval. Idempotent. */
  start(): void {
    if (this.cleanupHandle) return;
    this.cleanupHandle = setInterval(() => {
      this.cleanupExpiredEntries();
    }, this.cleanupIntervalMs);
  }

  /** Tear down the periodic cleanup interval. */
  stop(): void {
    if (this.cleanupHandle) {
      clearInterval(this.cleanupHandle);
      this.cleanupHandle = null;
    }
  }

  // --------- Connection management ---------

  /**
   * Check whether a new connection from `ip` for `walletAddress`
   * should be admitted. Enforces per-IP connection cap and updates
   * sybil tracking. Returns `true` on accept; `false` (with a
   * suspicious-activity log row) when the IP has hit its cap.
   */
  checkConnection(walletAddress: string, ip: string): boolean {
    let ipTracker = this.ipTrackers.get(ip);
    if (!ipTracker) {
      ipTracker = {
        ip,
        wallets: new Set(),
        connectionCount: 0,
        firstSeen: new Date(),
        flagged: false,
      };
      this.ipTrackers.set(ip, ipTracker);
    }

    if (ipTracker.connectionCount >= this.maxConnectionsPerIp) {
      this.logSuspicious({
        timestamp: Date.now(),
        type: 'CONNECTION_LIMIT',
        walletAddress,
        ip,
        details:
          `Connection rejected: ${ipTracker.connectionCount} connections from IP ` +
          `(limit: ${this.maxConnectionsPerIp})`,
        severity: 'MEDIUM',
      });
      return false;
    }

    ipTracker.wallets.add(walletAddress);
    ipTracker.connectionCount++;
    // Sybil tracking + the wallet→IP lookup are reserved for authenticated
    // wallets. Pre-auth connections all share the ANONYMOUS_WALLET sentinel,
    // so tracking them would dump unrelated visitors' IPs into one bucket and
    // falsely trip the CRITICAL sybil flag. The per-IP connection cap above is
    // the real pre-auth defense; authenticated wallets get registered for
    // sybil tracking separately via registerAuthenticatedConnection().
    if (walletAddress !== ANONYMOUS_WALLET) {
      this.activeConnections.set(walletAddress, ip);
      this.updateWalletTracker(walletAddress, ip);
    }
    return true;
  }

  /**
   * Register an authenticated wallet's IP once auth completes. Wires the
   * wallet into sybil tracking and the wallet→IP lookup used by
   * `recordFailedAction` logging. Call once per successful auth; the
   * underlying connection was already counted by `checkConnection`, so this
   * does not touch the per-IP connection counter.
   */
  registerAuthenticatedConnection(walletAddress: string, ip: string): void {
    if (walletAddress === ANONYMOUS_WALLET) return;
    this.activeConnections.set(walletAddress, ip);
    this.updateWalletTracker(walletAddress, ip);
  }

  /** Record a clean disconnect; balances counters maintained by `checkConnection`. */
  recordDisconnect(walletAddress: string, ip: string): void {
    const ipTracker = this.ipTrackers.get(ip);
    if (ipTracker && ipTracker.connectionCount > 0) {
      ipTracker.connectionCount--;
    }
    const walletTracker = this.walletTrackers.get(walletAddress);
    if (walletTracker && walletTracker.activeConnections > 0) {
      walletTracker.activeConnections--;
    }
    this.activeConnections.delete(walletAddress);
  }

  // --------- Action rate limiting ---------

  /**
   * Check whether a wallet may perform a rate-limited action right
   * now. Returns `{ allowed: false, reason, retryAfterMs }` when
   * blocked by either the sliding-window counter or an active
   * exponential-backoff window. On allow, the counter is bumped.
   */
  checkAction(walletAddress: string, ip: string): ActionCheckResult {
    const now = Date.now();
    let rateLimit = this.rateLimits.get(walletAddress);
    if (!rateLimit) {
      rateLimit = { count: 0, windowStart: now, failedCount: 0 };
      this.rateLimits.set(walletAddress, rateLimit);
    }

    // Backoff check (first; takes precedence over window).
    if (rateLimit.backoffUntil && now < rateLimit.backoffUntil) {
      const retryAfterMs = rateLimit.backoffUntil - now;
      this.logSuspicious({
        timestamp: now,
        type: 'BACKOFF_ACTIVE',
        walletAddress,
        ip,
        details: `Action blocked: in backoff for ${Math.ceil(retryAfterMs / 1000)}s more`,
        severity: 'LOW',
      });
      return {
        allowed: false,
        reason: 'In backoff period due to failed actions',
        retryAfterMs,
      };
    }

    // Sliding window: reset when expired.
    if (now - rateLimit.windowStart >= this.windowMs) {
      rateLimit.count = 0;
      rateLimit.windowStart = now;
    }

    if (rateLimit.count >= this.maxActionsPerWindow) {
      const retryAfterMs = this.windowMs - (now - rateLimit.windowStart);
      this.logSuspicious({
        timestamp: now,
        type: 'RATE_LIMIT',
        walletAddress,
        ip,
        details:
          `Rate limit exceeded: ${rateLimit.count} actions in window ` +
          `(limit: ${this.maxActionsPerWindow})`,
        severity: 'MEDIUM',
      });
      return { allowed: false, reason: 'Rate limit exceeded', retryAfterMs };
    }

    rateLimit.count++;

    // Allowed but flagged: log without blocking.
    const walletTracker = this.walletTrackers.get(walletAddress);
    if (walletTracker?.flagged) {
      this.logSuspicious({
        timestamp: now,
        type: 'SYBIL_FLAG',
        walletAddress,
        ip,
        details: `Flagged wallet acted: ${walletTracker.flagReason ?? 'no reason recorded'}`,
        severity: 'HIGH',
      });
    }

    return { allowed: true };
  }

  /**
   * Record a failed action. Increments the failure counter, sets a
   * fresh backoff window via `min(initialBackoff × multiplier^(n-1), maxBackoff)`,
   * and emits a suspicious-activity entry. The next `checkAction` call
   * will respect the new backoff.
   */
  recordFailedAction(walletAddress: string, action?: string): void {
    const now = Date.now();
    let rateLimit = this.rateLimits.get(walletAddress);
    if (!rateLimit) {
      rateLimit = { count: 0, windowStart: now, failedCount: 0 };
      this.rateLimits.set(walletAddress, rateLimit);
    }
    rateLimit.failedCount++;
    const backoffMs = Math.min(
      this.initialBackoffMs * Math.pow(this.backoffMultiplier, rateLimit.failedCount - 1),
      this.maxBackoffMs,
    );
    rateLimit.backoffUntil = now + backoffMs;

    const ip = this.activeConnections.get(walletAddress) ?? 'unknown';
    const actionLabel = action ? ` on '${action}'` : '';
    this.logSuspicious({
      timestamp: now,
      type: 'FAILED_ACTION',
      walletAddress,
      ip,
      details: `Failed action${actionLabel} #${rateLimit.failedCount}, backoff: ${backoffMs}ms`,
      severity: rateLimit.failedCount >= 5 ? 'HIGH' : 'MEDIUM',
    });
  }

  /** Record a successful action; clears backoff state on this wallet. */
  recordSuccessfulAction(walletAddress: string): void {
    const rateLimit = this.rateLimits.get(walletAddress);
    if (!rateLimit) return;
    rateLimit.failedCount = 0;
    rateLimit.backoffUntil = undefined;
  }

  // --------- Sybil detection ---------

  /**
   * Update the wallet's IP history with the given IP. Marks the
   * wallet as flagged when the count of distinct IPs observed within
   * the last hour reaches `maxIpsPerWallet`. Idempotent for repeat
   * IPs (re-observing an existing IP only refreshes activity, not the
   * first-seen timestamp).
   */
  private updateWalletTracker(walletAddress: string, ip: string): void {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    let tracker = this.walletTrackers.get(walletAddress);
    if (!tracker) {
      tracker = {
        walletAddress,
        ips: new Map(),
        activeConnections: 0,
        flagged: false,
      };
      this.walletTrackers.set(walletAddress, tracker);
    }
    tracker.activeConnections++;

    if (!tracker.ips.has(ip)) {
      tracker.ips.set(ip, now);
    }

    let recentIpCount = 0;
    const recentIps: string[] = [];
    tracker.ips.forEach((firstSeen, trackedIp) => {
      if (firstSeen >= oneHourAgo) {
        recentIpCount++;
        recentIps.push(trackedIp);
      }
    });

    if (recentIpCount >= this.maxIpsPerWallet && !tracker.flagged) {
      tracker.flagged = true;
      tracker.flagReason = `${recentIpCount} unique IPs in 1 hour: ${recentIps.join(', ')}`;
      this.logSuspicious({
        timestamp: now,
        type: 'SYBIL_FLAG',
        walletAddress,
        ip,
        details: tracker.flagReason,
        severity: 'CRITICAL',
      });
    }
  }

  isWalletFlagged(walletAddress: string): boolean {
    return this.walletTrackers.get(walletAddress)?.flagged ?? false;
  }

  /** Snapshot a wallet's sybil-tracking state. Includes the last-hour IP set. */
  getWalletSybilStatus(walletAddress: string): WalletSybilStatus {
    const tracker = this.walletTrackers.get(walletAddress);
    if (!tracker) return { flagged: false, uniqueIps: 0, ips: [] };

    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentIps: string[] = [];
    tracker.ips.forEach((firstSeen, ip) => {
      if (firstSeen >= oneHourAgo) recentIps.push(ip);
    });
    return {
      flagged: tracker.flagged,
      reason: tracker.flagReason,
      uniqueIps: recentIps.length,
      ips: recentIps,
    };
  }

  /** Manually unflag a wallet. Returns `true` when a flag was actually cleared. */
  unflagWallet(walletAddress: string): boolean {
    const tracker = this.walletTrackers.get(walletAddress);
    if (!tracker || !tracker.flagged) return false;
    tracker.flagged = false;
    tracker.flagReason = undefined;
    this.log.info(`[AntiCheat] Manually unflagged wallet: ${walletAddress}`);
    return true;
  }

  /** Reset backoff and failed-count for a wallet (admin-use). */
  resetBackoff(walletAddress: string): boolean {
    const rateLimit = this.rateLimits.get(walletAddress);
    if (!rateLimit) return false;
    rateLimit.failedCount = 0;
    rateLimit.backoffUntil = undefined;
    this.log.info(`[AntiCheat] Reset backoff for wallet: ${walletAddress}`);
    return true;
  }

  // --------- Logging + inspection ---------

  /**
   * Append a suspicious-activity log row. Trims to `maxLogEntries`
   * (FIFO drop) and mirrors a structured line through `log.info`
   * for live visibility.
   */
  private logSuspicious(entry: SuspiciousActivityLog): void {
    this.suspiciousLogs.push(entry);
    if (this.suspiciousLogs.length > this.maxLogEntries) this.suspiciousLogs.shift();
    this.log.info(
      `[AntiCheat] [${entry.severity}] ${entry.type}: ` +
        `${entry.walletAddress.slice(0, 8)}... from ${entry.ip} - ${entry.details}`,
    );
  }

  /**
   * Recent suspicious-activity rows, optionally filtered by minimum
   * severity. Preserves BG ordering: oldest first. Returns at most
   * `limit` rows.
   */
  getRecentSuspiciousActivity(limit = 100, minSeverity: Severity = 'LOW'): SuspiciousActivityLog[] {
    const order: Record<Severity, number> = {
      LOW: 0,
      MEDIUM: 1,
      HIGH: 2,
      CRITICAL: 3,
    };
    const minLevel = order[minSeverity];
    return this.suspiciousLogs.filter((l) => order[l.severity] >= minLevel).slice(-limit);
  }

  getStats(): AntiCheatStats {
    const now = Date.now();
    const todayStart = now - (now % (24 * 60 * 60 * 1000));

    let flaggedCount = 0;
    this.walletTrackers.forEach((tracker) => {
      if (tracker.flagged) flaggedCount++;
    });

    const todaysLogs = this.suspiciousLogs.filter((l) => l.timestamp >= todayStart);
    const eventsByType: Record<SuspiciousActivityType, number> = {
      RATE_LIMIT: 0,
      SYBIL_FLAG: 0,
      CONNECTION_LIMIT: 0,
      BACKOFF_ACTIVE: 0,
      FAILED_ACTION: 0,
      RAPID_IP_CHANGE: 0,
    };
    for (const log of todaysLogs) eventsByType[log.type]++;

    return {
      activeConnections: this.activeConnections.size,
      trackedWallets: this.walletTrackers.size,
      trackedIps: this.ipTrackers.size,
      flaggedWallets: flaggedCount,
      suspiciousEventsToday: todaysLogs.length,
      suspiciousEventsByType: eventsByType,
    };
  }

  // --------- Maintenance ---------

  /**
   * Drop stale wallet IPs (older than 1h), unused rate-limit entries
   * (older than 24h), and idle IP trackers (no connections, first-seen
   * older than 24h). Sybil flags are NOT auto-cleared — manual review
   * via `unflagWallet`.
   */
  cleanupExpiredEntries(): void {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    this.walletTrackers.forEach((tracker) => {
      const stale: string[] = [];
      tracker.ips.forEach((firstSeen, ip) => {
        if (firstSeen < oneHourAgo) stale.push(ip);
      });
      stale.forEach((ip) => tracker.ips.delete(ip));
    });

    const staleRateLimits: string[] = [];
    this.rateLimits.forEach((rateLimit, wallet) => {
      if (rateLimit.windowStart < oneDayAgo) staleRateLimits.push(wallet);
    });
    staleRateLimits.forEach((w) => this.rateLimits.delete(w));

    const staleIps: string[] = [];
    this.ipTrackers.forEach((tracker, ip) => {
      if (tracker.connectionCount === 0 && tracker.firstSeen.getTime() < oneDayAgo) {
        staleIps.push(ip);
      }
    });
    staleIps.forEach((ip) => this.ipTrackers.delete(ip));
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
