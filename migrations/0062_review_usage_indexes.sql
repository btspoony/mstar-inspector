-- 0062_review_usage_indexes.sql — the two indexes the review-usage aggregation
-- needs to keep a month bounded.
--
-- `src/dashboard/review-usage-store.ts#readReviewUsage` joins
-- `workspaces → review_targets → reviews → review_bots` and filters the review
-- side by a UTC month of `reviewed_at`. Both tables carry single-column
-- indexes from 0057 (`idx_reviews_target_id`, `idx_reviews_reviewed_at`) and
-- 0057's `idx_review_targets_bot_id`, but nothing serves the two predicates
-- the statement actually makes:
--
--   * the review join is `target_id = ?` AND a `reviewed_at` range, so without
--     a composite index SQLite either scans a target's whole history and
--     filters afterwards or range-scans the month and probes per row;
--   * the target join is `workspace_id = ?`, and no index leads with that
--     column.
--
-- Both matter most on the operator face, which binds no workspace and
-- therefore aggregates every live workspace in one statement.
--
-- Metadata-only: `CREATE INDEX` builds a secondary structure without rewriting
-- either table, so this is safe to apply over a live production DB with
-- existing rows. Append-only: nothing here rewrites or drops data.
--
-- Must apply AFTER 0057 (both indexed tables) and 0014 (`idx_reviews_reviewed_at`
-- stays: it serves reads that filter the window with no target).

CREATE INDEX idx_reviews_target_reviewed_at ON reviews(target_id, reviewed_at);

CREATE INDEX idx_review_targets_workspace_id ON review_targets(workspace_id);
