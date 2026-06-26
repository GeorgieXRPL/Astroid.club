# Production Cutover Runbook — key/wallet rotation + go-live

> **Status:** active cutover plan. Decisions locked for this pass:
>
> - **Addresses are real, rotate the secrets** — keep the existing mainnet Quarry/IOU
>   addresses + `$ASTROID` mint; rotate the Helius key, `ADMIN_SECRET`, and the
>   treasury hot wallet.
> - **Sweepstakes payout posture** — discovery yield stays in-game IOU credits.
>   `REWARD_WALLET_PRIVATE_KEY` is **not** set (no real per-discovery transfers).
> - **Keep the current test allowlist** for now (`WALLET_ALLOWLIST` unchanged).
> - Gateway app: **`astroid-club-gw`** (Fly, region `syd`, keep at **1 machine**).
>
> Anything in `ALL_CAPS_PLACEHOLDER` is a blank you fill in. **Never paste a private
> key or API key into chat, a screenshot, or a commit.** Apply them yourself with
> `fly secrets set` from your own terminal.

---

## Live state snapshot (what's already wired)

Confirmed live on `astroid-club-gw` and healthy:

- WS auth + signature verify, holder gate (`CHAIN_ENABLED=true`), anti-cheat, drill-stake clamp.
- **Quarry staking** end-to-end (`QUARRY_REWARDER_ADDRESS`, `QUARRY_ADDRESS`, `QUARRY_MINT_WRAPPER`, `IOU_TOKEN_MINT`, `IOU_TOKEN_DECIMALS`).
- **IOU redemption / bridge** (`REDEEMER_TREASURY_PRIVATE_KEY`).
- **Raid-wager escrow** (`RAID_VAULT_PERCENT`, durable `escrow_wagers` ledger + `EscrowManager` boot reconciliation). Escrow reuses the redeemer treasury wallet unless `ESCROW_PRIVATE_KEY` is set.
- **Supabase persistence** (`DATABASE_URL`, RLS hardened).
- Emission governor + discovery tuning (`EMISSION_*`, `DISCOVERY_REFERENCE_DRILL_POWER`, `DRILL_STAKE_BOUND`).

Intentionally **not** wired (by design for this launch):

- `executeYieldPayout` — no `REWARD_WALLET_PRIVATE_KEY` ⇒ discovery yield accrues as IOU credits only.
- `executeBuyback` — stub, optional, not a blocker.

---

## Part 0 — Prepare before you touch Fly

Have these ready (offline, in a password manager):

| # | Thing | How |
| - | ----- | --- |
| 1 | **New Helius production key** | Helius dashboard → API Keys → create `astroid.club gateway (production)`. Get the full `https://mainnet.helius-rpc.com/?api-key=...` URL and the bare key. |
| 2 | **Fresh `ADMIN_SECRET`** | `openssl rand -hex 32` |
| 3 | **New treasury hot wallet** | `solana-keygen new -o treasury.json` (keep `treasury.json` offline). This wallet signs IOU redemptions + escrow settlement. |
| 4 | *(recommended)* **Dedicated escrow wallet** | `solana-keygen new -o escrow.json` — separates escrowed wagers from the redemption float (`ESCROW_PRIVATE_KEY`). |
| 5 | **Funding** | Send `$ASTROID` (redemption + defender-spoil float) and ~0.1 SOL (fees) to the new treasury (and escrow, if used). |

> Keypair format for the secret value: either the JSON byte array (`[12,34,...]`,
> i.e. the contents of `treasury.json`) or a base58 string. The loader accepts both.

---

## Part 1 — Rotate the secrets (ordered)

### 1a. Drain / settle the OLD treasury first (escrow + IOU dependency)

The escrow ATA is derived from the treasury wallet. If you swap the key while
wagers are mid-flight, those deposits are stranded in the **old** wallet's ATA.

- Confirm no live raids with open wagers (check `escrow_wagers` where `status` is
  not settled, or just do this during a quiet window).
