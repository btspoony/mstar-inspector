/**
 * Support-grant maintenance for `/_internal_admin` (spec
 * operator-admin-surface §3.4).
 *
 * A grant is the operator's time-boxed cross-workspace access aid, so the
 * console REVOKES it by deleting the row rather than appending a tombstone,
 * and every write appends exactly one `audit_events` row carrying the grant's
 * target workspace (§4: support-grant writes stay in the workspace-scope
 * ledger, whose `workspace_id` the target always satisfies).
 *
 * Each write is ONE `db.batch`, so the grant (or its deletion) and its audit
 * row commit together or not at all: a failed audit append rolls the grant
 * write back, and a failed write appends nothing. That makes the §4 invariant
 * ("no admin action loses its audit trail"; one audit row per successful
 * write) mechanical rather than best-effort. Both statements are owned by
 * `../dashboard/operator-store` (the `support_grants` / `audit_events`
 * authority) — this module only classifies the outcome for the console.
 *
 * The existing support classifier is untouched — it keeps reading grants
 * through `hasValidGrant` / `listActiveSupportGrants`, so a created grant is
 * honoured on the next request and a deleted one stops matching exactly like
 * an expired row.
 */
import type { DashboardD1 } from "../dashboard/users";
import {
  deleteSupportGrantWithAudit,
  insertSupportGrantWithAudit,
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

/**
 * Create one grant and append its one audit row in a single batch.
 *
 * The workspace pre-check is a read the batch cannot express (a missing
 * workspace must be a refusal, not a foreign-key throw), and `workspaces` is
 * only soft-deleted at runtime, so the row it proves still exists when the
 * batch commits. If the driver refuses the batch, nothing is written: the
 * grant write and its audit row roll back together and the throw reaches the
 * caller — never a grant without its audit row.
 */
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

  const grant = await insertSupportGrantWithAudit(db, {
    workspaceId: input.workspaceId,
    operatorLogin: input.operatorLogin,
    reason: input.reason,
    grantedBy: input.grantedBy,
    now: input.now,
    expiresAt: input.expiresAt,
  });
  return { kind: "ok", grant };
}

/** Outcome of {@link revokeSupportGrant}; `not_found` writes nothing. */
export type RevokeSupportGrantOutcome =
  | { kind: "ok"; workspaceId: string }
  | { kind: "not_found" };

/**
 * Delete one grant and append its one audit row in a single batch.
 *
 * The audit statement is a guarded `INSERT … SELECT` over the grant row, so an
 * unknown id appends nothing and deletes nothing — `not_found`, with zero
 * writes. The returned workspace comes from that same statement's
 * `RETURNING`, so no separate read could disagree with what was audited.
 */
export async function revokeSupportGrant(
  db: DashboardD1,
  input: { id: string; actorLogin: string; now: string },
): Promise<RevokeSupportGrantOutcome> {
  const removed = await deleteSupportGrantWithAudit(db, input);
  if (removed === null) return { kind: "not_found" };
  return { kind: "ok", workspaceId: removed.workspaceId };
}
