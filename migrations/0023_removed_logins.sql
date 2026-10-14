-- 0023_removed_logins.sql — removal tombstones: an operator's removal sticks.
--
-- Append-only DDL on the existing production DB (0003+ convention): earlier
-- files are untouched and wrangler applies this one in filename order, both
-- locally and remotely, before the Worker ships.
--
-- Why this table exists: the OAuth callback is exempt from the per-request
-- membership guard, and the required ADMIN_LOGINS allowlist is re-injected on
-- every deploy. Removal is a row DELETE (0003: deliberately no status column),
-- so without a record of the removal the next OAuth login of a removed login
-- that is still on the allowlist re-created it as admin — removal was
-- ineffective. `bootstrapDashboardAccess` therefore consults this table AFTER
-- the existing-row check and BEFORE the allowlist branch: an existing `users`
-- row still wins, a recorded removal denies, and only then may the allowlist
-- create an admin. A deliberate re-invite (createUser) clears the record.
--
--   * github_login is the key and compares NOCASE, exactly like
--     `users.github_login` lookups and the 0016 NOCASE unique index (0003's
--     UNIQUE is BINARY): removing "OctoCat" removes "octocat".
--   * removed_at is store-supplied ISO-8601 UTC (users.created_at convention).
--   * removed_by is the acting admin's GitHub login; NULL when the removal
--     came through the store's unconditional delete (no actor in scope).
--
-- Rows are only written by the removal batch in src/dashboard/users.ts, in the
-- SAME transaction as the row delete, so "removed" can never be recorded
-- without the row actually being gone — or a row deleted without being
-- recorded. The last-admin guard refuses both writes together, so a refused
-- removal records nothing.

CREATE TABLE removed_logins (
  github_login TEXT NOT NULL COLLATE NOCASE,
  removed_at   TEXT NOT NULL,
  removed_by   TEXT
);

CREATE UNIQUE INDEX removed_logins_login_nocase_idx ON removed_logins(github_login COLLATE NOCASE);
