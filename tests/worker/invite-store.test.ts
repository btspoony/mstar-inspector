/**
 * Unit tests: migration 0028 + the `workspace_invites` store
 * (plan 97 Task 1, `### Store and schema contract (T1)`).
 *
 * The bun:sqlite double applies the REAL migration list (tests/store/helpers),
 * so the partial unique indexes and the CHECK domains under test are the same
 * DDL `wrangler d1 migrations apply` produces. Every case pins a semantics the
 * API layer (T2) maps to a status code, so a later change cannot silently drop
 * the lazy-flip invariant or the pending-uniqueness rule:
 *   - two live pending invites for one (workspace, login) → UNIQUE conflict;
 *   - revoke then re-invite → the replacement is legal;
 *   - lapse → flip inside `createInvite` → exactly one new pending row;
 *   - lapse → accept answers `expired` (409) and the row is terminal, so the
 *     repeat answers `gone` (410);
 *   - accept writes exactly one membership row and repeats idempotently;
 *   - login matching is NOCASE in both directions.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import {
  InvitePendingExistsError,
  acceptInvite,
  createInvite,
  getPendingInviteByLogin,
  listInvitesForLogin,
  listPendingInvites,
  revokeInvite,
} from "../../src/dashboard/invite-store";
import type { WorkspaceInviteRow } from "../../src/dashboard/invite-store";

const WORKSPACE = "default";
const INVITER = "user-operator";
const NOW = "2026-10-22T00:00:00.000Z";
const LATER = "2026-10-29T00:00:00.000Z";
const PAST = "2026-10-21T00:00:00.000Z";

/** One users row — the FK target for `invited_by` and the accept join. */
function seedUser(db: TestD1, id: string, login: string): void {
  db.raw
    .prepare(
      `INSERT INTO users (id, github_login, role, created_at, invited_by)
       VALUES (?, ?, 'member', ?, NULL)`,
    )
    .run(id, login, NOW);
}

/** A DB with the seeded workspace, one inviter, and whatever logins asked for. */
function createFixture(...logins: string[]): TestD1 {
  const db = createMigratedTestD1();
  seedUser(db, INVITER, "operator");
  for (const login of logins) seedUser(db, `user-${login}`, login);
  return db;
}

function invite(db: TestD1, login: string, now = NOW, expiresAt = LATER): Promise<WorkspaceInviteRow> {
  return createInvite(db, {
    workspaceId: WORKSPACE,
    login,
    role: "member",
    invitedBy: INVITER,
    now,
    expiresAt,
  });
}

/** The row as stored (status included; the store's reads filter lazily). */
function rowOf(db: TestD1, id: string): WorkspaceInviteRow {
  const row = db.raw
    .prepare("SELECT * FROM workspace_invites WHERE id = ?")
    .get(id) as WorkspaceInviteRow | null;
  if (row === null) throw new Error(`no invite row ${id}`);
  return row;
}

function statuses(db: TestD1): string[] {
  return db.raw
    .prepare("SELECT status FROM workspace_invites ORDER BY created_at ASC, id ASC")
    .all()
    .map((row) => (row as { status: string }).status);
}

function membershipCount(db: TestD1, login: string): number {
  const row = db.raw
    .prepare(
      `SELECT COUNT(*) AS n FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ? AND u.github_login = ? COLLATE NOCASE`,
    )
    .get(WORKSPACE, login) as { n: number };
  return row.n;
}

