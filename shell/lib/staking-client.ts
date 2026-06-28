/**
 * On-chain Quarry staking orchestration for the shell.
 *
 * Ties together the three steps every staking action needs:
 *
 *   1. Ask the gateway to BUILD an unsigned transaction
 *      (`Session.build*Tx`).
 *   2. Sign + submit it with the user's wallet
 *      (`WalletSource.signAndSendTransaction`).
 *   3. For a stake, ask the gateway to VERIFY the submitted tx
 *      (`Session.verifyStakeTx`); for unstake / claim / redeem the
 *      successful submit is the outcome and the caller just refreshes
 *      `stake_info`.
 *
 * The non-custodial invariant holds end-to-end: the gateway never sees
 * a private key, and the wallet only ever signs a transaction the
 * gateway built for the authenticated wallet's own position.
 */

import { type Session, SessionError, type StakeVerification, type UserStakeInfo } from './session';
import type { SignableTransaction, WalletSource } from './wallet-source';

export type StakeActionKind = 'stake' | 'unstake' | 'claim' | 'redeem';

/** Outcome of a staking action, shaped so the UI can branch on `ok`. */
export interface StakeActionResult {
  ok: boolean;
  kind: StakeActionKind;
  /** Base58 signature once the tx was submitted (absent on early failure). */
  signature?: string;
  /** Present for `stake`: the gateway's on-chain verification result. */
  verification?: StakeVerification;
  /** Human-readable summary safe to surface in the UI / event log. */
  message: string;
}

/**
 * Thrown when the active wallet can't sign on-chain transactions
 * (e.g. dev mode without `NEXT_PUBLIC_SOLANA_RPC_URL`, or a Privy
 * session that hasn't connected an external wallet yet). The UI
 * should disable the staking controls and surface the message.
 */
export class StakingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StakingUnavailableError';
  }
}

/**
 * Thrown when the wallet about to SIGN differs from the wallet the live
 * session was authenticated as. Every on-chain action the gateway builds is
 * scoped to the authenticated wallet (`session.walletAddress`) — it's the fee
 * payer + token authority baked into the transaction. If the browser then
 * signs with a different wallet (e.g. the user connected/switched wallets in
 * Privy after connecting, so `wallets[0]` changed under the session) the
 * signature is for the wrong key and Solana rejects it with
 * "Attempted to sign a transaction with an address that is not a signer"
 * (error #5663015). Worse, for a claim the credits would already have bridged
 * to the SESSION wallet, stranding them under a wallet the user isn't signing
 * with. Catching this BEFORE any build/bridge keeps funds safe and tells the
 * user exactly what to do.
 */
export class WalletMismatchError extends Error {
  constructor(
    public readonly sessionWallet: string,
    public readonly signerWallet: string,
  ) {
    super(
      `Your game session is signed in as ${shortAddr(sessionWallet)}, but your wallet is ` +
        `currently set to sign as ${shortAddr(signerWallet)}. Switch your wallet back to ` +
        `${shortAddr(sessionWallet)} (the wallet you logged in with), then try again — or sign ` +
        `out and reconnect with the wallet you want to play as. No funds were moved.`,
    );
    this.name = 'WalletMismatchError';
  }
}

