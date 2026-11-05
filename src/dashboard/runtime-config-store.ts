/**
 * Runtime configuration store — the system and workspace review-concurrency
 * caps (migration 0040: `review_runtime_settings` + the nullable
 * `workspaces.max_concurrent_reviews` column).
 *
 * Level contract:
 *   - System cap lives in `review_runtime_settings` under
 *     `review.concurrency.system`; an ABSENT row reads as the platform
 *     quota (256).
 *   - Workspace cap is the `workspaces` column; NULL reads as 32 — the
 *     per-workspace maximum, so no tenant may exceed it.
 *   - Effective = min(system, workspace). The per-PR lock (1) is not
 *     configurable and is not this store's business.
 *
 * Live-workspace policy: both workspace reads filter `deleted_at IS NULL`, the
 * same predicate the settings WRITE uses (`WORKSPACE_AUDIT_SQL` /
 * `WORKSPACE_UPDATE_SQL`). A retired workspace is therefore absent to the read
 * exactly as it is unavailable to the write: it falls back to
 * WORKSPACE_CONCURRENCY_DEFAULT (32, a real bound) rather than continuing to
 * govern its queued jobs with a pinned value nobody can change any more.
 * `deleted_at IS NULL` never degrades a read — it is absence, not untrusted
 * data — so `degraded` stays false on that path.
 *
 * Read discipline: ONE prepared statement per decision point, no KV and no
 * request cache — `getEffectiveConcurrency` reads both levels in a single
 * statement for exactly that reason. Only an ABSENT row/column is the default:
 * a PRESENT value the parse cannot trust, or a result that is not a row at
 * all, answers the CONSERVATIVE cap (1, i.e. serial) with `degraded: true` and
 * never throws — a settings read that breaks must not admit unlimited
 * concurrent reviews. The single-level reader (`getSystemConcurrency`) answers
 * `{ concurrency, degraded }` for the same reason: a settings face that renders
 * the conservative fallback as a normal value invites a save of a number
 * nobody stored. The structured warn belongs
 * to the consumer that has a logger (the pipeline reader), not here.
 *
 * Check budgets (spec §7.10) are the same table, global rather than
 * per-workspace: `review.check.terminalize_timeout_ms` (the consumer's wait on
 * the terminalize hook) and `review.check.update_timeout_ms` (the bound on the
 * one `checks.update`). Their defaults live here as ABSENT-ROW defaults, in the
 * one range predicate the writes and the degraded read share: an untrusted
 * stored value answers the default with `degraded: true` and never throws,
 * because a Check never blocks or delays the review.
 *
 * The recheck seat's ask budget (`review.recheck.assignment_max_bytes`) is one
 * more global row: how many UTF-8 bytes of assignment the seat may be asked
 * with. An absent row reads the runner's documented default; an untrusted
 * value answers that default with `degraded: true`, never a throw — the round
 * is still asked, at the conservative budget.
 *
 * The operator default review depth (plan 036a) is one more row in the same
 * table: `review.level.default` holds a `REVIEW_LEVELS` tier that every App
 * with no depth of its own inherits. An absent row reads `"default"`; a stored
 * value off the vocabulary is untrusted — the default with `degraded: true`,
 * never a throw, because a review must still run.
 *
 * Write discipline: the system value is an integer in 1..SYSTEM_CONCURRENCY_MAX
 * (the platform-wide quota; Cloudflare Queues delivers at most 250 of it at
 * once); the workspace value is an integer in 1..WORKSPACE_CONCURRENCY_MAX.
 * The two bounds are independent: a workspace write is NEVER compared with the
 * system quota — that comparison would let a tenant binary-search the platform
 * number — and the quota applies only at admission, as
 * `min(system, workspace)`. Both writes land with their
 * `platform_audit_events` row in ONE `db.batch`, the `flag.set` pattern in
 * src/admin/index.ts — a failed write appends no audit row.
 *
 * Module boundary: a dashboard leaf whose imports are the `DashboardD1` type
 * from ./users and the closed review vocabulary from
 * packages/shared/src/runtime (values and types only) — no store/pipeline/
 * review code, no runtime dependency.
 */
import { isReviewLevel, REVIEW_LEVELS, type ReviewLevel } from "../../packages/shared/src/runtime";
import type { DashboardD1 } from "./users";

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
export const CHECK_UPDATE_MIN = 500;
export const CHECK_UPDATE_MAX = 15_000;
/** The audit ledger's target id for the pair (one operator save, one row). */
const CHECK_BUDGETS_TARGET = "review.check.budgets";

/** PK of the operator default review-depth row (plan 036a). */
export const REVIEW_LEVEL_KEY = "review.level.default";
/** Absent row: the tier every App without its own depth inherits. */
export const REVIEW_LEVEL_DEFAULT: ReviewLevel = "default";

