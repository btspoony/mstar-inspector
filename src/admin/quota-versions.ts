import { FREE_PLAN_ID } from "../dashboard/entitlement";
import type { DashboardD1 } from "../dashboard/users";
import { isRpCeiling, isRpPerCredit, QUOTA_BASE_MAX, RP_PER_CREDIT_MAX } from "../contracts/rp-limits";
import {
  decodeQuotaProfiles,
  pickQuotaProfile,
  QUOTA_PROFILES_SQL,
  quotaMonth,
  quotaSpent,
  quotaStartsOn,
  type QuotaProfileListRow,
  type QuotaProfileVersion,
} from "../store/quota-store";
import { readMonthlyRpByWorkspace } from "../store/usage-store";
import type { ReviewLevel } from "../../packages/shared/src/runtime";

/** One plan of the catalogue, as the create form labels its ceiling field. */
export type QuotaPlan = { id: string; name: string };

/** One row of the operator's version table. */
export type QuotaVersionRow = {
  id: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  state: "past" | "current" | "scheduled";
  base: Record<ReviewLevel, number>;
  rpPerCredit: number;
  notes: string | null;
  monthlyRp: Record<string, number | null>;
};

export type QuotaVersionsPayload = {
  judgingVersion: number | null;
  nextVersion: number;
  plans: QuotaPlan[];
  versions: QuotaVersionRow[];
  uncoveredPlanIds: string[];
};

const PLAN_LIST_SQL = `SELECT id AS id, name AS name FROM plans ORDER BY id ASC`;

/** The plans catalogue, ordered by id (free, pro, unlimited). */
export async function listPlans(db: DashboardD1): Promise<QuotaPlan[]> {
  const res = await db.prepare(PLAN_LIST_SQL).all<QuotaPlan>();
  return res.results;
}

/**
 * The operator's version table plus this month's judging marker, in ONE
 * `batch`: the coverage decision compares the judging profile's plan set with
 * the catalogue, so both must come from the same snapshot — read separately a
 * concurrent publish could make the page report a gap that no longer exists.
 */
export async function listQuotaVersions(db: DashboardD1, now: Date): Promise<QuotaVersionsPayload> {
  const month = quotaMonth(now);
  const [profileResult, planResult] = await db.batch([
    db.prepare(QUOTA_PROFILES_SQL),
    db.prepare(PLAN_LIST_SQL),
  ]);
  const profiles = decodeQuotaProfiles((profileResult?.results ?? []) as QuotaProfileListRow[]);
  const plans = (planResult?.results ?? []) as QuotaPlan[];
  // An empty table is a fresh deployment, not a read failure: the operator
  // needs the form to publish the first version, so nothing here throws.
  //
  // The marker names the version a workspace with NO binding gets, which under
  // D13 is the profile in force at this instant — not the one covering the
  // month's 1st. A bound workspace may sit on an older version; that is the
  // point of the binding, and the list says so with `current` naming only the
  // unbound answer.
  const judging = profiles.length === 0 ? null : pickQuotaProfile(profiles, now.toISOString());
  const versions = profiles.map((profile: QuotaProfileVersion, index) => ({
    id: profile.id,
    version: profile.version,
    effectiveFrom: profile.effectiveFrom,
    effectiveTo: profiles[index + 1]?.effectiveFrom ?? null,
    state:
      profile.id === judging?.id
        ? ("current" as const)
        : profile.effectiveFrom > now.toISOString()
          ? ("scheduled" as const)
          : ("past" as const),
    base: profile.base,
    rpPerCredit: profile.rpPerCredit,
    notes: profile.notes,
    monthlyRp: profile.monthlyRp,
  }));
  const uncoveredPlanIds =
    judging === null
      ? plans.map((plan) => plan.id)
      : plans.filter((plan) => !Object.hasOwn(judging.monthlyRp, plan.id)).map((plan) => plan.id);
  return {
    judgingVersion: judging?.version ?? null,
    nextVersion: profiles.reduce((max, profile) => Math.max(max, profile.version), 0) + 1,
    plans,
    versions,
    uncoveredPlanIds,
  };
}

/** The candidate numbers a preview and a publish share. */
export type QuotaCandidate = {
  effectiveFrom: string;
  monthlyRp: Record<string, number | null>;
};

export type QuotaImpact = {
  count: number;
  total: number;
  startsOn: string;
};

async function liveWorkspacePlans(db: DashboardD1): Promise<Array<{ id: string; planId: string }>> {
  const res = await db
    .prepare(
      `SELECT w.id AS id, COALESCE(s.plan_id, ?1) AS planId
         FROM workspaces w
         LEFT JOIN workspace_subscriptions s
                ON s.workspace_id = w.id AND s.status = 'active'
        WHERE w.deleted_at IS NULL
        ORDER BY w.id ASC`,
    )
    .bind(FREE_PLAN_ID)
    .all<{ id: string; planId: string }>();
  return res.results;
}

