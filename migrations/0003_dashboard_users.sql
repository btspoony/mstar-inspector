-- 0003_dashboard_users.sql — Dashboard membership (plan 12 B4 Task 1).
--
-- Append-only DDL on the existing production DB: 0001/0002 are untouched and
-- wrangler applies this file in filename order like every migration before
-- it. DDL single source of truth: tests execute THIS file (bun:sqlite
-- in-memory) and wrangler applies it to real D1 (--local / --remote).
--
-- Shape locked by the v0.5 spec § Data model (dashboard-multi-app-platform):
--   * NO status column — removal is a row DELETE. The per-request guard
--     (plan 12 Task 2) re-reads this table every request, so a deleted row
--     is what invalidates removed members' stateless session cookies.
--   * role is pinned to 'admin' | 'member' by CHECK (no other roles, ever).
--   * github_login UNIQUE — one membership row per GitHub login. Code-side
--     lookups compare case-insensitively (GitHub logins are
--     case-insensitive upstream); the UNIQUE index backstops exact-case
--     duplicates at the DDL layer.
--   * id is caller-supplied TEXT (UUID) — same pattern as 0001 reviews.id,
--     no autoincrement dependency.
--   * created_at TEXT NOT NULL, always supplied by the store (ISO-8601 UTC).
--   * invited_by NULL = bootstrapped (ADMIN_LOGINS match / first-login
--     fallback on an empty table), not invited by an admin.

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  github_login TEXT UNIQUE NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at   TEXT NOT NULL,
  invited_by   TEXT
);
