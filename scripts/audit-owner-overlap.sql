-- audit-owner-overlap.sql — READ-ONLY: workspaces where one GitHub account
-- owns more than one live review target.
--
-- Run it against the deploy target's database, e.g.
--   bunx wrangler d1 execute mstar-inspector-db --remote --json \
--     --file scripts/audit-owner-overlap.sql
--
-- One row per (workspace_id, account_login): `target_ids` and `bot_ids` name
-- every live target claiming that account, comma-separated in target-id order.
-- An empty result is the healthy state. A non-empty one is an operator
-- decision, never an automatic repair: one person may legitimately review under
-- two targets, and the corrective write is clearing `account_login` on the
-- target that should not claim it.
SELECT
  workspace_id,
  account_login,
  group_concat(id, ',' ORDER BY id) AS target_ids,
  group_concat(bot_id, ',' ORDER BY id) AS bot_ids
FROM review_targets
WHERE deleted_at IS NULL AND account_login IS NOT NULL
GROUP BY workspace_id, account_login
HAVING COUNT(*) > 1
ORDER BY workspace_id, account_login;
