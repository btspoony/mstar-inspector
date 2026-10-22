/**
 * Workspace (tenant) routing + authorization — Deploy B of
 * `WORKSPACE_TENANT_MODE` (migration 0026 data plane).
 *
 * The mode switch governs the request path in `src/dashboard/index.ts`: under
 * `off` the workspace-shaped paths do not exist (404) and the legacy App face
 * behaves exactly as before; under `strict` the legacy App face is 404 and the
 * workspace paths serve, with authorization decided by the actor's workspace
 * role instead of `canManageApp`'s creator-or-deployment-admin rule. The
 * routing gate only CLASSIFIES the slug — the workspace row and the membership
 * are resolved after the session/user read, so an anonymous request learns
 * nothing about slug existence (pinned below).
 *
 * The fixture runs against the full migration set (the store helper walks
 * `migrations/`), so 0026/0027 are real: `default` is seeded by 0026 and the
 * backfill is a no-op because the rows are inserted afterwards. Every
 * workspace here is explicit, which keeps the role matrix readable.
 */
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { withSpaAssets } from "../helpers/spa";
import {
  MANIFEST_HOLD_COOKIE,
  MANIFEST_STATE_COOKIE,
  buildHoldPayload,
  createHoldValue,
  createManifestStateValue,
  encryptHoldValue,
} from "../../src/dashboard/manifest";
import { apiBase } from "../../src/spa/workspace-base";
import type { SpaBoot } from "../../src/spa/boot";
import { RESERVED_WORKSPACE_SLUGS } from "../../src/spa/routes";
import { t } from "../../src/i18n";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/** The boot the served shell injected (the client's only identity channel). */
function bootOf(html: string): SpaBoot {
  const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
  if (json === undefined) throw new Error("no injected SPA boot");
  return JSON.parse(json) as SpaBoot;
}

/**
 * Renders the REAL Members page (chrome included) at `/dashboard/members` from
 * one boot and returns every href it emits. The SPA tree is imported through a
 * computed specifier: the root tsconfig keeps `src/spa` out of this program
 * (it targets the Workers lib, not the DOM), so a static import would drag the
 * browser sources into a typecheck that has no `document`.
 */
