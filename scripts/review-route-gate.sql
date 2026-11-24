-- Deployment-owned routing gate. A successful deploy idempotently opens the
-- Workflow route (absent or `off` reads closed), so every deploy of the same
-- pipeline writes the same row and replaying it is a no-op. `updated_by`
-- carries the pipeline actor — the operator surface holds no write path.
INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
VALUES ('review.route.workflow', 'on', datetime('now'), 'deploy-pipeline')
ON CONFLICT(key) DO UPDATE SET
  value = 'on',
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by;
