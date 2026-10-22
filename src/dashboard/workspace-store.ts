/**
 * Workspace (tenant) resolution for the dashboard request path — the read-only
 * companion of `apps-store`'s tenant read face. Migrations 0026/0027 are the
 * DDL single sources; this module owns no write path and only answers the two
 * questions the routing layer needs: which workspace does this path ref (id or
 * slug) name, and what is this user's role inside it.
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

/** One member of a workspace (users row + its workspace role). */
export type WorkspaceMemberRow = {
  id: string;
  github_login: string;
  role: WorkspaceRole;
  created_at: string;
};

/** Narrow D1 face: reads plus the workspace-creation batch's statements. */
type WorkspaceStoreStatement = {
  bind(...values: unknown[]): WorkspaceStoreStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<{
    results: T[];
    meta: { changes: number; last_row_id: number };
  }>;
};

type WorkspaceStoreD1 = {
  prepare(query: string): WorkspaceStoreStatement;
};

/**
 * Resolve a workspace by its path ref — the same segment may be the row's id or
 * its slug, and BOTH must resolve to exactly one workspace. Soft-deleted
 * workspaces are invisible (the same 404 as an unknown ref): a retired tenant
 * must never serve traffic.
 *
 * Zero rows is an unknown ref; TWO rows means a slug equals another workspace's
 * id, so the segment names no single tenant — it answers the same 404 and
 * never picks one (the alternative is a cross-tenant read). The T2 slug write
 * guard forbids such data, so this is the defensive backstop, and the
 * concurrent-write race it cannot close degrades to a 404, never a leak.
 */
