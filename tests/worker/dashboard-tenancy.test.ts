/**
 * Workspace (tenant) routing + authorization (migration 0026 data plane).
 *
 * There is exactly one route family: the workspace named by the first path
 * segment. The retired pre-workspace App family answers 404, and authorization
 * is decided by the actor's workspace role. The routing gate only CLASSIFIES
 * the slug — the workspace row and the membership are resolved after the
 * session/user read, so an anonymous request learns nothing about slug
 * existence (pinned below).
 *
 * The fixture runs against the full migration set (the store helper walks
 * `migrations/`), so 0026/0027 are real: `default` is seeded by 0026 and the
 * backfill is a no-op because the rows are inserted afterwards. Every
 * workspace here is explicit, which keeps the role matrix readable.
 */
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
 * Renders the REAL Members page (chrome included) at `<pathname>` from one boot
 * and returns every href it emits. Members is workspace-scoped,
 * so the pathname names the workspace ref. The SPA tree is imported through a
 * computed specifier: the root tsconfig keeps `src/spa` out of this program
 * (it targets the Workers lib, not the DOM), so a static import would drag the
 * browser sources into a typecheck that has no `document`.
 */
async function renderMembersHrefs(boot: SpaBoot, pathname = "/dashboard/default/members"): Promise<string[]> {
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

/** The `users.id` of an already-seeded login (membership fixtures). */
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
 * `:workspaceRef` off these names — a capture regression would serve the App.
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

describe("the pre-workspace App face is retired", () => {
  test("every legacy App path answers 404", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
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
      envFor(db),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("the workspace settings page serves the shell scoped to its workspace", async () => {
    // `/dashboard/<ref>/settings` is an enumerated SPA page, not a worker
    // route, so the only thing that serves it is `spaDispatch`'s workspace
    // grammar. The status is the discriminating assertion: drop `settings`
    // from `WORKSPACE_FAMILY_SEGMENTS` and the path matches no SPA route and
    // no worker route, so it falls through to a 404. `workspaceRef` alone
    // would not fail — the boot falls back to the login's sole membership.
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
      envFor(observed),
    );
    expect(res.status).toBe(302);
    expect(statements.filter((sql) => sql.includes("FROM workspaces"))).toEqual([]);
  });
});

describe("workspace paths serve", () => {
  test("the workspace list serves its members and lists only its own Apps", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const res = await worker.fetch(await authedRequest("/dashboard/acme/api/apps", "mallory"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewer: { login: string }; apps: Array<{ slug: string }> };
    expect(body.viewer.login).toBe("mallory");
    expect(body.apps.map((app) => app.slug)).toEqual(["acme-app"]);
  });

  test("the workspace onboarding page serves managers and 403s a plain member", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
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
    const env = envFor(db);
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/other-app/onboarding", "dana"),
      env,
    );
    expect(res.status).toBe(404);
  });

  test("a signed-in non-member sees 404, not the workspace", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    // bob owns `other`; he has no membership in `acme`.
    const res = await worker.fetch(await authedRequest("/dashboard/acme/api/apps", "bob"), env);
    expect(res.status).toBe(404);
  });

  test("an unknown workspace slug answers 404", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/ghost/api/apps", "octocat"),
      envFor(db),
    );
    expect(res.status).toBe(404);
  });

  test("the workspace id resolves exactly like its slug", async () => {
    // The workspace-identifier work (2026-10): the segment is a ref —
    // `ws-acme` is the row id, `acme` its slug; both name the same workspace,
    // for the same member.
    const { db } = tenancyFixture();
    const env = envFor(db);
    const list = async (ref: string) => {
      const res = await worker.fetch(await authedRequest(`/dashboard/${ref}/api/apps`, "dana"), env);
      expect(res.status, ref).toBe(200);
      return (await res.json()) as { apps: Array<{ slug: string }> };
    };
    const byId = await list("ws-acme");
    expect(byId.apps.map((app) => app.slug)).toEqual(["acme-app"]);
    expect(await list("acme")).toEqual(byId);
  });

  test("a ref that names two workspaces answers 404 and warns (never picks one)", async () => {
    // A slug equal to ANOTHER workspace's id is the only way the single read
    // can return two rows. Here `ws-acme`'s slug becomes `dup` while a second
    // workspace IS `dup`; `dana` owns `ws-acme`, so picking that row would
    // answer 200 — the 404 is the exactly-one-row rule, the cross-tenant backstop.
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
    // The gate answers a retired route family before any session or membership
    // read. HTML navigation must render the member gate's page, not bare text.
    const { db } = tenancyFixture();
    const env = envFor(db);
    const path = "/dashboard/apps";
    const page = await worker.fetch(
      await authedRequest(path, "octocat", { accept: "text/html" }),
      env,
    );
    expect(page.status, path).toBe(404);
    expect(page.headers.get("Content-Type"), path).toContain("text/html");
    expect(await page.text(), path).toContain(t("en", "common.error.notFoundTitle"));
    const api = await worker.fetch(await authedRequest(path, "octocat"), env);
    expect(api.status, path).toBe(404);
    // The fetch contract is the status and its content type — never Hono's
    // exact default body text (I-000087: that pin is not ours to keep).
    expect(api.headers.get("Content-Type"), path).toStartWith("text/plain");
    expect(await api.text(), path).not.toContain(t("en", "common.error.notFoundTitle"));
  });

  test("non-App routes keep serving under strict; the retired root members API is gone", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
    const locale = await worker.fetch(await authedRequest("/dashboard/login", "octocat"), env);
    expect(locale.status).toBe(302);
    // The deployment-level member face is retired: it answers 404 on both
    // faces (the workspace one below is the only member surface left).
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

  test("the deployment-level settings path is retired (404, not a second authz rule)", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/apps/acme-app/settings", "carol", {
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

  test("a native settings form post answers 302 to the workspace-prefixed settings URL", async () => {
    const { db } = tenancyFixture();
    const env = envFor(db);
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
    const env = envFor(db);
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
    const env = envFor(db);
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
    const env = envFor(db);
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

  test("a native settings post on the retired deployment path answers 404 in the workspace family", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/apps/acme-app/settings", "octocat", {
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

  test("a fetch POST on an invisible App answers the plain 404 body", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/other-app/disable", "dana", { method: "POST" }),
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

  test("a workspace App page still serves with ASSETS bound", async () => {
    const { db } = tenancyFixture();
    const env = withSpaAssets(envFor(db));
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
      // The shell derives its API base from THIS pathname: every read and link
      // on the page hangs off /dashboard/acme (the legacy App family 404s here).
      expect(apiBase(path), path).toBe("/dashboard/acme");
    }
  });

  test("the workspace Members shell serves and keeps its nav inside the workspace", async () => {
    // Members is workspace-routed: the pathname names the
    // workspace, so every nav target stays inside it.
    // 0026 seeds `default`; this fixture adds the membership on top of it.
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
    // spaClick → pushState changes the pathname but NOT `window.__BOOT__`, so a
    // boot that omitted the slug on workspace pages would strand Members on the
    // legacy targets the moment the admin clicked through (I-000072).
    // A deployment ADMIN carries the Members entry; 0026 seeds `default` as
    // the sole live workspace, so it is also what the server resolves.
    const db = createMigratedTestD1();
    seedMembership(db, "default", seedUser(db, "octocat", "admin"), "owner");
    const res = await worker.fetch(
      await authedRequest("/dashboard/default/apps", "octocat", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.workspaceRef).toBe("default");
    // The Members PAGE the click lands on, rendered from THAT boot: the
    // sidebar hrefs are read off the markup, not off the model behind it.
    const hrefs = await renderMembersHrefs(boot);
    expect(hrefs).toContain("/dashboard/default/apps");
    expect(hrefs).toContain("/dashboard/default/members");
    expect(hrefs).not.toContain("/dashboard/apps");
  });

  test("the direct /index.html shell names the sole workspace too (N1)", async () => {
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
    for (const path of ["/dashboard/apps", "/dashboard/apps/acme-app/settings"]) {
      const res = await worker.fetch(
        await authedRequest(path, "octocat", { accept: "text/html" }),
        env,
      );
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("window.__BOOT__");
    }
  });
});

describe("the post-authentication landing is the workspace Apps page", () => {
  /** ONE live workspace — the M1 shape `getSoleWorkspace` resolves. */
  function soleWorkspaceFixture() {
    const db = createMigratedTestD1();
    const userId = seedUser(db, "octocat", "admin");
    seedMembership(db, "default", userId, "owner");
    return { db };
  }

  test("a signed-in HTML GET /dashboard 302s to the workspace Apps list, not the legacy root", async () => {
    const { db } = soleWorkspaceFixture();
    const env = withSpaAssets(envFor(db));
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
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("an already-signed-in login bounce lands on the same workspace Apps page", async () => {
    const { db } = soleWorkspaceFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/login", "octocat"),
      envFor(db),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/apps");
  });

  test("several live workspaces → the login's own first membership, never the retired /dashboard/apps", async () => {
    // `octocat` belongs to `ws-acme` only, so the deployment's non-sole shape
    // no longer strands them: the landing names their membership (ordered by
    // name, then id — stable), which is a real route.
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard", "octocat", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(302);
    // The emitted ref is the workspace ID, never the mutable slug.
    expect(res.headers.get("Location")).toBe("/dashboard/ws-acme/apps");
    expect(res.headers.get("Location")).not.toBe("/dashboard/apps");
  });

  test("a login with TWO memberships lands on the first one and keeps the switcher", async () => {
    const { db, users } = tenancyFixture();
    // `dana` owns `ws-acme`; give them `ws-other` too (membership order is
    // name, then id → `acme` still sorts first).
    seedMembership(db, "ws-other", users.wsOwner, "admin");
    const res = await worker.fetch(
      await authedRequest("/dashboard", "dana", { accept: "text/html" }),
      withSpaAssets(envFor(db)),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/ws-acme/apps");

    // The shell that redirect lands on still offers both workspaces.
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

describe("a workspace URL never carries a value its owner can change", () => {
  test("a ref-less shell boot names the sole workspace by id", async () => {
    // `/index.html` carries no workspace segment, so the boot's ref comes from
    // the server-resolved sole workspace — and that value is the id, never the
    // readable slug a platform operator can change.
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
    // The sidebar follows that ref, so no nav target carries the slug.
    const hrefs = await renderMembersHrefs(boot, "/index.html");
    expect(hrefs).toContain("/dashboard/ws-acme/apps");
    expect(hrefs).not.toContain("/dashboard/acme/apps");
  });

  test("a renamed slug still serves the same workspace, while the emitted ref is the id", async () => {
    // `ws-acme` is renamed from `acme` to `acme-labs` after the links went out.
    // The slug branch of the resolver keeps the old URL working; everything the
    // Worker EMITS names the id, which the rename never touched.
    const { db } = tenancyFixture();
    seed(db, "UPDATE workspaces SET slug = 'acme-labs' WHERE id = 'ws-acme'");
    const env = withSpaAssets(envFor(db));

    for (const ref of ["acme", "acme-labs", "ws-acme"]) {
      const shell = await worker.fetch(
        await authedRequest(`/dashboard/${ref}/apps`, "dana", { accept: "text/html" }),
        env,
      );
      expect(shell.status, ref).toBe(200);
      const boot = bootOf(await shell.text());
      // Every addressed form resolves the SAME workspace. A workspace-scoped
      // pathname still wins the boot's own ref (path-derived, unchanged), and
      // the row it names rides both identifiers.
      expect(boot.workspaceRef, ref).toBe(ref);
      const row = boot.memberships?.find((m) => m.id === "ws-acme");
      expect(row?.slug, ref).toBe("acme-labs");
      // What the shell EMITS for that row is the id.
      expect(
        buildWorkspaceSwitcherModel(boot, `/dashboard/${ref}/apps`)?.options.map((option) => option.ref),
        ref,
      ).toEqual(["ws-acme"]);
    }

    // The landing redirect is id-based too, so nothing emits the renamed slug.
    const landing = await worker.fetch(
      await authedRequest("/dashboard", "dana", { accept: "text/html" }),
      env,
    );
    expect(landing.status).toBe(302);
    expect(landing.headers.get("Location")).toBe("/dashboard/ws-acme/apps");
  });
});

describe("a login with no workspace gets the creation surface", () => {
  /** A signed-in users row with no membership anywhere. */
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
    // No workspace to name: no nav target may point at a workspace path.
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
    // The sidebar drops Apps/Members — both would 404 for this login — and the
    // page offers the one action that changes that.
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
    // The 201 names the landing: with 0026's `default` workspace already
    // present, sole-workspace resolution cannot pick the new one out, so
    // `/dashboard` would strand the creator on a slug-less shell.
    const created = (await res.json()) as { slug: string; appsPath: string };
    expect(created.appsPath).toBe(`/dashboard/${created.slug}/apps`);

    // The new membership is real: the login now reaches that workspace's own
    // pages (the outsider 404 is gone) and the boot no longer offers creation.
    const shell = await worker.fetch(
      await authedRequest(`/dashboard/${created.slug}/apps`, "newcomer", {
        accept: "text/html",
      }),
      withSpaAssets(envFor(db)),
    );
    expect(shell.status).toBe(200);
    const boot = bootOf(await shell.text());
    expect(boot.needsWorkspace).toBeUndefined();
    expect(boot.workspaceRef).toBe(created.slug);
    const api = await worker.fetch(
      await authedRequest(`/dashboard/${created.slug}/api/members`, "newcomer"),
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
    expect(res.headers.get("Location")).toBe("/dashboard/default/apps");
  });
});

describe("the onboarding CTA stays inside the workspace", () => {
  test("the Open Settings CTA targets the workspace settings page", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/acme-app/onboarding", "dana"),
      envFor(db),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="/dashboard/acme/apps/acme-app/settings"');
    expect(body).not.toContain('href="/dashboard/apps/acme-app/settings"');
  });

  test("the retired deployment-level onboarding path is a 404", async () => {
    const { db } = tenancyFixture();
    const res = await worker.fetch(
      await authedRequest("/dashboard/apps/acme-app/onboarding", "octocat"),
      envFor(db),
    );
    expect(res.status).toBe(404);
  });
});

describe("App creation is owner/admin", () => {
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

  /** POST /dashboard/manifest/commit carrying a parked hold cookie. */
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
      // octocat is a DEPLOYMENT admin but a workspace member: the workspace
      // role decides, exactly as the scoped canManageApp does.
      const res = await post(login, "/dashboard/manifest/start", env);
      expect(res.status, login).toBe(403);
      expect(await res.text(), login).toContain(t("en", "common.error.forbiddenTitle"));
      expect(res.headers.getSetCookie(), login).toEqual([]);
    }
  });

  test("the commit recovery route applies the same gate once a hold names its workspace", async () => {
    const { db } = soleWorkspaceRoles();
    const env = envFor(db);
    // With no hold there is no flow and no target workspace: the route's
    // long-standing "flow expired" bounce (302 to the shell, zero writes)
    // answers before any permission read.
    const noHold = await post("mallory", "/dashboard/manifest/commit", env);
    expect(noHold.status).toBe(302);
    expect(noHold.headers.get("Location")).toBe("/dashboard");
    // With a hold naming the sole workspace, the member is refused (403) and
    // the hold survives, so restoring the role makes the resubmit work.
    const hold = await createHoldValue(CONVERSION, "mallory", SESSION_SECRET, SLUG, "default");
    const member = await postWithHold("mallory", hold, env);
    expect(member.status).toBe(403);
    expect(await member.text()).toContain(t("en", "common.error.forbiddenTitle"));
    expect(member.headers.getSetCookie().some((c) => c.includes("Max-Age=0"))).toBe(false);
    // The owner clears the gate and commits into the workspace the hold names.
    const owner = await postWithHold("dana", await createHoldValue(CONVERSION, "dana", SESSION_SECRET, SLUG, "default"), env);
    expect(owner.status).toBe(302);
    expect(owner.headers.get("Location")).toBe(`/dashboard/default/apps/${SLUG}/onboarding`);
  });

  test("a no-ref manifest start on a multi-workspace deployment answers a readable 409 workspace_required", async () => {
    // `tenancyFixture` carries several live workspaces and the deployment-level
    // start route names none, so no attribution exists. That is missing input,
    // not a permission answer: 409 + a JSON code for a fetch, the styled error
    // page for navigation — never the bare 403 that hid the Create action.
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
    // Two live workspaces. `dana` owns `other` and is a plain member of `acme`;
    // `carol` is an admin of `acme` and nothing in `other`. The deployment's
    // sole-workspace rule cannot answer at all here, which is the regression:
    // each request must be judged against the ref it names.
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-acme", "acme");
    seedWorkspace(db, "ws-other", "other");
    const dana = seedUser(db, "dana", "member");
    seedMembership(db, "ws-acme", dana, "member");
    seedMembership(db, "ws-other", dana, "owner");
    seedMembership(db, "ws-acme", seedUser(db, "carol", "member"), "admin");

    const env = envFor(db);
    // Owner of W2 creates in W2.
    const owner = await post("dana", "/dashboard/other/manifest/start", env);
    expect(owner.status).toBe(200);
    expect(await owner.text()).toContain("https://github.com/settings/apps/new");
    // …and is refused in W1, where they are only a member.
    const memberElsewhere = await post("dana", "/dashboard/acme/manifest/start", env);
    expect(memberElsewhere.status).toBe(403);
    expect(await memberElsewhere.text()).toContain(t("en", "common.error.forbiddenTitle"));
    // The admin of W2 may create there; the same login is a non-member of W1.
    expect((await post("carol", "/dashboard/acme/manifest/start", env)).status).toBe(200);
    expect((await post("carol", "/dashboard/other/manifest/start", env)).status).toBe(403);
  });

  test("the manifest flow carries the target workspace end to end: start → callback → commit into W2, and W1 cannot read the App (404)", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-acme", "acme");
    seedWorkspace(db, "ws-other", "other");
    // `dana` owns BOTH, so only the REF can decide where the App lands.
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
      expect(callback.headers.get("Location")).toBe("/dashboard/ws-other/apps/mstar-inspector-dana/onboarding");
    } finally {
      globalThis.fetch = realFetch;
    }
    // The App is mapped into the workspace the flow named — not into `acme`,
    // and not into some "sole" workspace.
    const mapping = db.raw
      .prepare("SELECT app_workspaces.workspace_id AS ws FROM app_workspaces JOIN github_apps ON github_apps.id = app_workspaces.app_id WHERE github_apps.github_app_id = ?")
      .get(CONVERSION.id) as { ws: string } | null;
    expect(mapping?.ws).toBe("ws-other");
    // The READ is tenant-scoped too, for the very row this flow created: the
    // owning workspace serves it, and the sibling — same session, same slug —
    // answers the settings-family 404 (invisible, not merely forbidden).
    const ownerRead = await worker.fetch(
      await authedRequest("/dashboard/other/apps/mstar-inspector-dana/onboarding", "dana", {
        accept: "text/html",
      }),
      env,
    );
    expect(ownerRead.status).toBe(200);
    expect(await ownerRead.text()).toContain("mstar-inspector-dana");
    const siblingRead = await worker.fetch(
      await authedRequest("/dashboard/acme/apps/mstar-inspector-dana/onboarding", "dana", {
        accept: "text/html",
      }),
      env,
    );
    expect(siblingRead.status).toBe(404);
    expect(siblingRead.headers.get("Location")).toBeNull();
  });

  test("a workspace RENAMED mid-flow still receives the App (the flow binds the stable id, not the slug)", async () => {
    // F-001: the state/hold must not carry a mutable identity. Start in `acme`,
    // rename it to `acme-renamed` before GitHub redirects back, and — the worse
    // half of the same bug — let a NEW workspace take the freed `acme` slug. A
    // slug-bound flow would attribute the App to that stranger; the id-bound
    // flow must still land it in the original workspace.
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

    // The rename, plus a squatter on the freed slug.
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
      // The redirect names the workspace's stable ID — not the slug the flow
      // started with, and not the one a squatter has since taken.
      expect(callback.headers.get("Location")).toBe(
        "/dashboard/ws-acme/apps/mstar-inspector-dana/onboarding",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    const mapping = db.raw
      .prepare("SELECT app_workspaces.workspace_id AS ws FROM app_workspaces JOIN github_apps ON github_apps.id = app_workspaces.app_id WHERE github_apps.github_app_id = ?")
      .get(CONVERSION.id) as { ws: string } | null;
    // The App belongs to the ORIGINAL workspace — the one that owns the id —
    // and emphatically not to `ws-squatter`, which merely holds the old slug.
    expect(mapping?.ws).toBe("ws-acme");
  });

  test("a workspace DELETED mid-flow answers the named workspaceGone error, not a bare shell redirect", async () => {
    // The concurrent delete: the callback's creation check and the commit both
    // pass on a live workspace, and the retirement lands before the
    // post-commit slug read that names the landing page. The flow must say so,
    // not quietly drop the operator on `/dashboard`.
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-acme", "acme");
    seedMembership(db, "ws-acme", seedUser(db, "dana", "member"), "owner");

    const start = await post("dana", "/dashboard/acme/manifest/start", envFor(db));
    expect(start.status).toBe(200);
    const stateCookie =
      start.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_STATE_COOKIE}=`)) ?? "";
    const state = (stateCookie.split(";")[0] ?? "").slice(MANIFEST_STATE_COOKIE.length + 1);

    // `getWorkspaceByRef`'s SELECT is unique to the post-commit landing read,
    // so retiring the row here is exactly the mid-flow deletion.
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
    // The App row was written before the workspace vanished: the named failure
    // is about the missing landing page, not about a lost write.
    const row = db.raw
      .prepare("SELECT COUNT(*) AS n FROM github_apps WHERE github_app_id = ?")
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
    // Without D1 nothing can attribute the App: the dashboard face already
    // fails closed on the missing binding before the route runs, so the flow
    // never starts and no slug/state cookie is minted.
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
    // Owner/admin → true (the key is present, not merely defaulted).
    expect((await bootOfLogin("dana")).canCreateApp).toBe(true);
    expect((await bootOfLogin("carol")).canCreateApp).toBe(true);
    // Plain member → explicitly false.
    expect((await bootOfLogin("mallory")).canCreateApp).toBe(false);
    expect((await bootOfLogin("octocat")).canCreateApp).toBe(false);
  });

  test("a deployment that cannot name one workspace advertises no create capability", async () => {
    // Several live workspaces ⇒ no sole workspace to attribute a new App to.
    // `/index.html` is the shell document with no workspace-scoped pathname, so
    // the boot's only workspace source is the server-resolved sole workspace.
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
    // The shell names the missing input, so the disabled Create control can
    // explain itself instead of vanishing.
    expect(boot.workspaceRequired).toBe(true);
  });
});

describe("the route-local member gate", () => {
  /**
   * Every statement the request prepares, in order. The session guard and
   * `requireMember` both read the caller's `users` row, so the count of
   * `users` lookups is the read the request actually pays twice.
   */
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

  test("a workspace route reads the users row once per request", async () => {
    const { db } = tenancyFixture();
    const { observed, statements } = recordingDb(db);
    const res = await worker.fetch(
      await authedRequest("/dashboard/acme/api/apps", "mallory"),
      envFor(observed),
    );
    // The route still answers with the caller's own identity and workspace.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewer: { login: string }; apps: Array<{ slug: string }> };
    expect(body.viewer.login).toBe("mallory");
    expect(body.apps.map((app) => app.slug)).toEqual(["acme-app"]);
    // The guard already read this row; the gate must not read it again.
    expect(statements.filter((sql) => USER_READ.test(sql))).toHaveLength(1);
  });

  test("a mount without the session guard still resolves the user", async () => {
    // The fallback half: no guard ran, so `authUser` is absent from the
    // context and the gate reads the row for itself. A mount that skipped
    // that read would answer `undefined` instead of the caller.
    const db = createMigratedTestD1();
    seedUser(db, "mallory", "member");
    const { observed, statements } = recordingDb(db);
    const bare = new Hono<{ Bindings: Env; Variables: DashboardVariables }>();
    // The workspace-scope verdict without the guard that usually precedes it.
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
    const env = envFor(db);
    const state = await createManifestStateValue(SESSION_SECRET, SLUG, "default");
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
    // The hold is burned: a demoted operator keeps no resumable credential.
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
