/**
 * IOU bridge + atomic redeemer for astroid.club (Phase B — the IOU
 * money-flow). Two custodial operations backed by ONE treasury hot
 * wallet that holds both pre-minted Astroid Creds and $ASTROID:
 *
 *   1. **bridge** (in-game credits → on-chain IOU): server-signed
 *      transfer of Astroid Creds from the treasury to the player. The
 *      caller (gateway/world) debits the player's in-game credit ledger
 *      first (`StakeManager.redeemPendingYield`), so this only moves the
 *      token. Mirrors `RewardPayoutAdapter` exactly.
 *
 *   2. **buildRedeemSwap** (on-chain IOU → $ASTROID): an ATOMIC swap in
 *      a single transaction — the user's IOU goes to the treasury AND the
 *      treasury's $ASTROID goes to the user. The server PARTIAL-SIGNS the
 *      $ASTROID-out leg here; the user signs the IOU-out leg and submits.
 *      Because both legs share one transaction, redemption can't
 *      half-complete and there is no "verify-then-pay" window to exploit.
 *
 * CUSTODY: the treasury key (`REDEEMER_TREASURY_PRIVATE_KEY`) is a hot
 * wallet. Fund it with only as much IOU + $ASTROID as you're willing to
 * expose; top up out of band. The key is read once, kept in-memory, and
 * NEVER logged (errors are sanitized).
 *
 * Pre-minted treasury model (no live mint authority): the operator mints
 * an IOU supply once into this wallet; the bridge hands it out and the
 * swap takes it back, so supply recirculates. The server cannot mint.
 *
 * The heavy spl-token surface is loaded via `createRequire` for the same
 * CJS/ESM-interop reason as `rewards.ts` / `staking.ts`.
 */

import { createRequire } from 'node:module';

import {
  Connection,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import type { GameLogger } from '../game/interfaces.js';

import type { BuildError, TransactionBuildResult } from './staking.js';

// --- CommonJS interop for @solana/spl-token (see rewards.ts) -------------

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
}

let cachedSplToken: SplTokenSurface | null = null;

function loadSplToken(): SplTokenSurface {
  cachedSplToken ??= cjsRequire('@solana/spl-token') as SplTokenSurface;
  return cachedSplToken;
}

// --- Memo (SPL Memo v2) --------------------------------------------------

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

function memoIx(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, 'utf-8'),
  });
}

// --- Config --------------------------------------------------------------

/** Fully-resolved redeemer configuration. */
export interface RedeemerConfig {
  rpcUrl: string;
  /** Astroid Creds mint (the token the bridge hands out / swap takes back). */
  iouMint: string;
  /** Astroid Creds decimals (default 9). */
  iouDecimals: number;
  /** $ASTROID mint (the token redemption pays out). */
  astroidMint: string;
  /** $ASTROID decimals (default 6). */
  astroidDecimals: number;
  /** Treasury keypair holding pre-minted IOU + $ASTROID (hot wallet). */
  treasury: Keypair;
  /** $ASTROID paid per 1 Astroid Creds (UI units). Default 1.0. */
  redeemRate: number;
  /** Priority fee (micro-lamports) attached to the server-signed bridge tx. */
  priorityMicroLamports: number;
}

/**
 * Parse a keypair from an env var (default `REDEEMER_TREASURY_PRIVATE_KEY`).
 * Accepts a JSON 64-byte secret array or a base58 string. NEVER logs the
 * key. Same loader semantics as the reward wallet. The `envVar` override lets
 * the escrow layer custody wagers in a SEPARATE hot wallet (`ESCROW_PRIVATE_KEY`)
 * so escrowed funds aren't commingled with the redeemer float.
 */
export function loadTreasuryKeypair(envVar = 'REDEEMER_TREASURY_PRIVATE_KEY'): Keypair {
  const raw = process.env[envVar];
  if (!raw) {
    throw new Error(`${envVar} is required to wire the IOU bridge / redeemer.`);
  }
  if (raw.length < 32) {
    throw new Error(`${envVar} appears to be too short.`);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length === 64) {
      return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
    }
  } catch {
    // not JSON; fall through to base58
  }
  try {
    const mod = cjsRequire('bs58') as {
      decode?: (s: string) => Uint8Array;
      default?: { decode(s: string): Uint8Array };
    };
    const decode = mod.decode ?? mod.default?.decode;
    if (!decode) throw new Error('bs58 decode unavailable');
    return Keypair.fromSecretKey(decode(raw));
  } catch {
    throw new Error(`Failed to parse ${envVar}. Use a JSON array or base58 string.`);
  }
}

