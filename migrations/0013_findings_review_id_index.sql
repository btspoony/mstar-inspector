-- 0013_findings_review_id_index.sql — index the finding→review attribution
-- column (plan 22 Task 2, QC W-2 amendment; fixes the plan 21 T3 hot path).
--
-- findings.review_id is the FK to reviews.id: the plan-21 consumer's
-- previousRoundFingerprints query (`SELECT fingerprint FROM findings WHERE
-- review_id = ?`) runs on the per-PR hot path, and every plan-22 insights
-- aggregation joins findings → reviews on this column. Nothing indexed it,
-- so these lookups fell back to full table scans over an ever-growing table;
-- 0013 fills the gap.
--
-- Metadata-only: CREATE INDEX builds the secondary structure without
-- rewriting the table, so it is safe to apply over a live production DB with
-- existing rows. Must apply AFTER 0001 (the indexed column must exist).
-- 0011/0012 were cancelled by plan 21 QC — this number is free.
--
-- Append-only: nothing here rewrites rows or drops data.

CREATE INDEX idx_findings_review_id ON findings(review_id);