function shortAddr(s: string): string {
  return s.length <= 12 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * Guard that the wallet that will sign matches the authenticated session
 * wallet. Throws {@link WalletMismatchError} if they differ. Call this at the
 * top of every signing flow, before building or bridging anything.
 */
function assertSignerMatchesSession(session: Session, source: WalletSource): void {
  if (source.publicKey && source.publicKey !== session.walletAddress) {
    throw new WalletMismatchError(session.walletAddress, source.publicKey);
  }
}

/**
 * How long to wait for the gateway's `verify_stake_tx` reply. Verification
 * does a full on-chain `confirmTransaction` + `getTransaction` (memo check)
 * + a stake-tier reconcile, which on mainnet routinely outlasts the default
 * 10s socket timeout even though the stake has already landed. Give it room.
 */
const STAKE_VERIFY_TIMEOUT_MS = 60_000;

/** Whether the given wallet source can sign + submit on-chain txs. */
export function canStake(source: WalletSource | null): boolean {
  return Boolean(source && typeof source.signAndSendTransaction === 'function');
}

/**
 * Run a full staking action: build the tx, sign + submit it, and (for
 * a stake) verify it. Never throws on a "not verified" outcome — that
 * comes back as `{ ok: false, verification }`. Throws
 * {@link StakingUnavailableError} if the wallet can't sign, and
 * rethrows {@link SessionError} on transport failure so the caller can
 * log a transport vs. on-chain failure distinctly.
 */
export async function runStakeAction(
  session: Session,
  source: WalletSource,
  kind: StakeActionKind,
  amount: number,
): Promise<StakeActionResult> {
  const signAndSend = source.signAndSendTransaction;
  if (typeof signAndSend !== 'function') {
    throw new StakingUnavailableError(
      'This wallet cannot submit on-chain transactions. Connect a Solana wallet (or set NEXT_PUBLIC_SOLANA_RPC_URL in dev mode).',
    );
  }
  assertSignerMatchesSession(session, source);

  const build = await buildFor(session, kind, amount);
  const signable: SignableTransaction = {
    transaction: build.transaction,
    blockhash: build.blockhash,
    lastValidBlockHeight: build.lastValidBlockHeight,
  };

  // The atomic redeem swap needs a server-side treasury co-signature added
  // AFTER the wallet signs. So the wallet signs a CLEAN tx without broadcasting
  // (`signTransaction`) and the gateway co-signs + submits via
  // `submitRedeemSwap`. This wallet-first ordering keeps Phantom from flagging
  // the redeem as a drainer (it never sees a pre-attached foreign signature).
  // Every other action (stake/unstake/claim, and the legacy Creds-only redeem
  // fallback) is single-signer and the wallet submits it directly.
  let signature: string;
  if (kind === 'redeem' && build.requiresCoSign) {
    if (typeof source.signTransaction !== 'function') {
      throw new StakingUnavailableError(
        'This wallet cannot sign the redeem swap. Connect a Solana wallet (or set NEXT_PUBLIC_SOLANA_RPC_URL in dev mode).',
      );
    }
    const signed = await source.signTransaction(signable);
    const submitted = await session.submitRedeemSwap(signed);
    signature = submitted.signature;
  } else {
    signature = await signAndSend(signable);
  }

  if (kind === 'stake') {
    let verification: StakeVerification;
    try {
      verification = await session.verifyStakeTx(signature, amount, {
        timeoutMs: STAKE_VERIFY_TIMEOUT_MS,
      });
    } catch (err) {
      // The wallet already signed + submitted the stake (we hold its
      // signature). If the verification REPLY is slow enough to time out the
      // socket, the stake is still on-chain — the gateway reconciles the tier
      // on its next `stake_info` read (after connect / on refresh). Surface a
      // calm "confirming" outcome instead of a transport error so the player
      // isn't told a successful stake failed.
      if (err instanceof SessionError && err.code === 'timeout') {
        return {
          ok: true,
          kind,
          signature,
          message: `Staked ${formatAmount(amount)} $ASTROID. Confirming on-chain; your tier updates shortly.`,
        };
      }
      throw err;
    }
    return {
      ok: verification.verified,
      kind,
      signature,
      verification,
      message: verification.verified
        ? `Staked ${formatAmount(verification.actualAmount ?? amount)} $ASTROID`
        : `Submitted, but verification failed: ${verification.error ?? 'unknown reason'}`,
    };
  }

  return {
    ok: true,
    kind,
    signature,
    message: submitMessage(kind, amount),
  };
}

/** Outcome of claiming in-game mining rewards out to the wallet as $ASTROID. */
export interface ClaimResult {
  ok: boolean;
  /** Amount of in-game credits claimed (UI units). */
  amount: number;
  /** Signature of the server-signed bridge (credits → Astroid Creds). */
  bridgeSignature?: string;
  /** Signature of the user-signed redeem swap (Astroid Creds → $ASTROID). */
  redeemSignature?: string;
  /**
   * True when the bridge succeeded but the redeem swap did not. The credits
   * became Astroid Creds tokens in the wallet (nothing lost) and can be
   * finished later with "Redeem Creds".
   */
  bridgedOnly?: boolean;
  /** Human-readable summary safe for the UI / event log. */
  message: string;
}

/**
 * Claim accrued in-game mining rewards out to the wallet as real $ASTROID.
 *
 * Two on-chain steps: (1) the gateway BRIDGES the in-game credits to
 * on-chain Astroid Creds with a server-signed treasury transfer (this debits
 * the in-game ledger; it's refunded server-side if it fails), then (2) the
 * user signs an ATOMIC redeem swap exchanging that Astroid Creds for $ASTROID.
 *
 * If step 1 fails, credits are untouched (server refund) and this rejects via
 * {@link SessionError}. If step 1 succeeds but step 2 fails (user rejects /
 * transport), the credits have become Astroid Creds tokens in the wallet — no
 * loss — and the result is `{ ok: false, bridgedOnly: true }`.
 */
export async function runClaimToWallet(
  session: Session,
  source: WalletSource,
  amount: number,
): Promise<ClaimResult> {
  if (typeof source.signAndSendTransaction !== 'function') {
    throw new StakingUnavailableError(
      'This wallet cannot submit on-chain transactions. Connect a Solana wallet (or set NEXT_PUBLIC_SOLANA_RPC_URL in dev mode).',
    );
  }
  // Guard BEFORE the bridge: if the signer differs from the session wallet,
  // bridging would strand the Astroid Creds under a wallet the user isn't
  // signing with. Fail early so nothing moves.
  assertSignerMatchesSession(session, source);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, amount, message: 'No claimable rewards.' };
  }

  // Step 1: bridge in-game credits → on-chain Astroid Creds (server-signed).
  // (formerly handed out as the unnamed IOU token; now the named Astroid Creds.)
  // A failure here throws SessionError; credits are refunded by the gateway.
  const bridge = await session.bridgeIou(amount);

  // Step 2: atomic swap Astroid Creds → $ASTROID (user signs + submits).
  try {
    const redeem = await runStakeAction(session, source, 'redeem', amount);
    return {
      ok: redeem.ok,
      amount,
      bridgeSignature: bridge.signature,
      redeemSignature: redeem.signature,
      bridgedOnly: !redeem.ok,
      message: redeem.ok
        ? `Claimed ${formatAmount(amount)} → $ASTROID (tx ${shortSig(redeem.signature)})`
        : `Bridged to Astroid Creds, but the redeem step didn't finish (${redeem.message}). Use "Redeem Creds" to convert to $ASTROID.`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      amount,
      bridgeSignature: bridge.signature,
      bridgedOnly: true,
      message: `Bridged ${formatAmount(amount)} to Astroid Creds, but the redeem step failed (${reason}). Your rewards are now Astroid Creds tokens in your wallet. Use "Redeem Creds" to convert to $ASTROID.`,
    };
  }
}