/** Integer in min..max — the one predicate every write and every read re-parses with. */
function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Integer 1..max — the concurrency predicate. */
export function isConcurrencyValue(value: unknown, max: number): value is number {
  return isIntegerIn(value, CONCURRENCY_MIN, max);
}

/**
 * Parse one stored value in min..max. `undefined` = the row/column is ABSENT,
 * so the caller's default applies; `NaN` = the value is present but not a
 * trusted in-range integer, which no reader may treat as a default. Only a
 * number or a string counts: D1's declared column types do not constrain what
 * a row actually carries, so any other runtime value is untrusted, never
 * something `Number()` may coerce into a value (`["16"]` → 16, `true` → 1).
 */
function parseInRange(value: unknown, min: number, max: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") return Number.NaN;
  const parsed = typeof value === "number" ? value : Number(value);
  return isIntegerIn(parsed, min, max) ? parsed : Number.NaN;
}

/**
 * The workspace column's parse. A value ABOVE the per-workspace maximum is
 * clamped to it rather than treated as untrusted: migration 0043 lowers the
 * rows that exist when it applies, but the window between "migrations applied"
 * and "new Worker live" lets the previously deployed API store one more
 * 33..64 value. Reading it as the maximum keeps that workspace at a real cap
 * instead of degrading the whole workspace to serial.
 */
function parseWorkspaceStored(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") return Number.NaN;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < CONCURRENCY_MIN) return Number.NaN;
  return Math.min(parsed, WORKSPACE_CONCURRENCY_MAX);
}

/** One single-level read: the cap, plus whether the stored value could be trusted. */
export type ConcurrencyRead = { concurrency: number; degraded: boolean };

/**
 * One cap from one result row. Only `row === null` is an absent setting, so the
 * caller's default applies; a present row whose selected field is missing is a
 * malformed result — untrusted, never absent.
 */
function resolveRow(
  row: { value?: unknown } | null,
  fallback: number,
  parse: (value: unknown) => number | undefined,
): ConcurrencyRead {
  if (row === null) return { concurrency: fallback, degraded: false };
  if (row.value === undefined) return { concurrency: CONCURRENCY_MIN, degraded: true };
  const parsed = parse(row.value);
  if (parsed === undefined) return { concurrency: fallback, degraded: false };
  return Number.isNaN(parsed)
    ? { concurrency: CONCURRENCY_MIN, degraded: true }
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
};

/** One `review_runtime_settings` row. The declared `value` type constrains nothing a row actually carries. */
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
    return { concurrency: CONCURRENCY_MIN, degraded: true };
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
    return { concurrency: CONCURRENCY_MIN, degraded: true };
  }
}

/**
 * The untrusted-read answer: serial, flagged.
 */
