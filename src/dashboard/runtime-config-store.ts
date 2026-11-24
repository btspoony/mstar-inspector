import { isReviewLevel, REVIEW_LEVELS, type ReviewLevel } from "../../packages/shared/src/runtime";
import {
  DEFAULT_CHECK_MIN_SCORE,
  isCheckMinScoreValue,
} from "../contracts/review-gate";
import type { DashboardD1 } from "./users";
import { SWEEP_FIELDS, type SweepField, type SweepLimits, type SweepValues } from "../contracts/sweep-settings";
import { QUEUE_MAX_ATTEMPTS } from "../store/failure-store";
import { RECONCILE_FIELDS, RECONCILE_RULES, RECONCILE_DEFAULTS, invalidReconcileRelations, type ReconcileField, type ReconcileValues } from "../contracts/reconcile-settings";
import { CHECK_UPDATE_MIN } from "../contracts/check-budgets";
import { isFlagEnabled } from "../admin/flags";

export { CHECK_UPDATE_MIN } from "../contracts/check-budgets";

/** PK of the system row in `review_runtime_settings`. */
export const SYSTEM_CONCURRENCY_KEY = "review.concurrency.system";
/** Absent system row: the platform-wide quota. */
export const SYSTEM_CONCURRENCY_DEFAULT = 256;
/** NULL / absent workspace column: the per-workspace maximum. */
export const WORKSPACE_CONCURRENCY_DEFAULT = 32;
/** Lower bound of a stored value; also the degraded read fallback. */
export const CONCURRENCY_MIN = 1;
/**
 * Upper bound of the system value: the platform-wide quota, independent of the
 * queue ceiling. A stored 256 is a valid quota the platform can only saturate
 * to 250 (Cloudflare's delivery limit), which the operator console states.
 */
export const SYSTEM_CONCURRENCY_MAX = 256;
/** Upper bound of the workspace value: the per-workspace maximum. */
export const WORKSPACE_CONCURRENCY_MAX = 32;

/** PK of the terminalize-hook budget row (spec §7.10). */
export const CHECK_TERMINALIZE_KEY = "review.check.terminalize_timeout_ms";
/** PK of the bounded `checks.update` budget row (spec §7.10). */
export const CHECK_UPDATE_KEY = "review.check.update_timeout_ms";
/** Absent terminalize row: the 10 s inline budget §7.10 states. */
export const CHECK_TERMINALIZE_DEFAULT = 10_000;
/** Absent update row: the 5 s bound on the one terminal `checks.update`. */
export const CHECK_UPDATE_DEFAULT = 5_000;
/** Range of a stored terminalize budget. */
export const CHECK_TERMINALIZE_MIN = 1_000;
export const CHECK_TERMINALIZE_MAX = 30_000;
/** Range of a stored update budget. */
export const CHECK_UPDATE_MAX = 15_000;
const CHECK_BUDGETS_TARGET = "review.check.budgets";

/** PK of the comment-claim outbox retry window (migration 0048). */
export const COMMENT_CLAIM_RETRY_KEY = "review.comment_claim.retry_ms";
/** PK of the comment-claim outbox attempt cap. */
export const COMMENT_CLAIM_ATTEMPTS_KEY = "review.comment_claim.max_attempts";
/** PK of the comment-claim outbox batch size. */
export const COMMENT_CLAIM_OUTBOX_KEY = "review.comment_claim.outbox_cap";
/** Absent retry row: the 5-minute protocol window (well under one sweep interval). */
export const COMMENT_CLAIM_RETRY_DEFAULT = 300_000;
/** Absent attempts row: three outbox attempts before a claim expires. */
export const COMMENT_CLAIM_ATTEMPTS_DEFAULT = 3;
/** Absent outbox row: twenty claims re-sent per sweep. */
export const COMMENT_CLAIM_OUTBOX_DEFAULT = 20;
/** Range of a stored retry window: under 30 s would duplicate an in-flight send. */
export const COMMENT_CLAIM_RETRY_MIN = 30_000;
export const COMMENT_CLAIM_RETRY_MAX = 3_600_000;
/** Range of a stored attempt cap. */
export const COMMENT_CLAIM_ATTEMPTS_MIN = 1;
export const COMMENT_CLAIM_ATTEMPTS_MAX = 10;
/** Range of a stored outbox batch size. */
export const COMMENT_CLAIM_OUTBOX_MIN = 1;
export const COMMENT_CLAIM_OUTBOX_MAX = 100;
const COMMENT_CLAIM_TARGET = "review.comment_claim.budgets";

/** PK of the operator default review-depth row. */
export const REVIEW_LEVEL_KEY = "review.level.default";
/** Absent row: the tier every App without its own depth inherits. */
export const REVIEW_LEVEL_DEFAULT: ReviewLevel = "default";

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Integer 1..max — the concurrency predicate. */
export function isConcurrencyValue(value: unknown, max: number): value is number {
  return isIntegerIn(value, CONCURRENCY_MIN, max);
}

function parseInRange(value: unknown, min: number, max: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") return Number.NaN;
  const parsed = typeof value === "number" ? value : Number(value);
  return isIntegerIn(parsed, min, max) ? parsed : Number.NaN;
}

function parseWorkspaceStored(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") return Number.NaN;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < CONCURRENCY_MIN) return Number.NaN;
  return Math.min(parsed, WORKSPACE_CONCURRENCY_MAX);
}

/**
 * Why a degraded read could not trust its answer: the statement threw
 * (`read-failed`), the result row lacked a selected field (`malformed`), or the
 * stored value was present but not one the parse accepts (`untrusted`). Present
 * only when `degraded` is true — an absent setting is not a degradation.
 */
export type DegradedReason = "read-failed" | "malformed" | "untrusted";

/** One single-level read: the cap, plus whether the stored value could be trusted. */
export type ConcurrencyRead = {
  concurrency: number;
  degraded: boolean;
  reason?: DegradedReason;
};

function resolveRow(
  row: { value?: unknown } | null,
  fallback: number,
  parse: (value: unknown) => number | undefined,
): ConcurrencyRead {
  if (row === null) return { concurrency: fallback, degraded: false };
  if (row.value === undefined) {
    return { concurrency: CONCURRENCY_MIN, degraded: true, reason: "malformed" };
  }
  const parsed = parse(row.value);
  if (parsed === undefined) return { concurrency: fallback, degraded: false };
  return Number.isNaN(parsed)
    ? { concurrency: CONCURRENCY_MIN, degraded: true, reason: "untrusted" }
    : { concurrency: parsed, degraded: false };
}

/** Why a write was refused: a value outside the level's accepted range, or a
 * workspace target that does not exist. A workspace write is never refused for
 * the system quota's sake — that comparison would disclose the platform number.
 */
export type RuntimeConfigRefusal = "invalid_value" | "unknown_workspace";

/** A refused write. The route maps `reason` to its keyed 400/404. */
export class RuntimeConfigError extends Error {
  readonly reason: RuntimeConfigRefusal;

  constructor(reason: RuntimeConfigRefusal, message: string) {
    super(message);
    this.name = "RuntimeConfigError";
    this.reason = reason;
  }
}

/** The two caps and the value they resolve to. */
export type EffectiveConcurrency = {
  system: number;
  workspace: number;
  effective: number;
  degraded: boolean;
  reason?: DegradedReason;
};

type RuntimeSettingRow = { value?: unknown };

/**
 * The system cap on its own: an absent row reads as the default, anything
 * untrusted as 1 with `degraded: true`, and a read failure answers the same
 * conservative pair (the module's read contract).
 */
export async function getSystemConcurrency(db: DashboardD1): Promise<ConcurrencyRead> {
  try {
    const row = await db
      .prepare("SELECT value FROM review_runtime_settings WHERE key = ?")
      .bind(SYSTEM_CONCURRENCY_KEY)
      .first<RuntimeSettingRow>();
    return resolveRow(row, SYSTEM_CONCURRENCY_DEFAULT, (value) =>
      parseInRange(value, CONCURRENCY_MIN, SYSTEM_CONCURRENCY_MAX),
    );
  } catch {
    return { concurrency: CONCURRENCY_MIN, degraded: true, reason: "read-failed" };
  }
}

