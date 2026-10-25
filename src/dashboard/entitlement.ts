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

/**
 * The plan shape the entitlement decisions read; the catalogue's other limits
 * stay unread here. `includedMembers` follows 0031's NULL-means-unlimited
 * contract: a number is the seat cap, NULL is no cap at all — every consumer
 * must branch on it, never fall back to `0`.
 */
export type PlanLimits = { id: string; name: string; includedMembers: number | null };

/** The seeded free plan's id — the one plan id an absent subscription resolves to. */
export const FREE_PLAN_ID = "free";

/** The no-seat-cap plan id; its `included_members` is NULL by design. */
export const UNLIMITED_PLAN_ID = "unlimited";

/**
 * Whether a resolved plan id is the free tier. THE one spelling of that rule:
 * the acceptance gate, the free-membership counter and the creation guard all
 * read it, so a second free plan id is a one-line change here.
 */
export function isFreeTierPlan(planId: string | null | undefined): boolean {
  return planId == null || planId === FREE_PLAN_ID;
}

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
         FROM plans WHERE id = ?`,
    )
    .bind(FREE_PLAN_ID)
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

/**
 * The plan's included members are the cap; a pending invite counts as taken.
 * A NULL limit is no cap, so the answer is always yes and no caller can read
 * the absence as "zero seats".
 */
export function memberSlotAvailable(
  memberAndPendingCount: number,
  includedMembers: number | null,
): boolean {
  return includedMembers === null || memberAndPendingCount < includedMembers;
}

/**
 * The Product copy for a creation that exceeds the free slot, verbatim
 * (§ Creation). It is the raw 409 body the refusal class carries.
 */
export const FREE_SLOT_REFUSAL =
  "This workspace was not created. You already belong to a free workspace, and you can belong to only one at a time. Delete that workspace if you own it. If you do not, an owner or admin of that workspace must remove you. Then create this one.";

/**
 * The Product copy for an acceptance that exceeds the free slot, verbatim
 * (§ Invite acceptance). Same refusal class, different body: an acceptance
 * leaves the invite pending instead of creating a workspace.
 */
export const INVITE_FREE_SLOT_REFUSAL =
  "You were not added. You already belong to a free workspace, and you can belong to only one at a time. Delete that workspace if you own it. If you do not, an owner or admin of that workspace must remove you. Then accept this invite. The invite is still pending.";

/**
 * The Product copy for an invite that would exceed the plan's member cap,
 * verbatim (§ Sixth member) except for the plan's actual seat limit. Only a
 * numeric limit has a refusal: a NULL limit means no cap, so no copy exists
 * for it and no caller may ask.
 */
export function MEMBER_CAP_REFUSAL(includedMembers: number): string {
  return `This invite was not sent. This workspace already has ${includedMembers} people, counting members and pending invites. Remove a member or revoke a pending invite, then send the invite again.`;
}

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
