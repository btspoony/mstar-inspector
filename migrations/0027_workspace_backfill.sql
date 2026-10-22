-- 0027_workspace_backfill.sql — idempotent backfill into the 'default'
-- workspace.
--
-- 0026 creates the ownership tables and seeds the default workspace; this
-- file attributes every pre-existing row to it. Both statements are
-- re-runnable: each is an INSERT…SELECT guarded by WHERE NOT EXISTS against
-- its own target, so applying the file twice (or after new rows appear)
-- inserts nothing that already exists. Unlike 0017's one-shot backfill, this
-- file is safe to re-apply and is the migration a partially-applied
-- deployment can run again.
--
-- Scope decisions:
--   * github_apps: soft-deleted rows (deleted_at NOT NULL) are included. The
--     mapping is ownership, not liveness — a restored App must not fall
--     outside the workspace, and app_workspaces.app_id is the PK, so a
--     per-row guard is the only correct predicate.
--   * users: 'admin' maps to 'owner', 'member' maps to 'member'. It reads the
--     users table only — no ADMIN_LOGINS allowlist and no assumption that a
--     deployer row exists. Both statements reference users(id); no login is
--     involved, so a case-renamed login keeps its membership.
--   * created_at is a fixed ISO timestamp, never a clock read, so a second
--     apply is byte-identical and the row is deterministic across hosts.
--
-- Append-only: DML only against tables created by 0026, no existing table is
-- touched. Must apply AFTER 0026 (the target tables and the 'default' row).

INSERT INTO app_workspaces (app_id, workspace_id)
SELECT g.id, 'default'
FROM github_apps g
WHERE NOT EXISTS (SELECT 1 FROM app_workspaces w WHERE w.app_id = g.id);

INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
SELECT 'default', u.id,
       CASE u.role WHEN 'admin' THEN 'owner' ELSE 'member' END,
       '2026-10-21T00:00:00.000Z'
FROM users u
WHERE u.role IN ('admin', 'member')
  AND NOT EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = 'default' AND wm.user_id = u.id
  );
