/**
 * Platform operators and support grants — the workspace gate's operator classes
 * (platform-operator support, 2026-10).
 *
 * The fixture puts ONE listed operator in the env allowlist, with no membership
 * anywhere, plus a real workspace, its members, and an App. Every case asserts
 * BOTH the HTTP answer and the audit rows the gate wrote, because the two are
 * one decision: the row records the attempt before dispatch, so the count must
 * be exactly one per operator request and zero for everyone else.
 *
 * Pinned here:
 *   - operator without a grant (and with an EXPIRED one) → the outsider 404
 *     plus one `support.denied` row;
 *   - granted operator → 200 on the support view / member list, one
 *     `support.read` row per request;
 *   - granted operator → 403 on every other workspace route (App settings,
 *     credentials verify, role change, invites, audit list), one
 *     `support.forbidden` row;
 *   - a grant on W1 grants nothing on W2;
 *   - an operator who IS a member keeps ordinary membership rights (AC1) and is
 *     not audited as a support read;
 *   - the ceiling matches the METHOD too: HEAD rides the GET handler, a POST at
 *     a read path is refused;
 *   - the shell boot asks the gate's own classifier, so a membership-less
 *     operator lands on the workspace path (never the bare `/dashboard` whose
 *     support read has no tenant) and a listed operator holding a live invite
 *     is an invitee, not a support visitor.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { insertSupportGrant } from "../../src/dashboard/operator-store";
import { createInvite } from "../../src/dashboard/invite-store";
import { withSpaAssets } from "../helpers/spa";
import type { SpaBoot } from "../../src/spa/boot";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/** The operator the allowlist names, in mixed case — the compare is NOCASE. */
const OPERATOR = "Support-Bot";
/** A second listed operator, holding its own grant on the same workspace. */
const OTHER_OPERATOR = "Other-Bot";
const DAY = 24 * 60 * 60 * 1000;

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

/** The `users.id` of a seeded login (fixtures only; bun:sqlite returns unknown). */
function userIdOf(db: TestD1, login: string): string {
  // bun:sqlite's `get()` is typed `unknown`; this fixture owns the query shape.
  const row = db.raw.prepare("SELECT id FROM users WHERE github_login = ?").get(login) as
    | { id: string }
    | null;
  if (row === null) throw new Error(`no users row for ${login}`);
  return row.id;
}

/** The workspace role of a seeded member (fixtures only). */
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
    `INSERT INTO github_apps
       (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
             'dana', 'active', ?, ?)`,
    id,
    slug,
    4000 + Math.floor(Math.random() * 1000),
    slug,
    now,
    now,
  );
  seed(db, "INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)", id, workspaceId);
}

/**
 * Two workspaces, one member owner each, one App in W1, and the operator as a
 * signed-in login with NO membership anywhere.
 */
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
  return { db, owner };
}

/** Grant `login` on `workspaceId` from now for `ttlMs` (negative = expired). */
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

