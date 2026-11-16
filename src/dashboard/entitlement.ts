/**
 * Workspace entitlement — one workspace's plan limits, the two pure slot
 * predicates the creation / invite / acceptance routes call before they write,
 * and the one shared-bot capability decision those surfaces and the webhook
 * enqueue both consult.
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
 *
 * `sharedBotAllowed` is the shared-bot capability (migration
 * `0061_plan_shared_bot_allowed.sql`): a boolean, not a quota, so NULL is not
 * another spelling of unlimited — a plan either includes the shared bot or it
 * does not.
 */
export type PlanLimits = {
  id: string;
  name: string;
  includedMembers: number | null;
  sharedBotAllowed: boolean;
  /**
   * How many Apps this workspace may own (migration 0031's column, seeded
   * 1/10 by 0063). NULL is no cap, exactly like `includedMembers`: a consumer
   * must branch on it, never fall back to 0.
   */
  appsPerWorkspace: number | null;
};

/** The read's row shape: SQLite carries the capability as a 0/1 INTEGER. */
type PlanLimitsRow = Omit<PlanLimits, "sharedBotAllowed"> & {
  workspaceId?: string;
  sharedBotAllowed: number;
};

/**
 * One row → the limits the decisions read, converting the column's 0/1 into
 * the boolean at the boundary (the `allowlist_enabled !== 0` precedent).
 */
function planLimits(row: PlanLimitsRow): PlanLimits {
  return {
    id: row.id,
    name: row.name,
    includedMembers: row.includedMembers,
    sharedBotAllowed: row.sharedBotAllowed !== 0,
    appsPerWorkspace: row.appsPerWorkspace,
  };
}

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
  // The tier includes the shared bot, and this constant is what makes
  // `self-hosted` answer before any read: the capability never consults a
  // column in that mode.
  sharedBotAllowed: true,
  // No App cap in this mode: the constant answers before any read, which is
  // what makes `self-hosted` never consult the column (spec §4).
  appsPerWorkspace: null,
};

/**
 * Ids per subscription read: D1 refuses a statement binding more than 100
 * parameters, and the read binds one placeholder per id.
 */
const PLAN_QUERY_CHUNK = 100;

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
 * The id set is bound one placeholder per workspace and D1 caps a statement at
 * 100 bound parameters, while a login's membership count is bounded by nothing:
 * the free-slot rule and the plan caps limit paid memberships per workspace, not
 * how many workspaces may invite one login. The subscription read is therefore
 * chunked; every id is still resolved, so the switcher never silently loses a
 * row.
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

  for (let at = 0; at < workspaceIds.length; at += PLAN_QUERY_CHUNK) {
    const chunk = workspaceIds.slice(at, at + PLAN_QUERY_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const subscribed = await db
      .prepare(
        `SELECT s.workspace_id AS workspaceId, p.id AS id, p.name AS name, p.included_members AS includedMembers,
                p.shared_bot_allowed AS sharedBotAllowed, p.apps_per_workspace AS appsPerWorkspace
           FROM workspace_subscriptions s
           JOIN plans p ON p.id = s.plan_id
          WHERE s.workspace_id IN (${placeholders}) AND s.status = 'active'`,
      )
      .bind(...chunk)
      .all<PlanLimitsRow & { workspaceId: string }>();
    for (const row of subscribed.results) {
      // `workspaceId` is the key, not part of the limits.
      resolved.set(row.workspaceId, planLimits(row));
    }
  }

  let free: PlanLimits | null = null;
  for (const id of workspaceIds) {
    if (resolved.has(id)) continue;
    if (free === null) {
      const row = await db
        .prepare(
          `SELECT id AS id, name AS name, included_members AS includedMembers,
                  shared_bot_allowed AS sharedBotAllowed, apps_per_workspace AS appsPerWorkspace
             FROM plans WHERE id = ?`,
        )
        .bind(FREE_PLAN_ID)
        .first<PlanLimitsRow>();
      if (row === null) {
        throw new Error("plans is missing the seeded 'free' row; apply migration 0031_plans_usage.sql");
      }
      free = planLimits(row);
    }
    resolved.set(id, free);
  }
  return resolved;
}

/**
 * Why a workspace may not use the shared bot: the plan that lacks the
 * capability. A value, not a thrown error — the two call sites answer on
 * different surfaces (a 400 body, a terminal delivery skip), so the decision
 * stays surface-free and each site maps it.
 */
export type SharedBotRefusal = { kind: "shared-bot-not-included"; planId: string };

/**
 * THE shared-bot decision: `null` = allowed, a {@link SharedBotRefusal} = not.
 * Both call sites — creating a target on a shared bot
 * (`targets-store.createOnSharedBot`) and enqueueing a review for one
 * (`worker/handlers.handleReviewJob`, from the webhook route) — call this and
 * never re-derive the rule.
 *
 * The mode decides first, through {@link resolveWorkspacePlan}: `self-hosted`
 * resolves the unlimited constant before any DB read, so that mode never reads
 * the column at all. Every other mode reads the workspace's plan, so a plan
 * change reaches the next attempt with no restart and no cache.
 */
export async function assertSharedBotAllowed(
  db: WorkspaceStoreD1,
  workspaceId: string,
  mode: DeploymentMode,
): Promise<SharedBotRefusal | null> {
  const plan = await resolveWorkspacePlan(db, workspaceId, mode);
  return plan.sharedBotAllowed ? null : { kind: "shared-bot-not-included", planId: plan.id };
}

/**
 * The shared-bot row's state on the usage card (spec
 * [entitlement and deployment modes](../../docs/specs/architecture/entitlement-and-deployment-modes.md)
 * §5). The plan answers first, because only that state is the reader's to
 * change: `not-in-plan` moves with the workspace's plan, `not-designated`
 * waits for a platform operator, `available` needs both.
 *
 * `self-hosted` never reaches the card at all — the console that designates a
 * shared bot is not registered in that mode — so the row is absent there by
 * deployment, not a fourth state here.
 */
export type SharedBotAvailability = "available" | "not-in-plan" | "not-designated";

export function sharedBotAvailability(limits: PlanLimits, sharedBotExists: boolean): SharedBotAvailability {
  if (!limits.sharedBotAllowed) return "not-in-plan";
  return sharedBotExists ? "available" : "not-designated";
}

/** One free workspace per login, so the second free membership is the last. */
export function freeSlotAvailable(freeMembershipCount: number): boolean {
  return freeMembershipCount < 1;
}

/**
 * The plan's App cap; NULL is no cap, so the answer is always yes and no caller
 * can read the absence as "zero Apps". Mirrors {@link memberSlotAvailable}.
 */
export function appSlotAvailable(liveAppCount: number, appsPerWorkspace: number | null): boolean {
  return appsPerWorkspace === null || liveAppCount < appsPerWorkspace;
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

/**
 * The Product copy for a target creation the shared-bot capability refuses,
 * verbatim (§ Refusal copy). Answered as the 400 body of the form-POST family,
 * which carries no error-code field — so this text IS the refusal.
 *
 * It names the plan because this reader can act on it: use an App the
 * workspace owns, or have an operator move the workspace to a plan that
 * includes the shared bot. The plan id interpolates as stored; every
 * server-built refusal body on this surface is English.
 */
export function SHARED_BOT_REFUSAL(planId: string): string {
  return `This target was not created on the shared bot. The shared bot is not included in this workspace's plan (${planId}). Use a GitHub App this workspace owns, or move the workspace to a plan that includes the shared bot.`;
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
