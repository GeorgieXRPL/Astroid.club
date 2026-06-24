/**
 * Quarry-based on-chain staking for astroid.club.
 *
 * Ported from Black-Gold's audited `server/solana/staking.ts` into the
 * astroid `server/chain/*` boundary. Custody is non-custodial Quarry:
 * the in-memory `StakeManager` is only a mirror; the durable truth
 * lives on-chain.
 *
 * Flow (unchanged from the audited source):
 *   1. Server builds an unsigned stake/unstake/claim/redeem tx.
 *   2. Frontend signs it with the Privy-connected wallet.
 *   3. Frontend submits the signed tx to the cluster.
 *   4. Server verifies on-chain (memo tag + confirmation).
 *
 * Users stake $ASTROID, earn an IOU-ASTROID reward token (Quarry
 * MintWrapper emissions), and redeem IOU → $ASTROID via a redeemer
 * wallet.
 *
 * Decimals — the one substantive fix vs. the source: $ASTROID and
 * IOU-ASTROID can have *different* decimals (our mainnet target:
 * $ASTROID is a pump.fun-style 6-dec mint, IOU is the Solana-default
 * 9-dec MintWrapper token). The source scaled both by a single
 * `TOKEN_CONFIG.DECIMALS`, which silently mis-scales redemption and
 * reward amounts when the two differ. Here staked amounts use
 * `astroidDecimals` and IOU amounts (rewards, redemption) use
 * `iouDecimals`.
 *
 * The heavy, loosely-typed Quarry + Saber + web3.js-v1 SDKs are
 * confined to this file and loaded via `createRequire` (they ship as
 * CommonJS; Node's ESM loader can't see their named exports — the same
 * interop `scripts/localnet/deploy-quarry.ts` uses). They never
 * pollute the strict shared build.
 */

import { createRequire } from 'node:module';

// Type-only namespace imports: erased at compile time (no runtime
// `import`), so they don't trip the ESM-can't-enumerate-CJS-named-
// exports problem that affects value imports of these packages.
import type * as QuarrySDKModule from '@quarryprotocol/quarry-sdk';
import type * as SaberContribModule from '@saberhq/solana-contrib';
import type * as TokenUtilsModule from '@saberhq/token-utils';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

import type { GameLogger } from '../game/interfaces.js';

// --- CommonJS interop for the Quarry / Saber SDKs ------------------------
//
// `typeof import(...)` gives us the full .d.ts types at compile time;
// `require(...)` (cast to that type) gives us a working value at
// runtime. Static `import { QuarrySDK }` throws at runtime because the
// ESM loader can't enumerate these CJS modules' named exports.
const cjsRequire = createRequire(import.meta.url);

interface QuarryDeps {
  QuarrySDK: (typeof QuarrySDKModule)['QuarrySDK'];
  SolanaProvider: (typeof SaberContribModule)['SolanaProvider'];
  Token: (typeof TokenUtilsModule)['Token'];
  TokenAmount: (typeof TokenUtilsModule)['TokenAmount'];
}

/**
 * Minimal typed surface over the four `@solana/spl-token` functions we
 * use. Loaded via `createRequire` rather than a static import because
 * the dependency tree carries two spl-token majors (top-level 0.4.x +
 * a saber-nested 0.1.x), and TS module resolution can't unambiguously
 * pick the 0.4.x types from this path. Requiring the top-level package
 * at runtime resolves the right one; this interface re-asserts the
 * 0.4.x signatures we depend on.
 */
interface SplTokenSurface {
  getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): Promise<PublicKey>;
  createAssociatedTokenAccountInstruction(
    payer: PublicKey,
    associatedToken: PublicKey,
    owner: PublicKey,
    mint: PublicKey,
  ): TransactionInstruction;
  createTransferInstruction(
    source: PublicKey,
    destination: PublicKey,
    owner: PublicKey,
    amount: bigint | number,
  ): TransactionInstruction;
  getAccount(connection: Connection, address: PublicKey): Promise<{ amount: bigint }>;
}

let cachedSplToken: SplTokenSurface | null = null;

function loadSplToken(): SplTokenSurface {
  cachedSplToken ??= cjsRequire('@solana/spl-token') as SplTokenSurface;
  return cachedSplToken;
}

let cachedQuarryDeps: QuarryDeps | null = null;

