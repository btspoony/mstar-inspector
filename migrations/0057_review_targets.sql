-- 0057_review_targets.sql — review configuration leaves the bot for a target.
--
-- A bot is an execution identity: one GitHub App, its credentials, model chain,
-- sandbox image and installations. The workspace-owned review configuration —
-- trigger mode, review depth, Check gate, owner allowlist and the business
-- pause — moves onto `review_targets`, one target per existing bot, so the
-- user-visible product does not change: the same settings values, the same
-- review outcome for every migrated bot, and the same webhook URL (still keyed
-- by the bot id).
--
-- One file, one transaction, no dual-write window: the five moved columns are
-- gone from `review_bots` by the end of this file, so no reader can keep
-- reading them and no writer can keep writing them. Readers switch in the same
-- deploy.
--
-- `review_bots.review_enabled` stays as the OPERATIONAL pause and is reset to 1
-- here. The target holds the value users change, so the effective pause (either
-- flag 0) is the old flag, and a settings resume is not blocked by a stale copy
-- of it.
--
-- The old owner allowlist is not renamed: its rows move onto the target and the
-- table goes. Queued comment-trigger claims carry the job JSON the sweep resends
-- verbatim, so they are rewritten to the new payload shape here; messages
-- already on the queue are not in this database and the consumer fails those
-- closed.
--
-- The five columns are dropped in place rather than by rebuilding the parent
-- table (the 0038 recipe). A rebuild cannot run here: D1 executes a migration
-- file inside one transaction, where `PRAGMA foreign_keys = OFF` is inert, so
-- `DROP TABLE review_bots` fires `pull_requests`' ON DELETE CASCADE (emptying
-- the PR ledger) and leaves the non-cascading children's references as
-- violations that `PRAGMA defer_foreign_keys` cannot clear — the COMMIT fails
-- even after the parent is recreated. 0038's rebuild predates the ledger
-- (0039). Each of the five columns carries only its own inline CHECK, which
-- SQLite drops with the column, and nothing else in the schema names them.
-- Forward-only.
--
-- Must apply AFTER 0056: it reads the bot vocabulary.

CREATE TABLE review_targets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  bot_id TEXT NOT NULL REFERENCES review_bots(id),
  name TEXT NOT NULL,
  installation_id INTEGER,
  account_login TEXT,
  review_enabled INTEGER NOT NULL DEFAULT 1,
  review_trigger_mode TEXT NOT NULL DEFAULT 'every_push'
    CHECK (review_trigger_mode IN ('open','every_push','manual')),
  review_level TEXT CHECK (review_level IN ('quick','default','deep')),
  check_min_score INTEGER NOT NULL DEFAULT 80
    CHECK (check_min_score BETWEEN 0 AND 100 AND check_min_score = CAST(check_min_score AS INTEGER)),
  check_pass_verdicts TEXT NOT NULL DEFAULT '["ship it"]'
    CHECK (json_valid(check_pass_verdicts)),
  allowlist_enabled INTEGER NOT NULL DEFAULT 0 CHECK (allowlist_enabled IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- The bot's targets are looked up by bot id on every dashboard read
-- (`resolveInWorkspace`), every webhook resolution fallback (`resolve`) and
-- both attribution backfills below. The partial unique index cannot serve a
-- `WHERE bot_id = ?` scan (it is only usable when `installation_id` is known),
-- so this is its own index.
CREATE INDEX idx_review_targets_bot_id ON review_targets(bot_id);

-- One installation binds to one target: a second claim of the same
-- (bot, installation) would make webhook resolution ambiguous. An unbound
-- target (NULL) is outside the index on purpose — the create path writes it.
CREATE UNIQUE INDEX review_targets_bot_installation
  ON review_targets(bot_id, installation_id)
  WHERE installation_id IS NOT NULL;

CREATE TABLE target_owner_allowlist (
  target_id TEXT NOT NULL REFERENCES review_targets(id),
  owner_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_id, owner_login)
);

-- Reviews keep their bot attribution (publication still needs the credential)
-- and gain the target. A legacy row with no bot keeps no target.
ALTER TABLE reviews ADD COLUMN target_id TEXT REFERENCES review_targets(id);
CREATE INDEX idx_reviews_target_id ON reviews(target_id);

-- The ledger is tenant-owned now: nullable on the add (a NOT NULL add would
-- need a dummy default), bound by the backfill and keyed by the target.
ALTER TABLE pull_requests ADD COLUMN target_id TEXT REFERENCES review_targets(id);

-- One target per bot, soft-deleted bots included. The workspace row is
-- required: a bot without one fails the guard below rather than vanishing from
-- the join.
INSERT INTO review_targets (
  id, workspace_id, bot_id, name, installation_id, account_login,
  review_enabled, review_trigger_mode, review_level,
  check_min_score, check_pass_verdicts, allowlist_enabled,
  created_by, created_at, updated_at, deleted_at
)
SELECT
  lower(hex(randomblob(16))),
  w.workspace_id,
  b.id,
  b.name,
  NULL,
  NULL,
  b.review_enabled,
  b.review_trigger_mode,
  b.review_level,
  b.check_min_score,
  b.check_pass_verdicts,
  b.allowlist_enabled,
  b.created_by,
  b.created_at,
  b.updated_at,
  b.deleted_at
FROM review_bots b
INNER JOIN bot_workspaces w ON w.bot_id = b.id;