function degradedConcurrency(): EffectiveConcurrency {
  return {
    system: CONCURRENCY_MIN,
    workspace: CONCURRENCY_MIN,
    effective: CONCURRENCY_MIN,
    degraded: true,
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
    // This query always yields exactly one row; no row means the answer itself
    // is untrustworthy, not that both settings are absent. A present row whose
    // selected fields are missing is untrusted for the same reason — only a NULL
    // column means the setting is absent.
    if (row === null) return degradedConcurrency();
    if (row.system_value === undefined || row.workspace_value === undefined) {
      return degradedConcurrency();
    }
    const storedSystem = parseInRange(row.system_value, CONCURRENCY_MIN, SYSTEM_CONCURRENCY_MAX);
    const storedWorkspace = parseWorkspaceStored(row.workspace_value);
    if (Number.isNaN(storedSystem) || Number.isNaN(storedWorkspace)) {
      return degradedConcurrency();
    }
    const system = storedSystem ?? SYSTEM_CONCURRENCY_DEFAULT;
    const workspace = storedWorkspace ?? WORKSPACE_CONCURRENCY_DEFAULT;
    return { system, workspace, effective: Math.min(system, workspace), degraded: false };
  } catch {
    return degradedConcurrency();
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

/**
 * The stored system cap as SQL — the audit `before` value, under the ledger's
 * canonical-digits rule.
 */
const storedSystemCapSql = (keyParam: string, untrusted: string) =>
  `(SELECT ${trustedIntSql("value", untrusted, CONCURRENCY_MIN, SYSTEM_CONCURRENCY_MAX)} FROM review_runtime_settings WHERE key = ${keyParam})`;

/** One stored check budget as SQL — the audit `before` value. */
const storedBudgetSql = (keyParam: string, untrusted: string, min: number, max: number) =>
  `(SELECT ${trustedIntSql("value", untrusted, min, max)} FROM review_runtime_settings WHERE key = ${keyParam})`;

/**
 * Audit row + `review_runtime_settings` upsert, in that order, in ONE batch.
 * `before` carries the stored value only under the readers' trust rule, so a
 * corrupt row is recorded as `null` — a bare `CAST` would report `0` for
 * `'abc'` and a number no reader or write predicate ever used for `' 8'`.
 */
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

/**
 * The workspace cap as the ledger sees a stored value: the same clamp the
 * reader applies (canonical digits above the maximum record the maximum),
 * so `before` cannot disagree with the cap the workspace was running.
 */
const workspaceAuditCapSql = (value: string) => `CASE
      WHEN ${value} NOT GLOB '*[^0-9]*' AND CAST(${value} AS INTEGER) > ${WORKSPACE_CONCURRENCY_MAX}
        THEN ${WORKSPACE_CONCURRENCY_MAX}
      WHEN ${value} NOT GLOB '*[^0-9]*' AND CAST(${value} AS INTEGER) BETWEEN ${CONCURRENCY_MIN} AND ${WORKSPACE_CONCURRENCY_MAX}
        THEN CAST(${value} AS INTEGER)
      ELSE NULL END`;

/**
 * The ledger row carries the UPDATE's own guard — the target exists — so a
 * refused write appends nothing. It computes `before` with a subquery against
 * the not-yet-updated row: a bind cannot read the old value after the write.
 * That subquery uses the workspace clamp above, so a corrupt stored value is
 * recorded as `null` rather than the raw column.
 */
const WORKSPACE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?1, ?2, 'workspace.concurrency.set', 'workspace', ?3,
         json_object('before', (SELECT ${workspaceAuditCapSql("max_concurrent_reviews")}
                                  FROM workspaces WHERE id = ?3),
                     'after', ?4),
         ?5
   WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?3 AND deleted_at IS NULL)`;

/**
 * The workspace value is bounded by its own maximum only. The system quota is
 * NOT part of this predicate: refusing on it would let a tenant binary-search
 * the platform number, and the quota already applies at admission as
 * `min(system, workspace)`.
 */
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

  // Zero rows: the target is not a live workspace, so nothing was written.
  throw new UnknownWorkspaceError(workspaceId);
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
export type CheckBudgets = { terminalizeMs: number; updateMs: number; degraded: boolean };

/** The pair an accepted write carries. */
export type CheckBudgetValues = { terminalizeMs: number; updateMs: number };

/** The untrusted/failed-read answer: the documented defaults, flagged. */
function degradedCheckBudgets(): CheckBudgets {
  return {
    terminalizeMs: CHECK_TERMINALIZE_DEFAULT,
    updateMs: CHECK_UPDATE_DEFAULT,
    degraded: true,
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
    // This query always yields exactly one row; no row means the answer itself
    // is untrustworthy, and a missing field is malformed rather than absent.
    if (row === null) return degradedCheckBudgets();
    if (row.terminalize_value === undefined || row.update_value === undefined) {
      return degradedCheckBudgets();
    }
    const terminalize = parseInRange(
      row.terminalize_value,
      CHECK_TERMINALIZE_MIN,
      CHECK_TERMINALIZE_MAX,
    );
    const update = parseInRange(row.update_value, CHECK_UPDATE_MIN, CHECK_UPDATE_MAX);
    if (Number.isNaN(terminalize) || Number.isNaN(update)) return degradedCheckBudgets();
    return {
      terminalizeMs: terminalize ?? CHECK_TERMINALIZE_DEFAULT,
      updateMs: update ?? CHECK_UPDATE_DEFAULT,
      degraded: false,
    };
  } catch {
    return degradedCheckBudgets();
  }
}

/**
 * One operator save, one audit row: `before` carries each stored value under
 * the readers' trust rule (a corrupt row is `null`), `after` the accepted pair.
 * The two upserts share this batch, so a refused write appends nothing.
 */
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
  // The inline wait must contain the send it bounds. The refusal states the
  // RELATION only — echoing the other stored value would disclose a number the
  // caller did not supply.
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
    // This query yields one row per stored key; a row without `value` is
    // malformed rather than absent.
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

/**
 * One operator save, one audit row: `before` carries the stored value under
 * the readers' trust rule (a corrupt row is `null`), `after` the accepted one.
 */
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
    // A present row whose value is missing is malformed, not absent.
    return isReviewLevel(row.value)
      ? { value: row.value, degraded: false }
      : { value: REVIEW_LEVEL_DEFAULT, degraded: true };
  } catch {
    return { value: REVIEW_LEVEL_DEFAULT, degraded: true };
  }
}

/**
 * One operator save, one audit row: `before` carries the stored level only when
 * it is on the vocabulary (a corrupt row is `null`), `after` the accepted one.
 */
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
