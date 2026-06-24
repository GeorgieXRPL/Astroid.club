/**
 * Tests for the discovery-reward payout config + key handling
 * (server/chain/rewards.ts). The on-chain transfer itself is proven on
 * localnet (scripts/localnet/e2e-yield-payout.ts); here we cover the
 * pure, network-free surface:
 *
 *   - REWARD_WALLET_PRIVATE_KEY parsing (JSON array + base58 + errors).
 *   - getRewardConfigFromEnv gating + defaults + overrides.
 *
 * Security invariant under test: parse failures throw GENERIC errors
 * that never echo the supplied key material.
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getRewardConfigFromEnv, loadRewardWalletKeypair } from '../../server/chain/rewards.js';

const ENV_KEYS = [
  'REWARD_WALLET_PRIVATE_KEY',
  'SOLANA_RPC_URL',
  'ASTROID_MINT_ADDRESS',
  'ASTROID_DECIMALS',
  'REWARD_PRIORITY_MICROLAMPORTS',
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

describe('loadRewardWalletKeypair', () => {
  it('throws when REWARD_WALLET_PRIVATE_KEY is unset', () => {
    expect(() => loadRewardWalletKeypair()).toThrow(/required/i);
  });

  it('throws (generically) when the key is too short', () => {
    process.env.REWARD_WALLET_PRIVATE_KEY = 'short';
    expect(() => loadRewardWalletKeypair()).toThrow(/too short/i);
  });

  it('parses a JSON 64-byte secret array', () => {
    const kp = Keypair.generate();
    process.env.REWARD_WALLET_PRIVATE_KEY = JSON.stringify(Array.from(kp.secretKey));
    const loaded = loadRewardWalletKeypair();
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('parses a base58-encoded secret key', () => {
    const kp = Keypair.generate();
    process.env.REWARD_WALLET_PRIVATE_KEY = bs58.encode(kp.secretKey);
    const loaded = loadRewardWalletKeypair();
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('throws a generic error (no key echo) on garbage of sufficient length', () => {
    const garbage = '0'.repeat(64); // long enough to pass the length gate, invalid as a key
    process.env.REWARD_WALLET_PRIVATE_KEY = garbage;
    try {
      loadRewardWalletKeypair();
      throw new Error('expected loadRewardWalletKeypair to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/Failed to parse/i);
      expect(message).not.toContain(garbage);
    }
  });
});

describe('getRewardConfigFromEnv', () => {
  function setValidWallet(): Keypair {
    const kp = Keypair.generate();
    process.env.REWARD_WALLET_PRIVATE_KEY = JSON.stringify(Array.from(kp.secretKey));
    return kp;
  }

  it('returns null when the reward wallet is unset', () => {
    process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
    process.env.ASTROID_MINT_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    expect(getRewardConfigFromEnv()).toBeNull();
  });

  it('returns null when the RPC url is unset', () => {
    setValidWallet();
    process.env.ASTROID_MINT_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    expect(getRewardConfigFromEnv()).toBeNull();
  });

  it('returns null when the mint is unset', () => {
    setValidWallet();
    process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
    expect(getRewardConfigFromEnv()).toBeNull();
  });

  it('builds a config with defaults when all required env is present', () => {
    const kp = setValidWallet();
    process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
    process.env.ASTROID_MINT_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

    const config = getRewardConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.astroidDecimals).toBe(6);
    expect(config!.priorityMicroLamports).toBe(5000);
    expect(config!.rewardWallet.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('honors ASTROID_DECIMALS and REWARD_PRIORITY_MICROLAMPORTS overrides', () => {
    setValidWallet();
    process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
    process.env.ASTROID_MINT_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    process.env.ASTROID_DECIMALS = '9';
    process.env.REWARD_PRIORITY_MICROLAMPORTS = '12000';

    const config = getRewardConfigFromEnv();
    expect(config!.astroidDecimals).toBe(9);
    expect(config!.priorityMicroLamports).toBe(12000);
  });
});
