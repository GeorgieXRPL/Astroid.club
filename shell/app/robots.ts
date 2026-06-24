/**
 * /robots.txt for astroid.club.
 *
 * Public surface (landing, /how-to-play) is indexable so the Club is
 * discoverable. The arena and console are interactive, holder-gated
 * surfaces with no useful content for crawlers, and they show
 * different UI per session, so we politely ask bots to skip them.
 *
 * The sign-in page is also disallowed: it is a transient surface
 * that has no content of its own and would only inflate the index.
 */
import type { MetadataRoute } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:4001';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/how-to-play'],
        disallow: ['/arena', '/console', '/sign-in', '/api/'],
      },
    ],
    sitemap: `${SITE_URL.replace(/\/$/, '')}/sitemap.xml`,
  };
}