-- Bind the installation only when the bot has exactly one live row. Zero or
-- many live rows leave the target unbound (resolution falls back to the single
-- non-deleted target); a removed row is not a binding.
UPDATE review_targets
SET
  installation_id = (
    SELECT installation_id FROM bot_installations
    WHERE bot_id = review_targets.bot_id AND removed_at IS NULL
  ),
  account_login = (
    SELECT account_login FROM bot_installations
    WHERE bot_id = review_targets.bot_id AND removed_at IS NULL
  )
WHERE (
  SELECT COUNT(*) FROM bot_installations
  WHERE bot_id = review_targets.bot_id AND removed_at IS NULL
) = 1;

-- The owner allowlist moves onto the target, then the old table goes.
INSERT INTO target_owner_allowlist (target_id, owner_login, created_at)
SELECT t.id, a.owner_login, a.created_at
FROM app_owner_allowlist a
JOIN review_targets t ON t.bot_id = a.app_id;

DROP TABLE app_owner_allowlist;

-- Attribution: every review whose bot is known, and every ledger row, resolves
-- its bot's single target.
UPDATE reviews
SET target_id = (
  SELECT id FROM review_targets WHERE bot_id = reviews.bot_id
)
WHERE bot_id IS NOT NULL;

UPDATE pull_requests
SET target_id = (
  SELECT id FROM review_targets WHERE bot_id = pull_requests.bot_id
)
WHERE bot_id IS NOT NULL;

-- The business pause moved; the operational one starts clear.
UPDATE review_bots SET review_enabled = 1;

-- The sweep resends the stored job JSON, which must name a bot ref and a
-- target. Tombstones (payload_json NULL) keep holding nothing.
UPDATE comment_trigger_claims
SET payload_json = json_set(
  json_remove(
    json_set(payload_json, '$.botRef', json_extract(payload_json, '$.appRef')),
    '$.appRef'
  ),
  '$.targetId',
  (
    SELECT id FROM review_targets
    WHERE bot_id = json_extract(payload_json, '$.appRef.appId')
  )
)
WHERE state = 'queued' AND payload_json IS NOT NULL;

-- Guards: each count must be zero, and the table's own CHECK is what makes a
-- non-zero count fail the migration instead of leaving a row behind. A skip
-- (rather than a failure) here would silently drop a bot's target or leave a
-- row unreadable by the tenant faces.
CREATE TABLE guard_bot_without_workspace (
  n INTEGER NOT NULL CONSTRAINT guard_bot_without_workspace CHECK (n = 0)
);
INSERT INTO guard_bot_without_workspace (n)
SELECT COUNT(*) FROM review_bots b
WHERE NOT EXISTS (SELECT 1 FROM bot_workspaces w WHERE w.bot_id = b.id);
DROP TABLE guard_bot_without_workspace;

CREATE TABLE guard_bot_target_count (
  n INTEGER NOT NULL CONSTRAINT guard_bot_target_count CHECK (n = 0)
);
INSERT INTO guard_bot_target_count (n)
SELECT COUNT(*) FROM review_bots b
WHERE (SELECT COUNT(*) FROM review_targets t WHERE t.bot_id = b.id) <> 1;
DROP TABLE guard_bot_target_count;

CREATE TABLE guard_review_without_target (
  n INTEGER NOT NULL CONSTRAINT guard_review_without_target CHECK (n = 0)
);
INSERT INTO guard_review_without_target (n)
SELECT COUNT(*) FROM reviews WHERE bot_id IS NOT NULL AND target_id IS NULL;
DROP TABLE guard_review_without_target;

CREATE TABLE guard_ledger_without_target (
  n INTEGER NOT NULL CONSTRAINT guard_ledger_without_target CHECK (n = 0)
);
INSERT INTO guard_ledger_without_target (n)
SELECT COUNT(*) FROM pull_requests WHERE target_id IS NULL;
DROP TABLE guard_ledger_without_target;

CREATE TABLE guard_queued_claim_without_target (
  n INTEGER NOT NULL CONSTRAINT guard_queued_claim_without_target CHECK (n = 0)
);
INSERT INTO guard_queued_claim_without_target (n)
SELECT COUNT(*) FROM comment_trigger_claims
WHERE state = 'queued' AND payload_json IS NOT NULL
  AND (
    json_extract(payload_json, '$.targetId') IS NULL
    OR json_extract(payload_json, '$.appRef') IS NOT NULL
  );
DROP TABLE guard_queued_claim_without_target;

-- The PR ledger's identity is the target's PR, not the bot's: the same (owner,
-- repo, pr_number) under one bot is now one target's row.
DROP INDEX idx_pull_requests_bot_pr;
CREATE UNIQUE INDEX idx_pull_requests_target_pr
  ON pull_requests(target_id, owner, repo, pr_number);

-- The moved columns leave the bot row. Each carries its own inline CHECK, so
-- nothing has to be rebuilt (see the header), and every remaining column keeps
-- its exact 0004/0008/0018/0019/0022/0036/0037/0045 shape — including the
-- `status` CHECK and the `github_app_id` UNIQUE.
ALTER TABLE review_bots DROP COLUMN review_trigger_mode;
ALTER TABLE review_bots DROP COLUMN review_level;
ALTER TABLE review_bots DROP COLUMN check_min_score;
ALTER TABLE review_bots DROP COLUMN check_pass_verdicts;
ALTER TABLE review_bots DROP COLUMN allowlist_enabled;
