-- 0097_handoff_settling_index.sql — index the started-but-unsettled handoffs.
--
-- `review_attempt_handoffs` keeps one row per delivery and is never pruned,
-- while only a settlement that started and never completed carries
-- `settling_ms` without `settled_ms`. The 15-minute route reconcile selects
-- exactly those rows by `settling_ms`; without an index every pass scans the
-- whole delivery history. The partial index holds only the open settlements.
CREATE INDEX idx_review_attempt_handoffs_settling
  ON review_attempt_handoffs (settling_ms)
  WHERE settled_ms IS NULL AND settling_ms IS NOT NULL;
