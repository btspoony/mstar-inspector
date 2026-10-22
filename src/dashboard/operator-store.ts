/**
 * Platform-operator store — the one read/write authority for `support_grants`
 * and `audit_events` (migration 0029 is the DDL single source).
 *
 * Two appends and two reads, nothing else: this module exports NO update and
 * NO delete for either table, because both are append-only history.
 *   * `support_grants` is the time-boxed, workspace-scoped window that lets a
 *     non-member platform operator read a workspace's identity fields and
 *     member list. Expiry is evaluated per request from the stored
 *     `expires_at` (`> now`), never by a timer or a status flip, so a lapsed
 *     grant stops matching exactly like no row at all.
 *   * `audit_events` records the operator access attempt in the workspace gate
 *     (`support.read` | `support.forbidden` | `support.denied`), one row per
 *     operator request, and every read of it is owner/admin-only.
 *
 * Zero-dependency leaf (the `workspace-store` / `invite-store` module
 * boundary): the `db` parameter is a locally-declared narrow D1 face (types
 * only, zero imports), satisfied structurally by the real `D1Database` and the
 * dashboard test double.
 */

/** Closed `audit_events.action` vocabulary (free TEXT in the DDL, checked here). */
export type SupportAuditAction = "support.read" | "support.forbidden" | "support.denied";

/** A `support_grants` row (migration 0029). */
export type SupportGrantRow = {
  id: string;
  workspace_id: string;
  operator_login: string;
  reason: string;
  granted_by: string;
  created_at: string;
  expires_at: string;
};

/** An `audit_events` row (migration 0029). */
export type AuditEventRow = {
  id: string;
  workspace_id: string;
  actor_login: string;
  action: SupportAuditAction;
  created_at: string;
};

/** Narrow D1 face: the four statements these two tables need. */
type OperatorStoreStatement = {
  bind(...values: unknown[]): OperatorStoreStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<{
    results: T[];
    meta: { changes: number; last_row_id: number };
  }>;
};

type OperatorStoreD1 = {
  prepare(query: string): OperatorStoreStatement;
};

const GRANT_COLUMNS = `id, workspace_id, operator_login, reason, granted_by, created_at, expires_at`;

const AUDIT_COLUMNS = `id, workspace_id, actor_login, action, created_at`;

/**
 * Whether `login` holds an unexpired support grant on `workspaceId` — the
 * `operator-granted` half of the gate's principal classification. The lookup
 * is workspace-keyed in the WHERE clause, so a grant on another workspace can
 * never answer true here; `operator_login` matches case-insensitively through
 * the column collation.
 */
export async function hasValidGrant(
  db: OperatorStoreD1,
  workspaceId: string,
  login: string,
  now: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM support_grants
        WHERE workspace_id = ? AND operator_login = ? AND expires_at > ?
        ORDER BY expires_at DESC LIMIT 1`,
    )
    .bind(workspaceId, login, now)
    .first<{ 1: number }>();
  return row !== null;
}

/**
 * Record one grant. Callers are the operator's explicit store action (CLI), so
 * the row is written as given — the store never extends or shortens a window.
 */
export async function insertSupportGrant(
  db: OperatorStoreD1,
  input: {
    workspaceId: string;
    operatorLogin: string;
    reason: string;
    grantedBy: string;
    now: string;
    expiresAt: string;
  },
): Promise<SupportGrantRow> {
  const row: SupportGrantRow = {
    id: crypto.randomUUID(),
    workspace_id: input.workspaceId,
    operator_login: input.operatorLogin,
    reason: input.reason,
    granted_by: input.grantedBy,
    created_at: input.now,
    expires_at: input.expiresAt,
  };
  await db
    .prepare(
      `INSERT INTO support_grants
         (id, workspace_id, operator_login, reason, granted_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.workspace_id,
      row.operator_login,
      row.reason,
      row.granted_by,
      row.created_at,
      row.expires_at,
    )
    .run();
  return row;
}

/**
 * The workspace's unexpired grants, longest-lived first — the members'
 * undismissable notice read. Lapsed rows are filtered by the same
 * `expires_at > ?` predicate the gate uses, so the notice disappears the
 * request after a grant ends.
 */
export async function listActiveSupportGrants(
  db: OperatorStoreD1,
  workspaceId: string,
  now: string,
): Promise<SupportGrantRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM support_grants
        WHERE workspace_id = ? AND expires_at > ?
        ORDER BY expires_at DESC, id ASC`,
    )
    .bind(workspaceId, now)
    .all<SupportGrantRow>();
  return results;
}

/**
 * Append one audit row. Written by the workspace gate before dispatch, so the
 * row records the attempted access, not the handler's outcome.
 */
export async function insertAuditEvent(
  db: OperatorStoreD1,
  input: {
    workspaceId: string;
    actorLogin: string;
    action: SupportAuditAction;
    now: string;
  },
): Promise<AuditEventRow> {
  const row: AuditEventRow = {
    id: crypto.randomUUID(),
    workspace_id: input.workspaceId,
    actor_login: input.actorLogin,
    action: input.action,
    created_at: input.now,
  };
  await db
    .prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_login, action, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.workspace_id, row.actor_login, row.action, row.created_at)
    .run();
  return row;
}

/**
 * The workspace's audit rows, newest first, at most `limit` of them — the
 * owner/admin read. `id` breaks the tie so a same-millisecond batch keeps a
 * stable order.
 */
export async function listAuditEvents(
  db: OperatorStoreD1,
  workspaceId: string,
  limit: number,
): Promise<AuditEventRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${AUDIT_COLUMNS} FROM audit_events
        WHERE workspace_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .bind(workspaceId, limit)
    .all<AuditEventRow>();
  return results;
}
