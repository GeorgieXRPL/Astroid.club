/**
 * astroid.club server entrypoint.
 *
 * Boots the real game world behind the engine's WebSocket gateway.
 * Replaces the Phase 0 stub now that Phase 1 (game economy port,
 * anti-cheat, GameWorld, zod protocol, gateway) is complete.
 *
 * Wire-up:
 *   1. Read `runtime` (one-shot env parse).
 *   2. Construct `GameWorld` (12 game modules, no timers yet).
 *   3. Wrap it in `AstroidGateway` (WSGateway + WalletVerifier +
 *      Protocol + tick loop).
 *   4. Listen on an HTTP server so platforms like Railway and Fly
 *      can route via the same port for both HTTP health checks and
 *      WebSocket upgrades.
 *
 * Production NOTES (CHAIN_ENABLED gate is documented in detail in
 * `docs/PORTING_NOTES.md`):
 *   - With `runtime.chainEnabled === false` (default) yield payouts
 *     credit `stakeManager.addPendingYield` and the player calls
 *     `claim_yield` to bank them in-game. NO on-chain side effects.
 *   - With `runtime.chainEnabled === true` the boot fn here is
 *     responsible for wiring an `onYieldPayout` callback that emits
 *     real SPL transfers (separate slice).
 */

// MUST be the first import: populates process.env from .env.local (or
// .env) before any downstream module reads it. See ./env.ts for the
// load-order contract.
import './env.js';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { ASTEROIDS } from '../config/asteroids.js';

import { createAdminHandler } from './admin/admin-http.js';
import { LogBuffer } from './admin/log-buffer.js';
import { HolderChainAdapter, SolanaBalanceReader } from './chain/holder.js';
import { ChainOps, type ChainOpsImplementations } from './chain/index.js';
import { OnChainHoldEstimator } from './chain/prewarm.js';
import { PriceOracle, WRAPPED_SOL_MINT } from './chain/price-oracle.js';
import { BetEscrowChainService, getBetEscrowConfigFromEnv } from './chain/bet-escrow-chain.js';
import { EscrowManager } from './chain/escrow-manager.js';
import { RedeemerService, getRedeemerConfigFromEnv } from './chain/redeemer.js';
import { RewardPayoutAdapter, getRewardConfigFromEnv } from './chain/rewards.js';
import { QuarryStakingAdapter, getQuarryConfigFromEnv } from './chain/staking.js';
import { runtime } from './config/runtime.js';
import type {
  EscrowStore,
  EscrowWagerRecord,
  HomeStationStore,
  PendingYieldStore,
  RaidVaultStore,
  YieldLedger,
} from './game/interfaces.js';
import { setAstroidUsdPrice } from './game/types.js';
import { GameWorld } from './game/world.js';
import { AstroidGateway } from './net/gateway.js';
import { PostgresGameStore } from './storage/postgres-store.js';
import { RedisGameStore } from './storage/redis-store.js';
import { HolderTracker } from './verification/holder-tracker.js';

