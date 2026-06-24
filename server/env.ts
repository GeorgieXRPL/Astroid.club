/**
 * Env-file preload.
 *
 * Loaded as the very first import in `server/index.ts` so any
 * downstream module that reads `process.env` (notably `config/runtime.ts`
 * and the chain layer) sees values from `.env.local` (preferred) or
 * `.env` (fallback). Both files are optional — when neither is
 * present the process inherits whatever was already in `process.env`,
 * which covers containers, CI, and `$env:CHAIN_ENABLED=true` style
 * shell-set values.
 *
 * `.env.local` is the developer-local override and is gitignored;
 * `.env` is committed but should only carry non-secret defaults (we
 * currently don't ship one — `.env.example` documents the shape).
 *
 * This file MUST stay free of business logic. Adding code that reads
 * `process.env` here would defeat the load-order contract: `runtime.ts`
 * is the single source of truth for env parsing.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config as dotenvConfig } from 'dotenv';

const cwd = process.cwd();
const localPath = resolve(cwd, '.env.local');
const defaultPath = resolve(cwd, '.env');

if (existsSync(localPath)) {
  dotenvConfig({ path: localPath });
  console.info(`[env] loaded ${localPath}`);
} else if (existsSync(defaultPath)) {
  dotenvConfig({ path: defaultPath });
  console.info(`[env] loaded ${defaultPath}`);
} else {
  console.info('[env] no .env / .env.local found; using process.env as-is');
}
