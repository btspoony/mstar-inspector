import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedTarget, type TestD1 } from "../store/helpers";
import { insertSupportGrant } from "../../src/dashboard/operator-store";
import { createInvite } from "../../src/dashboard/invite-store";
import { withSpaAssets } from "../helpers/spa";
import type { SpaBoot } from "../../src/spa/boot";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const OPERATOR = "Support-Bot";
const OTHER_OPERATOR = "Other-Bot";
const DAY = 24 * 60 * 60 * 1000;
const APP_ID = 4000;
const TARGET_ID = "target-operator";

function envFor(db: TestD1, operators = OPERATOR): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB: db,
    PLATFORM_OPERATORS: operators,
  } as unknown as Env;
}

async function authedRequest(
  path: string,
  login: string,
  init: { method?: string; body?: string; accept?: string } = {},
): Promise<Request> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${session}` };
  if (init.accept !== undefined) headers["Accept"] = init.accept;
  if (init.body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
  return new Request(`https://worker.local${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

function seed(db: TestD1, sql: string, ...params: Array<string | number | null>): void {
  db.raw.prepare(sql).run(...params);
}

function userIdOf(db: TestD1, login: string): string {
  const row = db.raw.prepare("SELECT id FROM users WHERE github_login = ?").get(login) as
    | { id: string }
    | null;
  if (row === null) throw new Error(`no users row for ${login}`);
  return row.id;
}

function roleOf(db: TestD1, userId: string): string {
  const row = db.raw
    .prepare("SELECT role FROM workspace_members WHERE user_id = ?")
    .get(userId) as { role: string } | null;
  if (row === null) throw new Error(`no membership for ${userId}`);
  return row.role;
}

function seedUser(db: TestD1, login: string): string {
  const id = crypto.randomUUID();
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    id,
    login,
    new Date().toISOString(),
  );
  return id;
}

function seedWorkspace(db: TestD1, id: string, slug: string): void {
  seed(
    db,
    "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    id,
    slug,
    slug,
    new Date().toISOString(),
  );
}

function seedMembership(db: TestD1, workspaceId: string, userId: string, role: string): void {
  seed(
    db,
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    workspaceId,
    userId,
    role,
    new Date().toISOString(),
  );
}

function seedApp(db: TestD1, id: string, slug: string, workspaceId: string): void {
  const now = new Date().toISOString();
  seed(
    db,
    `INSERT INTO review_bots
       (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
             'dana', 'active', ?, ?)`,
    id,
    slug,
    APP_ID,
    slug,
    now,
    now,
  );
  seed(db, "INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)", id, workspaceId);
}

function fixture() {
  const db = createMigratedTestD1();
  seedUser(db, OPERATOR);
  const owner = seedUser(db, "dana");
  const other = seedUser(db, "erin");
  seedWorkspace(db, "ws-acme", "acme");
  seedWorkspace(db, "ws-other", "other");
  seedMembership(db, "ws-acme", owner, "owner");
  seedMembership(db, "ws-other", other, "owner");
  seedApp(db, "app-acme", "acme-app", "ws-acme");
  seedTarget(db, "app-acme", { id: TARGET_ID, workspaceId: "ws-acme" });
  return { db, owner };
}

function grant(db: TestD1, workspaceId: string, login: string, ttlMs: number): void {
  const now = Date.now();
  return void insertSupportGrant(db, {
    workspaceId,
    operatorLogin: login,
    reason: "tenant-reported incident",
    grantedBy: "deployer",
    now: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  });
}

type AuditRow = { action: string; actor_login: string; workspace_id: string };

function auditRows(db: TestD1): AuditRow[] {
  return db.raw
    .prepare("SELECT action, actor_login, workspace_id FROM audit_events ORDER BY created_at ASC, rowid ASC")
    .all() as AuditRow[];
}

