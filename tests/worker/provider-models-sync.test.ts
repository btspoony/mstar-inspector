import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createMigratedTestD1, seedDefaultMemberships, seedTarget } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createAppConfigStore, type AppConfigD1 } from "../../src/dashboard/app-config-store";
import { MAX_CUSTOM_PROVIDER_MODEL_IDS } from "../../src/contracts/provider-models";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import worker from "../../src/worker/index";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const APP_ID = 1001;
const SETTINGS = `/dashboard/default/apps/${APP_ID}/settings`;
const PREVIEW = `/dashboard/default/api/apps/${APP_ID}/provider-models/preview`;
const SEED_KEY = "sk-commandcode-seed-1234";

async function seededWorld() {
  const db = createMigratedTestD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  seedDefaultMemberships(db, { octocat: "owner", mallory: "owner" });
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  const app = await createReviewBotsStore(db).createApp({
    id,
    githubSlug: "mallorys-app",
    githubAppId: APP_ID,
    name: "mallorys-app",
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
    workspaceId: "default",
    maxApps: null,
  });
  seedTarget(db, id, { name: "mallorys-app" });
  return { db, app, store: createAppConfigStore(db as AppConfigD1, TEST_KEY) };
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

async function declare(
  store: ReturnType<typeof createAppConfigStore>,
  appId: string,
  decl: { provider_id: string; base_url: string; api: "openai-completions"; model_ids: string[] },
  withKey: boolean,
): Promise<void> {
  await store.upsertCustomProvider(appId, decl, SEED_KEY);
  if (!withKey) {
    const [key] = await store.listCustomProviderKeys(appId, decl.provider_id);
    if (key !== undefined) await store.deleteCustomProviderKey(appId, decl.provider_id, key.keyId);
  }
}

async function post(login: string, env: Env, fields: Record<string, string>): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local${SETTINGS}`, {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    }),
    env,
  );
}

async function preview(login: string, env: Env, provider: string): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local${PREVIEW}?provider=${encodeURIComponent(provider)}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}` },
    }),
    env,
  );
}

