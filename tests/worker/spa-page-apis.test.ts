/**
 * Plan 29 T4: SPA JSON faces for members / apps / settings.
 * Same gates as the HTML pages; payloads never include encrypted columns.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../../src/worker/index";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { Env } from "../../src/worker/env";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { createTestD1 } from "../store/helpers";
import { LOCALE_COOKIE } from "../../src/i18n";

const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";
const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
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
    "0015_provider_verification.sql",
    "0017_app_model_chains.sql",
    "0018_app_sandbox_images.sql",
  ]) {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
  return db;
}

async function seededWorld(): Promise<ReturnType<typeof createTestD1>> {
  const db = createDb();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  const id = crypto.randomUUID();
  const enc = await encryptedColumns(id);
  await createAppsStore(db).createApp({
    id,
    slug: "mstar-inspector-mallory",
    githubAppId: 1001,
    name: "mstar-inspector-mallory",
    privateKeyEnc: enc.privateKeyEnc,
    webhookSecretEnc: enc.webhookSecretEnc,
    createdBy: "mallory",
  });
  return db;
}

function makeEnv(db: unknown): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    REVIEW_ENABLED: "true",
    DB: db,
  } as Env;
}

const cookie = (login: string) => createSessionValue(login, null, SESSION_SECRET);

async function get(path: string, login?: string, env?: Env): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (login) headers.Cookie = `${SESSION_COOKIE}=${await cookie(login)}`;
  return worker.fetch(new Request(`https://worker.local${path}`, { headers }), env ?? makeEnv(await seededWorld()));
}

describe("GET /dashboard/api/members (plan 29 T4)", () => {
  test("admin 200, member 403, anon 302", async () => {
    const db = await seededWorld();
    const env = makeEnv(db);

    const admin = await get("/dashboard/api/members", "octocat", env);
    expect(admin.status).toBe(200);
    const body = (await admin.json()) as { members: Array<{ github_login: string; role: string }> };
    expect(body.members.map((m) => m.github_login).sort()).toEqual(["hubot", "mallory", "octocat"]);
    expect(body.members.some((m) => m.role === "admin")).toBe(true);
    expect(body.members.every((m) => !("invited_by" in m))).toBe(true);

    const member = await get("/dashboard/api/members", "mallory", env);
    expect(member.status).toBe(403);
    const forbidden = await member.text();
    expect(forbidden).toContain("restricted to dashboard admins");
    expect(forbidden).not.toContain('"members"');

    const anon = await get("/dashboard/api/members", undefined, env);
    expect(anon.status).toBe(302);
    expect(anon.headers.get("Location")).toBe("/dashboard/login");
  });
});

describe("GET /dashboard/api/apps (plan 29 T4)", () => {
  test("member 200 JSON with health, never encrypted columns", async () => {
    const db = await seededWorld();
    const env = makeEnv(db);
    const res = await get("/dashboard/api/apps", "hubot", env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      viewer: { login: string; role: string };
      apps: Array<{ slug: string; github_app_id: number; health: { rejected24h: number } }>;
    };
    expect(body.viewer).toEqual({ login: "hubot", role: "member" });
    expect(body.apps).toHaveLength(1);
    expect(body.apps[0]?.slug).toBe("mstar-inspector-mallory");
    expect(body.apps[0]?.github_app_id).toBe(1001);
    expect(body.apps[0]?.health.rejected24h).toBe(0);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("private_key_enc");
    expect(raw).not.toContain("test-pem");
  });
});

describe("GET /dashboard/api/apps/:slug/settings (plan 29 T4)", () => {
  test("creator 200 can_manage; other member 200 can_manage false; unknown slug 404", async () => {
    const db = await seededWorld();
    const env = makeEnv(db);

    const owner = await get("/dashboard/api/apps/mstar-inspector-mallory/settings", "mallory", env);
    expect(owner.status).toBe(200);
    const body = (await owner.json()) as {
      can_manage: boolean;
      app: { slug: string; review_enabled: boolean; created_by: string; sandbox_image_id: string };
      providers: Array<{ id: string; verifiable: boolean }>;
      sandbox_images?: Array<{ id: string; enabled: boolean }>;
    };
    expect(body.app.slug).toBe("mstar-inspector-mallory");
    expect(body.app.review_enabled).toBe(true);
    expect(body.can_manage).toBe(true);
    expect(body.providers.length).toBeGreaterThan(0);
    expect(body.providers.some((p) => p.id === "azure-openai" && p.verifiable === false)).toBe(true);
    expect(body.providers.some((p) => p.id === "workers-ai")).toBe(true);
    // Plan 37: the selected image id defaults to omp, and the manage face
    // carries the enabled-registry selector choices (ids only — never
    // image-local yaml or secrets). omp is NOT a provider catalog entry.
    expect(body.app.sandbox_image_id).toBe("omp");
    expect(body.sandbox_images).toEqual([{ id: "omp", enabled: true }]);
    expect(body.providers.some((p) => p.id === "omp")).toBe(false);
    expect(owner.headers.get("cache-control")).toBe("private, no-store");

    const other = await get("/dashboard/api/apps/mstar-inspector-mallory/settings", "hubot", env);
    expect(other.status).toBe(200);
    // Plan 35 T4 review: non-managers get base+health ONLY — no keys/chains/providers.
    const otherBody = (await other.json()) as {
      can_manage: boolean;
      app: { slug: string; sandbox_image_id: string };
      installations: unknown[];
      deliveries: unknown[];
      keys?: unknown;
      providers?: unknown;
      model_chains?: unknown;
      model_roles?: unknown;
      custom_providers?: unknown;
      sandbox_images?: unknown;
    };
    expect(otherBody.can_manage).toBe(false);
    expect(otherBody.app.slug).toBe("mstar-inspector-mallory");
    expect(otherBody.installations).toEqual([]);
    expect(otherBody.deliveries).toEqual([]);
    // Plan 37: the read-only face keeps the selected image id but NOT the
    // editor's choice list.
    expect(otherBody.app.sandbox_image_id).toBe("omp");
    expect(otherBody.keys).toBeUndefined();
    expect(otherBody.providers).toBeUndefined();
    expect(otherBody.model_chains).toBeUndefined();
    expect(otherBody.model_roles).toBeUndefined();
    expect(otherBody.custom_providers).toBeUndefined();
    expect(otherBody.sandbox_images).toBeUndefined();
    expect(other.headers.get("cache-control")).toBe("private, no-store");

    const missing = await get("/dashboard/api/apps/no-such-app/settings", "octocat", env);
    expect(missing.status).toBe(404);
  });

  test("non-manager POST to settings stays 403 (write family unchanged)", async () => {
    const db = await seededWorld();
    const env = makeEnv(db);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/apps/mstar-inspector-mallory/settings", {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${await cookie("hubot")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "op=save-chain&model_chain=ark-plan%2Fdeepseek-v4-flash",
      }),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("membership stays enforcing outside locale (plan 29 T4)", () => {
  test("row-less session cannot read members or apps JSON", async () => {
    const env = makeEnv(await seededWorld());
    const headers = { Cookie: `${SESSION_COOKIE}=${await cookie("stranger")}`, Accept: "application/json" };
    const members = await worker.fetch(new Request("https://worker.local/dashboard/api/members", { headers }), env);
    expect(members.status).toBe(403);
    const apps = await worker.fetch(new Request("https://worker.local/dashboard/api/apps", { headers }), env);
    expect(apps.status).toBe(403);
  });

  test("forbidden members HTML follows mstar_locale (plan 29 T6: the HTML GET is SPA-owned, so the 403 face is the API route)", async () => {
    const env = makeEnv(await seededWorld());
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/api/members", {
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
