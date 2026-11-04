-- 0043_workspace_concurrency_bound.sql — apply the per-workspace maximum to
-- values stored under the previous, wider range.
--
-- The workspace cap moved from a shared 1..64 range to its own 1..32 maximum
-- (the system level keeps 1..256). The goal is data hygiene, not survival: the
-- reader now CLAMPS an above-maximum value to the maximum (so a row stored in
-- the deploy window never degrades to serial), which would leave the column
-- disagreeing with the card and with the write path's 1..32 range. This file
-- makes the stored value match what every surface reports. The system row needs
-- no clamp because its old maximum (64) is inside the new one (256).
--
-- An untouched row (NULL) now reads as the 32 default: migration 0040 described
-- the default "as of then" (16), and this file changes the bound it resolves to
-- without rewriting an applied migration.
--
-- The clamp literal below is the value of `WORKSPACE_CONCURRENCY_MAX` in
-- `src/dashboard/runtime-config-store.ts`; `tests/store/migration.test.ts`
-- derives its expectation from that constant, so the two cannot drift apart.
--
-- Append-only on the production DB: one new record table plus one UPDATE. A
-- rollback restores the Worker, not the table — the record rows stay.

-- The previous values are recorded in this migration's own table rather than
-- `platform_audit_events`: that ledger is created by 0033, and several fixtures
-- (plus any historical-shape reconstruction) apply this file on a schema cut
-- before it. `INSERT OR IGNORE` keeps a replay a no-op.
CREATE TABLE IF NOT EXISTS workspace_concurrency_clamp_0043 (
  workspace_id   TEXT PRIMARY KEY,
  previous_value INTEGER NOT NULL,
  clamped_to     INTEGER NOT NULL,
  clamped_at     TEXT NOT NULL
);

INSERT OR IGNORE INTO workspace_concurrency_clamp_0043
  (workspace_id, previous_value, clamped_to, clamped_at)
SELECT id, max_concurrent_reviews, 32, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM workspaces
 WHERE max_concurrent_reviews > 32;
UPDATE workspaces SET max_concurrent_reviews = 32 WHERE max_concurrent_reviews > 32;
