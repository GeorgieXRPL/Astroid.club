# Game Design

Player-facing mechanics reference for `astroid.club`. This document describes how the game is **supposed to work** — the rules, formulas, and edge cases that govern asteroid mining, staking, raiding, and yield distribution.

For the canonical theme transformation that maps these concepts onto `Black-Gold`'s vocabulary, see [`GLOSSARY.md`](GLOSSARY.md). For the as-built code architecture, see [`ARCHITECTURE.md`](ARCHITECTURE.md). For the ported-file change log, see [`PORTING_NOTES.md`](PORTING_NOTES.md).

---

## TL;DR

- Players **mine asteroids** by joining one and reporting their drill power.
- They **stake `$ASTROID`** at the asteroid to multiply their drill power and qualify for tiered defense bonuses.
- The asteroid's **refinery** accumulates a fraction of every discovery as a yield pool that is distributed proportionally to the contributing miners.
- Players can **raid** other asteroids on **expeditions**, optionally with a **bet** that's burned if they lose. Raids resolve based on attack power vs. defender power; defenders enjoy a **1.2× advantage**.
- **Syndicates** let players coordinate multi-attacker raids and split the loot via a configurable treasury fraction.
- **Anti-cheat** rate-limits actions and detects sybil clusters; **holder verification** with **flash-loan mitigation** gates the `$ASTROID`-holder perks (e.g. poker freerolls) so flash-borrowers can't slip in.
- The whole economy runs in pure-memory mode by default. Flipping `CHAIN_ENABLED=true` activates SPL transfers without a code change.

---

## 1. Asteroids

Asteroids are the unit of place. Every asteroid has a stable `id`, a `name`, a `sector` (UI grouping), a position on the star map, a base discovery time, a base reward multiplier, and one of four **resource types**:

| Resource (internal) | Display name (suggested)        | Discovery time | Special ability                                                     | Spice                                                  |
| ------------------- | ------------------------------- | -------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| `carbon`            | Carbonaceous (e.g. Bennu-class) | 5 min          | **Steady Drill** — +10% loyalty bonus after 7 days at this asteroid | none                                                   |
| `silver`            | Speculative (e.g. Vesta-class)  | 8 min          | **Speculation** — high-variance yields                              | **Solar Flare** — random 0.5× to 2.0× yield multiplier |
| `oil`               | Volatiles (e.g. Themis-class)   | 10 min         | **Syndicate** — yields scale with miner count, up to 3× at 50+      | none                                                   |
| `gold`              | Strike (e.g. Psyche-class)      | 20 min         | **Stellar Strike** — random ~5% jackpot multiplier per discovery    | **Stellar Strike** itself                              |

The internal symbol names (`carbon`, `silver`, `oil`, `gold`) drive the mechanics, and the underlying economy values are preserved from the audited balance. Player-visible display strings ("Carbonaceous", "Speculative", …) are chosen by the frontend; the server doesn't care.

The 20 canonical asteroids are TBD — the design pass will name and place them deliberately. The system boots with an empty asteroid list and accepts dynamic registration via admin tooling (forthcoming).

---

## 2. Mining

### 2.1 Joining

A player **connects** (signs a wallet auth message), then **joins** an asteroid. Each player can be at exactly one asteroid at a time; joining a new one moves them. Players must join an asteroid before they can report drill power.

### 2.2 Drill power

Drill power is the per-player mining throughput. The client reports a base value (`drillPower`); the server computes the **effective drill power** by applying:

1. The player's **stake-tier multiplier** at this asteroid.
2. The **carbon loyalty bonus** if the asteroid is `carbon`-class and the player's loyalty days at this asteroid is ≥ 7.

```
effectiveDrill = baseDrill × stakeTierMultiplier × loyaltyBonus
```

Concretely:

```
calculateEffectiveDrillPower(base, stake, loyaltyDays, resource)
  = base × tier(stake).drillPowerMultiplier × (resource === 'carbon' && loyaltyDays >= 7 ? 1.1 : 1.0)
```

If `base === 0`, the result is `0` regardless of multipliers. The base zero short-circuits the entire formula (no DBZ risk).

### 2.3 Stake tiers

There are five tiers. The thresholds and multipliers match `Black-Gold` v3.4.1 byte-for-byte:

| Tier    | Stake (≥) | Drill multiplier | Defense multiplier |
| ------- | --------- | ---------------- | ------------------ |
| Base    | 0         | 1.0×             | 1.0×               |
| Bronze  | 100       | 1.5×             | 1.2×               |
| Silver  | 500       | 2.0×             | 1.5×               |
| Gold    | 1,000     | 2.5×             | 1.8×               |
| Diamond | 5,000     | 3.0×             | 2.0×               |

