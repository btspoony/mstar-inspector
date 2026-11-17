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
  const row = await createReviewBotsStore(db).createApp({
    id,
    githubSlug: opts.slug,
    githubAppId: opts.githubAppId,
    name: opts.slug,
    privateKeyEnc: enc.privateKeyEnc,
    webhookSecretEnc: enc.webhookSecretEnc,
    createdBy: opts.createdBy,
    workspaceId: "default",
  });
  // A target IS a repository (migration 0067) and creation no longer writes
  // one, so the fixture gives each App its single reviewing target: the App
  // pages' target-owned configuration (pause, trigger mode, gate, depth) reads
  // that row.
  const created = await createTargetsStore(db).create({
    workspaceId: "default",
    botId: id,
    repoId: 900000 + opts.githubAppId,
    repoOwner: "acme",
    repoName: opts.slug,
    createdBy: opts.createdBy,
  });
  if (created.outcome !== "created") throw new Error(`seed: target for ${id} was refused`);
  return row;
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

/** JSON-body POST for the target-addressed settings family. */
async function postTargetJson(
  path: string,
  cookie: string,
  env: Env,
  body: Record<string, unknown>,
): Promise<Response> {
  return await worker.fetch(
    new Request(`https://worker.local${path}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

describe("the Apps list's per-App pause state (target-owned)", () => {
  test("a target in another workspace is invisible: the App still opens with no target facts", async () => {
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

    // Visibility is the APP's: this workspace owns the bot, so the
    // App opens even though it holds no repository here. The foreign target is
    // invisible as target-owned FACT — no id, no pause, no policy.
    const detail = await get(`/dashboard/default/api/apps/${MALLORY_APP_ID}/settings`, cookie, makeEnv(db));
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as Record<string, unknown> & { app: Record<string, unknown> };
    for (const key of ["target_id", "check_gate"]) expect(body).not.toHaveProperty(key);
    expect(body.app).not.toHaveProperty("review_enabled");
    expect(body.app).not.toHaveProperty("review_trigger_mode");
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

describe("an App with no repository yet", () => {
  const SETTINGS_API = `/dashboard/default/api/apps/${MALLORY_APP_ID}/settings`;

  test("a manager opens it: 200 with the App's own facts and no target-owned ones", async () => {
    const db = await seededWorld();
    // The repository surface owns target creation now, so an App the
    // workspace owns routinely has none. Visibility is the APP's.
    db.raw
      .prepare("DELETE FROM review_targets WHERE bot_id = (SELECT id FROM review_bots WHERE github_app_id = ?)")
      .run(MALLORY_APP_ID);

    const res = await get(SETTINGS_API, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { app: Record<string, unknown> };
    expect(body.can_manage).toBe(true);
    expect(body.blocked).toBe(false);
    // Target-owned facts are ABSENT, not defaulted: there is no row to name.
    for (const key of ["target_id", "check_gate"]) expect(body).not.toHaveProperty(key);
    for (const key of ["review_enabled", "review_trigger_mode", "review_level", "default_review_level"]) {
      expect(body.app).not.toHaveProperty(key);
    }
    // The bot's own sections still render: they never needed a target.
    expect(body.app.sandbox_image_id).toBe("omp");
    expect(body).toHaveProperty("keys");
    expect(body).toHaveProperty("installations");
  });

  test("a member reads the same App: 200, identity set only", async () => {
    const db = await seededWorld();
    db.raw
      .prepare("DELETE FROM review_targets WHERE bot_id = (SELECT id FROM review_bots WHERE github_app_id = ?)")
      .run(MALLORY_APP_ID);

    const res = await get(SETTINGS_API, `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { app: Record<string, unknown> };
    expect(body.can_manage).toBe(false);
    expect(body).not.toHaveProperty("target_id");
    expect(body.app).not.toHaveProperty("review_enabled");
    expect(body.app.created_at).toBeDefined();
  });

  /**
   * The add flow routinely gives one App several repositories. The App page
   * owns no target policy any more, so its own configuration must stay
   * reachable: the gate answers `target: null` instead of refusing the App.
   */
  test("an App with SEVERAL repositories still opens, with the target slice absent", async () => {
    const db = await seededWorld();
    db.raw
      .prepare(
        `INSERT INTO review_targets
           (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
            created_by, created_at, updated_at)
         SELECT 'target-second', 'default', b.id, 'acme/second', 901003, 'acme', 'second',
                'mallory', datetime('now'), datetime('now')
           FROM review_bots b WHERE b.github_app_id = ?`,
      )
      .run(MALLORY_APP_ID);

    const res = await get(SETTINGS_API, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { app: Record<string, unknown> };
    expect(body.can_manage).toBe(true);
    // Target-owned facts are ABSENT: two rows name no single configuration.
    for (const key of ["target_id", "check_gate"]) expect(body).not.toHaveProperty(key);
    for (const key of ["review_enabled", "review_trigger_mode", "review_level"]) {
      expect(body.app).not.toHaveProperty(key);
    }
    // The App's own sections still render.
    expect(body).toHaveProperty("keys");
    expect(body).toHaveProperty("installations");
  });
});

