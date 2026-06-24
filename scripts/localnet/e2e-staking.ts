/**
 * Localnet end-to-end proof for the Quarry staking port.
 *
 * Drives `QuarryStakingAdapter` (server/chain/staking.ts) against the
 * live local validator + deployed Quarry stack and proves the full
 * lifecycle ON-CHAIN:
 *
 *   stake → accrue IOU → claim IOU → unstake → redeem IOU
 *
 * The payer keypair plays the "user" (bootstrap minted it 1,000,000
 * test $ASTROID). Since the payer is also the Rewarder authority, this
 * script first configures a generous reward rate so IOU accrues in
 * seconds rather than over a year — that admin step is NOT part of the
 * product flow, it just makes the proof fast.
 *
 * Every transaction is built UNSIGNED by the adapter (exactly what the
 * server would hand the browser), then signed here with the payer key
 * (standing in for the Privy wallet) and submitted. We assert balances
 * move the right way at each step.
 *
 *   npx tsx scripts/localnet/e2e-staking.ts
 *
 * Nothing here is committed-sensitive: keys + env live under .keys/.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import dotenv from 'dotenv';

import {
  QuarryStakingAdapter,
  getQuarryConfigFromEnv,
  isBuildError,
  type TransactionBuildResult,
  type BuildError,
} from '../../server/chain/staking.js';

const require = createRequire(import.meta.url);
const { QuarrySDK } = require('@quarryprotocol/quarry-sdk');
const { SolanaProvider } = require('@saberhq/solana-contrib');
const { Token, u64 } = require('@saberhq/token-utils');
const splToken = require('@solana/spl-token');

const KEYS_DIR = resolve(process.cwd(), '.keys');
dotenv.config({ path: resolve(KEYS_DIR, 'localnet.env') });

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function ok(label: string, condition: boolean, detail = ''): void {
  const mark = condition ? '✓' : '✗';
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${label} ${detail}`);
  }
}

/** Sign an adapter-built tx with the payer and submit + confirm. */
async function signSubmit(
  connection: Connection,
  payer: Keypair,
  built: TransactionBuildResult | BuildError,
  what: string,
): Promise<string> {
  if (isBuildError(built)) {
    throw new Error(`build ${what} failed: ${built.error}`);
  }
  const tx = Transaction.from(Buffer.from(built.transaction, 'base64'));
  tx.partialSign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
    'confirmed',
  );
  return sig;
}