/**
 * The workspace cap on its own — the tenant face's read. It never touches the
 * system row: a corrupt platform value must not blank a workspace whose own
 * column is perfectly readable (the tenant cannot see or repair that row).
 * An absent column is the default; an untrusted one or a read failure answers
 * 1 with `degraded: true`.
 */
export async function getWorkspaceConcurrency(
  db: DashboardD1,
  workspaceId: string,
): Promise<ConcurrencyRead> {
  try {
    const row = await db
      .prepare(
        "SELECT max_concurrent_reviews AS value FROM workspaces WHERE id = ? AND deleted_at IS NULL",
      )
      .bind(workspaceId)
      .first<RuntimeSettingRow>();
    return resolveRow(row, WORKSPACE_CONCURRENCY_DEFAULT, parseWorkspaceStored);
  } catch {
    return { concurrency: CONCURRENCY_MIN, degraded: true, reason: "read-failed" };
  }
}

function degradedConcurrency(reason: DegradedReason): EffectiveConcurrency {
  return {
    system: CONCURRENCY_MIN,
    workspace: CONCURRENCY_MIN,
    effective: CONCURRENCY_MIN,
    degraded: true,
    reason,
  };
}

/**
 * Both caps in ONE statement (one read per decision point), resolved to the
 * effective value. Any read failure — thrown, no result row, or a present
 * value the parse cannot trust — answers the conservative cap with
 * `degraded: true`; it never throws and never fails open to unlimited.
 * A retired workspace (`deleted_at IS NOT NULL`) is absent, not untrusted: its
 * subquery yields NULL and the workspace cap takes the default.
 */
export async function getEffectiveConcurrency(
  db: DashboardD1,
  workspaceId: string,
): Promise<EffectiveConcurrency> {
  try {
    const row = await db
      .prepare(
        `SELECT (SELECT value FROM review_runtime_settings WHERE key = ?1) AS system_value,
                (SELECT max_concurrent_reviews FROM workspaces WHERE id = ?2 AND deleted_at IS NULL) AS workspace_value`,
      )
      .bind(SYSTEM_CONCURRENCY_KEY, workspaceId)
      .first<{ system_value?: unknown; workspace_value?: unknown }>();
    if (row === null) return degradedConcurrency("malformed");
    if (row.system_value === undefined || row.workspace_value === undefined) {
      return degradedConcurrency("malformed");
    }
    const storedSystem = parseInRange(row.system_value, CONCURRENCY_MIN, SYSTEM_CONCURRENCY_MAX);
    const storedWorkspace = parseWorkspaceStored(row.workspace_value);
    if (Number.isNaN(storedSystem) || Number.isNaN(storedWorkspace)) {
      return degradedConcurrency("untrusted");
    }
    const system = storedSystem ?? SYSTEM_CONCURRENCY_DEFAULT;
    const workspace = storedWorkspace ?? WORKSPACE_CONCURRENCY_DEFAULT;
    return { system, workspace, effective: Math.min(system, workspace), degraded: false };
  } catch {
    return degradedConcurrency("read-failed");
  }
}

/**
 * One stored integer as SQL, under the audit ledger's trust rule: a canonical
 * min..max numeric value is that integer, anything else is `untrusted`. One
 * fragment, so the concurrency rows and the check-budget rows cannot drift
 * apart on what "trusted" means.
 *
 * It is deliberately stricter than `parseInRange`, which accepts any string
 * `Number()` turns into an in-range integer (`'8.0'`, `'1e1'`, `'+8'`): those
 * read as values but are ledgered as `before: null`. `shortcut: a non-canonical
 * numeric text is readable but not auditable, upgrade if a non-canonical
 * writer ever exists`.
 */
const trustedIntSql = (value: string, untrusted: string, min: number, max: number) => `CASE
      WHEN ${value} NOT GLOB '*[^0-9]*' AND CAST(${value} AS INTEGER) BETWEEN ${min} AND ${max}
      THEN CAST(${value} AS INTEGER) ELSE ${untrusted} END`;

const storedSystemCapSql = (keyParam: string, untrusted: string) =>
  `(SELECT ${trustedIntSql("value", untrusted, CONCURRENCY_MIN, SYSTEM_CONCURRENCY_MAX)} FROM review_runtime_settings WHERE key = ${keyParam})`;

const storedBudgetSql = (keyParam: string, untrusted: string, min: number, max: number) =>
  `(SELECT ${trustedIntSql("value", untrusted, min, max)} FROM review_runtime_settings WHERE key = ${keyParam})`;

const SYSTEM_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'runtime.concurrency.system.set', 'runtime', ?3,
          json_object('before', ${storedSystemCapSql("?6", "NULL")},
                      'after', ?4),
          ?5)`;

const SYSTEM_UPSERT_SQL = `
  INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT (key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by`;

const workspaceAuditCapSql = (value: string) => `CASE
      WHEN ${value} NOT GLOB '*[^0-9]*' AND CAST(${value} AS INTEGER) > ${WORKSPACE_CONCURRENCY_MAX}
        THEN ${WORKSPACE_CONCURRENCY_MAX}
      WHEN ${value} NOT GLOB '*[^0-9]*' AND CAST(${value} AS INTEGER) BETWEEN ${CONCURRENCY_MIN} AND ${WORKSPACE_CONCURRENCY_MAX}
        THEN CAST(${value} AS INTEGER)
      ELSE NULL END`;

const WORKSPACE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?1, ?2, 'workspace.concurrency.set', 'workspace', ?3,
         json_object('before', (SELECT ${workspaceAuditCapSql("max_concurrent_reviews")}
                                  FROM workspaces WHERE id = ?3),
                     'after', ?4),
         ?5
   WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?3 AND deleted_at IS NULL)`;

const WORKSPACE_UPDATE_SQL = `
  UPDATE workspaces SET max_concurrent_reviews = ?2
   WHERE id = ?1 AND deleted_at IS NULL`;

/** Set the system cap. Audited with the actor; returns the stored value. */
export async function setSystemConcurrency(
  db: DashboardD1,
  value: number,
  actor: string,
): Promise<number> {
  if (!isConcurrencyValue(value, SYSTEM_CONCURRENCY_MAX)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `concurrency must be an integer in ${CONCURRENCY_MIN}..${SYSTEM_CONCURRENCY_MAX}`,
    );
  }
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(SYSTEM_AUDIT_SQL)
      .bind(crypto.randomUUID(), actor, SYSTEM_CONCURRENCY_KEY, value, now, SYSTEM_CONCURRENCY_KEY),
    db.prepare(SYSTEM_UPSERT_SQL).bind(SYSTEM_CONCURRENCY_KEY, String(value), now, actor),
  ]);
  return value;
}

/**
 * Set the workspace cap. The value is validated against the workspace maximum
 * only; an unknown workspace is `unknown_workspace`. Accepted writes are
 * audited and return the stored value. The system quota is never compared
 * here — it applies at admission and stays out of the tenant's answers.
 */
export async function setWorkspaceConcurrency(
  db: DashboardD1,
  workspaceId: string,
  value: number,
  actor: string,
): Promise<number> {
  if (!isConcurrencyValue(value, WORKSPACE_CONCURRENCY_MAX)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `concurrency must be an integer in ${CONCURRENCY_MIN}..${WORKSPACE_CONCURRENCY_MAX}`,
    );
  }
  const now = new Date().toISOString();
  const [, update] = await db.batch([
    db
      .prepare(WORKSPACE_AUDIT_SQL)
      .bind(crypto.randomUUID(), actor, workspaceId, value, now),
    db.prepare(WORKSPACE_UPDATE_SQL).bind(workspaceId, value),
  ]);
  if (update?.meta.changes === 1) return value;

  throw new UnknownWorkspaceError(workspaceId);
}

/**
 * The floor a newly connected App of this workspace starts at. NULL is the
 * absent state and reads as the platform default; a stored value outside
 * 0..100 is untrusted, so the read answers the default with `degraded: true`
 * rather than inventing a floor nobody stored.
 */
export type CheckMinScoreRead = {
  minScore: number;
  degraded: boolean;
  reason?: DegradedReason;
};

function degradedCheckMinScore(reason: DegradedReason): CheckMinScoreRead {
  return { minScore: DEFAULT_CHECK_MIN_SCORE, degraded: true, reason };
}

