-- 0014_idx_reviews_reviewed_at.sql — index the insights window predicate
-- (plan 22, QC W-D): every plan-22 insights aggregation filters
-- `reviews.reviewed_at >= datetime('now', '-' || ? || ' days')`, and with
-- no index on reviewed_at the planner must full-scan reviews (or the
-- per-repo slice) per request — six aggregations per panel load. 0014 makes
-- the window a seekable range scan.
--
-- Metadata-only: CREATE INDEX builds the secondary structure without
-- rewriting the table, so it is safe to apply over a live production DB with
-- existing rows. Must apply AFTER 0001 (the indexed column must exist).
-- 0011 (plan 20 webhook deliveries) and 0012 (plan 23 custom providers)
-- apply before this file in filename order post-merge; 0013/0014 are plan 22.
--
-- Append-only: nothing here rewrites rows or drops data.

CREATE INDEX idx_reviews_reviewed_at ON reviews(reviewed_at);
