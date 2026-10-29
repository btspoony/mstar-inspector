/**
 * The settings read path's lazy
 * GitHub-metadata refresh + the response contract. Pinned here:
 *   - first sync (NULL synced_at) → exactly ONE GET https://api.github.com/app
 *     (App-JWT face), the five migration-0019 columns persist via
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
import { createAppsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { createMigratedTestD1, seedDefaultMemberships, type TestD1 } from "../store/helpers";
import type { Env } from "../../src/worker/env";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
/** The App's immutable GitHub App id — the only App address form (D0). */
const APP_ID = 1001;

// --- test RSA key material (the tests/dashboard/github-app-metadata.test.ts
// face — duplicated per the tests-are-not-modules convention) ---

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

/** DER bytes → armored PEM (64-col base64, the standard wrap). */
function toPem(der: Uint8Array, label: string): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const b64 = btoa(binary);
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

/** A fresh PKCS#8 PEM (workerd WebCrypto's format — mints a real JWT). */
async function pkcs8PemFixture(): Promise<string> {
  const { privateKey } = await generateKeyPair();
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
  return toPem(der, "PRIVATE KEY");
}

/** A realistic GET /app public profile. */
const GITHUB_PROFILE = {
  name: "Acme Inspector",
  description: "PR review bot for Acme",
  html_url: "https://github.com/apps/acme-inspector",
  slug: "acme-inspector",
  owner: { avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" },
};

/** The App icon derived from the numeric App id — no CDN request is made. */
const APP_AVATAR_URL = `https://avatars.githubusercontent.com/in/${APP_ID}?s=120&v=4`;

/**
 * One refresh = exactly ONE request (`GET /app`): the icon is derived, so any
 * other upstream URL is a failure, not a silent answer.
 */
function githubStub(profile: Record<string, unknown>) {
  return (url: string) => {
    if (url !== "https://api.github.com/app") throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(profile), { status: 200, headers: { "content-type": "application/json" } });
  };
}

// --- fetch stubbing (tests/worker/entry.test.ts precedent) ---

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

// --- world setup (tests/worker/spa-page-apis.test.ts pattern) ---

