import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ReactElement } from "react";
import worker from "../../src/worker/index";
import { requireMember, type DashboardVariables } from "../../src/dashboard/index";
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
  readManifestStateValue,
} from "../../src/dashboard/manifest";
import { apiBase } from "../../src/spa/workspace-base";
import { buildWorkspaceSwitcherModel } from "../../src/spa/shell";
import type { SpaBoot } from "../../src/spa/boot";
import { RESERVED_WORKSPACE_SLUGS, WORKSPACE_FAMILY_SEGMENTS, matchSpaRoute } from "../../src/spa/routes";
import { t } from "../../src/i18n";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function bootOf(html: string): SpaBoot {
  const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
  if (json === undefined) throw new Error("no injected SPA boot");
  return JSON.parse(json) as SpaBoot;
}

async function renderMembersHrefs(boot: SpaBoot, pathname = "/dashboard/default/members"): Promise<string[]> {
  const spa = "../../src/spa";
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  type Component = (props: Record<string, unknown>) => ReactElement;
  const { Layout } = (await import(`${spa}/Layout`)) as { Layout: Component };
  const { DashboardPage } = (await import(`${spa}/pages`)) as { DashboardPage: Component };
  const { matchRoute } = (await import(`${spa}/router`)) as {
    matchRoute: (pathname: string) => unknown;
  };
  const html = renderToStaticMarkup(
    createElement(Layout, {
      boot,
      pathname,
      children: createElement(DashboardPage, { route: matchRoute(pathname), boot }),
    }),
  );
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? "");
}

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB: db,
  } as unknown as Env;
}