function mockVocabulary(entries: Array<{ id: string; supported_endpoints?: string[] }>): ReturnType<typeof spyOn> {
  return spyOn(globalThis, "fetch").mockImplementation((async () =>
    new Response(JSON.stringify({ object: "list", data: entries }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch);
}

const LIVE = [
  { id: "deepseek/deepseek-v4-pro", supported_endpoints: ["/chat/completions", "/responses"] },
  { id: "Qwen/Qwen3.8-Max", supported_endpoints: ["/chat/completions"] },
  { id: "claude-sonnet-5-5", supported_endpoints: ["/messages"] },
];

const COMMANDCODE = {
  provider_id: "commandcode",
  base_url: "https://api.commandcode.ai/provider/v1",
  api: "openai-completions" as const,
};

describe("provider model sync (I-000644)", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  test("a keyless provider syncs: the fetched list replaces the stored one, ids verbatim", async () => {
    const { db, app, store } = await seededWorld();
    await declare(store, app.id, { ...COMMANDCODE, model_ids: ["stale-a", "stale-b"] }, false);
    const outbound: RequestInit[] = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_u: string, init?: RequestInit) => {
      outbound.push(init ?? {});
      return new Response(JSON.stringify({ object: "list", data: LIVE }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const res = await post("mallory", makeEnv(db), { op: "sync-provider-models", provider: "commandcode" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Synced 2 models for commandcode");
    expect(new Headers(outbound[0]?.headers).get("authorization")).toBeNull();

    const [decl] = await store.listCustomProviders(app.id);
    expect(decl!.model_ids).toEqual(["deepseek/deepseek-v4-pro", "Qwen/Qwen3.8-Max"]);
  });

  test("a stored key is presented when the pool has one; the same list is stored either way", async () => {
    const { db, app, store } = await seededWorld();
    await declare(store, app.id, { ...COMMANDCODE, model_ids: ["stale-a"] }, true);
    const seen: Array<string | null> = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_u: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ data: LIVE }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch);

    const res = await post("mallory", makeEnv(db), { op: "sync-provider-models", provider: "commandcode" });
    expect(res.status).toBe(200);
    expect(seen).toEqual([`Bearer ${SEED_KEY}`]);
    const [decl] = await store.listCustomProviders(app.id);
    expect(decl!.model_ids).toEqual(["deepseek/deepseek-v4-pro", "Qwen/Qwen3.8-Max"]);
  });

  test("a provider error leaves the stored list untouched", async () => {
    const { db, app, store } = await seededWorld();
    await declare(store, app.id, { ...COMMANDCODE, model_ids: ["keep-me"] }, false);
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      new Response(JSON.stringify({ error: {} }), { status: 500 })) as unknown as typeof fetch);

    const res = await post("mallory", makeEnv(db), { op: "sync-provider-models", provider: "commandcode" });
    expect(res.status).toBe(400);
    const [decl] = await store.listCustomProviders(app.id);
    expect(decl!.model_ids).toEqual(["keep-me"]);
  });

  test("an empty list leaves the stored list untouched and says so", async () => {
    const { db, app, store } = await seededWorld();
    await declare(store, app.id, { ...COMMANDCODE, model_ids: ["keep-me"] }, false);
    fetchSpy = mockVocabulary([]);

    const res = await post("mallory", makeEnv(db), { op: "sync-provider-models", provider: "commandcode" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("providerModelsEmpty");
    const [decl] = await store.listCustomProviders(app.id);
    expect(decl!.model_ids).toEqual(["keep-me"]);
  });

  test("a keyless endpoint that demands a key says so, not 'invalid key', and writes nothing", async () => {
    const { db, app, store } = await seededWorld();
    await declare(
      store,
      app.id,
      { provider_id: "deepseek", base_url: "https://api.deepseek.com/v1", api: "openai-completions", model_ids: ["keep-me"] },
      false,
    );
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      new Response(JSON.stringify({ error: { message: "Authentication Fails" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch);

    const res = await post("mallory", makeEnv(db), { op: "sync-provider-models", provider: "deepseek" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("providerModelsKeyRequired");
    const [decl] = await store.listCustomProviders(app.id);
    expect(decl!.model_ids).toEqual(["keep-me"]);
  });

  test("a list past the store's bound is refused whole, never silently clipped", async () => {
    const { db, app, store } = await seededWorld();
    await declare(store, app.id, { ...COMMANDCODE, model_ids: ["keep-me"] }, false);
    fetchSpy = mockVocabulary(
      Array.from({ length: MAX_CUSTOM_PROVIDER_MODEL_IDS + 1 }, (_, i) => ({
        id: `model-${i}`,
        supported_endpoints: ["/chat/completions"],
      })),
    );

    const res = await post("mallory", makeEnv(db), { op: "sync-provider-models", provider: "commandcode" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("modelIdsTooMany");
    const [decl] = await store.listCustomProviders(app.id);
    expect(decl!.model_ids).toEqual(["keep-me"]);
  });

  test("the preview states the replace arithmetic and writes nothing", async () => {
    const { db, app, store } = await seededWorld();
    await declare(
      store,
      app.id,
      { ...COMMANDCODE, model_ids: ["deepseek/deepseek-v4-pro", "stale-a", "stale-b"] },
      false,
    );
    fetchSpy = mockVocabulary(LIVE);

    const res = await preview("mallory", makeEnv(db), "commandcode");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      provider: "commandcode",
      current: 3,
      fetched: 2,
      kept: 1,
      added: 1,
      dropped: 2,
    });
    const [decl] = await store.listCustomProviders(app.id);
    expect(decl!.model_ids).toEqual(["deepseek/deepseek-v4-pro", "stale-a", "stale-b"]);
  });

  test("an undeclared provider is refused before any outbound request", async () => {
    const { db } = await seededWorld();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called for an undeclared provider");
    }) as unknown as typeof fetch);

    const res = await post("mallory", makeEnv(db), { op: "sync-provider-models", provider: "never-declared" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("customProviderUndeclared");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
