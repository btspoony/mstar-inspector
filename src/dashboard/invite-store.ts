
import type { DeploymentMode } from "../worker/env";
import {
  checkEntitlement,
  FREE_PLAN_ID,
  FreeWorkspaceSlotError,
  INVITE_FREE_SLOT_REFUSAL,
  MemberCapError,
  MEMBER_CAP_REFUSAL,
} from "./entitlement";

/** Invite role inside one workspace (migration 0028 CHECK domain; no `owner`). */
export type InviteRole = "admin" | "member";

/**
 * `workspace_members.role` domain (0026 CHECK). The accept path REPORTS a
 * membership, and a membership can be `owner` — an invitee accepted at
 * `member` may have been promoted since, so a repeat accept must not type the
 * answer as an invitable role.
 */
export type WorkspaceMemberRole = "owner" | "admin" | "member";

/**
 * Invite lifecycle (migration 0028 CHECK domain). `expired` is written only by
 * the write-path flip — never by a caller.
 */
export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

/** A `workspace_invites` row (migration 0028). `invited_by` is null once the
 * author's `users` row is hard-deleted (operator removal, ON DELETE SET NULL). */
export type WorkspaceInviteRow = {
  id: string;
  workspace_id: string;
  github_login: string;
  role: InviteRole;
  status: InviteStatus;
  invited_by: string | null;
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
 * revoked, expired, or lost the accept race), `member_cap` → 409 with the
 * acceptance copy (the plan's seats are all taken by members; the invite was
 * NOT consumed — it stays pending and becomes acceptable again once a seat is
 * freed, so a plan downgrade strands nothing).
 */
export type AcceptInviteOutcome =
  | { kind: "accepted"; workspaceId: string; role: WorkspaceMemberRole }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "gone" }
  | { kind: "member_cap"; limit: number };

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

function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof Error) {
    if ("code" in err && typeof err.code === "string" && err.code.includes("UNIQUE")) return true;
    return /UNIQUE constraint failed/i.test(err.message);
  }
  return false;
}

function bindNamed(
  statement: string,
  values: Record<string, unknown>,
): { sql: string; bindings: unknown[] } {
  const order: string[] = [];
  const sql = statement.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_token, name: string) => {
    let at = order.indexOf(name);
    if (at === -1) {
      order.push(name);
      at = order.length - 1;
    }
    return `?${at + 1}`;
  });
  return {
    sql,
    bindings: order.map((name) => {
      if (!(name in values)) {
        throw new Error(`invite-store: no value supplied for the :${name} bind`);
      }
      return values[name];
    }),
  };
}

const FLIP_LAPSED_SQL = `UPDATE workspace_invites SET status = 'expired'
WHERE workspace_id = ? AND status = 'pending' AND expires_at <= ?`;

/**
 * Flip at most `cap` lapsed pending invites to `expired` — the scheduled
 * sweep's entry point (I-000096). This is the write the members-page read used
 * to perform: reads only filter, so a lapsed row keeps reading `pending` until
 * the next sweep while the `expires_at > ?` predicate already keeps it out of
 * every list and out of the seat count.
 *
 * Global on purpose: no `workspace_id` filter, because the write-path flip
 * (FLIP_LAPSED_SQL) only reaches a workspace someone writes to — a workspace
 * nobody touches would keep its lapsed rows `pending` forever. The candidate
 * set is bounded per run so one sweep never pays for an unbounded backlog: a
 * larger backlog drains over successive runs, and the id subquery means the
 * returned count is the rows this run really flipped.
 *
 * The candidate order is `expires_at, id`, not the planner's default: a bare
 * LIMIT picks whichever rows the access path happens to reach first, so a
 * steady inflow of newly lapsed rows could keep re-filling the cap and
 * postpone an older lapsed row forever. Oldest-first makes each run drain
 * from the front of the backlog, and `id` breaks equal-expiry ties
 * deterministically. `workspace_invites_expiry` (migration 0035) keys the
 * partial pending set by exactly this order, so the ordering is a bounded
 * index seek rather than a sort over the whole pending set.
 */
