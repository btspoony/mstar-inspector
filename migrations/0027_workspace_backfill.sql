-- 0027_workspace_backfill.sql — idempotent App attribution into the 'default'
-- workspace. This file is REPLAYED by both deploy workflows after
-- `d1 migrations apply` (repair for a partially-applied deploy), so it must
-- contain ONLY a repair that is safe to repeat and grants nothing to anyone.
--
-- 0026 creates the ownership tables and seeds the default workspace; this
-- file attributes every pre-existing App to it. The statement is an
-- INSERT…SELECT guarded by WHERE NOT EXISTS against its own target, so
-- applying the file twice (or after new Apps appear) inserts nothing that
-- already exists.
--
-- The membership half that used to live here is NOT re-runnable repair: it
-- inserted a `workspace_members` row for every `users` row, so a routine
-- deploy re-added every login — including removed members — to the live
-- `default` workspace. It moved to the forward-only migration
-- `0030_workspace_membership_cutover.sql`, which `d1 migrations apply` runs
-- exactly once. Do not put a write to `workspace_members` (or any other
-- per-person table) back into this file.
--
-- Scope decisions:
--   * github_apps: soft-deleted rows (deleted_at NOT NULL) are included. The
--     mapping is ownership, not liveness — a restored App must not fall
--     outside the workspace, and app_workspaces.app_id is the PK, so a
--     per-row guard is the only correct predicate.
--
-- Append-only: DML only against tables created by 0026, no existing table is
-- touched. Must apply AFTER 0026 (the target tables and the 'default' row).

INSERT INTO app_workspaces (app_id, workspace_id)
SELECT g.id, 'default'
FROM github_apps g
WHERE NOT EXISTS (SELECT 1 FROM app_workspaces w WHERE w.app_id = g.id);