function logRuntime(): void {
  console.info('[astroid-club] runtime:', {
    port: runtime.port,
    chainEnabled: runtime.chainEnabled,
    rpcConfigured: Boolean(runtime.rpcUrl),
    mintConfigured: Boolean(runtime.astroidMint),
    redisConfigured: Boolean(runtime.redisUrl),
    adminEnabled: Boolean(runtime.adminSecret),
    cors: runtime.corsAllowedOrigins,
  });
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  // Tap `console` into a ring buffer BEFORE anything logs, so the admin
  // console's live feed includes boot output too.
  const logBuffer = new LogBuffer().install();
  console.info('[astroid-club] booting…');
  logRuntime();

  // Admin console request handler. Assigned once the GameWorld exists
  // (below); referenced by the HTTP server here. Null until then.
  let adminHandler: ((req: IncomingMessage, res: ServerResponse, url: URL) => boolean) | null = null;

  // Lightweight HTTP layer: health probe + a basic CORS preflight
  // responder. Future REST endpoints (staking, escrow) plug in here.
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestOrigin = req.headers.origin ?? '';
    const corsOrigin = runtime.corsAllowedOrigins.includes('*')
      ? '*'
      : runtime.corsAllowedOrigins.includes(requestOrigin)
        ? requestOrigin
        : '';
    if (corsOrigin) res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Admin console (`/admin` + `/admin/api/*`), gated by ADMIN_SECRET.
    if (adminHandler && adminHandler(req, res, url)) return;

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          chainEnabled: runtime.chainEnabled,
          server: 'astroid.club gateway',
        }),
      );
      return;
    }

    if (!req.headers.upgrade || req.headers.upgrade.toLowerCase() !== 'websocket') {
      res.writeHead(426, {
        'Content-Type': 'text/plain',
        Upgrade: 'websocket',
        Connection: 'Upgrade',
      });
      res.end('Upgrade Required');
    }
  });

  /**
   * Origin allow-list for WebSocket upgrades.
   *
   * Defence-in-depth alongside any edge-layer rule (Cloudflare WAF). The
   * `WSGateway` forwards `httpServer` to `ws.Server({ server })` which
   * registers its own `'upgrade'` listener; we prepend ours so we can
   * destroy the socket before the engine ever sees it.
   *
   * `*` in `CORS_ALLOWED_ORIGINS` disables the check (useful only when
   * fronted by Cloudflare with a domain-locked tunnel; not recommended for
   * direct public exposure). An empty `Origin` header (CLI clients, native
   * test clients) is permitted because the same anti-cheat budget still
   * applies once they auth — this matches the dev-mode test console.
   */
  httpServer.prependListener('upgrade', (req, socket) => {
    const origin = (req.headers.origin ?? '').toString();
    if (!origin) return;
    const allow =
      runtime.corsAllowedOrigins.includes('*') || runtime.corsAllowedOrigins.includes(origin);
    if (!allow) {
      console.warn(`[astroid-club] rejected WS upgrade from origin: ${origin}`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    }
  });

  // Layer 3 of the CHAIN_ENABLED kill switch: every chain side
  // effect goes through `ChainOps`. With `chainEnabled=false` every
  // method is a no-op. With `chainEnabled=true` and no impl wired,
  // every method throws `ChainOpNotImplementedError` — by design.
  // See `docs/CHAIN_AUDIT.md`.
  //
  // Holder verification (read-only): RPC reads of $ASTROID balance,
  // fed into the in-memory flash-loan-mitigation tracker. Only
  // constructed when chain is on; off-mode falls through to the
  // `disabled` sentinel inside ChainOps.
  const chainImpls: Partial<ChainOpsImplementations> = {};
  // True once the Quarry program addresses are wired below. The GameWorld
  // uses this to make on-chain custody the source of truth for staking
  // (the in-game simulation stake/unstake is then disabled).
  let quarryEnabled = false;
  // True once the raid-wager escrow treasury is wired below. The GameWorld
  // only receives the on-chain settlement hooks when this is set; otherwise
  // wager resolution stays in-memory (cosmetic).
  let betEscrowWired = false;
  // The escrow chain service, hoisted so the durable EscrowManager can drive
  // its return/payDefender/burnWager legs after the store is selected below.
  let betEscrowChainSvc: BetEscrowChainService | undefined;
  // Live price feed, hoisted so the holder gate's SOL-pegged threshold can read
  // it. Created + started further below (after the gateway is wired); the gate's
  // provider closure reads it lazily and falls back to the static floor until
  // the first quote lands.
  let priceOracle: PriceOracle | undefined;
  if (runtime.chainEnabled && runtime.rpcUrl && runtime.astroidMint) {
    // Plug the holder layer's loggers into the gateway's console so
    // operators can see why a wallet got the answer it got. Logs are
    // PII-light: balances are absolute (no addresses on the wire),
    // wallet addresses are short-prefix-only.
    const tracker = new HolderTracker({
      minHoldMs: runtime.holderMinHoldSeconds * 1_000,
      logger: console,
    });
    const heliusApiKey = process.env.HELIUS_API_KEY;
    const reader = new SolanaBalanceReader({
      rpcUrl: runtime.rpcUrl,
      mintAddress: runtime.astroidMint,
      decimals: runtime.astroidDecimals,
      heliusApiKey,
      logger: console,
    });

    // On-chain hold-time pre-warmer (`server/chain/prewarm.ts`).
    // Without it, every legitimate holder eats the full
    // `HOLDER_MIN_HOLD_SECONDS` wait the first time they verify
    // — even if they've held tokens for months on chain. With it,
    // their first verify reverse-simulates balance over recent
    // transfers and seeds the tracker with the true hold-start
    // timestamp. Requires Helius (the JSON-RPC path lacks
    // ergonomic per-mint transfer history); silently disabled if
    // `HELIUS_API_KEY` is unset.
    let estimator: OnChainHoldEstimator | undefined;
    if (runtime.holderPrewarmEnabled && heliusApiKey) {
      estimator = new OnChainHoldEstimator({
        mintAddress: runtime.astroidMint,
        heliusApiKey,
        isDevnet: runtime.rpcUrl.includes('devnet'),
        maxLookback: runtime.holderPrewarmMaxLookback,
        logger: console,
      });
      console.info(
        `[astroid-club] holder pre-warm enabled (lookback=${runtime.holderPrewarmMaxLookback}). ` +
          `New holders' on-chain hold time will be inferred from transfer history.`,
      );
    } else if (runtime.holderPrewarmEnabled) {
      console.warn(
        '[astroid-club] HOLDER_PREWARM_ENABLED=true but HELIUS_API_KEY is unset; ' +
          'pre-warm disabled. Long-time holders will pay the full HOLDER_MIN_HOLD_SECONDS ' +
          'wait on first verify.',
      );
    } else {
      console.info(
        '[astroid-club] holder pre-warm disabled (HOLDER_PREWARM_ENABLED=false). ' +
          'Hold time is measured from gateway-first-seen only.',
      );
    }

    // Optional SOL-pegged holder gate: when HOLDER_MIN_SOL > 0 the required
    // $ASTROID balance is recomputed live as `minSol * SOL_usd / ASTROID_usd`,
    // so entry stays worth ~N SOL and the token count drops as $ASTROID rises.
    // `priceOracle` is assigned later (below); the closure reads it lazily and
    // returns 0 (→ static floor) until the first quote arrives.
    const holderMinSol = runtime.holderMinSol;
    const holder = new HolderChainAdapter({
      reader,
      tracker,
      estimator,
      requiredBalance: runtime.holderMinBalance,
      requiredBalanceProvider:
        holderMinSol > 0
          ? () => {
              const solUsd = priceOracle?.getSolPrice() ?? 0;
              const astroidUsd = priceOracle?.getPrice() ?? 0;
              return solUsd > 0 && astroidUsd > 0 ? (holderMinSol * solUsd) / astroidUsd : 0;
            }
          : undefined,
      logger: console,
    });
    chainImpls.getHolderBalance = (wallet) => holder.getHolderBalance(wallet);
    chainImpls.verifyHolderQualified = (wallet) => holder.verifyHolderQualified(wallet);
    if (holderMinSol > 0) {
      console.info(
        `[astroid-club] holder gate pegged to ~${holderMinSol} SOL of $ASTROID ` +
          `(live Jupiter oracle; static floor ${runtime.holderMinBalance} tokens until a quote lands).`,
      );
    }

    // Quarry staking (build-and-sign). Only wired when the Quarry
    // program addresses are present in the environment (rewarder +
    // quarry at minimum). Without them, the staking ChainOps methods
    // throw `ChainOpNotImplementedError` if ever called — by design,
    // surfacing a misconfiguration rather than silently no-opping.
    const quarryConfig = getQuarryConfigFromEnv();
    if (quarryConfig) {
      quarryEnabled = true;
      const staking = new QuarryStakingAdapter(quarryConfig, { logger: console });
      chainImpls.buildStakeTx = (wallet, amount) => staking.buildStakeTransaction(wallet, amount);
      chainImpls.buildUnstakeTx = (wallet, amount) =>
        staking.buildUnstakeTransaction(wallet, amount);
      chainImpls.buildClaimTx = (wallet) => staking.buildClaimRewardsTransaction(wallet);
      chainImpls.buildRedeemTx = (wallet, amount) => staking.buildRedeemTransaction(wallet, amount);
      chainImpls.verifyStakeTx = (sig, wallet, amount) =>
        staking.verifyStakeTransaction(sig, wallet, amount);
      chainImpls.getStakeInfo = (wallet) => staking.getUserStakeInfo(wallet);
      console.info(
        `[astroid-club] Quarry staking wired (quarry=${quarryConfig.quarryAddress.slice(0, 8)}…, ` +
          `astroid=${quarryConfig.astroidDecimals}dec, iou=${quarryConfig.iouDecimals}dec).`,
      );
    } else {
      console.warn(
        '[astroid-club] CHAIN_ENABLED=true but Quarry addresses unset ' +
          '(QUARRY_REWARDER_ADDRESS / QUARRY_ADDRESS). On-chain staking disabled; ' +
          'stake/claim/redeem messages will be rejected.',
      );
    }

    // Discovery-reward payout (`chain_yield_sink`). When a reward-pool
    // wallet is configured, route the distribution service's per-asteroid
    // yield through a server-signed $ASTROID transfer. Without
    // REWARD_WALLET_PRIVATE_KEY this stays unwired and `executeYieldPayout`
    // throws if ever called — surfacing the misconfiguration instead of
    // silently dropping rewards.
    const rewardConfig = getRewardConfigFromEnv();
    if (rewardConfig) {
      const rewards = new RewardPayoutAdapter(rewardConfig, { logger: console });
      chainImpls.executeYieldPayout = (wallet, amount, asteroidId) =>
        rewards.payout(wallet, amount, asteroidId);
      console.info(
        `[astroid-club] reward payout wired (pool=${rewards.rewardWalletAddress.slice(0, 8)}…, ` +
          `astroid=${rewardConfig.astroidDecimals}dec). Discovery rewards pay real $ASTROID.`,
      );
    } else {
      console.warn(
        '[astroid-club] CHAIN_ENABLED=true but REWARD_WALLET_PRIVATE_KEY unset. ' +
          'On-chain discovery payouts disabled; yield is credited in-game ' +
          '(addPendingYield) only.',
      );
    }

    // IOU bridge + atomic redeemer (`chain_iou_bridge`). When a treasury
    // hot wallet (holding pre-minted IOU + $ASTROID) is configured:
    //   - `bridgeIou` moves in-game credits to on-chain IOU-ASTROID, and
    //   - `buildRedeemTx` is upgraded to an ATOMIC swap (user IOU ->
    //     treasury + treasury $ASTROID -> user in one tx), superseding the
    //     staking adapter's IOU-only transfer.
    // Without REDEEMER_TREASURY_PRIVATE_KEY this stays unwired and the
    // bridge reports `chain_disabled`.
    const redeemerConfig = getRedeemerConfigFromEnv();
    if (redeemerConfig) {
      const redeemer = new RedeemerService(redeemerConfig, { logger: console });
      chainImpls.bridgeIou = (wallet, amount) => redeemer.bridge(wallet, amount);
      chainImpls.buildRedeemTx = (wallet, amount) => redeemer.buildRedeemSwap(wallet, amount);
      chainImpls.coSignAndSubmitRedeem = (wallet, args) =>
        redeemer.coSignAndSubmitRedeem(wallet, args);
      console.info(
        `[astroid-club] IOU bridge + atomic redeemer wired (treasury=` +
          `${redeemer.treasuryAddress.slice(0, 8)}…, rate=${redeemerConfig.redeemRate} ` +
          `$ASTROID/IOU). Bridge converts in-game credits to on-chain IOU; redeem swaps IOU↔$ASTROID.`,
      );
    } else {
      console.warn(
        '[astroid-club] CHAIN_ENABLED=true but REDEEMER_TREASURY_PRIVATE_KEY unset. ' +
          'IOU bridge disabled; redeem falls back to the IOU-only transfer (no $ASTROID payout).',
      );
    }

    // Raid-wager escrow (`chain_bet_escrow`). Reuses the redeemer treasury
    // hot wallet to custody escrowed wagers: players deposit (wallet-signed)
    // into the escrow ATA, and the treasury server-signs settlement
    // (return on win, burn 90% + defender spoils on loss). Without the
    // treasury key this stays unwired and the escrow ops report `disabled`.
    const betEscrowConfig = getBetEscrowConfigFromEnv();
    if (betEscrowConfig) {
      const betEscrowChain = new BetEscrowChainService(betEscrowConfig, { logger: console });
      betEscrowChainSvc = betEscrowChain;
        chainImpls.buildBetEscrowDeposit = async (wallet, amount, raidId) => {
          const built = await betEscrowChain.buildDeposit(wallet, amount, raidId);
          if ('error' in built) throw new Error(built.error);
          return {
            transaction: built.transaction,
            blockhash: built.blockhash,
            lastValidBlockHeight: built.lastValidBlockHeight,
          };
        };
      chainImpls.verifyBetEscrowDeposit = (signature, wallet, amount, raidId) =>
        betEscrowChain.verifyDeposit(signature, wallet, amount, raidId);
      chainImpls.returnBetEscrow = (wallet, amount, raidId) =>
        betEscrowChain.returnWager(wallet, amount, raidId);
      chainImpls.payBetDefender = (wallet, amount, raidId) =>
        betEscrowChain.payDefender(wallet, amount, raidId);
      chainImpls.burnBetEscrow = (amount, raidId) => betEscrowChain.burnWager(amount, raidId);
      betEscrowWired = true;
      console.info(
        `[astroid-club] raid-wager escrow wired (escrow=${betEscrowChain.escrowAddress.slice(0, 8)}…). ` +
          'Wagers escrow on deposit; win returns, loss burns 90% + 10% defender spoils.',
      );
    } else {
      console.warn(
        '[astroid-club] CHAIN_ENABLED=true but REDEEMER_TREASURY_PRIVATE_KEY unset. ' +
          'Raid-wager escrow disabled; wagers remain cosmetic (no on-chain custody).',
      );
    }
  }
  const chainOps = new ChainOps({ runtime, impls: chainImpls });

  // Reward posture (sweepstakes / IOU model). `REWARD_MODE=ledger` (the
  // default) means mining accrues redeemable in-game credits and the only
  // on-chain step is an explicit redemption (see docs/READINESS.md).
  // `REWARD_MODE=onchain` fires a real SPL transfer per discovery (legacy
  // per-event payout) and requires the reward wallet to be wired.
  const payoutsOnChain = process.env.REWARD_MODE === 'onchain';
  const discoveryEnabled = (process.env.DISCOVERY_ENABLED ?? 'true') !== 'false';
  const discoveryReferenceDrillPower = Number(process.env.DISCOVERY_REFERENCE_DRILL_POWER ?? '1');
  const discoveryMaxPerAsteroidPerTick = Number(
    process.env.DISCOVERY_MAX_PER_ASTEROID_PER_TICK ?? '1',
  );

  // Anti-spoof drill-power bound. Drill power is self-reported by the client
  // (no proof-of-work), so without a bound a wallet can claim the 10M hard cap
  // regardless of stake. We clamp the reported base to
  // `DRILL_BASE_FREE + stake × DRILL_BASE_PER_STAKE` before the tier multiplier.
  // Defaults: a 5,000 free baseline (the client's own default) + 1 base per
  // staked token. Set DRILL_STAKE_BOUND=off to disable.
  const drillBoundEnabled = (process.env.DRILL_STAKE_BOUND ?? 'on') !== 'off';
  const drillBaseFree = Number(process.env.DRILL_BASE_FREE ?? '5000');
  const drillBasePerStake = Number(process.env.DRILL_BASE_PER_STAKE ?? '1');
  const drillPowerBound =
    drillBoundEnabled && Number.isFinite(drillBaseFree) && Number.isFinite(drillBasePerStake)
      ? { freeBase: Math.max(0, drillBaseFree), perStakeToken: Math.max(0, drillBasePerStake) }
      : undefined;

  // Reserve-protection knobs. The emission governor tapers mining issuance as
  // the outstanding redeemable credit liability approaches the treasury
  // backing (EMISSION_BUDGET) and/or a rolling daily cap (EMISSION_DAILY_CAP).
  // Both default to 0 (off) so behaviour is unchanged until an operator opts
  // in by sizing EMISSION_BUDGET to the funded backing. YIELD_BASE_PER_DISCOVERY
  // retunes the base reward without touching code.
  const emissionBudget = Number(process.env.EMISSION_BUDGET ?? '0');
  const emissionDailyCap = Number(process.env.EMISSION_DAILY_CAP ?? '0');
  const emissionTaperFraction = Number(process.env.EMISSION_TAPER_FRACTION ?? '0.25');
  const baseYieldPerDiscovery = process.env.YIELD_BASE_PER_DISCOVERY
    ? Number(process.env.YIELD_BASE_PER_DISCOVERY)
    : undefined;
  // Percent of each discovery routed into the persistent, raidable raid vault
  // (the asteroid "treasury"); the rest is paid to miners per-discovery.
  const raidVaultPercent = process.env.RAID_VAULT_PERCENT
    ? Number(process.env.RAID_VAULT_PERCENT)
    : undefined;
  // Meteor-strike spawn probability per world tick (~60s). Lower = rarer.
  // Defaults to the engine default (0.04) when unset/invalid.
  const meteorSpawnChance =
    process.env.METEOR_SPAWN_CHANCE && Number.isFinite(Number(process.env.METEOR_SPAWN_CHANCE))
      ? Number(process.env.METEOR_SPAWN_CHANCE)
      : undefined;
  // Raid cooldown overrides (minutes → ms). Default to the moderate 10m/5m
  // baked into COOLDOWN_DURATIONS when unset/invalid.
  const cooldownMins = (envKey: string): number | undefined => {
    const raw = process.env[envKey];
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n * 60_000 : undefined;
  };
  const expeditionStartMs = cooldownMins('RAID_START_COOLDOWN_MIN');
  const expeditionRecoveryMs = cooldownMins('RAID_RECOVERY_COOLDOWN_MIN');
  // Idle-raid fallback: how long a raid can sit before it auto-resolves even if
  // the target never makes a discovery. Defaults to 10 min (tracker default).
  const expeditionMaxDurationMs = cooldownMins('RAID_MAX_DURATION_MIN');
  const cooldownDurations =
    expeditionStartMs !== undefined || expeditionRecoveryMs !== undefined
      ? {
          ...(expeditionStartMs !== undefined && { expedition_start: expeditionStartMs }),
          ...(expeditionRecoveryMs !== undefined && { expedition_recovery: expeditionRecoveryMs }),
        }
      : undefined;

  // Durable state. Precedence:
  //   1. DATABASE_URL (Postgres/Supabase) — the production system of
  //      record: an auditable, append-only yield ledger + home stations.
  //   2. REDIS_URL — a durable current-balance cache (credits survive a
  //      restart, but no event history). Good for preview testing.
  //   3. neither — in-memory only; a redeploy wipes accrued IOU credits.
  // See docs/SUPABASE.md (production) and docs/REDIS.md (quick option).
  let postgresStore: PostgresGameStore | undefined;
  let redisStore: RedisGameStore | undefined;
  let homeStationStore: HomeStationStore | undefined;
  let pendingYieldStore: PendingYieldStore | undefined;
  let yieldLedger: YieldLedger | undefined;
  let raidVaultStore: RaidVaultStore | undefined;
  let escrowStore: EscrowStore | undefined;
  if (runtime.databaseUrl) {
    postgresStore = new PostgresGameStore({
      connectionString: runtime.databaseUrl,
      logger: console,
    });
    homeStationStore = postgresStore.homeStation;
    yieldLedger = postgresStore.ledger;
    raidVaultStore = postgresStore.raidVault;
    escrowStore = postgresStore.escrow;
    console.info(
      '[astroid-club] Postgres persistence ENABLED — auditable yield ledger + home ' +
        'stations are the durable system of record.',
    );
  } else if (runtime.redisUrl) {
    redisStore = new RedisGameStore({ url: runtime.redisUrl, logger: console });
    homeStationStore = redisStore.homeStation;
    pendingYieldStore = redisStore.pendingYield;
    raidVaultStore = redisStore.raidVault;
    escrowStore = redisStore.escrow;
    console.info(
      '[astroid-club] Redis persistence ENABLED — home stations and pending IOU ' +
        'credits survive restarts (balance cache; no audit log — see docs/SUPABASE.md).',
    );
  } else {
    console.warn(
      '[astroid-club] No DATABASE_URL or REDIS_URL — game state is IN-MEMORY ONLY. A ' +
        'restart or redeploy wipes pending IOU credits. See docs/SUPABASE.md.',
    );
  }

  // Durable escrow manager: the system-of-record + retrying settlement outbox
  // for on-chain raid wagers. Only built when the escrow treasury is wired.
  // Falls back to an in-memory store if no durable store is configured (escrow
  // still gets in-session retry, just no restart reconciliation).
  let escrowManager: EscrowManager | undefined;
  if (betEscrowWired && betEscrowChainSvc) {
    const memStore = (): EscrowStore => {
      const mem = new Map<string, EscrowWagerRecord>();
      return {
        put: (r) => void mem.set(r.wagerId, { ...r }),
        delete: (id) => void mem.delete(id),
        getUnsettled: () => Array.from(mem.values()).filter((r) => r.status !== 'settled'),
      };
    };
    const store = escrowStore ?? memStore();
    escrowManager = new EscrowManager({ store, chain: betEscrowChainSvc, logger: console });
    if (!escrowStore) {
      console.warn(
        '[astroid-club] escrow durable store NOT configured — wager liability is in-memory ' +
          'only (no restart reconciliation). Configure DATABASE_URL or REDIS_URL.',
      );
    }
  }

  const world = new GameWorld({
    chainEnabled: runtime.chainEnabled,
    payoutsOnChain,
    quarryEnabled,
    discoveryEnabled,
    discoveryReferenceDrillPower,
    discoveryMaxPerAsteroidPerTick,
    ...(baseYieldPerDiscovery !== undefined && { baseYieldPerDiscovery }),
    ...(raidVaultPercent !== undefined && { raidVaultPercent }),
    ...(meteorSpawnChance !== undefined && { meteor: { spawnChancePerTick: meteorSpawnChance } }),
    ...(cooldownDurations !== undefined && { cooldownDurations }),
    ...(expeditionMaxDurationMs !== undefined && { expeditionMaxDurationMs }),
    emission: {
      budget: emissionBudget,
      dailyCap: emissionDailyCap,
      taperFraction: emissionTaperFraction,
    },
    homeStationStore,
    pendingYieldStore,
    yieldLedger,
    ...(raidVaultStore && { raidVaultStore }),
    ...(drillPowerBound && { drillPowerBound }),
    autoStartTimers: true,
    // Route distribution-service yield payouts through `ChainOps`.
    // Only used when `payoutsOnChain` is true; in the default ledger
    // posture the orchestrator credits `addPendingYield` (IOU credits)
    // instead and this listener is never invoked.
    onYieldPayout: chainOps.toYieldPayoutListener(),
    // Raid-wager escrow hooks. Only wired when the escrow treasury is
    // configured. Both route through the durable EscrowManager: a verified
    // deposit is recorded as liability the instant the raid books, and the
    // resolved outcome is handed to the retrying, restart-safe outbox.
    ...(escrowManager && {
      onWagerBooked: (record) => {
        void escrowManager!.recordBooked(record);
      },
      onWagerSettle: (plan) => {
        void escrowManager!.settle(plan);
      },
    }),
    // Starter fleet: 4 canonical asteroids (Bennu / Vesta / Psyche /
    // Themis), one per resource class. Defined in `config/asteroids.ts`.
    // The design pass expands this to ~20 with a deliberate sector
    // layout; until then this is enough to play-test every branch.
    asteroids: ASTEROIDS,
  });
  console.info(
    `[astroid-club] seeded ${ASTEROIDS.length} asteroids: ` +
      ASTEROIDS.map((a) => `${a.name} (${a.resource})`).join(', '),
  );
  console.info(
    `[astroid-club] discovery loop ${discoveryEnabled ? 'ENABLED' : 'disabled'} ` +
      `(referenceDrillPower=${discoveryReferenceDrillPower}, ` +
      `maxPerAsteroidPerTick=${discoveryMaxPerAsteroidPerTick}); ` +
      `reward mode=${payoutsOnChain ? 'ONCHAIN (per-event SPL transfer)' : 'ledger (in-game IOU credits; redeem to claim)'}.`,
  );
  if (drillPowerBound) {
    console.info(
      `[astroid-club] drill-power bound ENABLED (base ≤ ${drillPowerBound.freeBase} + ` +
        `${drillPowerBound.perStakeToken}×stake; set DRILL_STAKE_BOUND=off to disable).`,
    );
  } else {
    console.info('[astroid-club] drill-power bound disabled (self-reported drill is unbounded).');
  }
  if (emissionBudget > 0 || emissionDailyCap > 0) {
    console.info(
      `[astroid-club] emission governor ENABLED ` +
        `(budget=${emissionBudget || '∞'}, dailyCap=${emissionDailyCap || '∞'}, ` +
        `taper=${emissionTaperFraction}).`,
    );
  } else {
    console.info('[astroid-club] emission governor disabled (set EMISSION_BUDGET to enable).');
  }
  console.info(
    `[astroid-club] raid vault ENABLED (${raidVaultPercent ?? 20}% of each discovery → persistent ` +
      `per-asteroid treasury; miners paid per-discovery, no hourly drain).`,
  );
  console.info(
    `[astroid-club] meteor spawn chance ${(meteorSpawnChance ?? 0.04) * 100}% per ~60s tick ` +
      `(set METEOR_SPAWN_CHANCE to tune).`,
  );

  // Reload durable state (IOU credits) before accepting connections so
  // returning players see their accrued balance immediately.
  if (postgresStore || redisStore) {
    await world.restorePersistedState();
  }

  // Wire the admin console now that the world exists. Read-only live
  // monitoring at `/admin`; enabled only when ADMIN_SECRET is set.
  const persistence = postgresStore ? 'postgres' : redisStore ? 'redis' : 'memory';
  adminHandler = createAdminHandler({
    world,
    buffer: logBuffer,
    persistence,
    quarryEnabled,
    payoutsOnChain,
    startedAt,
    // Lazy: the oracle is constructed further below; read it at snapshot time.
    getPriceOracle: () => priceOracle,
    escrowManager,
  });
  console.info(
    runtime.adminSecret
      ? `[astroid-club] admin console ENABLED at /admin (persistence=${persistence}).`
      : '[astroid-club] admin console disabled (set ADMIN_SECRET to enable /admin).',
  );

  const gateway = new AstroidGateway({
    world,
    chainOps,
    server: httpServer,
    walletAllowlist: runtime.walletAllowlist,
    // Route the "deposit landed but raid couldn't launch" refund through the
    // durable outbox so a chain failure is recorded + retried, not lost.
    ...(escrowManager && {
      onWagerRefund: (wallet: string, amount: number, wagerId: string) =>
        void escrowManager!.refund(wagerId, wallet, amount),
    }),
  });
  gateway.start();

  // Reconcile any escrow left unsettled by a prior restart (refund orphaned
  // deposits, resume in-flight settlements), then arm the retry sweep.
  if (escrowManager) {
    await escrowManager.reconcileOnBoot();
    escrowManager.start();
  }

  await new Promise<void>((resolve) => {
    httpServer.listen(runtime.port, () => {
      console.info(`[astroid-club] HTTP+WS listening on port ${runtime.port}`);
      console.info(`[astroid-club] health: http://localhost:${runtime.port}/health`);
      resolve();
    });
  });

  if (runtime.chainEnabled) {
    console.warn(
      '[astroid-club] CHAIN_ENABLED=true. Chain operations dispatch through ChainOps. ' +
        'Operations whose implementations have not yet landed will throw ' +
        '`ChainOpNotImplementedError` at the call site (by design — see CHAIN_AUDIT.md).',
    );
  }

  // Live $ASTROID/USD price feed → dynamic, USD-pegged stake tiers (and, when
  // HOLDER_MIN_SOL is set, the SOL-pegged holder gate). Only runs when we know
  // the mint; otherwise tiers use their static token fallbacks. SOL is tracked
  // in the same request only when the gate needs it.
  if (runtime.astroidMint) {
    priceOracle = new PriceOracle({
      mint: runtime.astroidMint,
      solMint: runtime.holderMinSol > 0 ? WRAPPED_SOL_MINT : undefined,
      apiKey: process.env.JUP_API_KEY || undefined,
      refreshMs: Number(process.env.STAKE_TIER_PRICE_REFRESH_MS ?? String(5 * 60_000)),
      logger: console,
      onPrice: setAstroidUsdPrice,
    });
    await priceOracle.start();
    console.info(
      priceOracle.getPrice() > 0
        ? `[astroid-club] price oracle ENABLED ($ASTROID=$${priceOracle.getPrice()}); ` +
            `stake tiers priced in USD ($50/$100/$200/$400 default).`
        : '[astroid-club] price oracle started but no live price yet; ' +
            'stake tiers using static token fallbacks until a quote arrives.',
    );
  } else {
    console.info(
      '[astroid-club] price oracle disabled (no ASTROID_MINT_ADDRESS); ' +
        'stake tiers use static token fallbacks.',
    );
  }

  const shutdown = (signal: string) => {
    console.info(`[astroid-club] received ${signal}; shutting down…`);
    gateway.stop();
    priceOracle?.stop();
    void postgresStore?.close();
    void redisStore?.close();
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[astroid-club] failed to start:', err);
  process.exit(1);
});
