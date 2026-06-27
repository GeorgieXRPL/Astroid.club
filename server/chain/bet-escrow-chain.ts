/**
 * On-chain counterpart to the in-memory bet ledger (`server/game/bet-escrow.ts`).
 *
 * This is the `bet-escrow-chain.ts` slice the ledger's docstring promises.
 * It mirrors the audited custody model of `redeemer.ts` exactly: ONE
 * treasury hot wallet (reusing `REDEEMER_TREASURY_PRIVATE_KEY`) holds the
 * escrowed $ASTROID, and the SAME wallet co-/server-signs settlement. The
 * raid-wager money-flow has four legs:
 *
 *   1. **buildDeposit** (player → escrow): an UNSIGNED transfer of the
 *      wager from the player's $ASTROID ATA to the escrow $ASTROID ATA,
 *      tagged with `astroid_raid_wager:<raidId>:<amount>:<fee>`. A SECOND
 *      transfer leg charges an escrow-creation fee ON TOP of the wager
 *      (`ceil(wager*feeBps/10000) + feeFlat`) to the fee destination (the
 *      mining treasury) as protocol revenue — the escrow ATA still receives
 *      EXACTLY the wager so the verify gate is unaffected. Fully wallet-signed
 *      (the player owns the source account) — no treasury co-sign needed, so
 *      Phantom never sees a foreign signature on a tx that moves the user's
 *      tokens. The server only VERIFIES it landed before crediting the
 *      ledger (`placeBet`).
 *   2. **verifyDeposit**: confirm the signed tx landed, carries our memo,
 *      AND actually credited the treasury ATA by >= the wager (balance-delta
 *      gate — stronger than the memo-only gate used for stake verification,
 *      because a deposit funds payouts we later make).
 *   3. **returnWager** (escrow → winner): treasury-signed transfer back to a
 *      winning raider. Server-signed + confirmed, like `redeemer.bridge`.
 *   4. **burnWager** / **payDefender** (escrow → void / defenders): on a
 *      LOSS, the ledger's resolution burns 90% and splits 10% to defenders
 *      weighted by stake. `burnWager` SPL-burns the treasury's tokens;
 *      `payDefender` transfers a defender's share to their ATA.
 *
 * Plus a deflationary **rent-offset burn**: whenever a settlement transfer
 * (return/payout) has to CREATE a recipient ATA, the escrow wallet fronts
 * ~0.002 SOL rent; in the same tx we burn the oracle-priced $ASTROID
 * equivalent of that rent — but ONLY from escrow surplus (balance above
 * outstanding liability), so it never eats funds backing live wagers.
 *
 * CUSTODY NOTE: deposits land in the treasury's main $ASTROID ATA, so
 * escrowed wagers are commingled with the redeemer's $ASTROID float (the
 * same single-hot-wallet model the redeemer already uses). The in-memory
 * ledger is the source of truth for outstanding escrow liability; keep the
 * treasury funded with a buffer above total locked bets. Splitting escrow
 * into a dedicated keypair is a future hardening step (ESCROW_PRIVATE_KEY).
 *
 * The heavy spl-token surface is loaded via `createRequire` for the same
 * CJS/ESM-interop reason as `redeemer.ts` / `staking.ts`.
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

import { loadTreasuryKeypair } from './redeemer.js';
import type { BuildError, TransactionBuildResult } from './staking.js';

// --- CommonJS interop for @solana/spl-token (see redeemer.ts) ------------

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
  createBurnInstruction(
    account: PublicKey,
    mint: PublicKey,
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

/** Stable memo prefix that tags every wager deposit so verify can match it. */
export const WAGER_MEMO_PREFIX = 'astroid_raid_wager';

function memoIx(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, 'utf-8'),
  });
}

// --- Config --------------------------------------------------------------

