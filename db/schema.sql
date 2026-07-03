-- astroid.club — production persistence schema (Postgres / Supabase).
--
-- This is the durable, AUDITABLE system of record for the in-game economy
-- (the sweepstakes IOU credit ledger) plus home-station assignments. It is
-- standard Postgres, so it runs on Supabase, Neon, Fly Postgres, Railway
-- Postgres, or local Postgres — nothing here is Supabase-specific.
--
-- Apply it once against your database:
--   psql "$DATABASE_URL" -f db/schema.sql
-- or paste it into the Supabase SQL editor. It is idempotent (safe to re-run).
--
-- Design: the credit balance is NOT stored as a mutable number. It is the
-- SUM of an append-only event log (`yield_events`), so every credit, claim,
-- and redemption is permanently recorded and the balance can always be
-- reconciled / audited / replayed. The `pending_yield_balances` view is just
-- a convenience projection.

-- Home station: which asteroid a wallet has joined. Mutable single row per
-- wallet (last write wins), restored lazily on connect.
CREATE TABLE IF NOT EXISTS home_stations (
  wallet      TEXT PRIMARY KEY,
  asteroid_id TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only ledger of every change to a wallet's pending yield. NEVER
-- update or delete rows here — corrections are new 'adjust' rows. NUMERIC
-- (not float) so credit math is exact.
CREATE TABLE IF NOT EXISTS yield_events (
  id          BIGSERIAL PRIMARY KEY,
  wallet      TEXT NOT NULL,
  asteroid_id TEXT,                                   -- null for claims/redemptions
  delta       NUMERIC NOT NULL,                       -- +credit, -claim/-redeem
  kind        TEXT NOT NULL CHECK (kind IN ('credit', 'claim', 'redeem', 'adjust')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS yield_events_wallet_idx  ON yield_events (wallet);
CREATE INDEX IF NOT EXISTS yield_events_created_idx ON yield_events (created_at);

-- Per-asteroid raid-vault treasury: the persistent, raidable balance shown to
-- attackers. Mutable single row per asteroid (last write wins), restored on
-- boot so accumulated treasuries survive a restart/redeploy. NUMERIC so the
-- balance is exact. The in-memory RaidVaultManager is the runtime source of
-- truth; this mirrors it write-through.
CREATE TABLE IF NOT EXISTS raid_vaults (
  asteroid_id TEXT PRIMARY KEY,
  balance     NUMERIC NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Durable escrow-wager ledger + settlement outbox. The system of record for
-- on-chain raid-wager LIABILITY: every verified deposit is written here as
-- `active` before the raid is acknowledged, so a restart mid-raid can refund
-- the orphaned deposit instead of losing track of custodied tokens. Once a
-- raid resolves the row holds the settlement plan (`legs` JSON, each with its
-- own `done` flag + signature) and the `EscrowManager` retries the not-yet-
-- done legs until all land — then the row is deleted. `failed` rows are parked
-- for manual ops. NUMERIC so the escrowed amount is exact.
CREATE TABLE IF NOT EXISTS escrow_wagers (
  wager_id        TEXT PRIMARY KEY,
  wallet          TEXT NOT NULL,                  -- the raider who deposited
  amount          NUMERIC NOT NULL,               -- escrowed whole $ASTROID
  expedition_id   TEXT,
  target_asteroid TEXT,
  deposit_sig     TEXT,
  status          TEXT NOT NULL
                    CHECK (status IN ('active', 'settling', 'settled', 'failed')),
  legs            JSONB,                           -- settlement legs once resolved
  retries         INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS escrow_wagers_status_idx ON escrow_wagers (status);

-- Operator-managed comp/bypass list: wallets that skip the holder gate (team,
-- partners, comped testers) while the game stays open to everyone else. Edited
-- live from the admin console; loaded into an in-memory set on boot. One row
-- per wallet (last write wins on the optional note).
CREATE TABLE IF NOT EXISTS comp_wallets (
  wallet      TEXT PRIMARY KEY,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Player-chosen chat handles (display names). One row per wallet (last write
-- wins). Handles are unique case-insensitively — the unique index on lower(handle)
-- enforces it at the DB level; the in-memory HandleService also enforces it so a
-- taken name is rejected before the write.
CREATE TABLE IF NOT EXISTS handles (
  wallet      TEXT PRIMARY KEY,
  handle      TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS handles_lower_unique ON handles (lower(handle));

-- Current pending-yield balance per wallet, derived from the event log.
-- Read on boot to repopulate in-memory state. `security_invoker = on` makes the
-- view run with the QUERYING user's privileges (not the creator's), so it
-- respects RLS — required by Supabase's linter (a SECURITY DEFINER view would
-- bypass RLS). The gateway doesn't read this view (it sums yield_events
-- directly); it's a convenience projection for manual inspection.
CREATE OR REPLACE VIEW pending_yield_balances
  WITH (security_invoker = on) AS
  SELECT wallet, SUM(delta) AS amount
  FROM yield_events
  GROUP BY wallet;

-- ---------------------------------------------------------------------------
-- Row-Level Security (RLS) — required when this DB is a Supabase project.
--
-- Supabase auto-exposes the `public` schema over its PostgREST API to the
-- `anon` and `authenticated` roles. These tables hold the game economy and
-- escrow liability and must NOT be reachable that way. Enabling RLS with NO
-- policies denies all access to non-owner roles (deny-by-default). The gateway
-- connects over DATABASE_URL as the table OWNER, which bypasses RLS, so it is
-- unaffected. The explicit REVOKE is belt-and-suspenders (this app never uses
-- the PostgREST API). Safe/idempotent to re-run.
-- ---------------------------------------------------------------------------
ALTER TABLE home_stations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE yield_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE raid_vaults    ENABLE ROW LEVEL SECURITY;
ALTER TABLE escrow_wagers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE comp_wallets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE handles        ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON home_stations, yield_events, raid_vaults, escrow_wagers, comp_wallets, handles
  FROM anon, authenticated;
