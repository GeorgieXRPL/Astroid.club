/**
 * On-chain discovery-reward payout for astroid.club (the `chain_yield_sink`
 * slice).
 *
 * Ported from Black-Gold's audited `server/solana/rewards.ts`. This is
 * the implementation behind `ChainOps.executeYieldPayout`: when the
 * game's `DistributionService` resolves a per-asteroid discovery reward
 * and chain is on, the gateway transfers that amount of **$ASTROID**
 * from a server-held **reward-pool wallet** to the player.
 *
 * CUSTODY MODEL (deliberately different from staking): unlike the
 * non-custodial build-and-sign staking flow, reward payouts are signed
 * server-side by a hot **reward wallet** whose key lives in
 * `REWARD_WALLET_PRIVATE_KEY`. Treat it as a hot wallet:
 *   - fund it with only as much $ASTROID as you're willing to expose;
 *   - top it up from the buyback / treasury out of band;
 *   - the key is read once, kept in-memory, and NEVER logged.
 * This mirrors Black-Gold's tested reward-pool design.
 *
 * The reward amount is the game's UI-unit figure; it's scaled by
 * `$ASTROID` decimals (NOT IOU decimals — rewards pay the base token).
 */

import { createRequire } from 'node:module';

import {
  Connection,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';

import type { GameLogger } from '../game/interfaces.js';

// --- CommonJS interop for @solana/spl-token ------------------------------
//
// Same rationale as staking.ts: the dependency tree carries two
// spl-token majors (top-level 0.4.x + a saber-nested 0.1.x), so we
// `require` the top-level package at runtime and re-assert the 0.4.x
// signatures we use through a minimal typed surface.
const cjsRequire = createRequire(import.meta.url);

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
  TokenAccountNotFoundError: new (...args: unknown[]) => Error;
}

let cachedSplToken: SplTokenSurface | null = null;

function loadSplToken(): SplTokenSurface {
  cachedSplToken ??= cjsRequire('@solana/spl-token') as SplTokenSurface;
  return cachedSplToken;
}

// --- Config --------------------------------------------------------------

/** Fully-resolved reward-payout configuration. */
export interface RewardPayoutConfig {
  rpcUrl: string;
  /** $ASTROID mint — the token rewards are paid in. */
  astroidMint: string;
  /** $ASTROID decimals (mainnet target: 6). */
  astroidDecimals: number;
  /** The reward-pool wallet keypair (hot wallet; signs payouts). */
  rewardWallet: Keypair;
  /** Priority fee (micro-lamports) attached to each payout. */
  priorityMicroLamports: number;
}

/**
 * Parse the reward wallet key from `REWARD_WALLET_PRIVATE_KEY`.
 * Accepts a JSON 64-byte secret array (Phantom export) or a base58
 * string. NEVER logs the key or its parse details.
 */
export function loadRewardWalletKeypair(): Keypair {
  const raw = process.env.REWARD_WALLET_PRIVATE_KEY;
  if (!raw) {
    throw new Error('REWARD_WALLET_PRIVATE_KEY is required to wire on-chain reward payouts.');
  }
  if (raw.length < 32) {
    throw new Error('REWARD_WALLET_PRIVATE_KEY appears to be too short.');
  }
  // JSON array form first.
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length === 64) {
      return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
    }
  } catch {
    // not JSON; fall through to base58
  }
  try {
    // bs58 v6 ships as ESM-with-CJS-interop: `require('bs58')` returns
    // `{ default: { decode } }`, so reach through `.default` when the
    // top-level `decode` isn't present.
    const mod = cjsRequire('bs58') as {
      decode?: (s: string) => Uint8Array;
      default?: { decode(s: string): Uint8Array };
    };
    const decode = mod.decode ?? mod.default?.decode;
    if (!decode) throw new Error('bs58 decode unavailable');
    return Keypair.fromSecretKey(decode(raw));
  } catch {
    // Generic message — never leak key-format hints.
    throw new Error(
      'Failed to parse REWARD_WALLET_PRIVATE_KEY. Use a JSON array or base58 string.',
    );
  }
}

/**
 * Build the reward config from the environment, or return null when the
 * reward wallet isn't configured (so the boot layer leaves
 * `executeYieldPayout` unwired and chain-yield payouts stay disabled).
 */
