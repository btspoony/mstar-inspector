-- 0034_support_grant_indexes.sql — index the two grant predicates that
-- `support_grants_lookup` cannot seek (issue I-000167).
--
-- 0029's `support_grants_lookup (workspace_id, operator_login, expires_at)`
-- serves every read that starts from a workspace: `hasValidGrant`,
-- `listActiveSupportGrants`, the `NEWEST_GRANT_APPEND` correlation, the
-- window delete and the grant-by-id deletes all seek its prefix. Two reads
-- have no workspace equality to lead with, so they could only scan:
--
--   * `admin/users.ts` LIST_USERS_SQL counts a user's live grants with
--     `g.operator_login = u.github_login AND g.expires_at > ?1` — a
--     login-keyed, expiry-bounded probe. Leading with `workspace_id` strands
--     it on a covering index scan of the whole grant table, repeated for
--     every user row. `support_grants_operator_window` leads with
--     `operator_login`, so both predicates become one seek.
--   * `listAllActiveSupportGrants` (the console's grant list) filters
--     `g.expires_at > ?` across ALL workspaces with no login or workspace
--     equality, so neither the lookup index nor the operator-window index can
--     bound it. `support_grants_expires_at` makes the window a range seek.
--
-- Neither index repeats an existing one's leading column: the lookup leads
-- with `workspace_id`, the operator window with `operator_login`, the expiry
-- index with `expires_at`, and `id` is already the primary key.
--
-- `workspace_id` is the operator window's third column on purpose: the count's
-- correlated subquery correlates on it, so carrying it in the index keeps the
-- probe covering and needs no per-row table access. It is a trailing column,
-- not a seek term — it orders nothing and never narrows a lookup.
--
-- Both indexes inherit `operator_login`'s COLLATE NOCASE (0029), because a
-- column's collation travels with it into an index.
--
-- Metadata-only: CREATE INDEX builds the secondary structure without
-- rewriting the table, so it is safe over a live DB with existing rows. Must
-- apply AFTER 0029 (the indexed columns must exist). No row, no ordering and
-- no consumer changes: every reader's ORDER BY stays explicit.

CREATE INDEX support_grants_operator_window
  ON support_grants (operator_login, expires_at, workspace_id);

CREATE INDEX support_grants_expires_at ON support_grants (expires_at);