/** Fully-resolved bet-escrow chain configuration. */
export interface BetEscrowChainConfig {
  rpcUrl: string;
  /** $ASTROID mint (the wager token). */
  astroidMint: string;
  /** $ASTROID decimals (default 6). */
  astroidDecimals: number;
  /** Treasury keypair that custodies escrowed wagers (hot wallet). */
  treasury: Keypair;
  /** Priority fee (micro-lamports) on server-signed settlement txs. */
  priorityMicroLamports: number;
  /**
   * Escrow-creation fee, charged to the player ON TOP of the wager and routed
   * to {@link feeDestination} as protocol revenue. `fee = ceil(wager *
   * feeBps/10000) + feeFlat` (in $ASTROID token units). The escrow ATA still
   * receives EXACTLY the wager, so the verify exact-credit gate is unaffected.
   */
  feeBps: number;
  /** Flat fee component (token units) — covers account-creation overhead. */
  feeFlat: number;
  /**
   * Where the escrow-creation fee lands. Normally the mining treasury
   * (`REDEEMER_TREASURY_PRIVATE_KEY` pubkey), kept distinct from the escrow
   * custody wallet so revenue is never confused with wager liability. Falls
   * back to the escrow wallet itself in the single-wallet model.
   */
  feeDestination: PublicKey;
  /**
   * When true, each settlement payout that has to CREATE a recipient ATA (the
   * escrow wallet fronts ~0.002 SOL rent) also burns the $ASTROID-equivalent
   * of that rent — a deflationary offset for the SOL spent. Burned strictly
   * from escrow SURPLUS (balance above outstanding liability); never from
   * funds backing live wagers.
   */
  rentBurnEnabled: boolean;
}

/** Minimal price-oracle surface the rent-offset burn needs (USD spot). */
export interface PriceOracleLike {
  /** Live $ASTROID/USD. */
  getPrice(): number;
  /** Live SOL/USD. */
  getSolPrice(): number;
}

/**
 * Runtime dependencies (not env-derived) the service reads lazily at
 * settlement time. Both are nullable closures because the price oracle and
 * escrow manager are constructed AFTER this service at boot.
 */
export interface BetEscrowChainDeps {
  connection?: Connection;
  logger?: GameLogger;
  /** Lazy accessor for the live price oracle (rent → $ASTROID conversion). */
  getPriceOracle?: () => PriceOracleLike | undefined;
  /** Lazy accessor for total outstanding wager liability (token units). */
  getOutstandingLiability?: () => number;
}

/** Compute the escrow-creation fee (token units) for a wager. */
export function computeEscrowFee(wager: number, feeBps: number, feeFlat: number): number {
  if (!Number.isFinite(wager) || wager <= 0) return 0;
  const pct = Math.ceil((wager * feeBps) / 10_000);
  return pct + Math.max(0, feeFlat);
}

/**
 * Resolve the bet-escrow config from the environment, or null when the
 * treasury / mint aren't configured (so the boot layer leaves escrow
 * unwired and `ChainOps` reports `disabled`). Reuses the redeemer's
 * treasury key on purpose — one hot wallet, per the custody note above.
 */
