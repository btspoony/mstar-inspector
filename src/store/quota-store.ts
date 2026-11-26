
import type { ReviewLevel } from "../../packages/shared/src/runtime";
import type { D1Like } from "./types";

/** The two key sources a review can be started from; the profile scales each. */
export type QuotaSource = "byok" | "shared";

/** One resolved profile, in the vocabulary the faces and the form use. */
export type QuotaProfile = {
  id: string;
  version: number;
  effectiveFrom: string;
  base: Record<ReviewLevel, number>;
  source: Record<QuotaSource, number>;
  rpPerCredit: number;
};

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
 * why: The stored row → the profile. `base_standard` is the `default` level's
 * weight: the level enum keeps its `default` member while every tenant-facing
 * name says Standard. The mapping is therefore spread over three sites and none
 * of them is local to this file — `REVIEW_LEVELS` in
 * `packages/shared/src/runtime.ts` (the enum keeps `default`), this function
 * (the column name to the enum member), and the form's label
 * (`settings.reviewDepthStandard` plus the profile's weight column). A fourth
 * level, or a rename of the tenant-facing name, has to change all three.
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

/** The one error an empty `quota_profiles` table produces, on every read path. */
export const QUOTA_PROFILES_EMPTY_ERROR = "quota_profiles is empty; apply migration 0063_quota_profiles.sql";

/**
 * The profile judging `at`, picked from a list already in `effective_from`
 * order (oldest first): the last one at or before `at`, else the earliest —
 * there was no earlier configured state, which is what makes the cutover month
 * resolvable. Throws only when the list is empty (migration 0063 not applied).
 */
export function pickQuotaProfile<T extends QuotaProfile>(profiles: readonly T[], at: string): T {
  const first = profiles[0];
  if (first === undefined) throw new Error(QUOTA_PROFILES_EMPTY_ERROR);
  let judging = first;
  for (const profile of profiles) {
    if (profile.effectiveFrom <= at) judging = profile;
  }
  return judging;
}

/**
 * The profile whose `effective_from` is the greatest <= `at`, read on its own.
 * {@link pickQuotaProfile} is the same rule over a list; this one exists for
 * callers that hold no snapshot. An instant before every profile answers the
 * EARLIEST profile. Throws only when the table is empty.
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
    throw new Error(QUOTA_PROFILES_EMPTY_ERROR);
  }
  return quotaProfile(earliest);
}

/**
 * The profile judging one workspace's month (D13, D36) — THE resolver every
 * reader goes through. A binding pinned by the metering path wins; with no
 * binding the answer is the profile in force at `at` (the month's 1st for every
 * caller but the metering write, which passes the instant it charges for).
 *
 * This function NEVER writes. Binding on read would lock a version for a
 * workspace that never metered and would make every reader a second writer,
 * which is exactly the mid-month jump the binding exists to prevent.
 */
export async function resolveWorkspaceQuotaProfile(
  db: D1Like,
  workspaceId: string,
  month: string,
  at: string,
): Promise<QuotaProfile> {
  const bound = await db
    .prepare(
      `SELECT ${PROFILE_COLUMNS}
         FROM workspace_quota_binding b
         JOIN quota_profiles p ON p.id = b.profile_id
        WHERE b.workspace_id = ?1 AND b.month = ?2`,
    )
    .bind(workspaceId, month)
    .first<QuotaProfileRow>();
  if (bound !== null) return quotaProfile(bound);
  return resolveQuotaProfile(db, at);
}

/**
 * The executing bot's price multiplier (D11). One statement, one column: the
 * metering path and the enqueue ceiling both read it here rather than each
 * carrying their own copy of the SQL.
 *
 * A bot row that is missing or soft-deleted answers `null`; the callers treat
 * that as unreadable and refuse, never as a free (1×) price.
 */
export async function readBotMultiplier(db: D1Like, botId: string): Promise<number | null> {
  const row = await db
    // shortcut: tenant-bypass — addressed by the bot's own id, and the
    // projection is one price column; no identity or ownership is read.
    .prepare(`SELECT multiplier FROM review_bots WHERE id = ? AND deleted_at IS NULL`)
    .bind(botId)
    .first<{ multiplier: number }>();
  return row?.multiplier ?? null;
}

/**
 * This workspace's ceiling for a plan under its bound profile; `monthlyRp ===
 * null` means unlimited. One `now` yields both the month key and the instant
 * the unbound answer is resolved at, so a workspace with no binding adopts the
 * newest version the moment it reads (D13) instead of waiting for a boundary.
 *
 * Throws when the profile has no row for the plan: a profile's plan set is
 * closed and complete, so an absent row is a configuration defect, never "no
 * ceiling".
 */
export async function resolveWorkspaceMonthlyQuota(
  db: D1Like,
  workspaceId: string,
  planId: string,
  now: Date,
): Promise<{ profile: QuotaProfile; monthlyRp: number | null }> {
  const month = quotaMonth(now);
  const profile = await resolveWorkspaceQuotaProfile(db, workspaceId, month.month, now.toISOString());
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
 * Whether a month's usage plus one more review's cost crosses the ceiling — THE
 * spelling of the enqueue's own comparison (`used + cost > limit`), so a face
 * and the refusal it predicts cannot disagree. A NULL ceiling is unlimited, so
 * it can never be spent.
 *
 * `nextCostRp` defaults to 1: the smallest charge `rpFor` can produce (the
 * cheapest cell is BYOK + Quick = 1 RP), so the default answers "is even the
 * cheapest possible review refused?". The workspace card and the operator's
 * impact preview ask exactly that question — they state today's usage, not a
 * chosen depth — and at `used == limit` the answer is already true, because any
 * real review costs at least 1 RP. A caller that knows the review's cost (a
 * level and a source) passes it to answer for THAT review.
 */
export function quotaSpent(usedRp: number, monthlyRp: number | null, nextCostRp = 1): boolean {
  return monthlyRp !== null && usedRp + nextCostRp > monthlyRp;
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
  monthlyRp: Record<string, number | null>;
};

/** One list row: a profile column set plus one ceiling row (absent = no plan). */
export type QuotaProfileListRow = QuotaProfileRow & {
  notes: string | null;
  plan_id: string | null;
  monthly_rp: number | null;
};

/**
 * The profile-list statement: every stored profile, oldest first, with its
 * ceilings. Exported so a caller can place it in a `batch` beside its own
 * statement and read both from ONE snapshot.
 */
export const QUOTA_PROFILES_SQL = `SELECT p.id            AS id,
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
        ORDER BY p.effective_from ASC, q.plan_id ASC`;

/** The rows above → one version per profile, oldest first, ceilings merged. */
export function decodeQuotaProfiles(rows: readonly QuotaProfileListRow[]): QuotaProfileVersion[] {
  const versions: QuotaProfileVersion[] = [];
  const byId = new Map<string, QuotaProfileVersion>();
  for (const row of rows) {
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
