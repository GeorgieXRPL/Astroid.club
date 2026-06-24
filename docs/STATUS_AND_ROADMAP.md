# astroid.club — Status & Roadmap

_Last updated: 2026-06-16_

A single source-of-truth for **what is built and live**, **known issues**, and
**what remains** (including the latest round of feature requests). Companion to
`GAME_DESIGN.md` (mechanics spec) and `ARCHITECTURE.md` (systems map).

---

## 1. What we have achieved (shipped & live)

### Core game loop

- **Server-authoritative, time-based mining.** Mining is resolved entirely
  server-side on the world tick (~60s) — there is no client CPU/GPU proof-of-work.
  A client only reports a `drillPower` number; the server applies stake-tier
  multipliers and computes discoveries. (CPU/phone mining is a _future_ phase,
  see roadmap.)
- **Asteroid network.** Multiple named asteroids, each with a resource class
  (carbon / silver / gold / oil) and a cosmetic mineral "flavor". Players
  `join` an asteroid to mine it and set a `home station`.
- **Share-based discovery payouts (per-discovery drip).** When a discovery
  resolves, a `RAID_VAULT_PERCENT` cut (default 20%) goes to the asteroid's
  persistent **raid vault** and the remainder (~80%) is paid to active miners
  **per-discovery**, weighted by drill-power-seconds × stake tier × loyalty ×
  time-active. There is no hourly pool to drain (the old "treasury reset").

### Economy & rewards

- **In-game IOU credit ledger.** Mining rewards accrue as `pendingYield`
  (claimable IOU credits), with a persistent **lifetime accumulator**
  (`lifetimeEarned` / `lifetimeRedeemed`) seeded from Postgres `yield_events`, so
  a claim never erases the record of what was earned.
- **On-chain claim pipeline (bridge → redeem).** Two steps: a server-signed
  **bridge** (in-game credits → IOU-ASTROID in the wallet, debited up front and
  refunded on failure) and a user-signed **atomic redeem swap** (IOU-ASTROID →
  $ASTROID). Includes a **"Finish claim" recovery** for when the redeem step
  didn't complete (rewards sit safely as IOU-ASTROID; one click finishes them).
- **Treasury-aware emission governor.** Caps reward issuance with a global daily
  cap and a taper as outstanding liability approaches the configured backing
  budget. Tunable via `EMISSION_BUDGET`, `EMISSION_DAILY_CAP`,
  `EMISSION_TAPER_FRACTION`, `YIELD_BASE_PER_DISCOVERY`.
- **On-chain staking (Quarry).** Stake/unstake $ASTROID via the Quarry protocol;
  stake tiers grant drill-power multipliers and defense buffs. On-chain stake is
  reconciled into in-game mechanics + UI.

### Raids (PvP)

- **Full raid loop.** Expeditions launch against a target asteroid, resolve on
  the world tick (on a discovery at the target, or at expiry), can **steal a
  capped fraction of the target's treasury**, escrow optional bets, credit
  winnings/spoils to attacker pending yield, and broadcast
  `raid_started` / `raid_resolved` events to clients.
- **Arena raid UI.** Wager input, recall/leave, rally defense, inbound-raid
  indicators, and a live raid feed.
- **Admin raids panels.** Active raids (attacker, party, target, attack vs.
  defense, bet, ETA) and recent raid outcomes (breached/defended, stolen, when).

### Platform & integrity

- **Anti-cheat.** Per-wallet rate limiting with exponential backoff, sybil/IP
  flagging, and suspicious-activity logging. **Benign business-rule failures no
  longer accrue backoff** (a recent fix — they used to lock players out of
  unrelated actions like claiming).
- **Drill-power hardening.** Over-cap drill reports are **clamped** (not
  rejected) at the protocol boundary and again server-side.
- **Admin console.** Gateway-served, token-authenticated, read-only dashboard:
  server health, asteroids (miners, drill, stake, treasury, defense, stealable),
  players (per-wallet drill/stake/credit/loyalty), economy + emission health,
  raids, and a live filterable server log.

### Client / 3D

- **3D arena** (React Three Fiber): orbiting noise-displaced asteroid bodies,
  a 1,500-rock background belt, starfield, ACES tone-mapping + bloom, with a 2D
  fallback for machines without WebGL.
- **HUD**: connection/identity panel, mining-rewards accumulator, claim/finish
  controls, asteroid action panel (mine, stake, set drill, raid, rally), raid feed.

### Ops

- Gateway deploys to **Fly** (`astroid-club-gw`), shell to **Vercel**.
- Postgres-backed persistence with Redis/memory fallbacks.

---

## 2. Known issues & clarifications

### "The treasury resets without anyone stealing it"

