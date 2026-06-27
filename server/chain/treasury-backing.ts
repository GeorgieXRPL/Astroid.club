/**
 * Treasury backing poller — exposes the LIVE redeemable reserve as the
 * emission governor's dynamic budget.
 *
 * Every mining credit is a redeemable claim against the redeemer treasury's
 * $ASTROID balance. To keep issuance from outrunning what the treasury can
 * actually pay, the {@link EmissionGovernor} tapers new yield as outstanding
 * liability approaches its budget. This poller makes that budget track reality:
 * it periodically reads the treasury's $ASTROID ATA balance and exposes
 * `balance × fraction` (a safety-margined backing) via {@link current}.
 *
 * It is deliberately cheap on the hot path: `current()` returns a cached
 * number with zero RPC; the balance refresh runs on a background interval (and
 * once eagerly at boot). On a read failure it keeps the last good value rather
 * than collapsing the budget to zero (which would wrongly halt issuance).
 *
 * spl-token is loaded via `createRequire` for the same CJS/ESM interop reason
 * as the other chain adapters.
 */

import { createRequire } from 'node:module';

import { Connection, PublicKey } from '@solana/web3.js';

import type { GameLogger } from '../game/interfaces.js';

const cjsRequire = createRequire(import.meta.url);

interface SplTokenSurface {
  getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): Promise<PublicKey>;
  getAccount(connection: Connection, address: PublicKey): Promise<{ amount: bigint }>;
}

let cachedSplToken: SplTokenSurface | null = null;

function loadSplToken(): SplTokenSurface {
  cachedSplToken ??= cjsRequire('@solana/spl-token') as SplTokenSurface;
  return cachedSplToken;
}

export interface TreasuryBackingConfig {
  rpcUrl: string;
  /** $ASTROID mint. */
  astroidMint: string;
  /** $ASTROID decimals (default 6). */
  astroidDecimals: number;
  /** Treasury (redeemer) wallet whose $ASTROID balance backs redemptions. */
  treasury: PublicKey;
  /**
   * Fraction of the treasury balance to expose as the emission budget — a
   * safety margin so issuance stops before the reserve is fully committed.
   * e.g. 0.8 keeps a 20% buffer. Clamped to (0, 1].
   */
  fraction: number;
  /** Refresh interval (ms). Default 120_000. */
  intervalMs?: number;
  connection?: Connection;
  logger?: GameLogger;
}

const DEFAULT_INTERVAL_MS = 120_000;

export class TreasuryBackingPoller {
  private readonly connection: Connection;
  private readonly astroidMint: PublicKey;
  private readonly treasury: PublicKey;
  private readonly decimals: number;
  private readonly fraction: number;
  private readonly intervalMs: number;
  private readonly log: GameLogger;

  /** Last observed treasury balance, in whole $ASTROID tokens. */
  private balanceTokens = 0;
  private lastUpdatedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ataPromise: Promise<PublicKey> | null = null;

  constructor(config: TreasuryBackingConfig) {
    this.connection = config.connection ?? new Connection(config.rpcUrl, 'confirmed');
    this.astroidMint = new PublicKey(config.astroidMint);
    this.treasury = config.treasury;
    this.decimals = config.astroidDecimals;
    this.fraction = Math.min(1, Math.max(0.0001, config.fraction));
    this.intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.log = config.logger ?? console;
  }

  /**
   * Emission budget to expose right now: `balance × fraction`. Returns 0 until
   * the first successful poll (the governor then falls back to its static
   * floor / behaves as un-pegged).
   */
  current(): number {
    return this.balanceTokens * this.fraction;
  }

  /** Raw last-observed treasury balance (whole tokens) for ops/telemetry. */
  getBalanceTokens(): number {
    return this.balanceTokens;
  }

  getUpdatedAt(): number {
    return this.lastUpdatedAt;
  }

  private treasuryAta(): Promise<PublicKey> {
    this.ataPromise ??= loadSplToken().getAssociatedTokenAddress(this.astroidMint, this.treasury);
    return this.ataPromise;
  }

  /** Read the treasury ATA balance once. Keeps the last good value on error. */
  async refreshOnce(): Promise<void> {
    try {
      const ata = await this.treasuryAta();
      const account = await loadSplToken().getAccount(this.connection, ata);
      this.balanceTokens = Number(account.amount) / Math.pow(10, this.decimals);
      this.lastUpdatedAt = Date.now();
    } catch (err) {
      this.log.warn?.(
        `[treasury-backing] balance refresh failed (keeping last value ${this.balanceTokens}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Eagerly refresh once, then poll on an interval. Safe to call once. */
  async start(): Promise<void> {
    await this.refreshOnce();
    if (this.timer) return;
    this.timer = setInterval(() => void this.refreshOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