async function authedRequest(
  path: string,
  login: string,
  init: {
    method?: string;
    body?: string;
    accept?: string;
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

function seedUserId(db: TestD1, login: string): string {
  const row = db.raw.prepare("SELECT id FROM users WHERE github_login = ?").get(login) as
    | { id: string }
    | null;
  if (row === null) throw new Error(`no users row for ${login}`);
  return row.id;
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

const ACME_APP_ID = 1000;
const OTHER_APP_ID = 1001;
const APP_IDS: Record<string, number> = { "ws-acme": ACME_APP_ID, "ws-other": OTHER_APP_ID };

function githubAppIdOf(rowId: string): number {
  let hash = 7;
  for (const char of rowId) hash = (hash * 31 + char.charCodeAt(0)) % 100_000;
  return 20_000 + hash;
}

function seedApp(db: TestD1, id: string, slug: string, workspaceId: string): void {
  const now = new Date().toISOString();
  seed(
    db,
    `INSERT INTO review_bots
       (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES (?, NULL, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
             'octocat', 'active', ?, ?)`,
    id,
    APP_IDS[workspaceId] ?? githubAppIdOf(id),
    slug,
    now,
    now,
  );
  seed(db, "INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)", id, workspaceId);
  seed(
    db,
    `INSERT INTO review_targets
       (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'octocat', ?, ?)`,
    `target-${id}`,
    workspaceId,
    id,
    slug,
    now,
    now,
  );
}

function botRowIdOf(db: TestD1, id: string): string {
  return (
    db.raw.prepare("SELECT id FROM review_bots WHERE id = ?").get(id) as { id: string }
  ).id;
}

function liveTargetIdOf(db: TestD1, botId: string): string {
  const row = db.raw
    .prepare("SELECT id FROM review_targets WHERE bot_id = ? AND deleted_at IS NULL")
    .get(botId) as { id: string } | null;
  if (row === null) throw new Error(`fixture bot ${botId} owns no live target`);
  return row.id;
}

function appAcmeId(db: TestD1): number {
  return (
    db.raw.prepare("SELECT github_app_id FROM review_bots WHERE id = ?").get("app-acme") as {
      github_app_id: number;
    }
  ).github_app_id;
}

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

describe("the pre-workspace App face is retired", () => {
  test("every legacy App path answers 404", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    for (const path of [
      `/dashboard/apps/${ACME_APP_ID}/onboarding`,
      `/dashboard/apps/${ACME_APP_ID}/settings`,
      "/dashboard/api/apps",
      `/dashboard/api/apps/${ACME_APP_ID}/settings`,
    ]) {
      const res = await worker.fetch(await authedRequest(path, "octocat"), env);
      expect(res.status, path).toBe(404);
    }
  });

  test("no session on a workspace path still redirects into the OAuth flow", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/acme/api/apps"),
      envFor(db),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("the workspace settings page serves the shell scoped to its workspace", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db));
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/settings", "dana", { accept: "text/html" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(bootOf(await res.text()).workspaceRef).toBe("acme");
  });

  test("an anonymous request cannot tell an existing workspace from a missing one (no pre-auth oracle)", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const answers: Array<{ status: number; location: string | null; body: string }> = [];
    for (const ref of ["acme", "ghost"]) {
      const res = await worker.fetch(
        new Request(`https://worker.local/dashboard/${ref}/api/apps`),
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

  test("an anonymous workspace API request reads only the maintenance window", async () => {
    const { db } = tenancyFixture();
    const statements: string[] = [];
    const observed = {
      ...db,
      prepare(query: string) {
        statements.push(query);
        return db.prepare(query);
      },
    } as TestD1;
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/acme/api/apps"),
      envFor(observed),
    );
    expect(res.status).toBe(302);
    expect(statements).toEqual([expect.stringMatching(/\bFROM\s+review_runtime_settings\b/i)]);
  });
});

describe("workspace paths serve", () => {
  test("the workspace list serves its members and lists only its own Apps", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const res = await worker.fetch(await authedRequest("/dashboard/acme/api/apps", "mallory"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewer: { login: string }; apps: Array<{ github_app_id: number }> };
    expect(body.viewer.login).toBe("mallory");
    expect(body.apps.map((app) => app.github_app_id)).toEqual([appAcmeId(db)]);
  });

  test("the workspace onboarding page serves managers and 403s a plain member", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const path = `/dashboard/acme/apps/${ACME_APP_ID}/onboarding`;

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
    const env = envFor(db);
    const res = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${OTHER_APP_ID}/onboarding`, "dana"),
      env,
    );
    expect(res.status).toBe(404);
  });

  test("a signed-in non-member sees 404, not the workspace", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const res = await worker.fetch(await authedRequest("/dashboard/acme/api/apps", "bob"), env);
    expect(res.status).toBe(404);
  });

  test("an unknown workspace ref answers 404", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/ghost/api/apps", "octocat"),
      envFor(db),
    );
    expect(res.status).toBe(404);
  });

  test("the workspace id resolves exactly like its slug", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const list = async (ref: string) => {
      const res = await worker.fetch(await authedRequest(`/dashboard/${ref}/api/apps`, "dana"), env);
      expect(res.status, ref).toBe(200);
      return (await res.json()) as { apps: Array<{ github_app_id: number }> };
    };
    const byId = await list("ws-acme");
    expect(byId.apps.map((app) => app.github_app_id)).toEqual([appAcmeId(db)]);
    expect(await list("acme")).toEqual(byId);
  });

  test("a ref that names two workspaces answers 404 and warns (never picks one)", async () => {
    const { db } = tenancyFixture();
    seedWorkspace(db, "dup", "dup-owner");
    seed(db, "UPDATE workspaces SET slug = 'dup' WHERE id = 'ws-acme'");
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => {
      warns.push(String(msg));
    };
    try {
      const res = await worker.fetch(await authedRequest("/dashboard/dup/api/apps", "dana"), envFor(db));
      expect(res.status).toBe(404);
    } finally {
      console.warn = original;
    }
    expect(warns.some((line) => line.includes('"event":"workspace_ref_ambiguous"'))).toBe(true);
  });

  test("the workspace 404 is the styled page on HTML navigation and a bare status on fetch", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const page = await worker.fetch(
      await authedRequest("/dashboard/ghost/api/apps", "octocat", { accept: "text/html" }),
      env,
    );
    expect(page.status).toBe(404);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    expect(await page.text()).toContain(t("en", "common.error.notFoundTitle"));
    const api = await worker.fetch(
      await authedRequest("/dashboard/ghost/api/apps", "octocat", { accept: "application/json" }),
      env,
    );
    expect(api.status).toBe(404);
    expect(api.headers.get("Content-Type")).toStartWith("text/plain");
    expect(await api.text()).not.toContain(t("en", "common.error.notFoundTitle"));
  });

  test("the ROUTING gate's 404s carry the same styled page (N2)", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const path = `/dashboard/apps/${ACME_APP_ID}/settings`;
    const page = await worker.fetch(
      await authedRequest(path, "octocat", { accept: "text/html" }),
      env,
    );
    expect(page.status, path).toBe(404);
    expect(page.headers.get("Content-Type"), path).toContain("text/html");
    expect(await page.text(), path).toContain(t("en", "common.error.notFoundTitle"));
    const api = await worker.fetch(await authedRequest(path, "octocat"), env);
    expect(api.status, path).toBe(404);
    expect(api.headers.get("Content-Type"), path).toStartWith("text/plain");
    expect(await api.text(), path).not.toContain(t("en", "common.error.notFoundTitle"));
  });

  test("non-App routes keep serving under strict; the retired root members API is gone", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const locale = await worker.fetch(await authedRequest("/dashboard/login", "octocat"), env);
    expect(locale.status).toBe(302);
    for (const path of ["/dashboard/api/members", "/dashboard/members/invite"]) {
      const gone = await worker.fetch(await authedRequest(path, "octocat"), env);
      expect(gone.status, path).toBe(404);
    }
    const scoped = await worker.fetch(await authedRequest("/dashboard/acme/api/members", "octocat"), env);
    expect(scoped.status).toBe(200);
  });
});

describe("manage is the workspace role", () => {
  const SETTINGS_BODY = "op=save-sandbox-image&sandbox_image_id=omp";

  test("member 403 while admin and owner succeed on the settings POST", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const post = (login: string) =>
      authedRequest(`/dashboard/acme/apps/${ACME_APP_ID}/settings`, login, {
        method: "POST",
        body: SETTINGS_BODY,
      });

    expect((await worker.fetch(await post("octocat"), env)).status).toBe(403);
    expect((await worker.fetch(await post("mallory"), env)).status).toBe(403);
    expect((await worker.fetch(await post("carol"), env)).status).toBe(200);
    expect((await worker.fetch(await post("dana"), env)).status).toBe(200);
  });

  test("the deployment-level settings path is retired (404, not a second authz rule)", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest(`/dashboard/apps/${ACME_APP_ID}/settings`, "carol", {
        method: "POST",
        body: SETTINGS_BODY,
      }),
      envFor(db),
    );
    expect(res.status).toBe(404);
  });
});

describe("success redirects stay in the workspace route family", () => {
  const SETTINGS_BODY = "op=save-sandbox-image&sandbox_image_id=omp";

  test("a native settings form post answers 302 to the workspace-prefixed target URL", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const res = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${ACME_APP_ID}/settings`, "carol", {
        method: "POST",
        body: SETTINGS_BODY,
        accept: "text/html",
      }),
      env,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toBe(
      `/dashboard/acme/repos/${liveTargetIdOf(db, botRowIdOf(db, "app-acme"))}`,
    );
    expect(location).not.toBe(`/dashboard/acme/repos/${ACME_APP_ID}`);
    const followed = await worker.fetch(
      await authedRequest(location, "dana", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(followed.status).toBe(200);
    expect(bootOf(await followed.text()).workspaceRef).toBe("acme");
  });

  test("a native validation 400 keeps the same workspace-prefixed target", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const res = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${ACME_APP_ID}/settings`, "carol", {
        method: "POST",
        body: "op=save-sandbox-image&sandbox_image_id=no-such-image",
        accept: "text/html",
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/dashboard/acme/repos/${liveTargetIdOf(db, botRowIdOf(db, "app-acme"))}`,
    );
  });

  test("an App with no repository lands on the repository overview, which always resolves", async () => {
    const { db } = tenancyFixture();
    db.raw.prepare("DELETE FROM review_targets WHERE bot_id = ?").run("app-acme");
    const res = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${ACME_APP_ID}/settings`, "carol", {
        method: "POST",
        body: SETTINGS_BODY,
        accept: "text/html",
      }),
      envFor(db),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/acme/repos");
  });

  test("the SPA fetch form post keeps its plain 2xx body (no redirect)", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const request = await authedRequest(`/dashboard/acme/apps/${ACME_APP_ID}/settings`, "carol", {
      method: "POST",
      body: SETTINGS_BODY,
      accept: "text/html",
    });
    request.headers.set("X-Mstar-Spa-Post", "1");
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).toContain(`Saved the omp runtime harness for ${ACME_APP_ID}.`);
  });

  test("a native settings post on the retired deployment path answers 404 in the workspace family", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest(`/dashboard/apps/${ACME_APP_ID}/settings`, "octocat", {
        method: "POST",
        body: SETTINGS_BODY,
        accept: "text/html",
      }),
      envFor(db),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
  });
});

describe("reserved slugs are never captured", () => {
  test("a workspace whose slug is a reserved word is unreachable", async () => {
    const { db } = reservedFixture();
    const env = envFor(db);
    for (const word of RESERVED_WORKSPACE_SLUGS) {
      const res = await worker.fetch(
        await authedRequest(`/dashboard/${word}/apps/${githubAppIdOf(`app-${word}`)}/onboarding`, "octocat"),
        env,
      );
      expect(res.status, word).toBe(404);
    }
  });

  test("the same shape under a non-reserved slug serves (guard, not routing luck)", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${ACME_APP_ID}/onboarding`, "dana"),
      envFor(db),
    );
    expect(res.status).toBe(200);
  });
});