/** Load (and cache) the Quarry/Saber SDK surface via CJS interop. */
function loadQuarrySDK(): QuarryDeps {
  if (cachedQuarryDeps) return cachedQuarryDeps;
  const quarry = cjsRequire('@quarryprotocol/quarry-sdk') as typeof QuarrySDKModule;
  const saber = cjsRequire('@saberhq/solana-contrib') as typeof SaberContribModule;
  const tokenUtils = cjsRequire('@saberhq/token-utils') as typeof TokenUtilsModule;
  cachedQuarryDeps = {
    QuarrySDK: quarry.QuarrySDK,
    SolanaProvider: saber.SolanaProvider,
    Token: tokenUtils.Token,
    TokenAmount: tokenUtils.TokenAmount,
  };
  return cachedQuarryDeps;
}

// --- Memo program (SPL Memo v2) ------------------------------------------

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/** Tag a transaction with a tracking memo signed by the user. */
function createMemoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, 'utf-8'),
  });
}

// --- Config --------------------------------------------------------------

/** Fully-resolved Quarry staking configuration. */
export interface QuarryStakingConfig {
  /** Solana JSON-RPC endpoint. */
  rpcUrl: string;
  /** The staked credential token — $ASTROID (was COAL in the source). */
  astroidMint: string;
  /** $ASTROID decimals (e.g. 6). */
  astroidDecimals: number;
  /** Quarry Rewarder address. */
  rewarderAddress: string;
  /** Quarry (pool) address for $ASTROID. */
  quarryAddress: string;
  /** MintWrapper address controlling IOU emissions (optional for reads). */
  mintWrapperAddress: string | null;
  /** IOU-ASTROID reward-token mint. */
  iouTokenMint: string | null;
  /** IOU-ASTROID decimals (e.g. 9). */
  iouDecimals: number;
  /** Redeemer wallet that receives IOU on redemption. */
  redeemerWallet: string | null;
}

/**
 * Resolve the Quarry config from environment variables. Reading env at
 * the `server/chain/*` boundary mirrors the existing holder adapter and
 * keeps the staking-specific program addresses out of the shared
 * `runtime`. Returns `null` when staking isn't configured (missing
 * rewarder/quarry/mint) so callers can no-op cleanly.
 */
export function getQuarryConfigFromEnv(): QuarryStakingConfig | null {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const astroidMint = process.env.ASTROID_MINT_ADDRESS;
  const rewarderAddress = process.env.QUARRY_REWARDER_ADDRESS;
  const quarryAddress = process.env.QUARRY_ADDRESS;
  if (!rpcUrl || !astroidMint || !rewarderAddress || !quarryAddress) {
    return null;
  }
  return {
    rpcUrl,
    astroidMint,
    astroidDecimals: Number(process.env.ASTROID_DECIMALS ?? '9'),
    rewarderAddress,
    quarryAddress,
    mintWrapperAddress: process.env.QUARRY_MINT_WRAPPER || null,
    iouTokenMint: process.env.IOU_TOKEN_MINT || null,
    iouDecimals: Number(process.env.IOU_TOKEN_DECIMALS ?? '9'),
    redeemerWallet:
      process.env.REDEEMER_WALLET_ADDRESS || process.env.REDEEMER_WALLET_PUBKEY || null,
  };
}

/** True when Quarry staking is configured for this deployment. */
export function isQuarryAvailable(): boolean {
  return getQuarryConfigFromEnv() !== null;
}

// --- Result / view types -------------------------------------------------

/** Unsigned transaction handed to the frontend for signing. */
export interface TransactionBuildResult {
  /** Base64-serialized transaction. */
  transaction: string;
  /** Human-readable description of what the user is signing. */
  message: string;
  lastValidBlockHeight: number;
  blockhash: string;
  /**
   * When true, this transaction also needs a SERVER co-signer (the
   * treasury), and the client must NOT broadcast it. Instead the wallet
   * signs it WITHOUT submitting (`signTransaction`) and hands it back via
   * `submit_redeem_swap`, where the server adds its signature and submits.
   *
   * This ordering (wallet first, treasury after) is deliberate: it means
   * the wallet never sees a transaction that already carries a foreign
   * signature while moving the user's tokens out — the exact pattern
   * Phantom's scanner flags as a potential drainer. Only the atomic redeem
   * swap sets this; every other build is single-signer and submitted by
   * the wallet directly.
   */
  requiresCoSign?: boolean;
}

/** A claim build additionally carries the estimated reward at build time. */
export interface ClaimBuildResult extends TransactionBuildResult {
  /** Pending IOU-ASTROID reward at build time (UI units). */
  estimatedReward: number;
}

/** Error shape returned by builders when they can't proceed. */
export interface BuildError {
  error: string;
}

/** A user's stake position read from on-chain Quarry state. */
export interface UserStakeInfo {
  walletAddress: string;
  /** Staked $ASTROID in UI units. */
  stakedAmount: number;
  /** Pending IOU-ASTROID rewards in UI units. */
  pendingRewards: number;
  lastStakeTime: Date | null;
  minerPDA: string | null;
}

