/**
 * Apps management UI tests (plan 13 B5 T3, spec § Multi-App 契约 + § IA).
 *
 * `GET /dashboard/apps` is member-visible (slug, numeric App id, status,
 * creator — never the encrypted columns or row ids); the pinned POST action
 * paths `/dashboard/apps/:slug/disable|enable|delete` (architect: zero-JS
 * `<form method="post">` cannot emit a DELETE verb) are creator-or-admin
 * (Clarify #6). Disable/enable/soft-delete flows are bridged END-TO-END to
 * the T2 webhook face: a disabled or soft-deleted App's webhook route 404s,
 * a re-enabled one resolves again (401 on a bad signature proves the row
 * was found and passed to signature verification).
 *
 * The D1 double is the real bun:sqlite helper over migrations
 * 0001/0002 + 0003–0009 + 0012 (production-shaped, filename order — 0006 backs the
 * per-App config tables the settings page reads; 0008 is plan 16's per-App
 * ops columns behind the pause toggle and the install-health panel; 0009 is
 * plan 17's app_model_roles, read on every settings render by the Role
 * models editor).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../../src/worker/index";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { Env } from "../../src/worker/env";
import { createAppsStore, type GithubAppRow } from "../../src/dashboard/apps-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser, type DashboardD1 } from "../../src/dashboard/users";
import { createTestD1 } from "../store/helpers";
import { SPA_BOOT_MARKER, htmlGet, withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";
const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const TEST_WEBHOOK_SECRET = "test-app-webhook-secret";

/**
 * Real secretbox envelopes encrypted under TEST_KEY with the row-PK AAD
 * (T1 review pin). The UI routes treat the columns as opaque, but the
 * bridged webhook-face tests decrypt the webhook secret (T2 contract), so
 * the rows must be genuinely decryptable.
 */
async function encryptedColumns(id: string): Promise<{ privateKeyEnc: string; webhookSecretEnc: string }> {
  const box = createSecretbox(TEST_KEY);
  return {
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret(TEST_WEBHOOK_SECRET, `github_apps.webhook_secret_enc:${id}`),
  };
}

function createAppsUiD1(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  for (const name of [
    "0003_dashboard_users.sql",
    "0004_github_apps.sql",
    "0005_reviews_app_id.sql",
    "0006_app_provider_config.sql",
    "0007_reviews_app_id_index.sql",
    "0008_github_apps_ops.sql",
    "0009_app_model_roles.sql",
    "0011_webhook_deliveries.sql",
    "0012_custom_providers_and_key_updated_at.sql",
  ]) {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
  return db;
}

async function seedMember(db: DashboardD1, login: string, role: "admin" | "member"): Promise<void> {
  await createUser(db, { login, role });
}

async function seedApp(
  db: DashboardD1,
  opts: { slug: string; githubAppId: number; createdBy: string },
): Promise<GithubAppRow> {
  const id = crypto.randomUUID();
  const enc = await encryptedColumns(id);
  return createAppsStore(db).createApp({
    id,
    slug: opts.slug,
    githubAppId: opts.githubAppId,
    name: opts.slug,
    privateKeyEnc: enc.privateKeyEnc,
    webhookSecretEnc: enc.webhookSecretEnc,
    createdBy: opts.createdBy,
  });
}

/**
 * Seeded world (plan 12 membership semantics + plan 13 apps):
 *   octocat = admin; mallory owns her App; ada owns hers; hubot owns none.
 */
async function seededWorld(): Promise<ReturnType<typeof createTestD1>> {
  const db = createAppsUiD1();
  await seedMember(db, "octocat", "admin");
  await seedMember(db, "mallory", "member");
  await seedMember(db, "ada", "member");
  await seedMember(db, "hubot", "member");
  await seedApp(db, { slug: "mstar-inspector-mallory", githubAppId: 1001, createdBy: "mallory" });
  await seedApp(db, { slug: "mstar-inspector-ada", githubAppId: 1002, createdBy: "ada" });
  return db;
}

function makeEnv(db: unknown, overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    REVIEW_ENABLED: "true", // webhook-face bridge tests need the slug lookup to run
    DB: db,
    ...overrides,
  } as Env;
}

const sessionCookie = (login: string) => createSessionValue(login, null, SESSION_SECRET);

async function get(path: string, cookie: string, env: Env): Promise<Response> {
  return await worker.fetch(new Request(`https://worker.local${path}`, { headers: { Cookie: cookie } }), env);
}

// Plan 29 T6/T7: apps/settings HTML GETs are SPA-owned (shared spa helper).

async function post(path: string, cookie: string, env: Env): Promise<Response> {
  return await worker.fetch(
    new Request(`https://worker.local${path}`, { method: "POST", headers: { Cookie: cookie } }),
    env,
  );
}

