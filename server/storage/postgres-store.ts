/**
 * Postgres-backed durable persistence for astroid.club — the production
 * system of record. Works against any Postgres (Supabase, Neon, Fly
 * Postgres, Railway Postgres, local); nothing here is Supabase-specific.
 *
 * Unlike the Redis store (a current-balance cache), this is an
 * AUDITABLE ledger: pending yield lives as an append-only `yield_events`
 * log and the balance is the SUM of that log. Every credit, claim, and
 * redemption is permanently recorded — the property a real-money
 * sweepstakes needs for reconciliation, dispute resolution, and replay.
 *
 * It exposes two adapter views over one connection pool:
 *   - `homeStation` (`HomeStationStore`)  — `home_stations` table.
 *   - `ledger`      (`YieldLedger`)        — `yield_events` table.
 *
 * Apply `db/schema.sql` once before use. Reads stay off the hot path
 * (only the per-connect home-station lookup and the one boot-time balance
 * restore touch the DB); credit/claim writes are fire-and-forget and
 * failures are logged, never thrown — a DB blip must not drop a player
 * action. The pg `Pool` is injectable so tests run without a live DB.
 */

import { Pool, type PoolConfig } from 'pg';

import type {
  CompWalletStore,
  EscrowStore,
  EscrowWagerRecord,
  GameLogger,
  HomeStationStore,
  RaidVaultStore,
  YieldLedger,
} from '../game/interfaces.js';

/**
 * Narrow subset of the pg `Pool` this store uses. Lets tests inject a
 * fake without a live database.
 */
export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

export interface PostgresGameStoreConfig {
  /** Postgres connection string (e.g. the Supabase `DATABASE_URL`). */
  connectionString?: string;
  /** Pre-constructed client/pool (tests / custom wiring). Overrides the string. */
  client?: PgClientLike;
  /**
   * TLS toggle. Managed Postgres (Supabase/Neon) requires SSL; we default
   * to enabled with `rejectUnauthorized: false` (their certs chain to
   * roots Node doesn't bundle). Set `false` for a local non-TLS DB.
   */
  ssl?: boolean;
  /** Extra pg pool options merged in. */
  poolConfig?: PoolConfig;
  logger?: GameLogger;
}

export class PostgresGameStore {
  /** Adapter to wire as `StakeManager`'s `homeStationStore`. */
  readonly homeStation: HomeStationStore;
  /** Adapter to wire as `StakeManager`'s `yieldLedger`. */
  readonly ledger: YieldLedger;
  /** Adapter to wire as the `RaidVaultManager`'s `store`. */
  readonly raidVault: RaidVaultStore;
  /** Adapter to wire as the `EscrowManager`'s durable `store`. */
  readonly escrow: EscrowStore;
  /** Adapter to wire as the `CompWalletService`'s durable `store`. */
  readonly compWallets: CompWalletStore;

  private readonly client: PgClientLike;
  private readonly log: GameLogger;

  constructor(config: PostgresGameStoreConfig) {
    this.log = config.logger ?? console;

    if (config.client) {
      this.client = config.client;
    } else if (config.connectionString) {
      const ssl = config.ssl ?? true;
      const pool = new Pool({
        connectionString: config.connectionString,
        ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
        ...config.poolConfig,
      });
      pool.on('error', (err: Error) => {
        this.log.error('[PostgresGameStore] pool error:', err.message);
      });
      this.client = pool;
    } else {
      throw new Error('PostgresGameStore requires either a `connectionString` or a `client`.');
    }

    this.homeStation = {
      set: (wallet, asteroidId) => this.setHomeStation(wallet, asteroidId),
      get: (wallet) => this.getHomeStation(wallet),
    };
    this.ledger = {
      recordCredit: (wallet, asteroidId, amount) =>
        this.recordEvent(wallet, asteroidId, amount, 'credit'),
      recordClaim: (wallet, amount) => this.recordEvent(wallet, null, -Math.abs(amount), 'claim'),
      recordRedeem: (wallet, amount) => this.recordEvent(wallet, null, -Math.abs(amount), 'redeem'),
      getAllBalances: () => this.getAllBalances(),
      getLifetimeTotals: () => this.getLifetimeTotals(),
    };
    this.raidVault = {
      set: (asteroidId, balance) => this.setRaidVault(asteroidId, balance),
      getAll: () => this.getAllRaidVaults(),
    };
    this.escrow = {
      put: (record) => this.putEscrow(record),
      delete: (wagerId) => this.deleteEscrow(wagerId),
      getUnsettled: () => this.getUnsettledEscrow(),
    };
    this.compWallets = {
      list: () => this.listCompWallets(),
      add: (wallet, note) => this.addCompWallet(wallet, note),
      remove: (wallet) => this.removeCompWallet(wallet),
    };
  }

