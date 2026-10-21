/**
 * Workspace (tenant) routing + authorization — Deploy B of
 * `WORKSPACE_TENANT_MODE` (migration 0026 data plane).
 *
 * The mode switch governs the request path in `src/dashboard/index.ts`: under
 * `off` the workspace-shaped paths do not exist (404) and the legacy App face
 * behaves exactly as before; under `strict` the legacy App face is 404 and the
 * workspace paths serve, with authorization decided by the actor's workspace
 * role instead of `canManageApp`'s creator-or-deployment-admin rule.
 *
 * The fixture runs against the full migration set (the store helper walks
 * `migrations/`), so 0026/0027 are real: `default` is seeded by 0026 and the
 * backfill is a no-op because the rows are inserted afterwards. Every
 * workspace here is explicit, which keeps the role matrix readable.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/** The routing gate's reserved-word set, restated as the test contract. */
const RESERVED_WORKSPACE_SLUGS = [
  "apps",
  "api",
  "oauth",
  "members",
  "login",
  "logout",
  "manifest",
  "locale",
  "healthz",
] as const;

function envFor(db: TestD1, mode?: "off" | "strict"): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB: db,
    ...(mode === undefined ? {} : { WORKSPACE_TENANT_MODE: mode }),
  } as unknown as Env;
}

