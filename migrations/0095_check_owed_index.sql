-- 0095_check_owed_index.sql — index the owed-Check marks on review_launches.
--
-- `review_launches` keeps one row per review attempt and is never pruned, while
-- only the few attempts that owe a Check settlement carry `check_owed_ms`. The
-- per-minute Check reconcile probes those marks by the Check's
-- (attempt_key, generation) from inside its due predicate (once per candidate
-- row) and clears concluded ones on every pass; without an index each probe
-- scans the whole table. The partial index holds only the marked rows.
CREATE INDEX idx_review_launches_check_owed
  ON review_launches (check_key, check_generation, check_owed_ms)
  WHERE check_owed_ms IS NOT NULL;
