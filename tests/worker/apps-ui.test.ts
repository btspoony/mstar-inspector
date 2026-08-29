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
 * 0001/0002 + 0003/0004/0005 (production-shaped, filename order).
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
    APP_ID: "123",
    PRIVATE_KEY: "private-key",
    WEBHOOK_SECRET: "s3cret-webhook-secret",
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

describe("GET /dashboard/apps (plan 13 B5 T3, member-visible list)", () => {
  test("guard covers the new route family: no session → 302 to login", async () => {
    const res = await get("/dashboard/apps", "", makeEnv(await seededWorld()));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("member list shows slug, numeric App id, status, creator — never encrypted columns or row ids", async () => {
    const db = await seededWorld();
    const res = await get("/dashboard/apps", `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<strong>mstar-inspector-mallory</strong>");
    expect(body).toContain('<span class="id">1001</span>');
    expect(body).toContain("by mallory");
    expect(body).toContain('<span class="id">1002</span>');
    expect(body).toContain("by ada");
    // Active badge is the gray token; encrypted payloads and row ids never render.
    expect(body).toContain('<span class="status">active</span>');
    expect(body).not.toContain(TEST_WEBHOOK_SECRET);
    expect(body).not.toContain("private_key_enc");
    const rowIds = db.raw.query("SELECT id FROM github_apps").all() as Array<{ id: string }>;
    for (const { id } of rowIds) expect(body).not.toContain(id);
    // Primary create action (blue-700) per spec § DESIGN.md 意图.
    expect(body).toContain('action="/dashboard/manifest/start"');
    expect(body).toContain('<button type="submit" class="primary">Create GitHub App</button>');
  });

  test("disabled apps render the amber badge; soft-deleted apps are not listed", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    await apps.setAppStatus((await apps.listApps()).find((a) => a.slug === "mstar-inspector-mallory")!.id, "disabled");
    await apps.softDeleteApp((await apps.listApps()).find((a) => a.slug === "mstar-inspector-ada")!.id);
    const res = await get("/dashboard/apps", `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, makeEnv(db));
    const body = await res.text();
    expect(body).toContain('<span class="note">disabled</span>');
    expect(body).not.toContain("mstar-inspector-ada");
    expect(body).toContain("mstar-inspector-mallory");
  });

  test("manage = admin or creator (Clarify #6): admin sees controls on every row; a member without creations sees none", async () => {
    const db = await seededWorld();
    const admin = await get("/dashboard/apps", `${SESSION_COOKIE}=${await sessionCookie("octocat")}`, makeEnv(db));
    const adminBody = await admin.text();
    expect(adminBody).toContain('action="/dashboard/apps/mstar-inspector-mallory/disable"');
    expect(adminBody).toContain('action="/dashboard/apps/mstar-inspector-mallory/delete"');
    expect(adminBody).toContain('action="/dashboard/apps/mstar-inspector-ada/disable"');
    expect(adminBody).toContain('action="/dashboard/apps/mstar-inspector-ada/delete"');

    const outsider = await get("/dashboard/apps", `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, makeEnv(db));
    const outsiderBody = await outsider.text();
    expect(outsiderBody).not.toContain("/disable");
    expect(outsiderBody).not.toContain("/enable");
    expect(outsiderBody).not.toContain("/delete");
  });

  test("creator (non-admin) sees controls on their own row only", async () => {
    const db = await seededWorld();
    const res = await get("/dashboard/apps", `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('action="/dashboard/apps/mstar-inspector-mallory/disable"');
    expect(body).toContain('action="/dashboard/apps/mstar-inspector-mallory/delete"');
    expect(body).not.toContain("/dashboard/apps/mstar-inspector-ada/disable");
    expect(body).not.toContain("/dashboard/apps/mstar-inspector-ada/delete");
    expect(body).not.toContain("/dashboard/apps/mstar-inspector-ada/enable");
  });

  test("the shell header gains the member-visible Apps entry (non-admin shell stays Members-free)", async () => {
    const db = await seededWorld();
    const shell = await get("/dashboard", `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, makeEnv(db));
    expect(shell.status).toBe(200);
    const body = await shell.text();
    expect(body).toContain('<a href="/dashboard/apps">Apps</a>');
    expect(body).not.toContain("/dashboard/members");
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

  test("creator disables their app → 200 notice, row disabled, the App's webhook route 404s (UI flow → T2 face)", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/disable", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Disabled mstar-inspector-mallory.");
    expect(appStatus(db, "mstar-inspector-mallory")).toBe("disabled");
    // The disabled row now offers Enable (not Disable) to its manager.
    expect(body).toContain('action="/dashboard/apps/mstar-inspector-mallory/enable"');
    expect(body).not.toContain('action="/dashboard/apps/mstar-inspector-mallory/disable"');
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
    expect(await res.text()).toContain("Enabled mstar-inspector-mallory.");
    expect(appStatus(db, "mstar-inspector-mallory")).toBe("active");
    const webhook = await post("/webhook/mstar-inspector-mallory", "", makeEnv(db));
    // Active + not deleted → the row resolved and the (missing) signature
    // fails verification: 401, NOT the 404 of an unknown/disabled app.
    expect(webhook.status).toBe(401);
  });

  test("admin manages another creator's app; the acting admin also sees their controls honored", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("octocat")}`;
    const res = await post("/dashboard/apps/mstar-inspector-ada/disable", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Disabled mstar-inspector-ada.");
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

  test("delete → soft delete: gone from the list, webhook route 404s, further manage POSTs 404", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/delete", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Deleted mstar-inspector-mallory.");
    // Soft delete (Clarify #4): the row remains in D1 with deleted_at stamped.
    const row = db.raw
      .query("SELECT deleted_at FROM github_apps WHERE slug = 'mstar-inspector-mallory'")
      .get() as { deleted_at: string | null };
    expect(row.deleted_at).not.toBeNull();
    expect(body).not.toContain("<strong>mstar-inspector-mallory</strong>");
    // The brief's bridged AC: the deleted app's webhook route 404s (T2).
    const webhook = await post("/webhook/mstar-inspector-mallory", "", makeEnv(db));
    expect(webhook.status).toBe(404);
    // Managing a deleted app is 404 — it no longer exists for the UI.
    const manage = await post("/dashboard/apps/mstar-inspector-mallory/disable", cookie, makeEnv(db));
    expect(manage.status).toBe(404);
  });
});
