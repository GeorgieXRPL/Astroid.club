/**
 * Read-only: inspect the Quarry MintWrapper — hardcap, total allowance,
 * total minted — and each minter's allowance (rewarder + the admin
 * wallet). Tells us whether we can add the admin as a minter to fund the
 * redeemer treasury, or must rebalance the rewarder's allowance first.
 */
const web3 = require('@solana/web3.js');
const { QuarrySDK } = require('@quarryprotocol/quarry-sdk');
const { SolanaProvider } = require('@saberhq/solana-contrib');

const WRAPPER = process.env.QUARRY_MINT_WRAPPER;
const REWARDER = process.env.QUARRY_REWARDER_ADDRESS;
const ADMIN = '9xB6FFxu9xj5L4opqcmqsjiEvtcSAoDEqLYKzuxWAQkr';

function s(x) {
  return x && x.toString ? x.toString() : String(x);
}

(async () => {
  const conn = new web3.Connection(process.env.SOLANA_RPC_URL, 'confirmed');
  const dummy = web3.Keypair.generate();
  const provider = SolanaProvider.init({
    connection: conn,
    wallet: {
      publicKey: dummy.publicKey,
      signTransaction: async (t) => t,
      signAllTransactions: async (t) => t,
    },
  });
  const sdk = QuarrySDK.load({ provider });
  const wrapper = new web3.PublicKey(WRAPPER);

  const w = await sdk.mintWrapper.fetchMintWrapper(wrapper);
  console.log('WRAPPER=' + WRAPPER);
  console.log('HARD_CAP=' + s(w.hardCap ?? w.hardcap));
  console.log('TOTAL_ALLOWANCE=' + s(w.totalAllowance));
  console.log('TOTAL_MINTED=' + s(w.totalMinted));
  console.log('ADMIN_ONCHAIN=' + s(w.admin));
  console.log('NUM_MINTERS=' + s(w.numMinters ?? w.minterCount ?? '?'));

  const rew = await sdk.mintWrapper.fetchMinter(wrapper, new web3.PublicKey(REWARDER));
  console.log('REWARDER_MINTER_ALLOWANCE=' + (rew ? s(rew.allowance) : 'none'));
  console.log('REWARDER_MINTER_TOTAL_MINTED=' + (rew ? s(rew.totalMinted) : 'none'));

  const adm = await sdk.mintWrapper.fetchMinter(wrapper, new web3.PublicKey(ADMIN));
  console.log('ADMIN_MINTER_ALLOWANCE=' + (adm ? s(adm.allowance) : 'none (admin is not a minter yet)'));
})().catch((e) => {
  console.log('ERROR=' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