describe("GET /dashboard/default/apps/:appId/settings (retired address)", () => {
  const SETTINGS = `/dashboard/default/apps/${MALLORY_APP_ID}/settings`;
  const ownerCookie = async () => `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;

  test("HTML navigation GET answers one 302 to the app's settings tab (no shell read)", async () => {
    const db = await seededWorld();
    const res = await htmlGet(SETTINGS, await ownerCookie(), withSpaAssets(makeEnv(db)));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/dashboard/default/apps/${MALLORY_APP_ID}?tab=settings`);
    expect(await res.text()).not.toContain("window.__BOOT__");
  });

  test("the redirect is address-level: a non-HTML GET takes it too", async () => {
    const db = await seededWorld();
    const res = await get(SETTINGS, "", makeEnv(db));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/dashboard/default/apps/${MALLORY_APP_ID}?tab=settings`);
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
    // The target-scoped save stays available — at its OWN address: the target
    // is what this workspace owns, whatever the bot's scope.
    const targetRow = db.raw
      .query(
        `SELECT t.id FROM review_targets t JOIN review_bots b ON b.id = t.bot_id
          WHERE b.github_app_id = ? AND t.deleted_at IS NULL`,
      )
      .get(MALLORY_APP_ID) as { id: string };
    const saved = await postTargetJson(
      `/dashboard/default/api/targets/${targetRow.id}`,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      { review_level: "quick" },
    );
    expect(saved.status).toBe(200);
    const target = db.raw
      .prepare("SELECT review_level FROM review_targets WHERE id = ?")
      .get(targetRow.id) as { review_level: string };
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
 * The list's shared-bot block — the creation chooser's official mode. It is
 * additive: every existing key keeps its value, and the new key is always
 * present, `[]` when the platform shares nothing.
 */
describe("GET /dashboard/:ref/api/apps — the shared-bot block", () => {
  type SharedBotPayload = { id: string; github_slug: string | null; name: string; target_count: number };
  type ListBody = {
    viewer: { login: string; role: string };
    apps: Array<{ github_app_id: number }>;
    shared_bots: SharedBotPayload[];
  };

  test("the payload is additive and an empty shared set is [], never omitted", async () => {
    const db = await seededWorld();
    const res = await get(
      "/dashboard/default/api/apps",
      `${SESSION_COOKIE}=${await sessionCookie("hubot")}`,
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.viewer).toEqual({ login: "hubot", role: "member" });
    expect(body.apps.map((app) => app.github_app_id).sort()).toEqual([MALLORY_APP_ID, ADA_APP_ID]);
    expect(body.shared_bots).toEqual([]);
  });

  test("a shared bot is offered with this workspace's count and never joins the apps list", async () => {
    const db = await seededWorld();
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES ('ws-other', 'ws-other', 'ws-other', 'hubot', datetime('now'))`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO review_bots
           (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, scope, shared_at, created_at, updated_at)
         VALUES ('app-platform', 'platform-app', 1099, 'Platform App', 'enc', 'enc', 'hubot',
                 'active', 'shared', datetime('now'), datetime('now'), datetime('now'))`,
      )
      .run();
    db.raw
      .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('app-platform', 'ws-other')")
      .run();

    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const res = await get(
        "/dashboard/default/api/apps",
        `${SESSION_COOKIE}=${await sessionCookie("hubot")}`,
        makeEnv(db),
      );
      const body = (await res.json()) as ListBody;
      expect(body.shared_bots).toEqual([
        { id: "app-platform", github_slug: "platform-app", name: "Platform App", target_count: 0 },
      ]);
      // Reading the chooser's list never puts another workspace's bot in
      // `apps`, and never reaches GitHub for it.
      expect(body.apps.map((app) => app.github_app_id).sort()).toEqual([MALLORY_APP_ID, ADA_APP_ID]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/**
 * A workspace's own target on a SHARED bot — the official creation path — is
 * readable from that workspace: the list carries the row (with this
 * workspace's own target state) and the settings/detail face resolves it.
 * Neither widens to a bot the workspace does not own and holds no target on,
 * and an `owned` bot from another workspace is never widened.
 */
describe("a target on a shared bot is visible to the workspace that created it", () => {
  const SHARED_APP_ID = 1099;
  const OTHER_WS = "ws-other";

  /** `ws-other` owns a bot; `default` holds a live target on it when asked. */
  function seedPlatformBot(
    db: ReturnType<typeof createAppsUiD1>,
    opts: {
      id?: string;
      githubAppId?: number;
      scope?: "owned" | "shared";
      targetInDefault?: boolean;
      targetReviewEnabled?: number;
    } = {},
  ): void {
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES (?, ?, ?, NULL, datetime('now'))
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(OTHER_WS, OTHER_WS, OTHER_WS);
    const id = opts.id ?? "app-platform";
    db.raw
      .prepare(
        `INSERT INTO review_bots
           (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, scope, shared_at, created_at, updated_at)
         VALUES (?, 'platform-app', ?, 'Platform App', 'enc', 'enc', 'hubot', 'active', ?,
                 datetime('now'), datetime('now'), datetime('now'))`,
      )
      .run(id, opts.githubAppId ?? SHARED_APP_ID, opts.scope ?? "shared");
    db.raw
      .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)")
      .run(id, OTHER_WS);
    if (opts.targetInDefault !== false) {
      db.raw
        .prepare(
          `INSERT INTO review_targets
             (id, workspace_id, bot_id, name, review_enabled, created_by, created_at, updated_at)
           VALUES (?, 'default', ?, 'Platform App', ?, 'hubot', datetime('now'), datetime('now'))`,
        )
        .run(`target-${id}`, id, opts.targetReviewEnabled ?? 1);
    }
  }

  type ListRow = { github_app_id: number; review_enabled?: number };
  async function listAppsOn(db: ReturnType<typeof createAppsUiD1>): Promise<ListRow[]> {
    const res = await get(
      "/dashboard/default/api/apps",
      `${SESSION_COOKIE}=${await sessionCookie("hubot")}`,
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { apps: ListRow[] }).apps;
  }

  test("the list carries the row, reading THIS workspace's target state", async () => {
    const db = await seededWorld();
    seedPlatformBot(db, { targetReviewEnabled: 0 });

    const rows = await listAppsOn(db);
    expect(rows.map((row) => row.github_app_id).sort()).toEqual(
      [MALLORY_APP_ID, ADA_APP_ID, SHARED_APP_ID].sort(),
    );
    // The pause the row carries is the caller's own target — not the bot's
    // operational switch and not another workspace's target.
    expect(rows.find((row) => row.github_app_id === SHARED_APP_ID)?.review_enabled).toBe(0);
  });

  test("the settings face resolves the workspace's target on that bot", async () => {
    const db = await seededWorld();
    seedPlatformBot(db);

    const res = await get(
      `/dashboard/default/api/apps/${SHARED_APP_ID}/settings`,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspace_id: string;
      target_id: string;
      app: { scope: string; review_enabled: boolean };
    };
    expect(body.workspace_id).toBe("default");
    expect(body.target_id).toBe("target-app-platform");
    expect(body.app.scope).toBe("shared");
    expect(body.app.review_enabled).toBe(true);
  });

  test("a bot the workspace holds no target on stays invisible", async () => {
    const db = await seededWorld();
    // A shared bot nobody in `default` has created a target on...
    seedPlatformBot(db, { id: "app-shared-unused", githubAppId: 1098, targetInDefault: false });
    // ...and an owned bot of the other workspace, never shared.
    seedPlatformBot(db, { id: "app-foreign-owned", githubAppId: 1097, scope: "owned", targetInDefault: false });

    const rows = await listAppsOn(db);
    expect(rows.map((row) => row.github_app_id).sort()).toEqual([MALLORY_APP_ID, ADA_APP_ID]);
    for (const appId of [1098, 1097]) {
      const res = await get(
        `/dashboard/default/api/apps/${appId}/settings`,
        `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
        makeEnv(db),
      );
      expect(res.status, String(appId)).toBe(404);
    }
  });
});