/**
 * The one schema gap this read has copy for: `workspaces.check_min_score`
 * missing during the deploy window before migration 0049 applies. Any other
 * missing column or table is a read failure — the malformed copy would send the
 * operator to a migration that cannot repair it.
 */
export function isFloorColumnMissingError(error: unknown): boolean {
  return /no such column: check_min_score\b/i.test(
    String(error instanceof Error ? error.message : error),
  );
}

/** The tenant face's read of the workspace's default floor. */
export async function getWorkspaceCheckMinScore(
  db: DashboardD1,
  workspaceId: string,
): Promise<CheckMinScoreRead> {
  try {
    const row = await db
      .prepare("SELECT check_min_score AS value FROM workspaces WHERE id = ? AND deleted_at IS NULL")
      .bind(workspaceId)
      .first<RuntimeSettingRow>();
    if (row === null) return { minScore: DEFAULT_CHECK_MIN_SCORE, degraded: false };
    if (row.value === undefined) return degradedCheckMinScore("malformed");
    if (row.value === null) return { minScore: DEFAULT_CHECK_MIN_SCORE, degraded: false };
    return isCheckMinScoreValue(row.value)
      ? { minScore: row.value, degraded: false }
      : degradedCheckMinScore("untrusted");
  } catch (error) {
    return degradedCheckMinScore(isFloorColumnMissingError(error) ? "malformed" : "read-failed");
  }
}


/** A refused write against a workspace id that does not exist. */
export class UnknownWorkspaceError extends RuntimeConfigError {
  constructor(workspaceId: string) {
    super("unknown_workspace", `no workspace ${workspaceId}`);
    this.name = "UnknownWorkspaceError";
  }
}

/**
 * The two §7.10 check budgets and whether the stored rows could be trusted.
 * `degraded: true` means at least one stored value was untrusted or the read
 * failed, so BOTH answers are the documented defaults.
 */
export type CheckBudgets = {
  terminalizeMs: number;
  updateMs: number;
  degraded: boolean;
  reason?: DegradedReason;
};

/** The pair an accepted write carries. */
export type CheckBudgetValues = { terminalizeMs: number; updateMs: number };

function degradedCheckBudgets(reason: DegradedReason): CheckBudgets {
  return {
    terminalizeMs: CHECK_TERMINALIZE_DEFAULT,
    updateMs: CHECK_UPDATE_DEFAULT,
    degraded: true,
    reason,
  };
}

/**
 * Both check budgets in ONE statement (one read per decision point). Only an
 * absent row is the default; a present value the parse cannot trust, a
 * malformed result row or a read failure answers the defaults with
 * `degraded: true` and never throws — a Check never blocks or delays the
 * review, so there is no conservative fallback smaller than the default worth
 * inventing.
 */
export async function getCheckBudgets(db: DashboardD1): Promise<CheckBudgets> {
  try {
    const row = await db
      .prepare(
        `SELECT (SELECT value FROM review_runtime_settings WHERE key = ?1) AS terminalize_value,
                (SELECT value FROM review_runtime_settings WHERE key = ?2) AS update_value`,
      )
      .bind(CHECK_TERMINALIZE_KEY, CHECK_UPDATE_KEY)
      .first<{ terminalize_value?: unknown; update_value?: unknown }>();
    if (row === null) return degradedCheckBudgets("malformed");
    if (row.terminalize_value === undefined || row.update_value === undefined) {
      return degradedCheckBudgets("malformed");
    }
    const terminalize = parseInRange(
      row.terminalize_value,
      CHECK_TERMINALIZE_MIN,
      CHECK_TERMINALIZE_MAX,
    );
    const update = parseInRange(row.update_value, CHECK_UPDATE_MIN, CHECK_UPDATE_MAX);
    if (Number.isNaN(terminalize) || Number.isNaN(update)) {
      return degradedCheckBudgets("untrusted");
    }
    return {
      terminalizeMs: terminalize ?? CHECK_TERMINALIZE_DEFAULT,
      updateMs: update ?? CHECK_UPDATE_DEFAULT,
      degraded: false,
    };
  } catch {
    return degradedCheckBudgets("read-failed");
  }
}

