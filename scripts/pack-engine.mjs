#!/usr/bin/env node
/**
 * Rebuilds and re-packs `game-engine-enhanced` from a sibling checkout, then
 * drops the resulting tarball into `vendor/` of this repo.
 *
 * Why a vendored tarball at all:
 *   - The gateway depends on the engine via `file:./vendor/...` so the
 *     `Astroid-miner` repo is self-contained and Docker / Fly / Vercel can
 *     build without needing a parallel checkout.
 *   - The engine is a private repo at HeartOfMidgar/Enhanced-Game-Engine; we
 *     want to ship updates without going through a public-npm publish step.
 *
 * Usage:
 *   npm run engine:pack                # default path: ../game-engine-enhanced
 *   ENGINE_SRC=../my-engine npm run engine:pack
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ENGINE_SRC = resolve(process.env.ENGINE_SRC ?? '../game-engine-enhanced');
const VENDOR_DIR = resolve('./vendor');
const FINAL_TARBALL = join(VENDOR_DIR, 'game-engine-enhanced.tgz');

if (!existsSync(ENGINE_SRC)) {
  console.error(
    `[engine:pack] could not find engine source at ${ENGINE_SRC}.\n` +
      `  Set ENGINE_SRC env var if your checkout lives elsewhere.`,
  );
  process.exit(1);
}

console.info(`[engine:pack] using engine source: ${ENGINE_SRC}`);

const run = (cmd, cwd) => {
  console.info(`> ${cmd}  (cwd=${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

run('npm install --no-audit --no-fund', ENGINE_SRC);
run('npm run build:lib', ENGINE_SRC);
run(`npm pack --pack-destination ${VENDOR_DIR}`, ENGINE_SRC);

const produced = readdirSync(VENDOR_DIR).filter(
  (f) => f.startsWith('game-engine-enhanced-') && f.endsWith('.tgz'),
);
if (produced.length === 0) {
  console.error('[engine:pack] npm pack did not produce a tarball.');
  process.exit(1);
}
const newest = produced
  .map((f) => ({ f, mtime: Date.now() }))
  .sort((a, b) => b.mtime - a.mtime)[0].f;

if (existsSync(FINAL_TARBALL)) rmSync(FINAL_TARBALL);
renameSync(join(VENDOR_DIR, newest), FINAL_TARBALL);

for (const f of produced) {
  if (f !== newest) rmSync(join(VENDOR_DIR, f));
}

console.info(`[engine:pack] wrote ${FINAL_TARBALL}`);
console.info('[engine:pack] run "npm install" to refresh the local install.');
