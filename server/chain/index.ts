/**
 * `ChainOps` — the single chokepoint for every potential on-chain
 * side effect in astroid.club.
 *
 * Why a facade? `CHAIN_ENABLED` is the operator's kill switch. We
 * want it load-bearing in three layers, not one:
 *
 * 1. **The flag itself** (`runtime.chainEnabled`). One env var flips
 *    the entire platform.
 * 2. **The orchestrator's gate** (e.g. `DistributionService` and
 *    `YieldOrchestrator` route to `addPendingYield` when chain is
 *    off, *without* invoking any callback at all). This is the
 *    primary kill switch for the existing yield path.
 * 3. **The facade's gate** (this file). Every chain operation has a
 *    single entry point that re-asserts `chainEnabled`. Adding a new
 *    chain SDK call to a random module bypasses layer 2; it cannot
 *    bypass layer 3, because the SDK is not allowed in any module
 *    other than `server/chain/*`. ESLint enforcement (separate
 *    slice) will tighten this further.
 *
 * Invariant: with `chainEnabled === false`, every method on
 * `ChainOps` returns a `disabled` sentinel and performs zero RPC,
 * zero signature broadcast, and zero token movement. Verified by
 * `tests/chain/ops.test.ts`.
 *
 * Implementation status: every method is currently a stub returning
 * `disabled` even when `chainEnabled === true` — the actual SDK
 * code lands in dedicated, tested slices (one per operation):
 *
 * | Op                      | Slice that lands the impl              |
 * | ----------------------- | -------------------------------------- |
 * | `executeYieldPayout`    | `chain_yield_sink`                     |
 * | `buildBetEscrowDeposit` | `chain_bet_escrow`                     |
 * | `verifyBetEscrowDeposit`| `chain_bet_escrow`                     |
 * | `executeBuyback`        | `chain_buyback`                        |
 * | `getHolderBalance`      | `holder_verification`                  |
 * | `verifyHolderQualified` | `holder_verification`                  |
 * | `getOnChainStake`       | (deferred — read-only, low priority)   |
 *
 * When `chainEnabled === true` and an op has no implementation yet,
 * the method throws `ChainOpNotImplementedError`. The boot fn
 * (`server/index.ts`) treats this as a startup failure for ops it
 * needs (e.g. yield sink) and refuses to come up. This is by design
 * — the alternative ("silently no-op") would lose user funds.
 */

import type { AstroidRuntime } from '../config/runtime.js';
import type { GameLogger } from '../game/interfaces.js';

import type { HolderVerifyResult } from './holder.js';
import type {
  BuildError,
  ClaimBuildResult,
  StakeVerification,
  TransactionBuildResult,
  UserStakeInfo,
} from './staking.js';

// Re-export staking view types so consumers (gateway) can type the wire
// envelopes without importing `staking.ts` directly — that module pulls
// the heavy web3/Quarry SDKs, which must stay confined to `chain/*` and
// off the gateway's always-loaded path.
export type {
  BuildError,
  ClaimBuildResult,
  StakeVerification,
  TransactionBuildResult,
  UserStakeInfo,
} from './staking.js';

// ---------------------------------------------------------------------------
// Result + error types
// ---------------------------------------------------------------------------

/** Sentinel returned by every method when `chainEnabled === false`. */
export interface DisabledChainResult {
  ok: false;
  disabled: true;
  message: string;
}

/** Successful chain operation; on-chain transaction signature included. */
export interface ChainTxSuccess {
  ok: true;
  disabled: false;
  /** Solana transaction signature (base58). */
  signature: string;
}

/** Read-only chain query result (no transaction signature). */
export interface ChainReadResult<T> {
  ok: true;
  disabled: false;
  data: T;
}

export type ChainTxResult = ChainTxSuccess | DisabledChainResult;
export type ChainQueryResult<T> = ChainReadResult<T> | DisabledChainResult;

/** Built (but unsigned) transaction returned to clients for them to sign. */
export interface BuiltTransaction {
  ok: true;
  disabled: false;
  /** Base64-encoded serialized transaction (browser wallets accept this). */
  serializedTx: string;
  /** Pre-flight: amount the user is committing, in human-readable units. */
  amount: number;
  /** Pre-flight: identifier of what the deposit is for (raidId, etc.). */
  context: string;
  /**
   * Blockhash the tx was built against + its last-valid height. Present when
   * the wallet must submit the tx itself (e.g. the wager deposit) and needs a
   * blockhash confirmation strategy. Absent for builds the server submits.
   */
  blockhash?: string;
  lastValidBlockHeight?: number;
}

