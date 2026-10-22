/**
 * Workspace invitation store — the one write/read authority for
 * `workspace_invites` (migration 0028 is the DDL single source).
 *
 * An invite is the only way into a workspace besides owning it by creation: a
 * signed-in login holding a live `pending` row may accept it, and acceptance
 * writes the `workspace_members` row in the SAME batch. `owner` is not
 * invitable — ownership comes from workspace creation or an explicit
 * owner-only promote.
 *
 * Expiry is a LAZY FLIP, never a timer: every invite write path runs
 * `UPDATE … SET status = 'expired' WHERE … expires_at <= ?` as its FIRST
 * statement, inside its own `db.batch`, and the reads keep the
 * `status = 'pending' AND expires_at > ?` predicate. A lapsed row therefore
 * reads `pending` until a write flips it, and the partial unique index
 * `workspace_invites_pending` only ever holds genuinely live invites — which
 * is what makes a replacement invite after expiry legal while a second invite
 * for a live pending row is still a UNIQUE violation.
 *
 * Zero-dependency leaf (the `workspace-store` module boundary): the `db`
 * parameter is a locally-declared narrow D1 face (types only, zero imports),
 * satisfied structurally by the real `D1Database`, the dashboard test double,
 * and the store layer's `D1Like`.
 */

/** Invite role inside one workspace (migration 0028 CHECK domain; no `owner`). */
export type InviteRole = "admin" | "member";

/**
 * Invite lifecycle (migration 0028 CHECK domain). `expired` is written only by
 * the write-path flip — never by a caller.
 */
export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

/** A `workspace_invites` row (migration 0028). */
export type WorkspaceInviteRow = {
  id: string;
  workspace_id: string;
  github_login: string;
  role: InviteRole;
  status: InviteStatus;
  invited_by: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
};

/**
 * Thrown by {@link createInvite} when a live `pending` invite already exists
 * for (workspace, login) — the partial unique index is the final word, so a
 * concurrent create loses here instead of minting a second pending row. The
 * caller maps `code` to 409 `invite.pending_exists`.
 */
export class InvitePendingExistsError extends Error {
  readonly code = "invite.pending_exists";

  constructor(login: string) {
    super(`workspace_invites: a pending invite for ${JSON.stringify(login)} already exists`);
    this.name = "InvitePendingExistsError";
  }
}

/**
 * Outcome of {@link acceptInvite}, classified for the accept route: `accepted`
 * → 200, `not_found` → 404 (missing invite or login mismatch, byte-identical
 * to an unknown workspace), `expired` → 409 `invite.expired` (lapsed, the row
 * was just flipped to its terminal state), `gone` → 410 (the row is terminal:
 * revoked, expired, or lost the accept race).
 */
export type AcceptInviteOutcome =
  | { kind: "accepted"; workspaceId: string; role: InviteRole }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "gone" };

/** Narrow D1 face: reads plus the invite write paths' batched statements. */
type InviteStoreStatement = {
  bind(...values: unknown[]): InviteStoreStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<{
    results: T[];
    meta: { changes: number; last_row_id: number };
  }>;
};

type InviteStoreD1 = {
  prepare(query: string): InviteStoreStatement;
  batch(statements: InviteStoreStatement[]): Promise<
    { results: unknown[]; meta: { changes: number; last_row_id: number } }[]
  >;
};

/** UNIQUE-constraint detection that tolerates bun:sqlite and D1 error shapes. */
function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof Error) {
    if ("code" in err && typeof err.code === "string" && err.code.includes("UNIQUE")) return true;
    return /UNIQUE constraint failed/i.test(err.message);
  }
  return false;
}

/**
 * The write-path flip (the ONLY producer of `expired`): every invite write
 * path runs it FIRST, in the same batch as its own write.
 */
const FLIP_LAPSED_SQL = `UPDATE workspace_invites SET status = 'expired'
WHERE workspace_id = ? AND status = 'pending' AND expires_at <= ?`;

