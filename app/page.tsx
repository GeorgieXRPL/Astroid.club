import Link from 'next/link';
import { branding } from './lib/branding';
import { HeroSceneClient } from './components/HeroSceneClient';

/**
 * Astroid Club - coming-soon landing page.
 *
 * One screen. One mood: something is about to open and you want to be
 * on the right side of the door. Three.js drift-through-the-galaxy
 * scene behind, minimal centered copy in front, condensed legal +
 * family links tucked into the footer.
 *
 * The whole hero is intentionally short on words. The mystery does
 * the work. No tease cards, no feature lists, no sign-up form.
 */
export default function HomePage() {
  return (
    <>
      <Hero />
      <SiteFooter />
    </>
  );
}

/* ============================================================
   Hero - full viewport, three.js scene behind, dim vignette,
   minimal centered copy. The "what's behind the door?" energy
   comes from sparseness, not from explanation.
   ============================================================ */
function Hero() {
  return (
    <section className="relative min-h-screen w-full overflow-hidden flex flex-col">
      {/*
        Three.js starfield behind everything. Z-0; receives all pointer
        events (drag to rotate, scroll to zoom, auto-rotate when idle).
        Every overlay above this layer that isn't itself interactive
        sets pointer-events-none so the user can grab the universe
        through the headline.
      */}
      <div className="absolute inset-0 z-0">
        <HeroSceneClient />
      </div>

      {/*
        Subtle top + bottom legibility fades. Linear, not radial - a
        radial gradient frames the canvas (visible dark vignette at
        the corners); linear fades just darken the strips behind the
        fixed top bar and bottom status row so text stays readable.
      */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 z-[1] h-40 pointer-events-none"
        style={{
          background:
            'linear-gradient(to bottom, rgba(0,8,20,0.65) 0%, rgba(0,8,20,0) 100%)',
        }}
      />
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 z-[1] h-44 pointer-events-none"
        style={{
          background:
            'linear-gradient(to top, rgba(0,8,20,0.75) 0%, rgba(0,8,20,0) 100%)',
        }}
      />

      {/* Top bar: wordmark + holders chip. The bar itself accepts pointer
          events (links/chip are clickable), but the whitespace between
          them does not so a drag started there reaches the canvas. */}
      <header className="relative z-10 flex items-center justify-between px-5 sm:px-8 pt-6 sm:pt-8 pointer-events-none">
        <Link
          href="/"
          aria-label="Astroid Club home, beta"
          className="flex items-center gap-2.5 group pointer-events-auto"
        >
          <Logo />
          <span className="font-display text-base sm:text-lg tracking-tight text-white">
            astroid<span className="text-cosmos">.</span>club
          </span>
          {/* Tiny BETA pill. Sits inside the link so the whole lockup
              reads as one brand mark; styled with the same cyan accent
              the wordmark dot uses, kept low-key so it doesn't fight
              the headline. */}
          <span
            aria-label="Beta"
            className="ml-1 px-1.5 py-px rounded-sm font-mono text-[9px] sm:text-[10px] tracking-[0.2em] uppercase text-cosmos border border-cosmos/40 bg-cosmos/5 leading-none"
            style={{ paddingTop: 2, paddingBottom: 2 }}
          >
            Beta
          </span>
        </Link>
        <span className="holder-chip pointer-events-auto">Holders only</span>
      </header>

      {/* Center stage. pointer-events-none on the whole stack so the user
          can click-and-drag through the headline to manipulate the scene. */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center text-center px-5 sm:px-8 py-12 pointer-events-none">
        <div className="eyebrow mb-6 sm:mb-8 opacity-90">
          {branding.eyebrow}
        </div>

        <h1
          className="font-display text-6xl sm:text-7xl lg:text-8xl xl:text-9xl font-bold tracking-tight text-white leading-[0.95] mb-5 sm:mb-7"
          style={{
            textShadow:
              '0 2px 24px rgba(0,8,20,0.7), 0 0 48px rgba(0,212,255,0.18)',
          }}
        >
          {branding.headline}
        </h1>

        <p
          className="font-display text-xl sm:text-2xl lg:text-3xl text-white/70 tracking-tight max-w-2xl"
          style={{ textShadow: '0 2px 16px rgba(0,8,20,0.7)' }}
        >
          {branding.subhead}
        </p>

        <div className="mt-12 sm:mt-16 text-xs sm:text-sm font-mono text-white/55 tracking-[0.32em] uppercase">
          {branding.teaseLine}
        </div>
      </div>

      {/* Bottom strip - status + small "stay close" line. Same pattern:
          parent is pointer-events-none; only the actual text spans pick
          up clicks (they have no clicks anyway, so the entire bottom is
          dragable through). */}
      <div className="relative z-10 flex flex-col sm:flex-row items-center justify-between gap-3 px-5 sm:px-8 pb-6 sm:pb-8 text-xs font-mono text-white/55 tracking-[0.18em] uppercase pointer-events-none">
        <span className="flex items-center gap-2.5">
          <span className="live-dot" aria-hidden />
          {branding.status} · v0.1
        </span>
        <span className="text-white/65 normal-case tracking-normal font-sans text-sm">
          {branding.callsign}
        </span>
      </div>

      {/* Tiny interaction hint, bottom-right on desktop only. Same trick
          .space uses on its star map. */}
      <div className="absolute bottom-3 right-3 sm:right-5 z-10 hidden md:block text-[10px] font-mono text-white/30 tracking-[0.24em] uppercase pointer-events-none select-none">
        Drag to look around · Scroll to zoom
      </div>
    </section>
  );
}

function Logo() {
  return (
    <span
      aria-hidden
      className="relative inline-flex items-center justify-center w-8 h-8 rounded-full"
      style={{
        background:
          'radial-gradient(circle at 30% 30%, #00d4ff 0%, #0353a4 55%, #001233 100%)',
        boxShadow:
          '0 0 18px rgba(0, 212, 255, 0.45), inset 0 0 6px rgba(255, 255, 255, 0.2)',
      }}
    >
      <span
        className="absolute w-1.5 h-1.5 rounded-full bg-white"
        style={{ top: 6, left: 8, boxShadow: '0 0 6px white' }}
      />
    </span>
  );
}

/* ============================================================
   Footer - only visible if you scroll. Small, dense, all the
   legal disclaimers in one quiet block.
   ============================================================ */
function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="relative z-10 border-t border-white/5 bg-black/40 backdrop-blur-sm">
      <div className="max-w-5xl mx-auto px-5 sm:px-8 py-10">
        <div className="grid md:grid-cols-3 gap-8">
          <div>
            <div className="flex items-center gap-2.5 mb-3">
              <Logo />
              <span className="font-display text-sm tracking-tight text-white">
                astroid<span className="text-cosmos">.</span>club
              </span>
            </div>
            <div className="telemetry-label mb-2">{branding.footer.family}</div>
            <a
              href={branding.footer.space.href}
              className="text-sm text-white/65 hover:text-cosmos transition-colors"
            >
              {branding.footer.space.label} →
            </a>
          </div>

          <div>
            <div className="telemetry-label mb-3">Get in touch</div>
            <ul className="space-y-2 text-sm">
              <li>
                <a
                  href={branding.footer.hello.href}
                  className="text-white/65 hover:text-cosmos transition-colors"
                >
                  {branding.footer.hello.label}
                </a>
              </li>
              <li>
                <a
                  href={branding.footer.security.href}
                  className="text-white/65 hover:text-cosmos transition-colors"
                >
                  {branding.footer.security.label}
                </a>
              </li>
            </ul>
          </div>

          <div>
            <div className="telemetry-label mb-3">Important</div>
            <div className="space-y-2 text-[11px] text-white/40 leading-relaxed">
              {branding.footer.legal.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-8 pt-5 border-t border-white/5 flex flex-wrap items-center justify-between gap-3 text-[10px] font-mono text-white/30 uppercase tracking-[0.18em]">
          <span>© {year} Astroid · {branding.footer.rights}</span>
          <span>Coming soon</span>
        </div>
      </div>
    </footer>
  );
}
