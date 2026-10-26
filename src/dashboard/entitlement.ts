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
import type { DeploymentMode } from "../worker/env";
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
 * `self-hosted` resolves to this — the seeded `unlimited` row mirrored as a
 * constant so the mode answers BEFORE any DB read (spec §2 rule 1). The name
 * mirrors migration 0032; self-hosted never renders the plan card (spec §4).
 */
const UNLIMITED_LIMITS: PlanLimits = {
  id: UNLIMITED_PLAN_ID,
  name: "Unlimited",
  includedMembers: null,
};

/**
 * The workspace's active plan limits, or the seeded `free` limits when it has
 * no active subscription row.
 *
 * The single-workspace form of {@link resolveWorkspacePlans} — the shell boot
 * resolves a whole membership list, so the precedence below lives there, once,
 * and this form adds no second copy of it.
 */
export async function resolveWorkspacePlan(
  db: WorkspaceStoreD1,
  workspaceId: string,
  mode: DeploymentMode,
): Promise<PlanLimits> {
  return (await resolveWorkspacePlans(db, [workspaceId], mode)).get(workspaceId)!;
}

/**
 * The plan limits each of `workspaceIds` resolves to, keyed by workspace id.
 *
 * One subscription read answers the whole list, and one `free` catalogue read
 * answers every workspace without an active row, so a membership list of N
 * workspaces costs two reads instead of 2N. The precedence is the contract and
 * is stated only here:
 *
 * - The mode decides FIRST: `self-hosted` is `unlimited` for every workspace,
 *   including the ones holding an `active free` row (every workspace created
 *   today does, so conditioning on "no subscription" would leave existing
 *   deployments capped — spec §4), and it answers before any read at all. The
 *   row stays truthful for a switch back to `saas`; only resolution ignores it.
 * - An active subscription row wins; absence falls back to the seeded `free`
 *   row. A missing `free` row means migration 0031 did not apply, so it throws
 *   instead of inventing limits.
 *
 * Known limit: the id set is bound one placeholder per workspace, and D1 caps a
 * query at 100 bound parameters. A login's membership list is bounded well below
 * that by the free-slot rule and the plan caps; a list that large would need the
 * resolve chunked.
 */
export async function resolveWorkspacePlans(
  db: WorkspaceStoreD1,
  workspaceIds: readonly string[],
  mode: DeploymentMode,
): Promise<Map<string, PlanLimits>> {
  const resolved = new Map<string, PlanLimits>();
  if (workspaceIds.length === 0) return resolved;
  if (mode === "self-hosted") {
    for (const id of workspaceIds) resolved.set(id, UNLIMITED_LIMITS);
    return resolved;
  }

  const placeholders = workspaceIds.map(() => "?").join(", ");
  const subscribed = await db
    .prepare(
      `SELECT s.workspace_id AS workspaceId, p.id AS id, p.name AS name, p.included_members AS includedMembers
         FROM workspace_subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.workspace_id IN (${placeholders}) AND s.status = 'active'`,
    )
    .bind(...workspaceIds)
    .all<PlanLimits & { workspaceId: string }>();
  for (const row of subscribed.results) {
    // Explicit fields: `workspaceId` is the key, not part of the limits.
    resolved.set(row.workspaceId, { id: row.id, name: row.name, includedMembers: row.includedMembers });
  }

  let free: PlanLimits | null = null;
  for (const id of workspaceIds) {
    if (resolved.has(id)) continue;
    free ??= await db
      .prepare(
        `SELECT id AS id, name AS name, included_members AS includedMembers
           FROM plans WHERE id = ?`,
      )
      .bind(FREE_PLAN_ID)
      .first<PlanLimits>();
    if (free === null) {
      throw new Error("plans is missing the seeded 'free' row; apply migration 0031_plans_usage.sql");
    }
    resolved.set(id, free);
  }
  return resolved;
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
 * The Product copy for a creation the operator's `workspace_creation_open`
 * flag closed (spec §3.1), verbatim: creation is closed for EVERYONE, so the
 * per-login free-slot copy would name the wrong cause. It is the second 409
 * body the creation route can answer, and the SPA edge identifies it by this
 * same constant (never by a copied literal).
 */
export const WORKSPACE_CREATION_CLOSED_REFUSAL =
  "This workspace was not created. Workspace creation is closed on this platform right now.";

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

/**
 * The Product copy for an acceptance the plan's seat cap refuses. Unlike
 * {@link MEMBER_CAP_REFUSAL} — which is about SENDING an invite — this one
 * names acceptance, and the invite IS still pending: accepting it again is the
 * recovery once a seat is freed or the plan grows. Reached only with a numeric
 * limit; an unlimited plan has no cap and so no such refusal.
 */
export function ACCEPT_MEMBER_CAP_REFUSAL(includedMembers: number): string {
  return `You were not added. This workspace is at its plan's limit of ${includedMembers} members. An owner or admin must remove a member, or the workspace must move to a larger plan, before this invite can be accepted. The invite is still pending.`;
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
