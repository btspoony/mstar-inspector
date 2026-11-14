-- workspace-backfill.sql — idempotent App attribution repair for the deploy
-- replay step.
--
-- Both deploy workflows replay ONE repair file after `d1 migrations apply`, so
-- a partially applied deploy heals without a manual run. That file was
-- `migrations/0027_workspace_backfill.sql`; 0056 renamed the bot family to
-- `review_bots` / `bot_workspaces(bot_id)`, and the historical file must keep
-- the pre-rename names it was written with (on a fresh database it runs before
-- 0056). The replay therefore points here instead.
--
-- Must stay idempotent: every deploy runs it. Soft-deleted bots (deleted_at NOT
-- NULL) are included — the mapping is ownership, not liveness, so a restored
-- bot must not fall outside the workspace — and the guard is `WHERE NOT EXISTS`
-- against the target, so a re-apply inserts nothing that already exists.
--
-- It writes no per-person row: replaying a `workspace_members` write is what
-- made every routine deploy re-add removed members to 'default'.

INSERT INTO bot_workspaces (bot_id, workspace_id)
SELECT g.id, 'default'
FROM review_bots g
WHERE NOT EXISTS (SELECT 1 FROM bot_workspaces w WHERE w.bot_id = g.id);
