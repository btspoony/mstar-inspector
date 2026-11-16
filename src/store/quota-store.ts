/**
 * Quota profile leaf (migration 0063) — the read side of the versioned quota
 * configuration: which profile judges an instant, which profile judges a
 * calendar month, and what one started review costs in RP.
 *
 * Module boundary (compass contracts A, same as usage-store.ts): type imports
 * from ./types plus the shared type package only — no worker/pipeline/session
 * dependency — so the dashboard, the webhook route and the pipeline consumer
 * all import one module.
 *
 * A month is judged by the profile covering that month's FIRST day, never by
 * the profile current at the moment of the read (compass D5): a profile
 * published mid-month starts judging on the next 1st, so a price change cannot
 * evict a workspace mid-month. Both reads implement exactly that rule.
 *
 * `effective_from` is the only stored interval endpoint — a profile's interval
 * ends at the next profile's `effective_from` — so this module never reads a
 * second column to answer "until when".
 */

import type { ReviewLevel } from "../../packages/shared/src/runtime";
import type { D1Like } from "./types";

/** The two key sources a review can be started from; the profile scales each. */
export type QuotaSource = "byok" | "shared";

/** One resolved profile, in the vocabulary the faces and the form use. */
export type QuotaProfile = {
  id: string;
  version: number;
  /** ISO-8601 UTC: the instant the operator chose for this profile to start. */
  effectiveFrom: string;
  base: Record<ReviewLevel, number>;
  source: Record<QuotaSource, number>;
  rpPerCredit: number;
};

/** The read's row shape: SQLite column names, weight columns named per level. */
type QuotaProfileRow = {
  id: string;
  version: number;
  effective_from: string;
  base_quick: number;
  base_standard: number;
  base_deep: number;
  source_byok: number;
  source_shared: number;
  rp_per_credit: number;
};

/**
 * The stored row → the profile. `base_standard` is the `default` level's
 * weight: the level enum keeps its `default` member while the tenant-facing
 * name (and the form's label) says Standard, so the mapping is here and only
 * here.
 */
function quotaProfile(row: QuotaProfileRow): QuotaProfile {
  return {
    id: row.id,
    version: row.version,
    effectiveFrom: row.effective_from,
    base: { quick: row.base_quick, default: row.base_standard, deep: row.base_deep },
    source: { byok: row.source_byok, shared: row.source_shared },
    rpPerCredit: row.rp_per_credit,
  };
}

const PROFILE_COLUMNS = `id            AS id,
            version       AS version,
            effective_from AS effective_from,
            base_quick    AS base_quick,
            base_standard AS base_standard,
            base_deep     AS base_deep,
            source_byok   AS source_byok,
            source_shared AS source_shared,
            rp_per_credit AS rp_per_credit`;

/**
 * The profile whose `effective_from` is the greatest <= `at`. An instant
 * before every profile answers the EARLIEST profile — there was no earlier
 * configured state, which is what makes the cutover month resolvable. Throws
 * only when the table is empty (migration 0063 not applied).
 */
export async function resolveQuotaProfile(db: D1Like, at: string): Promise<QuotaProfile> {
  const atOrBefore = await db
    .prepare(
      `SELECT ${PROFILE_COLUMNS} FROM quota_profiles
        WHERE effective_from <= ?1
        ORDER BY effective_from DESC
        LIMIT 1`,
    )
    .bind(at)
    .first<QuotaProfileRow>();
  if (atOrBefore !== null) return quotaProfile(atOrBefore);

  const earliest = await db
    .prepare(`SELECT ${PROFILE_COLUMNS} FROM quota_profiles ORDER BY effective_from ASC LIMIT 1`)
    .first<QuotaProfileRow>();
  if (earliest === null) {
    throw new Error("quota_profiles is empty; apply migration 0063_quota_profiles.sql");
  }
  return quotaProfile(earliest);
}

/**
 * The profile judging the month `monthStart` opens (D5) plus this plan's
 * ceiling; `monthlyRp === null` means unlimited. Throws when the profile has no
 * row for the plan: a profile's plan set is closed and complete, so an absent
 * row is a configuration defect, never "no ceiling".
 */