describe("invisible App stays a 404 (never a redirect)", () => {
  test("HTML GET and POST on a cross-workspace App answer 404 with no Location", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);

    const get = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${OTHER_APP_ID}/onboarding`, "dana", {
        accept: "text/html",
      }),
      env,
    );
    expect(get.status).toBe(404);
    expect(get.headers.get("Location")).toBeNull();
    expect(get.headers.get("Content-Type")).toContain("text/html");

    const post = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${OTHER_APP_ID}/disable`, "dana", {
        method: "POST",
        accept: "text/html",
      }),
      env,
    );
    expect(post.status).toBe(404);
    expect(post.headers.get("Location")).toBeNull();
  });

  test("a fetch POST on an invisible App answers the plain 404 body", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${OTHER_APP_ID}/disable`, "dana", { method: "POST" }),
      envFor(db),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("unknown app");
  });
});

describe("unmatched reserved-shaped paths keep their answer", () => {
  test("a POST under a reserved first segment still reaches the placeholder catch-all", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/login/apps/anything/disable", "octocat", { method: "POST" }),
      envFor(db),
    );
    expect(res.status).toBe(405);
    expect(await res.text()).toBe("placeholder actions are not implemented");
  });

  test("a GET under a reserved first segment is still the plain 404", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/login/apps/anything/onboarding", "octocat"),
      envFor(db),
    );
    expect(res.status).toBe(404);
  });
});

describe("tenant gate runs before SPA dispatch (ASSETS bound)", () => {
  test("retired App HTML GET and HEAD answer 404, not the SPA shell", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db));
    for (const path of [`/dashboard/apps/${ACME_APP_ID}/settings`, `/dashboard/apps/${ACME_APP_ID}/onboarding`]) {
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

  test("a workspace App page still serves with ASSETS bound", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db));
    const res = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${ACME_APP_ID}/onboarding`, "dana", {
        accept: "text/html",
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("acme-app");
    expect(body).not.toContain("window.__BOOT__");
  });

  test("the workspace Apps pages serve the shell over the workspace API base", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db));
    for (const path of ["/dashboard/acme/apps", "/dashboard/acme/apps/acme-app"]) {
      const res = await worker.fetch(
        await authedRequest(path, "dana", { accept: "text/html" }),
        env,
      );
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain("window.__BOOT__");
      expect(apiBase(path), path).toBe("/dashboard/acme");
    }
  });

  test("the workspace Members shell serves and keeps its nav inside the workspace", async () => {
    const db = createMigratedTestD1();
    seedMembership(db, "default", seedUser(db, "octocat", "admin"), "owner");
    const res = await worker.fetch(
      await authedRequest("/dashboard/default/members", "octocat", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.workspaceRef).toBe("default");
    const hrefs = await renderMembersHrefs(boot);
    expect(hrefs).toContain("/dashboard/default/apps");
    expect(hrefs).toContain("/dashboard/default/members");
    expect(hrefs).not.toContain("/dashboard/apps");
  });

  test("the retired root Members path answers 404 (retired, not redirected)", async () => {
    const db = createMigratedTestD1();
    seedMembership(db, "default", seedUser(db, "octocat", "admin"), "owner");
    const res = await worker.fetch(
      await authedRequest("/dashboard/members", "octocat", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(404);
  });

  test("the workspace Apps boot keeps its workspace after a client-side navigation to Members", async () => {
    const db = createMigratedTestD1();
    seedMembership(db, "default", seedUser(db, "octocat", "admin"), "owner");
    const res = await worker.fetch(
      await authedRequest("/dashboard/default/apps", "octocat", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.workspaceRef).toBe("default");
    const hrefs = await renderMembersHrefs(boot);
    expect(hrefs).toContain("/dashboard/default/apps");
    expect(hrefs).toContain("/dashboard/default/members");
    expect(hrefs).not.toContain("/dashboard/apps");
  });

  test("the direct /index.html shell names the sole workspace too (N1)", async () => {
    const db = createMigratedTestD1();
    seedMembership(db, "default", seedUser(db, "octocat", "admin"), "owner");
    const res = await worker.fetch(
      new Request("https://worker.local/index.html", {
        headers: {
          Accept: "text/html",
          Cookie: `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}`,
        },
      }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.workspaceRef).toBe("default");
    const hrefs = await renderMembersHrefs(boot);
    expect(hrefs).toContain("/dashboard/default/apps");
    expect(hrefs).not.toContain("/dashboard/apps");
  });

  test("a retired App page answers 404 even with ASSETS bound (gate before dispatch)", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db));
    for (const path of [`/dashboard/apps/${ACME_APP_ID}/settings`, `/dashboard/apps/${ACME_APP_ID}/onboarding`]) {
      const res = await worker.fetch(
        await authedRequest(path, "octocat", { accept: "text/html" }),
        env,
      );
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("window.__BOOT__");
    }
  });
});

