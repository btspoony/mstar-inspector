-- 0040_runtime_config.sql — operable runtime parameters (review concurrency).
--
-- `review_runtime_settings` holds the system-scope values an operator can
-- change without a deploy. It mirrors `server_flags` (0033) deliberately: one
-- row per overridden key, an ABSENT row is the documented default, and the
-- value is TEXT because the table is a settings store, not a typed schema —
-- the leaf store (`src/dashboard/runtime-config-store.ts`) is the one place
-- that parses it, so a future parameter does not need a migration.
--
-- Only non-secret parameters enter this table. Wrangler secrets
-- (DASHBOARD_ENCRYPTION_KEY, DASHBOARD_SESSION_SECRET,
-- GITHUB_OAUTH_CLIENT_SECRET, ALERT_WEBHOOK_URL) are never read from or written
-- here.
--
-- `updated_by` is nullable rather than NOT NULL (0033 makes it NOT NULL): the
-- seeded/absent distinction carries no actor, and a write always supplies one.
--
-- `workspaces.max_concurrent_reviews` is the per-tenant cap. NULL means "use
-- the default" (16), which is why the column is nullable and why it is added
-- without a DEFAULT: an existing row must not be frozen to today's number.
--
-- Append-only on the production DB: creates one table and adds one nullable
-- column. No rows, no backfill, no consumer change.

CREATE TABLE review_runtime_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

ALTER TABLE workspaces ADD COLUMN max_concurrent_reviews INTEGER;
