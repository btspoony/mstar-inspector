import { NEWEST_GRANT_APPEND } from "../dashboard/operator-store";
import type { DashboardD1 } from "../dashboard/users";

/** One `GET /_internal_admin/api/users` row as the statement returns it. */
export type AdminUserRow = {
  login: string;
  createdAt: string;
  workspaceCount: number;
  activeGrantCount: number;
};

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
             AND g.expires_at > ?1
             AND ${NEWEST_GRANT_APPEND}) AS activeGrantCount
    FROM users u
   ORDER BY u.created_at DESC, u.github_login ASC`;

/** Every known user with its SQL-side counts. */
export async function listUsers(db: DashboardD1, now: string): Promise<AdminUserRow[]> {
  const rows = await db.prepare(LIST_USERS_SQL).bind(now).all<AdminUserRow>();
  return rows.results;
}
