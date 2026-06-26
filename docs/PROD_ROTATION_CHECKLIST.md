# Prod Rotation Checklist — key/wallet rotation

> Tick-box companion to [`PROD_CUTOVER.md`](./PROD_CUTOVER.md). That doc has the
> _why_; this is the ordered _do-this-then-that_ with copy-paste snippets.
>
> - Gateway app: **`astroid-club-gw`** (Fly, region `syd`, 1 machine).
> - **Never** paste a private key or API key into chat, a screenshot, or a commit.
>   Run every `fly secrets set` from your own terminal.
> - `UPPER_CASE_PLACEHOLDER` = a blank you fill in.

---

## 0 · Prepare (offline, before touching Fly)

- [ ] **New Helius prod key** — Helius dashboard → API Keys → create
      `astroid.club gateway (production)`. Copy the full RPC URL + the bare key.
- [ ] **Fresh admin secret**

```bash
openssl rand -hex 32          # -> NEW_ADMIN_SECRET
```

- [ ] **New treasury hot wallet** (signs IOU redemptions + escrow settlement)

```bash
solana-keygen new -o treasury.json --no-bip39-passphrase
solana-keygen pubkey treasury.json     # note the address for funding
```

- [ ] **Dedicated escrow wallet** (recommended — isolates wagers from the redemption float)

```bash
solana-keygen new -o escrow.json --no-bip39-passphrase
solana-keygen pubkey escrow.json
```

- [ ] **Fund** the new treasury (and escrow, if used): send `$ASTROID`
      (redemption + defender-spoil float) + ~0.1 SOL (fees) to each pubkey.
- [ ] **Stash** `treasury.json` / `escrow.json` in a password manager. The secret
      value accepts either the JSON byte array (`cat treasury.json`) or a base58 string.

---

## 1 · Drain / settle the OLD treasury first

The escrow ATA is derived from the treasury wallet — swapping the key with wagers
mid-flight strands those deposits in the old wallet's ATA.

- [ ] Confirm no live raids with open wagers (quiet window, or check `escrow_wagers`
      for rows whose `status` is not settled).
- [ ] Let the gateway boot once on the **old** key with no in-flight wagers so
      `EscrowManager.reconcileOnBoot()` refunds/settles orphans.
- [ ] Drain or abandon the old (throwaway test) treasury once `escrow_wagers` is clean.

> Player IOU credits live in Supabase (`yield_events`), **not** in the wallet —
> rotating the treasury key does not wipe balances, only who signs payouts.

---

## 2 · Rotate the secrets (in order)

- [ ] **Helius (RPC + enriched key)**

```bash
fly secrets set \
  SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=NEW_PROD_KEY" \
  HELIUS_API_KEY="NEW_PROD_KEY" \
  --app astroid-club-gw
```

- [ ] **Admin secret**

```bash
fly secrets set ADMIN_SECRET="$(openssl rand -hex 32)" --app astroid-club-gw
```

- [ ] **Treasury wallet** (redemption + default escrow signer)

```bash
fly secrets set REDEEMER_TREASURY_PRIVATE_KEY="$(cat treasury.json)" --app astroid-club-gw
```

- [ ] **Dedicated escrow wallet** (when set, escrow uses THIS key, not the treasury)

```bash
fly secrets set ESCROW_PRIVATE_KEY="$(cat escrow.json)" --app astroid-club-gw
```

> `$(cat treasury.json)` keeps the key out of your shell history's argv. Treat the
> terminal as sensitive; delete the local key files once they're in the vault.

---

## 3 · Economy + holder gate (production values)

```bash
fly secrets set \
  HOLDER_MIN_SOL="1" \
  HOLDER_MIN_BALANCE="1250000" \
  HOLDER_MIN_HOLD_SECONDS="1800" \
  --app astroid-club-gw
```

- [ ] `HOLDER_MIN_SOL=1` — **SOL-pegged dynamic gate.** Required `$ASTROID` is
      recomputed live as `HOLDER_MIN_SOL × SOL_usd / ASTROID_usd`, so entry stays
      worth ~1 SOL and the token count scales **down** as price/MC rises.
      (Boot log: `holder gate pegged to ~1 SOL of $ASTROID`.)