async function renderMembersHrefs(boot: SpaBoot): Promise<string[]> {
  // Specifiers stay relative to THIS file so Bun resolves them exactly as a
  // static import would; `tsc` never sees them.
  const spa = "../../src/spa";
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  type Component = (props: Record<string, unknown>) => ReactElement;
  const { Layout } = (await import(`${spa}/Layout`)) as { Layout: Component };
  const { DashboardPage } = (await import(`${spa}/pages`)) as { DashboardPage: Component };
  const { matchRoute } = (await import(`${spa}/router`)) as {
    matchRoute: (pathname: string) => unknown;
  };
  const pathname = "/dashboard/members";
  const html = renderToStaticMarkup(
    createElement(Layout, {
      boot,
      pathname,
      children: createElement(DashboardPage, { route: matchRoute(pathname), boot }),
    }),
  );
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? "");
}

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
  init: {
    method?: string;
    body?: string;
    accept?: string;
    /** Extra cookies beside the session (manifest state / hold). */
    extraCookies?: Record<string, string>;
  } = {},
): Promise<Request> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  const cookies = [`${SESSION_COOKIE}=${session}`];
  for (const [name, value] of Object.entries(init.extraCookies ?? {})) cookies.push(`${name}=${value}`);
  const headers: Record<string, string> = { Cookie: cookies.join("; ") };
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

  test("an anonymous request cannot tell an existing workspace from a missing one (no pre-auth oracle)", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    // `acme` exists, `ghost` does not. Both must answer the same 302 to login:
    // the gate classifies the slug without a D1 read, and the workspace row is
    // only resolved after the session + user read.
    const answers: Array<{ status: number; location: string | null; body: string }> = [];
    for (const slug of ["acme", "ghost"]) {
      const res = await worker.fetch(
        new Request(`https://worker.local/dashboard/${slug}/api/apps`),
        env,
      );
      answers.push({
        status: res.status,
        location: res.headers.get("Location"),
        body: await res.text(),
      });
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toMatchObject({ status: 302, location: "/dashboard/login" });
  });

  test("the tenant gate issues no workspace read for an anonymous request", async () => {
    const { db } = tenancyFixture();
    const statements: string[] = [];
    // Record every statement the request prepares; a classified-only gate must
    // not touch `workspaces` before the session read.
    const observed = {
      ...db,
      prepare(query: string) {
        statements.push(query);
        return db.prepare(query);
      },
    } as TestD1;
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/acme/api/apps"),
      envFor(observed, "strict"),
    );
    expect(res.status).toBe(302);
    expect(statements.filter((sql) => sql.includes("FROM workspaces"))).toEqual([]);
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

  test("the workspace 404 is the styled page on HTML navigation and a bare status on fetch", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    // HTML navigation renders the console's own 404 surface (the same page the
    // pinned-POST 404 uses) instead of Hono's bare text.
    const page = await worker.fetch(
      await authedRequest("/dashboard/ghost/api/apps", "octocat", { accept: "text/html" }),
      env,
    );
    expect(page.status).toBe(404);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    expect(await page.text()).toContain(t("en", "common.error.notFoundTitle"));
    // A fetch gets no HTML page: the SPA's API reads parse the status only, so
    // the contract is a plain response — the status and its content type, not
    // Hono's exact body text (which is not ours to pin).
    const api = await worker.fetch(
      await authedRequest("/dashboard/ghost/api/apps", "octocat", { accept: "application/json" }),
      env,
    );
    expect(api.status).toBe(404);
    expect(api.headers.get("Content-Type")).toStartWith("text/plain");
    expect(await api.text()).not.toContain(t("en", "common.error.notFoundTitle"));
  });

  test("the ROUTING gate's 404s carry the same styled page (N2)", async () => {
    // Both gate branches answer a hidden route family before any session or
    // membership read: the strict legacy-App face and the off workspace face.
    // Their HTML navigation must render the member gate's page, not bare text.
    for (const [mode, path] of [
      ["strict", "/dashboard/apps"],
      ["off", "/dashboard/acme/apps"],
    ] as const) {
      const { db } = tenancyFixture();
      const env = envFor(db, mode);
      const page = await worker.fetch(
        await authedRequest(path, "octocat", { accept: "text/html" }),
        env,
      );
      expect(page.status, path).toBe(404);
      expect(page.headers.get("Content-Type"), path).toContain("text/html");
      expect(await page.text(), path).toContain(t("en", "common.error.notFoundTitle"));
      const api = await worker.fetch(await authedRequest(path, "octocat"), env);
      expect(api.status, path).toBe(404);
      expect(await api.text(), path).toBe("404 Not Found");
    }
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

describe("WORKSPACE_TENANT_MODE=strict — success redirects stay in the workspace route family", () => {
  const SETTINGS_BODY = "op=save-sandbox-image&sandbox_image_id=omp";

  test("a native settings form post answers 302 to the workspace-prefixed settings URL", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/acme-app/settings", "carol", {
        method: "POST",
        body: SETTINGS_BODY,
        accept: "text/html",
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/acme/apps/acme-app/settings");
  });

  test("a native validation 400 keeps the same workspace-prefixed target", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/acme-app/settings", "carol", {
        method: "POST",
        body: "op=save-sandbox-image&sandbox_image_id=no-such-image",
        accept: "text/html",
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/acme/apps/acme-app/settings");
  });

  test("a native pause form post redirects to the workspace apps list (Referer-derived)", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/acme-app/pause", "carol", {
        method: "POST",
        accept: "text/html",
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
  });

  test("the SPA fetch form post keeps its plain 2xx body (no redirect)", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    const request = await authedRequest("/dashboard/acme/apps/acme-app/settings", "carol", {
      method: "POST",
      body: SETTINGS_BODY,
      accept: "text/html",
    });
    request.headers.set("X-Mstar-Spa-Post", "1");
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).toContain("Saved the omp runtime image for acme-app.");
  });

  test("off: the same native post still redirects to the legacy settings URL", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "off");
    const res = await worker.fetch(
      await authedRequest("/dashboard/apps/acme-app/settings", "octocat", {
        method: "POST",
        body: SETTINGS_BODY,
        accept: "text/html",
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/apps/acme-app/settings");
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

describe("invisible App stays a 404 on both faces (never a redirect)", () => {
  test("strict: HTML GET and POST on a cross-workspace App answer 404 with no Location", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");

    const get = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/other-app/onboarding", "dana", {
        accept: "text/html",
      }),
      env,
    );
    expect(get.status).toBe(404);
    expect(get.headers.get("Location")).toBeNull();
    expect(get.headers.get("Content-Type")).toContain("text/html");

    const post = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/other-app/disable", "dana", {
        method: "POST",
        accept: "text/html",
      }),
      env,
    );
    expect(post.status).toBe(404);
    expect(post.headers.get("Location")).toBeNull();
  });

  test("strict: a fetch POST on an invisible App answers the legacy 404 body", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/other-app/disable", "dana", { method: "POST" }),
      envFor(db, "strict"),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("unknown app");
  });

  test("off: the legacy HTML GET and POST still redirect exactly as today", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db, "off");
    const cases: Array<{ path: string; init: { method?: string; accept: string } }> = [
      { path: "/dashboard/apps/ghost-app/onboarding", init: { accept: "text/html" } },
      { path: "/dashboard/apps/ghost-app/disable", init: { method: "POST", accept: "text/html" } },
    ];
    for (const { path, init } of cases) {
      const res = await worker.fetch(await authedRequest(path, "octocat", init), env);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("Location"), path).toBe("/dashboard");
    }
  });
});

