/**
 * Apps management UI tests (spec § Multi-App 契约 + § IA).
 *
 * `GET /dashboard/apps` is member-visible (numeric App id, status,
 * creator — never the encrypted columns or row ids); the pinned POST action
 * paths `/dashboard/default/apps/:appId/disable|enable|delete` (architect: zero-JS
 * `<form method="post">` cannot emit a DELETE verb) are creator-or-admin
 * (Clarify #6). Disable/enable/soft-delete flows are bridged END-TO-END to
 * the T2 webhook face: a disabled or soft-deleted App's webhook route 404s,
 * a re-enabled one resolves again (401 on a bad signature proves the row
 * was found and passed to signature verification).
 *
 * The D1 double is the real bun:sqlite helper over migrations
 * 0001/0002 + 0003–0009 + 0012 (production-shaped, filename order — 0006 backs the
 * per-App config tables the settings page reads; 0008 adds the per-App
 * ops columns behind the pause toggle and the install-health panel; 0009 is
 * app_model_roles, read on every settings render by the Role
 * models editor; 0022 is the per-App review trigger mode column).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../src/i18n";
import worker from "../../src/worker/index";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { Env } from "../../src/worker/env";
import { createAppsStore, type GithubAppRow } from "../../src/dashboard/apps-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser, type DashboardD1 } from "../../src/dashboard/users";
import { createTestD1 } from "../store/helpers";
import { SPA_BOOT_MARKER, htmlGet, withSpaAssets } from "../helpers/spa";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const TEST_WEBHOOK_SECRET = ["test", "app", "webhook", "secret"].join("-");
/**
 * Fixture Apps are addressed by their immutable GitHub App id (D0):
 * `mstar-inspector-mallory` / `-ada` are only their webhook paths + labels now.
 */
const MALLORY_APP_ID = 1001;
const ADA_APP_ID = 1002;

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
    "0022_app_trigger_mode.sql",
    "0023_removed_logins.sql",
    // 0026: createApp also writes the App's workspace mapping.
    "0026_workspaces.sql",
    // 0028: the SPA boot reads pending invites.
    "0028_workspace_invites.sql",
    // 0033: the SPA boot reads the `workspace_creation_open` server flag.
    "0033_platform_admin.sql",
    // 0036: github_apps.slug → webhook_path plus the cached github_slug.
    "0036_app_identity.sql",
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
    webhookPath: opts.slug,
    githubSlug: opts.slug,
    githubAppId: opts.githubAppId,
    name: opts.slug,
    privateKeyEnc: enc.privateKeyEnc,
    webhookSecretEnc: enc.webhookSecretEnc,
    createdBy: opts.createdBy,
    workspaceId: "default",
  });
}

/**
 * Seeded world (membership semantics + apps):
 *   octocat = admin; mallory owns her App; ada owns hers; hubot owns none.
 */
async function seededWorld(): Promise<ReturnType<typeof createTestD1>> {
  const db = createAppsUiD1();
  await seedMember(db, "octocat", "admin");
  await seedMember(db, "mallory", "member");
  await seedMember(db, "ada", "member");
  await seedMember(db, "hubot", "member");
  // Manage is the workspace role: `octocat` and `mallory` are owners, the
  // others plain members. The App creator column grants nothing.
  db.raw
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT 'default', id, CASE WHEN github_login IN ('octocat','mallory') THEN 'owner' ELSE 'member' END,
              '2026-01-01T00:00:00.000Z'
       FROM users`,
    )
    .run();
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
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
    ...overrides,
  } as Env;
}

const sessionCookie = (login: string) => createSessionValue(login, null, SESSION_SECRET);

async function get(path: string, cookie: string, env: Env): Promise<Response> {
  return await worker.fetch(new Request(`https://worker.local${path}`, { headers: { Cookie: cookie } }), env);
}

// SPA ownership: apps/settings HTML GETs are SPA-owned (shared spa helper).

async function post(path: string, cookie: string, env: Env): Promise<Response> {
  return await worker.fetch(
    new Request(`https://worker.local${path}`, { method: "POST", headers: { Cookie: cookie } }),
    env,
  );
}

