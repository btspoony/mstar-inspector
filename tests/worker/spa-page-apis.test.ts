/** note: SPA JSON faces for members / apps / settings.
 * Same gates as the HTML pages; payloads never include encrypted columns.
 */
import { describe, expect, spyOn, test } from "bun:test";
import worker from "../../src/worker/index";
import { createSecretbox, SecretboxKeyError } from "../../src/dashboard/secretbox";
import type { D1StatementLike } from "../../src/store/types";
import type { Env } from "../../src/worker/env";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { createTestD1 } from "../store/helpers";
import { SPA_PAGE_APIS_MIGRATIONS, applyMigrations } from "../helpers/migration-shapes";
import type { SpaBoot } from "../../src/spa/boot";
import { LOCALE_COOKIE } from "../../src/i18n";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";
import { htmlGetRequest, withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

async function encryptedColumns(id: string): Promise<{ privateKeyEnc: string; webhookSecretEnc: string }> {
  const box = createSecretbox(TEST_KEY);
  return {
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-app-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
  };
}

function createDb(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  applyMigrations(db, SPA_PAGE_APIS_MIGRATIONS);
  return db;
}

async function seededWorld(): Promise<ReturnType<typeof createTestD1>> {
  const db = createDb();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  // note: Every user joins the migration-seeded `default` workspace: manage is the
  // workspace role, so one owner plus plain members is the interesting shape.
  seedMembership(db, "default", "octocat", "owner");
  seedMembership(db, "default", "mallory", "member");
  seedMembership(db, "default", "hubot", "member");
  // why: A stable local App UID so the payload assertion can name it.
  const id = "app-mallory";
  const enc = await encryptedColumns(id);
  await createReviewBotsStore(db).createApp({
    id,
    githubSlug: "mstar-inspector-mallory",
    githubAppId: 1001,
    name: "mstar-inspector-mallory",
    privateKeyEnc: enc.privateKeyEnc,
    webhookSecretEnc: enc.webhookSecretEnc,
    createdBy: "mallory",
    workspaceId: "default",
    maxApps: null,
  });
  return db;
}

function makeEnv(db: unknown): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
  } as Env;
}

const cookie = (login: string) => createSessionValue(login, null, SESSION_SECRET);

async function get(path: string, login?: string, env?: Env): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (login) headers.Cookie = `${SESSION_COOKIE}=${await cookie(login)}`;
  return worker.fetch(new Request(`https://worker.local${path}`, { headers }), env ?? makeEnv(await seededWorld()));
}

describe("versioned provider catalog", () => {
  const path = "/dashboard/default/api/provider-catalog";

  test("requires sign-in and admits a plain workspace member", async () => {
    const env = makeEnv(await seededWorld());
    const anonymous = await get(path, undefined, env);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toBe("/dashboard/login");
    const response = await get(path, "hubot", env);
    expect(response.status).toBe(200);
    const body = await response.json() as { provider_catalog: Array<Record<string, unknown>> };
    expect(body.provider_catalog.length).toBeGreaterThan(0);
    expect(body.provider_catalog.every((row) => !Object.hasOwn(row, "eligibility"))).toBe(true);
  });

  test("only a matching version is immutable; unversioned/stale reads revalidate with ETag", async () => {
    const env = makeEnv(await seededWorld());
    const settingsResponse = await get("/dashboard/default/api/apps/1001/settings", "octocat", env);
    const settings = await settingsResponse.json() as { provider_catalog_version: string };
    const response = await get(path, "hubot", env);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    const etag = response.headers.get("etag")!;
    expect(etag).toBe(`"${settings.provider_catalog_version}"`);
    const immutable = await get(`${path}?v=${settings.provider_catalog_version}`, "hubot", env);
    expect(immutable.status).toBe(200);
    expect(immutable.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const stale = await get(`${path}?v=stale-fixture-version`, "hubot", env);
    expect(stale.headers.get("cache-control")).toBe("private, no-cache");
    for (const condition of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const notModified = await worker.fetch(new Request(`https://worker.local${path}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await cookie("hubot")}`, "If-None-Match": condition },
      }), env);
      expect(notModified.status).toBe(304);
      expect(notModified.headers.get("cache-control")).toBe("private, no-cache");
      expect(await notModified.text()).toBe("");
    }
    const changed = await worker.fetch(new Request(`https://worker.local${path}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await cookie("hubot")}`, "If-None-Match": '"other"' },
    }), env);
    expect(changed.status).toBe(200);
  });
});