/**
 * Resolve the redeemer config from the environment, or null when the
 * treasury / mints aren't configured (so the boot layer leaves the bridge
 * + swap unwired and they report `chain_disabled`).
 */
export function getRedeemerConfigFromEnv(): RedeemerConfig | null {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const iouMint = process.env.IOU_TOKEN_MINT;
  const astroidMint = process.env.ASTROID_MINT_ADDRESS;
  if (!rpcUrl || !iouMint || !astroidMint || !process.env.REDEEMER_TREASURY_PRIVATE_KEY) {
    return null;
  }
  return {
    rpcUrl,
    iouMint,
    iouDecimals: Number(process.env.IOU_TOKEN_DECIMALS ?? '9'),
    astroidMint,
    astroidDecimals: Number(process.env.ASTROID_DECIMALS ?? '6'),
    treasury: loadTreasuryKeypair(),
    redeemRate: Number(process.env.REDEEM_RATE ?? '1'),
    priorityMicroLamports: Number(process.env.REDEEM_PRIORITY_MICROLAMPORTS ?? '5000'),
  };
}

// --- Helpers -------------------------------------------------------------

function toRawAmount(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * Math.pow(10, decimals)));
}

function sanitizeError(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';
  return err.message
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, '[REDACTED_KEY]')
    .replace(/\[[\d,\s]{100,}\]/g, '[REDACTED_ARRAY]');
}

async function accountExists(connection: Connection, address: PublicKey): Promise<boolean> {
  const splToken = loadSplToken();
  try {
    await splToken.getAccount(connection, address);
    return true;
  } catch {
    return false;
  }
}

// --- Service -------------------------------------------------------------

/**
 * Treasury-backed IOU bridge + atomic redeemer. One instance per gateway;
 * holds the hot treasury keypair.
 */
export class RedeemerService {
  private readonly connection: Connection;
  private readonly iouMint: PublicKey;
  private readonly astroidMint: PublicKey;
  private readonly log: GameLogger;

  constructor(
    private readonly config: RedeemerConfig,
    deps: { connection?: Connection; logger?: GameLogger } = {},
  ) {
    this.connection = deps.connection ?? new Connection(config.rpcUrl, 'confirmed');
    this.iouMint = new PublicKey(config.iouMint);
    this.astroidMint = new PublicKey(config.astroidMint);
    this.log = deps.logger ?? console;
  }

  /** The treasury wallet's public address (safe to log/expose). */
  get treasuryAddress(): string {
    return this.config.treasury.publicKey.toBase58();
  }

  /**
   * Read `walletAddress`'s on-chain Astroid Creds (IOU) balance in UI units.
   * Returns 0 when the wallet has no Astroid Creds account yet. Drives the
   * one-click "Redeem Creds" affordance for credits that were bridged but not
   * yet redeemed (e.g. a claim whose redeem step didn't finish, or a session
   * that reloaded before redeeming).
   */
  async credsBalance(walletAddress: string): Promise<number> {
    const splToken = loadSplToken();
    try {
      const owner = new PublicKey(walletAddress);
      const ata = await splToken.getAssociatedTokenAddress(this.iouMint, owner);
      const account = await splToken.getAccount(this.connection, ata);
      return Number(account.amount) / Math.pow(10, this.config.iouDecimals);
    } catch {
      // No ATA / not found → nothing redeemable.
      return 0;
    }
  }