describe("operator without a valid grant", () => {
  test("every workspace path is the outsider 404 with exactly one support.denied row", async () => {
    const { db } = fixture();
    const env = envFor(db);
    for (const path of [
      "/dashboard/acme/api/support/workspace",
      "/dashboard/acme/api/members",
      "/dashboard/acme/api/apps",
      `/dashboard/acme/api/apps/${APP_ID}/settings`,
    ]) {
      const res = await worker.fetch(await authedRequest(path, OPERATOR), env);
      expect(res.status, path).toBe(404);
    }
    const rows = auditRows(db);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.action === "support.denied")).toBe(true);
    expect(rows.every((row) => row.actor_login === OPERATOR && row.workspace_id === "ws-acme")).toBe(true);
  });

  test("an EXPIRED grant answers exactly like no grant (404 + support.denied)", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, -DAY);
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/api/support/workspace", OPERATOR),
      envFor(db),
    );
    expect(res.status).toBe(404);
    expect(auditRows(db).map((row) => row.action)).toEqual(["support.denied"]);
  });

  test("a login NOT in PLATFORM_OPERATORS is an ordinary outsider: 404 and no audit row", async () => {
    const { db } = fixture();
    seedUser(db, "stranger");
    grant(db, "ws-acme", "stranger", DAY);
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/api/support/workspace", "stranger"),
      envFor(db),
    );
    expect(res.status).toBe(404);
    expect(auditRows(db)).toEqual([]);
  });
});

describe("operator with a valid grant", () => {
  test("the support view returns the AC2 fields and writes one support.read row", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/api/support/workspace", OPERATOR),
      envFor(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspace: Record<string, unknown>;
      members: Array<Record<string, unknown>>;
      grants: Array<Record<string, unknown>>;
    };
    expect(Object.keys(body.workspace).sort()).toEqual(["created_at", "id", "name", "slug"]);
    expect(body.members).toEqual([{ github_login: "dana", role: "owner" }]);
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]?.operator_login).toBe(OPERATOR);
    expect(body.grants[0]?.reason).toBe("tenant-reported incident");
    expect(auditRows(db).map((row) => row.action)).toEqual(["support.read"]);
  });

  test("the member list is readable but carries only login + role", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const res = await worker.fetch(await authedRequest("/dashboard/acme/api/members", OPERATOR), envFor(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<Record<string, unknown>> };
    expect(body.members).toEqual([{ github_login: "dana", role: "owner" }]);
    expect(auditRows(db).map((row) => row.action)).toEqual(["support.read"]);
  });

  test("the static catalog follows member-list read access for granted operators and outsiders", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const env = envFor(db);
    const catalog = await worker.fetch(await authedRequest("/dashboard/acme/api/provider-catalog", OPERATOR), env);
    expect(catalog.status).toBe(200);
    expect((await catalog.json() as { provider_catalog: unknown[] }).provider_catalog.length).toBeGreaterThan(0);
    expect(auditRows(db).map((row) => row.action)).toEqual(["support.read"]);
    seedUser(db, "stranger");
    const catalogRefusal = await worker.fetch(await authedRequest("/dashboard/acme/api/provider-catalog", "stranger"), env);
    const memberRefusal = await worker.fetch(await authedRequest("/dashboard/acme/api/members", "stranger"), env);
    expect(catalogRefusal.status).toBe(404);
    expect(catalogRefusal.status).toBe(memberRefusal.status);
    expect(await catalogRefusal.text()).toBe(await memberRefusal.text());
  });

  test("the grants notice is readable and audited", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/api/support/grants", OPERATOR),
      envFor(db),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { grants: unknown[] }).grants).toHaveLength(1);
    expect(auditRows(db).map((row) => row.action)).toEqual(["support.read"]);
  });

  test("an operator sees ONLY their own grant on both faces; the member notice keeps all", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    grant(db, "ws-acme", OTHER_OPERATOR, DAY);
    const env = envFor(db, `${OPERATOR},${OTHER_OPERATOR}`);

    for (const path of ["/dashboard/acme/api/support/workspace", "/dashboard/acme/api/support/grants"]) {
      const res = await worker.fetch(await authedRequest(path, OPERATOR), env);
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as {
        grants: Array<{ operator_login: string; reason: string }>;
      };
      expect(body.grants, path).toHaveLength(1);
      expect(body.grants[0]?.operator_login, path).toBe(OPERATOR);
      expect(body.grants[0]?.reason, path).toBe("tenant-reported incident");
    }

    const notice = await worker.fetch(await authedRequest("/dashboard/acme/api/support/grants", "dana"), env);
    expect(notice.status).toBe(200);
    const noticeBody = (await notice.json()) as { grants: Array<{ operator_login: string }> };
    expect(noticeBody.grants.map((row) => row.operator_login).sort()).toEqual(
      [OPERATOR, OTHER_OPERATOR].sort(),
    );
    expect(auditRows(db).map((row) => row.action)).toEqual(["support.read", "support.read"]);
  });

  test("App settings, credentials and the App list are 403 with one support.forbidden row each", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const env = envFor(db);
    const cases: Array<{ path: string; method?: string; body?: string }> = [
      { path: "/dashboard/acme/api/apps" },
      { path: `/dashboard/acme/api/apps/${APP_ID}/settings` },
      { path: `/dashboard/acme/api/apps/${APP_ID}/models` },
      { path: `/dashboard/acme/api/targets/${TARGET_ID}/insights/summary` },
      { path: `/dashboard/acme/api/targets/${TARGET_ID}/pull-requests` },
      { path: `/dashboard/acme/api/targets/${TARGET_ID}/pull-requests/acme/widgets/131` },
      { path: `/dashboard/acme/api/apps/${APP_ID}/keys/verify`, method: "POST", body: "provider=openai" },
    ];
    for (const item of cases) {
      const res = await worker.fetch(
        await authedRequest(item.path, OPERATOR, { method: item.method, body: item.body }),
        env,
      );
      expect(res.status, item.path).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("forbidden");
      if (item.path.includes("/api/")) {
        expect(res.headers.get("Cache-Control"), item.path).toBe("private, no-store");
      }
    }
    const rows = auditRows(db);
    expect(rows).toHaveLength(cases.length);
    expect(rows.every((row) => row.action === "support.forbidden")).toBe(true);
  });

  test("role change, member removal, invites and the audit list are 403", async () => {
    const { db, owner } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const env = envFor(db);
    const ownerId = userIdOf(db, "dana");
    const cases: Array<{ path: string; method: string; body: string }> = [
      { path: "/dashboard/acme/members/role", method: "POST", body: `userId=${ownerId}&role=member` },
      { path: "/dashboard/acme/members/remove", method: "POST", body: `userId=${ownerId}` },
      { path: "/dashboard/acme/api/members/invites", method: "POST", body: "login=hubot&role=member" },
    ];
    for (const item of cases) {
      const res = await worker.fetch(await authedRequest(item.path, OPERATOR, item), env);
      expect(res.status, item.path).toBe(403);
    }
    const audit = await worker.fetch(await authedRequest("/dashboard/acme/api/audit", OPERATOR), env);
    expect(audit.status).toBe(403);
    expect(roleOf(db, owner)).toBe("owner");
    expect(auditRows(db)).toHaveLength(4);
    expect(auditRows(db).every((row) => row.action === "support.forbidden")).toBe(true);
  });

  test("a grant on W1 grants nothing on W2: 404 there, 200 on W1", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const env = envFor(db);
    expect(
      (await worker.fetch(await authedRequest("/dashboard/acme/api/support/workspace", OPERATOR), env)).status,
    ).toBe(200);
    const other = await worker.fetch(
      await authedRequest("/dashboard/other/api/support/workspace", OPERATOR),
      env,
    );
    expect(other.status).toBe(404);
    const rows = auditRows(db);
    expect(rows.map((row) => row.action).sort()).toEqual(["support.denied", "support.read"]);
    expect(rows.find((row) => row.action === "support.denied")?.workspace_id).toBe("ws-other");
  });

});

