/**
 * Plan 53 Task 2 (T2.1, A4/A8 route side): the settings read path's lazy
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
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import type { Env } from "../../src/worker/env";

const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const SLUG = "mallorys-app";

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
  owner: { avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" },
};

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
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  await createAppsStore(db).createApp({
    id,
    slug: SLUG,
    githubAppId: 1001,
    name: SLUG,
    privateKeyEnc: await box.encryptSecret(privateKeyPem, `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-app-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
  });
  return { db, appId: id };
}

function makeEnv(db: unknown, encryptionKey: string | null = TEST_KEY): Env {
  const env = {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    REVIEW_ENABLED: "true",
    DB: db,
  };
  if (encryptionKey !== null) (env as Record<string, unknown>).DASHBOARD_ENCRYPTION_KEY = encryptionKey;
  return env as Env;
}

const cookie = (login: string) => createSessionValue(login, null, SESSION_SECRET);

async function getSettings(login: string, env: Env): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local/dashboard/api/apps/${SLUG}/settings`, {
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
  created_at: string;
  updated_at: string;
};

const cachedColumns = (db: TestD1, appId: string): CachedColumns =>
  db.raw
    .query(
      "SELECT github_name, github_description, github_html_url, github_avatar_url, github_metadata_synced_at, created_at, updated_at FROM github_apps WHERE id = ?",
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

describe("GET /api/apps/:slug/settings — lazy GitHub-metadata refresh (plan 53 T2.1, AD-531)", () => {
  test("first sync: NULL synced_at → one GET /app, columns persist, response carries the profile, updated_at untouched", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    const { calls } = stubFetch(
      () => new Response(JSON.stringify(GITHUB_PROFILE), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const res = await getSettings("mallory", makeEnv(db));

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/app");
    expect(new Headers(calls[0]!.init!.headers).get("authorization")!.startsWith("Bearer ")).toBe(true);

    const body = (await res.json()) as { app: Record<string, unknown> };
    expect(body.app.github_name).toBe("Acme Inspector");
    expect(body.app.github_description).toBe("PR review bot for Acme");
    expect(body.app.github_html_url).toBe("https://github.com/apps/acme-inspector");
    expect(body.app.github_avatar_url).toBe("https://avatars.githubusercontent.com/u/1?v=4");
    expect(body.app.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // The single store writer persisted exactly the profile columns — and the
    // machine-triggered write never churns the operator timestamp (L5).
    const row = cachedColumns(db, appId);
    expect(row.github_name).toBe("Acme Inspector");
    expect(row.github_description).toBe("PR review bot for Acme");
    expect(row.github_html_url).toBe("https://github.com/apps/acme-inspector");
    expect(row.github_avatar_url).toBe("https://avatars.githubusercontent.com/u/1?v=4");
    expect(row.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.updated_at).toBe(row.created_at);

    // The envelopes never leave the row (Global Constraints).
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("private_key");
    expect(raw).not.toContain(pem);
  });

  test("TTL hit: a synced_at just inside 24h serves the cache with ZERO fetches, on both faces", async () => {
    const { db, appId } = await seededWorld("unused — the refresh must not run");
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

  test("TTL expired: past 24h the refresh runs once and the response carries the update", async () => {
    const pem = await pkcs8PemFixture();
    const { db, appId } = await seededWorld(pem);
    seedCache(db, appId, "datetime('now', '-25 hours')");
    const { calls } = stubFetch(
      () =>
        new Response(JSON.stringify({ ...GITHUB_PROFILE, name: "Renamed Inspector" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

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
    expect(cachedColumns(db, appId).github_metadata_synced_at).toBeNull();
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
    const { calls } = stubFetch(
      () => new Response(JSON.stringify(GITHUB_PROFILE), { status: 200, headers: { "content-type": "application/json" } }),
    );

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
    expect(viewerBody.app.github_avatar_url).toBe("https://avatars.githubusercontent.com/u/1?v=4");
    expect(viewerBody.app.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // The synced-at cache means the second face triggered NO second fetch.
    expect(calls).toHaveLength(1);
    // The base-only face still carries no settings zones (plan 35 T4 pin).
    expect(viewerBody.keys).toBeUndefined();
    expect(viewerBody.provider_catalog).toBeUndefined();
  });
});
