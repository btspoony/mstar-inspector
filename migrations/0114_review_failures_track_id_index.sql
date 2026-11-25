-- 0114_review_failures_track_id_index.sql — the settlement-recovery lookup of a
-- failure row by the attempt it belongs to.
--
-- `track_id` is the attempt id a failure belongs to (0106). Builds before the
-- attempt-keyed insert wrote a live settlement's row as
-- `id = <random UUID>, track_id = <attemptId>`, so the primary key alone cannot
-- find it; recovery has to ask both keys. Without an index that `track_id` arm
-- scans every workspace's failure history on each lost reply, so it gets its
-- own non-unique index: one attempt legitimately carries more than one row
-- (its main record and a `<attemptId>:recheck` per-stage row).
CREATE INDEX IF NOT EXISTS idx_review_failures_track_id
  ON review_failures(track_id);
