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
-- restored App must not fall outside the workspace — and the multiplier follows
-- the split rule: an owned bot pays its owner's keys at 1, a shared bot keeps
-- the shared multiplier of the profile in force.
--
-- It writes no per-person row: replaying a `workspace_members` write is what
-- made every routine deploy re-add removed members to 'default'.

INSERT INTO app_workspaces (app_id, workspace_id)
SELECT g.id, 'default'
FROM github_apps g
WHERE NOT EXISTS (SELECT 1 FROM app_workspaces w WHERE w.app_id = g.id);
