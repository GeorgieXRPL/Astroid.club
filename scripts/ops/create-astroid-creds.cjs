/**
 * Create the "Astroid Creds" credits token and pre-mint a starting float to
 * the redeemer treasury.
 *
 * DESIGN INTENT (per operator decision — READ THIS before changing anything):
 *   Astroid Creds is a MANAGED, reserve-aware credits token, NOT a fixed
 *   pre-mint. The mint authority is deliberately RETAINED (kept on the
 *   treasury wallet) because:
 *     1. escrow-creation fees flow to the treasury and top up its $ASTROID
 *        backing, and
 *     2. supply will later be actively minted/burned against the live
 *        treasury balance — the same way USDC/USDT issuers mint on deposit
 *        and burn on redemption to keep circulating supply matched to
 *        reserves. So this token MUST stay mintable/burnable.
 *   Decimals are set to 6 to match $ASTROID so redemption is a clean 1:1.
 *
 * This script is the FIRST issuance only: it creates the mint (authority =
 * treasury) and mints the initial float. On-chain Metaplex metadata
 * (name "Astroid Creds", symbol, logo) is attached separately once a hosted
 * logo URI exists; because we keep the update authority on the treasury it
 * can be added/changed at any time.
 *
 * CUSTODY: signs with the treasury key from REDEEMER_TREASURY_PRIVATE_KEY
 * (read once, never logged). Run this ON the gateway machine (where the key
 * already lives) via the base64 pattern, or locally with the key exported.
 *
 * Guarded: DRY-RUN by default. Set EXECUTE=YES (and CONFIRM_MAINNET=YES on
 * mainnet) to actually create + mint.
 *
 * Required env:
 *   SOLANA_RPC_URL                 paid RPC (Helius/etc.)
 *   REDEEMER_TREASURY_PRIVATE_KEY  treasury key (JSON 64-byte array or base58)
 *   CREDS_MINT_AMOUNT              initial float to mint, UI units (e.g. 9500000)
 * Optional env:
 *   CREDS_DECIMALS                 default 6 (match $ASTROID)
 *   CREDS_FREEZE_AUTHORITY         "treasury" | "none" (default "none")
 *   EXECUTE=YES, CONFIRM_MAINNET=YES
 */
const web3 = require('@solana/web3.js');
const spl = require('@solana/spl-token');

const GENESIS = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'devnet',
};

function fail(msg) {
  console.error(`\n\u2717 ${msg}`);
  process.exit(1);
}

function loadTreasury() {
  const raw = process.env.REDEEMER_TREASURY_PRIVATE_KEY;
  if (!raw) fail('REDEEMER_TREASURY_PRIVATE_KEY is required.');
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p) && p.length === 64) return web3.Keypair.fromSecretKey(Uint8Array.from(p));
  } catch (e) {
    /* not JSON; try base58 */
  }
  const bs58 = require('bs58');
  const decode = bs58.decode || (bs58.default && bs58.default.decode);
  return web3.Keypair.fromSecretKey(decode(raw));
}

(async () => {
  const rpc = process.env.SOLANA_RPC_URL || fail('SOLANA_RPC_URL is required');
  const amountUi = process.env.CREDS_MINT_AMOUNT;
  if (!amountUi || !(Number(amountUi) > 0)) fail('CREDS_MINT_AMOUNT (UI units, > 0) is required');
  const decimals = Number(process.env.CREDS_DECIMALS || '6');
  const freezeMode = (process.env.CREDS_FREEZE_AUTHORITY || 'none').toLowerCase();
  const execute = process.env.EXECUTE === 'YES';

  const conn = new web3.Connection(rpc, 'confirmed');
  const treasury = loadTreasury();
  const freezeAuthority = freezeMode === 'treasury' ? treasury.publicKey : null;
  const amountRaw = BigInt(Math.round(Number(amountUi) * Math.pow(10, decimals)));

  const genesis = await conn.getGenesisHash();
  const network = GENESIS[genesis] || 'unknown';
  if (execute && network === 'mainnet' && process.env.CONFIRM_MAINNET !== 'YES') {
    fail('Refusing to EXECUTE on MAINNET without CONFIRM_MAINNET=YES.');
  }
  const sol = (await conn.getBalance(treasury.publicKey)) / web3.LAMPORTS_PER_SOL;

  console.log('\n\u2014 Create Astroid Creds + initial mint \u2014');
  console.log(`  network:           ${network}`);
  console.log(`  mint authority:    ${treasury.publicKey.toBase58()} (treasury, RETAINED)`);
  console.log(`  freeze authority:  ${freezeAuthority ? freezeAuthority.toBase58() : 'none'}`);
  console.log(`  decimals:          ${decimals}`);
  console.log(`  initial mint:      ${amountUi} creds (${amountRaw.toString()} raw)`);
  console.log(`  treasury SOL:      ${sol}`);
  console.log('  Plan:');
  console.log('    [1] create new SPL mint (authority = treasury, mint authority kept)');
  console.log('    [2] create treasury ATA for the new mint');
  console.log(`    [3] mintTo ${amountUi} creds -> treasury ATA`);

  if (!execute) {
    console.log('\nDRY-RUN. Re-run with EXECUTE=YES (and CONFIRM_MAINNET=YES on mainnet) to send.');
    return;
  }
  if (sol < 0.01) fail('Treasury SOL too low to pay rent/fees. Top up first.');

  console.log('\n[1/3] Creating mint\u2026');
  const mint = await spl.createMint(conn, treasury, treasury.publicKey, freezeAuthority, decimals);
  console.log(`      mint = ${mint.toBase58()}`);

  console.log('[2/3] Creating treasury ATA\u2026');
  const ata = await spl.getOrCreateAssociatedTokenAccount(conn, treasury, mint, treasury.publicKey);

  console.log('[3/3] Minting initial float\u2026');
  const sig = await spl.mintTo(conn, treasury, mint, ata.address, treasury.publicKey, amountRaw);

  console.log(`\n\u2713 Astroid Creds live: ${mint.toBase58()}`);
  console.log(`  minted ${amountUi} creds to treasury ATA ${ata.address.toBase58()}`);
  console.log(`  tx: ${sig}`);
  console.log('\nNext: wire the gateway to the new mint:');
  console.log(`  fly secrets set IOU_TOKEN_MINT=${mint.toBase58()} IOU_TOKEN_DECIMALS=${decimals} --app astroid-club-gw`);
})().catch((e) => {
  console.error('\n\u2717 create failed:', e && e.message ? e.message : String(e));
  process.exit(1);
});
