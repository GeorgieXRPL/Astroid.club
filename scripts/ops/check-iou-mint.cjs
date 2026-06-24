/**
 * Read-only: inspect the IOU-ASTROID mint — decimals, supply, mint &
 * freeze authority — and whether a given deployer wallet is the mint
 * authority and/or holds any IOU supply. Used to confirm who can fund the
 * redeemer treasury. NEVER touches private keys.
 */
const web3 = require('@solana/web3.js');
const spl = require('@solana/spl-token');

const DEPLOYER = process.argv[2] || '9xB6FFxu9xj5L4opqcmqsjiEvtcSAoDEqLYKzuxWAQkr';

(async () => {
  const rpc = process.env.SOLANA_RPC_URL;
  const iouMint = new web3.PublicKey(process.env.IOU_TOKEN_MINT);
  const conn = new web3.Connection(rpc, 'confirmed');

  const mint = await spl.getMint(conn, iouMint);
  const dec = mint.decimals;
  const authority = mint.mintAuthority ? mint.mintAuthority.toBase58() : null;

  console.log('IOU_MINT=' + iouMint.toBase58());
  console.log('IOU_DECIMALS=' + dec);
  console.log('IOU_SUPPLY=' + Number(mint.supply) / Math.pow(10, dec));
  console.log('IOU_MINT_AUTHORITY=' + (authority || 'null (fixed supply, cannot mint more)'));
  console.log('IOU_FREEZE_AUTHORITY=' + (mint.freezeAuthority ? mint.freezeAuthority.toBase58() : 'null'));
  console.log('DEPLOYER=' + DEPLOYER);
  console.log('DEPLOYER_IS_MINT_AUTHORITY=' + (authority === DEPLOYER));

  try {
    const ata = await spl.getAssociatedTokenAddress(iouMint, new web3.PublicKey(DEPLOYER));
    const acct = await spl.getAccount(conn, ata);
    console.log('DEPLOYER_IOU_BALANCE=' + Number(acct.amount) / Math.pow(10, dec));
  } catch {
    console.log('DEPLOYER_IOU_BALANCE=0 (no IOU token account)');
  }
})().catch((e) => {
  console.log('ERROR=' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
