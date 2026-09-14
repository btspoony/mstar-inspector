-- 0013_findings_review_id_index.sql — index the finding→review attribution
-- column (QC W-2 amendment; fixes the consumer hot path).
--
-- findings.review_id is the FK to reviews.id: the consumer's
-- previousRoundFingerprints query (`SELECT fingerprint FROM findings WHERE
-- review_id = ?`) runs on the per-PR hot path, and every insights
-- aggregation joins findings → reviews on this column. Nothing indexed it,
-- so these lookups fell back to full table scans over an ever-growing table;
-- 0013 fills the gap.
--
-- Metadata-only: CREATE INDEX builds the secondary structure without
-- rewriting the table, so it is safe to apply over a live production DB with
-- existing rows. Must apply AFTER 0001 (the indexed column must exist).
-- 0011 (webhook deliveries) and 0012 (custom providers)
-- apply before this file in filename order post-merge; 0013 and 0014 —
-- all present post-merge.
--
-- Append-only: nothing here rewrites rows or drops data.

CREATE INDEX idx_findings_review_id ON findings(review_id);