- Let the gateway run on the **old** key once with no in-flight wagers so
  `EscrowManager.reconcileOnBoot()` refunds/settles anything orphaned.
- For this **test phase** the old balances are throwaway — drain the old treasury
  to a wallet you control (or simply abandon it once `escrow_wagers` is clean).

> IOU credit balances themselves live in Supabase (`yield_events`), **not** in the
> wallet — rotating the treasury key does **not** wipe player credits. It only
> changes who signs payouts.

### 1b. Rotate Helius (RPC + enriched key)

```bash
fly secrets set \
  SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=NEW_PROD_KEY" \
  HELIUS_API_KEY="NEW_PROD_KEY" \
  --app astroid-club-gw
```

- *(optional, best-effort)* IP-lock the key in Helius to the gateway's egress.
  Fly shared-IP egress isn't static; check `fly ips list -a astroid-club-gw` and
  Fly's outbound-IP docs, or skip the lock and rely on key secrecy + a usage alert.
- Set a **Helius usage alert at 80%** of the monthly cap.
- **Revoke the old Helius key** after the new deploy is verified green.

### 1c. Rotate `ADMIN_SECRET`

```bash
fly secrets set ADMIN_SECRET="$(openssl rand -hex 32)" --app astroid-club-gw
```

### 1d. Rotate the treasury wallet (+ optional dedicated escrow wallet)

```bash
# Redemption + (by default) escrow settlement signer:
fly secrets set REDEEMER_TREASURY_PRIVATE_KEY="$(cat treasury.json)" --app astroid-club-gw

# RECOMMENDED hardening: dedicated escrow custody wallet.
# When set, the escrow layer uses THIS key instead of the treasury key.
fly secrets set ESCROW_PRIVATE_KEY="$(cat escrow.json)" --app astroid-club-gw
```

> Using `$(cat treasury.json)` keeps the key off your shell history's argv as a
> literal. Still treat the terminal as sensitive. Delete the local key files once
> they're safely in your password manager.

---

## Part 2 — Tune economy + gating for a public audience

These are still at test defaults. Set the production values:

```bash
fly secrets set \
  HOLDER_MIN_SOL="1" \
  HOLDER_MIN_BALANCE="1250000" \
  HOLDER_MIN_HOLD_SECONDS="1800" \
  --app astroid-club-gw
```

**Holder gate — SOL-pegged, dynamic.** When `HOLDER_MIN_SOL > 0` the required
`$ASTROID` is recomputed live from the Jupiter oracle as
`HOLDER_MIN_SOL × SOL_usd / ASTROID_usd`, so entry stays worth ~N SOL and the
token count **scales down as `$ASTROID`'s price/MC rises**.

- `HOLDER_MIN_SOL=1` → entry worth ~1 SOL. At current prices (SOL ≈ $68.23,
  `$ASTROID` ≈ $0.00005446) that is **~1.25M `$ASTROID`**; it self-adjusts as
  prices move. (Boot log: `holder gate pegged to ~1 SOL of $ASTROID`.)
- `HOLDER_MIN_BALANCE` is the **cold-start floor in token units** (human-readable,
  NOT raw) used only in the sub-second window before the first oracle quote lands.
  Set it near the current pegged value (~`1250000`) so the gate is never loose
  during warmup. To use a **fixed token count instead** (no peg), leave
  `HOLDER_MIN_SOL` unset and set `HOLDER_MIN_BALANCE` to the count you want.
- `HOLDER_MIN_HOLD_SECONDS=1800` (30 min) for sybil/flash-loan resistance. New
  holders inside the window see a live countdown to arena access.

**Emission caps** (currently in `fly.toml` `[env]`, flagged `TODO(before public launch)`):
size `EMISSION_BUDGET` to your real funded IOU backing and lower `EMISSION_DAILY_CAP`
to the intended steady-state. Edit `fly.toml` and redeploy, or override as secrets.

---

## Part 3 — Frontend (Vercel, Production scope)

Set under the Vercel project → Settings → Environment Variables (Production):

