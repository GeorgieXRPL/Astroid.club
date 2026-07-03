/**
 * astroid.club wire protocol.
 *
 * Defines the discriminated union of game-specific messages
 * (client → server) and the helpers a `WSGateway` uses to validate
 * them. The engine's `Protocol` already handles control messages
 * (`hello` / `join` / `leave` / `ping` / `pong` / `error`); this
 * module plugs the game schema into that.
 *
 * Conventions:
 * - Every message has a `type` literal.
 * - Every message MAY include an optional `requestId` so clients can
 *   correlate `result` / `error` envelopes with their causing request.
 * - Wallet addresses, nonces, and signatures use the engine's reusable
 *   primitives where possible (`SolanaAddress`, `UuidLike`).
 * - `signature` is base64; the engine's `WalletVerifier` decodes it.
 *
 * Wire envelopes from server → client are NOT validated here (the
 * server is the only one that produces them); they're typed in
 * `gateway.ts` for use by clients.
 */

import { Protocol, SolanaAddress, UuidLike } from 'game-engine-enhanced/net';
import { z } from 'zod';

/** Optional request id used for client-side correlation. */
const RequestId = z.string().min(1).max(64).optional();

// ---------- Auth flow ----------

/**
 * Client requests a fresh nonce for `walletAddress`. Server replies
 * with `result { nonce }`. Nonces are single-use, tied to the wallet,
 * and expire after 5 minutes (engine default).
 */
export const RequestNonceMessage = z.object({
  type: z.literal('request_nonce'),
  requestId: RequestId,
  walletAddress: SolanaAddress,
});

/**
 * Client authenticates using a nonce-bound signature. On success the
 * gateway stamps `walletAddress` onto the connection metadata so all
 * subsequent game messages are post-auth.
 */
export const AuthMessage = z.object({
  type: z.literal('auth'),
  requestId: RequestId,
  walletAddress: SolanaAddress,
  nonce: z.string().min(1).max(128),
  /** Detached tweetnacl signature, base64-encoded. */
  signature: z.string().min(1).max(256),
});

// ---------- Asteroid actions ----------

const AsteroidIdField = z.string().min(1).max(64);

export const JoinAsteroidMessage = z.object({
  type: z.literal('join_asteroid'),
  requestId: RequestId,
  asteroidId: AsteroidIdField,
});

export const LeaveAsteroidMessage = z.object({
  type: z.literal('leave_asteroid'),
  requestId: RequestId,
});

export const SetHomeStationMessage = z.object({
  type: z.literal('set_home_station'),
  requestId: RequestId,
  asteroidId: AsteroidIdField,
});

/**
 * Hard ceiling on a single wallet's self-reported base drill power. Drill
 * power is an unverified client number (no on-chain PoW), so without a cap a
 * crafted client can report an absurd value (e.g. 1e16) that overflows safe
 * integer precision, dominates the network total, and warps discovery rates.
 * 10M is ~2000x the reference solo power (5000) — generous headroom for the
 * future CPU/phone-mining model while blocking abuse. Effective power can
 * still exceed this via stake-tier multipliers, which are applied server-side.
 */
export const MAX_REPORTED_DRILL_POWER = 10_000_000;

export const ReportDrillPowerMessage = z.object({
  type: z.literal('report_drill_power'),
  requestId: RequestId,
  // Clamp rather than reject: an over-cap value is almost always a client UI
  // glitch (e.g. a stray large input), not abuse. Rejecting it surfaced as a
  // FAILED_ACTION and accrued anti-cheat backoff, which then blocked the
  // wallet's other actions (including claiming). Clamping keeps the request
  // valid; the server applies the same ceiling again defensively.
  drillPower: z
    .number()
    .nonnegative()
    .finite()
    .transform((v) => Math.min(v, MAX_REPORTED_DRILL_POWER)),
});

// ---------- Stake actions ----------

const TokenAmountField = z.number().positive().finite().max(1_000_000_000_000);

export const StakeMessage = z.object({
  type: z.literal('stake'),
  requestId: RequestId,
  asteroidId: AsteroidIdField,
  amount: TokenAmountField,
});

export const UnstakeMessage = z.object({
  type: z.literal('unstake'),
  requestId: RequestId,
  asteroidId: AsteroidIdField,
  amount: TokenAmountField,
});

// ---------- On-chain Quarry staking (build-and-sign) ----------
//
// These are distinct from the in-memory `stake` / `unstake` messages
// above (which mutate the game-side `StakeManager` mirror). The
// `*_tx` messages ask the server to BUILD an unsigned Solana
// transaction for the authenticated wallet; the client signs it with
// their wallet and submits it, then calls `verify_stake_tx`. The
// wallet identity always comes from the connection meta — never the
// body — so a client can't build/verify on behalf of another wallet.

