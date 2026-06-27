/**
 * /how-to-play - plain-English walkthrough of the mining loop.
 *
 * Audience is a verified holder who has just landed inside the Club
 * and wants to know what every button in the arena does. We assume
 * zero familiarity with on-chain mechanics or game-economy terms.
 *
 * Compliance posture mirrors the landing page:
 *   - No yield/profit/return language. "Tokens" are in-game balances
 *     during playtest; we say so loudly at the top.
 *   - No promises about prizes, drops, freerolls, or returns.
 *   - The page is informational, not a contract.
 *
 * Structure:
 *   - Hero: one-line elevator pitch + the prerequisite (hold $ASTROID).
 *   - Five steps (sign in → home → mine → stake → raid).
 *   - "Glossary" of in-arena vocabulary so players can decode the HUD.
 *   - "If something goes wrong" troubleshooting block.
 *
 * The page is server-rendered (no `'use client'`): nothing here
 * touches the wallet store. That keeps the route fast, cacheable,
 * and crawlable for SEO once the Club opens.
 */

import Link from 'next/link';

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'How to play | astroid.club',
  description:
    'A plain-English walkthrough of the asteroid-mining arena: sign in, pick a home, mine, stake, raid. Read this once, play forever.',
};

export default function HowToPlayPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16 sm:px-8">
      <Hero />
      <Steps />
      <ControlsCheatsheet />
      <Glossary />
      <Troubleshooting />
      <FooterCTA />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hero                                                                       */
/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section className="mb-12">
      <p className="eyebrow mb-4">How to play</p>
      <h1 className="mb-5 font-display text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl">
        Mine. Stake to scale. Raid, defend, deflect.
      </h1>
      <p className="max-w-2xl text-base leading-relaxed text-white/70 sm:text-lg">
        Astroid Club is a space-themed mining arena. Pick a home asteroid and mine to earn $ASTROID
        as discoveries land. Lock $ASTROID to climb drill tiers that multiply your output, raid
        rivals to carry off their treasury, defend your own, and deflect incoming meteor strikes.
        Mining stake runs on the audited Quarry protocol, and you can claim your rewards out to your
        wallet as real $ASTROID whenever you like.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link className="btn-primary" href="/arena">
          Open the arena
        </Link>
        <Link className="btn-secondary" href="/">
          Back to the Club
        </Link>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Five-step walkthrough                                                      */
/* -------------------------------------------------------------------------- */

interface Step {
  n: number;
  title: string;
  body: string;
  hint?: string;
}

const STEPS: Step[] = [
  {
    n: 1,
    title: 'Sign in with your Solana wallet',
    body: 'Click "Connect your wallet" on the arena door. Phantom, Solflare, and Backpack all work. Sign the one-line message to prove you control the wallet. No tokens move; no fees are charged. The Club gate then verifies that you hold enough $ASTROID and have held it long enough to be inside.',
    hint: 'If you just bought $ASTROID, the gate may ask you to wait a short hold-time window before re-checking. The Club gate is read-only and never moves your tokens.',
  },
  {
    n: 2,
    title: 'Pick a home asteroid',
    body: 'When the arena loads, drag to look around the belt and scroll to zoom. Click any asteroid; an action panel slides up from the bottom. Click "Set as home". Your home is your base of operations. It is where raids launch from, and where your defense rallies if you are attacked.',
    hint: 'Resource colour tells you what flows out of the rock: yellow is gold (rare and slow), grey is silver (steady), brown-orange is oil (high volume), and black is carbonaceous (the workhorse).',
  },
  {
    n: 3,
    title: 'Start mining, get paid per discovery',
    body: 'Click any asteroid and hit "Mine here". While you mine you contribute drill power to that rock. Each time the asteroid makes a discovery, the reward is split right then among everyone mining there, proportional to drill power × stake, so you earn as finds land instead of waiting on a periodic payout. Your rewards build up as claimable credits in your HUD.',
    hint: 'You can switch asteroids any time. "Leave" returns your miner to free-roam; "Mine here" on another rock relocates instantly.',
  },
  {
    n: 4,
    title: 'Stake to climb a drill tier',
    body: 'Open the top stats panel, set an amount, and click "Stake" to lock $ASTROID through the Quarry protocol. Stake raises your drill tier (Bronze, Silver, Gold, Diamond), and each tier multiplies your effective drill power and defense. Tiers are priced in USD and re-priced against the live $ASTROID price, so the token amount for each tier adjusts automatically. The HUD shows your current tier and exactly how much more to reach the next.',
    hint: 'Staking is non-custodial and global (not per-asteroid). Unstake any time. It is a gameplay buff, not an investment.',
  },
  {
    n: 5,
    title: 'Raid rivals, rally to defend',
    body: 'From your home station you can raid any other asteroid for a slice of its treasury, the pot that builds up from mining and meteor deflections. Select the target, optionally add a wager (capped at 20% of your home stake, forfeited if you lose), and click "Raid". Beat the defenders and you carry off treasury; lose and your wager is burned. If you are the one under attack, "Rally" spends stake to harden your defense.',
    hint: 'Watch the arena HUD for an "Active raids" list and inbound-raid alerts. Newcomers should mine and stake for a while before opening this can.',
  },
  {
    n: 6,
    title: 'Deflect meteor strikes',
    body: 'Now and then a meteor streaks toward an asteroid. If it hits, it skims a cut of that asteroid\u2019s treasury and dents its yield for a while. You can pay credits to deflect it, and the deflection cost is routed straight into the treasury, so a deflected strike actually grows the pot. The HUD shows the exact deflect cost and your spendable credit balance.',
    hint: 'Deflecting is paid from credits (your claimable mining balance), the same balance you would otherwise claim out to your wallet.',
  },
];

