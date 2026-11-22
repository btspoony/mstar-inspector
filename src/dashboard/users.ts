
/** A row of the `users` table (D1 column names, snake_case; migration 0003). */
export type DashboardUserRow = {
  id: string;
  github_login: string;
  role: "admin" | "member";
  created_at: string;
  invited_by: string | null;
};

/** One prepared statement of the narrow D1 face below. */
export type DashboardD1Statement = {
  bind(...values: unknown[]): DashboardD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<{
    results: T[];
    meta: { changes: number; last_row_id: number };
  }>;
};

/** One statement's result inside a D1 `batch()` (order matches input). */
export type DashboardD1BatchResult = {
  results: unknown[];
  meta: { changes: number; last_row_id: number };
};

/**
 * Narrow D1 face the users store depends on (mirror of src/store/types.ts
 * `D1Like`): single-statement reads and writes, plus `batch` — the operator
 * removal (tombstone + membership delete + row delete) is ONE `batch`
 * transaction. A real `D1Database` statement face satisfies this structurally.
 */
export type DashboardD1 = {
  prepare(query: string): DashboardD1Statement;
  batch(statements: DashboardD1Statement[]): Promise<DashboardD1BatchResult[]>;
};


/**
 * Parse a comma-separated login list: entries trimmed, empties dropped.
 * Unset / empty / whitespace-only → []. Entries keep their original case —
 * matching lowercases both sides instead (GitHub logins are case-insensitive;
 * the caller owns the comparison).
 */
export function parseLoginList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}


/** Case-insensitive lookup (GitHub logins are case-insensitive upstream). */
export async function getUserByLogin(
  db: DashboardD1,
  login: string,
): Promise<DashboardUserRow | null> {
  return db
    .prepare("SELECT * FROM users WHERE github_login = ? COLLATE NOCASE")
    .bind(login)
    .first<DashboardUserRow>();
}

/**
 * Thrown by createUser when a concurrent case-variant row wins the insert
 * (migration 0016 NOCASE unique index). createUser has no production caller
 * at this head: only fixtures and tests observe this error.
 */
export class DuplicateLoginError extends Error {
  constructor(login: string) {
    super(`users: a row for ${JSON.stringify(login)} already exists (case-insensitive)`);
    this.name = "DuplicateLoginError";
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof Error) {
    if ("code" in err && typeof err.code === "string" && err.code.includes("UNIQUE")) return true;
    return /UNIQUE constraint failed/i.test(err.message);
  }
  return false;
}

/**
 * Insert one users row (caller-supplied UUID, like 0001 reviews.id).
 * DELIBERATE creation — a fixture, an operator's re-admission — so it also
 * clears any removal record for that login in the same batch: an explicit
 * (re-)admission is the only thing allowed to undo a removal. The automatic
 * sign-in path does NOT call this function; it uses {@link signInDashboardUser},
 * which never clears removal state.
 *
 * It deliberately writes NO `workspace_members` row: admission into a
 * workspace is either its creation (creator becomes `owner`) or an accepted
 * invite, never a side effect of a users row. A login with no membership is a
 * non-member everywhere — under `strict` that is the outsider 404.
 *
 * Idempotent on an exact-case UNIQUE race: a concurrent callback that won
 * the insert has written THIS user's row — re-read and return it
 * (same first-written-row-wins convention as the D1 ArtifactStore put).
 *
 * A CASE-VARIANT race (migration 0016 NOCASE unique index — the 0003 BINARY
 * UNIQUE does not fire across cases) is surfaced as DuplicateLoginError so
 * the caller can answer 409 instead of silently minting a dead second row
 * (W-1): bun:sqlite absorbs the NOCASE-index conflict into `ON CONFLICT
 * (github_login)` (changes === 0 → the case-variant re-read discriminator
 * below throws); if D1 instead raises the constraint error, the catch maps
 * it to the same typed error.
 */
