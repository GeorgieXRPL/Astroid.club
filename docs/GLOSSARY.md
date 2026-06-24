# Glossary — Black-Gold to astroid.club theme transformation

This is the **single source of truth** for renaming domain entities when porting from `Black-Gold-main` to `astroid-club`. If you are about to rename a thing while porting code, the rename must appear in this table first. Any divergence is a bug.

> **Rule of thumb when in doubt:** keep the math identical to Black-Gold; only swap the entity names and player-visible strings. The economic balance has been audited; we are not redesigning it during the port.

> **Resource classes (current):** the four mechanic classes are `carbon | silver | gold | oil`. `carbon` is the steady-yield carbonaceous class, shown to players as **"Carbonaceous"**. The credential token is **$ASTROID**.
>
> **Hard rule — never reintroduce the source token name.** When porting Black-Gold code, do **not** carry over a `coal` resource symbol or any `COAL` / `$COAL` / `IOU-COAL` token string. Use `carbon` for the resource class and `$ASTROID` for the token. The literal string "coal" must not appear anywhere in astroid.club code, tests, UI, or docs (outside this single prohibition).

---

## 1. Entities

| Black-Gold           | astroid.club                                  | Why                                                                 |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| Mine                 | **Asteroid**                                  | Direct theme swap. The thing players stake on, mine from, and raid. |
| Mining globe / Earth | **Galaxy** (or "Star Map" for the UI surface) | The world the asteroids live in.                                    |
| Home base            | **Station**                                   | A player's starting outpost.                                        |
| Vault                | **Refinery**                                  | Where mined yield accumulates before distribution.                  |
| Discovery (event)    | **Discovery**                                 | Kept verbatim — a discovery on an asteroid still works in fiction.  |
| Reward pool          | **Yield pool**                                | Pool of resources distributed to miners.                            |
| Buyback service      | _(removed in v1)_                             | No token economics under the free-launch posture.                   |
| IOU staking token    | _(removed in v1)_                             | The source game's Quarry IOU token; not used in v1.                 |

## 2. Roles

| Black-Gold        | astroid.club  | Notes                                                             |
| ----------------- | ------------- | ----------------------------------------------------------------- |
| Miner             | **Miner**     | Same word; works perfectly in space.                              |
| Raider / Attacker | **Raider**    | Players who initiate raids on someone else's asteroid.            |
| Defender          | **Defender**  | Players defending their staked asteroids.                         |
| Syndicate         | **Syndicate** | Group of players coordinating raids and defenses. Kept verbatim.  |
| Bettor            | **Bettor**    | Side participants betting on raid outcomes (CHAIN_ENABLED-gated). |

## 3. Mechanics

| Black-Gold            | astroid.club              | Notes                                                                                          |
| --------------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| Raid                  | **Raid**                  | Kept verbatim. The act of attacking another player's asteroid.                                 |
| Attack power          | **Attack power**          | Same.                                                                                          |
| Defense power         | **Defense power**         | Same.                                                                                          |
| Hashrate              | **Drill power**           | Per-player mining throughput. "Hashrate" doesn't fit space-mining fiction.                     |
| Stake                 | **Stake**                 | Kept verbatim. The deposit that anchors a player to an asteroid and weights their drill power. |
| Stake tiers           | **Stake tiers**           | Same numerical tiers; same multipliers.                                                        |
| Cooldown              | **Cooldown**              | Same.                                                                                          |
| Expedition            | **Expedition**            | Kept verbatim. Works perfectly in space.                                                       |
| Bet escrow            | **Bet escrow**            | Kept verbatim. CHAIN_ENABLED-gated; logic preserved.                                           |
| Anti-cheat            | **Anti-cheat**            | Same.                                                                                          |
| Holder verification   | **Holder verification**   | Same. The token whose holders qualify is **$ASTROID**.                                         |
| Flash-loan mitigation | **Flash-loan mitigation** | Same — time-weighted balance tracking.                                                         |

## 4. Rare events (the "spice")

| Black-Gold   | astroid.club       | Notes                                                      |
| ------------ | ------------------ | ---------------------------------------------------------- |
| Silver Surge | **Solar Flare**    | Rare 0.5x–2.0x mining-yield surge. Same statistical range. |
| Gold Rush    | **Stellar Strike** | Rare ~5% jackpot find. Same probability and reward shape.  |

The numerical balance of these events (range, probability, payout) does **not** change. The only change is the player-facing string and the internal symbol name in code.

## 5. Tokens / on-chain

| Black-Gold         | astroid.club           | Notes                                                                                                           |
| ------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| Holder token       | **$ASTROID**           | The holder-credential token. astroid.club reads its balance for hold-time gating; never mints, never transfers. |
| Token mint env var | `ASTROID_MINT_ADDRESS` | (was `TOKEN_MINT_ADDRESS` in BG)                                                                                |
| Token decimals     | `ASTROID_DECIMALS`     | Default 9 (Solana convention).                                                                                  |
| Reward sink        | **Reward sink**        | Same shape as engine's `SplRewardSink`. CHAIN_ENABLED-gated.                                                    |
| Buyback service    | _(removed)_            | No token-economic flywheel in v1.                                                                               |

