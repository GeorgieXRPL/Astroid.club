/**
 * Admin HTTP surface, mounted on the gateway's existing HTTP server.
 *
 *   GET    /admin                  → the dashboard shell (no secret in the page)
 *   GET    /admin/api/snapshot      → live JSON state (Bearer-token protected)
 *   GET    /admin/api/comp-wallets  → list comped (holder-gate-bypass) wallets
 *   POST   /admin/api/comp-wallets  → add a comped wallet ({ wallet, note? })
 *   DELETE /admin/api/comp-wallets  → remove a comped wallet ({ wallet })
 *
 * Auth: a single shared secret (`ADMIN_SECRET`, via `runtime.adminSecret`)
 * compared in constant time. The dashboard sends it as
 * `Authorization: Bearer <secret>`. When `ADMIN_SECRET` is unset the whole
 * surface returns 503 (disabled) — the console only exists when the
 * operator opts in. The snapshot is read-only; the only mutations exposed are
 * comp-wallet add/remove (operator access control, not game state).
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { runtime } from '../config/runtime.js';
import { isValidWalletAddress } from '../verification/comp-wallets.js';

import { ADMIN_HTML } from './admin-page.js';
import { type AdminSnapshotDeps, buildAdminSnapshot } from './admin-snapshot.js';

/** Max accepted admin request body. Comp-wallet payloads are tiny. */
const MAX_BODY_BYTES = 4 * 1024;

/** Read and JSON-parse a small request body. Rejects oversized/invalid input. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (total === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Constant-time token check. False on any length/secret mismatch. */
function tokenValid(provided: string | undefined, secret: string | undefined): boolean {
  if (!provided || !secret) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  // Header-only: no `?token=` query fallback. Query strings leak into access
  // logs, reverse proxies, browser history, and Referer headers — the
  // dashboard always sends the secret as an `Authorization: Bearer`.
  return undefined;
}

/**
 * Best-effort real client IP for per-IP auth lockout. Prefers Fly's edge-set
 * `Fly-Client-IP` (clients can't spoof it past the proxy), then the first
 * `X-Forwarded-For` hop, then the raw socket address. Bucketing by client IP
 * keeps one abuser from locking the operator out via the shared proxy IP.
 */
