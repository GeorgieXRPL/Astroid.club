-- astroid.club — reset in-game state from the test run.
--
-- WHAT THIS CLEARS (the four durable game tables):
--   home_stations   — which asteroid each wallet joined
--   yield_events    — the append-only IOU credit ledger (pending balances)
--   raid_vaults     — per-asteroid accumulated raid treasuries
--   escrow_wagers   — durable raid-wager escrow ledger
--
-- WHAT THIS DOES NOT TOUCH:
--   - On-chain Quarry stakes — those are real, user-owned, and live on Solana.
--     This script cannot and must not move them.
--   - In-memory runtime (drill power, active missions, refinery, cooldowns,
--     anti-cheat). That clears on gateway restart and rehydrates from the
--     tables above — so after running this, RESTART THE GATEWAY.
--
-- HOW TO RUN:
--   psql "$DATABASE_URL" -f db/reset-test-state.sql
--   (or paste into the Supabase SQL editor)
-- THEN: fly apps restart astroid-club-gw
--
-- ⚠ DESTRUCTIVE. Intended for the throwaway TEST dataset only. Do not run
--   against a live economy you care about.

BEGIN;

-- Safety check: refuse to wipe if real escrow is mid-flight. If this returns
-- rows, settle/refund them first (let the gateway boot once so EscrowManager
-- reconciles) before re-running. Comment out to force.
DO $$
DECLARE
  open_wagers INT;
BEGIN
  SELECT count(*) INTO open_wagers
  FROM escrow_wagers
  WHERE status IN ('active', 'settling');
  IF open_wagers > 0 THEN
    RAISE EXCEPTION
      'Refusing to reset: % escrow wager(s) still active/settling. Settle them first (or comment out this guard).',
      open_wagers;
  END IF;
END $$;

-- Full wipe of the test economy. RESTART IDENTITY resets yield_events' BIGSERIAL.
TRUNCATE TABLE home_stations, yield_events, raid_vaults, escrow_wagers
  RESTART IDENTITY;

COMMIT;

-- Sanity: all four should report 0.
SELECT 'home_stations' AS table, count(*) FROM home_stations
UNION ALL SELECT 'yield_events',  count(*) FROM yield_events
UNION ALL SELECT 'raid_vaults',   count(*) FROM raid_vaults
UNION ALL SELECT 'escrow_wagers', count(*) FROM escrow_wagers;

-- -----------------------------------------------------------------------------
-- ALTERNATIVE: reset only specific wallets (instead of the full wipe above).
-- Comment out the TRUNCATE block and use this, filling in the addresses:
--
--   DELETE FROM home_stations WHERE wallet IN ('WALLET_A', 'WALLET_B');
--   DELETE FROM yield_events  WHERE wallet IN ('WALLET_A', 'WALLET_B');
--   DELETE FROM escrow_wagers WHERE wallet IN ('WALLET_A', 'WALLET_B')
--     AND status NOT IN ('active', 'settling');
--   -- raid_vaults are per-asteroid, not per-wallet; zero specific belts with:
--   -- UPDATE raid_vaults SET balance = 0 WHERE asteroid_id IN ('AST_ID');
-- -----------------------------------------------------------------------------
