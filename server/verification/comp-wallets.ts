/**
 * Comp / holder-gate-bypass list.
 *
 * The game is open to everyone, gated only by the holder requirement
 * (`HOLDER_MIN_*`). This service maintains an operator-managed allowlist of
 * wallets that are *comped past that gate* — team, partners, comped testers
 * who shouldn't have to hold $ASTROID to play. It does NOT restrict anyone:
 * non-comped wallets still get in normally via the holder gate. (That's the
 * opposite of the closed-beta `WALLET_ALLOWLIST`, which restricts auth to a
 * fixed set.)
 *
 * The in-memory `Set` is the runtime source of truth (a synchronous `has()` is
 * read on every holder check). An optional `CompWalletStore` (Postgres/Redis)
 * makes the list durable and live-editable from the admin console: mutations
 * update the set immediately AND persist, so no redeploy is needed and the
 * list survives restarts (reloaded via `load()` on boot).
 */

import type { CompWalletStore, GameLogger } from '../game/interfaces.js';

/** Base58 (no 0/O/I/l) account string, 32–44 chars — a Solana pubkey. */
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True if `wallet` looks like a valid base58 Solana address. */
export function isValidWalletAddress(wallet: unknown): wallet is string {
  return typeof wallet === 'string' && BASE58_PUBKEY.test(wallet);
}

export interface CompWalletServiceConfig {
  /** Durable backing store (Postgres/Redis). Omit for in-memory only. */
  store?: CompWalletStore;
  logger?: GameLogger;
}

export class CompWalletService {
  private readonly set = new Set<string>();
  private readonly store?: CompWalletStore;
  private readonly log: GameLogger;

  constructor(config: CompWalletServiceConfig = {}) {
    this.store = config.store;
    this.log = config.logger ?? console;
  }

  /**
   * Populate the in-memory set: first the env-seeded wallets (always present),
   * then any persisted in the store (unioned). Call once on boot.
   */
  async load(seed: readonly string[] = []): Promise<void> {
    for (const w of seed) {
      if (isValidWalletAddress(w)) this.set.add(w);
    }
    if (this.store) {
      try {
        for (const w of await this.store.list()) this.set.add(w);
      } catch (err) {
        this.log.error('[CompWallets] failed to load from store:', err);
      }
    }
    if (this.set.size > 0) {
      this.log.info(`[CompWallets] ${this.set.size} wallet(s) comped past the holder gate.`);
    }
  }

  /** Synchronous membership check — read on every holder verification. */
  has(walletAddress: string): boolean {
    return this.set.has(walletAddress);
  }

  /** Sorted snapshot of the current comp list. */
  list(): string[] {
    return [...this.set].sort();
  }

  get size(): number {
    return this.set.size;
  }

  /**
   * Add a wallet to the comp list (in-memory immediately, then persisted).
   * Idempotent. Throws on an invalid address or a store-write failure (the
   * caller — the admin endpoint — surfaces the error to the operator).
   */
  async add(walletAddress: string, note?: string): Promise<void> {
    if (!isValidWalletAddress(walletAddress)) {
      throw new Error(`invalid wallet address: ${String(walletAddress)}`);
    }
    this.set.add(walletAddress);
    if (this.store) await this.store.add(walletAddress, note);
    this.log.info(`[CompWallets] comped ${walletAddress.slice(0, 8)}… past the holder gate.`);
  }

  /**
   * Remove a wallet from the comp list. Returns whether it was present.
   * Persists the removal (throws on a store-write failure).
   */
  async remove(walletAddress: string): Promise<boolean> {
    const had = this.set.delete(walletAddress);
    if (this.store) await this.store.remove(walletAddress);
    if (had) this.log.info(`[CompWallets] removed ${walletAddress.slice(0, 8)}… from the comp list.`);
    return had;
  }
}
