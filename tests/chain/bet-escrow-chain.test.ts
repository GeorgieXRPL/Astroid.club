/**
 * Tests for the on-chain raid-wager escrow slice
 * (server/chain/bet-escrow-chain.ts). The token transfers (deposit build,
 * return, burn, defender spoils) hit Solana, so they're proven on localnet;
 * here we cover the pure, network-free surface plus the verify GATE logic
 * (which is the security-load-bearing part) against a fake connection:
 *
 *   - getBetEscrowConfigFromEnv gating + defaults + overrides + key reuse.
 *   - BetEscrowChainService.escrowAddress reflects the treasury key.
 *   - buildDeposit rejects bad amounts without touching the network.
 *   - returnWager / burnWager reject non-positive amounts before any RPC.
 *   - verifyDeposit's confirm + memo + balance-delta gate accepts a clean
 *     deposit and rejects failed / forged / underfunded ones.
 */

import { Keypair } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BetEscrowChainService,
  WAGER_MEMO_PREFIX,
  getBetEscrowConfigFromEnv,
} from '../../server/chain/bet-escrow-chain.js';

const ASTROID_MINT = 'So11111111111111111111111111111111111111112';

const ENV_KEYS = [
  'REDEEMER_TREASURY_PRIVATE_KEY',
  'SOLANA_RPC_URL',
  'ASTROID_MINT_ADDRESS',
  'ASTROID_DECIMALS',
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

describe('getBetEscrowConfigFromEnv', () => {
  function setValidTreasury(): Keypair {
    const kp = Keypair.generate();
    process.env.REDEEMER_TREASURY_PRIVATE_KEY = JSON.stringify(Array.from(kp.secretKey));
    return kp;
  }

  it('returns null when the treasury key is unset', () => {
    process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
    process.env.ASTROID_MINT_ADDRESS = ASTROID_MINT;
    expect(getBetEscrowConfigFromEnv()).toBeNull();
  });

  it('returns null when the RPC url is unset', () => {
    setValidTreasury();
    process.env.ASTROID_MINT_ADDRESS = ASTROID_MINT;
    expect(getBetEscrowConfigFromEnv()).toBeNull();
  });

  it('returns null when the $ASTROID mint is unset', () => {
    setValidTreasury();
    process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
    expect(getBetEscrowConfigFromEnv()).toBeNull();
  });

  it('builds a config (reusing the redeemer treasury key) with defaults', () => {
    const kp = setValidTreasury();
    process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
    process.env.ASTROID_MINT_ADDRESS = ASTROID_MINT;

    const config = getBetEscrowConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.astroidDecimals).toBe(6);
    expect(config!.priorityMicroLamports).toBe(5000);
    expect(config!.treasury.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('honors decimal / priority overrides', () => {
    setValidTreasury();
    process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
    process.env.ASTROID_MINT_ADDRESS = ASTROID_MINT;
    process.env.ASTROID_DECIMALS = '9';
    process.env.REDEEM_PRIORITY_MICROLAMPORTS = '12000';

    const config = getBetEscrowConfigFromEnv();
    expect(config!.astroidDecimals).toBe(9);
    expect(config!.priorityMicroLamports).toBe(12000);
  });
});

function makeService(treasury: Keypair, connection?: Connection): BetEscrowChainService {
  return new BetEscrowChainService(
    {
      rpcUrl: 'http://127.0.0.1:8899',
      astroidMint: ASTROID_MINT,
      astroidDecimals: 6,
      treasury,
      priorityMicroLamports: 5000,
    },
    { connection, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
  );
}

describe('BetEscrowChainService surface', () => {
  it('exposes the escrow (treasury) address (safe to log)', () => {
    const kp = Keypair.generate();
    expect(makeService(kp).escrowAddress).toBe(kp.publicKey.toBase58());
  });

  it('rejects a non-positive wager in buildDeposit without touching the network', async () => {
    const service = makeService(Keypair.generate());
    const result = await service.buildDeposit(Keypair.generate().publicKey.toBase58(), 0, 'raid-1');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/greater than zero/i);
  });

  it('refuses to return a non-positive wager before any RPC', async () => {
    const service = makeService(Keypair.generate());
    await expect(
      service.returnWager(Keypair.generate().publicKey.toBase58(), 0, 'raid-1'),
    ).rejects.toThrow(/escrow payout failed/i);
  });

  it('refuses to burn a non-positive amount before any RPC', async () => {
    const service = makeService(Keypair.generate());
    await expect(service.burnWager(0, 'raid-1')).rejects.toThrow(/escrow burn failed/i);
  });
});

describe('BetEscrowChainService.verifyDeposit (confirm + memo + balance gate)', () => {
  const SIG = bs58.encode(Keypair.generate().publicKey.toBytes());
  const RAID = 'raid-abc';
  const USER = Keypair.generate().publicKey.toBase58();

  /**
   * Build a fake parsed-tx with a controllable treasury balance delta + memo.
   * Also models the DEPOSITOR (`USER`) balance dropping by the wager, which the
   * hardened verify requires (proves the raider funded their own deposit).
   * `depositor` / `userPre` / `userPost` let tests exercise the depositor gate.
   */
  function parsedTx(opts: {
    treasury: string;
    preAmount: string;
    postAmount: string;
    memo: string;
    err?: unknown;
    depositor?: string;
    userPre?: string;
    userPost?: string;
    omitDepositor?: boolean;
  }) {
    const depositor = opts.depositor ?? USER;
    const userPre = opts.userPre ?? '500000000'; // holds 500 tokens pre
    const userPost = opts.userPost ?? '400000000'; // -100 tokens (the wager)
    const pre = [
      { owner: opts.treasury, mint: ASTROID_MINT, uiTokenAmount: { amount: opts.preAmount } },
    ];
    const post = [
      { owner: opts.treasury, mint: ASTROID_MINT, uiTokenAmount: { amount: opts.postAmount } },
    ];
    if (!opts.omitDepositor) {
      pre.push({ owner: depositor, mint: ASTROID_MINT, uiTokenAmount: { amount: userPre } });
      post.push({ owner: depositor, mint: ASTROID_MINT, uiTokenAmount: { amount: userPost } });
    }
    return {
      meta: {
        err: opts.err ?? null,
        logMessages: [`Program log: Memo (len): ${opts.memo}`],
        preTokenBalances: pre,
        postTokenBalances: post,
      },
    };
  }

  function fakeConnection(opts: {
    confirmErr?: unknown;
    parsed: unknown;
  }): Connection {
    return {
      confirmTransaction: vi.fn(async () => ({ value: { err: opts.confirmErr ?? null } })),
      getParsedTransaction: vi.fn(async () => opts.parsed),
    } as unknown as Connection;
  }

  it('accepts a confirmed deposit with the right memo and a sufficient balance delta', async () => {
    const treasury = Keypair.generate();
    const conn = fakeConnection({
      // wager 100 @ 6 decimals = 100_000_000 raw; treasury gains exactly that.
      parsed: parsedTx({
        treasury: treasury.publicKey.toBase58(),
        preAmount: '0',
        postAmount: '100000000',
        memo: `${WAGER_MEMO_PREFIX}:${RAID}:100`,
      }),
    });
    const service = makeService(treasury, conn);
    expect(await service.verifyDeposit(SIG, USER, 100, RAID)).toBe(true);
  });

  it('rejects when the tx failed to confirm', async () => {
    const treasury = Keypair.generate();
    const conn = fakeConnection({ confirmErr: 'InstructionError', parsed: null });
    const service = makeService(treasury, conn);
    expect(await service.verifyDeposit(SIG, USER, 100, RAID)).toBe(false);
  });

  it('rejects when the memo does not match the raid', async () => {
    const treasury = Keypair.generate();
    const conn = fakeConnection({
      parsed: parsedTx({
        treasury: treasury.publicKey.toBase58(),
        preAmount: '0',
        postAmount: '100000000',
        memo: `${WAGER_MEMO_PREFIX}:some-other-raid:100`,
      }),
    });
    const service = makeService(treasury, conn);
    expect(await service.verifyDeposit(SIG, USER, 100, RAID)).toBe(false);
  });

  it('rejects when the treasury balance delta is less than the wager (forged memo)', async () => {
    const treasury = Keypair.generate();
    const conn = fakeConnection({
      // Right memo, but the escrow only gained 1 token, not 100.
      parsed: parsedTx({
        treasury: treasury.publicKey.toBase58(),
        preAmount: '0',
        postAmount: '1000000',
        memo: `${WAGER_MEMO_PREFIX}:${RAID}:100`,
      }),
    });
    const service = makeService(treasury, conn);
    expect(await service.verifyDeposit(SIG, USER, 100, RAID)).toBe(false);
  });

  it('rejects an OVER-payment (credited must equal the wager exactly)', async () => {
    const treasury = Keypair.generate();
    const conn = fakeConnection({
      // Treasury gained 150 tokens for a 100 wager — reject so excess can't be trapped.
      parsed: parsedTx({
        treasury: treasury.publicKey.toBase58(),
        preAmount: '0',
        postAmount: '150000000',
        memo: `${WAGER_MEMO_PREFIX}:${RAID}:100`,
      }),
    });
    const service = makeService(treasury, conn);
    expect(await service.verifyDeposit(SIG, USER, 100, RAID)).toBe(false);
  });

  it('rejects when the memo amount does not match the wager (full-memo bind)', async () => {
    const treasury = Keypair.generate();
    const conn = fakeConnection({
      // Right raid + treasury delta, but the memo amount says 50, not 100.
      parsed: parsedTx({
        treasury: treasury.publicKey.toBase58(),
        preAmount: '0',
        postAmount: '100000000',
        memo: `${WAGER_MEMO_PREFIX}:${RAID}:50`,
      }),
    });
    const service = makeService(treasury, conn);
    expect(await service.verifyDeposit(SIG, USER, 100, RAID)).toBe(false);
  });

  it('rejects a third-party-funded deposit (depositor balance did not drop)', async () => {
    const treasury = Keypair.generate();
    const conn = fakeConnection({
      // Treasury funded + correct memo, but USER's own balance is absent —
      // someone else paid. The depositor gate must reject this.
      parsed: parsedTx({
        treasury: treasury.publicKey.toBase58(),
        preAmount: '0',
        postAmount: '100000000',
        memo: `${WAGER_MEMO_PREFIX}:${RAID}:100`,
        omitDepositor: true,
      }),
    });
    const service = makeService(treasury, conn);
    expect(await service.verifyDeposit(SIG, USER, 100, RAID)).toBe(false);
  });

  it('rejects when the depositor balance dropped by less than the wager', async () => {
    const treasury = Keypair.generate();
    const conn = fakeConnection({
      parsed: parsedTx({
        treasury: treasury.publicKey.toBase58(),
        preAmount: '0',
        postAmount: '100000000',
        memo: `${WAGER_MEMO_PREFIX}:${RAID}:100`,
        userPre: '500000000',
        userPost: '450000000', // only -50, not the full 100
      }),
    });
    const service = makeService(treasury, conn);
    expect(await service.verifyDeposit(SIG, USER, 100, RAID)).toBe(false);
  });
});