/**
 * How many live workspaces would already be over these numbers at today's
 * usage. One month sum (`readMonthlyRp` with no workspace bound), one
 * comparison per workspace (`quotaSpent`), one date (`quotaStartsOn`).
 *
 * A workspace holding a binding for this month is NOT counted: its version is
 * already pinned, so the candidate reaches it at its next month's first
 * metering, never mid-month (D13, contract § 3). What the count reports is the
 * population that adopts the candidate at its next metering — the unbound.
 */
export async function previewQuotaImpact(
  db: DashboardD1,
  candidate: QuotaCandidate,
  now: Date,
): Promise<QuotaImpact> {
  const month = quotaMonth(now);
  const [workspaces, usage, bound] = await Promise.all([
    liveWorkspacePlans(db),
    readMonthlyRpByWorkspace(db, month.startIso, month.endIso),
    db
      .prepare(`SELECT workspace_id AS workspaceId FROM workspace_quota_binding WHERE month = ?1`)
      .bind(month.month)
      .all<{ workspaceId: string }>(),
  ]);
  const spent = new Map(usage.map((row) => [row.workspaceId, row.total]));
  const pinned = new Set(bound.results.map((row) => row.workspaceId));
  let count = 0;
  for (const workspace of workspaces) {
    if (pinned.has(workspace.id)) continue;
    if (quotaSpent(spent.get(workspace.id) ?? 0, candidate.monthlyRp[workspace.planId] ?? null)) {
      count += 1;
    }
  }
  return { count, total: workspaces.length, startsOn: quotaStartsOn(candidate.effectiveFrom) };
}

/** The full create request: the candidate numbers plus its pricing fields. */
export type CreateQuotaVersionInput = QuotaCandidate & {
  notes: string | null;
  base: Record<ReviewLevel, number>;
  rpPerCredit: number;
};

export type CreateQuotaVersionOutcome =
  | { kind: "ok"; version: number }
  | { kind: "effective_from_taken" };

const PROFILE_INSERT_SQL = `
  INSERT INTO quota_profiles
    (id, version, effective_from, base_quick, base_standard, base_deep,
     rp_per_credit, notes, created_at, created_by)
  SELECT ?1, COALESCE(MAX(version), 0) + 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
    FROM quota_profiles`;

const PLAN_INSERT_SQL = `
  INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp) VALUES (?, ?, ?)`;

