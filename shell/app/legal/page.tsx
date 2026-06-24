/**
 * /legal - showcase-tier disclaimer + privacy stub.
 *
 * This is the on-site compliance surface for the community preview
 * window, before the lawyer's full Terms of Service and Privacy
 * Policy land. The copy is intentionally conservative and entirely
 * factual: it says what astroid.club IS, what it is NOT, and what
 * data we touch.
 *
 * Once legal greenlights live play, this page should be split into
 * /terms and /privacy with the lawyer's wording, and this stub can
 * become a 308 redirect to the chosen primary surface (or stay as a
 * landing index linking to both).
 *
 * Server-rendered, no client state.
 */

import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Legal',
  description:
    'Disclaimer and privacy notice for astroid.club. Nothing on this site is an offer, recommendation, or financial advice.',
};

const LAST_UPDATED = '2026-05-09';

export default function LegalPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 sm:px-8">
      <p className="eyebrow mb-4">Legal</p>
      <h1 className="mb-3 font-display text-4xl font-bold tracking-tight text-white sm:text-5xl">
        Disclaimer and privacy notice
      </h1>
      <p className="mb-12 font-mono text-[11px] uppercase tracking-[0.18em] text-white/45">
        Last updated {LAST_UPDATED}
      </p>

      <Disclaimer />
      <NotASecurity />
      <NoTransfers />
      <DataAndPrivacy />
      <Cosmetics />
      <Geography />
      <Contact />

      <div className="glass-panel-bright mt-12 p-6 text-sm leading-relaxed text-white/65">
        This is the community-preview disclaimer. It will be expanded into a full Terms of Service
        and Privacy Policy before any real-asset transfers go live, on the advice of legal counsel.
      </div>

      <div className="mt-12 flex flex-wrap gap-3">
        <Link className="btn-ghost" href="/">
          Back to the Club
        </Link>
        <Link className="btn-ghost" href="/how-to-play">
          How to play
        </Link>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sections                                                                   */
/* -------------------------------------------------------------------------- */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="mb-3 font-display text-2xl font-semibold text-white">{title}</h2>
      <div className="space-y-3 text-[15px] leading-relaxed text-white/75">{children}</div>
    </section>
  );
}

function Disclaimer() {
  return (
    <Section title="What this site is, and is not">
      <p>
        Astroid Club is a community surface for holders of the $ASTROID token. It is operated as
        part of the Saltaire Protocol ecosystem. The site is currently in a community-preview
        window: the mining arena, holder gate, and supporting tools are visible so members can look
        around before live play opens.
      </p>
      <p>
        Nothing on this site is an offer, solicitation, recommendation, or financial, investment,
        legal, or tax advice. Nothing here promises yield, profit, return, prize, airdrop, or any
        future asset distribution. Anything we describe as in design, in production, or coming soon
        is intent and a working build, not a contractual commitment.
      </p>
    </Section>
  );
}

function NotASecurity() {
  return (
    <Section title="Not a security, not a contractual benefit">
      <p>
        Holding $ASTROID gives you access to this community surface and the utilities listed on the
        home page. It does not entitle you to a share of any pool, treasury, fee, revenue, or future
        distribution. The token is a utility token. Astroid NFTs that we may mint carry no promised
        yield, no redemption value, and no contractual benefit.
      </p>
    </Section>
  );
}

function NoTransfers() {
  return (
    <Section title="No real-asset transfers during preview">
      <p>
        While the community-preview window is open, the gateway has every state-changing on-chain
        operation explicitly disabled. The holder gate is the only on-chain interaction that runs:
        it reads your wallet&rsquo;s $ASTROID balance from a public RPC. Reading your balance does
        not move your tokens; we never sign or submit a transaction on your behalf. You retain full
        custody of your wallet at all times.
      </p>
    </Section>
  );
}

function DataAndPrivacy() {
  return (
    <Section title="What we log">
      <p>
        We treat wallet addresses as personal data. The gateway logs the wallet address you sign in
        with, the timestamp of each verify_holder decision, and whether that decision qualified or
        not. The logs are retained for operational debugging and to prevent abuse (anti-cheat, sybil
        tracking).
      </p>
      <p>
        We do not collect your name, email, IP geolocation, browser fingerprint, or any other
        personal identifier beyond the wallet address you choose to sign in with. We do not set
        tracking cookies. We do not run third-party analytics that fingerprint individuals. If and
        when we add analytics, the implementation will be privacy-preserving (Vercel Web Analytics
        or Plausible, both cookieless).
      </p>
      <p>
        If you want your wallet&rsquo;s observation history cleared from our logs, email the
        operator (see Contact below) with the wallet address and a signed message proving you
        control it. We will action the deletion request within 14 days.
      </p>
    </Section>
  );
}

function Cosmetics() {
  return (
    <Section title="Astroid NFTs (when they ship)">
      <p>
        We may, in the future, mint Astroid NFTs (a collectible series and a cosmetic series) and
        make them available to verified holders for free or at network-fee cost. Those drops are
        optional and have no promised value. They carry no redemption right, no buyback obligation,
        and no contractual benefit. Take what you like; leave what you don&rsquo;t. They are art
        on-chain, not financial instruments.
      </p>
    </Section>
  );
}

function Geography() {
  return (
    <Section title="Geographic eligibility">
      <p>
        We do not currently target or solicit residents of any specific jurisdiction. If you are
        accessing this site from a country where holding, transferring, or interacting with
        utility tokens is restricted, it is your responsibility to comply with your local law.
        Geographic gating may be added before live play opens, on the advice of legal counsel.
      </p>
    </Section>
  );
}

function Contact() {
  return (
    <Section title="Contact">
      <p>
        Questions about this page, your data, or anything else legal-flavoured: reach out via the
        Saltaire Protocol channel listed on the home-page footer, or open an issue on the public
        GitHub repository. The build is open-source and the source of truth for what the gateway
        actually does is the code.
      </p>
    </Section>
  );
}
