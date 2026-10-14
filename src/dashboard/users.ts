/**
 * Dashboard membership store + OAuth-callback bootstrap decision
 * (spec dashboard-multi-app-platform.md § AuthZ + § Data model).
 *
 * Self-contained on purpose (route isolation, architect decision Q2 — the
 * dashboard/index.ts header contract): NO pipeline/store/review imports.
 * The narrow D1 face below mirrors src/store/types.ts `D1Like`
 * structurally, so a real `D1Database` and the bun:sqlite test double both
 * satisfy it; the store's only multi-write paths are removal (tombstone +
 * delete) and (re-)invite (insert + tombstone clear), each one `batch`.
 *
 * Bootstrap precedence is EXACT (spec § AuthZ), evaluated in order:
 *   1. user row exists          → allow, zero writes
 *   2. login was removed        → deny (an operator's removal outranks the
 *                                  allowlist — migration 0023; enforced both
 *                                  by a read and by the bootstrap insert
 *                                  itself, and cleared only by a deliberate
 *                                  re-invite)
 *   3. ADMIN_LOGINS contains it → create admin row, allow
 *   4. table empty AND
 *      ADMIN_LOGINS unset       → create admin row, allow (first-login
 *                                  fallback for the deploying operator)
 *   5. otherwise                → deny (caller renders the 403 page with
 *                                  zero Set-Cookie; this module wrote
 *                                  nothing)
 *
 * There is NO status column: removal = row delete (migration 0003), and that
 * delete records a tombstone in the SAME transaction (migration 0023) so the
 * allowlist cannot resurrect a login an operator removed. Removal state has
 * exactly two writers — the removal batch (records it) and createUser (clears
 * it, deliberate re-admission); the automatic bootstrap path touches neither,
 * so an in-flight OAuth callback cannot undo a removal. The delete is what
 * makes removed members' stateless cookies fail the per-request guard — never
 * soften this into a flag.
 *
 * Case handling: GitHub logins are case-insensitive upstream, so row
 * lookups, ADMIN_LOGINS comparison and the removal record are
 * case-insensitive; the UNIQUE index on github_login backstops exact-case
 * duplicates at the DDL layer.
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
 * `D1Like`): single-statement reads and writes, plus `batch` — the only
 * multi-write paths are a removal (tombstone + row delete) and a (re-)invite
 * (row insert + tombstone clear), each ONE `batch` transaction. A real
 * `D1Database` statement face satisfies this structurally.
 */
export type DashboardD1 = {
  prepare(query: string): DashboardD1Statement;
  batch(statements: DashboardD1Statement[]): Promise<DashboardD1BatchResult[]>;
};

// --- ADMIN_LOGINS parsing ---

/**
 * Parse the ADMIN_LOGINS var: comma-separated GitHub logins, trimmed;
 * empty entries dropped. Unset / empty / whitespace-only → [] (the var is
 * then "not configured" for bootstrap rule 3). Entries keep their original
 * case — matching lowercases both sides instead (GitHub logins are
 * case-insensitive).
 *
 * Twin rule: the `.github/workflows/deploy.yml` pre-deploy required-input
 * check and the deployed-Worker assertion both import and call THIS function
 * (via `bun -e`), so they apply the runtime rule itself rather than a shell
 * approximation of it — a rule change here reaches all three sites.
 * `docs/deploy.md` § 6 documents the same contract.
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
 * Insert one membership row (caller-supplied UUID, like 0001 reviews.id).
 * DELIBERATE creation — an admin's invite on the Members page, or a fixture —
 * so it also clears any removal record for that login in the same batch: an
 * explicit (re-)admission is the only thing allowed to undo a removal. The
 * automatic OAuth bootstrap does NOT call this function; it uses
 * bootstrapCreateAdmin, which never clears removal state.
 *
 * Idempotent on an exact-case UNIQUE race: a concurrent callback that won
 * the insert has written THIS user's row — re-read and return it
 * (same first-written-row-wins convention as the D1 ArtifactStore put).
 *
 * A CASE-VARIANT race (migration 0016 NOCASE unique index — the 0003 BINARY
 * UNIQUE does not fire across cases) is surfaced as DuplicateLoginError so
 * the invite route can answer 409 instead of silently minting a dead second
 * row (W-1): bun:sqlite absorbs the NOCASE-index conflict into `ON CONFLICT
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
      // re-invited login bootstrappable again (migration 0023). Bootstrap has
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

/**
 * The last-admin guard, shared by BOTH statements of the removal batch: a row
 * is removable only when it is not the sole remaining admin.
 */
