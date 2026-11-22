/**
 * Quota versions — the operator console's profile store (spec
 * [bot scope and claiming](../../docs/specs/feature/bot-scope-and-claiming.md)
 * § Review usage, and the iteration's quota plans).
 *
 * Three things live here, all of them operator-only:
 *
 * 1. {@link listQuotaVersions} — every stored profile with its interval, the
 *    marker on the one judging this month, and the ceilings it sets per plan.
 *    The interval END is derived from the next row's `effective_from`: the
 *    table stores one endpoint per profile, so nothing here can disagree with
 *    a second column that does not exist.
 * 2. {@link previewQuotaImpact} — the tightness check the create form must show
 *    before publishing: how many live `saas` workspaces have ALREADY spent the
 *    candidate ceiling for their plan at today's usage. It reads the month's RP
 *    through `readMonthlyRp`, the same statement the enqueue's ceiling read
 *    answers from, so at equal usage and equal numbers the preview cannot
 *    disagree with a refusal. It cannot predict a cut-off: under D5 a profile
 *    published mid-month judges from the next 1st, and that month starts at
 *    0 RP.
 * 3. {@link createQuotaVersion} — one `batch`: the profile row, one
 *    `monthly_rp` row per plan and the audit entry. It closes nothing: a
 *    profile's interval ends at its successor's `effective_from`, so no other
 *    row changes. `version` is derived inside the insert (`MAX(version)+1`), so
 *    two concurrent creates cannot mint the same ordinal — the unique index
 *    refuses the loser.
 *
 * The console is mounted on the `saas` router only, so every workspace here is
 * a `saas` workspace; `self-hosted` reads no ceiling at all.
 */
import { FREE_PLAN_ID } from "../dashboard/entitlement";
import type { DashboardD1 } from "../dashboard/users";
import {
  decodeQuotaProfiles,
  pickQuotaProfile,
  QUOTA_PROFILES_SQL,
  quotaMonth,
  quotaSpent,
  quotaStartsOn,
  type QuotaProfileListRow,
  type QuotaProfileVersion,
  type QuotaSource,
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
  /** note: The next profile's `effective_from`; `null` for the last (open) interval. */
  effectiveTo: string | null;
  /**
   * note: `current` is the profile judging this month (its `effective_from` covers
   * the month's 1st); `scheduled` starts after that 1st and never judges the
   * month in progress; `past` judged an earlier month.
   */
  state: "past" | "current" | "scheduled";
  base: Record<ReviewLevel, number>;
  source: Record<QuotaSource, number>;
  rpPerCredit: number;
  notes: string | null;
  monthlyRp: Record<string, number | null>;
};

export type QuotaVersionsPayload = {
  /** note: The version judging this month (the `current` marker is relative to it). */
  judgingVersion: number;
  /** note: The ordinal a create would mint — the form's read-only `fieldVersion`. */
  nextVersion: number;
  plans: QuotaPlan[];
  versions: QuotaVersionRow[];
  /**
   * why: Plan ids the JUDGING version states no ceiling for, ordered by id. Empty is
   * the healthy state.
   *
   * `quota_profile_plans` must carry a row for every plan (a missing row would
   * be indistinguishable from "no ceiling", so `resolveMonthlyQuota` throws by
   * design), and the enqueue turns that throw into a REFUSAL: every webhook of
   * a workspace on one of these plans is skipped, with a recorded `entitlement`
   * failure, until a version that covers the plan is published. Publishing is
   * the only repair — no setting anywhere can add the row. The page states this
   * because otherwise the state is invisible: the deliveries are refused and
   * nothing on any other surface says why.
   */
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
  // note: D1 returns each statement's rows at its batch position, in one transaction.
  const [profileResult, planResult] = await db.batch([
    db.prepare(QUOTA_PROFILES_SQL),
    db.prepare(PLAN_LIST_SQL),
  ]);
  const profiles = decodeQuotaProfiles((profileResult?.results ?? []) as QuotaProfileListRow[]);
  const plans = (planResult?.results ?? []) as QuotaPlan[];
  const judging = pickQuotaProfile(profiles, month.startIso);
  const versions = profiles.map((profile: QuotaProfileVersion, index) => ({
    id: profile.id,
    version: profile.version,
    effectiveFrom: profile.effectiveFrom,
    effectiveTo: profiles[index + 1]?.effectiveFrom ?? null,
    state:
      profile.id === judging.id
        ? ("current" as const)
        : profile.effectiveFrom > month.startIso
          ? ("scheduled" as const)
          : ("past" as const),
    base: profile.base,
    source: profile.source,
    rpPerCredit: profile.rpPerCredit,
    notes: profile.notes,
    monthlyRp: profile.monthlyRp,
  }));
  // why: The JUDGING version is the one that decides today's verdicts, so its plan
  // coverage is what the page must report: a gap in a past or scheduled version
  // cannot refuse anything this month. `judging` comes from the same snapshot,
  // so a plan it covers can never be reported as uncovered.
  const uncoveredPlanIds = plans.filter((plan) => !Object.hasOwn(judging.monthlyRp, plan.id)).map((plan) => plan.id);
  return {
    judgingVersion: judging.version,
    nextVersion: profiles.reduce((max, profile) => Math.max(max, profile.version), 0) + 1,
    plans,
    versions,
    uncoveredPlanIds,
  };
}

