# preview.astroid.club — deploy runbook

A tactical, copy-pasteable guide for shipping the community-preview
deployment of astroid.club. This is the lean version of `LAUNCH.md` —
everything you need to ship, nothing you don't.

You'll end up with two live surfaces:

| Surface | Hosted at      | URL                          |
| ------- | -------------- | ---------------------------- |
| Shell   | Vercel         | `https://preview.astroid.club` |
| Gateway | Fly.io         | `https://gw.astroid.club`      |

Both fronted by Cloudflare DNS for the `astroid.club` zone.

---

## Pre-flight (5 min)

You should already have:

- The `astroid.club` domain in Cloudflare.
- A GitHub account with push access to `HeartOfMidgar/Astroid-miner`.
- A Helius Developer-tier API key.
- A Privy app (configured for "external Solana wallets only").

If any are missing, sort them first; nothing below works without all four.

---

## 1. Push the latest gateway code

The vendored `game-engine-enhanced` tarball is already in `vendor/`. The
Dockerfile, `fly.toml`, build/start scripts, WS origin enforcement, and
`NEXT_PUBLIC_SITE_URL` plumbing are all in this repo. From your local
checkout:

```
git push origin main
```

Both Vercel and Fly will read from this branch.

---

## 2. Deploy the shell to Vercel

1. **Import the repo**

   - Go to <https://vercel.com/new>.
   - Pick `HeartOfMidgar/Astroid-miner`.
   - Set **Root Directory** to `shell`.
   - Framework preset: Next.js (auto-detected).
   - Build command: leave default (`next build`).
   - Output directory: leave default (`.next`).

2. **Set environment variables** (Vercel project → Settings → Environment Variables → Production)

   | Key                          | Value                                 |
   | ---------------------------- | ------------------------------------- |
   | `NEXT_PUBLIC_SITE_URL`       | `https://preview.astroid.club`        |
   | `NEXT_PUBLIC_ASTROID_WS_URL` | `wss://gw.astroid.club`               |
   | `NEXT_PUBLIC_ASTROID_HTTP_URL` | `https://gw.astroid.club`           |
   | `NEXT_PUBLIC_PRIVY_APP_ID`   | (your Privy app id from step 5)       |
   | `NEXT_PUBLIC_FEATURE_POKER`  | `false`                               |

3. **Add the custom domain**

   - Vercel project → Settings → Domains → Add → `preview.astroid.club`.
   - Vercel will print a CNAME target like `cname.vercel-dns.com`.
   - Don't add it in Cloudflare yet; do that in step 4.

4. **Deploy** once. The first build will fail until the gateway is up,
   but the static surface (`/`, `/legal`, `/how-to-play`) should render.

---

## 3. Deploy the gateway to Fly.io

1. **Install flyctl** if you haven't:

   ```
   iwr https://fly.io/install.ps1 -useb | iex      # Windows PowerShell
   curl -L https://fly.io/install.sh | sh          # macOS / Linux
   ```

2. **Authenticate**

   ```
   fly auth login
   ```

3. **Launch the app** (from the repo root, where `fly.toml` lives):

   ```
   fly launch --copy-config --no-deploy
   ```

   - When prompted, accept the existing `fly.toml`.
   - Pick a name (e.g. `astroid-club-gateway-preview`); update
     `app = "..."` in `fly.toml` if Fly assigns a different one.
   - Pick the same region as `primary_region` (`syd` by default).
   - Decline the Postgres / Redis / Tigris add-ons; we don't need them
     for preview.

4. **Set secrets** (replace placeholders with real values):

   ```
   fly secrets set `
     SOLANA_RPC_URL='https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY' `
     HELIUS_API_KEY='YOUR_HELIUS_KEY' `
     ASTROID_MINT_ADDRESS='8NwtzwGm4CV8Hm4fJXR69ac1MxDYuSaN3A9HVyikpump' `
     HOLDER_MIN_BALANCE='10000' `
     HOLDER_MIN_HOLD_SECONDS='600' `
     CORS_ALLOWED_ORIGINS='https://preview.astroid.club'
   ```

   PowerShell-style continuations shown; on bash use `\` instead of
   the back-tick.

   **Important**: if you don't yet have a real `HOLDER_MIN_BALANCE`,
   leave the default. The pre-warm flow (already enabled via `fly.toml`)
   will infer hold-start from on-chain history so legit holders qualify
   on first click, no waiting room.

5. **Deploy**:

   ```
   fly deploy
   ```

   First build pulls `node:20-alpine`, packs the engine, and compiles
   TypeScript — expect 2–3 minutes. Subsequent deploys are < 60s.

6. **Sanity check**: `fly logs` should show

   ```
   [astroid-club] HTTP+WS listening on port 3002
   [astroid-club] health: http://localhost:3002/health
   ```

   Hit the URL Fly prints (`https://<your-app>.fly.dev/health`) — you
   should get `{"status":"ok",...}`.

---

## 4. Wire DNS in Cloudflare

In Cloudflare → astroid.club → DNS → Records, add two CNAMEs:

| Type  | Name      | Target                       | Proxy |
| ----- | --------- | ---------------------------- | ----- |
| CNAME | `preview` | `cname.vercel-dns.com`       | OFF (DNS only) |
| CNAME | `gw`      | `<your-app>.fly.dev`         | OFF (DNS only) |

Why proxy off:

- **Vercel** terminates its own TLS via the SNI cert it provisions for
  `preview.astroid.club`. Cloudflare proxy in front conflicts with
  that handshake unless you switch to Cloudflare's "full strict" mode
  with a Vercel-issued cert — easier to keep proxy off for preview.