const CHECK_BUDGETS_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'runtime.check_budgets.set', 'runtime', '${CHECK_BUDGETS_TARGET}',
          json_object('before', json_object(
                      'terminalizeMs', ${storedBudgetSql("?6", "NULL", CHECK_TERMINALIZE_MIN, CHECK_TERMINALIZE_MAX)},
                      'updateMs', ${storedBudgetSql("?7", "NULL", CHECK_UPDATE_MIN, CHECK_UPDATE_MAX)}),
                      'after', json_object('terminalizeMs', ?3, 'updateMs', ?4)),
          ?5)`;

/**
 * Write both check budgets. A value outside its own range refuses the whole
 * write (`invalid_value`) with no row and no audit entry; an accepted pair is
 * audited with the actor in ONE batch and returned.
 */
export async function setCheckBudgets(
  db: DashboardD1,
  value: CheckBudgetValues,
  actor: string,
): Promise<CheckBudgetValues> {
  if (!isIntegerIn(value.terminalizeMs, CHECK_TERMINALIZE_MIN, CHECK_TERMINALIZE_MAX)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `terminalize timeout must be an integer in ${CHECK_TERMINALIZE_MIN}..${CHECK_TERMINALIZE_MAX}`,
    );
  }
  if (!isIntegerIn(value.updateMs, CHECK_UPDATE_MIN, CHECK_UPDATE_MAX)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `check update budget must be an integer in ${CHECK_UPDATE_MIN}..${CHECK_UPDATE_MAX}`,
    );
  }
  if (value.terminalizeMs <= value.updateMs) {
    throw new RuntimeConfigError(
      "invalid_value",
      "the terminalize timeout must be greater than the check update budget",
    );
  }
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(CHECK_BUDGETS_AUDIT_SQL)
      .bind(
        crypto.randomUUID(),
        actor,
        value.terminalizeMs,
        value.updateMs,
        now,
        CHECK_TERMINALIZE_KEY,
        CHECK_UPDATE_KEY,
      ),
    db
      .prepare(SYSTEM_UPSERT_SQL)
      .bind(CHECK_TERMINALIZE_KEY, String(value.terminalizeMs), now, actor),
    db.prepare(SYSTEM_UPSERT_SQL).bind(CHECK_UPDATE_KEY, String(value.updateMs), now, actor),
  ]);
  return value;
}

/** PK of the end-to-end review attempt cap (the Workflow route's hard stop). */
export const REVIEW_ATTEMPT_CAP_KEY = "review.attempt.duration_cap_ms";
/**
 * Absent row: 20 minutes. The 30-day successful-review sample (n = 1 361) had
 * p50 304 584 ms, p90 508 800 ms and max 647 553 ms; 20 minutes leaves those
 * tails room for queue wait, execution and publication while still bounding
 * capacity. Absent must mean neither "no cap" nor "cap of zero".
 */
export const REVIEW_ATTEMPT_CAP_DEFAULT_MS = 1_200_000;
/**
 * Range of a stored cap. Below the retired 900 000 ms Queue wall clock a cap
 * would cut reviews the platform was already completing; one hour is the most
 * capacity one attempt may hold.
 */
export const REVIEW_ATTEMPT_CAP_MIN_MS = 900_000;
export const REVIEW_ATTEMPT_CAP_MAX_MS = 3_600_000;

/** One cap read: the effective value, plus whether the stored row could be trusted. */
export type ReviewAttemptCap = {
  capMs: number;
  degraded: boolean;
  reason?: DegradedReason;
};

/**
 * The cap plus WHERE its number came from. `saved` is true only when a stored
 * row parsed in range, so the operator surface can show an absent row as the
 * default instead of claiming a value the store does not hold.
 */
export type ReviewAttemptCapSetting = ReviewAttemptCap & { saved: boolean };

/**
 * The end-to-end attempt cap in ONE read, plus whether a stored row produced
 * it. Only an absent row is the default; a present value the parse cannot
 * trust or a read failure answers the default with `degraded: true` and never
 * throws — admission REFUSES a degraded answer (retrying the delivery) and the
 * operator surface reports it as unreadable instead of showing a number.
 */
export async function getReviewAttemptCapSetting(
  db: DashboardD1,
): Promise<ReviewAttemptCapSetting> {
  try {
    const row = await db
      .prepare(`SELECT value FROM review_runtime_settings WHERE key = ?1`)
      .bind(REVIEW_ATTEMPT_CAP_KEY)
      .first<RuntimeSettingRow>();
    if (row === null) {
      return { capMs: REVIEW_ATTEMPT_CAP_DEFAULT_MS, saved: false, degraded: false };
    }
    if (row.value === undefined) {
      return {
        capMs: REVIEW_ATTEMPT_CAP_DEFAULT_MS,
        saved: false,
        degraded: true,
        reason: "malformed",
      };
    }
    const capMs = parseInRange(row.value, REVIEW_ATTEMPT_CAP_MIN_MS, REVIEW_ATTEMPT_CAP_MAX_MS);
    if (Number.isNaN(capMs)) {
      return {
        capMs: REVIEW_ATTEMPT_CAP_DEFAULT_MS,
        saved: false,
        degraded: true,
        reason: "untrusted",
      };
    }
    return capMs === undefined
      ? { capMs: REVIEW_ATTEMPT_CAP_DEFAULT_MS, saved: false, degraded: false }
      : { capMs, saved: true, degraded: false };
  } catch {
    return { capMs: REVIEW_ATTEMPT_CAP_DEFAULT_MS, saved: false, degraded: true, reason: "read-failed" };
  }
}

/** The enforcement read: the effective cap of {@link getReviewAttemptCapSetting}. */
export async function getReviewAttemptCap(db: DashboardD1): Promise<ReviewAttemptCap> {
  const { capMs, degraded, reason } = await getReviewAttemptCapSetting(db);
  return reason === undefined ? { capMs, degraded } : { capMs, degraded, reason };
}

/** The review route's operating switch: `on` admits a queue delivery to a Workflow. */
export const REVIEW_ROUTE_WORKFLOW_KEY = "review.route.workflow";

/** PK of the lost-reply observation window (the paid exec's reply never arrived). */
export const LOST_REPLY_SETTLE_KEY = "review.lostReply.settle_ms";
/**
 * Absent row: 15 minutes PAST the attempt's own deadline. The window anchors on
 * the attempt's hard stop — the runner budget and the kill grace already live
 * inside the deadline, so this default only buys a generous post-deadline
 * grace; a longer window costs a slot held longer, never a live paid child.
 */
export const LOST_REPLY_SETTLE_DEFAULT_MS = 900_000;
/**
 * Range of a stored window: the POST-DEADLINE grace only. The attempt deadline
 * already kills the container, so the floor must cover just what may still run
 * after it — the up-to-four 30 s post-runner reads (`POST_RUNNER_READ_TIMEOUT_MS`,
 * kept as a literal because `review-budget` imports this module) plus a 60 s
 * hand-off margin for this pass to reach the same store. Anything above the
 * floor is harmless to a live child; one hour is the most grace an operator
 * may want to grant.
 */
export const LOST_REPLY_SETTLE_MIN_MS = 180_000;
export const LOST_REPLY_SETTLE_MAX_MS = 3_600_000;

/** The window and whether the stored value could be trusted. */
export type LostReplySettleRead = { settleMs: number; degraded: boolean; reason?: DegradedReason };

/**
 * The lost-reply window on its own. Only an absent row is the default; an
 * untrusted stored value or a read failure answers the default with
 * `degraded: true` and never throws — the reconciliation pass must still run.
 */
export async function getLostReplySettleMs(db: DashboardD1): Promise<LostReplySettleRead> {
  try {
    const row = await db
      .prepare(`SELECT value FROM review_runtime_settings WHERE key = ?1`)
      .bind(LOST_REPLY_SETTLE_KEY)
      .first<RuntimeSettingRow>();
    if (row === null) return { settleMs: LOST_REPLY_SETTLE_DEFAULT_MS, degraded: false };
    if (row.value === undefined) {
      return { settleMs: LOST_REPLY_SETTLE_DEFAULT_MS, degraded: true, reason: "malformed" };
    }
    const parsed = parseInRange(row.value, LOST_REPLY_SETTLE_MIN_MS, LOST_REPLY_SETTLE_MAX_MS);
    if (Number.isNaN(parsed)) {
      return { settleMs: LOST_REPLY_SETTLE_DEFAULT_MS, degraded: true, reason: "untrusted" };
    }
    return { settleMs: parsed ?? LOST_REPLY_SETTLE_DEFAULT_MS, degraded: false };
  } catch {
    return { settleMs: LOST_REPLY_SETTLE_DEFAULT_MS, degraded: true, reason: "read-failed" };
  }
}

const LOST_REPLY_SETTLE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'runtime.lost_reply_settle.set', 'runtime', ?3,
          json_object('before', json_object('settleMs', ${storedBudgetSql("?5", "NULL", LOST_REPLY_SETTLE_MIN_MS, LOST_REPLY_SETTLE_MAX_MS)}),
                      'after', json_object('settleMs', ?4)),
          ?6)`;

/**
 * Set the lost-reply window. A value outside its range refuses the write
 * (`invalid_value`) with no row and no audit entry; an accepted value is
 * audited with the actor in ONE batch and returned.
 */
export async function setLostReplySettleMs(
  db: DashboardD1,
  value: number,
  actor: string,
): Promise<number> {
  if (!isIntegerIn(value, LOST_REPLY_SETTLE_MIN_MS, LOST_REPLY_SETTLE_MAX_MS)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `the lost-reply window must be an integer in ${LOST_REPLY_SETTLE_MIN_MS}..${LOST_REPLY_SETTLE_MAX_MS} ms`,
    );
  }
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(LOST_REPLY_SETTLE_AUDIT_SQL)
      .bind(crypto.randomUUID(), actor, LOST_REPLY_SETTLE_KEY, value, LOST_REPLY_SETTLE_KEY, now),
    db.prepare(SYSTEM_UPSERT_SQL).bind(LOST_REPLY_SETTLE_KEY, String(value), now, actor),
  ]);
  return value;
}

/**
 * The gate's answer. `off` is the answer for an ABSENT row, a stored `off`, an
 * untrusted value and an unreadable row alike — the modes are deliberately not
 * a boolean, because "the operator has not turned this on" and "the row cannot
 * be trusted" are different operating facts with the same refusal.
 */
export type ReviewRouteWorkflowGate = {
  mode: "on" | "off";
  saved: boolean;
  degraded: boolean;
  reason?: "malformed" | "untrusted" | "read-failed";
  rejected?: string;
};

/**
 * May a queue delivery create a Workflow instance? The setting is the gate:
 * absent is OFF (a fresh deploy must not route live reviews just because the
 * migration shipped), a stored `on` is the only admission, and every
 * unreadable shape is OFF — a refusal, never permission. The consumer's queue
 * handler reads this per batch; nothing else in the pipeline consults it.
 */
export async function getReviewRouteWorkflowGate(
  db: DashboardD1,
): Promise<ReviewRouteWorkflowGate> {
  try {
    const row = await db
      .prepare(`SELECT value FROM review_runtime_settings WHERE key = ?1`)
      .bind(REVIEW_ROUTE_WORKFLOW_KEY)
      .first<RuntimeSettingRow>();
    if (row === null) return { mode: "off", saved: false, degraded: false };
    if (row.value === undefined) {
      return { mode: "off", saved: false, degraded: true, reason: "malformed" };
    }
    const raw = row.value;
    if (raw === "on") return { mode: "on", saved: true, degraded: false };
    if (raw === "off") return { mode: "off", saved: true, degraded: false };
    return {
      mode: "off",
      saved: false,
      degraded: true,
      reason: "untrusted",
      rejected: typeof raw === "string" ? JSON.stringify(raw) : String(raw),
    };
  } catch {
    return { mode: "off", saved: false, degraded: true, reason: "read-failed" };
  }
}

/** The platform switch as both the queue and the operator answer read it. */
export type ReviewPlatformRead = { enabled: boolean; unreadable: boolean };

/**
 * The ONE answer to "are reviews running": a deliberate pause, a deployment
 * that has not opened the route, or running. Never a boolean — the three
 * answers name different operator actions.
 */
export type ReviewsRunAnswer = "running" | "paused-platform" | "blocked-deployment-gate";

