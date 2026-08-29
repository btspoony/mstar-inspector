/**
 * Dashboard membership store + OAuth-callback bootstrap decision (plan 12
 * B4 Task 1; spec .mstar/iterations/v0.5/specs/dashboard-multi-app-platform.md
 * § AuthZ + § Data model).
 *
 * Self-contained on purpose (route isolation, architect decision Q2 — the
 * dashboard/index.ts header contract): NO pipeline/store/review imports.
 * The narrow D1 face below mirrors src/store/types.ts `D1Like`
 * structurally, so a real `D1Database` and the bun:sqlite test double both
 * satisfy it; the store only ever needs single statements (no batch).
 *
 * Bootstrap precedence is EXACT (spec § AuthZ), evaluated in order:
 *   1. user row exists          → allow, zero writes
 *   2. ADMIN_LOGINS contains it → create admin row, allow
 *   3. table empty AND
 *      ADMIN_LOGINS unset       → create admin row, allow (first-login
 *                                  fallback for the deploying operator)
 *   4. otherwise                → deny (caller renders the 403 page with
 *                                  zero Set-Cookie; this module wrote
 *                                  nothing)
 *
 * There is NO status column: removal = row delete (migration 0003). That
 * delete is what makes removed members' stateless cookies fail the plan 12
 * Task 2 per-request guard — never soften this into a flag.
 *
 * Case handling: GitHub logins are case-insensitive upstream, so row
 * lookups and ADMIN_LOGINS comparison are case-insensitive; the UNIQUE
 * index on github_login backstops exact-case duplicates at the DDL layer.
 */

/** A row of the `users` table (D1 column names, snake_case; migration 0003). */
export type DashboardUserRow = {
  id: string;
  github_login: string;
  role: "admin" | "member";
  created_at: string;
  /** NULL = bootstrapped (ADMIN_LOGINS / first-login fallback), not invited. */
  invited_by: string | null;
};

/**
 * Narrow D1 face the users store depends on (mirror of src/store/types.ts
 * `D1Like`, batch omitted — the users store writes single rows only).
 * A real `D1Database` statement face satisfies this structurally.
 */
export type DashboardD1Statement = {
  bind(...values: unknown[]): DashboardD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<{
    results: T[];
    meta: { changes: number; last_row_id: number };
  }>;
};

export type DashboardD1 = {
  prepare(query: string): DashboardD1Statement;
};

// --- ADMIN_LOGINS parsing ---

/**
 * Parse the ADMIN_LOGINS var: comma-separated GitHub logins, trimmed;
 * empty entries dropped. Unset / empty / whitespace-only → [] (the var is
 * then "not configured" for bootstrap rule 3). Entries keep their original
 * case — matching lowercases both sides instead (GitHub logins are
 * case-insensitive).
 */
export function parseAdminLogins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isAdminLogin(entries: string[], login: string): boolean {
  const needle = login.toLowerCase();
  return entries.some((entry) => entry.toLowerCase() === needle);
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
 * Insert one membership row (caller-supplied UUID, like 0001 reviews.id).
 * Idempotent on an exact-case UNIQUE race: a concurrent callback that won
 * the insert has written THIS user's row — re-read and return it
 * (same first-written-row-wins convention as the D1 ArtifactStore put).
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
  const result = await db
    .prepare(
      `INSERT INTO users (id, github_login, role, created_at, invited_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (github_login) DO NOTHING`,
    )
    .bind(row.id, row.github_login, row.role, row.created_at, row.invited_by)
    .run();
  if (result.meta.changes === 0) {
    const existing = await getUserByLogin(db, user.login);
    if (!existing) {
      throw new Error(
        `users: insert for ${JSON.stringify(user.login)} conflicted but no row was found`,
      );
    }
    return existing;
  }
  return row;
}

/**
 * Full membership list (Task 3 members page): oldest member first;
 * `github_login` breaks same-millisecond `created_at` ties so the display
 * order is deterministic (qc1/qc3).
 */
export async function listUsers(db: DashboardD1): Promise<DashboardUserRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM users ORDER BY created_at ASC, github_login ASC")
    .all<DashboardUserRow>();
  return results;
}

/** Remove by row id (Task 3 remove — row id avoids login case ambiguity). */
export async function deleteUser(db: DashboardD1, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}

/**
 * Remove by row id UNLESS the row is the last remaining admin — ONE
 * conditional statement, so the last-admin invariant does not ride a
 * read-check-then-delete window (qc1): two concurrent removes of the last
 * two admins cannot both land; the loser sees changes === 0. Returns true
 * when the row was deleted.
 */
export async function deleteUserUnlessLastAdmin(db: DashboardD1, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM users
       WHERE id = ?
         AND NOT (role = 'admin' AND (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1)`,
    )
    .bind(id)
    .run();
  return result.meta.changes > 0;
}

/** Total membership — bootstrap rule 3 keys on the EMPTY table (any role). */
export async function countUsers(db: DashboardD1): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Admin count — last-admin protection (Task 3 remove guard). */
export async function countAdmins(db: DashboardD1): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- bootstrap decision (OAuth callback hook, spec § AuthZ precedence) ---

export type BootstrapDecision =
  | { outcome: "allow"; user: DashboardUserRow; created: boolean }
  | { outcome: "deny" };

/**
 * Decide membership for a GitHub-verified login at the OAuth callback.
 * Precedence (exact order, spec § AuthZ): row exists → allow; ADMIN_LOGINS
 * contains login → create admin; table empty && ADMIN_LOGINS unset →
 * create admin; else deny. The deny branch performs ZERO writes — the
 * caller must render the 403 page with zero Set-Cookie.
 */
export async function bootstrapDashboardAccess(
  db: DashboardD1,
  login: string,
  adminLogins: string | undefined,
): Promise<BootstrapDecision> {
  const existing = await getUserByLogin(db, login);
  if (existing) return { outcome: "allow", user: existing, created: false };
  const admins = parseAdminLogins(adminLogins);
  if (isAdminLogin(admins, login)) {
    return { outcome: "allow", user: await createUser(db, { login, role: "admin" }), created: true };
  }
  if (admins.length === 0 && (await countUsers(db)) === 0) {
    return { outcome: "allow", user: await createUser(db, { login, role: "admin" }), created: true };
  }
  return { outcome: "deny" };
}
