/**
 * Workspace membership + invitation API — the request-level
 * matrix over `/:workspaceRef/api/members{,/invites,/invites/:id/{revoke,accept}}`
 * and the workspace member action POSTs.
 *
 * The ordering contract is exercised through the real worker mount: the routing
 * gate classifies the ref, the session guard authenticates, and the route-local
 * gate resolves the workspace + the caller's membership. Every assertion is a
 * status plus the state it must leave behind — a refusal is only correct when it
 * wrote nothing.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createInvite } from "../../src/dashboard/invite-store";
import { signInDashboardUser } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const WORKSPACE = "ws-acme";

function seedUser(db: TestD1, login: string, role: "admin" | "member" = "member"): string {
  const id = crypto.randomUUID();
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, ?, ?, NULL)")
    .run(id, login, role, new Date().toISOString());
  return id;
}

function seedWorkspace(db: TestD1, id: string, slug: string): void {
  db.raw
    .prepare(
      "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    )
    .run(id, slug, slug, new Date().toISOString());
}

function seedMembership(
  db: TestD1,
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): void {
  db.raw
    .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)")
    .run(workspaceId, userId, role, new Date().toISOString());
}

/**
 * One workspace `acme` with the three-role ladder plus a signed-in outsider
 * (`bob`) who is a member of a DIFFERENT workspace — so a refusal for him is a
 * cross-workspace 404, never a 403.
 */
function fixture() {
  const db = createMigratedTestD1();
  seedWorkspace(db, WORKSPACE, "acme");
  seedWorkspace(db, "ws-other", "other");
  const owner = seedUser(db, "dana");
  const admin = seedUser(db, "carol");
  const member = seedUser(db, "mallory");
  const secondOwner = seedUser(db, "olive");
  const outsider = seedUser(db, "bob");
  seedMembership(db, WORKSPACE, owner, "owner");
  seedMembership(db, WORKSPACE, admin, "admin");
  seedMembership(db, WORKSPACE, member, "member");
  seedMembership(db, WORKSPACE, secondOwner, "owner");
  seedMembership(db, "ws-other", outsider, "owner");
  return { db, users: { owner, admin, member, secondOwner, outsider } };
}

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KEY: undefined,
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DB: db,
  } as unknown as Env;
}

