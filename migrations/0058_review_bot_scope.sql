-- 0058_review_bot_scope.sql — a bot carries a scope: owned by one workspace, or
-- shared across the platform.
--
-- `owned` is the only state that exists today, so the default is the whole
-- backfill: every existing bot stays owned and has never been shared.
-- `shared_at` is the instant a share began — the one timestamp an operator has
-- when a platform-wide bot misbehaves, and it survives a revoke only in the
-- audit ledger.
--
-- Two ALTERs, no table rebuild. A rebuild cannot run here: D1 executes a
-- migration file inside one transaction, where `PRAGMA foreign_keys = OFF` is
-- inert, so `DROP TABLE review_bots` would fire `pull_requests`'
-- ON DELETE CASCADE and empty the PR ledger (the same reason 0057 drops its
-- moved columns in place). Each column carries only its own inline CHECK,
-- which SQLite drops with the column.
--
-- Only a platform operator writes `scope`; no workspace route, API key or
-- dashboard path does. No review path reads it in this deploy.
--
-- Forward-only.

ALTER TABLE review_bots ADD COLUMN scope TEXT NOT NULL DEFAULT 'owned'
  CHECK (scope IN ('owned','shared'));
ALTER TABLE review_bots ADD COLUMN shared_at TEXT;
