/**
 * Workspace reads for `/_internal_admin` (plan 116 Task 3; spec
 * operator-admin-surface §3.3).
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
 */
import { FREE_PLAN_ID } from "../dashboard/entitlement";
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
