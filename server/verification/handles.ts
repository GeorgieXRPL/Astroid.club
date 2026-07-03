/**
 * Chat handles (player-chosen display names).
 *
 * Identity in astroid.club is wallet-first; a handle is an optional, cosmetic
 * alias shown next to a wallet's chat lines. This service owns the runtime
 * source of truth — two in-memory maps (wallet→handle and lower(handle)→wallet)
 * — so uniqueness is enforced synchronously before any write. An optional
 * {@link HandleStore} (Postgres/Redis) mirrors writes so handles survive
 * restarts (reloaded via {@link load} on boot). Without a store handles are
 * in-memory only.
 *
 * Handles never grant privileges and are not trusted for auth — the author of a
 * chat line is always the connection's authenticated wallet, never a handle.
 */

import type { GameLogger, HandleStore } from '../game/interfaces.js';

/** Min/max handle length (post-trim), in characters. */
export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 20;

/** Letters, digits, and underscore only — no spaces or punctuation. */
const HANDLE_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * Names that would impersonate the UI or an operator. Compared case-insensitively.
 * `you` is how a client labels its own lines, so it must not be claimable.
 */
const RESERVED = new Set(['you', 'system', 'admin', 'server', 'astroid', 'mod', 'moderator']);

/** Thrown when a requested handle is invalid or already taken. */
export class HandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandleError';
  }
}

/**
 * Validate + normalize a candidate handle. Trims surrounding whitespace and
 * returns the display form to store. Throws {@link HandleError} with a
 * user-facing message on any rule violation.
 */
export function normalizeHandle(raw: unknown): string {
  if (typeof raw !== 'string') throw new HandleError('Handle must be text.');
  const handle = raw.trim();
  if (handle.length < HANDLE_MIN_LENGTH) {
    throw new HandleError(`Handle must be at least ${HANDLE_MIN_LENGTH} characters.`);
  }
  if (handle.length > HANDLE_MAX_LENGTH) {
    throw new HandleError(`Handle must be at most ${HANDLE_MAX_LENGTH} characters.`);
  }
  if (!HANDLE_PATTERN.test(handle)) {
    throw new HandleError('Handle can only use letters, numbers, and underscores.');
  }
  if (RESERVED.has(handle.toLowerCase())) {
    throw new HandleError('That handle is reserved.');
  }
  return handle;
}

export interface HandleServiceConfig {
  /** Durable backing store (Postgres/Redis). Omit for in-memory only. */
  store?: HandleStore;
  logger?: GameLogger;
}

export class HandleService {
  private readonly byWallet = new Map<string, string>();
  private readonly byHandleLower = new Map<string, string>();
  private readonly store?: HandleStore;
  private readonly log: GameLogger;

  constructor(config: HandleServiceConfig = {}) {
    this.store = config.store;
    this.log = config.logger ?? console;
  }

  /** Populate the in-memory maps from the store. Call once on boot. */
  async load(): Promise<void> {
    if (!this.store) return;
    try {
      const all = await this.store.getAll();
      for (const [wallet, handle] of all) {
        const lower = handle.toLowerCase();
        // Skip a row that would collide with one already loaded (shouldn't
        // happen given the unique index, but stay defensive on boot).
        if (this.byHandleLower.has(lower)) continue;
        this.byWallet.set(wallet, handle);
        this.byHandleLower.set(lower, wallet);
      }
      if (this.byWallet.size > 0) {
        this.log.info(`[Handles] loaded ${this.byWallet.size} chat handle(s).`);
      }
    } catch (err) {
      this.log.error('[Handles] failed to load from store:', err);
    }
  }

  /** The wallet's current handle, or null if it hasn't set one. */
  get(walletAddress: string): string | null {
    return this.byWallet.get(walletAddress) ?? null;
  }

  /**
   * Claim (or change) `walletAddress`'s handle. Validates + enforces
   * case-insensitive uniqueness in memory, then persists. Returns the stored
   * display form. Throws {@link HandleError} on an invalid or taken name (the
   * gateway surfaces the message to the player); re-throws store failures.
   */
  async set(walletAddress: string, rawHandle: string): Promise<string> {
    const handle = normalizeHandle(rawHandle);
    const lower = handle.toLowerCase();

    const owner = this.byHandleLower.get(lower);
    if (owner && owner !== walletAddress) {
      throw new HandleError('That handle is already taken.');
    }
    // Re-claiming the same handle (any casing) is a no-op success.
    if (owner === walletAddress && this.byWallet.get(walletAddress) === handle) {
      return handle;
    }

    // Persist first so a store failure doesn't leave memory ahead of the DB.
    if (this.store) await this.store.set(walletAddress, handle);

    const previous = this.byWallet.get(walletAddress);
    if (previous) this.byHandleLower.delete(previous.toLowerCase());
    this.byWallet.set(walletAddress, handle);
    this.byHandleLower.set(lower, walletAddress);
    return handle;
  }

  get size(): number {
    return this.byWallet.size;
  }
}
