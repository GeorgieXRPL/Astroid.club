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