export const BuildStakeTxMessage = z.object({
  type: z.literal('build_stake_tx'),
  requestId: RequestId,
  amount: TokenAmountField,
});

export const BuildUnstakeTxMessage = z.object({
  type: z.literal('build_unstake_tx'),
  requestId: RequestId,
  amount: TokenAmountField,
});

export const BuildClaimTxMessage = z.object({
  type: z.literal('build_claim_tx'),
  requestId: RequestId,
});

export const BuildRedeemTxMessage = z.object({
  type: z.literal('build_redeem_tx'),
  requestId: RequestId,
  amount: TokenAmountField,
});

/**
 * Submit a wallet-signed (but NOT broadcast) atomic redeem swap. The wallet
 * signed the clean tx issued by `build_redeem_tx`; the gateway co-signs the
 * treasury leg and broadcasts. The signed transaction is base64; the wallet
 * identity always comes from the connection meta, never the body.
 */
export const SubmitRedeemSwapMessage = z.object({
  type: z.literal('submit_redeem_swap'),
  requestId: RequestId,
  signedTransaction: z.string().min(1).max(8192),
});

export const BridgeIouMessage = z.object({
  type: z.literal('bridge_iou'),
  requestId: RequestId,
  /** In-game IOU credits to move on-chain as IOU-ASTROID. */
  amount: TokenAmountField,
});

export const VerifyStakeTxMessage = z.object({
  type: z.literal('verify_stake_tx'),
  requestId: RequestId,
  /** Base58 transaction signature returned by the client's submit. */
  signature: z.string().min(64).max(128),
  /** Amount the client believes it staked (echoed back on success). */
  amount: TokenAmountField,
});

export const StakeInfoMessage = z.object({
  type: z.literal('stake_info'),
  requestId: RequestId,
});

/**
 * Read the authenticated wallet's on-chain Astroid Creds (bridged IOU)
 * balance. Drives the "Redeem Creds → $ASTROID" affordance for credits that
 * were bridged but not yet redeemed. Like `stake_info` this fans out to an RPC,
 * so it is NOT in the readonly rate-limit exemption set.
 */
export const CredsBalanceMessage = z.object({
  type: z.literal('creds_balance'),
  requestId: RequestId,
});

// ---------- Expedition / raid actions ----------

export const StartExpeditionMessage = z.object({
  type: z.literal('start_expedition'),
  requestId: RequestId,
  targetAsteroidId: AsteroidIdField,
  /** 0 means "no bet"; valid in BG and astroid.club. */
  betAmount: z.number().nonnegative().finite().max(1_000_000_000_000),
});

export const LeaveExpeditionMessage = z.object({
  type: z.literal('leave_expedition'),
  requestId: RequestId,
});

/**
 * Step 1 of an on-chain wagered raid: ask the gateway to build a deposit
 * transaction that escrows `amount` $ASTROID from the wallet for a raid on
 * `targetAsteroidId`. The gateway mints a server-side `wagerId`, returns the
 * UNSIGNED deposit tx for the wallet to sign + submit itself (no co-sign —
 * the wallet owns the source account), and caches the wager. The reply
 * carries `{ transaction, amount, wagerId }`.
 */
export const BuildWagerDepositMessage = z.object({
  type: z.literal('build_wager_deposit'),
  requestId: RequestId,
  targetAsteroidId: AsteroidIdField,
  amount: TokenAmountField,
});

/**
 * Step 2: the wallet submitted the deposit tx itself; hand the gateway the
 * resulting signature. The gateway verifies the deposit landed (confirmation
 * + memo + escrow balance delta) against the cached wager, then launches the
 * raid with the escrowed wager. The wallet identity + target + amount come
 * from the cached wager, never the body.
 */
export const SubmitWagerRaidMessage = z.object({
  type: z.literal('submit_wager_raid'),
  requestId: RequestId,
  /** Base58 signature of the wallet-submitted deposit transaction. */
  signature: z.string().min(64).max(128),
});

export const RallyDefenseMessage = z.object({
  type: z.literal('rally_defense'),
  requestId: RequestId,
  asteroidId: AsteroidIdField,
  tokenCost: z.number().nonnegative().finite().max(1_000_000_000_000),
});

export const DeflectMeteorMessage = z.object({
  type: z.literal('deflect_meteor'),
  requestId: RequestId,
  // Server-issued meteor id (e.g. "meteor_3_1718500000000"). The cost is fixed
  // server-side from the threat, so the client only needs to name the meteor.
  meteorId: z.string().min(1).max(128),
});

// ---------- Yield / queries ----------

export const ClaimYieldMessage = z.object({
  type: z.literal('claim_yield'),
  requestId: RequestId,
});