/** The answer plus the two raw facts it was derived from. */
export type ReviewRunState = {
  state: ReviewsRunAnswer;
  gate: ReviewRouteWorkflowGate;
  platform: ReviewPlatformRead;
};

/**
 * The state machine BOTH the queue batch and the operator answer read, so they
 * can never name different causes for the same deployment.
 *
 * Precedence is the queue's, because the queue is the thing that acts:
 *
 * 1. A gate that is not `on` (absent, `off`, untrusted, unreadable) is
 *    `blocked-deployment-gate`. It is a fact about the deployment, and it
 *    outranks a paused platform: with both closed the deliveries are refused by
 *    the gate, so the answer must not claim the platform pause settled them.
 * 2. An unreadable platform flag is `blocked-deployment-gate` too — never
 *    `running`, and never a pause nothing can prove.
 * 3. Only a readable `off` is `paused-platform`.
 */
export async function reviewRunState(db: DashboardD1): Promise<ReviewRunState> {
  const gate = await getReviewRouteWorkflowGate(db);
  let platform: ReviewPlatformRead;
  try {
    platform = { enabled: await isFlagEnabled(db, "review_global"), unreadable: false };
  } catch {
    platform = { enabled: false, unreadable: true };
  }
  if (gate.mode !== "on" || gate.degraded) return { state: "blocked-deployment-gate", gate, platform };
  if (platform.unreadable) return { state: "blocked-deployment-gate", gate, platform };
  return { state: platform.enabled ? "running" : "paused-platform", gate, platform };
}

const REVIEW_ATTEMPT_CAP_TARGET = "review.attempt.duration_cap";

const REVIEW_ATTEMPT_CAP_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'runtime.attempt_cap.set', 'runtime', ?3,
          json_object('before', ${storedBudgetSql("?5", "NULL", REVIEW_ATTEMPT_CAP_MIN_MS, REVIEW_ATTEMPT_CAP_MAX_MS)},
                      'after', ?4),
          ?6)`;

/**
 * Set the end-to-end attempt cap. A value outside its range refuses the write
 * (`invalid_value`, the accepted range named in the message) with no row and
 * no audit entry; an accepted value is audited with the actor in ONE batch and
 * returned.
 */
export async function setReviewAttemptCap(
  db: DashboardD1,
  value: number,
  actor: string,
): Promise<number> {
  if (!isIntegerIn(value, REVIEW_ATTEMPT_CAP_MIN_MS, REVIEW_ATTEMPT_CAP_MAX_MS)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `the attempt cap must be an integer in ${REVIEW_ATTEMPT_CAP_MIN_MS}..${REVIEW_ATTEMPT_CAP_MAX_MS} ms`,
    );
  }
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(REVIEW_ATTEMPT_CAP_AUDIT_SQL)
      .bind(crypto.randomUUID(), actor, REVIEW_ATTEMPT_CAP_TARGET, value, REVIEW_ATTEMPT_CAP_KEY, now),
    db.prepare(SYSTEM_UPSERT_SQL).bind(REVIEW_ATTEMPT_CAP_KEY, String(value), now, actor),
  ]);
  return value;
}

/**
 * The comment-claim outbox settings (migration 0048) and whether the stored
 * rows could be trusted. Global like the check budgets — one outbox per
 * deployment. `degraded: true` means at least one stored value was untrusted
 * or the read failed, so ALL answers are the documented defaults.
 */
export type CommentClaimSettings = {
  retryMs: number;
  maxAttempts: number;
  outboxCap: number;
  degraded: boolean;
};

/** The trio an accepted write carries. */
export type CommentClaimValues = { retryMs: number; maxAttempts: number; outboxCap: number };

function degradedCommentClaimSettings(): CommentClaimSettings {
  return {
    retryMs: COMMENT_CLAIM_RETRY_DEFAULT,
    maxAttempts: COMMENT_CLAIM_ATTEMPTS_DEFAULT,
    outboxCap: COMMENT_CLAIM_OUTBOX_DEFAULT,
    degraded: true,
  };
}

/**
 * All three comment-claim settings in ONE statement (one read per sweep).
 * Only an absent row is the default; a present value the parse cannot trust, a
 * malformed result row or a read failure answers the defaults with
 * `degraded: true` and never throws — a broken settings read must not stop the
 * cron from recovering a claim, and there is no safer fallback than the
 * documented window/cap.
 */
export async function getCommentClaimSettings(db: DashboardD1): Promise<CommentClaimSettings> {
  try {
    const row = await db
      .prepare(
        `SELECT (SELECT value FROM review_runtime_settings WHERE key = ?1) AS retry_value,
                (SELECT value FROM review_runtime_settings WHERE key = ?2) AS attempts_value,
                (SELECT value FROM review_runtime_settings WHERE key = ?3) AS outbox_value`,
      )
      .bind(COMMENT_CLAIM_RETRY_KEY, COMMENT_CLAIM_ATTEMPTS_KEY, COMMENT_CLAIM_OUTBOX_KEY)
      .first<{ retry_value?: unknown; attempts_value?: unknown; outbox_value?: unknown }>();
    if (row === null) return degradedCommentClaimSettings();
    if (
      row.retry_value === undefined ||
      row.attempts_value === undefined ||
      row.outbox_value === undefined
    ) {
      return degradedCommentClaimSettings();
    }
    const retryMs = parseInRange(row.retry_value, COMMENT_CLAIM_RETRY_MIN, COMMENT_CLAIM_RETRY_MAX);
    const maxAttempts = parseInRange(
      row.attempts_value,
      COMMENT_CLAIM_ATTEMPTS_MIN,
      COMMENT_CLAIM_ATTEMPTS_MAX,
    );
    const outboxCap = parseInRange(row.outbox_value, COMMENT_CLAIM_OUTBOX_MIN, COMMENT_CLAIM_OUTBOX_MAX);
    if (Number.isNaN(retryMs) || Number.isNaN(maxAttempts) || Number.isNaN(outboxCap)) {
      return degradedCommentClaimSettings();
    }
    return {
      retryMs: retryMs ?? COMMENT_CLAIM_RETRY_DEFAULT,
      maxAttempts: maxAttempts ?? COMMENT_CLAIM_ATTEMPTS_DEFAULT,
      outboxCap: outboxCap ?? COMMENT_CLAIM_OUTBOX_DEFAULT,
      degraded: false,
    };
  } catch {
    return degradedCommentClaimSettings();
  }
}

/** PK of the recheck seat's ask-budget row. */
export const RECHECK_ASSIGNMENT_KEY = "review.recheck.assignment_max_bytes";
/** Absent row: the seat's documented ask budget (the runner's default). */
export const RECHECK_ASSIGNMENT_DEFAULT = 65_536;
/**
 * Range of a stored budget. Below the floor the ask cannot even carry its own
 * prose plus a target core, so every round would skip; above the ceiling the
 * ask is larger than any supported window can hold.
 */
export const RECHECK_ASSIGNMENT_MIN = 8_192;
export const RECHECK_ASSIGNMENT_MAX = 262_144;

/** The ask budget and whether the stored value could be trusted. */
export type RecheckAssignmentRead = { maxBytes: number; degraded: boolean };

/**
 * The recheck seat's ask budget on its own. Only an absent row is the default;
 * an untrusted stored value or a read failure answers the default with
 * `degraded: true` and never throws — a round must still be asked.
 */
export async function getRecheckAssignmentMaxBytes(db: DashboardD1): Promise<RecheckAssignmentRead> {
  try {
    const row = await db
      .prepare(`SELECT value FROM review_runtime_settings WHERE key = ?1`)
      .bind(RECHECK_ASSIGNMENT_KEY)
      .first<RuntimeSettingRow>();
    if (row === null) return { maxBytes: RECHECK_ASSIGNMENT_DEFAULT, degraded: false };
    if (row === undefined || row.value === undefined) {
      return { maxBytes: RECHECK_ASSIGNMENT_DEFAULT, degraded: true };
    }
    const parsed = parseInRange(row.value, RECHECK_ASSIGNMENT_MIN, RECHECK_ASSIGNMENT_MAX);
    if (Number.isNaN(parsed)) return { maxBytes: RECHECK_ASSIGNMENT_DEFAULT, degraded: true };
    return { maxBytes: parsed ?? RECHECK_ASSIGNMENT_DEFAULT, degraded: false };
  } catch {
    return { maxBytes: RECHECK_ASSIGNMENT_DEFAULT, degraded: true };
  }
}

const COMMENT_CLAIM_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'runtime.comment_claim.set', 'runtime', '${COMMENT_CLAIM_TARGET}',
          json_object('before', json_object(
                      'retryMs', ${storedBudgetSql("?7", "NULL", COMMENT_CLAIM_RETRY_MIN, COMMENT_CLAIM_RETRY_MAX)},
                      'maxAttempts', ${storedBudgetSql("?8", "NULL", COMMENT_CLAIM_ATTEMPTS_MIN, COMMENT_CLAIM_ATTEMPTS_MAX)},
                      'outboxCap', ${storedBudgetSql("?9", "NULL", COMMENT_CLAIM_OUTBOX_MIN, COMMENT_CLAIM_OUTBOX_MAX)}),
                      'after', json_object('retryMs', ?3, 'maxAttempts', ?4, 'outboxCap', ?5)),
          ?6)`;

