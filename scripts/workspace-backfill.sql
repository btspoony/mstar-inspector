-- workspace-backfill.sql — idempotent App attribution repair for the deploy
-- replay step.
--
-- Both deploy workflows replay ONE repair file after `d1 migrations apply`, so
-- a partially applied deploy heals without a manual run. 0115 split the entity:
-- the ownership row moved to `app_workspaces(app_id)`, and every App owns one
-- `review_bots` row under the same id. The repair therefore writes both halves
-- of the attribution, each guarded by `WHERE NOT EXISTS` against its own
-- target, so a re-apply inserts nothing that already exists. It reads no column
-- the drop file removes: the bot's `sandbox_image_id` stays at its default here
-- (0116 copies the App's value in the same release), so this file re-runs clean
-- after `github_apps.sandbox_image_id` is gone.
--
-- Must stay idempotent: every deploy runs it. Soft-deleted Apps (deleted_at
-- NOT NULL) are included — the mapping is ownership, not liveness, so a
-- restored App must not fall outside the workspace.
--
-- It reads no column 0120 drops: since quota-relay-repair Task 3 the multiplier
-- is the bot's own price factor and the profile's `source_byok` /
-- `source_shared` are gone, so a bot created here starts at 1× and is priced
-- exactly at its base weight until an operator sets something else.
--
-- It writes no per-person row: replaying a `workspace_members` write is what
-- made every routine deploy re-add removed members to 'default'.

INSERT INTO app_workspaces (app_id, workspace_id)
SELECT g.id, 'default'
FROM github_apps g
WHERE NOT EXISTS (SELECT 1 FROM app_workspaces w WHERE w.app_id = g.id);

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
  -- The multiplier is the bot's own price factor from quota-relay-repair Task 3
  -- (D11/D37). This file must not read `quota_profiles.source_*`: that column is
  -- dropped in the same release, and a replay after the drop would fail.
  -- A bot this backfill creates is one the split never made, so it has no prior
  -- price to preserve; 1 keeps it priced exactly at its base weight.
  1,
  NULL,
  g.deleted_at,
  g.created_at,
  g.updated_at
FROM github_apps g
INNER JOIN app_workspaces w ON w.app_id = g.id
WHERE NOT EXISTS (SELECT 1 FROM review_bots b WHERE b.id = g.id);
