/**
 * Unit tests: migration 0028 + the `workspace_invites` store.
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
import { countMembersAndPendingInvites } from "../../src/dashboard/workspace-store";
import { FreeWorkspaceSlotError, MEMBER_CAP_REFUSAL } from "../../src/dashboard/entitlement";

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
  }, "saas");
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

/** The same migrated double, with every prepared statement recorded first. */
function recordSql(db: TestD1, captured: string[]): TestD1 {
  return {
    prepare(query: string) {
      captured.push(query);
      return db.prepare(query);
    },
    batch: (statements) => db.batch(statements),
    raw: db.raw,
  };
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

    const first = await acceptInvite(db, lapsed.id, "octocat", "2026-11-01T00:00:00.000Z", "saas");
    expect(first).toEqual({ kind: "expired" });
    // The write-path flip ran: the row is terminal even though nothing admitted.
    expect(rowOf(db, lapsed.id).status).toBe("expired");
    expect(rowOf(db, lapsed.id).accepted_at).toBeNull();
    expect(membershipCount(db, "octocat")).toBe(0);

    const repeat = await acceptInvite(db, lapsed.id, "octocat", "2026-11-01T00:00:00.000Z", "saas");
    expect(repeat).toEqual({ kind: "gone" });
  });

  test("accept admits exactly one membership row and repeats idempotently", async () => {
    const db = createFixture("octocat");
    const created = await invite(db, "octocat");

    const accepted = await acceptInvite(db, created.id, "octocat", NOW, "saas");
    expect(accepted).toEqual({ kind: "accepted", workspaceId: WORKSPACE, role: "member" });
    expect(membershipCount(db, "octocat")).toBe(1);
    expect(rowOf(db, created.id).status).toBe("accepted");
    expect(rowOf(db, created.id).accepted_at).toBe(NOW);
    expect(await listPendingInvites(db, WORKSPACE, NOW)).toHaveLength(0);

    const repeat = await acceptInvite(db, created.id, "octocat", NOW, "saas");
    expect(repeat).toEqual({ kind: "accepted", workspaceId: WORKSPACE, role: "member" });
    expect(membershipCount(db, "octocat")).toBe(1);
  });

  test("a repeat accept reports the membership's CURRENT role, owner included", async () => {
    const db = createFixture("octocat");
    const created = await invite(db, "octocat");
    expect(await acceptInvite(db, created.id, "octocat", NOW, "saas")).toMatchObject({ role: "member" });

    // Promoted after accepting: the repeat accept reports the membership, not
    // the invitable role domain the invite row carries.
    db.raw
      .prepare("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ?")
      .run(WORKSPACE);

    expect(await acceptInvite(db, created.id, "octocat", NOW, "saas")).toEqual({
      kind: "accepted",
      workspaceId: WORKSPACE,
      role: "owner",
    });
  });

  test("accept refuses a login mismatch and a revoked invite without writing", async () => {
    const db = createFixture("octocat");
    const created = await invite(db, "octocat");

    expect(await acceptInvite(db, created.id, "someone-else", NOW, "saas")).toEqual({ kind: "not_found" });
    expect(rowOf(db, created.id).status).toBe("pending");

    await revokeInvite(db, WORKSPACE, created.id);
    expect(await acceptInvite(db, created.id, "octocat", NOW, "saas")).toEqual({ kind: "gone" });
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
    expect(await acceptInvite(db, created.id, "octocat", NOW, "saas")).toMatchObject({ kind: "accepted" });
    expect(membershipCount(db, "OctoCat")).toBe(1);

    // The partial unique index is NOCASE too: a case-variant duplicate is the
    // same pending invite, not a second one.
    const other = await invite(db, "OCTOCAT");
    expect(other.github_login).toBe("OCTOCAT");
    await expect(invite(db, "octocat")).rejects.toBeInstanceOf(InvitePendingExistsError);
  });

  test("listPendingInvites is a pure read: a lapsed invite is excluded and left pending", async () => {
    const db = createFixture("octocat", "hubot");
    const lapsed = await invite(db, "octocat", NOW, LATER);
    await invite(db, "hubot", NOW, LATER);
    const captured: string[] = [];
    const recording = recordSql(db, captured);

    const live = await listPendingInvites(recording, WORKSPACE, "2026-10-25T00:00:00.000Z");
    expect(live).toHaveLength(2);

    const afterExpiry = await listPendingInvites(recording, WORKSPACE, "2026-11-01T00:00:00.000Z");
    expect(afterExpiry).toHaveLength(0);
    // The members-page GET performs no UPDATE (I-000096): the lapsed row keeps
    // its stored status until the sweep (or another write path) flips it.
    expect(captured.every((sql) => !/^\s*UPDATE\s/i.test(sql))).toBe(true);
    expect(rowOf(db, lapsed.id).status).toBe("pending");
    // Still `pending`, so a read before expiry lists both again.
    expect(await listPendingInvites(db, WORKSPACE, NOW)).toHaveLength(2);
  });

  test("a lapsed pending invite holds no seat before the sweep flips it", async () => {
    const db = createFixture("octocat");
    const lapsed = await invite(db, "octocat", NOW, LATER);
    const afterExpiry = "2026-11-01T00:00:00.000Z";

    // Live → one seat. Lapsed with no write yet → none, which is what keeps
    // the member cap correct during the sweep delay window.
    expect(await countMembersAndPendingInvites(db, WORKSPACE, NOW)).toBe(1);
    expect(rowOf(db, lapsed.id).status).toBe("pending");
    expect(await countMembersAndPendingInvites(db, WORKSPACE, afterExpiry)).toBe(0);
    expect(rowOf(db, lapsed.id).status).toBe("pending");
  });
});