/**
 * The settings payload's `pending_installations` (target page's bind source):
 * the bot's live installations no live target references, additively beside
 * the keys the payload already carried.
 */
describe("the settings payload's pending installations", () => {
  const SHARED_APP_ID = 1099;

  function seedInstallation(
    db: ReturnType<typeof createAppsUiD1>,
    botId: string,
    installationId: number,
    removed = false,
  ): void {
    db.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
         VALUES (?, ?, ?, 'acme', '2026-01-01 00:00:00', ${removed ? "datetime('now')" : "NULL"})`,
      )
      .run(`install-${installationId}`, botId, installationId);
  }

  /** One shared bot owned by `ws-other`, plus `default`'s live target on it. */
  function seedWorldWithBot(db: ReturnType<typeof createAppsUiD1>): void {
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES ('ws-other', 'ws-other', 'ws-other', NULL, datetime('now'))`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO review_bots
           (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, scope, shared_at, created_at, updated_at)
         VALUES ('app-platform', 'platform-app', ?, 'Platform App', 'enc', 'enc', 'hubot',
                 'active', 'shared', datetime('now'), datetime('now'), datetime('now'))`,
      )
      .run(SHARED_APP_ID);
    db.raw
      .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('app-platform', 'ws-other')")
      .run();
    db.raw
      .prepare(
        `INSERT INTO review_targets
           (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
         VALUES ('target-default', 'default', 'app-platform', 'Platform App', 'hubot',
                 datetime('now'), datetime('now'))`,
      )
      .run();
  }

  async function settingsOf(db: ReturnType<typeof createAppsUiD1>): Promise<Record<string, unknown>> {
    const res = await get(
      `/dashboard/default/api/apps/${SHARED_APP_ID}/settings`,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  test("lists the bot's live installations and keeps every existing key", async () => {
    const db = await seededWorld();
    seedWorldWithBot(db);
    seedInstallation(db, "app-platform", 500);
    seedInstallation(db, "app-platform", 600, true);
    // Installations are app-level (migration 0067): another workspace's target
    // binds nothing, so this one is listed like any other live installation.
    seedInstallation(db, "app-platform", 700);

    const body = await settingsOf(db);
    expect(body.pending_installations).toEqual([
      { installation_id: 500, account_login: "acme", seen_at: "2026-01-01 00:00:00" },
      { installation_id: 700, account_login: "acme", seen_at: "2026-01-01 00:00:00" },
    ]);
    // Additive: the keys the payload already carried are unchanged.
    expect(body.installation).toBeNull();
    expect(body.target_id).toBe("target-default");
    expect(body.workspace_id).toBe("default");
  });

  test("an empty pending set is [], never omitted", async () => {
    const db = await seededWorld();
    seedWorldWithBot(db);
    expect((await settingsOf(db)).pending_installations).toEqual([]);

    // An owned bot the workspace may use answers the same, empty shape.
    const owned = await get(
      `/dashboard/default/api/apps/${MALLORY_APP_ID}/settings`,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
    );
    expect(((await owned.json()) as Record<string, unknown>).pending_installations).toEqual([]);
  });
});

/**
 * Bot-scope WRITE authority is independent of the target read.
 *
 * A workspace that keeps a live target on ANOTHER workspace's bot can read that
 * target (the revoked-share case), but the bot itself — lifecycle, provider
 * configuration, keys, verification, metadata — stays the owning workspace's.
 * The trigger this pins: A owns bot B, C has a live target on B, the platform
 * unshares B, so B is `owned` again while C's target survives. C's manager must
 * not reach a single bot-scoped write; A's manager must keep working, and C's
 * target-scoped settings stay its own.
 */
describe("a retained target on another workspace's bot grants no bot-scope write", () => {
  const CONSUMER_WS = "ws-consumer";
  const FOREIGN_APP_ID = MALLORY_APP_ID;
  /** The bot-owned tables a bot-scope write would touch. */
  const MUTABLE_BOT_TABLES = [
    "bot_provider_keys",
    "bot_provider_models",
    "bot_model_config",
    "bot_model_chains",
    "bot_model_chain_seats",
    "bot_custom_providers",
    "bot_installations",
  ] as const;

  /** The revoked-share shape: A's bot, C's surviving target, C's manager. */
  async function crossWorkspaceWorld(): Promise<ReturnType<typeof createAppsUiD1>> {
    const db = await seededWorld();
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES (?, ?, ?, NULL, datetime('now'))`,
      )
      .run(CONSUMER_WS, CONSUMER_WS, CONSUMER_WS);
    // mallory manages BOTH workspaces, so every refusal below is the bot-scope
    // predicate's — never a membership 404/403.
    db.raw
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT ?, id, 'owner', '2026-01-01T00:00:00.000Z' FROM users WHERE github_login = 'mallory'`,
      )
      .run(CONSUMER_WS);
    // The target C created while the bot was shared. Nothing about the bot
    // changed except its scope: it was never C's. It carries its OWN
    // repository identity (0068: one repository belongs to one workspace per
    // bot, so C's row cannot name the repository A's target already holds).
    db.raw
      .prepare(
        `INSERT INTO review_targets
           (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
            created_by, created_at, updated_at)
         SELECT 'target-consumer', ?, b.id, 'consumer', 901002, 'acme', 'consumer-only',
                'mallory', datetime('now'), datetime('now')
           FROM review_bots b WHERE b.github_app_id = ?`,
      )
      .run(CONSUMER_WS, FOREIGN_APP_ID);
    return db;
  }

  function botScopedWriteCounts(db: ReturnType<typeof createAppsUiD1>): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const table of MUTABLE_BOT_TABLES) {
      counts[table] = (db.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    return counts;
  }

  test("every bot-scoped mutation of the consuming workspace refuses, with zero writes", async () => {
    const db = await crossWorkspaceWorld();
    const env = makeEnv(db);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const base = `/dashboard/${CONSUMER_WS}`;
    const before = botScopedWriteCounts(db);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      throw new Error("a bot-scope refusal must never reach GitHub");
    }) as unknown as typeof fetch);
    try {
      // Lifecycle: retire/disable another workspace's bot.
      for (const action of ["disable", "enable", "delete"]) {
        const res = await post(`${base}/apps/${FOREIGN_APP_ID}/${action}`, cookie, env);
        expect(res.status, action).toBe(403);
        expect((await res.json()) as unknown, action).toEqual({
          key: "settings.error.botReadOnly",
          message: t("en", "settings.error.botReadOnly"),
        });
      }
      // The settings family's bot-scoped ops (provider state, chains, keys,
      // the runtime image) — refused; the target-scoped ops are not.
      const botOps: Array<Record<string, string>> = [
        { op: "save-sandbox-image", sandbox_image_id: "omp" },
        { op: "add-key", provider: "zai", key: "sk-bot-scope-matrix" },
        { op: "save-chain", model_chain: "" },
        { op: "save-roles", "role_code-reviewer": "" },
      ];
      for (const fields of botOps) {
        const res = await postForm(`${base}/apps/${FOREIGN_APP_ID}/settings`, cookie, env, fields);
        expect(res.status, fields.op).toBe(403);
        expect(((await res.json()) as { key: unknown }).key, fields.op).toBe("settings.error.botReadOnly");
      }
      // Provider-key verification and its usage probe: both consume the bot's
      // stored credentials, so both are bot-scoped.
      const credentialProbes: Array<[string, Record<string, string>]> = [
        [`${base}/api/apps/${FOREIGN_APP_ID}/keys/verify`, { provider: "anthropic", key: "sk-foreign" }],
        [`${base}/api/apps/${FOREIGN_APP_ID}/keys/usage`, { provider: "zai", keyId: "nope" }],
      ];
      for (const [path, fields] of credentialProbes) {
        const res = await postForm(path, cookie, env, fields);
        expect(res.status, path).toBe(403);
        expect(((await res.json()) as { key: unknown }).key, path).toBe("settings.error.botReadOnly");
      }
      // The forced metadata refresh writes the bot row and reconciles its
      // installation list — bot-scoped.
      const refresh = await post(`${base}/api/apps/${FOREIGN_APP_ID}/refresh-metadata`, cookie, env);
      expect(refresh.status).toBe(403);
      expect(((await refresh.json()) as { key: unknown }).key).toBe("settings.error.botReadOnly");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    // Zero bot writes of any kind, and the bot still belongs to `default`.
    expect(botScopedWriteCounts(db)).toEqual(before);
    expect(appStatus(db, FOREIGN_APP_ID)).toBe("active");
    expect(
      db.raw.query("SELECT workspace_id FROM bot_workspaces WHERE bot_id = (SELECT id FROM review_bots WHERE github_app_id = ?)").get(FOREIGN_APP_ID),
    ).toEqual({ workspace_id: "default" });
    expect(
      db.raw.query("SELECT github_metadata_synced_at FROM review_bots WHERE github_app_id = ?").get(FOREIGN_APP_ID),
    ).toEqual({ github_metadata_synced_at: null });
  });

  /**
   * The payload face of the same rule: a Blocked target carries its OWN
   * configuration and nothing the bot owns. The seeded rows below are exactly
   * what used to ride the face — an installation's account, a delivery with
   * another tenant's repository, the provider/model surfaces.
   */
  test("the settings and models faces carry only target-owned sections", async () => {
    const db = await crossWorkspaceWorld();
    const botId = (
      db.raw.query("SELECT id FROM review_bots WHERE github_app_id = ?").get(FOREIGN_APP_ID) as { id: string }
    ).id;
    db.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
         VALUES ('install-leak', ?, 777, 'acme-org', '2026-01-01 00:00:00', NULL)`,
      )
      .run(botId);
    db.raw
      .prepare(
        `INSERT INTO webhook_deliveries
           (id, bot_id, event_name, outcome, status_code, repository_full_name, created_at)
         VALUES ('delivery-leak', ?, 'pull_request', 'ok', 200, 'secret-org/private-repo', datetime('now'))`,
      )
      .run(botId);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const env = makeEnv(db);

    // Reading the face must not reach GitHub: the lazy metadata refresh is a
    // bot-scope write with the OWNER's credentials.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      throw new Error("a Blocked read must never reach GitHub");
    }) as unknown as typeof fetch);
    let res: Response;
    try {
      res = await get(
        `/dashboard/${CONSUMER_WS}/api/apps/${FOREIGN_APP_ID}/settings`,
        cookie,
        env,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { app: Record<string, unknown> };

    // The target's own configuration is what the face exists for.
    expect(body.blocked).toBe(true);
    expect(body.blocked_reason).toBe("bot_not_shared");
    expect(typeof body.target_id).toBe("string");
    expect(body.workspace_id).toBe(CONSUMER_WS);
    expect(body.check_gate).toEqual({ min_score: 80, pass_verdicts: ["ship it"] });
    expect(body.app.review_trigger_mode).toBe("every_push");
    expect(body.app.review_level).toBeNull();
    expect(body.app.default_review_level).toBe("default");
    expect(body.app.review_enabled).toBe(true);

    // Not one bot-owned section rides the face.
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
      "sandbox_images",
      "model_limits_snapshot",
      "model_role_ids",
      "custom_provider_api_ids",
      "pending_installations",
    ]) {
      expect(key in body, key).toBe(false);
    }
    for (const key of ["sandbox_image_id", "last_webhook_at", "github_metadata_synced_at"]) {
      expect(key in body.app, key).toBe(false);
    }
    // Nor through a copied value: the other tenant's installation account and
    // repository are nowhere in the body.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("acme-org");
    expect(serialized).not.toContain("secret-org/private-repo");

    // The models face is bot-owned end to end, so a Blocked target has none.
    expect(
      db.raw.query("SELECT github_metadata_synced_at FROM review_bots WHERE github_app_id = ?").get(FOREIGN_APP_ID),
    ).toEqual({ github_metadata_synced_at: null });
    const models = await get(`/dashboard/${CONSUMER_WS}/api/apps/${FOREIGN_APP_ID}/models`, cookie, env);
    expect(models.status).toBe(403);
    expect(((await models.json()) as { key: unknown }).key).toBe("settings.error.botReadOnly");

    // Nothing changed for the owning workspace: same bot, full face.
    const owner = await get(`/dashboard/default/api/apps/${FOREIGN_APP_ID}/settings`, cookie, env);
    expect(owner.status).toBe(200);
    const ownerBody = (await owner.json()) as Record<string, unknown>;
    expect(ownerBody.blocked).toBe(false);
    expect(ownerBody.blocked_reason).toBeNull();
    expect(ownerBody.installations).toEqual([
      { installation_id: 777, account_login: "acme-org", seen_at: "2026-01-01 00:00:00" },
    ]);
    expect(Array.isArray(ownerBody.deliveries)).toBe(true);
    expect(Array.isArray(ownerBody.keys)).toBe(true);
    expect(Array.isArray(ownerBody.provider_catalog)).toBe(true);
  });

  test("the consuming workspace keeps its TARGET settings, and the owner keeps the bot", async () => {
    const db = await crossWorkspaceWorld();
    const env = makeEnv(db);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    // Target-scoped: the review depth is this workspace's own target, saved at
    // the target's own address.
    const saved = await postTargetJson(
      `/dashboard/${CONSUMER_WS}/api/targets/target-consumer`,
      cookie,
      env,
      { review_level: "quick" },
    );
    expect(saved.status).toBe(200);
    expect(
      db.raw.query("SELECT review_level FROM review_targets WHERE id = 'target-consumer'").get(),
    ).toEqual({ review_level: "quick" });

    // The owning workspace still manages its own bot.
    const ownerCookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    expect((await post(`/dashboard/default/apps/${FOREIGN_APP_ID}/disable`, ownerCookie, env)).status).toBe(200);
    expect(appStatus(db, FOREIGN_APP_ID)).toBe("disabled");
    const ownerOp = await postForm(
      "/dashboard/default/apps/1001/settings",
      ownerCookie,
      env,
      { op: "save-sandbox-image", sandbox_image_id: "omp" },
    );
    expect(ownerOp.status).toBe(200);
  });
});