export const NetworkStatsMessage = z.object({
  type: z.literal('network_stats'),
  requestId: RequestId,
});

export const MinerSnapshotMessage = z.object({
  type: z.literal('miner_snapshot'),
  requestId: RequestId,
});

// ---------- Holder verification ----------

/**
 * Ask the gateway to run the read-only holder check against the
 * authenticated wallet. The wallet identity comes from the connection
 * meta — it MUST NOT be passed in the message body, otherwise a
 * post-auth client could ask "is some other wallet a holder?" and
 * leak verification status. The gateway always uses
 * `meta.walletAddress`.
 *
 * Result envelope shape is {@link HolderEligibilityData}.
 */
export const VerifyHolderMessage = z.object({
  type: z.literal('verify_holder'),
  requestId: RequestId,
});

// ---------- Chat ----------

/** Max characters in a single chat message (post-trim). */
export const MAX_CHAT_LENGTH = 280;

/**
 * Send a chat line to the global belt channel. The author identity is
 * ALWAYS taken from the connection meta (`walletAddress`) — never the
 * body — so a client can't spoof another wallet. The text is trimmed and
 * hard-capped here; the gateway does the rate limiting and re-broadcasts
 * it to every connected client as a `chat_message` event.
 */
export const SendChatMessage = z.object({
  type: z.literal('send_chat'),
  requestId: RequestId,
  text: z
    .string()
    .min(1)
    .max(2000) // generous wire cap; trimmed + clamped to MAX_CHAT_LENGTH server-side
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, 'message is empty'),
});

/** Fetch the recent chat backlog so a just-connected client has context. */
export const ChatHistoryMessage = z.object({
  type: z.literal('chat_history'),
  requestId: RequestId,
});

/**
 * Claim (or change) the authenticated wallet's chat handle (display name).
 * Validation + case-insensitive uniqueness are enforced server-side by the
 * `HandleService`; the wide wire cap here just bounds the payload. Replies with
 * `result { handle }` (the stored form) or an error (`rejected`) when the name
 * is invalid or already taken.
 */
export const SetHandleMessage = z.object({
  type: z.literal('set_handle'),
  requestId: RequestId,
  handle: z.string().min(1).max(64),
});

// ---------- Aggregate ----------

/**
 * Discriminated union of every astroid.club client → server game
 * message. The engine's `Protocol.parse` first attempts control
 * messages (hello/join/leave/ping/pong/error) and falls through to
 * this union for game-specific messages.
 */
export const GameMessage = z.discriminatedUnion('type', [
  RequestNonceMessage,
  AuthMessage,
  JoinAsteroidMessage,
  LeaveAsteroidMessage,
  SetHomeStationMessage,
  ReportDrillPowerMessage,
  StakeMessage,
  UnstakeMessage,
  BuildStakeTxMessage,
  BuildUnstakeTxMessage,
  BuildClaimTxMessage,
  BuildRedeemTxMessage,
  SubmitRedeemSwapMessage,
  BridgeIouMessage,
  VerifyStakeTxMessage,
  StakeInfoMessage,
  CredsBalanceMessage,
  StartExpeditionMessage,
  LeaveExpeditionMessage,
  BuildWagerDepositMessage,
  SubmitWagerRaidMessage,
  RallyDefenseMessage,
  DeflectMeteorMessage,
  ClaimYieldMessage,
  NetworkStatsMessage,
  MinerSnapshotMessage,
  VerifyHolderMessage,
  SendChatMessage,
  ChatHistoryMessage,
  SetHandleMessage,
]);

export type GameMessage = z.infer<typeof GameMessage>;
export type GameMessageType = GameMessage['type'];

/** Set of message types that require an authenticated connection. */
export const POST_AUTH_TYPES: ReadonlySet<GameMessageType> = new Set<GameMessageType>([
  'join_asteroid',
  'leave_asteroid',
  'set_home_station',
  'report_drill_power',
  'stake',
  'unstake',
  'build_stake_tx',
  'build_unstake_tx',
  'build_claim_tx',
  'build_redeem_tx',
  'submit_redeem_swap',
  'bridge_iou',
  'verify_stake_tx',
  'stake_info',
  'creds_balance',
  'start_expedition',
  'leave_expedition',
  'build_wager_deposit',
  'submit_wager_raid',
  'rally_defense',
  'deflect_meteor',
  'claim_yield',
  'network_stats',
  'miner_snapshot',
  'verify_holder',
  'send_chat',
  'chat_history',
  'set_handle',
]);