  // --------- Home station ---------

  private async setHomeStation(walletAddress: string, asteroidId: string): Promise<void> {
    try {
      await this.client.query(
        `INSERT INTO home_stations (wallet, asteroid_id) VALUES ($1, $2)
         ON CONFLICT (wallet) DO UPDATE SET asteroid_id = EXCLUDED.asteroid_id, updated_at = now()`,
        [walletAddress, asteroidId],
      );
    } catch (err) {
      this.log.error('[PostgresGameStore] failed to persist home station:', err);
    }
  }

  private async getHomeStation(walletAddress: string): Promise<string | null> {
    try {
      const { rows } = await this.client.query(
        'SELECT asteroid_id FROM home_stations WHERE wallet = $1',
        [walletAddress],
      );
      const row = rows[0];
      return row ? (row.asteroid_id as string) : null;
    } catch (err) {
      this.log.error('[PostgresGameStore] failed to read home station:', err);
      return null;
    }
  }

  // --------- Yield ledger ---------

  private async recordEvent(
    walletAddress: string,
    asteroidId: string | null,
    delta: number,
    kind: 'credit' | 'claim' | 'redeem' | 'adjust',
  ): Promise<void> {
    if (delta === 0) return;
    try {
      await this.client.query(
        `INSERT INTO yield_events (wallet, asteroid_id, delta, kind) VALUES ($1, $2, $3, $4)`,
        [walletAddress, asteroidId, delta, kind],
      );
    } catch (err) {
      this.log.error('[PostgresGameStore] failed to record yield event:', err);
    }
  }

