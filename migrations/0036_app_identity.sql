-- 0036_app_identity.sql — split the local App identity from GitHub's own.
--
-- `slug` was a locally minted, login-derived value, so three different things
-- read it as if it were the App's GitHub identity: the dashboard URL, the Apps
-- list label, and the bot-mention target (`<slug>[bot]`). GitHub's App slug is
-- mutable and is not derivable, so it becomes its own cached column.
--
-- Three statements:
--   1. RENAME COLUMN keeps the stored VALUES, so every live webhook URL
--      (`/webhooks/{path}`) and every existing row keeps working — the path was
--      always opaque to us, only its name was wrong. SQLite rewrites the NOT
--      NULL + UNIQUE constraint onto the new name, so uniqueness stays enforced
--      with no table rebuild (a rebuild would be unsafe over a live DB).
--   2. `github_slug` is nullable: rows that predate the first metadata sync have
--      no honest value, and NULL says "never synced" instead of guessing.
--   3. The unique index lets the first sync fill the column while several
--      legacy rows still read NULL — SQLite unique indexes permit multiple
--      NULLs, so those rows do not collide.

ALTER TABLE github_apps RENAME COLUMN slug TO webhook_path;
ALTER TABLE github_apps ADD COLUMN github_slug TEXT;
CREATE UNIQUE INDEX github_apps_github_slug ON github_apps (github_slug);