export async function expireLapsedInvites(
  db: InviteStoreD1,
  now: string,
  cap: number,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE workspace_invites SET status = 'expired'
        WHERE id IN (SELECT id FROM workspace_invites
                      WHERE status = 'pending' AND expires_at <= ?
                      ORDER BY expires_at, id
                      LIMIT ?)`,
    )
    .bind(now, cap)
    .run();
  return result.meta.changes;
}

const LIVE = `status = 'pending' AND expires_at > ?`;

const SEAT_GUARD_SQL = `(SELECT
        (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = :workspaceId)
      + (SELECT COUNT(*) FROM workspace_invites
          WHERE workspace_id = :workspaceId AND status = 'pending' AND expires_at > :now)) < :limit`;

const ACCEPT_FREE_SLOT_GUARD_SQL = `(EXISTS (
        SELECT 1 FROM workspace_subscriptions ts
         WHERE ts.workspace_id = i.workspace_id AND ts.status = 'active'
           AND ts.plan_id <> :freePlanId)
      OR (SELECT COUNT(*) FROM workspace_members m
            JOIN users mu ON mu.id = m.user_id
            JOIN workspaces w ON w.id = m.workspace_id
            LEFT JOIN workspace_subscriptions s
                   ON s.workspace_id = w.id AND s.status = 'active'
           WHERE mu.github_login = :login COLLATE NOCASE
             AND w.deleted_at IS NULL
             AND (s.plan_id IS NULL OR s.plan_id = :freePlanId)) < 1)`;

const ACCEPT_SEAT_GUARD_SQL = `(SELECT COUNT(*)
        FROM workspace_members am
       WHERE am.workspace_id = i.workspace_id) < :limit`;

const INVITE_COLUMNS = `id, workspace_id, github_login, role, status, invited_by,
       created_at, expires_at, accepted_at`;

const INVITE_INSERT_SQL = `INSERT INTO workspace_invites
             (id, workspace_id, github_login, role, status, invited_by,
              created_at, expires_at, accepted_at)
           SELECT :id, :workspaceId, :login, :role, 'pending', :invitedBy,
                  :now, :expiresAt, NULL`;

/**
 * Create a pending invite. The flip runs first so a lapsed row stops blocking
 * the partial unique index; the insert then either succeeds, trips that index
 * (which surfaces as {@link InvitePendingExistsError}), or is refused by the
 * plan's seat cap.
 *
 * The cap is enforced BY the write: for a numeric limit the insert carries
 * {@link SEAT_GUARD_SQL}, so at the cap it writes no row and this throws
 * {@link MemberCapError} — the winner of a concurrent pair cannot push the
 * workspace past its plan. A NULL limit means no cap: the insert then carries
 * no seat condition at all, so the value never reaches the bind as NULL. The
 * plan is resolved here rather than passed in: the catalogue is static, and the
 * store is the one place that must know the limit it enforces. The mode is the
 * caller's because this store cannot see the request env, and `self-hosted`
 * resolves `unlimited` before reading the catalogue at all (spec §2).
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
  mode: DeploymentMode,
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
  const verdict = await checkEntitlement({
    db,
    mode,
    workspaceId: input.workspaceId,
    kind: "member-slot",
    seats: null,
  });
  const limit = verdict.plan.includedMembers;
  const values: Record<string, unknown> = {
    id: row.id,
    workspaceId: row.workspace_id,
    login: row.github_login,
    role: row.role,
    invitedBy: row.invited_by,
    now: row.created_at,
    expiresAt: row.expires_at,
  };
  const guarded = limit === null ? INVITE_INSERT_SQL : `${INVITE_INSERT_SQL}\n            WHERE ${SEAT_GUARD_SQL}`;
  const insert = bindNamed(guarded, limit === null ? values : { ...values, limit });
  let results: { results: unknown[]; meta: { changes: number; last_row_id: number } }[];
  try {
    results = await db.batch([
      db.prepare(FLIP_LAPSED_SQL).bind(input.workspaceId, input.now),
      db.prepare(insert.sql).bind(...insert.bindings),
    ]);
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new InvitePendingExistsError(input.login);
    throw err;
  }
  if (limit !== null && results[1]!.meta.changes === 0) {
    throw new MemberCapError(MEMBER_CAP_REFUSAL(limit));
  }
  return row;
}

/**
 * The workspace's live pending invites, oldest first. A PURE READ (I-000096):
 * lapsed rows are filtered out by the `expires_at > ?` predicate and left
 * `pending` until the sweep flips them, so the members-page GET never writes.
 */
export async function listPendingInvites(
  db: InviteStoreD1,
  workspaceId: string,
  now: string,
): Promise<WorkspaceInviteRow[]> {
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
 * One invite of THIS workspace by id, or null — the accept route's pre-read.
 * Workspace-scoped like `revokeInvite`, so an invite id from another workspace
 * cannot be consumed through this workspace's path (the accept path names the
 * workspace the request addressed).
 */
export async function getInviteInWorkspace(
  db: InviteStoreD1,
  workspaceId: string,
  inviteId: string,
): Promise<WorkspaceInviteRow | null> {
  return db
    .prepare(`SELECT ${INVITE_COLUMNS} FROM workspace_invites WHERE id = ? AND workspace_id = ?`)
    .bind(inviteId, workspaceId)
    .first<WorkspaceInviteRow>();
}

/**
 * The login's live pending invites across every workspace, each paired with its
 * workspace's path ref — the SPA boot payload's discovery rows.
 * A soft-deleted workspace is excluded: presenting an accept link into a
 * retired tenant would only 404.
 */
export async function listInviteDiscoveryForLogin(
  db: InviteStoreD1,
  login: string,
  now: string,
): Promise<Array<{ inviteId: string; workspaceRef: string; role: InviteRole; expiresAt: string }>> {
  const { results } = await db
    .prepare(
      `SELECT i.id AS inviteId, w.id AS workspaceRef, i.role AS role, i.expires_at AS expiresAt
         FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id
        WHERE i.github_login = ? COLLATE NOCASE AND i.${LIVE} AND w.deleted_at IS NULL
        ORDER BY i.created_at ASC, i.id ASC`,
    )
    .bind(login, now)
    .all<{ inviteId: string; workspaceRef: string; role: InviteRole; expiresAt: string }>();
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
 *
 * The plan's seat cap is enforced BY the write as well: for a numeric limit
 * the membership insert carries {@link ACCEPT_SEAT_GUARD_SQL}, so members can
 * never exceed the plan — not when two accepts race past the same pre-read,
 * and not when a downgrade left more pending invites than the new plan has
 * free seats. A refused acceptance writes nothing and consumes nothing: the
 * invite stays pending and the outcome is `member_cap`, so it becomes
 * acceptable again once a member is removed or the plan grows. A NULL limit
 * means no cap; the insert then carries no seat condition at all, because
 * binding NULL would make `count < NULL` evaluate to NULL and refuse every
 * acceptance on an unlimited plan.
 *
 * WHICH guard blocked is decided by a classifier SELECT appended to the SAME
 * batch, so the answer is read off the transaction snapshot the insert's guards
 * themselves evaluated — there is no window between the refusal and its
 * classification, which a per-batch re-read cannot promise. When both predicates
 * refuse the free-slot class wins (`I-000169`): its recovery is the one the
 * invitee can perform alone, while `member_cap`'s plan-upgrade copy misleads a
 * login that also holds a free workspace.
 *
 * The free slot is enforced BY the write too: the membership insert carries
 * {@link ACCEPT_FREE_SLOT_GUARD_SQL}, and the invite is only consumed when the
 * accepting login is a member of that workspace — so a refusal leaves the
 * invite pending and throws {@link FreeWorkspaceSlotError}. The route's read
 * stays fast-fail UX.
 *
 * The free-slot rule binds `saas` only (spec §3/§4): `self-hosted` resolves
 * every workspace to `unlimited`, so nothing is on the free tier and the guard
 * would only refuse an acceptance that must be allowed. The saas SQL text is
 * unchanged; the self-hosted insert simply carries no slot condition (and so
 * binds no free plan id). The seat condition is inert there for the same
 * reason: `unlimited` is a NULL limit.
 */
export async function acceptInvite(
  db: InviteStoreD1,
  inviteId: string,
  login: string,
  now: string,
  mode: DeploymentMode,
): Promise<AcceptInviteOutcome> {
  const invite = await db
    .prepare(`SELECT ${INVITE_COLUMNS} FROM workspace_invites WHERE id = ?`)
    .bind(inviteId)
    .first<WorkspaceInviteRow>();
  if (invite === null || invite.github_login.toLowerCase() !== login.toLowerCase()) {
    return { kind: "not_found" };
  }
  if (invite.status === "revoked" || invite.status === "expired") return { kind: "gone" };

  const memberRole = await memberRoleOf(db, invite.workspace_id, login);
  if (invite.status === "accepted") {
    return memberRole === null
      ? { kind: "not_found" }
      : { kind: "accepted", workspaceId: invite.workspace_id, role: memberRole };
  }

  if (invite.expires_at <= now) {
    await db.batch([db.prepare(FLIP_LAPSED_SQL).bind(invite.workspace_id, now)]);
    return { kind: "expired" };
  }

  const limit = (
    await checkEntitlement({
      db,
      mode,
      workspaceId: invite.workspace_id,
      kind: "member-slot",
      seats: null,
    })
  ).plan.includedMembers;
  const conditions = [
    mode === "saas"
      ? { allow: ACCEPT_FREE_SLOT_GUARD_SQL, refusal: "free_slot" as const, binds: { freePlanId: FREE_PLAN_ID } }
      : null,
    limit !== null
      ? { allow: ACCEPT_SEAT_GUARD_SQL, refusal: "member_cap" as const, binds: { limit } }
      : null,
  ].filter((condition) => condition !== null);
  const bindings: Record<string, unknown> = { now, login, inviteId };
  for (const condition of conditions) Object.assign(bindings, condition.binds);
  const guard = conditions.map((condition) => `\n            AND ${condition.allow}`).join("");

  const classified =
    limit === null
      ? null
      : bindNamed(
          `SELECT CASE${conditions
            .map((condition) => `\n         WHEN NOT ${condition.allow} THEN '${condition.refusal}'`)
            .join("")}
         ELSE 'free_slot'
       END AS blockedBy
  FROM workspace_invites i WHERE i.id = :inviteId`,
          bindings,
        );
  const insert = bindNamed(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT i.workspace_id, u.id, i.role, :now
           FROM workspace_invites i
           JOIN users u ON u.github_login = :login COLLATE NOCASE
          WHERE i.id = :inviteId AND i.status = 'pending' AND i.expires_at > :now${guard}
         ON CONFLICT DO NOTHING`,
    bindings,
  );

  const statements = [
    db.prepare(FLIP_LAPSED_SQL).bind(invite.workspace_id, now),
    db.prepare(insert.sql).bind(...insert.bindings),
    db
      .prepare(
        `UPDATE workspace_invites SET status = 'accepted', accepted_at = ?1
          WHERE id = ?2 AND status = 'pending' AND expires_at > ?1
            AND EXISTS (SELECT 1 FROM workspace_members wm
                          JOIN users u ON u.id = wm.user_id
                         WHERE wm.workspace_id = workspace_invites.workspace_id
                           AND u.github_login = ?3 COLLATE NOCASE)`,
      )
      .bind(now, inviteId, login),
    ...(classified === null ? [] : [db.prepare(classified.sql).bind(...classified.bindings)]),
  ];
  const results = await db.batch(statements);

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
  if (classified !== null && limit !== null) {
    const row = results[statements.length - 1]!.results[0] as { blockedBy?: string } | undefined;
    if (row?.blockedBy === "member_cap") return { kind: "member_cap", limit };
  }
  throw new FreeWorkspaceSlotError(INVITE_FREE_SLOT_REFUSAL);
}

async function memberRoleOf(
  db: InviteStoreD1,
  workspaceId: string,
  login: string,
): Promise<WorkspaceMemberRole | null> {
  const row = await db
    .prepare(
      `SELECT wm.role AS role
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ? AND u.github_login = ? COLLATE NOCASE`,
    )
    .bind(workspaceId, login)
    .first<{ role: WorkspaceMemberRole }>();
  return row?.role ?? null;
}