function appStatus(db: ReturnType<typeof createAppsUiD1>, slug: string): string | null {
  const row = db.raw.query("SELECT status FROM github_apps WHERE slug = ?").get(slug) as {
    status: string;
  } | null;
  return row?.status ?? null;
}

/** The per-App pause switch column (migration 0008) straight from the row. */
function reviewEnabled(db: ReturnType<typeof createAppsUiD1>, slug: string): number | null {
  const row = db.raw.query("SELECT review_enabled FROM github_apps WHERE slug = ?").get(slug) as {
    review_enabled: number;
  } | null;
  return row?.review_enabled ?? null;
}

describe("GET /dashboard/apps (plan 33 T2: enumerated SPA route)", () => {
  test("HTML navigation GET is served by SPA dispatch (boot-injected index)", async () => {
    const db = await seededWorld();
    const res = await htmlGet("/dashboard/apps", `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, withSpaAssets(makeEnv(db)));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).toContain('"login":"hubot"');
    expect(body).toContain('"role":"member"');
  });

  test("a non-HTML GET without session is not a 301 alias", async () => {
    const db = await seededWorld();
    const res = await get("/dashboard/apps", "", makeEnv(db));
    expect(res.status).not.toBe(301);
  });

  test("GET /dashboard with a member session → SPA boot role member (no admin)", async () => {
    const db = await seededWorld();
    const shell = await get("/dashboard", `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, withSpaAssets(makeEnv(db)));
    expect(shell.status).toBe(200);
    const body = await shell.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).toContain('"login":"hubot"');
    expect(body).toContain('"role":"member"');
    expect(body).not.toContain('"role":"admin"');
  });
});

describe("POST /dashboard/apps/:slug/disable|enable|delete (pinned action paths)", () => {
  test("no session → 302 to login, zero mutation", async () => {
    const db = await seededWorld();
    const res = await post("/dashboard/apps/mstar-inspector-mallory/disable", "", makeEnv(db));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    expect(appStatus(db, "mstar-inspector-mallory")).toBe("active");
  });

  test("creator disables their app → 200, row disabled, the App's webhook route 404s (UI flow → T2 face)", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/disable", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(appStatus(db, "mstar-inspector-mallory")).toBe("disabled");
    // T2 contract through the UI action: the disabled App's webhook 404s
    // (slug lookup fails before any signature verification).
    const webhook = await post("/webhook/mstar-inspector-mallory", "", makeEnv(db));
    expect(webhook.status).toBe(404);
  });

  test("creator re-enables → active again; the webhook route resolves the row (401 on bad signature, not 404)", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    await apps.setAppStatus(
      (await apps.listApps()).find((a) => a.slug === "mstar-inspector-mallory")!.id,
      "disabled",
    );
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/enable", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(appStatus(db, "mstar-inspector-mallory")).toBe("active");
    const webhook = await post("/webhook/mstar-inspector-mallory", "", makeEnv(db));
    // Active + not deleted → the row resolved and the (missing) signature
    // fails verification: 401, NOT the 404 of an unknown/disabled app.
    expect(webhook.status).toBe(401);
  });

  test("admin manages another creator's app", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("octocat")}`;
    const res = await post("/dashboard/apps/mstar-inspector-ada/disable", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(appStatus(db, "mstar-inspector-ada")).toBe("disabled");
    const enable = await post("/dashboard/apps/mstar-inspector-ada/enable", cookie, makeEnv(db));
    expect(enable.status).toBe(200);
    expect(appStatus(db, "mstar-inspector-ada")).toBe("active");
  });

  test("non-creator member POST → 403, zero mutation", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("hubot")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/disable", cookie, makeEnv(db));
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("restricted to dashboard admins");
    expect(appStatus(db, "mstar-inspector-mallory")).toBe("active");
  });

  test("creator of a DIFFERENT app POST → 403, zero mutation (creator scope is per-App)", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("ada")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/disable", cookie, makeEnv(db));
    expect(res.status).toBe(403);
    expect(appStatus(db, "mstar-inspector-mallory")).toBe("active");
  });

  test("unknown slug → 404, zero side effects", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("octocat")}`;
    for (const path of [
      "/dashboard/apps/no-such-app/disable",
      "/dashboard/apps/no-such-app/enable",
      "/dashboard/apps/no-such-app/delete",
    ]) {
      const res = await post(path, cookie, makeEnv(db));
      expect(res.status).toBe(404);
    }
  });

  test("delete → soft delete: row stamped, webhook route 404s, further manage POSTs 404", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/delete", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    // Soft delete (Clarify #4): the row remains in D1 with deleted_at stamped.
    const row = db.raw
      .query("SELECT deleted_at FROM github_apps WHERE slug = 'mstar-inspector-mallory'")
      .get() as { deleted_at: string | null };
    expect(row.deleted_at).not.toBeNull();
    // The brief's bridged AC: the deleted app's webhook route 404s (T2).
    const webhook = await post("/webhook/mstar-inspector-mallory", "", makeEnv(db));
    expect(webhook.status).toBe(404);
    // Managing a deleted app is 404 — it no longer exists for the UI.
    const manage = await post("/dashboard/apps/mstar-inspector-mallory/disable", cookie, makeEnv(db));
    expect(manage.status).toBe(404);
  });
});