**This is expected behavior of the current design, not a theft bug — but the UX
is misleading.** The asteroid "treasury" we expose to raiders is the **refinery
pool**, which serves double duty:

1. It **accumulates** the 30% refinery share from every discovery (✅ yes, it is
   still accumulating as people mine — confirmed in `addToRefinery`).
2. It is **also the hourly payout pool**: every distribution interval the
   `DistributionService` pays the accumulated balance out to that asteroid's
   active miners and resets `pendingDistribution` to 0 (`distributeRefinery`).

So the number raiders see climbs for up to an hour, then drops to ~0 when the
hourly distribution fires — which reads as "the treasury reset." **Decision
needed** on the treasury model (see roadmap §3.1) before the meteor mechanic
(§3.2), because meteors are specified to "reduce current rewards by a %" and need
a well-defined pool to act on.

---

## 3. Roadmap — what's left (this request)

Ordered by dependency. Items marked **[decision]** need a product call before
implementation.

### 3.1 True raidable treasury — DONE (shipped)

Implemented model (combines "separate vault" + "pay miners per discovery"):

- **Pay active miners per-discovery (drip).** The former 30% hourly refinery
  batch is folded into the per-discovery share distribution (miners now get
  ~92% of each discovery, weighted by share). **Removes the "treasury reset"** —
  no held pool drains hourly. The legacy refinery/hourly path remains in the
  codebase but is no longer fed by discoveries.
- **Separate, persistent raid vault.** A `RAID_VAULT_PERCENT` slice (default
  **20%**, env-tunable) of each discovery is routed into a per-asteroid vault
  (`server/game/raid-vault.ts`) that is **never auto-distributed** — it only
  grows and is the sole thing raiders can steal. The "Treasury" / "Stealable"
  figures in the arena + admin now read from this vault.
- **Reserves stay safe** via the emission governor (cadence doesn't change total
  emission; the daily cap + backing taper do).
- **Pending:** deflection payments topping up the vault land with the meteor
  mechanic (§3.2).

Files: `raid-vault.ts` (new), `yield-orchestrator.ts` (vault-mode split),
`world.ts` (vault wiring + raid steal/treasury source), `index.ts`
(`RAID_VAULT_PERCENT` env). Covered by `tests/game/raid-vault.test.ts` and new
vault-mode cases in `tests/game/yield-orchestrator.test.ts`.

### 3.2 Idle-miner gamification: meteor strikes — DONE (shipped)

- **Mechanic (A + C).** On the world tick the `MeteorEngine`
  (`server/game/meteor-engine.ts`) rolls (default 15%/tick) to threaten a random
  eligible asteroid — favoring ones with **active miners**. On impact it skims a
  % of the asteroid's **raid vault** (default 15%) **and** applies a discovery-
  **yield penalty** (default 30% for 5min) via a registry meteor debuff the
  orchestrator multiplies in.
- **Deflection loop.** Threatened miners **pay in-game credits to deflect**
  (`deflect_meteor`); the payment is consumed and routed **straight into the raid
  vault**, so a deflected strike actively *grows* the treasury. Cost scales with
  vault size (default 10%, min 50).
- **Visuals (shipped).** A streaking meteor with a glowing tail + point light
  (`MeteorStrike.tsx`) homes on the target asteroid's live orbit position; on
  resolve it plays a cyan **shield burst** (deflected) or red **impact
  shockwave** (struck). HUD shows a **☄ deflect banner** + feed lines.
- **Server.** Deterministic engine (injected RNG/clock); `meteor_incoming` /
  `meteor_resolved` broadcasts; admin "Incoming meteors" + "Recent meteor
  outcomes" panels. Tuning via `meteor` world config.
- Covered by `tests/game/meteor-engine.test.ts` + world-integration cases.

### 3.3 Navigation guide UI — DONE (shipped)

A clickable left-rail list (`shell/components/arena/NavRail.tsx`):

- Lists the **home** planet, the **actively-mined** planet, every planet with
  **active miners**, and any planet **under threat**; clicking a row
  focuses/selects it in the 3D scene.
- Doubles as the **notification surface**: per-row live badges for miners (⛏),
  **inbound raids** (⚔ N), and **incoming meteors** (☄), driven off
  `network_stats` + the live raid/meteor events. Threatened rows float to the
  top and pulse.
- Desktop-first (hidden on the smallest screens); scrolls past ~70vh so it
  scales as the fleet grows.

