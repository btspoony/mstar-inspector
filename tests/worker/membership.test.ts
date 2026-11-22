import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createInvite } from "../../src/dashboard/invite-store";
import { signInDashboardUser } from "../../src/dashboard/users";
import type { SpaBoot } from "../../src/spa/boot";
import type { DeploymentMode, Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { htmlGetRequest, withSpaAssets } from "../helpers/spa";

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
    DEPLOYMENT_MODE: "saas",
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

let currentDb: TestD1;

function use(db: TestD1): void {
  currentDb = db;
}

function count(db: TestD1, sql: string, ...params: string[]): number {
  const row = db.raw.prepare(sql).get(...params);
  return row !== null && typeof row === "object" && "n" in row && typeof row.n === "number" ? row.n : 0;
}

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
    expect((await request("/dashboard/api/members", "dana")).status).toBe(404);
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
    }, "saas");

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
    db.raw
      .prepare("INSERT INTO removed_logins (github_login, removed_at) VALUES (?, ?)")
      .run("HUBOT", "2026-10-22T00:00:00.000Z");

    const res = await request(INVITES, "dana", { method: "POST", body: "login=hubot" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("invite.login_removed");
    expect(pendingInvites(db)).toBe(0);
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
    "This invite was not sent. This workspace already has 5 people, counting members and pending invites. Remove a member or revoke a pending invite, then send the invite again.";

  function seedLiveInvite(db: TestD1, invitedBy: string, login = "newcomer") {
    const now = new Date();
    return createInvite(db, {
      workspaceId: WORKSPACE,
      login,
      role: "member",
      invitedBy,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    }, "saas");
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
    }, "saas");
    const res = await request(INVITES, "dana", { method: "POST", body: "login=ada" });
    expect(res.status).toBe(200);
    expect(pendingInvites(db)).toBe(1);

    const refused = await request(INVITES, "carol", { method: "POST", body: "login=erin" });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toBe(MEMBER_CAP_REFUSAL);
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

  test("an unlimited workspace's invite path writes with no seat refusal", async () => {
    const { db, users } = fixture();
    const ts = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at) VALUES (?, 'unlimited', 'active', ?, ?)",
      )
      .run(WORKSPACE, ts, ts);
    use(db);
    await seedLiveInvite(db, users.owner);
    const res = await request(INVITES, "dana", { method: "POST", body: "login=ada" });
    expect(res.status).toBe(200);
    expect(pendingInvites(db)).toBe(2);
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
    }, "saas");

    const res = await request(`/dashboard/acme/api/members/invites/${invite.id}/revoke`, "dana", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const list = await request(INVITES, "dana");
    expect(((await list.json()) as { invites: unknown[] }).invites).toEqual([]);

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
    }, "saas");
    const memberRes = await request(`/dashboard/acme/api/members/invites/${invite.id}/revoke`, "mallory", {
      method: "POST",
    });
    expect(memberRes.status).toBe(403);
    expect(pendingInvites(db)).toBe(1);

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
    }, "saas");
    seedUser(db, "hubot");

    const res = await request(`/dashboard/acme/api/members/invites/${invite.id}/accept`, "hubot", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(memberRows(db)).toBe(5);
    expect(memberRole(db, "hubot")).toBe("admin");
    expect(pendingInvites(db)).toBe(0);
    expect(inviteStatus(db, invite.id)).toBe("accepted");

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
    }, "saas");
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
    }, "saas");
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
    }, "saas");
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
    const lapsed = await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.owner,
      now: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }, "saas");
    seedUser(db, "hubot");
    const expired = await request(`/dashboard/acme/api/members/invites/${lapsed.id}/accept`, "hubot", {
      method: "POST",
    });
    expect(expired.status).toBe(409);
    expect(inviteStatus(db, lapsed.id)).toBe("expired");

    const reissue = await request(INVITES, "dana", { method: "POST", body: "login=hubot&role=admin" });
    expect(reissue.status).toBe(200);
    const fresh = db.raw
      .prepare("SELECT id, role, status FROM workspace_invites WHERE status = 'pending'")
      .get() as { id: string; role: string; status: string };
    expect(fresh.id).not.toBe(lapsed.id);
    expect(fresh.role).toBe("admin");
    expect(inviteStatus(db, lapsed.id)).toBe("expired");

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
    }, "saas");
    seedUser(db, "hubot");
    const path = `/dashboard/acme/api/members/invites/${lapsed.id}/accept`;
    const first = await request(path, "hubot", { method: "POST" });
    expect(first.status).toBe(409);
    expect(await first.text()).toContain("invite.expired");
    expect(inviteStatus(db, lapsed.id)).toBe("expired");
    expect((await request(path, "hubot", { method: "POST" })).status).toBe(410);
    expect(memberRows(db)).toBe(4);
  });

  test("an over-cap pending invite from a downgraded plan is the named 409 and writes no member", async () => {
    const { db, users } = fixture();
    const ts = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at) VALUES (?, 'unlimited', 'active', ?, ?)",
      )
      .run(WORKSPACE, ts, ts);
    const invite = await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.owner,
      now: ts,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, "saas");
    seedMembership(db, WORKSPACE, seedUser(db, "fifth"), "member");
    db.raw
      .prepare("UPDATE workspace_subscriptions SET plan_id = 'free', updated_at = ? WHERE workspace_id = ?")
      .run(ts, WORKSPACE);
    seedUser(db, "hubot");
    use(db);

    const res = await request(`/dashboard/acme/api/members/invites/${invite.id}/accept`, "hubot", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(
      "You were not added. This workspace is at its plan's limit of 5 members. An owner or admin must remove a member, or the workspace must move to a larger plan, before this invite can be accepted. The invite is still pending.",
    );
    expect(memberRows(db)).toBe(5);
    expect(inviteStatus(db, invite.id)).toBe("pending");
  });
});