/**
 * Every audit row in WRITE order. `created_at` ties for requests inside one
 * test (same-millisecond ISO), and the row `id` is a random UUID — so `rowid`
 * (insertion order) is the only deterministic tiebreak.
 */
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
      "/dashboard/acme/api/apps/acme-app/settings",
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

    // The two operator-reachable faces carry the same grant projection.
    for (const path of ["/dashboard/acme/api/support/workspace", "/dashboard/acme/api/support/grants"]) {
      const res = await worker.fetch(await authedRequest(path, OPERATOR), env);
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as {
        grants: Array<{ operator_login: string; reason: string }>;
      };
      // AC2: the operator's window is the grant that opened it — one row, theirs.
      expect(body.grants, path).toHaveLength(1);
      expect(body.grants[0]?.operator_login, path).toBe(OPERATOR);
      expect(body.grants[0]?.reason, path).toBe("tenant-reported incident");
    }

    // AC4: the member notice is the whole live set — both operators' rows.
    const notice = await worker.fetch(await authedRequest("/dashboard/acme/api/support/grants", "dana"), env);
    expect(notice.status).toBe(200);
    const noticeBody = (await notice.json()) as { grants: Array<{ operator_login: string }> };
    expect(noticeBody.grants.map((row) => row.operator_login).sort()).toEqual(
      [OPERATOR, OTHER_OPERATOR].sort(),
    );
    // The member read is not audited; the two operator reads are.
    expect(auditRows(db).map((row) => row.action)).toEqual(["support.read", "support.read"]);
  });

  test("App settings, credentials and the App list are 403 with one support.forbidden row each", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const env = envFor(db);
    const cases: Array<{ path: string; method?: string; body?: string }> = [
      { path: "/dashboard/acme/api/apps" },
      { path: "/dashboard/acme/api/apps/acme-app/settings" },
      { path: "/dashboard/acme/api/apps/acme-app/models" },
      { path: "/dashboard/acme/api/apps/acme-app/insights/summary" },
      { path: "/dashboard/acme/api/apps/acme-app/keys/verify", method: "POST", body: "provider=openai" },
    ];
    for (const item of cases) {
      const res = await worker.fetch(
        await authedRequest(item.path, OPERATOR, { method: item.method, body: item.body }),
        env,
      );
      expect(res.status, item.path).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("forbidden");
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
    // The owner is untouched by every refused write.
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
    // Both rows land in the same millisecond, so compare as a set.
    const rows = auditRows(db);
    expect(rows.map((row) => row.action).sort()).toEqual(["support.denied", "support.read"]);
    expect(rows.find((row) => row.action === "support.denied")?.workspace_id).toBe("ws-other");
  });

});

describe("an operator who is also a member", () => {
  test("keeps ordinary membership rights and writes no support audit row", async () => {
    const { db } = fixture();
    // `dana` owns W1 and is listed as an operator too.
    grant(db, "ws-acme", "dana", DAY);
    const env = envFor(db, `${OPERATOR},dana`);
    // A write route the ceiling would refuse an operator: as a member it serves.
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
    // AC4a: the whole notice payload — who, why, until when.
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
      // No mutating handler is mounted at all (405), so there is no dismiss
      // verb for the tenant to reach whatever the status.
      expect(res.status >= 400, method).toBe(true);
    }
    const still = await worker.fetch(await authedRequest("/dashboard/acme/api/support/grants", "dana"), env);
    const stillBody = (await still.json()) as { grants: Array<{ operator_login: string }> };
    expect(stillBody.grants.map((row) => row.operator_login)).toEqual([OPERATOR]);
    // Tenant refusals are the tenant's own gate — no support audit row.
    expect(auditRows(db).map((row) => row.action)).toEqual([]);
  });

  test("a grant on W1 puts no notice on W2", async () => {
    const { db } = fixture();
    grant(db, "ws-acme", OPERATOR, DAY);
    const env = envFor(db);
    // `erin` owns W2 and holds no grant there.
    const res = await worker.fetch(await authedRequest("/dashboard/other/api/support/grants", "erin"), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { grants: unknown[] }).grants).toEqual([]);
    // The live grant on W1 is unaffected by the empty read on W2.
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
    // Hono dispatches HEAD through the GET route, so the ceiling must admit it
    // for the handler that actually runs.
    const head = await worker.fetch(
      await authedRequest("/dashboard/acme/api/support/workspace", OPERATOR, { method: "HEAD" }),
      env,
    );
    expect(head.status).toBe(200);
    // The same path with a write method: no POST handler is mounted there, and
    // the ceiling refuses before the router can answer 404/405.
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
  /** The boot the served shell injected. */
  function bootOf(html: string): SpaBoot {
    const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
    if (json === undefined) throw new Error("no injected SPA boot");
    return JSON.parse(json) as SpaBoot;
  }

  /**
   * A strict deployment with ONE live workspace (`default`, seeded by 0026) —
   * the shape the landing redirect resolves. Migration 0026 seeds it, so this
   * fixture only adds the operator login.
   */
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
    // The support view derives its API base from the pathname's workspace
    // segment; on the bare mount that read has no tenant and 404s.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/apps");
    // A shell navigation is not a workspace route: no audit row.
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
    // The gate classifies `invitee` (the grant is intentionally inert), so the
    // shell must not replace the acceptance surface with the support face.
    expect(boot.supportOnly).toBeUndefined();
    expect(boot.pendingInvites?.map((invite) => invite.workspaceRef)).toEqual(["acme"]);
  });
});

