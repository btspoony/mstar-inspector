-- Deployment-owned routing gate. A successful deploy idempotently opens the
-- Workflow route (absent or `off` reads closed), so every deploy of the same
-- pipeline writes the same row and replaying it is a no-op. `updated_by`
-- carries the pipeline actor — the operator surface holds no write path.
--
-- `updated_at` uses the ISO-8601 form the operator writes store
-- (`2026-11-24T10:00:00.000Z`), not `datetime('now')`'s `YYYY-MM-DD HH:MM:SS`:
-- one column keeps one shape, so a reader can compare stamps across writers.
INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
VALUES ('review.route.workflow', 'on', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'deploy-pipeline')
ON CONFLICT(key) DO UPDATE SET
  value = 'on',
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by;
