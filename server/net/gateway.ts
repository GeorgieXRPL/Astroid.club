/**
 * astroid.club WebSocket gateway.
 *
 * Mounts a `GameWorld` behind the engine's `WSGateway` + `Protocol`
 * and the engine's `WalletVerifier`. Replaces Black-Gold's bespoke
 * connection manager + payload validator + signature verifier with
 * three composed engine primitives plus a thin message router.
 *
 * Wire flow:
 *
 * 1. Client connects, gets a `Connection` from the engine gateway.
 * 2. Client sends `request_nonce { walletAddress }`. Server replies
 *    with `result { nonce, message, app, ttlMs }`. The `message`
 *    field is the canonical JSON the client must sign.
 * 3. Client signs `message` with the wallet (Phantom, Backpack, ...)
 *    and sends `auth { walletAddress, nonce, signature }`. Server
 *    validates via `WalletVerifier.verifySignedAction`; on success
 *    stamps `walletAddress` onto `conn.meta` and replies with the
 *    connect snapshot.
 * 4. Subsequent game messages dispatch to `GameWorld` methods. The
 *    gateway translates `WorldResult<T>` into `result` / `error`
 *    envelopes; `requestId` echoes when the client supplied one.
 *
 * Periodic maintenance: `world.tick()` runs every `tickIntervalMs`
 * (default 60s), matching BG's cleanup cadence.
 */

import { type Server as HttpServer } from 'node:http';

import { v4 as uuidv4 } from 'uuid';

import { solana } from 'game-engine-enhanced/chain';
import {
  WSGateway,
  type Connection,
  type Protocol,
  type RateLimitConfig,
  type WSGatewayOptions,
} from 'game-engine-enhanced/net';
import type { Storage as EngineStorage } from 'game-engine-enhanced/storage';

const { WalletVerifier } = solana;
type WalletVerifier = InstanceType<typeof WalletVerifier>;

import { ChainOpNotImplementedError } from '../chain/index.js';
import type {
  BuildError,
  ChainOps,
  ChainQueryResult,
  ChainTxResult,
  TransactionBuildResult,
} from '../chain/index.js';
import type { GameLogger } from '../game/interfaces.js';
import type { GameWorld, WorldResult } from '../game/world.js';
import { ANONYMOUS_WALLET } from '../verification/anti-cheat.js';
import type { CompWalletService } from '../verification/comp-wallets.js';

import {
  GameMessage,
  POST_AUTH_TYPES,
  READONLY_MESSAGE_TYPES,
  createAstroidProtocol,
  type ErrorEnvelope,
  type EventEnvelope,
  type GameMessage as GameMessageT,
  type GameMessageType,
  type HolderEligibilityData,
  type NonceIssuedData,
  type ResultEnvelope,
} from './protocol.js';

/**
 * Reply sent when chain is enabled but a staking op has no impl wired
 * (e.g. Quarry addresses unset). This is an expected pre-launch state,
 * not a misconfiguration to surface as a server stack trace, so the
 * gateway returns a friendly `chain_disabled` rather than letting the
 * `ChainOpNotImplementedError` bubble up and spam the logs.
 */
const STAKING_UNAVAILABLE_MESSAGE =
  'On-chain staking is not available yet. Mining rewards are accruing as ' +
  'in-game credits; staking and redemption go live with the Quarry deployment.';

/**
 * Failure codes that represent ordinary, expected client/business-rule
 * outcomes — NOT abuse. These must never accrue anti-cheat backoff, because
 * doing so penalizes normal play (e.g. clicking "Set drill" before joining an
 * asteroid, or retrying a claim) and, worse, the resulting backoff blocks the
 * wallet's *other* actions (including claiming rewards) until it expires.
 *
 * Real abuse is still caught elsewhere: malformed messages reject at the Zod
 * boundary (dispatch try/catch), and request floods are throttled by the
 * rate-limit window in `checkAction`.
 */
const BENIGN_FAILURE_CODES: ReadonlySet<string> = new Set([
  'not_authenticated',
  'invalid_input',
  'unknown_asteroid',
  'cooldown_active',
  'rejected',
  'home_station_required',
  'chain_disabled',
  'rate_limited',
  'unknown_meteor',
  'insufficient_credits',
]);