export async function createUser(
  db: DashboardD1,
  user: { login: string; role: "admin" | "member"; invitedBy?: string | null },
): Promise<DashboardUserRow> {
  const row: DashboardUserRow = {
    id: crypto.randomUUID(),
    github_login: user.login,
    role: user.role,
    created_at: new Date().toISOString(),
    invited_by: user.invitedBy ?? null,
  };
  let inserted: DashboardD1BatchResult;
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO users (id, github_login, role, created_at, invited_by)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (github_login) DO NOTHING`,
        )
        .bind(row.id, row.github_login, row.role, row.created_at, row.invited_by),
      db
        .prepare("DELETE FROM removed_logins WHERE github_login = ? COLLATE NOCASE")
        .bind(user.login),
    ]);
    inserted = results[0]!;
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new DuplicateLoginError(user.login);
    throw err;
  }
  if (inserted.meta.changes === 0) {
    const existing = await getUserByLogin(db, user.login);
    if (!existing) {
      throw new Error(
        `users: insert for ${JSON.stringify(user.login)} conflicted but no row was found`,
      );
    }
    if (existing.github_login !== user.login) {
      throw new DuplicateLoginError(user.login);
    }
    return existing;
  }
  return row;
}

/**
 * Full membership list (members page): oldest member first;
 * `github_login` breaks same-millisecond `created_at` ties so the display
 * order is deterministic (qc1/qc3).
 */
export async function listUsers(db: DashboardD1): Promise<DashboardUserRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM users ORDER BY created_at ASC, github_login ASC")
    .all<DashboardUserRow>();
  return results;
}


/** Case-insensitive tombstone lookup — same NOCASE comparison as getUserByLogin. */
export async function isLoginRemoved(db: DashboardD1, login: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS removed FROM removed_logins WHERE github_login = ? COLLATE NOCASE")
    .bind(login)
    .first<{ removed: number }>();
  return row !== null;
}

async function removeUser(db: DashboardD1, id: string, removedBy: string | null): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO removed_logins (github_login, removed_at, removed_by)
         SELECT github_login, ?, ? FROM users WHERE id = ?
         ON CONFLICT (github_login) DO UPDATE
           SET removed_at = excluded.removed_at, removed_by = excluded.removed_by`,
      )
      .bind(new Date().toISOString(), removedBy, id),
    db.prepare("DELETE FROM workspace_members WHERE user_id = ?").bind(id),
    db.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  return results[2]!.meta.changes > 0;
}

/**
 * Remove by row id (row id avoids login case ambiguity). The removal is
 * recorded, so a later sign-in ({@link signInDashboardUser}) denies the login
 * until a deliberate re-admission clears the record.
 */
export async function deleteUser(
  db: DashboardD1,
  id: string,
  removedBy: string | null = null,
): Promise<boolean> {
  return removeUser(db, id, removedBy);
}


/** `workspace_members.role` domain (0026 CHECK; `workspace-store` owns the same type). */
export type WorkspaceMemberRole = "owner" | "admin" | "member";

function notSoleOwner(workspaceId: string, userId: string): { sql: string; params: string[] } {
  return {
    sql: `NOT (
      (SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?) = 'owner'
      AND (SELECT COUNT(*) FROM workspace_members o WHERE o.workspace_id = ? AND o.role = 'owner') <= 1
    )`,
    params: [workspaceId, userId, workspaceId],
  };
}

/**
 * Remove one user from one workspace: delete the membership row and nothing
 * else. A workspace is a container, so leaving it must not destroy the
 * person's identity — the `users` row survives (they stay signed in, keep
 * their invites as `invited_by`, and can be invited elsewhere or create their
 * own workspace), and the deployment-level `removed_logins` tombstone is
 * written ONLY by the operator removal path (`removeUser`, migration 0023),
 * never as a side effect of a workspace membership change.
 *
 * Removal is therefore independent of the operator path: that path hard-deletes
 * the `users` row, and `workspace_invites.invited_by` is `ON DELETE SET NULL`
 * (0028), so authored invites survive as anonymous history instead of rolling
 * the delete back. The membership itself is the only workspace-scoped artifact
 * keyed by the member; accepted invites stay as history.
 *
 * A sole owner, or a target that is not in this workspace, is refused with
 * zero writes. Returns true when this workspace's membership was removed.
 */
