-- 0121_quota_base_large.sql — the large base weights and the 1000 RP credit.
--
-- D11/D12 fix the price as `rp = ceil(base(level) × multiplier)` over a large
-- base: quick 50, standard 100, deep 300, with 1 credit = 1000 RP. A large base
-- is what makes ceiling a fractional product lose at most one RP.
--
-- This ships as a QUOTA VERSION, not a constant (Global Constraints): a
-- workspace keeps the prices its month was opened under and adopts these at
-- its next month's first metering (D13), and no historical `rp` row is
-- recomputed.
--
-- THE CUTOVER INSTANT is the first FREE instant at or after next month's first
-- day. "Free" means no profile already holds it: `UNIQUE (effective_from)` is
-- the authority, and an operator may already have scheduled a version there.
-- This file therefore probes forward one second at a time and takes the first
-- gap, so it can neither abort the deploy on the unique index nor overwrite
-- what an operator scheduled. When next month's midnight is already taken the
-- chosen instant lands within that month's first minute; the binding is
-- per-workspace and per-month, so nothing changes for a workspace that metered
-- before the probe found the gap.
--
-- THE RATIO comes from the profiles themselves, never from a constant. The
-- ceilings are copied from the profile IN FORCE at the cutover instant — the
-- version whose prices this one supersedes — and scaled by that profile's own
-- base total:
--
--     factor = (50 + 100 + 300) / (base_quick + base_standard + base_deep)
--
-- computed in integer arithmetic (multiply first, then divide) so a factor that
-- does not divide evenly rounds DOWN: the allowance never grows beyond the price
-- rise. The result is then CLAMPED to `max(1, …)`, because `0063` requires
-- `monthly_rp > 0` and a legal operator configuration can shrink a ceiling to
-- zero (a 1-RP ceiling over a 1000/1000/1000 base gives 1 * 450 / 3000 = 0). A
-- zero ceiling would mean "no review may ever run" — a state the schema cannot
-- express — so the smallest expressible ceiling, 1 RP, is the honest clamp. A
-- NULL source ceiling stays NULL (unlimited). A future-scheduled profile is
-- never the source and its ceilings are never touched.
--
-- `review_bots.multiplier` needs no DDL change: 0115 already created it as
-- `REAL NOT NULL CHECK (multiplier > 0)`, which admits 1.5. What changes is its
-- meaning — it held an integer source rate copied from the profile, and from
-- this release it is the bot's own price factor. A shared bot backfilled with
-- multiplier 10 therefore prices a deep review at `ceil(300 × 10) = 3000 RP`,
-- keeping its old ratio to the base weights.
--
-- Must apply AFTER 0120 (the source-column drop): this file names no dropped
-- column, but the release order is the contract.

-- The cutover instant: next month's first day, probed forward to the first
-- second no profile already holds. Expressed as a scalar subquery so the three
-- data statements below all read the same value.
--
-- `probe` is a recursive walk from next month's midnight, one second at a time,
-- stopping at the first instant absent from `quota_profiles.effective_from`.
INSERT INTO quota_profiles (
  id, version, effective_from, base_quick, base_standard, base_deep,
  rp_per_credit, notes, created_at, created_by
)
SELECT
  'quota-v2-large-base',
  COALESCE(MAX(version), 0) + 1,
  (
    WITH RECURSIVE probe(instant) AS (
      SELECT strftime('%Y-%m-01T00:00:00.000Z', 'now', 'start of month', '+1 month')
      UNION ALL
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ', instant, '+1 second')
        FROM probe
       WHERE EXISTS (SELECT 1 FROM quota_profiles p WHERE p.effective_from = instant)
         AND instant < strftime('%Y-%m-01T00:00:00.000Z', 'now', 'start of month', '+2 month')
    )
    SELECT instant FROM probe
     WHERE NOT EXISTS (SELECT 1 FROM quota_profiles p WHERE p.effective_from = instant)
     LIMIT 1
  ),
  50,
  100,
  300,
  1000,
  'v2: large base 50/100/300, 1 credit = 1000 RP; ceilings scaled by the superseded profile''s own base total.',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration'
FROM quota_profiles
WHERE NOT EXISTS (SELECT 1 FROM quota_profiles WHERE id = 'quota-v2-large-base');

-- One ceiling row per plan of the superseded profile. The superseded profile is
-- the one in force at this file's own `effective_from` — i.e. the latest profile
-- strictly older than the row just inserted, which excludes itself and every
-- future-scheduled operator version.
--
-- The factor is applied only when all three of that profile's base weights are
-- non-NULL; otherwise the ceiling stays NULL and the comment above explains it.
INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp)
SELECT
  'quota-v2-large-base',
  q.plan_id,
  -- Integer arithmetic, rounded DOWN, then clamped to at least 1 RP: 0063
  -- requires `monthly_rp > 0`, and a legal operator configuration can shrink a
  -- ceiling to zero (a 1-RP ceiling over a 1000/1000/1000 base yields
  -- 1 * 450 / 3000 = 0). A ceiling of 0 would mean "no review may ever run",
  -- which the DDL cannot even express, so the smallest expressible ceiling —
  -- 1 RP — is the honest clamp. A NULL source ceiling stays NULL (unlimited).
  CASE
    WHEN q.monthly_rp IS NULL THEN NULL
    ELSE max(1, (q.monthly_rp * 450) / (src.base_quick + src.base_standard + src.base_deep))
  END
FROM quota_profile_plans q
JOIN quota_profiles src ON src.id = q.profile_id
WHERE src.id = (
        SELECT p.id FROM quota_profiles p
         WHERE p.id <> 'quota-v2-large-base'
           AND p.effective_from <= (SELECT effective_from FROM quota_profiles WHERE id = 'quota-v2-large-base')
         ORDER BY p.effective_from DESC
         LIMIT 1
      )
  AND NOT EXISTS (
        SELECT 1 FROM quota_profile_plans WHERE profile_id = 'quota-v2-large-base'
      );
