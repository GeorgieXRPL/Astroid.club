/**
 * Tests for the IOU bridge + atomic redeemer config + key handling
 * (server/chain/redeemer.ts). The on-chain transfers (bridge) and the
 * partial-signed atomic swap (buildRedeemSwap) hit Solana, so they're
 * proven on localnet; here we cover the pure, network-free surface:
 *
 *   - REDEEMER_TREASURY_PRIVATE_KEY parsing (JSON array + base58 + errors).
 *   - getRedeemerConfigFromEnv gating + defaults + overrides.
 *   - RedeemerService.treasuryAddress reflects the configured key.
 *
 * Security invariant under test: parse failures throw GENERIC errors that
 * never echo the supplied key material.
 */

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RedeemerService,
  getRedeemerConfigFromEnv,
  loadTreasuryKeypair,
} from '../../server/chain/redeemer.js';

const IOU_MINT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASTROID_MINT = 'So11111111111111111111111111111111111111112';

const ENV_KEYS = [
  'REDEEMER_TREASURY_PRIVATE_KEY',
  'SOLANA_RPC_URL',
  'IOU_TOKEN_MINT',
  'IOU_TOKEN_DECIMALS',
  'ASTROID_MINT_ADDRESS',
  'ASTROID_DECIMALS',
  'REDEEM_RATE',
  'REDEEM_PRIORITY_MICROLAMPORTS',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('loadTreasuryKeypair', () => {
  it('throws when REDEEMER_TREASURY_PRIVATE_KEY is unset', () => {
    expect(() => loadTreasuryKeypair()).toThrow(/required/i);
  });

  it('throws (generically) when the key is too short', () => {
    process.env.REDEEMER_TREASURY_PRIVATE_KEY = 'short';
    expect(() => loadTreasuryKeypair()).toThrow(/too short/i);
  });

  it('parses a JSON 64-byte secret array', () => {
    const kp = Keypair.generate();
    process.env.REDEEMER_TREASURY_PRIVATE_KEY = JSON.stringify(Array.from(kp.secretKey));
    expect(loadTreasuryKeypair().publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('parses a base58-encoded secret key', () => {
    const kp = Keypair.generate();
    process.env.REDEEMER_TREASURY_PRIVATE_KEY = bs58.encode(kp.secretKey);
    expect(loadTreasuryKeypair().publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('throws a generic error (no key echo) on garbage of sufficient length', () => {
    const garbage = '0'.repeat(64);
    process.env.REDEEMER_TREASURY_PRIVATE_KEY = garbage;
    try {
      loadTreasuryKeypair();
      throw new Error('expected loadTreasuryKeypair to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/Failed to parse/i);
      expect(message).not.toContain(garbage);
    }
  });
});

describe('getRedeemerConfigFromEnv', () => {
  function setValidTreasury(): Keypair {
    const kp = Keypair.generate();
    process.env.REDEEMER_TREASURY_PRIVATE_KEY = JSON.stringify(Array.from(kp.secretKey));
    return kp;
  }

  function setRequired(): void {
    process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
    process.env.IOU_TOKEN_MINT = IOU_MINT;
    process.env.ASTROID_MINT_ADDRESS = ASTROID_MINT;
  }

  it('returns null when the treasury key is unset', () => {
    setRequired();
    expect(getRedeemerConfigFromEnv()).toBeNull();
  });

  it('returns null when the RPC url is unset', () => {
    setValidTreasury();
    process.env.IOU_TOKEN_MINT = IOU_MINT;
    process.env.ASTROID_MINT_ADDRESS = ASTROID_MINT;
    expect(getRedeemerConfigFromEnv()).toBeNull();
  });

  it('returns null when the IOU mint is unset', () => {
    setValidTreasury();
    process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
    process.env.ASTROID_MINT_ADDRESS = ASTROID_MINT;
    expect(getRedeemerConfigFromEnv()).toBeNull();
  });

  it('returns null when the $ASTROID mint is unset', () => {
    setValidTreasury();
    process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
    process.env.IOU_TOKEN_MINT = IOU_MINT;
    expect(getRedeemerConfigFromEnv()).toBeNull();
  });

  it('builds a config with defaults when all required env is present', () => {
    const kp = setValidTreasury();
    setRequired();

    const config = getRedeemerConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.iouDecimals).toBe(9);
    expect(config!.astroidDecimals).toBe(6);
    expect(config!.redeemRate).toBe(1);
    expect(config!.priorityMicroLamports).toBe(5000);
    expect(config!.treasury.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('honors decimal / rate / priority overrides', () => {
    setValidTreasury();
    setRequired();
    process.env.IOU_TOKEN_DECIMALS = '6';
    process.env.ASTROID_DECIMALS = '9';
    process.env.REDEEM_RATE = '0.5';
    process.env.REDEEM_PRIORITY_MICROLAMPORTS = '12000';

    const config = getRedeemerConfigFromEnv();
    expect(config!.iouDecimals).toBe(6);
    expect(config!.astroidDecimals).toBe(9);
    expect(config!.redeemRate).toBe(0.5);
    expect(config!.priorityMicroLamports).toBe(12000);
  });
});

describe('RedeemerService', () => {
  it('exposes the treasury public address (safe to log)', () => {
    const kp = Keypair.generate();
    const service = new RedeemerService({
      rpcUrl: 'http://127.0.0.1:8899',
      iouMint: IOU_MINT,
      iouDecimals: 9,
      astroidMint: ASTROID_MINT,
      astroidDecimals: 6,
      treasury: kp,
      redeemRate: 1,
      priorityMicroLamports: 5000,
    });
    expect(service.treasuryAddress).toBe(kp.publicKey.toBase58());
  });

  it('rejects a non-positive redeem amount without touching the network', async () => {
    const service = new RedeemerService({
      rpcUrl: 'http://127.0.0.1:8899',
      iouMint: IOU_MINT,
      iouDecimals: 9,
      astroidMint: ASTROID_MINT,
      astroidDecimals: 6,
      treasury: Keypair.generate(),
      redeemRate: 1,
      priorityMicroLamports: 5000,
    });
    const result = await service.buildRedeemSwap(Keypair.generate().publicKey.toBase58(), 0);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/greater than zero/i);
  });
});

describe('RedeemerService ATA rent-offset (anti rent-harvest)', () => {
  // Exploit under test: the treasury fronts ~0.002 SOL rent when it creates a
  // recipient's token account, but Solana refunds a closed account's rent to
  // the OWNER. A wallet looping claim → redeem → closeAccount harvested the
  // treasury's SOL in production. The fix deducts the oracle-priced rent
  // equivalent from the tokens delivered whenever we must create an ATA.
  const RENT_LAMPORTS = 2_039_280; // mainnet rent-exempt minimum for 165 bytes
  const BLOCKHASH = bs58.encode(Keypair.generate().publicKey.toBytes());

  interface FakeAccount {
    mint: PublicKey;
    owner: PublicKey;
    amount: bigint;
  }

  // The dependency tree carries two spl-token majors; TS resolves the import
  // to the old 0.1.x types while runtime loads 0.4.x (same interop issue the
  // server works around with createRequire). Re-assert the 0.4.x surface.
  interface SplSurface {
    TOKEN_PROGRAM_ID: PublicKey;
    ACCOUNT_SIZE: number;
    AccountLayout: {
      encode(fields: Record<string, unknown>, buffer: Buffer): number;
    };
    getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): Promise<PublicKey>;
  }

  async function loadSpl(): Promise<SplSurface> {
    return (await import('@solana/spl-token')) as unknown as SplSurface;
  }

  /** Encode a real SPL token account so spl-token's `getAccount` parses it. */
  async function encodeTokenAccount(acc: FakeAccount): Promise<Buffer> {
    const spl = await loadSpl();
    const data = Buffer.alloc(spl.ACCOUNT_SIZE);
    spl.AccountLayout.encode(
      {
        mint: acc.mint,
        owner: acc.owner,
        amount: acc.amount,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      data,
    );
    return data;
  }

  /**
   * Connection stub backed by a mutable map of token accounts. Also fakes the
   * send path so `bridge()`'s `sendAndConfirmTransaction` resolves and we can
   * inspect the transaction that would have been broadcast.
   */
  async function fakeChain(accounts: Map<string, FakeAccount>): Promise<{
    conn: Connection;
    sentTxs: Transaction[];
  }> {
    const spl = await loadSpl();
    const sentTxs: Transaction[] = [];
    const conn = {
      getAccountInfo: vi.fn(async (address: PublicKey) => {
        const acc = accounts.get(address.toBase58());
        if (!acc) return null;
        return {
          owner: spl.TOKEN_PROGRAM_ID,
          data: await encodeTokenAccount(acc),
          lamports: RENT_LAMPORTS,
          executable: false,
        };
      }),
      getMinimumBalanceForRentExemption: vi.fn(async () => RENT_LAMPORTS),
      getLatestBlockhash: vi.fn(async () => ({
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 1000,
      })),
      sendTransaction: vi.fn(async (tx: Transaction) => {
        sentTxs.push(tx);
        return 'sig-bridge'.padEnd(64, '1');
      }),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    } as unknown as Connection;
    return { conn, sentTxs };
  }

  /** Decode the u64 amount from an SPL Transfer instruction's data. */
  function transferAmount(tx: Transaction): bigint {
    const ix = tx.instructions[tx.instructions.length - 1]!;
    expect(ix.data[0]).toBe(3); // SPL Token Transfer discriminator
    return Buffer.from(ix.data).readBigUInt64LE(1);
  }

  // Oracle: SOL=$100, ASTROID=$0.001 → one ATA's rent (0.00203928 SOL) is
  // worth exactly 203.928 tokens at redeemRate 1.
  const oracle = { getPrice: () => 0.001, getSolPrice: () => 100 };
  const EXPECTED_FEE = (RENT_LAMPORTS / 1e9) * (100 / 0.001); // 203.928

  function makeService(
    treasury: Keypair,
    conn: Connection,
    withOracle: boolean,
  ): RedeemerService {
    return new RedeemerService(
      {
        rpcUrl: 'http://127.0.0.1:8899',
        iouMint: IOU_MINT,
        iouDecimals: 9,
        astroidMint: ASTROID_MINT,
        astroidDecimals: 6,
        treasury,
        redeemRate: 1,
        priorityMicroLamports: 5000,
      },
      {
        connection: conn,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        getPriceOracle: withOracle ? () => oracle : () => undefined,
      },
    );
  }

  async function setupAccounts(opts: {
    treasury: Keypair;
    user: Keypair;
    userHasIouAta?: boolean;
    userHasAstroidAta?: boolean;
    userIouBalance?: bigint;
  }): Promise<Map<string, FakeAccount>> {
    const spl = await loadSpl();
    const iouMint = new PublicKey(IOU_MINT);
    const astroidMint = new PublicKey(ASTROID_MINT);
    const accounts = new Map<string, FakeAccount>();
    const set = async (mint: PublicKey, owner: PublicKey, amount: bigint) => {
      const ata = await spl.getAssociatedTokenAddress(mint, owner);
      accounts.set(ata.toBase58(), { mint, owner, amount });
    };
    // Treasury holds plenty of both tokens.
    await set(iouMint, opts.treasury.publicKey, 10_000_000_000_000n);
    await set(astroidMint, opts.treasury.publicKey, 10_000_000_000_000n);
    if (opts.userHasIouAta) {
      await set(iouMint, opts.user.publicKey, opts.userIouBalance ?? 1_000_000_000_000n);
    }
    if (opts.userHasAstroidAta) {
      await set(astroidMint, opts.user.publicKey, 0n);
    }
    return accounts;
  }

  it('bridge deducts the rent-equivalent in creds when it must create the ATA', async () => {
    const treasury = Keypair.generate();
    const user = Keypair.generate();
    const accounts = await setupAccounts({ treasury, user, userHasIouAta: false });
    const { conn, sentTxs } = await fakeChain(accounts);
    const service = makeService(treasury, conn, true);

    await service.bridge(user.publicKey.toBase58(), 500);

    expect(sentTxs).toHaveLength(1);
    const raw = transferAmount(sentTxs[0]!);
    const expected = BigInt(Math.floor((500 - EXPECTED_FEE) * 1e9));
    expect(raw).toBe(expected);
  });

  it('bridge transfers the full amount when the ATA already exists (no fee)', async () => {
    const treasury = Keypair.generate();
    const user = Keypair.generate();
    const accounts = await setupAccounts({ treasury, user, userHasIouAta: true });
    const { conn, sentTxs } = await fakeChain(accounts);
    const service = makeService(treasury, conn, true);

    await service.bridge(user.publicKey.toBase58(), 500);

    expect(transferAmount(sentTxs[0]!)).toBe(500_000_000_000n);
  });

  it('bridge rejects a claim too small to cover the rent fee', async () => {
    const treasury = Keypair.generate();
    const user = Keypair.generate();
    const accounts = await setupAccounts({ treasury, user, userHasIouAta: false });
    const { conn } = await fakeChain(accounts);
    const service = makeService(treasury, conn, true);

    await expect(service.bridge(user.publicKey.toBase58(), 100)).rejects.toThrow(
      /too small to cover/i,
    );
  });

  it('bridge with the oracle down allows ONE free creation then refuses re-creation', async () => {
    const treasury = Keypair.generate();
    const user = Keypair.generate();
    const accounts = await setupAccounts({ treasury, user, userHasIouAta: false });
    const { conn, sentTxs } = await fakeChain(accounts);
    const service = makeService(treasury, conn, false);

    // First creation: free (legit new user), full amount delivered.
    await service.bridge(user.publicKey.toBase58(), 500);
    expect(transferAmount(sentTxs[0]!)).toBe(500_000_000_000n);

    // The harvester closes the ATA (still absent in our map) and claims again:
    // refused, because we already fronted rent for this wallet once.
    await expect(service.bridge(user.publicKey.toBase58(), 500)).rejects.toThrow(
      /closed after we funded it/i,
    );
  });

  it('buildRedeemSwap deducts the rent-equivalent from the $ASTROID payout when creating the user ATA', async () => {
    const treasury = Keypair.generate();
    const user = Keypair.generate();
    const accounts = await setupAccounts({
      treasury,
      user,
      userHasIouAta: true,
      userHasAstroidAta: false,
    });
    const { conn } = await fakeChain(accounts);
    const service = makeService(treasury, conn, true);

    const result = await service.buildRedeemSwap(user.publicKey.toBase58(), 500);
    expect('transaction' in result).toBe(true);
    if (!('transaction' in result)) return;

    const tx = Transaction.from(Buffer.from(result.transaction, 'base64'));
    // Last instruction is the treasury → user $ASTROID leg.
    const raw = transferAmount(tx);
    const expected = BigInt(Math.floor((500 - EXPECTED_FEE) * 1e6));
    expect(raw).toBe(expected);
  });

  it('buildRedeemSwap pays the full amount when the user $ASTROID ATA exists', async () => {
    const treasury = Keypair.generate();
    const user = Keypair.generate();
    const accounts = await setupAccounts({
      treasury,
      user,
      userHasIouAta: true,
      userHasAstroidAta: true,
    });
    const { conn } = await fakeChain(accounts);
    const service = makeService(treasury, conn, true);

    const result = await service.buildRedeemSwap(user.publicKey.toBase58(), 500);
    expect('transaction' in result).toBe(true);
    if (!('transaction' in result)) return;

    const tx = Transaction.from(Buffer.from(result.transaction, 'base64'));
    expect(transferAmount(tx)).toBe(500_000_000n);
  });

  it('buildRedeemSwap returns a BuildError (not a payout) when the amount cannot cover the fee', async () => {
    const treasury = Keypair.generate();
    const user = Keypair.generate();
    const accounts = await setupAccounts({
      treasury,
      user,
      userHasIouAta: true,
      userHasAstroidAta: false,
    });
    const { conn } = await fakeChain(accounts);
    const service = makeService(treasury, conn, true);

    const result = await service.buildRedeemSwap(user.publicKey.toBase58(), 100);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/too small to cover/i);
  });
});

describe('RedeemerService.coSignAndSubmitRedeem (wallet-first co-sign gate)', () => {
  const BLOCKHASH = bs58.encode(Keypair.generate().publicKey.toBytes());

  /** A two-signer (user + treasury) transaction shaped like the redeem swap. */
  function makeSwap(user: PublicKey, treasury: PublicKey): Transaction {
    const tx = new Transaction();
    // An instruction that requires BOTH the user and the treasury to sign,
    // mirroring the redeem swap's two transfer legs.
    tx.add(
      new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [
          { pubkey: user, isSigner: true, isWritable: true },
          { pubkey: treasury, isSigner: true, isWritable: true },
        ],
        data: Buffer.from([1, 2, 3, 4]),
      }),
    );
    tx.feePayer = user;
    tx.recentBlockhash = BLOCKHASH;
    return tx;
  }

  function makeService(treasury: Keypair, connection: Connection): RedeemerService {
    return new RedeemerService(
      {
        rpcUrl: 'http://127.0.0.1:8899',
        iouMint: IOU_MINT,
        iouDecimals: 9,
        astroidMint: ASTROID_MINT,
        astroidDecimals: 6,
        treasury,
        redeemRate: 1,
        priorityMicroLamports: 5000,
      },
      { connection, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    );
  }

  function fakeConnection(sig = 'a'.repeat(64)): { conn: Connection; sent: Uint8Array[] } {
    const sent: Uint8Array[] = [];
    const conn = {
      sendRawTransaction: vi.fn(async (raw: Uint8Array) => {
        sent.push(raw);
        return sig;
      }),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    } as unknown as Connection;
    return { conn, sent };
  }

  it('co-signs the treasury leg and submits a fully-signed tx', async () => {
    const user = Keypair.generate();
    const treasury = Keypair.generate();
    const { conn, sent } = fakeConnection('sig-ok'.padEnd(64, '1'));
    const service = makeService(treasury, conn);

    const built = makeSwap(user.publicKey, treasury.publicKey);
    const builtTransaction = built
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    // The wallet signs the CLEAN tx (no treasury signature attached).
    const walletSigned = Transaction.from(Buffer.from(builtTransaction, 'base64'));
    walletSigned.partialSign(user);
    const signedTransaction = walletSigned
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    const signature = await service.coSignAndSubmitRedeem(user.publicKey.toBase58(), {
      builtTransaction,
      signedTransaction,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1000,
    });

    expect(signature).toBe('sig-ok'.padEnd(64, '1'));
    expect(sent).toHaveLength(1);
    // The broadcast tx must carry BOTH signatures (user + treasury).
    const submitted = Transaction.from(sent[0]!);
    expect(submitted.verifySignatures()).toBe(true);
  });

  it('tolerates a wallet-prepended ComputeBudget (priority-fee) instruction', async () => {
    // Real wallets (e.g. Phantom with priority fees on) add ComputeBudget
    // instructions when signing. These reference no accounts and can't move
    // funds, so the co-sign gate must accept them rather than fail with
    // "does not match the redeem we issued".
    const user = Keypair.generate();
    const treasury = Keypair.generate();
    const { conn, sent } = fakeConnection('sig-cb'.padEnd(64, '1'));
    const service = makeService(treasury, conn);

    const built = makeSwap(user.publicKey, treasury.publicKey);
    const builtTransaction = built
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    // The wallet rebuilds the tx with a priority fee prepended, keeping our
    // blockhash + original instruction, then signs it.
    const withFee = new Transaction();
    withFee.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
    withFee.add(built.instructions[0]!);
    withFee.feePayer = user.publicKey;
    withFee.recentBlockhash = BLOCKHASH;
    withFee.partialSign(user);
    const signedTransaction = withFee
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    const signature = await service.coSignAndSubmitRedeem(user.publicKey.toBase58(), {
      builtTransaction,
      signedTransaction,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1000,
    });

    expect(signature).toBe('sig-cb'.padEnd(64, '1'));
    expect(sent).toHaveLength(1);
    const submitted = Transaction.from(sent[0]!);
    expect(submitted.verifySignatures()).toBe(true);
    expect(submitted.instructions).toHaveLength(2);
  });

  it('tolerates wallet-appended guard instructions that do not use the treasury signature (e.g. Lighthouse)', async () => {
    // Phantom appends Lighthouse assertion instructions when signing. They
    // reference accounts but never the treasury as a SIGNER, so they can't
    // touch treasury assets — they must be accepted.
    const user = Keypair.generate();
    const treasury = Keypair.generate();
    const { conn, sent } = fakeConnection('sig-lh'.padEnd(64, '1'));
    const service = makeService(treasury, conn);

    const built = makeSwap(user.publicKey, treasury.publicKey);
    const builtTransaction = built
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    const guarded = new Transaction();
    guarded.add(built.instructions[0]!);
    // A Lighthouse-style assert: references the treasury account but only as a
    // read-only, NON-signer input. Safe — it can only abort the tx.
    guarded.add(
      new TransactionInstruction({
        programId: new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),
        keys: [{ pubkey: treasury.publicKey, isSigner: false, isWritable: false }],
        data: Buffer.from([1, 1]),
      }),
    );
    guarded.feePayer = user.publicKey;
    guarded.recentBlockhash = BLOCKHASH;
    guarded.partialSign(user);
    const signedTransaction = guarded
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    const signature = await service.coSignAndSubmitRedeem(user.publicKey.toBase58(), {
      builtTransaction,
      signedTransaction,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1000,
    });
    expect(signature).toBe('sig-lh'.padEnd(64, '1'));
    expect(sent).toHaveLength(1);
  });

  it('refuses an extra instruction that wields the treasury signature', async () => {
    const user = Keypair.generate();
    const treasury = Keypair.generate();
    const service = makeService(treasury, fakeConnection().conn);

    const built = makeSwap(user.publicKey, treasury.publicKey);
    const builtTransaction = built
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    // The client smuggles in an extra instruction that requires the TREASURY
    // to sign (i.e. could move treasury funds) — must be rejected before the
    // treasury ever signs.
    const tampered = new Transaction();
    tampered.add(built.instructions[0]!);
    tampered.add(
      new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [{ pubkey: treasury.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.from([7, 7, 7, 7]),
      }),
    );
    tampered.feePayer = user.publicKey;
    tampered.recentBlockhash = BLOCKHASH;
    tampered.partialSign(user);
    const signedTransaction = tampered
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    await expect(
      service.coSignAndSubmitRedeem(user.publicKey.toBase58(), {
        builtTransaction,
        signedTransaction,
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 1000,
      }),
    ).rejects.toThrow(/does not match/i);
  });

  it('refuses to co-sign a tx whose message does not match the one issued', async () => {
    const user = Keypair.generate();
    const treasury = Keypair.generate();
    const service = makeService(treasury, fakeConnection().conn);

    const issued = makeSwap(user.publicKey, treasury.publicKey);
    const builtTransaction = issued
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    // A DIFFERENT transaction (attacker swapped the instruction data) signed by
    // the user — same signers, different message.
    const tampered = makeSwap(user.publicKey, treasury.publicKey);
    tampered.instructions[0]!.data = Buffer.from([9, 9, 9, 9]);
    tampered.partialSign(user);
    const signedTransaction = tampered
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    await expect(
      service.coSignAndSubmitRedeem(user.publicKey.toBase58(), {
        builtTransaction,
        signedTransaction,
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 1000,
      }),
    ).rejects.toThrow(/does not match/i);
  });

  it('refuses to submit when the wallet signature is missing', async () => {
    const user = Keypair.generate();
    const treasury = Keypair.generate();
    const service = makeService(treasury, fakeConnection().conn);

    const built = makeSwap(user.publicKey, treasury.publicKey);
    const builtTransaction = built
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');
    // Hand back the UNSIGNED tx (no wallet signature) — must be rejected even
    // though the message matches.
    await expect(
      service.coSignAndSubmitRedeem(user.publicKey.toBase58(), {
        builtTransaction,
        signedTransaction: builtTransaction,
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 1000,
      }),
    ).rejects.toThrow(/redeem submit failed/i);
  });
});
