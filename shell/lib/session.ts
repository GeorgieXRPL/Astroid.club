/**
 * astroid.club long-lived session.
 *
 * Wraps an authenticated WebSocket with promise-based request/response
 * (correlated by `requestId`) and an event subscription bus so the
 * shell — and later the arena — can drive every game message without
 * each consumer re-implementing wire-protocol details.
 *
 * Lifecycle:
 *   1. `connectSession()` runs the auth handshake, gets the connect
 *      snapshot, and returns a `Session` plus snapshot.
 *   2. The session listens to the same socket for the rest of its
 *      life. `send()` returns a promise that resolves when an envelope
 *      with a matching `requestId` arrives.
 *   3. The session forwards `event` envelopes (server-pushed game
 *      events) to subscribers registered via `on(event, handler)`.
 *   4. `close()` tears the socket down; subscribers receive a
 *      synthetic `__closed__` event and `getState()` flips to closed.
 *
 * This is intentionally vanilla TypeScript (no React) so the same
 * module can power the Vite arena bundle in a later slice.
 */

import type { WalletSource } from './wallet-source';

/** Per-asteroid public listing returned at connect time. */
export interface AsteroidListing {
  id: string;
  name: string;
  /** Internal mechanic class (`carbon | silver | gold | oil`). */
  resource: string;
  /** Cosmetic mineral flavor (`Iridium`, `Helium-3`, ...). */
  flavor: string;
  /** Galactic sector grouping. */
  sector: string;
  /** Star-map position; the arena projects this into orbit params. */
  position: { x: number; y: number; z: number };
}

/** Current drill-power tier + distance to the next (mirrors `StakeTierProgress`). */
export interface StakeTierProgress {
  tierName: string;
  drillPowerMultiplier: number;
  nextTierName: string | null;
  nextTierDrillMultiplier: number | null;
  nextTierThreshold: number | null;
  nextTierUsd: number | null;
  tokensToNextTier: number;
  astroidUsdPrice: number;
}

/** A server snapshot returned at connect time (mirrors `ConnectSnapshot`). */
export interface ConnectSnapshot {
  walletAddress: string;
  homeStationAsteroidId: string | null;
  activeAsteroidId: string | null;
  totalStake: number;
  /** Current stake tier and distance to the next, priced at the live $ASTROID price. */
  tier: StakeTierProgress;
  loyaltyDays: number;
  /** Claimable mining rewards (Astroid Creds) not yet moved on-chain. */
  pendingYield: number;
  /** Lifetime mining rewards ever earned (gross; never decreases). */
  lifetimeEarned: number;
  /** Lifetime rewards already moved on-chain (bridged/redeemed). */
  lifetimeRedeemed: number;
  /** True while this wallet is committed to an active raid expedition. */
  onExpedition: boolean;
  /**
   * Live details of the wallet's in-flight raid (null when not raiding) — used
   * for the arena's "raid in progress" indicator.
   */
  activeExpedition: {
    targetAsteroidId: string;
    attackPower: number;
    defensePower: number;
    defenseToBeat: number;
    expiresAt: string;
  } | null;
  asteroids: ReadonlyArray<AsteroidListing>;
}

/** Per-asteroid stats published by `network_stats`. */
export interface AsteroidNetworkStats {
  asteroidId: string;
  asteroidName: string;
  resource: string;
  minerCount: number;
  drillPower: number;
  totalStake: number;
  discoveriesFound: number;
  difficulty: number;
  lastDiscoveryTime: string | Date | null;
  hasDefenseBuff: boolean;
  hasAttackDebuff: boolean;
  activeRaidCount: number;
  /** Accumulated raid-vault treasury (persistent, raidable), in $ASTROID units. */
  refineryBalance: number;
  /** Discovery yield currently stealable by a successful raid. */
  stealableYield: number;
  /** Live defense power of this asteroid (what a raid must beat). */
  defensePower: number;
}

/** Whole-network view returned by `network_stats`. */
export interface NetworkStatsSnapshot {
  totalMiners: number;
  totalDrillPower: number;
  totalStake: number;
  totalDiscoveries: number;
  activeExpeditions: number;
  asteroids: AsteroidNetworkStats[];
}

