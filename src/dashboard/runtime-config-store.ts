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
 * Module boundary: a dashboard leaf whose only import is the `DashboardD1`
 * type from ./users — no store/pipeline/review code, no runtime dependency.
 */
import type { DashboardD1 } from "./users";

/** PK of the system row in `review_runtime_settings`. */
export const SYSTEM_CONCURRENCY_KEY = "review.concurrency.system";
/** Absent system row: the platform-wide quota. */
export const SYSTEM_CONCURRENCY_DEFAULT = 256;
/** NULL / absent workspace column: the per-workspace maximum. */
export const WORKSPACE_CONCURRENCY_DEFAULT = 32;
/** Lower bound of a stored value; also the degraded read fallback. */
export const CONCURRENCY_MIN = 1;
/** Upper bound of the system value: the platform-wide quota, independent of the queue ceiling. */
export const SYSTEM_CONCURRENCY_MAX = 256;
/** Upper bound of the workspace value: the per-workspace maximum. */
export const WORKSPACE_CONCURRENCY_MAX = 32;

/** Integer 1..max — the one predicate every write and every read re-parses with. */
export function isConcurrencyValue(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= CONCURRENCY_MIN &&
    value <= max
  );
}

/**
 * Parse one stored value. `undefined` = the row/column is ABSENT, so the
 * caller's default applies; `NaN` = the value is present but not a trusted
 * 1..max integer, which no reader may treat as a default. Only a number or a
 * string counts: D1's declared column types do not constrain what a row
 * actually carries, so any other runtime value is untrusted, never something
 * `Number()` may coerce into a cap (`["16"]` → 16, `true` → 1).
 */
function parseStored(value: unknown, max: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") return Number.NaN;
  const parsed = typeof value === "number" ? value : Number(value);
  return isConcurrencyValue(parsed, max) ? parsed : Number.NaN;
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
      parseStored(value, SYSTEM_CONCURRENCY_MAX),
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
    const storedSystem = parseStored(row.system_value, SYSTEM_CONCURRENCY_MAX);
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
 * One stored concurrency value as SQL, under the audit ledger's trust rule: a
 * canonical 1..max numeric value is that integer, anything else is
 * `untrusted`. One fragment, so the system row and the workspace column cannot
 * drift apart on what "trusted" means.
 *
 * It is deliberately stricter than `parseStored`, which accepts any string
 * `Number()` turns into an in-range integer (`'8.0'`, `'1e1'`, `'+8'`): those
 * read as caps but are ledgered as `before: null`. `shortcut: a non-canonical
 * numeric text is readable but not auditable, upgrade if a non-canonical
 * writer ever exists`.
 */
const trustedConcurrencySql = (value: string, untrusted: string, max: number) => `CASE
      WHEN ${value} NOT GLOB '*[^0-9]*' AND CAST(${value} AS INTEGER) BETWEEN ${CONCURRENCY_MIN} AND ${max}
      THEN CAST(${value} AS INTEGER) ELSE ${untrusted} END`;

/**
 * The stored system cap as SQL — the audit `before` value, under the ledger's
 * canonical-digits rule.
 */
const storedSystemCapSql = (keyParam: string, untrusted: string) =>
  `(SELECT ${trustedConcurrencySql("value", untrusted, SYSTEM_CONCURRENCY_MAX)} FROM review_runtime_settings WHERE key = ${keyParam})`;

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
