-- 0048_review_failures_pipeline_window.sql — the trailing-24h admission-drop
-- read gets an index that matches its own predicate.
--
-- The operator runtime page counts terminal admission drops over the trailing
-- 24h on EVERY load (`src/admin/index.ts` → `countAdmissionDrops24h`), and that
-- query filters `stage = 'pipeline'` before the `created_at` window. The table
-- is an append-only event log carrying every stage, so with only the 0010
-- `idx_review_failures_created` the planner walks every row of the window (and
-- for a fresh table, most of the table) and discards the non-pipeline stages
-- one by one — a cost that grows with all failure traffic, not just the drops.
--
-- This PARTIAL index is keyed on `created_at` and restricted to the read's own
-- `stage = 'pipeline'` predicate: the planner can range-scan it straight away
-- and the structure never holds a row the read would reject. `stage` is not a
-- column in the index because the predicate already pins it.
--
-- No column, constraint or stage-vocabulary change: the write path and the
-- `created_at` contract documented in `src/store/failure-store.ts` (BUG-03)
-- are untouched.
--
-- Append-only on the production DB: one CREATE INDEX over the table 0010
-- created, no data rewrite. Forward-only (SQLite has no down).

CREATE INDEX idx_review_failures_pipeline_created
  ON review_failures (created_at)
  WHERE stage = 'pipeline';
