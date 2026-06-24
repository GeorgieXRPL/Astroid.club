'use client';

/**
 * Public coming-soon landing for astroid.club.
 *
 * Shown at `/` while the arena is gated (`NEXT_PUBLIC_ARENA_OPEN` unset /
 * false). It is the holder-facing teaser: a Three.js drift-through-the-belt
 * scene behind sparse, intentionally mysterious copy. No "enter" CTA, no
 * wallet prompt — the doors are closed to the public until Privy production
 * is wired. Allowlisted testers reach the game via direct `/arena` URLs.
 *
 * All user-facing strings come from the compliance-reviewed `branding.ts`
 * (no price talk, no promises). The global header + footer (with the heavy
 * disclaimers) are supplied by the root layout, so this renders only the
 * hero stage.
 */

import { branding } from '@/lib/branding';

import { HeroSceneClient } from './HeroSceneClient';

export function ComingSoon() {
  return (
    <section className="relative flex min-h-[calc(100vh-88px)] w-full flex-col overflow-hidden">
      {/* Three.js starfield behind everything. Receives pointer events
          (drag to rotate, scroll to zoom). Overlays above set
          pointer-events-none so the universe is grabbable through the copy. */}
      <div className="absolute inset-0 z-0">
        <HeroSceneClient />
      </div>

      {/* Top + bottom legibility fades. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-40"
        style={{
          background: 'linear-gradient(to bottom, rgba(0,8,20,0.55) 0%, rgba(0,8,20,0) 100%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-44"
        style={{
          background: 'linear-gradient(to top, rgba(0,8,20,0.75) 0%, rgba(0,8,20,0) 100%)',
        }}
      />

      {/* Center stage. pointer-events-none so users can drag through the
          headline to manipulate the scene. */}
      <div className="pointer-events-none relative z-10 flex flex-1 flex-col items-center justify-center px-5 py-12 text-center sm:px-8">
        <div className="eyebrow mb-6 opacity-90 sm:mb-8">{branding.eyebrow}</div>

        <h1
          className="mb-5 font-display text-6xl font-bold leading-[0.95] tracking-tight text-white sm:mb-7 sm:text-7xl lg:text-8xl xl:text-9xl"
          style={{ textShadow: '0 2px 24px rgba(0,8,20,0.7), 0 0 48px rgba(0,212,255,0.18)' }}
        >
          {branding.headline}
        </h1>

        <p
          className="max-w-2xl font-display text-xl tracking-tight text-white/70 sm:text-2xl lg:text-3xl"
          style={{ textShadow: '0 2px 16px rgba(0,8,20,0.7)' }}
        >
          {branding.subhead}
        </p>

        <div className="mt-12 font-mono text-xs uppercase tracking-[0.32em] text-white/55 sm:mt-16 sm:text-sm">
          {branding.teaseLine}
        </div>
      </div>

      {/* Bottom status strip. */}
      <div className="pointer-events-none relative z-10 flex flex-col items-center justify-between gap-3 px-5 pb-6 font-mono text-xs uppercase tracking-[0.18em] text-white/55 sm:flex-row sm:px-8 sm:pb-8">
        <span className="flex items-center gap-2.5">
          <span className="live-dot" aria-hidden />
          {branding.status}
        </span>
        <span className="font-sans text-sm normal-case tracking-normal text-white/65">
          {branding.callsign}
        </span>
      </div>

      <div className="pointer-events-none absolute bottom-3 right-3 z-10 hidden select-none font-mono text-[10px] uppercase tracking-[0.24em] text-white/30 sm:right-5 md:block">
        Drag to look around · Scroll to zoom
      </div>
    </section>
  );
}
