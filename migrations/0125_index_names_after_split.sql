-- 0125_index_names_after_split.sql — the indexes the App/Bot split left behind.
--
-- 0115 renamed `bot_id` to `app_id` on five tables and `bot_installations` to
-- `github_app_installations`. It renamed no index, so twelve index names
-- describe a schema that no longer exists. One of them actively misleads: after
-- the split `reviews` carries both `app_id` (the publishing App) and `bot_id`
-- (the executing Review Bot), while `idx_reviews_bot_id` covers `app_id`. An
-- index whose name disagrees with its column is invisible to the planner, so no
-- behavioural test can catch it — only the names and `PRAGMA index_info` can.
--
-- Bodies are the ones the migrated schema holds, never a re-reading of the
-- `CREATE INDEX` statements: 0080's health index was dropped and recreated by
-- 0113, and 0060 recreated `idx_pull_requests_bot_pr` after 0057 dropped it.
--
-- Per index: create the new name first, drop the old one last, so no window
-- leaves a query without its covering index. Both drops carry `IF EXISTS` — the
-- leading one makes a run that died after creating the new name re-runnable,
-- the trailing one lets this file replay once it has completed.
--
-- `idx_webhook_deliveries_app_created` existed once before (0011), renamed by
-- 0056; the leading `DROP INDEX IF EXISTS` covers that name.
--
-- Forward-only. Must apply AFTER 0115, whose column names it creates, and 0113,
-- whose `CASE` it copies.

-- `reviews` now holds a real `bot_id`, so this index must not claim it.
DROP INDEX IF EXISTS idx_reviews_app_id;
CREATE INDEX idx_reviews_app_id ON reviews(app_id);
DROP INDEX IF EXISTS idx_reviews_bot_id;

DROP INDEX IF EXISTS idx_webhook_deliveries_app_created;
CREATE INDEX idx_webhook_deliveries_app_created ON webhook_deliveries(app_id, created_at);
DROP INDEX IF EXISTS idx_webhook_deliveries_bot_created;

-- The expression is DELIVERY_VERDICT_TIER_SQL in src/dashboard/apps-store.ts
-- byte-for-byte: change both, never one. Only the name changes here; 0113 is
-- applied history and already widened the arm to include 'refused'.
DROP INDEX IF EXISTS idx_webhook_deliveries_app_health;
CREATE INDEX idx_webhook_deliveries_app_health
ON webhook_deliveries (
  app_id,
  (CASE WHEN outcome IN ('ok', 'paused', 'rejected', 'refused') THEN 0 ELSE 1 END) DESC,
  created_at
);
DROP INDEX IF EXISTS idx_webhook_deliveries_bot_health;

DROP INDEX IF EXISTS idx_webhook_deliveries_app_outcome_created;
CREATE INDEX idx_webhook_deliveries_app_outcome_created
ON webhook_deliveries (app_id, outcome, created_at);
DROP INDEX IF EXISTS idx_webhook_deliveries_bot_outcome_created;

DROP INDEX IF EXISTS idx_review_targets_app_id;
CREATE INDEX idx_review_targets_app_id ON review_targets(app_id);
DROP INDEX IF EXISTS idx_review_targets_bot_id;

DROP INDEX IF EXISTS idx_review_targets_app_repo;
CREATE INDEX idx_review_targets_app_repo ON review_targets(app_id, repo_id);
DROP INDEX IF EXISTS idx_review_targets_bot_repo;

DROP INDEX IF EXISTS idx_review_targets_app_workspace;
CREATE INDEX idx_review_targets_app_workspace ON review_targets(app_id, workspace_id);
DROP INDEX IF EXISTS idx_review_targets_bot_workspace;

-- The collation is part of the index: without it the name lookups it exists for
-- fall back to the repo index and filter by hand.
DROP INDEX IF EXISTS idx_review_targets_app_owner_name;
CREATE INDEX idx_review_targets_app_owner_name
  ON review_targets(app_id, repo_owner COLLATE NOCASE, repo_name COLLATE NOCASE);
DROP INDEX IF EXISTS idx_review_targets_bot_owner_name;

-- Both the uniqueness and the partial predicate are part of the index: without
-- the `WHERE`, a soft-deleted row blocks re-adding the same repository.
DROP INDEX IF EXISTS review_targets_app_repo_unique;
CREATE UNIQUE INDEX review_targets_app_repo_unique
  ON review_targets(app_id, repo_id)
  WHERE repo_id IS NOT NULL AND deleted_at IS NULL;
DROP INDEX IF EXISTS review_targets_bot_repo_unique;

DROP INDEX IF EXISTS idx_pull_requests_app_pr;
CREATE INDEX idx_pull_requests_app_pr ON pull_requests(app_id, owner, repo, pr_number);
DROP INDEX IF EXISTS idx_pull_requests_bot_pr;

-- The table these live on was renamed too.
DROP INDEX IF EXISTS idx_github_app_installations_installation;
CREATE INDEX idx_github_app_installations_installation
  ON github_app_installations(installation_id);
DROP INDEX IF EXISTS idx_bot_installations_installation;

DROP INDEX IF EXISTS idx_github_app_installations_bound_workspace;
CREATE INDEX idx_github_app_installations_bound_workspace
  ON github_app_installations(app_id, bound_workspace_id);
DROP INDEX IF EXISTS idx_bot_installations_bound_workspace;
