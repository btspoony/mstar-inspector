-- 0038_webhook_path_drop.sql — the webhook URL is keyed by workspace + app id.
--
-- The manifest now registers `{origin}/webhook/{workspaces.id}/{github_apps.id}`,
-- so the row's primary key IS the URL's app segment and `webhook_path`
-- duplicated it with no independent meaning. Both segments exist before GitHub
-- creates the App, so the hook URL still needs no GitHub fact; the old
-- single-segment `/webhook/<uuid>` route is retired with no compatibility path
-- (docs/deploy.md carries the operator step).
--
-- `ALTER TABLE ... DROP COLUMN` cannot do this: 0036's RENAME carried the
-- original `UNIQUE` constraint onto `webhook_path`, and SQLite refuses to drop
-- a UNIQUE column (`cannot drop UNIQUE column: "webhook_path"`). So the column
-- goes with the standard parent-table rebuild — the 0032 recipe.
--
--   1. `app_workspaces` / `app_installations` / `webhook_deliveries` / the
--      provider tables reference `github_apps(id)` immediately, so a DROP TABLE
--      on the parent runs an implicit DELETE and fails while child rows exist.
--      `PRAGMA defer_foreign_keys` carries that gap to the end of the
--      migration's transaction (D1 runs every migration file inside one
--      implicit transaction).
--   2. The rows are copied back into a table created under the FINAL name, not
--      into a temp table that is then renamed (0032, verified against local D1:
--      the rename form leaves the deferred violation in place).
--   3. `PRAGMA foreign_keys = OFF` is the plain-SQLite half of the same swap —
--      the only form that also works in autocommit (the test double's
--      `db.exec`). D1 ignores it and relies on the deferred pragma above.
--
-- Every column except `webhook_path` keeps its exact 0004/0008/0018/0019/0022/
-- 0036/0037 shape (type, NOT NULL, DEFAULT, CHECK), and every row survives with
-- its values — no live App is dropped. `webhook_path` itself is not migrated
-- into anything: this flow always wrote the same UUID into `id` and the column,
-- and for any other row the value is dead history.
--
-- Must apply AFTER 0037 (the last column the rebuilt table must carry).

PRAGMA foreign_keys = OFF;
PRAGMA defer_foreign_keys = true;

CREATE TABLE github_apps_staging (
  id                           TEXT PRIMARY KEY,
  github_app_id                INTEGER UNIQUE NOT NULL,
  name                         TEXT NOT NULL,
  private_key_enc              TEXT NOT NULL,
  webhook_secret_enc           TEXT NOT NULL,
  created_by                   TEXT NOT NULL,
  status                       TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  deleted_at                   TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  review_enabled               INTEGER NOT NULL DEFAULT 1,
  last_webhook_at              TEXT,
  sandbox_image_id             TEXT NOT NULL DEFAULT 'omp',
  github_name                  TEXT,
  github_description           TEXT,
  github_html_url              TEXT,
  github_avatar_url            TEXT,
  github_metadata_synced_at    TEXT,
  review_trigger_mode          TEXT NOT NULL DEFAULT 'every_push'
                                 CHECK (review_trigger_mode IN ('open','every_push','manual')),
  github_slug                  TEXT,
  github_metadata_attempted_at TEXT
);

INSERT INTO github_apps_staging (
  id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, status,
  deleted_at, created_at, updated_at, review_enabled, last_webhook_at, sandbox_image_id,
  github_name, github_description, github_html_url, github_avatar_url,
  github_metadata_synced_at, review_trigger_mode, github_slug, github_metadata_attempted_at
)
SELECT
  id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, status,
  deleted_at, created_at, updated_at, review_enabled, last_webhook_at, sandbox_image_id,
  github_name, github_description, github_html_url, github_avatar_url,
  github_metadata_synced_at, review_trigger_mode, github_slug, github_metadata_attempted_at
FROM github_apps;

DROP TABLE github_apps;

CREATE TABLE github_apps (
  id                           TEXT PRIMARY KEY,
  github_app_id                INTEGER UNIQUE NOT NULL,
  name                         TEXT NOT NULL,
  private_key_enc              TEXT NOT NULL,
  webhook_secret_enc           TEXT NOT NULL,
  created_by                   TEXT NOT NULL,
  status                       TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  deleted_at                   TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  review_enabled               INTEGER NOT NULL DEFAULT 1,
  last_webhook_at              TEXT,
  sandbox_image_id             TEXT NOT NULL DEFAULT 'omp',
  github_name                  TEXT,
  github_description           TEXT,
  github_html_url              TEXT,
  github_avatar_url            TEXT,
  github_metadata_synced_at    TEXT,
  review_trigger_mode          TEXT NOT NULL DEFAULT 'every_push'
                                 CHECK (review_trigger_mode IN ('open','every_push','manual')),
  github_slug                  TEXT,
  github_metadata_attempted_at TEXT
);

INSERT INTO github_apps (
  id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, status,
  deleted_at, created_at, updated_at, review_enabled, last_webhook_at, sandbox_image_id,
  github_name, github_description, github_html_url, github_avatar_url,
  github_metadata_synced_at, review_trigger_mode, github_slug, github_metadata_attempted_at
)
SELECT
  id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, status,
  deleted_at, created_at, updated_at, review_enabled, last_webhook_at, sandbox_image_id,
  github_name, github_description, github_html_url, github_avatar_url,
  github_metadata_synced_at, review_trigger_mode, github_slug, github_metadata_attempted_at
FROM github_apps_staging;

DROP TABLE github_apps_staging;

PRAGMA foreign_keys = ON;
