/**
 * Workspace (tenant) resolution for the dashboard request path — the read-only
 * companion of `apps-store`'s tenant read face. Migrations 0026/0027 are the
 * DDL single sources; this module owns no write path and only answers the two
 * questions the routing layer needs: which workspace does this slug name, and
 * what is this user's role inside it.
 *
 * Zero-dependency leaf (the `apps-store` module boundary): the `db` parameter
 * is a locally-declared narrow D1 face (types only, zero imports), satisfied
 * structurally by the real `D1Database`, the dashboard test double, and the
 * store layer's `D1Like`.
 */

/** Membership role inside one workspace (migration 0026 CHECK domain). */
export type WorkspaceRole = "owner" | "admin" | "member";

/** A live `workspaces` row (migration 0026). */
export type WorkspaceRow = {
  id: string;
  slug: string;
  name: string;
};

/** Narrow D1 face: single-row reads plus the one bounded two-row probe below. */
type WorkspaceStoreD1 = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
    all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  };
};

/**
 * Resolve a workspace by its path slug. Soft-deleted workspaces are invisible
 * (the same 404 as an unknown slug): a retired tenant must never serve traffic.
 */
export async function getWorkspaceBySlug(
  db: WorkspaceStoreD1,
  slug: string,
): Promise<WorkspaceRow | null> {
  return db
    .prepare(`SELECT id, slug, name FROM workspaces WHERE slug = ? AND deleted_at IS NULL`)
    .bind(slug)
    .first<WorkspaceRow>();
}

/**
 * The user's role in one workspace, or null when they are not a member. Keyed
 * by the users row id (a login rename cannot orphan a membership).
 */
export async function getMembership(
  db: WorkspaceStoreD1,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const row = await db
    .prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .bind(workspaceId, userId)
    .first<{ role: WorkspaceRole }>();
  return row?.role ?? null;
}

/**
 * The deployment's single live workspace, or null when it does not carry
 * exactly one. M1 is single-workspace (the same assumption `createApp` makes);
 * the mode-independent manifest flow has no tenant scope on its request, so its
 * strict-mode landing page names the workspace through this read.
 */
export async function getSoleWorkspace(db: WorkspaceStoreD1): Promise<WorkspaceRow | null> {
  const rows = await db
    .prepare(`SELECT id, slug, name FROM workspaces WHERE deleted_at IS NULL LIMIT 2`)
    .all<WorkspaceRow>();
  return rows.results.length === 1 ? rows.results[0]! : null;
}