/** Configuration accepted by `AstroidGateway`. */
export interface AstroidGatewayOptions {
  /** The composed game world. The gateway never constructs game state. */
  world: GameWorld;
  /**
   * The composed chain facade. Used by `verify_holder` to run the
   * read-only holder check; gated on `chainEnabled` internally so
   * `verify_holder` works in both modes (returns the disabled
   * sentinel in dev). Optional — when omitted the gateway treats
   * `verify_holder` as if chain were disabled, which keeps the
   * test harness from having to construct a ChainOps just to
   * exercise the auth flow.
   */
  chainOps?: ChainOps;
  /**
   * Wallet verifier. Defaults to a fresh `WalletVerifier` bound to the
   * `astroid.club` app name, in-memory nonce storage, default 5-minute
   * TTL — fine for single-process dev. Production should wire a
   * Redis-backed `Storage` so nonces survive across server instances.
   */
  walletVerifier?: WalletVerifier;
  /**
   * Storage for the default `WalletVerifier` (only consulted when
   * `walletVerifier` is not supplied). Defaults to in-memory.
   */
  walletVerifierStorage?: EngineStorage;
  /** Bind to an existing HTTP server, OR... */
  server?: HttpServer;
  /** ...open on a port. Default 3002 (matches `runtime.port`). */
  port?: number;
  host?: string;
  /** Per-connection rate-limit config; defaults to engine defaults. */
  rateLimit?: Partial<RateLimitConfig>;
  /** Maintenance tick cadence in ms. Default 60_000. Set 0 to disable. */
  tickIntervalMs?: number;
  /** Heartbeat interval forwarded to `WSGateway`. */
  heartbeatMs?: number;
  /** Optional injectable logger (defaults to `console`). */
  logger?: GameLogger;
  /** Optional override for `verifyWallet`'s `app` name. Default `astroid.club`. */
  appName?: string;
  /**
   * Optional wallet allowlist. When non-empty, ONLY these wallet
   * addresses may authenticate; every other wallet is rejected after a
   * valid signature. Empty/omitted means no allowlist. Use it to lock a
   * preview/test deploy to your own wallets.
   */
  walletAllowlist?: readonly string[];
  /**
   * Optional durable refund hook. When a wager deposit is verified on-chain
   * but the raid can't launch, the gateway calls this (instead of a bare
   * fire-and-forget chain return) so the refund is recorded + retried by the
   * escrow outbox rather than silently lost on a chain failure.
   */
  onWagerRefund?: (walletAddress: string, amount: number, wagerId: string) => void;
  /**
   * Optional comp/bypass list. Wallets in it skip the holder gate (treated as
   * `qualified` in `verify_holder`) while everyone else is gated normally —
   * it grants access, it never restricts it. Operator-managed + live-editable
   * from the admin console.
   */
  compWallets?: CompWalletService;
}

/** What we stash on `conn.meta`. */
interface ConnectionMeta extends Record<string, unknown> {
  walletAddress?: string;
  /** Message type currently being dispatched; used for failed-action logging. */
  currentAction?: string;
  /**
   * The atomic redeem swap this connection most recently had built and is
   * expected to sign + return via `submit_redeem_swap`. Cached server-side so
   * the co-signer can prove the wallet-signed tx is byte-identical to the one
   * we issued before adding the treasury signature. Single-use + short-lived.
   */
  pendingRedeem?: {
    transaction: string;
    blockhash: string;
    lastValidBlockHeight: number;
    expiresAt: number;
  };
  /**
   * The raid wager this connection most recently had a deposit built for and
   * is expected to fund + confirm via `submit_wager_raid`. The wagerId,
   * target, and amount are SERVER-trusted (the submit body only carries the
   * deposit signature) so a client can't redirect the raid or under-pay.
   * Single-use + short-lived.
   */
  pendingWager?: {
    wagerId: string;
    targetAsteroidId: string;
    amount: number;
    expiresAt: number;
  };
}

/**
 * How long an issued redeem swap stays valid for `submit_redeem_swap`. Tied to
 * blockhash validity (~60–90s) — past this the user must rebuild.
 */
const REDEEM_PENDING_TTL_MS = 90_000;

/**
 * How long an issued wager deposit stays valid for `submit_wager_raid`. A bit
 * longer than the redeem window because the wallet must also broadcast +
 * confirm the deposit on-chain before submitting the signature back.
 */
const WAGER_PENDING_TTL_MS = 180_000;

/**
 * Composes `WSGateway` + zod `Protocol` + `WalletVerifier` into a
 * single mountable unit. Owns its tick interval; close cleanly via
 * `stop()` for graceful shutdowns.
 */
export class AstroidGateway {
  readonly underlying: WSGateway;
  readonly world: GameWorld;