/** The candidate numbers a preview and a publish share. */
export type QuotaCandidate = {
  /** note: ISO-8601 instant, `T00:00:00.000Z` — the form submits a UTC date. */
  effectiveFrom: string;
  /** note: One ceiling per plan id; `null` means that plan is unlimited. */
  monthlyRp: Record<string, number | null>;
};

export type QuotaImpact = {
  count: number;
  /** note: The same `saas` live-workspace count the numerator was drawn from. */
  total: number;
  /** note: The first 1st this candidate judges (`quotaStartsOn`), `YYYY-MM-DD`. */
  startsOn: string;
};

/** note: Every live workspace with the plan id its subscription resolves to. */
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
 */
export async function previewQuotaImpact(
  db: DashboardD1,
  candidate: QuotaCandidate,
  now: Date,
): Promise<QuotaImpact> {
  const month = quotaMonth(now);
  const [workspaces, usage] = await Promise.all([
    liveWorkspacePlans(db),
    readMonthlyRpByWorkspace(db, month.startIso, month.endIso),
  ]);
  const spent = new Map(usage.map((row) => [row.workspaceId, row.total]));
  let count = 0;
  for (const workspace of workspaces) {
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
  source: Record<QuotaSource, number>;
  rpPerCredit: number;
};

export type CreateQuotaVersionOutcome =
  | { kind: "ok"; version: number }
  | { kind: "effective_from_taken" };

const PROFILE_INSERT_SQL = `
  INSERT INTO quota_profiles
    (id, version, effective_from, base_quick, base_standard, base_deep,
     source_byok, source_shared, rp_per_credit, notes, created_at, created_by)
  SELECT ?1, COALESCE(MAX(version), 0) + 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
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
          input.source.byok,
          input.source.shared,
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
            source: input.source,
            rpPerCredit: input.rpPerCredit,
            monthlyRp: input.monthlyRp,
            notes: input.notes,
          }),
          now,
        ),
    ]);
  } catch (err) {
    // why: A concurrent publish can take the same instant between the probe and the
    // batch; the unique index refuses this one, and that is the same conflict.
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

/** note: A `YYYY-MM-DD` date as the UTC instant the profile stores. */
function utcDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const iso = `${date}T00:00:00.000Z`;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  // note: Reject a date the calendar does not have (2026-02-31 rolls over).
  return at.toISOString().slice(0, 10) === date ? iso : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
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
    const rp = positiveInt(value);
    if (rp === null) {
      return { ok: false, error: `monthlyRp.${planId} must be a positive whole number of RP, or null for no limit` };
    }
    ceilings[planId] = rp;
  }
  return { ok: true, value: { effectiveFrom, monthlyRp: ceilings } };
}

/**
 * The pricing half of the create body. Every factor is a positive integer
 * because the DDL CHECKs are: a zero or fractional weight would price a review
 * at 0 RP and make the ledger's pre-metering sentinel ambiguous.
 */
export function parseQuotaNumbers(body: unknown): Parsed<Pick<CreateQuotaVersionInput, "base" | "source" | "rpPerCredit" | "notes">> {
  const fields = record(body);
  if (fields === null) return { ok: false, error: "body must be a JSON object" };
  const base = record(fields.base);
  const source = record(fields.source);
  if (base === null || source === null) {
    return { ok: false, error: "base and source must be objects of positive whole numbers" };
  }
  const quick = positiveInt(base.quick);
  const standard = positiveInt(base.default);
  const deep = positiveInt(base.deep);
  if (quick === null || standard === null || deep === null) {
    return { ok: false, error: "base.quick, base.default and base.deep must each be a positive whole number of RP" };
  }
  const byok = positiveInt(source.byok);
  const shared = positiveInt(source.shared);
  if (byok === null || shared === null) {
    return { ok: false, error: "source.byok and source.shared must each be a positive whole-number multiplier" };
  }
  const rpPerCredit = positiveInt(fields.rpPerCredit);
  if (rpPerCredit === null) {
    return { ok: false, error: "rpPerCredit must be a positive whole number of RP" };
  }
  if (fields.notes !== null && fields.notes !== undefined && typeof fields.notes !== "string") {
    return { ok: false, error: "notes must be a string, or null to record none" };
  }
  const notes = typeof fields.notes === "string" && fields.notes.trim().length > 0 ? fields.notes.trim() : null;
  return { ok: true, value: { base: { quick, default: standard, deep }, source: { byok, shared }, rpPerCredit, notes } };
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