const AUDIT_INSERT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?, ?, 'quota.profile.create', 'quota_profile', ?, ?, ?)`;

/**
 * Publish one profile. The whole write is one `batch`, so a refused statement
 * leaves no profile, no ceiling rows and no audit entry behind. An
 * `effective_from` another profile already holds is the store's own conflict:
 * `UNIQUE (effective_from)` is the authority, and the probe before the batch
 * only turns the loser's error into a named refusal.
 */
export async function createQuotaVersion(
  db: DashboardD1,
  input: CreateQuotaVersionInput,
  now: string,
  actorLogin: string,
): Promise<CreateQuotaVersionOutcome> {
  const id = `quota-${crypto.randomUUID()}`;
  const planIds = Object.keys(input.monthlyRp).sort();
  const taken = await db
    .prepare(`SELECT 1 AS present FROM quota_profiles WHERE effective_from = ?`)
    .bind(input.effectiveFrom)
    .first<{ present: number }>();
  if (taken !== null) return { kind: "effective_from_taken" };
  try {
    await db.batch([
      db
        .prepare(PROFILE_INSERT_SQL)
        .bind(
          id,
          input.effectiveFrom,
          input.base.quick,
          input.base.default,
          input.base.deep,
          input.rpPerCredit,
          input.notes,
          now,
          actorLogin,
        ),
      ...planIds.map((planId) =>
        db.prepare(PLAN_INSERT_SQL).bind(id, planId, input.monthlyRp[planId] ?? null),
      ),
      db
        .prepare(AUDIT_INSERT_SQL)
        .bind(
          crypto.randomUUID(),
          actorLogin,
          id,
          JSON.stringify({
            effectiveFrom: input.effectiveFrom,
            base: input.base,
            rpPerCredit: input.rpPerCredit,
            monthlyRp: input.monthlyRp,
            notes: input.notes,
          }),
          now,
        ),
    ]);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: quota_profiles\.effective_from/.test(err.message)) {
      return { kind: "effective_from_taken" };
    }
    throw err;
  }
  const row = await db
    .prepare(`SELECT version AS version FROM quota_profiles WHERE id = ?`)
    .bind(id)
    .first<{ version: number }>();
  return { kind: "ok", version: row?.version ?? 0 };
}

function utcDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const iso = `${date}T00:00:00.000Z`;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString().slice(0, 10) === date ? iso : null;
}

/** A positive whole number no larger than `max` — the shared domain's own test. */
function positiveIntWithin(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The candidate half of both bodies: the instant a version starts and the
 * ceiling it sets per plan. Every plan of the catalogue must be covered —
 * a profile's plan set is closed and complete (`resolveMonthlyQuota` throws on
 * an absent row, so a missing plan would be a configuration defect).
 */
export function parseQuotaCandidate(body: unknown, planIds: readonly string[]): Parsed<QuotaCandidate> {
  const fields = record(body);
  if (fields === null) return { ok: false, error: "body must be a JSON object" };
  if (typeof fields.effectiveFrom !== "string") {
    return { ok: false, error: "effectiveFrom must be a YYYY-MM-DD date" };
  }
  const effectiveFrom = utcDate(fields.effectiveFrom);
  if (effectiveFrom === null) {
    return { ok: false, error: `effectiveFrom ${JSON.stringify(fields.effectiveFrom)} is not a calendar date (YYYY-MM-DD)` };
  }
  const monthlyRp = record(fields.monthlyRp);
  if (monthlyRp === null) {
    return { ok: false, error: "monthlyRp must be an object keyed by plan id" };
  }
  const expected = [...planIds].sort();
  const given = Object.keys(monthlyRp).sort();
  if (given.length !== expected.length || given.some((planId, index) => planId !== expected[index])) {
    return {
      ok: false,
      error: `monthlyRp must give a ceiling (a number, or null for unlimited) for exactly these plans: ${expected.join(", ")}`,
    };
  }
  const ceilings: Record<string, number | null> = {};
  for (const planId of expected) {
    const value = monthlyRp[planId];
    if (value === null) {
      ceilings[planId] = null;
      continue;
    }
    const rp = isRpCeiling(value) ? value : null;
    if (rp === null) {
      return { ok: false, error: `monthlyRp.${planId} must be a positive whole number of RP within the supported domain, or null for no limit` };
    }
    ceilings[planId] = rp;
  }
  return { ok: true, value: { effectiveFrom, monthlyRp: ceilings } };
}

/**
 * The pricing half of the create body. Every factor is a positive integer
 * because the DDL CHECKs are: a zero weight would price a review at 0 RP and
 * make the ledger's pre-metering sentinel ambiguous.
 *
 * The two key-source rates are GONE (D37): a review's price is
 * `ceil(base × the executing bot's multiplier)`, so the profile carries only
 * the level weights and the credit denominator.
 */
export function parseQuotaNumbers(
  body: unknown,
): Parsed<Pick<CreateQuotaVersionInput, "base" | "rpPerCredit" | "notes">> {
  const fields = record(body);
  if (fields === null) return { ok: false, error: "body must be a JSON object" };
  const base = record(fields.base);
  if (base === null) {
    return { ok: false, error: "base must be an object of positive whole numbers" };
  }
  const quick = positiveIntWithin(base.quick, QUOTA_BASE_MAX);
  const standard = positiveIntWithin(base.default, QUOTA_BASE_MAX);
  const deep = positiveIntWithin(base.deep, QUOTA_BASE_MAX);
  if (quick === null || standard === null || deep === null) {
    return {
      ok: false,
      error: `base.quick, base.default and base.deep must each be a positive whole number of RP no larger than ${QUOTA_BASE_MAX}`,
    };
  }
  // The rate divides every amount on every face, so the writer applies the
  // READ domain's bound: a version carrying a rate the SPA refuses would be a
  // page that cannot open.
  const rpPerCredit = isRpPerCredit(fields.rpPerCredit) ? fields.rpPerCredit : null;
  if (rpPerCredit === null) {
    return {
      ok: false,
      error: `rpPerCredit must be a positive whole number of RP no larger than ${RP_PER_CREDIT_MAX}`,
    };
  }
  if (fields.notes !== null && fields.notes !== undefined && typeof fields.notes !== "string") {
    return { ok: false, error: "notes must be a string, or null to record none" };
  }
  const notes = typeof fields.notes === "string" && fields.notes.trim().length > 0 ? fields.notes.trim() : null;
  return { ok: true, value: { base: { quick, default: standard, deep }, rpPerCredit, notes } };
}

/**
 * The preview a publish echoes back. A publish without one is refused
 * (`previewRequired`), and a publish whose echo disagrees with a fresh
 * computation is refused too: a stale count is worse than none, and the
 * operator decides on the number they were shown.
 */
export function parseQuotaImpact(body: unknown): QuotaImpact | null {
  const fields = record(body);
  if (fields === null) return null;
  const impact = record(fields.impact);
  if (impact === null) return null;
  const { count, total, startsOn } = impact;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) return null;
  if (typeof startsOn !== "string") return null;
  return { count, total, startsOn };
}