export async function deleteWorkspaceMember(
  db: DashboardD1,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const guard = notSoleOwner(workspaceId, userId);
  const result = await db
    .prepare(
      `DELETE FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND ${guard.sql}`,
    )
    .bind(workspaceId, userId, ...guard.params)
    .run();
  return result.meta.changes > 0;
}

/**
 * Change one member's role INSIDE one workspace, including promotion to
 * `owner` — that promotion IS the ownership-transfer path (there is no separate
 * transfer action). `users.role` is NOT written: `workspace_members.role` is the
 * only role surface after this plan, and the legacy column is never read for a
 * workspace-scoped decision.
 *
 * The sole-owner guard rides the same statement, so demoting the last owner is
 * a 0-row update, not a read-check-then-write window. The guard reads the
 * target's CURRENT role, so it never refuses a promotion. Returns true when the
 * role changed (same-role write is a 0-row no-op).
 */
export async function updateWorkspaceMemberRole(
  db: DashboardD1,
  workspaceId: string,
  userId: string,
  role: WorkspaceMemberRole,
): Promise<boolean> {
  const guard = notSoleOwner(workspaceId, userId);
  const result = await db
    .prepare(
      `UPDATE workspace_members SET role = ?
        WHERE workspace_id = ? AND user_id = ? AND role <> ? AND ${guard.sql}`,
    )
    .bind(role, workspaceId, userId, role, ...guard.params)
    .run();
  return result.meta.changes > 0;
}

/** Total users rows on the deployment (any role) — fixtures and tests. */
export async function countUsers(db: DashboardD1): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}


export type SignInDecision =
  | { outcome: "allow"; user: DashboardUserRow; created: boolean }
  | { outcome: "deny" };

async function signInCreateUser(db: DashboardD1, login: string): Promise<SignInDecision> {
  const row: DashboardUserRow = {
    id: crypto.randomUUID(),
    github_login: login,
    role: "member",
    created_at: new Date().toISOString(),
    invited_by: null,
  };
  let changes: number;
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO users (id, github_login, role, created_at, invited_by)
           SELECT ?, ?, 'member', ?, NULL
           WHERE NOT EXISTS (SELECT 1 FROM removed_logins WHERE github_login = ? COLLATE NOCASE)
           ON CONFLICT (github_login) DO NOTHING`,
        )
        .bind(row.id, row.github_login, row.created_at, row.github_login),
    ]);
    changes = results[0]!.meta.changes;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    changes = 0;
  }
  if (changes > 0) return { outcome: "allow", user: row, created: true };
  const existing = await getUserByLogin(db, login);
  return existing
    ? { outcome: "allow", user: existing, created: false }
    : { outcome: "deny" };
}

/**
 * Decide access for a GitHub-verified login at the OAuth callback. Precedence
 * (exact order): row exists → allow, zero writes; recorded removal → deny; any
 * other login → create a `member` row, allow. Sign-in never consults a
 * deployment allowlist and never joins a workspace. The deny
 * branch performs ZERO writes — the caller must render the 403 page with zero
 * Set-Cookie.
 *
 * The removal rule is enforced twice on purpose: the read below is the fast
 * path for the common case, and signInCreateUser's insert refuses AT THE WRITE
 * BOUNDARY — so a removal landing after the reads still denies instead of
 * resurrecting the login (and never clears the removal record).
 */
export async function signInDashboardUser(
  db: DashboardD1,
  login: string,
): Promise<SignInDecision> {
  const existing = await getUserByLogin(db, login);
  if (existing) return { outcome: "allow", user: existing, created: false };
  if (await isLoginRemoved(db, login)) return { outcome: "deny" };
  return signInCreateUser(db, login);
}
