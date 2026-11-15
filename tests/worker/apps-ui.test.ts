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
 * bot_model_roles, read on every settings render by the Role
 * models editor; 0022 is the per-App review trigger mode column).
 */
import { describe, expect, spyOn, test } from "bun:test";
import { t } from "../../src/i18n";
import worker from "../../src/worker/index";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { Env } from "../../src/worker/env";
import { createReviewBotsStore, type GithubAppRow } from "../../src/dashboard/apps-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser, type DashboardD1 } from "../../src/dashboard/users";
import { createTestD1 } from "../store/helpers";
import { APPS_UI_MIGRATIONS, applyMigrations } from "../helpers/migration-shapes";
import { SPA_BOOT_MARKER, htmlGet, withSpaAssets } from "../helpers/spa";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
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
  applyMigrations(db, APPS_UI_MIGRATIONS);
  return db;
}

async function seedMember(db: DashboardD1, login: string, role: "admin" | "member"): Promise<void> {
  await createUser(db, { login, role });
}

async function seedApp(
  db: DashboardD1,
  opts: { slug: string; githubAppId: number; createdBy: string },
): Promise<GithubAppRow> {
  // The row id is the webhook URL's app segment: keep it derivable so the
  // route assertions below can name the App without re-reading the row.
  const id = `app-${opts.slug}`;
  const enc = await encryptedColumns(id);
  return createReviewBotsStore(db).createApp({
    id,
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
  const row = db.raw.query("SELECT status FROM review_bots WHERE github_app_id = ?").get(appId) as {
    status: string;
  } | null;
  return row?.status ?? null;
}

/** The per-App pause switch (the target's business pause) straight from the row. */
function reviewEnabled(db: ReturnType<typeof createAppsUiD1>, appId: number): number | null {
  const row = db.raw
    .query(
      `SELECT t.review_enabled FROM review_targets t
         JOIN review_bots b ON b.id = t.bot_id
        WHERE b.github_app_id = ? AND t.deleted_at IS NULL`,
    )
    .get(appId) as {
    review_enabled: number;
  } | null;
  return row?.review_enabled ?? null;
}

/** The per-App trigger-mode column (the target's) straight from the row. */
function reviewTriggerMode(db: ReturnType<typeof createAppsUiD1>, appId: number): string | null {
  const row = db.raw
    .query(
      `SELECT t.review_trigger_mode FROM review_targets t
         JOIN review_bots b ON b.id = t.bot_id
        WHERE b.github_app_id = ? AND t.deleted_at IS NULL`,
    )
    .get(appId) as {
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
    const webhook = await post("/webhook/default/app-mstar-inspector-mallory", "", makeEnv(db));
    expect(webhook.status).toBe(404);
  });

  test("creator re-enables → active again; the webhook route resolves the row (401 on bad signature, not 404)", async () => {
    const db = await seededWorld();
    const apps = createReviewBotsStore(db);
    await apps.setAppStatus(
      (await apps.listApps()).find((a) => a.github_app_id === MALLORY_APP_ID)!.id,
      "disabled",
    );
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/enable`, cookie, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(appStatus(db, MALLORY_APP_ID)).toBe("active");
    const webhook = await post("/webhook/default/app-mstar-inspector-mallory", "", makeEnv(db));
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
      .query("SELECT deleted_at FROM review_bots WHERE github_app_id = 1001")
      .get() as { deleted_at: string | null };
    expect(row.deleted_at).not.toBeNull();
    // The brief's bridged AC: the deleted app's webhook route 404s (T2).
    const webhook = await post("/webhook/default/app-mstar-inspector-mallory", "", makeEnv(db));
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
    const webhook = await post("/webhook/default/app-mstar-inspector-mallory", "", makeEnv(db));
    expect(webhook.status).toBe(401);
    expect(reviewEnabled(db, MALLORY_APP_ID)).toBe(0);
  });

  test("creator resumes → 200, review_enabled=1", async () => {
    const db = await seededWorld();
    const apps = createReviewBotsStore(db);
    const bot = (await apps.listApps()).find((a) => a.github_app_id === MALLORY_APP_ID)!;
    const targets = createTargetsStore(db);
    const target = (await targets.resolve(bot.id, null))!;
    await targets.setReviewEnabled(target.workspace_id, target.id, false);
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
    const apps = createReviewBotsStore(db);
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

  test("a target in another workspace is invisible: the detail face 404s and the action refuses with zero writes", async () => {
    const db = await seededWorld();
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES ('ws-other', 'ws-other', 'Other', 'octocat', datetime('now'))`,
      )
      .run();
    // The bot belongs to `default`; its configuration claims another tenant.
    db.raw
      .prepare(
        `UPDATE review_targets SET workspace_id = 'ws-other'
          WHERE bot_id = (SELECT id FROM review_bots WHERE github_app_id = ?)`,
      )
      .run(MALLORY_APP_ID);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;

    const detail = await get(`/dashboard/default/api/apps/${MALLORY_APP_ID}/settings`, cookie, makeEnv(db));
    expect(detail.status).toBe(404);
    const pause = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/pause`, cookie, makeEnv(db));
    expect(pause.status).toBe(404);
    // The refusal wrote nothing: the foreign target still reads reviewing.
    expect(reviewEnabled(db, MALLORY_APP_ID)).toBe(1);
  });

  test("the list omits review_enabled for a bot with no live target (no fabricated pause state)", async () => {
    const db = await seededWorld();
    db.raw
      .prepare(
        `DELETE FROM review_targets
          WHERE bot_id = (SELECT id FROM review_bots WHERE github_app_id = ?)`,
      )
      .run(MALLORY_APP_ID);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;

    const res = await get("/dashboard/default/api/apps", cookie, makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apps: Array<Record<string, unknown>> };
    const row = body.apps.find((app) => app.github_app_id === MALLORY_APP_ID)!;
    // The row has no pause state to report, so the wire carries no key (not a
    // default of "reviewing").
    expect("review_enabled" in row).toBe(false);
    const sibling = body.apps.find((app) => app.github_app_id === ADA_APP_ID)!;
    expect(sibling.review_enabled).toBe(1);
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
      .prepare(
        `UPDATE review_targets SET updated_at = '2026-01-01 00:00:00'
          WHERE bot_id = (SELECT id FROM review_bots WHERE github_app_id = ?)`,
      )
      .run(MALLORY_APP_ID);
    const res = await postForm(`/dashboard/default/apps/${MALLORY_APP_ID}/review-trigger-mode`, cookie, makeEnv(db), {
      mode: "every_push",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(reviewTriggerMode(db, MALLORY_APP_ID)).toBe("every_push");
    // A same-value selection never touches the row (an operator mutation).
    const row = db.raw
      .query(
        `SELECT t.updated_at FROM review_targets t
           JOIN review_bots b ON b.id = t.bot_id
          WHERE b.github_app_id = ?`,
      )
      .get(MALLORY_APP_ID) as { updated_at: string };
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
    const apps = createReviewBotsStore(db);
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

/**
 * The bot's own settings face: `GET /dashboard/:ref/api/apps/:appId/bot`.
 *
 * The target detail keeps the workspace-owned configuration; the bot page reads
 * the bot-owned sections (credentials health, provider configuration, chains,
 * sandbox image, installations). A bot the caller's workspace does not own is
 * reachable exactly when it is SHARED — and then the face is read-only
 * (`can_manage: false`) whatever the caller's workspace role is.
 */
describe("GET /dashboard/:ref/api/apps/:appId/bot (the bot settings read face)", () => {
  /** The second workspace a shared bot is used from (its owner is `hubot`). */
  function seedOtherWorkspace(db: ReturnType<typeof createAppsUiD1>): void {
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES ('ws-other', 'ws-other', 'ws-other', 'hubot', datetime('now'))`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT 'ws-other', id, 'owner', '2026-01-01T00:00:00.000Z' FROM users WHERE github_login = 'hubot'`,
      )
      .run();
  }

  /** Share one bot WITHOUT the official-workspace designation: only `scope` gates this face. */
  function shareBot(db: ReturnType<typeof createAppsUiD1>, githubAppId: number): void {
    db.raw
      .prepare(`UPDATE review_bots SET scope = 'shared', shared_at = datetime('now') WHERE github_app_id = ?`)
      .run(githubAppId);
  }

  const botFace = (ref: string, githubAppId: number) => `/dashboard/${ref}/api/apps/${githubAppId}/bot`;

  test("the owning workspace's manager reads the bot-scoped sections only", async () => {
    const db = await seededWorld();
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const res = await get(
        botFace("default", MALLORY_APP_ID),
        `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
        makeEnv(db),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown> & { app: Record<string, unknown> };
      expect(body.can_manage).toBe(true);
      // Bot-scoped sections ride the face…
      for (const key of [
        "installations",
        "deliveries",
        "delivery_summary",
        "keys",
        "model_chain",
        "model_roles",
        "model_chains",
        "custom_providers",
        "configured_providers",
        "provider_catalog",
        "model_limits_snapshot",
        "model_role_ids",
        "custom_provider_api_ids",
        "sandbox_images",
      ]) {
        expect(body).toHaveProperty(key);
      }
      expect(body.app.sandbox_image_id).toBe("omp");
      expect(body.app.scope).toBe("owned");
      expect(body.app.github_slug).toBe("mstar-inspector-mallory");
      // …and no target-scoped section does: the workspace's review policy
      // stays on the target detail.
      for (const key of ["target_id", "check_gate", "allowlist", "installation", "workspace_id"]) {
        expect(body).not.toHaveProperty(key);
      }
      expect(body.app).not.toHaveProperty("review_trigger_mode");
      expect(body.app).not.toHaveProperty("review_level");
      // The read face never reaches GitHub: no metadata refresh, no probe.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a plain member reads the same sections, read-only", async () => {
    const db = await seededWorld();
    const res = await get(
      botFace("default", MALLORY_APP_ID),
      `${SESSION_COOKIE}=${await sessionCookie("hubot")}`,
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { app: Record<string, unknown> };
    expect(body.can_manage).toBe(false);
    expect(body).toHaveProperty("keys");
    expect(body).toHaveProperty("installations");
    expect(body.app.sandbox_image_id).toBe("omp");
  });

  test("an owned bot is invisible from another workspace (404 envelope)", async () => {
    const db = await seededWorld();
    seedOtherWorkspace(db);
    const res = await get(
      botFace("ws-other", MALLORY_APP_ID),
      `${SESSION_COOKIE}=${await sessionCookie("hubot")}`,
      makeEnv(db),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown app" });
  });

  test("a shared bot resolves from another workspace, read-only for its owner in that workspace", async () => {
    const db = await seededWorld();
    seedOtherWorkspace(db);
    shareBot(db, MALLORY_APP_ID);
    const res = await get(
      botFace("ws-other", MALLORY_APP_ID),
      `${SESSION_COOKIE}=${await sessionCookie("hubot")}`,
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { can_manage: unknown; app: { scope: unknown } };
    expect(body.can_manage).toBe(false);
    expect(body.app.scope).toBe("shared");
  });

  test("a shared bot is read-only for the owning workspace's manager too", async () => {
    const db = await seededWorld();
    shareBot(db, MALLORY_APP_ID);
    const res = await get(
      botFace("default", MALLORY_APP_ID),
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { can_manage: unknown };
    expect(body.can_manage).toBe(false);
  });

  test("an unknown, non-numeric or foreign (unshared) App answers the same 404 with no GitHub call", async () => {
    const db = await seededWorld();
    seedOtherWorkspace(db);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      for (const path of [
        botFace("default", 9999),
        "/dashboard/default/api/apps/not-a-number/bot",
        botFace("default", -1),
      ]) {
        const res = await get(path, cookie, makeEnv(db));
        expect(res.status, path).toBe(404);
        expect(await res.json()).toEqual({ error: "unknown app" });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a bot-scoped op posted for a shared bot is refused server-side, and a target-scoped op still saves", async () => {
    const db = await seededWorld();
    shareBot(db, MALLORY_APP_ID);
    // The owning workspace's manager still cannot configure a shared bot: the
    // refusal is the route's, not the page's.
    const refused = await postForm(
      `/dashboard/default/apps/${MALLORY_APP_ID}/settings`,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      { op: "save-sandbox-image", sandbox_image_id: "omp" },
    );
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { key: unknown };
    expect(body.key).toBe("settings.error.botReadOnly");
    // The target-scoped ops stay available: the target is what this workspace
    // owns, whatever the bot's scope.
    const saved = await postForm(
      `/dashboard/default/apps/${MALLORY_APP_ID}/settings`,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      { op: "save-review-level", level: "quick" },
    );
    expect(saved.status).toBe(200);
    const target = db.raw
      .prepare(
        `SELECT t.review_level FROM review_targets t JOIN review_bots b ON b.id = t.bot_id
          WHERE b.github_app_id = ?`,
      )
      .get(MALLORY_APP_ID) as { review_level: string };
    expect(target.review_level).toBe("quick");
  });

  test("keys/verify is refused for a shared bot on both paths, before any probe or store write", async () => {
    const db = await seededWorld();
    shareBot(db, MALLORY_APP_ID);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      for (const provider of ["anthropic", "matrix-custom"]) {
        const res = await postForm(
          `/dashboard/default/api/apps/${MALLORY_APP_ID}/keys/verify`,
          cookie,
          makeEnv(db),
          { provider, key: `test-matrix-${provider}` },
        );
        expect(res.status, provider).toBe(403);
        const body = (await res.json()) as { key: unknown };
        expect(body.key, provider).toBe("settings.error.botReadOnly");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    // Neither pool gained a row: the refusal precedes the verify-then-store.
    expect(
      (db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get() as { n: number }).n,
    ).toBe(0);
  });

  test("lifecycle actions on a shared bot are refused for its owning manager too", async () => {
    const db = await seededWorld();
    shareBot(db, MALLORY_APP_ID);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    for (const action of ["disable", "enable", "delete"]) {
      const res = await post(`/dashboard/default/apps/${MALLORY_APP_ID}/${action}`, cookie, makeEnv(db));
      expect(res.status, action).toBe(403);
    }
    expect(appStatus(db, MALLORY_APP_ID)).toBe("active");
  });

  test("no session → 302 to login", async () => {
    const db = await seededWorld();
    const res = await get(botFace("default", MALLORY_APP_ID), "", makeEnv(db));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });
});

/**
 * `POST /dashboard/:ref/apps/:appId/park` — the manager's repair for an owner
 * overlap. The route is a thin shell over the store's batch; the store's own
 * guards are pinned in tests/dashboard/targets-store.test.ts.
 */
describe("POST /dashboard/:ref/apps/:appId/park", () => {
  /**
   * The overlap the park repairs: this App's target claims `acme` in `default`
   * and ANOTHER bot's target claims it too — the shape the audit reports. Both
   * bots keep their single target; the duplicate claim is what park settles.
   */
  function seedOverlap(db: ReturnType<typeof createAppsUiD1>, githubAppId: number): string {
    const target = db.raw
      .prepare(
        `SELECT t.id, t.bot_id FROM review_targets t JOIN review_bots b ON b.id = t.bot_id
          WHERE b.github_app_id = ?`,
      )
      .get(githubAppId) as { id: string; bot_id: string };
    db.raw.prepare(`UPDATE review_targets SET account_login = 'acme' WHERE id = ?`).run(target.id);
    const insert = db.raw.prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, installation_id, account_login, review_enabled,
          review_trigger_mode, review_level, check_min_score, check_pass_verdicts,
          allowlist_enabled, created_by, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, NULL, 'acme', 1, 'every_push', NULL, 70, '["ship it"]', 0,
               'mallory', datetime('now'), datetime('now'), NULL)`,
    );
    // Another bot's target in THIS workspace: the claim it duplicates.
    insert.run("park-rival", "default", "app-mstar-inspector-ada", "park-rival");
    return target.id;
  }

  test("an overlap is parked: paused, claim cleared, one audit row, zero GitHub calls", async () => {
    const db = await seededWorld();
    const targetId = seedOverlap(db, MALLORY_APP_ID);
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const res = await post(
        `/dashboard/default/apps/${MALLORY_APP_ID}/park`,
        `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
        makeEnv(db),
      );
      expect(res.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    const row = db.raw
      .query("SELECT review_enabled, account_login FROM review_targets WHERE id = ?")
      .get(targetId) as { review_enabled: number; account_login: string | null };
    expect(row).toEqual({ review_enabled: 0, account_login: null });
    expect(
      db.raw.query("SELECT action, target_id, actor_login FROM audit_events").all(),
    ).toEqual([{ action: "target.park", target_id: targetId, actor_login: "mallory" }]);
  });

  test("a target with no overlapping claim is refused with 409 and zero writes", async () => {
    const db = await seededWorld();
    const auditBefore = db.raw.query("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number };
    const res = await post(
      `/dashboard/default/apps/${MALLORY_APP_ID}/park`,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
    );
    expect(res.status).toBe(409);
    // No account claim at all on this target: nothing to settle.
    expect(await res.text()).toBe("no-overlap");
    expect((db.raw.query("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n).toBe(auditBefore.n);
    expect(reviewEnabled(db, MALLORY_APP_ID)).toBe(1);
  });

  test("a plain member is refused by the manage gate before any write", async () => {
    const db = await seededWorld();
    seedOverlap(db, MALLORY_APP_ID);
    const res = await post(
      `/dashboard/default/apps/${MALLORY_APP_ID}/park`,
      `${SESSION_COOKIE}=${await sessionCookie("hubot")}`,
      makeEnv(db),
    );
    expect(res.status).toBe(403);
    expect(
      (db.raw.query("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n,
    ).toBe(0);
  });
});
