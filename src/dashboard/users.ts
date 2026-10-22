/**
 * Dashboard users store + OAuth-callback sign-in decision
 * (spec dashboard-multi-app-platform.md § AuthZ + § Data model).
 *
 * Self-contained on purpose (route isolation, architect decision Q2 — the
 * dashboard/index.ts header contract): NO pipeline/store/review imports.
 * The narrow D1 face below mirrors src/store/types.ts `D1Like`
 * structurally, so a real `D1Database` and the bun:sqlite test double both
 * satisfy it; the store's multi-write path — operator removal (tombstone +
 * membership delete + row delete) — is ONE `batch`.
 *
 * Sign-in is NOT operator-gated (plan 97 AC1): a `users` row is the only
 * requirement, so any GitHub login completes the OAuth callback. There is no
 * deployment allowlist and no first-login promotion — a new row carries
 * `role = 'member'` (the legacy column is never read for a workspace
 * authorization decision) and NO workspace membership: admission into a
 * workspace is its creation (creator becomes `owner`) or an accepted invite.
 *
 * Sign-in precedence is EXACT, evaluated in order:
 *   1. user row exists   → allow, zero writes
 *   2. login was removed → deny (migration 0023; enforced both by a read and
 *                          by the insert itself, and cleared only by a
 *                          deliberate re-admission)
 *   3. otherwise         → create a `member` row, allow
 *
 * There is NO status column: operator removal = row delete (migration 0003),
 * and that delete records a tombstone in the SAME transaction (migration 0023)
 * so a later sign-in cannot resurrect a login an operator removed. Removal
 * state has exactly two writers — the operator removal batch (records it) and
 * createUser (clears it, deliberate re-admission); the automatic sign-in path
 * touches neither, so an in-flight OAuth callback cannot undo a removal.
 * Leaving a WORKSPACE is not that: {@link deleteWorkspaceMember} deletes the
 * membership row only, so it writes neither the tombstone nor the users row.
 *
 * Case handling: GitHub logins are case-insensitive upstream, so row
 * lookups and the removal record are case-insensitive; the UNIQUE index on
 * github_login backstops exact-case duplicates at the DDL layer.
 */