async function authedRequest(
  path: string,
  login: string,
  init: { method?: string; body?: string } = {},
): Promise<Request> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${session}` };
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

function seedUser(db: TestD1, login: string, role: "admin" | "member"): string {
  const id = crypto.randomUUID();
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, ?, ?, NULL)",
    id,
    login,
    role,
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

function seedMembership(
  db: TestD1,
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): void {
  seed(
    db,
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    workspaceId,
    userId,
    role,
    new Date().toISOString(),
  );
}

let nextGithubAppId = 1000;

function seedApp(db: TestD1, id: string, slug: string, workspaceId: string): void {
  const now = new Date().toISOString();
  seed(
    db,
    `INSERT INTO github_apps
       (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
             'octocat', 'active', ?, ?)`,
    id,
    slug,
    nextGithubAppId++,
    slug,
    now,
    now,
  );
  seed(db, "INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)", id, workspaceId);
}

/**
 * Two real workspaces with a role matrix that separates the two authorization
 * worlds: `octocat` is a DEPLOYMENT admin but only a workspace MEMBER, so the
 * legacy rule and the workspace rule disagree for every route they share.
 */
function tenancyFixture() {
  const db = createMigratedTestD1();
  const users = {
    legacyAdmin: seedUser(db, "octocat", "admin"),
    wsAdmin: seedUser(db, "carol", "member"),
    wsOwner: seedUser(db, "dana", "member"),
    wsMember: seedUser(db, "mallory", "member"),
    outsider: seedUser(db, "bob", "member"),
  };
  seedWorkspace(db, "ws-acme", "acme");
  seedWorkspace(db, "ws-other", "other");
  seedMembership(db, "ws-acme", users.legacyAdmin, "member");
  seedMembership(db, "ws-acme", users.wsAdmin, "admin");
  seedMembership(db, "ws-acme", users.wsOwner, "owner");
  seedMembership(db, "ws-acme", users.wsMember, "member");
  seedMembership(db, "ws-other", users.outsider, "owner");
  seedApp(db, "app-acme", "acme-app", "ws-acme");
  seedApp(db, "app-other", "other-app", "ws-other");
  return { db, users };
}

/**
 * A workspace per reserved word, each with a real App and a member. The DB has
 * no CHECK on `workspaces.slug`, so the routing guard is the ONLY thing keeping
 * `:workspaceSlug` off these names — a capture regression would serve the App.
 */
function reservedFixture() {
  const db = createMigratedTestD1();
  const userId = seedUser(db, "octocat", "member");
  for (const word of RESERVED_WORKSPACE_SLUGS) {
    seedWorkspace(db, `ws-${word}`, word);
    seedMembership(db, `ws-${word}`, userId, "owner");
    seedApp(db, `app-${word}`, `reserved-${word}-app`, `ws-${word}`);
  }
  return { db };
}

describe("WORKSPACE_TENANT_MODE=off — workspace paths stay invisible", () => {
  test("workspace-shaped App paths answer 404", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "off");
    for (const path of [
      "/dashboard/acme/apps/acme-app/onboarding",
      "/dashboard/acme/api/apps",
      "/dashboard/acme/apps/acme-app/settings",
      "/dashboard/acme/api/apps/acme-app/models",
    ]) {
      const res = await worker.fetch(await authedRequest(path, "octocat"), env);
      expect(res.status, path).toBe(404);
    }
  });

  test("the legacy App face keeps today's behavior and authorization", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "off");
    // Deployment admin (workspace member) manages the App: the legacy rule.
    const onboarding = await worker.fetch(
      await authedRequest("/dashboard/apps/acme-app/onboarding", "octocat"),
      env,
    );
    expect(onboarding.status).toBe(200);
    // The legacy list still serves every App, unfiltered by workspace.
    const list = await worker.fetch(await authedRequest("/dashboard/api/apps", "mallory"), env);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { apps: Array<{ slug: string }> };
    expect(body.apps.map((app) => app.slug).sort()).toEqual(["acme-app", "other-app"]);
  });
});

describe("WORKSPACE_TENANT_MODE=strict — legacy App paths are retired", () => {
  test("the pre-workspace App face answers 404", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    for (const path of [
      "/dashboard/apps/acme-app/onboarding",
      "/dashboard/apps/acme-app/settings",
      "/dashboard/api/apps",
      "/dashboard/api/apps/acme-app/settings",
    ]) {
      const res = await worker.fetch(await authedRequest(path, "octocat"), env);
      expect(res.status, path).toBe(404);
    }
  });

  test("no session on a workspace path still redirects into the OAuth flow", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/acme/api/apps"),
      envFor(db, "strict"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });
});

describe("WORKSPACE_TENANT_MODE=strict — workspace paths serve", () => {
  test("the workspace list serves its members and lists only its own Apps", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    const res = await worker.fetch(await authedRequest("/dashboard/acme/api/apps", "mallory"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewer: { login: string }; apps: Array<{ slug: string }> };
    expect(body.viewer.login).toBe("mallory");
    expect(body.apps.map((app) => app.slug)).toEqual(["acme-app"]);
  });

  test("the workspace onboarding page serves managers and 403s a plain member", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    const path = "/dashboard/acme/apps/acme-app/onboarding";

    const owner = await worker.fetch(await authedRequest(path, "dana"), env);
    expect(owner.status).toBe(200);
    expect(await owner.text()).toContain("acme-app");

    const admin = await worker.fetch(await authedRequest(path, "carol"), env);
    expect(admin.status).toBe(200);

    const member = await worker.fetch(await authedRequest(path, "mallory"), env);
    expect(member.status).toBe(403);
  });

  test("an App from another workspace answers 404 even for this workspace's owner", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/other-app/onboarding", "dana"),
      env,
    );
    expect(res.status).toBe(404);
  });

  test("a signed-in non-member sees 404, not the workspace", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    // bob owns `other`; he has no membership in `acme`.
    const res = await worker.fetch(await authedRequest("/dashboard/acme/api/apps", "bob"), env);
    expect(res.status).toBe(404);
  });

  test("an unknown workspace slug answers 404", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/ghost/api/apps", "octocat"),
      envFor(db, "strict"),
    );
    expect(res.status).toBe(404);
  });

  test("non-App routes keep serving under strict", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    const members = await worker.fetch(await authedRequest("/dashboard/api/members", "octocat"), env);
    expect(members.status).toBe(200);
  });
});

describe("WORKSPACE_TENANT_MODE=strict — manage is the workspace role", () => {
  const SETTINGS_BODY = "op=save-sandbox-image&sandbox_image_id=omp";

  test("member 403 while admin and owner succeed on the settings POST", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    const post = (login: string) =>
      authedRequest("/dashboard/acme/apps/acme-app/settings", login, {
        method: "POST",
        body: SETTINGS_BODY,
      });

    // Deployment admin, workspace member: the workspace role decides → 403.
    expect((await worker.fetch(await post("octocat"), env)).status).toBe(403);
    expect((await worker.fetch(await post("mallory"), env)).status).toBe(403);
    expect((await worker.fetch(await post("carol"), env)).status).toBe(200); // workspace admin
    expect((await worker.fetch(await post("dana"), env)).status).toBe(200); // workspace owner
  });

  test("the same settings POST is 403 for that non-manager on the legacy face under off", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "off");
    const res = await worker.fetch(
      await authedRequest("/dashboard/apps/acme-app/settings", "carol", {
        method: "POST",
        body: SETTINGS_BODY,
      }),
      env,
    );
    expect(res.status).toBe(403); // legacy rule: not the creator, not a deployment admin
  });
});

describe("WORKSPACE_TENANT_MODE=strict — reserved slugs are never captured", () => {
  test("a workspace whose slug is a reserved word is unreachable", async () => {
    const { db } = reservedFixture();
    const env = envFor(db, "strict");
    for (const word of RESERVED_WORKSPACE_SLUGS) {
      const res = await worker.fetch(
        await authedRequest(`/dashboard/${word}/apps/reserved-${word}-app/onboarding`, "octocat"),
        env,
      );
      expect(res.status, word).toBe(404);
    }
  });

  test("the same shape under a non-reserved slug serves (guard, not routing luck)", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/acme-app/onboarding", "dana"),
      envFor(db, "strict"),
    );
    expect(res.status).toBe(200);
  });
});
