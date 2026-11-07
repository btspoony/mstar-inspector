-- 0051_review_failures_rate_limit_window.sql — the trailing-24h
-- secondary-rate-limit count gets an index that matches its own predicate.
--
-- The operator runtime page counts `github-secondary-rate-limit:` failures
-- over the trailing 24h on every load (`src/store/failure-store.ts`
-- `countGithubRateLimited24h`). That read states exactly two terms —
-- `created_at > datetime('now', '-24 hours')` and `error LIKE ?` — and no
-- stage predicate, so the 0048 partial index (`... WHERE stage = 'pipeline'`)
-- can never serve it. With only the 0010 `idx_review_failures_created`, the
-- planner walks the whole window and reads the table row of every failure to
-- evaluate the LIKE term; the table is an append-only log of every stage, so
-- that cost grows with all failure traffic, not just the secondary-limit rows.
--
-- Column order follows the predicate: `created_at` is the seekable range, and
-- `error` is carried so the LIKE test is answered from the index alone. There
-- is no ORDER BY (the read is `COUNT(*)`), so no further column is needed.
-- The write path and the `created_at` contract documented in
-- `src/store/failure-store.ts` (BUG-03) are untouched.
--
-- Append-only on the production DB: one CREATE INDEX over the table 0010
-- created, no data rewrite. Forward-only (SQLite has no down).

CREATE INDEX idx_review_failures_rate_limited_created
  ON review_failures (created_at, error);