  private async getAllBalances(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const { rows } = await this.client.query(
        `SELECT wallet, SUM(delta) AS amount FROM yield_events GROUP BY wallet HAVING SUM(delta) > 0`,
      );
      for (const row of rows) {
        const amount = Number(row.amount);
        if (Number.isFinite(amount) && amount > 0) out.set(row.wallet as string, amount);
      }
    } catch (err) {
      this.log.error('[PostgresGameStore] failed to read balances:', err);
    }
    return out;
  }

  /**
   * Lifetime gross totals per wallet, derived from the append-only event log:
   * `earned` = sum of positive `credit` deltas; `redeemed` = sum of the
   * magnitudes of `claim` + `redeem` deltas. Used to seed the in-memory
   * rewards accumulator on boot.
   */
  private async getLifetimeTotals(): Promise<Map<string, { earned: number; redeemed: number }>> {
    const out = new Map<string, { earned: number; redeemed: number }>();
    try {
      const { rows } = await this.client.query(
        `SELECT wallet,
                COALESCE(SUM(delta) FILTER (WHERE delta > 0), 0) AS earned,
                COALESCE(-SUM(delta) FILTER (WHERE delta < 0), 0) AS redeemed
         FROM yield_events GROUP BY wallet`,
      );
      for (const row of rows) {
        const earned = Number(row.earned) || 0;
        const redeemed = Number(row.redeemed) || 0;
        out.set(row.wallet as string, { earned, redeemed });
      }
    } catch (err) {
      this.log.error('[PostgresGameStore] failed to read lifetime totals:', err);
    }
    return out;
  }

  // --------- Raid vault ---------

  private async setRaidVault(asteroidId: string, balance: number): Promise<void> {
    try {
      await this.client.query(
        `INSERT INTO raid_vaults (asteroid_id, balance) VALUES ($1, $2)
         ON CONFLICT (asteroid_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = now()`,
        [asteroidId, balance],
      );
    } catch (err) {
      this.log.error('[PostgresGameStore] failed to persist raid vault:', err);
    }
  }

  private async getAllRaidVaults(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const { rows } = await this.client.query(
        'SELECT asteroid_id, balance FROM raid_vaults WHERE balance > 0',
      );
      for (const row of rows) {
        const balance = Number(row.balance);
        if (Number.isFinite(balance) && balance > 0) out.set(row.asteroid_id as string, balance);
      }
    } catch (err) {
      this.log.error('[PostgresGameStore] failed to read raid vaults:', err);
    }
    return out;
  }

  // --------- Escrow wagers (durable liability + settlement outbox) ---------

  private async putEscrow(record: EscrowWagerRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO escrow_wagers
         (wager_id, wallet, amount, expedition_id, target_asteroid, deposit_sig,
          status, legs, retries, last_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, now())
       ON CONFLICT (wager_id) DO UPDATE SET
         wallet = EXCLUDED.wallet,
         amount = EXCLUDED.amount,
         expedition_id = EXCLUDED.expedition_id,
         target_asteroid = EXCLUDED.target_asteroid,
         deposit_sig = EXCLUDED.deposit_sig,
         status = EXCLUDED.status,
         legs = EXCLUDED.legs,
         retries = EXCLUDED.retries,
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [
        record.wagerId,
        record.wallet,
        record.amount,
        record.expeditionId ?? null,
        record.targetAsteroid ?? null,
        record.depositSignature ?? null,
        record.status,
        record.legs ? JSON.stringify(record.legs) : null,
        record.retries,
        record.lastError ?? null,
      ],
    );
  }

  private async deleteEscrow(wagerId: string): Promise<void> {
    await this.client.query('DELETE FROM escrow_wagers WHERE wager_id = $1', [wagerId]);
  }

  private async getUnsettledEscrow(): Promise<EscrowWagerRecord[]> {
    const { rows } = await this.client.query(
      `SELECT wager_id, wallet, amount, expedition_id, target_asteroid, deposit_sig,
              status, legs, retries, last_error
       FROM escrow_wagers
       WHERE status IN ('active', 'settling', 'failed')`,
    );
    return rows.map((row) => {
      const rawLegs = row.legs;
      const legs =
        typeof rawLegs === 'string' ? JSON.parse(rawLegs) : (rawLegs ?? undefined);
      return {
        wagerId: row.wager_id as string,
        wallet: row.wallet as string,
        amount: Number(row.amount),
        expeditionId: (row.expedition_id as string | null) ?? undefined,
        targetAsteroid: (row.target_asteroid as string | null) ?? undefined,
        depositSignature: (row.deposit_sig as string | null) ?? undefined,
        status: row.status as EscrowWagerRecord['status'],
        legs: legs as EscrowWagerRecord['legs'],
        retries: Number(row.retries) || 0,
        lastError: (row.last_error as string | null) ?? undefined,
      };
    });
  }

  // --------- Comp / holder-gate-bypass wallets ---------

  private async listCompWallets(): Promise<string[]> {
    try {
      const { rows } = await this.client.query(
        'SELECT wallet FROM comp_wallets ORDER BY wallet',
      );
      return rows.map((row) => row.wallet as string);
    } catch (err) {
      this.log.error('[PostgresGameStore] failed to read comp wallets:', err);
      return [];
    }
  }

  // Comp-list writes are awaited by the admin endpoint (the operator needs to
  // know it persisted), so failures propagate rather than being swallowed.
  private async addCompWallet(walletAddress: string, note?: string): Promise<void> {
    await this.client.query(
      `INSERT INTO comp_wallets (wallet, note) VALUES ($1, $2)
       ON CONFLICT (wallet) DO UPDATE SET note = EXCLUDED.note`,
      [walletAddress, note ?? null],
    );
  }

  private async removeCompWallet(walletAddress: string): Promise<void> {
    await this.client.query('DELETE FROM comp_wallets WHERE wallet = $1', [walletAddress]);
  }

  // --------- Lifecycle ---------

  /** Close the connection pool (graceful shutdown). */
  async close(): Promise<void> {
    try {
      await this.client.end();
    } catch {
      // Already closed / never connected — nothing to do.
    }
  }
}
