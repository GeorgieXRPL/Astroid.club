/**
 * Deploy Quarry staking infrastructure (IOU token + MintWrapper +
 * Rewarder + Quarry + Minter) for astroid.club.
 *
 * Ported from Black-Gold's `scripts/deploy-quarry.ts`, themed to
 * $ASTROID and made localnet-first:
 *   - $ASTROID  = the token users STAKE (a test mint on localnet).
 *   - IOU-ASTROID = the Quarry reward token (MintWrapper-controlled),
 *     earned by stakers and later redeemed 1:1-ish for $ASTROID at the
 *     Redeemer (funded by the buyback service in a later step).
 *
 * Run against the localnet validator started by start-validator.sh:
 *   npx tsx scripts/localnet/deploy-quarry.ts
 *
 * Reads config from .keys/localnet.env (RPC, ASTROID mint) and signs
 * with the payer keypair at .keys/payer.json. On success it writes the
 * QUARRY_* / IOU_TOKEN_MINT values back into .keys/localnet.env and
 * dumps a .keys/quarry-deployment.json. Nothing here is proprietary or
 * committed — keys + outputs live under the gitignored .keys/.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import dotenv from 'dotenv';

// Quarry/Saber ship as CommonJS; Node's ESM loader can't see their named
// exports, so load them through createRequire. (The lazy loader in
// server/chain/staking.ts uses the same interop at runtime.)
const require = createRequire(import.meta.url);
const { QuarrySDK } = require('@quarryprotocol/quarry-sdk');
const { SolanaProvider } = require('@saberhq/solana-contrib');
const { Token, u64 } = require('@saberhq/token-utils');

const KEYS_DIR = resolve(process.cwd(), '.keys');
const ENV_PATH = resolve(KEYS_DIR, 'localnet.env');

dotenv.config({ path: ENV_PATH });

const RPC_URL = process.env.SOLANA_RPC_URL || 'http://127.0.0.1:8899';
const ASTROID_MINT = process.env.ASTROID_MINT_ADDRESS;
const PAYER_KEYPAIR_PATH = process.env.PAYER_KEYPAIR || resolve(KEYS_DIR, 'payer.json');

// IOU reward-token config. Decimals are independent of $ASTROID; we keep
// 9 (Solana convention, matching the audited source) and a 1B hardcap.
const IOU_TOKEN_DECIMALS = 9;
const IOU_HARDCAP = new u64('1000000000000000000');

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

/** Patch QUARRY_* / IOU_TOKEN_MINT values into .keys/localnet.env. */
function writeEnv(values: Record<string, string>): void {
  let text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  for (const [key, val] of Object.entries(values)) {
    const line = `${key}=${val}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(ENV_PATH, text);
}

async function main(): Promise<void> {
  if (!ASTROID_MINT) {
    throw new Error('ASTROID_MINT_ADDRESS not set (run start-validator + create the test mint first)');
  }

  const payer = loadKeypair(PAYER_KEYPAIR_PATH);
  const connection = new Connection(RPC_URL, 'confirmed');

  console.log('Quarry deploy — astroid.club');
  console.log(`  RPC:    ${RPC_URL}`);
  console.log(`  Payer:  ${payer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`  SOL:    ${(balance / LAMPORTS_PER_SOL).toFixed(3)}`);
  if (balance < 2 * LAMPORTS_PER_SOL) {
    console.warn('  ! low balance; airdrop more SOL to the payer');
  }

  const astroidMint = new PublicKey(ASTROID_MINT);
  console.log(`  Stake token ($ASTROID): ${astroidMint.toBase58()}`);

  const provider = SolanaProvider.init({
    connection,
    wallet: {
      publicKey: payer.publicKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signTransaction: async (tx: any) => {
        tx.partialSign(payer);
        return tx;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signAllTransactions: async (txs: any[]) => {
        txs.forEach((tx) => tx.partialSign(payer));
        return txs;
      },
    },
  });

  const sdk = QuarrySDK.load({ provider });

  // 1) IOU-ASTROID token + MintWrapper.
  console.log('\n[1/4] Creating IOU-ASTROID token + MintWrapper...');
  const pendingMintAndWrapper = await sdk.mintWrapper.newWrapperAndMint({
    mintKP: Keypair.generate(),
    decimals: IOU_TOKEN_DECIMALS,
    hardcap: IOU_HARDCAP,
    baseKP: Keypair.generate(),
    admin: payer.publicKey,
  });
  await pendingMintAndWrapper.tx.confirm();
  const iouMint = pendingMintAndWrapper.mint;
  const mintWrapperKey = pendingMintAndWrapper.mintWrapper;
  console.log(`      IOU mint:     ${iouMint.toBase58()}`);
  console.log(`      MintWrapper:  ${mintWrapperKey.toBase58()}`);

  // 2) Rewarder.
  console.log('[2/4] Creating Rewarder...');
  const { key: rewarderKey, tx: rewarderTx } = await sdk.mine.createRewarder({
    mintWrapper: mintWrapperKey,
    baseKP: Keypair.generate(),
    authority: payer.publicKey,
  });
  await rewarderTx.confirm();
  console.log(`      Rewarder:     ${rewarderKey.toBase58()}`);

  const rewarderWrapper = await sdk.mine.loadRewarderWrapper(rewarderKey);

  // 3) Quarry (the $ASTROID staking pool).
  console.log('[3/4] Creating Quarry ($ASTROID staking pool)...');
  const parsed = await connection.getParsedAccountInfo(astroidMint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const astroidDecimals = (parsed.value?.data as any)?.parsed?.info?.decimals ?? 6;
  const astroidToken = Token.fromMint(astroidMint, astroidDecimals, {
    name: 'ASTROID',
    symbol: 'ASTROID',
  });
  const { quarry: quarryKey, tx: quarryTx } = await rewarderWrapper.createQuarry({
    token: astroidToken,
  });
  await quarryTx.confirm();
  console.log(`      Quarry:       ${quarryKey.toBase58()}`);

  // 4) Allow the Rewarder to mint IOU-ASTROID.
  console.log('[4/4] Configuring Minter (Rewarder -> IOU-ASTROID)...');
  const minterTx = await sdk.mintWrapper.newMinterWithAllowance(
    mintWrapperKey,
    rewarderKey,
    IOU_HARDCAP,
  );
  await minterTx.confirm();

  const result = {
    network: process.env.SOLANA_NETWORK || 'localnet',
    timestamp: new Date().toISOString(),
    astroidToken: astroidMint.toBase58(),
    iouToken: iouMint.toBase58(),
    mintWrapper: mintWrapperKey.toBase58(),
    rewarder: rewarderKey.toBase58(),
    quarry: quarryKey.toBase58(),
    deployer: payer.publicKey.toBase58(),
  };

  writeEnv({
    QUARRY_MINT_WRAPPER: result.mintWrapper,
    QUARRY_REWARDER_ADDRESS: result.rewarder,
    QUARRY_ADDRESS: result.quarry,
    IOU_TOKEN_MINT: result.iouToken,
  });
  writeFileSync(resolve(KEYS_DIR, 'quarry-deployment.json'), JSON.stringify(result, null, 2));

  console.log('\n✓ Quarry infrastructure deployed. Wrote QUARRY_* to .keys/localnet.env');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error('Quarry deploy failed:', error instanceof Error ? error.message : error);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logs = (error as any)?.logs;
  if (Array.isArray(logs)) for (const l of logs) console.error('  ', l);
  process.exit(1);
});
