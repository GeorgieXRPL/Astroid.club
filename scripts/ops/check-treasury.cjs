/**
 * Read-only redeemer-treasury funding check. Runs inside the gateway
 * machine (where the secrets live), derives the treasury PUBLIC address
 * from REDEEMER_TREASURY_PRIVATE_KEY, and reports its IOU-ASTROID,
 * $ASTROID, and SOL balances. NEVER prints the private key.
 */
const web3 = require('@solana/web3.js');
const spl = require('@solana/spl-token');

function loadTreasury() {
  const raw = process.env.REDEEMER_TREASURY_PRIVATE_KEY;
  if (!raw) throw new Error('REDEEMER_TREASURY_PRIVATE_KEY not set');
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 64) {
      return web3.Keypair.fromSecretKey(Uint8Array.from(parsed));
    }
  } catch {
    /* not JSON; try base58 */
  }
  const bs58 = require('bs58');
  const decode = bs58.decode || (bs58.default && bs58.default.decode);
  return web3.Keypair.fromSecretKey(decode(raw));
}

async function tokenBalance(connection, mint, owner, decimals) {
  try {
    const ata = await spl.getAssociatedTokenAddress(mint, owner);
    const acct = await spl.getAccount(connection, ata);
    return Number(acct.amount) / Math.pow(10, decimals);
  } catch {
    return 0; // no ATA / not funded
  }
}

(async () => {
  const rpc = process.env.SOLANA_RPC_URL;
  const iouMint = new web3.PublicKey(process.env.IOU_TOKEN_MINT);
  const astroidMint = new web3.PublicKey(process.env.ASTROID_MINT_ADDRESS);
  const iouDec = Number(process.env.IOU_TOKEN_DECIMALS || '9');
  const astroidDec = Number(process.env.ASTROID_DECIMALS || '6');
  const rate = Number(process.env.REDEEM_RATE || '1');

  const treasury = loadTreasury();
  const conn = new web3.Connection(rpc, 'confirmed');

  const [iou, astroid, lamports] = await Promise.all([
    tokenBalance(conn, iouMint, treasury.publicKey, iouDec),
    tokenBalance(conn, astroidMint, treasury.publicKey, astroidDec),
    conn.getBalance(treasury.publicKey),
  ]);
  const sol = lamports / web3.LAMPORTS_PER_SOL;

  console.log('TREASURY_ADDRESS=' + treasury.publicKey.toBase58());
  console.log('IOU_MINT=' + iouMint.toBase58());
  console.log('ASTROID_MINT=' + astroidMint.toBase58());
  console.log('REDEEM_RATE=' + rate);
  console.log('IOU_ASTROID_BALANCE=' + iou);
  console.log('ASTROID_BALANCE=' + astroid);
  console.log('SOL_BALANCE=' + sol);
  console.log(
    'VERDICT=' +
      (iou > 0 && astroid > 0 && sol > 0.01
        ? 'READY (bridge + swap can both pay out)'
        : 'NOT_READY' +
          (iou <= 0 ? ' [no IOU-ASTROID to bridge]' : '') +
          (astroid <= 0 ? ' [no $ASTROID to swap]' : '') +
          (sol <= 0.01 ? ' [low SOL for fees/rent]' : '')),
  );
})().catch((e) => {
  console.log('ERROR=' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