/**
 * Write all three comment-claim settings. A value outside its own range
 * refuses the whole write (`invalid_value`) with no row and no audit entry; an
 * accepted trio is audited with the actor in ONE batch and returned. There is
 * no cross-field relation to enforce: unlike the Check pair, these three bound
 * independent resources (wait, attempts, batch size).
 */
export async function setCommentClaimSettings(
  db: DashboardD1,
  value: CommentClaimValues,
  actor: string,
): Promise<CommentClaimValues> {
  if (!isIntegerIn(value.retryMs, COMMENT_CLAIM_RETRY_MIN, COMMENT_CLAIM_RETRY_MAX)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `comment claim retry window must be an integer in ${COMMENT_CLAIM_RETRY_MIN}..${COMMENT_CLAIM_RETRY_MAX}`,
    );
  }
  if (!isIntegerIn(value.maxAttempts, COMMENT_CLAIM_ATTEMPTS_MIN, COMMENT_CLAIM_ATTEMPTS_MAX)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `comment claim attempts must be an integer in ${COMMENT_CLAIM_ATTEMPTS_MIN}..${COMMENT_CLAIM_ATTEMPTS_MAX}`,
    );
  }
  if (!isIntegerIn(value.outboxCap, COMMENT_CLAIM_OUTBOX_MIN, COMMENT_CLAIM_OUTBOX_MAX)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `comment claim outbox cap must be an integer in ${COMMENT_CLAIM_OUTBOX_MIN}..${COMMENT_CLAIM_OUTBOX_MAX}`,
    );
  }
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(COMMENT_CLAIM_AUDIT_SQL).bind(
      crypto.randomUUID(),
      actor,
      value.retryMs,
      value.maxAttempts,
      value.outboxCap,
      now,
      COMMENT_CLAIM_RETRY_KEY,
      COMMENT_CLAIM_ATTEMPTS_KEY,
      COMMENT_CLAIM_OUTBOX_KEY,
    ),
    db.prepare(SYSTEM_UPSERT_SQL).bind(COMMENT_CLAIM_RETRY_KEY, String(value.retryMs), now, actor),
    db.prepare(SYSTEM_UPSERT_SQL).bind(COMMENT_CLAIM_ATTEMPTS_KEY, String(value.maxAttempts), now, actor),
    db.prepare(SYSTEM_UPSERT_SQL).bind(COMMENT_CLAIM_OUTBOX_KEY, String(value.outboxCap), now, actor),
  ]);
  return value;
}

const RECHECK_ASSIGNMENT_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'runtime.recheck_assignment.set', 'runtime', '${RECHECK_ASSIGNMENT_KEY}',
          json_object('before', json_object('maxBytes', ${storedBudgetSql("?4", "NULL", RECHECK_ASSIGNMENT_MIN, RECHECK_ASSIGNMENT_MAX)}),
                      'after', json_object('maxBytes', ?3)),
          ?5)`;

/**
 * Set the ask budget. A value outside its range refuses the write
 * (`invalid_value`) with no row and no audit entry; an accepted value is
 * audited with the actor in ONE batch and returned.
 */
export async function setRecheckAssignmentMaxBytes(
  db: DashboardD1,
  value: number,
  actor: string,
): Promise<number> {
  if (!isIntegerIn(value, RECHECK_ASSIGNMENT_MIN, RECHECK_ASSIGNMENT_MAX)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `recheck assignment budget must be an integer in ${RECHECK_ASSIGNMENT_MIN}..${RECHECK_ASSIGNMENT_MAX}`,
    );
  }
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(RECHECK_ASSIGNMENT_AUDIT_SQL)
      .bind(crypto.randomUUID(), actor, value, RECHECK_ASSIGNMENT_KEY, now),
    db.prepare(SYSTEM_UPSERT_SQL).bind(RECHECK_ASSIGNMENT_KEY, String(value), now, actor),
  ]);
  return value;
}

/** The operator default and whether the stored value could be trusted. */
export type DefaultReviewLevelRead = { value: ReviewLevel; degraded: boolean };
/**
 * The operator default review depth on its own. Only an absent row is the
 * default; a present value off the shared vocabulary, a malformed result row or
 * a read failure answers the default with `degraded: true` and never throws —
 * a review must run, so there is no stricter fallback worth inventing. This is
 * the ONE read an App with no depth of its own costs.
 */
export async function readDefaultReviewLevel(db: DashboardD1): Promise<DefaultReviewLevelRead> {
  try {
    const row = await db
      .prepare("SELECT value FROM review_runtime_settings WHERE key = ?")
      .bind(REVIEW_LEVEL_KEY)
      .first<RuntimeSettingRow>();
    if (row === null) return { value: REVIEW_LEVEL_DEFAULT, degraded: false };
    return isReviewLevel(row.value)
      ? { value: row.value, degraded: false }
      : { value: REVIEW_LEVEL_DEFAULT, degraded: true };
  } catch {
    return { value: REVIEW_LEVEL_DEFAULT, degraded: true };
  }
}

const REVIEW_LEVEL_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'runtime.review_level.set', 'runtime', '${REVIEW_LEVEL_KEY}',
          json_object('before', (SELECT CASE
                      WHEN value IN (${REVIEW_LEVELS.map((level) => `'${level}'`).join(", ")}) THEN value
                      ELSE NULL END
                    FROM review_runtime_settings WHERE key = ?5),
                      'after', ?3),
          ?4)`;

/**
 * Set the operator default review depth. An off-vocabulary value refuses the
 * write (`invalid_value`) with no row and no audit entry; an accepted level is
 * audited with the actor in ONE batch and returned.
 */
export async function setDefaultReviewLevel(
  db: DashboardD1,
  value: ReviewLevel,
  actor: string,
): Promise<ReviewLevel> {
  if (!isReviewLevel(value)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `review level must be one of ${REVIEW_LEVELS.join(" | ")}`,
    );
  }
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(REVIEW_LEVEL_AUDIT_SQL)
      .bind(crypto.randomUUID(), actor, value, now, REVIEW_LEVEL_KEY),
    db.prepare(SYSTEM_UPSERT_SQL).bind(REVIEW_LEVEL_KEY, value, now, actor),
  ]);
  return value;
}

const RECONCILE_KEYS = RECONCILE_FIELDS.map((field) => RECONCILE_RULES[field].key);

type ReconcileSettingsIssue = { kind: "read_failed" } | { kind: "invalid_rows"; keys: string[] };

export async function getReconcileSettings(db: DashboardD1): Promise<{ values: ReconcileValues; issue: ReconcileSettingsIssue | null }> {
  try {
    const { results } = await db.prepare(`SELECT key, value FROM review_runtime_settings WHERE key IN (${RECONCILE_KEYS.map(() => "?").join(", ")})`)
      .bind(...RECONCILE_KEYS).all<{ key: string; value: unknown }>();
    const rows = new Map(results.map(({ key, value }) => [key, value]));
    const values = { ...RECONCILE_DEFAULTS };
    const invalid: ReconcileField[] = [];
    for (const field of RECONCILE_FIELDS) {
      const { key, min, max } = RECONCILE_RULES[field];
      if (!rows.has(key)) continue;
      const parsed = parseInRange(rows.get(key), min, max);
      if (parsed === undefined || Number.isNaN(parsed)) invalid.push(field);
      else values[field] = parsed;
    }
    invalid.push(...invalidReconcileRelations(values));
    if (invalid.length > 0) {
      return { values: { ...RECONCILE_DEFAULTS }, issue: { kind: "invalid_rows", keys: [...new Set(invalid.map((field) => RECONCILE_RULES[field].key))] } };
    }
    return { values, issue: null };
  } catch {
    return { values: { ...RECONCILE_DEFAULTS }, issue: { kind: "read_failed" } };
  }
}

