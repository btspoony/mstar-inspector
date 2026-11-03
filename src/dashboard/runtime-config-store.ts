/**
 * Runtime configuration store — the system and workspace review-concurrency
 * caps (migration 0040: `review_runtime_settings` + the nullable
 * `workspaces.max_concurrent_reviews` column).
 *
 * Level contract:
 *   - System cap lives in `review_runtime_settings` under
 *     `review.concurrency.system`; an ABSENT row reads as 32.
 *   - Workspace cap is the `workspaces` column; NULL reads as 16.
 *   - Effective = min(system, workspace). The per-PR lock (1) is not
 *     configurable and is not this store's business.
 *
 * Read discipline: ONE prepared statement per decision point, no KV and no
 * request cache — `getEffectiveConcurrency` reads both levels in a single
 * statement for exactly that reason. Only an ABSENT row/column is the default:
 * a PRESENT value the parse cannot trust, or a result that is not a row at
 * all, answers the CONSERVATIVE cap (1, i.e. serial) with `degraded: true` and
 * never throws — a settings read that breaks must not admit unlimited
 * concurrent reviews. The structured warn belongs to the consumer that has a
 * logger (the pipeline reader), not here.
 *
 * Write discipline: values are integers in 1..250; a workspace value above the
 * CURRENT system value is refused, never clamped. The cap is part of the
 * UPDATE's own predicate, so the refusal is decided by the write against the
 * cap as it stands at that moment — a concurrent lowering cannot slip between
 * a check and the write. Both writes land with their `platform_audit_events`
 * row in ONE `db.batch`, the `flag.set` pattern in src/admin/index.ts — a
 * failed write appends no audit row.
 *
 * Module boundary: a dashboard leaf whose only import is the `DashboardD1`
 * type from ./users — no store/pipeline/review code, no runtime dependency.
 */
import type { DashboardD1 } from "./users";

/** PK of the system row in `review_runtime_settings`. */
export const SYSTEM_CONCURRENCY_KEY = "review.concurrency.system";
/** Absent system row. */
export const SYSTEM_CONCURRENCY_DEFAULT = 32;
/** NULL / absent workspace column. */
export const WORKSPACE_CONCURRENCY_DEFAULT = 16;
/** Lower bound of a stored value; also the degraded read fallback. */
export const CONCURRENCY_MIN = 1;
/** Upper bound of a stored value. */
export const CONCURRENCY_MAX = 250;

/** Integer 1..250 — the one predicate every write and every read re-parses with. */
export function isConcurrencyValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= CONCURRENCY_MIN &&
    value <= CONCURRENCY_MAX
  );
}

/**
 * Parse one stored value. `undefined` = the row/column is ABSENT, so the
 * caller's default applies; `NaN` = the value is present but not a trusted
 * 1..250 integer, which no reader may treat as a default. Only a number or a
 * string counts: D1's declared column types do not constrain what a row
 * actually carries, so any other runtime value is untrusted, never something
 * `Number()` may coerce into a cap (`["16"]` → 16, `true` → 1).
 */
function parseStored(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") return Number.NaN;
  const parsed = typeof value === "number" ? value : Number(value);
  return isConcurrencyValue(parsed) ? parsed : Number.NaN;
}

/**
 * One cap from its stored value: absent → `fallback`, present-but-untrusted →
 * the conservative bound. Same answer `getEffectiveConcurrency` degrades to.
 */
function resolveStored(value: unknown, fallback: number): number {
  const parsed = parseStored(value);
  if (parsed === undefined) return fallback;
  return Number.isNaN(parsed) ? CONCURRENCY_MIN : parsed;
}

/**
 * One cap from one result row. Only `row === null` is an absent setting, so the
 * caller's default applies; a present row whose selected field is missing is a
 * malformed result — untrusted, never absent.
 */
function resolveRow(row: { value?: unknown } | null, fallback: number): number {
  if (row === null) return fallback;
  if (row.value === undefined) return CONCURRENCY_MIN;
  return resolveStored(row.value, fallback);
}

/** Why a write was refused. `invalid_value` is the 1..250 range; `above_system`
 * is a workspace value over the system cap, refused so the route can answer a
 * keyed 400 instead of storing a number that would never apply;
 * `unknown_workspace` is a target that does not exist, so nothing was written.
 */
export type RuntimeConfigRefusal = "invalid_value" | "above_system" | "unknown_workspace";

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

/** The system cap; an absent row reads as the default, anything untrusted as 1. */
export async function getSystemConcurrency(db: DashboardD1): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM review_runtime_settings WHERE key = ?")
    .bind(SYSTEM_CONCURRENCY_KEY)
    .first<RuntimeSettingRow>();
  return resolveRow(row, SYSTEM_CONCURRENCY_DEFAULT);
}

/** The workspace cap; an absent row/NULL column reads as the default, anything untrusted as 1. */
export async function getWorkspaceConcurrency(
  db: DashboardD1,
  workspaceId: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT max_concurrent_reviews AS value FROM workspaces WHERE id = ?")
    .bind(workspaceId)
    .first<{ value?: unknown }>();
  return resolveRow(row, WORKSPACE_CONCURRENCY_DEFAULT);
}

/** The untrusted-read answer: serial, flagged. */
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
 */
