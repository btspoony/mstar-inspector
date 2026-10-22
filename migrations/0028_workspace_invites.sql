-- 0028_workspace_invites.sql — workspace invitation rows.
--
-- Append-only DDL on the existing production DB (0003+ convention): earlier
-- files are untouched and wrangler applies this one in filename order, both
-- locally and remotely, before the Worker ships.
--
-- An invite is the ONLY way into a workspace besides owning it by creation:
-- a signed-in GitHub login with a live `pending` row for that workspace may
-- accept it, and acceptance writes the `workspace_members` row.
--
--   * status domain: 'pending' | 'accepted' | 'revoked' | 'expired'.
--     'expired' is a LAZY-FLIP terminal state — never inserted directly. The
--     flip (every invite write path, in the same batch as its own write)
--     turns a lapsed 'pending' row into 'expired', and a lapsed row that no
--     write has reached yet still reads 'pending', so every read keeps the
--     `status = 'pending' AND expires_at > ?` predicate. There is no timer,
--     no background job and no cron.
--   * role domain excludes 'owner': ownership is granted by workspace
--     creation or by an explicit owner-only promote, never by an invite.
--   * github_login carries COLLATE NOCASE, which governs both partial
--     indexes below (SQLite column-collation rule): the pending uniqueness is
--     case-insensitive without restating it, so a GitHub display-case change
--     cannot orphan or duplicate an invite.
--   * workspace_invites_pending is the live-invite uniqueness constraint: a
--     second `pending` row for one (workspace, login) is a UNIQUE violation
--     and surfaces as 409 `invite.pending_exists`. Because the flip makes a
--     lapsed row non-pending first, the index also admits the replacement
--     invite after expiry. It additionally serves the workspace-scoped
--     pending reads (workspace_id + status), which imply the partial
--     predicate.
--   * workspace_invites_login serves the invitee's cross-workspace discovery
--     read (boot payload / empty state).
--   * NO ON DELETE clause anywhere (0026 precedent): default NO ACTION makes
--     a hard DELETE of a referenced workspace or user impossible at the
--     schema level. Removal stays soft delete.
--   * Timestamps are caller-supplied ISO-8601 UTC strings (0003 created_at
--     convention), never a database clock. This file seeds no rows.
--
-- Must apply AFTER 0026 (workspaces / workspace_members) and 0003 (users) —
-- the FK parents.

CREATE TABLE workspace_invites (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  github_login  TEXT NOT NULL COLLATE NOCASE,
  role          TEXT NOT NULL CHECK (role IN ('admin','member')),
  status        TEXT NOT NULL CHECK (status IN ('pending','accepted','revoked','expired')),
  invited_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  accepted_at   TEXT
);

CREATE UNIQUE INDEX workspace_invites_pending
  ON workspace_invites (workspace_id, github_login)
  WHERE status = 'pending';

CREATE INDEX workspace_invites_login
  ON workspace_invites (github_login)
  WHERE status = 'pending';
