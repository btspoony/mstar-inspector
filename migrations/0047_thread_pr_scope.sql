-- 0047_thread_pr_scope.sql — the recheck rotation's PR-scoped thread probe.
--
-- `selectAssessmentTargets` (spec §7.2) now also selects ADDRESSED findings
-- that still own a non-terminal association, so every rotation pass probes
-- `review_threads` for the current PR. The only existing thread index
-- (`idx_thread_recovery`) leads on `resolution_state`, which cannot serve that
-- scope probe, and `review_threads` is cross-installation: without an index the
-- selector would scan the whole table on every round.
--
-- Leading equality columns are the PR scope (the same tuple every scope-bound
-- read binds); `resolution_state` is the trailing column so the non-terminal
-- filter rides the index instead of the table.
--
-- Append-only, forward-only (SQLite has no down). Number 0047: 0043 is already
-- taken twice by shipped migrations (0043_webhook_delivery_repository,
-- 0043_workspace_concurrency_bound).

CREATE INDEX idx_thread_pr_scope
  ON review_threads(app_id, installation_id, owner, repo, pr_number, resolution_state);