/** A second live workspace on `planId`, with `login` as its owner. */
function seedMembership(db: TestD1, workspaceId: string, login: string, planId: string): void {
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
       VALUES (?, ?, ?, NULL, ?, NULL)`,
    )
    .run(workspaceId, workspaceId, workspaceId, NOW);
  db.raw
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT ?, id, 'owner', ? FROM users WHERE github_login = ?`,
    )
    .run(workspaceId, NOW, login);
  db.raw
    .prepare(
      `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    )
    .run(workspaceId, planId, NOW, NOW);
}

describe("accept free-slot guard (store level, route gate bypassed)", () => {
  test("a login in a live free workspace cannot accept a free invite; the invite stays pending", async () => {
    const db = createFixture("mallory");
    seedMembership(db, "ws-elsewhere", "mallory", "free");
    const pending = await invite(db, "mallory");

    // No route read ran here: the guard inside the membership insert refuses,
    // and the batch leaves the invite pending.
    await expect(acceptInvite(db, pending.id, "mallory", NOW, "saas")).rejects.toBeInstanceOf(
      FreeWorkspaceSlotError,
    );

    expect(membershipCount(db, "mallory")).toBe(0);
    expect(rowOf(db, pending.id).status).toBe("pending");
  });

  test("a pro target accepts even when the login already holds a free workspace", async () => {
    const db = createFixture("mallory");
    seedMembership(db, "ws-elsewhere", "mallory", "free");
    db.raw
      .prepare(
        `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
         VALUES (?, 'pro', 'active', ?, ?)`,
      )
      .run(WORKSPACE, NOW, NOW);
    const pending = await invite(db, "mallory");

    expect(await acceptInvite(db, pending.id, "mallory", NOW, "saas")).toEqual({
      kind: "accepted",
      workspaceId: WORKSPACE,
      role: "member",
    });
    expect(membershipCount(db, "mallory")).toBe(1);
    expect(rowOf(db, pending.id).status).toBe("accepted");
  });

  test("an unlimited target accepts the same way: it is not the free tier", async () => {
    const db = createFixture("mallory");
    seedMembership(db, "ws-elsewhere", "mallory", "free");
    db.raw
      .prepare(
        `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
         VALUES (?, 'unlimited', 'active', ?, ?)`,
      )
      .run(WORKSPACE, NOW, NOW);
    const pending = await invite(db, "mallory");

    expect(await acceptInvite(db, pending.id, "mallory", NOW, "saas")).toEqual({
      kind: "accepted",
      workspaceId: WORKSPACE,
      role: "member",
    });
    expect(membershipCount(db, "mallory")).toBe(1);
  });

  test("self-hosted accepts the same login the guard refuses in saas: the rule binds saas only", async () => {
    const db = createFixture("mallory");
    seedMembership(db, "ws-elsewhere", "mallory", "free");
    const pending = await invite(db, "mallory");

    // Same fixture as the refusal above, resolved in self-hosted: nothing is on
    // the free tier there, so the acceptance must land.
    expect(await acceptInvite(db, pending.id, "mallory", NOW, "self-hosted")).toEqual({
      kind: "accepted",
      workspaceId: WORKSPACE,
      role: "member",
    });
    expect(membershipCount(db, "mallory")).toBe(1);
    expect(rowOf(db, pending.id).status).toBe("accepted");
  });
});

describe("seat limit (store level)", () => {
  /** Fill the workspace's seats with plain members (no cap guards members). */
  function seedMembers(db: TestD1, count: number): void {
    for (let i = 0; i < count; i += 1) {
      seedUser(db, `user-seat-${i}`, `seat-${i}`);
      db.raw
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
           VALUES (?, ?, 'member', ?)`,
        )
        .run(WORKSPACE, `user-seat-${i}`, NOW);
    }
  }

  function subscribe(db: TestD1, planId: string): void {
    db.raw
      .prepare(
        `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`,
      )
      .run(WORKSPACE, planId, NOW, NOW);
  }

  /** The one invite insert the store prepared, so the shape can be inspected. */
  function insertSql(captured: string[]): string {
    const sql = captured.find((query) => /^\s*INSERT INTO workspace_invites/i.test(query));
    if (sql === undefined) throw new Error("createInvite prepared no invite insert");
    return sql;
  }

  /** The workspace's member rows — the count the acceptance guard reads. */
  function memberCount(db: TestD1): number {
    const row = db.raw
      .prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?")
      .get(WORKSPACE) as { n: number };
    return row.n;
  }

  /** The operator's downgrade write (src/admin/workspaces.ts): plan id only —
   * it never removes a member or an invite row. */
  function downgrade(db: TestD1, planId: string): void {
    db.raw
      .prepare("UPDATE workspace_subscriptions SET plan_id = ?, updated_at = ? WHERE workspace_id = ?")
      .run(planId, NOW, WORKSPACE);
  }

  test("a five-seat plan refuses at five, names that limit and writes nothing", async () => {
    const db = createFixture("newcomer");
    seedMembers(db, 5);
    const captured: string[] = [];

    await expect(invite(recordSql(db, captured), "newcomer")).rejects.toThrow(
      MEMBER_CAP_REFUSAL(5),
    );

    expect(statuses(db)).toEqual([]);
    // The numeric path keeps the seat condition, bound as ?8.
    expect(insertSql(captured)).toContain("?8");
  });

  test("a null limit writes the invite past the five-seat cap, with no seat condition", async () => {
    const db = createFixture("newcomer");
    seedMembers(db, 6);
    subscribe(db, "unlimited");
    const captured: string[] = [];

    const created = await invite(recordSql(db, captured), "newcomer");

    expect(created.status).toBe("pending");
    expect(statuses(db)).toEqual(["pending"]);
    // A NULL bound into ?8 would make `count < ?8` evaluate to NULL and write
    // no row, so the unlimited insert must not carry the condition at all.
    expect(insertSql(captured)).not.toContain("?8");
  });

  test("a pending invite at limit minus one converts into the last seat", async () => {
    const db = createFixture("newcomer");
    seedMembers(db, 4);
    const pending = await invite(db, "newcomer");

    // Four members plus one pending already fill the five-seat plan. The
    // acceptance converts that pending seat (`members + 1`, `pending - 1`), so
    // the guard must count MEMBERS only — counting the pending row again would
    // refuse this legitimate conversion.
    expect(await acceptInvite(db, pending.id, "newcomer", NOW, "saas")).toEqual({
      kind: "accepted",
      workspaceId: WORKSPACE,
      role: "member",
    });
    expect(memberCount(db)).toBe(5);
    expect(rowOf(db, pending.id).status).toBe("accepted");
  });

  test("an accept at the cap refuses with member_cap and writes no member row", async () => {
    const db = createFixture("newcomer");
    subscribe(db, "unlimited");
    seedMembers(db, 5);
    // Minted while the plan was unlimited, then the workspace is downgraded:
    // the pending row outlives the seat it was issued against.
    const pending = await invite(db, "newcomer");
    downgrade(db, "free");

    expect(await acceptInvite(db, pending.id, "newcomer", NOW, "saas")).toEqual({
      kind: "member_cap",
      limit: 5,
    });
    expect(memberCount(db)).toBe(5);
    expect(rowOf(db, pending.id).status).toBe("pending");
  });

  test("a null limit binds no seat condition, so the accept lands past the five-seat cap", async () => {
    const db = createFixture("newcomer");
    seedMembers(db, 6);
    subscribe(db, "unlimited");
    const pending = await invite(db, "newcomer");

    // A NULL bound into the comparison would make `count < NULL` NULL and
    // refuse every acceptance on an unlimited plan.
    expect(await acceptInvite(db, pending.id, "newcomer", NOW, "saas")).toEqual({
      kind: "accepted",
      workspaceId: WORKSPACE,
      role: "member",
    });
    expect(memberCount(db)).toBe(7);
    expect(rowOf(db, pending.id).status).toBe("accepted");
  });

  test("a downgrade that strands pending invites stops successive accepts exactly at the new cap", async () => {
    const db = createFixture("a", "b", "c", "d");
    subscribe(db, "unlimited");
    seedMembers(db, 3);
    const pending = [
      await invite(db, "a"),
      await invite(db, "b"),
      await invite(db, "c"),
      await invite(db, "d"),
    ];
    // Three members plus four pending: `members + pending` sits above the
    // five-seat plan the workspace now resolves to.
    downgrade(db, "free");

    const kinds: string[] = [];
    for (const row of pending) {
      kinds.push((await acceptInvite(db, row.id, row.github_login, NOW, "saas")).kind);
    }

    // Exactly two conversions fit (3 → 4 → 5); the rest refuse and stay
    // pending, so they become acceptable again once a seat frees.
    expect(kinds).toEqual(["accepted", "accepted", "member_cap", "member_cap"]);
    expect(memberCount(db)).toBe(5);
    expect(statuses(db).filter((status) => status === "accepted")).toHaveLength(2);
    expect(statuses(db).filter((status) => status === "pending")).toHaveLength(2);
  });

  test("two accepts issued against the last free seat admit exactly one", async () => {
    const db = createFixture("racer-a", "racer-b");
    subscribe(db, "unlimited");
    seedMembers(db, 4);
    const first = await invite(db, "racer-a");
    const second = await invite(db, "racer-b");
    downgrade(db, "free");

    // The acceptance path has NO seat pre-read, so both calls reach the
    // membership insert and only the count inside it can hold the plan. The
    // bun:sqlite double brackets every batch in BEGIN/COMMIT on one connection,
    // so the pair runs back-to-back here; it is the same insert-time decision
    // the loser of a true race makes.
    const outcomes = [
      await acceptInvite(db, first.id, "racer-a", NOW, "saas"),
      await acceptInvite(db, second.id, "racer-b", NOW, "saas"),
    ];

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["accepted", "member_cap"]);
    expect(memberCount(db)).toBe(5);
    expect(rowOf(db, second.id).status).toBe("pending");
  });
});