- [ ] `HOLDER_MIN_BALANCE=1250000` — cold-start **floor in token units**
      (human-readable, not raw), used only in the sub-second window before the
      first oracle quote lands. Keep it near the current pegged value.
      _For a fixed token count instead:_ leave `HOLDER_MIN_SOL` **unset** and set
      `HOLDER_MIN_BALANCE` to the count you want.
- [ ] `HOLDER_MIN_HOLD_SECONDS=1800` — 30-minute hold window for sybil/flash-loan
      resistance. New holders see a live countdown to access while inside it.
- [ ] **Emission caps** (in `fly.toml` `[env]`, flagged `TODO(before public launch)`):
      size `EMISSION_BUDGET` to real funded IOU backing, lower `EMISSION_DAILY_CAP`
      to steady-state. Edit `fly.toml` and redeploy, or override as secrets.

---

## 4 · Frontend (Vercel → Production env)

| Variable | Value |
| -------- | ----- |
| `NEXT_PUBLIC_PRIVY_APP_ID` | production Privy app id (Solana-only, embedded wallets off, origins `https://astroid.club` + `https://www.astroid.club`, no `localhost`) |
| `NEXT_PUBLIC_ASTROID_WS_URL` | `wss://gw.astroid.club` |
| `NEXT_PUBLIC_SITE_URL` | `https://astroid.club` |
| `NEXT_PUBLIC_SOLANA_CHAIN` | `solana:mainnet` |
| `NEXT_PUBLIC_ARENA_OPEN` | current posture (CTA/nav visible, allowlist still gates entry) |

- [ ] Set the above, then **Redeploy** on Vercel.
      (`NEXT_PUBLIC_*` is bundled into the browser — never put a secret here.)

---

## 5 · Deploy + verify

```bash
fly deploy --app astroid-club-gw
fly logs   --app astroid-club-gw
```

- [ ] Boot log shows: `Postgres persistence ENABLED`, `Quarry staking wired`,
      `holder gate pegged to ~1 SOL of $ASTROID`,
      `raid-wager escrow wired (escrow=…)` with the **new** wallet address.
- [ ] No `IN-MEMORY ONLY`, no `ChainMisconfiguredError`,
      no `escrow durable store NOT configured`.

```bash
curl https://astroid-club-gw.fly.dev/health      # {"status":"ok",...}
curl https://gw.astroid.club/health               # same, via the public host
```

- [ ] **Smoke test** from `https://astroid.club` with an allowlisted test wallet:
      verify holder → sign → enter arena → set home → mine → stake → small wagered
      raid settles → no red console errors → OG card unfurls.

---

## 6 · Close out

- [ ] **Revoke the old Helius key** (after the new deploy is green).
- [ ] Set a **Helius usage alert at 80%** of the monthly cap.
- [ ] `shred -u treasury.json escrow.json` (or delete) — keys are in the vault now.
- [ ] Confirm the secret inventory:

```bash
fly secrets list --app astroid-club-gw
```

Expect rotated 🔁: `ADMIN_SECRET`, `HELIUS_API_KEY`, `SOLANA_RPC_URL`,
`REDEEMER_TREASURY_PRIVATE_KEY`. New this pass: `ESCROW_PRIVATE_KEY`,
`HOLDER_MIN_SOL`, `HOLDER_MIN_BALANCE`, `HOLDER_MIN_HOLD_SECONDS`.
Still unset (sweepstakes posture): `REWARD_WALLET_PRIVATE_KEY`, `REDIS_URL`.

---

## Rollback (one-liners)

```bash
fly releases rollback --app astroid-club-gw                 # gateway regression
fly secrets set CHAIN_ENABLED=false --app astroid-club-gw    # pause all chain ops (site stays up)
fly secrets set HOLDER_PREWARM_ENABLED=false --app astroid-club-gw  # Helius outage
# Frontend: Vercel deploy rollback (one click).
# Treasury low: send more $ASTROID to the treasury/escrow wallet — no redeploy.
```