/** A row of the `users` table (D1 column names, snake_case; migration 0003). */
export type DashboardUserRow = {
  id: string;
  github_login: string;
  role: "admin" | "member";
  created_at: string;
  /** NULL = created at sign-in, not invited. */
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

// --- login-list parsing (comma-separated configuration values) ---

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

// --- users store ---

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
 * (migration 0016 NOCASE unique index) — the invite route maps it to 409
 * duplicate-invite semantics; bootstrap re-reads and allows.
 */
export class DuplicateLoginError extends Error {
  constructor(login: string) {
    super(`users: a row for ${JSON.stringify(login)} already exists (case-insensitive)`);
    this.name = "DuplicateLoginError";
  }
}

/** UNIQUE-constraint detection that tolerates bun:sqlite and D1 error shapes. */
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
      // A deliberate (re-)creation is the ONLY thing that may undo a removal:
      // clearing the tombstone in the SAME batch as the insert is what makes a
      // re-admitted login bootstrappable again (migration 0023). Bootstrap has
      // its own creation path (bootstrapCreateAdmin) that never clears removal
      // state — an in-flight OAuth callback must not be able to undo a removal
      // that landed after its reads.
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
      // Case-variant conflict (migration 0016 NOCASE unique index): the row
      // exists under a different casing. The 0003 BINARY UNIQUE does not
      // fire across cases, so ON CONFLICT (github_login) absorbed the
      // NOCASE-index conflict here — surface it as DuplicateLoginError so
      // the invite route can answer 409 duplicate-invite semantics (W-1).
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

// --- removal: the tombstone and the row delete are ONE transaction (0023) ---

/** Case-insensitive tombstone lookup — same NOCASE comparison as getUserByLogin. */
export async function isLoginRemoved(db: DashboardD1, login: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS removed FROM removed_logins WHERE github_login = ? COLLATE NOCASE")
    .bind(login)
    .first<{ removed: number }>();
  return row !== null;
}

/**
 * Removal = record the login as removed (migration 0023), drop the user's
 * workspace memberships and delete its row, as ONE D1 `batch` — a transaction
 * (d1-batch-atomicity), so a removal can never be recorded without the row
 * actually being gone, or a row deleted without being recorded. `removedBy` is
 * the acting member's login, NULL when the caller has no actor in scope.
 * Returns true when the row was deleted.
 */
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
    // The workspace side first: 0026 declares `workspace_members.user_id
    // REFERENCES users(id)` with no cascade, so the row delete below is
    // impossible while a membership points at it.
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

// --- workspace membership: removal, role change (migration 0026) ---

/** `workspace_members.role` domain (0026 CHECK; `workspace-store` owns the same type). */
export type WorkspaceMemberRole = "owner" | "admin" | "member";

/**
 * The sole-owner guard, workspace-scoped (migration 0026): a row may not be
 * removed or demoted when it is the only `owner` of its workspace — a
 * workspace can never be left without one. `role` is the target row's CURRENT
 * role, so a promotion to `owner` is never refused by it.
 *
 * The condition is parameterized so EVERY statement of a batch carries the
 * same predicate (the `NOT_LAST_ADMIN` 0023 precedent), and it is evaluated
 * inside the writing statement — never a read-check-then-write window.
 */
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
 * This also keeps the delete legal: `workspace_invites.invited_by` references
 * `users(id)` with NO ACTION (0028), so a `users` delete would roll the batch
 * back for anyone who ever created an invite. The membership itself is the only
 * workspace-scoped artifact keyed by the member; accepted invites stay as
 * history.
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

// --- sign-in decision (OAuth callback hook) ---

export type SignInDecision =
  | { outcome: "allow"; user: DashboardUserRow; created: boolean }
  | { outcome: "deny" };

/**
 * Sign-in's OWN row creation — deliberately not `createUser`: the automatic
 * OAuth path must never clear removal state, and its insert must be refused at
 * the WRITE boundary. ONE statement both tests the removal record and inserts
 * (there is no read-check-then-insert window to lose):
 *
 *   INSERT INTO users … SELECT … WHERE NOT EXISTS (removal record for login)
 *
 * so a removal that lands *after* the caller's earlier reads is still refused
 * by the database. A refused insert resolves to the ordinary deny decision
 * having written nothing; `changes === 0` is classified by a re-read — an
 * existing row (exact-case or case-variant race) is signed in and is allowed,
 * no row at all means the insert was refused. The removal record is compared
 * NOCASE, like every other login lookup (migration 0023).
 *
 * The row carries `role = 'member'` (the column is NOT NULL; its value is
 * never read for a workspace authorization decision) and writes NO
 * `workspace_members` row — sign-in joins nobody to a workspace.
 */
async function signInCreateUser(db: DashboardD1, login: string): Promise<SignInDecision> {
  const row: DashboardUserRow = {
    id: crypto.randomUUID(),
    github_login: login,
    role: "member",
    created_at: new Date().toISOString(),
    invited_by: null, // signed in, not invited
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
    // D1 raises where bun:sqlite absorbs into ON CONFLICT: the row exists (a
    // case-variant race) — classify it below instead of 500ing the callback.
    if (!isUniqueConstraintError(err)) throw err;
    changes = 0;
  }
  if (changes > 0) return { outcome: "allow", user: row, created: true };
  const existing = await getUserByLogin(db, login);
  return existing
    ? { outcome: "allow", user: existing, created: false }
    : { outcome: "deny" }; // refused by the removal record — nothing was written
}

/**
 * Decide access for a GitHub-verified login at the OAuth callback. Precedence
 * (exact order): row exists → allow, zero writes; recorded removal → deny; any
 * other login → create a `member` row, allow. Sign-in never consults a
 * deployment allowlist and never joins a workspace (plan 97 AC1/AC3). The deny
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
  // A recorded removal denies (migration 0023): only a deliberate re-admission
  // — createUser, which clears the record — lets the login back in.
  if (await isLoginRemoved(db, login)) return { outcome: "deny" };
  return signInCreateUser(db, login);
}
