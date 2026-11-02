-- 0039_pull_requests.sql — per-App pull-request ledger.
--
-- One row per pull request this App has RECEIVED (a verified `pull_request`
-- delivery), so the dashboard can answer "which PRs did this App see, and what
-- happened to each review run?" without replaying webhook_deliveries or
-- reviews. The row is written on arrival — before the classifier's outcome is
-- acted on — so a delivery that only produced an `ignore` (a non-whitelisted
-- action, a mode that does not auto-trigger, a paused App) still leaves the PR
-- visible; the review outcome itself is read from `reviews` /
-- `review_failures` at read time, never copied here.
--
-- `state` is the payload's `pull_request.state` ('open' | 'closed'), promoted
-- to 'merged' when the payload carried `merged: true`. The domain is
-- producer-enforced (the 0011 outcome / 0010 stage precedent) — GitHub's own
-- state vocabulary can grow, and a CHECK would turn a new upstream value into
-- a failed insert on the webhook path.
--
-- UNIQUE (app_id, owner, repo, pr_number) is the idempotency key: the webhook
-- face upserts on exactly this tuple, so a PR that receives several deliveries
-- (opened, synchronize, closed, …) keeps ONE row whose last_seen_at advances.
-- `title` / `head_sha` are nullable because a payload may omit them; an upsert
-- keeps the previously known value rather than clearing it.
--
-- Append-only on the production DB: creates a new table + index only, touches
-- no existing table. Forward-only (SQLite has no down). ON DELETE CASCADE is
-- the one deliberate departure from the 0004/0011 no-ON-DELETE convention:
-- removal of an App is a soft delete, so the clause never fires in normal
-- operation, and if an operator ever hard-deletes a row this ledger is derived
-- data that must not block it.

CREATE TABLE pull_requests (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES github_apps(id) ON DELETE CASCADE,
  owner         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  pr_number     INTEGER NOT NULL,
  title         TEXT,
  state         TEXT NOT NULL,
  head_sha      TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_pull_requests_app_pr ON pull_requests (app_id, owner, repo, pr_number);
