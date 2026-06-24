/**
 * /sitemap.xml for astroid.club.
 *
 * Lists only public, indexable surfaces. The arena, console, and
 * sign-in routes are deliberately excluded because they require
 * authentication (and therefore have no stable content for a
 * crawler) and are listed under `Disallow` in /robots.txt.
 *
 * `lastModified` is computed at build time, which is good enough
 * for marketing pages that change with deploys.
 */
import type { MetadataRoute } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:4001';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = SITE_URL.replace(/\/$/, '');
  const lastModified = new Date();

  return [
    {
      url: `${base}/`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: `${base}/how-to-play`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.8,
    },
  ];
}
