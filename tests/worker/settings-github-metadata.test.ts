/**
 * GitHub-metadata refresh ownership (D45) + the bot-config payload contract.
 * Pinned here:
 *   - the settings GET performs ZERO GitHub fetches in every cache state
 *     (empty, stale, attempt-marked) and writes nothing — 0115 split the
 *     entity and the bot route never resolves App credentials (F2);
 *   - the bot payload carries null App identity/profile fields even when the
 *     cache holds a profile, and it is bot-shaped (`sandbox_image_id`, row id);
 *   - a missing DASHBOARD_ENCRYPTION_KEY leaves the member face at 200: there
 *     is no refresh leg to fail (the manager face keeps its own fail-closed
 *     500 for its key section);
 *   - `POST /api/apps/:appId/refresh-metadata` is the ONLY writer: it fills
 *     the cache, probes visibility, reconciles installations, and leaves
 *     `updated_at` untouched; a following GET still fetches nothing.
 *
 * Setup mirrors tests/worker/spa-page-apis.test.ts (real migrations over the
 * bun:sqlite double, session cookie, worker.fetch); the GitHub API is
 * stubbed via globalThis.fetch (the entry.test.ts precedent).
 */
import { afterEach, describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { createMigratedTestD1, seedDefaultMemberships, seedTarget, type TestD1 } from "../store/helpers";
import type { Env } from "../../src/worker/env";
import { appAvatarUrl } from "../../src/contracts/app-avatar";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const APP_ID = 1001;
// Bot-config routes bind the bot ROW id.
const BOT_ID = "bot-gh-metadata";


async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

function toPem(der: Uint8Array, label: string): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const b64 = btoa(binary);
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

async function pkcs8PemFixture(): Promise<string> {
  const { privateKey } = await generateKeyPair();
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
  return toPem(der, "PRIVATE KEY");
}

const GITHUB_PROFILE = {
  name: "Acme Inspector",
  description: "PR review bot for Acme",
  html_url: "https://github.com/apps/acme-inspector",
  slug: "acme-inspector",
  owner: { avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" },
};

const APP_AVATAR_URL = appAvatarUrl(APP_ID);

const GITHUB_APP_URL = "https://api.github.com/app";
const GITHUB_PUBLIC_APPS_URL = "https://api.github.com/apps/";
const GITHUB_INSTALLATIONS_URL = "https://api.github.com/app/installations?per_page=100";

function githubStub(profile: Record<string, unknown>, probeStatus = 404, installations: number[] = []) {
  const body = JSON.stringify(profile);
  const idList = JSON.stringify(installations.map((id) => ({ id, account: { login: `org-${id}` } })));
  return (url: string) => {
    if (url === GITHUB_APP_URL) {
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === GITHUB_INSTALLATIONS_URL) {
      return new Response(idList, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith(GITHUB_PUBLIC_APPS_URL)) return new Response(null, { status: probeStatus });
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const appProfileCalls = (calls: FetchCall[]) => calls.filter((call) => call.url === GITHUB_APP_URL);


type FetchCall = { url: string; init: RequestInit | undefined };

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { calls };
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});


async function seededWorld(privateKeyPem: string): Promise<{ db: TestD1; appId: string }> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  seedDefaultMemberships(db, { octocat: "owner", mallory: "owner", hubot: "member" });
  const id = BOT_ID;
  const box = createSecretbox(TEST_KEY);
  await createReviewBotsStore(db).createApp({
    id,
    githubSlug: "mallorys-app",
    githubAppId: APP_ID,
    name: "mallorys-app",
    privateKeyEnc: await box.encryptSecret(privateKeyPem, `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-app-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
    workspaceId: "default",
    maxApps: null,
  });
  seedTarget(db, id, { name: "mallorys-app" });
  return { db, appId: id };
}

function makeEnv(db: unknown, encryptionKey: string | null = TEST_KEY): Env {
  const env = {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DB: db,
  };
  if (encryptionKey !== null) (env as Record<string, unknown>).DASHBOARD_ENCRYPTION_KEY = encryptionKey;
  return env as Env;
}

const cookie = (login: string) => createSessionValue(login, null, SESSION_SECRET);

async function postRefresh(login: string, env: Env): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local/dashboard/default/api/apps/${APP_ID}/refresh-metadata`, {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${await cookie(login)}`, "X-Mstar-Spa-Post": "1" },
    }),
    env,
  );
}

async function getSettings(login: string, env: Env): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local/dashboard/default/api/review-bots/${BOT_ID}/settings`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await cookie(login)}`, Accept: "application/json" },
    }),
    env,
  );
}

type CachedColumns = {
  github_name: string | null;
  github_description: string | null;
  github_html_url: string | null;
  github_avatar_url: string | null;
  github_metadata_synced_at: string | null;
  github_metadata_attempted_at: string | null;
  github_visibility: string | null;
  github_slug: string | null;
  created_at: string;
  updated_at: string;
};

const cachedColumns = (db: TestD1, appId: string): CachedColumns =>
  db.raw
    .query(
      "SELECT github_name, github_description, github_html_url, github_avatar_url, github_metadata_synced_at, github_metadata_attempted_at, github_visibility, github_slug, created_at, updated_at FROM github_apps WHERE id = ?",
    )
    .get(appId) as CachedColumns;

function seedCache(db: TestD1, appId: string, syncedAtSql: string): void {
  db.raw
    .query(
      `UPDATE github_apps SET github_name = 'Cached App', github_description = 'cached description',
       github_html_url = 'https://github.com/apps/cached', github_avatar_url = 'https://avatars/u/2',
       github_metadata_synced_at = ${syncedAtSql} WHERE id = ?`,
    )
    .run(appId);
}

describe("GET /api/review-bots/:botId/settings — no metadata refresh (D45)", () => {
  test("an EMPTY cache performs zero GitHub fetches: the read face never refreshes", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    const row = cachedColumns(db, appId);
    expect(row.github_name).toBeNull();
    expect(row.github_metadata_synced_at).toBeNull();
    expect(row.github_metadata_attempted_at).toBeNull();
    expect(row.updated_at).toBe(row.created_at);
  });

  test("a STALE cache (synced_at far past any TTL) still performs zero fetches", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    seedCache(db, appId, "'2020-01-01 00:00:00'");
    const before = cachedColumns(db, appId);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    expect(cachedColumns(db, appId)).toEqual(before);
  });

  test("an attempt marker does not trigger a refresh from the read face", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    db.raw
      .prepare("UPDATE github_apps SET github_metadata_attempted_at = '2020-01-01 00:00:00' WHERE id = ?")
      .run(appId);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE, 200));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  test("the payload carries null App profile fields even when the cache holds a profile", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    seedCache(db, appId, "datetime('now')");
    stubFetch(githubStub(GITHUB_PROFILE));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { app: Record<string, unknown> };
    // F2 + D45: the bot payload is bot-shaped; App identity never rides it.
    for (const key of [
      "github_name",
      "github_description",
      "github_html_url",
      "github_avatar_url",
      "github_metadata_synced_at",
      "github_visibility",
      "github_slug",
      "github_app_id",
    ]) {
      expect(body.app[key], key).toBeNull();
    }
    // The bot's own fields are present.
    expect(body.app.id).toBe(appId);
    expect(body.app.sandbox_image_id).toBe("omp");
    expect(JSON.stringify(body)).not.toContain("Cached App");
  });

  test("manager and member read the same bot-shaped face; neither reaches GitHub", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE, 200));

    const manager = await getSettings("mallory", makeEnv(db));
    const member = await getSettings("hubot", makeEnv(db));

    expect(manager.status).toBe(200);
    expect(member.status).toBe(200);
    expect(calls).toEqual([]);
    const managerBody = (await manager.json()) as { can_manage: boolean; app: { github_name: unknown } };
    const memberBody = (await member.json()) as { can_manage: boolean; app: { github_name: unknown } };
    expect(managerBody.can_manage).toBe(true);
    expect(memberBody.can_manage).toBe(false);
    expect(managerBody.app.github_name).toBeNull();
    expect(memberBody.app.github_name).toBeNull();
    expect(cachedColumns(db, appId).github_metadata_synced_at).toBeNull();
  });

  test("a missing DASHBOARD_ENCRYPTION_KEY leaves the read face at 200 — no refresh leg to fail", async () => {
    const pem = await pkcs8PemFixture();
    const { db } = await seededWorld(pem);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE));

    // The member face carries no key material, so it needs no encryption key;
    // the manager face keeps its fail-closed 500 for its own key section.
    const res = await getSettings("hubot", makeEnv(db, null));

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  test("POST is the only writer: it fills the cache, and a following GET fetches nothing and writes nothing", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE, 200));

    const forced = await postRefresh("mallory", makeEnv(db));
    expect(forced.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      GITHUB_APP_URL,
      GITHUB_INSTALLATIONS_URL,
      `${GITHUB_PUBLIC_APPS_URL}acme-inspector`,
    ]);
    const written = cachedColumns(db, appId);
    expect(written.github_name).toBe("Acme Inspector");
    expect(written.github_slug).toBe("acme-inspector");
    expect(written.github_visibility).toBe("public");
    expect(written.updated_at).toBe(written.created_at);

    const callsBefore = calls.length;
    const read = await getSettings("mallory", makeEnv(db));
    expect(read.status).toBe(200);
    expect(calls.length).toBe(callsBefore);
    expect(cachedColumns(db, appId)).toEqual(written);
  });

  test("POST reconciles installations: an absent row is stamped, a stored-removed row is cleared", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    db.raw
      .prepare(
        "INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('seed-gone', ?, 10, 'gone-org', datetime('now'))",
      )
      .run(appId);
    db.raw
      .prepare(
        "INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at, removed_at) VALUES ('seed-back', ?, 20, 'back-org', datetime('now'), datetime('now'))",
      )
      .run(appId);
    stubFetch(githubStub(GITHUB_PROFILE, 404, [20]));

    const res = await postRefresh("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    const rows = db.raw
      .query("SELECT installation_id, removed_at FROM github_app_installations ORDER BY installation_id")
      .all() as Array<{ installation_id: number; removed_at: string | null }>;
    expect(rows).toEqual([
      { installation_id: 10, removed_at: expect.any(String) },
      { installation_id: 20, removed_at: null },
    ]);
  });
});

describe("POST /api/apps/:appId/refresh-metadata — the manager's forced refresh (D5)", () => {
  test("a fresh cache is bypassed: one GET /app, the rename lands, updated_at untouched", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    seedCache(db, appId, "datetime('now', '-1 hours')");
    const before = cachedColumns(db, appId);
    const { calls } = stubFetch(githubStub({ ...GITHUB_PROFILE, name: "Renamed Inspector" }));

    const res = await postRefresh("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(appProfileCalls(calls)).toHaveLength(1);
    const row = cachedColumns(db, appId);
    expect(row.github_name).toBe("Renamed Inspector");
    expect(row.github_metadata_synced_at).not.toBe(before.github_metadata_synced_at);
    expect(row.updated_at).toBe(row.created_at);
  });

  test("upstream failure → keyed 400 and the cached columns are unchanged", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    seedCache(db, appId, "datetime('now', '-1 hours')");
    const before = cachedColumns(db, appId);
    stubFetch(
      () =>
        new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await postRefresh("mallory", makeEnv(db));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.githubMetadataRefreshFailed",
      message: "GitHub did not return the App's metadata — nothing was refreshed. Check the App still exists, then retry.",
    });
    expect(cachedColumns(db, appId)).toEqual(before);
  });

  test("a plain member is 403 and never reaches the network", async () => {
    const pem = await pkcs8PemFixture();
    const { db } = await seededWorld(pem);
    const { calls } = stubFetch(() => {
      throw new Error("the role gate must run before any fetch");
    });

    const res = await postRefresh("hubot", makeEnv(db));

    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("a missing DASHBOARD_ENCRYPTION_KEY fails closed at the gate (500, zero fetches)", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    const before = cachedColumns(db, appId);
    const { calls } = stubFetch(() => {
      throw new Error("no key means no fetch");
    });

    const res = await postRefresh("mallory", makeEnv(db, null));

    expect(res.status).toBe(500);
    expect(calls).toHaveLength(0);
    expect(cachedColumns(db, appId)).toEqual(before);
  });

  test("unknown and non-numeric App ids are 404 with zero fetches", async () => {
    const pem = await pkcs8PemFixture();
    const { db } = await seededWorld(pem);
    const { calls } = stubFetch(() => {
      throw new Error("unknown Apps never reach the network");
    });
    const env = makeEnv(db);
    for (const segment of ["9999", "not-a-number"]) {
      const res = await worker.fetch(
        new Request(`https://worker.local/dashboard/default/api/apps/${segment}/refresh-metadata`, {
          method: "POST",
          headers: { Cookie: `${SESSION_COOKIE}=${await cookie("mallory")}`, "X-Mstar-Spa-Post": "1" },
        }),
        env,
      );
      expect(res.status, segment).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });
});
