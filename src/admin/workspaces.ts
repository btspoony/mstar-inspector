/**
 * Workspace reads and the plan assignment write for `/_internal_admin`
 * (plan 116 Task 3; spec operator-admin-surface §3.2 / §3.3).
 *
 * The list is ONE statement: live member count, pending invite count, owner
 * login, plan and creation stamp are all resolved in SQL, so the console never
 * issues a per-row read. The plan column mirrors the SaaS half of
 * `resolveWorkspacePlan` (`active` subscription, else the seeded `free` row) —
 * the same SQL mirror `countFreeMembershipsForLogin` keeps
 * (src/dashboard/workspace-store.ts:298) — and imports `FREE_PLAN_ID` so that
 * fallback has one spelling. The module is only reachable through the `saas`
 * router (src/worker/index.ts), so the resolver's `self-hosted` branch, which
 * answers before any DB read, has no reachable case here.
 *
 * The write is ONE `batch`: the subscription upsert and its
 * `platform_audit_events` row land together or not at all, so a failed write
 * appends no audit row and a successful one appends exactly one.
 */
import { FREE_PLAN_ID, resolveWorkspacePlan } from "../dashboard/entitlement";
import type { DashboardD1 } from "../dashboard/users";

/** One `GET /_internal_admin/api/workspaces` row (spec §3.3). */
export type AdminWorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  ownerLogin: string | null;
  memberCount: number;
  pendingInviteCount: number;
  planId: string;
  createdAt: string;
};

/**
 * Every live workspace, newest first. Binds: `?1` the live-invite stamp
 * (`now`), `?2` the free plan id the plan column falls back to.
 *
 * A workspace normally holds one owner (the removal guard refuses to leave
 * none, src/dashboard/users.ts:293-294), but a promoted second owner must not
 * make the row depend on scan order, so the owner subquery picks the earliest
 * deterministically. Soft-deleted workspaces are invisible, like every other
 * live read.
 */
const LIST_SQL = `
  SELECT w.id         AS id,
         w.name       AS name,
         w.slug       AS slug,
         w.created_at AS createdAt,
         (SELECT u.github_login
            FROM workspace_members m
            JOIN users u ON u.id = m.user_id
           WHERE m.workspace_id = w.id AND m.role = 'owner'
           ORDER BY m.created_at, u.github_login
           LIMIT 1) AS ownerLogin,
         (SELECT COUNT(*) FROM workspace_members m
           WHERE m.workspace_id = w.id) AS memberCount,
         (SELECT COUNT(*) FROM workspace_invites i
           WHERE i.workspace_id = w.id
             AND i.status = 'pending' AND i.expires_at > ?1) AS pendingInviteCount,
         COALESCE(s.plan_id, ?2) AS planId
    FROM workspaces w
    LEFT JOIN workspace_subscriptions s
           ON s.workspace_id = w.id AND s.status = 'active'
   WHERE w.deleted_at IS NULL
   ORDER BY w.created_at DESC, w.id ASC`;

/** Live workspaces with their SQL-side counts, owner and resolved plan. */
export async function listWorkspaces(db: DashboardD1, now: string): Promise<AdminWorkspaceRow[]> {
  const rows = await db.prepare(LIST_SQL).bind(now, FREE_PLAN_ID).all<AdminWorkspaceRow>();
  return rows.results;
}

/**
 * Outcome of {@link setWorkspacePlan}. `unknown_plan` and `unknown_workspace`
 * write nothing: the route turns them into a 400 and a 404, and the caller can
 * tell "the catalogue has no such plan" from "the tenant is gone".
 */
export type SetWorkspacePlanOutcome =
  | { kind: "ok"; planId: string }
  | { kind: "unknown_plan" }
  | { kind: "unknown_workspace" };

/**
 * `created_at` is written on a fresh row only: the conflict branch keeps the
 * original subscription start and moves `updated_at`, and re-activates a
 * cancelled row rather than forking a second one (`workspace_id` is the PK).
 */
const SUBSCRIPTION_UPSERT_SQL = `
  INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
  VALUES (?1, ?2, 'active', ?3, ?3)
  ON CONFLICT (workspace_id) DO UPDATE SET
    plan_id = excluded.plan_id,
    status = 'active',
    updated_at = excluded.updated_at`;

/** Platform-scope ledger row: the tenant is the target, the detail is before/after. */
const AUDIT_INSERT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'workspace.plan.set', 'workspace', ?3, ?4, ?5)`;

/**
 * Assign one workspace's plan (spec §3.2).
 *
 * The plan id is validated against the catalogue first, so an unknown id is a
 * refusal with no write at all — `plans` is read-only at runtime, so that read
 * cannot go stale between the check and the batch. A downgrade below the live
 * member count is deliberately allowed: it blocks NEW invites through the seat
 * guard every invite write carries (src/dashboard/invite-store.ts:164), and it
 * never removes a member — no membership row is touched here.
 *
 * `previousPlanId` is what the workspace RESOLVED to before the write. The
 * console only exists on `saas`, so passing that mode is the registration
 * contract, not a guess.
 */
export async function setWorkspacePlan(
  db: DashboardD1,
  input: { workspaceId: string; planId: string; actorLogin: string; now: string },
): Promise<SetWorkspacePlanOutcome> {
  const plan = await db
    .prepare("SELECT 1 AS found FROM plans WHERE id = ?")
    .bind(input.planId)
    .first<{ found: number }>();
  if (!plan) return { kind: "unknown_plan" };

  const workspace = await db
    .prepare("SELECT 1 AS found FROM workspaces WHERE id = ? AND deleted_at IS NULL")
    .bind(input.workspaceId)
    .first<{ found: number }>();
  if (!workspace) return { kind: "unknown_workspace" };

  const previousPlanId = (await resolveWorkspacePlan(db, input.workspaceId, "saas")).id;
  await db.batch([
    db.prepare(SUBSCRIPTION_UPSERT_SQL).bind(input.workspaceId, input.planId, input.now),
    db
      .prepare(AUDIT_INSERT_SQL)
      .bind(
        crypto.randomUUID(),
        input.actorLogin,
        input.workspaceId,
        JSON.stringify({ before: previousPlanId, after: input.planId }),
        input.now,
      ),
  ]);
  return { kind: "ok", planId: input.planId };
}
