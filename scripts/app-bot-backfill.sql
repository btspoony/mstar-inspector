-- app-bot-backfill.sql — the replayable half of the entity split.
--
-- The replay contract (PM resolution): a schema migration containing
-- `ALTER TABLE ... RENAME` is apply-once in SQLite — no rename migration can
-- re-run, and 0031 is precedent — so the ADR's "backfill file rerun after the
-- drop" means THIS standalone executable file, not a second application of
-- `migrations/0115_app_bot_split.sql`. 0115 carries the same statements inline
-- because D1 has no include; this file is the artifact a rehearsal or repair
-- re-runs.
--
-- SYNC CONTRACT: these three statements are verbatim copies of 0115's inline
-- data DML — the bot backfill, the `reviews.bot_id` fill and the queued
-- payload rewrite. A change to one copy is a change to ALL THREE:
-- `migrations/0115_app_bot_split.sql` (inline, apply-once), this file (the
-- replayable artifact) and `scripts/workspace-backfill.sql` (the deploy replay
-- step, which carries the first two).
--
-- Every statement is idempotent by construction (each guarded against its own
-- target or a fixed-point write) and none reads nor writes
-- `github_apps.sandbox_image_id` — the bot's `sandbox_image_id` stays at the
-- table default here — so the file re-runs clean after
-- `migrations/0116_github_apps_sandbox_image_drop.sql` has applied. Run it
-- with `wrangler d1 execute --file`, after `d1 migrations apply`, any number
-- of times.

-- One bot per App, keyed by the same id. `multiplier` follows the split rule:
-- an owned bot pays its owner's own keys at 1; a shared bot keeps the shared
-- multiplier of the profile in force at run time (the latest `effective_from`
-- at or before now, else the earliest — the `resolveQuotaProfile` rule), so no
-- stored price changes.
INSERT INTO review_bots (
  id, workspace_id, name, description, scope, shared_at,
  sandbox_image_id, multiplier, monthly_rp, deleted_at, created_at, updated_at
)
SELECT
  g.id,
  w.workspace_id,
  g.name,
  NULL,
  g.scope,
  g.shared_at,
  'omp',
  CASE WHEN g.scope = 'shared' THEN
    COALESCE(
      (SELECT source_shared FROM quota_profiles
        WHERE effective_from <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
        ORDER BY effective_from DESC LIMIT 1),
      (SELECT source_shared FROM quota_profiles ORDER BY effective_from ASC LIMIT 1)
    )
  ELSE 1 END,
  NULL,
  g.deleted_at,
  g.created_at,
  g.updated_at
FROM github_apps g
INNER JOIN app_workspaces w ON w.app_id = g.id
WHERE NOT EXISTS (SELECT 1 FROM review_bots b WHERE b.id = g.id);

-- The executing bot equals the acting App for every row the split backfilled:
-- in this release one App executes through exactly one bot, its own.
UPDATE reviews SET bot_id = app_id WHERE app_id IS NOT NULL AND bot_id IS NULL;

-- Queued comment-trigger payloads predate `botRef.botId`; the sweep resends
-- the stored JSON verbatim, so queued rows are rewritten here. The bot is the
-- one the split created for that App — the same id — and the rewrite is a
-- fixed-point write: a payload that already carries the value gets the same
-- value back. Tombstones (payload_json NULL) keep holding nothing.
UPDATE comment_trigger_claims
SET payload_json = json_set(
  payload_json,
  '$.botRef.botId',
  json_extract(payload_json, '$.botRef.appId')
)
WHERE state = 'queued'
  AND payload_json IS NOT NULL
  AND json_extract(payload_json, '$.botRef.appId') IS NOT NULL;