describe("invite accept free slot", () => {
  const FREE_SLOT_INVITE_REFUSAL =
    "You were not added. You already belong to a free workspace, and you can belong to only one at a time. Delete that workspace if you own it. If you do not, an owner or admin of that workspace must remove you. Then accept this invite. The invite is still pending.";

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
    }, "saas");
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
    const promote = await request("/dashboard/acme/members/role", "carol", {
      method: "POST",
      body: `userId=${users.member}&role=owner`,
    });
    expect(promote.status).toBe(403);
    expect(memberRole(db, "mallory")).toBe("member");
    expect(memberRole(db, "dana")).toBe("owner");
  });

  test("the last owner cannot be demoted or removed (409, zero writes)", async () => {
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
    const peer = await request("/dashboard/acme/members/role", "dana", {
      method: "POST",
      body: `userId=${users.secondOwner}&role=member`,
    });
    expect(peer.status).toBe(200);
    const self = await request("/dashboard/acme/members/role", "dana", {
      method: "POST",
      body: `userId=${users.owner}&role=member`,
    });
    expect(self.status).toBe(409);
    expect(await self.text()).toContain("only owner");
    expect(memberRole(db, "dana")).toBe("owner");
    expect(memberRole(db, "olive")).toBe("member");
    expect(memberRows(db)).toBe(4);
  });

  test("owner removal: allowed for a non-last owner, the actor's own removal is 409", async () => {
    const { db, users } = fixture();
    use(db);
    const first = await request("/dashboard/acme/members/remove", "dana", {
      method: "POST",
      body: `userId=${users.secondOwner}`,
    });
    expect(first.status).toBe(200);
    expect(memberRows(db)).toBe(3);

    const second = await request("/dashboard/acme/members/remove", "dana", {
      method: "POST",
      body: `userId=${users.owner}`,
    });
    expect(second.status).toBe(409);
    const third = await request("/dashboard/acme/members/remove", "carol", {
      method: "POST",
      body: `userId=${users.owner}`,
    });
    expect(third.status).toBe(403);
    expect(memberRows(db)).toBe(3);
  });

  test("removing a member deletes only the membership: identity and invites survive", async () => {
    const { db, users } = fixture();
    use(db);
    await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.member,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, "saas");

    const res = await request("/dashboard/acme/members/remove", "dana", {
      method: "POST",
      body: `userId=${users.member}`,
    });
    expect(res.status).toBe(200);
    expect(memberRows(db)).toBe(3);
    expect(count(db, "SELECT COUNT(*) AS n FROM users WHERE github_login = 'mallory'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM removed_logins")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM workspace_invites WHERE invited_by = ?", users.member)).toBe(1);
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

    expect((await signInDashboardUser(db, "mallory")).outcome).toBe("allow");

    const invite = await createInvite(db, {
      workspaceId: "ws-other",
      login: "mallory",
      role: "member",
      invitedBy: users.outsider,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, "saas");
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
    const live = await createInvite(db, {
      workspaceId: WORKSPACE,
      login: "hubot",
      role: "member",
      invitedBy: users.owner,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    }, "saas");

    const counted = (await (await request(MEMBERS, "dana")).json()) as MembersBody;
    expect(counted.workspace.pendingInvites).toBe(1);
    expect(counted.members.length).toBe(4);

    db.raw
      .prepare("UPDATE workspace_invites SET expires_at = ? WHERE id = ?")
      .run(new Date(now.getTime() - 1_000).toISOString(), live.id);
    const lapsed = (await (await request(MEMBERS, "dana")).json()) as MembersBody;
    expect(lapsed.workspace.pendingInvites).toBe(0);
    expect(inviteStatus(db, live.id)).toBe("pending");
  });
});