describe("the shell boot reads the workspace facts once", () => {
  /** Every statement the request prepares, in order. */
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

  /** The boot's own access join: the workspace row + role + login's users row. */
  const ACCESS_JOIN = /FROM workspaces w\s+LEFT JOIN users u/;
  /** A plain `workspaces` re-read by ref or as the sole workspace. */
  const WORKSPACE_REREAD = /SELECT id, slug, name, created_at FROM workspaces/;
  /** The classifier's member test, which the access join has already answered. */
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
    // Reinstating a second sole-vs-ref resolution (a second `workspaceBoot`, or
    // `operatorSupportWorkspace` re-reading the workspace + role itself) raises
    // both counts and fails here.
    expect(count(statements, ACCESS_JOIN)).toBe(1);
    expect(count(statements, WORKSPACE_REREAD)).toBe(0);
    expect(count(statements, MEMBERSHIP_REREAD)).toBe(0);
    // The behaviour the reads exist for is unchanged.
    const boot = bootOf(await res.text());
    expect(boot.supportOnly).toBe(true);
    expect(boot.workspaceRef).toBe("acme");
  });

  /** The boot the served shell injected. */
  function bootOf(html: string): SpaBoot {
    const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
    if (json === undefined) throw new Error("no injected SPA boot");
    return JSON.parse(json) as SpaBoot;
  }

  test("a granted operator's bare /dashboard reuses the boot it already paid for", async () => {
    // The sole-workspace shape: `/dashboard` names no ref, so the landing can
    // only resolve through the deployment's single workspace.
    const db = createMigratedTestD1();
    seedUser(db, OPERATOR);
    grant(db, "default", OPERATOR, DAY);
    const { observed, statements } = recordingDb(db);
    const res = await worker.fetch(
      await authedRequest("/dashboard", OPERATOR, { accept: "text/html" }),
      withSpaAssets(envFor(observed)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/apps");
    // The landing resolves from the boot extras — the same request must not
    // re-run the sole-vs-ref resolution.
    expect(count(statements, ACCESS_JOIN)).toBe(1);
    expect(count(statements, WORKSPACE_REREAD)).toBe(0);
  });

  test("a plain workspace member's bare /dashboard lands through the shared landing policy", async () => {
    // A member, not an operator and holding no grant: the request reaches
    // `signedInLanding` itself (the support redirect above absorbs the operator
    // path), so this is the case that keeps the policy wired to the boot it
    // already paid for.
    const db = createMigratedTestD1();
    const member = seedUser(db, "dana");
    seedMembership(db, "default", member, "member");
    const { observed, statements } = recordingDb(db);
    const res = await worker.fetch(
      await authedRequest("/dashboard", "dana", { accept: "text/html" }),
      withSpaAssets(envFor(observed)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/apps");
    // Reinstating a second `workspaceBoot` (the landing re-reading what the
    // dispatch already resolved) raises this count and fails here.
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
    // No grant: no support face. The grant probe is the classifier's own read,
    // and the workspace facts still come from the single access join.
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
    // The scope middleware resolved this row; the route must not query it again.
    expect(count(statements, WORKSPACE_REREAD)).toBe(1);
  });
});