/** Form-encoded POST (the trigger-mode route reads a `mode` field from the body). */
async function postForm(
  path: string,
  cookie: string,
  env: Env,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await worker.fetch(
    new Request(`https://worker.local${path}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields),
    }),
    env,
  );
}

function appStatus(db: ReturnType<typeof createAppsUiD1>, appId: number): string | null {
  const row = db.raw.query("SELECT status FROM github_apps WHERE github_app_id = ?").get(appId) as {
    status: string;
  } | null;
  return row?.status ?? null;
}

/** The per-App pause switch column (migration 0008) straight from the row. */
function reviewEnabled(db: ReturnType<typeof createAppsUiD1>, appId: number): number | null {
  const row = db.raw.query("SELECT review_enabled FROM github_apps WHERE github_app_id = ?").get(appId) as {
    review_enabled: number;
  } | null;
  return row?.review_enabled ?? null;
}

/** The per-App trigger-mode column (migration 0022) straight from the row. */
function reviewTriggerMode(db: ReturnType<typeof createAppsUiD1>, appId: number): string | null {
  const row = db.raw.query("SELECT review_trigger_mode FROM github_apps WHERE github_app_id = ?").get(appId) as {
    review_trigger_mode: string;
  } | null;
  return row?.review_trigger_mode ?? null;
}

describe("the Apps page shell (workspace-scoped SPA route)", () => {
  test("HTML navigation GET is served by SPA dispatch (boot-injected index)", async () => {
    const db = await seededWorld();
    const res = await htmlGet("/dashboard/default/apps", `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, withSpaAssets(makeEnv(db)));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).toContain('"login":"hubot"');
    // The boot carries the workspace memberships (id + role), never users.role.
    expect(body).toContain('"memberships":[{"id":"default","slug":"default","name":"Default","role":"member","plan":"Unlimited"}]');
  });

  test("the retired deployment-level /dashboard/apps answers 404", async () => {
    const db = await seededWorld();
    const res = await get("/dashboard/apps", "", makeEnv(db));
    expect(res.status).toBe(404);
  });

  test("GET /dashboard with a member session → the sole workspace's Apps page", async () => {
    const db = await seededWorld();
    const shell = await get("/dashboard", `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, withSpaAssets(makeEnv(db)));
    expect(shell.status).toBe(302);
    expect(shell.headers.get("Location")).toBe("/dashboard/default/apps");
  });
});

describe("POST /dashboard/default/apps/:appId/disable|enable|delete (pinned action paths)", () => {
  test("no session → 302 to login, zero mutation", async () => {
    const db = await seededWorld();
    const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/disable`, "", makeEnv(db));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    expect(appStatus(db, MALLORY_APP_ID)).toBe("active");
  });

  test("creator disables their app → 200, row disabled, the App's webhook route 404s (UI flow → T2 face)", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/disable`, cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(appStatus(db, MALLORY_APP_ID)).toBe("disabled");
    // T2 contract through the UI action: the disabled App's webhook 404s
    // (the webhook-path lookup resolves the row, then the status gate refuses).
    const webhook = await post("/webhook/mstar-inspector-mallory", "", makeEnv(db));
    expect(webhook.status).toBe(404);
  });

  test("creator re-enables → active again; the webhook route resolves the row (401 on bad signature, not 404)", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    await apps.setAppStatus(
      (await apps.listApps()).find((a) => a.github_app_id === MALLORY_APP_ID)!.id,
      "disabled",
    );
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/enable`, cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(appStatus(db, MALLORY_APP_ID)).toBe("active");
    const webhook = await post("/webhook/mstar-inspector-mallory", "", makeEnv(db));
    // Active + not deleted → the row resolved and the (missing) signature
    // fails verification: 401, NOT the 404 of an unknown/disabled app.
    expect(webhook.status).toBe(401);
  });

  test("admin manages another creator's app", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("octocat")}`;
    const res = await post(`/dashboard/default/apps/${ADA_APP_ID}/disable`, cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(appStatus(db, ADA_APP_ID)).toBe("disabled");
    const enable = await post(`/dashboard/default/apps/${ADA_APP_ID}/enable`, cookie, makeEnv(db));
    expect(enable.status).toBe(200);
    expect(appStatus(db, ADA_APP_ID)).toBe("active");
  });

  test("non-creator member POST → 403, zero mutation", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("hubot")}`;
    const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/disable`, cookie, makeEnv(db));
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("restricted to dashboard admins");
    expect(appStatus(db, MALLORY_APP_ID)).toBe("active");
  });

  test("creator of a DIFFERENT app POST → 403, zero mutation (creator scope is per-App)", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("ada")}`;
    const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/disable`, cookie, makeEnv(db));
    expect(res.status).toBe(403);
    expect(appStatus(db, MALLORY_APP_ID)).toBe("active");
  });

  test("unknown App id → 404, zero side effects", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("octocat")}`;
    for (const path of [
      "/dashboard/default/apps/9999/disable",
      "/dashboard/default/apps/9999/enable",
      "/dashboard/default/apps/9999/delete",
    ]) {
      const res = await post(path, cookie, makeEnv(db));
      expect(res.status).toBe(404);
    }
  });

  test("delete → soft delete: row stamped, webhook route 404s, further manage POSTs 404", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/delete`, cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    // Soft delete (Clarify #4): the row remains in D1 with deleted_at stamped.
    const row = db.raw
      .query("SELECT deleted_at FROM github_apps WHERE github_app_id = 1001")
      .get() as { deleted_at: string | null };
    expect(row.deleted_at).not.toBeNull();
    // The brief's bridged AC: the deleted app's webhook route 404s (T2).
    const webhook = await post("/webhook/mstar-inspector-mallory", "", makeEnv(db));
    expect(webhook.status).toBe(404);
    // Managing a deleted app is 404 — it no longer exists for the UI.
    const manage = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/disable`, cookie, makeEnv(db));
    expect(manage.status).toBe(404);
  });
});

