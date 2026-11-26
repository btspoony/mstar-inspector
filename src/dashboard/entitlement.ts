import type { DeploymentMode } from "../worker/env";
import type { D1Like } from "../store/types";
import { quotaSpent, resolveWorkspaceMonthlyQuota } from "../store/quota-store";
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
  appsPerWorkspace: number | null;
};

type PlanLimitsRow = Omit<PlanLimits, "sharedBotAllowed"> & {
  workspaceId?: string;
  sharedBotAllowed: number;
};

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

const UNLIMITED_LIMITS: PlanLimits = {
  id: UNLIMITED_PLAN_ID,
  name: "Unlimited",
  includedMembers: null,
  sharedBotAllowed: true,
  appsPerWorkspace: null,
};

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

/** The question a caller asks; {@link EntitlementCtx} discriminates on it. */
export type EntitlementKind =
  | "member-slot"
  | "free-workspace-slot"
  | "shared-bot"
  | "app-count"
  | "review-quota";

type Base = { db: WorkspaceStoreD1; mode: DeploymentMode; workspaceId: string };

type FreeSlotCtx = Omit<Base, "workspaceId"> & {
  kind: "free-workspace-slot";
  workspaceId: string | null;
  freeMembershipCount: () => Promise<number>;
};

/**
 * One question and the counters it is judged against. Counters are caller
 * inputs because they are read inside the caller's own statements (a seats count
 * in the same batch as the guarded insert, a month sum the enqueue already
 * needs); the plan, and `review-quota`'s ceiling, are this module's reads.
 *
 * `app-count`'s counter is a thunk: the branch only reads it when the plan HAS a
 * cap, so an uncapped plan — and `self-hosted`, which answers the unlimited
 * constant — never touches the Apps tables.
 *
 * `member-slot`'s `seats` is nullable ON PURPOSE: a number is the route's
 * fast-fail count, while `null` says "the caller's own guarded SQL is the atomic
 * authority" — that branch never refuses and still carries `plan`, so the
 * guarded insert binds its limit without a second plan read.
 *
 * `shared-bot`'s `botScope` exists because only the platform's SHARED bot is a
 * plan capability: an own bot is admitted without consulting the column, though
 * the verdict still carries the plan like every other kind.
 */
export type EntitlementCtx =
  | (Base & { kind: "member-slot"; seats: number | null })
  | FreeSlotCtx
  | (Base & { kind: "shared-bot"; botScope: "shared" | "own" })
  | (Base & { kind: "app-count"; liveAppCount: () => Promise<number> })
  | (Base & {
      kind: "review-quota";
      db: WorkspaceStoreD1 & D1Like;
      // The instant the ceiling is judged at: it yields BOTH the month key and,
      // with no binding for that month, the profile in force. A caller passes
      // the moment it is deciding for, never a fixed month boundary (D13).
      now: Date;
      usedRp: number;
      costRp: number;
    });

/** Why a kind refused, carrying the numbers its own copy and log line need. */
export type EntitlementRefusal =
  | { kind: "member-slot"; limit: number; seats: number }
  | { kind: "free-workspace-slot" }
  | { kind: "shared-bot"; planId: string }
  | { kind: "app-count"; limit: number; count: number }
  | { kind: "review-quota"; limit: number; used: number; cost: number };

/**
 * The verdict. `plan` rides BOTH branches, so an allowed caller that must bind a
 * limit into its own guarded SQL reads it here instead of resolving the plan
 * again.
 */
export type EntitlementVerdict =
  | { ok: true; plan: PlanLimits }
  | { ok: false; plan: PlanLimits; refusal: EntitlementRefusal };

/**
 * The free-workspace-slot verdict. Its ALLOWED case carries no plan: the
 * question is about the login, and two of its three callers name no workspace
 * at all, so minting a plan there would be a read nobody uses (the SPA boot
 * would pay it on every page load). The REFUSED case carries one — the named
 * workspace's — so the acceptance route can log which plan its copy blamed.
 */
export type FreeSlotVerdict =
  | { ok: true }
  | {
      ok: false;
      plan: PlanLimits | null;
      refusal: { kind: "free-workspace-slot" };
    };