describe("the repository surface is a page family, not a Worker route family", () => {
  test("repos joins the SPA family and the bare spelling is no page", () => {
    expect(WORKSPACE_FAMILY_SEGMENTS).toContain("repos");
    expect(matchSpaRoute("/dashboard/repos")).toBeNull();
  });

  test("both repository paths serve the shell scoped to their workspace", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db));
    const detailPath = `/dashboard/acme/repos/${liveTargetIdOf(db, botRowIdOf(db, "app-acme"))}`;
    for (const path of ["/dashboard/acme/repos", detailPath]) {
      const res = await worker.fetch(await authedRequest(path, "dana", { accept: "text/html" }), env);
      expect(res.status, path).toBe(200);
      const boot = bootOf(await res.text());
      expect(boot.workspaceRef, path).toBe("acme");
    }
  });
});

describe("the post-authentication landing is the workspace repository overview", () => {
  function soleWorkspaceFixture() {
    const db = createMigratedTestD1();
    const userId = seedUser(db, "octocat", "admin");
    seedMembership(db, "default", userId, "owner");
    return { db };
  }

  test("a signed-in HTML GET /dashboard 302s to the workspace repository overview, not a page", async () => {
    const { db } = soleWorkspaceFixture();
    const env = withSpaAssets(envFor(db));
    const res = await worker.fetch(
      await authedRequest("/dashboard", "octocat", { accept: "text/html" }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/repos");
    expect(await res.text()).not.toContain("window.__BOOT__");
  });

  test("the retired /dashboard/apps spelling answers the same redirect as the root", async () => {
    const { db } = soleWorkspaceFixture();
    for (const root of ["/dashboard", "/dashboard/apps"]) {
      const res = await worker.fetch(
        await authedRequest(root, "octocat", { accept: "text/html" }),
        withSpaAssets(envFor(db)),
      );
      expect(res.status, root).toBe(302);
      expect(res.headers.get("Location"), root).toBe("/dashboard/default/repos");
    }
  });

  test("an unsigned /dashboard still 302s into the login page", async () => {
    const { db } = soleWorkspaceFixture();
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard", { headers: { Accept: "text/html" } }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("an already-signed-in login bounce lands on the same workspace repository overview", async () => {
    const { db } = soleWorkspaceFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/login", "octocat"),
      envFor(db),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/repos");
  });

  test("several live workspaces → the login's own first membership, never the retired /dashboard/apps", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard", "octocat", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/ws-acme/repos");
    expect(res.headers.get("Location")).not.toBe("/dashboard/apps");
  });

  test("a login with TWO memberships lands on the first one and keeps the switcher", async () => {
    const { db, users } = tenancyFixture();
    seedMembership(db, "ws-other", users.wsOwner, "admin");
    const res = await worker.fetch(
      await authedRequest("/dashboard", "dana", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/ws-acme/repos");

    const shell = await worker.fetch(
      await authedRequest("/dashboard/ws-acme/apps", "dana", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(shell.status).toBe(200);
    const boot = bootOf(await shell.text());
    expect(boot.memberships?.map((m) => m.slug).sort()).toEqual(["acme", "other"]);
    expect(boot.workspaceRef).toBe("ws-acme");
  });
});

describe("a workspace URL never carries a mutable value", () => {
  test("a ref-less shell boot names the sole workspace by id", async () => {
    const db = createMigratedTestD1();
    seed(db, "DELETE FROM workspaces");
    seedWorkspace(db, "ws-acme", "acme");
    seedMembership(db, "ws-acme", seedUser(db, "octocat", "admin"), "owner");
    const res = await worker.fetch(
      await authedRequest("/index.html", "octocat", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.workspaceRef).toBe("ws-acme");
    const hrefs = await renderMembersHrefs(boot, "/index.html");
    expect(hrefs).toContain("/dashboard/ws-acme/apps");
    expect(hrefs).not.toContain("/dashboard/acme/apps");
  });

  test("a rewritten slug stops addressing the workspace, while the id keeps working", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db));
    const members = async (ref: string) =>
      worker.fetch(await authedRequest(`/dashboard/${ref}/api/members`, "dana"), env);

    expect((await members("acme")).status).toBe(200);

    seed(db, "UPDATE workspaces SET slug = 'acme-labs' WHERE id = 'ws-acme'");

    for (const ref of ["acme-labs", "ws-acme"]) {
      const res = await members(ref);
      expect(res.status, ref).toBe(200);
      const body = (await res.json()) as {
        viewer: { login: string; role: string };
        members: Array<{ github_login: string }>;
      };
      expect(body.viewer, ref).toEqual({ login: "dana", role: "owner" });
      expect(body.members.map((row) => row.github_login).sort(), ref).toEqual([
        "carol",
        "dana",
        "mallory",
        "octocat",
      ]);
    }

    expect((await members("acme")).status).toBe(404);

    const shell = await worker.fetch(
      await authedRequest("/dashboard/ws-acme/apps", "dana", { accept: "text/html" }),
      env,
    );
    expect(shell.status).toBe(200);
    expect(
      buildWorkspaceSwitcherModel(bootOf(await shell.text()), "/dashboard/ws-acme/apps")?.options.map(
        (option) => option.ref,
      ),
    ).toEqual(["ws-acme"]);
    const landing = await worker.fetch(
      await authedRequest("/dashboard", "dana", { accept: "text/html" }),
      env,
    );
    expect(landing.status).toBe(302);
    expect(landing.headers.get("Location")).toBe("/dashboard/ws-acme/repos");
  });
});

describe("a login with no workspace gets the creation surface", () => {
  function newcomer() {
    const db = createMigratedTestD1();
    seedUser(db, "newcomer", "member");
    return { db };
  }

  test("the /dashboard shell keeps rendering and carries needsWorkspace (not a redirect into a 404)", async () => {
    const { db } = newcomer();
    const res = await worker.fetch(
      await authedRequest("/dashboard", "newcomer", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.needsWorkspace).toBe(true);
    expect(boot.workspaceRef).toBeUndefined();
    expect(boot.canCreateApp).toBe(false);
  });

  test("the shell renders the creation form and no workspace nav entries", async () => {
    const { db } = newcomer();
    const res = await worker.fetch(
      await authedRequest("/dashboard", "newcomer", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    const boot = bootOf(await res.text());
    const hrefs = await renderMembersHrefs(boot, "/dashboard");
    expect(hrefs).not.toContain("/dashboard/apps");
    expect(hrefs).not.toContain("/dashboard/default/apps");
    const spa = "../../src/spa";
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    type Component = (props: Record<string, unknown>) => ReactElement;
    const { DashboardPage } = (await import(`${spa}/pages`)) as { DashboardPage: Component };
    const { matchRoute } = (await import(`${spa}/router`)) as {
      matchRoute: (pathname: string) => unknown;
    };
    const html = renderToStaticMarkup(
      createElement(DashboardPage, { route: matchRoute("/dashboard"), boot }),
    );
    expect(html).toContain(t(boot.locale, "workspace.setupHeading"));
    expect(html).toContain(t(boot.locale, "workspace.create"));
  });

  test("after creating a workspace the same login lands on that workspace's Apps page", async () => {
    const { db } = newcomer();
    const res = await worker.fetch(
      await authedRequest("/dashboard/api/workspaces", "newcomer", {
        method: "POST",
        body: new URLSearchParams({ name: "Acme" }).toString(),
      }),
      envFor(db),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; homePath: string };
    expect(created.homePath).toBe(`/dashboard/${created.id}/repos`);

    const shell = await worker.fetch(
      await authedRequest(`/dashboard/${created.id}/repos`, "newcomer", {
        accept: "text/html",
      }),
      withSpaAssets(envFor(db)),
    );
    expect(shell.status).toBe(200);
    const boot = bootOf(await shell.text());
    expect(boot.needsWorkspace).toBeUndefined();
    expect(boot.workspaceRef).toBe(created.id);
    const api = await worker.fetch(
      await authedRequest(`/dashboard/${created.id}/api/members`, "newcomer"),
      envFor(db),
    );
    expect(api.status).toBe(200);
    const members = (await api.json()) as { viewer: { login: string; role: string } };
    expect(members.viewer).toEqual({ login: "newcomer", role: "owner" });
  });

  test("a login that already belongs to a workspace is sent to it, not to creation", async () => {
    const { db } = newcomer();
    seedMembership(db, "default", seedUserId(db, "newcomer"), "member");
    const res = await worker.fetch(
      await authedRequest("/dashboard", "newcomer", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/repos");
  });
});

describe("the onboarding CTA stays inside the workspace", () => {
  test("the Open Settings CTA targets the App's resolved review target", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${ACME_APP_ID}/onboarding`, "dana"),
      envFor(db),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    const targetId = liveTargetIdOf(db, botRowIdOf(db, "app-acme"));
    expect(body).toContain(`href="/dashboard/acme/repos/${targetId}"`);
    expect(body).not.toContain(`href="/dashboard/acme/repos/${ACME_APP_ID}"`);
    expect(body).not.toContain(`href="/dashboard/apps/${ACME_APP_ID}/settings"`);
  });

  test("the Open Settings CTA falls back to the overview when the App holds no repository", async () => {
    const { db } = tenancyFixture();
    db.raw.prepare("DELETE FROM review_targets WHERE bot_id = ?").run("app-acme");
    const res = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${ACME_APP_ID}/onboarding`, "dana"),
      envFor(db),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/dashboard/acme/repos"');
  });

  test("the retired deployment-level onboarding path is a 404", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest(`/dashboard/apps/${ACME_APP_ID}/onboarding`, "octocat"),
      envFor(db),
    );
    expect(res.status).toBe(404);
  });
});

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("the manifest chrome stays inside the workspace", () => {
  test("the start page's brand, Apps and cancel links name the addressed workspace", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-acme", "acme");
    seedWorkspace(db, "ws-other", "other");
    const dana = seedUser(db, "dana", "member");
    seedMembership(db, "ws-acme", dana, "owner");
    seedMembership(db, "ws-other", dana, "owner");

    const res = await worker.fetch(
      await authedRequest("/dashboard/other/manifest/start", "dana", { method: "POST" }),
      envFor(db),
    );
    expect(res.status).toBe(200);
    const hrefs = hrefsOf(await res.text());
    expect([...new Set(hrefs.filter((href) => href !== "/dashboard/logout"))]).toEqual([
      "/dashboard/ws-other/apps",
    ]);
    expect(hrefs).not.toContain("/dashboard");
  });

  test("the confirm page's chrome targets the workspace the hold names", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-acme", "acme");
    seedWorkspace(db, "ws-other", "other");
    const dana = seedUser(db, "dana", "member");
    seedMembership(db, "ws-acme", dana, "owner");
    seedMembership(db, "ws-other", dana, "owner");
    const hold = await createHoldValue(
      {
        id: 987654,
        name: "mstar-inspector-dana",
        slug: "mstar-inspector-dana",
        pem: "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----",
        webhook_secret: "not-a-real-webhook-secret",
      },
      "dana",
      SESSION_SECRET,
      "mstar-inspector-dana",
      "ws-other",
    );

    const res = await worker.fetch(
      await authedRequest("/dashboard/manifest/confirm", "dana", {
        extraCookies: { [MANIFEST_HOLD_COOKIE]: hold },
      }),
      envFor(db),
    );
    expect(res.status).toBe(200);
    const hrefs = hrefsOf(await res.text());
    expect([...new Set(hrefs.filter((href) => href !== "/dashboard/logout"))]).toEqual([
      "/dashboard/ws-other/apps",
    ]);
    expect(hrefs).not.toContain("/dashboard");
  });

  test("the onboarding page's dashboard link is the workspace Apps page it was reached through", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${ACME_APP_ID}/onboarding`, "dana"),
      envFor(db),
    );
    expect(res.status).toBe(200);
    const hrefs = hrefsOf(await res.text());
    expect(hrefs).toContain("/dashboard/acme/apps");
    expect(hrefs).not.toContain("/dashboard");
  });
});

describe("App creation is owner/admin", () => {
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

  function postWithHold(login: string, hold: string, env: Env): Promise<Response> {
    return authedRequest("/dashboard/manifest/commit", login, {
      method: "POST",
      extraCookies: { [MANIFEST_HOLD_COOKIE]: hold },
    }).then((request) => worker.fetch(request, env));
  }

  const SLUG = "mstar-inspector-carol";
  const CONVERSION = {
    id: 987654,
    name: SLUG,
    slug: SLUG,
    pem: "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----",
    webhook_secret: "not-a-real-webhook-secret",
  };

  test("owner and admin may start the manifest flow and get the create form", async () => {
    const { db } = soleWorkspaceRoles();
    const env = envFor(db);
    for (const login of ["dana", "carol"]) {
      const res = await post(login, "/dashboard/manifest/start", env);
      expect(res.status, login).toBe(200);
      expect(await res.text(), login).toContain("https://github.com/settings/apps/new");
    }
  });

  test("a plain member is refused with the styled 403 page and mints no state cookie", async () => {
    const { db } = soleWorkspaceRoles();
    const env = envFor(db);
    for (const login of ["mallory", "octocat"]) {
      const res = await post(login, "/dashboard/manifest/start", env);
      expect(res.status, login).toBe(403);
      expect(await res.text(), login).toContain(t("en", "common.error.forbiddenTitle"));
      expect(res.headers.getSetCookie(), login).toEqual([]);
    }
  });

  test("the commit recovery route applies the same gate once a hold names its workspace", async () => {
    const { db } = soleWorkspaceRoles();
    const env = envFor(db);
    const noHold = await post("mallory", "/dashboard/manifest/commit", env);
    expect(noHold.status).toBe(302);
    expect(noHold.headers.get("Location")).toBe("/dashboard");
    const hold = await createHoldValue(CONVERSION, "mallory", SESSION_SECRET, SLUG, "default");
    const member = await postWithHold("mallory", hold, env);
    expect(member.status).toBe(403);
    expect(await member.text()).toContain(t("en", "common.error.forbiddenTitle"));
    expect(member.headers.getSetCookie().some((c) => c.includes("Max-Age=0"))).toBe(false);
    const owner = await postWithHold("dana", await createHoldValue(CONVERSION, "dana", SESSION_SECRET, SLUG, "default"), env);
    expect(owner.status).toBe(302);
    expect(owner.headers.get("Location")).toBe(
      `/dashboard/default/apps/${CONVERSION.id}/onboarding`,
    );
  });

  test("a no-ref manifest start on a multi-workspace deployment answers a readable 409 workspace_required", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const res = await post("dana", "/dashboard/manifest/start", env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "workspace_required",
      message: t("en", "manifest.error.workspaceRequired"),
    });
    expect(res.headers.getSetCookie()).toEqual([]);

    const html = await authedRequest("/dashboard/manifest/start", "dana", {
      method: "POST",
      accept: "text/html",
    }).then((request) => worker.fetch(request, env));
    expect(html.status).toBe(409);
    expect(await html.text()).toContain(t("en", "manifest.error.workspaceRequired"));
  });

  test("the creation right is judged in the ADDRESSED workspace, not the deployment", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-acme", "acme");
    seedWorkspace(db, "ws-other", "other");
    const dana = seedUser(db, "dana", "member");
    seedMembership(db, "ws-acme", dana, "member");
    seedMembership(db, "ws-other", dana, "owner");
    seedMembership(db, "ws-acme", seedUser(db, "carol", "member"), "admin");

    const env = envFor(db);
    const owner = await post("dana", "/dashboard/other/manifest/start", env);
    expect(owner.status).toBe(200);
    expect(await owner.text()).toContain("https://github.com/settings/apps/new");
    const memberElsewhere = await post("dana", "/dashboard/acme/manifest/start", env);
    expect(memberElsewhere.status).toBe(403);
    expect(await memberElsewhere.text()).toContain(t("en", "common.error.forbiddenTitle"));
    expect((await post("carol", "/dashboard/acme/manifest/start", env)).status).toBe(200);
    expect((await post("carol", "/dashboard/other/manifest/start", env)).status).toBe(403);
  });

  test("the manifest flow carries the target workspace end to end: start → callback → commit into W2, and W1 cannot read the App (404)", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-acme", "acme");
    seedWorkspace(db, "ws-other", "other");
    const dana = seedUser(db, "dana", "member");
    seedMembership(db, "ws-acme", dana, "owner");
    seedMembership(db, "ws-other", dana, "owner");
    const env = envFor(db);

    const start = await post("dana", "/dashboard/other/manifest/start", env);
    expect(start.status).toBe(200);
    const stateCookie =
      start.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_STATE_COOKIE}=`)) ?? "";
    const state = (stateCookie.split(";")[0] ?? "").slice(MANIFEST_STATE_COOKIE.length + 1);
    expect((await readManifestStateValue(state, state, SESSION_SECRET))?.workspaceId).toBe("ws-other");

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    try {
      const callback = await authedRequest(
        `/dashboard/manifest/callback?code=manifest-code&state=${state}`,
        "dana",
        { accept: "text/html", extraCookies: { [MANIFEST_STATE_COOKIE]: state } },
      ).then((request) => worker.fetch(request, env));
      expect(callback.status).toBe(302);
      expect(callback.headers.get("Location")).toBe(
        `/dashboard/ws-other/apps/${CONVERSION.id}/onboarding`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    const mapping = db.raw
      .prepare("SELECT bot_workspaces.workspace_id AS ws FROM bot_workspaces JOIN review_bots ON review_bots.id = bot_workspaces.bot_id WHERE review_bots.github_app_id = ?")
      .get(CONVERSION.id) as { ws: string } | null;
    expect(mapping?.ws).toBe("ws-other");
    const ownerRead = await worker.fetch(
      await authedRequest(`/dashboard/other/apps/${CONVERSION.id}/onboarding`, "dana", {
        accept: "text/html",
      }),
      env,
    );
    expect(ownerRead.status).toBe(200);
    expect(await ownerRead.text()).toContain(CONVERSION.slug!);
    const siblingRead = await worker.fetch(
      await authedRequest(`/dashboard/acme/apps/${CONVERSION.id}/onboarding`, "dana", {
        accept: "text/html",
      }),
      env,
    );
    expect(siblingRead.status).toBe(404);
    expect(siblingRead.headers.get("Location")).toBeNull();
  });

  test("a workspace whose slug changes mid-flow still receives the App (the flow binds the stable id)", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-acme", "acme");
    seedWorkspace(db, "ws-other", "other");
    const dana = seedUser(db, "dana", "member");
    seedMembership(db, "ws-acme", dana, "owner");
    const env = envFor(db);

    const start = await post("dana", "/dashboard/acme/manifest/start", env);
    expect(start.status).toBe(200);
    const stateCookie =
      start.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_STATE_COOKIE}=`)) ?? "";
    const state = (stateCookie.split(";")[0] ?? "").slice(MANIFEST_STATE_COOKIE.length + 1);
    expect((await readManifestStateValue(state, state, SESSION_SECRET))?.workspaceId).toBe("ws-acme");

    seed(db, "UPDATE workspaces SET slug = 'acme-renamed' WHERE id = 'ws-acme'");
    seedWorkspace(db, "ws-squatter", "acme");
    seedMembership(db, "ws-squatter", seedUser(db, "mallory", "member"), "owner");

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    try {
      const callback = await authedRequest(
        `/dashboard/manifest/callback?code=manifest-code&state=${state}`,
        "dana",
        { accept: "text/html", extraCookies: { [MANIFEST_STATE_COOKIE]: state } },
      ).then((request) => worker.fetch(request, env));
      expect(callback.status).toBe(302);
      expect(callback.headers.get("Location")).toBe(
        `/dashboard/ws-acme/apps/${CONVERSION.id}/onboarding`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    const mapping = db.raw
      .prepare("SELECT bot_workspaces.workspace_id AS ws FROM bot_workspaces JOIN review_bots ON review_bots.id = bot_workspaces.bot_id WHERE review_bots.github_app_id = ?")
      .get(CONVERSION.id) as { ws: string } | null;
    expect(mapping?.ws).toBe("ws-acme");
  });

  test("a workspace DELETED mid-flow answers the named workspaceGone error, not a bare shell redirect", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-acme", "acme");
    seedMembership(db, "ws-acme", seedUser(db, "dana", "member"), "owner");

    const start = await post("dana", "/dashboard/acme/manifest/start", envFor(db));
    expect(start.status).toBe(200);
    const stateCookie =
      start.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_STATE_COOKIE}=`)) ?? "";
    const state = (stateCookie.split(";")[0] ?? "").slice(MANIFEST_STATE_COOKIE.length + 1);

    const deletingDb: TestD1 = {
      prepare(query: string) {
        if (query.includes("FROM workspaces WHERE (slug = ?1 OR id = ?1)")) {
          seed(
            db,
            "UPDATE workspaces SET deleted_at = ? WHERE id = 'ws-acme'",
            new Date().toISOString(),
          );
        }
        return db.prepare(query);
      },
      batch: (statements) => db.batch(statements),
      raw: db.raw,
    };

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    try {
      const callback = await authedRequest(
        `/dashboard/manifest/callback?code=manifest-code&state=${state}`,
        "dana",
        { accept: "text/html", extraCookies: { [MANIFEST_STATE_COOKIE]: state } },
      ).then((request) => worker.fetch(request, envFor(deletingDb)));
      expect(callback.status).toBe(409);
      expect(callback.headers.get("Location")).toBeNull();
      expect(await callback.text()).toContain(t("en", "manifest.error.workspaceGone"));
    } finally {
      globalThis.fetch = realFetch;
    }
    const row = db.raw
      .prepare("SELECT COUNT(*) AS n FROM review_bots WHERE github_app_id = ?")
      .get(CONVERSION.id) as { n: number };
    expect(row.n).toBe(1);
  });

  test("the commit recovery route answers the same named workspaceGone error, not a shell redirect", async () => {
    const { db } = soleWorkspaceRoles();
    const hold = await createHoldValue(CONVERSION, "dana", SESSION_SECRET, SLUG, "default");

    const deletingDb: TestD1 = {
      prepare(query: string) {
        if (query.includes("FROM workspaces WHERE (slug = ?1 OR id = ?1)")) {
          seed(
            db,
            "UPDATE workspaces SET deleted_at = ? WHERE id = 'default'",
            new Date().toISOString(),
          );
        }
        return db.prepare(query);
      },
      batch: (statements) => db.batch(statements),
      raw: db.raw,
    };

    const res = await postWithHold("dana", hold, envFor(deletingDb));
    expect(res.status).toBe(409);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).toContain(t("en", "manifest.error.workspaceGone"));
    const row = db.raw
      .prepare("SELECT COUNT(*) AS n FROM review_bots WHERE github_app_id = ?")
      .get(CONVERSION.id) as { n: number };
    expect(row.n).toBe(1);
  });

  test("the boot's create capability follows the addressed workspace", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-acme", "acme");
    seedWorkspace(db, "ws-other", "other");
    const dana = seedUser(db, "dana", "member");
    seedMembership(db, "ws-acme", dana, "member");
    seedMembership(db, "ws-other", dana, "owner");
    const env = withSpaAssets(envFor(db));
    const bootAt = async (ref: string): Promise<SpaBoot> =>
      bootOf(
        await (
          await worker.fetch(await authedRequest(`/dashboard/${ref}/apps`, "dana", { accept: "text/html" }), env)
        ).text(),
      );
    expect((await bootAt("other")).canCreateApp).toBe(true);
    expect((await bootAt("other")).workspaceRef).toBe("other");
    expect((await bootAt("acme")).canCreateApp).toBe(false);
    expect((await bootAt("acme")).workspaceRef).toBe("acme");
  });

  test("a deployment with an unbound store refuses creation (configuration, not permission)", async () => {
    const env = { ...envFor(createMigratedTestD1()), DB: undefined } as unknown as Env;
    const res = await post("octocat", "/dashboard/manifest/start", env);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("dashboard storage is not configured");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("the shell boot carries the addressed workspace's create capability", async () => {
    const { db } = soleWorkspaceRoles();
    const env = withSpaAssets(envFor(db));
    const bootOfLogin = async (login: string): Promise<SpaBoot> =>
      bootOf(await (await worker.fetch(await authedRequest("/dashboard/default/members", login, { accept: "text/html" }), env)).text());
    expect((await bootOfLogin("dana")).canCreateApp).toBe(true);
    expect((await bootOfLogin("carol")).canCreateApp).toBe(true);
    expect((await bootOfLogin("mallory")).canCreateApp).toBe(false);
    expect((await bootOfLogin("octocat")).canCreateApp).toBe(false);
  });

  test("a deployment that cannot name one workspace advertises no create capability", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db));
    const boot = bootOf(
      await (
        await worker.fetch(
          await authedRequest("/index.html", "octocat", { accept: "text/html" }),
          env,
        )
      ).text(),
    );
    expect(boot.canCreateApp).toBe(false);
    expect(boot.workspaceRef).toBeUndefined();
    expect(boot.workspaceRequired).toBe(true);
  });
});