describe("POST /dashboard/default/apps/:appId/pause|resume (per-App review pause)", () => {
  test("guard covers the pinned routes: no session → 302 to login, zero mutation", async () => {
    const db = await seededWorld();
    for (const path of ["pause", "resume"]) {
      const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/${path}`, "", makeEnv(db));
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard/login");
    }
    expect(reviewEnabled(db, MALLORY_APP_ID)).toBe(1);
  });

  test("creator pauses → 200, review_enabled=0 (the SPA refetches the JSON face for the paused badge)", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/pause`, cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(reviewEnabled(db, MALLORY_APP_ID)).toBe(0);
  });

  test("pausing leaves the webhook CONNECTED (pause ≠ disable): the route still resolves and verifies — 401 on a bad signature, not 404", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    await post(`/dashboard/default/apps/${MALLORY_APP_ID}/pause`, cookie, makeEnv(db));
    const webhook = await post("/webhook/mstar-inspector-mallory", "", makeEnv(db));
    expect(webhook.status).toBe(401);
    expect(reviewEnabled(db, MALLORY_APP_ID)).toBe(0);
  });

  test("creator resumes → 200, review_enabled=1", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    await apps.setReviewEnabled(
      (await apps.listApps()).find((a) => a.github_app_id === MALLORY_APP_ID)!.id,
      false,
    );
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/resume`, cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(reviewEnabled(db, MALLORY_APP_ID)).toBe(1);
  });

  test("pausing an already-paused app is an idempotent no-op — 200, zero mutation", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    await post(`/dashboard/default/apps/${MALLORY_APP_ID}/pause`, cookie, makeEnv(db));
    const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/pause`, cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(reviewEnabled(db, MALLORY_APP_ID)).toBe(0);
  });

  test("resuming an active app is an idempotent no-op — 200, zero mutation", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/resume`, cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(reviewEnabled(db, MALLORY_APP_ID)).toBe(1);
  });

  test("authz matrix: another member → 403 zero mutation; the creator of a DIFFERENT app → 403 (scope is per-App)", async () => {
    const db = await seededWorld();
    for (const login of ["hubot", "ada"]) {
      const res = await post(
        `/dashboard/default/apps/${MALLORY_APP_ID}/pause`,
        `${SESSION_COOKIE}=${await sessionCookie(login)}`,
        makeEnv(db),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("restricted to dashboard admins");
      expect(reviewEnabled(db, MALLORY_APP_ID)).toBe(1);
    }
  });

  test("admin (non-creator) may pause and resume another creator's app", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("octocat")}`;
    const pause = await post(`/dashboard/default/apps/${ADA_APP_ID}/pause`, cookie, makeEnv(db));
    expect(pause.status).toBe(200);
    expect(await pause.text()).toBe("ok");
    expect(reviewEnabled(db, ADA_APP_ID)).toBe(0);
    const resume = await post(`/dashboard/default/apps/${ADA_APP_ID}/resume`, cookie, makeEnv(db));
    expect(resume.status).toBe(200);
    expect(reviewEnabled(db, ADA_APP_ID)).toBe(1);
  });

  test("unknown App id → 404; soft-deleted app → 404, zero side effects", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("octocat")}`;
    for (const path of ["/dashboard/default/apps/9999/pause", "/dashboard/default/apps/9999/resume"]) {
      const res = await post(path, cookie, makeEnv(db));
      expect(res.status).toBe(404);
    }
    await apps.softDeleteApp((await apps.listApps()).find((a) => a.github_app_id === MALLORY_APP_ID)!.id);
    for (const path of [
      `/dashboard/default/apps/${MALLORY_APP_ID}/pause`,
      `/dashboard/default/apps/${MALLORY_APP_ID}/resume`,
    ]) {
      const res = await post(path, cookie, makeEnv(db));
      expect(res.status).toBe(404);
    }
  });

});

describe("POST /dashboard/default/apps/:appId/review-trigger-mode (per-App review trigger mode)", () => {
  test("guard covers the pinned route: no session → 302 to login, zero mutation", async () => {
    const db = await seededWorld();
    const res = await postForm(
      `/dashboard/default/apps/${MALLORY_APP_ID}/review-trigger-mode`,
      "",
      makeEnv(db),
      { mode: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    expect(reviewTriggerMode(db, MALLORY_APP_ID)).toBe("every_push");
  });

  test("creator sets each vocabulary mode → 200 ok, exact wire spelling stored (spec §2 enum)", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    for (const mode of ["open", "every_push", "manual"]) {
      const res = await postForm(`/dashboard/default/apps/${MALLORY_APP_ID}/review-trigger-mode`, cookie, makeEnv(db), {
        mode,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(reviewTriggerMode(db, MALLORY_APP_ID)).toBe(mode);
    }
  });

  test("invalid mode → keyed 400, stored row left unchanged — no silent coercion to the default (spec §2)", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    for (const mode of ["bogus", "EVERY_PUSH", ""]) {
      const res = await postForm(`/dashboard/default/apps/${MALLORY_APP_ID}/review-trigger-mode`, cookie, makeEnv(db), {
        mode,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        key: "settings.error.triggerModeUnknown",
        message: `${mode} is not a review trigger mode — use open, every_push, or manual. Nothing was stored.`,
        params: { mode },
      });
      expect(reviewTriggerMode(db, MALLORY_APP_ID)).toBe("every_push");
    }
    // A missing mode field fails closed the same way.
    const missing = await postForm(`/dashboard/default/apps/${MALLORY_APP_ID}/review-trigger-mode`, cookie, makeEnv(db), {});
    expect(missing.status).toBe(400);
    expect(reviewTriggerMode(db, MALLORY_APP_ID)).toBe("every_push");
  });

  test("selecting the already-stored mode is an idempotent no-op — 200, zero mutation (updated_at untouched)", async () => {
    const db = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    db.raw
      .prepare("UPDATE github_apps SET updated_at = '2026-01-01 00:00:00' WHERE github_app_id = ?")
      .run(MALLORY_APP_ID);
    const res = await postForm(`/dashboard/default/apps/${MALLORY_APP_ID}/review-trigger-mode`, cookie, makeEnv(db), {
      mode: "every_push",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    const row = db.raw
      .query("SELECT review_trigger_mode, updated_at FROM github_apps WHERE github_app_id = ?")
      .get(MALLORY_APP_ID) as { review_trigger_mode: string; updated_at: string };
    expect(row.review_trigger_mode).toBe("every_push");
    expect(row.updated_at).toBe("2026-01-01 00:00:00");
  });

  test("authz matrix: another member → 403 zero mutation; the creator of a DIFFERENT app → 403 (scope is per-App)", async () => {
    const db = await seededWorld();
    for (const login of ["hubot", "ada"]) {
      const res = await postForm(
        `/dashboard/default/apps/${MALLORY_APP_ID}/review-trigger-mode`,
        `${SESSION_COOKIE}=${await sessionCookie(login)}`,
        makeEnv(db),
        { mode: "manual" },
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("restricted to dashboard admins");
      expect(reviewTriggerMode(db, MALLORY_APP_ID)).toBe("every_push");
    }
  });

  test("admin (non-creator) may set another creator's app", async () => {
    const db = await seededWorld();
    const res = await postForm(
      `/dashboard/default/apps/${ADA_APP_ID}/review-trigger-mode`,
      `${SESSION_COOKIE}=${await sessionCookie("octocat")}`,
      makeEnv(db),
      { mode: "open" },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(reviewTriggerMode(db, ADA_APP_ID)).toBe("open");
  });

  test("unknown App id → 404; soft-deleted app → 404, zero side effects", async () => {
    const db = await seededWorld();
    const apps = createAppsStore(db);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("octocat")}`;
    const unknown = await postForm("/dashboard/default/apps/9999/review-trigger-mode", cookie, makeEnv(db), {
      mode: "manual",
    });
    expect(unknown.status).toBe(404);
    await apps.softDeleteApp((await apps.listApps()).find((a) => a.github_app_id === MALLORY_APP_ID)!.id);
    const deleted = await postForm(`/dashboard/default/apps/${MALLORY_APP_ID}/review-trigger-mode`, cookie, makeEnv(db), {
      mode: "manual",
    });
    expect(deleted.status).toBe(404);
  });

  test("native HTML form post keeps the pinned 302 to the App settings page", async () => {
    const db = await seededWorld();
    const res = await postForm(
      `/dashboard/default/apps/${MALLORY_APP_ID}/review-trigger-mode`,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      { mode: "manual" },
      { Accept: "text/html" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/dashboard/default/apps/${MALLORY_APP_ID}/settings`);
    expect(reviewTriggerMode(db, MALLORY_APP_ID)).toBe("manual");
  });
});

describe("GET /dashboard/default/apps/:appId/settings (SPA-owned)", () => {
  const SETTINGS = `/dashboard/default/apps/${MALLORY_APP_ID}/settings`;
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