/**
 * Why the gateway returned a particular {@link HolderEligibility}.
 *
 * Mirrors `HolderEligibilityReason` on the server. Kept duplicated
 * here (rather than importing from `server/net/protocol.ts`) so the
 * shell stays free of any Node-only server dependency graph at
 * build time.
 */
export type HolderEligibilityReason = 'chain_disabled' | 'qualified' | 'not_qualified';

/**
 * Result of a `verify_holder` request. Always shaped the same so
 * consumers can branch on `eligible` and use `reason` only for copy
 * selection / telemetry.
 */
export interface HolderEligibility {
  eligible: boolean;
  reason: HolderEligibilityReason;
  walletAddress: string;
  message: string;
  /**
   * Milliseconds until the hold-time gate opens, present only when the wallet
   * holds enough $ASTROID but is still inside the window. Drives the live
   * countdown shown to a new holder waiting out the timer.
   */
  remainingHoldMs?: number;
}

/**
 * On-chain Quarry staking wire shapes. These mirror the server's
 * `TransactionBuildResult` / `ClaimBuildResult` / `StakeVerification`
 * / `UserStakeInfo` (`server/chain/staking.ts`). Kept duplicated here
 * so the shell stays free of the Node-only server graph at build time.
 */
export interface StakeTxBuild {
  /** Base64-serialized unsigned transaction the wallet must sign. */
  transaction: string;
  /** Human-readable description of what the user is signing. */
  message: string;
  lastValidBlockHeight: number;
  blockhash: string;
  /**
   * When true, the wallet must sign this tx WITHOUT broadcasting it
   * (`WalletSource.signTransaction`) and return it via
   * {@link Session.submitRedeemSwap}; the gateway co-signs the treasury leg
   * and submits. Only the atomic redeem swap sets this.
   */
  requiresCoSign?: boolean;
}

/** A claim build additionally carries the estimated reward at build time. */
export interface ClaimTxBuild extends StakeTxBuild {
  /** Pending Astroid Creds reward at build time (UI units). */
  estimatedReward: number;
}

/** Result of asking the gateway to verify a submitted staking tx. */
export interface StakeVerification {
  verified: boolean;
  actualAmount?: number;
  error?: string;
}

/**
 * Result of building a raid-wager deposit (step 1 of an on-chain wagered
 * raid). The wallet signs + submits {@link transaction} itself (no co-sign),
 * then hands the signature to {@link Session.submitWagerRaid}.
 */
export interface WagerDepositBuild {
  /** Base64-serialized unsigned deposit tx the wallet signs + submits. */
  transaction: string;
  /** Amount escrowed (UI units), echoed for display. */
  amount: number;
  /** Server-minted id tagging the deposit memo, escrow pool, + settlement. */
  wagerId: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Result of launching a raid (plain or after a verified wager deposit). */
export interface ExpeditionStart {
  expeditionId: string;
  expiresAt: string;
}

/** Result of a server-signed Astroid Creds bridge. */
export interface BridgeIouResult {
  /** Base58 signature of the confirmed treasury transfer. */
  signature: string;
  /** Amount of in-game credits bridged to Astroid Creds (UI units). */
  bridged: number;
}

/**
 * A user's on-chain stake position. `lastStakeTime` is an ISO string
 * over the wire (the server sends a serialized `Date`).
 */
export interface UserStakeInfo {
  walletAddress: string;
  /** Staked $ASTROID in UI units. */
  stakedAmount: number;
  /** Pending Astroid Creds rewards in UI units. */
  pendingRewards: number;
  lastStakeTime: string | null;
  minerPDA: string | null;
}

interface ResultEnvelope<T = unknown> {
  type: 'result';
  requestId?: string;
  data: T;
}
interface ErrorEnvelope {
  type: 'error';
  requestId?: string;
  code: string;
  message: string;
}
interface EventEnvelope<T = unknown> {
  type: 'event';
  event: string;
  data: T;
}
type WireEnvelope = ResultEnvelope<unknown> | ErrorEnvelope | EventEnvelope<unknown>;

export class SessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

/** A pending in-flight request awaiting its `result` or `error` envelope. */
interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: SessionError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Synthetic event fired when the socket closes for any reason. */
export const SESSION_CLOSED_EVENT = '__closed__';

export class Session {
  /**
   * Auto-incrementing requestId source. Wallet-scoped (each session
   * owns its own counter), monotonic, never reused — keeps server
   * logs grep-friendly.
   */
  private nextRequestId = 1;

  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  private state: 'connected' | 'closed' = 'connected';

