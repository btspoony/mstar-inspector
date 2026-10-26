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
 * statement, inside its own `db.batch`, the reads keep the
 * `status = 'pending' AND expires_at > ?` predicate, and the worker's
 * scheduled sweep flips the rest in bounded batches ({@link expireLapsedInvites}).
 * Reads never write, so a lapsed row keeps reading `pending` (while already
 * being absent from every list and from the seat count) until a write or the
 * sweep flips it. The partial unique index `workspace_invites_pending` only ever
 * holds genuinely live invites — which is what makes a replacement invite
 * after expiry legal while a second invite for a live pending row is still a
 * UNIQUE violation.
 *
 * Module boundary (the `workspace-store` one): the `db` parameter is a
 * locally-declared narrow D1 face (types only). The single exception is the
 * joined `./entitlement` import — the create batch enforces the plan's seat cap
 * itself (it must, or two concurrent creates both pass the route's read) and
 * refuses with the entitlement's own cap error instead of copying either below.
 */

import type { DeploymentMode } from "../worker/env";
import {
  FREE_PLAN_ID,
  FreeWorkspaceSlotError,
  INVITE_FREE_SLOT_REFUSAL,
  MemberCapError,
  MEMBER_CAP_REFUSAL,
  resolveWorkspacePlan,
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
 * Bind one statement by NAME: its `:name` tokens become D1's `?N` placeholders,
 * numbered in first-appearance order, and the values follow that same order.
 * Each guard therefore carries its own values, and appending or reordering a
 * guard cannot shift another guard's parameter — no statement's position is
 * derived from the order conditions were pushed.
 *
 * A token with no supplied value throws instead of binding NULL: the guards
 * that must disappear on an unlimited plan are OMITTED from the SQL text (and
 * their value from the map), never bound as NULL — `count < NULL` evaluates to
 * NULL, which would refuse every write.
 */
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

/**
 * The write-path flip: every invite write path runs it FIRST, in the same
 * batch as its own write. The sweep's bulk flip ({@link expireLapsedInvites})
 * is the other producer.
 */
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
                      LIMIT ?)`,
    )
    .bind(now, cap)
    .run();
  return result.meta.changes;
}

/** Live-invite read predicate — lazy expiry, so every read filters it. */
const LIVE = `status = 'pending' AND expires_at > ?`;

/**
 * The seat guard, as a SQL condition the insert carries: members plus live
 * pending invites below the plan's included seats. Re-reading the count inside
 * the insert is what closes the read-then-write window — two concurrent creates
 * both pass the route's fast-fail read, and the second one's condition is false,
 * so its batch writes no invite row. Its `:workspaceId` / `:now` tokens are the
 * same ones the insert above binds, so the guard reuses them by NAME instead of
 * relying on a positional `?N`. It appears only for a numeric limit, and
 * `:limit` is only ever bound by that numeric path (see `bindNamed`).
 */
const SEAT_GUARD_SQL = `(SELECT
        (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = :workspaceId)
      + (SELECT COUNT(*) FROM workspace_invites
          WHERE workspace_id = :workspaceId AND status = 'pending' AND expires_at > :now)) < :limit`;

/**
 * The acceptance's free-slot ALLOW predicate, as a SQL condition the membership
 * insert carries: true only when the TARGET workspace is on a paid plan, or the
 * accepting login holds no live free membership yet — the same join rule as
 * `countFreeMembershipsForLogin`. Re-reading it inside the insert is what closes
 * the read-then-write window the route gate leaves open. Its `:login` token is
 * the insert above's own; `:freePlanId` is bound only by the `saas` path that
 * appends this condition. `i` is the invite row.
 */
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

/**
 * The acceptance's seat condition, as a SQL condition its membership insert
 * carries: the target workspace's MEMBERS below the plan's included seats.
 * Re-reading the count inside the insert is what closes the read-then-write
 * window — two accepts racing past the same pre-read cannot both land.
 *
 * Members only, deliberately: an acceptance CONVERTS one pending invite into
 * one member (`members + 1`, `pending - 1`), so the invite rule's
 * `members + pending <= limit` sum is unchanged by it. Counting the pending
 * row here too would refuse a legitimate conversion at `limit - 1` members.
 * The converse is why the guard cannot be dropped after a downgrade: the
 * operator's plan change never removes a member or an invite, so
 * `members + pending` can sit above the new cap. Admitting those pending
 * invites one at a time raises members only while a seat is free; once they
 * reach the cap the rest refuse `member_cap` and stay pending. Refusing every
 * conversion instead would strand invites that were legitimately issued.
 *
 * The workspace comes from the insert's own `i` row. `:limit` is bound only by
 * the numeric-limit path that appends this condition: an unlimited plan omits
 * the condition instead of binding NULL (`count < NULL` is NULL, so it would
 * refuse every acceptance).
 */
const ACCEPT_SEAT_GUARD_SQL = `(SELECT COUNT(*)
        FROM workspace_members am
       WHERE am.workspace_id = i.workspace_id) < :limit`;

const INVITE_COLUMNS = `id, workspace_id, github_login, role, status, invited_by,
       created_at, expires_at, accepted_at`;

/**
 * The invite row insert without the seat condition. `createInvite` appends
 * {@link SEAT_GUARD_SQL} only for a numeric seat limit: a NULL limit means no
 * cap, and binding NULL into `:limit` would make `count < NULL` evaluate to
 * NULL, so the insert would write no row and mint a spurious refusal.
 */
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
  const limit = (await resolveWorkspacePlan(db, input.workspaceId, mode)).includedMembers;
  const values: Record<string, unknown> = {
    id: row.id,
    workspaceId: row.workspace_id,
    login: row.github_login,
    role: row.role,
    invitedBy: row.invited_by,
    now: row.created_at,
    expiresAt: row.expires_at,
  };
  // The seat condition is appended (and only then is `:limit` supplied): an
  // unlimited plan omits it entirely rather than binding NULL into it.
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
  // The guard refused: no invite row was written (the flip above only ever
  // expires already-lapsed rows, so it changed no seat). A null limit has no
  // guard, so it can never reach this refusal.
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
  // The predicate filters lapsed rows, so a row that expires between the sweep
  // runs is never listed (and holds no seat) while its stored status is still
  // `pending`.
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
      `SELECT i.id AS inviteId, w.slug AS workspaceRef, i.role AS role, i.expires_at AS expiresAt
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

  // Both guards append their own NAME tokens; `bindNamed` numbers each
  // statement's placeholders from the text itself, so neither guard's parameter
  // position depends on which conditions are present. A condition that is inert
  // is OMITTED from the SQL (and its value from the map), never bound as NULL:
  // `count < NULL` is NULL, which would refuse every acceptance.
  //
  // This literal's order IS the refusal precedence (free slot, then seat), used
  // by both the insert's AND chain and the classifier's CASE below — so
  // precedence is stated once here instead of falling out of a push sequence.
  const limit = (await resolveWorkspacePlan(db, invite.workspace_id, mode)).includedMembers;
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

  // The refusal classifier runs INSIDE the same batch, so it evaluates both
  // allow predicates on the transaction snapshot the insert's own guards read —
  // no window between the refusal and its classification. Precedence when both
  // refuse is the free-slot class: it is the one the invitee can clear alone,
  // and `member_cap`'s plan-upgrade copy would mislead a login that also holds a
  // free workspace. The trailing ELSE is the residual (a blocker cleared
  // concurrently): it keeps the free-slot copy, whose last instruction ("then
  // accept this invite") is exactly what the retry then succeeds at.
  //
  // Only a numeric limit brings a second possible class, so an unlimited plan
  // needs no classifier — the free-slot refusal is already the throw below.
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
  // Still pending with no membership written: a guard inside the insert
  // refused, and statement (3) only consumes the invite for an admitted login,
  // so the invite stays pending either way. WHICH guard is whatever the batch's
  // own classifier reported — the same snapshot the guards evaluated.
  if (classified !== null && limit !== null) {
    const row = results[statements.length - 1]!.results[0] as { blockedBy?: string } | undefined;
    if (row?.blockedBy === "member_cap") return { kind: "member_cap", limit };
  }
  throw new FreeWorkspaceSlotError(INVITE_FREE_SLOT_REFUSAL);
}

/** The login's role in one workspace, or null when they are not a member. */
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
