-- 0045_review_gate_and_owner_allowlist.sql — per-App review gate, owner
-- allowlist and GitHub App visibility.
--
-- The Check run stops being an execution-completion signal and reports the
-- App's configured REVIEW GATE: a published review concludes `success` only
-- when its verdict is one of `check_pass_verdicts` AND its tally score is at
-- least `check_min_score`. Both values are App configuration, so a change
-- takes effect on the next Check without a deploy.
--
--   check_min_score      INTEGER NOT NULL DEFAULT 80 — the score floor.
--   check_pass_verdicts  TEXT NOT NULL DEFAULT '["ship it"]' — a JSON array of
--                        the engine `PR_VERDICTS` spellings; the store rejects
--                        an off-vocabulary value before the write and this
--                        column has no CHECK because JSON contents cannot be
--                        enumerated in DDL. Reading the column back yields the
--                        same array the writer validated.
--   allowlist_enabled    INTEGER NOT NULL DEFAULT 0 — the owner allowlist
--                        switch. Off (the default) behaves exactly like before
--                        this migration; on with an EMPTY list refuses every
--                        owner (fail closed).
--   github_visibility    TEXT CHECK(... IN ('public','private','unknown')) —
--                        the anonymous `GET /apps/{slug}` probe cached during
--                        the existing metadata refresh. NULL = never probed,
--                        which the store reads as 'unknown' (cannot prove
--                        private, so the allowlist surface stays visible). A
--                        private App never applies its allowlist rows.
--
-- `app_owner_allowlist` holds the owner logins a public App will accept review
-- work from — one row per (app, login). `created_at` is the datetime('now')
-- TEXT convention shared with the rest of this table family. The row set is
-- replaced atomically by the store (delete-then-insert in one batch), never
-- merged, so removing an owner is the same operation as adding one. The
-- primary key is the app prefix, which also serves the per-App read; there is
-- no separate index.
--
-- Append-only on the production DB: four `ALTER TABLE ... ADD COLUMN`s whose
-- NOT NULL columns carry a DEFAULT (every existing row materializes the
-- defaults with no backfill) plus one new table. Forward-only (SQLite has no
-- down).

ALTER TABLE github_apps ADD COLUMN check_min_score INTEGER NOT NULL DEFAULT 80 CHECK(check_min_score BETWEEN 0 AND 100);
ALTER TABLE github_apps ADD COLUMN check_pass_verdicts TEXT NOT NULL DEFAULT '["ship it"]';
ALTER TABLE github_apps ADD COLUMN allowlist_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE github_apps ADD COLUMN github_visibility TEXT CHECK(github_visibility IN ('public','private','unknown'));

CREATE TABLE app_owner_allowlist (
  app_id      TEXT NOT NULL REFERENCES github_apps(id),
  owner_login TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (app_id, owner_login)
);