/** Result of verifying a submitted staking transaction. */
export interface StakeVerification {
  verified: boolean;
  actualAmount?: number;
  error?: string;
}

// --- Small numeric helpers ----------------------------------------------

function toRawAmount(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * Math.pow(10, decimals)));
}

function fromRawAmount(raw: number, decimals: number): number {
  return raw / Math.pow(10, decimals);
}

/** Coerce a BN / bigint / numeric-ish field to a JS number. */
function coerceToNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const maybeBn = value as { toNumber?: () => number; toString?: () => string };
  if (typeof maybeBn.toNumber === 'function') return maybeBn.toNumber();
  if (typeof maybeBn.toString === 'function') return Number(maybeBn.toString());
  return 0;
}

function isBuildError(v: TransactionBuildResult | BuildError): v is BuildError {
  return (v as BuildError).error !== undefined;
}

export { isBuildError };

// --- Adapter -------------------------------------------------------------

/**
 * Builds and verifies Quarry staking transactions for a single
 * configured deployment. Holds no key material — every transaction it
 * returns is unsigned and serialized for the client to sign with their
 * own wallet (the non-custodial invariant). Read-only queries use a
 * dummy-wallet provider.
 */
export class QuarryStakingAdapter {
  private readonly config: QuarryStakingConfig;
  private readonly connection: Connection;
  private readonly log: GameLogger;

  constructor(config: QuarryStakingConfig, deps: { connection?: Connection; logger?: GameLogger } = {}) {
    this.config = config;
    this.connection = deps.connection ?? new Connection(config.rpcUrl, 'confirmed');
    this.log = deps.logger ?? silentLogger();
  }

  /** Expose the connection for the e2e harness (submit / confirm). */
  get rpc(): Connection {
    return this.connection;
  }

  // -- internal: provider + quarry handles --------------------------------

  /** Provider bound to a real user pubkey (the user signs later). */
  private buildUserProvider(userPubkey: PublicKey) {
    const { SolanaProvider } = loadQuarrySDK();
    return SolanaProvider.init({
      connection: this.connection,
      wallet: {
        publicKey: userPubkey,
        signTransaction: async (tx: Transaction) => tx,
        signAllTransactions: async (txs: Transaction[]) => txs,
      },
    });
  }

  /** Dummy-wallet provider for read-only Quarry queries. */
  private buildReadOnlyProvider() {
    const { SolanaProvider } = loadQuarrySDK();
    return SolanaProvider.init({
      connection: this.connection,
      wallet: {
        publicKey: PublicKey.default,
        signTransaction: async (tx: Transaction) => tx,
        signAllTransactions: async (txs: Transaction[]) => txs,
      },
    });
  }

  private astroidToken() {
    const { Token } = loadQuarrySDK();
    return Token.fromMint(new PublicKey(this.config.astroidMint), this.config.astroidDecimals, {
      name: 'Astroid',
      symbol: 'ASTROID',
    });
  }

  /** Load the QuarryWrapper for $ASTROID from a given provider. */
  private async loadQuarry(provider: ReturnType<QuarryStakingAdapter['buildReadOnlyProvider']>) {
    const { QuarrySDK } = loadQuarrySDK();
    const sdk = QuarrySDK.load({ provider });
    const rewarderWrapper = await sdk.mine.loadRewarderWrapper(
      new PublicKey(this.config.rewarderAddress),
    );
    return rewarderWrapper.getQuarry(this.astroidToken());
  }

  // -- builders -----------------------------------------------------------

  /** Build an unsigned stake tx for `amount` $ASTROID (UI units). */
  async buildStakeTransaction(
    walletAddress: string,
    amount: number,
  ): Promise<TransactionBuildResult | BuildError> {
    try {
      const userPubkey = new PublicKey(walletAddress);
      const { TokenAmount } = loadQuarrySDK();
      const provider = this.buildUserProvider(userPubkey);
      const quarry = await this.loadQuarry(provider);

      const minerActions = await quarry.getMinerActions(userPubkey);
      const minerKey = await quarry.getMinerAddress(userPubkey);
      const minerExists = (await this.connection.getAccountInfo(minerKey)) !== null;

      const transaction = new Transaction();
      transaction.add(
        createMemoInstruction(`quarry_stake:${amount}:${this.config.quarryAddress}`, userPubkey),
      );

      if (!minerExists) {
        const pendingMiner = await quarry.createMiner({ authority: userPubkey });
        transaction.add(...pendingMiner.tx.instructions);
      }

      const rawAmount = toRawAmount(amount, this.config.astroidDecimals);
      const stakeAmount = new TokenAmount(this.astroidToken(), rawAmount.toString());
      const stakeTx = await minerActions.stake(stakeAmount);
      transaction.add(...stakeTx.instructions);

      return this.finalize(transaction, userPubkey, `Stake ${amount} $ASTROID in the astroid.club Quarry`);
    } catch (err) {
      return this.buildErrorFor('stake', err);
    }
  }

