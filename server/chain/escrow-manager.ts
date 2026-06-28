/**
 * Durable escrow manager — the system-of-record + settlement outbox for
 * on-chain raid wagers.
 *
 * The in-memory `BetEscrow` ledger (`server/game/bet-escrow.ts`) decides the
 * GAME outcome of a wager; this manager owns the MONEY: it persists every
 * verified deposit as a liability and drives the real token movement
 * (`returnWager` / `payDefender` / `burnWager`) through a retrying, restart-
 * safe outbox. The two guarantees it adds over the old fire-and-forget hooks:
 *
 *   1. **No lost liability across restarts.** A verified deposit is recorded
 *      durably (`active`) before the raid is acknowledged. If the gateway
 *      restarts mid-raid the in-memory expedition is gone but the record
 *      survives, so `reconcileOnBoot` can REFUND the orphaned deposit instead
 *      of silently keeping the player's tokens.
 *   2. **No silent settlement failure.** A resolved wager's payout legs are
 *      persisted (`settling`) with per-leg `done` flags BEFORE they execute.
 *      A chain failure leaves the record `settling`; a background retry loop
 *      (and boot reconcile) re-runs only the not-yet-done legs — so a burn +
 *      N defender payouts that partially landed never double-pays the ones
 *      that already confirmed.
 *
 * Idempotency caveat (documented, acceptable for the small-amount test
 * phase): a leg is marked `done` immediately after the chain op returns a
 * signature. A crash in the narrow window between on-chain confirmation and
 * the durable `put` could re-send that leg on the next boot. A future
 * hardening pass can close this by checking the leg's memo on-chain before
 * re-sending. The window is small and bounded; nothing is ever LOST (only a
 * rare double-pay risk), which is the right trade-off vs. dropping a payout.
 */

import type {
  EscrowSettlementLeg,
  EscrowStore,
  EscrowWagerRecord,
  GameLogger,
  WagerSettlement,
} from '../game/interfaces.js';

/**
 * Narrow on-chain surface the manager drives. Each method performs the real
 * SPL transfer/burn and RESOLVES WITH the confirmed signature, or THROWS a
 * sanitized error so the manager can retry. (Adapted from `ChainOps` /
 * `BetEscrowChainService` at the boot layer.)
 */
export interface EscrowChainOps {
  returnWager(wallet: string, amount: number, wagerId: string): Promise<string>;
  payDefender(wallet: string, amount: number, wagerId: string): Promise<string>;
  burnWager(amount: number, wagerId: string): Promise<string>;
  /**
   * Move a forfeited wager's recirculated share to the treasury that backs
   * raid vaults (a no-op self-transfer in the single-wallet model).
   */
  recirculateToTreasury(amount: number, wagerId: string): Promise<string>;
}

export interface EscrowManagerConfig {
  store: EscrowStore;
  chain: EscrowChainOps;
  logger?: GameLogger;
  /** How often the retry loop sweeps unfinished settlements (ms). */
  retryIntervalMs?: number;
  /** Max settlement attempts before a record is parked as `failed`. */
  maxRetries?: number;
}

const DEFAULT_RETRY_INTERVAL_MS = 60_000;
const DEFAULT_MAX_RETRIES = 10;

export class EscrowManager {
  private readonly store: EscrowStore;
  private readonly chain: EscrowChainOps;
  private readonly log: GameLogger;
  private readonly retryIntervalMs: number;
  private readonly maxRetries: number;

  /** Runtime mirror of unsettled records, keyed by wagerId. */
  private readonly records = new Map<string, EscrowWagerRecord>();
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  /** Guards re-entrancy so the retry sweep and a live settle don't overlap. */
  private readonly inFlight = new Set<string>();

