/**
 * Public landing page for a shared card (roadmap §3.4, Phase 2).
 *
 * Reads the card params from the query string and (a) sets Open Graph / Twitter
 * metadata pointing at the `/share/og` image so the link unfurls with the card
 * preview, and (b) renders the same image plus a CTA into the arena.
 */

import type { Metadata } from 'next';
import Link from 'next/link';

import { decodeShareParams } from '@/lib/share-card';

type SearchParams = Record<string, string | string[] | undefined>;

function toParams(sp: SearchParams): URLSearchParams {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') usp.set(k, v);
  }
  return usp;
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const usp = toParams(await searchParams);
  const spec = decodeShareParams(usp);
  const query = usp.toString();
  const ogUrl = `/share/og?${query}`;
  const title = spec.headline;
  const description = spec.accent
    ? `${spec.accent.value} ${spec.accent.label} · astroid.club`
    : 'Mine. Raid. Defend. astroid.club';

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `/share?${query}`,
      images: [{ url: ogUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogUrl],
    },
  };
}

export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const usp = toParams(await searchParams);
  const spec = decodeShareParams(usp);
  const ogUrl = `/share/og?${usp.toString()}`;

  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center px-6 py-16 text-center">
      <p className="eyebrow mb-6">{spec.eyebrow}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt={spec.headline}
        className="w-full max-w-2xl rounded-xl border border-white/10 shadow-[0_12px_60px_-16px_rgba(0,212,255,0.45)]"
        src={ogUrl}
      />
      <p className="mt-8 max-w-xl text-base leading-relaxed text-white/70">
        Stake $ASTROID, mine the belt, raid rivals and defend your home station. The arena is live
        in playtest.
      </p>
      <Link className="btn-primary mt-6" href="/arena">
        Enter the arena
      </Link>
    </div>
  );
}
