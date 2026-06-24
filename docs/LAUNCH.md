# Launch checklist (community preview → live play)

> **Audience:** the operator preparing astroid.club for public access.
> **Status:** intended for the community-preview milestone (look-around, no live play). Live play turns on later, gated behind legal greenlight.

This doc is the canonical pre-flight list. Work it top to bottom. Anything marked **[blocker]** must land before the site can be linked publicly.

---

## TL;DR

The rollout has three modes. Pick one and ship it; switching modes is one env-var flip plus a redeploy.

| Mode                  | `CHAIN_ENABLED`               | Who gets in                    | What they can do                                                                                                                                                                                                   | Use case                    |
| --------------------- | ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| **Dev pass-through**  | `false`                       | anyone who clicks Verify       | full arena (in-memory state, resets)                                                                                                                                                                               | local + staging             |
| **Community preview** | `true`                        | verified $ASTROID holders only | full arena + **real Quarry staking** (stake/unstake/claim/redeem) + **real discovery reward payouts** ($ASTROID from the reward pool); remaining chain-write ops (buyback, bet escrow) still throw until they ship | **what you ship next week** |
| **Live play**         | `true` + remaining ops landed | verified holders               | real on-chain stake, raid, claim, yield payout                                                                                                                                                                     | post-legal-greenlight       |