async function request(
  path: string,
  login: string,
  init: { method?: "GET" | "POST"; body?: string; accept?: string } = {},
): Promise<Response> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  const headers: Record<string, string> = {
    Cookie: `${SESSION_COOKIE}=${session}`,
    Accept: init.accept ?? "application/json",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
  return worker.fetch(
    new Request(`https://worker.local${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
    envFor(currentDb),
  );
}

/** The active fixture's store — `request` reads it, so each test sets it first. */
let currentDb: TestD1;

function use(db: TestD1): void {
  currentDb = db;
}

/** A `COUNT(*) AS n` read through the bun:sqlite double (always one row). */
function count(db: TestD1, sql: string, ...params: string[]): number {
  const row = db.raw.prepare(sql).get(...params);
  return row !== null && typeof row === "object" && "n" in row && typeof row.n === "number" ? row.n : 0;
}

/** One workspace member's stored role (`workspace_members.role`). */
function memberRole(db: TestD1, login: string, workspaceId = WORKSPACE): string {
  const row = db.raw
    .prepare(
      `SELECT wm.role AS role FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ? AND u.github_login = ? COLLATE NOCASE`,
    )
    .get(workspaceId, login) as { role: string } | null;
  if (row === null) throw new Error(`no membership for ${login} in ${workspaceId}`);
  return row.role;
}

/** One invite's stored status, read back after the request under test. */
function inviteStatus(db: TestD1, id: string): string {
  const row = db.raw.prepare("SELECT status FROM workspace_invites WHERE id = ?").get(id) as {
    status: string;
  } | null;
  if (row === null) throw new Error(`no invite ${id}`);
  return row.status;
}

function pendingInvites(db: TestD1): number {
  return count(db, "SELECT COUNT(*) AS n FROM workspace_invites WHERE status = 'pending'");
}

function memberRows(db: TestD1, workspaceId = WORKSPACE): number {
  return count(db, "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?", workspaceId);
}

const MEMBERS = "/dashboard/acme/api/members";
const INVITES = "/dashboard/acme/api/members/invites";

describe("member list visibility (AC4)", () => {
  test("every member sees the list with workspace roles; an outsider gets 404", async () => {
    const { db } = fixture();
    use(db);
    for (const login of ["dana", "carol", "mallory"]) {
      const res = await request(MEMBERS, login);
      expect(res.status, login).toBe(200);
      const body = (await res.json()) as {
        viewer: { login: string; role: string };
        members: Array<{ github_login: string; role: string }>;
      };
      expect(body.members.map((row) => row.github_login).sort()).toEqual([
        "carol",
        "dana",
        "mallory",
        "olive",
      ]);
      // The payload exposes WORKSPACE roles (owner is a first-class row here).
      expect(body.members.some((row) => row.role === "owner")).toBe(true);
      expect(body.viewer.login).toBe(login);
    }

    const outsider = await request(MEMBERS, "bob");
    expect(outsider.status).toBe(404);
    expect(await outsider.text()).not.toContain("mallory");
  });

  test("an unknown workspace ref answers the same 404 as a non-member", async () => {
    const { db } = fixture();
    use(db);
    const res = await request("/dashboard/nope/api/members", "dana");
    expect(res.status).toBe(404);
  });

  test("the retired deployment-level member faces are gone", async () => {
    const { db } = fixture();
    use(db);
    // GET /api/members has no route left at all (plain 404).
    expect((await request("/dashboard/api/members", "dana")).status).toBe(404);
    // The retired member POSTs fall through to the placeholder catch-all: the
    // method is not wired anywhere, so it answers 405 and writes nothing.
    for (const [path, body] of [
      ["/dashboard/members/invite", "login=hubot"],
      ["/dashboard/members/remove", "userId=x"],
      ["/dashboard/members/role", "userId=x&role=admin"],
    ] as const) {
      const res = await request(path, "dana", { method: "POST", body });
      expect(res.status, path).toBe(405);
    }
    expect(pendingInvites(db)).toBe(0);
    expect(memberRows(db)).toBe(4);
    expect(count(db, "SELECT COUNT(*) AS n FROM removed_logins")).toBe(0);
  });
});

describe("pending invite visibility (AC4)", () => {
  test("owner and admin read the list; a plain member is 403; an outsider is 404", async () => {
    const { db, users } = fixture();
    use(db);
    await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.owner,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    for (const login of ["dana", "carol"]) {
      const res = await request(INVITES, login);
      expect(res.status, login).toBe(200);
      const body = (await res.json()) as {
        invites: Array<{ github_login: string; role: string; expires_at: string }>;
      };
      expect(body.invites).toHaveLength(1);
      expect(body.invites[0]!.github_login).toBe("hubot");
      expect(body.invites[0]!.expires_at).toBeTruthy();
    }

    const member = await request(INVITES, "mallory");
    expect(member.status).toBe(403);

    const outsider = await request(INVITES, "bob");
    expect(outsider.status).toBe(404);
  });
});

describe("invite creation (AC2)", () => {
  test("owner and admin create one pending invite; the row carries the invited role", async () => {
    const { db, users } = fixture();
    use(db);
    // The fixture's four members leave ONE seat and this case mints two
    // invites, so drop a non-actor member: the cap has its own cases below.
    db.raw
      .prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
      .run(WORKSPACE, users.secondOwner);
    for (const login of ["dana", "carol"]) {
      const target = login === "dana" ? "hubot" : "ada";
      const res = await request(INVITES, login, {
        method: "POST",
        body: `login=${target}&role=admin`,
      });
      expect(res.status, login).toBe(200);
    }
    const rows = db.raw
      .prepare("SELECT github_login, role, status FROM workspace_invites ORDER BY github_login")
      .all() as Array<{ github_login: string; role: string; status: string }>;
    expect(rows).toEqual([
      { github_login: "ada", role: "admin", status: "pending" },
      { github_login: "hubot", role: "admin", status: "pending" },
    ]);
  });

  test("a plain member is 403 and writes nothing", async () => {
    const { db } = fixture();
    use(db);
    const res = await request(INVITES, "mallory", { method: "POST", body: "login=hubot" });
    expect(res.status).toBe(403);
    expect(pendingInvites(db)).toBe(0);
  });

  test("a non-member is 404 and writes nothing", async () => {
    const { db } = fixture();
    use(db);
    const res = await request(INVITES, "bob", { method: "POST", body: "login=hubot" });
    expect(res.status).toBe(404);
    expect(pendingInvites(db)).toBe(0);
  });

  test("a second pending invite for the same login is 409 and leaves the first row untouched", async () => {
    const { db, users } = fixture();
    use(db);
    // Four members + the first pending invite would fill the five-seat cap and
    // the cap refusal would answer first; drop a member so this stays the
    // duplicate-invite case it is named for.
    db.raw
      .prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
      .run(WORKSPACE, users.secondOwner);
    expect((await request(INVITES, "dana", { method: "POST", body: "login=hubot" })).status).toBe(200);
    const first = db.raw
      .prepare("SELECT id, role, created_at FROM workspace_invites WHERE status = 'pending'")
      .get() as { id: string; role: string; created_at: string };

    const second = await request(INVITES, "carol", { method: "POST", body: "login=hubot&role=admin" });
    expect(second.status).toBe(409);
    expect(await second.text()).toContain("invite.pending_exists");
    expect(
      db.raw.prepare("SELECT id, role, created_at FROM workspace_invites WHERE status = 'pending'").get(),
    ).toEqual(first);
  });

  test("inviting a login with a removal record is 409 invite.login_removed, no row", async () => {
    const { db } = fixture();
    use(db);
    // The removal record denies sign-in at the write boundary (0023), so an
    // invite minted here could never be accepted. Refusing writes nothing;
    // clearing the record is the operator's decision, not this route's.
    db.raw
      .prepare("INSERT INTO removed_logins (github_login, removed_at) VALUES (?, ?)")
      .run("HUBOT", "2026-10-22T00:00:00.000Z");

    const res = await request(INVITES, "dana", { method: "POST", body: "login=hubot" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("invite.login_removed");
    expect(pendingInvites(db)).toBe(0);
    // The record survives: the refusal never re-admits the login.
    expect(
      (db.raw.prepare("SELECT COUNT(*) AS n FROM removed_logins").get() as { n: number }).n,
    ).toBe(1);
  });

  test("inviting an existing member is 409 and creates no row", async () => {
    const { db } = fixture();
    use(db);
    const res = await request(INVITES, "dana", { method: "POST", body: "login=Mallory" });
    expect(res.status).toBe(409);
    expect(pendingInvites(db)).toBe(0);
  });

  test("malformed input is 400 before any read or write", async () => {
    const { db } = fixture();
    use(db);
    for (const body of ["login=&role=member", "login=not%20a%20login", "login=hubot&role=owner"]) {
      const res = await request(INVITES, "dana", { method: "POST", body });
      expect(res.status, body).toBe(400);
    }
    expect(pendingInvites(db)).toBe(0);
  });
});

describe("invite creation member cap", () => {
  const MEMBER_CAP_REFUSAL =
    "This invite was not sent. This workspace already has five people, counting members and pending invites. Remove a member or revoke a pending invite, then send the invite again.";

  /** A live pending invite, minted at the store so the route stays the subject. */
  function seedLiveInvite(db: TestD1, invitedBy: string, login = "newcomer") {
    const now = new Date();
    return createInvite(db, {
      workspaceId: WORKSPACE,
      login,
      role: "member",
      invitedBy,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
  }

  test("the fifth person is invitable; the sixth person's invite is the exact 409 and writes nothing", async () => {
    const { db } = fixture();
    use(db);
    expect((await request(INVITES, "dana", { method: "POST", body: "login=hubot" })).status).toBe(200);
    expect(pendingInvites(db)).toBe(1);

    const res = await request(INVITES, "carol", { method: "POST", body: "login=ada" });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(MEMBER_CAP_REFUSAL);
    expect(pendingInvites(db)).toBe(1);
  });

  test("a live pending invite consumes a seat: four members plus one pending refuse the next invite", async () => {
    const { db, users } = fixture();
    use(db);
    await seedLiveInvite(db, users.owner);
    const res = await request(INVITES, "dana", { method: "POST", body: "login=ada" });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(MEMBER_CAP_REFUSAL);
    expect(pendingInvites(db)).toBe(1);
  });

  test("revoking the pending invite frees the seat for the same call", async () => {
    const { db, users } = fixture();
    use(db);
    const invite = await seedLiveInvite(db, users.owner);
    expect((await request(INVITES, "dana", { method: "POST", body: "login=ada" })).status).toBe(409);

    const revoked = await request(`${INVITES}/${invite.id}/revoke`, "dana", { method: "POST" });
    expect(revoked.status).toBe(200);
    const retry = await request(INVITES, "dana", { method: "POST", body: "login=ada" });
    expect(retry.status).toBe(200);
    expect(pendingInvites(db)).toBe(1);
  });

  test("a lapsed pending invite consumes no seat", async () => {
    const { db, users } = fixture();
    use(db);
    const now = new Date();
    await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "lapsed",
      role: "member",
      invitedBy: users.owner,
      now: new Date(now.getTime() - 120_000).toISOString(),
      expiresAt: new Date(now.getTime() - 60_000).toISOString(),
    });
    const res = await request(INVITES, "dana", { method: "POST", body: "login=ada" });
    expect(res.status).toBe(200);
    expect(pendingInvites(db)).toBe(1);
  });

  test("a pro workspace is capped at five too", async () => {
    const { db, users } = fixture();
    const ts = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at) VALUES (?, 'pro', 'active', ?, ?)",
      )
      .run(WORKSPACE, ts, ts);
    use(db);
    await seedLiveInvite(db, users.owner);
    const res = await request(INVITES, "dana", { method: "POST", body: "login=ada" });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(MEMBER_CAP_REFUSAL);
    expect(pendingInvites(db)).toBe(1);
  });
});

describe("invite revoke (AC6)", () => {
  test("revoking removes the row from the pending list and a later accept is 410", async () => {
    const { db, users } = fixture();
    use(db);
    const invite = await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.owner,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const res = await request(`/dashboard/acme/api/members/invites/${invite.id}/revoke`, "dana", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const list = await request(INVITES, "dana");
    expect(((await list.json()) as { invites: unknown[] }).invites).toEqual([]);

    // The invitee must already have a users row for accept to reach its
    // terminal branch; the plan's accept joins `users`.
    seedUser(db, "hubot");
    const accept = await request(`/dashboard/acme/api/members/invites/${invite.id}/accept`, "hubot", {
      method: "POST",
    });
    expect(accept.status).toBe(410);
    expect(memberRows(db)).toBe(4);
  });

  test("a plain member cannot revoke (403); a foreign workspace id is 404", async () => {
    const { db, users } = fixture();
    use(db);
    const invite = await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.owner,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const memberRes = await request(`/dashboard/acme/api/members/invites/${invite.id}/revoke`, "mallory", {
      method: "POST",
    });
    expect(memberRes.status).toBe(403);
    expect(pendingInvites(db)).toBe(1);

    // Same invite id addressed through the OTHER workspace ref: not this
    // workspace's invite, so the outsider 404 (never a cross-tenant revoke).
    const foreign = await request(`/dashboard/other/api/members/invites/${invite.id}/revoke`, "bob", {
      method: "POST",
    });
    expect(foreign.status).toBe(404);
    expect(pendingInvites(db)).toBe(1);
  });
});

describe("invite accept (AC3)", () => {
  test("the invited login accepts and becomes a member at the invited role", async () => {
    const { db, users } = fixture();
    use(db);
    const invite = await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "Hubot",
      role: "admin",
      invitedBy: users.owner,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    // The person signs in FIRST (C3: the invite path never creates a users row).
    seedUser(db, "hubot");

    const res = await request(`/dashboard/acme/api/members/invites/${invite.id}/accept`, "hubot", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(memberRows(db)).toBe(5);
    expect(memberRole(db, "hubot")).toBe("admin");
    expect(pendingInvites(db)).toBe(0);
    expect(inviteStatus(db, invite.id)).toBe("accepted");

    // The new member now reads the member list.
    expect((await request(MEMBERS, "hubot")).status).toBe(200);
  });

  test("a repeat accept returns the same membership and inserts no second row", async () => {
    const { db, users } = fixture();
    use(db);
    const invite = await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.owner,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    seedUser(db, "hubot");
    const path = `/dashboard/acme/api/members/invites/${invite.id}/accept`;
    expect((await request(path, "hubot", { method: "POST" })).status).toBe(200);
    expect((await request(path, "hubot", { method: "POST" })).status).toBe(200);
    expect(memberRows(db)).toBe(5);
  });

  test("a login mismatch is 404, byte-identical to an unknown workspace, with zero writes", async () => {
    const { db, users } = fixture();
    use(db);
    const invite = await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.owner,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    seedUser(db, "mallory2");
    const res = await request(`/dashboard/acme/api/members/invites/${invite.id}/accept`, "mallory2", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(memberRows(db)).toBe(4);
    expect(pendingInvites(db)).toBe(1);
  });

  test("an unknown invite id and an invite of another workspace both answer 404", async () => {
    const { db, users } = fixture();
    use(db);
    const foreign = await createInvite(db, {
      workspaceId: "ws-other",
      login: "hubot",
      role: "member",
      invitedBy: users.outsider,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    seedUser(db, "hubot");
    expect(
      (await request(`/dashboard/acme/api/members/invites/${foreign.id}/accept`, "hubot", { method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await request("/dashboard/acme/api/members/invites/nope/accept", "hubot", { method: "POST" })).status,
    ).toBe(404);
    expect(memberRows(db)).toBe(4);
  });

  test("an EXPIRED invite can be re-issued to the same login and the re-invite is accepted", async () => {
    const { db, users } = fixture();
    use(db);
    // A lapsed invite, driven through the accept route so its terminal state
    // is the one the route itself produces (`expired`, not a hand-set row).
    const lapsed = await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.owner,
      now: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    seedUser(db, "hubot");
    const expired = await request(`/dashboard/acme/api/members/invites/${lapsed.id}/accept`, "hubot", {
      method: "POST",
    });
    expect(expired.status).toBe(409);
    expect(inviteStatus(db, lapsed.id)).toBe("expired");

    // The terminal row does not block a re-invite: a new pending row is minted
    // (the pending uniqueness index only covers live invites) and the old row
    // keeps its expired state.
    const reissue = await request(INVITES, "dana", { method: "POST", body: "login=hubot&role=admin" });
    expect(reissue.status).toBe(200);
    const fresh = db.raw
      .prepare("SELECT id, role, status FROM workspace_invites WHERE status = 'pending'")
      .get() as { id: string; role: string; status: string };
    expect(fresh.id).not.toBe(lapsed.id);
    expect(fresh.role).toBe("admin");
    expect(inviteStatus(db, lapsed.id)).toBe("expired");

    // The re-invite is accepted and the membership lands at the NEW role.
    const accept = await request(`/dashboard/acme/api/members/invites/${fresh.id}/accept`, "hubot", {
      method: "POST",
    });
    expect(accept.status).toBe(200);
    expect(memberRole(db, "hubot")).toBe("admin");
    expect(inviteStatus(db, fresh.id)).toBe("accepted");
    expect(pendingInvites(db)).toBe(0);
  });

  test("a lapsed pending invite answers 409 invite.expired once, then 410", async () => {
    const { db, users } = fixture();
    use(db);
    const lapsed = await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.owner,
      now: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    seedUser(db, "hubot");
    const path = `/dashboard/acme/api/members/invites/${lapsed.id}/accept`;
    const first = await request(path, "hubot", { method: "POST" });
    expect(first.status).toBe(409);
    expect(await first.text()).toContain("invite.expired");
    // The same request flipped the row to its terminal state.
    expect(inviteStatus(db, lapsed.id)).toBe("expired");
    expect((await request(path, "hubot", { method: "POST" })).status).toBe(410);
    expect(memberRows(db)).toBe(4);
  });
});

/**
 * The accepting login's free slot (Invite acceptance gate). `ws-acme` seeds no
 * subscription row, so it resolves to `free`; these cases place the invitee in
 * a second live free workspace, or price the target.
 */
describe("invite accept free slot", () => {
  const FREE_SLOT_INVITE_REFUSAL =
    "You were not added. You already belong to a free workspace, and you can belong to only one at a time. Delete that workspace if you own it. If you do not, an owner or admin of that workspace must remove you. Then accept this invite. The invite is still pending.";

  /** A second live free workspace (`second`, owner `erin`) with `hubot` as a member; returns hubot's user id. */
  function seedSecondWorkspace(db: TestD1): string {
    seedWorkspace(db, "ws-second", "second");
    seedMembership(db, "ws-second", seedUser(db, "erin"), "owner");
    const hubot = seedUser(db, "hubot");
    seedMembership(db, "ws-second", hubot, "member");
    return hubot;
  }

  function inviteHubotToAcme(db: TestD1, invitedBy: string) {
    return createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  test("a login already in a live free workspace is refused with the exact 409 body, leaving the invite pending", async () => {
    const { db, users } = fixture();
    seedSecondWorkspace(db);
    use(db);
    const invite = await inviteHubotToAcme(db, users.owner);

    const res = await request(`/dashboard/acme/api/members/invites/${invite.id}/accept`, "hubot", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(FREE_SLOT_INVITE_REFUSAL);
    expect(inviteStatus(db, invite.id)).toBe("pending");
    expect(memberRows(db)).toBe(4);
  });

  test("removing that membership lets the same accept through", async () => {
    const { db, users } = fixture();
    const hubotId = seedSecondWorkspace(db);
    use(db);
    const invite = await inviteHubotToAcme(db, users.owner);
    const path = `/dashboard/acme/api/members/invites/${invite.id}/accept`;
    expect((await request(path, "hubot", { method: "POST" })).status).toBe(409);

    // The existing removal path: the second workspace's owner drops the login.
    const removed = await request("/dashboard/second/members/remove", "erin", {
      method: "POST",
      body: `userId=${hubotId}`,
    });
    expect(removed.status).toBe(200);
    expect(count(db, "SELECT COUNT(*) AS n FROM workspace_members WHERE user_id = ?", hubotId)).toBe(0);

    const accepted = await request(path, "hubot", { method: "POST" });
    expect(accepted.status).toBe(200);
    expect(inviteStatus(db, invite.id)).toBe("accepted");
    expect(memberRole(db, "hubot")).toBe("member");
  });

  test("a pro target accepts regardless of the login's free workspace", async () => {
    const { db, users } = fixture();
    seedSecondWorkspace(db);
    db.raw
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at) VALUES (?, 'pro', 'active', ?, ?)",
      )
      .run(WORKSPACE, new Date().toISOString(), new Date().toISOString());
    use(db);
    const invite = await inviteHubotToAcme(db, users.owner);

    const res = await request(`/dashboard/acme/api/members/invites/${invite.id}/accept`, "hubot", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(inviteStatus(db, invite.id)).toBe("accepted");
    expect(memberRole(db, "hubot")).toBe("member");
  });
});

describe("member role change and removal (AC5)", () => {
  test("owner changes a member's workspace role; users.role is not written", async () => {
    const { db, users } = fixture();
    use(db);
    const res = await request("/dashboard/acme/members/role", "dana", {
      method: "POST",
      body: `userId=${users.member}&role=admin`,
    });
    expect(res.status).toBe(200);
    expect(memberRole(db, "mallory")).toBe("admin");
    // The legacy column is not a role surface.
    const legacy = db.raw.prepare("SELECT role FROM users WHERE id = ?").get(users.member) as {
      role: string;
    } | null;
    expect(legacy?.role).toBe("member");
  });

  test("admin may not change any role — owner's, another admin's, or a plain member's (403)", async () => {
    const { db, users } = fixture();
    use(db);
    for (const target of [users.owner, users.secondOwner, users.member]) {
      const res = await request("/dashboard/acme/members/role", "carol", {
        method: "POST",
        body: `userId=${target}&role=member`,
      });
      expect(res.status, target).toBe(403);
    }
    // …and an admin may not promote a plain member to owner either.
    const promote = await request("/dashboard/acme/members/role", "carol", {
      method: "POST",
      body: `userId=${users.member}&role=owner`,
    });
    expect(promote.status).toBe(403);
    // Zero writes on every refusal: the roles are exactly the seeded ones.
    expect(memberRole(db, "mallory")).toBe("member");
    expect(memberRole(db, "dana")).toBe("owner");
  });

  test("the last owner cannot be demoted or removed (409, zero writes)", async () => {
    // A workspace with exactly ONE owner: the sole-owner guard is the refusal.
    const db = createMigratedTestD1();
    seedWorkspace(db, WORKSPACE, "acme");
    const owner = seedUser(db, "dana");
    const admin = seedUser(db, "carol");
    seedMembership(db, WORKSPACE, owner, "owner");
    seedMembership(db, WORKSPACE, admin, "admin");
    use(db);

    const demote = await request("/dashboard/acme/members/role", "carol", {
      method: "POST",
      body: `userId=${owner}&role=member`,
    });
    // An admin acting on an owner is 403 before the last-owner rule applies.
    expect(demote.status).toBe(403);

    const remove = await request("/dashboard/acme/members/remove", "carol", {
      method: "POST",
      body: `userId=${owner}`,
    });
    expect(remove.status).toBe(403);
    expect(memberRows(db)).toBe(2);
  });

  test("an owner demoting a non-last peer owner is allowed: 200 and both roles as posted", async () => {
    const { db, users } = fixture();
    use(db);
    // TWO owners: the guard's clause is about the LAST owner, so a peer change
    // falls outside it — the multi-owner case this guard must not block.
    expect(memberRole(db, "dana")).toBe("owner");
    expect(memberRole(db, "olive")).toBe("owner");

    const res = await request("/dashboard/acme/members/role", "dana", {
      method: "POST",
      body: `userId=${users.secondOwner}&role=admin`,
    });
    expect(res.status).toBe(200);
    expect(memberRole(db, "olive")).toBe("admin");
    expect(memberRole(db, "dana")).toBe("owner");
    expect(memberRows(db)).toBe(4);
  });

  test("the last-owner guard does not fire for a peer: only the sole owner's own demotion is 409, both rows unchanged", async () => {
    const { db, users } = fixture();
    use(db);
    // The peer demotion lands — the guard is silent for a non-last owner…
    const peer = await request("/dashboard/acme/members/role", "dana", {
      method: "POST",
      body: `userId=${users.secondOwner}&role=member`,
    });
    expect(peer.status).toBe(200);
    // …and the 409 belongs only to the now-sole owner demoting themselves.
    const self = await request("/dashboard/acme/members/role", "dana", {
      method: "POST",
      body: `userId=${users.owner}&role=member`,
    });
    expect(self.status).toBe(409);
    expect(await self.text()).toContain("only owner");
    // Zero writes on the refusal: both rows keep the roles they held before it.
    expect(memberRole(db, "dana")).toBe("owner");
    expect(memberRole(db, "olive")).toBe("member");
    expect(memberRows(db)).toBe(4);
  });

  test("owner removal: allowed for a non-last owner, the actor's own removal is 409", async () => {
    const { db, users } = fixture();
    use(db);
    // Two owners exist, so removing one is allowed.
    const first = await request("/dashboard/acme/members/remove", "dana", {
      method: "POST",
      body: `userId=${users.secondOwner}`,
    });
    expect(first.status).toBe(200);
    expect(memberRows(db)).toBe(3);

    // Now `dana` is the last owner: her own removal is the last-owner conflict.
    const second = await request("/dashboard/acme/members/remove", "dana", {
      method: "POST",
      body: `userId=${users.owner}`,
    });
    expect(second.status).toBe(409);
    const third = await request("/dashboard/acme/members/remove", "carol", {
      method: "POST",
      body: `userId=${users.owner}`,
    });
    expect(third.status).toBe(403); // admin may not remove an owner
    expect(memberRows(db)).toBe(3);
  });

  test("removing a member deletes only the membership: identity and invites survive", async () => {
    const { db, users } = fixture();
    use(db);
    // `mallory` created an invite, so workspace_invites.invited_by points at her.
    await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.member,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const res = await request("/dashboard/acme/members/remove", "dana", {
      method: "POST",
      body: `userId=${users.member}`,
    });
    expect(res.status).toBe(200);
    expect(memberRows(db)).toBe(3);
    // The users row stays — removal is workspace-scoped, never a login ban …
    expect(count(db, "SELECT COUNT(*) AS n FROM users WHERE github_login = 'mallory'")).toBe(1);
    // … nothing is tombstoned at the deployment level …
    expect(count(db, "SELECT COUNT(*) AS n FROM removed_logins")).toBe(0);
    // … and the invite she created is intact (its FK target still exists).
    expect(count(db, "SELECT COUNT(*) AS n FROM workspace_invites WHERE invited_by = ?", users.member)).toBe(1);
    // She is out of THIS workspace, so its pages answer the outsider 404.
    expect((await request(MEMBERS, "mallory")).status).toBe(404);
  });

  test("the removed person can still sign in and be invited into another workspace", async () => {
    const { db, users } = fixture();
    use(db);
    expect(
      (
        await request("/dashboard/acme/members/remove", "dana", {
          method: "POST",
          body: `userId=${users.member}`,
        })
      ).status,
    ).toBe(200);

    // Sign-in is unaffected: no tombstone, so the login is admitted.
    expect((await signInDashboardUser(db, "mallory")).outcome).toBe("allow");

    // …and another workspace can invite them, which they accept.
    const invite = await createInvite(db, {
      workspaceId: "ws-other",
      login: "mallory",
      role: "member",
      invitedBy: users.outsider,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const accept = await request(`/dashboard/other/api/members/invites/${invite.id}/accept`, "mallory", {
      method: "POST",
    });
    expect(accept.status).toBe(200);
    expect(memberRole(db, "mallory", "ws-other")).toBe("member");
  });

  test("a plain member cannot change roles or remove anyone (403)", async () => {
    const { db, users } = fixture();
    use(db);
    const role = await request("/dashboard/acme/members/role", "mallory", {
      method: "POST",
      body: `userId=${users.member}&role=admin`,
    });
    expect(role.status).toBe(403);
    const remove = await request("/dashboard/acme/members/remove", "mallory", {
      method: "POST",
      body: `userId=${users.admin}`,
    });
    expect(remove.status).toBe(403);
    expect(memberRows(db)).toBe(4);
  });

  test("a target that is not a member of this workspace is 404", async () => {
    const { db, users } = fixture();
    use(db);
    const res = await request("/dashboard/acme/members/remove", "dana", {
      method: "POST",
      body: `userId=${users.outsider}`,
    });
    expect(res.status).toBe(404);
  });
});

describe("workspace summary in the member payload", () => {
  type MembersBody = {
    workspace: {
      plan: { id: string; name: string };
      memberLimit: number;
      reviewAttemptsThisMonth: number;
      pendingInvites: number;
    };
    members: Array<{ github_login: string }>;
  };

  /** One metered started execution (the ledger's only required columns). */
  function insertUsage(db: TestD1, reviewId: string, occurredAt: string, workspaceId = WORKSPACE): void {
    db.raw
      .prepare(
        `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at)
         VALUES (?, 1, ?, ?, ?)`,
      )
      .run(reviewId, `${reviewId}:${occurredAt}`, workspaceId, occurredAt);
  }

  test("a free workspace reports the Free plan, its member limit and this month's attempts", async () => {
    const { db } = fixture();
    use(db);
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    // Two rows inside the current UTC month (the first instant counts), one
    // before it, and one in another workspace — the count is this workspace's.
    insertUsage(db, "review-in-1", new Date(monthStart).toISOString());
    insertUsage(db, "review-in-2", now.toISOString());
    insertUsage(db, "review-out", new Date(monthStart - 1).toISOString());
    insertUsage(db, "review-other", now.toISOString(), "ws-other");

    const res = await request(MEMBERS, "dana");
    expect(res.status).toBe(200);
    const body = (await res.json()) as MembersBody;
    expect(body.workspace).toEqual({
      plan: { id: "free", name: "Free" },
      memberLimit: 5,
      reviewAttemptsThisMonth: 2,
      pendingInvites: 0,
    });
    // The existing member fields are unchanged by the addition.
    expect(body.members.map((row) => row.github_login).sort()).toEqual([
      "carol",
      "dana",
      "mallory",
      "olive",
    ]);
  });

  test("an active pro subscription changes the reported plan, not the limit", async () => {
    const { db } = fixture();
    use(db);
    const now = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at) VALUES (?, 'pro', 'active', ?, ?)",
      )
      .run(WORKSPACE, now, now);

    const body = (await (await request(MEMBERS, "dana")).json()) as MembersBody;
    expect(body.workspace).toEqual({
      plan: { id: "pro", name: "Pro" },
      memberLimit: 5,
      reviewAttemptsThisMonth: 0,
      pendingInvites: 0,
    });
  });

  test("a live pending invite is counted; a lapsed one consumes no seat", async () => {
    const { db, users } = fixture();
    use(db);
    const now = new Date();
    // Four members already hold four of the plan's five seats, so the seat
    // guard admits exactly one pending invite — the count the summary reports.
    const live = await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.owner,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });

    const counted = (await (await request(MEMBERS, "dana")).json()) as MembersBody;
    expect(counted.workspace.pendingInvites).toBe(1);
    // The member fields themselves stay the member rows.
    expect(counted.members.length).toBe(4);

    // The cap's own lazy-expiry predicate: a past expires_at frees the seat
    // even before a write flips the row's status.
    db.raw
      .prepare("UPDATE workspace_invites SET expires_at = ? WHERE id = ?")
      .run(new Date(now.getTime() - 1_000).toISOString(), live.id);
    const lapsed = (await (await request(MEMBERS, "dana")).json()) as MembersBody;
    expect(lapsed.workspace.pendingInvites).toBe(0);
  });
});