export async function getWorkspaceByRef(
  db: WorkspaceStoreD1,
  ref: string,
): Promise<WorkspaceRow | null> {
  const rows = await db
    .prepare(
      `SELECT id, slug, name FROM workspaces WHERE (slug = ?1 OR id = ?1) AND deleted_at IS NULL LIMIT 2`,
    )
    .bind(ref)
    .all<WorkspaceRow>();
  if (rows.results.length === 1) return rows.results[0]!;
  if (rows.results.length > 1) {
    console.warn(JSON.stringify({ event: "workspace_ref_ambiguous", ref }));
  }
  return null;
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
 * Every member of one workspace, oldest first (`github_login` breaks
 * same-millisecond `created_at` ties). The member list is visible to every
 * member, so this read carries no role filter; the caller's own role decides
 * what the page offers.
 */
export async function listWorkspaceMembers(
  db: WorkspaceStoreD1,
  workspaceId: string,
): Promise<WorkspaceMemberRow[]> {
  const rows = await db
    .prepare(
      `SELECT u.id AS id, u.github_login AS github_login, wm.role AS role,
              wm.created_at AS created_at
         FROM workspace_members wm JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ?
        ORDER BY wm.created_at ASC, u.github_login ASC`,
    )
    .bind(workspaceId)
    .all<WorkspaceMemberRow>();
  return rows.results;
}

/** One member of this workspace by row id, or null when they are not one. */
export async function getWorkspaceMember(
  db: WorkspaceStoreD1,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMemberRow | null> {
  return db
    .prepare(
      `SELECT u.id AS id, u.github_login AS github_login, wm.role AS role,
              wm.created_at AS created_at
         FROM workspace_members wm JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ? AND wm.user_id = ?`,
    )
    .bind(workspaceId, userId)
    .first<WorkspaceMemberRow>();
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

/**
 * The sole live workspace's slug plus the login's role inside it — ONE read,
 * because the SPA shell boot needs both facts and the manifest gate needs the
 * role alone. Null under the same predicate as {@link getSoleWorkspace}; a
 * login with no users row or no membership resolves `role: null` (not a
 * member), never an error.
 */
export async function getSoleWorkspaceAccess(
  db: WorkspaceStoreD1,
  login: string,
): Promise<{ slug: string; role: WorkspaceRole | null } | null> {
  const rows = await db
    .prepare(
      `SELECT w.slug AS slug, wm.role AS role
         FROM workspaces w
         LEFT JOIN users u ON u.github_login = ? COLLATE NOCASE
         LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = u.id
        WHERE w.deleted_at IS NULL
        LIMIT 2`,
    )
    .bind(login)
    .all<{ slug: string; role: WorkspaceRole | null }>();
  const row = rows.results.length === 1 ? rows.results[0]! : null;
  return row === null ? null : { slug: row.slug, role: row.role };
}

/**
 * How many live workspaces this login belongs to — `0` is the "no workspace
 * yet" state that offers creation. Soft-deleted workspaces do not
 * count: a retired tenant is not a home.
 */
export async function countMembershipsForLogin(
  db: WorkspaceStoreD1,
  login: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
         JOIN workspaces w ON w.id = wm.workspace_id
        WHERE u.github_login = ? COLLATE NOCASE AND w.deleted_at IS NULL`,
    )
    .bind(login)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The creation write face: prepared statements run as ONE `batch`. */
type WorkspaceStoreWriteD1 = {
  prepare(query: string): WorkspaceStoreStatement;
  batch(statements: WorkspaceStoreStatement[]): Promise<
    { results: unknown[]; meta: { changes: number; last_row_id: number } }[]
  >;
};

/** The guard that refused a slug write — the 409 code the route answers. */
export type WorkspaceSlugConflict = "slug_taken" | "slug_is_workspace_id";

/**
 * The rename: both guards live in the UPDATE's own WHERE, so the statement is
 * atomic by construction — a guard hit changes no row (`changes === 0`), which
 * is what a two-statement pre-check batch cannot promise. The guards are the
 * pinned pair: no OTHER workspace may carry the slug in any case, and the value
 * may not be any workspace's id (that would make the path ref ambiguous).
 */
const SET_SLUG_SQL = `UPDATE workspaces SET slug = ?1
   WHERE id = ?2
     AND NOT EXISTS (SELECT 1 FROM workspaces WHERE slug = ?1 COLLATE NOCASE AND id <> ?2)
     AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = ?1 AND id <> ?2)`;

/** Which guard matched, read once after a refused write (index order = precedence). */
const SLUG_CONFLICT_SQL = `SELECT
     EXISTS (SELECT 1 FROM workspaces WHERE slug = ?1 COLLATE NOCASE AND id <> ?2) AS slug_taken,
     EXISTS (SELECT 1 FROM workspaces WHERE id = ?1 AND id <> ?2) AS id_taken`;

/**
 * Rename one workspace's slug. Returns the conflict that refused the write, or
 * null when it landed. A concurrent write that slips past the guards is caught
 * by the UNIQUE index and maps to `slug_taken`, never a 500.
 */
export async function setWorkspaceSlug(
  db: WorkspaceStoreD1,
  workspaceId: string,
  slug: string,
): Promise<WorkspaceSlugConflict | null> {
  let changes: number;
  try {
    changes = (await db.prepare(SET_SLUG_SQL).bind(slug, workspaceId).run()).meta.changes;
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) return "slug_taken";
    throw err;
  }
  if (changes > 0) return null;
  const guard = await db
    .prepare(SLUG_CONFLICT_SQL)
    .bind(slug, workspaceId)
    .first<{ slug_taken: number; id_taken: number }>();
  // A zero-change write with both guards clear is unreachable: the caller
  // resolved a live row, and workspaces are soft-deleted, never removed.
  return guard?.slug_taken ? "slug_taken" : "slug_is_workspace_id";
}

/**
 * Create one workspace and its creator's `owner` membership as ONE `batch` — a
 * workspace without an owner, or an owner without a workspace, must never be
 * observable. `slug` equals `id` by contract (the id is already
 * lowercase, so the two can never disagree on case).
 *
 * Returns false when the slug is already taken (the UNIQUE index is the final
 * word), so the caller can mint another id instead of 500ing.
 */
export async function createWorkspace(
  db: WorkspaceStoreWriteD1,
  input: { id: string; name: string; userId: string; createdAt: string },
): Promise<boolean> {
  let inserted: { meta: { changes: number; last_row_id: number } };
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .bind(input.id, input.id, input.name, input.userId, input.createdAt),
      db
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
           VALUES (?, ?, 'owner', ?)`,
        )
        .bind(input.id, input.userId, input.createdAt),
    ]);
    inserted = results[0]!;
  } catch (err) {
    // The batch aborts as a unit, so a taken slug leaves no orphan membership.
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) return false;
    throw err;
  }
  return inserted.meta.changes > 0;
}