describe("an operator who is also a member", () => {
  test("keeps ordinary membership rights and writes no support audit row", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", "dana", DAY);
    const env = envFor(db, `${OPERATOR},dana`);
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/api/members", "dana"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewer: { role: string } };
    expect(body.viewer.role).toBe("owner");
    expect(auditRows(db)).toEqual([]);
  });
});

describe("tenant-visible grant notice and member audit reads", () => {
  test("a member reads the grants notice and sees no audit rows of their own", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const res = await worker.fetch(await authedRequest("/dashboard/acme/api/support/grants", "dana"), envFor(db));
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null || !("grants" in body) || !Array.isArray(body.grants))
      throw new Error("no grants array");
    const row = body.grants[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("no grant row");
    expect(Object.keys(row).sort()).toEqual(["expires_at", "operator_login", "reason"]);
    expect(row.operator_login).toBe(OPERATOR);
    expect(row.reason).toBe("tenant-reported incident");
    const expiresAt = row.expires_at;
    expect(typeof expiresAt).toBe("string");
    if (typeof expiresAt !== "string") throw new Error("no expires_at");
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(auditRows(db)).toEqual([]);
  });

  test("owner reads the audit list; a plain member is 403", async () => {
    const { db, owner } = fixture();
    seedUser(db, "mallory");
    seedMembership(db, "ws-acme", userIdOf(db, "mallory"), "member");
    seedUser(db, "peggy");
    seedMembership(db, "ws-acme", userIdOf(db, "peggy"), "admin");
    grant(db, "ws-acme", OPERATOR, DAY);
    const env = envFor(db);
    await worker.fetch(await authedRequest("/dashboard/acme/api/support/workspace", OPERATOR), env);

    const asAdmin = await worker.fetch(await authedRequest("/dashboard/acme/api/audit", "peggy"), env);
    expect(asAdmin.status).toBe(200);
    const adminEvents = ((await asAdmin.json()) as { events: Array<{ actor_login: string }> }).events;
    expect(adminEvents.map((event) => event.actor_login)).toEqual([OPERATOR]);

    const asOwner = await worker.fetch(await authedRequest("/dashboard/acme/api/audit", "dana"), env);
    expect(asOwner.status).toBe(200);
    const events = ((await asOwner.json()) as { events: Array<{ actor_login: string; action: string; created_at: string }> })
      .events;
    expect(events).toHaveLength(1);
    expect(events[0]?.actor_login).toBe(OPERATOR);
    expect(events[0]?.action).toBe("support.read");
    expect(owner).toBeTruthy();

    const asMember = await worker.fetch(await authedRequest("/dashboard/acme/api/audit", "mallory"), env);
    expect(asMember.status).toBe(403);
  });

  test("the notice is undismissable server-side: no mutating route, grant survives", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const env = envFor(db);
    for (const method of ["POST", "DELETE", "PATCH"]) {
      const res = await worker.fetch(
        await authedRequest("/dashboard/acme/api/support/grants", "dana", { method, body: "x=1" }),
        env,
      );
      expect(res.status >= 400, method).toBe(true);
    }
    const still = await worker.fetch(await authedRequest("/dashboard/acme/api/support/grants", "dana"), env);
    const stillBody = (await still.json()) as { grants: Array<{ operator_login: string }> };
    expect(stillBody.grants.map((row) => row.operator_login)).toEqual([OPERATOR]);
    expect(auditRows(db).map((row) => row.action)).toEqual([]);
  });

  test("a grant on W1 puts no notice on W2", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const env = envFor(db);
    const res = await worker.fetch(await authedRequest("/dashboard/other/api/support/grants", "erin"), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { grants: unknown[] }).grants).toEqual([]);
    const onW1 = await worker.fetch(await authedRequest("/dashboard/acme/api/support/grants", "dana"), env);
    expect(((await onW1.json()) as { grants: Array<{ operator_login: string }> }).grants).toHaveLength(1);
    expect(auditRows(db)).toEqual([]);
  });
});