test("concurrent settings reads log the first section's error even when a later key read rejects first", async () => {
  const db = await seededWorld();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let keyStarted!: () => void;
  const laterStarted = new Promise<void>((resolve) => { keyStarted = resolve; });
  function wrap(statement: D1StatementLike, sql: string): D1StatementLike {
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (property === "all" && sql.includes("SELECT installation_id, account_login, seen_at FROM bot_installations")) {
          return async () => { await held; throw new TypeError("earlier installation failure"); };
        }
        if (property === "all" && sql.includes("SELECT * FROM bot_provider_keys WHERE bot_id")) {
          return async () => { keyStarted(); throw new SecretboxKeyError("later key failure"); };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const pending = get("/dashboard/default/api/apps/1001/settings", "octocat", makeEnv({
      prepare: (sql: string) => wrap(db.prepare(sql), sql), batch: db.batch.bind(db),
    }));
    await laterStarted;
    release();
    const response = await pending;
    expect(response.status).toBe(500);
    expect(warnings.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({
      event: "dashboard_settings", stage: "api_render", error_type: "TypeError", key_error: false,
    }));
  } finally {
    release();
    warnings.mockRestore();
  }
});

describe("the retired deployment-level members face", () => {
  test("GET /dashboard/api/members is gone; the workspace face serves", async () => {
    // note: Authority is workspace-scoped, so a deployment-level member list has no
    // meaning: the root path is a 404 and the workspace face is the only one.
    const env = makeEnv(await seededWorld());
    const root = await worker.fetch(
      new Request("https://worker.local/dashboard/api/members", {
        headers: { Accept: "application/json", Cookie: `${SESSION_COOKIE}=${await cookie("octocat")}` },
      }),
      env,
    );
    expect(root.status).toBe(404);
  });
});

describe("GET /dashboard/default/api/apps", () => {
  test("member 200 JSON with health, never encrypted columns", async () => {
    const db = await seededWorld();
    const env = makeEnv(db);
    const res = await get("/dashboard/default/api/apps", "hubot", env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      viewer: { login: string; role: string };
      apps: Array<{
        github_app_id: number;
        github_name: string | null;
        github_slug: string | null;
        github_avatar_url: string | null;
        slug?: string;
        health: { rejected24h: number };
      }>;
    };
    expect(body.viewer).toEqual({ login: "hubot", role: "member" });
    expect(body.apps).toHaveLength(1);
    expect(body.apps[0]?.github_app_id).toBe(1001);
    expect(body.apps[0]?.github_name).toBeNull();
    expect(body.apps[0]?.github_slug).toBe("mstar-inspector-mallory");
    expect(body.apps[0]?.github_avatar_url).toBeNull();
    // note: The local webhook path is not an App address any more (D0/D6).
    expect(body.apps[0]?.slug).toBeUndefined();
    expect(body.apps[0]?.health.rejected24h).toBe(0);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("private_key_enc");
    expect(raw).not.toContain("test-pem");
  });
});

describe("GET /dashboard/default/api/apps/:appId/settings", () => {
  test("creator 200 can_manage; other member 200 can_manage false; unknown App id 404", async () => {
    const db = await seededWorld();
    const env = makeEnv(db);

    // note: Manage is the workspace role, not App creation: 0027 maps the seeded
    // deployment admin to `owner` and every other user to `member`.
    const owner = await get("/dashboard/default/api/apps/1001/settings", "octocat", env);
    expect(owner.status).toBe(200);
    const body = (await owner.json()) as {
      can_manage: boolean;
      workspace_id: string;
      targets_many: boolean;
      target_id?: string;
      app: {
        github_app_id: number;
        github_slug: string | null;
        id: string;
        review_enabled?: boolean;
        created_by: string;
        sandbox_image_id: string;
      };
      configured_providers?: Array<{ kind: string }>;
      provider_catalog?: Array<{ id: string; tier: string; verifiable: boolean; eligibility: string }>;
      provider_catalog_version: string;
      provider_eligibility: Record<string, string>;
      model_limits_snapshot?: unknown;
      providers?: unknown;
      sandbox_images?: Array<{ id: string; enabled: boolean }>;
    };
    expect(body.app.github_app_id).toBe(1001);
    expect(body.app.github_slug).toBe("mstar-inspector-mallory");
    expect(body.app.id).toBe("app-mallory");
    expect(body.workspace_id).toBe("default");
    // why: Creation writes the App and its workspace mapping only (D13), so this
    // workspace holds no repository under it: the target-owned policy is
    // absent rather than invented, and `targets_many: false` is what separates
    // "none" from "several". The App stays fully readable either way.
    expect(body.targets_many).toBe(false);
    expect(body.target_id).toBeUndefined();
    expect(body.app.review_enabled).toBeUndefined();
    expect(body.can_manage).toBe(true);
    // note: clean cutover: the old `providers` catalog dump is gone; the
    // manage face splits persisted state from the discovery catalog.
    expect(body.providers).toBeUndefined();
    // note: Fresh world = the unconfigured-App case: persisted state is EMPTY while
    // the catalog is fully populated.
    expect(body.configured_providers).toEqual([]);
    expect(body.provider_catalog).toBeUndefined();
    expect(body.model_limits_snapshot).toBeUndefined();
    expect(body.provider_catalog_version).toMatch(/^[0-9a-f]{64}$/);
    expect(body.provider_eligibility["azure-openai"]).toBe("builtin");
    expect(body.provider_eligibility["workers-ai"]).toBe("template");
    // invariant: omp is the selected runtime image: zero rows are unavailable this
    // iteration, and omp itself is NOT a catalog entry.
    expect(Object.values(body.provider_eligibility)).not.toContain("unavailable");
    // note: the selected image id defaults to omp, and the manage face
    // carries the enabled-registry selector choices (ids only — never
    // image-local yaml or secrets).
    expect(body.app.sandbox_image_id).toBe("omp");
    expect(body.sandbox_images).toEqual([{ id: "omp", enabled: true }]);
    expect(body.provider_eligibility["omp"]).toBeUndefined();
    expect(owner.headers.get("cache-control")).toBe("private, no-store");

    // note: The App's creator is a plain workspace member here, so creation no
    // longer grants the manage face.
    const other = await get("/dashboard/default/api/apps/1001/settings", "mallory", env);
    expect(other.status).toBe(200);
    // invariant: identity-only non-manager face: the D4 identity set + the cached
    // public GitHub profile + can_manage false — NO health or ops data.
    const otherBody = (await other.json()) as {
      can_manage: boolean;
      app: Record<string, unknown>;
      installations?: unknown;
      deliveries?: unknown;
      delivery_summary?: unknown;
      keys?: unknown;
      configured_providers?: unknown;
      provider_catalog?: unknown;
      providers?: unknown;
      model_chains?: unknown;
      model_roles?: unknown;
      custom_providers?: unknown;
      sandbox_images?: unknown;
    };
    expect(otherBody.can_manage).toBe(false);
    expect(otherBody.app.github_app_id).toBe(1001);
    expect(otherBody.app.github_slug).toBe("mstar-inspector-mallory");
    // note: The derived Blocked pair rides both faces. No repository target exists
    // here, so neither `target_id` nor its pause state is named: the identity
    // set is exactly the App's own fields.
    expect(Object.keys(otherBody).sort()).toEqual([
      "app",
      "blocked",
      "blocked_reason",
      "can_manage",
      "workspace_id",
    ]);
    expect(Object.keys(otherBody.app).sort()).toEqual([
      "created_at",
      "created_by",
      "github_app_id",
      "github_avatar_url",
      "github_description",
      "github_html_url",
      "github_metadata_synced_at",
      "github_name",
      "github_slug",
      "id",
      "status",
    ]);
    expect(typeof otherBody.app.created_at).toBe("string");
    // note: health/ops fields moved behind the manager branch; the settings
    // zones never ride this face.
    expect(otherBody.installations).toBeUndefined();
    expect(otherBody.deliveries).toBeUndefined();
    expect(otherBody.delivery_summary).toBeUndefined();
    expect(otherBody.keys).toBeUndefined();
    expect(otherBody.configured_providers).toBeUndefined();
    expect(otherBody.provider_catalog).toBeUndefined();
    expect(otherBody).not.toHaveProperty("provider_catalog_version");
    expect(otherBody).not.toHaveProperty("provider_eligibility");
    expect(otherBody.model_chains).toBeUndefined();
    expect(otherBody.model_roles).toBeUndefined();
    expect(otherBody.custom_providers).toBeUndefined();
    expect(otherBody.sandbox_images).toBeUndefined();
    expect(other.headers.get("cache-control")).toBe("private, no-store");

    const missing = await get("/dashboard/default/api/apps/9999/settings", "octocat", env);
    expect(missing.status).toBe(404);

    // invariant: The App segment is decimal digits only: `0x3e9` / `1.001e3` parse to the
    // seeded 1001 under `Number()`, so a lax segment check would answer the
    // App's settings under a second URL.
    for (const alias of ["0x3e9", "1.001e3", "1e3", "+1001"]) {
      const res = await get(`/dashboard/default/api/apps/${alias}/settings`, "octocat", env);
      expect(res.status, alias).toBe(404);
    }
  });

  test("non-manager POST to settings stays 403 (write family unchanged)", async () => {
    const db = await seededWorld();
    const env = makeEnv(db);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/default/apps/1001/settings", {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${await cookie("hubot")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "op=save-chain&model_chain=ark%2Fdeepseek-v4-flash",
      }),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("membership stays enforcing outside locale", () => {
  test("row-less session cannot read the members or apps JSON", async () => {
    const env = makeEnv(await seededWorld());
    const headers = { Cookie: `${SESSION_COOKIE}=${await cookie("stranger")}`, Accept: "application/json" };
    const apps = await worker.fetch(new Request("https://worker.local/dashboard/default/api/apps", { headers }), env);
    expect(apps.status).toBe(403);
  });

  test("the members-family 403 follows mstar_locale (workspace-scoped face)", async () => {
    // why: Members + invites are workspace routes now, so the 403 surface is the
    // workspace one: a plain member asking for the pending list.
    const db = await seededWorld();
    db.raw.exec(
      "INSERT INTO workspaces (id, slug, name, created_at) VALUES ('ws-locale', 'acme', 'Acme', '2026-01-01T00:00:00.000Z')",
    );
    db.raw.exec(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT 'ws-locale', id, 'member', '2026-01-01T00:00:00.000Z' FROM users WHERE github_login = 'mallory'`,
    );
    const env = makeEnv(db);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/acme/api/members/invites", {
        headers: {
          Cookie: `${SESSION_COOKIE}=${await cookie("mallory")}; ${LOCALE_COOKIE}=zh_CN`,
          Accept: "application/json",
        },
      }),
      env,
    );
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("管理员");
    expect(html).not.toContain("restricted to dashboard admins");
  });
});

/** invariant: The boot the served shell injected (the client's only identity channel). */
function bootOf(html: string): SpaBoot {
  const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
  if (json === undefined) throw new Error("no injected SPA boot");
  return JSON.parse(json) as SpaBoot;
}

function seedWorkspace(db: ReturnType<typeof createTestD1>, id: string, slug: string, name: string, deletedAt: string | null = null): void {
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_at, deleted_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ?)")
    .run(id, slug, name, deletedAt);
}

function seedMembership(db: ReturnType<typeof createTestD1>, workspaceId: string, login: string, role: string): void {
  db.raw
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT ?, id, ?, '2026-01-01T00:00:00.000Z' FROM users WHERE github_login = ?`,
    )
    .run(workspaceId, role, login);
}

describe("SPA boot payload — workspace memberships (2026-10)", () => {
  test("lists every live membership as {id, slug, name, role} — both identifiers, not one ref", async () => {
    const db = await seededWorld();
    // why: A login outside the seeded `default` workspace, so the list is exactly
    // the three rows below.
    await createUser(db, { login: "switcher", role: "member" });
    seedWorkspace(db, "ws-acme", "acme", "Acme");
    seedWorkspace(db, "ws_7d41", "ws_7d41", "Side project");
    seedWorkspace(db, "ws-gone", "gone", "Retired", "2026-02-01T00:00:00.000Z");
    seedMembership(db, "ws-acme", "switcher", "owner");
    seedMembership(db, "ws_7d41", "switcher", "member");
    seedMembership(db, "ws-gone", "switcher", "member");
    const env = makeEnv(db);
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/acme/apps", { Cookie: `${SESSION_COOKIE}=${await cookie("switcher")}` }),
      withSpaAssets(env),
    );
    expect(res.status).toBe(200);
    const boot = bootOf(await res.text());
    // invariant: Ordering is by name; the soft-deleted workspace never becomes a switch
    // target. Both identifiers ride the row: `ws-acme` was renamed to `acme`,
    // so a path addressing either form must resolve to this same membership.
    // `plan` rides each row in both modes (D16), `self-hosted` resolving the
    // one plan every workspace has there.
    expect(boot.memberships).toEqual([
      { id: "ws-acme", slug: "acme", name: "Acme", role: "owner", plan: "Unlimited" },
      { id: "ws_7d41", slug: "ws_7d41", name: "Side project", role: "member", plan: "Unlimited" },
    ]);
  });

  test("a login with no workspace carries no memberships", async () => {
    const db = createDb();
    await createUser(db, { login: "loner", role: "member" });
    const res = await worker.fetch(
      htmlGetRequest("/dashboard", { Cookie: `${SESSION_COOKIE}=${await cookie("loner")}` }),
      withSpaAssets(makeEnv(db)),
    );
    expect(bootOf(await res.text()).memberships).toBeUndefined();
  });
});