- **Fly** terminates TLS for `<your-app>.fly.dev` and any custom
  domain you attach to the app. With Cloudflare proxy on, WebSocket
  upgrades sometimes drop on the free plan; not worth the debugging
  for preview. Re-enable later for live play if you want the WAF.

After the DNS records resolve (1–5 min), Vercel and Fly will both
auto-issue certificates. Confirm:

- `https://preview.astroid.club/` returns the landing page.
- `https://gw.astroid.club/health` returns `{"status":"ok",...}`.

To attach the custom domain to Fly:

```
fly certs add gw.astroid.club
```

Wait for Fly to confirm the cert is valid (60–90s). Re-check `/health`.

---

## 5. Privy dashboard

<https://dashboard.privy.io> → your app → Settings.

1. **Allowed login origins**: add `https://preview.astroid.club`.
   Keep `http://localhost:4001` for dev.
2. **External wallets**: ensure only the Solana toggles are on
   (Phantom, Backpack, Solflare, Glow, etc.). Ethereum / EVM toggles
   should be off — the shell already enforces this in code, but the
   dashboard is the source of truth.
3. **Embedded wallets**: leave OFF. We use Privy strictly for
   external-wallet message signing.
4. Copy the **App ID**; this is the value of `NEXT_PUBLIC_PRIVY_APP_ID`
   in step 2.

---

## 6. Helius

<https://dev.helius.xyz> → Endpoints → your endpoint.

1. **Confirm the key works**: from a terminal,

   ```
   curl -X POST https://mainnet.helius-rpc.com/?api-key=YOUR_KEY `
     -H 'Content-Type: application/json' `
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```

   Expect `{"jsonrpc":"2.0","id":1,"result":"ok"}`.

2. **Restrict origin** (optional but recommended): under "Access
   Control", whitelist `https://gw.astroid.club` and `https://preview.astroid.club`.
   The browser never sees the key (it lives only on the gateway), so
   the gateway origin is the one that matters.

3. **Rate limits**: Developer plan = 10 req/s sustained, 100 RPS
   burst. The gateway batches holder reads through the in-memory
   tracker + cache; you should see < 1 req/s steady-state for
   preview.

---

## 7. First smoke test

In a new browser session (or incognito):

1. Visit `https://preview.astroid.club/`.
   - Landing renders.
   - Footer shows "Part of the Saltaire Protocol ecosystem · Village coming soon".
   - `/legal` and `/how-to-play` resolve.

2. Click **Sign in** (Privy modal).
   - Wallets shown are Solana-only.
   - Sign in with a wallet that holds the qualifying $ASTROID balance.

3. The arena loads.
   - HUD shows your wallet, asteroid, drill power.
   - "Mine", "Stake", "Raid", "Claim yield" all respond.

4. Open the browser console.
   - No `require is not defined`.
   - No CORS errors.
   - The only chatter should be the WS heartbeat.

5. From `fly logs`, confirm:
   - `[astroid-club] verify_holder qualified` for your wallet.
   - No `[astroid-club] rejected WS upgrade from origin` lines.

If all five pass, preview is live. Tweet the URL.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| Landing page 404 / blank | Vercel build failed; check Vercel deployment logs | Re-run build after fixing the error |
| `Connection refused` from arena | Gateway not running; `fly status` will say `stopped` | `fly deploy` again; check `fly logs` for the crash |
| `verify_holder not_qualified` for known holder | Wrong `ASTROID_DECIMALS` or wrong mint | Confirm `ASTROID_MINT_ADDRESS` in fly secrets matches the live token; Helius will report the right decimals |
| `403` on WS upgrade | `CORS_ALLOWED_ORIGINS` doesn't include the shell origin | `fly secrets set CORS_ALLOWED_ORIGINS='https://preview.astroid.club'` |
| Privy "origin not allowed" | Privy dashboard missing the preview origin | Add it under Allowed login origins |
| `401 Invalid API key` in fly logs | Helius key rotated or env mismatch | `fly secrets set SOLANA_RPC_URL=...` with the new key |
| Slow first verify (~10 min wait) | Pre-warm disabled or Helius key missing | Confirm `HOLDER_PREWARM_ENABLED=true` and `HELIUS_API_KEY` are both set on Fly |

For deeper monitoring, `fly logs` is the source of truth. Wire it into
Better Stack / Logtail if you want alerts; the format is
`[astroid-club] <level> <message>` so a single regex captures
everything.

---

## 9. Refreshing the engine tarball

When the engine source changes (`Enhanced-Game-Engine` repo) and you
need to ship the update with the gateway:

```
npm run engine:pack
npm install
git commit -am "vendor: bump game-engine-enhanced to vX.Y.Z"
git push
fly deploy
```

The script rebuilds the engine, repacks the tarball, drops it into
`vendor/`, and you ship a normal Fly deploy. No special CI step.

---

## 10. Going from preview to live play

Live play is a much bigger jump and is documented separately in
`docs/LAUNCH.md`. The high-order checklist:

1. Counsel review of `/legal` and the on-site copy.
2. Replace the showcase `/legal` with full ToS at `/terms` + Privacy at `/privacy`.
3. Geographic gating via Cloudflare WAF if counsel flags any jurisdiction.
4. Move the gateway to a paid Fly tier with min-instances ≥ 2; switch the
   in-memory holder tracker to Redis or Supabase for cross-instance state.
5. Flip `CHAIN_ENABLED` actions on (yield payouts, NFT mints) one slice at
   a time, behind staged feature flags.
6. Tweet the live URL.

Until then, preview is doing exactly what you want it to do: showing
your community what's behind the door without anyone risking real
assets.
