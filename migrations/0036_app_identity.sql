-- 0036_app_identity.sql — split the local App identity from GitHub's own.
--
-- `slug` was a locally minted, login-derived value, so three different things
-- read it as if it were the App's GitHub identity: the dashboard URL, the Apps
-- list label, and the bot-mention target (`<slug>[bot]`). GitHub's App slug is
-- mutable and is not derivable, so it becomes its own cached column.
--
-- Two statements:
--   1. RENAME COLUMN keeps the stored VALUES, so every live webhook URL
--      (`/webhooks/{path}`) and every existing row keeps working — the path was
--      always opaque to us, only its name was wrong. SQLite rewrites the NOT
--      NULL + UNIQUE constraint onto the new name, so uniqueness stays enforced
--      with no table rebuild (a rebuild would be unsafe over a live DB).
--   2. `github_slug` is nullable: rows that predate the first metadata sync have
--      no honest value, and NULL says "never synced" instead of guessing.
--
-- `github_slug` is deliberately NOT indexed. It caches a mutable upstream fact,
-- not an identity: GitHub frees a slug when its App is renamed or deleted and
-- reuses it for another App, so a stale cached value here may legitimately
-- equal the live slug of a different App. A UNIQUE index would turn that stale
-- cache into a write failure for an unrelated, newer App (and into a false
-- "already connected" conflict). Identity is `github_app_id`; nothing reads this
-- column as a key.

ALTER TABLE github_apps RENAME COLUMN slug TO webhook_path;
ALTER TABLE github_apps ADD COLUMN github_slug TEXT;