export function getBetEscrowConfigFromEnv(): BetEscrowChainConfig | null {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const astroidMint = process.env.ASTROID_MINT_ADDRESS;
  // Prefer a DEDICATED escrow hot wallet (`ESCROW_PRIVATE_KEY`) so escrowed
  // wagers aren't commingled with the redeemer's $ASTROID float; fall back to
  // the redeemer treasury when it's unset (single-wallet model).
  const hasEscrowKey = !!process.env.ESCROW_PRIVATE_KEY;
  const hasRedeemerKey = !!process.env.REDEEMER_TREASURY_PRIVATE_KEY;
  if (!rpcUrl || !astroidMint || (!hasEscrowKey && !hasRedeemerKey)) {
    return null;
  }
  const treasury = loadTreasuryKeypair(
    hasEscrowKey ? 'ESCROW_PRIVATE_KEY' : 'REDEEMER_TREASURY_PRIVATE_KEY',
  );
  // Fee revenue → the mining treasury (redeemer) when escrow runs on a
  // dedicated key, so wager liability (escrow wallet) and protocol revenue
  // (treasury) stay separate. Single-wallet fallback: fee lands on the escrow
  // wallet itself (still tracked as surplus over liability).
  const feeDestination =
    hasEscrowKey && hasRedeemerKey
      ? loadTreasuryKeypair('REDEEMER_TREASURY_PRIVATE_KEY').publicKey
      : treasury.publicKey;
  return {
    rpcUrl,
    astroidMint,
    astroidDecimals: Number(process.env.ASTROID_DECIMALS ?? '6'),
    treasury,
    priorityMicroLamports: Number(process.env.REDEEM_PRIORITY_MICROLAMPORTS ?? '5000'),
    feeBps: Number(process.env.ESCROW_FEE_BPS ?? '200'),
    feeFlat: Number(process.env.ESCROW_FEE_FLAT ?? '5000'),
    feeDestination,
    rentBurnEnabled: (process.env.ESCROW_RENT_BURN_ENABLED ?? 'true') !== 'false',
  };
}

/** Token-account size (bytes) used to price ATA rent-exemption. */
const TOKEN_ACCOUNT_BYTES = 165;

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
 * Treasury-backed on-chain leg of the raid-wager escrow. One instance per
 * gateway; holds the hot treasury keypair. All methods throw a sanitized
 * error (never echoing key material) on failure so callers can refund the
 * in-memory ledger.
 */
export class BetEscrowChainService {
  private readonly connection: Connection;
  private readonly astroidMint: PublicKey;
  private readonly log: GameLogger;
  private readonly getPriceOracle: () => PriceOracleLike | undefined;
  private readonly getOutstandingLiability: () => number;

  /** Running tally of fees verified into the treasury (token units). */
  private feesCollected = 0;
  /** Running tally of $ASTROID burned to offset recipient-ATA rent. */
  private rentBurned = 0;
  /** Cached rent-exempt minimum for a token account (lamports). */
  private rentExemptLamports: number | null = null;

  constructor(
    private readonly config: BetEscrowChainConfig,
    deps: BetEscrowChainDeps = {},
  ) {
    this.connection = deps.connection ?? new Connection(config.rpcUrl, 'confirmed');
    this.astroidMint = new PublicKey(config.astroidMint);
    this.log = deps.logger ?? console;
    this.getPriceOracle = deps.getPriceOracle ?? (() => undefined);
    this.getOutstandingLiability = deps.getOutstandingLiability ?? (() => 0);
  }

  /** The escrow (treasury) wallet's public address — safe to log/expose. */
  get escrowAddress(): string {
    return this.config.treasury.publicKey.toBase58();
  }

  /** Ops snapshot for the admin console: revenue + deflation from escrow. */
  getFeeSummary(): { feeBps: number; feeFlat: number; feesCollected: number; rentBurned: number } {
    return {
      feeBps: this.config.feeBps,
      feeFlat: this.config.feeFlat,
      feesCollected: this.feesCollected,
      rentBurned: this.rentBurned,
    };
  }

  /** Compute the escrow-creation fee (token units) this service charges. */
  feeFor(wager: number): number {
    return computeEscrowFee(wager, this.config.feeBps, this.config.feeFlat);
  }

  /** Cached rent-exempt lamports for a fresh token account. */
  private async rentLamports(): Promise<number> {
    if (this.rentExemptLamports == null) {
      this.rentExemptLamports = await this.connection.getMinimumBalanceForRentExemption(
        TOKEN_ACCOUNT_BYTES,
      );
    }
    return this.rentExemptLamports;
  }

