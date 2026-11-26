/**
 * The settings read path's lazy
 * GitHub-metadata refresh + the response contract. Pinned here:
 *   - first sync (NULL synced_at) → exactly ONE GET https://api.github.com/app
 *     (App-JWT face) plus the anonymous `GET /apps/{slug}` visibility probe
 *     (migration 0045), the five migration-0019 columns persist via
 *     saveGithubMetadata, the response carries the profile, and the
 *     operator-mutation timestamp updated_at is untouched;
 *   - TTL: a synced_at inside 24h serves the cache with ZERO fetches (both
 *     faces); past 24h the refresh runs once and the response carries the
 *     update;
 *   - fail-open BY STRUCTURE (AD-531): a `{ok:false}` fetch, an envelope-level
 *     decrypt failure (the Task-1 review handoff), or a missing
 *     DASHBOARD_ENCRYPTION_KEY (architect watch item) all answer 200 with the
 *     cached columns — the refresh leg can never produce a non-200; the
 *     manage branch keeps its pre-existing fail-closed 500 for its own key;
 *   - both faces: the non-manager payload carries the same profile fields
 *     (AC3), and one refresh serves the two faces.
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
  const id = crypto.randomUUID();
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
    new Request(`https://worker.local/dashboard/default/api/apps/${APP_ID}/settings`, {
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
      "SELECT github_name, github_description, github_html_url, github_avatar_url, github_metadata_synced_at, github_metadata_attempted_at, github_visibility, github_slug, created_at, updated_at FROM review_bots WHERE id = ?",
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

describe("GET /api/apps/:appId/settings — lazy GitHub-metadata refresh (AD-531)", () => {
  test("first sync: NULL synced_at → one GET /app, columns persist, response carries the profile, updated_at untouched", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      GITHUB_APP_URL,
      GITHUB_INSTALLATIONS_URL,
      `${GITHUB_PUBLIC_APPS_URL}acme-inspector`,
    ]);
    expect(new Headers(appProfileCalls(calls)[0]!.init!.headers).get("authorization")!.startsWith("Bearer ")).toBe(true);

    const body = (await res.json()) as { app: Record<string, unknown> };
    expect(body.app.github_name).toBe("Acme Inspector");
    expect(body.app.github_description).toBe("PR review bot for Acme");
    expect(body.app.github_html_url).toBe("https://github.com/apps/acme-inspector");
    expect(body.app.github_avatar_url).toBe(APP_AVATAR_URL);
    expect(body.app.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(body.app.github_visibility).toBe("private");

    const row = cachedColumns(db, appId);
    expect(row.github_name).toBe("Acme Inspector");
    expect(row.github_description).toBe("PR review bot for Acme");
    expect(row.github_html_url).toBe("https://github.com/apps/acme-inspector");
    expect(row.github_avatar_url).toBe(APP_AVATAR_URL);
    expect(row.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.github_visibility).toBe("private");
    expect(row.updated_at).toBe(row.created_at);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("private_key");
    expect(raw).not.toContain(pem);
  });

  test("TTL hit: a synced_at just inside 24h serves the cache with ZERO fetches, on both faces", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    seedCache(db, appId, "datetime('now', '-23 hours')");
    const { calls } = stubFetch(() => {
      throw new Error("the TTL window must not touch the network");
    });

    const manager = await getSettings("mallory", makeEnv(db));
    expect(manager.status).toBe(200);
    const managerBody = (await manager.json()) as { can_manage: boolean; app: Record<string, unknown> };
    expect(managerBody.can_manage).toBe(true);
    expect(managerBody.app.github_name).toBe("Cached App");
    expect(managerBody.app.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const viewer = await getSettings("hubot", makeEnv(db));
    expect(viewer.status).toBe(200);
    expect(((await viewer.json()) as { app: Record<string, unknown> }).app.github_name).toBe("Cached App");

    expect(calls).toHaveLength(0);
  });

  test("TTL hit but NULL github_slug: an unsynced row still refreshes and persists the slug", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    seedCache(db, appId, "datetime('now', '-1 hours')");
    db.raw.query("UPDATE review_bots SET github_slug = NULL WHERE id = ?").run(appId);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(appProfileCalls(calls)).toHaveLength(1);
    const body = (await res.json()) as { app: Record<string, unknown> };
    expect(body.app.github_slug).toBe("acme-inspector");
    const row = db.raw.query("SELECT github_slug FROM review_bots WHERE id = ?").get(appId) as {
      github_slug: string | null;
    };
    expect(row.github_slug).toBe("acme-inspector");
  });

  test("TTL expired: past 24h the refresh runs once and the response carries the update", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    seedCache(db, appId, "datetime('now', '-25 hours')");
    const { calls } = stubFetch(githubStub({ ...GITHUB_PROFILE, name: "Renamed Inspector" }));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(appProfileCalls(calls)).toHaveLength(1);
    const body = (await res.json()) as { app: Record<string, unknown> };
    expect(body.app.github_name).toBe("Renamed Inspector");
    const row = cachedColumns(db, appId);
    expect(row.github_name).toBe("Renamed Inspector");
    expect(row.github_metadata_synced_at).not.toBeNull();
  });

  test("an inconclusive visibility probe (503) keeps the stored github_visibility", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    db.raw.query("UPDATE review_bots SET github_visibility = 'private' WHERE id = ?").run(appId);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE, 503));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(appProfileCalls(calls)).toHaveLength(1);
    expect(calls.map((call) => call.url)).toContain(`${GITHUB_PUBLIC_APPS_URL}acme-inspector`);
    const body = (await res.json()) as { app: Record<string, unknown> };
    expect(body.app.github_name).toBe("Acme Inspector");
    expect(body.app.github_visibility).toBe("private");
    const row = cachedColumns(db, appId);
    expect(row.github_name).toBe("Acme Inspector");
    expect(row.github_visibility).toBe("private");
  });

  test("a public probe answer (200) is cached as 'public' and served on the manager face", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    stubFetch(githubStub(GITHUB_PROFILE, 200));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { app: Record<string, unknown> };
    expect(body.app.github_visibility).toBe("public");
    expect(cachedColumns(db, appId).github_visibility).toBe("public");
  });

  test("fetch {ok:false} (HTTP 404) → 200 fail-open with the cached (null) columns; synced_at stays NULL", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    const { calls } = stubFetch(
      () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }),
    );

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const body = (await res.json()) as { app: Record<string, unknown> };
    expect(body.app.github_name).toBeNull();
    expect(body.app.github_description).toBeNull();
    expect(body.app.github_html_url).toBeNull();
    expect(body.app.github_avatar_url).toBeNull();
    expect(body.app.github_metadata_synced_at).toBeNull();
    const row = cachedColumns(db, appId);
    expect(row.github_metadata_synced_at).toBeNull();
    expect(row.github_metadata_attempted_at).toBeNull();
    expect(row.updated_at).toBe(row.created_at);
  });

  test("a permanently failing upstream costs ONE fetch across two settings reads (migration 0037)", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    db.raw.query("UPDATE review_bots SET github_slug = NULL WHERE id = ?").run(appId);
    const { calls } = stubFetch(
      () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }),
    );
    const env = makeEnv(db);

    expect((await getSettings("mallory", env)).status).toBe(200);
    expect((await getSettings("hubot", env)).status).toBe(200);

    expect(calls).toHaveLength(1);
    const row = cachedColumns(db, appId);
    expect(row.github_slug).toBeNull();
    expect(row.github_metadata_synced_at).toBeNull();
    expect(row.github_metadata_attempted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("the attempt marker expires with the TTL: a later read fetches again", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    db.raw
      .query(
        `UPDATE review_bots SET github_slug = NULL,
           github_metadata_attempted_at = datetime('now', '-25 hours') WHERE id = ?`,
      )
      .run(appId);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(appProfileCalls(calls)).toHaveLength(1);
    expect(cachedColumns(db, appId).github_slug).toBe("acme-inspector");
  });

  test("a successful payload WITHOUT a slug stamps the attempt and does not loop", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    db.raw.query("UPDATE review_bots SET github_slug = NULL WHERE id = ?").run(appId);
    const { calls } = stubFetch(githubStub({ name: "Acme Inspector" }));
    const env = makeEnv(db);

    expect((await getSettings("mallory", env)).status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([GITHUB_APP_URL, GITHUB_INSTALLATIONS_URL]);
    const row = cachedColumns(db, appId);
    expect(row.github_name).toBe("Acme Inspector");
    expect(row.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.github_metadata_attempted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    expect((await getSettings("hubot", env)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("force ignores the attempt marker: the manager's refresh always asks GitHub", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    db.raw
      .query(
           github_metadata_attempted_at = datetime('now') WHERE id = ?`,
      )
      .run(appId);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE));

    const res = await postRefresh("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(appProfileCalls(calls)).toHaveLength(1);
    expect(cachedColumns(db, appId).github_slug).toBe("acme-inspector");
  });

  test("envelope-level decrypt failure (Task-1 review handoff) → swallowed, 200 with the manage face intact", async () => {
    const { db, appId } = await seededWorld("this plaintext is unreachable");
    db.raw.query("UPDATE review_bots SET private_key_enc = 'not-an-envelope' WHERE id = ?").run(appId);
    const { calls } = stubFetch(
      () => new Response(JSON.stringify(GITHUB_PROFILE), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    const body = (await res.json()) as { can_manage: boolean; app: Record<string, unknown>; keys: unknown };
    expect(body.can_manage).toBe(true);
    expect(body.app.github_name).toBeNull();
    expect(body.app.github_metadata_synced_at).toBeNull();
    expect(body.keys).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("not-an-envelope");
  });

  test("missing DASHBOARD_ENCRYPTION_KEY → refresh skipped silently (never a 500); the manage branch keeps its existing fail-closed 500", async () => {
    const pem = await pkcs8PemFixture();
    const { db } = await seededWorld(pem);
    const envNoKey = makeEnv(db, null);
    const { calls } = stubFetch(
      () => new Response(JSON.stringify(GITHUB_PROFILE), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const viewer = await getSettings("hubot", envNoKey);
    expect(viewer.status).toBe(200);
    expect(calls).toHaveLength(0);
    const viewerBody = (await viewer.json()) as { can_manage: boolean; app: Record<string, unknown> };
    expect(viewerBody.can_manage).toBe(false);
    expect(viewerBody.app.github_name).toBeNull();

    const manager = await getSettings("mallory", envNoKey);
    expect(manager.status).toBe(500);
    expect(calls).toHaveLength(0);
  });

  test("non-manager sees the profile fields (AC3) — one refresh serves both faces", async () => {
    const pem = await pkcs8PemFixture();
    const { db } = await seededWorld(pem);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE));

    const manager = await getSettings("mallory", makeEnv(db));
    expect(manager.status).toBe(200);
    expect(((await manager.json()) as { app: Record<string, unknown> }).app.github_name).toBe("Acme Inspector");

    const viewer = await getSettings("hubot", makeEnv(db));
    expect(viewer.status).toBe(200);
    const viewerBody = (await viewer.json()) as {
      can_manage: boolean;
      app: Record<string, unknown>;
      keys?: unknown;
      provider_catalog?: unknown;
    };
    expect(viewerBody.can_manage).toBe(false);
    expect(viewerBody.app.github_name).toBe("Acme Inspector");
    expect(viewerBody.app.github_description).toBe("PR review bot for Acme");
    expect(viewerBody.app.github_html_url).toBe("https://github.com/apps/acme-inspector");
    expect(viewerBody.app.github_avatar_url).toBe(APP_AVATAR_URL);
    expect(viewerBody.app.github_slug).toBe("acme-inspector");
    expect(viewerBody.app.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(appProfileCalls(calls)).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(viewerBody.keys).toBeUndefined();
    expect(viewerBody.provider_catalog).toBeUndefined();
  });

  test("a real refresh reconciles installations: an absent row is stamped, a stored-removed row is cleared", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    db.raw
      .prepare(
        "INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('seed-gone', ?, 10, 'gone-org', datetime('now'))",
      )
      .run(appId);
    db.raw
      .prepare(
        "INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at) VALUES ('seed-back', ?, 20, 'back-org', datetime('now'), datetime('now'))",
      )
      .run(appId);
    stubFetch(githubStub(GITHUB_PROFILE, 404, [20]));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    const rows = db.raw
      .query("SELECT installation_id, removed_at FROM bot_installations ORDER BY installation_id")
      .all() as Array<{ installation_id: number; removed_at: string | null }>;
    expect(rows).toEqual([
      { installation_id: 10, removed_at: expect.any(String) },
      { installation_id: 20, removed_at: null },
    ]);
  });

  test("an unusable installation list changes no row and does not turn the refresh into a failure", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    db.raw
      .prepare(
        "INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('seed-live', ?, 10, 'live-org', datetime('now'))",
      )
      .run(appId);
    const profileStub = githubStub(GITHUB_PROFILE);
    stubFetch((url) =>
      url === GITHUB_INSTALLATIONS_URL
        ? new Response("boom", { status: 500 })
        : profileStub(url),
    );

    const res = await postRefresh("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(cachedColumns(db, appId).github_name).toBe("Acme Inspector");
    const row = db.raw
      .query("SELECT removed_at FROM bot_installations WHERE installation_id = 10")
      .get() as { removed_at: string | null };
    expect(row.removed_at).toBeNull();
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
