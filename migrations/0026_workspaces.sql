-- 0026_workspaces.sql — workspace ownership data plane.
--
-- workspaces is the tenant root: every App and every dashboard user belongs
-- to exactly one workspace. Single-tenant deployments get one workspace whose
-- id and slug are both 'default'; the seed row below is that workspace, so a
-- later multi-tenant feature can attach rows without a NULL-owner window.
--
-- workspace_members is the user side of the ownership map (role domain:
-- 'owner' | 'admin' | 'member', store-enforced like the 0003 users.role
-- domain). user_id references users(id) — the row id, never the GitHub login,
-- so a login rename cannot orphan a membership.
--
-- app_workspaces is the App side: one row per App, app_id is the PK. The map
-- lives in its own table rather than as a github_apps column so ownership can
-- evolve (and be backfilled) without rebuilding the App table.
--
-- Append-only on the production DB: creates new tables only, touches no
-- existing table. There is deliberately no ON DELETE clause (0004/0006
-- precedent): removal is soft delete, and the default NO ACTION makes a hard
-- DELETE of a referenced workspace or user impossible at the schema level.
-- Must apply AFTER 0003 (users) and 0004 (github_apps) — the FK parents.
--
-- The seed uses a fixed ISO timestamp rather than a database clock so the
-- applied row is byte-identical across local and remote applies.

CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  role         TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE app_workspaces (
  app_id       TEXT PRIMARY KEY REFERENCES github_apps(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id)
);

INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
VALUES ('default', 'default', 'Default', NULL, '2026-10-21T00:00:00.000Z', NULL);
