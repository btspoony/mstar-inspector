/**
 * The three-role boundary and the two structural refusals.
 *
 * Everything here goes through the real worker mount — routing gate, session
 * guard, workspace resolution, route-local role check, then the store's
 * conditional statement — so a refusal is only correct when it also wrote
 * nothing. The matrix is `{owner, admin, member} × {invite, revoke,
 * change_role, remove_member, promote}` plus the two target-class sweeps
 * (`admin` against an `owner` / another `admin`) and the structural fixtures:
 * `last_owner` (the workspace can never lose its final owner) and
 * `self_demote` (an owner stepping down while sole owner).
 *
 * `promote` is a role change to `owner`: there is no separate transfer route.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createInvite } from "../../src/dashboard/invite-store";
import { deleteWorkspaceMember, updateWorkspaceMemberRole } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const WORKSPACE = "ws-acme";
const BASE = "/dashboard/acme";
const INVITES = `${BASE}/api/members/invites`;

type Actor = "owner" | "admin" | "member";
type Action = "invite" | "revoke" | "change_role" | "remove_member" | "promote";

function seedUser(db: TestD1, login: string): string {
  const id = crypto.randomUUID();
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(id, login, new Date().toISOString());
  return id;
}

function seedWorkspace(db: TestD1, id: string, slug: string): void {
  db.raw
    .prepare(
      "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    )
    .run(id, slug, slug, new Date().toISOString());
}

function seedMembership(db: TestD1, userId: string, role: Actor | "owner"): void {
  db.raw
    .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)")
    .run(WORKSPACE, userId, role, new Date().toISOString());
}

/**
 * Two workspaces' worth of world, in one (`acme`): one actor per role, one
 * plain member as the default target, and — separately — a second `admin` and
 * a second `owner` so the target-class sweep can address each.
 */
function world() {
  const db = createMigratedTestD1();
  seedWorkspace(db, WORKSPACE, "acme");
  const ids = {
    dana: seedUser(db, "dana"), // actor: owner
    olive: seedUser(db, "olive"), // target: second owner
    carol: seedUser(db, "carol"), // actor: admin
    ivan: seedUser(db, "ivan"), // target: second admin
    mallory: seedUser(db, "mallory"), // actor: member
    hubot: seedUser(db, "hubot"), // target: plain member
  };
  seedMembership(db, ids.dana, "owner");
  seedMembership(db, ids.olive, "owner");
  seedMembership(db, ids.carol, "admin");
  seedMembership(db, ids.ivan, "admin");
  seedMembership(db, ids.mallory, "member");
  seedMembership(db, ids.hubot, "member");
  return { db, ids };
}

/** Exactly one `owner` (`dana`) plus one `admin` and one `member`. */
function soleOwnerWorld() {
  const db = createMigratedTestD1();
  seedWorkspace(db, WORKSPACE, "acme");
  const ids = {
    dana: seedUser(db, "dana"),
    carol: seedUser(db, "carol"),
    mallory: seedUser(db, "mallory"),
    hubot: seedUser(db, "hubot"),
  };
  seedMembership(db, ids.dana, "owner");
  seedMembership(db, ids.carol, "admin");
  seedMembership(db, ids.mallory, "member");
  seedMembership(db, ids.hubot, "member");
  return { db, ids };
}

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KEY: undefined,
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DB: db,
    WORKSPACE_TENANT_MODE: "strict",
  } as unknown as Env;
}

async function post(
  db: TestD1,
  path: string,
  login: string,
  body: Record<string, string>,
): Promise<Response> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  return worker.fetch(
    new Request(`https://worker.local${path}`, {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${session}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    }),
    envFor(db),
  );
}

/** One live pending invite, so the `revoke` row has something to revoke. */
async function seedPendingInvite(db: TestD1, invitedBy: string): Promise<string> {
  const now = new Date();
  const invite = await createInvite(db, {
    workspaceId: WORKSPACE,
    login: "newcomer",
    role: "member",
    invitedBy,
    now: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  });
  return invite.id;
}

/** One workspace member's stored role. */
function roleOf(db: TestD1, userId: string): string | null {
  const row = db.raw
    .prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
    .get(WORKSPACE, userId) as { role: string } | null;
  return row?.role ?? null;
}

function memberCount(db: TestD1): number {
  const row = db.raw
    .prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?")
    .get(WORKSPACE) as { n: number } | null;
  return row?.n ?? 0;
}

const ACTOR_LOGIN: Record<Actor, string> = { owner: "dana", admin: "carol", member: "mallory" };