/** Read an SPL token ATA balance in UI units (0 if the ATA is absent). */
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
  const config = getQuarryConfigFromEnv();
  if (!config) {
    throw new Error('Quarry not configured. Run start-validator + bootstrap + deploy-quarry first.');
  }

  const payer = loadKeypair(resolve(KEYS_DIR, 'payer.json'));
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const adapter = new QuarryStakingAdapter(config, { connection, logger: console });

  const astroidMint = new PublicKey(config.astroidMint);
  const iouMint = new PublicKey(config.iouTokenMint!);
  const redeemer = new PublicKey(config.redeemerWallet!);
  const user = payer.publicKey;

  console.log('Quarry staking e2e — localnet');
  console.log(`  RPC:       ${config.rpcUrl}`);
  console.log(`  User:      ${user.toBase58()}`);
  console.log(`  $ASTROID:  ${config.astroidMint} (${config.astroidDecimals} dec)`);
  console.log(`  IOU:       ${config.iouTokenMint} (${config.iouDecimals} dec)`);
  console.log(`  Quarry:    ${config.quarryAddress}`);

  // ---- Admin: set a fast reward rate so IOU accrues in seconds ----------
  console.log('\n[setup] Configuring reward rate (admin; payer is rewarder authority)…');
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
        txs.forEach((t) => t.partialSign(payer));
        return txs;
      },
    },
  });
  const sdk = QuarrySDK.load({ provider });
  const rewarderWrapper = await sdk.mine.loadRewarderWrapper(new PublicKey(config.rewarderAddress));
  const astroidToken = Token.fromMint(astroidMint, config.astroidDecimals, {
    name: 'Astroid',
    symbol: 'ASTROID',
  });
  const quarryWrapper = await rewarderWrapper.getQuarry(astroidToken);

  // Single quarry takes 100% of the rewarder's share.
  await (await quarryWrapper.setRewardsShare(new u64(100))).confirm();
  // ~1 IOU/sec: annual rate = 31_536_000 sec * 1e9 raw (9 dec).
  const annualRate = new u64('31536000000000000');
  await (await rewarderWrapper.setAndSyncAnnualRewards(annualRate, [astroidMint])).confirm();
  console.log('  reward rate set (~1 IOU/sec to the sole staker)');

  const STAKE = 1000;

  // ---- 1) Stake --------------------------------------------------------
  console.log('\n[1] Stake 1000 $ASTROID');
  const astroidBefore = await ataBalance(connection, astroidMint, user, config.astroidDecimals);
  const stakeSig = await signSubmit(
    connection,
    payer,
    await adapter.buildStakeTransaction(user.toBase58(), STAKE),
    'stake',
  );
  const verify = await adapter.verifyStakeTransaction(stakeSig, user.toBase58(), STAKE);
  ok('stake tx verified on-chain', verify.verified, verify.error ?? stakeSig.slice(0, 12));
  const astroidAfterStake = await ataBalance(connection, astroidMint, user, config.astroidDecimals);
  ok('wallet $ASTROID decreased by stake', Math.round(astroidBefore - astroidAfterStake) === STAKE,
    `${astroidBefore} -> ${astroidAfterStake}`);
  const infoAfterStake = await adapter.getUserStakeInfo(user.toBase58());
  ok('on-chain staked balance == 1000', Math.round(infoAfterStake.stakedAmount) === STAKE,
    `staked=${infoAfterStake.stakedAmount}`);

  // ---- 2) Accrue + claim ----------------------------------------------
  console.log('\n[2] Wait ~6s for IOU accrual, then claim');
  await new Promise((r) => setTimeout(r, 6000));
  const iouBeforeClaim = await ataBalance(connection, iouMint, user, config.iouDecimals);
  const claimSig = await signSubmit(
    connection,
    payer,
    await adapter.buildClaimRewardsTransaction(user.toBase58()),
    'claim',
  );
  const iouAfterClaim = await ataBalance(connection, iouMint, user, config.iouDecimals);
  ok('claim minted IOU-ASTROID to wallet', iouAfterClaim > iouBeforeClaim,
    `IOU ${iouBeforeClaim} -> ${iouAfterClaim} (sig ${claimSig.slice(0, 12)})`);

  // ---- 3) Unstake ------------------------------------------------------
  console.log('\n[3] Unstake 1000 $ASTROID');
  await signSubmit(
    connection,
    payer,
    await adapter.buildUnstakeTransaction(user.toBase58(), STAKE),
    'unstake',
  );
  const infoAfterUnstake = await adapter.getUserStakeInfo(user.toBase58());
  ok('on-chain staked balance back to 0', Math.round(infoAfterUnstake.stakedAmount) === 0,
    `staked=${infoAfterUnstake.stakedAmount}`);
  const astroidAfterUnstake = await ataBalance(connection, astroidMint, user, config.astroidDecimals);
  ok('wallet $ASTROID restored', Math.round(astroidAfterUnstake) >= Math.round(astroidBefore),
    `${astroidAfterUnstake}`);

  // ---- 4) Redeem -------------------------------------------------------
  console.log('\n[4] Redeem IOU-ASTROID to the redeemer wallet');
  const redeemAmount = Math.max(1, Math.floor(iouAfterClaim / 2));
  const redeemerBefore = await ataBalance(connection, iouMint, redeemer, config.iouDecimals);
  const redeemSig = await signSubmit(
    connection,
    payer,
    await adapter.buildRedeemTransaction(user.toBase58(), redeemAmount),
    'redeem',
  );
  const redeemerAfter = await ataBalance(connection, iouMint, redeemer, config.iouDecimals);
  ok('redeemer received IOU-ASTROID', Math.round(redeemerAfter - redeemerBefore) === redeemAmount,
    `redeemer IOU ${redeemerBefore} -> ${redeemerAfter} (sig ${redeemSig.slice(0, 12)})`);

  console.log('\n✓ Quarry staking e2e PASSED — stake → accrue → claim → unstake → redeem all on-chain.');
}

main().catch((error: unknown) => {
  console.error('\n✗ e2e FAILED:', error instanceof Error ? error.message : error);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logs = (error as any)?.logs;
  if (Array.isArray(logs)) for (const l of logs) console.error('  ', l);
  process.exit(1);
});