Negative or fractional stakes fall back to Base. `Number.MAX_SAFE_INTEGER` resolves to Diamond.

> **On-chain staking (Quarry).** When `QUARRY_*` addresses are configured, staking is **on-chain and non-custodial**: the player stakes `$ASTROID` into the audited third-party [Quarry](https://github.com/QuarryProtocol/quarry) protocol via a build-and-sign flow, and the in-game `stake`/`unstake` messages are rejected (`use_onchain_staking`). The Club never takes custody of staked tokens and they are withdrawable at any time. Staking is purely a **gameplay buff** (the tier multipliers above) — there is **no promised yield, interest, or profit**. The stake-tier multipliers are driven by the player's on-chain stake position; see the reconciliation note in §11.
>
> Quarry stake is a single **global** position (not per-asteroid), so the tier a player earns applies to whichever asteroid they are actively mining/defending, rather than being split per-asteroid as in the legacy in-game model.

### 2.4 Home station

The first asteroid a player stakes at is automatically their **home station**. They gain a **1.5× defense bonus** when defending it. Home stations can be changed manually via `set_home_station`, gated by a cooldown to prevent rapid switching mid-raid.

A home station is required to start an expedition (raids must originate from a station you've claimed).

---

## 3. Discoveries and yield

Each asteroid has a **base discovery time** (5–20 min depending on resource type). When a discovery resolves at an asteroid, it produces a **yield amount** computed from:

- The asteroid's `baseRewardMultiplier`.
- The total drill-power-seconds contributed since the last discovery.
- Resource-specific spice (Solar Flare for `silver`, Stellar Strike for `gold`).

The yield is split:

- **70% to the finder** — the active miner whose drill power triggered the discovery.
- **30% to the refinery** — accumulated for the next periodic distribution.

This 70/30 split is preserved exactly from BG (`calculateYieldSplit(total) = { finderShare: floor(total*0.7), refineryShare: floor(total*0.3) }`).

### 3.1 The refinery

Each asteroid has a **refinery** — a yield accumulator that periodically distributes its balance proportionally to the miners who contributed. The distribution math:

For each contributor `c`:

```
score(c) = (c.drillPowerSeconds / totalDrillPowerSeconds)
         × c.stakeTierMultiplier
         × (1 + c.loyaltyBonus)
         × (c.timeActiveSeconds / distributionWindowSeconds)
```

The refinery balance is split proportional to `score(c) / Σ score`. Distribution requires:

- At least one contributor with positive drill-power-seconds.
- A balance ≥ `MIN_DISTRIBUTION_AMOUNT` (= 1).

If either condition is unmet, the distribution is skipped and the balance carries to the next cycle. After a successful distribution, contributor records are cleared and pending balance resets to zero.

### 3.2 Off-chain (`CHAIN_ENABLED=false`) vs on-chain

When chain is off, distributions credit each player's **pending yield** ledger via `addPendingYield`. Players bank pending yield via the `claim_yield` message. No SPL transfer happens.

When chain is on, the `DistributionService` invokes the registered `onYieldPayout` listener, which routes through `ChainOps.executeYieldPayout` (currently a stub; the SPL transfer impl lands in the `chain_yield_sink` slice).

---

## 4. Raids

### 4.1 Expeditions

A **raid** is initiated as an **expedition** from your home station to a target asteroid. The starter pays an attack-power "cost" derived from their drill power and stake:

```
attackPower = drillPower × 0.5 + stake × 0.1
```

Multiple players can **join** an existing expedition; each joiner adds their own attack power to the pool. Each player is limited to **one active expedition at a time**.

Self-raids are rejected (you can't raid your own home station).

### 4.2 Defense

Every player staked at an asteroid contributes defense power:

```
defensePower = stake × tier(stake).defenseMultiplier × (isHomeStation ? 1.5 : 1.0)
```

The asteroid's total defense is the sum across all stakers. Defenders can also **rally**, applying a temporary defense buff above the baseline (cooldown-gated).

### 4.3 Resolution

Raids resolve via a single fairness check:

```
attackersWin <=> attackPower > defensePower × 1.2
```

The 1.2× defender advantage is preserved verbatim from BG. A tied or under-1.2× attack power means the defenders win.

### 4.4 Outcomes

**Attackers win:**

- The attacker pool steals up to a capped percentage (`MAX_STEAL_PERCENT`) of the asteroid's pending discovery yield.
- Stolen yield is distributed across attackers proportional to their bet weighting (50% bet-weighted / 50% even split).
- The asteroid receives an **attack debuff** (temporary penalty to its yield).
- Bet stakes are returned in full to attackers.

**Defenders win:**

- The asteroid receives a **defense buff** — temporary **raid immunity**.
- 90% of the loser bet pool is **burned** (no on-chain side effect when chain is off; logged as a virtual burn).
- 10% of the loser bet pool is distributed to defenders, weighted by their stake at the asteroid.

Both outcomes apply cooldowns to the raid initiator (`expedition_recovery`, `expedition_start`).

### 4.5 Defense buffs and immunity

After a successful defense, the asteroid is granted **raid immunity** for a fixed window. Expedition creation against an immune asteroid is rejected. The buff expires automatically and can be cleared by admin tooling.

---

## 5. Bets

Bets are an optional spice on top of raids. A player can attach a bet (≤ 20% of their stake at the source asteroid) to an expedition. Bet semantics:

- **Locked** the moment the bet is placed (the player can't unstake the locked amount until the raid resolves).
- **Returned** in full if the attacker side wins.
- **90% burned, 10% to defenders** if the defender side wins (preserves BG's exact split).

Duplicate bets on the same raid are rejected. A player cannot have multiple bets locked across different active raids without explicit support (current logic allows but tests cover the single-bet case).

When `CHAIN_ENABLED=false`, the bet-escrow layer is a pure in-memory ledger — no SPL transfer. When chain is on, the gateway will (in a future slice) build a deposit transaction via `ChainOps.buildBetEscrowDeposit`, the client signs it, and the gateway calls `ChainOps.verifyBetEscrowDeposit` before crediting the ledger.

---

## 6. Syndicates

A **syndicate** is a self-organized group of miners. The lifecycle:

1. **Create.** A founder calls `createSyndicate(tag, name, settings)`. Syndicate has a tag (3–5 chars) and configurable settings:
   - `rewardSplit`: percentage of raid loot routed to the syndicate treasury (the rest is split among participants).
   - `joinPolicy`: `'open'`, `'invite_only'`, or `'closed'`.
2. **Invite.** Existing members can `invitePlayer(walletAddress)`. Invitations expire.
3. **Join.** A player accepts an invite via `acceptInvite(syndicateId)`. Players in another syndicate must leave first (`leaveSyndicate`). Founders cannot leave without disbanding.
4. **Raid.** Members propose a syndicate raid against an asteroid. Other members can `joinRaid` to add their attack power. The raid launches when minimum participants are met (preventing solo abuse of the multiplier).
5. **Resolve.** On a win, the loot is split:
   - `treasuryShare = stolenYield × (settings.rewardSplit / 100)` → syndicate treasury.
   - `participantPool = stolenYield − treasuryShare` → split among raid participants.
   - **Quirk preserved from BG:** the raid proposer does not receive a participant share. (They get credit toward the syndicate's fame; their reward is the leadership bonus, not a slice.)

Syndicate multipliers are bounded:

```
syndicateMultiplier(activeMiners) =
  activeMiners <= 1   → 1.0×
  activeMiners >= 50  → 3.0×
  else                → 1.0 + (activeMiners − 1) × (2.0 / 49)   // linear ramp
```

---

## 7. Cooldowns

Cooldowns gate disruptive actions to prevent rapid-fire abuse. Each cooldown is keyed by `(walletAddress, action)`:

| Action                | Duration | Notes                                                |
| --------------------- | -------- | ---------------------------------------------------- |
| `home_station_switch` | 24 hr    | Prevents rapid switching mid-raid.                   |
| `expedition_start`    | 1 hr     | Throttles raid frequency.                            |
| `expedition_recovery` | 4 hr     | Applied after a raid resolves.                       |
| `rally_defense`       | 30 min   | Defender rally action; prevents constant rally spam. |

Different cooldown types are independent. A wallet on `expedition_start` cooldown can still call `set_home_station`. Expired cooldowns are cleaned up periodically by the world tick.

---

## 8. Anti-cheat

Three layers, all preserved from BG:

### 8.1 Per-wallet rate limit

A sliding-window rate limiter caps actions per wallet (10/min default). Exceeding the cap triggers an **exponential backoff block** that blocks all actions from that wallet for an increasing duration.

### 8.2 Per-IP connection cap

Each IP can host at most 3 connected wallets simultaneously. The 4th connection is rejected at the gateway layer.

### 8.3 Sybil detection

A wallet observed connecting from 3 or more distinct IPs within a 1-hour window is flagged. **Important quirk preserved from BG:** flagged wallets are **logged but allowed** to continue. The flag is informational for operators, not an automatic ban. (BG's rationale: false-positives on legitimate users with shared VPNs / mobile carriers are common; an automatic ban is too aggressive without human review.)

---

## 9. Holder verification

Holder verification gates `$ASTROID`-holder perks (e.g. poker freeroll access). It is **read-only by design** — the system reads on-chain balances but never moves funds.

### 9.1 Components

- **`HolderTracker`** (`server/verification/holder-tracker.ts`) — pure in-memory eligibility brain. Records observation timestamps, per-wallet consecutive-observation counts, and decides eligibility. Testable without any chain mocks.
- **`SolanaBalanceReader`** (`server/chain/holder.ts`) — production balance reader. Uses Helius DAS REST when `HELIUS_API_KEY` is set, falls back to standard `getParsedTokenAccountsByOwner`.
- **`HolderChainAdapter`** (same file) — glues the reader and the tracker, with a 30-second read-through cache.

### 9.2 Eligibility decision

A wallet is eligible when:

```
balance >= requiredBalance              // basic threshold
&& (
  holdDurationMs >= minHoldMs           // continuous-hold time
  OR
  consecutiveObservations >= minObs     // periodic check-in count
)
```

Defaults: `requiredBalance = runtime.holderMinBalance` (default 1), `minHoldMs = 600_000` (10 min, BG parity), `minObs = 5`.

### 9.3 Flash-loan mitigation

A wallet that just received tokens (via flash loan or otherwise) has zero hold time and one observation — it is **not eligible**. The wallet must continue to hold the threshold balance through subsequent observations, accumulating either hold time or observation count, before it qualifies.

A balance dip below the threshold **resets** the wallet's tracking record. An attacker cannot accumulate eligibility by bouncing the balance around the threshold (verified by a 100-cycle attacker-simulation test).

### 9.4 Divergence from BG

BG's flash-loan guard was dead code due to an `&&` that should have been `||` combined with too-low constants. astroid.club fixes this:

- **OR semantic** (instead of BG's broken `&&`): block while EITHER gate is unsatisfied.
- **No first-observation grace** (BG allowed first call to pass — exactly the flash-loan attack vector).
- **Default `minObs = 5`** (BG had 2, redundant under the new `||`).

The fix is documented in `server/verification/holder-tracker.ts` and asserted in tests (`'NEVER passes through on first call (BG quirk explicitly fixed)'`).

---

## 10. Random / spice mechanics

Two rare events add variance to discoveries.

### 10.1 Solar Flare (silver-class only)

Each silver-asteroid discovery rolls a multiplier in `[0.5, 2.0)` (uniform). Mean payout matches the unmultiplied baseline (`(0.5 + 2.0) / 2 = 1.25` ≈ slight upside expectation). The range and probability distribution are preserved verbatim from BG's `rollSilverSurgeMultiplier`.

### 10.2 Stellar Strike (gold-class only)

Each gold-asteroid discovery has a ~5% chance to **jackpot**. The jackpot doesn't change the size of the payout in this system; it triggers a separate jackpot reward configured per asteroid. Probability is preserved from BG's `rollGoldRushJackpot` (5% ± 0.5% in 100k-trial tests).

These are the only RNG-driven mechanics. Every other game outcome (raid resolution, distribution math, tier calculation) is deterministic given the inputs.

---

## 11. Tokenomics

`$ASTROID` is a plain SPL token. astroid.club:

- **Reads** balances for holder verification (flash-loan mitigation).
- **Accrues** mining/refinery yield as in-game **IOU credits** (a game-side ledger), never as a promised token payout.
- **Will burn** lost bet stakes via `ChainOps` when bet escrow is on-chain (deferred).

### 11.1 Staking is a utility, not a yield product

Staking is **for fun and gameplay utility only**. The explicit posture:

- **Non-custodial.** Staked `$ASTROID` is locked in the audited, third-party **Quarry** protocol, never in a Club-controlled wallet. The Club cannot move, spend, or "use" staked tokens; the player can unstake at any time.
- **No yield promise.** Staking does not pay interest, dividends, or any guaranteed token return. Its only effect is the in-game **drill-power / defense tier multiplier** (§2.3) — a gameplay buff.
- **IOU-ASTROID is a protection artifact.** Quarry mints an IOU reward token as part of its standard, audited flow. We lean on Quarry's audited custody specifically to **mitigate attack/drain risk** rather than rolling our own staking program. The IOU carries **no promised value**; an optional, discretionary redeemer (§redeemer) can swap IOU back toward `$ASTROID`, but redemption is never guaranteed or required to play.

There is **no custom Anchor program** owned by this repo and **no Club-owned staking program** — custody is delegated to Quarry by design.

### 11.2 On-chain stake → in-game tier reconciliation

For staking to buff drill power, the player's **on-chain Quarry stake is read back into the in-game `StakeManager`** so `getStakeTier()` resolves above Base. This reconciliation is wired:

- `StakeManager` keeps a per-wallet `onChainStake` mirror (a single **global** amount) populated by `setOnChainStake`. In Quarry mode this — not the legacy per-asteroid `stakes` map — is the source of truth for tier, drill-power, defense, and yield-share math.
- The global stake applies wherever the wallet is **present**: the asteroid they are actively mining, or their home station (defense). Elsewhere it contributes 0.
- The gateway reconciles by reading `get_stake_info` and calling `world.syncOnChainStake(...)` at three points: **on connect** (seed the tier), **after a verified `verify_stake_tx`** (stake landed), and **on every `stake_info` read** (the client refreshes after unstake/claim, so this catches withdrawals at zero extra RPC cost). Reads are best-effort — a transient RPC failure just leaves the tier at its last reconciled value.

### 11.3 Fees / sinks feeding the in-game pools

Raid and defense outcomes route value through the **in-game IOU/refinery ledger**, never through the on-chain staked tokens:

- A small configurable fraction of raid spoils / defense rewards can be skimmed into an asteroid's refinery pool, recycling value back to active miners.
- This keeps the "we never touch staked tokens" guarantee intact: the sink operates on in-game credits, not on the Quarry-held `$ASTROID`.

The platform's value-transfer surfaces are gated by `CHAIN_ENABLED` (holder reads, bridge, redeemer) and the `QUARRY_*` config (staking). See [`CHAIN_AUDIT.md`](CHAIN_AUDIT.md) for the operator-facing audit.

---

## 12. Glossary cross-reference

The internal symbol names are stable and BG-derived. Player-facing strings are chosen by the frontend. See [`GLOSSARY.md`](GLOSSARY.md) for the canonical mapping. Quick highlights:

| Internal symbol | Player-facing            |
| --------------- | ------------------------ |
| `carbon`        | Carbonaceous (suggested) |
| `silver`        | Speculative (suggested)  |
| `oil`           | Volatiles (suggested)    |
| `gold`          | Strike (suggested)       |
| `vault`         | Refinery                 |
| `mine`          | Asteroid                 |
| `homeBase`      | Home Station             |
| `hashrate`      | Drill Power              |
| `Silver Surge`  | **Solar Flare**          |
| `Gold Rush`     | **Stellar Strike**       |

---

## 13. Differences from Black-Gold

The port preserves all numerical values and audited surfaces. The only intentional divergences:

1. **Flash-loan mitigation is now functional.** BG's guard was dead code; astroid's switches to `OR` semantic and removes the first-observation grace.
2. **No first-observation grace for holder verification.** Buffering is the client's job.
3. **Cache fall-through removed for failed reads.** BG returned stale cache on RPC error; astroid propagates the error to the caller. (BG's behavior let attackers extend a stale balance's validity by causing transient errors.)
4. **Module-level singletons are gone.** Every game module is constructor-injected via narrow interfaces. Testability and re-startability improve; behavior is identical.
5. **Buyback service deferred.** BG had a runtime buyback loop. astroid's `ChainOps.executeBuyback` exists as a typed entry point but no impl is wired by default.

Every deliberate divergence is logged in [`PORTING_NOTES.md`](PORTING_NOTES.md) under the relevant slice.

---

## 14. Open design questions

These are intentionally not yet decided and will be resolved in future design passes:

- **Asteroid catalog.** 20 canonical asteroids with names, sectors, and star-map positions.
- **Frontend visuals for Solar Flare / Stellar Strike.** Same RNG, but the player feedback (animations, sounds) lives in the frontend.
- **Holder tier table.** BG had 8 market-cap-driven tiers (`config/holder-tiers.ts`). astroid currently uses a single fixed `holderMinBalance`. A `holder_tiers` slice can re-introduce dynamic tiers if needed.
- **Tournament / freeroll integration.** Poker freerolls for `$ASTROID` holders are a Phase 4 concern. The server's holder verification is the natural plug point, but the freeroll service itself is unspecified.
- **PvE world events.** BG didn't have these; astroid will.
- **Seasons.** Leaderboards reset cadence, season rewards, etc.

---

For the as-built code architecture and the operator audit of chain side effects, see the sibling docs in this folder.