describe("the switcher resolves each plan once", () => {
  const SUBSCRIPTION_READ = /FROM workspace_subscriptions/;
  const FREE_PLAN_READ = /FROM plans WHERE id = \?/;

  function recording(db: TestD1): { observed: TestD1; statements: string[] } {
    const statements: string[] = [];
    const observed = {
      ...db,
      prepare(query: string) {
        statements.push(query);
        return db.prepare(query);
      },
    } as TestD1;
    return { observed, statements };
  }

  const countReads = (statements: string[], shape: RegExp): number =>
    statements.filter((sql) => shape.test(sql)).length;

  function mixedPlanWorld(): { db: TestD1; login: string } {
    const db = createMigratedTestD1();
    const login = "poly";
    const userId = seedUser(db, login);
    const now = new Date().toISOString();
    for (const [id, subscription] of [
      ["ws-a", "pro"],
      ["ws-b", "pro"],
      ["ws-c", null],
    ] as const) {
      seedWorkspace(db, id, id);
      seedMembership(db, id, userId, "member");
      if (subscription !== null) {
        db.raw
          .prepare(
            "INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
          )
          .run(id, subscription, now, now);
      }
    }
    return { db, login };
  }

  function envIn(db: TestD1, mode: DeploymentMode): Env {
    return {
      REVIEW_QUEUE: { send: async () => {} },
      IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
      GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
      DEPLOYMENT_MODE: mode,
      DASHBOARD_SESSION_SECRET: SESSION_SECRET,
      DB: db,
    } as unknown as Env;
  }

  async function switcherRows(env: Env, login: string): Promise<NonNullable<SpaBoot["memberships"]>> {
    const session = await createSessionValue(login, null, SESSION_SECRET);
    const response = await worker.fetch(
      htmlGetRequest("/dashboard/ws-a/repos", { Cookie: `${SESSION_COOKIE}=${session}` }),
      withSpaAssets(env),
    );
    expect(response.status).toBe(200);
    const json = (await response.text()).match(/window\.__BOOT__=(\{[^\n]+\});/)?.[1];
    if (!json) throw new Error("expected a boot payload");
    return (JSON.parse(json) as SpaBoot).memberships ?? [];
  }

  test("two workspaces on one plan cost ONE subscription read", async () => {
    const { db, login } = mixedPlanWorld();
    const { observed, statements } = recording(db);
    const rows = await switcherRows(envIn(observed, "saas"), login);
    expect(countReads(statements, SUBSCRIPTION_READ)).toBe(1);
    expect(rows.map((row) => [row.id, row.plan])).toEqual([
      ["ws-a", "Pro"],
      ["ws-b", "Pro"],
      ["ws-c", "Free"],
    ]);
  });

  test("self-hosted reads no subscription at all and names Unlimited everywhere", async () => {
    const { db, login } = mixedPlanWorld();
    const { observed, statements } = recording(db);
    const rows = await switcherRows(envIn(observed, "self-hosted"), login);
    expect(countReads(statements, SUBSCRIPTION_READ)).toBe(0);
    expect(countReads(statements, FREE_PLAN_READ)).toBe(0);
    expect(rows.map((row) => row.plan)).toEqual(["Unlimited", "Unlimited", "Unlimited"]);
  });

  test("the boot payload names the switcher's live memberships and their plans in order", async () => {
    const { db, login } = mixedPlanWorld();
    const rows = await switcherRows(envIn(db, "saas"), login);
    expect(rows).toEqual([
      { id: "ws-a", slug: "ws-a", name: "ws-a", role: "member", plan: "Pro" },
      { id: "ws-b", slug: "ws-b", name: "ws-b", role: "member", plan: "Pro" },
      { id: "ws-c", slug: "ws-c", name: "ws-c", role: "member", plan: "Free" },
    ]);
  });
});