/**
 * Message types that are read-only: they observe state but never
 * mutate it. The gateway uses this set to exempt HUD polls from the
 * per-wallet anti-cheat action budget. State-changing operations are
 * still subject to the full rate limit.
 *
 * Two rules of thumb when adding to this set:
 *  - The handler must not record state changes against the wallet
 *    (no stake updates, no expedition starts, no claim writes).
 *  - The handler must be cheap: snapshots are served from memory,
 *    so spamming them costs CPU but no I/O. Anything that fans out
 *    to an RPC must NOT be listed here.
 */
export const READONLY_MESSAGE_TYPES: ReadonlySet<GameMessageType> = new Set<GameMessageType>([
  'network_stats',
  'miner_snapshot',
  // Serves the in-memory chat backlog; no wallet/game-state mutation, no RPC.
  'chat_history',
]);

/** Whether a given message must be sent over an authenticated connection. */
export function requiresAuth(type: GameMessageType): boolean {
  return POST_AUTH_TYPES.has(type);
}

// ---------- Server → client wire envelopes ----------

/**
 * Successful response. `requestId` echoes the request when present;
 * `data` is the world result's `data` field.
 */
export interface ResultEnvelope<T = unknown> {
  type: 'result';
  requestId?: string;
  data: T;
}

/** Failure response, mirrors a `WorldResult` rejection. */
export interface ErrorEnvelope {
  type: 'error';
  requestId?: string;
  code: string;
  message: string;
}

/** Server-pushed game event (raid_started, refinery_distribution, ...). */
export interface EventEnvelope<T = unknown> {
  type: 'event';
  event: string;
  data: T;
}

/**
 * One chat line. Broadcast to every client as a `chat_message` event and
 * returned (as an array, oldest→newest) by `chat_history`. The author is the
 * server-attributed wallet; clients render a truncated form.
 */
export interface ChatLine {
  /** Monotonic-ish id (millis + counter) for client de-dupe / keys. */
  id: string;
  /** Author wallet (base58). Clients truncate for display. */
  walletAddress: string;
  /** Author's chat handle at send time, or null if they haven't set one. */
  handle: string | null;
  /** Sanitized, length-clamped message text. */
  text: string;
  /** Author's active asteroid at send time (or null). Small context tag. */
  asteroidId: string | null;
  /** Epoch millis the server accepted the message. */
  sentAt: number;
}

/** Result of an issued nonce request. */
export interface NonceIssuedData {
  nonce: string;
  walletAddress: string;
  /** Canonical message string the client must sign. */
  message: string;
  /** Application identifier the server bound the nonce to. */
  app: string;
  /** Time-to-live for the nonce in milliseconds. */
  ttlMs: number;
}

/**
 * Why the gateway returned a particular {@link HolderEligibilityData}.
 *
 * The reason exists so the UI can render different copy per branch
 * (and so we can audit what reason the user actually saw without
 * re-running the verification). It is NOT a pre-image of any
 * sensitive amount — `balance` and `requiredBalance` are NOT echoed
 * back, by design: the holder check is a binary gate.
 *
 * Branches:
 *   - `chain_disabled` — `chainEnabled=false` build (local dev,
 *     pre-launch). The Club treats every authenticated wallet as
 *     eligible so the surface stays usable, but the client can
 *     surface a small "dev mode" tag so testers know they didn't
 *     just pass a real holder check.
 *   - `qualified` — chain on, the wallet has held at least the
 *     required $ASTROID for the configured hold window.
 *   - `not_qualified` — chain on, threshold or hold-time not met.
 *     We don't tell the client *which* failed (preserves a tiny bit
 *     of opacity around the exact tracker semantics). The Club
 *     copy directs them to the spec.
 */
export type HolderEligibilityReason = 'chain_disabled' | 'qualified' | 'not_qualified';

/**
 * Result envelope returned by `verify_holder`. Always shaped the
 * same regardless of which reason fired so consumers can branch on
 * `eligible` and use `reason` only for telemetry / copy selection.
 */
export interface HolderEligibilityData {
  eligible: boolean;
  reason: HolderEligibilityReason;
  /** Wallet that was verified — echoed for client-side consistency. */
  walletAddress: string;
  /** Human-readable message safe to surface in UI. */
  message: string;
  /**
   * Milliseconds until the hold-time gate opens, when the wallet holds enough
   * but is still inside the window. Present only on that branch (a new holder
   * waiting out the timer); absent otherwise. Lets the client render a live
   * countdown to arena access.
   */
  remainingHoldMs?: number;
}

// ---------- Protocol factory ----------

/**
 * Build a configured `Protocol` ready to plug into `WSGateway`. The
 * returned protocol parses control messages first and falls through
 * to {@link GameMessage}.
 */
export function createAstroidProtocol(): Protocol<typeof GameMessage> {
  return new Protocol({ game: GameMessage });
}

/** Re-exported for callers that want the engine's primitives directly. */
export { SolanaAddress, UuidLike };
