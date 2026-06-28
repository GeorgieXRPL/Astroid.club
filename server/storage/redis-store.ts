/**
 * Redis-backed durable persistence for astroid.club game state.
 *
 * The gateway holds the live economy in memory (Maps inside the
 * `StakeManager`). That's fast and correct while a process is up, but a
 * restart or redeploy wipes it — including the redeemable in-game IOU
 * credits (pending yield) players have earned. This store mirrors the
 * two pieces that must outlive a process to Redis:
 *
 *   - **Home station**   (`HomeStationStore`)   — wallet -> asteroid id.
 *   - **Pending yield**   (`PendingYieldStore`)  — wallet -> IOU credits.
 *
 * Design:
 *   - In-memory Maps remain the runtime source of truth; Redis is a
 *     write-through mirror, restored once on boot. Reads during play
 *     never touch Redis (no added latency on the hot path).
 *   - Writes are best-effort. A Redis blip must never crash the game or
 *     reject a player action, so write failures are logged and swallowed
 *     (the in-memory value is still correct until the next restart).
 *   - The ioredis client is injectable so tests can run without a live
 *     Redis (see `tests/storage/redis-store.test.ts`).
 *   - `HomeStationStore` and `PendingYieldStore` both declare `set`/`get`
 *     style methods, so the store exposes them as two distinct adapter
 *     views (`.homeStation`, `.pendingYield`) rather than implementing
 *     both clashing surfaces on one object.
 *
 * NOTE: this is the *in-game* IOU ledger. Once Phase B lands (on-chain
 * IOU mint + Quarry redeemer), real value lives on-chain and this store
 * is only a convenience cache. See `docs/READINESS.md`.
 */

import { Redis, type RedisOptions } from 'ioredis';

import type {
  CompWalletStore,
  EscrowStore,
  EscrowWagerRecord,
  GameLogger,
  HomeStationStore,
  PendingYieldStore,
  RaidVaultStore,
} from '../game/interfaces.js';

/**
 * Narrow subset of the ioredis client this store uses. Declared so tests
 * can inject a fake without standing up a real Redis server.
 */
export interface RedisClientLike {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, field: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  quit(): Promise<unknown>;
}

export interface RedisGameStoreConfig {
  /** Connection string, e.g. `rediss://default:pass@host:6379`. */
  url?: string;
  /** Pre-constructed client (tests / custom wiring). Overrides `url`. */
  client?: RedisClientLike;
  /** Key namespace; defaults to `astroid`. */
  keyPrefix?: string;
  /** Extra ioredis options merged into the connection. */
  options?: RedisOptions;
  logger?: GameLogger;
}

/**
 * Owns a single Redis connection and exposes two persistence adapters
 * backed by two hashes: `<prefix>:home-station` and
 * `<prefix>:pending-yield`.
 */
export class RedisGameStore {
  /** Adapter to wire as `StakeManager`'s `homeStationStore`. */
  readonly homeStation: HomeStationStore;
  /** Adapter to wire as `StakeManager`'s `pendingYieldStore`. */
  readonly pendingYield: PendingYieldStore;
  /** Adapter to wire as the `RaidVaultManager`'s `store`. */
  readonly raidVault: RaidVaultStore;
  /** Adapter to wire as the `EscrowManager`'s durable `store`. */
  readonly escrow: EscrowStore;
  /** Adapter to wire as the `CompWalletService`'s durable `store`. */
  readonly compWallets: CompWalletStore;

  private readonly client: RedisClientLike;
  private readonly log: GameLogger;
  private readonly homeKey: string;
  private readonly yieldKey: string;
  private readonly raidVaultKey: string;
  private readonly escrowKey: string;
  private readonly compWalletKey: string;

  constructor(config: RedisGameStoreConfig) {
    this.log = config.logger ?? console;
    const prefix = config.keyPrefix ?? 'astroid';
    this.homeKey = `${prefix}:home-station`;
    this.yieldKey = `${prefix}:pending-yield`;
    this.raidVaultKey = `${prefix}:raid-vault`;
    this.escrowKey = `${prefix}:escrow-wager`;
    this.compWalletKey = `${prefix}:comp-wallets`;

    if (config.client) {
      this.client = config.client;
    } else if (config.url) {
      // `maxRetriesPerRequest: null` keeps commands queued through brief
      // reconnects instead of throwing on every blip.
      const client = new Redis(config.url, {
        maxRetriesPerRequest: null,
        ...config.options,
      });
      client.on('error', (err: Error) => {
        this.log.error('[RedisGameStore] connection error:', err.message);
      });
      client.on('connect', () => {
        this.log.info('[RedisGameStore] connected');
      });
      this.client = client;
    } else {
      throw new Error('RedisGameStore requires either a `url` or a `client`.');
    }

    this.homeStation = {
      set: (wallet, asteroidId) => this.setHomeStation(wallet, asteroidId),
      get: (wallet) => this.getHomeStation(wallet),
    };
    this.pendingYield = {
      set: (wallet, amount) => this.setPendingYield(wallet, amount),
      delete: (wallet) => this.deletePendingYield(wallet),
      getAll: () => this.getAllPendingYield(),
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
      await this.client.hset(this.homeKey, walletAddress, asteroidId);
    } catch (err) {
      this.log.error('[RedisGameStore] failed to persist home station:', err);
    }
  }

