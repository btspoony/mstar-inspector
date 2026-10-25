/**
 * Platform-operator store — the one read/write authority for `support_grants`
 * and `audit_events` (migration 0029 is the DDL single source).
 *
 * The exports are the whole surface — two appends (`insertSupportGrant`,
 * `insertAuditEvent`), three listing reads (`listActiveSupportGrants`,
 * `listAllActiveSupportGrants`, `listAuditEvents`), the validity probe
 * (`hasValidGrant`) and ONE delete (`deleteSupportGrant`). A grant is a
 * time-boxed access aid, not history (spec operator-admin-surface §3.4), so
 * the operator console revokes it by deleting the row; `audit_events` stays
 * append-only by construction.
 *   * `support_grants` is the time-boxed, workspace-scoped window that lets a
 *     non-member platform operator read a workspace's identity fields and
 *     member list. Expiry is evaluated per request from the stored
 *     `expires_at` (`> now`), never by a timer or a status flip, so a lapsed
 *     grant stops matching exactly like no row at all.
 *     Both reads judge ONE row per (workspace, operator): the newest by
 *     `rowid` (insertion order), so an appended row can end a window its
 *     predecessor still claims. The console's revocation deletes the whole
 *     pair (see `deleteSupportGrant`), so it can never reveal an older row.
 *   * `audit_events` records the operator access attempt in the workspace gate
 *     (`support.read` | `support.forbidden` | `support.denied`), one row per
 *     operator request, and the console's grant maintenance
 *     (`support.grant.create` | `support.grant.delete`), one row per write.
 *     Every read of it is owner/admin-only.
 *
 * Zero-dependency leaf (the `workspace-store` / `invite-store` module
 * boundary): the `db` parameter is a locally-declared narrow D1 face (types
 * only, zero imports), satisfied structurally by the real `D1Database` and the
 * dashboard test double.
 */

/**
 * Closed `audit_events.action` vocabulary (free TEXT in the DDL, checked
 * here). The two `support.grant.*` rows are the console's grant maintenance:
 * the actor is the operator who wrote, the workspace is the grant's target.
 */
export type SupportAuditAction =
  | "support.read"
  | "support.forbidden"
  | "support.denied"
  | "support.grant.create"
  | "support.grant.delete";

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

/**
 * The newest append for one (workspace, operator) — the ONE row every grant
 * read judges. `rowid` is insertion order because `created_at` is
 * caller-supplied and may tie.
 */
export const NEWEST_GRANT_APPEND = `g.rowid = (
            SELECT MAX(x.rowid) FROM support_grants x
             WHERE x.workspace_id = g.workspace_id
               AND x.operator_login = g.operator_login
          )`;

const AUDIT_COLUMNS = `id, workspace_id, actor_login, action, created_at`;

/**
 * Whether `login` holds an open support window on `workspaceId` — the
 * `operator-granted` half of the gate's principal classification. The lookup
 * is workspace-keyed in the WHERE clause, so a grant on another workspace can
 * never answer true here; `operator_login` matches case-insensitively through
 * the column collation.
 *
 * Exactly ONE row decides: the newest append for that (workspace, login),
 * ordered by `rowid` (insertion order — `created_at` is caller-supplied and may
 * tie). Revocation is an append, so the superseding row must be able to end a
 * window its predecessor still claims; filtering every row by `expires_at`
 * would leave the revoked grant live.
 */
export async function hasValidGrant(
  db: OperatorStoreD1,
  workspaceId: string,
  login: string,
  now: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT expires_at > ? AS live FROM support_grants
        WHERE workspace_id = ? AND operator_login = ?
        ORDER BY rowid DESC LIMIT 1`,
    )
    .bind(now, workspaceId, login)
    .first<{ live: number }>();
  return row !== null && row.live === 1;
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
 * Remove one grant by id and return the row it removed, or null when no such
 * row exists — the console's revoke path.
 *
 * EVERY append for the same (workspace, operator) goes with it. The reads
 * judge the newest append for that pair, so deleting only the newest row would
 * hand the window back to the row it superseded: a revocation that silently
 * restores access. The pair, not the row, is the window.
 */
export async function deleteSupportGrant(
  db: OperatorStoreD1,
  id: string,
): Promise<SupportGrantRow | null> {
  const row = await db
    .prepare(`SELECT ${GRANT_COLUMNS} FROM support_grants WHERE id = ?`)
    .bind(id)
    .first<SupportGrantRow>();
  if (row === null) return null;
  await db
    .prepare("DELETE FROM support_grants WHERE workspace_id = ? AND operator_login = ?")
    .bind(row.workspace_id, row.operator_login)
    .run();
  return row;
}

/**
 * The workspace's open support windows, longest-lived first — the members'
 * undismissable notice read. Same one-row-per-operator rule as
 * `hasValidGrant`: only the NEWEST append for each operator may raise a
 * notice, so a revocation removes the notice on the next request.
 */
export async function listActiveSupportGrants(
  db: OperatorStoreD1,
  workspaceId: string,
  now: string,
): Promise<SupportGrantRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM support_grants g
        WHERE g.workspace_id = ? AND g.expires_at > ?
          AND ${NEWEST_GRANT_APPEND}
        ORDER BY expires_at DESC, id ASC`,
    )
    .bind(workspaceId, now)
    .all<SupportGrantRow>();
  return results;
}

/**
 * Every open support window across ALL workspaces, longest-lived first — the
 * console's list. Same one-row-per-(workspace, operator) rule as
 * `listActiveSupportGrants`, without the workspace filter, so one statement
 * answers the whole console table.
 */
export async function listAllActiveSupportGrants(
  db: OperatorStoreD1,
  now: string,
): Promise<SupportGrantRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM support_grants g
        WHERE g.expires_at > ?
          AND ${NEWEST_GRANT_APPEND}
        ORDER BY expires_at DESC, id ASC`,
    )
    .bind(now)
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
 * stable order. A negative or non-finite `limit` would bind as SQLite's
 * "no upper bound", so the store refuses it rather than fail open.
 */
export async function listAuditEvents(
  db: OperatorStoreD1,
  workspaceId: string,
  limit: number,
): Promise<AuditEventRow[]> {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`listAuditEvents: limit must be a non-negative integer, got ${limit}`);
  }
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