/**
 * THE plan decision: every "may this workspace do X under its plan" question is
 * answered here, one branch per {@link EntitlementKind}. A route, a store or the
 * SPA maps the verdict onto its own surface (400 copy, 409 class, enqueue skip)
 * but never re-derives the rule.
 *
 * The plan is read once, through {@link resolveWorkspacePlan}, and `self-hosted`
 * answers the unlimited constant before the catalogue is touched — so that mode
 * pays no read at all, exactly once, before the first statement (spec §2 rule 1).
 * A NULL plan limit is no cap, so those branches never refuse (the caller's own
 * guarded SQL stays the atomic authority where one exists).
 */
export function checkEntitlement(ctx: FreeSlotCtx): Promise<FreeSlotVerdict>;
export function checkEntitlement(
  ctx: Exclude<EntitlementCtx, { kind: "free-workspace-slot" }>,
): Promise<EntitlementVerdict>;
export async function checkEntitlement(
  ctx: EntitlementCtx,
): Promise<EntitlementVerdict | FreeSlotVerdict> {
  let resolved: PlanLimits | undefined;
  const plan = async (workspaceId: string): Promise<PlanLimits> =>
    (resolved ??= await resolveWorkspacePlan(ctx.db, workspaceId, ctx.mode));

  switch (ctx.kind) {
    case "member-slot": {
      const limits = await plan(ctx.workspaceId);
      if (
        ctx.seats === null ||
        limits.includedMembers === null ||
        memberSlotAvailable(ctx.seats, limits.includedMembers)
      ) {
        return { ok: true, plan: limits };
      }
      return { ok: false, plan: limits, refusal: { kind: "member-slot", limit: limits.includedMembers, seats: ctx.seats } };
    }
    case "free-workspace-slot": {
      if (ctx.workspaceId === null) {
        return freeSlotAvailable(await ctx.freeMembershipCount())
          ? { ok: true }
          : { ok: false, plan: null, refusal: { kind: "free-workspace-slot" } };
      }
      const limits = await plan(ctx.workspaceId);
      if (!isFreeTierPlan(limits.id)) return { ok: true };
      return freeSlotAvailable(await ctx.freeMembershipCount())
        ? { ok: true }
        : { ok: false, plan: limits, refusal: { kind: "free-workspace-slot" } };
    }
    case "shared-bot": {
      const limits = await plan(ctx.workspaceId);
      return ctx.botScope === "own" || assertSharedBotAllowed(limits) === null
        ? { ok: true, plan: limits }
        : { ok: false, plan: limits, refusal: { kind: "shared-bot", planId: limits.id } };
    }
    case "app-count": {
      const limits = await plan(ctx.workspaceId);
      if (limits.appsPerWorkspace === null) return { ok: true, plan: limits };
      const count = await ctx.liveAppCount();
      return count < limits.appsPerWorkspace
        ? { ok: true, plan: limits }
        : { ok: false, plan: limits, refusal: { kind: "app-count", limit: limits.appsPerWorkspace, count } };
    }
    case "review-quota": {
      const limits = await plan(ctx.workspaceId);
      const { monthlyRp } = await resolveWorkspaceMonthlyQuota(ctx.db, ctx.workspaceId, limits.id, ctx.now);
      if (monthlyRp !== null && quotaSpent(ctx.usedRp, monthlyRp, ctx.costRp)) {
        return {
          ok: false,
          plan: limits,
          refusal: { kind: "review-quota", limit: monthlyRp, used: ctx.usedRp, cost: ctx.costRp },
        };
      }
      return { ok: true, plan: limits };
    }
  }
}

/**
 * Why a workspace may not use the shared bot: the plan that lacks the
 * capability. A value, not a thrown error — the two call sites answer on
 * different surfaces (a 400 body, a terminal delivery skip), so the decision
 * stays surface-free and each site maps it.
 */
export type SharedBotRefusal = { kind: "shared-bot-not-included"; planId: string };

function assertSharedBotAllowed(plan: PlanLimits): SharedBotRefusal | null {
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

function freeSlotAvailable(freeMembershipCount: number): boolean {
  return freeMembershipCount < 1;
}

function memberSlotAvailable(
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