describe("workspace_invites store", () => {
  test("insert then list: a created invite is the workspace's one pending row", async () => {
    const db = createFixture("octocat");

    const created = await invite(db, "octocat");
    expect(created.status).toBe("pending");
    expect(created.github_login).toBe("octocat");

    const pending = await listPendingInvites(db, WORKSPACE, NOW);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(created.id);
    expect(pending[0]!.role).toBe("member");

    // Discovery is the invitee's own read, scoped by login not workspace.
    const discovered = await listInvitesForLogin(db, "octocat", NOW);
    expect(discovered.map((row) => row.id)).toEqual([created.id]);
    expect(await getPendingInviteByLogin(db, WORKSPACE, "octocat", NOW)).not.toBeNull();
    expect(await getPendingInviteByLogin(db, WORKSPACE, "someone-else", NOW)).toBeNull();
  });

  test("a second live pending invite conflicts; the first row is untouched", async () => {
    const db = createFixture("octocat");
    const first = await invite(db, "octocat");

    await expect(invite(db, "octocat")).rejects.toBeInstanceOf(InvitePendingExistsError);
    // The rejected batch rolled back: still exactly one row, still the first.
    expect(statuses(db)).toEqual(["pending"]);
    expect(rowOf(db, first.id).status).toBe("pending");
  });

  test("revoke then re-invite: the replacement is legal and the revoked row stays", async () => {
    const db = createFixture("octocat");
    const first = await invite(db, "octocat");

    expect(await revokeInvite(db, WORKSPACE, first.id)).toBe(true);
    expect(rowOf(db, first.id).status).toBe("revoked");
    // Revoking an already terminal invite changes nothing.
    expect(await revokeInvite(db, WORKSPACE, first.id)).toBe(false);

    const second = await invite(db, "octocat");
    expect(second.id).not.toBe(first.id);
    expect(statuses(db).sort()).toEqual(["pending", "revoked"]);
    expect((await listPendingInvites(db, WORKSPACE, NOW)).map((row) => row.id)).toEqual([second.id]);
  });

  test("revoke is workspace-scoped: a foreign invite id cannot be revoked", async () => {
    const db = createFixture("octocat");
    const created = await invite(db, "octocat");

    expect(await revokeInvite(db, "other-workspace", created.id)).toBe(false);
    expect(rowOf(db, created.id).status).toBe("pending");
  });

  test("lapse then create: the flip makes the lapsed row terminal and the new pending row is the only one", async () => {
    const db = createFixture("octocat");
    const lapsed = await invite(db, "octocat", NOW, LATER);

    // Read-only reads filter lazily: past expires_at the invite is invisible
    // while the stored row still says 'pending' (no write has reached it).
    expect(rowOf(db, lapsed.id).status).toBe("pending");
    expect(await getPendingInviteByLogin(db, WORKSPACE, "octocat", PAST)).not.toBeNull();
    expect(await getPendingInviteByLogin(db, WORKSPACE, "octocat", "2026-10-30T00:00:00.000Z")).toBeNull();
    expect(rowOf(db, lapsed.id).status).toBe("pending");

    // createInvite at a time past expires_at flips first, so the partial
    // unique index admits the replacement.
    const replacement = await invite(db, "octocat", "2026-11-01T00:00:00.000Z", "2026-11-08T00:00:00.000Z");

    expect(rowOf(db, lapsed.id).status).toBe("expired");
    expect(rowOf(db, replacement.id).status).toBe("pending");
    const pending = await listPendingInvites(db, WORKSPACE, "2026-11-01T00:00:00.000Z");
    expect(pending.map((row) => row.id)).toEqual([replacement.id]);
    expect(statuses(db)).toEqual(["expired", "pending"]);
  });

  test("lapse then accept: expired outcome, the row flips, and the repeat is gone", async () => {
    const db = createFixture("octocat");
    const lapsed = await invite(db, "octocat", NOW, LATER);

    const first = await acceptInvite(db, lapsed.id, "octocat", "2026-11-01T00:00:00.000Z");
    expect(first).toEqual({ kind: "expired" });
    // The write-path flip ran: the row is terminal even though nothing admitted.
    expect(rowOf(db, lapsed.id).status).toBe("expired");
    expect(rowOf(db, lapsed.id).accepted_at).toBeNull();
    expect(membershipCount(db, "octocat")).toBe(0);

    const repeat = await acceptInvite(db, lapsed.id, "octocat", "2026-11-01T00:00:00.000Z");
    expect(repeat).toEqual({ kind: "gone" });
  });

  test("accept admits exactly one membership row and repeats idempotently", async () => {
    const db = createFixture("octocat");
    const created = await invite(db, "octocat");

    const accepted = await acceptInvite(db, created.id, "octocat", NOW);
    expect(accepted).toEqual({ kind: "accepted", workspaceId: WORKSPACE, role: "member" });
    expect(membershipCount(db, "octocat")).toBe(1);
    expect(rowOf(db, created.id).status).toBe("accepted");
    expect(rowOf(db, created.id).accepted_at).toBe(NOW);
    expect(await listPendingInvites(db, WORKSPACE, NOW)).toHaveLength(0);

    const repeat = await acceptInvite(db, created.id, "octocat", NOW);
    expect(repeat).toEqual({ kind: "accepted", workspaceId: WORKSPACE, role: "member" });
    expect(membershipCount(db, "octocat")).toBe(1);
  });

  test("accept refuses a login mismatch and a revoked invite without writing", async () => {
    const db = createFixture("octocat");
    const created = await invite(db, "octocat");

    expect(await acceptInvite(db, created.id, "someone-else", NOW)).toEqual({ kind: "not_found" });
    expect(rowOf(db, created.id).status).toBe("pending");

    await revokeInvite(db, WORKSPACE, created.id);
    expect(await acceptInvite(db, created.id, "octocat", NOW)).toEqual({ kind: "gone" });
    expect(membershipCount(db, "octocat")).toBe(0);
    expect(rowOf(db, created.id).status).toBe("revoked");
  });

  test("login matching is case-insensitive in both directions", async () => {
    const db = createFixture("OctoCat");
    const created = await invite(db, "OctoCat");

    // A display-case change on either side still finds and accepts the invite.
    expect(await getPendingInviteByLogin(db, WORKSPACE, "octocat", NOW)).not.toBeNull();
    expect((await listInvitesForLogin(db, "OCTOCAT", NOW)).map((row) => row.id)).toEqual([
      created.id,
    ]);
    expect(await acceptInvite(db, created.id, "octocat", NOW)).toMatchObject({ kind: "accepted" });
    expect(membershipCount(db, "OctoCat")).toBe(1);

    // The partial unique index is NOCASE too: a case-variant duplicate is the
    // same pending invite, not a second one.
    const other = await invite(db, "OCTOCAT");
    expect(other.github_login).toBe("OCTOCAT");
    await expect(invite(db, "octocat")).rejects.toBeInstanceOf(InvitePendingExistsError);
  });

  test("listPendingInvites flips lapsed rows as a write path", async () => {
    const db = createFixture("octocat", "hubot");
    const lapsed = await invite(db, "octocat", NOW, LATER);
    await invite(db, "hubot", NOW, LATER);

    const live = await listPendingInvites(db, WORKSPACE, "2026-10-25T00:00:00.000Z");
    expect(live).toHaveLength(2);

    const afterExpiry = await listPendingInvites(db, WORKSPACE, "2026-11-01T00:00:00.000Z");
    expect(afterExpiry).toHaveLength(0);
    // The lapsed row is terminal now, so it can never resurface as pending.
    expect(rowOf(db, lapsed.id).status).toBe("expired");
    expect(await listPendingInvites(db, WORKSPACE, NOW)).toHaveLength(0);
  });
});