/** Live-invite read predicate — lazy expiry, so every read filters it. */
const LIVE = `status = 'pending' AND expires_at > ?`;

const INVITE_COLUMNS = `id, workspace_id, github_login, role, status, invited_by,
       created_at, expires_at, accepted_at`;

/**
 * Create a pending invite. The flip runs first so a lapsed row stops blocking
 * the partial unique index; the insert then either succeeds or trips that
 * index, which surfaces as {@link InvitePendingExistsError} (the first row is
 * untouched — the batch rolls back).
 */
export async function createInvite(
  db: InviteStoreD1,
  input: {
    workspaceId: string;
    login: string;
    role: InviteRole;
    invitedBy: string;
    now: string;
    expiresAt: string;
  },
): Promise<WorkspaceInviteRow> {
  const row: WorkspaceInviteRow = {
    id: crypto.randomUUID(),
    workspace_id: input.workspaceId,
    github_login: input.login,
    role: input.role,
    status: "pending",
    invited_by: input.invitedBy,
    created_at: input.now,
    expires_at: input.expiresAt,
    accepted_at: null,
  };
  try {
    await db.batch([
      db.prepare(FLIP_LAPSED_SQL).bind(input.workspaceId, input.now),
      db
        .prepare(
          `INSERT INTO workspace_invites
             (id, workspace_id, github_login, role, status, invited_by,
              created_at, expires_at, accepted_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL)`,
        )
        .bind(
          row.id,
          row.workspace_id,
          row.github_login,
          row.role,
          row.invited_by,
          row.created_at,
          row.expires_at,
        ),
    ]);
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new InvitePendingExistsError(input.login);
    throw err;
  }
  return row;
}

/**
 * The workspace's live pending invites, oldest first. This is the read that
 * precedes a create, so it flips lapsed rows first: the list never shows an
 * invite whose expiration has passed.
 */
