# Gateway deploy runbook (Fly.io)

Exact steps to deploy the astroid.club **gateway** (the WebSocket +
HTTP server) to Fly.io. The Next.js shell deploys separately to Vercel
— see `docs/LAUNCH.md` for the full launch checklist; this is just the
gateway-on-Fly runbook.

> **Use a NEW Fly app — do not reuse the Black-Gold app.** Same app =
> same machines + same domain, so a deploy would overwrite the live
> Black-Gold gateway and mix two games' in-memory state. Same Fly
> account/org is fine; the app must be distinct. The committed
> `fly.toml` already names a separate app: `astroid-club-gateway`.

## 0. Prerequisites

- `flyctl` installed and logged into the same Fly account as Black-Gold
  (`fly auth whoami`).
- This repo checked out with `Dockerfile` + `fly.toml` at the root.
- Decide the chain target (devnet vs mainnet). Staking additionally
  needs a Quarry deployed on that cluster — see §5.

## 1. Confirm / pick the app name

```bash
# Make sure the name is NOT your Black-Gold app:
fly apps list

# Default name from fly.toml. Change `app = "..."` in fly.toml if you
# want a different one (e.g. astroid-club-gateway-preview).
grep '^app' fly.toml
```

## 2. Create the app (no deploy yet)

```bash
# Reuses the committed fly.toml; creates the app shell without deploying.
fly launch --copy-config --no-deploy
# (or, if the app already exists:  fly apps create astroid-club-gateway)
```

## 3. Set secrets BEFORE the first deploy (required)

`fly.toml` ships `CHAIN_ENABLED="true"`. The runtime **refuses to boot**
when chain is on but `SOLANA_RPC_URL` or `ASTROID_MINT_ADDRESS` are
missing (`server/config/runtime.ts` `requireEnv`). So set these first:

```bash
fly secrets set \
  SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY" \
  HELIUS_API_KEY="YOUR_KEY" \
  ASTROID_MINT_ADDRESS="<real $ASTROID mint pubkey>" \
  HOLDER_MIN_BALANCE="1000000" \
  HOLDER_MIN_HOLD_SECONDS="600" \
  CORS_ALLOWED_ORIGINS="https://astroid.club,https://www.astroid.club" \
  ADMIN_SECRET="$(openssl rand -hex 32)" \
  --app astroid-club-gateway
```

`ASTROID_DECIMALS`, `HOLDER_PREWARM_ENABLED`, `HOLDER_PREWARM_MAX_LOOKBACK`,
`PORT`, and `CHAIN_ENABLED` already live in `fly.toml [env]`; override
them with `fly secrets set` only if you need different values.