  private readonly verifier: WalletVerifier;
  private readonly chainOps: ChainOps | null;
  private readonly tickIntervalMs: number;
  private readonly log: GameLogger;
  private readonly appName: string;
  private readonly walletAllowlist: ReadonlySet<string>;
  private readonly compWallets?: CompWalletService;
  private readonly onWagerRefund?: (
    walletAddress: string,
    amount: number,
    wagerId: string,
  ) => void;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: AstroidGatewayOptions) {
    this.world = options.world;
    // Let the world push gameplay events (raid started/resolved) to every
    // connected client through the gateway's broadcast channel.
    this.world.setBroadcaster((event, data) => this.broadcastEvent(event, data));
    this.chainOps = options.chainOps ?? null;
    this.tickIntervalMs = options.tickIntervalMs ?? 60_000;
    this.log = options.logger ?? defaultLogger();
    this.appName = options.appName ?? 'astroid.club';
    this.walletAllowlist = new Set(options.walletAllowlist ?? []);
    this.compWallets = options.compWallets;
    this.onWagerRefund = options.onWagerRefund;
    if (this.walletAllowlist.size > 0) {
      this.log.warn(
        `[gateway] wallet allowlist active — ${this.walletAllowlist.size} wallet(s) ` +
          `permitted; all others rejected at auth.`,
      );
    }

    this.verifier =
      options.walletVerifier ??
      new WalletVerifier({
        app: this.appName,
        ...(options.walletVerifierStorage && { storage: options.walletVerifierStorage }),
      });

    const protocol = createAstroidProtocol() as unknown as Protocol;
    const gatewayOptions: WSGatewayOptions = {
      protocol,
      ...(options.server ? { server: options.server } : {}),
      ...(options.server ? {} : { port: options.port ?? 3002 }),
      ...(options.host && { host: options.host }),
      ...(options.rateLimit && { rateLimit: options.rateLimit }),
      ...(options.heartbeatMs !== undefined && { heartbeatMs: options.heartbeatMs }),
    };
    this.underlying = new WSGateway(gatewayOptions);

    this.underlying.events.on('connection', (conn) => this.onConnection(conn));
    this.underlying.events.on('disconnect', (conn) => this.onDisconnect(conn));
    this.underlying.events.on('message', (conn, msg) => {
      void this.onMessage(conn, msg);
    });
    this.underlying.events.on('invalid', (conn, _raw, error) => {
      conn.send({
        type: 'error',
        code: 'invalid_message',
        message: error,
      } satisfies ErrorEnvelope);
    });
  }

  /** Begin the maintenance tick. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.world.start();
    if (this.tickIntervalMs > 0) {
      this.tickHandle = setInterval(() => {
        try {
          this.world.tick();
        } catch (err) {
          this.log.error('[AstroidGateway] tick failed:', err);
        }
      }, this.tickIntervalMs);
    }
    this.log.info(
      `[AstroidGateway] started (tickIntervalMs=${this.tickIntervalMs}, app=${this.appName})`,
    );
  }

  /** Stop the maintenance tick and close all connections. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = null;
    this.world.stop();
    this.underlying.close();
    this.log.info('[AstroidGateway] stopped');
  }

  /** Broadcast a server-pushed event to every connected client. */
  broadcastEvent<T>(event: string, data: T): void {
    const envelope: EventEnvelope<T> = { type: 'event', event, data };
    this.underlying.broadcast(envelope);
  }

  // --------- Internal: connection lifecycle ---------

  private onConnection(conn: Connection): void {
    this.log.info(`[AstroidGateway] connection from ${conn.ip}`);
    if (!this.world.antiCheat.checkConnection(ANONYMOUS_WALLET, conn.ip)) {
      conn.send({
        type: 'error',
        code: 'rate_limited',
        message: 'too many connections from your IP',
      } satisfies ErrorEnvelope);
      conn.close(1008, 'connection-cap');
      return;
    }
  }

  private onDisconnect(conn: Connection): void {
    const meta = conn.meta as ConnectionMeta;
    if (meta.walletAddress) {
      this.world.disconnectPlayer(meta.walletAddress);
      this.world.antiCheat.recordDisconnect(meta.walletAddress, conn.ip);
    } else {
      this.world.antiCheat.recordDisconnect(ANONYMOUS_WALLET, conn.ip);
    }
  }

  // --------- Internal: message dispatch ---------

  private async onMessage(conn: Connection, raw: unknown): Promise<void> {
    const parsed = GameMessage.safeParse(raw);
    if (!parsed.success) {
      // Engine's WSGateway already filtered control messages; anything
      // it forwards here that doesn't match `GameMessage` is a client
      // mistake or hostile traffic.
      conn.send({
        type: 'error',
        code: 'invalid_message',
        message: parsed.error.issues.map((i) => i.message).join(', '),
      } satisfies ErrorEnvelope);
      return;
    }

    const message = parsed.data;
    const requestId = message.requestId;
    const meta = conn.meta as ConnectionMeta;

    // Auth gate (mirrors `requiresAuth` from the protocol module).
    if (POST_AUTH_TYPES.has(message.type) && !meta.walletAddress) {
      this.replyError(conn, requestId, 'not_authenticated', 'connect first');
      return;
    }

    // Per-action rate limit (anti-cheat, separate from connection-level
    // limiter inside `WSGateway`).
    //
    // Read-only message types are exempt: they don't change state, the
    // server can serve them cheaply (in-memory snapshots), and the UI
    // polls them to keep its HUD live. Counting `miner_snapshot` /
    // `network_stats` against the per-wallet action budget would mean
    // any reasonably-paced HUD poll burns through the budget in
    // seconds and locks the user out of the arena — exactly the
    // symptom that motivated this exemption. State-changing actions
    // (`stake`, `start_expedition`, etc.) still count fully.
    const wallet = meta.walletAddress ?? ANONYMOUS_WALLET;
    // Remember what we're dispatching so failed-action logging can name the
    // offending message instead of an opaque "Failed action #N".
    meta.currentAction = message.type;
    if (!READONLY_MESSAGE_TYPES.has(message.type)) {
      const rl = this.world.antiCheat.checkAction(wallet, conn.ip);
      if (!rl.allowed) {
        this.replyError(conn, requestId, 'rate_limited', rl.reason ?? 'rate limited');
        return;
      }
    }

    try {
      await this.dispatch(conn, message);
    } catch (err) {
      this.world.antiCheat.recordFailedAction(wallet, message.type);
      this.log.error(`[AstroidGateway] dispatch error on '${message.type}':`, err);
      this.replyError(
        conn,
        requestId,
        'rejected',
        err instanceof Error ? err.message : 'internal error',
      );
    }
  }

  private async dispatch(conn: Connection, message: GameMessageT): Promise<void> {
    const meta = conn.meta as ConnectionMeta;
    const requestId = message.requestId;

    switch (message.type) {
      case 'request_nonce': {
        const nonce = await this.verifier.issueNonce(message.walletAddress);
        // Build the signable message with `timestamp: 0`. The engine's
        // `WalletVerifier.verifySignedAction` reconstructs and verifies
        // against the same canonical form (timestamp pinned to 0); using
        // `createSignatureMessage` would stamp `Date.now()` and fail to
        // match server-side reconstruction.
        const canonical = JSON.stringify({
          app: this.appName,
          action: 'auth',
          nonce,
          timestamp: 0,
        });
        const data: NonceIssuedData = {
          nonce,
          walletAddress: message.walletAddress,
          message: canonical,
          app: this.appName,
          ttlMs: 5 * 60 * 1000,
        };
        this.replyOk(conn, requestId, data);
        return;
      }
      case 'auth': {
        const ok = await this.verifier.verifySignedAction({
          walletAddress: message.walletAddress,
          action: 'auth',
          nonce: message.nonce,
          signature: message.signature,
        });
        if (!ok) {
          this.replyError(conn, requestId, 'rejected', 'signature verification failed');
          return;
        }
        if (this.walletAllowlist.size > 0 && !this.walletAllowlist.has(message.walletAddress)) {
          this.log.warn(
            `[gateway] auth rejected: ${message.walletAddress.slice(0, 8)}… not on the allowlist`,
          );
          // Public-facing copy: the wallet IS valid, it just isn't in the
          // closed-beta allowlist yet. Surface it as an intentional "not open
          // to everyone yet" notice (code `beta_locked`) rather than a scary
          // auth failure, so the apex CTA reads as "coming soon" for the public
          // while allowlisted testers pass straight through.
          this.replyError(
            conn,
            requestId,
            'beta_locked',
            'Public entry opens soon — access is limited to the closed beta right now.',
          );
          return;
        }
        meta.walletAddress = message.walletAddress;
        // Now that the wallet is known, register it for sybil tracking and the
        // wallet→IP lookup (failed-action logs were showing "from unknown"
        // because the IP was only ever keyed under the anonymous sentinel).
        this.world.antiCheat.registerAuthenticatedConnection(message.walletAddress, conn.ip);
        const result = await this.world.connectPlayer(message.walletAddress);
        this.relay(conn, requestId, result);
        // Seed the in-game stake tier from the wallet's on-chain Quarry
        // position so drill-power/defense buffs apply from the first action
        // (best-effort; no-op when Quarry is disabled).
        if (result.ok) {
          void this.reconcileOnChainStake(message.walletAddress);
        }
        return;
      }
      case 'join_asteroid':
        this.relay(
          conn,
          requestId,
          this.world.joinAsteroid(meta.walletAddress!, message.asteroidId),
        );
        return;
      case 'leave_asteroid':
        this.relay(conn, requestId, this.world.leaveAsteroid(meta.walletAddress!));
        return;
      case 'set_home_station':
        this.relay(
          conn,
          requestId,
          this.world.setHomeStation(meta.walletAddress!, message.asteroidId),
        );
        return;
      case 'report_drill_power':
        this.relay(
          conn,
          requestId,
          this.world.reportDrillPower(meta.walletAddress!, message.drillPower),
        );
        return;
      case 'stake':
        this.relay(
          conn,
          requestId,
          this.world.stake(meta.walletAddress!, message.asteroidId, message.amount),
        );
        return;
      case 'unstake':
        this.relay(
          conn,
          requestId,
          this.world.unstake(meta.walletAddress!, message.asteroidId, message.amount),
        );
        return;
      case 'build_stake_tx': {
        await this.forwardBuild(conn, requestId, (ops, wallet) =>
          ops.buildStakeTx(wallet, message.amount),
        );
        return;
      }
      case 'build_unstake_tx': {
        await this.forwardBuild(conn, requestId, (ops, wallet) =>
          ops.buildUnstakeTx(wallet, message.amount),
        );
        return;
      }
      case 'build_claim_tx': {
        await this.forwardBuild(conn, requestId, (ops, wallet) => ops.buildClaimTx(wallet));
        return;
      }
      case 'build_redeem_tx': {
        await this.handleBuildRedeem(conn, requestId, message.amount);
        return;
      }
      case 'submit_redeem_swap': {
        await this.handleSubmitRedeemSwap(conn, requestId, message.signedTransaction);
        return;
      }
      case 'bridge_iou': {
        await this.handleBridgeIou(conn, requestId, meta.walletAddress!, message.amount);
        return;
      }
      case 'verify_stake_tx': {
        await this.forwardQuery(conn, requestId, async (ops, wallet) => {
          const result = await ops.verifyStakeTx(message.signature, wallet, message.amount);
          // A verified stake changes the on-chain position; re-read the
          // authoritative total and reconcile the in-game tier. Guarded so a
          // failed follow-up read can't turn a good verification into an error.
          if (!result.disabled && result.data?.verified) {
            try {
              await this.syncStakeFromChain(ops, wallet);
            } catch {
              /* best-effort reconcile; verification result still stands */
            }
          }
          return result;
        });
        return;
      }
      case 'stake_info': {
        await this.forwardQuery(conn, requestId, async (ops, wallet) => {
          const result = await ops.getStakeInfo(wallet);
          // The client refreshes stake_info after every stake/unstake/claim,
          // so this read doubles as the reconcile trigger at zero extra cost.
          if (!result.disabled && result.data) {
            this.world.syncOnChainStake(wallet, result.data.stakedAmount);
          }
          return result;
        });
        return;
      }
      case 'start_expedition':
        this.relay(
          conn,
          requestId,
          this.world.startExpedition(
            meta.walletAddress!,
            message.targetAsteroidId,
            message.betAmount,
          ),
        );
        return;
      case 'leave_expedition':
        this.relay(conn, requestId, this.world.leaveExpedition(meta.walletAddress!));
        return;
      case 'build_wager_deposit': {
        await this.handleBuildWagerDeposit(
          conn,
          requestId,
          message.targetAsteroidId,
          message.amount,
        );
        return;
      }
      case 'submit_wager_raid': {
        await this.handleSubmitWagerRaid(conn, requestId, message.signature);
        return;
      }
      case 'rally_defense':
        this.relay(
          conn,
          requestId,
          this.world.rallyDefense(meta.walletAddress!, message.asteroidId, message.tokenCost),
        );
        return;
      case 'deflect_meteor':
        this.relay(
          conn,
          requestId,
          this.world.deflectMeteor(meta.walletAddress!, message.meteorId),
        );
        return;
      case 'claim_yield':
        this.relay(conn, requestId, this.world.claimPendingYield(meta.walletAddress!));
        return;
      case 'network_stats':
        this.replyOk(conn, requestId, this.world.getNetworkStats());
        return;
      case 'miner_snapshot':
        this.relay(conn, requestId, this.world.getMinerSnapshot(meta.walletAddress!));
        return;
      case 'verify_holder': {
        const wallet = meta.walletAddress!;
        const data = await this.runHolderVerification(wallet);
        this.replyOk(conn, requestId, data);
        return;
      }
      default: {
        const exhaustive: never = message;
        void exhaustive;
        this.replyError(conn, requestId, 'rejected', 'unknown message type');
      }
    }
  }

  /**
   * Execute the read-only holder check for `walletAddress` and shape
   * the result into the wire envelope. Three branches:
   *
   *   - chain disabled (no `chainOps` provided OR `CHAIN_ENABLED=false`)
   *     → eligible, reason `chain_disabled`. Lets local dev / pre-launch
   *     traffic exercise the Club gate without a real RPC.
   *   - chain on, qualified → eligible, reason `qualified`.
   *   - chain on, not qualified → not eligible, reason `not_qualified`.
   *     We deliberately don't echo the balance / threshold back; the
   *     check is a binary gate and copy points users at the spec.
   *
   * RPC errors propagate up to `dispatch`'s try/catch and surface as a
   * generic `error` envelope. Anti-cheat backoff applies.
   */
  private async runHolderVerification(walletAddress: string): Promise<HolderEligibilityData> {
    // Comp list: wallets the operator has comped past the holder gate (team,
    // partners, testers). Checked first so they pass regardless of holdings.
    if (this.compWallets?.has(walletAddress)) {
      return {
        eligible: true,
        reason: 'qualified',
        walletAddress,
        message: 'Access granted (comped). Welcome to the Club.',
      };
    }
    if (!this.chainOps) {
      return {
        eligible: true,
        reason: 'chain_disabled',
        walletAddress,
        message:
          'Holder verification is in dev mode. All authenticated wallets are treated as eligible.',
      };
    }
    const result = await this.chainOps.verifyHolderQualified(walletAddress);
    if (result.disabled) {
      return {
        eligible: true,
        reason: 'chain_disabled',
        walletAddress,
        message:
          'Holder verification is in dev mode. All authenticated wallets are treated as eligible.',
      };
    }
    if (result.data.qualified) {
      return {
        eligible: true,
        reason: 'qualified',
        walletAddress,
        message: 'Holder verification passed. Welcome to the Club.',
      };
    }
    // A new holder who clears the balance but is still inside the hold-time
    // window gets a countdown so the UI can show "access unlocks in mm:ss".
    // Below-threshold wallets get the generic threshold copy (no countdown).
    const inHoldWindow = result.data.remainingHoldMs > 0;
    return {
      eligible: false,
      reason: 'not_qualified',
      walletAddress,
      remainingHoldMs: inHoldWindow ? result.data.remainingHoldMs : undefined,
      message: inHoldWindow
        ? 'You hold enough $ASTROID. Arena access unlocks after a short hold window.'
        : 'This wallet does not currently meet the holder threshold or hold-time requirement.',
    };
  }

  // --------- On-chain staking helpers ---------

  /**
   * Run a transaction-builder ChainOp for the authenticated wallet and
   * forward the result. Three branches mirror `runHolderVerification`:
   *   - no `chainOps` / chain off → `chain_disabled` error.
   *   - builder returned `{ error }` → `rejected` error (counts as a
   *     failed action for anti-cheat backoff).
   *   - builder returned a tx → `result` envelope with the unsigned
   *     serialized transaction.
   */
  private async forwardBuild<T extends TransactionBuildResult>(
    conn: Connection,
    requestId: string | undefined,
    run: (ops: ChainOps, wallet: string) => Promise<ChainQueryResult<T | BuildError>>,
  ): Promise<void> {
    const wallet = (conn.meta as ConnectionMeta).walletAddress!;
    if (!this.chainOps) {
      this.replyError(conn, requestId, 'chain_disabled', 'On-chain staking is not enabled.');
      return;
    }
    let result: ChainQueryResult<T | BuildError>;
    try {
      result = await run(this.chainOps, wallet);
    } catch (err) {
      if (err instanceof ChainOpNotImplementedError) {
        this.replyError(conn, requestId, 'chain_disabled', STAKING_UNAVAILABLE_MESSAGE);
        return;
      }
      throw err;
    }
    if (result.disabled) {
      this.replyError(conn, requestId, 'chain_disabled', result.message);
      return;
    }
    if (isBuildError(result.data)) {
      this.world.antiCheat.recordFailedAction(wallet, (conn.meta as ConnectionMeta).currentAction);
      this.replyError(conn, requestId, 'rejected', result.data.error);
      return;
    }
    this.replyOk(conn, requestId, result.data);
  }

  /**
   * Build a redeem swap. Mirrors {@link forwardBuild}, but when the builder
   * marks the tx `requiresCoSign` (the atomic IOU↔$ASTROID swap), cache the
   * issued transaction on the connection so the later `submit_redeem_swap`
   * can prove the wallet-signed tx is byte-identical before the treasury
   * co-signs. The wallet must sign WITHOUT broadcasting and return it.
   */
  private async handleBuildRedeem(
    conn: Connection,
    requestId: string | undefined,
    amount: number,
  ): Promise<void> {
    const wallet = (conn.meta as ConnectionMeta).walletAddress!;
    if (!this.chainOps) {
      this.replyError(conn, requestId, 'chain_disabled', 'On-chain staking is not enabled.');
      return;
    }
    let result: ChainQueryResult<TransactionBuildResult | BuildError>;
    try {
      result = await this.chainOps.buildRedeemTx(wallet, amount);
    } catch (err) {
      if (err instanceof ChainOpNotImplementedError) {
        this.replyError(conn, requestId, 'chain_disabled', STAKING_UNAVAILABLE_MESSAGE);
        return;
      }
      throw err;
    }
    if (result.disabled) {
      this.replyError(conn, requestId, 'chain_disabled', result.message);
      return;
    }
    if (isBuildError(result.data)) {
      this.world.antiCheat.recordFailedAction(wallet, (conn.meta as ConnectionMeta).currentAction);
      this.replyError(conn, requestId, 'rejected', result.data.error);
      return;
    }
    const data = result.data;
    if (data.requiresCoSign) {
      (conn.meta as ConnectionMeta).pendingRedeem = {
        transaction: data.transaction,
        blockhash: data.blockhash,
        lastValidBlockHeight: data.lastValidBlockHeight,
        expiresAt: Date.now() + REDEEM_PENDING_TTL_MS,
      };
    }
    this.replyOk(conn, requestId, data);
  }

  /**
   * Co-sign + submit a wallet-signed atomic redeem swap. The wallet signed the
   * exact tx we issued in `handleBuildRedeem` (cached as `pendingRedeem`); we
   * hand both to the redeemer, which verifies the messages match before adding
   * the treasury signature and broadcasting. A failure here is benign (the
   * user still holds their IOU and can retry), so it never trips anti-cheat.
   */
  private async handleSubmitRedeemSwap(
    conn: Connection,
    requestId: string | undefined,
    signedTransaction: string,
  ): Promise<void> {
    if (!this.chainOps) {
      this.replyError(conn, requestId, 'chain_disabled', 'On-chain redemption is not enabled.');
      return;
    }
    const meta = conn.meta as ConnectionMeta;
    const pending = meta.pendingRedeem;
    // Single-use: clear it now whether or not submission succeeds, so a stale
    // entry can't be reused against a new (or replayed) signed transaction.
    meta.pendingRedeem = undefined;
    if (!pending || pending.expiresAt < Date.now()) {
      this.replyError(
        conn,
        requestId,
        'rejected',
        'No redeem to submit (it may have expired). Rebuild the redeem and sign again.',
      );
      return;
    }

    let result: ChainTxResult;
    try {
      result = await this.chainOps.coSignAndSubmitRedeem(meta.walletAddress!, {
        builtTransaction: pending.transaction,
        signedTransaction,
        blockhash: pending.blockhash,
        lastValidBlockHeight: pending.lastValidBlockHeight,
      });
    } catch (err) {
      if (err instanceof ChainOpNotImplementedError) {
        this.replyError(conn, requestId, 'chain_disabled', STAKING_UNAVAILABLE_MESSAGE);
        return;
      }
      this.replyError(
        conn,
        requestId,
        'rejected',
        err instanceof Error ? err.message : 'redeem submit failed',
      );
      return;
    }

    if (result.disabled) {
      this.replyError(conn, requestId, 'chain_disabled', result.message);
      return;
    }
    this.replyOk(conn, requestId, { signature: result.signature });
  }

  /**
   * Build a wager deposit (step 1 of an on-chain wagered raid). Pre-validates
   * the raid so we never charge a deposit for a doomed one, mints a
   * server-side `wagerId`, and asks `ChainOps` to build the UNSIGNED deposit
   * tx. The wallet signs + submits it itself (the wallet owns the source — no
   * co-sign), then calls `submit_wager_raid` with the signature. The wager
   * (wagerId / target / amount) is cached server-side so the submit can't be
   * redirected or under-paid.
   */
  private async handleBuildWagerDeposit(
    conn: Connection,
    requestId: string | undefined,
    targetAsteroidId: string,
    amount: number,
  ): Promise<void> {
    const meta = conn.meta as ConnectionMeta;
    const wallet = meta.walletAddress!;
    if (!this.chainOps) {
      this.replyError(conn, requestId, 'chain_disabled', 'On-chain wagers are not enabled.');
      return;
    }
    // Reject a second build while a wager is still pending: building a new
    // deposit would overwrite the cached wager, so a deposit already broadcast
    // for the first wagerId could never be matched at submit (memo mismatch)
    // and the tokens would be stranded. Force the player to submit or let the
    // current one expire first.
    if (meta.pendingWager && meta.pendingWager.expiresAt >= Date.now()) {
      this.replyError(
        conn,
        requestId,
        'rejected',
        'You already have a wager deposit awaiting submission. Sign and submit it, ' +
          'or wait for it to expire before starting another.',
      );
      return;
    }
    // Pre-flight the raid BEFORE touching funds — surface the specific reason.
    const preview = this.world.previewExpedition(wallet, targetAsteroidId);
    if (!preview.ok) {
      this.replyError(conn, requestId, preview.code, preview.message);
      return;
    }

    const wagerId = uuidv4();
    let result: Awaited<ReturnType<ChainOps['buildBetEscrowDeposit']>>;
    try {
      result = await this.chainOps.buildBetEscrowDeposit(wallet, amount, wagerId);
    } catch (err) {
      if (err instanceof ChainOpNotImplementedError) {
        this.replyError(conn, requestId, 'chain_disabled', 'On-chain wagers are not enabled.');
        return;
      }
      // The builder throws on a recoverable problem (e.g. insufficient wallet
      // balance) with a sanitized message — surface it as a plain rejection.
      this.replyError(
        conn,
        requestId,
        'rejected',
        err instanceof Error ? err.message : 'failed to build wager deposit',
      );
      return;
    }
    if (result.disabled) {
      this.replyError(conn, requestId, 'chain_disabled', result.message);
      return;
    }

    meta.pendingWager = {
      wagerId,
      targetAsteroidId,
      amount,
      expiresAt: Date.now() + WAGER_PENDING_TTL_MS,
    };
    this.replyOk(conn, requestId, {
      transaction: result.serializedTx,
      amount: result.amount,
      wagerId,
      blockhash: result.blockhash,
      lastValidBlockHeight: result.lastValidBlockHeight,
    });
  }

  /**
   * Submit a wallet-funded wager deposit (step 2). Verifies the deposit landed
   * (confirmation + memo + escrow balance delta) against the cached wager,
   * then launches the raid with the escrowed wager. If the raid can't start
   * after a verified deposit (e.g. a cooldown started in the window), the
   * escrow is returned so the player never loses tokens to a no-op.
   */
  private async handleSubmitWagerRaid(
    conn: Connection,
    requestId: string | undefined,
    signature: string,
  ): Promise<void> {
    const meta = conn.meta as ConnectionMeta;
    const wallet = meta.walletAddress!;
    if (!this.chainOps) {
      this.replyError(conn, requestId, 'chain_disabled', 'On-chain wagers are not enabled.');
      return;
    }
    const pending = meta.pendingWager;
    // Single-use: clear now so a stale entry can't be reused / replayed.
    meta.pendingWager = undefined;
    if (!pending || pending.expiresAt < Date.now()) {
      this.replyError(
        conn,
        requestId,
        'rejected',
        'No wager to submit (it may have expired). Rebuild the wager and sign again.',
      );
      return;
    }

    let verified: ChainQueryResult<boolean>;
    try {
      verified = await this.chainOps.verifyBetEscrowDeposit(
        signature,
        wallet,
        pending.amount,
        pending.wagerId,
      );
    } catch (err) {
      if (err instanceof ChainOpNotImplementedError) {
        this.replyError(conn, requestId, 'chain_disabled', 'On-chain wagers are not enabled.');
        return;
      }
      this.replyError(
        conn,
        requestId,
        'rejected',
        err instanceof Error ? err.message : 'wager verification failed',
      );
      return;
    }
    if (verified.disabled) {
      this.replyError(conn, requestId, 'chain_disabled', verified.message);
      return;
    }
    if (!verified.data) {
      this.replyError(
        conn,
        requestId,
        'rejected',
        'Could not verify your wager deposit on-chain. If tokens left your wallet, ' +
          'do not retry — contact support so the escrow can be returned.',
      );
      return;
    }

    // Deposit confirmed → launch the raid with the escrowed wager.
    const started = this.world.startExpedition(wallet, pending.targetAsteroidId, 0, {
      wagerId: pending.wagerId,
      amount: pending.amount,
      txSignature: signature,
    });
    if (started.ok) {
      this.replyOk(conn, requestId, started.data);
      return;
    }

    // The deposit landed but the raid couldn't start (rare: state changed in
    // the deposit window). Return the escrow so the player isn't out of pocket.
    // Prefer the durable refund hook (recorded + retried by the escrow outbox);
    // fall back to a best-effort chain return if no manager is wired.
    if (this.onWagerRefund) {
      this.onWagerRefund(wallet, pending.amount, pending.wagerId);
    } else {
      this.chainOps
        .returnBetEscrow(wallet, pending.amount, pending.wagerId)
        .then((r) => {
          if (!r.disabled) {
            this.log.info(
              `[AstroidGateway] returned un-launched wager ${pending.wagerId.slice(0, 8)}… ` +
                `(${pending.amount}) to ${wallet.slice(0, 8)}…`,
            );
          }
        })
        .catch((err) => this.log.error('[AstroidGateway] wager auto-return failed:', err));
    }
    this.replyError(
      conn,
      requestId,
      started.code,
      `${started.message} — your wager deposit is being returned.`,
    );
  }

  /**
   * Bridge `amount` of a wallet's in-game IOU credits to on-chain
   * IOU-ASTROID. Debits the in-game ledger FIRST (synchronous + balance
   * checked, so concurrent requests can't double-spend), then runs the
   * server-signed treasury transfer. On any chain-side failure the credit
   * is refunded so the player never loses it without receiving the token.
   */
  private async handleBridgeIou(
    conn: Connection,
    requestId: string | undefined,
    wallet: string,
    amount: number,
  ): Promise<void> {
    if (!this.chainOps) {
      this.replyError(conn, requestId, 'chain_disabled', 'On-chain bridging is not enabled.');
      return;
    }
    // Debit in-game credits up front. Reject (no chain call) if the wallet
    // lacks the balance.
    const debit = this.world.bridgeDebit(wallet, amount);
    if (!debit.ok) {
      this.replyError(conn, requestId, debit.code, debit.message);
      return;
    }

    let result: ChainTxResult;
    try {
      result = await this.chainOps.bridgeIou(wallet, amount);
    } catch (err) {
      this.world.bridgeRefund(wallet, amount);
      if (err instanceof ChainOpNotImplementedError) {
        this.replyError(conn, requestId, 'chain_disabled', STAKING_UNAVAILABLE_MESSAGE);
        return;
      }
      // A chain-side bridge failure is transient (RPC hiccup, blockhash
      // expiry) and the in-game credit was already refunded above, so the
      // player can simply retry. Do NOT record an anti-cheat failure here —
      // backoff would block that retry (and their claim).
      this.replyError(
        conn,
        requestId,
        'rejected',
        err instanceof Error ? err.message : 'bridge failed',
      );
      return;
    }

    if (result.disabled) {
      this.world.bridgeRefund(wallet, amount);
      this.replyError(conn, requestId, 'chain_disabled', result.message);
      return;
    }
    this.replyOk(conn, requestId, { signature: result.signature, bridged: amount });
  }

  /**
   * Run a read-only / verification ChainOp for the authenticated wallet
   * and forward the data verbatim. The result payload (e.g.
   * `StakeVerification`, `UserStakeInfo`) carries its own success
   * semantics; the gateway only distinguishes chain-disabled.
   */
  private async forwardQuery<T>(
    conn: Connection,
    requestId: string | undefined,
    run: (ops: ChainOps, wallet: string) => Promise<ChainQueryResult<T>>,
  ): Promise<void> {
    const wallet = (conn.meta as ConnectionMeta).walletAddress!;
    if (!this.chainOps) {
      this.replyError(conn, requestId, 'chain_disabled', 'On-chain staking is not enabled.');
      return;
    }
    let result: ChainQueryResult<T>;
    try {
      result = await run(this.chainOps, wallet);
    } catch (err) {
      if (err instanceof ChainOpNotImplementedError) {
        this.replyError(conn, requestId, 'chain_disabled', STAKING_UNAVAILABLE_MESSAGE);
        return;
      }
      throw err;
    }
    if (result.disabled) {
      this.replyError(conn, requestId, 'chain_disabled', result.message);
      return;
    }
    this.replyOk(conn, requestId, result.data);
  }

  /**
   * Best-effort read of a wallet's on-chain Quarry stake, reconciled into
   * the in-game tier. Swallows transport / not-implemented / disabled
   * errors: the worst case is the tier keeps its last known value. No-op
   * when no chain ops are wired.
   */
  private async reconcileOnChainStake(walletAddress: string): Promise<void> {
    if (!this.chainOps) return;
    try {
      await this.syncStakeFromChain(this.chainOps, walletAddress);
    } catch {
      /* tier just stays at its last reconciled value */
    }
  }

  /** Read `get_stake_info` via `ops` and push the total into the world. */
  private async syncStakeFromChain(ops: ChainOps, walletAddress: string): Promise<void> {
    const info = await ops.getStakeInfo(walletAddress);
    if (!info.disabled && info.data) {
      this.world.syncOnChainStake(walletAddress, info.data.stakedAmount);
    }
  }

  // --------- Wire helpers ---------

  /** Forward a `WorldResult` onto the wire as `result` or `error`. */
  private relay<T>(conn: Connection, requestId: string | undefined, result: WorldResult<T>): void {
    if (result.ok) {
      this.replyOk(conn, requestId, result.data);
    } else {
      if (!BENIGN_FAILURE_CODES.has(result.code)) {
        this.world.antiCheat.recordFailedAction(
          this.walletForConn(conn),
          (conn.meta as ConnectionMeta).currentAction,
        );
      }
      this.replyError(conn, requestId, result.code, result.message);
    }
  }

  private replyOk<T>(conn: Connection, requestId: string | undefined, data: T): void {
    const envelope: ResultEnvelope<T> = { type: 'result', data };
    if (requestId !== undefined) envelope.requestId = requestId;
    conn.send(envelope);

    const wallet = this.walletForConn(conn);
    this.world.antiCheat.recordSuccessfulAction(wallet);
  }

  private replyError(
    conn: Connection,
    requestId: string | undefined,
    code: string,
    message: string,
  ): void {
    const envelope: ErrorEnvelope = { type: 'error', code, message };
    if (requestId !== undefined) envelope.requestId = requestId;
    conn.send(envelope);
  }

  private walletForConn(conn: Connection): string {
    return (conn.meta as ConnectionMeta).walletAddress ?? ANONYMOUS_WALLET;
  }
}

// --------- Public type re-exports for downstream consumers ---------

export type { GameMessageType };

/**
 * Local guard for the builder `{ error }` shape. Defined here (rather
 * than imported from `staking.ts`) so the gateway never pulls the
 * web3/Quarry SDK onto its always-loaded path — only the erased type
 * is imported.
 */
function isBuildError(v: TransactionBuildResult | BuildError): v is BuildError {
  return 'error' in v && typeof (v as BuildError).error === 'string';
}

function defaultLogger(): GameLogger {
  return {
    info: (msg, ...rest) => console.info(msg, ...rest),
    warn: (msg, ...rest) => console.warn(msg, ...rest),
    error: (msg, ...rest) => console.error(msg, ...rest),
  };
}
