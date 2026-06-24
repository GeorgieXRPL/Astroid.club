# Porting notes — Black-Gold to astroid.club

A running log of every file ported from `Black-Gold-main` to this repo. Read alongside [`GLOSSARY.md`](GLOSSARY.md).

The format for each entry:

- **Source:** path inside `Black-Gold-main`
- **Destination:** path inside `astroid-club`
- **Renames applied:** specific symbols / files renamed per the glossary
- **Numerical changes:** must be `(none)` unless explicitly reviewed and rationalised here
- **Tests:** which test file(s) cover the ported logic

---

## Phase 0 — scaffold (landed)

No source files ported. Only structure, configuration, and the canonical glossary.

---

## Phase 1 — game economy port

### `config/asteroids.ts` — landed

- **Source:** `Black-Gold-main/config/mines.ts`
- **Destination:** `astroid-club/config/asteroids.ts`
- **Renames applied:**
  - `MineDefinition` → `AsteroidDefinition`
  - `MINES` → `ASTEROIDS` (left empty as a TODO; populating with 20 real-world asteroids is a creative pass for the design team)
  - `getMinesByResource` → `getAsteroidsByResource`
  - `getMineById` → `getAsteroidById`
  - `lat` / `lng` / `country` / `countryName` → `sector: string`, `position: { x, y, z }` (galactic)
  - Resource mechanic strings retheme'd: "Steady Burn" → "Steady Drill"; "Gold Rush" → "Stellar Strike"; "Seam" → "Vein"; "Gusher" → "Burst"; "Speculation" description references "silver surges" → "Solar Flare events"
  - Internal resource symbols are `'carbon' | 'gold' | 'oil' | 'silver'` (the steady-yield class is `carbon`, shown to players as "Carbonaceous"); the economy values are kept verbatim so ported tests remain comparable to the audit suite
- **Numerical changes:** (none) — discovery times, multipliers, and colors preserved exactly

### `server/game/types.ts` — landed

- **Source:** `Black-Gold-main/server/game/types.ts`
- **Destination:** `astroid-club/server/game/types.ts`
- **Renames applied:**
  - `Mine` / `mineId` → `Asteroid` / `asteroidId` throughout
  - `hashrate*` → `drillPower*` (interface fields, helper names, multiplier name)
  - `vault` / `Vault*` → `refinery` / `Refinery*`
  - `reward` / `RewardSource` → `yield` / `YieldSource` where the term refers to player-visible payouts
  - `silverSurgeMultiplier` → `solarFlareMultiplier`
  - `isJackpotActive` → `isStellarStrikeActive`
  - `rollSilverSurgeMultiplier` → `rollSolarFlareMultiplier`
  - `rollGoldRushJackpot` → `rollStellarStrikeJackpot`
  - `home_base*` → `home_station*`
  - `'silver_surge'` event → `'solar_flare'`; `'jackpot_triggered'` → `'stellar_strike'`; `'mine_update'` → `'asteroid_update'`; `'vault_distribution'` → `'refinery_distribution'`
  - `RaidResult.stolenRewards` → `stolenYield`
  - `MineerContribution.hashrateSeconds` → `MinerContribution.drillPowerSeconds`
- **Numerical changes:** (none) — `STAKE_TIERS`, `COOLDOWN_DURATIONS`, defender bonus (1.5x), syndicate scaling (1→3 over 1→50 miners), Solar Flare range [0.5, 2.0), Stellar Strike rate 5%, all preserved verbatim
- **Strict-mode adaptations:** added `noUncheckedIndexedAccess`-safe array reads in `getStakeTier` (uses `STAKE_TIERS[0]!` for the base-tier fallback, with a comment explaining the invariant)
- **Tests:** `tests/game/types.test.ts` — 27 unit tests covering tier table, tier lookup edge cases (negative, zero, threshold, overflow), drill-power math, defense math, attack math, syndicate scaling, Solar Flare distribution (50k samples), Stellar Strike rate (100k trials). All passing.

### `server/game/interfaces.ts` — landed (new file, no BG counterpart)

- **Purpose:** define narrow dependency interfaces (`AsteroidRegistryLike`, `StakeManagerLike`, `ExpeditionTrackerLike`, `CooldownManagerLike`, `GameLogger`) so ported game modules can be constructor-injected rather than calling singletons
- **Why:** BG used `getMineRegistry()` / `getStakeManager()` / `getExpeditionTracker()` / `getCooldownManager()` module-level singletons. astroid.club's port replaces those with DI to:
  1. Make every game module independently unit-testable without booting the whole stack
  2. Mesh with the engine's `DependencyContainer`
  3. Support multiple game-room instances per server process (BG was implicitly single-room)
- **Interface scope:** each interface declares only the methods the consumer actually calls — narrowest possible surface for mocking
- **Logger rename:** `RaidLogger` was renamed to `GameLogger` once it became clear multiple modules (`raid-engine`, `cooldowns`, `expedition-tracker`) would use the same shape. The old name is kept as a deprecated type alias for one slice and will be removed.
- **Numerical changes:** (none — no logic in this file)

### `server/game/raid-engine.ts` — landed

- **Source:** `Black-Gold-main/server/game/raid-engine.ts`
- **Destination:** `astroid-club/server/game/raid-engine.ts`
- **Renames applied:**
  - All BG mine references → asteroid; class name `RaidEngine` kept
  - `pendingBarrelRewards` → `pendingDiscoveryYield`
  - Methods: `setPendingReward` → `setPendingYield` (and `get`/`clear` analogously)
  - `calculateMineDefensePower` → `calculateAsteroidDefensePower`
  - `getMineRegistry` / `getStakeManager` / `getExpeditionTracker` singleton calls → `this.registry` / `this.stakeManager` / `this.tracker` constructor-injected dependencies
  - `RaidResult.stolenRewards` → `stolenYield` (already in types.ts)
  - Log strings use the token symbol `"$ASTROID"`
  - `defenseBuff.hashrateBoost` → `defenseBuff.drillPowerBoost`
  - `attackDebuff.hashrateReduction` → `attackDebuff.drillPowerReduction`
  - Replaced singleton getter at end of file (`getRaidEngine` / `resetRaidEngine`) with a configured constructor — the engine's DI container manages lifetime, no module-level singleton
- **Numerical changes:** (none)
  - `DEFENSE_ADVANTAGE = 1.2` preserved
  - `MIN_STEAL_PERCENT = 0.1`, `MAX_STEAL_PERCENT = 0.3` preserved
  - `DEFENDER_SPOILS_PERCENT = 0.1` preserved (90% burned)
  - Rally-defense: 1.5x boost, 2.0x cap, 30-minute duration preserved
  - History limits (100), recent-default (20) preserved
  - Power-ratio cap of 2.0 in steal calculation preserved
  - 50% defense degradation for miners on expedition preserved
  - Attacker reward distribution: equal base + 50%-weighted bet bonus preserved
- **Logging:** BG used `console.log` directly; astroid.club uses an injectable `GameLogger` (formerly `RaidLogger`) that defaults to `console`. No log content removed; only routing changed.
- **Tests:** Phase 1 covers helper math via `tests/game/types.test.ts`; full raid-resolution simulation tests are deferred to the next slice (need mock `AsteroidRegistry` / `StakeManager` / `ExpeditionTracker` test doubles).

### `server/game/cooldowns.ts` — landed

- **Source:** `Black-Gold-main/server/game/cooldowns.ts`
- **Destination:** `astroid-club/server/game/cooldowns.ts`
- **Renames applied:**
  - User-visible action label `"switch home base"` → `"switch your home station"` (the cooldown _key_ rename `home_base_switch` → `home_station_switch` is in `types.ts`; this file consumes it)
  - Removed module-level singleton (`getCooldownManager` / `resetCooldownManager`); class is now constructed directly with optional `{ logger }`
  - Implements the new `CooldownManagerLike` interface
- **Numerical changes:** (none) — `COOLDOWN_DURATIONS` are sourced from `types.ts` unchanged
- **Logging:** routed through injectable `GameLogger` (defaults to `console`)
- **Tests:** `tests/game/cooldowns.test.ts` — 13 unit tests covering hasCooldown, getRemainingCooldown, applyCooldown (replace-on-same-type), independent types, clearCooldown, clearAllCooldowns, cleanupExpired, all four checkAction labels. Vitest fake timers used throughout for determinism. All passing.

### `server/game/asteroid-registry.ts` — landed

- **Source:** `Black-Gold-main/server/game/mine-registry.ts`
- **Destination:** `astroid-club/server/game/asteroid-registry.ts`
- **Renames applied:**
  - `MineRegistry` → `AsteroidRegistry`; `MineState` → `AsteroidState`; `mineId` → `asteroidId` everywhere
  - `getMine` → `getAsteroid`; `getAllMines` → `getAllAsteroids`; `getMinesByResource` → `getAsteroidsByResource`
  - `MineNetworkStats` → `AsteroidNetworkStats`; `mineName` field → `asteroidName`
  - `addMiner` / `removeMiner` kept (player term "miner" preserved) but their drill-power field was renamed (`hashrate` → `drillPower`)
  - `updateMinerHashrate` → `updateMinerDrillPower`; `updateMineStake` → `updateAsteroidStake`
  - `getHashrateMultiplier` → `getDrillPowerMultiplier`; `getRewardMultiplier` → `getYieldMultiplier`
  - `recordDiscoveryFound` kept (term reused)
  - `defenseBuff.hashrateBoost` → `defenseBuff.drillPowerBoost`; `attackDebuff.hashrateReduction` → `attackDebuff.drillPowerReduction`
  - `isJackpotActive` → `isStellarStrikeActive`; `silverSurgeMultiplier` → `solarFlareMultiplier`
  - Log strings: `"🎰 GOLD RUSH! Jackpot at ..."` → `"STELLAR STRIKE! Jackpot at ..."` (emoji removed)
  - Removed module-level singleton (`getMineRegistry` / `resetMineRegistry`); construct directly with `{ asteroids?, logger? }`
- **Numerical changes:** (none)
  - Defense buff: 2-hour immunity, 1-hour drill-power boost at 1.1x — preserved verbatim
  - Attack debuff: 0.8x drill-power reduction, 30-minute window — preserved verbatim
  - Stellar Strike yield multiplier: 5.0x on gold-class asteroids — preserved verbatim
  - Two-stage defense-buff expiry (boost can drop to 1.0 while immunity continues, both must elapse before clearing) — preserved verbatim
  - Multiplier composition order (defense boost × attack debuff × syndicate multiplier for drill power; baseRewardMultiplier × Stellar Strike × Solar Flare × syndicate for yield) — preserved verbatim
- **Architectural changes:**
  - **No hash-pool dependency.** BG's registry consumed `server/pool/difficulty.ts` to dynamically recompute per-asteroid difficulty when miners joined/left. astroid.club doesn't run a Bitcoin-style PoW pool — `difficulty` and `target` stay as informational placeholder fields on `AsteroidState`, but nothing recomputes them. `updateAsteroidDifficulty(id, difficulty, target)` is preserved as a manual setter for future use. The `recalculateMineDifficulty` method was dropped entirely; `getAsteroidTarget` and `getAsteroidTargetTime` accessors were kept (they read from data, not the pool).
  - **Empty by default.** BG seeded the registry from the `MINES` constant at construction. Our `ASTEROIDS` array is intentionally empty in this phase, so the constructor accepts an explicit `asteroids` list and exposes `registerAsteroid(definition)` as a public method (idempotent, replaces by id). Keeps tests and bootstrap code free of hardcoded data.
  - Singleton getters dropped; integrates via the engine's `DependencyContainer` later.
- **Logging:** routed through injectable `GameLogger`.
- **Tests:** `tests/game/asteroid-registry.test.ts` — 29 tests covering construction (empty, seeded, idempotent re-register), miner add/remove/move, drill-power and stake updates with zero-clamping, the buff/debuff lifecycle (including the two-stage expiry across the 1h/2h boundary), incoming-raid bookkeeping (idempotent add, no-op remove), oil syndicate scaling, gold Stellar Strike rolls (forced via `Math.random` spy), silver Solar Flare re-rolls, the multiplier-composition formulas, network-stats projection, and totals. All passing.

### `server/game/stake-manager.ts` — landed

- **Source:** `Black-Gold-main/server/game/stake-manager.ts`
- **Destination:** `astroid-club/server/game/stake-manager.ts`
- **Renames applied:**
  - `homeBaseMineId` → `homeStationAsteroidId`; `homeBaseJoinedAt` → `homeStationJoinedAt`
  - `setHomeBase` → `setHomeStation`; `restoreHomeMine` → `restoreHomeStation`
  - `getStakeAtMine` → `getStakeAtAsteroid`; `getStakeTierAtMine` → `getStakeTierAtAsteroid`
  - `getEffectiveHashrate` → `getEffectiveDrillPower`
  - `getMineStakers` → `getAsteroidStakers`
  - `minesUnderAttack` → `asteroidsUnderAttack`; `registerMineUnderAttack` → `registerAsteroidUnderAttack`; `unregisterMineAttack` → `unregisterAsteroidAttack`; `isMineUnderAttack` → `isAsteroidUnderAttack`
  - `pendingRewards` → `pendingYield`; `addPendingReward` → `addPendingYield`; `getPendingReward` → `getPendingYield`; `claimPendingReward` → `claimPendingYield`; `getAllPendingRewards` → `getAllPendingYield`; `getTotalPendingRewards` → `getTotalPendingYield`
  - `calculateRewardShare` → `calculateYieldShare`
  - Token symbol in user-facing warning strings → `"$ASTROID"` (configurable via `tokenSymbol` config option)
  - Removed module-level singleton (`getStakeManager` / `resetStakeManager`)
