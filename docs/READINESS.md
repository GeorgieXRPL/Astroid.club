# astroid.club — Testing Readiness (single source of truth)

_Last updated: 2026-06-10. This doc reflects the **actual wired state** of the
live mainnet preview, not the design intent. When you change what's wired,
update this file._

---

## TL;DR

The gateway is **live, healthy, and locked to your wallet(s)**. You can sign in,
join asteroids, report drill power, and the holder gate / anti-cheat run for
real.

- **Discovery/mining loop: WIRED ✅** (Phase A). Mining now produces yield —
  time-based discoveries resolve per asteroid and accrue **in-game IOU
  credits** (the sweepstakes posture; no real tokens move while playing).
- **State persistence: WIRED ✅** — the gateway uses the strongest store you
  configure: **`DATABASE_URL` (Postgres/Supabase, auditable ledger)** >
  `REDIS_URL` (balance cache) > in-memory (wiped on redeploy). Production =
  Postgres. See `docs/SUPABASE.md` (prod) / `docs/REDIS.md` (quick).
- **Quarry staking: not deployed** — `stake/claim/redeem` are **gracefully
  rejected** (a friendly `chain_disabled` reply, no server stack trace). _Config gap._
- **IOU redemption → real `$ASTROID`: not deployed** (the Phase B "redeem on
  leave" step needs the IOU mint + Quarry Redeemer + treasury). _Config gap._
- **Per-event on-chain payout (`REWARD_MODE=onchain`): not wired** — only needed
  if you ever abandon the sweepstakes model for direct per-discovery transfers.

---

## 1. What is LIVE right now

**Gateway:** `astroid-club-gw.fly.dev` (Fly.io, region `syd`, 2 machines, health
checks passing).

**Frontend:** `preview.astroid.club` (Vercel, building from `Astroid-miner-2`).

**Confirmed working:**

- WebSocket connect + wallet auth (signature verified).
- **Wallet allowlist** — only wallets in `WALLET_ALLOWLIST` get in; everyone
  else is rejected at auth. (Currently 1 wallet.)
- **CORS / origin lock** — only `preview.astroid.club` and `preview.astroid.space`.
- **Holder gate** (`CHAIN_ENABLED=true`): reads `$ASTROID` balance over RPC,
  Helius pre-warm infers on-chain hold time so long-time holders qualify fast.
- **Game world actions:** `join_asteroid`, `leave_asteroid`, `set_home_station`,
  `report_drill_power`, `start_expedition`, `leave_expedition`, `rally_defense`,
  `claim_yield`, `network_stats`, `miner_snapshot`, `verify_holder`.
- **Raids** pay defender spoils into the in-game pending-yield ledger.
- In-memory anti-cheat, cooldowns, refinery contribution tracking, stake ledger.

**Configured Fly secrets:** `ASTROID_MINT_ADDRESS`, `SOLANA_RPC_URL`,
`HELIUS_API_KEY`, `CORS_ALLOWED_ORIGINS`, `WALLET_ALLOWLIST`, `ADMIN_SECRET`.
**Fly `[env]`:** `CHAIN_ENABLED=true`, `ASTROID_DECIMALS=6`,
`HOLDER_PREWARM_ENABLED=true`.

---

## 2. What is NOT wired yet (and why nothing pays out)

### 2a. Discovery / mining trigger — **WIRED (Phase A)**

`server/game/discovery-engine.ts` is the mining loop. It's **probabilistic** —
a "% chance per seed", not a fixed clock. On every world `tick()`,
`GameWorld.runDiscoverySweep()`:

1. computes the **expected** discoveries this tick per asteroid:
   `expected = totalDrillPower × elapsedMs / (baseDiscoveryTimeMs ×
DISCOVERY_REFERENCE_DRILL_POWER)`,
2. resolves `floor(expected)` finds plus one more with probability equal to the
   fractional part (a Bernoulli roll), capped per tick,
3. picks the **finder** at random weighted by drill power, and computes each
   active miner's `sharePercent` from their drill-power share,
4. calls `YieldOrchestrator.processDiscovery({...})`, which applies the
   per-asteroid yield (`base × resource × asteroid × variance`), the 70/30
   finder/refinery split, and the finder bonus.

So a solo miner at the reference power has a per-tick find chance of
`elapsedMs / baseDiscoveryTimeMs` — on a 60s tick: carbon (5 min) ≈ 20%/min,
silver (8 min) ≈ 12.5%/min, oil (10 min) ≈ 10%/min, gold (20 min) ≈ 5%/min.
The expected time-to-find still equals `baseDiscoveryTimeMs`, but each tick is a
genuine roll (sweepstakes-style variance).

**Payout posture (`REWARD_MODE`, default `ledger`):** discoveries credit the
**in-game pending-yield ledger** — the redeemable IOU credit balance — and fund
the asteroid refinery. No real tokens move during play. Tunable via
`DISCOVERY_REFERENCE_DRILL_POWER` (rate) and
`DISCOVERY_MAX_PER_ASTEROID_PER_TICK` (safety cap). Covered by
`tests/game/discovery-engine.test.ts` and the discovery-sweep block in
`tests/game/world.test.ts`.

> Tuning note: `DISCOVERY_REFERENCE_DRILL_POWER=1` means a single unit of drill
> power finds a discovery in one `baseDiscoveryTimeMs`. If real drill-power
> values are large, raise this so discoveries don't fire every tick. Watch the
> Fly logs for `[DiscoveryEngine] Discovery resolved …` and adjust.

### 2b. IOU redemption → real `$ASTROID` — **NOT DEPLOYED (Phase B, config)**

The sweepstakes model's second half: accrued IOU credits are swapped for real
`$ASTROID` in one explicit step when a player cashes out. The bones exist — a
`build_redeem_tx` gateway message and the Quarry **Redeemer** path
(`IOU_TOKEN_MINT` + `REDEEMER_WALLET_ADDRESS`, the standard "burn IOU → release
real token 1:1"). To turn it on you need an **IOU SPL mint**, a **Quarry
Redeemer** holding a `$ASTROID` treasury, and a bridge from the in-game IOU
credit balance to the on-chain IOU so a redeem reflects what was mined.

> Legal note: whether this structure qualifies as a compliant sweepstakes
> (eligibility, no-purchase-necessary, jurisdiction) is a question for counsel.
> The mechanism is built so redemption is an explicit, separable step.

### 2c. Quarry staking — **NOT DEPLOYED (config)**

Boot log: `CHAIN_ENABLED=true but Quarry addresses unset … On-chain staking
disabled; stake/claim/redeem messages will be rejected.`

The `QuarryStakingAdapter` (build/sign stake, unstake, claim, redeem; verify) is
implemented. It activates only when these env vars are present:

| Env var                   | Required | Notes                                  |
| ------------------------- | -------- | -------------------------------------- |
| `QUARRY_REWARDER_ADDRESS` | yes      | from the guarded deploy                |
| `QUARRY_ADDRESS`          | yes      | from the guarded deploy                |
| `QUARRY_MINT_WRAPPER`     | optional | if using a mint-wrapper emissions path |
| `IOU_TOKEN_MINT`          | optional | IOU staking-receipt mint               |
| `IOU_TOKEN_DECIMALS`      | optional | default 9                              |
| `REDEEMER_WALLET_ADDRESS` | optional | IOU → real-token redeemer              |

Deploy with the guarded script (dry-run by default, refuses mainnet without
`CONFIRM_MAINNET=YES`, sets **no** reward rate so emissions are 0):
`scripts/deploy/deploy-quarry-guarded.ts`. See `docs/DEPLOY_GATEWAY.md` §5.

### 2d. Per-event on-chain payout (`REWARD_MODE=onchain`) — **NOT WIRED (optional)**

Only relevant if you ever drop the sweepstakes model and pay real `$ASTROID`
per discovery instead of accruing IOU credits. The custodial
`RewardPayoutAdapter` (server signs the transfer) activates only when:

| Env var                         | Required | Notes                             |
| ------------------------------- | -------- | --------------------------------- |
| `REWARD_MODE=onchain`           | yes      | switch off ledger accrual         |
| `REWARD_WALLET_PRIVATE_KEY`     | yes      | hot wallet — JSON array or base58 |
| `REWARD_PRIORITY_MICROLAMPORTS` | optional | priority fee, default 5000        |

For the sweepstakes model you do **not** set this — keep `REWARD_MODE=ledger`.

### 2e. State persistence — **WIRED (3 tiers; pick one with an env var)**

The live economy is held in memory (`StakeManager`). On boot,
`GameWorld.restorePersistedState()` reloads durable state from whichever store is
configured. All writes are best-effort (a store blip never crashes the game or
drops a request) and reads stay in memory (no hot-path lag).

| Tier                | Env var        | What it gives you                                                                                                                                                           | Doc                |
| ------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Postgres (prod)** | `DATABASE_URL` | **Auditable, append-only ledger** (`yield_events`) + home stations. Balance derived from the event log; every credit/claim/redeem is a permanent row. **System of record.** | `docs/SUPABASE.md` |
| **Redis (quick)**   | `REDIS_URL`    | Durable **current-balance cache** + home stations. Survives restarts, **no history**.                                                                                       | `docs/REDIS.md`    |
| **In-memory**       | (neither)      | Nothing persists — a redeploy wipes credits.                                                                                                                                | —                  |

Precedence: `DATABASE_URL` > `REDIS_URL` > in-memory. Confirm via the boot log
(`Postgres persistence ENABLED` / `Redis persistence ENABLED` / `IN-MEMORY ONLY`).

- Code: `server/storage/postgres-store.ts` (pg, `db/schema.sql`),
  `server/storage/redis-store.ts` (ioredis); seam = the `YieldLedger` /
  `PendingYieldStore` / `HomeStationStore` interfaces, so swapping stores is a
  drop-in adapter with no game-logic change.
- Tests: `tests/storage/postgres-store.test.ts`,
  `tests/storage/redis-store.test.ts`, and the pending-yield + ledger blocks in
  `tests/game/stake-manager.test.ts`.

> Multi-machine note: a durable store fixes the **restart-wipe** problem. It does
> **not** live-sync two machines mid-session (each restores on boot, then runs
> its own in-memory copy). For consistent live sessions keep the app at **1
> machine** (or add sticky sessions) until a shared-state design lands.

---

## 3. Remaining checklist to "real testing"

| #   | Item                                                                                             | Type | Status |
| --- | ------------------------------------------------------------------------------------------------ | ---- | ------ |
| 1   | Wire the discovery/mining trigger (Phase A)                                                      | code | ☑ done |
| 2   | Tune `DISCOVERY_REFERENCE_DRILL_POWER` to real drill-power magnitudes (watch logs)               | ops  | ☐      |
| 3   | End-to-end test (gameplay-only): join → mine → IOU credits accrue → `claim_yield`                | test | ☐      |
| 3b  | Persistence wired (Postgres ledger + Redis cache + boot restore)                                 | code | ☑ done |
| 3c  | Stand up Postgres: apply `db/schema.sql` + `fly secrets set DATABASE_URL=…` (`docs/SUPABASE.md`) | ops  | ☐      |
| 4   | (Phase B) Deploy IOU mint + Quarry Redeemer + treasury for redemption                            | ops  | ☐      |
| 5   | (Phase B) Bridge in-game IOU credit balance ↔ on-chain IOU                                       | code | ☐      |
| 6   | Deploy Quarry staking (guarded) + `fly secrets set QUARRY_REWARDER_ADDRESS / QUARRY_ADDRESS`     | ops  | ☐      |
| 7   | Restart gateway; confirm "Quarry staking wired" log; full E2E with allowlisted wallet            | test | ☐      |

**Recommended order:** #1 is done — you can test the full mine→earn→claim loop
right now with **zero financial risk** (it credits in-game IOU). Do #2–#3 next.
#4–#7 are the on-chain redemption + staking layer, stageable independently.

---

## 4. Two testing postures

- **Gameplay-only (no real tokens, default — `REWARD_MODE=ledger`):** mining
  accrues in-game IOU credits. Validate the full mine→find→earn→claim loop with
  **zero financial risk**. Staking UI stays disabled until Quarry is deployed;
  IOU redemption stays disabled until Phase B.
- **Full on-chain:** deploy Quarry staking + the Phase B redeemer (and/or set
  `REWARD_MODE=onchain` for per-event transfers). Keep the `WALLET_ALLOWLIST`
  lock on until you're confident.

The allowlist stays on the whole time — flip it off (`fly secrets unset
WALLET_ALLOWLIST`) only when you want to open the doors.