describe("off: unmatched reserved-shaped paths keep their original answer", () => {
  test("a POST under a reserved first segment still reaches the placeholder catch-all", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/login/apps/anything/disable", "octocat", { method: "POST" }),
      envFor(db, "off"),
    );
    expect(res.status).toBe(405);
    expect(await res.text()).toBe("placeholder actions are not implemented");
  });

  test("a GET under a reserved first segment is still the plain 404", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/login/apps/anything/onboarding", "octocat"),
      envFor(db, "off"),
    );
    expect(res.status).toBe(404);
  });
});

describe("tenant gate runs before SPA dispatch (ASSETS bound)", () => {
  test("strict: legacy App HTML GET and HEAD answer 404, not the SPA shell", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db, "strict"));
    for (const path of ["/dashboard/apps", "/dashboard/apps/acme-app/settings"]) {
      const get = await worker.fetch(
        await authedRequest(path, "octocat", { accept: "text/html" }),
        env,
      );
      expect(get.status, path).toBe(404);
      expect(await get.text()).not.toContain("window.__BOOT__");

      const head = await worker.fetch(
        await authedRequest(path, "octocat", { method: "HEAD", accept: "text/html" }),
        env,
      );
      expect(head.status, path).toBe(404);
    }
  });

  test("strict: a workspace App page still serves with ASSETS bound", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db, "strict"));
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/acme-app/onboarding", "dana", {
        accept: "text/html",
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("acme-app");
    expect(body).not.toContain("window.__BOOT__");
  });

  test("strict: the workspace Apps pages serve the shell over the workspace API base", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db, "strict"));
    for (const path of ["/dashboard/acme/apps", "/dashboard/acme/apps/acme-app"]) {
      const res = await worker.fetch(
        await authedRequest(path, "dana", { accept: "text/html" }),
        env,
      );
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain("window.__BOOT__");
      // The shell derives its API base from THIS pathname: every read and link
      // on the page hangs off /dashboard/acme (the legacy App family 404s here).
      expect(apiBase(path), path).toBe("/dashboard/acme");
    }
  });

  test("strict: the workspace-active Members shell names the sole workspace in the boot, so its nav stays inside it", async () => {
    // Members is not workspace-routed; only the server-resolved sole workspace
    // can keep its Apps/brand links off the legacy `/dashboard/apps` dead end.
    // 0026 seeds `default`; this fixture adds the membership on top of it.
    const db = createMigratedTestD1();
    seedMembership(db, "default", seedUser(db, "octocat", "admin"), "owner");
    const res = await worker.fetch(
      await authedRequest("/dashboard/members", "octocat", { accept: "text/html" }),
      withSpaAssets(envFor(db, "strict")),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.workspaceSlug).toBe("default");
    const hrefs = await renderMembersHrefs(boot);
    expect(hrefs).toContain("/dashboard/default/apps");
    expect(hrefs).toContain("/dashboard/members");
    expect(hrefs).not.toContain("/dashboard/apps");
  });

  test("off: the Members shell keeps the legacy targets (no workspace in the boot)", async () => {
    const db = createMigratedTestD1();
    seedMembership(db, "default", seedUser(db, "octocat", "admin"), "owner");
    const res = await worker.fetch(
      await authedRequest("/dashboard/members", "octocat", { accept: "text/html" }),
      withSpaAssets(envFor(db, "off")),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.workspaceSlug).toBeUndefined();
    // `off` keeps today's output exactly: the legacy targets, no workspace.
    const hrefs = await renderMembersHrefs(boot);
    expect(hrefs).toContain("/dashboard/apps");
    expect(hrefs).not.toContain("/dashboard/default/apps");
  });

  test("strict: the workspace Apps boot keeps its workspace after a client-side navigation to Members", async () => {
    // spaClick → pushState changes the pathname but NOT `window.__BOOT__`, so a
    // boot that omitted the slug on workspace pages would strand Members on the
    // legacy targets the moment the admin clicked through (I-000072).
    // A deployment ADMIN carries the Members entry; 0026 seeds `default` as
    // the sole live workspace, so it is also what the server resolves.
    const db = createMigratedTestD1();
    seedMembership(db, "default", seedUser(db, "octocat", "admin"), "owner");
    const res = await worker.fetch(
      await authedRequest("/dashboard/default/apps", "octocat", { accept: "text/html" }),
      withSpaAssets(envFor(db, "strict")),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.workspaceSlug).toBe("default");
    // The Members PAGE the click lands on, rendered from THAT boot: the
    // sidebar hrefs are read off the markup, not off the model behind it.
    const hrefs = await renderMembersHrefs(boot);
    expect(hrefs).toContain("/dashboard/default/apps");
    expect(hrefs).toContain("/dashboard/members");
    expect(hrefs).not.toContain("/dashboard/apps");
  });

  test("strict: the direct /index.html shell names the sole workspace too (N1)", async () => {
    // `/index.html` is the same shell document addressed directly — the SPA
    // router then reads the real pathname — so it must carry the same boot or
    // its sidebar keeps the legacy dead end.
    const db = createMigratedTestD1();
    seedMembership(db, "default", seedUser(db, "octocat", "admin"), "owner");
    const res = await worker.fetch(
      new Request("https://worker.local/index.html", {
        headers: {
          Accept: "text/html",
          Cookie: `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}`,
        },
      }),
      withSpaAssets(envFor(db, "strict")),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.workspaceSlug).toBe("default");
    const hrefs = await renderMembersHrefs(boot);
    expect(hrefs).toContain("/dashboard/default/apps");
    expect(hrefs).not.toContain("/dashboard/apps");
  });

  test("off: a workspace-shaped shell never exists, so no boot carries a slug", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/apps", "octocat", { accept: "text/html" }),
      withSpaAssets(envFor(db, "off")),
    );
    expect(res.status).toBe(200);
    expect(bootOf(await res.text()).workspaceSlug).toBeUndefined();
  });

  test("off: a workspace Apps page answers 404 even with ASSETS bound (gate before dispatch)", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db, "off"));
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps", "octocat", { accept: "text/html" }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("window.__BOOT__");
  });

  test("off: the legacy SPA pages still serve with ASSETS bound", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db, "off"));
    for (const path of ["/dashboard/apps", "/dashboard/apps/acme-app/settings"]) {
      const res = await worker.fetch(
        await authedRequest(path, "octocat", { accept: "text/html" }),
        env,
      );
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain("window.__BOOT__");
    }
  });
});

