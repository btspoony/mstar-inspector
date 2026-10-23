-- 0030_workspace_membership_cutover.sql — ONE-TIME membership backfill into
-- the 'default' workspace, scoped to the users that predate open sign-in.
--
-- Why this file exists (and why 0027 no longer does this):
--   0027's membership statement — INSERT … SELECT … FROM users — ran for
--   EVERY users row. Both deploy workflows replay 0027 through
--   `wrangler d1 execute --file` (outside the migrations ledger), so after
--   open sign-in (any GitHub login gets a `users` row, no allowlist, and a
--   removal keeps the row) a routine deploy made every login a member of the
--   live 'default' workspace, re-added removed members, and returned a legacy
--   `role = 'admin'` row as `owner`. The App-attribution half of 0027 is a
--   genuine repair and stays there; the membership half is not re-runnable
--   repair, so it lives here where `wrangler d1 migrations apply` runs it
--   EXACTLY ONCE per database.
--
-- CUTOVER: 2026-10-22T11:13:45.000Z — the instant open sign-in landed
-- (commit 3a98f38, "login is member and workspace creation"). `users` rows
-- created at or after that instant signed in under the new rules and joined
-- nobody; they are excluded here. Rows created before it were admitted by the
-- retired allowlist and were the intended members of 'default'. A deployment
-- whose open-sign-in cutover differs must NOT edit this file after it applied
-- — write the next numbered migration instead.
--
-- Two more exclusions, both real signals rather than guesses:
--   * a login with a `removed_logins` record stays out — an operator removed
--     them, and only a deliberate re-admission (createUser) may undo that;
--   * an existing `workspace_members` row is kept as-is (NOT EXISTS), so an
--     invite-accepted membership or an owner's role change is never
--     overwritten by the legacy `users.role` mapping.
--
-- Do NOT re-run this file by hand: it cannot tell a legitimate pre-cutover
-- member from one an owner removed afterwards, so a second apply would
-- restore them. `docs/deploy.md` § "Repairing a replayed 0027 membership
-- backfill" is the supported path for a database the old replay already
-- polluted.
--
-- Append-only DML against tables created by 0023/0026; no existing row is
-- updated or deleted. Must apply AFTER 0026 (target tables + the seeded
-- 'default' row) and 0023 (removed_logins).

INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
SELECT 'default', u.id,
       CASE u.role WHEN 'admin' THEN 'owner' ELSE 'member' END,
       '2026-10-21T00:00:00.000Z'
FROM users u
WHERE u.created_at < '2026-10-22T11:13:45.000Z'
  AND u.role IN ('admin', 'member')
  AND NOT EXISTS (
    SELECT 1 FROM removed_logins r
    WHERE r.github_login = u.github_login COLLATE NOCASE
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = 'default' AND wm.user_id = u.id
  );