describe("POST /dashboard/apps/:slug/pause|resume (plan 16, per-App review pause)", () => {
  test("guard covers the pinned routes: no session → 302 to login, zero mutation", async () => {
    const db = await seededWorld();
    for (const path of ["pause", "resume"]) {
      const res = await post(`/dashboard/apps/mstar-inspector-mallory/${path}`, "", makeEnv(db));
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard/login");
    }
    expect(reviewEnabled(db, "mstar-inspector-mallory")).toBe(1);
  });

  test("creator pauses → 200, review_enabled=0 (the SPA refetches the JSON face for the paused badge)", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/pause", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(reviewEnabled(db, "mstar-inspector-mallory")).toBe(0);
  });

  test("pausing leaves the webhook CONNECTED (pause ≠ disable): the route still resolves and verifies — 401 on a bad signature, not 404", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    await post("/dashboard/apps/mstar-inspector-mallory/pause", cookie, makeEnv(db));
    const webhook = await post("/webhook/mstar-inspector-mallory", "", makeEnv(db));
    expect(webhook.status).toBe(401);
    expect(reviewEnabled(db, "mstar-inspector-mallory")).toBe(0);
  });

  test("creator resumes → 200, review_enabled=1", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    await apps.setReviewEnabled(
      (await apps.listApps()).find((a) => a.slug === "mstar-inspector-mallory")!.id,
      false,
    );
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/resume", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(reviewEnabled(db, "mstar-inspector-mallory")).toBe(1);
  });

  test("pausing an already-paused app is an idempotent no-op — 200, zero mutation", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    await post("/dashboard/apps/mstar-inspector-mallory/pause", cookie, makeEnv(db));
    const res = await post("/dashboard/apps/mstar-inspector-mallory/pause", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(reviewEnabled(db, "mstar-inspector-mallory")).toBe(0);
  });

  test("resuming an active app is an idempotent no-op — 200, zero mutation", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/resume", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(reviewEnabled(db, "mstar-inspector-mallory")).toBe(1);
  });

  test("authz matrix: another member → 403 zero mutation; the creator of a DIFFERENT app → 403 (scope is per-App)", async () => {
    const db = await seededWorld();
    for (const login of ["hubot", "ada"]) {
      const res = await post(
        "/dashboard/apps/mstar-inspector-mallory/pause",
        `${SESSION_COOKIE}=${await sessionCookie(login)}`,
        makeEnv(db),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("restricted to dashboard admins");
      expect(reviewEnabled(db, "mstar-inspector-mallory")).toBe(1);
    }
  });

  test("admin (non-creator) may pause and resume another creator's app", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("octocat")}`;
    const pause = await post("/dashboard/apps/mstar-inspector-ada/pause", cookie, makeEnv(db));
    expect(pause.status).toBe(200);
    expect(await pause.text()).toBe("ok");
    expect(reviewEnabled(db, "mstar-inspector-ada")).toBe(0);
    const resume = await post("/dashboard/apps/mstar-inspector-ada/resume", cookie, makeEnv(db));
    expect(resume.status).toBe(200);
    expect(reviewEnabled(db, "mstar-inspector-ada")).toBe(1);
  });

  test("unknown slug → 404; soft-deleted app → 404, zero side effects", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("octocat")}`;
    for (const path of ["/dashboard/apps/no-such-app/pause", "/dashboard/apps/no-such-app/resume"]) {
      const res = await post(path, cookie, makeEnv(db));
      expect(res.status).toBe(404);
    }
    await apps.softDeleteApp((await apps.listApps()).find((a) => a.slug === "mstar-inspector-mallory")!.id);
    for (const path of [
      "/dashboard/apps/mstar-inspector-mallory/pause",
      "/dashboard/apps/mstar-inspector-mallory/resume",
    ]) {
      const res = await post(path, cookie, makeEnv(db));
      expect(res.status).toBe(404);
    }
  });

});

describe("GET /dashboard/apps/:slug/settings (plan 29 T6: SPA-owned)", () => {
  const SETTINGS = "/dashboard/apps/mstar-inspector-mallory/settings";
  const ownerCookie = async () => `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;

  test("HTML navigation GET is served by SPA dispatch (boot-injected index)", async () => {
    const db = await seededWorld();
    const res = await htmlGet(SETTINGS, await ownerCookie(), withSpaAssets(makeEnv(db)));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("the legacy SSR handler is gone: a non-HTML GET falls through to the legacy app (guard 302, never the old HTML)", async () => {
    const db = await seededWorld();
    const res = await get(SETTINGS, "", makeEnv(db));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });
});
