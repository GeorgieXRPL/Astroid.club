'use client';

/**
 * Top-of-page navigation.
 *
 * Shape:
 *   - Desktop (>= md / 768px): horizontal row of `btn-ghost` links.
 *   - Mobile  (<  md):         hamburger button that opens a slide-down
 *                              panel with the same links stacked
 *                              vertically.
 *
 * The hamburger is a client component because it needs `open` state and
 * needs to react to Escape / outside-click / route-change so the panel
 * doesn't hang around when the user navigates. Everything else in the
 * header is static markup driven from `layout.tsx`.
 *
 * The link list is the single source of truth for both layouts. To add /
 * remove an item, change `NAV_LINKS` only.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { ARENA_OPEN } from '@/lib/features';

interface NavLink {
  href: string;
  label: string;
  /** Renders as <a target="_blank"> when set; defaults to internal Next.js Link. */
  external?: boolean;
  /** Hidden from the public nav until the arena is opened. */
  gated?: boolean;
}

const ALL_NAV_LINKS: ReadonlyArray<NavLink> = [
  { href: '/arena', label: 'Arena', gated: true },
  { href: '/how-to-play', label: 'How to play', gated: true },
  { href: '/console', label: 'Console', gated: true },
  { href: '/sign-in', label: 'Sign in', gated: true },
  { href: 'https://github.com/HeartOfMidgar/astroid-public', label: 'Source', external: true },
];

// While the doors are closed, drop the in-game links so the public lands
// on the coming-soon page only. The /arena route stays reachable by direct
// URL behind Privy + the server-side wallet allowlist for testers.
const NAV_LINKS: ReadonlyArray<NavLink> = ALL_NAV_LINKS.filter(
  (link) => ARENA_OPEN || !link.gated,
);

export function SiteNav() {
  return (
    <>
      <DesktopNav />
      <MobileNav />
    </>
  );
}

function DesktopNav() {
  return (
    <nav
      aria-label="Primary"
      className="hidden items-center gap-2 font-mono text-sm text-white/55 md:flex md:gap-4"
    >
      {NAV_LINKS.map((link) =>
        link.external ? (
          <a
            key={link.href}
            className="btn-ghost"
            href={link.href}
            rel="noreferrer"
            target="_blank"
          >
            {link.label}
          </a>
        ) : (
          <Link key={link.href} className="btn-ghost" href={link.href}>
            {link.label}
          </Link>
        ),
      )}
    </nav>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  // Track when we're client-side so the portal can attach to document.body.
  // Without this guard the SSR pass would call createPortal during render.
  useEffect(() => {
    setMounted(true);
  }, []);

  // Close on route change so the panel doesn't linger after a tap.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on Escape and lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  // The header and main both have `relative z-10`, which gives them
  // their own sibling stacking contexts. Anything `fixed` rendered
  // inside the header's subtree was being painted UNDER `<main>`'s
  // contents because main is later in the DOM. Portalling the overlay
  // and panel into `document.body` lifts them out of the header's
  // stacking context entirely, so they paint above every page region.
  const overlay =
    open && mounted
      ? createPortal(
          <div className="md:hidden">
            {/* Click-outside layer. Solid space-blue at high alpha so
                3D canvases and dense copy can't bleed through. */}
            <button
              aria-hidden
              className="fixed inset-0 z-[100] bg-[#000814]/95 backdrop-blur-md"
              onClick={() => setOpen(false)}
              tabIndex={-1}
              type="button"
            />
            {/* Opaque sheet panel — no alpha on the surface so it stays
                legible against any underlying content. */}
            <nav
              aria-label="Primary"
              className="fixed inset-x-4 top-20 z-[110] rounded-2xl border border-white/15 bg-[#05060a] p-3 shadow-2xl shadow-black/70 ring-1 ring-cosmos/10"
              id="site-nav-panel"
            >
              <ul className="flex flex-col">
                {NAV_LINKS.map((link) => (
                  <li key={link.href}>
                    {link.external ? (
                      <a
                        className="flex items-center justify-between rounded-xl px-4 py-3 font-mono text-base text-white/90 transition-colors hover:bg-white/5 hover:text-cosmos"
                        href={link.href}
                        onClick={() => setOpen(false)}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <span>{link.label}</span>
                        <span aria-hidden className="ml-2 text-white/35">
                          ↗
                        </span>
                      </a>
                    ) : (
                      <Link
                        className="block rounded-xl px-4 py-3 font-mono text-base text-white/90 transition-colors hover:bg-white/5 hover:text-cosmos"
                        href={link.href}
                        onClick={() => setOpen(false)}
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="md:hidden">
      <button
        aria-controls="site-nav-panel"
        aria-expanded={open}
        aria-label={open ? 'Close menu' : 'Open menu'}
        className="btn-ghost flex h-10 w-10 items-center justify-center !p-0"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <BurgerIcon open={open} />
      </button>
      {overlay}
    </div>
  );
}

function BurgerIcon({ open }: { open: boolean }) {
  // Three-line icon that morphs into an X when `open`. Pure CSS via two
  // pseudo-line spans, no SVG needed.
  return (
    <span
      aria-hidden
      className="relative flex h-4 w-5 flex-col justify-between"
      style={{ transition: 'transform 200ms ease' }}
    >
      <span
        className="h-0.5 w-full origin-center rounded-full bg-white/80"
        style={{
          transform: open ? 'translateY(7px) rotate(45deg)' : 'none',
          transition: 'transform 200ms ease',
        }}
      />
      <span
        className="h-0.5 w-full rounded-full bg-white/80"
        style={{
          opacity: open ? 0 : 1,
          transition: 'opacity 150ms ease',
        }}
      />
      <span
        className="h-0.5 w-full origin-center rounded-full bg-white/80"
        style={{
          transform: open ? 'translateY(-7px) rotate(-45deg)' : 'none',
          transition: 'transform 200ms ease',
        }}
      />
    </span>
  );
}