  /** Build an unsigned unstake (withdraw) tx for `amount` $ASTROID. */
  async buildUnstakeTransaction(
    walletAddress: string,
    amount: number,
  ): Promise<TransactionBuildResult | BuildError> {
    try {
      const userPubkey = new PublicKey(walletAddress);
      const { TokenAmount } = loadQuarrySDK();
      const provider = this.buildUserProvider(userPubkey);
      const quarry = await this.loadQuarry(provider);

      const minerActions = await quarry.getMinerActions(userPubkey);
      const rawAmount = toRawAmount(amount, this.config.astroidDecimals);
      const unstakeAmount = new TokenAmount(this.astroidToken(), rawAmount.toString());
      const unstakeTx = await minerActions.withdraw(unstakeAmount);

      const transaction = new Transaction();
      transaction.add(
        createMemoInstruction(`quarry_unstake:${amount}:${this.config.quarryAddress}`, userPubkey),
      );
      transaction.add(...unstakeTx.instructions);

      return this.finalize(
        transaction,
        userPubkey,
        `Unstake ${amount} $ASTROID from the astroid.club Quarry`,
      );
    } catch (err) {
      return this.buildErrorFor('unstake', err);
    }
  }

  /** Build an unsigned claim-rewards tx (claims all pending IOU-ASTROID). */
  async buildClaimRewardsTransaction(
    walletAddress: string,
  ): Promise<ClaimBuildResult | BuildError> {
    try {
      const userPubkey = new PublicKey(walletAddress);
      const provider = this.buildUserProvider(userPubkey);
      const quarry = await this.loadQuarry(provider);

      const stakeInfo = await this.getUserStakeInfo(walletAddress);
      const estimatedReward = stakeInfo.pendingRewards;

      const minerActions = await quarry.getMinerActions(userPubkey);
      const claimTx = await minerActions.claim();

      const transaction = new Transaction();
      transaction.add(
        createMemoInstruction(`quarry_claim:${this.config.quarryAddress}`, userPubkey),
      );
      transaction.add(...claimTx.instructions);

      const finalized = await this.finalize(
        transaction,
        userPubkey,
        'Claim IOU-ASTROID rewards from the astroid.club Quarry',
      );
      if (isBuildError(finalized)) return finalized;
      return { ...finalized, estimatedReward };
    } catch (err) {
      return this.buildErrorFor('claim', err);
    }
  }

  /**
   * Build an unsigned redeem tx: transfer `amount` IOU-ASTROID from the
   * user to the redeemer wallet (the server's buyback/redeemer service
   * then returns $ASTROID, handled in a later slice). Uses IOU decimals.
   */
  async buildRedeemTransaction(
    walletAddress: string,
    amount: number,
  ): Promise<TransactionBuildResult | BuildError> {
    if (!this.config.iouTokenMint) {
      return { error: 'IOU token not configured' };
    }
    if (!this.config.redeemerWallet) {
      return { error: 'Redeemer wallet not configured (set REDEEMER_WALLET_ADDRESS).' };
    }

    try {
      const userPubkey = new PublicKey(walletAddress);
      const redeemerPubkey = new PublicKey(this.config.redeemerWallet);
      const iouMintPubkey = new PublicKey(this.config.iouTokenMint);
      const splToken = loadSplToken();

      const userATA = await splToken.getAssociatedTokenAddress(iouMintPubkey, userPubkey);
      const redeemerATA = await splToken.getAssociatedTokenAddress(iouMintPubkey, redeemerPubkey);

      const transaction = new Transaction();
      transaction.add(
        createMemoInstruction(
          `quarry_redeem:${amount}:${this.config.iouTokenMint}`,
          userPubkey,
        ),
      );

      // Create the redeemer's ATA if it doesn't exist yet (user pays).
      let redeemerAtaExists = true;
      try {
        await splToken.getAccount(this.connection, redeemerATA);
      } catch {
        redeemerAtaExists = false;
      }
      if (!redeemerAtaExists) {
        transaction.add(
          splToken.createAssociatedTokenAccountInstruction(
            userPubkey,
            redeemerATA,
            redeemerPubkey,
            iouMintPubkey,
          ),
        );
      }

      // IOU uses its own decimals, NOT $ASTROID's.
      const rawAmount = toRawAmount(amount, this.config.iouDecimals);
      transaction.add(
        splToken.createTransferInstruction(userATA, redeemerATA, userPubkey, rawAmount),
      );

      return this.finalize(
        transaction,
        userPubkey,
        `Redeem ${amount} IOU-ASTROID for $ASTROID`,
      );
    } catch (err) {
      return this.buildErrorFor('redeem', err);
    }
  }