export async function resolveMonthlyQuota(
  db: D1Like,
  monthStart: string,
  planId: string,
): Promise<{ profile: QuotaProfile; monthlyRp: number | null }> {
  const profile = await resolveQuotaProfile(db, monthStart);
  const row = await db
    .prepare(`SELECT monthly_rp AS monthlyRp FROM quota_profile_plans WHERE profile_id = ? AND plan_id = ?`)
    .bind(profile.id, planId)
    .first<{ monthlyRp: number | null }>();
  if (row === null) {
    throw new Error(
      `quota profile ${profile.id} has no ceiling for plan '${planId}'; publish a profile that covers it`,
    );
  }
  return { profile, monthlyRp: row.monthlyRp };
}

/**
 * Integer RP one started review costs. Pure. Every factor is > 0 by DDL CHECK,
 * so the result is always >= 1 — which is what lets 0 mark a pre-metering
 * `usage_events.rp` row unambiguously.
 */
export function rpFor(level: ReviewLevel, source: QuotaSource, profile: QuotaProfile): number {
  return profile.base[level] * profile.source[source];
}

/**
 * The UTC month a quota face reports, with half-open ISO bounds over
 * `usage_events.occurred_at` (`startIso <= occurred_at < endIso`).
 */
export function quotaMonth(now: Date): { month: string; startIso: string; endIso: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const startIso = start.toISOString();
  return { month: startIso.slice(0, 7), startIso, endIso: end.toISOString() };
}

/**
 * Whether a month's usage has spent the ceiling — the ONE spelling of "at or
 * over" shared by the workspace card's banner and the operator's impact
 * preview. A NULL ceiling is unlimited, so it can never be spent.
 *
 * The enqueue's own comparison is `used + cost > monthlyRp` (a review is
 * admitted while it still fits). Because `rpFor` is >= 1, that refuses exactly
 * the months this returns true for — plus the ones one review would tip over.
 * At today's usage, `used >= monthlyRp` therefore means "no further review is
 * admitted", which is what both faces count.
 */
export function quotaSpent(usedRp: number, monthlyRp: number | null): boolean {
  return monthlyRp !== null && usedRp >= monthlyRp;
}

/**
 * The date a profile first judges quota (D5): the 1st of the month its
 * `effective_from` covers, or the next month's 1st when it lands mid-month.
 * This is the same rule `resolveQuotaProfile(monthStart)` applies at read time
 * — a month is judged by the profile whose `effective_from <= monthStart`, so
 * the first month start at or after the instant is the first one it judges.
 * Returns `YYYY-MM-DD`, the shape the faces render.
 */
export function quotaStartsOn(effectiveFrom: string): string {
  const at = new Date(effectiveFrom);
  const monthStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  if (at.getTime() === monthStart) return new Date(monthStart).toISOString().slice(0, 10);
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/** One stored profile with its operator-only notes and its per-plan ceilings. */
export type QuotaProfileVersion = QuotaProfile & {
  notes: string | null;
  /** This version's ceiling per plan id; `null` means that plan is unlimited. */
  monthlyRp: Record<string, number | null>;
};

/**
 * Every stored profile, oldest first, with its ceilings — the operator list's
 * read. The interval END is the next row's `effective_from` (no second stored
 * endpoint), so callers derive it from this order.
 */
export async function listQuotaProfiles(db: D1Like): Promise<QuotaProfileVersion[]> {
  const res = await db
    .prepare(
      `SELECT p.id            AS id,
              p.version       AS version,
              p.effective_from AS effective_from,
              p.base_quick    AS base_quick,
              p.base_standard AS base_standard,
              p.base_deep     AS base_deep,
              p.source_byok   AS source_byok,
              p.source_shared AS source_shared,
              p.rp_per_credit AS rp_per_credit,
              p.notes         AS notes,
              q.plan_id       AS plan_id,
              q.monthly_rp    AS monthly_rp
         FROM quota_profiles p
         LEFT JOIN quota_profile_plans q ON q.profile_id = p.id
        ORDER BY p.effective_from ASC, q.plan_id ASC`,
    )
    .all<QuotaProfileRow & { notes: string | null; plan_id: string | null; monthly_rp: number | null }>();
  const versions: QuotaProfileVersion[] = [];
  const byId = new Map<string, QuotaProfileVersion>();
  for (const row of res.results) {
    let version = byId.get(row.id);
    if (version === undefined) {
      version = { ...quotaProfile(row), notes: row.notes, monthlyRp: {} };
      byId.set(row.id, version);
      versions.push(version);
    }
    if (row.plan_id !== null) version.monthlyRp[row.plan_id] = row.monthly_rp;
  }
  return versions;
}
