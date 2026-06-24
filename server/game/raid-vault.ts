/**
 * Raid vault manager for astroid.club.
 *
 * The per-asteroid **raid vault** is the persistent, raidable "treasury"
 * shown to attackers. Unlike the {@link RefineryManager} pool — which is paid
 * out to active miners on a cadence and therefore drains to ~0 (the "treasury
 * resets without anyone stealing it" report) — the vault is *never*
 * auto-distributed. It only:
 *
 *   - **grows** by a small cut of each discovery (see `YieldOrchestrator`), and
 *   - **shrinks** when a successful raid steals from it (or, later, can be
 *     topped up by meteor-deflection payments).
 *
 * This separation means the displayed treasury is stable and meaningful: it
 * reflects real accumulated value a raider can carry off, not an hourly payout
 * pool mid-cycle.
 *
 * Reserve safety is unaffected: total emission is governed by the
 * `EmissionGovernor`, independent of how the per-discovery split is routed.
 */

import type { GameLogger, RaidVaultStore } from './interfaces.js';

export interface RaidVaultManagerConfig {
  /** Token symbol for log lines. Defaults to "$ASTROID". */
  tokenSymbol?: string;
  /**
   * Optional durable persistence for vault balances (Redis/Postgres). When
   * set, every balance change is mirrored (fire-and-forget) and `restore()`
   * reloads balances on boot so treasuries survive a restart/redeploy. When
   * unset, vaults are in-memory only and reset to 0 on restart.
   */
  store?: RaidVaultStore;
  logger?: GameLogger;
}

export class RaidVaultManager {
  private readonly balances: Map<string, number> = new Map();
  private readonly tokenSymbol: string;
  private readonly store: RaidVaultStore | undefined;
  private readonly log: GameLogger;

  constructor(config: RaidVaultManagerConfig = {}) {
    this.tokenSymbol = config.tokenSymbol ?? '$ASTROID';
    this.store = config.store;
    this.log = config.logger ?? defaultLogger();
  }

  /** Add to an asteroid's vault. Ignores non-positive amounts. Returns new balance. */
  add(asteroidId: string, amount: number): number {
    if (amount <= 0) return this.balances.get(asteroidId) ?? 0;
    const next = (this.balances.get(asteroidId) ?? 0) + amount;
    this.balances.set(asteroidId, next);
    this.persist(asteroidId, next);
    this.log.info(
      `[RaidVault] +${amount} ${this.tokenSymbol} to ${asteroidId}. Balance: ${next}`,
    );
    return next;
  }

  /**
   * Remove up to `amount` from an asteroid's vault (a successful raid steal).
   * Clamped at 0. Returns the amount actually debited.
   */
  debit(asteroidId: string, amount: number): number {
    const balance = this.balances.get(asteroidId) ?? 0;
    if (balance <= 0 || amount <= 0) return 0;
    const taken = Math.min(amount, balance);
    const next = balance - taken;
    this.balances.set(asteroidId, next);
    this.persist(asteroidId, next);
    this.log.info(
      `[RaidVault] -${taken} ${this.tokenSymbol} from ${asteroidId} (raid). ` +
        `Balance: ${next}`,
    );
    return taken;
  }

  /** Current vault balance for an asteroid (0 if none). */
  getBalance(asteroidId: string): number {
    return this.balances.get(asteroidId) ?? 0;
  }

  /** Snapshot of every asteroid's vault balance. */
  getAllBalances(): Map<string, number> {
    return new Map(this.balances);
  }

  /** Sum of every asteroid's vault balance. */
  getTotal(): number {
    let total = 0;
    for (const v of this.balances.values()) total += v;
    return total;
  }

  /**
   * Reload persisted vault balances into memory. Call once on boot, before
   * serving traffic, so accumulated treasuries survive a restart. No-op when
   * no `store` is wired. Returns the number of asteroids restored.
   */
  async restore(): Promise<number> {
    if (!this.store) return 0;
    try {
      const persisted = await Promise.resolve(this.store.getAll());
      let count = 0;
      for (const [asteroidId, balance] of persisted) {
        if (Number.isFinite(balance) && balance > 0) {
          this.balances.set(asteroidId, balance);
          count++;
        }
      }
      return count;
    } catch (err) {
      this.log.error('[RaidVault] failed to restore balances:', err);
      return 0;
    }
  }

  /** Fire-and-forget write-through to the durable store (if any). */
  private persist(asteroidId: string, balance: number): void {
    if (!this.store) return;
    Promise.resolve(this.store.set(asteroidId, balance)).catch((err) => {
      this.log.error('[RaidVault] failed to persist balance:', err);
    });
  }
}

function defaultLogger(): GameLogger {
  return {
    info: (msg, ...rest) => console.info(msg, ...rest),
    warn: (msg, ...rest) => console.warn(msg, ...rest),
    error: (msg, ...rest) => console.error(msg, ...rest),
  };
}
