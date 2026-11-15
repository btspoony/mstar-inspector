-- 0059_install_claims.sql — a signed-in user's short-lived intent to bind one
-- installation to one review target.
--
-- GitHub's setup redirect carries no `state`, so the installation id arriving
-- at the callback names no target. The intent is recorded here instead: a
-- workspace manager presses install on a target's page, the row remembers which
-- target, and `/bot/setup` binds the installation to whichever live claim the
-- signed-in user actually holds.
--
-- No `bot_id`: the target carries it, and a claim names a target, not a bot.
-- `workspace_id` is the target's workspace at claim time, so a later per-tenant
-- claim list reads it without a join.
--
-- Both instants are ISO text and expiry is a text comparison, so no
-- `strftime` form can mix in. There is no sweeper: reads filter the live
-- predicate (`consumed_at IS NULL AND expires_at > :now`), so a lapsed row is
-- inert and still the upsert's conflict target.
--
-- `install_claims_live_target` is PARTIAL on purpose: it makes one live claim
-- per (user, target) — a second press refreshes that row instead of stacking —
-- while consumed history may stack freely. `install_claims_user_open` is the
-- setup callback's scan for one user's live claims.
--
-- Only the claim batch writes `review_targets.installation_id`; no webhook does.
--
-- Forward-only. Must apply AFTER 0058: the bind reads `review_bots.scope`.

CREATE TABLE install_claims (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  target_id    TEXT NOT NULL REFERENCES review_targets(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT
);
CREATE INDEX install_claims_user_open ON install_claims(user_id, consumed_at);
CREATE UNIQUE INDEX install_claims_live_target
  ON install_claims(user_id, target_id) WHERE consumed_at IS NULL;