The community-preview mode is what the existing build already supports: the holder gate is real, **on-chain Quarry staking is wired end-to-end** (`server/chain/staking.ts` + the shell's staking flow), and **per-asteroid discovery rewards now pay real $ASTROID** through `server/chain/rewards.ts` (`RewardPayoutAdapter`, the `executeYieldPayout` impl). Staking is non-custodial (the wallet signs); reward payout is **custodial** — a server-held hot **reward-pool wallet** (`REWARD_WALLET_PRIVATE_KEY`) signs each transfer, so fund it conservatively and top it up from treasury/buyback out of band. The remaining state-changing ops (buyback, bet escrow) still throw `ChainOpNotImplementedError` because they haven't shipped — so raids remain in-memory. Each on-chain feature is a deliberate opt-in: leave the Quarry env vars unset and staking stays unwired; leave `REWARD_WALLET_PRIVATE_KEY` unset and discovery yield is credited in-game only (no token movement). For a pure look-around preview with **no** asset movement, leave both unset.

---

## Ship preview this week (tactical mini-plan)

Eight steps, in order. Roughly half a day of work spread across Mon-Wed, with the public link going live Thursday or Friday once you've slept on it.

1. **Pick a gateway host (15 min).** Spin up a Fly.io account, install `flyctl`. (Or Render / Railway if you prefer; the rest of this works either way.)
2. **Deploy the gateway (45 min).** Build with `npm run build:lib && npm run build:server`, deploy with `flyctl launch`. Confirm `https://<your-fly-app>.fly.dev/health` returns `{status:"ok"}`.
3. **Add the `gw.astroid.club` CNAME in Cloudflare, DNS-only / grey cloud (5 min).** Point at the Fly host. Wait for cert provisioning (~2 min). Confirm `wss://gw.astroid.club` accepts a WebSocket from the browser console.
4. **Create the production Privy app (10 min).** Wallet-only login, Solana-only chains, no embedded wallets. Add `https://astroid.club` and `https://www.astroid.club` to allowed origins. Copy the new app id.
5. **Set Vercel production env vars (10 min).** `NEXT_PUBLIC_PRIVY_APP_ID` (new prod id), `NEXT_PUBLIC_ASTROID_WS_URL=wss://gw.astroid.club`, `NEXT_PUBLIC_SITE_URL=https://astroid.club`. Trigger a redeploy.
6. **Set gateway env vars on Fly (15 min).** All the values from §3 of this doc. Critically: `CHAIN_ENABLED=true`, real `SOLANA_RPC_URL`, real `ASTROID_MINT`, `ASTROID_DECIMALS=6`, `HOLDER_PREWARM_ENABLED=true`, `CORS_ALLOWED_ORIGINS=https://astroid.club,https://www.astroid.club`. Restart the Fly app.
7. **Smoke-test from the live URL (30 min).** Walk through the 8 steps in §11 of this doc. If any fail, fix before sharing.
8. **Soft launch (private link to a handful of holders for 24h).** Watch the Fly logs and Helius dashboard. If nothing's on fire, post the public link.

What you can defer to next week: Supabase storage (preview is fine in-memory), CI/CD pipeline, status page, analytics, Discord. None of those are blockers for "community can look around"; they're polish for "operator stays sane".

---

## 1. Domain + DNS (Vercel + Cloudflare) [blocker]

You already own `astroid.club`, run the shell on **Vercel**, and front it with **Cloudflare**. The remaining work for community preview is mostly subdomain plumbing for the gateway and a preview environment.

DNS records to add in Cloudflare for the preview rollout:

| Record                 | Target                                                     | Proxy (cloud)       | Why                                                                                                   |
| ---------------------- | ---------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------- |
| `astroid.club` (apex)  | Vercel CNAME flattening or A record                        | Orange (proxied)    | shell, edge cache, WAF in front                                                                       |
| `www.astroid.club`     | Vercel CNAME                                               | Orange (proxied)    | redirect handled by Vercel domain config                                                              |
| `preview.astroid.club` | Vercel CNAME (separate Vercel project or git branch alias) | Orange (proxied)    | community preview surface; can sit on `main` branch with a `NEXT_PUBLIC_PREVIEW_BANNER=true` env flag |
| `gw.astroid.club`      | gateway host (Render / Fly / Railway)                      | **Grey (DNS-only)** | bypasses Cloudflare for the WebSocket upgrade; cleanest path on free/Pro plans                        |

- [ ] In **Vercel → Settings → Domains** add `astroid.club`, `www.astroid.club`, and `preview.astroid.club`. Set the apex as primary, www → 308 to apex.
- [ ] In **Cloudflare → SSL/TLS** set the mode to **Full (strict)**. Vercel auto-issues a real cert; Full(strict) means Cloudflare validates it end-to-end.
- [ ] In **Cloudflare → Rules → Page Rules** (or new Rules engine), add: `astroid.club/api/*` → cache bypass; everything else can keep default cache.
- [ ] Add a CNAME for `gw.astroid.club` pointing to your gateway host's hostname, **DNS-only (grey cloud)**. Cloudflare's free tier proxies WebSockets but with a 100s idle timeout that breaks long-lived game sessions; grey-cloud sidesteps the issue entirely. Pro+ plan can flip to orange later.
- [ ] Confirm SSL on `gw.astroid.club`: the gateway host (Render, Fly, etc.) will provision Let's Encrypt automatically once DNS resolves.

## 2. Hosting [blocker]

The shell is a Next.js 15 app; the gateway is a long-running Node process **with persistent WebSocket connections**. They have to live on different hosts because Vercel's serverless functions have a 30s timeout and don't keep WS connections open between invocations.

### Shell on Vercel (already set up)

- [ ] In the Vercel project settings, set **Root directory** to `shell/`.
- [ ] **Build command**: leave Vercel's auto-detect (it runs `npm run build` inside `shell/`). The shell's `package.json` builds Next.js correctly.
- [ ] **Install command**: `npm install --workspaces` from the repo root (or use Vercel's workspace auto-detect).
- [ ] **Node version**: 20 LTS (set in Vercel project settings, matches local dev).
- [ ] **Production branch**: `main`.
- [ ] **Preview deployments**: any branch / PR auto-gets a `*.vercel.app` URL. Useful for legal review and social-share previews.
- [ ] **Function region**: pick the same region as your gateway host (e.g. both in `iad1` if gateway is on Render-Virginia) to minimize OG-image generation latency.

### Gateway on a long-running host (the gap)

Vercel cannot host the gateway. Pick one of:

| Host                          | Plan                | Cost     | Notes                                                               |
| ----------------------------- | ------------------- | -------- | ------------------------------------------------------------------- |
| **Fly.io**                    | `shared-cpu-1x`     | ~$3-5/mo | excellent WebSocket support, simple `flyctl deploy`, global anycast |
| **Render**                    | Starter Web Service | $7/mo    | good DX, auto-deploys on push, healthcheck baked in                 |
| **Railway**                   | Hobby               | ~$5/mo   | one-click deploy, easy env-var UI                                   |
| **DigitalOcean App Platform** | Basic               | $5/mo    | reliable, slightly less convenient secret management                |

For preview, **Fly.io is the cheapest** and handles WS without ceremony. A starter `fly.toml` would expose port 3002 and run `node dist/server/index.js`.

- [ ] Pick a host, deploy a hello-world to confirm WebSocket upgrade works end-to-end.
- [ ] Set `NEXT_PUBLIC_ASTROID_WS_URL=wss://gw.astroid.club` on Vercel for the shell.
- [ ] Confirm WSS handshake from a browser console: `new WebSocket('wss://gw.astroid.club')` should open without error before you wire it up to the UI.

## 3. Environment variables [blocker]

Copy `astroid-club/.env.example` to `.env.production` (or your host's secrets store). Fill in:

| Variable                        | Preview value                                   | Live value              | Notes                                                           |
| ------------------------------- | ----------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| `CHAIN_ENABLED`                 | `true`                                          | `true`                  | leave on; the gate is part of the value prop                    |
| `SOLANA_RPC_URL`                | Helius mainnet URL with API key                 | same                    | paid Helius plan recommended for production                     |
| `HELIUS_API_KEY`                | rotated production key                          | same                    | **never** commit this                                           |
| `ASTROID_MINT`                  | the real $ASTROID mint pubkey                   | same                    | mainnet mint, not devnet                                        |
| `ASTROID_DECIMALS`              | `6`                                             | `6`                     | confirm via `scripts/debug-holder-read.mjs`                     |
| `QUARRY_REWARDER_ADDRESS`       | deployed Rewarder pubkey                        | same                    | unset ⇒ staking ops stay disabled                               |
| `QUARRY_ADDRESS`                | deployed $ASTROID Quarry pubkey                 | same                    | the staking pool                                                |
| `QUARRY_MINT_WRAPPER`           | IOU-ASTROID MintWrapper pubkey                  | same                    | emits the reward token                                          |
| `IOU_TOKEN_MINT`                | IOU-ASTROID mint pubkey                         | same                    | 9 decimals (distinct from $ASTROID's 6)                         |
| `IOU_TOKEN_DECIMALS`            | `9`                                             | `9`                     | reward-token decimals                                           |
| `REDEEMER_WALLET_ADDRESS`       | redeemer wallet pubkey                          | same                    | destination for IOU→$ASTROID redemptions                        |
| `REWARD_WALLET_PRIVATE_KEY`     | hot reward-pool key (JSON array or base58)      | same                    | **custodial**; unset ⇒ discovery payouts disabled; never commit |
| `REWARD_PRIORITY_MICROLAMPORTS` | `5000`                                          | tune                    | priority fee on each reward transfer                            |
| `HOLDER_MIN_BALANCE`            | e.g. `1_000_000`                                | tune with the community | scaled by decimals                                              |
| `HOLDER_MIN_HOLD_SECONDS`       | `600` (10 min)                                  | `86_400` (24h)          | flash-loan gating window                                        |
| `HOLDER_PREWARM_ENABLED`        | `true`                                          | `true`                  | required for fairness across restarts                           |
| `HOLDER_PREWARM_MAX_LOOKBACK`   | `100`                                           | `100`                   | Helius transaction history depth                                |
| `CORS_ALLOWED_ORIGINS`          | `https://astroid.club,https://www.astroid.club` | same                    | strict allowlist                                                |
| `ADMIN_SECRET`                  | random 32-byte hex                              | same                    | gates admin debug surfaces                                      |
| `REDIS_URL`                     | (optional, see §6)                              | (recommended)           | nonce + holder-cache durability                                 |
| `PORT`                          | `3002`                                          | provided by host        | usually overridden by Render/Fly                                |

### Shell-side env

| Variable                     | Value                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_PRIVY_APP_ID`   | production Privy app id (separate from dev)                                                               |
| `NEXT_PUBLIC_ASTROID_WS_URL` | `wss://gw.astroid.club`                                                                                   |
| `NEXT_PUBLIC_SITE_URL`       | `https://astroid.club`                                                                                    |
| `NEXT_PUBLIC_SOLANA_CHAIN`   | `solana:mainnet` (preview/devnet test: `solana:devnet`) — which cluster the wallet submits staking txs to |

> Anything prefixed `NEXT_PUBLIC_` is bundled into the browser JS, so do **not** put secrets there.

## 4. Privy production app [blocker]

Privy treats dev and prod as separate apps. Don't reuse the dev id.

- [ ] Create a new Privy app at <https://dashboard.privy.io>. Name it `astroid.club (production)`.
- [ ] **Login methods**: enable only **External wallets**. Disable email, SMS, social, passkey.
- [ ] **Supported chains**: Solana only. Disable Ethereum / EVM chains entirely.
- [ ] **Embedded wallets**: disable creation on login for both Solana and EVM.
- [ ] **Allowed origins**: add `https://astroid.club`, `https://www.astroid.club`, and any staging origin. Remove `localhost` entries before going live.
- [ ] Copy the new app id into `NEXT_PUBLIC_PRIVY_APP_ID` for the production build.

## 5. Helius production setup [blocker]

You're on the **Developer plan**, which gives plenty of headroom for community preview and well into live play (10M+ credits/month, 50 RPS). The gateway is read-only against Helius and both call sites are cached, so real wall-clock RPC volume stays low:

- `HolderChainAdapter` caches each wallet's balance for `30s` (`cacheTtlMs`). A holder hitting Verify three times in a minute = one Helius call.
- `OnChainHoldEstimator` caches pre-warm results for `5min`. First-time observation = one paginated `getSignaturesForAddress` walk; subsequent restarts within the cache window = zero calls.

So the practical Helius load looks like ~`O(unique_new_wallets_per_5min)` calls per cycle, not `O(connected_users × tick_rate)`.

Checklist:

- [ ] In **Helius dashboard → API Keys**, create a dedicated key named `astroid.club gateway (production)`. Don't reuse the dev key.
- [ ] Lock the key by IP if possible. The gateway's egress IP is stable on Render/Fly/Railway; check the host's docs for "outbound IPs" and paste them into Helius's allowlist.
- [ ] Set `SOLANA_RPC_URL` to the **mainnet** endpoint with the new key embedded (`https://mainnet.helius-rpc.com/?api-key=...`).
- [ ] Set `HELIUS_API_KEY` separately for the enriched-transactions endpoint used by pre-warm.
- [ ] Verify with `npm run debug:holder -- <a-real-holder-wallet>` against production. Output should show non-zero balance and a sensible `holdStartMs` from pre-warm.
- [ ] Set up a Helius **usage alert** at 80% of your monthly credit cap so you have time to react before throttling kicks in.

## 6. Storage durability (optional for preview, [blocker] for live)

The default `WalletVerifier` and `HolderTracker` are in-memory: nonces and observation history reset on every restart.

- For **community preview** in-memory is fine. Pre-warm refills hold time on first observation, so users don't see a fairness regression.
- For **live play** you want at least nonce durability (so signatures can't be replayed across restarts) and ideally observation-history durability + an audit trail of every verify_holder decision.

### Supabase vs Redis: pick one or both

**Supabase is a great fit for this app**, because most of what we'd persist is queryable / auditable, not millisecond-hot. Quick comparison:

| Need                                                                        | Supabase (Postgres)                                               | Redis (Upstash)                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| **Nonce TTL store** (5min, signed-action replay protection)                 | works (`expires_at` column + cron sweep), ~30-80ms per read/write | ideal (sub-1ms, native TTL)                           |
| **HolderTracker observation history** (per-wallet first-seen, consec count) | ideal: durable, queryable, joinable                               | works, but you lose ad-hoc analytics                  |
| **Verify decision audit log** (who, when, qualified?, balance, latency)     | ideal: Postgres + RLS for read access                             | poor fit (key-value only)                             |
| **Admin dashboards** ("X holders verified today", "median balance")         | ideal: Supabase Studio + SQL                                      | needs a separate analytics pipeline                   |
| **Ops cost**                                                                | one service, generous free tier                                   | $0.20/1M requests on Upstash free, then pay-as-you-go |

**Recommendation**: use **Supabase as the primary store** for everything durable, plus optional **Upstash Redis** as a thin nonce cache if you ever measure auth-handshake latency and don't like it. For the community preview, just Supabase is enough; the nonce read happens once per sign-in and ~50ms is invisible to the user.

### Supabase wiring plan

- [ ] Create a Supabase project. Free tier is plenty for preview (500 MB DB, 2 GB egress, daily backups).
- [ ] Create three tables (SQL migration):

  ```sql
  -- Auth nonces (5-minute TTL)
  create table auth_nonces (
    nonce text primary key,
    wallet_address text not null,
    issued_at timestamptz not null default now(),
    expires_at timestamptz not null
  );
  create index auth_nonces_expires_at on auth_nonces(expires_at);

  -- Holder observation state (one row per wallet)
  create table holder_observations (
    wallet_address text primary key,
    first_seen_above_threshold_ms bigint,
    last_seen_balance numeric not null,
    consecutive_observations integer not null default 0,
    last_check_at timestamptz not null default now()
  );

  -- Audit log of every verify_holder decision
  create table verify_decisions (
    id bigserial primary key,
    wallet_address text not null,
    qualified boolean not null,
    reason text not null,
    balance numeric,
    hold_start_ms bigint,
    decided_at timestamptz not null default now()
  );
  create index verify_decisions_wallet on verify_decisions(wallet_address);
  create index verify_decisions_decided_at on verify_decisions(decided_at);
  ```

- [ ] Implement a `SupabaseStorage` adapter conforming to `game-engine-enhanced/storage`'s `Storage` interface (just `get`/`set`/`delete`/`expire`). Use `auth_nonces` as the backing table.
- [ ] Pass it into `WalletVerifier` via `walletVerifierStorage` in `server/index.ts`.
- [ ] Optionally implement a `SupabaseHolderTrackerStore` if you want hold history to survive restarts even when pre-warm can't reach it (Helius outage scenario).
- [ ] Add a **Row Level Security (RLS)** policy: only the gateway's service role key can write; nobody can read except the operator via Studio.
- [ ] Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the gateway env. **Service-role key, not anon key**: anon key is for browsers, service role is for server-to-server.

### When Redis is worth adding on top

Skip Redis entirely for preview. Add an Upstash Redis instance later if any of these become true:

- Helius outages cause sign-in stalls (Redis cache shields you).
- You want to share state across multiple gateway instances (Supabase can do this, but Redis pub/sub is the cleaner pattern for fan-out).
- Auth handshake latency creeps above 200ms and traces back to nonce I/O.

## 7. Compliance + legal

Compliance has two tiers. The **showcase tier** is what you need before sharing the URL publicly next week; the **live-play tier** is what your lawyer will gate live transfers behind. The current copy is already conservative on purpose: nothing on the site promises yield, profit, or asset distribution.

### Showcase tier (ship with preview)

These should land **before** you tweet the URL even though no live play is happening:

- [ ] **`/legal` page on-site**: slim disclaimer + privacy stub. The route already ships in this build (`shell/app/legal/page.tsx`). Linked from the footer. Covers: this is a community preview, nothing is an offer or recommendation, no real-asset transfers occur, wallet addresses are read-only data, no analytics that fingerprint individuals. Lawyer can edit this in place when they greenlight live play.
- [ ] **Footer disclaimer** is already on every page (`shell/app/layout.tsx`). Reword in place if legal asks.
- [ ] **Astroid NFT card wording**: already conservative ("no promised yield, no redemption value, not a security and not a contractual benefit"). Send the rendered page to your lawyer for sign-off before you mint anything.
- [ ] **Poker freeroll** stays gated behind `POKER_ENABLED=false` until your gaming/regulatory counsel clears it. The card is invisible in the rendered DOM, not just hidden via CSS.
- [ ] **Saltaire Protocol attribution** in the footer is already there ("Part of the Saltaire Protocol ecosystem · Village coming soon"). Confirm the wording is what your entities want to be associated with publicly.

### Live-play tier (gated behind legal greenlight)

- [ ] **Terms of Service** page at `/terms`. Replaces the showcase `/legal` stub. Cover: token is utility, no investment advice, no guaranteed returns, jurisdictional carve-outs your counsel flags (e.g. OFAC list, EU consumer-law obligations if you have EU traffic, plus any home-jurisdiction overlay your entity sits under).
- [ ] **Privacy Policy** at `/privacy`. Cover: wallet addresses are personal data under GDPR/CCPA, what you log (IP, wallet, decisions), retention period, how to request deletion (operator email).
- [ ] **Cookie / consent notice** if you wire any analytics, A/B testing, or remarketing pixels. With the privacy-friendly stack recommended in §15 (Vercel Analytics or Plausible), no banner is required because no PII cookies are set.
- [ ] **Geographic gating**: if your lawyer flags any jurisdiction (US, UK, EU, or your home jurisdiction), the simplest layer is **Cloudflare → Security → WAF → Country block**: one rule, applied to the whole site or just `/arena` and `/console`. Keep an audit log of who's blocked and why.
- [ ] **OFAC / sanctions screening**: if any holder wallet is sanctioned (rare but possible), you'll want a pre-verify pass against an OFAC SDN list. There are SaaS providers (Chainalysis, TRM Labs) but a free tier from a public list is enough for preview.
- [ ] **Home-jurisdiction questions for counsel**: does the operating entity have to be locally registered? Does the Astroid NFT card wording satisfy your local financial-markets regulator? Does the Poker freeroll require a remote-gambling carve-out?

> **Why split it?** The showcase tier is what stops a regulator from saying "you operated unregistered for X days". The live-play tier is what protects you when real value starts moving. If your lawyer can only review one thing this week, send them the rendered `/legal` and Astroid NFT card: those are the two surfaces that are on the public internet for showcase.

## 8. Monitoring + alerting

For preview a tail of the gateway log over SSH is enough. For live play:

- [ ] Wire `GameLogger` to a structured sink (Datadog, Logtail, Better Stack, your own ELK).
- [ ] Page on `dispatch error` surfacing more than N times in 5 minutes.
- [ ] Page on `holder pre-warm` failures (likely a Helius outage).
- [ ] Track WebSocket connection count and active wallet count as gauges.
- [ ] Set up uptime checks on `/health` (gateway) and `/` (shell).

## 9. Security hardening

- [ ] Rotate `HELIUS_API_KEY` immediately if anyone has ever pasted it into chat / a screenshot.
- [ ] Run `git log --all -p -- .env*` to confirm no secret was ever committed.
- [ ] Add `Content-Security-Policy`, `Strict-Transport-Security`, and `X-Frame-Options: DENY` headers (Vercel: `next.config.mjs` headers; Render: edge config).
- [ ] Lock `CORS_ALLOWED_ORIGINS` to your real domains. No `*`.
- [ ] Confirm the WebSocket gateway is behind WSS (not WS) in production.
- [ ] Set `ADMIN_SECRET` to a fresh random hex value; share it only with the operator.

## 10. SEO + social

- [ ] Verify `app/opengraph-image.tsx` renders correctly: <https://www.opengraph.xyz/>.
- [ ] Verify `app/apple-icon.tsx` renders by visiting `/apple-icon` directly.
- [ ] Submit the production domain to Google Search Console, Bing Webmaster.
- [ ] Confirm `/sitemap.xml` and `/robots.txt` resolve.
- [ ] Add a `link rel=canonical` if you serve at both apex and www.

## 11. Smoke test before public link [blocker]

After the deploy, but before you tweet the link:

1. [ ] Open `https://astroid.club/` from a fresh browser (no Privy session). The landing renders, footer reads "Part of the Saltaire Protocol ecosystem · Village coming soon".
2. [ ] Click **How to play** in the header. The walkthrough loads, no em-dashes, no broken entities.
3. [ ] Click **Verify** with a wallet that holds enough $ASTROID. Privy modal opens, shows only Solana wallets. Sign. Banner flips to "Welcome, traveller".
4. [ ] Click **Enter the arena**. The 3D scene loads, asteroids drift, HUD pills populate within 15s.
5. [ ] Click an asteroid → **Set as home** → **Mine here**. Confirm the engine accepts the message (`result` envelope, no `rate_limited`).
6. [ ] Open dev tools console. No red errors. No `Each child in a list` warning (Privy SDK noise is filtered).
7. [ ] Open the page on a phone (iOS Safari + Android Chrome). Layout breathes; the apple touch icon shows when added to home screen.
8. [ ] Paste the URL into Discord and Twitter. Preview cards render with the OG image and tagline.
9. [ ] **(Chain-enabled deploys only)** Open `/console`, scroll to **On-chain staking**. With a funded wallet on the configured cluster, click **Stake** for a small amount → approve in the wallet → confirm the panel shows the new staked balance and the event log shows a verified signature. Then **Claim**, **Unstake**, **Redeem** each succeed. If `CHAIN_ENABLED=false` (or Quarry env unset), the panel shows the disabled/`chain_disabled` notice instead — that's expected.

If any of those fail, **do not** publicise the link. Triage from `gateway` logs first.

## 12. Rollback plan

If something goes sideways after launch:

1. **Frontend regression** Vercel deploy rollback (one click).
2. **Gateway regression** redeploy previous tag from your hosting provider.
3. **Holder gate misfire** flip `CHAIN_ENABLED=false` and redeploy. Anyone who clicks Verify will be admitted; the site stays usable while you debug.
4. **Helius outage** set `HOLDER_PREWARM_ENABLED=false` so the gateway falls back to in-memory tracking only. Existing observers continue to qualify; new wallets see the cold-start hold-time window.
5. **Privy outage** there is no graceful degrade for sign-in. Push a banner via `app/layout.tsx` and wait it out.

## 13. Cloudflare hardening (free tier is enough for preview)

You already proxy through Cloudflare. A handful of free-tier features pay off immediately:

- [ ] **Bot Fight Mode** in Security → Bots. Blocks the obvious crawlers and headless-browser scrapers without affecting humans or known good bots (Googlebot, Twitterbot, etc.).
- [ ] **Rate Limiting Rules** in Security → WAF → Rate limiting rules. Add: more than 30 requests / 10s from a single IP to `/api/*` triggers a challenge. The shell has no real `/api`, so this catches abusive scraping.
- [ ] **Cache Rules** in Caching → Cache Rules:
  - `*/icon.svg`, `*/apple-icon`, `*/opengraph-image` → Cache Everything, Edge TTL 1 day.
  - `*/sitemap.xml`, `*/robots.txt` → Cache Everything, Edge TTL 1 hour.
  - Anything containing `/_next/static/` → Cache Everything, Edge TTL 1 month.
- [ ] **Always Use HTTPS** in SSL/TLS → Edge Certificates → on. Forces http to https at the edge.
- [ ] **HSTS** in SSL/TLS → Edge Certificates → HTTP Strict Transport Security → enable, 6-month max-age, include subdomains. (Skip preload until you're confident.)
- [ ] **Security headers transform** in Rules → Transform Rules → Modify Response Header. Add `Permissions-Policy: camera=(), microphone=(), geolocation=()` and `Referrer-Policy: strict-origin-when-cross-origin` for every response.
- [ ] **DDoS** is on by default for free plans; you don't need to enable anything.
- [ ] **Analytics → Web Analytics** is privacy-friendly (no cookies, no PII), free, and gives you traffic and bot-share without needing GA. Drop the JS snippet on the shell as an alternative to or alongside §15.

> **Do NOT proxy the gateway through Cloudflare on free plan.** Free-tier WebSocket support has a 100s idle timeout that breaks long game sessions. Keep `gw.astroid.club` on grey-cloud (DNS-only).

## 14. Vercel deploy mechanics

You already have the Vercel project. Quick wins for the preview rollout:

- [ ] **Production branch**: `main` → `astroid.club`.
- [ ] **Preview branch**: every other branch / PR auto-gets a `*-astroid-club.vercel.app` URL. Useful for legal review (send the lawyer a preview URL of a copy change without touching prod).
- [ ] **Environment variables** under Project → Settings → Environment Variables, scoped per environment:
  - **Production**: real Privy app id, real WS URL (`wss://gw.astroid.club`), real site URL.
  - **Preview**: same values or a staging Privy app id pointing at a staging gateway.
  - **Development**: `localhost` values; Vercel respects `.env.local` if you also use Vercel CLI for local dev.
- [ ] **Deploy hooks** in Project → Settings → Git → Deploy Hooks. Generate one and call it from your release script if you want to redeploy without a Git push (e.g. after rotating the Privy app id).
- [ ] **Branch protection** on `main` in GitHub: required PR review, required status check ("Vercel preview deploy"). Stops the accidental `git push --force` that nukes production.
- [ ] **Custom 404 / 500** pages: add `shell/app/not-found.tsx` and `shell/app/global-error.tsx` with on-brand copy. The Next.js default is fine but generic; you'll want them on-brand for production.

## 15. Analytics (privacy-friendly, no cookie banner needed)

The two stacks below collect zero PII, set no cookies, and need no consent prompt under GDPR/CCPA. Pick one.

| Stack                | Cost                              | Pros                                                                                 |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| **Vercel Analytics** | included free in your Vercel plan | one-line install (`@vercel/analytics`), no extra service to manage, real-user vitals |
| **Plausible**        | $9/mo or self-host free           | open-source, lightweight, very nice dashboards, EU-hosted                            |

- [ ] Wire one of them in `shell/app/layout.tsx` (`<Analytics />` from `@vercel/analytics/react`, or a `<script>` tag for Plausible).
- [ ] **Custom event** when a wallet signs in successfully: `verify_holder_qualified`. That's your conversion funnel.
- [ ] **Custom event** for `enter_arena`. Tells you what fraction of verified holders actually play vs. just look around.

Skip Google Analytics. It sets cookies, requires a consent banner, and pulls in a lot of JS for very little signal compared to the lightweight options above.

## 16. Status + uptime

For the preview window where outages would just be embarrassing rather than financially harmful:

- [ ] **UptimeRobot** (free tier, 5-minute checks). Add monitors for:
  - `https://astroid.club/` (HTTP 200, body contains `astroid.club`)
  - `https://gw.astroid.club/health` (HTTP 200, JSON `status:"ok"`)
- [ ] Set up a **public status page** (`status.astroid.club` via UptimeRobot's free public page or BetterStack). Linkable from the footer once you go live.
- [ ] Subscribe yourself + at least one co-operator to the alert email / Slack / Discord webhook.

## 17. CI/CD + branch protection

You're pushing manually right now; that's fine for the preview, but a 30-minute investment buys real safety:

- [ ] Add a **GitHub Actions workflow** at `.github/workflows/ci.yml` that runs `npm install --workspaces`, `npm run typecheck`, `npm run lint`, `npm run test` on every PR. Required check on `main`.
- [ ] **Branch protection rule** on `main`: require PR, require CI green, require linear history. No direct pushes.
- [ ] **Dependabot** at `.github/dependabot.yml`: weekly PRs for npm + GitHub Actions updates. Approve the patch-version ones, batch the minor/major ones.
- [ ] **Secret scanning** at GitHub → Settings → Code security → Secret scanning. Free for public repos; alerts you if you ever push an API key.
- [ ] **Vercel deploy hook** triggered by the CI workflow if you want CI-gated deploys (skip if you're happy with Vercel's auto-deploy on push).

## 18. Email + community channels

- [ ] **Email**: `info@astroid.club` (or `hello@`, `contact@`) routed via **Cloudflare Email Routing** to a personal inbox. Free, takes 5 minutes. Put it in the footer or `/legal` so people have a way to reach the operator.
- [ ] **Discord** server, invite link in the footer / `/legal`. Channels: `#announcements`, `#holders`, `#bugs`, `#general`.
- [ ] **Telegram** (optional, redundant with Discord but reaches a different crowd).
- [ ] **Twitter/X**: confirm `@HeartOfMidgar` is the public face, or set up a dedicated `@astroidclub` handle. Pin the launch tweet with the OG card.
- [ ] **Farcaster** (optional, but the Solana crowd is increasingly there). Buy `@astroidclub` on Warpcast.
- [ ] **Discord bot or webhook** that posts new sign-ups / verify decisions into a private operator channel. Cheap with Supabase webhooks.

## 19. Backups + disaster recovery

- [ ] **Supabase** has automated daily backups on every plan; the free tier keeps 7 days. Confirm the schedule under Project Settings → Backups.
- [ ] **Code**: GitHub is the source of truth; ensure `main` is mirrored at least to a second remote (a private GitLab, your local dev machine) so a GitHub outage doesn't block deploys.
- [ ] **Secrets**: store production `.env` values in a password manager (1Password, Bitwarden) AND in your hosting provider's secret store. If you lose access to one you can rebuild from the other.
- [ ] **Documentation**: `docs/LAUNCH.md` (this file), `docs/CHAIN_AUDIT.md`, `docs/HOW_TO_PLAY.md` are all in the repo. They are the runbook if you have to onboard a co-operator in a hurry.

---

## Roadmap to live play

Once legal greenlights live play:

1. **Land the remaining chain-write implementations** that currently throw `ChainOpNotImplementedError`. See `docs/CHAIN_AUDIT.md` §"Surface inventory" for the list. Quarry staking (`chain_quarry_staking`) and discovery reward payout (`chain_yield_sink`) are **done**; the remaining stubs are buyback and bet escrow.
2. ~~**Wire Quarry** for real stake escrow.~~ **Done** — `server/chain/staking.ts` (`QuarryStakingAdapter`) builds non-custodial stake/unstake/claim/redeem txs, wired through `ChainOps` + the gateway, with the frontend flow in `shell/lib/staking-client.ts`. Proven on localnet by `scripts/localnet/e2e-staking.ts` (see `docs/LOCALNET_STAKING.md`).
3. ~~**Wire claim distribution** so per-asteroid discovery yield actually transfers tokens to the wallet.~~ **Done** — `server/chain/rewards.ts` (`RewardPayoutAdapter`) implements `executeYieldPayout`: a custodial $ASTROID transfer from the reward-pool wallet, wired into the `DistributionService` yield-payout callback. Proven on localnet by `scripts/localnet/e2e-yield-payout.ts`.
4. **Wire bet escrow** for raids. `BetEscrow` is in simulation; chain version pulls from a vault PDA.
5. **Fund + automate the reward pool** (and `buyback`) so the reward wallet refills itself from creator fees / treasury rather than manual top-ups.
6. **Lift `HOLDER_MIN_HOLD_SECONDS`** to 24h+ for production sybil resistance.
7. **Run a 72h closed beta** with hand-picked holders before the public flip.
8. **Announce** with a fixed "live at T+0" timestamp; no surprise launches.

---

## What's already done

For reference, here is what does **not** need to be on your pre-launch list because it has already landed:

- ECS-backed game world with 20 asteroids across 4 sectors.
- WebSocket gateway with signature-verified auth, anti-cheat rate limiting, read-only message exemption.
- Holder gate with flash-loan resistance + on-chain pre-warm from transaction history.
- Privy sign-in, Solana-only at every layer the SDK exposes.
- Public landing, /how-to-play walkthrough, test console, 3D arena.
- On-chain Quarry staking, end-to-end: non-custodial build/sign/verify, frontend flow in the console's "On-chain staking" panel, proven on localnet.
- On-chain discovery reward payout (`chain_yield_sink`): custodial $ASTROID transfer from the reward pool, wired into the distribution service, proven on localnet.
- 661 unit tests, full TypeScript strictness, prettier-clean codebase.
- Robots.txt, sitemap.xml, OG image, apple touch icon.

The build is in good shape. The list above is mostly ops + legal, not engineering.