describe("the read ceiling is method-aware", () => {
  test("HEAD rides the GET handler and reads; a POST at a read path is forbidden", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const env = envFor(db);
    const head = await worker.fetch(
      await authedRequest("/dashboard/acme/api/support/workspace", OPERATOR, { method: "HEAD" }),
      env,
    );
    expect(head.status).toBe(200);
    const post = await worker.fetch(
      await authedRequest("/dashboard/acme/api/support/workspace", OPERATOR, {
        method: "POST",
        body: "x=1",
      }),
      env,
    );
    expect(post.status).toBe(403);
    expect(auditRows(db).map((row) => row.action).sort()).toEqual(["support.forbidden", "support.read"]);
  });
});

describe("the shell boot asks the gate's own classifier", () => {
  function bootOf(html: string): SpaBoot {
    const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
    if (json === undefined) throw new Error("no injected SPA boot");
    return JSON.parse(json) as SpaBoot;
  }

  function soleWorkspaceFixture() {
    const db = createMigratedTestD1();
    seedUser(db, OPERATOR);
    return { db };
  }

  test("a membership-less granted operator's bare /dashboard redirects to the workspace path", async () => {
    const { db } = soleWorkspaceFixture();
    grant(db, "default", OPERATOR, DAY);
    const res = await worker.fetch(
      await authedRequest("/dashboard", OPERATOR, { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/repos");
    expect(auditRows(db)).toEqual([]);
  });

  test("the redirected page boots supportOnly with the workspace ref named", async () => {
    const { db } = soleWorkspaceFixture();
    grant(db, "default", OPERATOR, DAY);
    const res = await worker.fetch(
      await authedRequest("/dashboard/default/apps", OPERATOR, { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.supportOnly).toBe(true);
    expect(boot.needsWorkspace).toBeUndefined();
    expect(boot.workspaceRef).toBe("default");
  });

  test("a granted operator's support landing names the workspace ID, not its slug", async () => {
    const db = createMigratedTestD1();
    seedUser(db, OPERATOR);
    seed(db, "DELETE FROM workspaces");
    seedWorkspace(db, "ws-acme", "acme");
    grant(db, "ws-acme", OPERATOR, DAY);
    const env = withSpaAssets(envFor(db));
    const landing = await worker.fetch(
      await authedRequest("/dashboard", OPERATOR, { accept: "text/html" }),
      env,
    );
    expect(landing.status).toBe(302);
    expect(landing.headers.get("Location")).toBe("/dashboard/ws-acme/repos");
    const shell = await worker.fetch(
      await authedRequest("/dashboard/ws-acme/apps", OPERATOR, { accept: "text/html" }),
      env,
    );
    expect(shell.status).toBe(200);
    expect(bootOf(await shell.text()).workspaceRef).toBe("ws-acme");
  });

  test("a listed operator holding a live invite here is an invitee, not a support visitor", async () => {
    const { db, owner } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    await createInvite(db, {
      workspaceId: "ws-acme",
      login: OPERATOR,
      role: "member",
      invitedBy: owner,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + DAY).toISOString(),
    }, "saas");
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps", OPERATOR, { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    const boot = bootOf(await res.text());
    expect(boot.supportOnly).toBeUndefined();
    expect(boot.pendingInvites?.map((invite) => invite.workspaceRef)).toEqual(["ws-acme"]);
  });
});

describe("the shell boot reads the workspace facts once", () => {
  function recordingDb(db: TestD1): { observed: TestD1; statements: string[] } {
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

  const ACCESS_JOIN = /FROM workspaces w\s+LEFT JOIN users u/;
  const WORKSPACE_REREAD = /SELECT id, slug, name, created_at FROM workspaces/;
  const MEMBERSHIP_REREAD = /FROM workspace_members WHERE workspace_id = \? AND user_id = \?/;

  function count(statements: string[], shape: RegExp): number {
    return statements.filter((sql) => shape.test(sql)).length;
  }

  test("a granted operator's shell reads the access join once and the workspace row never again", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const { observed, statements } = recordingDb(db);
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps", OPERATOR, { accept: "text/html" }),
      withSpaAssets(envFor(observed)),
    );
    expect(res.status).toBe(200);
    expect(count(statements, ACCESS_JOIN)).toBe(1);
    expect(count(statements, WORKSPACE_REREAD)).toBe(0);
    expect(count(statements, MEMBERSHIP_REREAD)).toBe(0);
    const boot = bootOf(await res.text());
    expect(boot.supportOnly).toBe(true);
    expect(boot.workspaceRef).toBe("acme");
  });

  function bootOf(html: string): SpaBoot {
    const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
    if (json === undefined) throw new Error("no injected SPA boot");
    return JSON.parse(json) as SpaBoot;
  }

  test("a granted operator's bare /dashboard reuses the boot it already paid for", async () => {
    const db = createMigratedTestD1();
    seedUser(db, OPERATOR);
    grant(db, "default", OPERATOR, DAY);
    const { observed, statements } = recordingDb(db);
    const res = await worker.fetch(
      await authedRequest("/dashboard", OPERATOR, { accept: "text/html" }),
      withSpaAssets(envFor(observed)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/repos");
    expect(count(statements, ACCESS_JOIN)).toBe(1);
    expect(count(statements, WORKSPACE_REREAD)).toBe(0);
  });

  test("a plain workspace member's bare /dashboard lands through the shared landing policy", async () => {
    const db = createMigratedTestD1();
    const member = seedUser(db, "dana");
    seedMembership(db, "default", member, "member");
    const { observed, statements } = recordingDb(db);
    const res = await worker.fetch(
      await authedRequest("/dashboard", "dana", { accept: "text/html" }),
      withSpaAssets(envFor(observed)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/repos");
    expect(count(statements, ACCESS_JOIN)).toBe(1);
    expect(count(statements, WORKSPACE_REREAD)).toBe(0);
  });

  test("a non-grant non-member operator keeps the shell and its creation surface", async () => {
    const { db } = fixture();
    const { observed, statements } = recordingDb(db);
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps", OPERATOR, { accept: "text/html" }),
      withSpaAssets(envFor(observed)),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.supportOnly).toBeUndefined();
    expect(count(statements, ACCESS_JOIN)).toBe(1);
    expect(count(statements, MEMBERSHIP_REREAD)).toBe(0);
  });

  test("the support view serves the scope's own workspace row", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const { observed, statements } = recordingDb(db);
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/api/support/workspace", OPERATOR),
      withSpaAssets(envFor(observed)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: { id: string; slug: string; name: string; created_at: string } };
    expect(body.workspace.id).toBe("ws-acme");
    expect(count(statements, WORKSPACE_REREAD)).toBe(0);
  });
});