export async function listPendingInvites(
  db: InviteStoreD1,
  workspaceId: string,
  now: string,
): Promise<WorkspaceInviteRow[]> {
  // The flip runs as its own batch before the read: the narrow statement face
  // the repo's D1 test double implements returns no SELECT rows through
  // `batch()`, so the list statement stays a plain read. The predicate below
  // filters lapsed rows anyway, so a row that expires between the two
  // statements is never listed.
  await db.batch([db.prepare(FLIP_LAPSED_SQL).bind(workspaceId, now)]);
  const { results } = await db
    .prepare(
      `SELECT ${INVITE_COLUMNS} FROM workspace_invites
        WHERE workspace_id = ? AND ${LIVE}
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(workspaceId, now)
    .all<WorkspaceInviteRow>();
  return results;
}

/**
 * The login's live pending invite in ONE workspace (case-insensitive), or null
 * when there is none — the `invitee` half of the workspace principal
 * classification.
 */
export async function getPendingInviteByLogin(
  db: InviteStoreD1,
  workspaceId: string,
  login: string,
  now: string,
): Promise<WorkspaceInviteRow | null> {
  return db
    .prepare(
      `SELECT ${INVITE_COLUMNS} FROM workspace_invites
        WHERE workspace_id = ? AND github_login = ? COLLATE NOCASE AND ${LIVE}
        LIMIT 1`,
    )
    .bind(workspaceId, login, now)
    .first<WorkspaceInviteRow>();
}

/**
 * The login's live pending invites across every workspace — the invitee's
 * discovery read (SPA boot payload / empty state). Case-insensitive, because
 * a GitHub display-case change must not orphan an invite.
 */
export async function listInvitesForLogin(
  db: InviteStoreD1,
  login: string,
  now: string,
): Promise<WorkspaceInviteRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${INVITE_COLUMNS} FROM workspace_invites
        WHERE github_login = ? COLLATE NOCASE AND ${LIVE}
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(login, now)
    .all<WorkspaceInviteRow>();
  return results;
}

/**
 * Revoke a live pending invite. Workspace-scoped in the WHERE clause, so an
 * invite id from another workspace can never be revoked; false means no live
 * pending row matched (unknown id, already terminal, or foreign workspace).
 */
export async function revokeInvite(
  db: InviteStoreD1,
  workspaceId: string,
  inviteId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE workspace_invites SET status = 'revoked'
        WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    )
    .bind(inviteId, workspaceId)
    .run();
  return result.meta.changes > 0;
}

/**
 * Accept an invite: classify the row, then admit the invitee as a workspace
 * member and consume the invite in ONE batch. Statements (2) and (3) are both
 * keyed on `status = 'pending' AND expires_at > ?`, so a revocation or expiry
 * landing between the pre-read and the batch loses (0-row insert, 0-row
 * update) instead of admitting a member from a dead invite. Repeat accepts are
 * idempotent: the re-read finds the membership and returns success without a
 * second row.
 */
export async function acceptInvite(
  db: InviteStoreD1,
  inviteId: string,
  login: string,
  now: string,
): Promise<AcceptInviteOutcome> {
  const invite = await db
    .prepare(`SELECT ${INVITE_COLUMNS} FROM workspace_invites WHERE id = ?`)
    .bind(inviteId)
    .first<WorkspaceInviteRow>();
  // A login mismatch is the same 404 as an unknown invite: no tenant-existence
  // oracle, and the accept route is the only surface that reads this.
  if (invite === null || invite.github_login.toLowerCase() !== login.toLowerCase()) {
    return { kind: "not_found" };
  }
  if (invite.status === "revoked" || invite.status === "expired") return { kind: "gone" };

  const memberRole = await memberRoleOf(db, invite.workspace_id, login);
  if (invite.status === "accepted") {
    // Repeat accept: the membership row already exists, so return it. Accepted
    // is not in the plan's 410 set (only revoked/expired are), so an invite
    // whose membership has since been removed falls to the "neither" branch:
    // 404, with zero writes.
    return memberRole === null
      ? { kind: "not_found" }
      : { kind: "accepted", workspaceId: invite.workspace_id, role: memberRole };
  }

  if (invite.expires_at <= now) {
    // The invite expired before any write reached it: flip it to its terminal
    // state so the repeat attempt answers 410 (the write-path invariant, still
    // one batch).
    await db.batch([db.prepare(FLIP_LAPSED_SQL).bind(invite.workspace_id, now)]);
    return { kind: "expired" };
  }

  await db.batch([
    db.prepare(FLIP_LAPSED_SQL).bind(invite.workspace_id, now),
    db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT i.workspace_id, u.id, i.role, ?
           FROM workspace_invites i
           JOIN users u ON u.github_login = ? COLLATE NOCASE
          WHERE i.id = ? AND i.status = 'pending' AND i.expires_at > ?
         ON CONFLICT DO NOTHING`,
      )
      .bind(now, login, inviteId, now),
    db
      .prepare(
        `UPDATE workspace_invites SET status = 'accepted', accepted_at = ?
          WHERE id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .bind(now, inviteId, now),
  ]);

  // Classify by re-read: a membership row proves the batch admitted (or had
  // already admitted) this login; a terminal row means it lost the race.
  const admitted = await memberRoleOf(db, invite.workspace_id, login);
  if (admitted !== null) {
    return { kind: "accepted", workspaceId: invite.workspace_id, role: admitted };
  }
  const after = await db
    .prepare(`SELECT status FROM workspace_invites WHERE id = ?`)
    .bind(inviteId)
    .first<{ status: InviteStatus }>();
  if (after === null || after.status === "revoked" || after.status === "expired") {
    return { kind: "gone" };
  }
  return { kind: "not_found" };
}

/** The login's role in one workspace, or null when they are not a member. */
async function memberRoleOf(
  db: InviteStoreD1,
  workspaceId: string,
  login: string,
): Promise<InviteRole | null> {
  const row = await db
    .prepare(
      `SELECT wm.role AS role
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ? AND u.github_login = ? COLLATE NOCASE`,
    )
    .bind(workspaceId, login)
    .first<{ role: InviteRole }>();
  return row?.role ?? null;
}
