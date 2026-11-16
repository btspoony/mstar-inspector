-- 0063_quota_profiles.sql — quota becomes a versioned, time-ranged configuration.
--
-- Quota used to be three NULL columns on `plans` (platform_key_limit,
-- reviews_included, apps_per_workspace) that no code read: free and pro were
-- in fact identical, and changing a number meant a hand-written UPDATE with no
-- history and no rollback point. This file replaces the two consumption
-- columns with a profile table plus its per-plan ceilings.
--
-- quota_profiles is append-only. One row is one version; `effective_from` is
-- the ONLY stored interval endpoint — a profile's interval ends at the next
-- profile's `effective_from`, so publishing a version closes nothing and no
-- second column can disagree with the first. That makes overlap
-- unrepresentable rather than merely refused: `UNIQUE (effective_from)` is a
-- plain index that every writer, including a future operator route, trips over
-- with no scan and no trigger (no migration 0001-0062 creates one).
--
-- `version` stays stored and UNIQUE for the same reason the create form shows
-- a derived, read-only ordinal (`admin.quotaVersions.fieldVersion`): two
-- concurrent creates must not mint the same one, and the insert derives
-- MAX(version) + 1 while the unique index refuses the loser.
--
-- The base weight columns are the strength vocabulary `quick | standard |
-- deep`, i.e. the tenant-facing names; the level enum keeps its `default`
-- member and `base_standard` is that member's weight (the form labels it
-- "Standard weight (RP)"). `rp_per_credit` is per profile, not a constant, so
-- a later version can re-denominate credits with no code change.
--
-- quota_profile_plans carries this version's ceiling per plan. `monthly_rp`
-- NULL means unlimited AND the row is always present: an absent row would make
-- "this version says nothing about this plan" indistinguishable from "no
-- ceiling", and a plan added later would silently become unlimited. The read
-- (`resolveMonthlyQuota`) therefore throws on an absent row — the profile's
-- plan set is closed and complete, and a new plan needs a new version.
--
-- apps_per_workspace stays on `plans`: it is a static capability, not
-- consumption, and nothing about it changes mid-month. It gains its first
-- reader in a later migration, which is why only platform_key_limit and
-- reviews_included are dropped here. Both drops are plain: neither column has
-- an index, a CHECK or a constraint naming it, and no reader exists in src/,
-- packages/ or tests/ (only two row-shape fixtures, updated with this file).
--
-- The seed is v1 at the plan catalogue's own seed instant (0031) so the
-- applied rows are byte-identical across local and remote applies:
-- free 2000 RP/month (100 credits), pro 20000 RP/month (1000 credits),
-- unlimited NULL. base 1/2/6, source 1/10, 1 credit = 20 RP.
--
-- Must apply AFTER 0032 (the seeded `unlimited` row) and 0061 (the last
-- `plans` alteration). Append-only otherwise: two new tables plus seed rows;
-- the only destructive statements drop two unread columns.

CREATE TABLE quota_profiles (
  id             TEXT PRIMARY KEY,
  version        INTEGER NOT NULL UNIQUE,
  effective_from TEXT    NOT NULL UNIQUE,
  base_quick     INTEGER NOT NULL CHECK (base_quick    > 0),
  base_standard  INTEGER NOT NULL CHECK (base_standard > 0),
  base_deep      INTEGER NOT NULL CHECK (base_deep     > 0),
  source_byok    INTEGER NOT NULL CHECK (source_byok   > 0),
  source_shared  INTEGER NOT NULL CHECK (source_shared > 0),
  rp_per_credit  INTEGER NOT NULL CHECK (rp_per_credit > 0),
  notes          TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL
);

CREATE TABLE quota_profile_plans (
  profile_id TEXT    NOT NULL REFERENCES quota_profiles(id),
  plan_id    TEXT    NOT NULL REFERENCES plans(id),
  monthly_rp INTEGER CHECK (monthly_rp IS NULL OR monthly_rp > 0),
  PRIMARY KEY (profile_id, plan_id)
);

INSERT INTO quota_profiles (
  id, version, effective_from, base_quick, base_standard, base_deep,
  source_byok, source_shared, rp_per_credit, notes, created_at, created_by
)
VALUES (
  'quota-v1', 1, '2026-10-24T00:00:00.000Z', 1, 2, 6, 1, 10, 20,
  'v1 baseline: free 2000 RP, pro 20000 RP, unlimited uncapped.',
  '2026-10-24T00:00:00.000Z', 'migration'
);

INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp)
VALUES
  ('quota-v1', 'free',      2000),
  ('quota-v1', 'pro',       20000),
  ('quota-v1', 'unlimited', NULL);

-- The app cap is a plan capability, not consumption. NULL stays "no cap".
UPDATE plans SET apps_per_workspace = 1  WHERE id = 'free';
UPDATE plans SET apps_per_workspace = 10 WHERE id = 'pro';

ALTER TABLE plans DROP COLUMN platform_key_limit;
ALTER TABLE plans DROP COLUMN reviews_included;
