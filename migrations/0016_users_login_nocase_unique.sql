-- 0016_users_login_nocase_unique.sql — case-insensitive unique membership (plan 34 QC W-1).
--
-- Append-only DDL on the existing production DB (0003+ convention): the
-- 0003 `github_login TEXT UNIQUE` index is BINARY-collated, so two
-- concurrent case-variant invites ("OctoCat" / "octocat") could both pass
-- the NOCASE pre-read and mint two rows for one GitHub identity. This
-- NOCASE UNIQUE index makes case-insensitive uniqueness a DDL-level
-- invariant: the second case-variant INSERT conflicts (ON CONFLICT
-- (github_login) absorbs it — changes === 0), and the store distinguishes
-- the case-variant row from an exact-case race and surfaces
-- DuplicateLoginError, which the invite route maps to 409 duplicate-invite
-- semantics (W-1).
--
-- Fails loudly (CREATE UNIQUE INDEX errors) if the production DB already
-- holds case-variant duplicates — the correct behavior: surface the
-- pre-existing corruption instead of silently continuing.

CREATE UNIQUE INDEX users_login_nocase_idx ON users(github_login COLLATE NOCASE);
