/**
 * Attach Metaplex Token Metadata (name / symbol / logo URI) to the Astroid
 * Creds mint, so wallets show the name + logo instead of an unnamed token.
 *
 * Dependency-free: hand-rolls the Token Metadata `CreateMetadataAccountV3`
 * instruction with @solana/web3.js only, so it runs on the gateway machine
 * (where the treasury key lives and only the core SDK is installed).
 *
 * The metadata is created MUTABLE with the treasury as update authority, so
 * the name/logo/URI can be changed later (consistent with the managed-token
 * model — mint authority is also retained on the treasury).
 *
 * CUSTODY: signs with REDEEMER_TREASURY_PRIVATE_KEY (mint authority = payer =
 * update authority). Read once, never logged.
 *
 * Guarded: DRY-RUN by default. EXECUTE=YES (+ CONFIRM_MAINNET=YES on mainnet).
 *
 * Required env:
 *   SOLANA_RPC_URL, REDEEMER_TREASURY_PRIVATE_KEY
 * Optional env:
 *   CREDS_MINT     (default: the Astroid Creds mint; falls back to IOU_TOKEN_MINT)
 *   META_NAME      (default "Astroid Creds")    <= 32 chars
 *   META_SYMBOL    (default "ASTROCRED")         <= 10 chars
 *   META_URI       (default https://astroid.club/astrocred.json)  <= 200 chars
 *   EXECUTE=YES, CONFIRM_MAINNET=YES
 */
const web3 = require('@solana/web3.js');

const TOKEN_METADATA_PROGRAM_ID = new web3.PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);
const DEFAULT_CREDS_MINT = '2ST8s4GziyyXdz5myDeMvLbrfWiBYBETrmNhqHc4kfCM';

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
    /* base58 */
  }
  const bs58 = require('bs58');
  const decode = bs58.decode || (bs58.default && bs58.default.decode);
  return web3.Keypair.fromSecretKey(decode(raw));
}

function borshString(s) {
  const buf = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

// CreateMetadataAccountV3 (instruction discriminator 33) with DataV2 + no
// creators/collection/uses, isMutable=true, no collectionDetails.
function createV3Data(name, symbol, uri) {
  const sellerFee = Buffer.alloc(2); // u16 LE = 0
  return Buffer.concat([
    Buffer.from([33]),
    borshString(name),
    borshString(symbol),
    borshString(uri),
    sellerFee,
    Buffer.from([0]), // creators: None
    Buffer.from([0]), // collection: None
    Buffer.from([0]), // uses: None
    Buffer.from([1]), // isMutable: true
    Buffer.from([0]), // collectionDetails: None
  ]);
}

(async () => {
  const rpc = process.env.SOLANA_RPC_URL || fail('SOLANA_RPC_URL is required');
  const mint = new web3.PublicKey(
    process.env.CREDS_MINT || process.env.IOU_TOKEN_MINT || DEFAULT_CREDS_MINT,
  );
  const name = process.env.META_NAME || 'Astroid Creds';
  const symbol = process.env.META_SYMBOL || 'ASTROCRED';
  const uri = process.env.META_URI || 'https://astroid.club/astrocred.json';
  const execute = process.env.EXECUTE === 'YES';

  if (name.length > 32) fail(`META_NAME too long (${name.length} > 32).`);
  if (symbol.length > 10) fail(`META_SYMBOL too long (${symbol.length} > 10).`);
  if (uri.length > 200) fail(`META_URI too long (${uri.length} > 200).`);

  const conn = new web3.Connection(rpc, 'confirmed');
  const treasury = loadTreasury();

  const [metadataPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  );

  const genesis = await conn.getGenesisHash();
  const network = GENESIS[genesis] || 'unknown';
  if (execute && network === 'mainnet' && process.env.CONFIRM_MAINNET !== 'YES') {
    fail('Refusing to EXECUTE on MAINNET without CONFIRM_MAINNET=YES.');
  }

  const existing = await conn.getAccountInfo(metadataPda);
  console.log('\n\u2014 Attach Astroid Creds metadata \u2014');
  console.log(`  network:        ${network}`);
  console.log(`  mint:           ${mint.toBase58()}`);
  console.log(`  metadata PDA:   ${metadataPda.toBase58()}`);
  console.log(`  update auth:    ${treasury.publicKey.toBase58()} (treasury)`);
  console.log(`  name / symbol:  "${name}" / "${symbol}"`);
  console.log(`  uri:            ${uri}`);
  if (existing) fail('Metadata account already exists for this mint. Use an update script instead.');

  if (!execute) {
    console.log('\nDRY-RUN. Re-run with EXECUTE=YES (and CONFIRM_MAINNET=YES on mainnet) to send.');
    return;
  }

  const keys = [
    { pubkey: metadataPda, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: treasury.publicKey, isSigner: true, isWritable: false }, // mint authority
    { pubkey: treasury.publicKey, isSigner: true, isWritable: true }, // payer
    { pubkey: treasury.publicKey, isSigner: false, isWritable: false }, // update authority
    { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];
  const ix = new web3.TransactionInstruction({
    keys,
    programId: TOKEN_METADATA_PROGRAM_ID,
    data: createV3Data(name, symbol, uri),
  });
  const tx = new web3.Transaction().add(ix);
  const sig = await web3.sendAndConfirmTransaction(conn, tx, [treasury], {
    commitment: 'confirmed',
    maxRetries: 3,
  });
  console.log(`\n\u2713 Metadata attached. tx: ${sig}`);
})().catch((e) => {
  console.error('\n\u2717 metadata failed:', e && e.message ? e.message : String(e));
  process.exit(1);
});