**Arena mobile polish:** the identity + network panels use viewport-relative
widths so they no longer collide on phones; the identity panel is **collapsible**
(auto-collapsed under 640px to reclaim space); and the tall global **footer is
hidden on `/arena`** (`shell/components/chrome-visibility.tsx`) so it doesn't get
in the way of the immersive scene. The bottom **action panel is now a
size-capped, scrollable bottom sheet** (pinned via `mt-auto` inside a `flex-1`
overflow region) so it can never spill past the viewport and clip its buttons,
and its 8-box **stat grid collapses** (auto-collapsed on mobile) so the 3D scene
stays visible behind it.

### 3.4 Shareable "PNL" cards — Phase 1 DONE

Click-to-generate, shareable cards for raid reports and mining runs.

**Phase 1 (shipped):** fully client-side. `shell/lib/share-card.ts` renders a
branded 1200×630 card to an offscreen `<canvas>` (deep-space gradient, starfield,
brand lockup, the Astroid mascot, a hero stat + key/value rows, `astroid.club`
footer) and exports it as a PNG. The card opens in a **preview modal**
(`shell/components/arena/ShareCardModal.tsx`) where the player explicitly chooses
to **copy**, **download**, or **share to X** (no surprise auto-download). Helper
functions `downloadCard` / `copyCard` / `openShareIntent` back the buttons.
Wired into the arena:

- **"Share my run"** in the identity panel → a mining PNL card ($ASTROID earned,
  claimable, staked, claimed, loyalty) built by `minerCardSpec`.
- **"Share raid"** in the raid feed → a raid-outcome card (looted vs. repelled,
  target, stake risked) built by `raidCardSpec`. The client attributes a
  broadcast `raid_resolved` to the player by matching the asteroid it launched
  against (`pendingMyRaid` ref), so the button only appears for your own raids.

**Phase 2 (shipped):** server-rendered OG images so shared links unfurl with the
preview. `shell/app/share/og/route.tsx` re-renders the card with `next/og`
(Satori, edge runtime) from query params decoded by `decodeShareParams`;
`shell/app/share/page.tsx` sets the Open Graph / Twitter metadata pointing at
that image and shows the card + an "Enter the arena" CTA. The arena's "Share to
X" now links to a `/share?…` URL (built via `encodeShareParams`) so the post
unfurls automatically — copy/download remain for inline attachment. The OG image
uses the transparent mascot (`/mascot-rocket.png`) since Satori can't composite-
key the card art's black background.

_Future hooks: contest/giveaway tracking, NFT minting of standout cards._

### 3.5 Branding & rocket flythrough — DONE (first pass)

- **Brand lockup** is now a reusable component (`shell/components/BrandMark.tsx`):
  the "blue dwarf" disc glyph + `ASTROID` wordmark, matching the site header /
  favicon visual language. The app shell already brands every route via the
  layout header; the arena now also carries a subtle, clickable brand watermark
  (bottom-left, sm+).
- **Mascot flythrough** (`shell/components/arena/RocketFlythrough.tsx`): Astroid —
  the dog mascot riding his rocket — flies a bowed quadratic bezier between two
  named asteroids on a timer, then rests off-screen before the next trip. The
  play: the mascot ("Astroid") mines asteroids with $ASTROID, so he drifts
  planet-to-planet across the belt. Rendered as a camera-facing billboard sprite
  of the mascot art (`shell/public/mascot-rocket.png`, background removed),
  horizontally flipped so the nose always leads travel. Endpoints track each
  asteroid's live orbit position (same pure motion `AsteroidBody` uses) so he
  genuinely flies "from planet to planet". Wired into `Arena.tsx`.
  _To iterate: tune size/cadence, or add a faint trail ribbon. Pending a
  screenshot check on the live deploy._

### 3.6 Asteroid visual rework — DONE (first pass)

`AsteroidBody.tsx` now builds craggy rock instead of round globs: low-frequency
asymmetric lumps (irregular potato/peanut silhouette), higher-amplitude
multi-octave surface noise, and 3–6 seeded **impact craters** (inward bowls with
raised rims) per asteroid, at `detail=5` for clean crater rims. Deterministic per
asteroid id. To iterate further, tune `bumpiness` / crater depth+count or add a
normal/roughness map. _Pending a screenshot check on the live deploy._

### 3.7 (Future) CPU/phone mining

Per the X teaser "Part 2", real device-based mining after further adjustments.
Not started; needs anti-cheat + verification design.

---

## 4. Suggested execution order

1. **§3.1 treasury model** (gates §3.2 and fixes the reported confusion).
2. **§3.6 asteroid visuals** (contained, high visual payoff, independent).
3. **§3.3 navigation + notifications rail** (foundation for alerts).
4. **§3.2 meteor strikes** (mechanic + visuals + feeds into the rail).
5. **§3.5 branding + rocket flythrough**.
6. **§3.4 shareable cards** (then contests/NFT later).