export async function getEffectiveConcurrency(
  db: DashboardD1,
  workspaceId: string,
): Promise<EffectiveConcurrency> {
  try {
    const row = await db
      .prepare(
        `SELECT (SELECT value FROM review_runtime_settings WHERE key = ?1) AS system_value,
                (SELECT max_concurrent_reviews FROM workspaces WHERE id = ?2) AS workspace_value`,
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
    const storedSystem = parseStored(row.system_value);
    const storedWorkspace = parseStored(row.workspace_value);
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
 * The system cap as SQL, so a write statement can read the cap inside its own
 * predicate instead of trusting an earlier read. An absent row is the default;
 * anything not a plain 1..250 integer is the conservative bound, matching what
 * a degraded read answers. (Stricter than `parseStored` on stray whitespace:
 * `shortcut: a hand-edited " 8" is read as 8 but refuses writes, upgrade if a
 * non-canonical writer ever exists`.)
 */
const systemCapSql = (keyParam: string) => `COALESCE((SELECT CASE
      WHEN value NOT GLOB '*[^0-9]*' AND CAST(value AS INTEGER) BETWEEN ${CONCURRENCY_MIN} AND ${CONCURRENCY_MAX}
      THEN CAST(value AS INTEGER) ELSE ${CONCURRENCY_MIN} END
    FROM review_runtime_settings WHERE key = ${keyParam}), ${SYSTEM_CONCURRENCY_DEFAULT})`;

/** Audit row + `review_runtime_settings` upsert, in that order, in ONE batch. */
const SYSTEM_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'runtime.concurrency.system.set', 'runtime', ?3,
          json_object('before', (SELECT CAST(value AS INTEGER) FROM review_runtime_settings WHERE key = ?3),
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
 * The ledger row carries the same two guards as the UPDATE below — the target
 * exists and the value does not exceed the system cap — so a refused write
 * appends nothing. It computes `before` with a subquery against the
 * not-yet-updated row: a bind cannot read the old value after the write.
 */
const WORKSPACE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?1, ?2, 'workspace.concurrency.set', 'workspace', ?3,
         json_object('before', (SELECT max_concurrent_reviews FROM workspaces WHERE id = ?3),
                     'after', ?4),
         ?5
   WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?3 AND deleted_at IS NULL)
     AND ?4 <= ${systemCapSql("?6")}`;

/**
 * The cap is part of the predicate: raising the workspace value above the
 * system cap is refused by this statement itself, against the cap as it stands
 * now, so no concurrent lowering can be raced by a separate check. Zero rows
 * changed means either refusal; the caller reads the post-write state to name
 * which one.
 */
const WORKSPACE_UPDATE_SQL = `
  UPDATE workspaces SET max_concurrent_reviews = ?2
   WHERE id = ?1 AND deleted_at IS NULL AND ?2 <= ${systemCapSql("?3")}`;

/** Set the system cap. Audited with the actor; returns the stored value. */
export async function setSystemConcurrency(
  db: DashboardD1,
  value: number,
  actor: string,
): Promise<number> {
  if (!isConcurrencyValue(value)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `concurrency must be an integer in ${CONCURRENCY_MIN}..${CONCURRENCY_MAX}`,
    );
  }
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(SYSTEM_AUDIT_SQL)
      .bind(crypto.randomUUID(), actor, SYSTEM_CONCURRENCY_KEY, value, now),
    db.prepare(SYSTEM_UPSERT_SQL).bind(SYSTEM_CONCURRENCY_KEY, String(value), now, actor),
  ]);
  return value;
}

/**
 * Set the workspace cap. A value above the system cap is REFUSED (thrown as
 * `above_system`) rather than clamped; an unknown workspace is
 * `unknown_workspace`. Accepted writes are audited and return the stored value.
 */
export async function setWorkspaceConcurrency(
  db: DashboardD1,
  workspaceId: string,
  value: number,
  actor: string,
): Promise<number> {
  if (!isConcurrencyValue(value)) {
    throw new RuntimeConfigError(
      "invalid_value",
      `concurrency must be an integer in ${CONCURRENCY_MIN}..${CONCURRENCY_MAX}`,
    );
  }
  const now = new Date().toISOString();
  const [, update] = await db.batch([
    db
      .prepare(WORKSPACE_AUDIT_SQL)
      .bind(crypto.randomUUID(), actor, workspaceId, value, now, SYSTEM_CONCURRENCY_KEY),
    db
      .prepare(WORKSPACE_UPDATE_SQL)
      .bind(workspaceId, value, SYSTEM_CONCURRENCY_KEY),
  ]);
  if (update?.meta.changes === 1) return value;

  // Zero rows: the write was refused, so nothing was written. Which refusal it
  // was comes from the state after the attempt, never from a check before it.
  const post = await db
    .prepare(
      `SELECT (SELECT 1 FROM workspaces WHERE id = ?1 AND deleted_at IS NULL) AS target,
              (SELECT value FROM review_runtime_settings WHERE key = ?2) AS system_value`,
    )
    .bind(workspaceId, SYSTEM_CONCURRENCY_KEY)
    .first<{ target: unknown; system_value?: unknown }>();
  if (post === null || post.target === null) throw new UnknownWorkspaceError(workspaceId);
  const system = resolveStored(post.system_value, SYSTEM_CONCURRENCY_DEFAULT);
  throw new RuntimeConfigError(
    "above_system",
    `workspace concurrency ${value} exceeds the system cap ${system}`,
  );
}

/** A refused write against a workspace id that does not exist. */
export class UnknownWorkspaceError extends RuntimeConfigError {
  constructor(workspaceId: string) {
    super("unknown_workspace", `no workspace ${workspaceId}`);
    this.name = "UnknownWorkspaceError";
  }
}
