/**
 * Guarded Quarry deploy for a REAL cluster (devnet / mainnet).
 *
 * Same on-chain steps as scripts/localnet/deploy-quarry.ts (IOU mint +
 * MintWrapper + Rewarder + Quarry + Minter) but with safety rails for
 * moving real value:
 *
 *   - Detects the cluster from its genesis hash and refuses to touch
 *     mainnet unless CONFIRM_MAINNET=YES.
 *   - Refuses a localhost RPC unless ALLOW_LOCALNET=1 (use the localnet
 *     script for that).
 *   - Verifies the payer's SOL balance and the $ASTROID mint's decimals
 *     before doing anything.
 *   - DRY-RUN by default: prints the full plan and exits. Set
 *     EXECUTE=YES to actually send transactions.
 *   - Sets NO reward rate — emissions stay at 0 until you deliberately
 *     configure them later. (Astroid's reward model is the per-asteroid
 *     discovery payout in server/chain/rewards.ts, not Quarry emission.)
 *
 * Required env:
 *   SOLANA_RPC_URL          paid RPC for the target cluster (e.g. Helius)
 *   ASTROID_MINT_ADDRESS    the real $ASTROID mint (6 decimals)
 *   PAYER_KEYPAIR           path to the admin keypair JSON (becomes the
 *                           MintWrapper + Rewarder authority — keep it safe)
 * Optional env:
 *   CONFIRM_MAINNET=YES     required to proceed on mainnet
 *   EXECUTE=YES             required to send txs (otherwise dry-run)
 *   EXPECTED_ASTROID_DECIMALS  default 6 (abort on mismatch)
 *   MIN_PAYER_SOL           default 0.5 (floor; real cost is well under 0.15)
 *   ALLOW_LOCALNET=1        permit a localhost RPC
 *   OUT_ENV                 output env path (default .keys/<network>.env)
 *
 * Usage:
 *   SOLANA_RPC_URL=... ASTROID_MINT_ADDRESS=... PAYER_KEYPAIR=./admin.json \
 *     npx tsx scripts/deploy/deploy-quarry-guarded.ts            # dry-run
 *   ... CONFIRM_MAINNET=YES EXECUTE=YES npx tsx scripts/deploy/deploy-quarry-guarded.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const require = createRequire(import.meta.url);
const { QuarrySDK } = require('@quarryprotocol/quarry-sdk');
const { SolanaProvider } = require('@saberhq/solana-contrib');
const { Token, u64 } = require('@saberhq/token-utils');

const IOU_TOKEN_DECIMALS = 9;
const IOU_HARDCAP = new u64('1000000000000000000');

// Cluster genesis hashes — the reliable way to know what we're aimed at.
const GENESIS = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
} as const;

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function loadKeypair(path: string): Keypair {
  if (!existsSync(path)) fail(`PAYER_KEYPAIR not found at ${path}`);
  const secret = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function writeEnv(outPath: string, values: Record<string, string>): void {
  let text = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  for (const [key, val] of Object.entries(values)) {
    const line = `${key}=${val}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(outPath, text);
}

async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const astroidMintStr = process.env.ASTROID_MINT_ADDRESS;
  const payerPath = process.env.PAYER_KEYPAIR;
  const execute = process.env.EXECUTE === 'YES';
  const expectedDecimals = Number(process.env.EXPECTED_ASTROID_DECIMALS ?? '6');
  // The deploy creates a handful of small accounts (IOU mint, MintWrapper,
  // Rewarder, Quarry, Minter). Actual cost is well under ~0.15 SOL — mostly
  // refundable rent-exempt deposits plus negligible tx fees. The floor is a
  // guardrail so the 4-step sequence can't run dry mid-way (which would leave
  // a half-deployed Quarry), NOT a reflection of real cost. Override with
  // MIN_PAYER_SOL if you want more/less headroom.
  const minSol = Number(process.env.MIN_PAYER_SOL ?? '0.5');

  if (!rpcUrl) fail('SOLANA_RPC_URL is required.');
  if (!astroidMintStr) fail('ASTROID_MINT_ADDRESS is required.');
  if (!payerPath) fail('PAYER_KEYPAIR (path to admin keypair JSON) is required.');

  const isLocalhost = /127\.0\.0\.1|localhost/.test(rpcUrl);
  if (isLocalhost && process.env.ALLOW_LOCALNET !== '1') {
    fail(
      'RPC looks like localhost. Use scripts/localnet/deploy-quarry.ts, or set ALLOW_LOCALNET=1.',
    );
  }

  const connection = new Connection(rpcUrl, 'confirmed');

  // --- Cluster detection ---------------------------------------------------
  let network = 'unknown';
  try {
    const genesis = await connection.getGenesisHash();
    network = (GENESIS as Record<string, string>)[genesis] ?? `unknown(${genesis.slice(0, 8)}…)`;
  } catch (err) {
    fail(`Could not reach RPC ${rpcUrl}: ${err instanceof Error ? err.message : err}`);
  }

  console.log('Guarded Quarry deploy');
  console.log(`  RPC:      ${rpcUrl}`);
  console.log(`  Cluster:  ${network}`);
  console.log(`  Mode:     ${execute ? 'EXECUTE (will send txs)' : 'DRY-RUN (no txs)'}`);

  if (network === 'mainnet' && process.env.CONFIRM_MAINNET !== 'YES') {
    fail('Target is MAINNET. Re-run with CONFIRM_MAINNET=YES to acknowledge real-value deploy.');
  }

  // --- Payer checks --------------------------------------------------------
  const payer = loadKeypair(payerPath);
  const balance = await connection.getBalance(payer.publicKey);
  const sol = balance / LAMPORTS_PER_SOL;
  console.log(`  Payer:    ${payer.publicKey.toBase58()} (admin authority)`);
  console.log(`  SOL:      ${sol.toFixed(4)}`);
  if (sol < minSol) {
    fail(`Payer balance ${sol.toFixed(4)} SOL is below MIN_PAYER_SOL=${minSol}. Fund it first.`);
  }

  // --- Mint checks ---------------------------------------------------------
  const astroidMint = new PublicKey(astroidMintStr);
  const parsed = await connection.getParsedAccountInfo(astroidMint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info = (parsed.value?.data as any)?.parsed?.info;
  if (!info || typeof info.decimals !== 'number') {
    fail(`ASTROID_MINT_ADDRESS ${astroidMintStr} is not a readable SPL mint on ${network}.`);
  }
  const astroidDecimals = info.decimals as number;
  console.log(`  $ASTROID: ${astroidMint.toBase58()}`);
  console.log(`            decimals=${astroidDecimals} supply=${info.supply ?? '?'}`);
  console.log(`            mintAuthority=${info.mintAuthority ?? 'null'}`);
  if (astroidDecimals !== expectedDecimals) {
    fail(
      `$ASTROID decimals=${astroidDecimals} but EXPECTED_ASTROID_DECIMALS=${expectedDecimals}. ` +
        `Set EXPECTED_ASTROID_DECIMALS to override if this is intentional.`,
    );
  }

  console.log('\nPlan:');
  console.log('  [1/4] Create IOU-ASTROID token (9 dec) + MintWrapper');
  console.log('  [2/4] Create Rewarder (authority = payer)');
  console.log('  [3/4] Create Quarry (stake token = $ASTROID)');
  console.log('  [4/4] Allow Rewarder to mint IOU-ASTROID (minter allowance)');
  console.log('  NOTE: reward rate is NOT set (emissions = 0 until you set it deliberately).');

  if (!execute) {
    console.log(
      '\nDRY-RUN complete. Re-run with EXECUTE=YES (and CONFIRM_MAINNET=YES on mainnet) to deploy.',
    );
    return;
  }

  // --- Execute -------------------------------------------------------------
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

  console.log('\n[1/4] Creating IOU-ASTROID token + MintWrapper…');
  const pending = await sdk.mintWrapper.newWrapperAndMint({
    mintKP: Keypair.generate(),
    decimals: IOU_TOKEN_DECIMALS,
    hardcap: IOU_HARDCAP,
    baseKP: Keypair.generate(),
    admin: payer.publicKey,
  });
  await pending.tx.confirm();
  const iouMint = pending.mint;
  const mintWrapperKey = pending.mintWrapper;
  console.log(`      IOU mint:    ${iouMint.toBase58()}`);
  console.log(`      MintWrapper: ${mintWrapperKey.toBase58()}`);

  console.log('[2/4] Creating Rewarder…');
  const { key: rewarderKey, tx: rewarderTx } = await sdk.mine.createRewarder({
    mintWrapper: mintWrapperKey,
    baseKP: Keypair.generate(),
    authority: payer.publicKey,
  });
  await rewarderTx.confirm();
  console.log(`      Rewarder:    ${rewarderKey.toBase58()}`);

  const rewarderWrapper = await sdk.mine.loadRewarderWrapper(rewarderKey);

  console.log('[3/4] Creating Quarry ($ASTROID staking pool)…');
  const astroidToken = Token.fromMint(astroidMint, astroidDecimals, {
    name: 'ASTROID',
    symbol: 'ASTROID',
  });
  const { quarry: quarryKey, tx: quarryTx } = await rewarderWrapper.createQuarry({
    token: astroidToken,
  });
  await quarryTx.confirm();
  console.log(`      Quarry:      ${quarryKey.toBase58()}`);

  console.log('[4/4] Configuring Minter (Rewarder -> IOU-ASTROID)…');
  const minterTx = await sdk.mintWrapper.newMinterWithAllowance(
    mintWrapperKey,
    rewarderKey,
    IOU_HARDCAP,
  );
  await minterTx.confirm();

  const result = {
    network,
    timestamp: new Date().toISOString(),
    astroidToken: astroidMint.toBase58(),
    astroidDecimals,
    iouToken: iouMint.toBase58(),
    mintWrapper: mintWrapperKey.toBase58(),
    rewarder: rewarderKey.toBase58(),
    quarry: quarryKey.toBase58(),
    deployer: payer.publicKey.toBase58(),
  };

  const keysDir = resolve(process.cwd(), '.keys');
  const outEnv = process.env.OUT_ENV || resolve(keysDir, `${network}.env`);
  writeEnv(outEnv, {
    QUARRY_MINT_WRAPPER: result.mintWrapper,
    QUARRY_REWARDER_ADDRESS: result.rewarder,
    QUARRY_ADDRESS: result.quarry,
    IOU_TOKEN_MINT: result.iouToken,
  });
  writeFileSync(
    resolve(keysDir, `quarry-deployment-${network}.json`),
    JSON.stringify(result, null, 2),
  );

  console.log(`\n✓ Quarry deployed on ${network}. Wrote QUARRY_* to ${outEnv}`);
  console.log(JSON.stringify(result, null, 2));
  console.log(
    '\nNext: set these QUARRY_* / IOU_TOKEN_MINT as gateway secrets (fly secrets set …), ' +
      'and remember emissions are 0 until you set a reward rate.',
  );
}

main().catch((error: unknown) => {
  console.error('Quarry deploy failed:', error instanceof Error ? error.message : error);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logs = (error as any)?.logs;
  if (Array.isArray(logs)) for (const l of logs) console.error('  ', l);
  process.exit(1);
});
