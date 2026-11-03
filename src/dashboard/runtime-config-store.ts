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
 * statement for exactly that reason. A read failure returns the CONSERVATIVE
 * cap (1, i.e. serial) with `degraded: true` and never throws: a settings read
 * that breaks must not admit unlimited concurrent reviews. The structured warn
 * belongs to the consumer that has a logger (the pipeline reader), not here.
 *
 * Write discipline: values are integers in 1..250; a workspace value above the
 * CURRENT system value is refused, never clamped. Both writes land with their
 * `platform_audit_events` row in ONE `db.batch`, the `flag.set` pattern in
 * src/admin/index.ts — a failed write appends no audit row.
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
 * Why a write was refused. `invalid_value` is the 1..250 range; `above_system`
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

/** One `review_runtime_settings` row. */
type RuntimeSettingRow = { value: string };

/** The system cap; an absent row reads as the default. */
export async function getSystemConcurrency(db: DashboardD1): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM review_runtime_settings WHERE key = ?")
    .bind(SYSTEM_CONCURRENCY_KEY)
    .first<RuntimeSettingRow>();
  const parsed = row === null ? Number.NaN : Number(row.value);
  return isConcurrencyValue(parsed) ? parsed : SYSTEM_CONCURRENCY_DEFAULT;
}

/** The workspace cap; a NULL row/column reads as the default. */
export async function getWorkspaceConcurrency(
  db: DashboardD1,
  workspaceId: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT max_concurrent_reviews AS value FROM workspaces WHERE id = ?")
    .bind(workspaceId)
    .first<{ value: number | null }>();
  const stored = row?.value ?? null;
  return isConcurrencyValue(stored) ? stored : WORKSPACE_CONCURRENCY_DEFAULT;
}

/**
 * Both caps in ONE statement (one read per decision point), resolved to the
 * effective value. Any read failure — thrown, or a row shape the parse cannot
 * trust — answers the conservative cap with `degraded: true`; it never throws
 * and never fails open to unlimited.
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
      .first<{ system_value: string | null; workspace_value: number | null }>();
    const systemValue = Number(row?.system_value ?? Number.NaN);
    const system = isConcurrencyValue(systemValue) ? systemValue : SYSTEM_CONCURRENCY_DEFAULT;
    const workspaceStored = row?.workspace_value ?? null;
    const workspace = isConcurrencyValue(workspaceStored)
      ? workspaceStored
      : WORKSPACE_CONCURRENCY_DEFAULT;
    return { system, workspace, effective: Math.min(system, workspace), degraded: false };
  } catch {
    return {
      system: CONCURRENCY_MIN,
      workspace: CONCURRENCY_MIN,
      effective: CONCURRENCY_MIN,
      degraded: true,
    };
  }
}

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
 * The ledger row is guarded by the TARGET's existence, so an unknown workspace
 * appends nothing (the `workspace.slug.set` pattern in src/admin/workspaces.ts),
 * and it computes `before` with a subquery against the not-yet-updated row —
 * a bind cannot read the old value after the write.
 */
const WORKSPACE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?1, ?2, 'workspace.concurrency.set', 'workspace', ?3,
         json_object('before', (SELECT max_concurrent_reviews FROM workspaces WHERE id = ?3),
                     'after', ?4),
         ?5
   WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?3 AND deleted_at IS NULL)`;

/**
 * No cap predicate here: the refusal above is a named error the route answers
 * with a keyed 400, which a guarded UPDATE cannot distinguish from an unknown
 * workspace. A system cap lowered in that instant is still honoured by every
 * read — `getEffectiveConcurrency` takes the min — so no message can exceed it.
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
  const system = await getSystemConcurrency(db);
  if (value > system) {
    throw new RuntimeConfigError(
      "above_system",
      `workspace concurrency ${value} exceeds the system cap ${system}`,
    );
  }
  const now = new Date().toISOString();
  const [, update] = await db.batch([
    db
      .prepare(WORKSPACE_AUDIT_SQL)
      .bind(crypto.randomUUID(), actor, workspaceId, value, now),
    db.prepare(WORKSPACE_UPDATE_SQL).bind(workspaceId, value),
  ]);
  if (update?.meta.changes !== 1) {
    throw new UnknownWorkspaceError(workspaceId);
  }
  return value;
}

/** A refused write against a workspace id that does not exist. */
export class UnknownWorkspaceError extends RuntimeConfigError {
  constructor(workspaceId: string) {
    super("unknown_workspace", `no workspace ${workspaceId}`);
    this.name = "UnknownWorkspaceError";
  }
}
