-- 0122_bot_quota_overrides.sql — a bot's ceiling can be per workspace.
--
-- A shared bot's month is capped twice: the consuming workspace's plan allowance
-- (shared RP only) and the bot's own ceiling. `review_bots.monthly_rp` is the
-- bot's DEFAULT ceiling, set by its owner (0115). This table is the owner's
-- per-workspace exception: one row per (bot, workspace), overriding the default
-- for that workspace alone.
--
-- Resolution order is a value, not a query shape: an override row's `monthly_rp`
-- wins, else `review_bots.monthly_rp`, else unlimited. `monthly_rp > 0` because a
-- ceiling of 0 is "this workspace may never use this bot" — a state the product
-- cannot express, and D32 settles it: there is no "0 = disable" meaning.
--
-- Both ceilings are NULL until the attribution report is checked (Task 4's
-- `usage-bot-attribution`): a per-bot cap enforced against half-attributed
-- history would cap the wrong bot. This file therefore seeds no row and sets no
-- default ceiling.
--
-- Must apply AFTER 0121.

CREATE TABLE bot_quota_overrides (
  bot_id       TEXT    NOT NULL REFERENCES review_bots(id),
  workspace_id TEXT    NOT NULL REFERENCES workspaces(id),
  monthly_rp   INTEGER NOT NULL CHECK (monthly_rp > 0),
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (bot_id, workspace_id)
);
