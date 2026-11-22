-- Bounded discovery for an applied publication's line batch (§7.9a condition
-- 2's recovery half). A batch whose remote marker can never be matched stays
-- ELIGIBLE forever: read-only discovery fails, nothing changes, and the row
-- keeps its oldest position in every pass until it alone fills the bounded
-- selection. Ordering cannot fix that — only leaving the eligible set can.
--
-- The bound is a COUNT of failed readbacks, never a clock: a clock-based bound
-- re-admits the row on every slow pass and the starvation returns. The count
-- is durable on the row so a pass that captured nothing is not silently
-- forgotten, and the reason is what the last readback actually observed —
-- `marker-missing`, `comment-gone`, `readback-scope` (or `ambiguous`) — kept
-- beside the count so an operator can see why recovery stopped.
--
-- Leaving the set is NOT deletion: the row, its count and its reason remain.
-- `line_unresolvable_ms` NULL means the batch is still eligible.
ALTER TABLE review_publications ADD COLUMN line_discovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_publications ADD COLUMN line_unresolvable_ms INTEGER;
ALTER TABLE review_publications ADD COLUMN line_unresolvable_reason TEXT;
