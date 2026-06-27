/**
 * Upload the Astroid Creds logo + token metadata JSON to Arweave via Irys,
 * then print the permanent gateway URLs.
 *
 * Why this is safe / needs no secrets:
 *   - Files < 100 KiB upload FREE on Irys, so this uses a THROWAWAY in-memory
 *     signer and needs no SOL and no treasury key. (Keep the image < 100 KiB;
 *     the repo logo is pre-optimized to ~83 KiB at 1024px.)
 *   - The mint / treasury are never touched here. The ONLY treasury-signed
 *     step is pointing the on-chain metadata URI at the Arweave JSON, done
 *     separately by `scripts/ops/update-astrocred-uri.cjs` (run on the
 *     gateway machine where the key lives).
 *
 * Run LOCALLY (full toolchain). One-off deps, not added to package.json:
 *   npm install --no-save @irys/upload @irys/upload-solana
 *   node scripts/ops/upload-arweave.cjs
 *
 * Optional env:
 *   IMAGE_PATH   path to the logo to upload (default /tmp/astrocred-arweave.jpg)
 *   OUT_DIR      where to write the captured URLs + uploaded JSON (default /tmp)
 *
 * Outputs (stdout + OUT_DIR):
 *   IMAGE <url>  — permanent image URL
 *   JSON  <url>  — permanent metadata URL (use this as the on-chain URI)
 */
const fs = require('fs');
const path = require('path');

const web3 = require('@solana/web3.js');
const bs58 = require('bs58');
const { Uploader } = require('@irys/upload');
const { Solana } = require('@irys/upload-solana');

const FREE_TIER_BYTES = 100 * 1024;

function bs58encode(bytes) {
  return (bs58.encode || (bs58.default && bs58.default.encode))(bytes);
}

(async () => {
  const imagePath = process.env.IMAGE_PATH || '/tmp/astrocred-arweave.jpg';
  const outDir = process.env.OUT_DIR || '/tmp';
  if (!fs.existsSync(imagePath)) throw new Error(`image not found: ${imagePath}`);
  const bytes = fs.statSync(imagePath).size;
  if (bytes >= FREE_TIER_BYTES) {
    throw new Error(
      `image is ${(bytes / 1024).toFixed(1)} KiB; must be < 100 KiB for a free upload. ` +
        `Re-encode smaller or fund the Irys node.`,
    );
  }

  // Throwaway signer — free-tier (<100 KiB) uploads require no balance.
  const signer = bs58encode(web3.Keypair.generate().secretKey);
  const irys = await Uploader(Solana).withWallet(signer);

  // 1) Image → Arweave.
  const img = await irys.uploadFile(imagePath, {
    tags: [{ name: 'Content-Type', value: 'image/jpeg' }],
  });
  const imageUrl = `https://gateway.irys.xyz/${img.id}`;
  console.log(`IMAGE ${imageUrl}`);

  // 2) Metadata JSON (referencing the Arweave image) → Arweave.
  const meta = {
    name: 'Astroid Creds',
    symbol: 'ASTROCRED',
    description:
      'In-game credits for astroid.club, the $ASTROID mining game. Earned through ' +
      'play and redeemable for $ASTROID from the treasury.',
    image: imageUrl,
    external_url: 'https://astroid.club',
    properties: {
      files: [{ uri: imageUrl, type: 'image/jpeg' }],
      category: 'image',
    },
  };
  const metaJson = JSON.stringify(meta);
  const json = await irys.upload(metaJson, {
    tags: [{ name: 'Content-Type', value: 'application/json' }],
  });
  const jsonUrl = `https://gateway.irys.xyz/${json.id}`;
  console.log(`JSON ${jsonUrl}`);

  // Persist for the repo mirror + the on-chain update step.
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'astrocred-arweave.meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'astrocred-arweave-urls.json'),
    JSON.stringify({ imageUrl, jsonUrl }, null, 2),
  );
  console.log(`\nWrote URLs to ${path.join(outDir, 'astrocred-arweave-urls.json')}`);
})().catch((e) => {
  console.error('\n\u2717 upload failed:', e && e.message ? e.message : String(e));
  process.exit(1);
});
