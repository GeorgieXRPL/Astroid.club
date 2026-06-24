/**
 * One-shot diagnostic for holder reads.
 *
 * Hits Helius's `/v0/addresses/{wallet}/balances` REST endpoint
 * directly using the credentials in `.env.local`, then prints what
 * the gateway's `SolanaBalanceReader` would see end-to-end. Use this
 * when `verify_holder` returns `not_qualified` for a wallet you know
 * holds the token, to figure out whether the issue is:
 *
 *   - Wrong wallet (no $ASTROID at all)
 *   - Wrong mint pubkey in `.env.local`
 *   - Wrong `ASTROID_DECIMALS` in `.env.local` (the reader uses this
 *     to scale the raw amount; off-by-1000 between 6 and 9 decimals
 *     is a common foot-gun)
 *   - Helius returning a different shape than we parse
 *
 * Run:
 *   node scripts/debug-holder-read.mjs <wallet-address>
 */
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const localPath = resolve(process.cwd(), '.env.local');
if (existsSync(localPath)) dotenvConfig({ path: localPath, override: true });

const wallet = process.argv[2];
if (!wallet) {
  console.error('usage: node scripts/debug-holder-read.mjs <wallet>');
  process.exit(2);
}

const apiKey = process.env.HELIUS_API_KEY;
const mintConfigured = process.env.ASTROID_MINT_ADDRESS;
const decimalsConfigured = Number(process.env.ASTROID_DECIMALS ?? '9');
const minBalance = Number(process.env.HOLDER_MIN_BALANCE ?? '1');
const rpcUrl = process.env.SOLANA_RPC_URL ?? '';
const isDevnet = rpcUrl.includes('devnet');

console.log('--- env from .env.local ---');
console.log(
  '  ASTROID_MINT_ADDRESS:',
  mintConfigured ? `${mintConfigured.slice(0, 8)}…${mintConfigured.slice(-6)}` : '(unset)',
);
console.log('  ASTROID_DECIMALS:    ', decimalsConfigured);
console.log('  HOLDER_MIN_BALANCE:  ', minBalance);
console.log(
  '  HELIUS_API_KEY:      ',
  apiKey ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : '(unset)',
);
console.log('  isDevnet:            ', isDevnet);
console.log('');

if (!apiKey) {
  console.error(
    'HELIUS_API_KEY is unset in .env.local; this script can only test the Helius REST path.',
  );
  process.exit(2);
}

const base = isDevnet ? 'https://api-devnet.helius.xyz' : 'https://api.helius.xyz';
const url = `${base}/v0/addresses/${wallet}/balances?api-key=${apiKey}`;

console.log(`--- GET ${base}/v0/addresses/${wallet.slice(0, 8)}…/balances ---`);

const r = await fetch(url);
if (!r.ok) {
  console.error(`HTTP ${r.status}: ${await r.text()}`);
  process.exit(1);
}

const data = await r.json();
console.log('  nativeBalance (lamports):', data.nativeBalance ?? '(missing)');
console.log('  tokens count:           ', data.tokens?.length ?? 0);

if (!data.tokens || data.tokens.length === 0) {
  console.log(
    '\nNo SPL tokens reported for this wallet. Either it really holds nothing, or you have the wrong wallet.',
  );
  process.exit(0);
}

console.log('\n--- all tokens (mint, raw amount, decimals, uiAmount = raw / 10^decimals) ---');
for (const t of data.tokens) {
  const decimals = typeof t.decimals === 'number' ? t.decimals : decimalsConfigured;
  const ui = t.amount / Math.pow(10, decimals);
  const isOurMint = mintConfigured && t.mint?.toLowerCase() === mintConfigured.toLowerCase();
  console.log(
    `  ${isOurMint ? '★' : ' '} ${t.mint}  raw=${t.amount}  decimals=${t.decimals ?? '?'}  ui=${ui}`,
  );
}

if (mintConfigured) {
  const match = data.tokens.find((t) => t.mint?.toLowerCase() === mintConfigured.toLowerCase());
  console.log('\n--- decision (replicating gateway logic) ---');
  if (!match) {
    console.log(`  no entry for ASTROID_MINT_ADDRESS=${mintConfigured}`);
    console.log(`  → reader returns 0, gateway says not_qualified`);
    console.log(
      '  fix: confirm the mint pubkey in .env.local matches one of the mints listed above',
    );
  } else {
    const usingConfigured = match.amount / Math.pow(10, decimalsConfigured);
    const usingActual = match.amount / Math.pow(10, match.decimals ?? decimalsConfigured);
    console.log(`  matched mint:                   ${match.mint}`);
    console.log(`  raw amount:                     ${match.amount}`);
    console.log(`  decimals reported by Helius:    ${match.decimals ?? '(missing)'}`);
    console.log(`  decimals in .env.local:         ${decimalsConfigured}`);
    console.log(`  uiAmount with .env.local dec:   ${usingConfigured}`);
    console.log(`  uiAmount with Helius dec:       ${usingActual}`);
    console.log(`  HOLDER_MIN_BALANCE:             ${minBalance}`);
    console.log(`  reader returns:                 ${usingConfigured}`);
    if (usingConfigured >= minBalance) {
      console.log(`  → gate should pass on second observation (qualified)`);
    } else {
      console.log(`  → gate FAILS (not_qualified) — uiAmount < HOLDER_MIN_BALANCE`);
      if (typeof match.decimals === 'number' && match.decimals !== decimalsConfigured) {
        console.log(
          `\n  ⚠ ASTROID_DECIMALS=${decimalsConfigured} but Helius reports decimals=${match.decimals} ` +
            `for this mint. Set ASTROID_DECIMALS=${match.decimals} in .env.local and restart.`,
        );
      }
    }
  }
}
