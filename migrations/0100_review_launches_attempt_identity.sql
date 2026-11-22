-- 0100_review_launches_attempt_identity.sql — index a launch by the
-- (attempt_key, generation) its Check carries.
--
-- The per-minute Check reconcile selects a Check whose attempt persisted its
-- paid result but never concluded the Check (I-000684), probing
-- `review_launches` once per candidate row by that frozen identity — the same
-- pair `review_checks` stores. Without this index each probe scans the whole
-- (never pruned) launch table. The 0095 partial index only covers rows that
-- already carry an owed mark, which this state deliberately does not.
CREATE INDEX idx_review_launches_attempt_identity
  ON review_launches (attempt_key, attempt_generation);
