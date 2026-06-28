/**
 * Upload the Astroid Creds logo + metadata JSON to Arweave L1 via ArDrive
 * Turbo, then print direct `https://arweave.net/<txid>` URLs.
 *
 * Why Turbo (not the Irys free lane): Turbo posts to Arweave L1, so the data
 * resolves DIRECTLY at https://arweave.net/<txid> (200 + image/jpeg, no
 * redirect) — the gateway wallets actually render. Irys's free lane only
 * served via a redirecting gateway, which wallet image proxies won't follow.
 *
 * Free + keyless: uploads < 100 KiB are free on Turbo, so this generates a
 * throwaway Arweave JWK and needs no funding and no treasury key. The mint /
 * treasury are never touched here — the on-chain URI flip is a separate,
 * treasury-signed step (scripts/ops/update-astrocred-uri.cjs).
 *
 * Run LOCALLY (full toolchain). One-off deps, not added to package.json:
 *   npm install --no-save @ardrive/turbo-sdk arweave
 *   node scripts/ops/upload-arweave-turbo.cjs
 *
 * Optional env:
 *   IMAGE_PATH (default /tmp/astrocred-arweave.jpg)
 *   OUT_DIR    (default /tmp)
 */
const fs = require('fs');
const path = require('path');

const { TurboFactory, ArweaveSigner } = require('@ardrive/turbo-sdk');
const Arweave = require('arweave');

const FREE_TIER_BYTES = 100 * 1024;
const GATEWAY = 'https://arweave.net';

async function uploadBytes(turbo, filePath, contentType) {
  const size = fs.statSync(filePath).size;
  const res = await turbo.uploadFile({
    fileStreamFactory: () => fs.createReadStream(filePath),
    fileSizeFactory: () => size,
    dataItemOpts: { tags: [{ name: 'Content-Type', value: contentType }] },
  });
  return res.id;
}

(async () => {
  const imagePath = process.env.IMAGE_PATH || '/tmp/astrocred-arweave.jpg';
  const outDir = process.env.OUT_DIR || '/tmp';
  if (!fs.existsSync(imagePath)) throw new Error(`image not found: ${imagePath}`);
  const bytes = fs.statSync(imagePath).size;
  if (bytes >= FREE_TIER_BYTES) {
    throw new Error(`image is ${(bytes / 1024).toFixed(1)} KiB; keep it < 100 KiB for a free upload.`);
  }

  // Throwaway Arweave key — free-tier (<100 KiB) uploads need no balance.
  const arweave = Arweave.init({});
  const jwk = await arweave.wallets.generate();
  const turbo = TurboFactory.authenticated({ signer: new ArweaveSigner(jwk) });

  // 1) Image → Arweave L1.
  const imageId = await uploadBytes(turbo, imagePath, 'image/jpeg');
  const imageUrl = `${GATEWAY}/${imageId}`;
  console.log(`IMAGE ${imageUrl}`);

  // 2) Metadata JSON (referencing the Arweave image) → Arweave L1.
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
  const jsonPath = path.join(outDir, 'astrocred-arweave.meta.json');
  fs.writeFileSync(jsonPath, JSON.stringify(meta));
  const jsonId = await uploadBytes(turbo, jsonPath, 'application/json');
  const jsonUrl = `${GATEWAY}/${jsonId}`;
  console.log(`JSON ${jsonUrl}`);

  fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'astrocred-arweave-urls.json'),
    JSON.stringify({ imageUrl, jsonUrl, imageId, jsonId }, null, 2),
  );
  console.log(`\nWrote URLs to ${path.join(outDir, 'astrocred-arweave-urls.json')}`);
})().catch((e) => {
  console.error('\n\u2717 turbo upload failed:', e && e.message ? e.message : String(e));
  process.exit(1);
});