| Variable | Value |
| -------- | ----- |
| `NEXT_PUBLIC_PRIVY_APP_ID` | the **production** Privy app id (Solana-only, embedded wallets off, origins `https://astroid.club` + `https://www.astroid.club`, no `localhost`) |
| `NEXT_PUBLIC_ASTROID_WS_URL` | `wss://gw.astroid.club` |
| `NEXT_PUBLIC_SITE_URL` | `https://astroid.club` |
| `NEXT_PUBLIC_SOLANA_CHAIN` | `solana:mainnet` |
| `NEXT_PUBLIC_ARENA_OPEN` | current posture (CTA/nav visible, allowlist still gates entry) |

Then **Redeploy** on Vercel. (`NEXT_PUBLIC_*` is bundled into the browser — never
put a secret here.)

---

## Part 4 — Deploy + verify

```bash
fly deploy --app astroid-club-gw
```

Watch the boot log (`fly logs -a astroid-club-gw`) for:

- `Postgres persistence ENABLED` (Supabase reachable).
- `Quarry staking wired` (staking active).
- `raid-wager escrow wired (escrow=…)` — confirm the escrow address matches the
  **new** treasury/escrow wallet.
- No `IN-MEMORY ONLY`, no `ChainMisconfiguredError`, no `escrow durable store NOT configured`.

Then:

```bash
curl https://astroid-club-gw.fly.dev/health        # {"status":"ok",...}
curl https://gw.astroid.club/health                 # same, via the public host
```

**Smoke test from `https://astroid.club`** (an allowlisted test wallet):

1. Landing renders; footer reads "Part of the Saltaire Protocol ecosystem".
2. How to play loads, no broken entities.
3. Verify with a holder wallet → Privy shows Solana only → sign → "Welcome".
4. Enter the arena → 3D scene + HUD populate.
5. Pick asteroid → Set home → Mine here (no `rate_limited`).
6. Stake a small amount → approve → staked balance updates.
7. Launch a small raid with a wager → confirm escrow deposit, then settle (return/burn) resolves.
8. No red console errors. OG card unfurls when the URL is pasted to Discord/X.

---

## Part 5 — Rollback

- **Gateway regression:** `fly releases rollback --app astroid-club-gw`
- **Frontend regression:** Vercel deploy rollback (one click).
- **Pause all chain ops fast:** `fly secrets set CHAIN_ENABLED=false --app astroid-club-gw` (everyone admitted, no tokens move, site stays usable while you debug).
- **Helius outage:** `fly secrets set HOLDER_PREWARM_ENABLED=false --app astroid-club-gw`.
- **Treasury running low:** send more `$ASTROID` to the treasury/escrow wallet — no redeploy needed.

---

## Appendix — current Fly secret inventory

Set today (rotate the ones marked 🔁):

`ADMIN_SECRET` 🔁 · `ASTROID_MINT_ADDRESS` · `CORS_ALLOWED_ORIGINS` ·
`HELIUS_API_KEY` 🔁 · `SOLANA_RPC_URL` 🔁 · `WALLET_ALLOWLIST` (kept) ·
`DISCOVERY_REFERENCE_DRILL_POWER` · `DATABASE_URL` · `IOU_TOKEN_DECIMALS` ·
`IOU_TOKEN_MINT` · `QUARRY_ADDRESS` · `QUARRY_MINT_WRAPPER` ·
`QUARRY_REWARDER_ADDRESS` · `REDEEMER_TREASURY_PRIVATE_KEY` 🔁 · `RAID_VAULT_PERCENT`

To add this pass: `ESCROW_PRIVATE_KEY` (recommended), `HOLDER_MIN_SOL` (SOL-pegged
gate), `HOLDER_MIN_HOLD_SECONDS`, `HOLDER_MIN_BALANCE` (cold-start floor).

Deliberately **unset** (sweepstakes posture): `REWARD_WALLET_PRIVATE_KEY`,
`REWARD_PRIORITY_MICROLAMPORTS`, `REDIS_URL`.
