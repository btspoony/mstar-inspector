/**
 * Workspace (tenant) resolution for the dashboard request path — the read-only
 * companion of `apps-store`'s tenant read face. Migrations 0026/0027 are the
 * DDL single sources; this module owns no write path and only answers the two
 * questions the routing layer needs: which workspace does this path ref (id or
 * slug) name, and what is this user's role inside it.
 *
 * Module boundary (the `apps-store` one): the `db` parameter is a
 * locally-declared narrow D1 face (types only). The single exception is the
 * joined `./entitlement` import — the creation batch refuses with the
 * entitlement's own slot error and spells the free plan id once there, instead
 * of copying either below.
 */

import type { DeploymentMode } from "../worker/env";
import {
  FREE_PLAN_ID,
  FREE_SLOT_REFUSAL,
  FreeWorkspaceSlotError,
} from "./entitlement";

/** Membership role inside one workspace (migration 0026 CHECK domain). */
export type WorkspaceRole = "owner" | "admin" | "member";

/** A live `workspaces` row (migration 0026). */
export type WorkspaceRow = {
  id: string;
  slug: string;
  name: string;
  /** ISO stamp — one of the four fields the support view may expose (AC2). */
  created_at: string;
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

export type WorkspaceStoreD1 = {
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
      `SELECT id, slug, name, created_at FROM workspaces WHERE (slug = ?1 OR id = ?1) AND deleted_at IS NULL LIMIT 2`,
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
 * One workspace plus the login's role and users-row identity — ONE read,
 * because the SPA shell boot needs the slug, the support classifier needs the
 * id + role + login's own row, and the manifest gate needs the id and role.
 */
export type WorkspaceAccess = {
  id: string;
  slug: string;
  role: WorkspaceRole | null;
  /** The login's `users` row identity; null when the login has no row. */
  user: { id: string; github_login: string } | null;
};

/** The access join's row shape (the login's users row may be absent). */
type WorkspaceAccessRow = {
  id: string;
  slug: string;
  role: WorkspaceRole | null;
  user_id: string | null;
  user_login: string | null;
};

function workspaceAccessOf(row: WorkspaceAccessRow): WorkspaceAccess {
  return {
    id: row.id,
    slug: row.slug,
    role: row.role,
    user:
      row.user_id === null || row.user_login === null
        ? null
        : { id: row.user_id, github_login: row.user_login },
  };
}

/**
 * The sole live workspace's id + slug plus the login's role and users row
 * inside it. Null when the deployment does not carry exactly one live
 * workspace; a login with no users row resolves `role: null` and
 * `user: null` (not a member), never an error.
 */
export async function getSoleWorkspaceAccess(
  db: WorkspaceStoreD1,
  login: string,
): Promise<WorkspaceAccess | null> {
  const rows = await db
    .prepare(
      `SELECT w.id AS id, w.slug AS slug, wm.role AS role,
              u.id AS user_id, u.github_login AS user_login
         FROM workspaces w
         LEFT JOIN users u ON u.github_login = ? COLLATE NOCASE
         LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = u.id
        WHERE w.deleted_at IS NULL
        LIMIT 2`,
    )
    .bind(login)
    .all<WorkspaceAccessRow>();
  const row = rows.results.length === 1 ? rows.results[0]! : null;
  return row === null ? null : workspaceAccessOf(row);
}

/**
 * The workspace with this stable `workspaces.id` plus the login's role inside
 * it. `id` never changes and can never be another workspace's slug (the slug
 * write guard forbids it), so this is the SAFE key for a value that must
 * outlive a rename — the manifest flow binds it and re-resolves the current
 * slug only when it needs a URL. A retired or unknown id resolves null.
 */
export async function getWorkspaceAccessById(
  db: WorkspaceStoreD1,
  workspaceId: string,
  login: string,
): Promise<WorkspaceAccess | null> {
  const row = await db
    .prepare(
      `SELECT w.id AS id, w.slug AS slug, wm.role AS role,
              u.id AS user_id, u.github_login AS user_login
         FROM workspaces w
         LEFT JOIN users u ON u.github_login = ?2 COLLATE NOCASE
         LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = u.id
        WHERE w.id = ?1 AND w.deleted_at IS NULL`,
    )
    .bind(workspaceId, login)
    .first<WorkspaceAccessRow>();
  return row === null ? null : workspaceAccessOf(row);
}

/**
 * The workspace a path/flow ref names (an id or a slug, the same predicate as
 * {@link getWorkspaceByRef}) plus the login's role inside it — the addressed
 * counterpart of {@link getSoleWorkspaceAccess}, used wherever the request
 * names its own workspace instead of relying on the deployment's sole one. An
 * unknown, retired or ambiguous ref and a login with no membership all resolve
 * `null`/`role: null` rather than an error.
 */
export async function getWorkspaceAccessByRef(
  db: WorkspaceStoreD1,
  ref: string,
  login: string,
): Promise<WorkspaceAccess | null> {
  const rows = await db
    .prepare(
      `SELECT w.id AS id, w.slug AS slug, wm.role AS role,
              u.id AS user_id, u.github_login AS user_login
         FROM workspaces w
         LEFT JOIN users u ON u.github_login = ?2 COLLATE NOCASE
         LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = u.id
        WHERE (w.slug = ?1 OR w.id = ?1) AND w.deleted_at IS NULL
        LIMIT 2`,
    )
    .bind(ref, login)
    .all<WorkspaceAccessRow>();
  if (rows.results.length > 1) {
    console.warn(JSON.stringify({ event: "workspace_ref_ambiguous", ref }));
    return null;
  }
  const row = rows.results[0];
  return row === undefined ? null : workspaceAccessOf(row);
}

/**
 * How many live workspaces the DEPLOYMENT carries — the fact that decides
 * whether a request which names no workspace can still be attributed: exactly
 * one resolves through {@link getSoleWorkspaceAccess}, more than one has no
 * answer at all. Soft-deleted workspaces do not count.
 */
export async function countLiveWorkspaces(db: WorkspaceStoreD1): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE deleted_at IS NULL`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * How many seats one workspace has taken: its live `workspace_members` rows
 * plus its pending invites that have not lapsed. The invite half carries the
 * invite reads' own lazy-expiry predicate (`status = 'pending' AND expires_at
 * > ?`), so a row whose expiry passed but no write has flipped yet consumes no
 * seat. This is the count the member-cap predicate reads.
 */
export async function countMembersAndPendingInvites(
  db: WorkspaceStoreD1,
  workspaceId: string,
  nowIso: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ?)
       + (SELECT COUNT(*) FROM workspace_invites
           WHERE workspace_id = ? AND status = 'pending' AND expires_at > ?) AS n`,
    )
    .bind(workspaceId, workspaceId, nowIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
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

/**
 * How many live FREE workspaces this login belongs to — the count the free-slot
 * predicate reads. Same rule as {@link resolveWorkspacePlan}: only an `active`
 * subscription row counts, so a workspace with no row (or only a non-active
 * one) is on `free`, and a membership in any other plan's workspace does not
 * consume the slot. Soft-deleted workspaces do not count: a retired tenant is
 * not a home.
 */
export async function countFreeMembershipsForLogin(
  db: WorkspaceStoreD1,
  login: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
         JOIN workspaces w ON w.id = wm.workspace_id
         LEFT JOIN workspace_subscriptions s
                ON s.workspace_id = w.id AND s.status = 'active'
        WHERE u.github_login = ? COLLATE NOCASE AND w.deleted_at IS NULL
          AND (s.plan_id IS NULL OR s.plan_id = ?)`,
    )
    .bind(login, FREE_PLAN_ID)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** One row of the SPA switcher: both identifiers of the workspace + what to show. */
export type WorkspaceMembershipOption = {
  id: string;
  slug: string;
  name: string;
  role: WorkspaceRole;
};

/**
 * Every live workspace this login belongs to, as the SPA boot's switcher rows.
 * Both identifiers ride the row: the path segment may be the stable `id` or the
 * readable `slug`, so a consumer cannot decide "which row is current" from one
 * field (and right after a rename the path still holds the OLD slug while the
 * stored `slug` is new). Same predicate as {@link countMembershipsForLogin}: a
 * retired tenant is not a home and never appears as a switch target.
 */
export async function listWorkspaceMembershipOptions(
  db: WorkspaceStoreD1,
  login: string,
): Promise<WorkspaceMembershipOption[]> {
  const rows = await db
    .prepare(
      `SELECT w.id AS id, w.slug AS slug, w.name AS name, wm.role AS role
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
         JOIN workspaces w ON w.id = wm.workspace_id
        WHERE u.github_login = ? COLLATE NOCASE AND w.deleted_at IS NULL
        ORDER BY w.name ASC, w.id ASC`,
    )
    .bind(login)
    .all<WorkspaceMembershipOption>();
  return rows.results;
}

/** The creation write face: prepared statements run as ONE `batch`. */
type WorkspaceStoreWriteD1 = {
  prepare(query: string): WorkspaceStoreStatement;
  batch(statements: WorkspaceStoreStatement[]): Promise<
    { results: unknown[]; meta: { changes: number; last_row_id: number } }[]
  >;
};

/** Why a slug write was refused: a guard hit, or the target row is gone. */
export type WorkspaceSlugConflict = "slug_taken" | "slug_is_workspace_id" | "workspace_not_found";

/**
 * The rename: both guards live in the UPDATE's own WHERE, so the statement is
 * atomic by construction — a guard hit changes no row (`changes === 0`), which
 * is what a two-statement pre-check batch cannot promise. The guards are the
 * pinned pair: no OTHER workspace may carry the slug in any case, and the value
 * may not be any workspace's id (that would make the path ref ambiguous). The
 * TARGET must still be live — a workspace soft-deleted between the caller's
 * resolution and this statement is a vanished row, not a rename.
 */
const SET_SLUG_SQL = `UPDATE workspaces SET slug = ?1
   WHERE id = ?2
     AND deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM workspaces WHERE slug = ?1 COLLATE NOCASE AND id <> ?2)
     AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = ?1 AND id <> ?2)`;

/** Which guard matched, read once after a refused write (index order = precedence). */
const SLUG_CONFLICT_SQL = `SELECT
     EXISTS (SELECT 1 FROM workspaces WHERE slug = ?1 COLLATE NOCASE AND id <> ?2) AS slug_taken,
     EXISTS (SELECT 1 FROM workspaces WHERE id = ?1 AND id <> ?2) AS id_taken`;

/**
 * Rename one workspace's slug. Returns the conflict that refused the write, or
 * null when it landed. A concurrent write that slipped past the guards is
 * caught by the UNIQUE index and maps to `slug_taken`, never a 500.
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
    // Pinned to the D1 driver's message, the only conflict signal it exposes:
    // if that wording drifts this falls through to a 500 (visible, not a wrong
    // 409). Re-check when the D1 face starts carrying a structured error code.
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) return "slug_taken";
    throw err;
  }
  if (changes > 0) return null;
  const guard = await db
    .prepare(SLUG_CONFLICT_SQL)
    .bind(slug, workspaceId)
    .first<{ slug_taken: number; id_taken: number }>();
  if (guard?.slug_taken) return "slug_taken";
  if (guard?.id_taken) return "slug_is_workspace_id";
  // Neither guard matched, so the WHERE's `id = ?2 AND deleted_at IS NULL` hit
  // no live row: the workspace was soft-deleted between the caller's resolution
  // and this statement. A vanished row is the 404 family, not a conflict.
  return "workspace_not_found";
}

/**
 * The free-slot guard, as a SQL condition every insert of the creation batch
 * carries: "this login holds no live free membership yet". Re-reading it inside
 * the batch is what closes the read-then-write window — two concurrent
 * creations both pass the route's fast-fail read, and the second one's
 * predicates all evaluate false, so its batch writes zero rows. Parameters:
 * `?5` the login, `?6` the free plan id; the rest of each statement binds
 * `?1` id, `?2` name, `?3` user id, `?4` created stamp. `?1` is excluded from
 * the count because the statements run in sequence inside one transaction: by
 * the subscription insert, the owner membership above is already visible.
 */
const FREE_SLOT_GUARD_SQL = `(SELECT COUNT(*)
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
       JOIN workspaces w ON w.id = m.workspace_id
       LEFT JOIN workspace_subscriptions s
              ON s.workspace_id = w.id AND s.status = 'active'
      WHERE u.github_login = ?5 COLLATE NOCASE
        AND w.deleted_at IS NULL
        AND w.id <> ?1
        AND (s.plan_id IS NULL OR s.plan_id = ?6)) < 1`;

/**
 * Create one workspace, its creator's `owner` membership and its `free`
 * subscription as ONE `batch` — a workspace without an owner, or an owner
 * without a workspace, must never be observable. `slug` equals `id` by
 * contract (the id is already lowercase, so the two can never disagree on
 * case).
 *
 * The free slot is enforced BY the write: all three inserts carry
 * {@link FREE_SLOT_GUARD_SQL}, so a login that already holds a live free
 * workspace gets zero rows from every statement and the refusal leaves nothing
 * behind (a `batch` that committed cannot be rolled back after the fact, so
 * the guard has to be part of each statement rather than a check after it).
 *
 * The rule binds `saas` only (spec §3/§4): `self-hosted` resolves every
 * workspace to `unlimited`, so creation is always allowed there — the insert
 * then carries no guard at all, while the `free` subscription row is still
 * written unchanged (it records what SaaS would resolve). In `saas` the guard
 * and its binds are untouched.
 *
 * Returns false when the slug is already taken (the UNIQUE index is the final
 * word), so the caller can mint another id instead of 500ing. Throws
 * {@link FreeWorkspaceSlotError} when the guard refused.
 */
export async function createWorkspace(
  db: WorkspaceStoreWriteD1,
  input: {
    id: string;
    name: string;
    userId: string;
    githubLogin: string;
    createdAt: string;
  },
  mode: DeploymentMode,
): Promise<boolean> {
  const binds = [
    input.id,
    input.name,
    input.userId,
    input.createdAt,
    input.githubLogin,
    FREE_PLAN_ID,
  ] as const;
  const guarded = mode === "saas";
  const slotGuard = guarded ? ` WHERE ${FREE_SLOT_GUARD_SQL}` : "";
  // Without the guard the workspace and membership inserts reference `?1`–`?4`
  // only; the subscription still binds the plan id as `?6` (indexes 2 and 5
  // stay bound but unused, as SQLite requires every index up to the highest).
  const slotBinds: readonly unknown[] = guarded ? binds : binds.slice(0, 4);
  let results: { results: unknown[]; meta: { changes: number; last_row_id: number } }[];
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
           SELECT ?1, ?1, ?2, ?3, ?4, NULL${slotGuard}`,
        )
        .bind(...slotBinds),
      db
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
           SELECT ?1, ?3, 'owner', ?4${slotGuard}`,
        )
        .bind(...slotBinds),
      db
        .prepare(
          `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
           SELECT ?1, ?6, 'active', ?4, ?4${slotGuard}`,
        )
        .bind(...binds),
    ]);
  } catch (err) {
    // The batch aborts as a unit, so a taken slug leaves no orphan membership.
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) return false;
    throw err;
  }
  // The guard refused: every statement wrote zero rows, so nothing to undo.
  // Self-hosted has no guard, so it can never reach this refusal.
  if (guarded && results[1]!.meta.changes === 0) {
    throw new FreeWorkspaceSlotError(FREE_SLOT_REFUSAL);
  }
  return results[0]!.meta.changes > 0;
}

/**
 * Retire one workspace as ONE `batch`: stamp `deleted_at`, cancel the active
 * subscription, drop every membership and revoke the pending invites. The row
 * itself is never hard-deleted — every live read filters `deleted_at IS NULL`,
 * so the tenant stops resolving while its history stays readable. The
 * subscription goes with the tenant: a retired workspace must not leave an
 * `active` plan row for a later billing or support read to pick up.
 *
 * Returns whether THIS call retired the workspace: the `deleted_at IS NULL`
 * guard means a replay changes no row, so a caller can tell "retired now" from
 * "already gone, or never existed". The HTTP route still answers 200 on its
 * idempotent path (a replay never reaches here — the tenant gate 404s it).
 */
export async function deleteWorkspace(
  db: WorkspaceStoreWriteD1,
  workspaceId: string,
  deletedAt: string,
): Promise<boolean> {
  const [retired] = await db.batch([
    db
      .prepare(`UPDATE workspaces SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .bind(deletedAt, workspaceId),
    db
      .prepare(
        `UPDATE workspace_subscriptions SET status = 'canceled', updated_at = ?
          WHERE workspace_id = ? AND status = 'active'`,
      )
      .bind(deletedAt, workspaceId),
    db.prepare(`DELETE FROM workspace_members WHERE workspace_id = ?`).bind(workspaceId),
    db
      .prepare(
        `UPDATE workspace_invites SET status = 'revoked'
          WHERE workspace_id = ? AND status = 'pending'`,
      )
      .bind(workspaceId),
  ]);
  return retired!.meta.changes > 0;
}
