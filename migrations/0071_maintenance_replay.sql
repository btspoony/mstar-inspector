-- 0071_maintenance_replay.sql — an operator replay of a lost maintenance-window
-- delivery keeps its own request/sent stamps (plan 377 Q2).
--
-- A delivery the maintenance window could not hand back to the queue leaves a
-- `stage = 'maintenance_deferred'` `review_failures` row that nothing replays.
-- Replay is a FRESH recovery of that PR's current head, not a re-delivery of
-- the old webhook body, so the row only needs to record that an operator asked
-- for it and when the queue send finally resolved:
--
--   maintenance_replay_requested_at  when an operator requested the replay
--   maintenance_replay_sent_at       when the queue send resolved
--
-- Both are nullable UTC ISO-8601 text and absent on every existing row. A
-- requested-but-unsent pair is the outbox entry the sweep retries while the
-- maintenance window is readable and open.
--
-- No new table: the state belongs to the failure row it replays, and "never
-- delete the failure" is what keeps the record visible after a recovery.
--
-- The partial index serves exactly the outbox scan (`requested IS NOT NULL AND
-- sent IS NULL`, ordered oldest-request first), so a completed or never-
-- requested row is outside the structure.
--
-- Metadata-only: two nullable column adds and one index build, no row rewrite.
-- Forward-only.

ALTER TABLE review_failures ADD COLUMN maintenance_replay_requested_at TEXT;
ALTER TABLE review_failures ADD COLUMN maintenance_replay_sent_at TEXT;

CREATE INDEX idx_review_failures_maintenance_replay_pending
  ON review_failures(maintenance_replay_requested_at, id)
  WHERE maintenance_replay_requested_at IS NOT NULL AND maintenance_replay_sent_at IS NULL;