/** Outcome of launching an on-chain wagered raid. */
export interface WagerRaidResult {
  ok: boolean;
  /** Expedition id once the raid launched (absent on failure). */
  expeditionId?: string;
  /** Server-minted wager id (deposit memo / escrow pool / settlement). */
  wagerId?: string;
  /** Signature of the wallet-submitted deposit. */
  depositSignature?: string;
  /** Human-readable summary safe for the UI / event log. */
  message: string;
}

/**
 * How long to wait for `submit_wager_raid`. The gateway does a full on-chain
 * deposit verify (confirm + memo + balance delta) before launching, which on
 * mainnet routinely outlasts the default 10s socket timeout. Give it room.
 */
const WAGER_SUBMIT_TIMEOUT_MS = 60_000;

/**
 * Launch an on-chain wagered raid. Three steps, mirroring the redeem UX:
 *
 *   1. Ask the gateway to BUILD an escrow deposit (it pre-validates the raid,
 *      so a refused raid never charges a deposit).
 *   2. Sign + submit the deposit with the wallet — fully wallet-signed and
 *      broadcast by the wallet (no co-sign), so Phantom never sees a foreign
 *      signature on a tx moving the user's tokens.
 *   3. Hand the signature back; the gateway verifies the deposit landed and
 *      launches the raid (auto-returning the escrow if it can't).
 *
 * Throws {@link StakingUnavailableError} if the wallet can't submit on-chain,
 * and rethrows {@link SessionError} on transport / business-rule failures
 * (e.g. cooldown, chain disabled) so the caller can surface the reason.
 */