const RECONCILE_BEFORE_SQL = RECONCILE_FIELDS.map((field, index) => {
  const { min, max } = RECONCILE_RULES[field];
  return `'${field}', ${storedBudgetSql(`?${index + 5}`, "NULL", min, max)}`;
}).join(", ");

const RECONCILE_AUDIT_SQL = `INSERT INTO platform_audit_events
  (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'platform.reconcile.set', 'runtime', 'platform.reconcile',
    json_object('before', json_object(${RECONCILE_BEFORE_SQL}), 'after', json(?3)), ?4)`;

export async function setReconcileSettings(db: DashboardD1, input: unknown, actor: string): Promise<ReconcileValues> {
  const source = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const values = {} as ReconcileValues;
  for (const field of RECONCILE_FIELDS) {
    const { min, max } = RECONCILE_RULES[field];
    const value = source[field];
    if (!isIntegerIn(value, min, max)) {
      throw new RuntimeConfigError("invalid_value", `reconcile.${field} must be an integer in ${min}..${max}; correct the field in Admin > Runtime and save again`);
    }
    values[field] = value;
  }
  const invalid = invalidReconcileRelations(values);
  if (invalid.length > 0) {
    throw new RuntimeConfigError("invalid_value", `reconcile budgets must satisfy per-request <= run budget, publication lane + thread operation (including cold credentials for a different App pair) <= lifecycle total requests, row <= Check total requests; correct ${invalid.join(", ")} in Admin > Runtime and save again`);
  }
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(RECONCILE_AUDIT_SQL).bind(crypto.randomUUID(), actor, JSON.stringify(values), now, ...RECONCILE_KEYS),
    ...RECONCILE_FIELDS.map((field) => db.prepare(SYSTEM_UPSERT_SQL).bind(RECONCILE_RULES[field].key, String(values[field]), now, actor)),
  ]);
  return values;
}

const SWEEP_RULES = {
  failureThreshold: { key: "platform.sweep.failure_threshold", fallback: QUEUE_MAX_ATTEMPTS + 1, min: 1, max: 10_000 },
  windowHours: { key: "platform.sweep.window_hours", fallback: 24, min: 1, max: 168 },
  webhookTimeoutMs: { key: "platform.sweep.webhook_timeout_ms", fallback: 3_000, min: 100, max: 15_000 },
  retentionDays: { key: "platform.sweep.retention_days", fallback: 30, min: 1, max: 365 },
  retentionCap: { key: "platform.sweep.retention_cap", fallback: 500, min: 1, max: 500 },
  inviteLapseCap: { key: "platform.sweep.invite_lapse_cap", fallback: 500, min: 1, max: 500 },
  pullRequestRetentionDays: { key: "platform.sweep.pull_request_retention_days", fallback: 90, min: 1, max: 365 },
  pullRequestRetentionCap: { key: "platform.sweep.pull_request_retention_cap", fallback: 500, min: 1, max: 500 },
} satisfies Record<SweepField, { key: string; fallback: number; min: number; max: number }>;

export const SWEEP_LIMITS = Object.fromEntries(
  SWEEP_FIELDS.map((field) => {
    const { min, max } = SWEEP_RULES[field];
    return [field, { min, max }];
  }),
) as SweepLimits;

const SWEEP_KEYS = SWEEP_FIELDS.map((field) => SWEEP_RULES[field].key);

type SweepSettingsIssue =
  | { kind: "read_failed"; error: unknown }
  | { kind: "invalid_rows"; keys: string[]; fields: SweepField[] };

export async function getSweepSettings(
  db: DashboardD1,
): Promise<{ values: SweepValues; issue: SweepSettingsIssue | null }> {
  let rows = new Map<string, unknown>();
  let issue: SweepSettingsIssue | null = null;
  try {
    const { results } = await db
      .prepare(`SELECT key, value FROM review_runtime_settings WHERE key IN (${SWEEP_KEYS.map(() => "?").join(", ")})`)
      .bind(...SWEEP_KEYS)
      .all<{ key: string; value: string }>();
    rows = new Map(results.map(({ key, value }) => [key, value]));
  } catch (error) {
    issue = { kind: "read_failed", error };
  }
  const values = {} as SweepValues;
  const invalidFields: SweepField[] = [];
  for (const field of SWEEP_FIELDS) {
    const { key, fallback, min, max } = SWEEP_RULES[field];
    const stored = parseInRange(rows.get(key), min, max);
    const trusted = stored !== undefined && !Number.isNaN(stored);
    if (rows.has(key) && !trusted) invalidFields.push(field);
    values[field] = trusted ? stored : fallback;
  }
  if (invalidFields.length > 0) {
    issue = { kind: "invalid_rows", keys: invalidFields.map((field) => SWEEP_RULES[field].key), fields: invalidFields };
  }
  return { values, issue };
}

const SWEEP_BEFORE_SQL = SWEEP_FIELDS.map((field, index) => {
  const { min, max } = SWEEP_RULES[field];
  return `'${field}', ${storedBudgetSql(`?${index + 5}`, "NULL", min, max)}`;
}).join(", ");

const SWEEP_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'platform.sweep.set', 'runtime', 'platform.sweep',
          json_object('before', json_object(${SWEEP_BEFORE_SQL}), 'after', json(?3)), ?4)`;

export async function setSweepSettings(
  db: DashboardD1,
  input: unknown,
  actor: string,
): Promise<SweepValues> {
  const source = input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const values = {} as SweepValues;
  for (const field of SWEEP_FIELDS) {
    const { min, max } = SWEEP_RULES[field];
    const value = source[field];
    if (!isIntegerIn(value, min, max)) {
      throw new RuntimeConfigError("invalid_value", `sweep.${field} must be an integer in ${min}..${max}`);
    }
    values[field] = value;
  }
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(SWEEP_AUDIT_SQL).bind(crypto.randomUUID(), actor, JSON.stringify(values), now, ...SWEEP_KEYS),
    ...SWEEP_FIELDS.map((field) =>
      db.prepare(SYSTEM_UPSERT_SQL).bind(SWEEP_RULES[field].key, String(values[field]), now, actor),
    ),
  ]);
  return values;
}

/**
 * The platform's official workspace: the one tenant whose bots may be offered
 * platform-wide. It is a global parameter, not a switch and not a tenant
 * column, so it rides this table as `platform.official_workspace_id`. An
 * ABSENT row is the legal steady state "no official workspace": it disables new
 * shares and nothing else.
 */
export const OFFICIAL_WORKSPACE_KEY = "platform.official_workspace_id";

/**
 * The registered domain prefixes of `review_runtime_settings`. The table is the
 * PLATFORM's parameter store, not a review-only one, and its keys group by
 * domain: `review.*` for review behaviour, `platform.*` for platform state.
 * Existing writers keep their constant keys; this registry is what stops the
 * next writer from turning the table into a general key/value store.
 */
export const RUNTIME_SETTING_DOMAINS = ["review.", "platform."] as const;

const SETTING_SEGMENT = "[a-z0-9_]+";

const RUNTIME_SETTING_KEY_PATTERN = new RegExp(
  `^(?:${RUNTIME_SETTING_DOMAINS.map((domain) => domain.replaceAll(".", "\\.")).join("|")})` +
    `${SETTING_SEGMENT}(?:\\.${SETTING_SEGMENT})*$`,
);

/** Is this key a member of a registered domain? See `RUNTIME_SETTING_DOMAINS`. */
export function isRuntimeSettingKey(key: unknown): key is string {
  return typeof key === "string" && RUNTIME_SETTING_KEY_PATTERN.test(key);
}

const OFFICIAL_WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const OFFICIAL_WORKSPACE_READ_SQL = `
  SELECT w.id AS id
    FROM review_runtime_settings s
    JOIN workspaces w ON w.id = s.value AND w.deleted_at IS NULL
   WHERE s.key = ?`;

export async function readOfficialWorkspaceId(db: DashboardD1): Promise<string | null> {
  const row = await db
    .prepare(OFFICIAL_WORKSPACE_READ_SQL)
    .bind(OFFICIAL_WORKSPACE_KEY)
    .first<{ id: string }>();
  return row?.id ?? null;
}

const OFFICIAL_WORKSPACE_SET_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?1, ?2, 'runtime.official_workspace.set', 'runtime',
         '${OFFICIAL_WORKSPACE_KEY}',
         json_object('before', (SELECT value FROM review_runtime_settings
                                 WHERE key = '${OFFICIAL_WORKSPACE_KEY}'),
                     'after', ?3),
         ?4
   WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?3 AND deleted_at IS NULL)`;