export function getRewardConfigFromEnv(): RewardPayoutConfig | null {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const astroidMint = process.env.ASTROID_MINT_ADDRESS;
  if (!rpcUrl || !astroidMint || !process.env.REWARD_WALLET_PRIVATE_KEY) {
    return null;
  }
  return {
    rpcUrl,
    astroidMint,
    astroidDecimals: Number(process.env.ASTROID_DECIMALS ?? '6'),
    rewardWallet: loadRewardWalletKeypair(),
    priorityMicroLamports: Number(process.env.REWARD_PRIORITY_MICROLAMPORTS ?? '5000'),
  };
}

// --- Helpers -------------------------------------------------------------

function toRawAmount(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * Math.pow(10, decimals)));
}

/**
 * Strip anything that looks like a key (long base58 run or a big number
 * array) out of an error message before it's logged or returned.
 */
function sanitizeError(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';
  return err.message
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, '[REDACTED_KEY]')
    .replace(/\[[\d,\s]{100,}\]/g, '[REDACTED_ARRAY]');
}

// --- Adapter -------------------------------------------------------------

/**
 * Transfers $ASTROID discovery rewards from the reward-pool wallet to
 * players. One instance per gateway; holds the hot reward keypair.
 */
export class RewardPayoutAdapter {
  private readonly connection: Connection;
  private readonly mint: PublicKey;
  private readonly logger: GameLogger;

  constructor(
    private readonly config: RewardPayoutConfig,
    deps: { logger?: GameLogger } = {},
  ) {
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    this.mint = new PublicKey(config.astroidMint);
    this.logger = deps.logger ?? console;
  }

  /**
   * Pay `amount` (UI units of $ASTROID) to `recipientAddress`. Creates
   * the recipient's ATA if absent (reward wallet pays rent), checks the
   * pool has enough, attaches a priority fee, and confirms. Resolves
   * with the base58 signature. Throws a sanitized error on failure (the
   * caller — `ChainOps.executeYieldPayout` — surfaces it).
   */
  async payout(recipientAddress: string, amount: number, asteroidId?: string): Promise<string> {
    const splToken = loadSplToken();
    const payer = this.config.rewardWallet;

    try {
      const recipient = new PublicKey(recipientAddress);
      const rawAmount = toRawAmount(amount, this.config.astroidDecimals);
      if (rawAmount <= 0n) {
        throw new Error(`Refusing to pay a non-positive reward (${amount}).`);
      }

      const sourceATA = await splToken.getAssociatedTokenAddress(this.mint, payer.publicKey);
      const sourceAccount = await splToken.getAccount(this.connection, sourceATA);
      if (sourceAccount.amount < rawAmount) {
        throw new Error(
          `Insufficient reward pool balance (needs ${amount} $ASTROID). Top up the reward wallet.`,
        );
      }

      const transaction = new Transaction();
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.config.priorityMicroLamports,
        }),
      );

      const destATA = await splToken.getAssociatedTokenAddress(this.mint, recipient);
      let destExists = true;
      try {
        await splToken.getAccount(this.connection, destATA);
      } catch {
        destExists = false;
      }
      if (!destExists) {
        transaction.add(
          splToken.createAssociatedTokenAccountInstruction(
            payer.publicKey,
            destATA,
            recipient,
            this.mint,
          ),
        );
      }

      transaction.add(
        splToken.createTransferInstruction(sourceATA, destATA, payer.publicKey, rawAmount),
      );

      const signature = await sendAndConfirmTransaction(this.connection, transaction, [payer], {
        commitment: 'confirmed',
        maxRetries: 3,
      });

      this.logger.info?.(
        `[rewards] paid ${amount} $ASTROID to ${recipientAddress.slice(0, 8)}…` +
          `${asteroidId ? ` (asteroid=${asteroidId})` : ''} | tx ${signature.slice(0, 8)}…`,
      );
      return signature;
    } catch (err) {
      const message = sanitizeError(err);
      this.logger.error?.(`[rewards] payout failed: ${message}`);
      throw new Error(`reward payout failed: ${message}`);
    }
  }

  /** Current reward-pool balance in UI units (0 on read failure). */
  async getPoolBalance(): Promise<number> {
    try {
      const splToken = loadSplToken();
      const sourceATA = await splToken.getAssociatedTokenAddress(
        this.mint,
        this.config.rewardWallet.publicKey,
      );
      const account = await splToken.getAccount(this.connection, sourceATA);
      return Number(account.amount) / Math.pow(10, this.config.astroidDecimals);
    } catch (err) {
      this.logger.error?.(`[rewards] pool balance read failed: ${sanitizeError(err)}`);
      return 0;
    }
  }

  /** The reward-pool wallet's public address (safe to log/expose). */
  get rewardWalletAddress(): string {
    return this.config.rewardWallet.publicKey.toBase58();
  }
}