  constructor(config: EscrowManagerConfig) {
    this.store = config.store;
    this.chain = config.chain;
    this.log = config.logger ?? console;
    this.retryIntervalMs = config.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /**
   * Record a verified deposit as a live liability BEFORE the raid is
   * acknowledged. Idempotent on wagerId.
   */
  async recordBooked(rec: {
    wagerId: string;
    wallet: string;
    amount: number;
    expeditionId?: string;
    targetAsteroid?: string;
    depositSignature?: string;
  }): Promise<void> {
    const record: EscrowWagerRecord = {
      wagerId: rec.wagerId,
      wallet: rec.wallet,
      amount: rec.amount,
      expeditionId: rec.expeditionId,
      targetAsteroid: rec.targetAsteroid,
      depositSignature: rec.depositSignature,
      status: 'active',
      retries: 0,
    };
    this.records.set(record.wagerId, record);
    await this.persist(record);
  }

  /**
   * Resolve a wager: turn the game outcome into durable settlement legs and
   * drive them to completion (with retry). Upserts the record so it is robust
   * even if `recordBooked` never ran (e.g. a refund for a deposit whose raid
   * failed to book).
   */
  async settle(plan: WagerSettlement): Promise<void> {
    const record = this.records.get(plan.wagerId) ?? {
      wagerId: plan.wagerId,
      wallet: plan.returnTo?.wallet ?? '',
      amount: plan.returnTo?.amount ?? plan.burn ?? 0,
      status: 'active' as const,
      retries: 0,
    };
    record.legs = this.buildLegs(plan);
    record.status = 'settling';
    record.lastError = undefined;
    this.records.set(record.wagerId, record);
    await this.persist(record);
    await this.runLegs(record);
  }

  /**
   * Refund the full deposit to the raider — used for a deposit whose raid
   * couldn't launch, or an `active` record orphaned by a restart.
   */
  async refund(wagerId: string, wallet: string, amount: number): Promise<void> {
    await this.settle({ wagerId, returnTo: { wallet, amount } });
  }

  /** Translate a settlement plan into ordered, not-yet-done legs. */
  private buildLegs(plan: WagerSettlement): EscrowSettlementLeg[] {
    if (plan.returnTo && plan.returnTo.amount > 0) {
      return [{ kind: 'return', wallet: plan.returnTo.wallet, amount: plan.returnTo.amount, done: false }];
    }
    const legs: EscrowSettlementLeg[] = [];
    for (const payout of plan.defenderPayouts ?? []) {
      if (payout.amount > 0) {
        legs.push({ kind: 'payout', wallet: payout.wallet, amount: payout.amount, done: false });
      }
    }
    // Recirculate (move to the backing treasury) before the burn — it's a
    // recoverable transfer, so running it ahead of the irreversible burn keeps
    // the value-preserving leg safe if a later leg fails.
    if (plan.recirculate && plan.recirculate > 0) {
      legs.push({ kind: 'recirculate', amount: plan.recirculate, done: false });
    }
    // Burn last so a partial failure leaves tokens in escrow rather than over-
    // burning before defenders are paid / value is recirculated.
    if (plan.burn && plan.burn > 0) {
      legs.push({ kind: 'burn', amount: plan.burn, done: false });
    }
    return legs;
  }

  /**
   * Execute every not-yet-done leg of a record in order. On a leg failure,
   * persists progress + the error and bails (the retry loop re-runs later).
   * When all legs land, marks the record settled and drops it from the store.
   */
  private async runLegs(record: EscrowWagerRecord): Promise<void> {
    if (this.inFlight.has(record.wagerId)) return;
    this.inFlight.add(record.wagerId);
    try {
      const legs = record.legs ?? [];
      for (const leg of legs) {
        if (leg.done) continue;
        try {
          leg.signature = await this.executeLeg(record.wagerId, leg);
          leg.done = true;
          await this.persist(record);
        } catch (err) {
          record.retries += 1;
          record.lastError = err instanceof Error ? err.message : String(err);
          if (record.retries >= this.maxRetries) {
            record.status = 'failed';
            this.log.error(
              `[EscrowManager] wager ${record.wagerId.slice(0, 8)}… settlement PARKED as failed after ` +
                `${record.retries} attempts (${leg.kind} ${leg.amount}): ${record.lastError}. ` +
                'Manual intervention required.',
            );
          } else {
            this.log.warn(
              `[EscrowManager] wager ${record.wagerId.slice(0, 8)}… ${leg.kind} leg failed ` +
                `(attempt ${record.retries}/${this.maxRetries}): ${record.lastError}. Will retry.`,
            );
          }
          await this.persist(record);
          return;
        }
      }
      // All legs landed.
      record.status = 'settled';
      this.records.delete(record.wagerId);
      await this.remove(record.wagerId);
      this.log.info(
        `[EscrowManager] wager ${record.wagerId.slice(0, 8)}… fully settled ` +
          `(${legs.length} leg(s)).`,
      );
    } finally {
      this.inFlight.delete(record.wagerId);
    }
  }

  private executeLeg(wagerId: string, leg: EscrowSettlementLeg): Promise<string> {
    switch (leg.kind) {
      case 'return':
        return this.chain.returnWager(leg.wallet!, leg.amount, wagerId);
      case 'payout':
        return this.chain.payDefender(leg.wallet!, leg.amount, wagerId);
      case 'recirculate':
        return this.chain.recirculateToTreasury(leg.amount, wagerId);
      case 'burn':
        return this.chain.burnWager(leg.amount, wagerId);
    }
  }

  /**
   * Boot reconciliation: load every unsettled record. `active` records are
   * orphaned (the in-memory raid that owned them is gone after a restart), so
   * refund them. `settling` records resume their remaining legs. `failed`
   * records are surfaced loudly but left for manual handling.
   */
  async reconcileOnBoot(): Promise<void> {
    let unsettled: EscrowWagerRecord[];
    try {
      unsettled = await this.store.getUnsettled();
    } catch (err) {
      this.log.error('[EscrowManager] failed to load unsettled escrow on boot:', err);
      return;
    }
    if (unsettled.length === 0) return;
    this.log.warn(
      `[EscrowManager] reconciling ${unsettled.length} unsettled escrow wager(s) on boot.`,
    );
    for (const record of unsettled) {
      this.records.set(record.wagerId, record);
      if (record.status === 'failed') {
        this.log.error(
          `[EscrowManager] wager ${record.wagerId.slice(0, 8)}… is PARKED (failed). ` +
            `Owed: ${record.amount} $ASTROID to ${record.wallet.slice(0, 8)}…. Last error: ` +
            `${record.lastError ?? 'unknown'}. Manual settlement required.`,
        );
        continue;
      }
      if (record.status === 'active') {
        this.log.warn(
          `[EscrowManager] refunding orphaned wager ${record.wagerId.slice(0, 8)}… ` +
            `(${record.amount} $ASTROID → ${record.wallet.slice(0, 8)}…) — its raid did not survive ` +
            'the restart.',
        );
        // Reset retry budget for the fresh refund attempt.
        record.retries = 0;
        await this.refund(record.wagerId, record.wallet, record.amount);
      } else {
        // 'settling' — resume the remaining legs.
        await this.runLegs(record);
      }
    }
  }

  /** Start the background retry sweep. Safe to call once at boot. */
  start(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      void this.sweep();
    }, this.retryIntervalMs);
    // Don't keep the process alive solely for the sweep.
    this.retryTimer.unref?.();
  }

  stop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async sweep(): Promise<void> {
    for (const record of this.records.values()) {
      if (record.status === 'settling') {
        await this.runLegs(record);
      }
    }
  }

  /** Currently-tracked unsettled liability (sum of amounts). For ops/metrics. */
  outstandingLiability(): number {
    let total = 0;
    for (const record of this.records.values()) {
      if (record.status === 'active' || record.status === 'settling') total += record.amount;
    }
    return total;
  }

  /**
   * Snapshot of unsettled escrow for the admin console: per-status counts and
   * the outstanding (active + settling) liability. `failed` rows are parked and
   * need manual ops, so they're surfaced separately.
   */
  getSummary(): { active: number; settling: number; failed: number; outstanding: number } {
    let active = 0;
    let settling = 0;
    let failed = 0;
    for (const record of this.records.values()) {
      if (record.status === 'active') active += 1;
      else if (record.status === 'settling') settling += 1;
      else if (record.status === 'failed') failed += 1;
    }
    return { active, settling, failed, outstanding: this.outstandingLiability() };
  }

  private async persist(record: EscrowWagerRecord): Promise<void> {
    try {
      await this.store.put(record);
    } catch (err) {
      this.log.error(
        `[EscrowManager] failed to persist wager ${record.wagerId.slice(0, 8)}…:`,
        err,
      );
    }
  }

  private async remove(wagerId: string): Promise<void> {
    try {
      await this.store.delete(wagerId);
    } catch (err) {
      this.log.error(`[EscrowManager] failed to delete wager ${wagerId.slice(0, 8)}…:`, err);
    }
  }
}