## 6. File / symbol rename map

When porting a Black-Gold source file, apply these renames mechanically. The math, branching, and field shapes stay identical.

| BG file                               | astroid.club file                          | BG symbol             | astroid.club symbol                |
| ------------------------------------- | ------------------------------------------ | --------------------- | ---------------------------------- |
| `server/game/raid-engine.ts`          | `server/game/raid-engine.ts`               | `RaidEngine`          | `RaidEngine` (same — raid is kept) |
| `server/game/mine-registry.ts`        | `server/game/asteroid-registry.ts`         | `MineRegistry`        | `AsteroidRegistry`                 |
| `server/game/vault-manager.ts`        | `server/game/refinery-manager.ts`          | `VaultManager`        | `RefineryManager`                  |
| `server/game/bet-escrow.ts`           | `server/game/bet-escrow.ts`                | `BetEscrow`           | `BetEscrow` (same — kept)          |
| `server/game/stake-manager.ts`        | `server/game/stake-manager.ts`             | `StakeManager`        | `StakeManager` (same)              |
| `server/game/syndicate-manager.ts`    | `server/game/syndicate-manager.ts`         | `SyndicateManager`    | `SyndicateManager` (same)          |
| `server/game/syndicate-raids.ts`      | `server/game/syndicate-raids.ts`           | `SyndicateRaids`      | `SyndicateRaids` (same)            |
| `server/game/expedition-tracker.ts`   | `server/game/expedition-tracker.ts`        | `ExpeditionTracker`   | `ExpeditionTracker` (same)         |
| `server/game/cooldowns.ts`            | `server/game/cooldowns.ts`                 | `CooldownManager`     | `CooldownManager` (same)           |
| `server/game/distribution-service.ts` | `server/game/distribution-service.ts`      | `DistributionService` | `DistributionService` (same)       |
| `server/game/reward-orchestrator.ts`  | `server/game/yield-orchestrator.ts`        | `RewardOrchestrator`  | `YieldOrchestrator`                |
| `server/game/types.ts`                | `server/game/types.ts`                     | `Mine`                | `Asteroid`                         |
| (in `types.ts`)                       |                                            | `mineId`              | `asteroidId`                       |
| (in `types.ts`)                       |                                            | `vault`               | `refinery`                         |
| (in `types.ts`)                       |                                            | `hashrate`            | `drillPower`                       |
| (in `types.ts`)                       |                                            | `STAKE_TIERS`         | `STAKE_TIERS` (same)               |
| `server/solana/holder.ts`             | `server/solana/holder.ts`                  | `verifyHolder`        | `verifyHolder` (same)              |
| `server/solana/rewards.ts`            | _(use engine's `SplRewardSink`)_           |                       |                                    |
| `server/solana/buyback.ts`            | _(removed in v1)_                          |                       |                                    |
| `server/solana/staking.ts`            | _(use engine's optional Quarry provider)_  |                       |                                    |
| `server/middleware/rateLimit.ts`      | _(use engine's `RateLimiter`)_             |                       |                                    |
| `server/middleware/validate.ts`       | _(use engine's `Protocol` zod-validation)_ |                       |                                    |
| `server/auth/verify-wallet.ts`        | _(use engine's `verifySignedAction`)_      |                       |                                    |
| `server/storage/redis-store.ts`       | _(use engine's `RedisStorage`)_            |                       |                                    |
| `config/holder-tiers.ts`              | `config/holder-tiers.ts`                   | `HOLDER_TIERS`        | `HOLDER_TIERS` (same)              |

## 7. Player-visible string changes

A handful of player-visible strings are swapped wholesale. These appear in UI, server toasts, log messages, and tournament metadata:

| BG                   | astroid.club     |
| -------------------- | ---------------- |
| "Black Gold"         | "astroid.club"   |
| "the mine"           | "the asteroid"   |
| "your mine"          | "your asteroid"  |
| "the globe"          | "the galaxy"     |
| "Earth" (in fiction) | "the galaxy"     |
| "vault"              | "refinery"       |
| "discover gold"      | "discover ore"   |
| "Silver Surge"       | "Solar Flare"    |
| "Gold Rush"          | "Stellar Strike" |

## 8. What does **not** change

These things are deliberately preserved during the port. Changing any of them is out of scope for the migration and would re-open audited surfaces:

- Stake-tier multipliers and thresholds.
- Defender advantage formula and percentage caps on raid outcomes.
- Steal vs. burn split percentages.
- Anti-cheat heuristics, thresholds, and rate-limit windows.
- Flash-loan mitigation (time-weighted balance, minimum hold seconds).
- Bet-escrow caps (e.g. the 20% stake cap on a single bet).
- Discovery-event probabilities and ranges.
- Vault → Refinery distribution cadence (hourly).
- Cooldown durations.
- Wallet-signature requirements on state-changing actions.

If a port introduces a numerical change to any of the above, **stop and document it explicitly** in `docs/PORTING_NOTES.md` with a rationale. Otherwise the port should be a syntactic transform plus theme rename.
