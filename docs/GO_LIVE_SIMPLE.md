# Go Live on Mainnet — The Super Simple Guide

This is the easy version. Follow the steps **in order**. Don't skip.
Anything in `ALL_CAPS_LIKE_THIS` is a blank you fill in with your own value.

> 💡 Two computers/brains rule: deploy the **gateway** (the game server) to
> Fly, and the **website** to Vercel. They are two separate things. We do
> the gateway first, the website last.

---

## Part 0 — Get your 5 things ready

Before touching anything, put these 5 things in a safe place. You can't
finish without them.

| #   | Thing                  | What it is                                                                         |
| --- | ---------------------- | ---------------------------------------------------------------------------------- |
| 1   | **$ASTROID mint**      | The address of your real coin on mainnet.                                          |
| 2   | **Admin keypair file** | A wallet file (e.g. `admin.json`) with about **1 SOL** in it (deploy costs < 0.15 SOL; the rest is just headroom). |
| 3   | **Helius RPC link**    | Your paid mainnet link, like `https://mainnet.helius-rpc.com/?api-key=XXXX`.       |
| 4   | **Reward wallet**      | A _different_ wallet, holding some **$ASTROID** + a little SOL. This pays players. |
| 5   | **Redeemer address**   | A wallet address where IOU tokens get collected.                                   |

> 🔐 **Very important:** wallet #2 and wallet #4 hold real money. Keep their
> secret keys secret. Never paste them into chat or screenshots.

---

## Part 1 — Make the Quarry (the staking machine)

We run one script. It does nothing scary the first time — it just **looks**
and tells you what it would do. That's called a "dry run".

### Step 1a — Do the safe look-first (dry run)

Copy this into your terminal, filling in your blanks:

```bash
SOLANA_RPC_URL="YOUR_HELIUS_LINK" \
  ASTROID_MINT_ADDRESS="YOUR_ASTROID_MINT" \
  PAYER_KEYPAIR="./admin.json" \
  npx tsx scripts/deploy/deploy-quarry-guarded.ts
```

Read what it prints. It should say:

- `Cluster: mainnet`
- Your SOL balance (must be **above 0.5** — the actual deploy spends < 0.15 SOL, most of it refundable account rent)
- `decimals=6` for $ASTROID
- `Mode: DRY-RUN`

✅ If all that looks right, go to the next step.
❌ If it complains, fix that thing first (usually: not enough SOL, or wrong mint).

### Step 1b — Do it for real

Same command, but add the two magic words at the end. This spends real SOL
and makes the staking machine. **You can't undo it.**

```bash
SOLANA_RPC_URL="YOUR_HELIUS_LINK" \
  ASTROID_MINT_ADDRESS="YOUR_ASTROID_MINT" \
  PAYER_KEYPAIR="./admin.json" \
  CONFIRM_MAINNET=YES EXECUTE=YES \
  npx tsx scripts/deploy/deploy-quarry-guarded.ts
```

When it finishes it prints **4 addresses** and saves them to a file
(`.keys/mainnet.env`). **Keep those 4 addresses** — you need them next:

- `QUARRY_REWARDER_ADDRESS`
- `QUARRY_ADDRESS`
- `QUARRY_MINT_WRAPPER`
- `IOU_TOKEN_MINT`

---

## Part 2 — Turn on the game server (Fly)

### Step 2a — Make the app (only once)

```bash
fly launch --copy-config --no-deploy
```

### Step 2b — Give it the secrets BEFORE turning it on

The server won't start without these. Fill in your blanks:

```bash
fly secrets set \
  SOLANA_RPC_URL="YOUR_HELIUS_LINK" \
  HELIUS_API_KEY="YOUR_HELIUS_KEY" \
  ASTROID_MINT_ADDRESS="YOUR_ASTROID_MINT" \
  CORS_ALLOWED_ORIGINS="https://preview.astroid.space" \
  WALLET_ALLOWLIST="YOUR_WALLET_PUBKEY_1,YOUR_WALLET_PUBKEY_2" \
  ADMIN_SECRET="$(openssl rand -hex 32)" \
  --app astroid-club-gw
```

