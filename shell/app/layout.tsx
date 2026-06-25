import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { HideOnArena } from '@/components/chrome-visibility';
import { SiteNav } from '@/components/site-nav';
import { RootWalletProviders } from '@/lib/wallet-source-providers';

import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

/**
 * `metadataBase` is the absolute origin used to resolve relative URLs
 * inside Open Graph / Twitter metadata (the OG image, the canonical
 * URL, etc.). Defaults to localhost for dev so social preview tools
 * can fetch images during local testing; production deploys should
 * override this via the `NEXT_PUBLIC_SITE_URL` env var.
 */
const siteUrl = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:4001');

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: 'astroid.club | for holders of $ASTROID',
    template: '%s | astroid.club',
  },
  description:
    'A members-only space for holders of $ASTROID. Mining arena, in-world events, cosmetic drops, community lounge. Holders only.',
  applicationName: 'Astroid Club',
  authors: [{ name: 'Saltaire Protocol', url: 'https://github.com/HeartOfMidgar' }],
  keywords: [
    'Astroid',
    'Astroid Club',
    'Solana',
    'mining',
    'asteroid mining',
    'holders',
    'Saltaire Protocol',
  ],
  openGraph: {
    type: 'website',
    siteName: 'astroid.club',
    title: 'astroid.club | for holders of $ASTROID',
    description:
      'A members-only space for holders of $ASTROID. Mining arena, in-world events, cosmetic drops, community lounge. Holders only.',
    locale: 'en_US',
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'astroid.club | for holders of $ASTROID',
    description:
      'A members-only space for holders of $ASTROID. Mining arena, in-world events, cosmetic drops, community lounge. Holders only.',
    creator: '@GGSaltaire',
  },
  robots: {
    index: true,
    follow: true,
  },
  // Icons are auto-discovered by Next.js from app/icon.svg,
  // app/apple-icon.tsx, app/opengraph-image.tsx — no explicit
  // `icons` field needed.
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="flex min-h-screen flex-col antialiased">
        <RootWalletProviders>
          <LayoutChrome>{children}</LayoutChrome>
        </RootWalletProviders>
      </body>
    </html>
  );
}

function LayoutChrome({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="relative z-10 flex items-center justify-between gap-4 px-6 pt-6 sm:px-8 sm:pt-8">
        <Link aria-label="astroid.club home" className="group flex items-center gap-2.5" href="/">
          <Logo />
          <span className="font-display text-base tracking-tight text-white sm:text-lg">
            astroid<span className="text-cosmos">.</span>club
          </span>
          <span aria-label="Beta" className="beta-pill ml-1">
            Beta
          </span>
        </Link>
        <SiteNav />
      </header>

      <main className="relative z-10 flex-1">{children}</main>

      <HideOnArena>
        <footer className="relative z-10 border-t border-white/5 bg-black/40 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-6 py-8 sm:px-8">
          <div className="grid gap-6 md:grid-cols-3">
            <div>
              <div className="mb-3 flex items-center gap-2.5">
                <Logo />
                <span className="font-display text-sm tracking-tight text-white">
                  astroid<span className="text-cosmos">.</span>club
                </span>
              </div>
              <p className="telemetry-label mb-2">Part of the Astroid family</p>
              <a
                className="text-sm text-white/65 transition-colors hover:text-cosmos"
                href="https://astroid.space"
                rel="noreferrer"
                target="_blank"
              >
                astroid.space →
              </a>
            </div>
            <div>
              <div className="telemetry-label mb-3">Build</div>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link
                    className="text-white/65 transition-colors hover:text-cosmos"
                    href="/how-to-play"
                  >
                    How to play
                  </Link>
                </li>
                <li>
                  <Link className="text-white/65 transition-colors hover:text-cosmos" href="/legal">
                    Legal
                  </Link>
                </li>
                <li>
                  <Link
                    className="text-white/65 transition-colors hover:text-cosmos"
                    href="/status"
                  >
                    Status
                  </Link>
                </li>
                <li>
                  <a
                    className="inline-flex items-center gap-2 text-white/65 transition-colors hover:text-cosmos"
                    href="https://x.com/GGSaltaire"
                    rel="noreferrer"
                    target="_blank"
                  >
                    <XIcon />
                    <span>X / @GGSaltaire</span>
                  </a>
                </li>
                <li>
                  <a
                    className="text-white/65 transition-colors hover:text-cosmos"
                    href="https://github.com/HeartOfMidgar/astroid-public"
                    rel="noreferrer"
                    target="_blank"
                  >
                    Source on GitHub
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <div className="telemetry-label mb-3">Important</div>
              <p className="text-[11px] leading-relaxed text-white/40">
                Astroid Club is a community surface for the $ASTROID token community. Nothing here
                is an offer or recommendation; nothing here is investment, financial, legal, or tax
                advice. The Club is in development. Anything we tease is intent, not a promise.{' '}
                <Link
                  className="text-white/55 underline-offset-2 hover:text-cosmos hover:underline"
                  href="/legal"
                >
                  Read the full disclaimer
                </Link>
                .
              </p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-white/30">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Part of the Saltaire Protocol ecosystem</span>
              <span aria-hidden className="text-white/20">
                &middot;
              </span>
              <span className="text-cosmos/70">Village coming soon</span>
              <span aria-hidden className="text-white/20">
                &middot;
              </span>
              <span>
                built by{' '}
                <a
                  className="text-white/55 underline-offset-2 transition-colors hover:text-cosmos hover:underline"
                  href="https://x.com/GGSaltaire"
                  rel="noreferrer"
                  target="_blank"
                >
                  @GGSaltaire
                </a>
              </span>
            </span>
            <span>v0.1 dev</span>
          </div>
        </div>
        </footer>
      </HideOnArena>
    </>
  );
}

/**
 * Inline X (formerly Twitter) glyph. Sized to match the surrounding
 * text via `currentColor` so it picks up hover-cosmos transitions.
 */
function XIcon() {
  return (
    <svg
      aria-hidden
      className="h-3.5 w-3.5"
      fill="currentColor"
      role="img"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/**
 * Brand mark — a small "blue dwarf" disc with a bright limb. Reused
 * in the header and footer; also used as the favicon's source idea.
 */
function Logo() {
  return (
    <span
      aria-hidden
      className="relative inline-flex h-8 w-8 items-center justify-center rounded-full"
      style={{
        background: 'radial-gradient(circle at 30% 30%, #00d4ff 0%, #0353a4 55%, #001233 100%)',
        boxShadow: '0 0 18px rgba(0, 212, 255, 0.45), inset 0 0 6px rgba(255, 255, 255, 0.2)',
      }}
    >
      <span
        className="absolute h-1.5 w-1.5 rounded-full bg-white"
        style={{ top: 6, left: 8, boxShadow: '0 0 6px white' }}
      />
    </span>
  );
}
