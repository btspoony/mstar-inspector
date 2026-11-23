-- 0104_review_failures_error_code.sql — every new failure carries a stable
-- operator-facing code and a track id.
--
-- `review_failures.error` keeps the mechanism text an operator needs, and the
-- UI keeps it inside the collapsed block; `error_code` is the key a PR author
-- sees and the key an incident is queried by (`wrangler tail --search <code>`).
-- `track_id` is the attempt id the failure belongs to (the Workflow instance
-- id), or the row's own id when the failure never reached an attempt.
--
-- Both nullable with no backfill: a historical row has no code, and the UI
-- renders it exactly as before. NULL therefore means "recorded before 0104",
-- never "classified as nothing".
ALTER TABLE review_failures ADD COLUMN error_code TEXT;
ALTER TABLE review_failures ADD COLUMN track_id TEXT;

-- The incident query: every occurrence of one code, newest first.
CREATE INDEX idx_review_failures_code_created ON review_failures (error_code, created_at);