  private async getHomeStation(walletAddress: string): Promise<string | null> {
    try {
      return await this.client.hget(this.homeKey, walletAddress);
    } catch (err) {
      this.log.error('[RedisGameStore] failed to read home station:', err);
      return null;
    }
  }

  // --------- Pending yield ---------

  private async setPendingYield(walletAddress: string, amount: number): Promise<void> {
    try {
      await this.client.hset(this.yieldKey, walletAddress, String(amount));
    } catch (err) {
      this.log.error('[RedisGameStore] failed to persist pending yield:', err);
    }
  }

  private async deletePendingYield(walletAddress: string): Promise<void> {
    try {
      await this.client.hdel(this.yieldKey, walletAddress);
    } catch (err) {
      this.log.error('[RedisGameStore] failed to delete pending yield:', err);
    }
  }

  private async getAllPendingYield(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const raw = await this.client.hgetall(this.yieldKey);
      for (const [wallet, value] of Object.entries(raw)) {
        const amount = Number(value);
        if (Number.isFinite(amount) && amount > 0) out.set(wallet, amount);
      }
    } catch (err) {
      this.log.error('[RedisGameStore] failed to read pending yield:', err);
    }
    return out;
  }

  // --------- Raid vault ---------

  private async setRaidVault(asteroidId: string, balance: number): Promise<void> {
    try {
      await this.client.hset(this.raidVaultKey, asteroidId, String(balance));
    } catch (err) {
      this.log.error('[RedisGameStore] failed to persist raid vault:', err);
    }
  }

  private async getAllRaidVaults(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const raw = await this.client.hgetall(this.raidVaultKey);
      for (const [asteroidId, value] of Object.entries(raw)) {
        const balance = Number(value);
        if (Number.isFinite(balance) && balance > 0) out.set(asteroidId, balance);
      }
    } catch (err) {
      this.log.error('[RedisGameStore] failed to read raid vaults:', err);
    }
    return out;
  }

  // --------- Escrow wagers (durable liability + settlement outbox) ---------
  //
  // Unlike the caches above, escrow writes are NOT swallowed: the
  // `EscrowManager` awaits them and handles failures, so a persistence error
  // must propagate rather than be silently lost (the funds are real).

  private async putEscrow(record: EscrowWagerRecord): Promise<void> {
    await this.client.hset(this.escrowKey, record.wagerId, JSON.stringify(record));
  }

  private async deleteEscrow(wagerId: string): Promise<void> {
    await this.client.hdel(this.escrowKey, wagerId);
  }

  private async getUnsettledEscrow(): Promise<EscrowWagerRecord[]> {
    const raw = await this.client.hgetall(this.escrowKey);
    const out: EscrowWagerRecord[] = [];
    for (const value of Object.values(raw)) {
      try {
        const record = JSON.parse(value) as EscrowWagerRecord;
        // `settled` rows are deleted, but guard anyway.
        if (record.status !== 'settled') out.push(record);
      } catch (err) {
        this.log.error('[RedisGameStore] failed to parse escrow record:', err);
      }
    }
    return out;
  }

  // --------- Comp / holder-gate-bypass wallets ---------
  //
  // Stored as a hash field-per-wallet (value = optional note). Like escrow,
  // writes are awaited by the admin endpoint and propagate on failure.

  private async listCompWallets(): Promise<string[]> {
    try {
      const raw = await this.client.hgetall(this.compWalletKey);
      return Object.keys(raw).sort();
    } catch (err) {
      this.log.error('[RedisGameStore] failed to read comp wallets:', err);
      return [];
    }
  }

  private async addCompWallet(walletAddress: string, note?: string): Promise<void> {
    await this.client.hset(this.compWalletKey, walletAddress, note ?? '');
  }

  private async removeCompWallet(walletAddress: string): Promise<void> {
    await this.client.hdel(this.compWalletKey, walletAddress);
  }

  // --------- Lifecycle ---------

  /** Close the underlying connection (graceful shutdown). */
  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // Already closed / never connected — nothing to do.
    }
  }
}