const OFFICIAL_WORKSPACE_SET_SQL = `
  INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
  SELECT ?1, ?2, ?3, ?4
   WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?2 AND deleted_at IS NULL)
  ON CONFLICT (key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by`;

const OFFICIAL_WORKSPACE_CLEAR_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?1, ?2, 'runtime.official_workspace.set', 'runtime',
         '${OFFICIAL_WORKSPACE_KEY}',
         json_object('before', (SELECT value FROM review_runtime_settings
                                 WHERE key = '${OFFICIAL_WORKSPACE_KEY}'),
                     'after', NULL),
         ?3
   WHERE EXISTS (SELECT 1 FROM review_runtime_settings
                  WHERE key = '${OFFICIAL_WORKSPACE_KEY}')`;

const OFFICIAL_WORKSPACE_CLEAR_SQL = `DELETE FROM review_runtime_settings WHERE key = ?1`;

/**
 * Set or clear the official workspace. An id must name a live workspace —
 * anything else is `unknown_workspace` with zero rows and zero audit rows — and
 * `null` clears the row. Returns the resulting id.
 */
export async function setOfficialWorkspace(
  db: DashboardD1,
  input: { workspaceId: string | null; actor: string; now: string },
): Promise<string | null> {
  const { workspaceId, actor, now } = input;

  if (workspaceId === null) {
    await db.batch([
      db.prepare(OFFICIAL_WORKSPACE_CLEAR_AUDIT_SQL).bind(crypto.randomUUID(), actor, now),
      db.prepare(OFFICIAL_WORKSPACE_CLEAR_SQL).bind(OFFICIAL_WORKSPACE_KEY),
    ]);
    return null;
  }

  const id = workspaceId.trim();
  if (!OFFICIAL_WORKSPACE_ID_PATTERN.test(id)) throw new UnknownWorkspaceError(workspaceId);
  const [, upsert] = await db.batch([
    db.prepare(OFFICIAL_WORKSPACE_SET_AUDIT_SQL).bind(crypto.randomUUID(), actor, id, now),
    db.prepare(OFFICIAL_WORKSPACE_SET_SQL).bind(OFFICIAL_WORKSPACE_KEY, id, now, actor),
  ]);
  if ((upsert?.meta.changes ?? 0) === 0) throw new UnknownWorkspaceError(workspaceId);
  return id;
}

/** The maintenance toggle: `'1'` while the platform is closed, `'0'` otherwise. */
export const MAINTENANCE_ENABLED_KEY = "platform.maintenance.enabled";
/** Why it is closed, as the Operator typed it. Absent = no reason given. */
export const MAINTENANCE_REASON_KEY = "platform.maintenance.reason";
/** When it closed, ISO-8601 UTC. Absent = never closed. */
export const MAINTENANCE_SINCE_KEY = "platform.maintenance.since";
const MAINTENANCE_TARGET = "platform.maintenance";

/**
 * Whether the platform is closed, and the window it was closed in.
 *
 * `unreadable` is the third state: the read failed, so nobody knows whether the
 * window is open. `enabled` stays `false` (nothing stated a close), but every
 * gate treats this as CLOSED — the window is the only fence around the
 * destructive backfill, and an unknowable fence is not an open one.
 */
export type MaintenanceMode = {
  enabled: boolean;
  reason: string | null;
  since: string | null;
  unreadable: boolean;
};

/**
 * The one predicate every traffic gate asks: is the platform closed? An
 * unreadable window counts as closed, so the backfill's only fence never
 * disappears because a settings read broke.
 */
export function maintenanceClosed(mode: MaintenanceMode): boolean {
  return mode.enabled || mode.unreadable;
}

/**
 * The maintenance window in ONE statement. Only an ABSENT `enabled` row is the
 * documented default — off. `reason` / `since` describe a running window only,
 * and the writer deletes both on disable, so a closed platform carries neither.
 *
 * It never throws, and it does not answer OPEN on a fault either: a read error
 * answers `unreadable: true` (with `enabled: false`) and logs one
 * `maintenance_read_failed` line, leaving the fail-closed decision to the gate.
 * Answering "open" here would let a settings outage unlock traffic mid-backfill
 * — the one thing the window exists to prevent.
 */
export async function getMaintenanceMode(db: DashboardD1): Promise<MaintenanceMode> {
  try {
    const rows = await db
      .prepare("SELECT key, value FROM review_runtime_settings WHERE key IN (?1, ?2, ?3)")
      .bind(MAINTENANCE_ENABLED_KEY, MAINTENANCE_REASON_KEY, MAINTENANCE_SINCE_KEY)
      .all<{ key: string; value: string }>();
    const stored = new Map(rows.results.map((row) => [row.key, row.value]));
    return {
      enabled: stored.get(MAINTENANCE_ENABLED_KEY) === "1",
      reason: stored.get(MAINTENANCE_REASON_KEY) ?? null,
      since: stored.get(MAINTENANCE_SINCE_KEY) ?? null,
      unreadable: false,
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "maintenance_read_failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    return { enabled: false, reason: null, since: null, unreadable: true };
  }
}

const MAINTENANCE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'platform.maintenance.set', 'runtime', '${MAINTENANCE_TARGET}',
          json_object('before', json_object(
                      'enabled', json(CASE WHEN (SELECT value FROM review_runtime_settings
                                                  WHERE key = '${MAINTENANCE_ENABLED_KEY}') = '1'
                                          THEN 'true' ELSE 'false' END),
                      'reason', (SELECT value FROM review_runtime_settings
                                  WHERE key = '${MAINTENANCE_REASON_KEY}'),
                      'since', (SELECT value FROM review_runtime_settings
                                 WHERE key = '${MAINTENANCE_SINCE_KEY}')),
                      'after', json_object('enabled', json(?3), 'reason', ?4, 'since', ?5)),
          ?6)`;

const MAINTENANCE_CLEAR_SQL = "DELETE FROM review_runtime_settings WHERE key = ?1";

/**
 * Open or close the maintenance window. Enabling stamps `since` with `now` and
 * keeps `reason` when one was given; disabling DELETEs both, so a closed
 * platform never carries a stale window into the next one. A blank reason is
 * no reason. The flag, its two companions and the audit row share one batch:
 * the caller's actor names the save, and a write error appends nothing.
 */
export async function setMaintenanceMode(
  db: DashboardD1,
  input: { enabled: boolean; reason?: string | null; actor: string },
  now: string,
): Promise<void> {
  const { enabled, actor } = input;
  const reason = enabled ? (input.reason?.trim() || null) : null;
  const put = (key: string, value: string | null) =>
    value === null
      ? db.prepare(MAINTENANCE_CLEAR_SQL).bind(key)
      : db.prepare(SYSTEM_UPSERT_SQL).bind(key, value, now, actor);
  await db.batch([
    db
      .prepare(MAINTENANCE_AUDIT_SQL)
      .bind(
        crypto.randomUUID(),
        actor,
        enabled ? "true" : "false",
        reason,
        enabled ? now : null,
        now,
      ),
    put(MAINTENANCE_ENABLED_KEY, enabled ? "1" : "0"),
    put(MAINTENANCE_SINCE_KEY, enabled ? now : null),
    put(MAINTENANCE_REASON_KEY, reason),
  ]);
}