  /**
   * Bridge: transfer `iouAmount` Astroid Creds (UI units) from the treasury
   * to `walletAddress`. Server-signed + confirmed. The CALLER must have
   * already debited the player's in-game credits — this only moves the
   * token. Resolves with the base58 signature; throws a sanitized error
   * on failure so the caller can refund the debited credits.
   */
  async bridge(walletAddress: string, iouAmount: number): Promise<string> {
    const splToken = loadSplToken();
    const treasury = this.config.treasury;
    try {
      const recipient = new PublicKey(walletAddress);
      const rawIou = toRawAmount(iouAmount, this.config.iouDecimals);
      if (rawIou <= 0n) {
        throw new Error(`Refusing to bridge a non-positive amount (${iouAmount}).`);
      }

      const treasuryIouATA = await splToken.getAssociatedTokenAddress(
        this.iouMint,
        treasury.publicKey,
      );
      const treasuryIou = await splToken.getAccount(this.connection, treasuryIouATA);
      if (treasuryIou.amount < rawIou) {
        throw new Error(
          `Insufficient IOU treasury balance (needs ${iouAmount} Astroid Creds). Top up the treasury.`,
        );
      }

      const tx = new Transaction();
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.config.priorityMicroLamports,
        }),
      );
      tx.add(memoIx(`astroid_bridge:${iouAmount}:${this.config.iouMint}`, treasury.publicKey));

      const userIouATA = await splToken.getAssociatedTokenAddress(this.iouMint, recipient);
      if (!(await accountExists(this.connection, userIouATA))) {
        tx.add(
          splToken.createAssociatedTokenAccountInstruction(
            treasury.publicKey,
            userIouATA,
            recipient,
            this.iouMint,
          ),
        );
      }
      tx.add(
        splToken.createTransferInstruction(treasuryIouATA, userIouATA, treasury.publicKey, rawIou),
      );

      const signature = await sendAndConfirmTransaction(this.connection, tx, [treasury], {
        commitment: 'confirmed',
        maxRetries: 3,
      });
      this.log.info?.(
        `[redeemer] bridged ${iouAmount} Astroid Creds to ${walletAddress.slice(0, 8)}… ` +
          `| tx ${signature.slice(0, 8)}…`,
      );
      return signature;
    } catch (err) {
      const message = sanitizeError(err);
      this.log.error?.(`[redeemer] bridge failed: ${message}`);
      throw new Error(`bridge failed: ${message}`);
    }
  }

  /**
   * Build an ATOMIC redeem-swap for `iouAmount` Astroid Creds (UI units):
   * one unsigned transaction that transfers the user's IOU to the treasury
   * AND the treasury's `iouAmount * redeemRate` $ASTROID to the user. The
   * treasury leg is partial-signed here; the user signs the IOU leg and
   * submits. Returns a `BuildError` (not a throw) on a recoverable problem
   * (insufficient user IOU / treasury $ASTROID) so the gateway can relay it.
   */
  async buildRedeemSwap(
    walletAddress: string,
    iouAmount: number,
  ): Promise<TransactionBuildResult | BuildError> {
    const splToken = loadSplToken();
    const treasury = this.config.treasury;
    try {
      if (!Number.isFinite(iouAmount) || iouAmount <= 0) {
        return { error: 'Redeem amount must be greater than zero.' };
      }
      const user = new PublicKey(walletAddress);
      const rawIou = toRawAmount(iouAmount, this.config.iouDecimals);
      const astroidOut = iouAmount * this.config.redeemRate;
      const rawAstroid = toRawAmount(astroidOut, this.config.astroidDecimals);
      if (rawAstroid <= 0n) {
        return { error: 'Redeem amount is too small to pay out any $ASTROID.' };
      }

      const userIouATA = await splToken.getAssociatedTokenAddress(this.iouMint, user);
      const treasuryIouATA = await splToken.getAssociatedTokenAddress(
        this.iouMint,
        treasury.publicKey,
      );
      const userAstroidATA = await splToken.getAssociatedTokenAddress(this.astroidMint, user);
      const treasuryAstroidATA = await splToken.getAssociatedTokenAddress(
        this.astroidMint,
        treasury.publicKey,
      );

      // The user must actually hold the IOU they're redeeming.
      let userIou: { amount: bigint };
      try {
        userIou = await splToken.getAccount(this.connection, userIouATA);
      } catch {
        return { error: 'You have no Astroid Creds to redeem. Bridge in-game credits first.' };
      }
      if (userIou.amount < rawIou) {
        return { error: `Insufficient Astroid Creds balance (need ${iouAmount}).` };
      }

      // The treasury must be able to cover the $ASTROID payout.
      const treasuryAstroid = await splToken.getAccount(this.connection, treasuryAstroidATA);
      if (treasuryAstroid.amount < rawAstroid) {
        return { error: 'Redemption treasury is low on $ASTROID. Try again later.' };
      }

      const tx = new Transaction();
      tx.add(memoIx(`astroid_redeem_swap:${iouAmount}:${this.config.iouMint}`, user));

      // Treasury's IOU ATA must exist to receive the user's IOU.
      if (!(await accountExists(this.connection, treasuryIouATA))) {
        tx.add(
          splToken.createAssociatedTokenAccountInstruction(
            treasury.publicKey,
            treasuryIouATA,
            treasury.publicKey,
            this.iouMint,
          ),
        );
      }
      // Create the user's $ASTROID ATA if needed (treasury pays rent).
      if (!(await accountExists(this.connection, userAstroidATA))) {
        tx.add(
          splToken.createAssociatedTokenAccountInstruction(
            treasury.publicKey,
            userAstroidATA,
            user,
            this.astroidMint,
          ),
        );
      }

      // Leg 1: user IOU -> treasury (user signs).
      tx.add(splToken.createTransferInstruction(userIouATA, treasuryIouATA, user, rawIou));
      // Leg 2: treasury $ASTROID -> user (treasury signs).
      tx.add(
        splToken.createTransferInstruction(
          treasuryAstroidATA,
          userAstroidATA,
          treasury.publicKey,
          rawAstroid,
        ),
      );

      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = user;

      // Deliberately DO NOT sign the treasury leg here. The wallet must sign
      // a CLEAN transaction first (`signTransaction`, no broadcast); the
      // treasury co-signs afterward in `coSignAndSubmitRedeem`. Pre-attaching
      // the treasury signature is what makes Phantom flag this as a drainer
      // (a foreign signature on a tx that moves the user's tokens out).
      const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      return {
        transaction: serialized.toString('base64'),
        message: `Redeem ${iouAmount} Astroid Creds for ${astroidOut} $ASTROID`,
        lastValidBlockHeight,
        blockhash,
        requiresCoSign: true,
      };
    } catch (err) {
      const message = sanitizeError(err);
      this.log.error?.(`[redeemer] failed to build redeem swap: ${message}`);
      return { error: `Failed to build redeem transaction: ${message}` };
    }
  }

  /**
   * Co-sign and submit a wallet-signed redeem swap.
   *
   * The wallet signed the CLEAN transaction we issued from
   * {@link buildRedeemSwap} (no treasury signature attached) and handed it
   * back. We now add the treasury's signature for the $ASTROID-out leg and
   * broadcast it.
   *
   * SECURITY — this is the gate that makes co-signing a client-submitted
   * transaction safe. The fee payer must be the authenticated wallet, the
   * blockhash must be the one we issued, and the submission must contain
   * EXACTLY the instructions we built (in order) plus, at most, benign extras
   * from programs that cannot move funds — ComputeBudget (priority fees) and
   * Lighthouse (Phantom's transaction-guard asserts). Any other program — i.e.
   * anything that could abuse the treasury's signature to move funds — is
   * rejected before the treasury signs. The `built` transaction is supplied by
   * the gateway from its own cache of what it issued — never reconstructed
   * from client input.
   *
   * Resolves with the confirmed base58 signature; throws a sanitized error
   * on any mismatch / failure (nothing is lost — if it didn't land, the
   * user still holds their IOU and can retry).
   */
  async coSignAndSubmitRedeem(
    walletAddress: string,
    args: {
      builtTransaction: string;
      signedTransaction: string;
      blockhash: string;
      lastValidBlockHeight: number;
    },
  ): Promise<string> {
    const treasury = this.config.treasury;
    try {
      const user = new PublicKey(walletAddress);
      const built = Transaction.from(Buffer.from(args.builtTransaction, 'base64'));
      const signed = Transaction.from(Buffer.from(args.signedTransaction, 'base64'));

      // The fee payer must be the authenticated wallet.
      if (!signed.feePayer?.equals(user)) {
        throw new Error('Redeem fee payer is not the authenticated wallet.');
      }

      // The submitted tx must spend the SAME blockhash we issued, so the
      // confirmation parameters below stay valid (and a stale/replayed redeem
      // can't be slipped in).
      if (signed.recentBlockhash !== args.blockhash) {
        this.log.error?.(
          `[redeemer] redeem rejected: blockhash changed by wallet ` +
            `(issued ${args.blockhash.slice(0, 8)}… got ${(signed.recentBlockhash ?? 'none').slice(0, 8)}…)`,
        );
        throw new Error('Submitted transaction does not match the redeem we issued.');
      }

      // SECURITY GATE — we are about to add the TREASURY's signature to a
      // client-submitted transaction, so we must prove it does exactly what we
      // built and nothing that abuses the treasury's authority. We do NOT
      // require byte-identical messages, because real wallets legitimately add
      // instructions when signing — Phantom prepends ComputeBudget (priority
      // fees) AND appends Lighthouse assertion guards, so a 3-instruction
      // redeem can come back with a dozen. We enforce two rules:
      //   1. every instruction WE built must appear, in order — so the user
      //      can't drop their IOU-payment leg while keeping the treasury's
      //      $ASTROID payout leg, and
      //   2. every EXTRA instruction must belong to a program that provably
      //      cannot move funds: ComputeBudget (only sets fee/CU; touches no
      //      accounts) or Lighthouse (assertions + writes to its own PDAs; it
      //      cannot CPI-transfer SPL/SOL out of any account). A signature is
      //      transaction-wide, so we can't tell per-instruction whether the
      //      treasury "signs" a given extra — hence we gate on the PROGRAM,
      //      not on signer flags. Any other program in an extra is rejected
      //      before the treasury ever signs.
      const SAFE_EXTRA_PROGRAMS = new Set<string>([
        ComputeBudgetProgram.programId.toBase58(),
        // Lighthouse — Phantom's transaction-guard program.
        'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95',
      ]);
      const normalize = (ix: TransactionInstruction): string =>
        JSON.stringify([
          ix.programId.toBase58(),
          ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
          Buffer.from(ix.data).toString('base64'),
        ]);
      const builtIxs = built.instructions.map(normalize);
      let next = 0;
      for (const ix of signed.instructions) {
        if (next < builtIxs.length && normalize(ix) === builtIxs[next]) {
          next += 1;
          continue;
        }
        if (SAFE_EXTRA_PROGRAMS.has(ix.programId.toBase58())) continue;
        this.log.error?.(
          `[redeemer] redeem rejected: unexpected program ${ix.programId.toBase58()} ` +
            `(built=${built.instructions.length} signed=${signed.instructions.length})`,
        );
        throw new Error('Submitted transaction does not match the redeem we issued.');
      }
      if (next !== builtIxs.length) {
        this.log.error?.(
          `[redeemer] redeem rejected: missing required instructions ` +
            `(matched ${next}/${builtIxs.length})`,
        );
        throw new Error('Submitted transaction does not match the redeem we issued.');
      }

      // The wallet's signature must already be present and valid over the
      // message (requireAllSignatures=false: the treasury slot is still empty).
      if (!signed.verifySignatures(false)) {
        throw new Error('Redeem is missing a valid wallet signature.');
      }

      // Add the treasury's $ASTROID-out signature. partialSign does not touch
      // the message, so the wallet's signature stays valid.
      signed.partialSign(treasury);
      if (!signed.verifySignatures()) {
        throw new Error('Redeem is still missing a required signature after co-signing.');
      }

      const signature = await this.connection.sendRawTransaction(signed.serialize(), {
        maxRetries: 3,
      });
      await this.connection.confirmTransaction(
        {
          signature,
          blockhash: args.blockhash,
          lastValidBlockHeight: args.lastValidBlockHeight,
        },
        'confirmed',
      );
      this.log.info?.(
        `[redeemer] co-signed + submitted redeem for ${walletAddress.slice(0, 8)}… ` +
          `| tx ${signature.slice(0, 8)}…`,
      );
      return signature;
    } catch (err) {
      const message = sanitizeError(err);
      this.log.error?.(`[redeemer] co-sign submit failed: ${message}`);
      throw new Error(`redeem submit failed: ${message}`);
    }
  }
}