  constructor(
    public readonly walletAddress: string,
    private readonly ws: WebSocket,
    private readonly defaultTimeoutMs: number,
  ) {
    ws.addEventListener('message', this.onMessage);
    ws.addEventListener('close', this.onClose);
    ws.addEventListener('error', this.onError);
  }

  getState(): 'connected' | 'closed' {
    return this.state;
  }

  /**
   * Send a typed message and resolve with the server's reply. The
   * message must NOT include `requestId`; the session generates one.
   * Rejects with `SessionError` on timeout, error envelope, or close.
   */
  send<T = unknown>(
    message: Record<string, unknown> & { type: string },
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.state === 'closed') {
      return Promise.reject(new SessionError('closed', 'Session is closed'));
    }

    const requestId = `r${this.nextRequestId++}`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const payload = { ...message, requestId };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new SessionError('timeout', `no reply for ${message.type} after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });

      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(new SessionError('send_failed', err instanceof Error ? err.message : String(err)));
      }
    });
  }

  /**
   * Subscribe to a named server-pushed event. Returns a function that
   * unsubscribes when called. Special event {@link SESSION_CLOSED_EVENT}
   * fires once when the socket closes.
   */
  on(event: string, handler: (data: unknown) => void): () => void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(handler);
    return () => {
      bucket?.delete(handler);
    };
  }

  /**
   * Run the read-only holder check against the authenticated wallet.
   *
   * The server uses `meta.walletAddress` for the lookup — there is
   * no wallet field on the request, by design. Returns the
   * eligibility envelope; the caller decides what to render.
   *
   * Throws {@link SessionError} on transport failure / timeout. A
   * "wallet doesn't qualify" outcome is NOT an error — it returns
   * `{ eligible: false, reason: 'not_qualified' }`.
   */
  verifyHolder(options: { timeoutMs?: number } = {}): Promise<HolderEligibility> {
    return this.send<HolderEligibility>({ type: 'verify_holder' }, options);
  }

  // -------- On-chain Quarry staking (build-and-sign) --------
  //
  // Each `build*` asks the gateway for an unsigned transaction; the
  // caller signs + submits it (via `WalletSource.signAndSendTransaction`)
  // and then calls `verifyStakeTx` with the returned signature. The
  // wallet identity is always taken from the connection meta server-side,
  // never the body, so these can't act on behalf of another wallet.

  /** Build an unsigned $ASTROID stake transaction for `amount` (UI units). */
  buildStakeTx(amount: number, options: { timeoutMs?: number } = {}): Promise<StakeTxBuild> {
    return this.send<StakeTxBuild>({ type: 'build_stake_tx', amount }, options);
  }

  /** Build an unsigned unstake transaction for `amount` (UI units). */
  buildUnstakeTx(amount: number, options: { timeoutMs?: number } = {}): Promise<StakeTxBuild> {
    return this.send<StakeTxBuild>({ type: 'build_unstake_tx', amount }, options);
  }

  /** Build an unsigned claim transaction for pending Astroid Creds rewards. */
  buildClaimTx(options: { timeoutMs?: number } = {}): Promise<ClaimTxBuild> {
    return this.send<ClaimTxBuild>({ type: 'build_claim_tx' }, options);
  }

  /** Build an unsigned Astroid Creds redeem transaction for `amount` (UI units). */
  buildRedeemTx(amount: number, options: { timeoutMs?: number } = {}): Promise<StakeTxBuild> {
    return this.send<StakeTxBuild>({ type: 'build_redeem_tx', amount }, options);
  }

  /**
   * Submit a wallet-signed (but NOT broadcast) atomic redeem swap built by
   * {@link buildRedeemTx}. The gateway adds the treasury's co-signature and
   * broadcasts, returning the confirmed signature. Must be called on the same
   * connection that built the swap (the gateway caches it there).
   */
  submitRedeemSwap(
    signedTransaction: string,
    options: { timeoutMs?: number } = {},
  ): Promise<{ signature: string }> {
    return this.send<{ signature: string }>(
      { type: 'submit_redeem_swap', signedTransaction },
      options,
    );
  }

  /**
   * Bridge `amount` of in-game credits to on-chain Astroid Creds. The
   * gateway debits the in-game ledger and runs a server-signed treasury
   * transfer, returning the confirmed signature. Credits are refunded
   * server-side if the transfer fails.
   */
  bridgeIou(amount: number, options: { timeoutMs?: number } = {}): Promise<BridgeIouResult> {
    return this.send<BridgeIouResult>({ type: 'bridge_iou', amount }, options);
  }

  /**
   * Step 1 of an on-chain wagered raid: ask the gateway to build a deposit
   * that escrows `amount` $ASTROID for a raid on `targetAsteroidId`. The
   * gateway pre-validates the raid and returns the UNSIGNED deposit tx for the
   * wallet to sign + submit itself (no co-sign), plus a server-minted wagerId.
   */
  buildWagerDeposit(
    targetAsteroidId: string,
    amount: number,
    options: { timeoutMs?: number } = {},
  ): Promise<WagerDepositBuild> {
    return this.send<WagerDepositBuild>(
      { type: 'build_wager_deposit', targetAsteroidId, amount },
      options,
    );
  }

  /**
   * Step 2: hand the gateway the signature of the wallet-submitted deposit. It
   * verifies the deposit landed (confirmation + memo + escrow balance delta)
   * and launches the raid with the escrowed wager. Must run on the same
   * connection that built the deposit (the gateway cached it there). The
   * on-chain verify can outlast the default socket timeout — give it room.
   */
  submitWagerRaid(
    signature: string,
    options: { timeoutMs?: number } = {},
  ): Promise<ExpeditionStart> {
    return this.send<ExpeditionStart>({ type: 'submit_wager_raid', signature }, options);
  }

  /**
   * Ask the gateway to verify a submitted staking transaction. A
   * "not verified" outcome is NOT a transport error — it returns
   * `{ verified: false, error }`. Throws {@link SessionError} only on
   * transport failure / timeout.
   */
  verifyStakeTx(
    signature: string,
    amount: number,
    options: { timeoutMs?: number } = {},
  ): Promise<StakeVerification> {
    return this.send<StakeVerification>({ type: 'verify_stake_tx', signature, amount }, options);
  }

  /** Read the authenticated wallet's on-chain stake position. */
  getStakeInfo(options: { timeoutMs?: number } = {}): Promise<UserStakeInfo> {
    return this.send<UserStakeInfo>({ type: 'stake_info' }, options);
  }

  /**
   * Read the authenticated wallet's on-chain Astroid Creds (bridged IOU)
   * balance in UI units. Used to surface a "Redeem Creds → $ASTROID" action for
   * credits that were bridged but not yet redeemed.
   */
  getCredsBalance(options: { timeoutMs?: number } = {}): Promise<number> {
    return this.send<number>({ type: 'creds_balance' }, options);
  }

  /** Close the socket. Idempotent. */
  close(): void {
    if (this.state === 'closed') return;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  private onMessage = (ev: MessageEvent<string>) => {
    let env: WireEnvelope;
    try {
      env = JSON.parse(ev.data) as WireEnvelope;
    } catch {
      // Ignore non-JSON noise. Server never sends non-JSON, but
      // proxies / browser dev tools can inject debug frames.
      return;
    }

    if (env.type === 'event') {
      this.fanout(env.event, env.data);
      return;
    }

    if (env.type === 'result' || env.type === 'error') {
      if (!env.requestId) return; // unsolicited; ignore
      const pending = this.pending.get(env.requestId);
      if (!pending) return;
      this.pending.delete(env.requestId);
      clearTimeout(pending.timer);
      if (env.type === 'result') {
        pending.resolve(env.data);
      } else {
        pending.reject(new SessionError(env.code, env.message));
      }
    }
  };

  private onClose = () => {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SessionError('closed', 'WebSocket closed'));
    }
    this.pending.clear();
    this.fanout(SESSION_CLOSED_EVENT, undefined);
    this.ws.removeEventListener('message', this.onMessage);
    this.ws.removeEventListener('close', this.onClose);
    this.ws.removeEventListener('error', this.onError);
  };

  private onError = () => {
    // Browsers fire 'error' before 'close' on connection failures.
    // We don't surface this directly — onClose handles state; the
    // session snapshot only flips to 'closed' once the close event
    // arrives so we don't double-fire.
  };

  private fanout(event: string, data: unknown): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    // Snapshot iteration so handlers can unsubscribe themselves
    // mid-fanout without breaking the loop.
    for (const handler of [...bucket]) {
      try {
        handler(data);
      } catch (err) {
        console.error(`[session] event handler for "${event}" threw`, err);
      }
    }
  }
}

export interface ConnectOptions {
  wsUrl: string;
  /**
   * The wallet driving the handshake. Anything implementing
   * {@link WalletSource} works — dev keypair via
   * `devKeypairAsWalletSource`, a Privy-connected Solana wallet via
   * `usePrivyWalletSource`, or a future custom integration.
   */
  source: WalletSource;
  /** Per-step handshake timeout. */
  timeoutMs?: number;
}

export interface ConnectResult {
  session: Session;
  snapshot: ConnectSnapshot;
}

/**
 * Open a WebSocket, run the request_nonce → sign → auth handshake,
 * and return a long-lived `Session` plus the connect snapshot.
 *
 * On any failure the socket is closed and a `SessionError` is thrown.
 */
export async function connectSession({
  wsUrl,
  source,
  timeoutMs = 10_000,
}: ConnectOptions): Promise<ConnectResult> {
  const ws = await openSocket(wsUrl, timeoutMs);

  // We use bare promise wrappers here (NOT a Session yet) because the
  // session's auto-requestId generator should start at 1 once the
  // handshake is done. Cleanest separation: handshake uses fixed
  // requestIds (`auth-1`, `auth-2`), the session takes over after.
  const handshakeResponses = new Map<string, (env: WireEnvelope) => void>();
  const handshakeMessageListener = (ev: MessageEvent<string>) => {
    let env: WireEnvelope;
    try {
      env = JSON.parse(ev.data) as WireEnvelope;
    } catch {
      return;
    }
    if (env.type === 'event') return; // belongs to nobody yet
    if (!env.requestId) return;
    const r = handshakeResponses.get(env.requestId);
    if (r) {
      handshakeResponses.delete(env.requestId);
      r(env);
    }
  };

  const handshakeCloseListener = () => {
    for (const r of handshakeResponses.values()) {
      r({
        type: 'error',
        requestId: '__close__',
        code: 'closed',
        message: 'WebSocket closed during handshake',
      });
    }
    handshakeResponses.clear();
  };

  ws.addEventListener('message', handshakeMessageListener);
  ws.addEventListener('close', handshakeCloseListener);

  function awaitReply<T>(
    payload: { type: string; requestId: string } & Record<string, unknown>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        handshakeResponses.delete(payload.requestId);
        reject(new SessionError('timeout', `no reply for ${payload.type}`));
      }, timeoutMs);
      handshakeResponses.set(payload.requestId, (env) => {
        clearTimeout(timer);
        if (env.type === 'error') {
          reject(new SessionError(env.code, env.message));
        } else if (env.type === 'result') {
          resolve(env.data as T);
        }
      });
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        handshakeResponses.delete(payload.requestId);
        reject(new SessionError('send_failed', err instanceof Error ? err.message : String(err)));
      }
    });
  }

  try {
    const nonceData = await awaitReply<{
      nonce: string;
      message: string;
    }>({
      type: 'request_nonce',
      requestId: 'auth-1',
      walletAddress: source.publicKey,
    });

    const signature = await source.signMessage(nonceData.message);

    const snapshot = await awaitReply<ConnectSnapshot>({
      type: 'auth',
      requestId: 'auth-2',
      walletAddress: source.publicKey,
      nonce: nonceData.nonce,
      signature,
    });

    ws.removeEventListener('message', handshakeMessageListener);
    ws.removeEventListener('close', handshakeCloseListener);

    const session = new Session(snapshot.walletAddress, ws, timeoutMs);
    return { session, snapshot };
  } catch (err) {
    ws.removeEventListener('message', handshakeMessageListener);
    ws.removeEventListener('close', handshakeCloseListener);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function openSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new SessionError('timeout', `WebSocket open timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve(ws);
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new SessionError('ws_error', `failed to open WebSocket at ${url}`));
      },
      { once: true },
    );
  });
}