  /**
   * $ASTROID equivalent (raw units) of the SOL rent fronted for one ATA, via
   * the live oracle. Returns 0n when prices are unavailable so the burn is
   * simply skipped rather than guessed.
   */
  private async rentBurnRaw(): Promise<bigint> {
    const oracle = this.getPriceOracle();
    const astroidUsd = oracle?.getPrice() ?? 0;
    const solUsd = oracle?.getSolPrice() ?? 0;
    if (astroidUsd <= 0 || solUsd <= 0) return 0n;
    const rentSol = (await this.rentLamports()) / 1e9;
    const tokens = (rentSol * solUsd) / astroidUsd;
    if (!Number.isFinite(tokens) || tokens <= 0) return 0n;
    return toRawAmount(tokens, this.config.astroidDecimals);
  }

  private treasuryAtaPromise: Promise<PublicKey> | null = null;
  private feeAtaPromise: Promise<PublicKey> | null = null;

  /** Cached treasury $ASTROID ATA (the escrow destination). */
  private treasuryAta(): Promise<PublicKey> {
    this.treasuryAtaPromise ??= loadSplToken().getAssociatedTokenAddress(
      this.astroidMint,
      this.config.treasury.publicKey,
    );
    return this.treasuryAtaPromise;
  }

  /** Cached fee-destination $ASTROID ATA (protocol revenue sink). */
  private feeAta(): Promise<PublicKey> {
    this.feeAtaPromise ??= loadSplToken().getAssociatedTokenAddress(
      this.astroidMint,
      this.config.feeDestination,
    );
    return this.feeAtaPromise;
  }

  /** True when the fee lands on the same wallet that custodies escrow. */
  private get feeIsCommingled(): boolean {
    return this.config.feeDestination.equals(this.config.treasury.publicKey);
  }

  /**
   * Build (but DO NOT sign/send) a wager-deposit transaction: transfer
   * `amount` $ASTROID from the player's ATA to the treasury's escrow ATA,
   * tagged with `astroid_raid_wager:<raidId>`. The player is fee payer and
   * the sole signer (their wallet signs + submits). Returns a `BuildError`
   * (not a throw) on a recoverable problem so the gateway can relay it.
   */
  async buildDeposit(
    walletAddress: string,
    amount: number,
    raidId: string,
  ): Promise<TransactionBuildResult | BuildError> {
    const splToken = loadSplToken();
    try {
      if (!Number.isFinite(amount) || amount <= 0) {
        return { error: 'Wager must be greater than zero.' };
      }
      const user = new PublicKey(walletAddress);
      const rawAmount = toRawAmount(amount, this.config.astroidDecimals);
      if (rawAmount <= 0n) {
        return { error: 'Wager is too small to escrow.' };
      }

      // Escrow-creation fee, charged ON TOP of the wager → fee destination.
      const fee = this.feeFor(amount);
      const rawFee = toRawAmount(fee, this.config.astroidDecimals);
      const rawTotal = rawAmount + rawFee;

      const userAta = await splToken.getAssociatedTokenAddress(this.astroidMint, user);
      const treasuryAta = await this.treasuryAta();

      // The player must hold the wager PLUS the fee they're being charged.
      let userBal: { amount: bigint };
      try {
        userBal = await splToken.getAccount(this.connection, userAta);
      } catch {
        return { error: 'You have no $ASTROID in your wallet to wager.' };
      }
      if (userBal.amount < rawTotal) {
        return {
          error: `Insufficient $ASTROID balance (need ${amount} + ${fee} fee = ${amount + fee}).`,
        };
      }

      const tx = new Transaction();
      // Memo binds raid, wager AND fee; the legacy `:raidId:amount` substring
      // still matches the existing verify gate (we append `:fee`).
      tx.add(memoIx(`${WAGER_MEMO_PREFIX}:${raidId}:${amount}:${fee}`, user));

      // Escrow ATA must exist to receive the wager (player pays rent if not).
      if (!(await accountExists(this.connection, treasuryAta))) {
        tx.add(
          splToken.createAssociatedTokenAccountInstruction(
            user,
            treasuryAta,
            this.config.treasury.publicKey,
            this.astroidMint,
          ),
        );
      }
      // Wager leg: player → escrow ATA (EXACTLY the wager — verify gate relies
      // on this being unpolluted by the fee).
      tx.add(splToken.createTransferInstruction(userAta, treasuryAta, user, rawAmount));

      // Fee leg: player → fee destination. Skipped when the fee rounds to zero.
      if (rawFee > 0n) {
        const feeAta = this.feeIsCommingled ? treasuryAta : await this.feeAta();
        if (!this.feeIsCommingled && !(await accountExists(this.connection, feeAta))) {
          tx.add(
            splToken.createAssociatedTokenAccountInstruction(
              user,
              feeAta,
              this.config.feeDestination,
              this.astroidMint,
            ),
          );
        }
        tx.add(splToken.createTransferInstruction(userAta, feeAta, user, rawFee));
      }

      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = user;

      // No treasury signature: the player owns the source account and signs
      // the whole tx. (Contrast the redeem swap, which needs a treasury
      // co-sign for its treasury-out leg.)
      const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      return {
        transaction: serialized.toString('base64'),
        message:
          `Escrow ${amount} $ASTROID wager for raid ${raidId.slice(0, 8)}…` +
          (fee > 0 ? ` (+${fee} fee)` : ''),
        lastValidBlockHeight,
        blockhash,
      };
    } catch (err) {
      const message = sanitizeError(err);
      this.log.error?.(`[bet-escrow] failed to build deposit: ${message}`);
      return { error: `Failed to build wager deposit: ${message}` };
    }
  }

