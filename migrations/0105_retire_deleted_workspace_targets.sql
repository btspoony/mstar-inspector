-- Retire the review targets a deleted workspace left live.
--
-- Workspace deletion now stamps `deleted_at` on the workspace's live targets in
-- the same batch that retires the workspace. Before that, a deleted workspace's
-- targets stayed live: they kept their bot-level repository claim
-- (`review_targets_bot_repo_unique`), so no other workspace could add those
-- repositories even after rebinding the installation. This backfill stamps
-- those rows with their workspace's own `deleted_at`. Rows stay in place, so the
-- ledger and per-month counts that read soft-deleted targets are unchanged.
UPDATE review_targets
   SET deleted_at = (SELECT w.deleted_at FROM workspaces w WHERE w.id = review_targets.workspace_id),
       updated_at = datetime('now')
 WHERE deleted_at IS NULL
   AND workspace_id IN (SELECT id FROM workspaces WHERE deleted_at IS NOT NULL);
