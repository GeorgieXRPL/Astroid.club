/**
 * Dev keypair helper.
 *
 * Generates an ed25519 keypair via tweetnacl, persists it in
 * `localStorage`, and exposes signing helpers that match what the
 * server's `WalletVerifier` expects.
 *
 * **This file is the dev-mode `WalletSource` provider.** When no
 * `NEXT_PUBLIC_PRIVY_APP_ID` is configured, the shell falls back to
 * this module so local dev never blocks on the Privy app being
 * provisioned. The same module also still backs the smoke script,
 * which talks straight to the gateway without going through the
 * shell's UI.
 *
 * The wallet abstraction (`./wallet-source`) is the contract that
 * keeps Privy and the dev keypair interchangeable from the auth
 * handshake's point of view.
 */

import bs58 from 'bs58';
import nacl from 'tweetnacl';

import type { SignableTransaction, WalletSource } from './wallet-source';

const STORAGE_KEY = 'astroid-club:dev-keypair:v1';

export interface DevKeypair {
  /** Solana-style base58-encoded public key. Used as `walletAddress`. */
  publicKey: string;
  /** 64-byte secret key, base58-encoded for compactness. */
  secretKey: string;
}

interface RawKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

function fromStorage(): DevKeypair | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DevKeypair;
    if (!parsed.publicKey || !parsed.secretKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

function toStorage(kp: DevKeypair): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kp));
}

function decode(kp: DevKeypair): RawKeypair {
  return {
    publicKey: bs58.decode(kp.publicKey),
    secretKey: bs58.decode(kp.secretKey),
  };
}

/**
 * Get the current dev keypair from `localStorage`, or generate
 * a fresh one and persist it. Idempotent across reloads.
 */
export function getOrCreateDevKeypair(): DevKeypair {
  const existing = fromStorage();
  if (existing) return existing;
  const fresh = nacl.sign.keyPair();
  const kp: DevKeypair = {
    publicKey: bs58.encode(fresh.publicKey),
    secretKey: bs58.encode(fresh.secretKey),
  };
  toStorage(kp);
  return kp;
}

/**
 * Forget the current dev keypair. Next call to {@link getOrCreateDevKeypair}
 * generates a new one. Useful for testing the "fresh wallet" flow.
 */
export function rotateDevKeypair(): DevKeypair {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY);
  }
  return getOrCreateDevKeypair();
}

/**
 * Sign `message` with the dev keypair and return a base64-encoded
 * detached signature. Matches what the server's `WalletVerifier`
 * expects via `verifySignedAction`.
 */
export function signMessage(message: string, kp: DevKeypair): string {
  const { secretKey } = decode(kp);
  const messageBytes = new TextEncoder().encode(message);
  const sig = nacl.sign.detached(messageBytes, secretKey);
  // base64 encode without Buffer (browser context).
  let binary = '';
  for (const byte of sig) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Sign + submit a gateway-built transaction with the dev keypair.
 *
 * `@solana/web3.js` is imported lazily so it only enters the bundle on
 * the dev-mode staking path — never in privy-mode builds. Submits via
 * `NEXT_PUBLIC_SOLANA_RPC_URL` (typically a localnet or devnet RPC) and
 * confirms with a blockhash strategy before resolving the base58
 * signature.
 *
 * Note: the dev keypair is a throwaway browser wallet; it must be
 * funded with SOL (and hold $ASTROID / Astroid Creds) on the target RPC
 * for staking to actually succeed. This exists so the full flow is
 * exercisable against localnet/devnet without a browser extension.
 */
async function devSignAndSendTransaction(tx: SignableTransaction, kp: DevKeypair): Promise<string> {
  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      'NEXT_PUBLIC_SOLANA_RPC_URL is not set. Dev-mode staking needs an RPC to submit transactions to.',
    );
  }
  const { Connection, Keypair, Transaction } = await import('@solana/web3.js');
  const connection = new Connection(rpcUrl, 'confirmed');
  const signer = Keypair.fromSecretKey(bs58.decode(kp.secretKey));
  const transaction = Transaction.from(base64ToBytes(tx.transaction));
  transaction.sign(signer);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction(
    {
      signature,
      blockhash: tx.blockhash,
      lastValidBlockHeight: tx.lastValidBlockHeight,
    },
    'confirmed',
  );
  return signature;
}

/**
 * Sign a gateway-built transaction with the dev keypair WITHOUT submitting
 * it, returning the base64-serialized signed tx. Mirrors the wallet's
 * `signTransaction` (used by the atomic redeem swap, where the server
 * co-signs + broadcasts). `partialSign` leaves room for the server's
 * signature; we serialize without requiring all signatures.
 */
async function devSignTransaction(tx: SignableTransaction, kp: DevKeypair): Promise<string> {
  const { Keypair, Transaction } = await import('@solana/web3.js');
  const signer = Keypair.fromSecretKey(bs58.decode(kp.secretKey));
  const transaction = Transaction.from(base64ToBytes(tx.transaction));
  transaction.partialSign(signer);
  return bytesToBase64(
    transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
}

/**
 * Adapt a {@link DevKeypair} to the shared {@link WalletSource} shape
 * used by the auth handshake. The handshake never branches on which
 * wallet source produced the signature — a Privy-connected Phantom
 * and the dev keypair are interchangeable from its point of view.
 */
export function devKeypairAsWalletSource(kp: DevKeypair): WalletSource {
  return {
    publicKey: kp.publicKey,
    signMessage: async (message: string) => signMessage(message, kp),
    signAndSendTransaction: (tx: SignableTransaction) => devSignAndSendTransaction(tx, kp),
    signTransaction: (tx: SignableTransaction) => devSignTransaction(tx, kp),
  };
}
