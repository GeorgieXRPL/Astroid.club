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

import { Keypair, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import type { Connection, PublicKey } from '@solana/web3.js';
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