async function seededWorld(privateKeyPem: string): Promise<{ db: TestD1; appId: string }> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  seedDefaultMemberships(db, { octocat: "owner", mallory: "owner", hubot: "member" });
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  await createAppsStore(db).createApp({
    id,
    githubSlug: "mallorys-app",
    githubAppId: APP_ID,
    name: "mallorys-app",
    privateKeyEnc: await box.encryptSecret(privateKeyPem, `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-app-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
    workspaceId: "default",
  });
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

/** The manager's forced refresh — one POST, no form body. */
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
  github_slug: string | null;
  created_at: string;
  updated_at: string;
};

const cachedColumns = (db: TestD1, appId: string): CachedColumns =>
  db.raw
    .query(
      "SELECT github_name, github_description, github_html_url, github_avatar_url, github_metadata_synced_at, github_metadata_attempted_at, github_slug, created_at, updated_at FROM github_apps WHERE id = ?",
    )
    .get(appId) as CachedColumns;

/** Seed a cached profile + a synced_at RELATIVE to now (the TEXT convention). */
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
    expect(calls.map((call) => call.url)).toEqual(["https://api.github.com/app"]);
    expect(new Headers(calls[0]!.init!.headers).get("authorization")!.startsWith("Bearer ")).toBe(true);

    const body = (await res.json()) as { app: Record<string, unknown> };
    expect(body.app.github_name).toBe("Acme Inspector");
    expect(body.app.github_description).toBe("PR review bot for Acme");
    expect(body.app.github_html_url).toBe("https://github.com/apps/acme-inspector");
    expect(body.app.github_avatar_url).toBe(APP_AVATAR_URL);
    expect(body.app.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // The single store writer persisted exactly the profile columns — and the
    // machine-triggered write never churns the operator timestamp (L5).
    const row = cachedColumns(db, appId);
    expect(row.github_name).toBe("Acme Inspector");
    expect(row.github_description).toBe("PR review bot for Acme");
    expect(row.github_html_url).toBe("https://github.com/apps/acme-inspector");
    expect(row.github_avatar_url).toBe(APP_AVATAR_URL);
    expect(row.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.updated_at).toBe(row.created_at);

    // The envelopes never leave the row (Global Constraints).
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("private_key");
    expect(raw).not.toContain(pem);
  });

  test("TTL hit: a synced_at just inside 24h serves the cache with ZERO fetches, on both faces", async () => {
    // A VALID PEM (not a garbage marker): the zero-fetch pin below must be
    // load-bearing — a refresh-always regression would mint past the key
    // check, reach the throwing stub, and fail the call-count assert (a
    // garbage PEM would fail pre-stub and pin nothing).
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
    // The migration-0036 upgrade case: 0019 already stamped
    // github_metadata_synced_at, so the row is "fresh" while github_slug stays
    // NULL and the bot mention is dead. Opening the settings page is the
    // documented remedy, so it MUST fetch exactly once here.
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    seedCache(db, appId, "datetime('now', '-1 hours')");
    db.raw.query("UPDATE github_apps SET github_slug = NULL WHERE id = ?").run(appId);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(["https://api.github.com/app"]);
    const body = (await res.json()) as { app: Record<string, unknown> };
    expect(body.app.github_slug).toBe("acme-inspector");
    const row = db.raw.query("SELECT github_slug FROM github_apps WHERE id = ?").get(appId) as {
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
    expect(calls).toHaveLength(1);
    const body = (await res.json()) as { app: Record<string, unknown> };
    expect(body.app.github_name).toBe("Renamed Inspector");
    const row = cachedColumns(db, appId);
    expect(row.github_name).toBe("Renamed Inspector");
    expect(row.github_metadata_synced_at).not.toBeNull();
  });

  test("fetch {ok:false} (HTTP 404) → 200 fail-open with the cached (null) columns; synced_at stays NULL", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    const { calls } = stubFetch(
      () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }),
    );

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1); // one attempt, zero retries (AD-531)
    const body = (await res.json()) as { app: Record<string, unknown> };
    expect(body.app.github_name).toBeNull();
    expect(body.app.github_description).toBeNull();
    expect(body.app.github_html_url).toBeNull();
    expect(body.app.github_avatar_url).toBeNull();
    expect(body.app.github_metadata_synced_at).toBeNull();
    const row = cachedColumns(db, appId);
    expect(row.github_metadata_synced_at).toBeNull();
    // This row still caches a slug, so it has no NULL-slug re-attempt to
    // floor: the marker stays untouched and only the profile columns are
    // involved. The operator timestamp holds (machine write).
    expect(row.github_metadata_attempted_at).toBeNull();
    expect(row.updated_at).toBe(row.created_at);
  });

  test("a permanently failing upstream costs ONE fetch across two settings reads (migration 0037)", async () => {
    // The 404/401/403 case: nothing is ever written to the profile columns, so
    // without an attempt marker the NULL-slug rule re-fetches on every read —
    // one `/app` call plus up to the 5 s timeout per open, for every member.
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    db.raw.query("UPDATE github_apps SET github_slug = NULL WHERE id = ?").run(appId);
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
        `UPDATE github_apps SET github_slug = NULL,
           github_metadata_attempted_at = datetime('now', '-25 hours') WHERE id = ?`,
      )
      .run(appId);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE));

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(["https://api.github.com/app"]);
    expect(cachedColumns(db, appId).github_slug).toBe("acme-inspector");
  });

  test("a successful payload WITHOUT a slug stamps the attempt and does not loop", async () => {
    // The degraded-payload case: the profile persists (so synced_at is fresh)
    // while the slug stays NULL, which is the re-attempt trigger. Without the
    // marker every read would fetch again.
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    db.raw.query("UPDATE github_apps SET github_slug = NULL WHERE id = ?").run(appId);
    // Neither `slug` nor a derivable html_url: both slug sources degrade.
    const { calls } = stubFetch(githubStub({ name: "Acme Inspector" }));
    const env = makeEnv(db);

    expect((await getSettings("mallory", env)).status).toBe(200);
    expect(calls).toHaveLength(1); // GET /app only — the icon needs no request
    const row = cachedColumns(db, appId);
    expect(row.github_name).toBe("Acme Inspector");
    expect(row.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.github_metadata_attempted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    expect((await getSettings("hubot", env)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("force ignores the attempt marker: the manager's refresh always asks GitHub", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    db.raw
      .query(
        `UPDATE github_apps SET github_slug = NULL,
           github_metadata_attempted_at = datetime('now') WHERE id = ?`,
      )
      .run(appId);
    const { calls } = stubFetch(githubStub(GITHUB_PROFILE));

    const res = await postRefresh("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(["https://api.github.com/app"]);
    expect(cachedColumns(db, appId).github_slug).toBe("acme-inspector");
  });

  test("envelope-level decrypt failure (Task-1 review handoff) → swallowed, 200 with the manage face intact", async () => {
    const { db, appId } = await seededWorld("this plaintext is unreachable");
    // Corrupt the stored envelope AFTER seeding — decryptSecret throws on it.
    db.raw.query("UPDATE github_apps SET private_key_enc = 'not-an-envelope' WHERE id = ?").run(appId);
    const { calls } = stubFetch(
      () => new Response(JSON.stringify(GITHUB_PROFILE), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const res = await getSettings("mallory", makeEnv(db));

    // Fail-open by structure: the leg's own catch-all served the cached row —
    // the refresh never reached the network and never hit the route's 500 face.
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    const body = (await res.json()) as { can_manage: boolean; app: Record<string, unknown>; keys: unknown };
    expect(body.can_manage).toBe(true);
    expect(body.app.github_name).toBeNull();
    expect(body.app.github_metadata_synced_at).toBeNull();
    expect(body.keys).toEqual([]); // the manage face rendered fully
    expect(JSON.stringify(body)).not.toContain("not-an-envelope");
  });

  test("missing DASHBOARD_ENCRYPTION_KEY → refresh skipped silently (never a 500); the manage branch keeps its existing fail-closed 500", async () => {
    const pem = await pkcs8PemFixture(); // decryptable — only the missing key blocks the refresh
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

    // Pre-existing face, untouched by this plan (spec: the missing-key 500
    // belongs to the manage branch only).
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
    // The synced-at cache means the second face triggered NO second fetch:
    // one refresh = the two requests of the first face.
    expect(calls).toHaveLength(1);
    // The base-only face still carries no settings zones (pin).
    expect(viewerBody.keys).toBeUndefined();
    expect(viewerBody.provider_catalog).toBeUndefined();
  });
});

describe("POST /api/apps/:appId/refresh-metadata — the manager's forced refresh (D5)", () => {
  test("a fresh cache is bypassed: one GET /app, the rename lands, updated_at untouched", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    // The read path would serve this cache untouched for another hour.
    seedCache(db, appId, "datetime('now', '-1 hours')");
    const before = cachedColumns(db, appId);
    const { calls } = stubFetch(githubStub({ ...GITHUB_PROFILE, name: "Renamed Inspector" }));

    const res = await postRefresh("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(["https://api.github.com/app"]);
    const row = cachedColumns(db, appId);
    expect(row.github_name).toBe("Renamed Inspector");
    expect(row.github_metadata_synced_at).not.toBe(before.github_metadata_synced_at);
    // The forced refresh is still a machine write: the operator timestamp holds.
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

    // An unreachable GitHub is a retryable operator condition, never a broken
    // server: the keyed 400 lets the SPA localize the cause.
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

    // requireAppSettings owns the encryption-key precondition: it fails closed
    // with 500 before the refresh core runs (the read face's silent skip is a
    // different, deliberately fail-open contract).
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