describe("the route-local member gate", () => {
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

  const USER_READ = /FROM users WHERE github_login/;

  test("the repository list fits in three reads: maintenance, access, and data", async () => {
    const { db } = tenancyFixture();
    const { observed, statements } = recordingDb(db);
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/api/targets", "mallory"),
      envFor(observed),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targets: Array<{ target_id: string }> };
    expect(body.targets.map((target) => target.target_id)).toEqual(["target-app-acme"]);
    const userReads = statements.filter((sql) => /\b(?:FROM|JOIN)\s+users\b/i.test(sql));
    expect(userReads).toHaveLength(1);
    expect(userReads[0]).toMatch(/\bworkspaces\b/i);
    expect(userReads[0]).toMatch(/\bworkspace_members\b/i);
    expect(statements).toHaveLength(3);
  });

  test("a mount without the session guard still resolves the user", async () => {
    const db = createMigratedTestD1();
    seedUser(db, "mallory", "member");
    const { observed, statements } = recordingDb(db);
    const bare = new Hono<{ Bindings: Env; Variables: DashboardVariables }>();
    bare.use("*", async (c, next) => {
      c.set("tenant", { ref: "default", workspaceId: "default", role: "owner", principal: "member" });
      c.set("workspaceScope", { workspaceId: "default", role: "owner" });
      await next();
    });
    bare.get("/gate", async (c) => {
      const gate = await requireMember(c);
      if (!gate.ok) return gate.response;
      return c.json({ login: gate.user.github_login, role: gate.scope.role });
    });
    const session = await createSessionValue("mallory", null, SESSION_SECRET);
    const res = await bare.fetch(
      new Request("https://worker.local/gate", {
        headers: { Cookie: `${SESSION_COOKIE}=${session}` },
      }),
      envFor(observed),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: "mallory", role: "owner" });
    expect(statements.filter((sql) => USER_READ.test(sql))).toHaveLength(1);
  });
});