- **Numerical changes:** (none)
  - 20% bet-cap as a fraction of stake — preserved verbatim
  - 50% stake-weighted share of yield (the other 50% goes to drill-power contribution, distributed elsewhere) — preserved verbatim
  - Effective drill-power and defense-power formulas come from `types.ts` (already byte-identical to BG)
- **Architectural changes:**
  - **Dependency injection.** BG's manager called `getMineRegistry()`, `getBetEscrowManager()`, and `getRedisStore()` directly. astroid.club takes them through the constructor as narrow `*Like` interfaces:
    - `AsteroidRegistryLike` — required (extended this slice with `updateAsteroidStake`)
    - `BetEscrowLike` — defaults to a no-op stub (real implementation arrives in the bet-escrow slice; until then, the manager safely reports "no locked bets" and skips the warning)
    - `HomeStationStore` — defaults to an in-memory `Map`-backed store; the engine's `RedisStorage` will plug in via this interface later
  - **No env reads.** BG read `process.env.QUARRY_ADDRESS` at construction. We accept `quarryEnabled: boolean` explicitly. Runtime config lives in `server/config/runtime.ts`.
  - **No project-specific token strings.** Logged token symbol is configurable; defaults to `"$ASTROID"`.
  - Implements the `StakeManagerLike` interface that `RaidEngine` and `ExpeditionTracker` consume.
- **Behavioural quirk preserved:** `stake()` auto-sets the wallet's home station on first stake. `requestUnstake()` always succeeds when the row exists (BG model: token custody is on-chain via Quarry, the manager is the in-memory mirror) and surfaces a warning when locked bets exist instead of blocking.
- **Logging:** routed through injectable `GameLogger`.
- **Tests:** `tests/game/stake-manager.test.ts` — 37 tests pairing the real `AsteroidRegistry` with custom `BetEscrowLike` and `HomeStationStore` doubles. Covers miner-state lazy creation and identity, home-station set/restore (including persistence, restore-from-empty, and store-error swallowing), stake/unstake (validation, accumulation across asteroids, registry totalStake propagation, zero-clamp row removal), `requestUnstake` rejection paths and the locked-bet warning, bet processing (20% cap, zero-stake rejection), bet burn, defense and drill-power formulas (verified against `calculateDefensePower` / `calculateEffectiveDrillPower`), the 50% stake-weighted yield share, raid bookkeeping (active-raid counts, asteroid-under-attack ref counting, locked-bet pass-through, Quarry flag), loyalty-day refresh (only updates the home-station stake row), cooldown expiry, and `getAsteroidStakers` zero-row filtering. All passing.

### `server/game/interfaces.ts` — extended this slice

- Added `BetEscrowLike` (used by `StakeManager` for the locked-bet warning).
- Added `HomeStationStore` (pluggable persistence for home-station ids; sync or async).
- Added `updateAsteroidStake` to `AsteroidRegistryLike` (used by `StakeManager`).

### `server/game/syndicate-manager.ts` — landed

- **Source:** `Black-Gold-main/server/game/syndicate-manager.ts`
- **Destination:** `astroid-club/server/game/syndicate-manager.ts`
- **Renames applied:**
  - `stake.mineId` → `stake.asteroidId` (call into stake manager during creation-cost burn)
  - Token symbol in log strings → `"$ASTROID"` (configurable)
  - Module-level singleton (`getSyndicateManager` / `resetSyndicateManager`) dropped
- **Numerical changes:** (none)
  - `SYNDICATE_CREATION_COST = 1000` — preserved verbatim
  - Validation rules: name `[a-zA-Z0-9 _-]+`, max 24 chars; tag `[a-zA-Z0-9]+`, 2–4 chars (case-insensitive uniqueness) — preserved verbatim
  - `MAX_MEMBERS = 50`, `MAX_OFFICERS = 5` (excluding leader) — preserved verbatim
  - Treasury split bounds `[0, 30]%` — preserved verbatim
  - Burn order: largest stakes first — preserved verbatim
- **Architectural changes:**
  - **DI for the stake manager.** BG called `getStakeManager()` at method-call time. astroid.club takes a `StakeManagerLike` via constructor. Required two new methods on `StakeManagerLike`: `getTotalStake(walletAddress)` and `getWalletStakes(walletAddress)` — both already implemented on the real `StakeManager`.
  - Implements `SyndicateManagerLike` (new in `interfaces.ts`) so `SyndicateRaidsManager` can depend on the abstraction.
- **Logging:** routed through injectable `GameLogger`.
- **Tests:** `tests/game/syndicate-manager.test.ts` — 42 tests covering: name/tag validation (all rejection branches + happy path); creation-cost burn (largest-first ordering, multi-stake cascade, totalBurned bookkeeping); pre-existing-member, insufficient-stake, and duplicate-tag rejections; invite lifecycle (only leaders/officers can invite, can't invite already-syndicated players, list/accept/decline, multi-invite clears on accept, accept rejected when already a member, accept rejected after target syndicate disbanded); membership mutations (member-leave, leader-can't-leave-with-members, leader-auto-disband-as-last-member, kick rules for leader/officer/member, MAX_OFFICERS cap on promote, demote requires officer, leader-only promote/demote, transferLeadership swap + non-member rejection); settings (rewardSplit out-of-range, valid update, non-leader rejection); treasury (deposit credits both treasury and member.totalContributed, deposit non-positive rejection, withdraw leader-only and balance-limited); browsing (case-insensitive search, leaderboard sorts by members or wins with limit, disband frees the tag, getStats aggregation). All passing.

### `server/game/syndicate-raids.ts` — landed

- **Source:** `Black-Gold-main/server/game/syndicate-raids.ts`
- **Destination:** `astroid-club/server/game/syndicate-raids.ts`
- **Renames applied:**
  - `targetMineId` → `targetAsteroidId` (across `SyndicateRaid` interface and parameters)
  - `mineId` → `asteroidId` throughout
  - `homeBaseMineId` → `homeStationAsteroidId` (on `MinerGameState`)
  - `getStakeAtMine` → `getStakeAtAsteroid`
  - `getMineRegistry` → `AsteroidRegistryLike` (DI)
  - `getPendingReward` → `getPendingYield`
  - `calculateMineDefensePower` → `calculateAsteroidDefensePower`
  - `stolenRewards` (RaidResult field) → `stolenYield`
  - `state.homeBaseMineId` → `state.homeStationAsteroidId`
  - Token symbol in log strings → `"$ASTROID"` (configurable)
  - Module-level singleton (`getSyndicateRaidsManager` / `resetSyndicateRaidsManager`) dropped
