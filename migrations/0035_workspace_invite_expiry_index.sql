-- 0035_workspace_invite_expiry_index.sql — index the sweep's lapsed-invite
-- candidates (issue I-000096).
--
-- 0028's two partial indexes lead with `(workspace_id, github_login)` and
-- `(github_login)`: they serve the live-invite uniqueness constraint and the
-- invitee's cross-workspace discovery read. Neither is keyed by `expires_at`,
-- so the scheduled sweep's candidate subquery — `expireLapsedInvites` in
-- `src/dashboard/invite-store.ts`, filtering `status = 'pending' AND
-- expires_at <= ?` globally — had no seek term for the window. Its only
-- access paths were login-ordered scans of the WHOLE live pending set, so a
-- run that flips zero rows still paid for every pending row, and a capped
-- login-ordered slice served arbitrary (not oldest) rows.
--
-- `(expires_at, id)` matches the subquery's `ORDER BY expires_at, id`: with
-- `expires_at` alone SQLite would sort every matched row in a temp B-tree
-- before the cap applied. The trailing `id` turns the ordering into an index
-- fact, so the run becomes one bounded range seek that serves the OLDEST
-- lapsed rows first — a steady inflow of newer lapsed rows can no longer
-- consume the whole cap and postpone an older row indefinitely.
--
-- Partial on `status = 'pending'`, like both 0028 indexes and for the same
-- reason: `expired` / `accepted` / `revoked` rows are history, and the
-- predicate keeps the structure proportional to the live pending set.
--
-- Metadata-only: CREATE INDEX builds the secondary structure without
-- rewriting the table, so it is safe over a live DB with existing rows. Must
-- apply AFTER 0028 (the indexed columns must exist). No row and no consumer
-- changes: every reader keeps its own explicit filter and ORDER BY.

CREATE INDEX workspace_invites_expiry
  ON workspace_invites (expires_at, id)
  WHERE status = 'pending';
