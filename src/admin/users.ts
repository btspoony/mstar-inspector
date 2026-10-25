/**
 * The user read for `/_internal_admin` (spec operator-admin-surface §3.3).
 *
 * ONE statement: the live-workspace count and the active support-grant count
 * are resolved in SQL, so the console never issues a per-row read. `isOperator`
 * is deliberately NOT a column — the env allowlist decides it, and the route
 * derives it from the same `isPlatformOperator` the gate uses, so the list can
 * never disagree with the authorization decision.
 */
import type { DashboardD1 } from "../dashboard/users";

/** One `GET /_internal_admin/api/users` row as the statement returns it. */
export type AdminUserRow = {
  login: string;
  createdAt: string;
  workspaceCount: number;
  activeGrantCount: number;
};

/**
 * Every known user, newest first. Binds: `?1` the grant-expiry stamp (`now`).
 *
 * A soft-deleted workspace is not a workspace the user is still in, so the
 * count joins `workspaces` and drops it, like every other live read.
 * `support_grants.operator_login` is `COLLATE NOCASE`, so the grant count
 * matches a login case-insensitively, exactly as `hasValidGrant` does.
 */
const LIST_USERS_SQL = `
  SELECT u.github_login AS login,
         u.created_at   AS createdAt,
         (SELECT COUNT(*)
            FROM workspace_members m
            JOIN workspaces w ON w.id = m.workspace_id
           WHERE m.user_id = u.id AND w.deleted_at IS NULL) AS workspaceCount,
         (SELECT COUNT(*)
            FROM support_grants g
           WHERE g.operator_login = u.github_login
             AND g.expires_at > ?1) AS activeGrantCount
    FROM users u
   ORDER BY u.created_at DESC, u.github_login ASC`;

/** Every known user with its SQL-side counts. */
export async function listUsers(db: DashboardD1, now: string): Promise<AdminUserRow[]> {
  const rows = await db.prepare(LIST_USERS_SQL).bind(now).all<AdminUserRow>();
  return rows.results;
}
