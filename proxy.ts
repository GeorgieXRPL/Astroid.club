/**
 * @fileoverview Global security headers (Next.js Proxy / Edge Middleware).
 *
 * Same conservative-but-realistic header set we use on astroid.space.
 * Tighten the CSP further as we remove third-party scripts; loosen
 * `connect-src` / `script-src` if we add analytics, Turnstile, or
 * the eventual waitlist API.
 *
 * Note: Next 16 renamed the `middleware.ts` convention to `proxy.ts`.
 * Same API, same matcher config - just a different filename.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const isProd = process.env.NODE_ENV === 'production';

function csp(): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // 'unsafe-inline' on script/style is required by Next's runtime
    // bootstrap and Tailwind v4 inline styles. 'unsafe-eval' is needed
    // by React Refresh in dev only - we drop it in prod.
    'script-src': isProd
      ? ["'self'", "'unsafe-inline'"]
      : ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'connect-src': ["'self'"],
    'frame-ancestors': ["'none'"],
    'frame-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"],
    'media-src': ["'self'"],
    'manifest-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
  };
  if (isProd) directives['upgrade-insecure-requests'] = [];
  return Object.entries(directives)
    .map(([k, v]) => (v.length ? `${k} ${v.join(' ')}` : k))
    .join('; ');
}

export function proxy(_req: NextRequest) {
  const res = NextResponse.next();

  // HSTS - only emit in production; localhost over http would otherwise
  // refuse to load. The `preload` directive lets us submit to the
  // browser HSTS preload list once the header has been steady for a while.
  if (isProd) {
    res.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload'
    );
  }

  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()'
  );
  res.headers.set('X-DNS-Prefetch-Control', 'off');
  res.headers.set('Content-Security-Policy', csp());

  // Cross-origin isolation - same-origin defaults make it impossible
  // for another origin to read our pages or pop us via window.opener.
  res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');

  return res;
}

/**
 * Apply to everything except next.js internals and static assets.
 * The static-asset exclusion keeps the CSP off /_next/* (which would
 * otherwise block Next's own bundles in some browsers).
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$).*)',
  ],
};