- **Numerical changes:** (none, all preserved verbatim)
  - `MAX_RAID_DURATION_MS = 2 * 60 * 60 * 1000` (2h)
  - `MIN_PARTICIPANTS = 3`
  - `SYNDICATE_POWER_BONUS = 1.1` (per-joiner coordination bonus)
  - `DEFENSE_ADVANTAGE_MULTIPLIER = 1.2` (defender's natural advantage)
  - `MAX_BET_FRACTION_OF_STAKE = 0.2` (20% of stake at home station)
  - `ATTACK_POWER_PER_STAKE = 0.1` (per-member base attack-power formula)
  - Steal-percent formula: `min(0.1 + (min(attack/effectiveDefense, 2.0) - 1) × 0.2, 0.3)`
  - Bet-weighted reward fraction: 50% equal-share + 50% bet-weighted
  - History buffer: 100 raids
- **BG quirks preserved (with explicit test coverage):**
  1. **Proposer doesn't get the coordination bonus.** When a leader/officer proposes a raid, their attack power is added once with NO `× 1.1` multiplier. Every joiner's power IS multiplied by 1.1. BG's exact behaviour; treated as intentional ("the bonus is for _coordinating_ with someone, so the first member doesn't get it yet"). Verified in `proposeRaid > seeds raid pool with the proposer (no bonus on the founder)`.
  2. **Bet burn skipped when bettor has no home station.** A wallet that somehow places a non-zero bet but has `homeStationAsteroidId === null` will see its bet recorded in `betsBurned` but no `stakeManager.burnBet()` call. Verified in `resolveRaid (attackers lose) > skips burnBet when bettor has no home station`.
  3. **Pending raid is `'active'` status, not `'pending'`.** BG marked the proposal as `status: 'active'` immediately on creation, even before `launchRaid`. Preserved.
- **Architectural changes:**
  - **DI for every collaborator.** BG called `getSyndicateManager()`, `getStakeManager()`, `getMineRegistry()`, `getRaidEngine()` at method-call time. astroid.club takes them all via constructor using narrow `*Like` interfaces. Two new interfaces in `interfaces.ts`: `SyndicateManagerLike` (used here) and `RaidEngineLike` (used here; concrete `RaidEngine` already implements its surface).
  - Module-level singleton dropped.
- **Logging:** routed through injectable `GameLogger`.
- **Tests:** `tests/game/syndicate-raids.test.ts` — 42 tests covering: every `proposeRaid` rejection path (non-member, raidCoordination off, non-officer, duplicate proposal, unknown target, immune target, bet over cap) and the happy path with the proposer-no-bonus quirk; `joinRaid` (bonused power addition, all rejection paths, 20% cap); `leaveRaid` (power removal, raid auto-cancel on empty, all rejection paths); `launchRaid` (officer-only, MIN_PARTICIPANTS gate, pending-to-active transition, target-asteroid lookup); `cancelRaid` (officer-only, no-pending rejection); `resolveRaid` win path (steal-percent formula end-to-end with the 2.0 ratio cap exercising the 30% steal cap, bet-weighted returns, attack debuff applied, history accumulation); `resolveRaid` loss path (per-bet burn calls into stake manager with home station, defender spoils invocation, defense buff applied, both quirk branches: bettor-with-no-home and totalBets===0); `distributeRewards` (no-op on loss, exact 50/50 split with no treasury, treasury cut math at 20%, totalBets===0 path, unknown raid no-op); `cleanupExpiredRaids` (pending dropped silently, active marked failed and pushed to history, in-window kept); `getStats` win-rate. All passing.

### `server/game/yield-orchestrator.ts` — landed (chain-gated)

- **Source:** `Black-Gold-main/server/game/reward-orchestrator.ts`
- **Destination:** `astroid-club/server/game/yield-orchestrator.ts`
- **Renames applied:**
  - `RewardOrchestrator` / `reward-orchestrator` → `YieldOrchestrator` / `yield-orchestrator`
  - `REWARD_CONFIG` → `YIELD_CONFIG`
  - `BASE_REWARD_PER_DISCOVERY` → `BASE_YIELD_PER_DISCOVERY`
  - `REWARD_VARIANCE` → `YIELD_VARIANCE`
  - `MINER_POOL_PERCENT`, `VAULT_SHARE_PERCENT` → `MINER_POOL_PERCENT`, `REFINERY_SHARE_PERCENT`
  - `FINDER_BONUS_PERCENT` — kept (semantically the same)
  - `vaultReward` (return field) → `refineryYield`
  - `vaultAmount` → `refineryYield`
  - `totalReward` → `totalYield`
  - `finderReward` → `finderYield`
  - `mineId` → `asteroidId`
  - `MinerShareInfo.hashSeconds` → `MinerShareInfo.drillPowerSeconds`
  - `processRewardPayout` → `routePayout` (private; consolidated chain-vs-pending decision)
  - `handleNewDiscovery` → `processDiscovery`
  - `handleDefenderSpoils` — dropped (raid engine handles it natively, see "skipped")
  - `handleTimeoutDiscovery` — dropped (no pool / timeout system, see "skipped")
  - `isProductionReady` — dropped (BG-specific dev-readiness check)
  - `getRewardPoolBalance` polling — dropped (chain-layer concern)
  - Token symbol in log strings → `"$ASTROID"` (configurable; sourced from `TOKEN_CONFIG.SYMBOL`)
- **Numerical changes:** (none)
  - `MINER_POOL_PERCENT = 70`, `REFINERY_SHARE_PERCENT = 30` — preserved verbatim
  - `FINDER_BONUS_PERCENT = 20` — preserved verbatim
  - `BASE_YIELD_PER_DISCOVERY = 100` — preserved verbatim
  - `YIELD_VARIANCE = 0.2` — preserved verbatim
  - Per-resource multipliers `carbon=1.0`, `silver=1.2`, `oil=1.3`, `gold=1.5` — preserved verbatim (now in `DEFAULT_RESOURCE_MULTIPLIERS`, configurable)
  - Discovery-yield formula: `floor(BASE × resourceMultiplier × asteroidMultiplier × variance)` — same as BG, plus an extra `asteroidMultiplier` from `AsteroidDefinition.baseRewardMultiplier` (per-asteroid tuning knob; BG didn't have one)
  - Share-based payout formula: `Math.floor(minerPool × sharePercent / 100)` per miner; finder gets `Math.floor(baseShare × bonusPercent / 100)` on top — preserved verbatim
- **Skipped from BG (intentional):**
  - **`handleTimeoutDiscovery`** — BG had a cryptographic pool-mining flow with a "closest hash wins" timeout path and a rollover jackpot. astroid.club discoveries are time-based (`baseDiscoveryTimeMs` per asteroid) so there is no pool, no PoW shares, and no timeout fallback. If/when this is added later it lands as a separate slice.
  - **`handleDefenderSpoils`** — `RaidEngine.distributeDefenderSpoils` already credits defenders via `addPendingYield`. Routing through the orchestrator too would double-credit.
  - **Direct chain transfers** (`sendReward`, `queueReward`, `getRewardPoolBalance`) — orchestrator no longer talks to chain directly. All payouts route through the same `chainEnabled`/`onYieldPayout` hook used by `DistributionService`. Boot layer wires SPL transfers; orchestrator stays pure.
  - **`isProductionReady`** — BG-specific dev-readiness check tied to `TOKEN_CONFIG.MINT_ADDRESS` constants we don't have.
- **Architectural changes:**
  - **Class instead of free functions + module-level state.** BG's singleton `state` object is gone.
  - **DI for every collaborator.** Constructor takes `DistributionService`, `AsteroidRegistryLike`, `StakeManagerLike`. No singletons.
  - **Explicit CHAIN_ENABLED gating.** Same pattern as `DistributionService`: `chainEnabled: true` fires `onYieldPayout`; `chainEnabled: false` (default) credits `stakeManager.addPendingYield`. Chain-side fallback (queueReward retry) is a future chain-layer concern.
  - **Seedable randomness.** `random: () => number` config arg defaults to `Math.random`. Tests pass `() => 0.5` for deterministic zero-variance.
  - **Configurable resource multipliers.** Defaults to BG's table; consumers can override per game world for balance tuning.
  - **Stats now include `lastDistribution`** stamped via the `attachDistributionListener()` hook (reads `setOnDistribution` on the underlying service).
- **Logging:** routed through injectable `GameLogger`.
- **Tests:** `tests/game/yield-orchestrator.test.ts` — 18 tests covering: discovery-yield formula (deterministic mid-variance, low/high variance bounds, asteroidMultiplier stacking, unknown-asteroid fallback, custom resource multipliers); share-based discovery (per-miner base + finder bonus math, refinery 30% credit observable on real `RefineryManager`, configurable bonus, zero-amount entries excluded, finder-with-0%-share quirk); chain-disabled vs. chain-enabled routing (addPendingYield credit vs. onYieldPayout invocation); legacy fallback (no-shares 100%-to-finder + empty-shares array equivalent); stats accumulation (totals + mutation-safe getStats); `forceHourlyDistribution` and `attachDistributionListener` stamping `lastDistribution` only on non-empty results. All passing.

### `server/game/distribution-service.ts` — landed (chain-gated)

- **Source:** `Black-Gold-main/server/game/distribution-service.ts`
- **Destination:** `astroid-club/server/game/distribution-service.ts`
- **Renames applied:**
  - `vaultManager` → `refinery` (the `RefineryManager` instance)
  - `mineId` → `asteroidId`
  - `currentHashrate` → `currentDrillPower`
  - `VaultDistributionResult` → `RefineryDistributionResult`
  - `getMinerPendingReward` → `getMinerPendingYield`
  - `handleDiscovery` returns `{ finderShare, refineryShare }` (was `vaultShare`)
  - `onRewardPayout` → `onYieldPayout`
- **Numerical changes:** (none) — 30s tick cadence and 60s distribution-check cadence preserved as defaults.
- **Architectural changes:**
  - **Class instead of free functions + module-level state.** BG used a free-function module with a hidden singleton `serviceState`. astroid.club packages everything into a `DistributionService` class so multiple game worlds can run independently.
  - **Explicit CHAIN_ENABLED gating.** BG always called the registered `onRewardPayout` callback. astroid.club inspects an explicit `chainEnabled` flag:
    - `chainEnabled: true` → fire `onYieldPayout` callback per payout. Boot layer is expected to wire a real SPL transfer.
    - `chainEnabled: false` (default) → skip the callback and call `stakeManager.addPendingYield(wallet, asteroidId, amount)`. Users `claimPendingYield()` later via a separate route.
  - **DI for the refinery and stake manager.** Constructor takes `RefineryManager` + `StakeManagerLike`. No singletons.
  - **Resource passed through directly.** The contribution updater takes a `ResourceType` straight through (rather than a derived boolean flag) when calling `updateMinerContribution` — refinery slice already aligned.
  - **`tickContributions()` / `performDistribution()` are public.** Tests and the engine loop can drive the service manually without spinning up timers. `start()` / `stop()` remain available for full-service mode.
- **Logging:** routed through injectable `GameLogger`.
- **Tests:** `tests/game/distribution-service.test.ts` — 27 tests covering: active-miner registry (register, unregister, partial-update patches, no-op on unknown); `tickContributions` (skip-under-1s threshold, drill-power-seconds accumulation, multi-tick from new baseline, multi-asteroid); `handleDiscovery` (70/30 split, refinery credit, no-row-when-share-floors-to-zero); `performDistribution` chain-disabled mode (credits `addPendingYield`, suppresses chain callback, empty-results no-op); `performDistribution` chain-enabled mode (fires callback per payout with correct `(wallet, amount, asteroidId)`, suppresses `addPendingYield`, no-throw on missing callback, `setOnYieldPayout` swaps cleanly); `onDistribution` listener (fires once on non-empty, suppressed on empty); `start()`/`stop()` lifecycle (interval-driven contributions, idempotent start, safe stop-without-start, end-to-end `checkAndDistribute` firing real distributions when `shouldDistribute` flips); inspection delegation. All passing.

### `server/game/refinery-manager.ts` — landed

- **Source:** `Black-Gold-main/server/game/vault-manager.ts`
- **Destination:** `astroid-club/server/game/refinery-manager.ts`
- **Renames applied:**
  - `MineVault` → `AsteroidRefinery` (in `types.ts`)
  - `vault` → `refinery` throughout (variable names, log strings, function names)
  - `VaultManager` → `RefineryManager`; `createVaultManager` / `getOrCreateVault` / `initializeVault` etc. become instance methods
  - `VaultDistributionResult` → `RefineryDistributionResult` (in `types.ts`)
  - `vaultShare` (return field) → `refineryShare`; `calculateRewardSplit` → `calculateYieldSplit`
  - `mineId` → `asteroidId`; `MineVault.mineId` already `AsteroidRefinery.asteroidId`
  - `hashrateSeconds` (in `MinerContribution`) → `drillPowerSeconds` (already in `types.ts`)
  - `hashrateMultiplier` (in `StakeTier`) → `drillPowerMultiplier` (already in `types.ts`)
  - `currentHashrate` parameter → `currentDrillPower`
  - Token symbol in log strings → `"$ASTROID"` (configurable)
- **Numerical changes:** (none)
  - 70/30 finder/refinery yield split — preserved verbatim
  - 1-hour distribution cadence (`DEFAULT_DISTRIBUTION_INTERVAL_MS`) — preserved verbatim
  - Carbon-class loyalty bonus: +10% after 7 days at home station — preserved verbatim
  - `MIN_DISTRIBUTION_AMOUNT = 1` — preserved verbatim
  - Score formula: `(drillPowerSeconds / total) × stakeFactor × (1 + loyalty) × min(1, t/3600)` — preserved verbatim
  - Per-miner payout: `Math.floor(amountToDistribute × score / totalScore)` — preserved verbatim, including the dust-loss behaviour on uneven shares
- **Architectural changes:**
  - **Class instead of free functions.** BG used a functional style (`createVaultManager()` returning a state object, then free functions taking `state` as the first arg). astroid.club packages state and operations into a `RefineryManager` class to match the rest of the game-module style.
  - **Resource-explicit contribution updates.** `updateMinerContribution` takes a `ResourceType` directly (rather than a derived boolean flag) — same semantics, simpler, less leak-prone.
  - `markDistributionChecked()` exposed (BG had this implicit in `distributeAllVaults`); useful for tests and post-restart resets.
- **Logging:** routed through injectable `GameLogger`.
- **Tests:** `tests/game/refinery-manager.test.ts` — 31 tests covering: yield-split (70/30 with floor + dust); refinery state (initialize, getOrCreate idempotent, getRefinery null); accumulate (lazy init, multiple adds); contribution updates (fresh, accumulate, carbon-loyalty 7-day boundary, non-carbon never qualifies, stake-tier multiplier propagation); the score formula (zero total, BG formula, time cap at 1.0); all four distribution early-exit branches (no refinery, below minimum, no contributors, zero drill-power); the happy-path proportional payout including the floor-rounding dust loss; sub-1-token shares filtered out of payout map; `distributeAllRefineries` + cadence reset; `shouldDistribute` cadence; inspection helpers (`getRefineryStats`, balance maps, totals); pending-share estimator with all four branches. All passing.

### `server/game/bet-escrow.ts` — landed (in-memory ledger only)

- **Source:** `Black-Gold-main/server/game/bet-escrow.ts`
- **Destination:** `astroid-club/server/game/bet-escrow.ts`
- **Renames applied:**
  - `BetEscrowManager` → `BetEscrow` (single instance per DI container; "Manager" suffix dropped)
  - `mineId` → `asteroidId` on `BetRecord`; `targetMineId` / `sourceMineId` → `targetAsteroidId` / `sourceAsteroidId` on `RaidBetPool`
  - Token symbol in log strings → `"$ASTROID"` (configurable via `tokenSymbol` config option)
  - Removed module-level singleton (`getBetEscrowManager` / `resetBetEscrowManager`)
- **Numerical changes:** (none)
  - 90% burn / 10% to defenders on losing bets — preserved verbatim
  - Stake-weighted defender distribution with `Math.floor` rounding — preserved verbatim
  - 24-hour resolved-pool cleanup window — preserved verbatim
- **BG quirks preserved (with explicit test coverage):**
  1. **Defender bets are recorded but not pooled.** `placeBet(..., side: 'defender', ...)` stores a `BetRecord` in the ledger and lets `BetEscrowLike.hasLockedBets` see it, but does NOT add it to the pool's `attackerBets` map or `totalAttackerBets`. Defender side accounting happens in the stake manager.
  2. **Floor-rounding can drop dust.** Defender spoils are distributed by `Math.floor(share)` per recipient. Uneven splits drop sub-1-token dust into the void; documented in test `floor-rounding can drop dust on uneven splits`.
  3. **`if (share > 0)` check is pre-floor.** When 100 defenders each have stake 1 and the spoils pool is 1, every recipient gets `Math.floor(0.01) = 0` but is still inserted into the payout map (because the pre-floor check `0.01 > 0` passes). Verified in test `floor-to-zero entries leak in`. This is technically a BG bug but preserving it keeps math identical for porting confidence; can be revisited as a separate change later if desired.
- **Architectural change — chain split:**
  - **In-memory ledger only.** BG's class did two things: track bets in memory **and** build Solana transactions (`buildBetDepositTransaction`, `verifyBetDeposit`, `buildPayoutTransactions`, `buildBurnTransaction`) using `@solana/web3.js` + `@solana/spl-token`. astroid.club splits those concerns:
    - This file is the **pure in-memory ledger** with zero chain dependencies. It can be unit tested without Solana mocks and is the source of truth for `BetEscrowLike.hasLockedBets` / `getLockedBetAmount` queries.
    - The chain-side counterpart (transaction building, on-chain verify, payouts, burns) is deferred to a future `bet-escrow-chain.ts` slice.
  - **CHAIN_ENABLED gating happens at the route layer, not in this module.** Wallet flow:
    - `CHAIN_ENABLED=true`: route handler builds tx via `bet-escrow-chain.ts`, user signs, server verifies signature, then calls `escrow.placeBet(..., realSig)`.
    - `CHAIN_ENABLED=false`: route handler skips build/sign/verify and calls `escrow.placeBet(..., 'NOOP_<betId>')` directly. The ledger doesn't care.
  - **Implements `BetEscrowLike`** so the stake manager (which already accepts a `BetEscrowLike` via DI) can use this directly to drop the no-op stub.
- **Logging:** routed through injectable `GameLogger`.
- **Tests:** `tests/game/bet-escrow.test.ts` — 31 tests covering construction (with and without configured wallet), pool lifecycle (create + duplicate-id rejection + active/resolved partitioning), placeBet (all rejection paths: unknown raid, resolved raid, duplicate wallet; correct attacker pool accounting; defender BG-quirk; opaque txSignature pass-through; createdAt/resolvedAt invariants), `BetEscrowLike` queries (empty, multi-pool aggregation, post-resolve drop), `resolveRaid` (unknown / re-resolve throws; attacker-win returns; defender-win 90/10 split with single + multi defender; floor-rounding dust loss; floor-to-zero leakage; empty-pool no-op; no-stakes spoils-lost case; pool status transitions), cleanup (active preserved; resolved-old removed with bets cleared; custom window; in-window kept), and stats (empty, post-resolve aggregation). All passing.

### `server/game/interfaces.ts` — unchanged this slice

(No new interfaces — `BetEscrowLike` already declared the surface needed.)

### `server/game/expedition-tracker.ts` — landed

- **Source:** `Black-Gold-main/server/game/expedition-tracker.ts`
- **Destination:** `astroid-club/server/game/expedition-tracker.ts`
- **Renames applied:**
  - `Mine`/`mineId` → `Asteroid`/`asteroidId` throughout
  - `attackerHashrate` → `attackerDrillPower`; `additionalPower` derivation unchanged
  - `homeBaseMineId` → `homeStationAsteroidId`; `activeMineId` → `activeAsteroidId`
  - Replaced singleton getters (`getMineRegistry()` / `getStakeManager()` / `getCooldownManager()`) with constructor-injected `{ registry, stakeManager, cooldownManager, logger }`
  - Class implements the new `ExpeditionTrackerLike` interface (which RaidEngine already consumes)
  - Removed module-level singleton (`getExpeditionTracker` / `resetExpeditionTracker`)
- **Numerical changes:** (none)
  - `MAX_EXPEDITION_DURATION_MS = 2 * 60 * 60 * 1000` preserved
  - 1-hour cleanup window for resolved expeditions preserved
  - Attack power formula `calculateAttackPower(drillPower, stake)` unchanged
  - Bet handling: 100% forfeited on early leave (burned via stake manager) — unchanged
  - Cooldown application order on create / join / complete / leave — unchanged from BG
- **Behavioural quirk preserved:** `joinExpedition` only checks the `expedition_start` cooldown, not `expedition_recovery`. BG behaved this way; we don't want to silently change game balance, so the test suite explicitly covers the join path with each cooldown state.
- **Logging:** routed through injectable `GameLogger`; log _content_ updated per glossary (asteroid names) but log _level_ and order unchanged
- **Tests:** `tests/game/expedition-tracker.test.ts` — 24 unit tests using small in-memory `FakeRegistry` / `FakeStakeManager` test doubles plus the real `CooldownManager`. Covers the success path, every validation rejection (unknown source, unknown target, self-raid, immune target, already on expedition, expedition_start cooldown, expedition_recovery cooldown, bet refusal), join behaviour, completeExpedition (success + failure), startReturn, leaveExpedition (with bet burn, last-attacker cancel, no-expedition no-op), getExpeditionsTargeting, getTotalAttackPower, checkExpiredExpeditions (across the 2h boundary), cleanup (across the 1h resolved window), getStats. All passing.

---

## Phase 1 — remaining (next slices)

> Listed in dependency order. Each entry below is a placeholder documenting the intended scope; will be filled in as the files are ported.

### `server/game/bet-escrow-chain.ts` (deferred)

The on-chain side of bet escrow — `buildBetDepositTransaction`, `verifyBetDeposit`, `buildPayoutTransactions`, `buildBurnTransaction`. Lands once `CHAIN_ENABLED` flips on. The in-memory ledger above is independent and already in production.

### `server/game/world.ts` + `server/net/protocol.ts` — landed (transport-agnostic core, sub-slice A of `wire_engine`)

- **Source:** `Black-Gold-main/server/index.ts` (the 2,300-line WS monolith) + `Black-Gold-main/server/middleware/validate.ts` (zod schemas)
- **Destination:**
  - `astroid-club/server/game/world.ts` — `GameWorld` composition root
  - `astroid-club/server/net/protocol.ts` — astroid.club zod wire protocol on top of the engine's `Protocol`
- **Renames applied:**
  - BG message types → world methods (rethemed):
    - `connect` → `connectPlayer` (returns asteroid catalog + restored home station)
    - `join_mine` → `joinAsteroid`
    - `leave_mine` → `leaveAsteroid`
    - `set_home` → `setHomeStation`
    - `hashrate` → `reportDrillPower`
    - `stake` / `unstake` → `stake` / `unstake`
    - `start_expedition` / `leave_expedition` → same names
    - `rally_defense` → same
    - `stats` → `getNetworkStats`
    - new: `claimPendingYield`, `getMinerSnapshot`
  - Wire token symbol stays `$ASTROID` everywhere; configurable via `tokenSymbol`.
- **Numerical changes:** (none)
  - All gating, cooldowns, multipliers, and bet caps come from the underlying modules and remain byte-identical to BG.
- **Architectural changes:**
  - **Composition root.** `GameWorld` constructs (and is the only code that constructs) one instance of every ported game module: `AsteroidRegistry`, `CooldownManager`, `BetEscrow`, `StakeManager`, `ExpeditionTracker`, `RaidEngine`, `RefineryManager`, `DistributionService`, `YieldOrchestrator`, `SyndicateManager`, `SyndicateRaidsManager`, `AntiCheatService`. Every `*Like` interface is satisfied via DI here. No singleton survives.
  - **Transport-agnostic.** Player actions return a discriminated union `WorldResult<T> = { ok: true; data: T } | { ok: false; code; message }`. The gateway translates that into wire envelopes; tests assert on the result directly. No `WebSocket`, `IncomingMessage`, or zod imports inside the world.
  - **Stable error code surface.** `WorldErrorCode` union: `invalid_input | not_authenticated | unknown_asteroid | unknown_player | home_station_required | cooldown_active | invalid_target | rejected | rate_limited | sybil_flagged`. The gateway maps these one-to-one onto `error` envelopes.
  - **Per-wallet drill-power tracking on the world.** The registry only stores per-asteroid totals; `GameWorld` keeps a `lastReportedDrillPower: Map<wallet, number>` so it can compute deltas for `updateMinerDrillPower`, register/unregister with `DistributionService`, and pass the right power into `createExpedition`.
  - **Auto-register with the distribution service.** `joinAsteroid` calls `distribution.registerActiveMiner(...)`; `leaveAsteroid` and `disconnectPlayer` call `unregisterActiveMiner`. The orchestrator already accumulates drill-power-seconds from there.
  - **Timer-free by default.** `autoStartTimers: false` (default). Tests drive the world deterministically without real intervals. Production passes `autoStartTimers: true` (or calls `start()` after wiring up callbacks).
  - **CHAIN_ENABLED gating threaded once.** Constructor takes `chainEnabled` + `onYieldPayout`; both `DistributionService` and `YieldOrchestrator` receive them. With `chainEnabled=false` (default) the orchestrator and distributor route to `stakeManager.addPendingYield`; with `chainEnabled=true` they fire the callback. Verified end-to-end in `world.test.ts` against a `vi.fn()` listener.
  - **`GameMessage` zod union (server/net/protocol.ts).** Discriminated union on `type` covering 14 client-to-server messages: `request_nonce`, `auth`, `join_asteroid`, `leave_asteroid`, `set_home_station`, `report_drill_power`, `stake`, `unstake`, `start_expedition`, `leave_expedition`, `rally_defense`, `claim_yield`, `network_stats`, `miner_snapshot`. Reuses the engine's `SolanaAddress` and `UuidLike` primitives. `createAstroidProtocol()` returns an engine `Protocol<GameMessage>` ready to plug into `WSGateway`.
  - **`requiresAuth(type)` helper** mirrors BG's `requiresSignature` but operates on the post-auth set rather than per-message — once a connection passes `auth`, every subsequent game message is allowed (the gateway checks the wallet's connection metadata, not a per-message signature).
  - **Server-to-client envelope types** (`ResultEnvelope`, `ErrorEnvelope`, `EventEnvelope`, `NonceIssuedData`) are exported as plain TS interfaces, not zod schemas — only the server produces them, so validation overhead is wasted there.
- **Skipped from BG (intentional):**
  - **PoW / mining-pool messages** (`hashrate` PoW shares, `submit`, `request_work`, `result`, `discovery_pending`, difficulty broadcasts). astroid.club discovery is time-based, not PoW. If reintroduced it lands as a separate slice.
  - **Admin console** (`admin_auth`, `admin_subscribe`, `admin_action`, periodic admin broadcasts). Out of scope for the gateway slice; will land later behind `runtime.adminSecret`.
  - **REST `/api/staking/*` and `/api/escrow/*`** transaction-building endpoints. Those touch chain code and land with the chain-gated bet-escrow / staking slice.
  - **Bet placement / resolution** wire path. The bet-escrow ledger is in production; the chain side (transaction build / verify) is deferred.
- **Logging:** routed through injectable `GameLogger`. Default forwards to `console`.
- **Tests:**
  - `tests/game/world.test.ts` — 43 integration tests:
    - construction (every module exposed; idempotent start/stop; `autoStartTimers=false` schedules no real intervals; `tick()` clean on empty state)
    - auth gating (every action rejects pre-`connectPlayer`; `disconnectPlayer` flips off)
    - connect snapshot (asteroid catalog, zero defaults, `getMinerSnapshot` after stakes)
    - asteroid join/leave (known/unknown ids, move semantics, distribution-service registration mirror)
    - home station (set + cooldown gating)
    - drill-power reporting (delta diff, replace-not-add, validation, distribution-service mirror, asteroid-required gate)
    - stake / unstake (validation, unknown asteroid, missing-stake rejection)
    - expeditions (no-bet path, validation, home-station-required gate, leave + missing path)
    - rally defense (success, insufficient stake, unknown asteroid)
    - pending yield (zero default, claim drains)
    - network stats (cross-player aggregation)
    - chain-gated routing (vi.fn listener verifies addPendingYield path with chain off; verifies onYieldPayout fires when chain on through a real `processDiscovery`)
  - `tests/net/protocol.test.ts` — 28 tests covering schema parsing for every message, `SolanaAddress` rejection of bad input, primitive validation (negative drill power, non-finite numbers, zero amounts where positive required, negative bet/cost), bodyless messages, optional `requestId`, unknown types, null/non-object payloads, and the `createAstroidProtocol` round trip + control-message passthrough + JSON encode/parse.
- **Quality gate:** `typecheck`, `lint`, `prettier`, and `vitest run` all green (429/429 tests, including 43+28 new).

### `shell/` — landed (`frontend_shell_scaffold` sub-slice)

- **Source:** `Black-Gold-main/client/*` (Vite SPA — referenced for shape, not ported). astroid.club's frontend strategy is a hybrid Next.js shell + Vite arena per `docs/ARCHITECTURE.md`; this is the Next.js shell half.
- **Destination:** `astroid-club/shell/` — workspace member of `@saltaire/astroid-club`. Already declared as a workspace in the root `package.json`.
- **Renames applied:** wallet UX is reframed as "dev keypair" (this slice) → "Privy + Solana wallet adapter" (next slice). Theme palette (`space.950`, `flare.500`, `ore.500`) chosen at the Tailwind config level so future arena/share work can pull the same tokens.
- **Numerical changes:** (none — the shell is purely a transport for game state, no math).
- **What landed:**
  - `shell/package.json` — Next.js 15.1.6, React 19, TypeScript 5.7, Tailwind 3.4. Adds `tweetnacl` and `bs58` as runtime deps for client-side ed25519 signing.
  - `shell/tsconfig.json` + `shell/next.config.mjs` + `shell/tailwind.config.ts` + `shell/postcss.config.mjs` + `shell/eslint.config.mjs` + `shell/.gitignore` — standard Next.js scaffolding.
  - `shell/app/layout.tsx` + `shell/app/page.tsx` + `shell/app/globals.css` — landing page with branding, feature list, and a build-status table that mirrors the README.
  - `shell/app/sign-in/page.tsx` — interactive sign-in demo. Generates a dev keypair (or reuses the persisted one), runs the auth handshake, displays the connect snapshot.
  - `shell/lib/dev-keypair.ts` — `localStorage`-backed ed25519 keypair generation and signing. Signs with `nacl.sign.detached` and emits base64 (matches what the server's `WalletVerifier` expects).
  - `shell/lib/auth-client.ts` — the `request_nonce → sign → auth` handshake. Mirrors `server/net/protocol.ts`'s wire envelopes; the `ConnectSnapshot` interface mirrors `server/game/world.ts` exactly.
  - `shell/README.md` — local dev instructions, layout, "why dev-keypair-first" rationale.
  - `scripts/smoke-shell-auth.mjs` — out-of-bundle smoke test that runs the same handshake from node using `tweetnacl` + `ws`. Catches wire-protocol drift between shell client and server.
- **Architecture:**
  - The shell talks to the server WSGateway over `ws://localhost:3002` (overridable via `NEXT_PUBLIC_ASTROID_WS_URL`).
  - Auth flow signs the canonical message returned by the server unchanged. The `timestamp: 0` quirk lives entirely on the server side (`gateway.ts`); the client never reasons about it.
  - The shell deliberately does not keep a long-lived NetClient yet — Phase 2 sub-slice 4 owns that. This slice's auth handshake exists as a smoke test that the wire protocol works end-to-end with a real client.
  - **No Privy yet.** Phase 2 sub-slice 2 swaps `dev-keypair.ts` for Privy + `@solana/wallet-adapter-*`. The auth client is already deliberately structured so the keypair source is injected; replacement is a one-file change.
- **Skipped (intentional):**
  - **Privy.** Avoided this slice because Privy needs an out-of-repo app ID + Solana cluster config. Layered on top in the next sub-slice.
  - **Long-lived NetClient.** Phase 2 sub-slice 4. The shell's sign-in page closes the WS after displaying the snapshot.
  - **Asteroid catalog.** Server boots with zero asteroids (design-pass concern); the snapshot UI handles the empty case.
  - **Tests in shell/.** Component-level Vitest setup is deferred — not needed yet because the surface is small and the smoke test covers the auth contract.
- **Quality gate:** `typecheck` (root + shell), `lint:shell`, `format:check`, `vitest run` (590/590), `next build` all green. Smoke-tested live against a running server: handshake completes, snapshot returns the expected shape.

### `shell/` design system + 4-asteroid seed — landed (`frontend_theme` sub-slice)

- **Source (visual):** `../Astroid.club/app/globals.css` — the public coming-soon site that defines the cosmos cyan / ember orange / deep-space palette, glass-panel UI, holder-chip, telemetry-label / eyebrow typographic patterns, the CSS-only starfield + drift-parallax recipe, hero glow blobs, and reduced-motion fallback. Every CSS variable on `:root` is sourced from there byte-for-byte; drifting either side drifts the brand.
- **Destination:**
  - `shell/app/globals.css` — all design tokens + utility classes, with one extension over the public site: `resource-dot--{carbon,silver,gold,oil}` accent dots and `field` / `field-input` styles for the dev console's forms.
  - `shell/tailwind.config.ts` — Tailwind 3 mirror of those tokens (`space.{500..950}`, `cosmos`, `ember`, `ink`) + the `var(--font-display)` / `var(--font-mono)` plumbing.
  - `shell/app/layout.tsx` — Inter + JetBrains Mono via `next/font/google`, header with logo + beta pill + nav (Sign in / Console / GitHub), footer with family-link to astroid.space + legal disclaimer.
  - `shell/app/page.tsx` — restyled landing using eyebrow + glass-panel feature cards + glow-cyan/glow-ember atmosphere; build-status table now reflects the as-built state through this slice.
  - `shell/app/sign-in/page.tsx` — restyled in the same idiom; "Open the test console" CTA after success.
- **Game-side change:** `config/asteroids.ts` ships a starter fleet of 4 canonical asteroids (Bennu carbon / Vesta silver / Psyche gold / Themis oil), one per resource class, with discovery times and reward multipliers picked to span the resource curves without being copies of any single BG mine. `server/index.ts` passes them into `GameWorld`.
- **Why now:** the previous slice ended with `asteroids: []` in the connect snapshot — there was nothing to play-test against. Seeding 4 (vs the eventual ~20) gives full coverage of every resource-class branch (Steady Drill / Solar Flare / Stellar Strike / Syndicate) without committing to a creative pass on the full belt.
- **Verification:** typecheck, typecheck:shell, lint:shell, format, full vitest (590/590) all green. `node scripts/smoke-shell-auth.mjs` returns the four seeded asteroids in the connect snapshot.

### `shell/lib/session.ts` + `shell/app/console/` — landed (`frontend_console` sub-slice)

- **Source:** none (greenfield UX shell). Replaces the throw-away `shell/lib/auth-client.ts` from the previous slice (deleted in this commit).
- **Destination:**
  - `shell/lib/session.ts` — long-lived authenticated WebSocket. Exposes a `Session` with promise-based `send<T>()` (auto-generated monotonic `requestId`s), `on(event, handler)` event subscription bus, idempotent `close()`, and a synthetic `__closed__` event so subscribers can react to socket teardown without re-implementing `WebSocket.onclose`. `connectSession()` runs request_nonce → sign → auth and returns the session + connect snapshot.
  - `shell/lib/use-session.ts` — module-level singleton store + `useSession()` React hook. Survives Next.js route changes (modules persist; only the page tree unmounts), so signing in on `/sign-in` and navigating to `/console` reuses the same authenticated socket.
  - `shell/app/console/page.tsx` — the test console: snapshot panel, network stats panel, asteroid grid (per-card join / leave / set-as-home with status badges for "your home", "you're here", "buffed", "debuffed", "raids inbound"), drill-power form, stake / unstake form, expedition launcher with active-expedition tracker and per-asteroid rally-defense buttons, claim-yield panel, and an event log that captures every send/result/error and listens for the gateway's `broadcastEvent` taxonomy (`raid_resolved`, `solar_flare`, `stellar_strike`, ...). Auto-polls `miner_snapshot` and `network_stats` every 5 s and immediately after every successful action.
- **Architectural notes:**
  - **No React Context.** The session store lives at module scope so the eventual Vite arena bundle can subscribe to the same store via the same module without bouncing through Next-only context plumbing.
  - **`runAction<T>()` is the single I/O choke point.** Every button on the console funnels through it — append `sent` to the log, await the reply, append `ok` (with the JSON result) or `err` (with the wire code/message), then refresh both panels. Means the user sees exactly what the server saw and what came back, even when actions silently change state on the server (joining auto-leaves any prior asteroid, etc.).
  - **Wire-protocol parity test still passes.** `node scripts/smoke-shell-auth.mjs` continues to return the connect snapshot from a Node client; the comment now points at `session.ts` instead of the deleted `auth-client.ts`.
- **Skipped (intentional, deferred):**
  - **Server-pushed events.** The gateway exposes `broadcastEvent(event, data)` but no server module currently calls it. The console subscribes to the eventual taxonomy so they show up automatically once emitters land.
  - **Component-level tests.** The console is a dev tool; the protocol contract is tested at the gateway level (`tests/net/gateway.test.ts`, 11 tests) and end-to-end via the smoke script.
- **Quality gate:** `typecheck`, `typecheck:shell`, `lint:shell`, full vitest (590/590) all green. Live-tested: server boots with the 4 seeded asteroids; shell at `:4001/console` renders 200 and the auth handshake round-trips through the new `Session` cleanly.

### `shell/components/arena/*` + `shell/app/arena/page.tsx` — landed (`frontend_arena_starmap` sub-slice)

The 3D mining arena: a Three.js scene with the four seeded asteroids drifting on tilted orbits around the world origin, click-to-select with a HUD action panel that drives every relevant `GameWorld` message.

- **Source (visual):** `../Astroid.club/app/components/StarFieldHero.tsx` — the same procedural Perlin-noise nebula textures, the 26-puff galactic band, four layers of `<DeepStars>` at varied radii / sizes / speeds, foreground dust parallax, ACES tone mapping, large-kernel bloom, vignette, OrbitControls with auto-rotate. The arena reuses that recipe verbatim so the in-game sky is visually identical to the public Astroid.club hero. Drift the constants and you drift the brand.
- **Stack additions:**
  - `three@^0.184.0`, `@react-three/fiber@^9.6.0`, `@react-three/drei@^10.7.7`, `@react-three/postprocessing@^3.0.4`, `postprocessing@^6.39.1` (+ `@types/three`) installed into the shell workspace via `npm install --workspace=@saltaire/astroid-club-shell`. Versions match the public site so an eventual unification is a no-op.
- **Files:**
  - `shell/components/arena/Starfield.tsx` — the cosmic backdrop. Same procedural recipe as `StarFieldHero` but stripped of the camera + post-processing + OrbitControls (the parent scene owns those so the asteroids and the sky share one bloom pass).
  - `shell/components/arena/asteroid-orbits.ts` — per-asteroid orbit + visual layout, keyed by asteroid id. Tuned so Bennu is the close-orbit "training rock", Vesta sits a little wider, and Psyche / Themis swap inclinations on the outer orbit so the two outer bodies don't overlap.
  - `shell/components/arena/AsteroidBody.tsx` — one drifting rock. Geometry is a `IcosahedronGeometry(detail=1)` with vertices jittered along their normals using a seeded Mulberry32 PRNG (seed = hashed asteroid id) so each body looks distinctly bumpy across reloads. Per-resource styling — carbon: dark rough rock, no glow; silver: bright metallic with a faint white halo; gold: warm body with an ember halo (the Stellar-Strike vibe); oil: dusky blue-gray with cyan halo. A larger invisible sphere acts as a forgiving click target so users don't have to pixel-aim through silhouette gaps. Selection ring is a billboarded sprite with a custom canvas-built annular gradient. Floating label is a `<Html>` from drei, tagged `pointer-events-none` so clicks reach the body, with badges for "here" (active) and "home".
  - `shell/components/arena/Arena.tsx` — top-level scene composition: the canvas, ambient + warm key + cool rim lights, the starfield, the four asteroid bodies, OrbitControls (matching the public site's polar/zoom limits), and `EffectComposer` with bloom + vignette.
  - `shell/components/arena/ArenaSceneClient.tsx` — `next/dynamic` wrapper with `ssr: false`. Three.js can't run on the server (no window/canvas/WebGL); same pattern Astroid.club uses for `HeroSceneClient`.
  - `shell/app/arena/page.tsx` — full-bleed page that hosts a single always-on canvas with HUD overlays. Disconnected state shows a sign-in CTA card; connected state renders the identity strip (top-left), live network stats (top-right), and the bottom asteroid action panel that exposes Mine here / Leave / Set as home / Stake / Set drill / Raid actions for the selection. There is exactly one canvas on the page — auth state only swaps which HUD overlays render on top, so orbit motion stays continuous across sign-in.
- **Wire-up:** the connected snapshot's `asteroids[]` drives which bodies render. Per-asteroid network stats come from the same `network_stats` poll the console uses (5 s interval + immediate refresh after every action). Selection state is local to the page; `home` and `active` are derived from the snapshot.
- **Skipped (intentional, deferred):**
  - **Real orbital paths between asteroid clusters.** The current orbit layout puts every body around the world origin; a more accurate "Inner Belt vs Outer Belt vs Trojan cluster" projection lands with the design pass that expands the fleet to ~20.
  - **Per-class environmental effects.** Solar Flare and Stellar Strike events fire on the server; emitting them as `broadcastEvent` and consuming them as visual flashes in the arena lands when the event taxonomy slice goes in.
  - **Defenders / raiders rendering.** A future slice will render incoming raids as small ships flying between origin asteroids on bezier paths.
- **Quality gate:** `typecheck` (root + shell), `lint:shell`, `prettier --write` on every changed file, full vitest (590/590) all green. Live-tested: shell at `:4001/arena` returns 200 and Three.js compiles 1805 modules in dev. The `npm install` against the shell workspace stays clean (two pre-existing moderate audit advisories from upstream dev deps; no new ones).

### Arena polish: smooth bodies, 20-rock roster, instanced background belt — landed (`frontend_arena_polish` follow-up)

Direct response to feedback that the rocks "looked triangular" and that there were too few of them. Same arena page; richer scene.

- **Smooth, organic asteroid bodies.** Replaced the per-vertex random jitter on a low-detail icosahedron (which left visible flat triangular faces) with a multi-octave 3D Perlin / fbm displacement on a `IcosahedronGeometry(detail=4)` subdivided sphere. Each vertex is offset along its own normal by a smooth noise field; vertex normals are then recomputed so lighting follows the new silhouette. Result: fluid, fluidly curved rocks that read as solid bodies instead of polygonal soup, with no per-frame cost (built once per asteroid on mount). Lives in `shell/components/arena/noise.ts` (new — 3D gradient noise, fbm, hash-string-to-seed) consumed by `AsteroidBody.tsx` and `AsteroidBelt.tsx`.
- **Per-asteroid axial scale** so silhouettes vary at the macro level too — some rocks elongate, some round out. Derived deterministically from the asteroid id so the arena is identical across reloads.
- **Roster expansion: 4 → 20 named asteroids.** `config/asteroids.ts` now seeds five asteroids per resource class (4 × 5 = 20) across four canonical sectors:
  - **Near-Earth** (4): Bennu, Ryugu, Apollo, Eros
  - **Inner Belt** (6): Vesta, Eunomia, Iris, Mathilde, Lutetia, Kleopatra
  - **Outer Belt** (6): Psyche, Davida, Themis, Hygiea, Hilda, Astraea
  - **Trojan / Kuiper** (4): Chariklo, Chiron, Pholus, Nessus
    Real-world asteroid names where possible. Server-side mechanic class (`carbon | silver | gold | oil`) is unchanged — no changes to the economy math or to ported tests.
- **Cosmetic mineral flavor field.** `AsteroidDefinition.flavor?: string` (optional, defaults to capitalized resource) feeds a per-flavor tint map in `AsteroidBody.tsx`. Lets every rock carry a unique mineral identity ("Iridium", "Platinum", "Osmium", "Helium-3", "Water Ice", "Rare Earths", "Cobalt", "Lithium", "Methane Clathrate", ...) without growing the server-side resource taxonomy. Game logic still keys off `resource`; visuals key off `flavor` (with `resource` as the fallback). The flavor surfaces in the floating asteroid label (`Bennu · Carbonaceous`) and in the bottom action panel header.
- **Snapshot extension.** `ConnectSnapshot.asteroids[]` now carries `{id, name, resource, flavor, sector, position}` (was `{id, name, resource}`). `flavor` defaults to the capitalized resource when not set on the definition. Existing tests assert on `id` only (verified — none break); added fields are pure additions. Mirrored in `shell/lib/session.ts` (`AsteroidListing` interface).
- **Orbit derivation from server position.** `shell/components/arena/asteroid-orbits.ts` was rewritten to be pure-functional: `orbitFromListing(asteroid)` projects the server's `position` + `sector` into orbit-radius bands (Near-Earth: ~7.5; Inner Belt: ~12; Outer Belt: ~18; Trojan/Kuiper: ~26) with deterministic per-rock radial jitter, phase derived from the canonical xz-azimuth, and inclination from the y/horizontal-radius ratio. The hard-coded id → orbit map is gone; the design intent now lives on the server. Adding new asteroids to `config/asteroids.ts` immediately makes them appear in the arena without touching arena code.
- **Background asteroid belt.** New `shell/components/arena/AsteroidBelt.tsx` renders ~1500 small non-interactive rocks distributed in a two-layer torus around the world origin: an inner ring (radius 30-40, dark C-type tones) and an outer ring (radius 42-58, with a touch of warm ferrous color). Implemented via `THREE.InstancedMesh` so the per-frame cost is one draw call + one group rotation regardless of count. Each layer is a `<group>` with a slow rotation speed (0.0035-0.0055 rad/s) so the inner and outer belts drift at different rates — gives the belt depth without per-instance updates. One shared FBM-noise rocky geometry per layer (icosahedron detail=2 + 3-octave Perlin); per-instance rotation, position, and slightly anisotropic scale baked into the matrix at mount time and never touched again.
- **Camera + control limits adjusted** for the wider scene: camera moved from `[0, 6, 32]` → `[0, 8, 38]`, FOV 65 → 60, far plane 400 → 600, OrbitControls maxDistance 55 → 90 so the player can pull back far enough to see the whole belt.
- **Verified end-to-end.** Server registers all 20 asteroids in startup logs ("Initialized with 20 asteroids"). The smoke-shell-auth script confirms the connect snapshot returns the new shape with `flavor`/`sector`/`position` populated for every rock. Arena URL is unchanged (`:4001/arena`).
- **Quality gate:** typecheck (root + shell), `lint:shell` (zero warnings), `prettier --write` on all changed files, full vitest (590/590) all green. The 4-asteroid → 20-asteroid expansion did NOT break any test (gateway / world tests only assert on length and `id`, which is what we want).
- **Skipped (deferred to next polish slice):**
  - **Per-instance individual orbits in the belt.** Instances currently rotate as a rigid group around Y; adding per-instance Kepler-ish orbits is a vertex-shader rewrite. Not worth the complexity for atmosphere-only rocks.
  - **Surface normal/bump maps** for additional close-up detail. Big perf win available if we generate procedural bump textures; current FBM displacement on the geometry already reads well at default zoom.
  - **Light-rim shader** for the silhouette pop you'd want during Solar Flare events. Lands with the event-emitter slice.

### `tests/game/scenarios.test.ts` — landed (`tests` slice)

- **Source:** `Black-Gold-main/scripts/test-game-simulation.ts` (9 suites, 68 tests) and `Black-Gold-main/scripts/test-game-formulas.ts` (10 sections, 81 assertions). The formula tests were already covered by `tests/game/types.test.ts` and `tests/game/refinery-manager.test.ts` from earlier porting slices; this slice ports the simulation suite.
- **Destination:** `astroid-club/tests/game/scenarios.test.ts` — single file with one `describe` per BG suite. Each `it` preserves BG's test name verbatim (rethemed) so a future maintainer can grep for "Stake at multiple mines" / "Stake at multiple asteroids" and find both source and port.
- **Renames applied:** test name and assertion theme rewrites per `GLOSSARY.md` — "mine"→"asteroid", "vault"→"refinery", "hashrate"→"drill power", "Mine Registration"→"Asteroid Registration", "Vault Distribution"→"Refinery Distribution", BG's `setPendingReward`→`setPendingYield`, `stolenRewards`→`stolenYield`, `home_base_switch`→`home_station_switch`, etc. The 4-fixture asteroid set (`asteroid-carbon/gold/oil/silver`) replaces BG's 4-mine set — all four resource classes are exercised, including carbon (loyalty-bonus quirk), oil (syndicate-scaling quirk), silver (Solar-Flare-was-Silver-Surge quirk), and gold (Stellar-Strike-was-Gold-Rush quirk).
- **Numerical changes:** (none — every numerical assertion matches BG byte-for-byte; if any of these fail, the port has silently drifted)
- **Architectural changes:**
  - **Driving the world, not the singletons.** BG's sim called `getMineRegistry()`, `getStakeManager()`, etc. — module-level singletons that had to be reset between suites. astroid drives `world.joinAsteroid` / `world.stake` / `world.startExpedition` (the public API of `GameWorld`) where possible, and falls through to `world.registry` / `world.stakeManager` / `world.refinery` only where BG's assertions need direct module state. Each `describe` constructs a fresh `GameWorld` in `beforeEach`; no singletons, no resets.
  - **Authentication step.** BG had no auth. astroid's `GameWorld` gates every action behind `authedWallets`, so each suite calls `connectAll(world, [...])` in `beforeEach` to authenticate the wallets it'll use. The connection step is the only systematic deviation from BG's source.
  - **Formula-audit bookend.** A final `describe` block re-asserts BG's exact formula values (drill-power multipliers, defense-power formula, attack-power components, STAKE_TIERS shape) anchored against the same imports the scenario tests use. This way a regression in either the formula OR the import path is caught here.
- **Skipped (intentional):**
  - **(none)** — every BG test mapped to an astroid scenario. Some of BG's "stake at multiple mines" type tests were already covered by per-module tests in earlier slices, but they're re-asserted here through the `GameWorld` API as wiring sanity checks.
- **Tests:** the file IS the test. 63 scenario tests across 9 BG-mapped suites + 4 formula-audit re-assertions = 67 new tests. Total project test count: 590 (from 527).
- **Quality gate:** `typecheck`, `lint`, `prettier`, `vitest run` all green (590/590; 67 new). Every test passed first try with no behavioral drift, confirming the port is numerically identical to BG.

### `server/verification/holder-tracker.ts` + `server/chain/holder.ts` — landed (`holder_verification` slice)

- **Source:** `Black-Gold-main/server/solana/holder.ts` (verifyHolder, balance reads, time-weighted history); `Black-Gold-main/config/holder-tiers.ts` was reviewed but not ported (tiered market-cap thresholds deferred — see "Skipped" below).
- **Destination:**
  - `astroid-club/server/verification/holder-tracker.ts` — pure in-memory `HolderTracker` (eligibility brain).
  - `astroid-club/server/chain/holder.ts` — `BalanceReader` interface + `SolanaBalanceReader` (production RPC reader) + `HolderChainAdapter` (cache + tracker glue, supplies `ChainOps.impls`).
- **Renames applied:** "tokens to mine" / "miners" framing kept (asteroid-mining is still mining); BG's `BalanceHistory.firstSeenAboveThreshold` (Date) → `BalanceObservation.firstSeenAboveThresholdMs` (number — easier to reason about with injected clocks); `verifyHolder` (free function) → `HolderChainAdapter.verifyHolderQualified` (method); `verificationCache` (module-level Map) → `HolderChainAdapter.cache` (instance Map).
- **Numerical changes:**
  - `MIN_HOLD_TIME_MS = 600_000` → `minHoldMs = 600_000` (default unchanged; now configurable per tracker instance and read from `runtime.holderMinHoldSeconds * 1000` at boot).
  - `MIN_CONSECUTIVE_VERIFICATIONS = 2` → `minConsecutiveObservations = 5` (default raised — see "BG bug fix" below).
  - Cache TTL kept at 30s (BG's `CACHE_DURATION_MS`); now configurable per adapter.
- **Architectural changes:**
  - **Pure-logic / chain-side split.** BG's `verifyHolder` mixed RPC reads, caching, and eligibility logic into one async function. astroid.club splits these so the eligibility brain (the part that decides `eligible: true | false`) is unit-testable without any chain mocks. The chain adapter is a thin shim: read balance → ask tracker → return boolean.
  - **`BalanceReader` interface.** Production reads use `SolanaBalanceReader` (Helius DAS REST when `HELIUS_API_KEY` is set, falls back to standard `Connection.getParsedTokenAccountsByOwner`). Tests inject a `FakeReader` that returns canned values, throws on demand, and counts calls. The `@solana/web3.js` import is contained to one file — `server/chain/holder.ts` — keeping the audit surface minimal.
  - **Read-through cache, no stale fallback.** BG's `verifyHolder` returned the cached value on RPC error (even after expiry). astroid.club's adapter does NOT — failed reads propagate to the caller. Reason: the original behavior lets attackers extend a stale balance's validity window simply by causing transient RPC errors. Better to surface the error and let the gateway return a "try again" envelope to the client.
  - **No first-observation grace.** BG allowed first-observation to pass, with the comment "grace period for new users". This is exactly the flash-loan attack vector — an attacker borrows tokens, hits the verify endpoint once, and is granted access. astroid.club's `HolderTracker` denies first-observation unconditionally (with `eligible: false, reason: 'flash_loan_guard'`). The tracker creates the history record so subsequent observations can mature toward eligibility. Operators wanting a UX grace period should buffer the first verify call client-side and retry after a delay (the second call is then the first that the user actually sees fail-or-pass).
  - **Threshold-dip resets tracking.** A single below-threshold observation deletes the wallet's history. This is preserved bit-for-bit from BG (`balanceHistory.delete`) and prevents an attacker from accumulating eligibility credit by bouncing around the threshold. There's a dedicated test that hammers the dip-bounce path 100 times and confirms the attacker's hold count remains at 1.
- **BG bug fix (intentional divergence):** BG's flash-loan guard was dead code. The check was `if (holdDuration < MIN_HOLD_TIME_MS && consecutiveVerifications < MIN_CONSECUTIVE_VERIFICATIONS) { isEligible = false }`. With `MIN_CONSECUTIVE_VERIFICATIONS = 2` and the count being incremented before the check, every observation past the first had `consecutiveVerifications === 2`, so the `&&` was always false and the guard never blocked anyone. astroid.club:
  - Switches `&&` to `||` (block while EITHER gate is unsatisfied — semantics now match the comment in BG's source).
  - Raises the consecutive-observations default from 2 to 5 (with the OR semantic, 2 is redundant with the time gate).
  - Documents the divergence in the file header and via tests (`'NEVER passes through on first call (BG quirk explicitly fixed)'`, `'the attacker cannot bypass the guard by dipping repeatedly'`).
- **Skipped (intentional):**
  - **Tiered market-cap thresholds (`config/holder-tiers.ts`).** BG had 8 tiers (Genesis…Mass) keyed off market cap. astroid.club uses a single fixed `holderMinBalance` from `runtime` for now; a follow-up `holder_tiers` slice can wire a market-cap source (CoinGecko/buyback service) and reintroduce the tier table. The tracker takes `requiredBalance` per call so swapping in dynamic thresholds is mechanical.
  - **`updateMarketCap` / `getMarketCap` module-level state.** Mooted by the previous bullet — when tiers come back they should be DI'd into the adapter, not module globals.
  - **`fees.ts` and any tooling that moves SOL/$ASTROID.** This slice is read-only by mandate.
- **Tests:**
  - `tests/verification/holder-tracker.test.ts` — 34 tests:
    - **Below-threshold path (4)**: returns `below_threshold` reason; zero balance / zero threshold edge case; no tracking entry created.
    - **First observation (4)**: returns `flash_loan_guard`, full `minHoldMs` remaining, tracking record created, asserts BG's first-observation grace is GONE.
    - **Time gate (4)**: blocks under threshold; passes at exactly `minHoldMs`; passes well over threshold; off-by-one (`minHoldMs - 1` blocked).
    - **Consecutive gate (3)**: passes at exactly the configured count; blocks one below; documents `minConsecutiveObservations=1` as an explicit opt-out.
    - **Both gates (1)**: eligible when both satisfied.
    - **Threshold dip (2)**: single dip resets; attacker cannot accumulate via 100 dip-bounce cycles.
    - **Isolation (3)**: per-wallet isolation, `clear`, `clearAll`.
    - **Input validation (5)**: NaN/Infinity/negative balance and required.
    - **Constructor validation (4)**: rejects negative `minHoldMs`, `minConsecutiveObservations < 1`; accepts `minHoldMs=0`; defaults match BG.
    - **Logging (4)**: first observation logs both `tracked` and `flash-loan guard`; flash-loan denials log; passing eligibility doesn't log; below-threshold doesn't log.
  - `tests/chain/holder.test.ts` — 19 tests:
    - **Cache (8)**: first-call reader hit; cached within TTL; reader hit after TTL; per-wallet isolation; `cacheTtlMs=0` disables cache; reader errors propagate (no stale fallback); failed reads not cached; `invalidateCache` / `clearCache`.
    - **Eligibility flow (6)**: false on first observation; false below threshold; true after time gate; true after consecutive gate; false after balance dip (resets); cached balance reused across `verify` calls.
    - **Constructor validation (3)**: negative `requiredBalance`, Infinity `requiredBalance`, negative `cacheTtlMs`.
    - **`SolanaBalanceReader` smoke (3)**: constructs without error; reads via Helius (injected fetch returns canned JSON; URL contains the wallet and the devnet host); zero balance when the wallet doesn't hold the mint.
- **Quality gate:** `typecheck`, `lint`, `prettier`, `vitest run` all green (559/559 tests; 53 new — 34 tracker + 19 chain adapter).
- **Wire-up:** `server/index.ts` constructs `HolderTracker` + `SolanaBalanceReader` + `HolderChainAdapter` only when `runtime.chainEnabled === true` and required config (`rpcUrl`, `astroidMint`) is present. With chain off, none of the chain-side classes are constructed at all and the relevant `ChainOps` methods return `disabled` from layer 3. `docs/CHAIN_AUDIT.md` is updated to reflect that `getHolderBalance` and `verifyHolderQualified` are now **landed** (the rest remain stubs by design).

### `server/chain/index.ts` — landed (`chain_flag` audit, sub-slice 1 of 2)

- **Source:** N/A — astroid.club does not currently have any direct Solana SDK code (verified via `rg`); the BG modules `solana/staking.ts`, `solana/rewards.ts`, `solana/buyback.ts`, `solana/holder.ts`, `solana/utils.ts` will land op-by-op in dedicated future slices, each behind this facade.
- **Destination:**
  - `astroid-club/server/chain/index.ts` — `ChainOps` facade (single chokepoint for chain side effects)
  - `astroid-club/docs/CHAIN_AUDIT.md` — operator-facing audit document
- **Renames applied:** (no BG → astroid renames; this is a new module)
- **Numerical changes:** (none — all numerical thresholds for chain ops live in their respective implementation slices)
- **Architectural changes:**
  - **Three-layer kill switch design.** `CHAIN_ENABLED` is now load-bearing in three independent layers:
    - **Layer 1: env flag.** `runtime.chainEnabled` (existing). One bit flips the platform.
    - **Layer 2: orchestrator gates.** `DistributionService.chainEnabled` and `YieldOrchestrator.chainEnabled` (existing). They never invoke the registered callback when the flag is off; instead they route to `stakeManager.addPendingYield`.
    - **Layer 3: ChainOps facade.** _(new)_ Every chain op has a single entry point on `ChainOps` that re-asserts `chainEnabled` and returns a `disabled` sentinel when off. Adding a new SDK call to a random module bypasses layer 2; it cannot bypass layer 3 because the SDK is restricted to `server/chain/*` (a follow-up ESLint rule will enforce this).
  - **`ChainOps` facade.** Methods covering the full BG chain surface: `executeYieldPayout`, `buildBetEscrowDeposit`, `verifyBetEscrowDeposit`, `executeBuyback`, `getHolderBalance`, `verifyHolderQualified`, `getOnChainStake`. Each returns a discriminated union (`disabled` sentinel or success result with signature/data).
  - **Pluggable `impls`.** Each op's SDK implementation is a callback supplied via `ChainOpsImplementations`. Implementation slices construct their impl and pass it via `new ChainOps({ runtime, impls: { ... } })`. The facade itself imports zero `@solana/*` code. This keeps the SDK out of `ChainOps` (it only knows about the gate) and makes the SDK code unit-testable in isolation when each slice lands.
  - **Fail-loud, not silently-degrade.** When `chainEnabled === true` and an op has no impl wired, `ChainOps` throws `ChainOpNotImplementedError(opName, sliceName)`. The boot fn is responsible for catching and refusing to start (loss of funds is worse than a crash). When the impl exists but rejects (RPC error, bad signature, etc.), the error propagates to the caller; only the `toYieldPayoutListener` adapter swallows errors (because the orchestrator's payout path is fire-and-forget).
  - **Belt-and-suspenders config check.** Constructor throws `ChainMisconfiguredError` if `chainEnabled === true` but `rpcUrl` or `astroidMint` is unset. `runtime.ts`'s `requireEnv` already throws at boot for the same condition; `ChainOps` re-asserts because the runtime parser only runs once at module load and tests construct their own runtime objects.
  - **YieldPayoutListener adapter.** `chainOps.toYieldPayoutListener()` returns a sync function matching `DistributionService.YieldPayoutListener`. It re-checks `chainEnabled` (defense in depth — the orchestrator already gates), forwards to `executeYieldPayout`, logs success and failures, and is fire-and-forget. The boot fn passes this directly to `GameWorld({ onYieldPayout })` so the wire is complete: orchestrator → chainOps → impl.
  - **Boot wire-up.** `server/index.ts` now constructs `new ChainOps({ runtime })` once and passes `chainOps.toYieldPayoutListener()` to `GameWorld`. The chain warning is rephrased: instead of "wiring not done, falling back to in-memory" (silent degradation), it now warns that unwired ops will _throw at the call site by design_.
- **Skipped (intentional):**
  - **No SDK code in this slice.** The facade is a pure gating layer. Each chain op's SDK code lands in its own slice (`chain_yield_sink`, `chain_bet_escrow`, `chain_buyback`, `holder_verification`).
  - **No ESLint rule yet.** A static check that `@solana/*` imports may only appear in `server/chain/` is on the followup list. The current state is verified manually via `rg`.
- **Tests:**
  - `tests/chain/ops.test.ts` — 32 unit tests:
    - **chainEnabled=false (8 ops + adapter)**: every method returns `{ ok: false, disabled: true }`; the supplied impl is ignored when the flag is off (impl spy never called); the listener adapter no-ops and warns when invoked.
    - **chainEnabled=true with no impls (8 ops)**: every method throws `ChainOpNotImplementedError`; the error names the implementing slice.
    - **chainEnabled=true with full impls (9 cases)**: every method delegates to the impl and wraps the return value into the typed result; the listener adapter forwards calls and swallows impl rejections (logs them).
    - **Misconfiguration guards (4 cases)**: throws `ChainMisconfiguredError` when on but `rpcUrl` or `astroidMint` is missing; error message names the missing field; does NOT throw when off, even with all chain config missing.
- **Quality gate:** `typecheck`, `lint`, `prettier`, `vitest run` all green (472/472 tests; 32 new chain tests).
- **Operator-facing audit:** `docs/CHAIN_AUDIT.md` enumerates every op, its three-layer gating state, the verification commands (`rg`, vitest, runtime smoke), and the "adding new chain code" procedure that makes the layer-3 invariant easy to maintain.

### `server/net/gateway.ts` + `server/index.ts` — landed (sub-slice B of `wire_engine`)

- **Source:** `Black-Gold-main/server/index.ts` (the connection / dispatch / signature halves of the 2,300-line monolith)
- **Destination:**
  - `astroid-club/server/net/gateway.ts` — `AstroidGateway` mounting `GameWorld` behind the engine's `WSGateway` + `Protocol` + `WalletVerifier`
  - `astroid-club/server/index.ts` — production boot fn (replaces the Phase 0 stub)
- **Renames applied:**
  - `verifySignedAction` from BG's `auth/verify-wallet.ts` → engine's `WalletVerifier.verifySignedAction` (no astroid.club code; we call into the engine directly).
  - BG `parseMessage` + `validatePayload` + `RateLimiter` mid-loop checks → engine's `Protocol.parse` + zod-validated `GameMessage` + `WSGateway`'s built-in connection-level `RateLimiter` + per-action `AntiCheatService.checkAction`.
  - BG `clientConnections: Map<WebSocket, ClientConnection>` ad-hoc bookkeeping → engine's `Connection.meta` shaped to `{ walletAddress?: string }`.
- **Numerical changes:** (none)
  - All thresholds come from the engine defaults (`RateLimiter`: 100/60s/300s) and the world's `AntiCheatService` (10/60s/3-per-IP/3-IPs-per-wallet). Both match BG within a constant or document the match in their respective slice.
- **Architectural changes:**
  - **Three engine primitives instead of one bespoke server.** `WSGateway` owns ws lifecycle, control-message handling, room registry, and connection-level rate limiting. `Protocol` parses zod-validated messages. `WalletVerifier` issues nonces + verifies signed actions over a pluggable `Storage`. The gateway file is ~330 lines vs BG's 2,300.
  - **Auth flow.** Three messages (`request_nonce` → `auth` → game messages):
    1. Client sends `request_nonce { walletAddress }`. Server calls `verifier.issueNonce(...)`, replies `result { nonce, message, app, ttlMs }`.
    2. Client signs the canonical `message` with the wallet, sends `auth { walletAddress, nonce, signature }`.
    3. Server calls `verifier.verifySignedAction(...)`. On success stamps `walletAddress` onto `conn.meta` and emits the connect snapshot.
       Subsequent game messages are gated by `POST_AUTH_TYPES.has(type) && meta.walletAddress`.
  - **Engine bug worked around: `timestamp` in canonical message.** The engine's `WalletVerifier.createSignatureMessage(...)` stamps `Date.now()`, but `verifySignedAction(...)` reconstructs the canonical message with `timestamp: 0` for verification (both the primary check and the legacy fallback). Handing the client a `Date.now()` message would always fail the signature check. The gateway builds the canonical with `timestamp: 0` directly (matches what the verifier reconstructs server-side). Documented in code; a clean fix in the engine is a follow-up commit on `Enhanced-Game-Engine`.
  - **Per-action anti-cheat hook.** Every dispatched message goes through `world.antiCheat.checkAction(wallet, ip)` BEFORE world dispatch. Connection admission goes through `world.antiCheat.checkConnection(...)`. Successful actions clear backoff; rejected/failed actions feed `recordFailedAction` to drive exponential backoff. Both are independent of the gateway's own connection-level rate limiter.
  - **Wire envelopes are simple.** `result | error | event` discriminator on `type`. `requestId` echoes the client's correlation id when present. `error` codes match `WorldErrorCode` from the world (one-to-one mapping).
  - **Event broadcast hook.** `gateway.broadcastEvent(event, data)` produces an `EventEnvelope` and forwards through the engine's `WSGateway.broadcast(...)`. Used by future server-pushed events (raid_started, refinery_distribution, ...).
  - **Lifecycle.** `start()` calls `world.start()` and schedules `world.tick()` every `tickIntervalMs` (default 60s; tests pass 0 to disable). `stop()` clears the tick interval, stops the world, and closes the gateway. Idempotent.
- **Boot fn (`server/index.ts`) changes:**
  - Plain Node `http.Server` for health probes and CORS preflight responses (matches BG's Railway-friendly pattern). All upgrade requests forward to `WSGateway` (we pass `server: httpServer` to the gateway constructor).
  - `/health` returns `{ status: 'ok', chainEnabled, server }`. Future REST endpoints (staking, escrow) plug in via the same dispatcher.
  - SIGINT / SIGTERM trigger `gateway.stop()` then `httpServer.close(...)` for clean shutdowns.
- **Tests:**
  - `tests/net/gateway.test.ts` — 11 integration tests against a real `AstroidGateway` on an ephemeral port, with the `ws` package as the client. Each test signs a real `tweetnacl` ed25519 signature against a freshly generated keypair, so the auth flow runs end-to-end (no mocks):
    - full nonce → auth → snapshot handshake (with `requestId` echo)
    - bogus signature → `error/rejected`
    - post-auth message before auth → `error/not_authenticated`
    - dispatch: `join_asteroid` (success), unknown asteroid (`unknown_asteroid`), full `set_home_station + stake + claim_yield` flow, `network_stats`, `miner_snapshot`
    - zod validation rejection (negative stake amount) → `error/invalid_message`
    - lifecycle: idempotent `start()`/`stop()`, `broadcastEvent` reaches every client
- **Quality gate:** `typecheck`, `lint` (zero warnings), `prettier`, `vitest run` all green (440/440).
- **Skipped from BG (intentional):**
  - **Admin console** (`admin_auth`, `admin_subscribe`, `admin_action`, periodic `broadcastAdminUpdates`). Out of scope for this slice; will land later behind `runtime.adminSecret`.
  - **REST `/api/staking/*` and `/api/escrow/*`** transaction-building endpoints. Land with the chain-gated bet-escrow + staking slice.
  - **PoW share submission** (`hashrate` PoW shares, `submit`, `request_work`, `result`, `discovery_pending`, dynamic difficulty broadcasts). astroid.club is time-based.

### `server/verification/anti-cheat.ts` — landed

### `server/verification/anti-cheat.ts` — landed

- **Source:** `Black-Gold-main/server/verification/anticheat.ts`
- **Destination:** `astroid-club/server/verification/anti-cheat.ts` (hyphenated to match the rest of the repo)
- **Renames applied:**
  - `AntiCheatService` — kept (class name unchanged)
  - `submission` (everywhere in the public surface) → `action` — `checkSubmission` → `checkAction`, `recordFailedSubmission` → `recordFailedAction`, `recordSuccessfulSubmission` → `recordSuccessfulAction`. astroid.club applies these limits to ALL high-frequency wallet actions (expedition start, bet placement, raid join, yield claim) — there is no PoW-share concept to limit.
  - `RATE_LIMIT_CONFIG.MAX_SUBMISSIONS_PER_MINUTE` → constructor option `maxActionsPerWindow`
  - `recordSubmissionFailure` → `recordFailedAction`
  - Severity emoji glyphs in console output → plain text tags (`[LOW]`, `[MEDIUM]`, `[HIGH]`, `[CRITICAL]`) so the injectable `GameLogger` doesn't have to render glyphs
  - Module-level singleton (`getAntiCheatService` / `resetAntiCheatService`) dropped — class is instantiated by the boot layer
- **Numerical changes:** (none) — every threshold matches BG exactly:
  - `maxActionsPerWindow = 10`
  - `windowMs = 60_000`
  - `initialBackoffMs = 1000`
  - `backoffMultiplier = 2`
  - `maxBackoffMs = 60_000`
  - `maxConnectionsPerIp = 3`
  - `maxIpsPerWallet = 3`
  - `cleanupIntervalMs = 60_000`
  - `maxLogEntries = 10_000`
  - 1-hour sybil window — preserved
  - 24-hour rate-limit / IP-tracker stale window — preserved
- **Architectural changes:**
  - **Class with full DI.** No singleton, no env-var lookup; every threshold is a constructor option with a BG-matching default. Multiple game worlds can each have their own anti-cheat instance.
  - **Configurable logger.** All log lines go through the injected `GameLogger`. Tests pass `{ info: () => {}, ... }` to silence output.
  - **Manual or auto cleanup.** `autoStart: true` schedules the periodic `cleanupExpiredEntries()` interval (BG default). Tests pass nothing and call `cleanupExpiredEntries()` manually for determinism.
  - **`SuspiciousActivityType` exported** as a string union; `getStats().suspiciousEventsByType` is now a `Record<SuspiciousActivityType, number>` so callers can iterate type-safely.
  - **`WalletSybilStatus` snapshot type** exported for use by admin UIs.
  - **`stop()` is idempotent and safe before `start()`** so DI container teardown can call it unconditionally.
- **BG behaviours preserved (with explicit test coverage):**
  1. **LOG-AND-ALLOW for sybil-flagged wallets.** Flagging never blocks an action. The `SYBIL_FLAG` log row is emitted on every subsequent `checkAction` so reviewers can correlate. Verified in `flagged wallets are still allowed to act`.
  2. **Backoff is per-wallet, independent of the rate-limit window.** A wallet in backoff is blocked even if its window count is well below the cap. The `BACKOFF_ACTIVE` log row records the remaining backoff. Verified across the backoff suite.
  3. **`recordSuccessfulAction` clears backoff completely** (resets `failedCount` to 0, removes `backoffUntil`). BG behaviour, not the typical "decrement" pattern.
  4. **Cleanup never auto-clears sybil flags.** Only `unflagWallet()` (operator action) lifts a flag. Stale IP entries get pruned but the flag persists across cleanup.
  5. **`maxLogEntries` is a hard FIFO cap.** Old rows roll off when new ones land.
- **Logging:** routed through injectable `GameLogger`. Default logger forwards to `console.{info,warn,error}`.
- **Tests:** `tests/verification/anti-cheat.test.ts` — 37 tests covering: construction (no auto-start by default; `autoStart: true` schedules interval; idempotent `stop()`); per-IP connection caps (admit, reject 4th, custom cap, disconnect frees slot, unknown-IP disconnect no-op); sliding-window action rate limiting (admit-up-to-cap, block 11th with retryAfterMs, window slide, custom cap, per-wallet independence); exponential backoff (1s/2s/4s/8s doubling, cap at 60s, expiry, success-clears-state, `resetBackoff` admin helper, HIGH severity at >=5 failures); sybil flagging (no flag below threshold, flag at threshold with reason and IP list, repeat-IP no-count, LOG-AND-ALLOW behaviour, custom threshold, `unflagWallet` semantics, empty-status for unknown wallets); stats and logging (zero on fresh service, accurate counts, group-by-type, severity filter, FIFO log cap); cleanup (drops stale wallet IPs after 1h, drops idle IP trackers after 24h, drops old rate-limit entries after 24h, preserves active IP trackers regardless of age). All passing.

### `server/solana/holder.ts`

- **Source:** `Black-Gold-main/server/solana/holder.ts`
- **Destination:** same path
- **Renames applied:** `TOKEN_*` env vars → `ASTROID_*`; player-visible strings updated.
- **Numerical changes:** (none) — flash-loan mitigation timings preserved.
- **Read-only enforcement:** this file makes RPC reads only; there is no write surface to gate. CHAIN_ENABLED toggles whether the read happens at all (vs. dev-mode stub).
- **Tests:** `tests/solana/holder.test.ts`

---

## Phase 2 — Privy wallet sign-in

### Privy as the production wallet source — landed

The dev keypair stays as the local-dev fallback; Privy becomes the wallet source whenever a Privy app id is configured. The auth handshake stays identical end-to-end — only the source of the public key + signature changes.

- **Files added:**
  - `shell/lib/wallet-source.ts` — narrow `WalletSource` interface (publicKey + async signMessage returning base64). The auth handshake imports nothing else from any specific wallet provider.
  - `shell/lib/wallet-mode.ts` — single source of truth for `PRIVY_APP_ID` / `WALLET_MODE`. Read once at module load so the rules-of-hooks invariant in `useWalletSource()` holds across all renders of any given build.
  - `shell/lib/wallet-source-context.ts` — shared React Context. Lives in its own file so the Privy and dev providers can both publish into it without circular imports.
  - `shell/lib/wallet-source-providers.tsx` — `RootWalletProviders` (the top-level switch), `DevWalletProvider`, the `PrivyModeGate` two-phase mount, and the public `useWalletSource()` hook.
  - `shell/lib/wallet-source-privy.tsx` — Privy implementation, dynamically imported with `ssr: false`. Mounts `<PrivyProvider>` with the locked-down "external Solana wallets only" config and translates the active `ConnectedStandardSolanaWallet` into our canonical `WalletSource`.

- **Files changed:**
  - `shell/lib/dev-keypair.ts` — added `devKeypairAsWalletSource()` so the dev keypair flows through the same `WalletSource` interface as Privy. The handshake is unchanged.
  - `shell/lib/session.ts` + `shell/lib/use-session.ts` — `connectSession({ wsUrl, source })` and `connect(wsUrl, source)` now take a `WalletSource` instead of a `DevKeypair`. `signMessage()` is awaited once during the `request_nonce` → `auth` handshake.
  - `shell/app/layout.tsx` — wraps the chrome in `<RootWalletProviders>`; the rest of the layout is unchanged.
  - `shell/app/page.tsx` — landing page calls `useWalletSource()`. Adds a "Secured by Privy" badge under the verify CTA in privy mode (links to `https://privy.io`) and a "Dev mode · local keypair" badge in dev mode. The verify button is disabled until `wallet.ready`.
  - `shell/app/sign-in/page.tsx` — sign-in routes through `wallet.connectWallet()` → `connect()`. Copy and headline switch on `wallet.mode` so privy and dev users see appropriate text. The "rotate keypair" button is replaced by "sign out" in privy mode.
  - `shell/app/arena/page.tsx` + `shell/app/console/page.tsx` — auto-connect on mount only when `wallet.source` is already non-null. Dev mode auto-connects (the keypair is always present); privy mode only auto-connects if the user already authorized this app in a previous session, so we never silently spring the wallet modal on a cold visit.
  - `shell/next.config.mjs` — webpack `externals` for Privy's optional Solana peer deps (`@solana/kit`, `@solana-program/{memo,system,token}`, `@farcaster/mini-app-solana`, `@abstract-foundation/agw-client`, `permissionless`). Privy uses these only for embedded-wallet transaction signing; we sign messages with external wallets only and never touch those code paths.

- **Privy posture (locked):**
  - `walletChainType: 'solana-only'` — no EVM modal entries.
  - `loginMethods: ['wallet']` — wallet picker only; no email / social / passkey routes.
  - `embeddedWallets.{solana,ethereum}.createOnLogin: 'off'` — Privy never custodians a key. Holders bring their own Solana wallet (Phantom / Solflare / Backpack / Glow / etc.) — required for the holder-verification gate to be meaningful.
  - `toSolanaWalletConnectors({ shouldAutoConnect: false })` — extension popups don't fire on every cold page load. The modal only surfaces when the user explicitly clicks "Verify".

- **Why a two-phase mount in privy mode (`PrivyModeGate`):** Privy's React SDK is heavyweight (≈650 packages including its WalletConnect / MetaMask SDK siblings). Loading it under SSR explodes — its optional Solana peers (`@solana/kit`, `@solana-program/*`) aren't installed and Webpack can't resolve them on the server pass. Two cleanups in series fix that:
  1. The `wallet-source-privy.tsx` module is imported via `next/dynamic({ssr: false})`. The Privy chunk never enters the server bundle.
  2. During SSR / first paint we publish a `PRIVY_SSR_STUB` Context value (`source: null, ready: false, mode: 'privy'`). The page is interactive immediately on locked-landing copy; the verify button just stays disabled until the Privy chunk arrives. After hydration `useEffect` flips a flag and the real `PrivyWalletShell` mounts.

- **Why dev mode is still here:** Local development should not block on a Privy app id. With no `NEXT_PUBLIC_PRIVY_APP_ID` set, the build mounts `DevWalletProvider` instead — a `localStorage`-backed ed25519 keypair via tweetnacl. The auth handshake doesn't know or care which mode it's in; both modes produce the same `WalletSource` shape.

- **Tests:** No new vitest cases — Privy's React hooks aren't exercised under jsdom in this slice. Coverage is provided by:
  - The full server suite (`590/590` tests still passing) — the handshake's wire format is unchanged.
  - `scripts/smoke-shell-auth.mjs` — independently re-implements the request_nonce → sign → auth flow against the running gateway. Validates that the wire protocol stayed bit-stable through the wallet-source refactor.
  - HTTP smoke against `/`, `/sign-in`, `/arena`, `/console` in BOTH modes (dev and privy with a placeholder `NEXT_PUBLIC_PRIVY_APP_ID`). Confirmed: dev mode renders the dev badge, privy mode renders the "Secured by Privy" badge linked to `https://privy.io`, both modes return 200 and contain the locked-landing "Knock, knock." copy.

- **Compliance / safety surface:** The Privy badge is rendered as a real `<a href="https://privy.io" target="_blank">` so users can verify the integration before clicking. The locked landing already discloses that verification is read-only; nothing in the wallet-source refactor relaxes that. The "external wallets only" posture means Privy never holds keys for our users.

---

## Phase 2 — verify_holder end-to-end

### `verify_holder` wire path + Club gate — landed

The auth handshake now feeds into a separate, explicit holder-eligibility check. The landing page's "inside the club" view only renders once `verify_holder` returns `eligible: true`. With `CHAIN_ENABLED=false` the gateway transparently passes through (`reason: chain_disabled`), so dev / pre-launch traffic flows the full state machine without standing up an RPC.

- **Files added:**
  - `scripts/smoke-verify-holder.mjs` — independent end-to-end smoke (request_nonce → auth → verify_holder) that prints the eligibility envelope. Validates the wire shape stays bit-stable independently of the test harness.

- **Files changed:**
  - `server/net/protocol.ts` — adds `VerifyHolderMessage` to the discriminated union, adds `verify_holder` to `POST_AUTH_TYPES`, exports `HolderEligibilityReason` (`chain_disabled` | `qualified` | `not_qualified`) and `HolderEligibilityData` (the on-the-wire result envelope).
  - `server/net/gateway.ts` — accepts an optional `chainOps` in `AstroidGatewayOptions`; dispatches `verify_holder` through a new `runHolderVerification(walletAddress)` helper that collapses ChainOps's three result shapes (disabled sentinel / data=true / data=false) into one envelope. Wallet identity comes from `meta.walletAddress` so a post-auth client cannot probe other addresses' eligibility — even if zod admits an extra `walletAddress` field on the message, the gateway ignores it.
  - `server/index.ts` — wires the constructed `chainOps` into the gateway (was previously only used by the world's yield payout listener).
  - `shell/lib/session.ts` — adds `HolderEligibility` interface (mirrors the server type) and a typed `Session.verifyHolder()` convenience method.
  - `shell/app/page.tsx` — the landing page now drives a 5-state holder machine (`idle | pending | eligible | not_eligible | error`) off the `Session` lifecycle. Renders three distinct surfaces: locked landing (with a unified "verifying holdings…" CTA label that covers both auth and the holder check), the club inside (with a `qualified` / `chain_disabled` reason badge in the welcome banner), and a new compliant "Not yet, traveller." panel for failed checks. The new panel deliberately doesn't echo the wallet's actual balance — only "this wallet does not currently meet the threshold or hold-time requirement".

- **Why it's a binary gate (not a balance disclosure):** The holder check is a yes/no surface. The wire envelope intentionally does not echo `balance`, `requiredBalance`, or hold seconds. Reasons:
  1. Reduces the attacker's ability to probe exact tracker semantics around the flash-loan mitigation window.
  2. Avoids the UI implying any kind of price-related claim (compliance posture: no balance, no value, no commitments).
  3. Keeps the gateway response stable across future tweaks to threshold or hold-time configuration without breaking client copy.

- **Why the gateway uses `meta.walletAddress` not the message body:** Post-auth, only one identity should drive lookups — the one that proved control of the wallet via the sign-in handshake. If we let `verify_holder` accept a wallet field, an authenticated client could ask the gateway to verify _other_ addresses' eligibility, which is mostly innocuous for a binary check but still leaks information (and risks normalising "client-supplied wallet" patterns we don't want elsewhere). The "always uses the authenticated wallet" gateway test pins this contract.

- **Why `chainOps` is optional on `AstroidGateway`:** Test harnesses, smoke scripts, and any downstream consumer that wants to exercise the auth + game-message flow without standing up a chain shouldn't have to construct a fake `ChainOps`. When `chainOps` is omitted, `verify_holder` returns the same `chain_disabled` pass-through envelope it would return under `CHAIN_ENABLED=false`. Boot fn always passes the real `chainOps` so production behavior is uniform.

- **Tests:** `tests/net/gateway.test.ts` — gateway suite grew from 11 to 18 tests with a new `verify_holder` describe block covering: pre-auth rejection (`not_authenticated`); chain-disabled pass-through with no `chainOps` plugged; chain-disabled pass-through even with an impl plugged but `runtime.chainEnabled === false`; qualified path (`reason: qualified`, ChainOps impl called with the auth wallet); not-qualified path (`eligible: false`, message contains no digits — sanity check that we don't echo a balance); message-body-walletAddress-is-ignored defense in depth; RPC-throws path surfacing as a `rejected` error envelope. Full server suite: 597/597 passing.

- **Smoke:**
  - `node scripts/smoke-verify-holder.mjs` against the live server with `CHAIN_ENABLED=false` returns `{ eligible: true, reason: chain_disabled, walletAddress: <fresh kp>, message: ... }` and exits 0. Independent of the vitest harness — validates the wire format on the running gateway.
  - HTTP smoke against `/`, `/sign-in`, `/arena`, `/console` returns 200; landing page contains the locked "Knock, knock." copy on first paint and reactively flips into the club after sign-in completes the holder check.

---

## Files **not** ported (deliberate)

- `server/middleware/rateLimit.ts` — replaced by the engine's `RateLimiter`. Identical algorithm.
- `server/middleware/validate.ts` — replaced by the engine's `Protocol` zod-validation primitive.
- `server/auth/verify-wallet.ts` — replaced by the engine's `verifySignedAction` (which is itself a port of this file, already in production in the engine).
- `server/storage/redis-store.ts` — replaced by the engine's `RedisStorage`.
- `server/solana/buyback.ts` — removed. No buyback under the free-launch posture.
- `server/solana/staking.ts` — removed in v1; if needed later, the engine's optional `QuarryStakingProvider` will be configured for $ASTROID.
- `server/pool/*` — Black-Gold's mining-pool difficulty / work distribution. Not part of astroid.club's loop; players don't run a hash-pool.
- `app/*` — replaced by the new `shell/` (Next.js) and `arena/` (Vite) hybrid in Phase 2.