describe("role matrix: {owner, admin, member} × {invite, revoke, change_role, remove_member, promote}", () => {
  const MATRIX: Array<[Actor, Action, number]> = [
    ["owner", "invite", 200],
    ["owner", "revoke", 200],
    ["owner", "change_role", 200],
    ["owner", "remove_member", 200],
    ["owner", "promote", 200],
    ["admin", "invite", 200],
    ["admin", "revoke", 200],
    ["admin", "change_role", 403],
    ["admin", "remove_member", 200],
    ["admin", "promote", 403],
    ["member", "invite", 403],
    ["member", "revoke", 403],
    ["member", "change_role", 403],
    ["member", "remove_member", 403],
    ["member", "promote", 403],
  ];

  for (const [actor, action, expected] of MATRIX) {
    test(`${actor} ${action} → ${expected}`, async () => {
      const { db, ids } = world();
      const inviteId = await seedPendingInvite(db, ids.dana);
      const login = ACTOR_LOGIN[actor];
      const before = { members: memberCount(db), target: roleOf(db, ids.hubot) };

      const res = await (action === "invite"
        ? post(db, INVITES, login, { login: "newbie", role: "member" })
        : action === "revoke"
          ? post(db, `${INVITES}/${inviteId}/revoke`, login, {})
          : action === "change_role"
            ? post(db, `${BASE}/members/role`, login, { userId: ids.hubot, role: "admin" })
            : action === "remove_member"
              ? post(db, `${BASE}/members/remove`, login, { userId: ids.hubot })
              : post(db, `${BASE}/members/role`, login, { userId: ids.hubot, role: "owner" }));

      expect(res.status).toBe(expected);
      if (expected !== 200) {
        // A refusal writes nothing: same member count, same target role.
        expect(memberCount(db)).toBe(before.members);
        expect(roleOf(db, ids.hubot)).toBe(before.target);
      } else if (action === "change_role") {
        expect(roleOf(db, ids.hubot)).toBe("admin");
      } else if (action === "promote") {
        expect(roleOf(db, ids.hubot)).toBe("owner");
      } else if (action === "remove_member") {
        expect(memberCount(db)).toBe(before.members - 1);
      }
    });
  }
});

describe("target-class boundary: admin may not touch an owner or another admin", () => {
  test("admin remove_member / change_role / promote on a peer admin or an owner → 403, zero writes", async () => {
    const { db, ids } = world();
    const paths: Array<[string, Record<string, string>, string]> = [
      [`${BASE}/members/remove`, { userId: ids.ivan }, "second admin, remove"],
      [`${BASE}/members/remove`, { userId: ids.olive }, "owner, remove"],
      [`${BASE}/members/role`, { userId: ids.ivan, role: "member" }, "second admin, demote"],
      [`${BASE}/members/role`, { userId: ids.olive, role: "member" }, "owner, demote"],
      [`${BASE}/members/role`, { userId: ids.olive, role: "owner" }, "owner, promote (same role)"],
    ];
    for (const [path, body, label] of paths) {
      const res = await post(db, path, "carol", body);
      expect(res.status, label).toBe(403);
    }
    expect(memberCount(db)).toBe(6);
    expect(roleOf(db, ids.ivan)).toBe("admin");
    expect(roleOf(db, ids.olive)).toBe("owner");
  });

  test("admin remove_member of a plain member is allowed", async () => {
    const { db, ids } = world();
    const res = await post(db, `${BASE}/members/remove`, "carol", { userId: ids.hubot });
    expect(res.status).toBe(200);
    expect(roleOf(db, ids.hubot)).toBeNull();
  });

  test("owner may remove or demote an admin or a member, and remove a non-last peer owner", async () => {
    const { db, ids } = world();
    expect((await post(db, `${BASE}/members/role`, "dana", { userId: ids.ivan, role: "member" })).status).toBe(200);
    expect(roleOf(db, ids.ivan)).toBe("member");
    expect((await post(db, `${BASE}/members/remove`, "dana", { userId: ids.ivan })).status).toBe(200);
    expect(roleOf(db, ids.ivan)).toBeNull();
    // Two owners exist, so removing the peer leaves the workspace with one.
    expect((await post(db, `${BASE}/members/remove`, "dana", { userId: ids.olive })).status).toBe(200);
    expect(roleOf(db, ids.olive)).toBeNull();
    expect(roleOf(db, ids.dana)).toBe("owner");
  });

  test("admin acting on the LAST owner is 403, never 409", async () => {
    const { db, ids } = soleOwnerWorld();
    const remove = await post(db, `${BASE}/members/remove`, "carol", { userId: ids.dana });
    expect(remove.status).toBe(403);
    const demote = await post(db, `${BASE}/members/role`, "carol", { userId: ids.dana, role: "member" });
    expect(demote.status).toBe(403);
    // The role boundary answers first: the owner row is untouched either way.
    expect(roleOf(db, ids.dana)).toBe("owner");
  });
});

