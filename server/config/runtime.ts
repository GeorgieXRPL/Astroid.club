/**
 * Runtime configuration read once at boot. Threaded through modules that need
 * to know the chain posture, RPC endpoint, mint, etc.
 *
 * Do not read `process.env` directly outside this file — go through `runtime`
 * so a single switch (CHAIN_ENABLED) flips the whole platform.
 */

const truthy = (v: string | undefined): boolean =>
  v === 'true' || v === '1' || v === 'yes' || v === 'on';

const requireEnv = (name: string, when: boolean): string | undefined => {
  const value = process.env[name];
  if (when && !value) {
    throw new Error(
      `${name} is required when CHAIN_ENABLED=true. Set it in your .env or unset CHAIN_ENABLED.`,
    );
  }
  return value;
};

export interface AstroidRuntime {
  /** When false, every on-chain side effect becomes a no-op returning a placeholder. */
  readonly chainEnabled: boolean;
  /** Solana JSON-RPC endpoint, used only when chainEnabled. */
  readonly rpcUrl: string | undefined;
  /** $ASTROID SPL mint address; required when chainEnabled. */
  readonly astroidMint: string | undefined;
  /** $ASTROID decimals (default 9). */
  readonly astroidDecimals: number;
  /** Minimum balance to qualify for the club. */
  readonly holderMinBalance: number;
  /** Continuous-hold seconds before a wallet qualifies (flash-loan guard). */
  readonly holderMinHoldSeconds: number;
  /**
   * When true (and Helius is wired), the holder gate pre-warms its
   * in-memory tracker from on-chain transaction history on a
   * wallet's first verify, so long-time holders qualify
   * immediately. See `server/chain/prewarm.ts`. Default true.
   */
  readonly holderPrewarmEnabled: boolean;
  /**
   * Maximum number of recent transactions the pre-warmer walks
   * back when reverse-simulating balance. Capped at 100 (Helius
   * per-page limit). Default 100.
   */
  readonly holderPrewarmMaxLookback: number;
  /** Comma-separated CORS origins for the gateway. */
  readonly corsAllowedOrigins: readonly string[];
  /**
   * Optional wallet allowlist. When non-empty, ONLY these wallet
   * addresses may authenticate — every other wallet is rejected after
   * signature verification, regardless of holdings. Empty (the default)
   * means no allowlist (any wallet that passes the holder gate gets in).
   * Set via `WALLET_ALLOWLIST` (comma-separated base58 pubkeys) to lock a
   * preview/test deploy to your own wallets.
   */
  readonly walletAllowlist: readonly string[];
  /** When set, enables the admin console; when unset, console is disabled. */
  readonly adminSecret: string | undefined;
  /** Optional Redis URL; a current-balance cache for game state when set. */
  readonly redisUrl: string | undefined;
  /**
   * Optional Postgres connection string (Supabase/Neon/etc.). When set,
   * the durable, auditable yield ledger + home stations live here — the
   * production system of record. Takes precedence over `redisUrl`.
   */
  readonly databaseUrl: string | undefined;
  /** WS / REST gateway port. */
  readonly port: number;
}

export const runtime: AstroidRuntime = (() => {
  const chainEnabled = truthy(process.env.CHAIN_ENABLED);
  return {
    chainEnabled,
    rpcUrl: requireEnv('SOLANA_RPC_URL', chainEnabled),
    astroidMint: requireEnv('ASTROID_MINT_ADDRESS', chainEnabled),
    astroidDecimals: Number(process.env.ASTROID_DECIMALS ?? '9'),
    holderMinBalance: Number(process.env.HOLDER_MIN_BALANCE ?? '1'),
    holderMinHoldSeconds: Number(process.env.HOLDER_MIN_HOLD_SECONDS ?? '600'),
    holderPrewarmEnabled: truthy(process.env.HOLDER_PREWARM_ENABLED ?? 'true'),
    holderPrewarmMaxLookback: Number(process.env.HOLDER_PREWARM_MAX_LOOKBACK ?? '100'),
    corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    walletAllowlist: (process.env.WALLET_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminSecret: process.env.ADMIN_SECRET || undefined,
    redisUrl: process.env.REDIS_URL || undefined,
    databaseUrl: process.env.DATABASE_URL || undefined,
    port: Number(process.env.PORT ?? '3002'),
  };
})();
