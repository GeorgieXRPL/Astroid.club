'use client';

/**
 * Astroid Club landing — gated by holder verification.
 *
 * Two states:
 *
 *   1. Outside the club (default).
 *      Mirrors the public coming-soon teaser at astroid.club:
 *      sparse, mysterious, holder-only chip in the corner. Headline
 *      and subhead are taken VERBATIM from the public site's branding
 *      file (`Astroid.club/app/lib/branding.ts`) so the two surfaces
 *      read as one brand. The "Verify your holdings" CTA is the only
 *      door in.
 *
 *   2. Inside the club (after sign-in).
 *      Operational view for verified members: quick links into the
 *      Arena and Console, the four pillars (Mining / Perks /
 *      Events / Community) as compliant utility cards, and the live
 *      build roadmap so members can see what's being worked on.
 *
 * Compliance posture (driven by `branding.ts`):
 *   - No yield, profit, or "you will receive X" language.
 *   - "Holders are invited" / "free to claim" / "free to participate"
 *     framing throughout.
 *   - Astroid NFT card explicitly states no yield, no redemption,
 *     not a security.
 *   - Poker freeroll utility is REMOVED from the visible feature set
 *     pending regulatory approval — see `POKER_ENABLED` flag below
 *     for the re-enable path.
 *   - Heavy disclaimers stay in `layout.tsx`'s footer.
 *
 * Holder-verification mechanic:
 *   - In the current build the "verification" is the wallet-sign-in
 *     handshake (auth handshake against the gateway). The dev keypair
 *     persists in localStorage; signing the nonce stands in for the
 *     real on-chain holder check while `CHAIN_ENABLED=false`.
 *   - When `CHAIN_ENABLED=true` lands, `connect()` will additionally
 *     gate on the gateway's `verify_holder` response. The page only
 *     needs the `state === 'connected'` signal — that contract stays
 *     stable across the chain flip.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { ComingSoon } from '@/components/landing/ComingSoon';
import { ARENA_OPEN } from '@/lib/features';
import { SessionError, type ConnectSnapshot, type HolderEligibilityReason } from '@/lib/session';
import { connect, disconnect, useSession } from '@/lib/use-session';
import { useWalletSource } from '@/lib/wallet-source-providers';

const WS_URL = process.env.NEXT_PUBLIC_ASTROID_WS_URL ?? 'ws://localhost:3002';

/**
 * Feature flag for the poker-freeroll utility. Off by default while
 * regulatory approval is in flight; flip to `true` (via env or here)
 * once cleared. The card is fully scoped below — no other code path
 * leaks the feature when this is false.
 */
const POKER_ENABLED = process.env.NEXT_PUBLIC_FEATURE_POKER === 'true';

/** Tease pillars copied from the public site's branding contract. */
const PILLARS = ['Community', 'Perks', 'Events', 'Lore'] as const;

/* -------------------------------------------------------------------------- */
/*  Page shell                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Local state for the post-auth holder verification step. The auth
 * handshake gives us a `Session`; the Club gate then runs
 * `session.verifyHolder()` to decide whether to render `ClubInside`
 * or a "this wallet does not currently qualify" panel.
 *
 *   - `idle`         — no session yet, or the session was just torn
 *                       down. Shows `ClubOutside`.
 *   - `pending`      — auth done, holder check in flight. Shows the
 *                       outside-the-club shell with "Verifying your
 *                       holdings…" copy so users see motion.
 *   - `eligible`     — Club gate passed. Renders `ClubInside`.
 *   - `not_eligible` — Club gate failed (chain on, threshold or
 *                       hold-time not met). Renders `NotEligible`.
 *   - `error`        — transport / RPC failure. Surfaces the error
 *                       and offers a retry. Doesn't reveal the
 *                       wallet's actual balance.
 */
type HolderStatus =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'eligible'; reason: HolderEligibilityReason; message: string }
  | { state: 'not_eligible'; message: string }
  | { state: 'error'; code: string; message: string };

export default function Home() {
  // Public doors are closed until the arena is opened. Render the
  // coming-soon teaser at the apex; allowlisted testers still reach the
  // game directly at /arena (Privy + server allowlist gate it).
  if (!ARENA_OPEN) {
    return (
      <div className="relative">
        <ComingSoon />
      </div>
    );
  }
  return <ClubApp />;
}