> **Pure look-around preview (no asset movement):** to ship holder gate
>
> - arena with **no** staking, simply leave the `QUARRY_*` / `IOU_*`
>   secrets unset (§5). The staking ops return `chain_disabled` to the
>   client. If you want zero chain at all, set `CHAIN_ENABLED=false` (then
>   the RPC/mint secrets above aren't required either).

## 4. Deploy + verify

```bash
fly deploy --app astroid-club-gateway

# Health check (Fly also polls this):
curl https://astroid-club-gateway.fly.dev/health   # -> {"status":"ok",...}

# WebSocket handshake from a browser console on your shell origin:
#   new WebSocket('wss://astroid-club-gateway.fly.dev')  // should open
```

Then in **Cloudflare**, add `gw.astroid.club` as a CNAME to the Fly
host, **DNS-only (grey cloud)** — Cloudflare's free-tier 100s WS idle
timeout breaks long game sessions (see `docs/LAUNCH.md` §1, §13).

### Admin console

With `ADMIN_SECRET` set (step 3), the gateway serves a live, read-only
monitoring dashboard:

```
https://astroid-club-gateway.fly.dev/admin
```

Open it in a browser, paste the `ADMIN_SECRET` value, and you get a live
view (auto-refreshing every 3s) of: server flags + uptime, connected
players, per-asteroid activity, the IOU-credit economy, anti-cheat /
security stats, and a streaming server log with a filter box. It's
read-only — it never mutates game state. The page shell carries no
secret; the token is kept in `sessionStorage` and sent as a Bearer on
each API call. The page is `noindex`. To read the current token:
`fly secrets list` shows only digests, so keep your own copy when you set
it (or rotate with `fly secrets set ADMIN_SECRET="$(openssl rand -hex 32)"`).

## 5. Enable on-chain staking (optional, after a cluster Quarry exists)

The localnet flow in `docs/LOCALNET_STAKING.md` only deploys Quarry to a
local validator. To enable staking on the deployed gateway, deploy Quarry
to your **target cluster** with the **guarded** deploy script and feed the
resulting addresses in as secrets.

> ⚠️ **Mainnet moves real value.** The keypair you sign with becomes the
> **permanent admin authority** of the MintWrapper + Rewarder — use a
> secured keypair, not a throwaway. The guarded script defaults to a
> **dry-run** and refuses mainnet unless you pass `CONFIRM_MAINNET=YES`.

```bash
# 1) Dry-run first — prints cluster, payer balance, mint decimals, plan.
SOLANA_RPC_URL="<cluster rpc>" \
  ASTROID_MINT_ADDRESS="<real $ASTROID mint>" \
  PAYER_KEYPAIR="./admin-keypair.json" \
  npx tsx scripts/deploy/deploy-quarry-guarded.ts

# 2) Execute on mainnet (after the dry-run looks right):
SOLANA_RPC_URL="<cluster rpc>" \
  ASTROID_MINT_ADDRESS="<real $ASTROID mint>" \
  PAYER_KEYPAIR="./admin-keypair.json" \
  CONFIRM_MAINNET=YES EXECUTE=YES \
  npx tsx scripts/deploy/deploy-quarry-guarded.ts
# Writes QUARRY_*/IOU_TOKEN_MINT to .keys/<network>.env. NO reward rate is
# set — Quarry emissions stay 0 (Astroid pays per-asteroid discovery
# rewards via §5b, not Quarry emission). Set a rate later only if you
# deliberately want continuous IOU emission.

fly secrets set \
  QUARRY_REWARDER_ADDRESS="<...>" \
  QUARRY_ADDRESS="<...>" \
  QUARRY_MINT_WRAPPER="<...>" \
  IOU_TOKEN_MINT="<...>" \
  IOU_TOKEN_DECIMALS="9" \
  REDEEMER_WALLET_ADDRESS="<...>" \
  --app astroid-club-gateway
# Fly restarts the app; `server/index.ts` now wires the QuarryStakingAdapter.
```

## 5b. Enable discovery reward payouts (optional, custodial)

Per-asteroid discovery rewards pay **real $ASTROID** from a server-held
hot **reward-pool wallet** (`server/chain/rewards.ts`). This is the only
custodial chain op — the gateway holds the key and signs each transfer.

1. Generate/choose a dedicated reward wallet (NOT the admin/Quarry payer).
2. Fund it with $ASTROID — only as much as you're willing to expose — and
   a little SOL for fees/ATA rent. Top it up out of band from treasury.
3. Set the key as a secret (JSON array or base58; **never commit it**):

```bash
fly secrets set \
  REWARD_WALLET_PRIVATE_KEY='[12,34,...]' \
  REWARD_PRIORITY_MICROLAMPORTS="5000" \
  --app astroid-club-gateway
# On restart, `server/index.ts` wires executeYieldPayout. With the key
# unset, discovery yield is credited in-game (addPendingYield) only — no
# token movement. Proven on localnet by scripts/localnet/e2e-yield-payout.ts.
```

## 6. Point the Vercel shell at the gateway

In the Vercel project (shell), set:

```
NEXT_PUBLIC_ASTROID_WS_URL = wss://gw.astroid.club   (or the .fly.dev host)
NEXT_PUBLIC_SOLANA_CHAIN   = solana:mainnet           (or solana:devnet to test)
```

Redeploy the shell. The console's "On-chain staking" panel will light up
once the gateway has the Quarry secrets and the wallet is on the matching
cluster.

## Rollback

- Bad gateway deploy: `fly releases --app astroid-club-gateway` then
  `fly deploy --image <previous>` (or `fly releases rollback`).
- Holder gate misfiring: `fly secrets set CHAIN_ENABLED=false` — everyone
  who verifies is admitted while you debug (see `docs/LAUNCH.md` §12).
