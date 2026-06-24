/**
 * Localnet end-to-end proof for the discovery-reward payout
 * (`chain_yield_sink` / server/chain/rewards.ts).
 *
 * Drives `RewardPayoutAdapter` against the live local validator: it
 * uses the bootstrap payer (which holds 1,000,000 test $ASTROID) as the
 * reward-pool wallet, pays a fresh recipient, and asserts the recipient
 * actually receives $ASTROID on-chain — exactly what the gateway does
 * when a player's discovery resolves with CHAIN_ENABLED=true.
 *
 *   npx tsx scripts/localnet/e2e-yield-payout.ts
 *
 * Prereqs: start-validator + bootstrap (so .keys/localnet.env has
 * SOLANA_RPC_URL + ASTROID_MINT_ADDRESS and .keys/payer.json is funded).
 * Nothing here is committed-sensitive: keys + env live under .keys/.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';

import { RewardPayoutAdapter, getRewardConfigFromEnv } from '../../server/chain/rewards.js';

const require = createRequire(import.meta.url);
const splToken = require('@solana/spl-token');

const KEYS_DIR = resolve(process.cwd(), '.keys');
dotenv.config({ path: resolve(KEYS_DIR, 'localnet.env') });

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function ok(label: string, condition: boolean, detail = ''): void {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) throw new Error(`ASSERTION FAILED: ${label} ${detail}`);
}

async function ataBalance(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
  decimals: number,
): Promise<number> {
  const ata = await splToken.getAssociatedTokenAddress(mint, owner);
  try {
    const acc = await splToken.getAccount(connection, ata);
    return Number(acc.amount) / Math.pow(10, decimals);
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const payer = loadKeypair(resolve(KEYS_DIR, 'payer.json'));

  // Use the payer (holds test $ASTROID) as the reward-pool wallet. The
  // adapter reads REWARD_WALLET_PRIVATE_KEY, so inject the payer's key.
  process.env.REWARD_WALLET_PRIVATE_KEY = JSON.stringify(Array.from(payer.secretKey));

  const config = getRewardConfigFromEnv();
  if (!config) {
    throw new Error(
      'Reward payout not configured. Need SOLANA_RPC_URL + ASTROID_MINT_ADDRESS in .keys/localnet.env.',
    );
  }

  const connection = new Connection(config.rpcUrl, 'confirmed');
  const adapter = new RewardPayoutAdapter(config, { logger: console });
  const mint = new PublicKey(config.astroidMint);
  const recipient = Keypair.generate();
  const amount = 250;

  console.log('Reward payout e2e — localnet');
  console.log(`  RPC:       ${config.rpcUrl}`);
  console.log(`  Pool:      ${adapter.rewardWalletAddress}`);
  console.log(`  $ASTROID:  ${config.astroidMint} (${config.astroidDecimals} dec)`);
  console.log(`  Recipient: ${recipient.publicKey.toBase58()}`);

  const poolBefore = await adapter.getPoolBalance();
  ok('reward pool funded', poolBefore >= amount, `pool=${poolBefore}`);

  const recipBefore = await ataBalance(
    connection,
    mint,
    recipient.publicKey,
    config.astroidDecimals,
  );
  ok('recipient starts empty', recipBefore === 0, `bal=${recipBefore}`);

  console.log(`\n[1] Paying ${amount} $ASTROID to the recipient…`);
  const sig = await adapter.payout(recipient.publicKey.toBase58(), amount, 'bennu-localnet');
  ok(
    'payout returned a signature',
    typeof sig === 'string' && sig.length > 0,
    sig.slice(0, 12) + '…',
  );

  const recipAfter = await ataBalance(
    connection,
    mint,
    recipient.publicKey,
    config.astroidDecimals,
  );
  ok('recipient received exact amount', recipAfter === amount, `${recipBefore} -> ${recipAfter}`);

  const poolAfter = await adapter.getPoolBalance();
  ok('pool debited by amount', poolBefore - poolAfter === amount, `${poolBefore} -> ${poolAfter}`);

  console.log('\n✓ Reward payout e2e passed.');
}

main().catch((err: unknown) => {
  console.error('\n✗ Reward payout e2e failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
