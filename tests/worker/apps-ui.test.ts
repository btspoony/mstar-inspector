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
import { createAppConfigStore } from "../../src/dashboard/app-config-store";
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
    "0006_app_provider_config.sql",
    "0007_reviews_app_id_index.sql",
    "0008_github_apps_ops.sql",
    "0009_app_model_roles.sql",
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

/** The per-App pause switch column (migration 0008) straight from the row. */
function reviewEnabled(db: ReturnType<typeof createAppsUiD1>, slug: string): number | null {
  const row = db.raw.query("SELECT review_enabled FROM github_apps WHERE slug = ?").get(slug) as {
    review_enabled: number;
  } | null;
  return row?.review_enabled ?? null;
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

  test("disabled rows withhold the pause/resume toggle — two-face consistency with the settings disconnected line (polish #2)", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    await apps.setAppStatus((await apps.listApps()).find((a) => a.slug === "mstar-inspector-mallory")!.id, "disabled");
    const res = await get("/dashboard/apps", `${SESSION_COOKIE}=${await sessionCookie("octocat")}`, makeEnv(db));
    const body = await res.text();
    // The list hides the pause toggle on disabled rows (a disabled App is
    // disconnected — webhook 404 — so pausing is meaningless), mirroring the
    // settings page's gray "disconnected" line instead of the Review switch.
    expect(body).toContain('<span class="note">disabled</span>');
    expect(body).not.toContain('action="/dashboard/apps/mstar-inspector-mallory/pause"');
    expect(body).not.toContain('action="/dashboard/apps/mstar-inspector-mallory/resume"');
    expect(body).not.toContain('<span class="note">paused</span>');
    // The row still offers its reversible status control (Enable) and Settings.
    expect(body).toContain('action="/dashboard/apps/mstar-inspector-mallory/enable"');
    expect(body).toContain('href="/dashboard/apps/mstar-inspector-mallory/settings"');
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

  test("creator pauses → 200 notice, review_enabled=0, the re-rendered list immediately shows the amber paused badge + Resume", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/pause", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Paused mstar-inspector-mallory.");
    expect(reviewEnabled(db, "mstar-inspector-mallory")).toBe(0);
    // Paused badge = the amber-700 token (spec § DESIGN.md 意图); the row now
    // offers Resume (not Pause) to its manager — Disable stays (pause ≠ disable).
    expect(body).toContain('<span class="note">paused</span>');
    expect(body).toContain('action="/dashboard/apps/mstar-inspector-mallory/resume"');
    expect(body).not.toContain('action="/dashboard/apps/mstar-inspector-mallory/pause"');
    expect(body).toContain('action="/dashboard/apps/mstar-inspector-mallory/disable"');
  });

  test("pausing leaves the webhook CONNECTED (pause ≠ disable): the route still resolves and verifies — 401 on a bad signature, not 404", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    await post("/dashboard/apps/mstar-inspector-mallory/pause", cookie, makeEnv(db));
    const webhook = await post("/webhook/mstar-inspector-mallory", "", makeEnv(db));
    expect(webhook.status).toBe(401);
    expect(reviewEnabled(db, "mstar-inspector-mallory")).toBe(0);
  });

  test("creator resumes → 200 notice, review_enabled=1, the list shows the gray active badge again", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    await apps.setReviewEnabled(
      (await apps.listApps()).find((a) => a.slug === "mstar-inspector-mallory")!.id,
      false,
    );
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/resume", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Resumed mstar-inspector-mallory.");
    expect(reviewEnabled(db, "mstar-inspector-mallory")).toBe(1);
    expect(body).toContain('<span class="status">active</span>');
    expect(body).toContain('action="/dashboard/apps/mstar-inspector-mallory/pause"');
  });

  test("pausing an already-paused app is an idempotent no-op re-render — warn notice, zero mutation", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    await post("/dashboard/apps/mstar-inspector-mallory/pause", cookie, makeEnv(db));
    const res = await post("/dashboard/apps/mstar-inspector-mallory/pause", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("mstar-inspector-mallory was already paused — nothing changed.");
    expect(reviewEnabled(db, "mstar-inspector-mallory")).toBe(0);
  });

  test("resuming an active app is an idempotent no-op re-render — warn notice, zero mutation", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post("/dashboard/apps/mstar-inspector-mallory/resume", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("mstar-inspector-mallory was already active — nothing changed.");
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
    expect(await pause.text()).toContain("Paused mstar-inspector-ada.");
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

  test("the list offers Pause on manageable active rows and Resume on paused ones — never to non-managers", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    await apps.setReviewEnabled(
      (await apps.listApps()).find((a) => a.slug === "mstar-inspector-mallory")!.id,
      false,
    );
    const admin = await get("/dashboard/apps", `${SESSION_COOKIE}=${await sessionCookie("octocat")}`, makeEnv(db));
    const adminBody = await admin.text();
    expect(adminBody).toContain('action="/dashboard/apps/mstar-inspector-mallory/resume"');
    expect(adminBody).toContain('action="/dashboard/apps/mstar-inspector-ada/pause"');
    const outsider = await get("/dashboard/apps", `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, makeEnv(db));
    const outsiderBody = await outsider.text();
    expect(outsiderBody).not.toContain("/pause");
    expect(outsiderBody).not.toContain("/resume");
  });
});

describe("App settings — Review switch + install health panel (plan 16)", () => {
  const SETTINGS = "/dashboard/apps/mstar-inspector-mallory/settings";
  const ownerCookie = async () => `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;

  test("active app: Review switch POSTs to the pinned pause route (blue-700 primary); NULL last webhook reads 'never'; empty install list", async () => {
    const db = await seededWorld();
    const res = await get(SETTINGS, await ownerCookie(), makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<h2>Review</h2>');
    expect(body).toContain('<form method="post" action="/dashboard/apps/mstar-inspector-mallory/pause">');
    expect(body).toContain('<button type="submit" class="primary">Pause reviews</button>');
    // Level 1 tokens only: the panel reuses the gray status line and the
    // .keys empty-state rhythm (spec § DESIGN.md 意图) — no new markup classes.
    expect(body).toContain("Last webhook: never");
    expect(body).toContain("No installations yet.");
  });

  test("paused app: amber paused badge + Resume reviews (also primary); a touched last_webhook_at renders as relative time", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    const app = (await apps.listApps()).find((a) => a.slug === "mstar-inspector-mallory")!;
    await apps.setReviewEnabled(app.id, false);
    await apps.touchLastWebhook(app.id);
    const res = await get(SETTINGS, await ownerCookie(), makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<p><span class="note">paused</span></p>');
    expect(body).toContain('<form method="post" action="/dashboard/apps/mstar-inspector-mallory/resume">');
    expect(body).toContain('<button type="submit" class="primary">Resume reviews</button>');
    expect(body).not.toContain('action="/dashboard/apps/mstar-inspector-mallory/pause"');
    expect(body).toContain("Last webhook: just now");
  });

  test("disabled app: the Review section shows the gray disconnected line — no Pause/Resume toggle, no paused/resumes copy; install health still renders (Phase 5, PR #7 review)", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    const app = (await apps.listApps()).find((a) => a.slug === "mstar-inspector-mallory")!;
    await apps.setAppStatus(app.id, "disabled");
    const res = await get(SETTINGS, await ownerCookie(), makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    // The disconnected line replaces BOTH the active toggle ("Reviews are on"
    // + Pause) and the paused copy ("Webhooks stay connected" + Resume) — a
    // disabled App is disconnected (webhook 404), so pausing is meaningless
    // (mirror of the list's status-gated pause toggle).
    expect(body).toContain("This App is disconnected — enable it to review.");
    expect(body).not.toContain("Pause reviews");
    expect(body).not.toContain("Resume reviews");
    expect(body).not.toContain('action="/dashboard/apps/mstar-inspector-mallory/pause"');
    expect(body).not.toContain('action="/dashboard/apps/mstar-inspector-mallory/resume"');
    expect(body).not.toContain("Reviews are on");
    expect(body).not.toContain("Webhooks stay connected");
    expect(body).not.toContain('<span class="note">paused</span>');
    // The install-health panel renders regardless of status.
    expect(body).toContain("Last webhook: never");
    expect(body).toContain("No installations yet.");
  });

  test("installations render newest-first (seen_at DESC face) with relative last-seen; installation ids in tabular figures", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    const app = (await apps.listApps()).find((a) => a.slug === "mstar-inspector-mallory")!;
    await apps.upsertInstallation({ appId: app.id, installationId: 101, accountLogin: "octo-install" });
    await apps.upsertInstallation({ appId: app.id, installationId: 102, accountLogin: "hubot-install" });
    // Backdate the FIRST-seen installation so the ordering face is observable.
    db.raw
      .prepare("UPDATE app_installations SET seen_at = datetime('now', '-3 hours') WHERE installation_id = 101")
      .run();
    const res = await get(SETTINGS, await ownerCookie(), makeEnv(db));
    const body = await res.text();
    // The list reuses the .keys rhythm verbatim (spec § DESIGN.md 意图).
    expect(body).toContain('<ul class="keys">');
    expect(body).toContain("<strong>hubot-install</strong>");
    expect(body).toContain("last seen just now");
    expect(body).toContain("<strong>octo-install</strong>");
    expect(body).toContain("last seen 3 hours ago");
    expect(body).toContain('installation <span class="id">101</span>');
    // Newest first: installation 102 precedes 101 in the document.
    expect(body.indexOf("hubot-install")).toBeLessThan(body.indexOf("octo-install"));
  });

  test("XSS pins: a webhook-supplied login never renders raw; a NULL login renders as 'unknown'", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    const app = (await apps.listApps()).find((a) => a.slug === "mstar-inspector-mallory")!;
    await apps.upsertInstallation({
      appId: app.id,
      installationId: 103,
      accountLogin: '<script>alert(1)</script>',
    });
    await apps.upsertInstallation({ appId: app.id, installationId: 104 });
    const res = await get(SETTINGS, await ownerCookie(), makeEnv(db));
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("<strong>unknown</strong>");
  });
});

describe("App settings — masked key last-updated (plan 23 T1, AC-23c)", () => {
  const SETTINGS = "/dashboard/apps/mstar-inspector-mallory/settings";
  const ownerCookie = async () => `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;

  const store = (db: ReturnType<typeof createAppsUiD1>) => createAppConfigStore(db, TEST_KEY);
  const appRow = async (db: ReturnType<typeof createAppsUiD1>) =>
    (await createAppsStore(db).listApps()).find((a) => a.slug === "mstar-inspector-mallory")!;

  test("a freshly stored key renders its last-update time in the masked row", async () => {
    const db = await seededWorld();
    await store(db).setProviderKey((await appRow(db)).id, "anthropic", "sk-ant-view-9988");
    const res = await get(SETTINGS, await ownerCookie(), makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`key ending <code class="id">9988</code> · updated just now`);
  });

  test("a pre-0012 row (NULL updated_at) shows the em dash placeholder, never 'never'", async () => {
    const db = await seededWorld();
    const app = await appRow(db);
    await store(db).setProviderKey(app.id, "anthropic", "sk-ant-view-9988");
    db.raw
      .prepare("UPDATE app_provider_keys SET updated_at = NULL WHERE app_id = ? AND provider = 'anthropic'")
      .run(app.id);
    const res = await get(SETTINGS, await ownerCookie(), makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`key ending <code class="id">9988</code> · updated &mdash;`);
  });

  test("hostile updated_at never renders raw — the meta shows the constant 'unknown' phrase instead", async () => {
    const db = await seededWorld();
    const app = await appRow(db);
    await store(db).setProviderKey(app.id, "anthropic", "sk-ant-view-9988");
    db.raw
      .prepare("UPDATE app_provider_keys SET updated_at = ? WHERE app_id = ? AND provider = 'anthropic'")
      .run('<script>alert("x")</script>', app.id);
    const res = await get(SETTINGS, await ownerCookie(), makeEnv(db));
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain(`key ending <code class="id">9988</code> · updated unknown`);
  });
});

describe("App settings — custom providers (plan 23 T2)", () => {
  const SETTINGS = "/dashboard/apps/mstar-inspector-mallory/settings";
  const ownerCookie = async () => `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;

  const store = (db: ReturnType<typeof createAppsUiD1>) => createAppConfigStore(db, TEST_KEY);
  const appRow = async (db: ReturnType<typeof createAppsUiD1>) =>
    (await createAppsStore(db).listApps()).find((a) => a.slug === "mstar-inspector-mallory")!;

  test("the section renders between Model chain and Role models with the api enum select and a password key input", async () => {
    const db = await seededWorld();
    const res = await get(SETTINGS, await ownerCookie(), makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.indexOf("Model chain")).toBeLessThan(body.indexOf("Custom providers"));
    expect(body.indexOf("Custom providers")).toBeLessThan(body.indexOf("Role models"));
    expect(body).toContain('<select name="api">');
    expect(body).toContain('<input type="password" name="key" autocomplete="new-password"');
  });

  test("a stored declaration renders provider_id / base_url / api / model_ids with escaped values", async () => {
    const db = await seededWorld();
    const app = await appRow(db);
    await store(db).upsertCustomProvider(
      app.id,
      {
        provider_id: "ark",
        base_url: 'https://evil.example.com/?q="><script>alert(1)</script>',
        api: "openai-completions",
        model_ids: ['"><img src=x onerror=alert(1)>'],
      },
      "sk-custom-ark-9988",
    );
    const res = await get(SETTINGS, await ownerCookie(), makeEnv(db));
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
