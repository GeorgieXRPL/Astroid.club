/**
 * Admin HTTP surface, mounted on the gateway's existing HTTP server.
 *
 *   GET /admin            → the dashboard shell (no secret in the page)
 *   GET /admin/api/snapshot → live JSON state (Bearer-token protected)
 *
 * Auth: a single shared secret (`ADMIN_SECRET`, via `runtime.adminSecret`)
 * compared in constant time. The dashboard sends it as
 * `Authorization: Bearer <secret>`. When `ADMIN_SECRET` is unset the whole
 * surface returns 503 (disabled) — the console only exists when the
 * operator opts in. Read-only: no endpoint mutates game state.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { runtime } from '../config/runtime.js';

import { ADMIN_HTML } from './admin-page.js';
import { type AdminSnapshotDeps, buildAdminSnapshot } from './admin-snapshot.js';

/** Constant-time token check. False on any length/secret mismatch. */
function tokenValid(provided: string | undefined, secret: string | undefined): boolean {
  if (!provided || !secret) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractToken(req: IncomingMessage, url: URL): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return url.searchParams.get('token') ?? undefined;
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
  let failedAttempts = 0;

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
      if (!tokenValid(extractToken(req, url), runtime.adminSecret)) {
        failedAttempts += 1;
        console.warn(
          `[admin] unauthorized ${url.pathname} from ${req.socket.remoteAddress ?? 'unknown'} ` +
            `(attempt #${failedAttempts})`,
        );
        json(res, 401, { error: 'unauthorized' });
        return true;
      }

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

      json(res, 404, { error: 'not_found' });
      return true;
    }

    json(res, 404, { error: 'not_found' });
    return true;
  };
}