function clientIp(req: IncomingMessage): string {
  const fly = req.headers['fly-client-ip'];
  if (typeof fly === 'string' && fly.length > 0) return fly;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Admin auth brute-force backoff. After {@link ADMIN_MAX_FAILS} failed token
 * checks from one client IP, that IP is locked out for an escalating window
 * (doubling from {@link ADMIN_LOCK_BASE_MS}, capped at {@link ADMIN_LOCK_MAX_MS}).
 * A correct token clears the IP's state immediately. State is in-memory and
 * size-capped — pure defense-in-depth atop a high-entropy secret.
 */
const ADMIN_MAX_FAILS = 5;
const ADMIN_LOCK_BASE_MS = 30_000;
const ADMIN_LOCK_MAX_MS = 15 * 60 * 1000;
const ADMIN_STATE_TTL_MS = 30 * 60 * 1000;
const ADMIN_STATE_MAX = 10_000;

interface AdminAuthState {
  /** Consecutive failures since the last lock/success. */
  fails: number;
  /** Epoch ms until which this IP is locked out (0 = not locked). */
  lockedUntil: number;
  /** How many times this IP has been locked (drives escalating duration). */
  lockTier: number;
  /** Last-touched epoch ms (for idle pruning). */
  seen: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  res.end(JSON.stringify(body));
}

/**
 * Build the `/admin` request handler. Returns a function that handles the
 * request and returns `true` (so the caller can stop), or `false` when
 * the path isn't an admin path (caller continues its own routing).
 */
export function createAdminHandler(
  deps: AdminSnapshotDeps,
): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  // Per-IP auth-failure state for brute-force backoff. Bounded + idle-pruned.
  const authState = new Map<string, AdminAuthState>();

  const pruneAuthState = (now: number): void => {
    if (authState.size < ADMIN_STATE_MAX) return;
    for (const [ip, s] of authState) {
      if (s.lockedUntil < now && now - s.seen > ADMIN_STATE_TTL_MS) authState.delete(ip);
    }
  };

  return (req, res, url) => {
    if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false;

    if (!runtime.adminSecret) {
      json(res, 503, { error: 'admin_disabled', message: 'Set ADMIN_SECRET to enable the admin console.' });
      return true;
    }

    // Dashboard shell — no token needed (it carries no data; the API does).
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      });
      res.end(ADMIN_HTML);
      return true;
    }

    // Everything under /admin/api/* requires the token.
    if (url.pathname.startsWith('/admin/api/')) {
      const ip = clientIp(req);
      const now = Date.now();
      const st = authState.get(ip);

      // Locked out → 429 with Retry-After; don't even compare the token.
      if (st && st.lockedUntil > now) {
        const retryMs = st.lockedUntil - now;
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Retry-After': String(Math.ceil(retryMs / 1000)),
        });
        res.end(JSON.stringify({ error: 'too_many_attempts', retryAfterMs: retryMs }));
        return true;
      }

      if (!tokenValid(extractToken(req), runtime.adminSecret)) {
        const tier = st?.lockTier ?? 0;
        const fails = (st?.fails ?? 0) + 1;
        let lockedUntil = 0;
        let lockTier = tier;
        if (fails >= ADMIN_MAX_FAILS) {
          lockedUntil = now + Math.min(ADMIN_LOCK_MAX_MS, ADMIN_LOCK_BASE_MS * 2 ** tier);
          lockTier = tier + 1;
        }
        // After a lock trips, reset the counter so the next window starts fresh
        // (but keep the higher tier so repeat offenders are locked longer).
        authState.set(ip, { fails: lockedUntil ? 0 : fails, lockedUntil, lockTier, seen: now });
        pruneAuthState(now);
        console.warn(
          `[admin] unauthorized ${url.pathname} from ${ip} (fail ${fails}` +
            `${lockedUntil ? `, locked ${Math.ceil((lockedUntil - now) / 1000)}s` : ''})`,
        );
        json(res, 401, { error: 'unauthorized' });
        return true;
      }

      // Correct token → clear any failure/lock state for this IP.
      if (st) authState.delete(ip);

      if (url.pathname === '/admin/api/snapshot') {
        const sinceEventId = Number(url.searchParams.get('sinceEventId') ?? '0') || 0;
        try {
          const snapshot = buildAdminSnapshot(deps, { sinceEventId });
          json(res, 200, snapshot);
        } catch (err) {
          json(res, 500, { error: 'snapshot_failed', message: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }

      // Comp / holder-gate-bypass list management. GET lists; POST adds; DELETE
      // removes. Mutations persist + update the live in-memory set (no redeploy).
      if (url.pathname === '/admin/api/comp-wallets') {
        const svc = deps.compWallets;
        if (!svc) {
          json(res, 503, {
            error: 'comp_wallets_disabled',
            message: 'Comp-wallet management is not wired in this deployment.',
          });
          return true;
        }
        const method = (req.method ?? 'GET').toUpperCase();
        if (method === 'GET') {
          json(res, 200, { wallets: svc.list() });
          return true;
        }
        if (method === 'POST' || method === 'DELETE') {
          void (async () => {
            try {
              const body = await readJsonBody(req);
              const wallet = body.wallet;
              if (!isValidWalletAddress(wallet)) {
                json(res, 400, { error: 'invalid_wallet', message: 'Provide a valid base58 wallet address.' });
                return;
              }
              if (method === 'POST') {
                const note = typeof body.note === 'string' ? body.note.slice(0, 200) : undefined;
                await svc.add(wallet, note);
                console.info(`[admin] comp wallet added: ${wallet.slice(0, 8)}…`);
                json(res, 200, { ok: true, wallet, wallets: svc.list() });
              } else {
                const removed = await svc.remove(wallet);
                console.info(`[admin] comp wallet removed: ${wallet.slice(0, 8)}… (present=${removed})`);
                json(res, 200, { ok: true, wallet, removed, wallets: svc.list() });
              }
            } catch (err) {
              json(res, 500, {
                error: 'comp_wallet_failed',
                message: err instanceof Error ? err.message : String(err),
              });
            }
          })();
          return true;
        }
        json(res, 405, { error: 'method_not_allowed' });
        return true;
      }

      json(res, 404, { error: 'not_found' });
      return true;
    }

    json(res, 404, { error: 'not_found' });
    return true;
  };
}
