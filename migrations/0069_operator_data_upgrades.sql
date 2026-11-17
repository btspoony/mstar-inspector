-- 0069_operator_data_upgrades.sql — one row per operator data upgrade
-- (spec operator-data-upgrade § Upgrade registry and state machine, D8).
--
-- An upgrade item is not a schema migration: it moves EXISTING rows (the
-- repository backfill repoints ledger rows between targets), so its progress
-- has to survive a worker that dies mid-batch. The cursor is the resume point,
-- `processed` the rows already moved, `maintenance_owned` whether the RUNNER
-- opened the maintenance window (only a window it opened may it close again).
--
-- Rows are created by the runner's first step, never seeded: an absent row is
-- the documented `pending` state, so this file writes no data.

CREATE TABLE operator_data_upgrades (
  id                TEXT PRIMARY KEY,
  status            TEXT NOT NULL
                    CHECK (status IN ('pending', 'running', 'verifying', 'completed', 'failed')),
  cursor_json       TEXT,
  processed         INTEGER NOT NULL DEFAULT 0,
  maintenance_owned INTEGER NOT NULL DEFAULT 0
                    CHECK (maintenance_owned IN (0, 1)),
  started_at        TEXT,
  -- The claim's identity: a fresh UUID written by every successful claim, so
  -- a guard can name THIS claim. `started_at` cannot serve — two claims taken
  -- with the same stamp are otherwise indistinguishable, which lets the loser
  -- of a takeover write the winner's maintenance window.
  claim_token       TEXT,
  -- When the CURRENT run began retiring rows, stamped once by its first claim
  -- and cleared by a reset. `started_at` cannot serve: it is the per-phase
  -- in-flight claim, cleared between phases. Verify reads this to tell rows the
  -- run itself could have stranded from deletions that predate it.
  run_started_at    TEXT,
  finished_at       TEXT,
  last_error        TEXT,
  log_json          TEXT
);