const NOT_LAST_ADMIN =
  "NOT (role = 'admin' AND (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1)";

/** Case-insensitive tombstone lookup — same NOCASE comparison as getUserByLogin. */
export async function isLoginRemoved(db: DashboardD1, login: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS removed FROM removed_logins WHERE github_login = ? COLLATE NOCASE")
    .bind(login)
    .first<{ removed: number }>();
  return row !== null;
}

/**
 * Removal = record the login as removed (migration 0023) AND delete its row,
 * as ONE D1 `batch` — a transaction (d1-batch-atomicity), so a removal can
 * never be recorded without the row actually being gone, or a row deleted
 * without being recorded. The tombstone statement reads the row's login under
 * the SAME `condition` as the DELETE (and both evaluate it inside the one
 * transaction), so a refused removal writes nothing on either side.
 * `removedBy` is the acting admin's login, NULL when the caller has no actor
 * in scope. Returns true when the row was deleted.
 */
async function removeUser(
  db: DashboardD1,
  id: string,
  removedBy: string | null,
  condition?: string,
): Promise<boolean> {
  const guard = condition ? ` AND ${condition}` : "";
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO removed_logins (github_login, removed_at, removed_by)
         SELECT github_login, ?, ? FROM users WHERE id = ?${guard}
         ON CONFLICT (github_login) DO UPDATE
           SET removed_at = excluded.removed_at, removed_by = excluded.removed_by`,
      )
      .bind(new Date().toISOString(), removedBy, id),
    db.prepare(`DELETE FROM users WHERE id = ?${guard}`).bind(id),
  ]);
  return results[1]!.meta.changes > 0;
}

/**
 * Remove by row id (row id avoids login case ambiguity). The removal is
 * recorded, so a later `bootstrapDashboardAccess` denies the login even when
 * the ADMIN_LOGINS allowlist still lists it.
 */
export async function deleteUser(
  db: DashboardD1,
  id: string,
  removedBy: string | null = null,
): Promise<boolean> {
  return removeUser(db, id, removedBy);
}

/**
 * Remove by row id UNLESS the row is the last remaining admin — the guard
 * rides BOTH statements of the removal batch, so the last-admin invariant
 * still does not ride a read-check-then-delete window (qc1): two concurrent
 * removes of the last two admins cannot both land; the loser's DELETE takes no
 * row AND records no tombstone. Returns true when the row was deleted.
 */
export async function deleteUserUnlessLastAdmin(
  db: DashboardD1,
  id: string,
  removedBy: string | null = null,
): Promise<boolean> {
  return removeUser(db, id, removedBy, NOT_LAST_ADMIN);
}

/**
 * Change a user's role UNLESS the row is the last remaining admin being
 * demoted — ONE conditional statement, so the last-admin invariant does
 * not ride a read-check-then-update window (deleteUserUnlessLastAdmin
 * precedent, qc1): two concurrent demotions of the last two admins cannot
 * both land; the loser sees changes === 0. Returns true when the role
 * actually changed (setting the same role is a no-op, changes === 0).
 *
 * Atomicity basis (qc2/qc3 W-002): the guard subquery
 * `(SELECT COUNT(*) FROM users WHERE role = 'admin')` is evaluated INSIDE
 * the same statement as the write, and the statement is atomic — SQLite
 * serializes concurrent writers on the write lock, and D1 runs each
 * statement as its own serialized transaction (single-writer model), so
 * the count cannot observe a half-applied concurrent demotion. The local
 * bun:sqlite harness validates the SQL under serialization; the production
 * guarantee is D1's write serialization — a platform behavior, not
 * code-proven mutual exclusion (Needs L4/QA verification).
 */
export async function updateUserRoleUnlessLastAdmin(
  db: DashboardD1,
  id: string,
  role: "admin" | "member",
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users
       SET role = ?
       WHERE id = ?
         AND role <> ?
         AND NOT (role = 'admin' AND ? = 'member' AND (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1)`,
    )
    .bind(role, id, role, role)
    .run();
  return result.meta.changes > 0;
}

