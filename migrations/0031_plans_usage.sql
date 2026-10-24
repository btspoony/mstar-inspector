-- 0031_plans_usage.sql — plan catalogue, workspace entitlements, review usage.
--
-- plans is the catalogue: one row per purchasable plan, read-only at runtime.
-- Every limit column describes a plan-level capability, and NULL is the
-- contract, not a missing value: a NULL limit means "unlimited" when the
-- column is a quota (platform_key_limit, reviews_included,
-- apps_per_workspace) and "not configured" when the column is a price
-- (monthly_price_cents, extra_member_price_cents). Never encode either state
-- as a sentinel number (0 or -1) — a consumer that forgets the sentinel would
-- read it as a real price or quota.
--
-- workspace_subscriptions is the tenant side: at most one row per workspace
-- (workspace_id is the PK), pointing at a plans row. There is deliberately NO
-- backfill: a missing row resolves to `free`, so every workspace that predates
-- this migration keeps working without an UPDATE path, and only new workspace
-- creation writes the `free` row. status is the subscription lifecycle
-- ('active' today); it is not a CHECK domain yet because the only writer is
-- workspace creation.
--
-- usage_events is the review usage ledger and (review_id, seq) is its key.
-- seq is minted per STARTED execution of a review: a genuine re-execution
-- after a runner failure therefore adds a second row for the same review_id
-- and is counted again, deliberately. A duplicate delivery of a completed
-- review writes nothing — the dedup reads run before this insert. Each
-- review_id may legitimately hold several rows. review_id is a STRING and
-- deliberately not an FK: an attempt can outlive a review row that rolled
-- back. workspace_id is the FK that keeps a usage row attributable to a real
-- tenant.
--
-- Append-only on the production DB: creates new tables only, touches no
-- existing table. There is deliberately no ON DELETE clause (0004/0026
-- precedent): removal is soft delete, and the default NO ACTION makes a hard
-- DELETE of a referenced workspace or plan impossible at the schema level.
-- Must apply AFTER 0026 (workspaces — the FK parents for both tenant tables);
-- plans must exist before workspace_subscriptions references it, so that table
-- is created and seeded first in this file.
--
-- The seed uses a fixed ISO timestamp rather than a database clock so the
-- applied rows are byte-identical across local and remote applies. No plan
-- carries a price yet: both price columns are NULL ("not configured") until
-- pricing exists, so no surface can read a made-up amount.

CREATE TABLE plans (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  monthly_price_cents      INTEGER,
  included_members         INTEGER NOT NULL,
  extra_member_price_cents INTEGER,
  platform_key_limit       INTEGER,
  reviews_included         INTEGER,
  apps_per_workspace       INTEGER,
  created_at               TEXT NOT NULL
);

CREATE TABLE workspace_subscriptions (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE usage_events (
  review_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  occurred_at  TEXT NOT NULL,
  PRIMARY KEY (review_id, seq)
);

INSERT INTO plans (
  id, name, monthly_price_cents, included_members, extra_member_price_cents,
  platform_key_limit, reviews_included, apps_per_workspace, created_at
)
VALUES
  ('free', 'Free', NULL, 5, NULL, NULL, NULL, NULL, '2026-10-24T00:00:00.000Z'),
  ('pro',  'Pro',  NULL, 5, NULL, NULL, NULL, NULL, '2026-10-24T00:00:00.000Z');
