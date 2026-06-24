# How to play Astroid Club

A plain-English walkthrough of the asteroid-mining arena. Read this once, play forever.

The interactive version of this doc lives at [`/how-to-play`](https://astroid.club/how-to-play) inside the app.

---

## TL;DR

Mine asteroids. Stake to scale. Raid for the prize pot.

You pick a home asteroid, mine it for resources, stake `$ASTROID` to multiply your share of discoveries, and (optionally) launch raids on rival asteroids. Every action is one click and one wallet signature; no gas until the chain switch ships.

---

## Prerequisites

- A Solana wallet you control: **Phantom**, **Solflare**, or **Backpack**.
- Some `$ASTROID` in that wallet, held continuously for the configured hold-time window. The gate enforces this read-only. Nothing is ever moved or staked just to enter.

EVM-only wallets like MetaMask are intentionally not supported. Astroid Club is Solana-only.

---

## The five-step loop

### 1. Sign in with your Solana wallet

Click **Connect your wallet** on the arena door. Sign the one-line message that pops up; this proves you control the wallet without moving anything. The Club gate then verifies you hold enough `$ASTROID` and have held it long enough.

> **Tip:** If you just bought `$ASTROID`, the gate may ask you to wait through the configured hold-time window before re-checking. The check is read-only; your tokens never move.

### 2. Pick a home asteroid

When the arena loads, drag to look around the belt and scroll to zoom. Click any asteroid; an action panel slides up from the bottom. Click **Set as home**.

Your home is your base of operations: it is where raids launch from, and where defense rallies trigger if you are attacked.

> **Tip:** Resource colour tells you what flows out of the rock: yellow is gold (rare and slow), grey is silver (steady), brown-orange is oil (high volume), and black is carbonaceous (the workhorse).

### 3. Start mining

Click any asteroid (your home or another) and hit **Mine here**. Your miner moves to that rock. As long as you are mining, you contribute drill power to the asteroid. When the asteroid hits its discovery threshold, every active miner shares the find proportional to drill × stake.

> **Tip:** You can change asteroids at any time. **Leave** returns your miner to free-roam; **Mine here** on a different rock relocates instantly.

### 4. Stake to multiply your share

Set a stake amount in the action panel and click **Stake**. Staked `$ASTROID` multiplies your share of discoveries at that asteroid. Bigger stake, bigger slice, but stake is locked to that asteroid until you unstake, so think before you commit.

Yields accumulate as **Pending yield** in the HUD. Claim them any time; nothing expires.

### 5. Raid (optional, high risk)

From your home asteroid you can launch a raid against any other asteroid. Click the target rock, click **Raid**, and a timed expedition begins.

- If your raid resolves before the target's defenders rally, you walk away with a slice of their pending pot.
- If it fails, your wager is forfeited to the defenders.

Raids are PvP. Defenders can spend tokens on a **Rally defense** pulse to harden their asteroid. Newcomers should mine and stake quietly for a few days before opening this can.

---

## Controls cheatsheet

| Button          | What it does                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------- |
| **Mine here**   | Move your miner to the selected asteroid and start contributing drill power.                   |
| **Leave**       | Stop mining and free-roam.                                                                     |
| **Set as home** | Mark this asteroid as your base. Raids launch from here; defense rallies trigger here.         |
| **Stake**       | Lock the input amount of `$ASTROID` at this asteroid to multiply your discovery share.         |
| **Set drill**   | Tell the engine your current drill power. Higher drill = bigger contribution per tick.         |
| **Raid**        | Launch a timed expedition from your home against this asteroid. PvP only. Expect counter-fire. |

Drag the canvas to look around. Scroll to zoom. Click any asteroid to bring up its action panel.

---

## Glossary

| Term                  | Meaning                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Drill power**       | Your contribution rate at the asteroid you are mining. Higher drill closes the discovery timer faster and earns a bigger slice of each find.                 |
| **Stake**             | In-game `$ASTROID` you have locked to a specific asteroid. Multiplies your share of that asteroid's discoveries until you unstake.                           |
| **Discovery**         | When an asteroid's timer fills it produces a payout pot. Active miners share the pot proportional to drill × stake.                                          |
| **Pending yield**     | Discoveries that have flowed to your wallet but not yet been claimed. Click **Claim yield** any time.                                                        |
| **Home station**      | The asteroid you've declared as your base. Raids launch from here; defense rallies happen here.                                                              |
| **Expedition / Raid** | Timed PvP attack from your home to another asteroid. If it lands first you take a slice of the target's pot; if it fails, your wager is forfeited.           |
| **Rally**             | A defensive pulse defenders can spend tokens on to harden their asteroid against incoming raids.                                                             |
| **Syndicate**         | When several miners cluster on the same asteroid, they form a syndicate. The timer accelerates and discoveries get richer, but the slice per wallet shrinks. |

---

## If something goes wrong

### "Sign in to mine" even though my wallet is connected

The arena needs the Club gate to pass first. Head back to the home page and click **Verify**; once you see "Welcome, traveller" you can re-enter the arena.

### "You do not hold enough $ASTROID"

Check the wallet you signed in with is actually the one holding tokens. The gate is read-only. We never move your tokens. If you topped up after signing in, wait a moment for the on-chain hold-time check to recount.

### My wallet is not in the modal

Astroid Club is Solana-only. Phantom, Solflare, and Backpack are supported. EVM-only wallets like MetaMask are intentionally not listed.

### I clicked Mine but nothing seems to be happening

Mining is a slow accumulator. The discovery timer ticks over minutes, not seconds. Watch the asteroid's **Discoveries** counter in the HUD. Stake more to speed up your share when a discovery lands.

### Numbers in the HUD froze

The HUD polls every 15 seconds; refresh the page if you suspect a stuck connection. The session is ephemeral. Re-signing in is fast and never costs anything.

---

## Compliance posture

This document and the playtest it describes are informational. Nothing here is investment advice, a solicitation, an offer, or a promise of yield, prizes, profit, or distributions. In-game balances and behaviours are part of a playtest and may reset between releases. The chain switch is gated behind a feature flag (`CHAIN_ENABLED=false` by default); until it is flipped, no real-asset transfers occur.

If you have questions about how the Club works, the open-source code is the source of truth: <https://github.com/HeartOfMidgar/Astroid-miner>.
