/**
 * Workspace entitlement — one workspace's plan limits plus the two pure slot
 * predicates the creation / invite / acceptance routes call before they write.
 *
 * The resolver is the only read: `workspace_subscriptions JOIN plans` keyed by
 * workspace id. Absence-means-free is the contract — no row, or a row that is
 * not `active`, resolves to the seeded `free` plan. The predicates take counts
 * the caller already read, so they hold no D1 handle and no async.
 *
 * Refusals are named classes (not plain Errors) because routes tell 409 from
 * 500 by class, never by message-sniffing; the message is the user-visible 409
 * body, passed in verbatim.
 *
 * Known limit: the free-slot and member-cap checks are read-then-write, not
 * reservations — two concurrent requests can both read the same count and both
 * pass, admitting a second free membership or a sixth member. A db.batch cannot
 * close this (a batch is atomic within one request, never isolated across
 * requests). Atomic enforcement is required before the first paid plan.
 */
import type { WorkspaceStoreD1 } from "./workspace-store";

/** The plan shape the entitlement decisions read; the catalogue's other limits stay unread here. */
export type PlanLimits = { id: string; name: string; includedMembers: number };

/**
 * The workspace's active plan limits, or the seeded `free` limits when it has
 * no active subscription row. A missing `free` row means migration 0031 did
 * not apply, so it throws instead of inventing limits.
 */
export async function resolveWorkspacePlan(
  db: WorkspaceStoreD1,
  workspaceId: string,
): Promise<PlanLimits> {
  const subscribed = await db
    .prepare(
      `SELECT p.id AS id, p.name AS name, p.included_members AS includedMembers
         FROM workspace_subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.workspace_id = ? AND s.status = 'active'`,
    )
    .bind(workspaceId)
    .first<PlanLimits>();
  if (subscribed) return subscribed;

  const free = await db
    .prepare(
      `SELECT id AS id, name AS name, included_members AS includedMembers
         FROM plans WHERE id = 'free'`,
    )
    .first<PlanLimits>();
  if (!free) {
    throw new Error("plans is missing the seeded 'free' row; apply migration 0031_plans_usage.sql");
  }
  return free;
}

/** One free workspace per login, so the second free membership is the last. */
export function freeSlotAvailable(freeMembershipCount: number): boolean {
  return freeMembershipCount < 1;
}

/** The plan's included members are the cap; a pending invite counts as taken. */
export function memberSlotAvailable(
  memberAndPendingCount: number,
  includedMembers: number,
): boolean {
  return memberAndPendingCount < includedMembers;
}

/**
 * The Product copy for a creation / acceptance that exceeds the free slot,
 * verbatim (§ Creation). It is the raw 409 body the refusal class carries, and
 * every free-slot gate passes this same string so the copy has one home.
 */
export const FREE_SLOT_REFUSAL =
  "This workspace was not created. You already belong to a free workspace, and you can belong to only one at a time. Delete that workspace if you own it. If you do not, an owner or admin of that workspace must remove you. Then create this one.";

/** Refusal for a creation / acceptance that would exceed the free slot: a 409 body. */
export class FreeWorkspaceSlotError extends Error {
  constructor(body: string) {
    super(body);
    this.name = "FreeWorkspaceSlotError";
  }
}

/** Refusal for an invite that would exceed the plan's member cap: a 409 body. */
export class MemberCapError extends Error {
  constructor(body: string) {
    super(body);
    this.name = "MemberCapError";
  }
}
