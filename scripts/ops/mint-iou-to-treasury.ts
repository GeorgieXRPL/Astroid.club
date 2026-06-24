/**
 * Fund the redeemer treasury with IOU-ASTROID, the proper way.
 *
 * The IOU mint authority is the Quarry MintWrapper (a PDA), so you can't
 * `spl-token mint`. Minting goes through the wrapper using the wrapper
 * ADMIN keypair (the deployer, 9xB6…). The wrapper's whole hardcap is
 * currently allocated to the rewarder's minter, and Quarry caps
 * `total_allowance <= hard_cap`, so we:
 *
 *   [1] lower the rewarder's minter allowance by AMOUNT (emissions are 0 —
 *       Astroid pays rewards via discovery payouts, not Quarry emission),
 *   [2] grant the admin wallet a minter allowance of AMOUNT (create or
 *       top-up), keeping total_allowance == hard_cap,
 *   [3] performMintTo AMOUNT IOU-ASTROID into the treasury's ATA.
 *
 * All three are signed by PAYER_KEYPAIR (must be the wrapper admin).
 *
 * Guarded: DRY-RUN by default. Set EXECUTE=YES (and CONFIRM_MAINNET=YES on
 * mainnet) to send. Read-only RPC reads happen in both modes.
 *
 * Required env:
 *   SOLANA_RPC_URL        paid RPC (Helius/etc.)
 *   PAYER_KEYPAIR         path to the wrapper-admin keypair (default .keys/jup-9x.json)
 *   AMOUNT                IOU-ASTROID to mint, in UI units (e.g. 1000000)
 * Optional env (default to the mainnet deployment record / verified treasury):
 *   IOU_TOKEN_MINT, QUARRY_MINT_WRAPPER, QUARRY_REWARDER_ADDRESS,
 *   IOU_TOKEN_DECIMALS (default 9), TREASURY_OWNER, CONFIRM_MAINNET=YES, EXECUTE=YES
 *
 * Usage:
 *   SOLANA_RPC_URL=... AMOUNT=1000000 npx tsx scripts/ops/mint-iou-to-treasury.ts          # dry-run
 *   ... CONFIRM_MAINNET=YES EXECUTE=YES npx tsx scripts/ops/mint-iou-to-treasury.ts        # send
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const require = createRequire(import.meta.url);
const { QuarrySDK } = require('@quarryprotocol/quarry-sdk');
const { SolanaProvider } = require('@saberhq/solana-contrib');
const { Token, TokenAmount, u64 } = require('@saberhq/token-utils');

// Defaults from the recorded mainnet deployment + verified treasury.
const DEFAULTS = {
  iouMint: '3kxHUvQvg4LBxt5CvF5kWTNA6P1S6EswpCwBMvGi5Fzs',
  wrapper: 'F6ixhGmT5BGDhn2Ki86wWUV5gaXDzaQwQ1HjdXeaCZWM',
  rewarder: 'H8E2UucvSq2dtcF6oNgSvskP2yUf7xfJemSWrrtw3cM1',
  treasury: '2u1CYqNikh2dHZ2a3CabkcXib6GmcPR4RMWC27DoP7n5',
};

const GENESIS: Record<string, string> = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'devnet',
};

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function loadKeypair(path: string): Keypair {
  if (!existsSync(path)) fail(`PAYER_KEYPAIR not found at ${path}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
}

async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL || fail('SOLANA_RPC_URL is required');
  const payerPath = process.env.PAYER_KEYPAIR ?? '.keys/jup-9x.json';
  const amountUi = process.env.AMOUNT;
  if (!amountUi || !(Number(amountUi) > 0)) fail('AMOUNT (UI units, > 0) is required');
  const decimals = Number(process.env.IOU_TOKEN_DECIMALS ?? '9');
  const execute = process.env.EXECUTE === 'YES';

  const iouMint = new PublicKey(process.env.IOU_TOKEN_MINT ?? DEFAULTS.iouMint);
  const wrapper = new PublicKey(process.env.QUARRY_MINT_WRAPPER ?? DEFAULTS.wrapper);
  const rewarder = new PublicKey(process.env.QUARRY_REWARDER_ADDRESS ?? DEFAULTS.rewarder);
  const treasury = new PublicKey(process.env.TREASURY_OWNER ?? DEFAULTS.treasury);

  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = loadKeypair(payerPath);

  // Cluster guard.
  const genesis = await connection.getGenesisHash();
  const network = GENESIS[genesis] ?? 'unknown';
  if (execute && network === 'mainnet' && process.env.CONFIRM_MAINNET !== 'YES') {
    fail('Refusing to EXECUTE on MAINNET without CONFIRM_MAINNET=YES.');
  }

  const provider = SolanaProvider.init({
    connection,
    wallet: {
      publicKey: payer.publicKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signTransaction: async (tx: any) => (tx.partialSign(payer), tx),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signAllTransactions: async (txs: any[]) => (txs.forEach((t) => t.partialSign(payer)), txs),
    },
  });
  const sdk = QuarrySDK.load({ provider });

  const token = Token.fromMint(iouMint, decimals);
  const amount = TokenAmount.parse(token, amountUi);
  const amountRaw = amount.toU64();

  // Read current state.
  const w = await sdk.mintWrapper.fetchMintWrapper(wrapper);
  if (!w) fail(`MintWrapper ${wrapper.toBase58()} not found.`);
  if (w.admin.toBase58() !== payer.publicKey.toBase58()) {
    fail(
      `PAYER (${payer.publicKey.toBase58()}) is not the wrapper admin (${w.admin.toBase58()}). ` +
        `Use the deployer keypair.`,
    );
  }
  const rewarderMinter = await sdk.mintWrapper.fetchMinter(wrapper, rewarder);
  if (!rewarderMinter) fail('Rewarder minter not found — unexpected for this wrapper.');
  const adminMinter = await sdk.mintWrapper.fetchMinter(wrapper, payer.publicKey);

  const rewarderNew = rewarderMinter.allowance.sub(amountRaw);
  if (rewarderNew.isNeg()) {
    fail(
      `Not enough rewarder allowance to free up (${rewarderMinter.allowance.toString()} raw) ` +
        `for AMOUNT (${amountRaw.toString()} raw). Mint a smaller amount.`,
    );
  }
  const adminNew = (adminMinter ? adminMinter.allowance : new u64(0)).add(amountRaw);

  console.log('\n— Mint IOU-ASTROID → treasury —');
  console.log(`  network:        ${network}`);
  console.log(`  admin (payer):  ${payer.publicKey.toBase58()}`);
  console.log(`  IOU mint:       ${iouMint.toBase58()} (${decimals} dec)`);
  console.log(`  wrapper:        ${wrapper.toBase58()}`);
  console.log(`  treasury owner: ${treasury.toBase58()}`);
  console.log(`  AMOUNT:         ${amountUi} IOU (${amountRaw.toString()} raw)`);
  console.log('  Plan:');
  console.log(
    `    [1] rewarder minter allowance ${rewarderMinter.allowance.toString()} → ${rewarderNew.toString()}`,
  );
  console.log(
    `    [2] admin minter allowance ${adminMinter ? adminMinter.allowance.toString() : 'none'} → ${adminNew.toString()}` +
      (adminMinter ? ' (update)' : ' (create)'),
  );
  console.log(`    [3] performMintTo ${amountUi} IOU → treasury ATA`);

  if (!execute) {
    console.log('\nDRY-RUN. Re-run with EXECUTE=YES (and CONFIRM_MAINNET=YES on mainnet) to send.');
    return;
  }

  console.log('\n[1/3] Lowering rewarder allowance…');
  await (await sdk.mintWrapper.minterUpdate(wrapper, rewarder, rewarderNew)).confirm();

  console.log('[2/3] Granting admin minter allowance…');
  if (adminMinter) {
    await (await sdk.mintWrapper.minterUpdate(wrapper, payer.publicKey, adminNew)).confirm();
  } else {
    await (await sdk.mintWrapper.newMinterWithAllowance(wrapper, payer.publicKey, amountRaw)).confirm();
  }

  console.log('[3/3] Minting to treasury…');
  const tx = await sdk.mintWrapper.performMintTo({
    amount,
    mintWrapper: wrapper,
    minterAuthority: payer.publicKey,
    destOwner: treasury,
  });
  const sig = await tx.confirm();
  console.log(`\n✓ Minted ${amountUi} IOU-ASTROID to ${treasury.toBase58()}`);
  console.log(`  tx: ${sig.signature ?? sig}`);
}

main().catch((err) => {
  console.error('\n✗ mint failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
