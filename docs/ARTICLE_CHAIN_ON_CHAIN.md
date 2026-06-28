# A Chain on a Chain: Inside the Economy of Astroid.club

### How a real-time mining game became an app-specific economic layer that settles to Solana

> Draft for X / long-form. Polish freely. Accuracy notes are at the bottom — delete that section before publishing.

---

When you build a game on a blockchain, the lazy version is obvious: mint a token, slap "play-to-earn" on it, and let an emissions schedule do the talking until the chart bleeds out. We went a different direction, and somewhere along the way I realized what we'd actually built.

It's a chain on a chain.

Astroid.club runs two economies stacked on top of each other. Underneath is **Solana** — where `$ASTROID` lives, where staking is custodied by an audited protocol, where wagers are escrowed and burns are real. On top is a **live, tick-driven game economy** that mints and destroys its own credits every few seconds as players mine, raid, and defend asteroids. The two are not loosely associated. The upper economy's *entire money supply is pegged to the lower one's treasury*, and it settles down to L1 on demand. It behaves less like a game with a token bolted on and more like an application-specific economic layer with periodic settlement to a base chain.

Here's how the whole machine works, and why it's designed the way it is.

## The two-token model

The base asset is `$ASTROID`, a normal SPL token. It's what you stake, what you must hold to get in, and what everything ultimately redeems into.

But a game can't pay out a scarce L1 token on every dice roll — the fees and latency alone would kill it. So the in-game unit is **Astroid Creds (ASTROCRED)**: a second SPL token, cheap to mint, that the game issues for mining and raid rewards. Creds are redeemable back into `$ASTROID` through an on-chain bridge. We deliberately kept mint authority on the treasury — not to print freely, but to manage supply the way USDC or USDT manage theirs: minting against reserves, burning when redeemed.

So the mental model is: **`$ASTROID` is the reserve asset; Creds are the circulating medium; the treasury is the central bank.** And like any sound central bank, it has a hard rule about how much it can issue.

## The solvency engine (the part I'm proudest of)

Every Cred the game pays out is a redeemable claim on the treasury. If the game mints faster than the treasury can back, you get the same death spiral every emissions token eventually hits.

So issuance isn't on a fixed schedule — it's **governed against live reserves**. A poller reads the treasury's on-chain `$ASTROID` balance every two minutes and exposes 80% of it as the issuance budget. Two throttles then sit in front of every reward:

- A **backing taper**: rewards flow at full rate until outstanding credit liability reaches 75% of the budget, then scale linearly down to zero as liability approaches 100%.
- A **daily cap**: a hard ceiling of 250,000 Creds per rolling 24 hours, regardless of activity.

The stricter of the two wins. And critically, **redemptions free up headroom** — when players cash Creds back into `$ASTROID`, the liability drops and the system can breathe again. It's not a fixed cliff; it's a feedback loop that keeps circulating supply solvent against real reserves as the player base grows. The economy can only ever owe what the treasury can actually pay.

That single design choice — pegging in-game issuance to an on-chain balance — is the seam where the two chains fuse.

## Mining: probability, not a payslip

You join an asteroid and report your drill power. Because the client reports that number, the server can't trust it — there's no proof-of-work here. So drill power is **clamped to what your stake earns you**: a free baseline plus one unit per staked token, then multiplied by your tier. Self-reported nine-figure drill numbers get snapped back to what you've actually committed. (This is why a legitimately huge staker can show millions of effective drill — it's earned, not spoofed — and why we later had to cap its effect in combat.)

Discoveries themselves are a **sweepstakes, not a clock**. Each tick is a memoryless roll: more total drill on an asteroid raises the *expected* find rate, but any individual hit can come early or late. When a discovery lands, the finder is chosen at random *weighted by drill share*, and every active miner earns a proportional cut. It feels alive because it is variance, not a metronome.

When yield is created, it's sized by a base value, the resource type, the specific asteroid, and a ±20% variance roll — then run through the solvency governor above, and only then split:

- **20% to the asteroid's vault** — a persistent, raidable treasury that only grows from discoveries and only shrinks when someone takes it.
- **80% to the miners**, by drill share, with a 20% finder's bonus on top of the triggerer's slice.

That vault matters, because it's what turns mining into a target.

## Staking is a buff, not a yield product — and it's alive

This is worth being blunt about, because the space has trained people to assume otherwise: **staking on Astroid.club pays no interest and promises no return.** Tokens are staked into **Quarry**, an audited third-party protocol — the Club never takes custody, and you can withdraw any time. We lean on Quarry's audited custody specifically so we're not rolling our own staking program and inheriting that risk surface.

What staking buys is **gameplay leverage**, through five tiers:

- Bronze (~$50): 1.5× drill, 1.2× defense
- Silver (~$100): 2.0× / 1.5×
- Gold (~$200): 2.5× / 1.8×
- Diamond (~$400): 3.0× / 2.0×

Now here's the part that makes the ladder feel alive: **those tiers are pegged to a dollar value, not a fixed token count, and they rebalance themselves in real time.** A live Jupiter price feed converts each dollar target into a token requirement on every read. So the requirement breathes with the market:

- **Market cap up → the token requirement falls.** Your tokens are worth more, so it takes fewer of them to hold your tier.
- **Market cap down → the token requirement rises.** Each token carries less value, so the ladder asks for more.

The *dollar cost of status* stays constant while the underlying token math counter-cyclically rebalances itself — automatically, every price tick, with no admin intervention. A fixed-token ladder rots the instant price moves: at the wrong price, a few dollars buys Diamond, or Diamond becomes unreachable. Pegging the cost to dollars keeps every tier's commitment honest forever, and turns the staking ladder into something that genuinely reacts to the market it lives in. It's as if it's alive.

## The PvP economy: raids, burns, and a deliberate house edge

Asteroid vaults are stealable. You launch an **expedition** from your home station at a target, optionally with others pooling power. Resolution is a single, transparent inequality:

```
attackPower = drill-term × 0.5 + stake × 0.1
attackers win  ⟺  attackPower > defensePower × 1.2
```

Defenders get a built-in 20% advantage — raids should require real overmatch, not a coin flip. Win, and you steal between 10% and 30% of the vault, scaling with how badly you outgunned the defense. The target takes a temporary debuff; you split the loot. Hold the line, and the asteroid earns a short **raid-immunity window** — 30 minutes by default — plus a drill-power boost that lingers for a full hour after immunity lifts, so a fresh defender keeps a combat edge even once the asteroid is back in the raid pool. The window is short on purpose: long enough to reward a successful defense, brief enough that a contested asteroid keeps drawing attackers rather than going dormant.

Two design details make the combat economy interesting rather than degenerate:

**The whale soft cap.** Because a large stake can legitimately produce enormous effective drill, an uncapped attack term let the biggest wallets faceroll every raid. So above a five-million soft cap, additional drill contributes to *attack* at only 0.15×. Whales stay the strongest force in the game — they just stop being unbeatable. Staking remains lucrative; it stops being tyrannical.

**Bets that burn — and bets that feed the map.** You can attach a wager (capped at 20% of your stake) to a raid. Lose, and the forfeit splits three ways: **40% is burned, 40% recirculates into *other* asteroids' vaults as fresh stealable bounty, and 20% is paid to the successful defenders**, weighted by their contribution. The burn is permanent deflation tied directly to PvP activity; the recirculation keeps forfeited value *in play* — a lost raid literally funds the next one somewhere else on the map — and the defender cut rewards the players who actually showed up to hold the line. (We moved off a flat 90% burn deliberately: as whale stakes pushed wager sizes up, torching 90% of every large bet was needlessly destructive. The split — 40/40/20 by default — is a tunable protocol parameter.) When wagers run on-chain, all three legs are real: a real SPL burn, a real transfer to the treasury that backs the vaults, and real transfers to defenders, settled through a treasury-custodied escrow with strict deposit verification (it checks the exact amount credited, who paid it, and that the deposit can't be replayed onto a different raid) and a restart-safe settlement outbox so the legs always sum back to the wager. There's even a deflationary nicety: when the escrow has to front rent for a new token account, it burns the equivalent in `$ASTROID` — but only ever from surplus above outstanding wager liability, never from funds backing live bets.

Layered on top: **rally defense** (burn staked tokens for a temporary, stacking defense buff — a panic button, not a shield), **meteors** (a 4%-per-tick PvE threat with a 90-second warning that you pay Creds to deflect, or eat a vault skim and a yield penalty), and a **syndicate** system in the engine for guild-coordinated raids with shared treasuries. Every one of these is either a sink, a burn, or a redistribution of *existing* value — not fresh emission.

## Getting in: a holder gate that flash loans can't beat

Access itself is on-chain-gated. To enter the arena you must hold enough `$ASTROID` *and hold it long enough*. The threshold can be pegged to a SOL value so the entry cost stays stable as price moves, and the hold-time check is explicitly flash-loan-resistant: the first time a wallet appears above the threshold it is **denied**, and any dip below the line **wipes its history**. You cannot borrow tokens for a single block and walk in. Real holders, real duration.

## The kill switch underneath it all

For all the on-chain machinery, the entire game runs behind a single master switch. With chain integration off, every on-chain side effect becomes a no-op and the whole economy runs in pure memory — which means we can develop, test, and simulate the full system without touching mainnet, then flip it live without a code change. The settlement layer is composable, not load-bearing for the game to function. That's how you ship a chain-backed game without praying every deploy.