describe("strict: the post-authentication landing is the workspace Apps page", () => {
  /** ONE live workspace — the M1 shape `getSoleWorkspace` resolves. */
  function soleWorkspaceFixture() {
    const db = createMigratedTestD1();
    const userId = seedUser(db, "octocat", "admin");
    seedMembership(db, "default", userId, "owner");
    return { db };
  }

  test("a signed-in HTML GET /dashboard 302s to the workspace Apps list, not the legacy root", async () => {
    const { db } = soleWorkspaceFixture();
    const env = withSpaAssets(envFor(db, "strict"));
    const res = await worker.fetch(
      await authedRequest("/dashboard", "octocat", { accept: "text/html" }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/apps");
    // The dead-end shell is never served on this path.
    expect(await res.text()).not.toContain("window.__BOOT__");
  });

  test("an unsigned /dashboard still 302s into the login page", async () => {
    const { db } = soleWorkspaceFixture();
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard", { headers: { Accept: "text/html" } }),
      withSpaAssets(envFor(db, "strict")),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("an already-signed-in login bounce lands on the same workspace Apps page", async () => {
    const { db } = soleWorkspaceFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/login", "octocat"),
      envFor(db, "strict"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/apps");
  });

  test("no sole workspace → the legacy root shell is kept (no guessed slug)", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db, "strict"));
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => {
      warns.push(String(msg));
    };
    try {
      const res = await worker.fetch(
        await authedRequest("/dashboard", "octocat", { accept: "text/html" }),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("window.__BOOT__");
    } finally {
      console.warn = original;
    }
    expect(warns.some((line) => line.includes('"reason":"no_sole_workspace"'))).toBe(true);
  });

  test("off: the legacy root shell is unchanged", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard", "octocat", { accept: "text/html" }),
      withSpaAssets(envFor(db, "off")),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("window.__BOOT__");
  });
});

describe("strict: the onboarding CTA stays inside the workspace", () => {
  test("the Open Settings CTA targets the workspace settings page", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/acme-app/onboarding", "dana"),
      envFor(db, "strict"),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="/dashboard/acme/apps/acme-app/settings"');
    expect(body).not.toContain('href="/dashboard/apps/acme-app/settings"');
  });

  test("off: the CTA keeps the legacy href", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/apps/acme-app/onboarding", "octocat"),
      envFor(db, "off"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/dashboard/apps/acme-app/settings"');
  });
});

describe("WORKSPACE_TENANT_MODE=strict — App creation is owner/admin", () => {
  /**
   * ONE live workspace (`default`, 0026's seed) — the M1 shape the gate judges
   * against — with a role matrix where `octocat` is a deployment ADMIN but only
   * a workspace MEMBER, so the legacy rule and the workspace rule disagree.
   */
  function soleWorkspaceRoles() {
    const db = createMigratedTestD1();
    seedMembership(db, "default", seedUser(db, "octocat", "admin"), "member");
    seedMembership(db, "default", seedUser(db, "carol", "member"), "admin");
    seedMembership(db, "default", seedUser(db, "dana", "member"), "owner");
    seedMembership(db, "default", seedUser(db, "mallory", "member"), "member");
    return { db };
  }

  function post(login: string, path: string, env: Env): Promise<Response> {
    return authedRequest(path, login, { method: "POST" }).then((request) => worker.fetch(request, env));
  }

  test("owner and admin may start the manifest flow and get the create form", async () => {
    const { db } = soleWorkspaceRoles();
    const env = envFor(db, "strict");
    for (const login of ["dana", "carol"]) {
      const res = await post(login, "/dashboard/manifest/start", env);
      expect(res.status, login).toBe(200);
      expect(await res.text(), login).toContain("https://github.com/settings/apps/new");
    }
  });

  test("a plain member is refused with the styled 403 page and mints no state cookie", async () => {
    const { db } = soleWorkspaceRoles();
    const env = envFor(db, "strict");
    for (const login of ["mallory", "octocat"]) {
      // octocat is a DEPLOYMENT admin but a workspace member: the workspace
      // role decides, exactly as the scoped canManageApp does.
      const res = await post(login, "/dashboard/manifest/start", env);
      expect(res.status, login).toBe(403);
      expect(await res.text(), login).toContain(t("en", "common.error.forbiddenTitle"));
      expect(res.headers.getSetCookie(), login).toEqual([]);
    }
  });

  test("the commit recovery route applies the same gate (member 403, owner passes to the hold check)", async () => {
    const { db } = soleWorkspaceRoles();
    const env = envFor(db, "strict");
    const member = await post("mallory", "/dashboard/manifest/commit", env);
    expect(member.status).toBe(403);
    expect(await member.text()).toContain(t("en", "common.error.forbiddenTitle"));
    // The owner clears the gate; with no hold the route falls back to the flow
    // start, which is the pre-existing no-hold contract.
    const owner = await post("dana", "/dashboard/manifest/commit", env);
    expect(owner.status).toBe(302);
    expect(owner.headers.get("Location")).toBe("/dashboard");
  });

  test("off keeps the ungated flow (its creator rule can manage the new App)", async () => {
    const { db } = soleWorkspaceRoles();
    expect((await post("mallory", "/dashboard/manifest/start", envFor(db, "off"))).status).toBe(200);
  });

  test("a strict deployment without a sole workspace refuses creation instead of defaulting open", async () => {
    // `tenancyFixture` carries several live workspaces, so ownership of a new
    // App cannot be resolved at all: strict must refuse here, not mint a slug
    // and only fail later inside createApp (after the state cookie and the
    // operator's trip to GitHub).
    const { db } = tenancyFixture();
    const env = envFor(db, "strict");
    for (const login of ["octocat", "dana"]) {
      const res = await post(login, "/dashboard/manifest/start", env);
      expect(res.status, login).toBe(403);
      expect(await res.text(), login).toContain(t("en", "common.error.forbiddenTitle"));
      expect(res.headers.getSetCookie(), login).toEqual([]);
    }
  });

  test("a strict deployment with an unbound store refuses creation (configuration, not permission)", async () => {
    // Without D1 nothing can attribute the App: the dashboard face already
    // fails closed on the missing binding before the route runs, so the flow
    // never starts and no slug/state cookie is minted.
    const env = { ...envFor(createMigratedTestD1(), "strict"), DB: undefined } as unknown as Env;
    const res = await post("octocat", "/dashboard/manifest/start", env);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("dashboard storage is not configured");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("the shell boot carries the create capability the SPA hides the action on", async () => {
    const { db } = soleWorkspaceRoles();
    const env = withSpaAssets(envFor(db, "strict"));
    const bootOfLogin = async (login: string): Promise<SpaBoot> =>
      bootOf(await (await worker.fetch(await authedRequest("/dashboard/members", login, { accept: "text/html" }), env)).text());
    // Owner/admin → true (the key is present, not merely defaulted).
    expect((await bootOfLogin("dana")).canCreateApp).toBe(true);
    expect((await bootOfLogin("carol")).canCreateApp).toBe(true);
    // Plain member → explicitly false.
    expect((await bootOfLogin("mallory")).canCreateApp).toBe(false);
    expect((await bootOfLogin("octocat")).canCreateApp).toBe(false);
    // `off` never sends the field: the legacy flow is ungated there.
    const offEnv = withSpaAssets(envFor(db, "off"));
    const offBoot = bootOf(
      await (await worker.fetch(await authedRequest("/dashboard/members", "mallory", { accept: "text/html" }), offEnv)).text(),
    );
    expect(offBoot.canCreateApp).toBeUndefined();
  });

  test("a strict deployment that cannot name one workspace advertises no create capability", async () => {
    const { db } = tenancyFixture(); // several live workspaces
    const env = withSpaAssets(envFor(db, "strict"));
    const boot = bootOf(
      await (await worker.fetch(await authedRequest("/dashboard/members", "octocat", { accept: "text/html" }), env)).text(),
    );
    expect(boot.canCreateApp).toBe(false);
    expect(boot.workspaceSlug).toBeUndefined();
  });
});

describe("WORKSPACE_TENANT_MODE=strict — a mid-flight demotion cannot finish the flow", () => {
  const SLUG = "mstar-inspector-mallory";
  const CONVERSION = {
    id: 987654,
    name: SLUG,
    pem: "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----",
    webhook_secret: "not-a-real-webhook-secret",
  };

  /** ONE live workspace where the caller starts as owner. */
  function ownerThenDemote() {
    const db = createMigratedTestD1();
    const userId = seedUser(db, "mallory", "member");
    seedMembership(db, "default", userId, "owner");
    return { db, userId };
  }

  /** The role change a concurrent admin performs while the flow is open. */
  function demote(db: TestD1, userId: string): void {
    db.raw
      .prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'default' AND user_id = ?")
      .run(userId);
  }

  /** GET /manifest/callback with a valid single-use state for `mallory`. */
  async function callback(env: Env, state: string): Promise<Response> {
    return worker.fetch(
      await authedRequest("/dashboard/manifest/callback?code=manifest-code&state=" + state, "mallory", {
        accept: "text/html",
        extraCookies: { [MANIFEST_STATE_COOKIE]: state },
      }),
      env,
    );
  }

  test("a start that began as owner still refuses the callback commit after demotion", async () => {
    const { db, userId } = ownerThenDemote();
    const env = envFor(db, "strict");
    const state = await createManifestStateValue(SESSION_SECRET, SLUG);
    // The operator really did start: the gate admitted it.
    expect((await worker.fetch(await authedRequest("/dashboard/manifest/start", "mallory", { method: "POST" }), env)).status).toBe(200);
    // A concurrent admin demotes them before GitHub redirects back.
    demote(db, userId);
    let networkCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;
    try {
      const res = await callback(env, state);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(t("en", "common.error.forbiddenTitle"));
      expect(networkCalls).toBe(0); // no code exchange behind the denial
    } finally {
      globalThis.fetch = realFetch;
    }
    const rows = db.raw.query("SELECT COUNT(*) AS n FROM github_apps").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("a parked hold no longer renders the confirm page (or its commit form) after demotion", async () => {
    const { db, userId } = ownerThenDemote();
    const env = envFor(db, "strict");
    const hold = await encryptHoldValue(buildHoldPayload(CONVERSION, "mallory", SLUG), SESSION_SECRET);
    demote(db, userId);
    const res = await worker.fetch(
      await authedRequest("/dashboard/manifest/confirm", "mallory", {
        accept: "text/html",
        extraCookies: { [MANIFEST_HOLD_COOKIE]: hold },
      }),
      env,
    );
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain(t("en", "common.error.forbiddenTitle"));
    expect(body).not.toContain('action="/dashboard/manifest/commit"');
    // The hold is burned: a demoted operator keeps no resumable credential.
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
  });

  test("the same hold still resumes for a caller who is still owner", async () => {
    const { db } = ownerThenDemote();
    const env = envFor(db, "strict");
    const hold = await createHoldValue(CONVERSION, "mallory", SESSION_SECRET, SLUG);
    const res = await worker.fetch(
      await authedRequest("/dashboard/manifest/confirm", "mallory", {
        accept: "text/html",
        extraCookies: { [MANIFEST_HOLD_COOKIE]: hold },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('action="/dashboard/manifest/commit"');
  });

  test("off adds no gate and no read: a demoted-shape flow still completes there", async () => {
    const { db, userId } = ownerThenDemote();
    const env = envFor(db, "off");
    demote(db, userId);
    const hold = await createHoldValue(CONVERSION, "mallory", SESSION_SECRET, SLUG);
    const res = await worker.fetch(
      await authedRequest("/dashboard/manifest/confirm", "mallory", {
        accept: "text/html",
        extraCookies: { [MANIFEST_HOLD_COOKIE]: hold },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('action="/dashboard/manifest/commit"');
  });
});

describe("WORKSPACE_TENANT_MODE with an illegal value — fails loud", () => {
  test("every /dashboard request answers 500 with the bad value and serves no route", async () => {
    const { db } = tenancyFixture();
    const env = { ...envFor(db), WORKSPACE_TENANT_MODE: "on" } as unknown as Env;
    // Legacy, workspace-shaped and mode-independent paths alike: refusing to
    // pick a face is safer than serving either one from a typo'd deploy var.
    for (const path of ["/dashboard/apps", "/dashboard/acme/apps", "/dashboard/login"]) {
      const res = await worker.fetch(await authedRequest(path, "octocat"), env);
      expect(res.status, path).toBe(500);
      expect(await res.text(), path).toContain(
        'invalid WORKSPACE_TENANT_MODE on — expected "off" or "strict"',
      );
    }
  });
});
