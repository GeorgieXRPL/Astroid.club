import Link from 'next/link';
import { branding } from './lib/branding';

/**
 * Astroid Club - coming-soon landing page.
 *
 * Single route, fully static, no client-side JS beyond what Next ships
 * by default. The waitlist card is intentionally NOT a form yet - we
 * collect nothing in v1. When the waitlist actually opens, the
 * <WaitlistTease /> block becomes <WaitlistForm /> in a follow-up PR.
 *
 * All copy is sourced from branding.ts so a compliance review is a
 * single-file diff.
 */
export default function HomePage() {
  return (
    <>
      <SiteHeader />

      <main className="flex-1">
        <Hero />
        <TeaseGrid />
        <WaitlistTease />
        <FamilyStrip />
      </main>

      <SiteFooter />
    </>
  );
}

/* ============================================================
   Header - intentionally tiny. No nav (single-page site), just
   the wordmark + a quiet "holders" chip so the surface tells you
   who it's for at a glance.
   ============================================================ */
function SiteHeader() {
  return (
    <header className="relative z-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2.5 group" aria-label="Astroid Club home">
          <Logo />
          <span className="font-display text-base sm:text-lg tracking-tight text-white">
            Astroid<span className="text-cosmos">.</span>club
          </span>
        </Link>
        <span className="holder-chip" aria-label="For holders of $ASTROID">
          For $ASTROID holders
        </span>
      </div>
    </header>
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
   Hero
   ============================================================ */
function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Atmospheric glow blobs - cheap, GPU-friendly, no JS needed. */}
      <div className="glow-cyan" style={{ top: '-120px', left: '-80px' }} />
      <div className="glow-ember" style={{ top: '60px', right: '-100px' }} />

      <div className="relative max-w-6xl mx-auto px-4 sm:px-6 pt-20 sm:pt-28 pb-16 sm:pb-24">
        <div className="max-w-3xl">
          <div className="eyebrow mb-5">{branding.eyebrow}</div>

          <h1 className="font-display text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight text-white leading-[1.04] mb-6">
            {branding.headline}
            <span className="block text-white/55 mt-2">
              {branding.headlineAccent}
            </span>
          </h1>

          <p className="text-lg text-white/70 leading-relaxed max-w-2xl mb-10">
            {branding.subhead}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <a
              href="#waitlist"
              className="btn-primary"
            >
              See what is coming
              <span aria-hidden>↓</span>
            </a>
            <Link
              href={branding.footer.links.space.href}
              className="btn-secondary"
            >
              Visit astroid.space
              <span aria-hidden>↗</span>
            </Link>
          </div>

          <div className="mt-12 flex flex-wrap items-center gap-x-8 gap-y-3 text-xs font-mono uppercase tracking-[0.18em] text-white/40">
            <span>Solana · $ASTROID</span>
            <span aria-hidden>·</span>
            <span>Community-first</span>
            <span aria-hidden>·</span>
            <span>est. 2026</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   Tease grid - 4 cards of "what's coming"
   ============================================================ */
function TeaseGrid() {
  return (
    <section className="relative max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-20">
      <div className="section-divider mb-10">What's coming</div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {branding.teases.map((tease) => (
          <TeaseCard
            key={tease.tag}
            tag={tease.tag}
            title={tease.title}
            body={tease.body}
          />
        ))}
      </div>
    </section>
  );
}

function TeaseCard({
  tag,
  title,
  body,
}: {
  tag: string;
  title: string;
  body: string;
}) {
  return (
    <article className="glass-panel p-6 hover:border-cosmos/40 transition-colors">
      <div className="telemetry-label mb-4">{tag}</div>
      <h3 className="font-display text-lg font-semibold text-white tracking-tight mb-2">
        {title}
      </h3>
      <p className="text-sm text-white/60 leading-relaxed">{body}</p>
    </article>
  );
}

/* ============================================================
   Waitlist tease - NOT a form yet. Just a panel that says "soon".
   ============================================================ */
