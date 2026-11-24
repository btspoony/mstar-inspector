-- 0109_check_run_id_index.sql — the check_run.rerequested reverse lookup.
--
-- A rerequested delivery resolves its PR identity from the attempt row the
-- remote run id names: `WHERE github_app_id = ? AND check_run_id = ?` on the
-- webhook's synchronous path, which waits on this answer before it enqueues.
-- `check_run_id` is set only on rows whose remote run is proven (`create_state
-- = 'known'`), so the partial index covers every row the lookup can match.
-- Terminal rows intentionally keep their index entry: a Re-run request names
-- exactly such an already-concluded run.
CREATE INDEX IF NOT EXISTS idx_review_checks_app_run
  ON review_checks(github_app_id, check_run_id)
  WHERE check_run_id IS NOT NULL;