  /**
   * Verify a submitted wager-deposit landed: it confirmed without error,
   * carries our `astroid_raid_wager:<raidId>` memo, AND the treasury escrow
   * ATA's balance increased by at least the wager (balance-delta gate).
   * Returns true on a clean match, false otherwise. Never throws.
   */
  async verifyDeposit(
    signature: string,
    walletAddress: string,
    amount: number,
    raidId: string,
  ): Promise<boolean> {
    try {
      const confirm = await this.connection.confirmTransaction(signature, 'confirmed');
      if (confirm.value.err) return false;

      const tx = await this.connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || tx.meta?.err) return false;

      // Memo gate: the tx must carry our FULL raid-tagged wager memo, binding
      // both the raid id AND the amount (not just a prefix) so a memo built
      // for a different wager/amount can't satisfy a later submit.
      const logs = tx.meta?.logMessages ?? [];
      const memoTag = `${WAGER_MEMO_PREFIX}:${raidId}:${amount}`;
      if (!logs.some((line) => line.includes(memoTag))) return false;

      const treasury = this.config.treasury.publicKey.toBase58();
      const feeDest = this.config.feeDestination.toBase58();
      const mint = this.config.astroidMint;
      const rawAmount = toRawAmount(amount, this.config.astroidDecimals);
      const fee = this.feeFor(amount);
      const rawFee = toRawAmount(fee, this.config.astroidDecimals);

      const pre = tx.meta?.preTokenBalances ?? [];
      const post = tx.meta?.postTokenBalances ?? [];
      const delta = (owner: string): bigint => {
        const p = pre.find((b) => b.owner === owner && b.mint === mint);
        const q = post.find((b) => b.owner === owner && b.mint === mint);
        if (!q) return 0n;
        return BigInt(q.uiTokenAmount.amount) - BigInt(p?.uiTokenAmount.amount ?? '0');
      };

      // Treasury-credit gate: the escrow ATA must have GAINED EXACTLY the wager
      // in $ASTROID — or wager+fee when the fee is commingled on the same
      // wallet. Exact (not >=) so an over-transfer can't trap extra tokens with
      // no credit/refund path; the server-built tx always moves exactly this.
      if (!post.find((b) => b.owner === treasury && b.mint === mint)) return false;
      const expectedTreasuryCredit = this.feeIsCommingled ? rawAmount + rawFee : rawAmount;
      if (delta(treasury) !== expectedTreasuryCredit) return false;

      // Fee gate: when the fee lands on a SEPARATE wallet, it must have been
      // credited exactly. (Commingled fees are already covered above.)
      if (!this.feeIsCommingled && rawFee > 0n && delta(feeDest) !== rawFee) return false;

      // Depositor gate: the RAIDER's own $ASTROID account must have funded the
      // escrow (their balance dropped by >= wager + fee). Without this a third
      // party could pay the deposit for someone else's raid — the balance-delta
      // gate alone only proves the treasury was funded, not BY WHOM.
      const depositorPre = pre.find((b) => b.owner === walletAddress && b.mint === mint);
      const depositorPost = post.find((b) => b.owner === walletAddress && b.mint === mint);
      if (!depositorPre) return false;
      const debited =
        BigInt(depositorPre.uiTokenAmount.amount) -
        BigInt(depositorPost?.uiTokenAmount.amount ?? '0');
      if (debited < rawAmount + rawFee) return false;

      this.feesCollected += fee;
      this.log.info?.(
        `[bet-escrow] verified ${amount} $ASTROID wager deposit (+${fee} fee) from ` +
          `${walletAddress.slice(0, 8)}… for raid ${raidId.slice(0, 8)}… ` +
          `| tx ${signature.slice(0, 8)}…`,
      );
      return true;
    } catch (err) {
      this.log.error?.(`[bet-escrow] verifyDeposit failed: ${sanitizeError(err)}`);
      return false;
    }
  }

  /**
   * Return `amount` $ASTROID from the escrow to a WINNING raider. Treasury-
   * signed + confirmed. The caller resolves the in-memory ledger first;
   * this only moves the token. Resolves with the base58 signature; throws a
   * sanitized error on failure so the caller can flag the payout for retry.
   */
  async returnWager(walletAddress: string, amount: number, raidId: string): Promise<string> {
    return this.transferFromEscrow(walletAddress, amount, `${WAGER_MEMO_PREFIX}_return:${raidId}`);
  }

  /**
   * Pay a defender their weighted share of the 10% spoils from a LOST raid.
   * Same mechanics as {@link returnWager}; separate memo for auditability.
   */
  async payDefender(walletAddress: string, amount: number, raidId: string): Promise<string> {
    return this.transferFromEscrow(
      walletAddress,
      amount,
      `${WAGER_MEMO_PREFIX}_spoils:${raidId}`,
    );
  }

  /** Shared treasury-signed escrow → recipient transfer (return + spoils). */
  private async transferFromEscrow(
    walletAddress: string,
    amount: number,
    memo: string,
  ): Promise<string> {
    const splToken = loadSplToken();
    const treasury = this.config.treasury;
    try {
      const recipient = new PublicKey(walletAddress);
      const rawAmount = toRawAmount(amount, this.config.astroidDecimals);
      if (rawAmount <= 0n) {
        throw new Error(`Refusing to transfer a non-positive amount (${amount}).`);
      }

      const treasuryAta = await this.treasuryAta();
      const escrowBal = await splToken.getAccount(this.connection, treasuryAta);
      if (escrowBal.amount < rawAmount) {
        throw new Error(`Escrow balance too low to pay ${amount} $ASTROID. Top up the treasury.`);
      }

      const tx = new Transaction();
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.config.priorityMicroLamports,
        }),
      );
      tx.add(memoIx(`${memo}:${amount}`, treasury.publicKey));

      const recipientAta = await splToken.getAssociatedTokenAddress(this.astroidMint, recipient);
      const mustCreateAta = !(await accountExists(this.connection, recipientAta));
      if (mustCreateAta) {
        tx.add(
          splToken.createAssociatedTokenAccountInstruction(
            treasury.publicKey,
            recipientAta,
            recipient,
            this.astroidMint,
          ),
        );
      }
      tx.add(
        splToken.createTransferInstruction(treasuryAta, recipientAta, treasury.publicKey, rawAmount),
      );

      // Rent-offset burn: when WE front the ~0.002 SOL rent for a new recipient
      // ATA, burn the $ASTROID-equivalent (oracle-priced) in the same tx — a
      // deflationary offset for the SOL spent. Strictly from SURPLUS: never
      // burn into the balance backing other outstanding wagers.
      let rentBurnApplied = 0n;
      if (this.config.rentBurnEnabled && mustCreateAta) {
        const rentRaw = await this.rentBurnRaw();
        const liabilityRaw = toRawAmount(
          this.getOutstandingLiability(),
          this.config.astroidDecimals,
        );
        const surplus = escrowBal.amount - liabilityRaw; // balance above all liability
        if (rentRaw > 0n && surplus >= rentRaw && escrowBal.amount >= rawAmount + rentRaw) {
          tx.add(memoIx(`${WAGER_MEMO_PREFIX}_rent_burn:${rentRaw}`, treasury.publicKey));
          tx.add(
            splToken.createBurnInstruction(
              treasuryAta,
              this.astroidMint,
              treasury.publicKey,
              rentRaw,
            ),
          );
          rentBurnApplied = rentRaw;
        }
      }

      const signature = await sendAndConfirmTransaction(this.connection, tx, [treasury], {
        commitment: 'confirmed',
        maxRetries: 3,
      });
      if (rentBurnApplied > 0n) {
        this.rentBurned += Number(rentBurnApplied) / Math.pow(10, this.config.astroidDecimals);
      }
      this.log.info?.(
        `[bet-escrow] paid ${amount} $ASTROID to ${walletAddress.slice(0, 8)}… ` +
          `(${memo})${rentBurnApplied > 0n ? ' +rent-burn' : ''} | tx ${signature.slice(0, 8)}…`,
      );
      return signature;
    } catch (err) {
      const message = sanitizeError(err);
      this.log.error?.(`[bet-escrow] escrow payout failed: ${message}`);
      throw new Error(`escrow payout failed: ${message}`);
    }
  }

  /**
   * Burn `amount` $ASTROID from the escrow — the 90% deflationary sink for a
   * LOST raid's forfeited wager. Treasury-signed SPL burn. Resolves with the
   * base58 signature; throws a sanitized error on failure.
   */
  async burnWager(amount: number, raidId: string): Promise<string> {
    const splToken = loadSplToken();
    const treasury = this.config.treasury;
    try {
      const rawAmount = toRawAmount(amount, this.config.astroidDecimals);
      if (rawAmount <= 0n) {
        throw new Error(`Refusing to burn a non-positive amount (${amount}).`);
      }

      const treasuryAta = await this.treasuryAta();
      const escrowBal = await splToken.getAccount(this.connection, treasuryAta);
      if (escrowBal.amount < rawAmount) {
        throw new Error(`Escrow balance too low to burn ${amount} $ASTROID.`);
      }

      const tx = new Transaction();
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.config.priorityMicroLamports,
        }),
      );
      tx.add(memoIx(`${WAGER_MEMO_PREFIX}_burn:${raidId}:${amount}`, treasury.publicKey));
      tx.add(
        splToken.createBurnInstruction(treasuryAta, this.astroidMint, treasury.publicKey, rawAmount),
      );

      const signature = await sendAndConfirmTransaction(this.connection, tx, [treasury], {
        commitment: 'confirmed',
        maxRetries: 3,
      });
      this.log.info?.(
        `[bet-escrow] burned ${amount} $ASTROID from escrow (raid ${raidId.slice(0, 8)}…) ` +
          `| tx ${signature.slice(0, 8)}…`,
      );
      return signature;
    } catch (err) {
      const message = sanitizeError(err);
      this.log.error?.(`[bet-escrow] burn failed: ${message}`);
      throw new Error(`escrow burn failed: ${message}`);
    }
  }
}
