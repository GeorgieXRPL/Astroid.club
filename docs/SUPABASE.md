# Production persistence — Supabase / Postgres (the auditable ledger)

## Why this (and not just Redis)

Your IOU credits are **money-adjacent** — they redeem to real `$ASTROID`. For a
sweepstakes you want a record you can **audit and reconcile**, not just a number
that could vanish.

- **Redis** (see `docs/REDIS.md`) stores only the _current balance_. Good enough
  for a quick preview test. No history.
- **Postgres (Supabase)** stores an **append-only log of every event** — every
  credit, claim, and redemption is a permanent row, and the balance is the sum
  of that log. This is the **production system of record**: you can prove how
  any balance was reached, reconcile against on-chain, and resolve disputes.

The code picks the strongest option you've configured: **`DATABASE_URL` wins over
`REDIS_URL` wins over in-memory.** It's standard Postgres, so this also works on
Neon, Fly Postgres, or Railway Postgres — not just Supabase.

> You set `DATABASE_URL` once and apply one SQL file. Everything else (recording
> events, restoring on boot) is automatic.

---

## Step 1 — Create a Supabase project

1. Go to <https://supabase.com> and sign in.
2. **New project**. Name it `astroid` (anything is fine).
3. Set a strong **database password** — you'll need it in the connection string.
   Save it somewhere safe.
4. **Region:** pick the one closest to your Fly region (`syd` → Sydney/Singapore).
5. Click **Create** and wait ~2 minutes for it to provision.

---

## Step 2 — Get the connection string (`DATABASE_URL`)

1. In the project, open **Project Settings → Database**.
2. Find **Connection string** and choose the **URI** tab.
3. You'll see something like:

   ```
   postgresql://postgres.abcdxyz:[YOUR-PASSWORD]@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres
   ```

4. Replace `[YOUR-PASSWORD]` with the database password from Step 1.
5. Use the **Session pooler** / port **5432** string (good for a long-running
   server like ours). Copy the finished URL.

> SSL is required by Supabase and the server enables it automatically — you don't
> need to add anything to the URL.

---

## Step 3 — Create the tables (run the schema once)

The schema lives in this repo at `db/schema.sql`. Apply it **once**. Two ways:

**Easiest — Supabase SQL editor:**

1. In Supabase, open **SQL Editor → New query**.
2. Open `db/schema.sql` from the repo, copy everything, paste it in.
3. Click **Run**. You should see "Success". (It's safe to re-run.)

**Or from your terminal (if you have `psql`):**

```bash
psql "postgresql://postgres.abcdxyz:PASSWORD@...pooler.supabase.com:5432/postgres" -f db/schema.sql
```

This creates `home_stations`, `yield_events` (the append-only log), and a
`pending_yield_balances` view.

---

## Step 4 — Give it to the gateway

```bash
fly secrets set DATABASE_URL="postgresql://postgres.abcdxyz:PASSWORD@...pooler.supabase.com:5432/postgres" -a astroid-club-gw
```

Setting a secret auto-redeploys the gateway.

---

## Step 5 — Check it worked

```bash
fly logs -a astroid-club-gw
```

**Good:**

```
[astroid-club] Postgres persistence ENABLED — auditable yield ledger + home stations are the durable system of record.
```

If returning players already had credits you'll also see:

```
[GameWorld] restored pending yield for N wallet(s) from store
```

**If you instead see** `Redis persistence ENABLED` or `IN-MEMORY ONLY`, the
`DATABASE_URL` secret didn't land — re-run Step 4 and confirm with
`fly secrets list -a astroid-club-gw`.

---

## Step 6 — Prove it (and see the audit trail)

1. Sign in and mine until you have some IOU credits.
2. In Supabase, open **Table editor → `yield_events`**. You'll see one
   `credit` row per discovery (wallet, asteroid, amount, timestamp).
3. Restart the gateway: `fly apps restart astroid-club-gw`.
4. Sign back in — your pending yield is exactly what it was. When you
   `claim`, a negative `claim` row appears in `yield_events`.

Handy SQL (run in the SQL editor):

```sql
-- current balances
select * from pending_yield_balances order by amount desc;

-- full history for one wallet
select created_at, kind, asteroid_id, delta
from yield_events where wallet = 'WALLET_PUBKEY'
order by created_at;
```

---

## Good to know

- **It's safe if the DB hiccups.** Writes are best-effort: a brief DB outage is
  logged and swallowed, the game keeps running on its in-memory copy, and no
  player action is dropped. (The trade-off: an event that fails to write during
  an outage isn't retried — acceptable pre-launch; add an outbox/retry before
  high-stakes production if you need at-least-once durability.)
- **Never edit `yield_events` by hand.** It's append-only by design. To correct
  a balance, insert a new row with `kind = 'adjust'` and the +/- delta.
- **Redis is optional now.** With `DATABASE_URL` set, Postgres is the source of
  record and you don't also need Redis. Keep Redis only if you later want it as a
  hot cache / multi-machine coordination layer.
- **Multi-machine note.** Postgres makes state _durable_, not _live-shared_ across
  machines mid-session. Keep the app at **1 machine** (or sticky sessions) until
  authoritative state is moved server-side. See `docs/READINESS.md`.
- **Phase B.** On-chain redemption (Quarry redeemer + treasury) settles against
  this ledger — the `redeem` event kind is already reserved for it.