export async function runWagerRaid(
  session: Session,
  source: WalletSource,
  targetAsteroidId: string,
  amount: number,
): Promise<WagerRaidResult> {
  const signAndSend = source.signAndSendTransaction;
  if (typeof signAndSend !== 'function') {
    throw new StakingUnavailableError(
      'Connect a Solana wallet to place an on-chain wager (or set NEXT_PUBLIC_SOLANA_RPC_URL in dev mode).',
    );
  }
  assertSignerMatchesSession(session, source);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: 'Wager must be greater than 0.' };
  }

  const build = await session.buildWagerDeposit(targetAsteroidId, amount);
  const signable: SignableTransaction = {
    transaction: build.transaction,
    blockhash: build.blockhash,
    lastValidBlockHeight: build.lastValidBlockHeight,
  };
  const depositSignature = await signAndSend(signable);
  const started = await session.submitWagerRaid(depositSignature, {
    timeoutMs: WAGER_SUBMIT_TIMEOUT_MS,
  });
  return {
    ok: true,
    expeditionId: started.expeditionId,
    wagerId: build.wagerId,
    depositSignature,
    message: `Escrowed ${formatAmount(amount)} $ASTROID. Raid launched (tx ${shortSig(depositSignature)}).`,
  };
}

function shortSig(sig?: string): string {
  return sig ? `${sig.slice(0, 8)}…` : 'n/a';
}

/** Read the wallet's on-chain stake position; returns null on transport error. */
/**
 * Finish a claim that stopped at the bridge step (`bridgedOnly`). Runs ONLY
 * the user-signed redeem swap (Astroid Creds → $ASTROID) for `amount`. Used by
 * the "Finish claim" recovery button when the player was too slow to sign the
 * redeem in time (blockhash expiry / rejected prompt) and their rewards are
 * sitting as Astroid Creds tokens in the wallet.
 */
export async function runRedeemIou(
  session: Session,
  source: WalletSource,
  amount: number,
): Promise<ClaimResult> {
  if (typeof source.signAndSendTransaction !== 'function') {
    throw new StakingUnavailableError(
      'This wallet cannot submit on-chain transactions. Connect a Solana wallet (or set NEXT_PUBLIC_SOLANA_RPC_URL in dev mode).',
    );
  }
  assertSignerMatchesSession(session, source);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, amount, message: 'Nothing to redeem.' };
  }
  const redeem = await runStakeAction(session, source, 'redeem', amount);
  return {
    ok: redeem.ok,
    amount,
    redeemSignature: redeem.signature,
    bridgedOnly: !redeem.ok,
    message: redeem.ok
      ? `Redeemed ${formatAmount(amount)} Astroid Creds → $ASTROID (tx ${shortSig(redeem.signature)})`
      : `Redeem didn't finish (${redeem.message}). Try "Finish claim" again.`,
  };
}

export async function fetchStakeInfo(session: Session): Promise<UserStakeInfo | null> {
  try {
    return await session.getStakeInfo();
  } catch (err) {
    if (err instanceof SessionError) return null;
    throw err;
  }
}

async function buildFor(session: Session, kind: StakeActionKind, amount: number) {
  switch (kind) {
    case 'stake':
      return session.buildStakeTx(amount);
    case 'unstake':
      return session.buildUnstakeTx(amount);
    case 'claim':
      return session.buildClaimTx();
    case 'redeem':
      return session.buildRedeemTx(amount);
  }
}

function submitMessage(kind: StakeActionKind, amount: number): string {
  switch (kind) {
    case 'unstake':
      return `Unstaked ${formatAmount(amount)} $ASTROID`;
    case 'claim':
      return 'Claimed pending Astroid Creds rewards';
    case 'redeem':
      return `Redeemed ${formatAmount(amount)} Astroid Creds`;
    case 'stake':
      return `Staked ${formatAmount(amount)} $ASTROID`;
  }
}

function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? n.toString() : n.toFixed(4);
}