describe("a mid-flight demotion cannot finish the flow", () => {
  const SLUG = "mstar-inspector-mallory";
  const CONVERSION = {
    id: 987654,
    name: SLUG,
    slug: SLUG,
    pem: "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----",
    webhook_secret: "not-a-real-webhook-secret",
  };

  function ownerThenDemote() {
    const db = createMigratedTestD1();
    const userId = seedUser(db, "mallory", "member");
    seedMembership(db, "default", userId, "owner");
    return { db, userId };
  }

  function demote(db: TestD1, userId: string): void {
    db.raw
      .prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'default' AND user_id = ?")
      .run(userId);
  }

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
    const env = envFor(db);
    const state = await createManifestStateValue(SESSION_SECRET, SLUG, "default");
    expect((await worker.fetch(await authedRequest("/dashboard/manifest/start", "mallory", { method: "POST" }), env)).status).toBe(200);
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
      expect(networkCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
    const rows = db.raw.query("SELECT COUNT(*) AS n FROM review_bots").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("a parked hold no longer renders the confirm page (or its commit form) after demotion", async () => {
    const { db, userId } = ownerThenDemote();
    const env = envFor(db);
    const hold = await encryptHoldValue(
      buildHoldPayload(CONVERSION, "mallory", SLUG, "default"),
      SESSION_SECRET,
    );
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
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
  });

  test("the same hold still resumes for a caller who is still owner", async () => {
    const { db } = ownerThenDemote();
    const env = envFor(db);
    const hold = await createHoldValue(CONVERSION, "mallory", SESSION_SECRET, SLUG, "default");
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