function ClubApp() {
  const session = useSession();
  const [holder, setHolder] = useState<HolderStatus>({ state: 'idle' });

  // Drive the holder check off the session lifecycle. Each time we
  // get a fresh `Session` (i.e. a new auth handshake completes),
  // kick off a `verify_holder` call and resolve into eligible /
  // not_eligible / error. When the session goes away (sign-out,
  // socket close), reset to `idle` so the next sign-in triggers a
  // fresh check rather than reusing a stale answer.
  const sess = session.state === 'connected' ? session.session : null;
  useEffect(() => {
    if (!sess) {
      setHolder({ state: 'idle' });
      return;
    }
    setHolder({ state: 'pending' });
    let cancelled = false;
    sess.verifyHolder().then(
      (result) => {
        if (cancelled) return;
        if (result.eligible) {
          setHolder({
            state: 'eligible',
            reason: result.reason,
            message: result.message,
          });
        } else {
          setHolder({ state: 'not_eligible', message: result.message });
        }
      },
      (err) => {
        if (cancelled) return;
        const code = err instanceof SessionError ? err.code : 'unknown';
        const msg = err instanceof Error ? err.message : String(err);
        setHolder({ state: 'error', code, message: msg });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sess]);

  if (sess && session.snapshot && holder.state === 'eligible') {
    return (
      <div className="relative">
        <ClubInside snapshot={session.snapshot} reason={holder.reason} />
      </div>
    );
  }

  if (sess && holder.state === 'not_eligible') {
    return (
      <div className="relative">
        <NotEligible
          walletAddress={session.snapshot?.walletAddress ?? ''}
          message={holder.message}
        />
      </div>
    );
  }

  return (
    <div className="relative">
      <ClubOutside session={session} holder={holder} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Outside the club — mystery + verification CTA                              */
/* -------------------------------------------------------------------------- */

function ClubOutside({
  session,
  holder,
}: {
  session: ReturnType<typeof useSession>;
  holder: HolderStatus;
}) {
  const wallet = useWalletSource();
  const [pending, setPending] = useState(false);

  const onVerify = useCallback(async () => {
    setPending(true);
    try {
      const source = await wallet.connectWallet();
      await connect(WS_URL, source);
    } catch {
      /* error already published into the session store */
    } finally {
      setPending(false);
    }
  }, [wallet]);

  // The CTA is "busy" through the whole auth + holder verification
  // pipeline. Splitting them into two visually distinct phases would
  // require an extra click without giving the user any new
  // information — they care about "am I in the Club yet" not about
  // which wire-protocol step is currently in flight.
  const isConnecting = pending || session.state === 'connecting' || holder.state === 'pending';
  const sessionError = session.state === 'error' ? session.error : null;
  const holderError = holder.state === 'error' ? holder : null;
  const error = sessionError ?? holderError;
  const ctaLabel = isConnecting
    ? holder.state === 'pending'
      ? 'Verifying holdings\u2026'
      : 'Signing in\u2026'
    : 'Verify your holdings';

  return (
    <section className="relative mx-auto flex min-h-[calc(100vh-180px)] max-w-5xl flex-col items-center justify-center px-6 py-16 text-center sm:px-8">
      <div className="glow-cyan -top-32 left-1/4" aria-hidden />
      <div className="glow-ember bottom-0 right-1/4" aria-hidden />

      {/* Holders-only chip — borrowed lockup from the public site. */}
      <div className="mb-8 flex items-center justify-center">
        <span className="holder-chip">Holders only</span>
      </div>

      <p className="eyebrow mb-6">For holders of $ASTROID &middot; Beta</p>

      <h1
        className="mb-6 font-display text-6xl font-bold leading-[0.95] tracking-tight text-white sm:text-7xl lg:text-8xl"
        style={{
          textShadow: '0 2px 24px rgba(0,8,20,0.7), 0 0 48px rgba(0,212,255,0.18)',
        }}
      >
        Knock, knock.
      </h1>

      <p
        className="mb-10 max-w-2xl font-display text-xl leading-tight tracking-tight text-white/70 sm:text-2xl lg:text-3xl"
        style={{ textShadow: '0 2px 16px rgba(0,8,20,0.7)' }}
      >
        A door is about to open.
      </p>

      {/* Four-pillar tease — locked vocabulary, no commitments. */}
      <div className="mb-12 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 font-mono text-[11px] uppercase tracking-[0.32em] text-white/55 sm:text-xs">
        {PILLARS.map((p, i) => (
          <span key={p} className="flex items-center gap-x-3">
            {i > 0 && (
              <span aria-hidden className="text-white/25">
                ·
              </span>
            )}
            <span>{p}</span>
          </span>
        ))}
      </div>

      {/* The CTA. */}
      <div className="flex flex-col items-center gap-4">
        <button
          aria-busy={isConnecting}
          className="btn-primary px-7 py-3 text-base"
          disabled={isConnecting || !wallet.ready}
          onClick={onVerify}
          type="button"
        >
          {ctaLabel}
        </button>
        <p className="max-w-sm text-xs leading-relaxed text-white/45">
          We&rsquo;ll ask your wallet to sign a one-time message. No transaction, no fees, no
          permissions granted. Holdings are checked read-only on-chain.
        </p>
        <WalletProviderBadge mode={wallet.mode} />
      </div>

      {error && (
        <div className="mt-6 max-w-md rounded-md border border-ember/40 bg-ember/10 px-4 py-3 font-mono text-xs text-ember">
          {error.code}: {error.message}
        </div>
      )}

      <div className="mt-16 flex flex-col items-center gap-2 font-mono text-[10px] uppercase tracking-[0.32em] text-white/40 sm:text-xs">
        <span className="flex items-center gap-2.5">
          <span className="live-dot" aria-hidden />
          Stay close. The doors open here first.
        </span>
        <span className="text-white/25">v0.1 dev &middot; ws://localhost:3002</span>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Inside the club — operational view                                         */
/* -------------------------------------------------------------------------- */

function ClubInside({
  snapshot,
  reason,
}: {
  snapshot: ConnectSnapshot;
  reason: HolderEligibilityReason;
}) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-12 sm:px-8 sm:py-16">
      <WelcomeBanner snapshot={snapshot} reason={reason} />
      <Hero />
      <QuickLinks />
      <UtilitiesGrid />
      <Roadmap />
    </div>
  );
}

function WelcomeBanner({
  snapshot,
  reason,
}: {
  snapshot: ConnectSnapshot;
  reason: HolderEligibilityReason;
}) {
  // The reason badge is what tells the user how their gate was
  // resolved. `chain_disabled` should never appear in production
  // (boot fn requires CHAIN_ENABLED=true on launch); it surfaces
  // here so local devs and pre-launch testers know the answer
  // came from the dev-mode pass-through, not a real RPC.
  const reasonBadge =
    reason === 'qualified'
      ? { label: 'Holder verified \u00b7 on-chain', tone: 'success' as const }
      : { label: 'Dev mode \u00b7 holder check pass-through', tone: 'muted' as const };

  return (
    <section className="mb-12">
      <div className="glass-panel-bright flex flex-col items-start gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span aria-hidden className="live-dot" />
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-emerald-300">
              Verified holder
            </p>
            <p className="font-mono text-[12px] text-white/85">{short(snapshot.walletAddress)}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              reasonBadge.tone === 'success'
                ? 'rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-300'
                : 'rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/55'
            }
          >
            {reasonBadge.label}
          </span>
          <Link className="btn-primary" href="/arena">
            Enter the arena
          </Link>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Not eligible — wallet didn't pass the holder gate                          */
/* -------------------------------------------------------------------------- */

/**
 * Shown when `verify_holder` returns `eligible: false`. We deliberately
 * do NOT echo the wallet's actual balance or the threshold back: the
 * Club gate is binary, and revealing the exact tracker semantics
 * makes it slightly easier for an attacker to game the flash-loan
 * mitigation. The copy points users at the spec instead.
 *
 * The user can sign out from here to try a different wallet.
 */
function NotEligible({ walletAddress, message }: { walletAddress: string; message: string }) {
  const wallet = useWalletSource();
  const onSignOut = useCallback(async () => {
    disconnect();
    await wallet.disconnectWallet();
  }, [wallet]);

  return (
    <section className="relative mx-auto flex min-h-[calc(100vh-180px)] max-w-3xl flex-col items-center justify-center px-6 py-16 text-center sm:px-8">
      <div className="glow-ember -top-32 left-1/4" aria-hidden />

      <div className="mb-8">
        <span className="holder-chip">Holders only</span>
      </div>

      <p className="eyebrow mb-5">Verification did not pass</p>
      <h1 className="mb-5 font-display text-5xl font-bold leading-[0.95] tracking-tight text-white sm:text-6xl">
        Not yet, traveller.
      </h1>
      <p className="mb-3 max-w-xl text-base leading-relaxed text-white/70 sm:text-lg">{message}</p>
      <p className="mb-8 max-w-xl text-sm leading-relaxed text-white/45">
        The Club gate is read-only. We never moved or touched any tokens. If you topped up after
        signing in, the gate has a hold-time window before it re-counts; come back in a little while
        or pick a different wallet.
      </p>

      {walletAddress && (
        <div className="mb-8 inline-flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.03] px-4 py-2 font-mono text-xs text-white/65">
          <span className="text-white/40">checked</span>
          <span>{short(walletAddress)}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3">
        <button className="btn-secondary" onClick={onSignOut} type="button">
          Try a different wallet
        </button>
        <Link
          className="text-xs text-white/55 underline-offset-4 hover:text-white/80 hover:underline"
          href="https://github.com/HeartOfMidgar/Astroid-miner/blob/main/docs/GAME_DESIGN.md#9-holder-verification"
          rel="noreferrer"
          target="_blank"
        >
          Read the holder spec
        </Link>
      </div>
    </section>
  );
}

function Hero() {
  return (
    <section className="relative mb-16 max-w-3xl">
      <div className="glow-cyan -left-48 -top-32" aria-hidden />
      <div className="glow-ember left-32 top-12" aria-hidden />
      <div className="relative">
        <p className="eyebrow mb-5">Inside the club &middot; Beta</p>
        <h1 className="mb-5 font-display text-5xl font-bold leading-[0.95] tracking-tight text-white sm:text-6xl lg:text-7xl">
          Welcome, traveller.
          <br />
          <span className="text-white/65">Here&rsquo;s what&rsquo;s behind the door, so far.</span>
        </h1>
        <p className="max-w-xl text-base leading-relaxed text-white/70 sm:text-lg">
          A members-only space for $ASTROID holders. The mining arena is live in playtest. Astroid
          NFT drops, in-world events, and community channels are queued. Everything you see is
          intent and a working build, not a promise.
        </p>
      </div>
    </section>
  );
}

function QuickLinks() {
  return (
    <section className="mb-16 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Link
        className="glass-panel group flex items-start gap-4 p-5 transition hover:border-cosmos/40 hover:bg-cosmos/5"
        href="/arena"
      >
        <span className="resource-dot resource-dot--gold mt-1.5" aria-hidden />
        <span className="flex-1">
          <span className="block font-display text-base font-semibold text-white">
            Mining arena
          </span>
          <span className="block text-sm text-white/60">
            20 asteroids, 4 sectors, drift through a procedural belt. Drag to look, click an
            asteroid to mine it.
          </span>
        </span>
        <span aria-hidden className="font-mono text-cosmos/70 transition group-hover:text-cosmos">
          →
        </span>
      </Link>
      <Link
        className="glass-panel group flex items-start gap-4 p-5 transition hover:border-cosmos/40 hover:bg-cosmos/5"
        href="/how-to-play"
      >
        <span className="resource-dot resource-dot--oil mt-1.5" aria-hidden />
        <span className="flex-1">
          <span className="block font-display text-base font-semibold text-white">How to play</span>
          <span className="block text-sm text-white/60">
            Step-by-step walkthrough, controls cheatsheet, glossary. Read this once, play forever.
          </span>
        </span>
        <span aria-hidden className="font-mono text-cosmos/70 transition group-hover:text-cosmos">
          →
        </span>
      </Link>
      <Link
        className="glass-panel group flex items-start gap-4 p-5 transition hover:border-cosmos/40 hover:bg-cosmos/5"
        href="/console"
      >
        <span className="resource-dot resource-dot--silver mt-1.5" aria-hidden />
        <span className="flex-1">
          <span className="block font-display text-base font-semibold text-white">
            Test console
          </span>
          <span className="block text-sm text-white/60">
            Drive every game message by hand. Useful while we tune the economy.
          </span>
        </span>
        <span aria-hidden className="font-mono text-cosmos/70 transition group-hover:text-cosmos">
          →
        </span>
      </Link>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Holder utilities — compliance-reviewed copy                                */
/* -------------------------------------------------------------------------- */

interface UtilityCard {
  pillar: (typeof PILLARS)[number];
  title: string;
  /**
   * Lifecycle status as it appears on the card badge.
   *  - `live`           : the utility is shipped and usable today
   *  - `in-production`  : actively being built, has a target ship date
   *                        ahead of the slower `in-design` queue
   *  - `in-design`      : scoped, not yet under active build
   *  - `planned`        : on the roadmap, no design pass yet
   */
  status: 'live' | 'in-production' | 'in-design' | 'planned';
  body: string;
  /** Compliance-mandated disclaimer footer; rendered in muted micro-copy. */
  fineprint?: string;
}

const UTILITIES: UtilityCard[] = [
  {
    pillar: 'Perks',
    title: 'Mining arena',
    status: 'live',
    body: 'Mine a procedural belt and get paid as discoveries land. Lock $ASTROID to climb USD-pegged drill tiers (Bronze → Diamond) that multiply your output, raid rival asteroids to carry off their treasury, rally to defend, and deflect incoming meteor strikes to shield — and grow — your vault. A live HUD navigation guide and raid console keep the action in view, and one click turns any run or raid into a shareable card. Staking runs on the audited Quarry protocol — your tokens stay in your control and unstake any time.',
    fineprint:
      'Staking is non-custodial: $ASTROID is locked in the audited, third-party Quarry protocol, never in a Club-controlled treasury, and is withdrawable any time. Staking is a gameplay buff, not an investment — no yield, interest, or profit is promised. In-game mining credits are game artifacts with no promised redemption value.',
  },
  {
    pillar: 'Perks',
    title: 'Astroid NFTs',
    status: 'in-production',
    body: 'Phase-gated, free-to-claim NFTs for verified holders. A collectible series and a cosmetic series, both minted on Solana: emblems, Astroid skins, ship badges, and event-tied keepsakes. Optional. Take what you like; leave what you don\u2019t. These are all in production and are coming soon.',
    fineprint:
      'No promised yield. No redemption value. Not a security and not a contractual benefit. Free to claim if and when minted; never required to participate in the Club. Mint costs (when applicable) cover network fees only.',
  },
  {
    pillar: 'Events',
    title: 'In-world events',
    status: 'in-design',
    body: 'Periodic events that reshape the asteroid map: Solar Flare windows, Stellar Strike storms, syndicate-scale raids. Verified holders are invited to participate; lore unlocks attached to the longest-active wallets.',
    fineprint:
      'Participation is free for verified holders. Events have no entry fee, no required spend, and no promised reward beyond what is shown in-arena.',
  },
  {
    pillar: 'Community',
    title: 'Members lounge',
    status: 'planned',
    body: 'Direct line to the build: a holder-gated channel for behind-the-doors updates, playtest invites, and creator-led calls. Holding $ASTROID is your invitation.',
    fineprint:
      'Channel access is a courtesy, not a contractual benefit. Holding the token does not entitle you to support, profit, or any future asset distribution.',
  },
  // The "more to come" tile is intentionally pillar-free of the four
  // declared lockups: it's a generic placeholder card, not a fifth
  // utility commitment. Sits last so the grid always reads as
  // "real things, then a horizon".
  {
    pillar: 'Community',
    title: 'More to come',
    status: 'planned',
    body: 'New utilities and surprises will appear here as we scale and the community builds. Holders shape the roadmap; the next card is whatever the Club rallies around together.',
    fineprint:
      'A placeholder for future utilities. Adding something here is not a commitment to ship a specific feature, return, or asset distribution. Anything that lands will be announced on its own terms.',
  },
  // Poker freerolls — gated behind regulatory approval. The card
  // re-enters the visible set when `POKER_ENABLED` flips. Until then
  // the feature is fully scrubbed from the rendered UI.
  ...(POKER_ENABLED
    ? [
        {
          pillar: 'Perks' as const,
          title: 'Poker freerolls',
          status: 'planned' as const,
          body: 'Sponsored poker freerolls for verified holders, run on partner platforms. Read-only on-chain checks; flash-loan resistant.',
          fineprint:
            'Subject to regulatory clearance. No buy-ins required. Not available where prohibited.',
        },
      ]
    : []),
];

function UtilitiesGrid() {
  return (
    <section className="mb-16">
      <div className="section-divider mb-8">What&rsquo;s open to holders</div>
      <div className="grid gap-4 md:grid-cols-2">
        {UTILITIES.map((u) => (
          <UtilityTile key={u.title} card={u} />
        ))}
      </div>
    </section>
  );
}

function UtilityTile({ card }: { card: UtilityCard }) {
  return (
    <article className="glass-panel flex flex-col gap-3 p-6 transition hover:border-white/20 hover:bg-space-800/40">
      <div className="flex items-center justify-between gap-3">
        <p className="telemetry-label">{card.pillar}</p>
        <UtilityStatus status={card.status} />
      </div>
      <h3 className="font-display text-lg font-semibold text-white">{card.title}</h3>
      <p className="text-sm leading-relaxed text-white/65">{card.body}</p>
      {card.fineprint && (
        <p className="mt-1 border-t border-white/5 pt-3 text-[10.5px] leading-relaxed text-white/35">
          {card.fineprint}
        </p>
      )}
    </article>
  );
}

function UtilityStatus({ status }: { status: UtilityCard['status'] }) {
  const palette: Record<UtilityCard['status'], string> = {
    live: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
    'in-production': 'border-amber-400/40 bg-amber-400/10 text-amber-300',
    'in-design': 'border-cosmos/40 bg-cosmos/10 text-cosmos',
    planned: 'border-white/10 bg-white/[0.03] text-white/55',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.18em] ${palette[status]}`}
    >
      {status}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Roadmap — what we're working on                                            */
/* -------------------------------------------------------------------------- */

const ROADMAP: Array<{ slice: string; state: 'landed' | 'next' | 'queued' }> = [
  { slice: 'Mining arena · 20 asteroids · 4 sectors · belt of ~1500', state: 'landed' },
  { slice: 'Holder gate · binary check, flash-loan resistant', state: 'landed' },
  { slice: 'Privy sign-in · external Solana wallets only', state: 'landed' },
  { slice: 'Non-custodial staking · audited Quarry protocol', state: 'landed' },
  { slice: 'USD-pegged drill tiers · Bronze/Silver/Gold/Diamond, live-priced', state: 'landed' },
  { slice: 'Per-discovery payouts · miners paid as finds land', state: 'landed' },
  { slice: 'PvP raids · steal a rival treasury, rally to defend', state: 'landed' },
  { slice: 'Meteor strikes · deflect to shield (and grow) the treasury', state: 'landed' },
  { slice: 'Navigation guide + live raid console in the arena HUD', state: 'landed' },
  { slice: 'Claim to wallet · bridge + atomic redeem to $ASTROID', state: 'landed' },
  { slice: 'Shareable PNL cards · mining + raid reports', state: 'landed' },
  { slice: 'Mainnet holder reads · Helius DAS + flash-loan window', state: 'next' },
  { slice: 'Astroid NFT drop minter · phase-gated, free claim', state: 'queued' },
  { slice: 'Solar Flare / Stellar Strike visual events', state: 'queued' },
  { slice: 'Members lounge · holder-gated updates feed', state: 'queued' },
];

function Roadmap() {
  return (
    <section>
      <div className="section-divider mb-8">What we&rsquo;re working on</div>
      <div className="glass-panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-white/5 text-left">
            <tr>
              <th className="telemetry-label px-5 py-3 font-medium">Slice</th>
              <th className="telemetry-label px-5 py-3 font-medium">State</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {ROADMAP.map((s) => (
              <tr key={s.slice}>
                <td className="px-5 py-3 text-white/85">{s.slice}</td>
                <td className="px-5 py-3 font-mono text-xs">
                  <RoadmapBadge state={s.state} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-[11px] leading-relaxed text-white/35">
        Anything queued or in design is intent, not a promise. Features may change, ship later, or
        not ship at all.
      </p>
    </section>
  );
}

function RoadmapBadge({ state }: { state: 'landed' | 'next' | 'queued' }) {
  const palette: Record<string, string> = {
    landed: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
    next: 'border-cosmos/40 bg-cosmos/10 text-cosmos',
    queued: 'border-white/10 bg-white/[0.03] text-white/45',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 uppercase tracking-[0.16em] ${palette[state]}`}
    >
      {state}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function short(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * Small "Secured by Privy" badge under the verify CTA. Tells users
 * what they're about to talk to and links out to Privy's site so
 * they can verify the integration is real before clicking.
 *
 * Renders a "Dev mode" badge instead when no Privy app id is
 * configured (local development) — so the same component handles
 * both build modes without the page having to know.
 */
function WalletProviderBadge({ mode }: { mode: 'privy' | 'dev' }) {
  if (mode === 'dev') {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-white/45">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-white/40" />
        Dev mode &middot; local keypair
      </span>
    );
  }
  return (
    <a
      aria-label="Learn more about Privy (opens in a new tab)"
      className="group inline-flex items-center gap-2 rounded-full border border-cosmos/30 bg-cosmos/5 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-cosmos/85 transition-colors hover:border-cosmos/55 hover:bg-cosmos/10 hover:text-cosmos"
      href="https://privy.io"
      rel="noreferrer"
      target="_blank"
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cosmos" />
      Secured by Privy
      <span aria-hidden className="text-cosmos/55 transition-colors group-hover:text-cosmos">
        ↗
      </span>
    </a>
  );
}