describe("promote is the ownership-transfer path (no separate route)", () => {
  test("the sole owner promotes an existing member to owner; the new owner can then demote the old one", async () => {
    const { db, ids } = soleOwnerWorld();
    const promote = await post(db, `${BASE}/members/role`, "dana", { userId: ids.hubot, role: "owner" });
    expect(promote.status).toBe(200);
    expect(roleOf(db, ids.hubot)).toBe("owner");
    // Ownership has moved far enough that the original owner may step down.
    const stepDown = await post(db, `${BASE}/members/role`, "dana", { userId: ids.dana, role: "member" });
    expect(stepDown.status).toBe(200);
    expect(roleOf(db, ids.dana)).toBe("member");
    expect(roleOf(db, ids.hubot)).toBe("owner");
  });

  test("the sole owner promotes an existing admin to owner as well", async () => {
    const { db, ids } = soleOwnerWorld();
    const res = await post(db, `${BASE}/members/role`, "dana", { userId: ids.carol, role: "owner" });
    expect(res.status).toBe(200);
    expect(roleOf(db, ids.carol)).toBe("owner");
  });
});

describe("last_owner: the workspace can never lose its final owner", () => {
  test("the store refuses to remove the sole owner: zero writes, no tombstone", async () => {
    const { db, ids } = soleOwnerWorld();
    expect(await deleteWorkspaceMember(db, WORKSPACE, ids.dana)).toBe(false);
    expect(roleOf(db, ids.dana)).toBe("owner");
    const tombstones = db.raw.prepare("SELECT COUNT(*) AS n FROM removed_logins").get() as { n: number };
    expect(tombstones.n).toBe(0);
  });

  test("the store refuses to demote the sole owner and allows it once a second owner exists", async () => {
    const { db, ids } = soleOwnerWorld();
    expect(await updateWorkspaceMemberRole(db, WORKSPACE, ids.dana, "member")).toBe(false);
    expect(roleOf(db, ids.dana)).toBe("owner");
    // Promote a peer, then the same demotion lands.
    expect(await updateWorkspaceMemberRole(db, WORKSPACE, ids.carol, "owner")).toBe(true);
    expect(await updateWorkspaceMemberRole(db, WORKSPACE, ids.dana, "member")).toBe(true);
    expect(roleOf(db, ids.dana)).toBe("member");
  });

  test("the sole owner removing themselves is the last-owner 409, zero writes", async () => {
    const { db, ids } = soleOwnerWorld();
    const res = await post(db, `${BASE}/members/remove`, "dana", { userId: ids.dana });
    // The last-owner conflict wins over the generic self-removal 400.
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("last owner");
    expect(roleOf(db, ids.dana)).toBe("owner");
    expect(memberCount(db)).toBe(4);
  });

  test("an owner who is not the last one removing themselves is the self-removal 400, zero writes", async () => {
    const { db, ids } = world();
    // `dana` and `olive` are both owners, so the last-owner guard does not fire.
    const res = await post(db, `${BASE}/members/remove`, "dana", { userId: ids.dana });
    expect(res.status).toBe(400);
    expect(roleOf(db, ids.dana)).toBe("owner");
    expect(memberCount(db)).toBe(6);
  });
});

describe("self_demote: an owner may step down only after another owner exists", () => {
  test("the sole owner demoting themselves is 409 with zero writes", async () => {
    const { db, ids } = soleOwnerWorld();
    for (const role of ["admin", "member"] as const) {
      const res = await post(db, `${BASE}/members/role`, "dana", { userId: ids.dana, role });
      expect(res.status, role).toBe(409);
      // The actor-aware refusal, not the store's generic last-owner 409: the
      // store predicate cannot see who is acting, so this body is what pins
      // the handler-level check.
      expect(await res.text()).toContain("only owner");
      expect(roleOf(db, ids.dana)).toBe("owner");
    }
  });

  test("after a second owner exists the same self-demotion is allowed", async () => {
    const { db, ids } = world();
    // `dana` and `olive` are both owners here.
    const res = await post(db, `${BASE}/members/role`, "dana", { userId: ids.dana, role: "admin" });
    expect(res.status).toBe(200);
    expect(roleOf(db, ids.dana)).toBe("admin");
    expect(roleOf(db, ids.olive)).toBe("owner");
  });

  test("a plain member may not promote themselves, and an admin may not either", async () => {
    const { db, ids } = world();
    for (const [login, userId] of [
      ["mallory", ids.mallory],
      ["carol", ids.carol],
    ] as const) {
      const res = await post(db, `${BASE}/members/role`, login, { userId, role: "owner" });
      expect(res.status, login).toBe(403);
      expect(roleOf(db, userId)).toBe(login === "carol" ? "admin" : "member");
    }
  });
});
