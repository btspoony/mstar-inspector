-- 0073_maintenance_replay_rotation_index.sql — the pending-replay scan is
-- index-ordered, so a retained dead backlog cannot make selection cost grow
-- with the backlog before the alert lanes run.
--
-- 0072 made the pending outbox a rotation by ordering on
-- `COALESCE(maintenance_replay_last_attempt_at, ''), maintenance_replay_requested_at, id`.
-- The 0071 pending index orders `(maintenance_replay_requested_at, id)`, which
-- cannot serve that expression: SQLite reads every pending row, sorts it, then
-- applies LIMIT — work proportional to the backlog on every selection.
--
-- This index carries the exact predicate and the exact order the drain uses
-- (never-tried first, then least-recently-tried, request time and id as
-- tie-breaks), so the LIMIT stops the scan instead of the sort. A row whose
-- send keeps failing stays pending by contract (no attempt cap), which is why
-- the backlog can only be bounded by reading it in index order.
--
-- 0071's `(maintenance_replay_requested_at, id)` index stays: its leading key
-- answers the pending-existence probe (`requested IS NOT NULL AND sent IS
-- NULL LIMIT 1`), which cannot use this index's COALESCE prefix.
--
-- Index build only, no row rewrite. Forward-only.

CREATE INDEX idx_review_failures_maintenance_replay_rotation
  ON review_failures(
    COALESCE(maintenance_replay_last_attempt_at, ''),
    maintenance_replay_requested_at,
    id
  )
  WHERE maintenance_replay_requested_at IS NOT NULL AND maintenance_replay_sent_at IS NULL;