> 🔒 **Locking it to just you:** `WALLET_ALLOWLIST` is the important one
> for testing. Put **only your own wallet addresses** there (comma
> separated). Anyone else who finds the site can sign in but will be
> **rejected** at the door. Leave it blank later to open it up to all
> holders. `CORS_ALLOWED_ORIGINS` set to your real site is a second lock
> (stops other websites from talking to your server).

### Step 2c — Add the staking addresses (the 4 from Part 1)

```bash
fly secrets set \
  QUARRY_REWARDER_ADDRESS="FROM_PART_1" \
  QUARRY_ADDRESS="FROM_PART_1" \
  QUARRY_MINT_WRAPPER="FROM_PART_1" \
  IOU_TOKEN_MINT="FROM_PART_1" \
  IOU_TOKEN_DECIMALS="9" \
  REDEEMER_WALLET_ADDRESS="YOUR_REDEEMER_ADDRESS" \
  --app astroid-club-gw
```

### Step 2d — Add the reward wallet (so players actually get paid)

This is the wallet that pays players when they find stuff. Paste its secret
key (the JSON array `[12,34,...]` or the base58 string):

```bash
fly secrets set \
  REWARD_WALLET_PRIVATE_KEY='PASTE_REWARD_WALLET_SECRET' \
  REWARD_PRIORITY_MICROLAMPORTS="5000" \
  --app astroid-club-gw
```

> If you skip 2d, the game still works but rewards are only "pretend"
> (counted in-game, no real coins sent). Add it when you want real payouts.

### Step 2e — Make IOU credits survive restarts (Supabase) ⚠️ important

In-game IOU credits live in memory by default, so **every redeploy wipes
them**. For anything money-adjacent you want a durable, auditable ledger.
Create a free Supabase project, apply `db/schema.sql`, and set the
connection string (full walkthrough: `docs/SUPABASE.md`):

```bash
fly secrets set \
  DATABASE_URL='postgresql://postgres.PROJECT:PASSWORD@HOST.pooler.supabase.com:5432/postgres' \
  --app astroid-club-gw
```

> The gateway auto-picks the strongest store it finds:
> `DATABASE_URL` (Postgres) > `REDIS_URL` (cache) > in-memory. With
> Postgres set, accrued credits reload on boot. Skip only for throwaway
> tests.

### Step 2f — Turn it on

```bash
fly deploy --app astroid-club-gw
```

### Step 2g — Check it's alive

```bash
curl https://astroid-club-gw.fly.dev/health
```

You want to see `{"status":"ok",...}`. 🎉

---

## Part 3 — Connect the website (Vercel)

In your Vercel project (the one serving `preview.astroid.space`), set
these 2 values:

```
NEXT_PUBLIC_ASTROID_WS_URL = wss://astroid-club-gw.fly.dev
NEXT_PUBLIC_SOLANA_CHAIN   = solana:mainnet
```

Then press **Redeploy** on Vercel.

> The `wss://astroid-club-gw.fly.dev` host works right away. If you'd
> rather use a pretty address like `wss://gw.astroid.space`, add a CNAME
> in Cloudflare pointing to `astroid-club-gw.fly.dev` (DNS-only / grey
> cloud) and use that instead. Optional — skip it for testing.

---

## Part 4 — Try it yourself

1. Open your website.
2. Connect your wallet (the one with some $ASTROID).
3. Go to `/console` → **On-chain staking** panel.
4. Click **Stake** a small amount → approve in your wallet.
5. The panel should show your new staked balance. ✅
6. Play and find something → check your wallet gets real $ASTROID. ✅

If staking shows a "disabled" message, the server is missing the Part 2c
secrets. If rewards don't arrive, check Part 2d and that the reward wallet
has enough $ASTROID.

---

## Oops — how to undo / pause

- **Bad server deploy:** `fly releases rollback --app astroid-club-gw`
- **Want to pause all chain stuff fast:** `fly secrets set CHAIN_ENABLED=false --app astroid-club-gw`
  (everyone gets let in, no coins move, while you fix things.)
- **Reward wallet running low:** just send more $ASTROID to wallet #4. No
  redeploy needed.

---

## The one-line summary

> Make the Quarry (Part 1) → give the Fly server its secrets and turn it on
> (Part 2) → point the website at it (Part 3) → test (Part 4).

That's it. Take it one part at a time.
