# Redis setup — make IOU credits survive restarts (simple guide)

## Why you need this

Right now the game keeps everything (your mined **IOU credits**, your home
station) **in memory**. That's fine while the server is running — but every time
you redeploy or the Fly machine restarts, **the credits get wiped**.

Redis is a tiny database that lives outside the server. When you plug it in, the
gateway writes a copy of two things to Redis as you play:

- **home station** (which asteroid you joined), and
- **pending yield / IOU credits** (your redeemable in-game balance).

On the next boot it reads them back, so a restart no longer erases progress. No
real tokens are involved — this is just the in-game ledger.

> You only set `REDIS_URL` once. Everything else is automatic: the code already
> writes through to Redis and restores on boot when the variable is present.

---

## Pick ONE option

- **Option A — Upstash** (recommended; free tier, 2 minutes, nothing to run).
- **Option B — Fly Redis** (lives next to the gateway, one command).

Both end the same way: you get a connection URL and run **one** `fly secrets`
command.

---

## Option A — Upstash (recommended)

### Step 1 — Make a database

1. Go to <https://upstash.com> and sign in (GitHub login is fine).
2. Click **Create Database**.
3. Name: `astroid` (anything is fine).
4. **Region:** pick the one closest to your Fly region. Your gateway is in
   `syd` (Sydney), so choose an Asia-Pacific region (e.g. Singapore/Sydney).
5. Leave the rest as default. Click **Create**.

### Step 2 — Copy the URL

1. Open the database you just made.
2. Find the connection string. You want the one that starts with **`rediss://`**
   (two `s`s = TLS/encrypted). It looks like:

   ```
   rediss://default:AbCdEf123456@apn1-xxxx-12345.upstash.io:6379
   ```

3. Copy that whole line.

### Step 3 — Give it to the gateway

Run this in your terminal (paste your real URL inside the quotes):

```bash
fly secrets set REDIS_URL="rediss://default:AbCdEf123456@apn1-xxxx-12345.upstash.io:6379" -a astroid-club-gw
```

That's it. Setting a secret makes Fly redeploy the gateway automatically.

Now jump to **"Step 4 — Check it worked"** below.

---

## Option B — Fly Redis (Upstash-on-Fly)

### Step 1 — Create it

```bash
fly redis create
```

Answer the prompts:

- **Org:** your org.
- **Name:** `astroid-redis`.
- **Region:** `syd` (same as the gateway).
- **Plan:** the free / smallest plan is fine for testing.
- **Eviction:** choose **No** (do not evict). We don't want it throwing away
  credits to save space.

When it finishes it prints a **`redis://...`** URL. Copy it.

### Step 2 — Give it to the gateway

```bash
fly secrets set REDIS_URL="redis://default:PASSWORD@your-redis.upstash.io:6379" -a astroid-club-gw
```

(You can re-print the URL any time with `fly redis status astroid-redis`.)

---

## Step 4 — Check it worked

Watch the boot logs:

```bash
fly logs -a astroid-club-gw
```

**Good** — you'll see lines like:

```
[astroid-club] runtime: { ... redisConfigured: true ... }
[astroid-club] Redis persistence ENABLED — home stations and pending IOU credits survive restarts.
[RedisGameStore] connected
```

If returning players already had credits, you'll also see:

```
[GameWorld] restored pending yield for N wallet(s) from store
```

**Bad** (variable not picked up) — you'll see:

```
[astroid-club] REDIS_URL unset — game state is IN-MEMORY ONLY...
```

If you see the "in-memory only" line, the secret didn't land — re-run the
`fly secrets set` command and confirm with `fly secrets list -a astroid-club-gw`
(it should list `REDIS_URL`).

---

## Step 5 — Prove it survives a restart

1. Sign in and mine until you have some IOU credits (the HUD "Pending yield"
   goes up).
2. Restart the gateway:

   ```bash
   fly apps restart astroid-club-gw
   ```

3. Sign back in. Your pending yield should be **exactly what it was** before the
   restart. Without Redis it would have reset to 0.

---

## Good to know

- **It's safe if Redis hiccups.** Writes are best-effort: if Redis is briefly
  unreachable the game keeps running on its in-memory copy and just logs the
  error. You never lose a request because of Redis.
- **Reads are local.** During play the server reads from memory, not Redis, so
  there's no added lag. Redis is only touched on writes and on the one boot-time
  restore.
- **What is NOT stored.** Live raids, expeditions in flight, and anti-cheat
  counters are intentionally ephemeral — they reset on restart by design. Only
  home station + IOU credits persist.
- **Wiping the ledger.** If you ever want a clean slate during testing, delete
  the two keys: `astroid:home-station` and `astroid:pending-yield` (Upstash has
  a data browser; or `redis-cli DEL astroid:pending-yield astroid:home-station`).
- **Phase B note.** Once on-chain IOU redemption ships (Quarry Redeemer +
  treasury, see `docs/READINESS.md`), real value lives on-chain and Redis
  becomes just a convenience cache for the in-game number.