export type BuildTxResult = BuiltTransaction | DisabledChainResult;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when `chainEnabled === true` but the operator forgot to wire
 * up the implementation. Boot fn catches and refuses to come up.
 */
export class ChainOpNotImplementedError extends Error {
  constructor(
    public readonly op: string,
    public readonly slice: string,
  ) {
    super(
      `Chain op '${op}' has no implementation yet. ` +
        `It will land in slice '${slice}'. ` +
        `Either implement it, set CHAIN_ENABLED=false, or wire a callback that supplies it.`,
    );
    this.name = 'ChainOpNotImplementedError';
  }
}

/**
 * Thrown when `chainEnabled === true` but a required runtime config
 * field is missing (e.g. `rpcUrl` unset). Should never happen in
 * practice — `runtime.ts` already validates these at boot — but
 * defense in depth.
 */
export class ChainMisconfiguredError extends Error {
  constructor(missing: string) {
    super(
      `Chain enabled but ${missing} is unset. ` +
        `Set the required env vars or unset CHAIN_ENABLED.`,
    );
    this.name = 'ChainMisconfiguredError';
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ChainOpsConfig {
  /** The whole runtime (we only read chain-related fields). */
  runtime: AstroidRuntime;
  logger?: GameLogger;
  /**
   * Optional pluggable implementations. When chain SDK code lands in
   * its own slice, that slice constructs its impl and passes it via
   * `impls`. `ChainOps` then delegates to the impl while still
   * gating on `chainEnabled`. This keeps the SDK out of `ChainOps`
   * itself — `ChainOps` only knows about the gate.
   */
  impls?: Partial<ChainOpsImplementations>;
}

/**
 * Pluggable per-op implementations. Each is `undefined` until the
 * relevant slice lands. `ChainOps` calls `impls.<op>?.(args)` and
 * throws `ChainOpNotImplementedError` if undefined.
 */
export interface ChainOpsImplementations {
  executeYieldPayout(walletAddress: string, amount: number, asteroidId: string): Promise<string>;
  buildBetEscrowDeposit(
    walletAddress: string,
    amount: number,
    raidId: string,
  ): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number }>;
  verifyBetEscrowDeposit(
    signature: string,
    walletAddress: string,
    amount: number,
    raidId: string,
  ): Promise<boolean>;
  /** Return a winning raider's escrowed wager (treasury → wallet). */
  returnBetEscrow(walletAddress: string, amount: number, raidId: string): Promise<string>;
  /** Pay a defender their stake-weighted share of a lost raid's defender spoils. */
  payBetDefender(walletAddress: string, amount: number, raidId: string): Promise<string>;
  /** Burn the deflationary-sink share of a lost raid's forfeited wager. */
  burnBetEscrow(amount: number, raidId: string): Promise<string>;
  executeBuyback(amountSol: number): Promise<{ tokensReceived: number; signature: string }>;
  /**
   * Bridge in-game IOU credits to on-chain IOU-ASTROID: server-signed
   * treasury → player transfer. The caller debits the in-game ledger
   * first. Returns the transaction signature.
   */
  bridgeIou(walletAddress: string, amount: number): Promise<string>;
  getHolderBalance(walletAddress: string): Promise<number>;
  verifyHolderQualified(walletAddress: string): Promise<HolderVerifyResult>;
  getOnChainStake(walletAddress: string): Promise<{ amount: number; lastUpdate: number }>;
  // -- Quarry staking (chain_quarry_staking) --
  buildStakeTx(walletAddress: string, amount: number): Promise<TransactionBuildResult | BuildError>;
  buildUnstakeTx(
    walletAddress: string,
    amount: number,
  ): Promise<TransactionBuildResult | BuildError>;
  buildClaimTx(walletAddress: string): Promise<ClaimBuildResult | BuildError>;
  buildRedeemTx(
    walletAddress: string,
    amount: number,
  ): Promise<TransactionBuildResult | BuildError>;
  /**
   * Co-sign (treasury) and submit a wallet-signed atomic redeem swap. Only
   * wired when the IOU redeemer treasury is configured. The gateway supplies
   * the transaction IT issued (`builtTransaction`) plus the wallet-signed
   * version so the impl can prove they share the same message before signing.
   */
  coSignAndSubmitRedeem(
    walletAddress: string,
    args: {
      builtTransaction: string;
      signedTransaction: string;
      blockhash: string;
      lastValidBlockHeight: number;
    },
  ): Promise<string>;
  verifyStakeTx(
    signature: string,
    walletAddress: string,
    expectedAmount: number,
  ): Promise<StakeVerification>;
  getStakeInfo(walletAddress: string): Promise<UserStakeInfo>;
  /** Read a wallet's on-chain Astroid Creds (bridged IOU) balance, UI units. */
  getCredsBalance(walletAddress: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// ChainOps
// ---------------------------------------------------------------------------

/**
 * Single chokepoint for chain side effects. Every method either:
 *   - returns `{ ok: false, disabled: true, ... }` when chain is off, or
 *   - delegates to `impls.<op>` when chain is on (throwing
 *     `ChainOpNotImplementedError` if the impl is missing).
 *
 * No `@solana/*` import in this file. The SDK is the responsibility
 * of the impl modules under `server/chain/<op>.ts` (deferred).
 */
export class ChainOps {
  private readonly chainEnabled: boolean;
  private readonly runtime: AstroidRuntime;
  private readonly impls: Partial<ChainOpsImplementations>;
  private readonly log: GameLogger;

  constructor(config: ChainOpsConfig) {
    this.runtime = config.runtime;
    this.chainEnabled = config.runtime.chainEnabled;
    this.impls = config.impls ?? {};
    this.log = config.logger ?? defaultLogger();

    if (this.chainEnabled) {
      // Defense-in-depth: if `runtime.ts`'s requireEnv didn't
      // fail-loud, this catches a partial config.
      if (!this.runtime.rpcUrl) throw new ChainMisconfiguredError('SOLANA_RPC_URL');
      if (!this.runtime.astroidMint) throw new ChainMisconfiguredError('ASTROID_MINT_ADDRESS');
      this.log.warn(
        '[ChainOps] CHAIN_ENABLED=true. Chain operations will dispatch to their ' +
          'configured implementations. Unimplemented ops will throw at the call site.',
      );
    } else {
      this.log.info(
        '[ChainOps] CHAIN_ENABLED=false. All chain operations are disabled. ' +
          'Yield, escrow, buyback, holder checks return `disabled` sentinels.',
      );
    }
  }

  /** Whether chain operations are active. */
  isEnabled(): boolean {
    return this.chainEnabled;
  }

  // -------- Yield sink --------

  /**
   * Pay out distributed yield for one wallet. Called by the
   * `DistributionService` callback path when `CHAIN_ENABLED=true`.
   * Returns the transaction signature on success.
   */
  async executeYieldPayout(
    walletAddress: string,
    amount: number,
    asteroidId: string,
  ): Promise<ChainTxResult> {
    if (!this.chainEnabled) return disabled('executeYieldPayout');
    const impl = this.impls.executeYieldPayout;
    if (!impl) throw new ChainOpNotImplementedError('executeYieldPayout', 'chain_yield_sink');
    const signature = await impl(walletAddress, amount, asteroidId);
    return { ok: true, disabled: false, signature };
  }

  // -------- Bet escrow --------

  /**
   * Build (but do not sign or send) a bet-deposit transaction the
   * client will sign with their wallet. Server then verifies the
   * signed tx via `verifyBetEscrowDeposit` before crediting the
   * in-memory `BetEscrow` ledger.
   */
  async buildBetEscrowDeposit(
    walletAddress: string,
    amount: number,
    raidId: string,
  ): Promise<BuildTxResult> {
    if (!this.chainEnabled) return disabled('buildBetEscrowDeposit');
    const impl = this.impls.buildBetEscrowDeposit;
    if (!impl) throw new ChainOpNotImplementedError('buildBetEscrowDeposit', 'chain_bet_escrow');
    const built = await impl(walletAddress, amount, raidId);
    return {
      ok: true,
      disabled: false,
      serializedTx: built.transaction,
      amount,
      context: raidId,
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
    };
  }

  /**
   * Verify that the supplied transaction signature represents a
   * valid bet deposit of `amount` $ASTROID from `walletAddress`
   * tagged with `raidId`. Returns true on success, false if the tx
   * does not match.
   */
  async verifyBetEscrowDeposit(
    signature: string,
    walletAddress: string,
    amount: number,
    raidId: string,
  ): Promise<ChainQueryResult<boolean>> {
    if (!this.chainEnabled) return disabled('verifyBetEscrowDeposit');
    const impl = this.impls.verifyBetEscrowDeposit;
    if (!impl) throw new ChainOpNotImplementedError('verifyBetEscrowDeposit', 'chain_bet_escrow');
    const verified = await impl(signature, walletAddress, amount, raidId);
    return { ok: true, disabled: false, data: verified };
  }

  /**
   * Return a WINNING raider's escrowed wager. Server-signed treasury →
   * wallet transfer. The caller resolves the in-memory ledger first; this
   * only moves the token. Returns the transaction signature.
   */
  async returnBetEscrow(
    walletAddress: string,
    amount: number,
    raidId: string,
  ): Promise<ChainTxResult> {
    if (!this.chainEnabled) return disabled('returnBetEscrow');
    const impl = this.impls.returnBetEscrow;
    if (!impl) throw new ChainOpNotImplementedError('returnBetEscrow', 'chain_bet_escrow');
    const signature = await impl(walletAddress, amount, raidId);
    return { ok: true, disabled: false, signature };
  }

  /**
   * Pay a defender their stake-weighted share of a lost raid's defender spoils.
   * Server-signed treasury → defender transfer. Returns the signature.
   */
  async payBetDefender(
    walletAddress: string,
    amount: number,
    raidId: string,
  ): Promise<ChainTxResult> {
    if (!this.chainEnabled) return disabled('payBetDefender');
    const impl = this.impls.payBetDefender;
    if (!impl) throw new ChainOpNotImplementedError('payBetDefender', 'chain_bet_escrow');
    const signature = await impl(walletAddress, amount, raidId);
    return { ok: true, disabled: false, signature };
  }

  /**
   * Burn the deflationary-sink share of a lost raid's forfeited wager.
   * Server-signed SPL burn from the escrow. Returns the signature.
   */
  async burnBetEscrow(amount: number, raidId: string): Promise<ChainTxResult> {
    if (!this.chainEnabled) return disabled('burnBetEscrow');
    const impl = this.impls.burnBetEscrow;
    if (!impl) throw new ChainOpNotImplementedError('burnBetEscrow', 'chain_bet_escrow');
    const signature = await impl(amount, raidId);
    return { ok: true, disabled: false, signature };
  }

  // -------- Buyback --------

  /**
   * Execute a SOL → $ASTROID swap on a configured AMM. Used by
   * tokenomics to apply deflationary pressure (e.g. burning losing
   * raid bets via market buys).
   */
  async executeBuyback(
    amountSol: number,
  ): Promise<ChainQueryResult<{ tokensReceived: number; signature: string }>> {
    if (!this.chainEnabled) return disabled('executeBuyback');
    const impl = this.impls.executeBuyback;
    if (!impl) throw new ChainOpNotImplementedError('executeBuyback', 'chain_buyback');
    const data = await impl(amountSol);
    return { ok: true, disabled: false, data };
  }

  // -------- IOU bridge (in-game credits -> on-chain IOU) --------

  /**
   * Bridge `amount` of a wallet's in-game IOU credits to on-chain
   * IOU-ASTROID via a server-signed treasury transfer. The caller
   * (gateway) must debit the in-game ledger before calling and refund it
   * if this rejects/throws. Returns the transaction signature.
   */
  async bridgeIou(walletAddress: string, amount: number): Promise<ChainTxResult> {
    if (!this.chainEnabled) return disabled('bridgeIou');
    const impl = this.impls.bridgeIou;
    if (!impl) throw new ChainOpNotImplementedError('bridgeIou', 'chain_iou_bridge');
    const signature = await impl(walletAddress, amount);
    return { ok: true, disabled: false, signature };
  }

  // -------- Holder verification --------

  /**
   * Read a wallet's $ASTROID balance from the chain. Read-only;
   * still gated on `chainEnabled` because RPC traffic counts as a
   * side effect (rate limits, billing).
   */
  async getHolderBalance(walletAddress: string): Promise<ChainQueryResult<number>> {
    if (!this.chainEnabled) return disabled('getHolderBalance');
    const impl = this.impls.getHolderBalance;
    if (!impl) throw new ChainOpNotImplementedError('getHolderBalance', 'holder_verification');
    const data = await impl(walletAddress);
    return { ok: true, disabled: false, data };
  }

  /**
   * Continuous-hold check (flash-loan mitigation). Returns true if
   * the wallet has held at least `runtime.holderMinBalance` for at
   * least `runtime.holderMinHoldSeconds`.
   */
  async verifyHolderQualified(
    walletAddress: string,
  ): Promise<ChainQueryResult<HolderVerifyResult>> {
    if (!this.chainEnabled) return disabled('verifyHolderQualified');
    const impl = this.impls.verifyHolderQualified;
    if (!impl) throw new ChainOpNotImplementedError('verifyHolderQualified', 'holder_verification');
    const data = await impl(walletAddress);
    return { ok: true, disabled: false, data };
  }

  // -------- On-chain stake read --------

  /** Read on-chain stake state (mirrors `StakeManager` for verification). */
  async getOnChainStake(
    walletAddress: string,
  ): Promise<ChainQueryResult<{ amount: number; lastUpdate: number }>> {
    if (!this.chainEnabled) return disabled('getOnChainStake');
    const impl = this.impls.getOnChainStake;
    if (!impl) throw new ChainOpNotImplementedError('getOnChainStake', 'on_chain_stake_read');
    const data = await impl(walletAddress);
    return { ok: true, disabled: false, data };
  }

  // -------- Quarry staking (build-and-sign) --------
  //
  // Each builder returns the unsigned, serialized transaction the
  // client signs with their wallet, OR a `{ error }` shape the SDK
  // produced (e.g. insufficient balance). Both are wrapped in a
  // `ChainQueryResult` so the gateway can branch on `disabled` first.

  /** Build an unsigned stake tx for `amount` $ASTROID. */
  async buildStakeTx(
    walletAddress: string,
    amount: number,
  ): Promise<ChainQueryResult<TransactionBuildResult | BuildError>> {
    if (!this.chainEnabled) return disabled('buildStakeTx');
    const impl = this.impls.buildStakeTx;
    if (!impl) throw new ChainOpNotImplementedError('buildStakeTx', 'chain_quarry_staking');
    return { ok: true, disabled: false, data: await impl(walletAddress, amount) };
  }

  /** Build an unsigned unstake (withdraw) tx for `amount` $ASTROID. */
  async buildUnstakeTx(
    walletAddress: string,
    amount: number,
  ): Promise<ChainQueryResult<TransactionBuildResult | BuildError>> {
    if (!this.chainEnabled) return disabled('buildUnstakeTx');
    const impl = this.impls.buildUnstakeTx;
    if (!impl) throw new ChainOpNotImplementedError('buildUnstakeTx', 'chain_quarry_staking');
    return { ok: true, disabled: false, data: await impl(walletAddress, amount) };
  }

  /** Build an unsigned claim-rewards tx (claims all pending IOU-ASTROID). */
  async buildClaimTx(
    walletAddress: string,
  ): Promise<ChainQueryResult<ClaimBuildResult | BuildError>> {
    if (!this.chainEnabled) return disabled('buildClaimTx');
    const impl = this.impls.buildClaimTx;
    if (!impl) throw new ChainOpNotImplementedError('buildClaimTx', 'chain_quarry_staking');
    return { ok: true, disabled: false, data: await impl(walletAddress) };
  }

  /** Build an unsigned redeem tx (transfer IOU-ASTROID to the redeemer). */
  async buildRedeemTx(
    walletAddress: string,
    amount: number,
  ): Promise<ChainQueryResult<TransactionBuildResult | BuildError>> {
    if (!this.chainEnabled) return disabled('buildRedeemTx');
    const impl = this.impls.buildRedeemTx;
    if (!impl) throw new ChainOpNotImplementedError('buildRedeemTx', 'chain_quarry_staking');
    return { ok: true, disabled: false, data: await impl(walletAddress, amount) };
  }

  /** Treasury co-sign + submit for a wallet-signed atomic redeem swap. */
  async coSignAndSubmitRedeem(
    walletAddress: string,
    args: {
      builtTransaction: string;
      signedTransaction: string;
      blockhash: string;
      lastValidBlockHeight: number;
    },
  ): Promise<ChainTxResult> {
    if (!this.chainEnabled) return disabled('coSignAndSubmitRedeem');
    const impl = this.impls.coSignAndSubmitRedeem;
    if (!impl) throw new ChainOpNotImplementedError('coSignAndSubmitRedeem', 'chain_iou_bridge');
    const signature = await impl(walletAddress, args);
    return { ok: true, disabled: false, signature };
  }

  /** Verify a submitted staking tx confirmed on-chain with our memo. */
  async verifyStakeTx(
    signature: string,
    walletAddress: string,
    expectedAmount: number,
  ): Promise<ChainQueryResult<StakeVerification>> {
    if (!this.chainEnabled) return disabled('verifyStakeTx');
    const impl = this.impls.verifyStakeTx;
    if (!impl) throw new ChainOpNotImplementedError('verifyStakeTx', 'chain_quarry_staking');
    return { ok: true, disabled: false, data: await impl(signature, walletAddress, expectedAmount) };
  }

  /** Read a wallet's on-chain Quarry stake position. */
  async getStakeInfo(walletAddress: string): Promise<ChainQueryResult<UserStakeInfo>> {
    if (!this.chainEnabled) return disabled('getStakeInfo');
    const impl = this.impls.getStakeInfo;
    if (!impl) throw new ChainOpNotImplementedError('getStakeInfo', 'chain_quarry_staking');
    return { ok: true, disabled: false, data: await impl(walletAddress) };
  }

  /**
   * Read a wallet's on-chain Astroid Creds (bridged IOU) balance, UI units.
   * Lets the client surface a "Redeem Creds" action for credits sitting in the
   * wallet from a bridge whose redeem step hasn't completed yet.
   */
  async getCredsBalance(walletAddress: string): Promise<ChainQueryResult<number>> {
    if (!this.chainEnabled) return disabled('getCredsBalance');
    const impl = this.impls.getCredsBalance;
    if (!impl) throw new ChainOpNotImplementedError('getCredsBalance', 'chain_iou_bridge');
    return { ok: true, disabled: false, data: await impl(walletAddress) };
  }

  // -------- Convenience for the GameWorld callback --------

  /**
   * Adapter that matches `YieldPayoutListener` from
   * `DistributionService`. Wraps `executeYieldPayout` so it can be
   * passed to `GameWorld({ onYieldPayout })`. Synchronous wrapper
   * around the async op — fire-and-forget, errors logged. Boot fn
   * is responsible for calling this only when chain is enabled (the
   * orchestrator already gates internally; this is layer 3).
   */
  toYieldPayoutListener(): (walletAddress: string, amount: number, asteroidId: string) => void {
    return (walletAddress, amount, asteroidId) => {
      // The orchestrator only calls this when chainEnabled, but we
      // still re-check here for layer-3 defense.
      if (!this.chainEnabled) {
        this.log.warn(
          `[ChainOps] yield payout listener invoked while chain is off; dropping ` +
            `${amount} for ${walletAddress.slice(0, 8)} at ${asteroidId}`,
        );
        return;
      }
      this.executeYieldPayout(walletAddress, amount, asteroidId)
        .then((result) => {
          if (!result.ok) {
            this.log.error(
              `[ChainOps] yield payout returned disabled (unexpected with chain on): ` +
                `${result.message}`,
            );
            return;
          }
          this.log.info(
            `[ChainOps] yield payout sent: ${amount} $ASTROID -> ` +
              `${walletAddress.slice(0, 8)}... (sig=${result.signature.slice(0, 12)}...)`,
          );
        })
        .catch((err) => {
          this.log.error('[ChainOps] yield payout failed:', err);
        });
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function disabled(op: string): DisabledChainResult {
  return {
    ok: false,
    disabled: true,
    message: `${op}: chain disabled (CHAIN_ENABLED=false)`,
  };
}

function defaultLogger(): GameLogger {
  return {
    info: (msg, ...rest) => console.info(msg, ...rest),
    warn: (msg, ...rest) => console.warn(msg, ...rest),
    error: (msg, ...rest) => console.error(msg, ...rest),
  };
}
