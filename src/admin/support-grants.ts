/**
 * Support-grant maintenance for `/_internal_admin` (plan 116 Task 5; spec
 * operator-admin-surface §3.4).
 *
 * A grant is the operator's time-boxed cross-workspace access aid, so the
 * console REVOKES it by deleting the row rather than appending a tombstone,
 * and every write appends exactly one `audit_events` row carrying the grant's
 * target workspace (§4: support-grant writes stay in the workspace-scope
 * ledger, whose `workspace_id` the target always satisfies).
 *
 * The write lands BEFORE its audit row, so a refused or failed write appends
 * nothing. The two statements are separate D1 calls, not one batch: the store
 * module owns both statements and its narrow D1 face has no `batch`.
 *
 * The existing support classifier is untouched — it keeps reading grants
 * through `hasValidGrant` / `listActiveSupportGrants`, so a created grant is
 * honoured on the next request and a deleted one stops matching exactly like
 * an expired row.
 */
import type { DashboardD1 } from "../dashboard/users";
import {
  deleteSupportGrant,
  insertAuditEvent,
  insertSupportGrant,
  type SupportGrantRow,
} from "../dashboard/operator-store";

/**
 * Outcome of {@link createSupportGrant}. `unknown_workspace` writes nothing:
 * the console can tell a stale id from a malformed request instead of letting
 * the foreign key fail as a 500.
 */
export type CreateSupportGrantOutcome =
  | { kind: "ok"; grant: SupportGrantRow }
  | { kind: "unknown_workspace" };

/** Create one grant, then append its one audit row. */
export async function createSupportGrant(
  db: DashboardD1,
  input: {
    workspaceId: string;
    operatorLogin: string;
    reason: string;
    grantedBy: string;
    now: string;
    expiresAt: string;
  },
): Promise<CreateSupportGrantOutcome> {
  const workspace = await db
    .prepare("SELECT 1 AS found FROM workspaces WHERE id = ? AND deleted_at IS NULL")
    .bind(input.workspaceId)
    .first<{ found: number }>();
  if (workspace === null) return { kind: "unknown_workspace" };

  const grant = await insertSupportGrant(db, {
    workspaceId: input.workspaceId,
    operatorLogin: input.operatorLogin,
    reason: input.reason,
    grantedBy: input.grantedBy,
    now: input.now,
    expiresAt: input.expiresAt,
  });
  await insertAuditEvent(db, {
    workspaceId: grant.workspace_id,
    actorLogin: input.grantedBy,
    action: "support.grant.create",
    now: input.now,
  });
  return { kind: "ok", grant };
}

/** Outcome of {@link revokeSupportGrant}; `not_found` writes nothing. */
export type RevokeSupportGrantOutcome =
  | { kind: "ok"; workspaceId: string }
  | { kind: "not_found" };

/** Delete one grant, then append its one audit row. */
export async function revokeSupportGrant(
  db: DashboardD1,
  input: { id: string; actorLogin: string; now: string },
): Promise<RevokeSupportGrantOutcome> {
  const removed = await deleteSupportGrant(db, input.id);
  if (removed === null) return { kind: "not_found" };
  await insertAuditEvent(db, {
    workspaceId: removed.workspace_id,
    actorLogin: input.actorLogin,
    action: "support.grant.delete",
    now: input.now,
  });
  return { kind: "ok", workspaceId: removed.workspace_id };
}