  // -- reads --------------------------------------------------------------

  /** Read a wallet's stake position from on-chain Quarry state. */
  async getUserStakeInfo(walletAddress: string): Promise<UserStakeInfo> {
    const defaultInfo: UserStakeInfo = {
      walletAddress,
      stakedAmount: 0,
      pendingRewards: 0,
      lastStakeTime: null,
      minerPDA: null,
    };

    try {
      const userPubkey = new PublicKey(walletAddress);
      const provider = this.buildReadOnlyProvider();
      const quarry = await this.loadQuarry(provider);

      const minerKey = await quarry.getMinerAddress(userPubkey);
      const minerInfo = await this.connection.getAccountInfo(minerKey);
      if (!minerInfo) return defaultInfo;

      const miner = await quarry.getMiner(userPubkey);
      if (!miner) return defaultInfo;

      const minerData = miner as unknown as Record<string, unknown>;
      const stakedRaw = coerceToNumber(
        minerData.balance ?? minerData.tokensDeposited ?? minerData.tokenBalance,
      );
      const rewardsRaw = coerceToNumber(minerData.rewardsEarned ?? minerData.rewardsTally);

      return {
        walletAddress,
        // staked is denominated in $ASTROID; rewards in IOU-ASTROID.
        stakedAmount: fromRawAmount(stakedRaw, this.config.astroidDecimals),
        pendingRewards: fromRawAmount(rewardsRaw, this.config.iouDecimals),
        lastStakeTime: null, // SDK doesn't expose this directly
        minerPDA: minerKey.toBase58(),
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes('Account does not exist')) {
        return defaultInfo;
      }
      this.log.warn(`[Staking] getUserStakeInfo failed for ${walletAddress.slice(0, 8)}…: ${errMsg(err)}`);
      return defaultInfo;
    }
  }

  /**
   * Verify a submitted staking transaction confirmed on-chain and
   * carries our stake memo. Returns `verified: true` with the expected
   * amount echoed back. (Parsing the precise staked delta out of the
   * tx is deferred — confirmation + memo tag is the audited gate.)
   */
  async verifyStakeTransaction(
    signature: string,
    walletAddress: string,
    expectedAmount: number,
  ): Promise<StakeVerification> {
    try {
      const result = await this.connection.confirmTransaction(signature, 'confirmed');
      if (result.value.err) {
        return { verified: false, error: 'Transaction failed on-chain' };
      }

      const txDetails = await this.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!txDetails) {
        return { verified: false, error: 'Transaction not found' };
      }

      const logs = txDetails.meta?.logMessages ?? [];
      const hasStakeMemo = logs.some((line) => line.includes('quarry_stake'));
      if (!hasStakeMemo) {
        return { verified: false, error: 'Not a valid stake transaction' };
      }

      this.log.info(`[Staking] verified stake ${signature.slice(0, 12)}… for ${walletAddress.slice(0, 8)}…`);
      return { verified: true, actualAmount: expectedAmount };
    } catch (err) {
      return { verified: false, error: errMsg(err) };
    }
  }

  // -- helpers ------------------------------------------------------------

  /** Attach a recent blockhash + fee payer and serialize (unsigned). */
  private async finalize(
    transaction: Transaction,
    feePayer: PublicKey,
    message: string,
  ): Promise<TransactionBuildResult> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = feePayer;
    const serialized = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    return {
      transaction: serialized.toString('base64'),
      message,
      lastValidBlockHeight,
      blockhash,
    };
  }

  /** Map common SDK errors to friendly messages. */
  private buildErrorFor(action: string, err: unknown): BuildError {
    this.log.error(`[Staking] failed to build ${action} transaction:`, err);
    if (err instanceof Error) {
      if (err.message.includes('Account does not exist')) {
        return { error: 'Quarry account not found. Ensure Quarry is deployed.' };
      }
      if (err.message.includes('insufficient funds') || err.message.includes('insufficient balance')) {
        return { error: 'Insufficient balance for this action.' };
      }
      return { error: err.message };
    }
    return { error: `Unknown error building ${action} transaction` };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function silentLogger(): GameLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}
