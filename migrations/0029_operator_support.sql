-- 0029_operator_support.sql — platform support grants and the append-only audit log.
--
-- Append-only DDL on the existing production DB (0026/0028 convention): earlier
-- files are untouched and wrangler applies this one in filename order, both
-- locally and remotely, before the Worker ships.
--
--   * support_grants is the ONLY thing that lets a platform operator (a login in
--     PLATFORM_OPERATORS that is not a member) read a workspace's identity
--     fields and member list. A grant is workspace-scoped and time-boxed:
--     `hasValidGrant` reads `expires_at > ?` per request, so expiry needs no
--     timer, no background job and no status flip — an expired row simply stops
--     matching, exactly like no row at all.
--   * operator_login carries COLLATE NOCASE (0028 precedent): a GitHub
--     display-case change must not orphan or widen a grant. The same collation
--     governs the comparisons on the index's second column (`operator_login`).
--   * granted_by is the creating operator's login STRING (the CLI actor), not a
--     `users` FK: operators hold no user row, and the grant is audit history
--     rather than a permission edge to a user.
--   * audit_events is append-only by construction. There is no UPDATE or DELETE
--     path in the store module (`operator-store.ts` exports insert/list only),
--     and the plan's T3 source-shape assertion guards that.
--     `action` keeps the closed vocabulary 'support.read' | 'support.forbidden'
--     | 'support.denied'; it is free TEXT here and checked in code so a new
--     action needs no migration.
--   * Both workspace_id columns keep the default NO ACTION (0026 precedent): a
--     hard DELETE of a referenced workspace stays impossible at the schema
--     level, so workspace removal stays soft delete and audit history can never
--     be cascaded away.
--   * Timestamps are caller-supplied ISO-8601 UTC strings (0003 created_at
--     convention), never a database clock — `expires_at > ?` compares them as
--     text, which is correct because every writer uses the same fixed-width
--     `.toISOString()` form. This file seeds no rows.
--
-- Must apply AFTER 0026 (workspaces) — the FK parent.

CREATE TABLE support_grants (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  operator_login TEXT NOT NULL COLLATE NOCASE,
  reason         TEXT NOT NULL,
  granted_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

-- Serves the per-request validity lookup (workspace + login) and the members'
-- notice read (workspace + unexpired), which imply the expiry comparison.
CREATE INDEX support_grants_lookup ON support_grants (workspace_id, operator_login, expires_at);

CREATE TABLE audit_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_login  TEXT NOT NULL COLLATE NOCASE,
  action       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- Serves the owner/admin list read: newest-first within one workspace.
CREATE INDEX audit_events_workspace ON audit_events (workspace_id, created_at);