function WaitlistTease() {
  return (
    <section
      id="waitlist"
      className="relative max-w-4xl mx-auto px-4 sm:px-6 py-16 sm:py-24 scroll-mt-20"
    >
      <div className="glass-panel-bright p-8 sm:p-12 text-center relative overflow-hidden">
        {/* soft inner glow */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(circle at 50% 0%, rgba(0, 212, 255, 0.18) 0%, transparent 60%)',
          }}
        />

        <div className="relative">
          <div className="eyebrow mb-3">{branding.waitlistEyebrow}</div>
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-white tracking-tight mb-5">
            {branding.waitlistTitle}
          </h2>
          <p className="text-white/70 max-w-xl mx-auto leading-relaxed mb-8">
            {branding.waitlistBody}
          </p>

          {/* Faux input row - communicates intent without collecting data.
              When the waitlist actually opens this becomes a real form. */}
          <div
            aria-hidden
            className="max-w-md mx-auto flex items-center gap-2 p-1.5 rounded-xl border border-white/10 bg-black/30"
          >
            <div className="flex-1 px-4 py-2.5 text-left text-sm text-white/35 font-mono">
              you@somewhere.dev
            </div>
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="btn-primary text-sm"
              title="The waitlist is not open yet"
            >
              Soon
            </button>
          </div>

          <p className="mt-6 text-xs font-mono text-white/35 tracking-wider uppercase">
            Not collecting yet · We will announce when it opens
          </p>

          <p className="mt-8 text-xs text-white/40 leading-relaxed max-w-xl mx-auto">
            {branding.waitlistFootnote}
          </p>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   Family strip - quiet promo for the rest of the Astroid family
   ============================================================ */
function FamilyStrip() {
  return (
    <section className="relative max-w-2xl mx-auto px-4 sm:px-6 pb-20">
      <FamilyCard
        tag="The mission site"
        title="astroid.space"
        body="Name a star. Color the mascot. See the on-chain charity wallet that the Astroid project funds in real time."
        href={branding.footer.links.space.href}
        cta="Open astroid.space"
      />
    </section>
  );
}

function FamilyCard({
  tag,
  title,
  body,
  href,
  cta,
}: {
  tag: string;
  title: string;
  body: string;
  href: string;
  cta: string;
}) {
  return (
    <a
      href={href}
      className="glass-panel p-6 group hover:border-cosmos/40 transition-colors block"
      target={href.startsWith('http') ? '_blank' : undefined}
      rel={href.startsWith('http') ? 'noopener noreferrer' : undefined}
    >
      <div className="telemetry-label mb-3">{tag}</div>
      <h3 className="font-display text-xl font-semibold text-white tracking-tight mb-2">
        {title}
      </h3>
      <p className="text-sm text-white/60 leading-relaxed mb-5">{body}</p>
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-cosmos group-hover:text-white transition-colors">
        {cta} <span aria-hidden>→</span>
      </span>
    </a>
  );
}

/* ============================================================
   Footer - family blurb + legal disclaimers + contact links
   ============================================================ */
function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="relative border-t border-white/5 bg-black/20 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14">
        <div className="grid lg:grid-cols-3 gap-10">
          <div>
            <div className="flex items-center gap-2.5 mb-4">
              <Logo />
              <span className="font-display text-base tracking-tight text-white">
                Astroid<span className="text-cosmos">.</span>club
              </span>
            </div>
            <div className="telemetry-label mb-2">{branding.footer.family}</div>
            <p className="text-sm text-white/55 leading-relaxed max-w-sm">
              {branding.footer.familyBlurb}
            </p>
          </div>

          <div>
            <div className="telemetry-label mb-3">Family</div>
            <ul className="space-y-2 text-sm">
              <li>
                <a
                  href={branding.footer.links.space.href}
                  className="text-white/70 hover:text-cosmos transition-colors"
                >
                  {branding.footer.links.space.label}
                </a>
              </li>
            </ul>

            <div className="telemetry-label mt-6 mb-3">Get in touch</div>
            <ul className="space-y-2 text-sm">
              <li>
                <a
                  href={branding.footer.links.hello.href}
                  className="text-white/70 hover:text-cosmos transition-colors"
                >
                  {branding.footer.links.hello.label}
                </a>
              </li>
              <li>
                <a
                  href={branding.footer.links.security.href}
                  className="text-white/70 hover:text-cosmos transition-colors"
                >
                  {branding.footer.links.security.label}
                </a>
              </li>
            </ul>
          </div>

          <div>
            <div className="telemetry-label mb-3">{branding.footer.legal.heading}</div>
            <div className="space-y-3 text-xs text-white/45 leading-relaxed">
              {branding.footer.legal.lines.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-12 pt-6 border-t border-white/5 flex flex-wrap items-center justify-between gap-3 text-xs font-mono text-white/35 uppercase tracking-[0.16em]">
          <span>© {year} Astroid · {branding.footer.rights}</span>
          <span>Coming soon · v0.1</span>
        </div>
      </div>
    </footer>
  );
}