/** Total membership — bootstrap rule 3 keys on the EMPTY table (any role). */
export async function countUsers(db: DashboardD1): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Admin count — last-admin protection (remove guard). */
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
 * Bootstrap's OWN membership creation — deliberately not `createUser`: the
 * automatic OAuth path must never clear removal state, and its insert must be
 * refused at the WRITE boundary. ONE statement both tests the removal record
 * and inserts (there is no read-check-then-insert window to lose):
 *
 *   INSERT INTO users … SELECT … WHERE NOT EXISTS (removal record for login)
 *
 * so a removal that lands *after* the caller's earlier reads is still refused
 * by the database. A refused insert resolves to the ordinary deny decision
 * having written nothing; `changes === 0` is classified by a re-read — an
 * existing row (exact-case or case-variant race) is a member and is allowed,
 * no row at all means the insert was refused. The removal record is compared
 * NOCASE, like every other login lookup (migration 0023).
 */
async function bootstrapCreateAdmin(db: DashboardD1, login: string): Promise<BootstrapDecision> {
  const row: DashboardUserRow = {
    id: crypto.randomUUID(),
    github_login: login,
    role: "admin",
    created_at: new Date().toISOString(),
    invited_by: null, // bootstrapped, not invited
  };
  let changes: number;
  try {
    const result = await db
      .prepare(
        `INSERT INTO users (id, github_login, role, created_at, invited_by)
         SELECT ?, ?, 'admin', ?, NULL
         WHERE NOT EXISTS (SELECT 1 FROM removed_logins WHERE github_login = ? COLLATE NOCASE)
         ON CONFLICT (github_login) DO NOTHING`,
      )
      .bind(row.id, row.github_login, row.created_at, row.github_login)
      .run();
    changes = result.meta.changes;
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
 * Decide membership for a GitHub-verified login at the OAuth callback.
 * Precedence (exact order, spec § AuthZ): row exists → allow; recorded
 * removal → deny (an operator's removal outranks the allowlist); ADMIN_LOGINS
 * contains login → create admin; table empty && ADMIN_LOGINS unset →
 * create admin; else deny. The deny branch performs ZERO writes — the caller
 * must render the 403 page with zero Set-Cookie.
 *
 * The removal rule is enforced twice on purpose: the read below is the fast
 * path for the common case, and bootstrapCreateAdmin's insert refuses AT THE
 * WRITE BOUNDARY — so a removal landing after the reads still denies instead
 * of resurrecting the login (and never clears the removal record).
 */
export async function bootstrapDashboardAccess(
  db: DashboardD1,
  login: string,
  adminLogins: string | undefined,
): Promise<BootstrapDecision> {
  const existing = await getUserByLogin(db, login);
  if (existing) return { outcome: "allow", user: existing, created: false };
  // A recorded removal denies even when the login is still on ADMIN_LOGINS
  // (migration 0023): without this the allowlist resurrected a removed admin
  // on its next OAuth login. Only a deliberate admin (re-)invite — createUser,
  // which clears the record — makes the login bootstrappable again.
  if (await isLoginRemoved(db, login)) return { outcome: "deny" };
  const admins = parseAdminLogins(adminLogins);
  if (isAdminLogin(admins, login)) return bootstrapCreateAdmin(db, login);
  if (admins.length === 0 && (await countUsers(db)) === 0) return bootstrapCreateAdmin(db, login);
  return { outcome: "deny" };
}