## This is the first test of the ecosystem

Everything above is the *first* version — a deliberate, controlled test of the ecosystem, not the destination. The priority right now is narrow and unglamorous: **prove the in-game mechanics function exactly as intended** under real conditions. Does the solvency governor hold issuance to reserves? Do raids redistribute value without runaway inflation? Do the burns and sinks actually bite? Do the dynamic tiers track the market the way the math says they should? You earn the right to decentralize by first demonstrating the economy is sound.

That's why mining is **server-coordinated today**. The server validates drill power, runs the discovery tick, and enforces the economic rules — not because that's the end state, but because it lets us observe, tune, and harden the whole loop safely while the numbers are still being proven. It's the training-wheels phase by design.

The trajectory from here is **progressive decentralization**:

- **From server to swarm.** Move mining from a server-side configuration toward a **CPU- and mobile-based client model** — real distributed participation, where the work and the validation live with the players rather than a central tick.
- **From managed to renounced.** The current model intentionally retains controls (managed supply, server-enforced rules) so we can correct course during the test. As the mechanics stabilize and prove out, those controls get handed to the chain — moving toward **relinquished protocol authorities and a fully decentralized model** where the rules run without us.
- **From test to scale.** Each layer that proves itself becomes permanent infrastructure to build the next on top of. We scale the ecosystem out as the foundation earns trust, not before.

So treat this as the genesis configuration: an honest, observable first run of a self-contained economy, with a clear path to handing it over to the people who play it.

## Why "a chain on a chain" is the right frame

Step back and the architecture rhymes with something familiar. There's a base layer that provides scarce assets, custody, and final settlement. There's an execution layer on top that runs fast, mints and burns its own unit of account, and maintains its own state — but whose money supply is *anchored to the base layer's reserves* and *settles back down* whenever a user wants out.

That's not a metaphor I reached for. It's what the code does. The emission governor is a monetary policy pegged to an on-chain balance. The Creds bridge is a settlement function. The staking ladder is a counter-cyclical, market-reactive pricing curve. The holder gate is sybil-and-flash-resistant access control. The raid burns are deflation tied to real activity. The treasury is a reserve.

We set out to build a game about mining asteroids. What we ended up with is a small, self-contained economy with its own central bank, its own circulating currency, its own deflationary sinks, its own market-reactive pricing, and its own bridge to the chain underneath — all running in real time, all solvent by construction.

A chain on a chain. It turns out that's a surprisingly good way to build a game economy that's meant to last.

---

## Accuracy notes (delete before publishing)

These keep the piece defensible if anyone reads the repo:

- **Live and verified:** the solvency governor (budget = 80% of treasury balance; 250k/day cap; full rate until 75% of budget, then linear taper), the drill clamp (free baseline + 1/staked token), the USD-pegged + price-recomputed staking tiers, the 20/80 vault/miner split + 20% finder bonus, the 1.2× defender edge, the 10–30% steal band, the 5,000,000 / 0.15 whale soft cap, the 90/10 bet burn-vs-defenders split, the on-chain escrow deposit gates + surplus-only rent burn, and the flash-loan-resistant holder gate.
- **Dynamic tiers direction:** tiers are pegged to USD, so token requirement = tierUSD ÷ live price. Since supply is fixed, price and market cap move together — MC up lowers the token requirement, MC down raises it. Accurate as written.
- **Framed carefully on purpose:** syndicates are described as "in the engine" (implemented + tested, but coordinated syndicate-raid auto-resolution isn't wired into the live world tick yet — only solo expeditions auto-resolve). The asteroid **vault** is described rather than the legacy hourly "refinery" pool (production runs vault mode; the UI's `refineryBalance` actually shows the vault).
- **Deliberately not asserted as live:** specific Solar Flare / Stellar Strike jackpot multipliers — those helpers exist but aren't confirmed wired into the live yield path, so the article only refers to resource-class "variance/spice" in general terms.
- **Forward-looking (roadmap, not current state):** the "first test of the ecosystem" section is explicitly vision. Keep these honest:
  - **Server vs. client mining:** today mining is server-coordinated (client reports drill power, server validates + runs the tick). CPU/mobile client-side mining is a genuine architectural shift, framed as trajectory — not a current capability.
  - **Retained vs. renounced authority:** the body of the article (correctly) says mint authority is *retained now* for managed supply. The roadmap says those controls are *relinquished as the model proves out*. Always keep the "now vs. eventually" distinction explicit so the two statements don't read as contradictory.
  - **"Renounce" wording:** there's no custom Anchor program owned by this repo (staking is delegated to Quarry; the token is standard SPL), so "renounce" precisely means relinquishing the treasury's retained mint/update authorities and moving rule-enforcement on-chain — hence the phrasing "relinquished protocol authorities" rather than "renounced contracts."