function Steps() {
  return (
    <section className="mb-16">
      <div className="section-divider mb-8">The core loop</div>
      <ol className="space-y-4">
        {STEPS.map((s) => (
          <li className="glass-panel flex items-start gap-5 p-6" key={s.n}>
            <span
              aria-hidden
              className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-cosmos/30 bg-cosmos/10 font-display text-base font-bold text-cosmos"
            >
              {s.n}
            </span>
            <div>
              <h2 className="mb-2 font-display text-xl font-semibold text-white">{s.title}</h2>
              <p className="mb-2 text-sm leading-relaxed text-white/75">{s.body}</p>
              {s.hint && (
                <p className="rounded-md border border-white/8 bg-white/[0.03] px-3 py-2 text-[12px] leading-relaxed text-white/55">
                  <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.18em] text-cosmos/80">
                    Tip
                  </span>
                  {s.hint}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  HUD controls cheatsheet                                                    */
/* -------------------------------------------------------------------------- */

interface Control {
  button: string;
  what: string;
}

const CONTROLS: Control[] = [
  {
    button: 'Mine here',
    what: 'Move your miner to the selected asteroid and start earning a share of its discoveries.',
  },
  { button: 'Leave', what: 'Stop mining at the current asteroid and free-roam.' },
  {
    button: 'Set as home',
    what: 'Mark this asteroid as your base. Raids launch from here; defense rallies trigger here.',
  },
  {
    button: 'Stake',
    what: 'Lock $ASTROID (top stats panel) to raise your drill tier from Bronze to Diamond, multiplying drill power and defense.',
  },
  {
    button: 'Set drill',
    what: 'Tell the engine your current drill power. Higher drill = bigger contribution per tick.',
  },
  {
    button: 'Raid',
    what: 'Launch a timed expedition from your home against this asteroid to steal its treasury. PvP, so expect counter-fire.',
  },
  {
    button: 'Rally',
    what: 'Spend stake to harden an asteroid you hold against an incoming raid.',
  },
  {
    button: 'Deflect',
    what: 'Pay credits to turn away an inbound meteor. The cost is routed into the treasury instead of being skimmed.',
  },
  {
    button: 'Claim',
    what: 'Move your accrued mining credits out to your wallet as real $ASTROID (one wallet signature).',
  },
  {
    button: 'Share my run',
    what: 'Generate a branded PNL card of your mining run or last raid to download or post.',
  },
];

function ControlsCheatsheet() {
  return (
    <section className="mb-16">
      <div className="section-divider mb-8">Controls cheatsheet</div>
      <div className="glass-panel divide-y divide-white/5 overflow-hidden">
        {CONTROLS.map((c) => (
          <div
            className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-baseline sm:gap-6"
            key={c.button}
          >
            <span className="w-32 shrink-0 font-mono text-[12px] uppercase tracking-[0.18em] text-cosmos">
              {c.button}
            </span>
            <span className="text-sm leading-relaxed text-white/75">{c.what}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-white/45">
        Drag the canvas to look around. Scroll to zoom. Click any asteroid to bring up its action
        panel.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Glossary                                                                   */
/* -------------------------------------------------------------------------- */

interface Term {
  term: string;
  meaning: string;
}

const TERMS: Term[] = [
  {
    term: 'Drill power',
    meaning:
      'Your contribution rate at the asteroid you are mining. Higher drill closes the discovery timer faster and earns a bigger slice of each find.',
  },
  {
    term: 'Stake',
    meaning:
      'Non-custodial $ASTROID you lock through the Quarry protocol. Stake sets your drill tier and defense; it is global, not per-asteroid, and you can unstake any time.',
  },
  {
    term: 'Drill tier',
    meaning:
      'Bronze, Silver, Gold, or Diamond, set by how much you stake. Each tier multiplies your effective drill power. Tiers are priced in USD (\u2248 $50 / $100 / $200 / $400) and the token amount adjusts to the live $ASTROID price.',
  },
  {
    term: 'Discovery',
    meaning:
      'When an asteroid makes a find, the reward is split immediately among active miners, proportional to drill \u00d7 stake, so you are paid per discovery, not on a timer.',
  },
  {
    term: 'Credits',
    meaning:
      'Your claimable in-game mining balance. Spend them to deflect meteors, or claim them out to your wallet as real $ASTROID.',
  },
  {
    term: 'Claim',
    meaning:
      'Move your credits on-chain: the gateway bridges them to Astroid Creds, then your wallet signs one atomic swap to receive real $ASTROID. Credits only leave once it confirms, so nothing is lost mid-claim.',
  },
  {
    term: 'Treasury (raid vault)',
    meaning:
      'A persistent pot each asteroid builds up from mining and from deflected meteors. It is what raiders try to steal and what defenders protect.',
  },
  {
    term: 'Home station',
    meaning:
      'The asteroid you\u2019ve declared as your base. Raids launch from here; defense rallies happen here.',
  },
  {
    term: 'Expedition / Raid',
    meaning:
      'A timed PvP attack from your home to another asteroid for its treasury. An optional wager (max 20% of your home stake) is forfeited if you lose.',
  },
  {
    term: 'Rally',
    meaning:
      'A defensive pulse: spend stake to harden an asteroid you hold against incoming raids.',
  },
  {
    term: 'Meteor strike',
    meaning:
      'A random event that streaks toward an asteroid. If it lands it skims a cut of the treasury and dents yield for a while. Pay credits to deflect it; the cost is added to the treasury.',
  },
  {
    term: 'Navigation guide',
    meaning:
      'The collapsible HUD rail listing your home, the asteroids you mine, and an "Active raids" section. Click any row to jump to that asteroid.',
  },
  {
    term: 'Share card',
    meaning:
      'A branded PNL image of your mining run or a raid outcome, generated in one click to download or post.',
  },
  {
    term: 'Syndicate',
    meaning:
      'When several miners cluster on the same asteroid, they form a syndicate. Discoveries get richer, but the slice per wallet shrinks.',
  },
];

function Glossary() {
  return (
    <section className="mb-16">
      <div className="section-divider mb-8">Glossary</div>
      <dl className="grid gap-4 sm:grid-cols-2">
        {TERMS.map((t) => (
          <div className="glass-panel p-5" key={t.term}>
            <dt className="mb-1 font-display text-base font-semibold text-white">{t.term}</dt>
            <dd className="text-sm leading-relaxed text-white/65">{t.meaning}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Troubleshooting                                                            */
/* -------------------------------------------------------------------------- */

interface Trouble {
  symptom: string;
  fix: string;
}

const TROUBLES: Trouble[] = [
  {
    symptom: 'The arena says "Sign in to mine" even though my wallet is connected.',
    fix: 'The arena needs the Club gate to pass first. Head back to the home page and click Verify; once you see "Welcome, traveller" you can re-enter the arena.',
  },
  {
    symptom: 'I clicked Verify and it said I do not hold enough $ASTROID.',
    fix: 'Check the wallet you signed in with is the one holding tokens. The gate is read-only. We never move your tokens. If you topped up after signing in, give it a moment for the on-chain hold-time check to recount.',
  },
  {
    symptom: 'The wallet modal does not show my wallet.',
    fix: 'Astroid Club is Solana-only. Phantom, Solflare, and Backpack are supported. EVM-only wallets like MetaMask are intentionally not listed.',
  },
  {
    symptom: 'I clicked Mine but nothing seems to be happening.',
    fix: 'Mining is a slow accumulator. The discovery timer ticks down over minutes, not seconds. Watch the asteroid\u2019s "Discoveries" counter in the HUD. Stake more to speed up your share when a discovery lands.',
  },
  {
    symptom: 'Numbers in the HUD froze.',
    fix: 'The HUD polls every few seconds; refresh the page if you suspect a stuck connection. The session is ephemeral. Re-signing in is fast and never costs anything.',
  },
];

function Troubleshooting() {
  return (
    <section className="mb-16">
      <div className="section-divider mb-8">If something goes wrong</div>
      <div className="space-y-3">
        {TROUBLES.map((t) => (
          <details
            className="glass-panel group cursor-pointer p-5 transition hover:border-white/15"
            key={t.symptom}
          >
            <summary className="list-none font-display text-base font-medium text-white">
              <span className="mr-2 inline-block transition group-open:rotate-90 text-cosmos">
                ›
              </span>
              {t.symptom}
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-white/65">{t.fix}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Footer CTA                                                                 */
/* -------------------------------------------------------------------------- */

function FooterCTA() {
  return (
    <section className="glass-panel-bright mt-12 p-6 text-center">
      <p className="eyebrow mb-3">Ready</p>
      <h2 className="mb-3 font-display text-2xl font-semibold text-white">
        A door is about to open.
      </h2>
      <p className="mx-auto mb-5 max-w-md text-sm leading-relaxed text-white/65">
        The mining arena is in playtest. Every action is reversible while we tune the curves;
        nothing you see commits real assets yet.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Link className="btn-primary" href="/arena">
          Enter the arena
        </Link>
        <Link className="btn-secondary" href="/console">
          Open the test console
        </Link>
      </div>
    </section>
  );
}
