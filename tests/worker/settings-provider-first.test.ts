import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMigratedTestD1, seedDefaultMemberships, seedTarget } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import {
  CUSTOM_PROVIDER_API_IDS,
  MAX_KEYS_PER_PROVIDER,
  createAppConfigStore,
  MODEL_ROLE_IDS,
} from "../../src/dashboard/app-config-store";
import { THINKING_LEVELS, composeModelOptions, findFailingSelector, selectorBase } from "../../src/dashboard/model-membership";
import { THINKING_LEVELS as RUNNER_THINKING_LEVELS } from "../../packages/runner/src/token-usage";
import { PROVIDER_IDS } from "../../src/dashboard/app-config-store";
import {
  LEGACY_PROVIDER_IDS,
  PROVIDER_CATALOG,
  PROVIDER_IDS_COMMON,
} from "../../src/contracts/provider-catalog.generated";
import { MAX_CUSTOM_PROVIDER_MODEL_IDS } from "../../src/contracts/provider-models";
import { hasUsageProbe } from "../../src/dashboard/provider-usage";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import worker from "../../src/worker/index";
import { sk, OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const PLAIN_KEY = sk("ant-mallory-verify-9988");
const APP_ID = 1001;
const SETTINGS = `/dashboard/default/apps/${APP_ID}/settings`;
const VERIFY = `/dashboard/default/api/apps/${APP_ID}/keys/verify`;
const MODELS = `/dashboard/default/api/apps/${APP_ID}/models`;
const SETTINGS_JSON = `/dashboard/default/api/apps/${APP_ID}/settings`;

type ConfiguredRow = {
  kind: string;
  provider?: string;
  key_id?: string;
  last4?: string;
  updated_at?: string | null;
  verified_at?: string | null;
  verified_status?: string | null;
  provider_id?: string;
  base_url?: string;
  api?: string;
  model_ids?: string[];
};

async function seededWorld() {
  const db = createMigratedTestD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  seedDefaultMemberships(db, { octocat: "owner", mallory: "owner", hubot: "member" });
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
  return { db, app };
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

async function postForm(
  path: string,
  login: string,
  env: Env,
  fields: Record<string, string>,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local${path}`, {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${await cookie(login)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    }),
    env,
  );
}

async function getJson(path: string, login: string, env: Env): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local${path}`, {
      headers: {
        Cookie: `${SESSION_COOKIE}=${await cookie(login)}`,
        Accept: "application/json",
      },
    }),
    env,
  );
}

async function readSettingsWithCatalog(response: Response, env: Env): Promise<unknown> {
  const settings = await response.json() as {
    provider_catalog_version: string;
    provider_eligibility: Record<string, string>;
    provider_catalog?: unknown;
  };
  expect(settings.provider_catalog).toBeUndefined();
  expect(settings.provider_catalog_version).toMatch(/^[0-9a-f]{64}$/);
  const catalogResponse = await getJson(
    `/dashboard/default/api/provider-catalog?v=${settings.provider_catalog_version}`, "mallory", env,
  );
  expect(catalogResponse.status).toBe(200);
  const catalog = await catalogResponse.json() as { provider_catalog: Array<{ id: string }> };
  return {
    ...settings,
    ...catalog,
    provider_catalog: catalog.provider_catalog.map((row) => ({
      ...row, eligibility: settings.provider_eligibility[row.id],
    })),
  };
}

async function keyIdOf(plainKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plainKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

function mockModelsOk(ids: string[]): ReturnType<typeof spyOn> {
  return spyOn(globalThis, "fetch").mockImplementation(
    (async () =>
      new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch,
  );
}

function mockStatus(status: number, body: unknown = {}): ReturnType<typeof spyOn> {
  return spyOn(globalThis, "fetch").mockImplementation(
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch,
  );
}

describe("selector membership helpers (spec §6.3)", () => {
  test("selectorBase strips a known thinking level and requires a provider prefix", () => {
    expect(selectorBase("anthropic/claude-sonnet-4-6:high")).toEqual({
      provider: "anthropic",
      literal: "claude-sonnet-4-6:high",
      model: "claude-sonnet-4-6",
      base: "anthropic/claude-sonnet-4-6",
    });
    expect(selectorBase("bare-model")).toBeNull();
  });

  test("selectorBase keeps a colon-embedded model id literal", () => {
    expect(selectorBase("ollama-cloud/deepseek-v4.1-flash:1017")).toEqual({
      provider: "ollama-cloud",
      literal: "deepseek-v4.1-flash:1017",
      model: "deepseek-v4.1-flash:1017",
      base: "ollama-cloud/deepseek-v4.1-flash:1017",
    });
    expect(selectorBase("my-custom/qwen3:32b")?.model).toBe("qwen3:32b");
    expect(selectorBase("ollama-cloud/deepseek-v4.1-flash:1017:high")).toEqual({
      provider: "ollama-cloud",
      literal: "deepseek-v4.1-flash:1017:high",
      model: "deepseek-v4.1-flash:1017",
      base: "ollama-cloud/deepseek-v4.1-flash:1017",
    });
  });

  test("selectorBase resolves an unambiguous abbreviation and the legacy thinking alias", () => {
    expect(selectorBase("anthropic/claude-sonnet-4-6:med")).toEqual({
      provider: "anthropic",
      literal: "claude-sonnet-4-6:med",
      model: "claude-sonnet-4-6",
      base: "anthropic/claude-sonnet-4-6",
    });
    expect(selectorBase("anthropic/claude-sonnet-4-6:xhi")?.model).toBe("claude-sonnet-4-6");
    expect(selectorBase("anthropic/claude-sonnet-4-6:thinking")?.model).toBe("claude-sonnet-4-6");
    // A single character is not an abbreviation — it stays part of the id.
    expect(selectorBase("anthropic/claude-sonnet-4-6:h")?.model).toBe("claude-sonnet-4-6:h");
  });

  test("dashboard THINKING_LEVELS cannot drift from the runner vocabulary", () => {
    expect(Object.keys(THINKING_LEVELS).sort()).toEqual(Object.keys(RUNNER_THINKING_LEVELS).sort());
  });

  test("composeModelOptions groups verified cache then custom declarations; probe rows have no selectors", () => {
    const groups = composeModelOptions(
      [
        { provider: "anthropic", models: ["claude-sonnet-4-6", "claude-opus-4-7"], fetched_at: "now" },
        { provider: "copilot", models: [], fetched_at: "now" },
        { provider: "ark", models: ["doubao-seed-2-1-pro"], fetched_at: "now" },
      ],
      [{ provider_id: "my-custom", model_ids: ["local-7b"], has_keys: true }],
    );
    expect(groups).toEqual([
      { provider: "anthropic", source: "verified", selectors: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-7"] },
      { provider: "copilot", source: "probe", selectors: [] },
      { provider: "ark", source: "verified", selectors: ["ark/doubao-seed-2-1-pro"] },
      { provider: "my-custom", source: "custom", selectors: ["my-custom/local-7b"] },
    ]);
  });

  test("findFailingSelector: (a) cache hit / miss / variant; (b) probe-only + no-row syntax; (c) custom declaration", () => {
    const verified = [
      { provider: "anthropic", models: ["claude-sonnet-4-6"], fetched_at: "now" },
      { provider: "copilot", models: [], fetched_at: "now" },
    ];
    const custom = [{ provider_id: "my-custom", model_ids: ["local-7b"], has_keys: true }];
    expect(findFailingSelector(["anthropic/claude-sonnet-4-6:high"], verified, custom)).toBeNull();
    expect(findFailingSelector(["anthropic/claude-opus-4-7"], verified, custom)).toBe("anthropic/claude-opus-4-7");
    expect(findFailingSelector(["copilot/anything"], verified, custom)).toBeNull();
    expect(findFailingSelector(["openai/gpt-5"], verified, custom)).toBeNull();
    expect(findFailingSelector(["my-custom/local-7b"], verified, custom)).toBeNull();
    expect(findFailingSelector(["my-custom/nope"], verified, custom)).toBe("my-custom/nope");
  });

  test("a model id that embeds a colon passes membership literally against cache and custom declarations", () => {
    const verified = [{ provider: "ollama-cloud", models: ["deepseek-v4.1-flash:1017"], fetched_at: "now" }];
    expect(findFailingSelector(["ollama-cloud/deepseek-v4.1-flash:1017"], verified, [])).toBeNull();
    expect(findFailingSelector(["ollama-cloud/deepseek-v4.1-flash"], verified, [])).toBe("ollama-cloud/deepseek-v4.1-flash");
    expect(findFailingSelector(["ollama-cloud/deepseek-v4.1-flash:1017:high"], verified, [])).toBeNull();
    const custom = [{ provider_id: "my-custom", model_ids: ["qwen3:32b"], has_keys: true }];
    expect(findFailingSelector(["my-custom/qwen3:32b"], [], custom)).toBeNull();
  });

  test("a literal id ending in a thinking level wins over the stripped base", () => {
    const verified = [{ provider: "openrouter", models: ["glm-4.7:max"], fetched_at: "now" }];
    expect(findFailingSelector(["openrouter/glm-4.7:max"], verified, [])).toBeNull();
    const custom = [{ provider_id: "my-custom", model_ids: ["glm-4.7:max"], has_keys: true }];
    expect(findFailingSelector(["my-custom/glm-4.7:max"], [], custom)).toBeNull();
  });

  test("abbreviated and legacy thinking tails resolve to the cached base model", () => {
    const verified = [{ provider: "anthropic", models: ["claude-sonnet-4-6"], fetched_at: "now" }];
    expect(findFailingSelector(["anthropic/claude-sonnet-4-6:med"], verified, [])).toBeNull();
    expect(findFailingSelector(["anthropic/claude-sonnet-4-6:xhi"], verified, [])).toBeNull();
    expect(findFailingSelector(["anthropic/claude-sonnet-4-6:thinking"], verified, [])).toBeNull();
    expect(findFailingSelector(["anthropic/claude-sonnet-4-6:h"], verified, [])).toBe("anthropic/claude-sonnet-4-6:h");
  });

  test("a KEYLESS custom declaration is offered nothing and rejected everywhere — an unknown provider still stays syntax-only", () => {
    const drained = [{ provider_id: "my-custom", model_ids: ["local-7b"], has_keys: false }];
    expect(composeModelOptions([], drained)).toEqual([]);
    expect(findFailingSelector(["my-custom/local-7b"], [], drained)).toBe("my-custom/local-7b");
    expect(findFailingSelector(["openai/gpt-5"], [], drained)).toBeNull();
  });
});

describe("POST /dashboard/api/apps/:appId/keys/verify", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  test("401 from the provider → 400 invalid_key, key NOT stored, body never echoes the key", async () => {
    const { db } = await seededWorld();
    fetchSpy = mockStatus(401, { error: { message: "nope" } });
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: PLAIN_KEY });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ ok: false, reason: "invalid_key" });
    expect(JSON.stringify(body)).not.toContain(PLAIN_KEY);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get() as { n: number }).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_models").get() as { n: number }).toEqual({ n: 0 });
  });

  test("network reject → 400 unreachable, nothing stored", async () => {
    const { db } = await seededWorld();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: PLAIN_KEY });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, reason: "unreachable" });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get() as { n: number }).toEqual({ n: 0 });
  });

  test("success stores via saveVerifiedKey and returns verified models, never the key", async () => {
    const { db, app } = await seededWorld();
    fetchSpy = mockModelsOk(["claude-sonnet-4-6", "claude-opus-4-7"]);
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: PLAIN_KEY });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; provider: string; models: string[] };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe("anthropic");
    expect(body.models).toContain("claude-sonnet-4-6");
    expect(JSON.stringify(body)).not.toContain(PLAIN_KEY);
    const store = createAppConfigStore(db, TEST_KEY);
    const keys = await store.listProviderKeys(app.id);
    expect(keys).toEqual([expect.objectContaining({ provider: "anthropic", last4: PLAIN_KEY.slice(-4) })]);
    const cached = await store.getVerifiedModels(app.id);
    expect(cached).toEqual([
      expect.objectContaining({ provider: "anthropic", models: expect.arrayContaining(["claude-sonnet-4-6"]) }),
    ]);
  });

  test("unsupported built-in → 400 unsupported_provider, nothing stored", async () => {
    const { db } = await seededWorld();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called for unsupported providers");
    }) as unknown as typeof fetch);
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "azure-openai", key: PLAIN_KEY });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, reason: "unsupported_provider" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get() as { n: number }).toEqual({ n: 0 });
  });

  const TEMPLATE_DECL = {
    provider_id: "opencode-go",
    base_url: "https://opencode.example/v1",
    api: "openai-completions" as const,
    model_ids: ["go-model-1", "go-model-2"],
  };
  const CUSTOM_DECL = {
    provider_id: "my-gateway",
    base_url: "https://gateway.example/api",
    api: "anthropic-messages" as const,
    model_ids: ["local-7b"],
  };

  async function declaredWorld(decl: typeof TEMPLATE_DECL | typeof CUSTOM_DECL) {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    const seedKey = sk("seed-key-1234");
    await store.upsertCustomProvider(app.id, decl, seedKey);
    await store.deleteCustomProviderKey(app.id, decl.provider_id, await keyIdOf(seedKey));
    return { db, app, store };
  }

  for (const [tier, decl] of [
    ["template-tier", TEMPLATE_DECL],
    ["custom", CUSTOM_DECL],
  ] as const) {
    test(`a declared ${tier} id verifies against its declaration and appends one key`, async () => {
      const { db, app, store } = await declaredWorld(decl);
      db.raw
        .prepare("UPDATE review_bots SET sandbox_image_id = 'legacy-runtime' WHERE id = ?")
        .run(app.id);
      fetchSpy = mockStatus(200, {});
      const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: decl.provider_id, key: PLAIN_KEY });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, provider: decl.provider_id });
      const probe = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(probe[0].startsWith(decl.base_url)).toBe(true);
      expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_provider_keys").get() as { n: number }).toEqual({ n: 1 });
      expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get() as { n: number }).toEqual({ n: 0 });
      expect(await store.listCustomProviders(app.id)).toEqual([{ ...decl, has_keys: true }]);
    });
  }

  test("a declared id whose verify is rejected returns the structured reason and writes nothing", async () => {
    const { db, app, store } = await declaredWorld(CUSTOM_DECL);
    fetchSpy = mockStatus(401, { error: { message: "nope" } });
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: CUSTOM_DECL.provider_id, key: PLAIN_KEY });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid_key" });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_provider_keys").get() as { n: number }).toEqual({ n: 0 });
    expect((await store.listCustomProviders(app.id)).map((row) => row.has_keys)).toEqual([false]);
  });

  test("other member 403", async () => {
    const { db } = await seededWorld();
    const res = await postForm(VERIFY, "hubot", makeEnv(db), { provider: "anthropic", key: PLAIN_KEY });
    expect(res.status).toBe(403);
  });
});

describe("GET /dashboard/api/apps/:appId/models", () => {
  test("returns grouped selector grammar from verified cache + custom declarations", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.saveVerifiedKey(app.id, "anthropic", PLAIN_KEY, ["claude-sonnet-4-6"]);
    await store.saveVerifiedKey(app.id, "ark", PLAIN_KEY, ["doubao-seed-2-1-pro"]);
    await store.saveVerifiedKey(app.id, "copilot", PLAIN_KEY, []);
    await store.upsertCustomProvider(
      app.id,
      {
        provider_id: "my-custom",
        base_url: "https://example.com/v1",
        api: "openai-completions",
        model_ids: ["local-7b"],
      },
      sk("custom-9988"),
    );
    const res = await getJson(MODELS, "mallory", makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Array<{ provider: string; source: string; selectors: string[] }> };
    expect(body.groups).toEqual([
      { provider: "anthropic", source: "verified", selectors: ["anthropic/claude-sonnet-4-6"] },
      { provider: "ark", source: "verified", selectors: ["ark/doubao-seed-2-1-pro"] },
      { provider: "copilot", source: "probe", selectors: [] },
      { provider: "my-custom", source: "custom", selectors: ["my-custom/local-7b"] },
    ]);
    expect(JSON.stringify(body)).not.toContain(PLAIN_KEY);
    expect(JSON.stringify(body)).not.toContain(sk("custom"));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("a drained custom pool stops offering models and stops validating chains, while the declaration stays editable", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    const env = makeEnv(db);
    const decl = {
      provider_id: "my-custom",
      base_url: "https://example.com/v1",
      api: "openai-completions" as const,
      model_ids: ["local-7b"],
    };
    await store.upsertCustomProvider(app.id, decl, PLAIN_KEY);

    type ModelsBody = { groups: Array<{ provider: string; selectors: string[] }> };
    const before = await getJson(MODELS, "mallory", env);
    const beforeBody = (await before.json()) as ModelsBody;
    expect(beforeBody.groups.map((group) => group.provider)).toContain("my-custom");
    const keyedChain = await postForm(SETTINGS, "mallory", env, { op: "save-chain", model_chain: "my-custom/local-7b" });
    expect(keyedChain.status).toBe(200);

    await store.deleteCustomProviderKey(app.id, "my-custom", await keyIdOf(PLAIN_KEY));
    expect(await store.listCustomProviderKeys(app.id, "my-custom")).toEqual([]);

    const after = await getJson(MODELS, "mallory", env);
    const afterBody = (await after.json()) as ModelsBody;
    expect(afterBody.groups.map((group) => group.provider)).not.toContain("my-custom");
    expect(afterBody.groups.flatMap((group) => group.selectors)).not.toContain("my-custom/local-7b");

    const rejected = await postForm(SETTINGS, "mallory", env, {
      op: "save-chain",
      model_chain: "my-custom/local-7b",
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      code: "not_in_verified_models",
      message: "Selector my-custom/local-7b is not in this App's verified models.",
      selector: "my-custom/local-7b",
    });
    expect(await store.getModelChain(app.id)).toBe("my-custom/local-7b");

    const settings = await getJson(SETTINGS_JSON, "mallory", env);
    const payload = (await settings.json()) as { configured_providers: ConfiguredRow[] };
    expect(payload.configured_providers.filter((row) => row.kind === "custom")).toEqual([
      { kind: "custom", ...decl },
    ]);

    await store.addCustomProviderKey(app.id, "my-custom", sk("custom-ark-5555"), {
      base_url: decl.base_url,
      api: decl.api,
    });
    const restored = await getJson(MODELS, "mallory", env);
    const restoredBody = (await restored.json()) as ModelsBody;
    expect(restoredBody.groups.flatMap((group) => group.selectors)).toContain("my-custom/local-7b");
    const restoredChain = await postForm(SETTINGS, "mallory", env, {
      op: "add-chain",
      name: "fast",
      chain: "my-custom/local-7b",
    });
    expect(restoredChain.status).toBe(200);
  });
});

describe("POST save-chain / save-roles membership", () => {
  test("selector in the verified cache (with variant) saves; unknown cache member 400s and is not stored", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.saveVerifiedKey(app.id, "anthropic", PLAIN_KEY, ["claude-sonnet-4-6"]);
    const env = makeEnv(db);
    const ok = await postForm(SETTINGS, "mallory", env, {
      op: "save-chain",
      model_chain: "anthropic/claude-sonnet-4-6:high",
    });
    expect(ok.status).toBe(200);
    expect(await store.getModelChain(app.id)).toBe("anthropic/claude-sonnet-4-6:high");
    const fail = await postForm(SETTINGS, "mallory", env, {
      op: "save-chain",
      model_chain: "anthropic/claude-opus-4-7",
    });
    expect(fail.status).toBe(400);
    const failBody = await fail.json();
    expect(failBody).toEqual({
      code: "not_in_verified_models",
      message: "Selector anthropic/claude-opus-4-7 is not in this App's verified models.",
      selector: "anthropic/claude-opus-4-7",
    });
    expect(await store.getModelChain(app.id)).toBe("anthropic/claude-sonnet-4-6:high");
  });

  test("a stored legacy :thinking selector re-saves verbatim against a cache holding only the base", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.saveVerifiedKey(app.id, "anthropic", PLAIN_KEY, ["claude-sonnet-4-6"]);
    const stored = "anthropic/claude-sonnet-4-6:thinking";
    await store.setModelChain(app.id, stored);
    const env = makeEnv(db);
    const res = await postForm(SETTINGS, "mallory", env, { op: "save-chain", model_chain: stored });
    expect(res.status).toBe(200);
    expect(await store.getModelChain(app.id)).toBe(stored);
  });

  test("no cache row (or probe-only empty cache) stays syntax-only — existing chains still save", async () => {
    const { db, app } = await seededWorld();
    const env = makeEnv(db);
    const noRow = await postForm(SETTINGS, "mallory", env, { op: "save-chain", model_chain: "openai/gpt-5:thinking" });
    expect(noRow.status).toBe(200);
    const store = createAppConfigStore(db, TEST_KEY);
    await store.saveVerifiedKey(app.id, "copilot", PLAIN_KEY, []);
    const probe = await postForm(SETTINGS, "mallory", env, { op: "save-chain", model_chain: "copilot/not-listed" });
    expect(probe.status).toBe(200);
  });

  test("custom provider membership uses declared model_ids, not bot_provider_models", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.upsertCustomProvider(
      app.id,
      {
        provider_id: "my-custom",
        base_url: "https://example.com/v1",
        api: "openai-completions",
        model_ids: ["local-7b"],
      },
      sk("custom-9988"),
    );
    const env = makeEnv(db);
    const ok = await postForm(SETTINGS, "mallory", env, { op: "save-chain", model_chain: "my-custom/local-7b" });

    expect(ok.status).toBe(200);
    const fail = await postForm(SETTINGS, "mallory", env, { op: "save-chain", model_chain: "my-custom/nope" });
    expect(fail.status).toBe(400);
    expect(await fail.json()).toEqual({
      code: "not_in_verified_models",
      message: "Selector my-custom/nope is not in this App's verified models.",
      selector: "my-custom/nope",
    });
    expect((await store.getVerifiedModels(app.id)).some((row) => row.provider === "my-custom")).toBe(false);
  });

  test("save-roles references chains: unknown chain 400s, blank still clears", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.upsertModelChain(app.id, "seat-mstar-review-seat", "anthropic/claude-sonnet-4-6:high");
    const env = makeEnv(db);
    const roles = Object.fromEntries(MODEL_ROLE_IDS.map((role) => [`role_${role}`, ""]));
    const fail = await postForm(SETTINGS, "mallory", env, {
      op: "save-roles",
      ...roles,
      "role_mstar-review-seat": "no-such-chain",
    });
    expect(fail.status).toBe(400);
    expect(await fail.text()).toContain("mstar-review-seat is not a known model chain");
    const ok = await postForm(SETTINGS, "mallory", env, {
      op: "save-roles",
      ...roles,
      "role_mstar-review-seat": "seat-mstar-review-seat",
    });
    expect(ok.status).toBe(200);
    expect(await store.getModelChainSeats(app.id)).toEqual({
      "mstar-review-seat": "seat-mstar-review-seat",
    });
    const clear = await postForm(SETTINGS, "mallory", env, { op: "save-roles", ...roles });
    expect(clear.status).toBe(200);
    expect(await store.getModelChainSeats(app.id)).toEqual({});
  });
});

describe("POST save-sandbox-image (spec § Technical interfaces)", () => {
  test("creator saves an enabled registry id; the selection persists and rides the payload", async () => {
    const { db, app } = await seededWorld();
    const env = makeEnv(db);
    const ok = await postForm(SETTINGS, "mallory", env, { op: "save-sandbox-image", sandbox_image_id: "omp" });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Saved the omp runtime harness");
    expect(db.raw.query("SELECT sandbox_image_id FROM review_bots WHERE id = ?").get(app.id)).toEqual({
      sandbox_image_id: "omp",
    });
    const payload = await getJson(`/dashboard/default/api/apps/${APP_ID}/settings`, "mallory", env);
    const body = (await payload.json()) as {
      app: { sandbox_image_id: string };
      sandbox_images?: Array<{ id: string; enabled: boolean }>;
    };
    expect(body.app.sandbox_image_id).toBe("omp");
    expect(body.sandbox_images).toEqual([{ id: "omp", enabled: true }]);
    expect(JSON.stringify(body)).not.toContain("models.yml");
  });

  test("unknown or disabled id → 400, nothing stored", async () => {
    const { db, app } = await seededWorld();
    const env = makeEnv(db);
    for (const imageId of ["no-such-image", "", "ark"]) {
      const res = await postForm(SETTINGS, "mallory", env, { op: "save-sandbox-image", sandbox_image_id: imageId });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Unknown or disabled runtime harness");
    }
    expect(db.raw.query("SELECT sandbox_image_id FROM review_bots WHERE id = ?").get(app.id)).toEqual({
      sandbox_image_id: "omp",
    });
  });

  test("non-creator member → 403 (creator-or-admin gate), nothing stored", async () => {
    const { db, app } = await seededWorld();
    const res = await postForm(SETTINGS, "hubot", makeEnv(db), {
      op: "save-sandbox-image",
      sandbox_image_id: "omp",
    });
    expect(res.status).toBe(403);
    expect(db.raw.query("SELECT sandbox_image_id FROM review_bots WHERE id = ?").get(app.id)).toEqual({
      sandbox_image_id: "omp",
    });
  });
});

describe("POST /dashboard/apps/:appId/settings — pinned add-key / add-custom-provider verify", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  test("add-key 401 from the provider → 400, zero rows stored", async () => {
    const { db } = await seededWorld();
    fetchSpy = mockStatus(401, { error: { message: "nope" } });
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("rejected by the provider");
    expect(body).not.toContain(PLAIN_KEY);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get() as { n: number }).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_models").get() as { n: number }).toEqual({ n: 0 });
  });

  test("add-key success still stores via saveVerifiedKey", async () => {
    const { db, app } = await seededWorld();
    fetchSpy = mockModelsOk(["claude-sonnet-4-6"]);
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Stored the anthropic key");
    expect(body).not.toContain(PLAIN_KEY);
    const store = createAppConfigStore(db, TEST_KEY);
    const keys = await store.listProviderKeys(app.id);
    expect(keys).toEqual([expect.objectContaining({ provider: "anthropic", last4: PLAIN_KEY.slice(-4) })]);
    const cached = await store.getVerifiedModels(app.id);
    expect(cached).toEqual([
      expect.objectContaining({ provider: "anthropic", models: expect.arrayContaining(["claude-sonnet-4-6"]) }),
    ]);
  });

  test("add-key unsupported built-in → 400 unsupported_provider, zero rows stored", async () => {
    const { db } = await seededWorld();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called for unsupported providers");
    }) as unknown as typeof fetch);
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-key",
      provider: "azure-openai",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "unsupported_provider",
      message: "This provider can't be verified here — manage the key in the provider console. Nothing was stored.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get() as { n: number }).toEqual({ n: 0 });
  });

  test("add-custom-provider 401 from the provider → 400, zero rows stored", async () => {
    const { db } = await seededWorld();
    fetchSpy = mockStatus(401, { error: { message: "nope" } });
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-custom-provider",
      provider_id: "my-custom",
      base_url: "https://example.com/v1",
      api: "openai-completions",
      model_ids: "local-7b",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("rejected by the provider");
    expect(body).not.toContain(PLAIN_KEY);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });
});

function rawRun(
  db: ReturnType<typeof createMigratedTestD1>,
  sql: string,
  ...params: (string | number | null)[]
): void {
  db.raw.prepare(sql).run(...params);
}

describe("Server-side eligibility precheck (fail-closed)", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  test("verify: non-omp selected image → 400 unsupported_provider, probe never called, nothing stored", async () => {
    const { db, app } = await seededWorld();
    rawRun(db, "UPDATE review_bots SET sandbox_image_id = 'legacy-runtime' WHERE id = ?", app.id);
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called for an ineligible App");
    }) as unknown as typeof fetch);
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: PLAIN_KEY });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "unsupported_provider",
      key: "settings.error.providerUnavailableOnHarness",
      message:
        "anthropic is not available under this App's selected runtime harness (legacy-runtime) — nothing was stored.",
      params: { provider: "anthropic", image: "legacy-runtime" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get() as { n: number }).toEqual({ n: 0 });
  });

  test("verify: omp selected image → precheck passes, existing verify-first flow stores the key", async () => {
    const { db, app } = await seededWorld();
    rawRun(db, "UPDATE review_bots SET sandbox_image_id = 'omp' WHERE id = ?", app.id);
    fetchSpy = mockModelsOk(["claude-sonnet-4-6"]);
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: PLAIN_KEY });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; provider: string };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe("anthropic");
    const store = createAppConfigStore(db, TEST_KEY);
    expect(await store.listProviderKeys(app.id)).toEqual([
      expect.objectContaining({ provider: "anthropic", last4: PLAIN_KEY.slice(-4) }),
    ]);
  });

  test("add-key: non-omp selected image → 400 plain text naming provider + image, nothing stored", async () => {
    const { db, app } = await seededWorld();
    rawRun(db, "UPDATE review_bots SET sandbox_image_id = 'legacy-runtime' WHERE id = ?", app.id);
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called for an ineligible App");
    }) as unknown as typeof fetch);
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("anthropic");
    expect(body).toContain("legacy-runtime");
    expect(body).toContain("nothing was stored");
    expect(body).not.toContain(PLAIN_KEY);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get() as { n: number }).toEqual({ n: 0 });
  });

  test("add-key: omp selected image → precheck passes, existing flow stores the key", async () => {
    const { db, app } = await seededWorld();
    rawRun(db, "UPDATE review_bots SET sandbox_image_id = 'omp' WHERE id = ?", app.id);
    fetchSpy = mockModelsOk(["claude-sonnet-4-6"]);
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Stored the anthropic key");
    const store = createAppConfigStore(db, TEST_KEY);
    expect(await store.listProviderKeys(app.id)).toEqual([
      expect.objectContaining({ provider: "anthropic", last4: PLAIN_KEY.slice(-4) }),
    ]);
  });
});

describe("POST /dashboard/apps/:appId/settings — add-template-provider materialization (spec §5)", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  const ACCOUNT_ID = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

  test("workers-ai template materializes into a custom provider with the account-id-substituted base URL", async () => {
    const { db, app } = await seededWorld();
    fetchSpy = mockStatus(200, { data: [] });
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "workers-ai",
      account_id: ACCOUNT_ID,
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Cloudflare Workers AI");
    expect(body).not.toContain(PLAIN_KEY);
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/models`,
      expect.objectContaining({ method: "GET" }),
    );
    const store = createAppConfigStore(db, TEST_KEY);
    const declared = await store.listCustomProviders(app.id);
    expect(declared).toHaveLength(1);
    expect(declared[0]!.provider_id).toBe("workers-ai");
    expect(declared[0]!.base_url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`);
    expect(declared[0]!.api).toBe("openai-completions");
    expect(declared[0]!.model_ids).toContain("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(declared[0]!.model_ids.length).toBeGreaterThan(0);
  });

  test("401 from the provider → 400, zero rows stored, key never echoed", async () => {
    const { db } = await seededWorld();
    fetchSpy = mockStatus(401, { error: { message: "nope" } });
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "workers-ai",
      account_id: ACCOUNT_ID,
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("rejected by the provider");
    expect(body).not.toContain(PLAIN_KEY);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });

  test("malformed account id → 400 before any network call, zero rows stored", async () => {
    const { db } = await seededWorld();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called for a malformed account id");
    }) as unknown as typeof fetch);
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "workers-ai",
      account_id: "not-a-32-hex-account-id",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("32 hex characters");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });

  test("unknown template id → 400, zero rows stored", async () => {
    const { db } = await seededWorld();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called for an unknown template");
    }) as unknown as typeof fetch);
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "no-such-template",
      account_id: ACCOUNT_ID,
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unknown provider template");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });

  test("non-creator member → 403 (creator-or-admin gate, spec §2)", async () => {
    const { db } = await seededWorld();
    fetchSpy = mockStatus(200, { data: [] });
    const res = await postForm(SETTINGS, "hubot", makeEnv(db), {
      op: "add-template-provider",
      template_id: "workers-ai",
      account_id: ACCOUNT_ID,
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(403);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });


  test("a no-placeholder breadth template materializes WITHOUT an account id (catalog base URL prefill)", async () => {
    const { db, app } = await seededWorld();
    fetchSpy = mockStatus(200, { data: [] });
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "subconscious",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Subconscious");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.subconscious.dev/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
    const store = createAppConfigStore(db, TEST_KEY);
    const declared = await store.listCustomProviders(app.id);
    expect(declared).toHaveLength(1);
    expect(declared[0]!.provider_id).toBe("subconscious");
    expect(declared[0]!.base_url).toBe("https://api.subconscious.dev/v1");
    expect(declared[0]!.api).toBe("openai-completions");
    expect(declared[0]!.model_ids).toEqual(
      [...PROVIDER_CATALOG["subconscious"]!.models].slice(0, MAX_CUSTOM_PROVIDER_MODEL_IDS),
    );
  });

  test("a base_url form override replaces the catalog prefill and materializes through the same validators", async () => {
    const { db, app } = await seededWorld();
    fetchSpy = mockStatus(200, { data: [] });
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "subconscious",
      base_url: "https://gateway.example.com/v1",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://gateway.example.com/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
    const store = createAppConfigStore(db, TEST_KEY);
    const declared = await store.listCustomProviders(app.id);
    expect(declared).toHaveLength(1);
    expect(declared[0]!.base_url).toBe("https://gateway.example.com/v1");
    expect(declared[0]!.api).toBe("openai-completions");
  });

  test("a non-https base_url override → 400 before any network call, zero rows stored", async () => {
    const { db } = await seededWorld();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called for an invalid base URL");
    }) as unknown as typeof fetch);
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "subconscious",
      base_url: "http://insecure.example.com/v1",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not a valid https URL");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });

  test("a template with a null catalog base URL and no override → 400 incomplete, zero rows stored", async () => {
    const { db } = await seededWorld();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called for an incomplete template");
    }) as unknown as typeof fetch);
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "watsonx",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("incomplete");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });

  const mergedTemplate = (() => {
    for (const [id, entry] of Object.entries(PROVIDER_CATALOG)) {
      if (entry.tier !== "template" || entry.protocols === undefined || entry.protocols.length < 2) continue;
      const secondary = entry.protocols
        .slice(1)
        .find((option) => option.baseUrl !== null && !option.baseUrl.includes("{") && option.models.length > 0);
      if (secondary === undefined) continue;
      return { id, entry, secondary };
    }
    return null;
  })();

  test.skipIf(mergedTemplate === null)("a chosen protocol materializes ITS endpoint and ITS vocabulary", async () => {
    if (mergedTemplate === null) return;
    const { db, app } = await seededWorld();
    fetchSpy = mockStatus(200, { data: [] });
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: mergedTemplate.id,
      api: mergedTemplate.secondary.api,
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(200);
    const declared = await createAppConfigStore(db, TEST_KEY).listCustomProviders(app.id);
    expect(declared).toHaveLength(1);
    expect(declared[0]!.provider_id).toBe(mergedTemplate.id);
    expect(declared[0]!.api).toBe(mergedTemplate.secondary.api as typeof declared[number]["api"]);
    expect(mergedTemplate.secondary.baseUrl).toBe(declared[0]!.base_url);
    expect(declared[0]!.model_ids).toEqual(
      [...mergedTemplate.secondary.models].slice(0, MAX_CUSTOM_PROVIDER_MODEL_IDS),
    );
  });

  test.skipIf(mergedTemplate === null)("an absent protocol keeps the row's default protocol", async () => {
    if (mergedTemplate === null) return;
    const { db, app } = await seededWorld();
    fetchSpy = mockStatus(200, { data: [] });
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: mergedTemplate.id,
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(200);
    const declared = await createAppConfigStore(db, TEST_KEY).listCustomProviders(app.id);
    expect(declared[0]!.api).toBe(mergedTemplate.entry.api as typeof declared[number]["api"]);
    expect(mergedTemplate.entry.baseUrl).toBe(declared[0]!.base_url);
    expect(declared[0]!.model_ids).toEqual([...mergedTemplate.entry.models].slice(0, MAX_CUSTOM_PROVIDER_MODEL_IDS));
  });

  test("a protocol the row does not ship → the unsupported-api 400, zero rows stored", async () => {
    const { db } = await seededWorld();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called for an unsupported protocol");
    }) as unknown as typeof fetch);
    const single = Object.entries(PROVIDER_CATALOG).find(
      ([, entry]) => entry.tier === "template" && entry.protocols === undefined && entry.api !== null,
    )!;
    const foreign = [...CUSTOM_PROVIDER_API_IDS].find((id) => id !== single[1].api)!;
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: single[0],
      api: foreign,
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ key: "settings.error.templateApiUnsupported" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });

  test("an {account_id}-templated override demands the account id (conditional demand follows the effective base URL)", async () => {
    const { db } = await seededWorld();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called without an account id");
    }) as unknown as typeof fetch);
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "subconscious",
      base_url: "https://api.example.com/accounts/{account_id}/v1",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("account id");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });
});

describe("GET settings includes delivery_summary for the sidebar", () => {
  test("delivery_summary is present and never includes encrypted columns", async () => {
    const { db } = await seededWorld();
    const res = await getJson(`/dashboard/default/api/apps/${APP_ID}/settings`, "mallory", makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await readSettingsWithCatalog(res, makeEnv(db))) as {
      delivery_summary: { latest: null; rejected24h: number };
      configured_providers?: Array<{ kind: string }>;
      provider_catalog?: Array<{ id: string; label: string; tier: string; verifiable: boolean; eligibility: string }>;
      app: { sandbox_image_id: string };
      sandbox_images?: Array<{ id: string; enabled: boolean }>;
    };
    expect(body.delivery_summary).toEqual({ latest: null, rejected24h: 0 });
    expect(body.app.sandbox_image_id).toBe("omp");
    expect(body.sandbox_images).toEqual([{ id: "omp", enabled: true }]);
    expect(JSON.stringify(body)).not.toContain("key_enc");
    expect(JSON.stringify(body)).not.toContain("private_key");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(body.configured_providers).toEqual([]);
    const byId = (id: string) => body.provider_catalog!.find((p) => p.id === id);
    expect(body.provider_catalog!.filter((p) => p.tier === "builtin").map((p) => p.id)).toEqual([...PROVIDER_IDS]);
    expect(byId("azure-openai")?.verifiable).toBe(false);
    expect(byId("ai-gateway")?.verifiable).toBe(false);
    expect(byId("anthropic")?.verifiable).toBe(true);
    expect(byId("anthropic")?.eligibility).toBe("builtin");
    expect(byId("workers-ai")).toMatchObject({
      tier: "template",
      label: "Cloudflare Workers AI",
      verifiable: true,
      eligibility: "template",
    });
    expect(body.provider_catalog!.some((p) => p.eligibility === "unavailable")).toBe(false);
  });

  test("other member GET is 200 with can_manage false and base+health only", async () => {
    const { db } = await seededWorld();
    const res = await getJson(`/dashboard/default/api/apps/${APP_ID}/settings`, "hubot", makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      can_manage: boolean;
      app: { github_app_id: number; github_slug: string | null };
      keys?: unknown;
      configured_providers?: unknown;
      provider_catalog?: unknown;
      model_chains?: unknown;
      model_roles?: unknown;
      custom_providers?: unknown;
    };
    expect(body.can_manage).toBe(false);
    expect(body.app.github_app_id).toBe(APP_ID);
    expect(body.app.github_slug).toBe("mallorys-app");
    expect(body.keys).toBeUndefined();
    expect(body.configured_providers).toBeUndefined();
    expect(body.provider_catalog).toBeUndefined();
    expect(body.model_chains).toBeUndefined();
    expect(body.model_roles).toBeUndefined();
    expect(body.custom_providers).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("key_enc");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("GET settings configured_providers vs provider_catalog", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  const ACCOUNT_ID = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

  async function getConfigured(env: Env): Promise<{
    configured_providers: ConfiguredRow[];
    provider_catalog: Array<{ id: string; tier: string; eligibility: string }>;
  }> {
    const res = await getJson(`/dashboard/default/api/apps/${APP_ID}/settings`, "mallory", env);
    expect(res.status).toBe(200);
    return (await readSettingsWithCatalog(res, env)) as {
      configured_providers: ConfiguredRow[];
      provider_catalog: Array<{ id: string; tier: string; eligibility: string }>;
    };
  }

  test("a stored builtin key is configured state; catalog rows never are", async () => {
    const { db } = await seededWorld();
    fetchSpy = mockModelsOk(["claude-sonnet-4-6"]);
    const stored = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: PLAIN_KEY,
    });
    expect(stored.status).toBe(200);
    const body = await getConfigured(makeEnv(db));
    expect(body.configured_providers).toEqual([
      {
        kind: "key",
        provider: "anthropic",
        key_id: expect.any(String),
        last4: PLAIN_KEY.slice(-4),
        updated_at: expect.any(String),
        verified_at: expect.any(String),
        verified_status: "ok",
      },
    ]);
    expect(body.provider_catalog.some((p) => p.id === "anthropic" && p.eligibility === "builtin")).toBe(true);
    expect(body.configured_providers.every((row) => row.kind === "key" || row.kind === "custom")).toBe(true);
    expect(JSON.stringify(body)).not.toContain(PLAIN_KEY);
    expect(JSON.stringify(body)).not.toContain("key_enc");
  });

  test("a materialized template (workers-ai) is a custom configured declaration", async () => {
    const { db } = await seededWorld();
    fetchSpy = mockStatus(200, { data: [] });
    const stored = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "workers-ai",
      account_id: ACCOUNT_ID,
      key: PLAIN_KEY,
    });
    expect(stored.status).toBe(200);
    const body = await getConfigured(makeEnv(db));
    expect(body.configured_providers).toEqual([
      {
        kind: "key",
        provider: "workers-ai",
        key_id: expect.any(String),
        last4: PLAIN_KEY.slice(-4),
        updated_at: expect.any(String),
        verified_at: expect.any(String),
        verified_status: "reachable",
      },
      {
        kind: "custom",
        provider_id: "workers-ai",
        base_url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`,
        api: "openai-completions",
        model_ids: expect.any(Array),
      },
    ]);
    expect(body.provider_catalog.find((p) => p.id === "workers-ai")).toMatchObject({
      tier: "template",
      eligibility: "template",
    });
    expect(JSON.stringify(body)).not.toContain(PLAIN_KEY);
  });

  test("a template on an unproven host lands a 'reachable' row, never 'ok'", async () => {
    const { db } = await seededWorld();
    fetchSpy = mockStatus(200, { data: [] });
    const stored = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "commandcode",
      key: PLAIN_KEY,
    });
    expect(stored.status).toBe(200);
    const body = await getConfigured(makeEnv(db));
    expect(body.configured_providers.find((row) => row.kind === "key")).toMatchObject({
      kind: "key",
      provider: "commandcode",
      verified_status: "reachable",
    });
    const keyRow = db.raw
      .query("SELECT verified_status FROM bot_custom_provider_keys WHERE provider = 'commandcode'")
      .get() as { verified_status: string | null };
    expect(keyRow.verified_status).toBe("reachable");
  });

  test("a template on the allow-listed TypeSafe host lands 'ok' — its models endpoint rejects a bogus key", async () => {
    const { db } = await seededWorld();
    fetchSpy = mockStatus(200, { data: [] });
    const stored = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "typesafe",
      key: PLAIN_KEY,
    });
    expect(stored.status).toBe(200);
    const body = await getConfigured(makeEnv(db));
    expect(body.configured_providers.find((row) => row.kind === "key")).toMatchObject({
      kind: "key",
      provider: "typesafe",
      verified_status: "ok",
    });
  });

  test("a template override on the SAME allow-listed host but an off-path base URL lands 'reachable'", async () => {
    const { db } = await seededWorld();
    fetchSpy = mockStatus(200, { data: [] });
    const stored = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "typesafe",
      base_url: "https://api.typesafe.ai/console",
      key: PLAIN_KEY,
    });
    expect(stored.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.typesafe.ai/console/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
    const body = await getConfigured(makeEnv(db));
    expect(body.configured_providers.find((row) => row.kind === "key")).toMatchObject({
      kind: "key",
      provider: "typesafe",
      verified_status: "reachable",
    });
  });

  test("a non-catalog custom declaration is configured state", async () => {
    const { db } = await seededWorld();
    fetchSpy = mockStatus(200, { data: [] });
    const stored = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-custom-provider",
      provider_id: "my-custom",
      base_url: "https://example.com/v1",
      api: "openai-completions",
      model_ids: "local-7b",
      key: PLAIN_KEY,
    });
    expect(stored.status).toBe(200);
    const body = await getConfigured(makeEnv(db));
    expect(body.configured_providers).toEqual([
      {
        kind: "key",
        provider: "my-custom",
        key_id: expect.any(String),
        last4: PLAIN_KEY.slice(-4),
        updated_at: expect.any(String),
        verified_at: expect.any(String),
        verified_status: "reachable",
      },
      {
        kind: "custom",
        provider_id: "my-custom",
        base_url: "https://example.com/v1",
        api: "openai-completions",
        model_ids: ["local-7b"],
      },
    ]);
    expect(body.provider_catalog.some((p) => p.id === "my-custom")).toBe(false);
    expect(JSON.stringify(body)).not.toContain(PLAIN_KEY);
  });
});

describe("multi-key provider pools (routes)", () => {
  afterEach(() => {
    mock.restore();
  });

  const SECOND_KEY = sk("ant-mallory-second-7766");
  const ACCOUNT_ID = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

  type KeyRow = {
    provider: string;
    keyId: string;
    last4: string;
    updatedAt: string | null;
    verifiedAt: string | null;
    verifiedStatus: string | null;
  };

  async function getSettings(
    env: Env,
  ): Promise<{ keys: KeyRow[]; configured_providers: ConfiguredRow[] }> {
    const res = await getJson(SETTINGS_JSON, "mallory", env);
    expect(res.status).toBe(200);
    return (await res.json()) as { keys: KeyRow[]; configured_providers: ConfiguredRow[] };
  }

  test("a second key for one provider is a new row — both add paths append, a re-submitted key stays one row", async () => {
    const { db, app } = await seededWorld();
    mockModelsOk(["claude-sonnet-4-6"]);
    const env = makeEnv(db);
    const first = await postForm(VERIFY, "mallory", env, { provider: "anthropic", key: PLAIN_KEY });
    expect(first.status).toBe(200);
    const second = await postForm(SETTINGS, "mallory", env, {
      op: "add-key",
      provider: "anthropic",
      key: SECOND_KEY,
    });
    expect(second.status).toBe(200);
    const resubmit = await postForm(VERIFY, "mallory", env, { provider: "anthropic", key: PLAIN_KEY });
    expect(resubmit.status).toBe(200);
    const store = createAppConfigStore(db, TEST_KEY);
    expect((await store.listProviderKeys(app.id, "anthropic")).length).toBe(2);
  });

  test("the settings payload carries every row of the provider with its key identity", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.addProviderKey(app.id, "anthropic", PLAIN_KEY);
    await store.addProviderKey(app.id, "anthropic", SECOND_KEY);
    mockModelsOk(["claude-sonnet-4-6"]);
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: PLAIN_KEY });
    expect(res.status).toBe(200);

    const body = await getSettings(makeEnv(db));
    const firstId = await keyIdOf(PLAIN_KEY);
    const secondId = await keyIdOf(SECOND_KEY);
    expect(body.keys).toHaveLength(2);
    expect(body.keys.every((row) => row.provider === "anthropic")).toBe(true);
    expect(body.keys.map((row) => row.keyId).sort()).toEqual([firstId, secondId].sort());
    expect(body.keys.map((row) => row.last4).sort()).toEqual([PLAIN_KEY.slice(-4), SECOND_KEY.slice(-4)].sort());
    const verifiedOnce = body.keys.find((row) => row.keyId === firstId)!;
    const neverVerified = body.keys.find((row) => row.keyId === secondId)!;
    expect(verifiedOnce.verifiedStatus).toBe("ok");
    expect(verifiedOnce.verifiedAt).toEqual(expect.any(String));
    expect(neverVerified).toMatchObject({ verifiedAt: null, verifiedStatus: null });
    const keyRows = body.configured_providers.filter((row) => row.kind === "key");
    expect(keyRows).toHaveLength(2);
    expect(keyRows.map((row) => row.key_id).sort()).toEqual([firstId, secondId].sort());
    expect(keyRows.every((row) => row.provider === "anthropic")).toBe(true);
    expect(JSON.stringify(body)).not.toContain(PLAIN_KEY);
    expect(JSON.stringify(body)).not.toContain(SECOND_KEY);
    expect(JSON.stringify(body)).not.toContain("key_enc");
  });

  test("verification is per key: verifying one row leaves its sibling untouched", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.addProviderKey(app.id, "anthropic", PLAIN_KEY);
    await store.addProviderKey(app.id, "anthropic", SECOND_KEY);
    mockModelsOk(["claude-sonnet-4-6"]);
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: PLAIN_KEY });
    expect(res.status).toBe(200);
    const rows = await store.listProviderKeys(app.id, "anthropic");
    expect(rows).toHaveLength(2);
    const firstId = await keyIdOf(PLAIN_KEY);
    const secondId = await keyIdOf(SECOND_KEY);
    const verifiedRow = rows.find((row) => row.keyId === firstId)!;
    const sibling = rows.find((row) => row.keyId === secondId)!;
    expect(verifiedRow.verifiedStatus).toBe("ok");
    expect(verifiedRow.verifiedAt).toEqual(expect.any(String));
    expect(sibling).toMatchObject({ verifiedAt: null, verifiedStatus: null });
  });

  test("delete takes the key identity: exactly one row goes and the sibling stays", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.addProviderKey(app.id, "anthropic", PLAIN_KEY);
    await store.addProviderKey(app.id, "anthropic", SECOND_KEY);
    const res = await postForm(SETTINGS + "/key/delete", "mallory", makeEnv(db), {
      provider: "anthropic",
      key_id: await keyIdOf(PLAIN_KEY),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Removed the stored anthropic key for mallorys-app");
    const remaining = await store.listProviderKeys(app.id, "anthropic");
    expect(remaining.map((row) => row.keyId)).toEqual([await keyIdOf(SECOND_KEY)]);
  });

  test("a delete without a key identity is a zero-write no-op — never a pool wipe", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.addProviderKey(app.id, "anthropic", PLAIN_KEY);
    await store.addProviderKey(app.id, "anthropic", SECOND_KEY);
    const res = await postForm(SETTINGS + "/key/delete", "mallory", makeEnv(db), { provider: "anthropic" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("nothing changed");
    expect((await store.listProviderKeys(app.id, "anthropic")).length).toBe(2);
  });

  test("an unknown key identity is a tolerant no-op", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.addProviderKey(app.id, "anthropic", PLAIN_KEY);
    const res = await postForm(SETTINGS + "/key/delete", "mallory", makeEnv(db), {
      provider: "anthropic",
      key_id: "0".repeat(16),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("nothing changed");
    expect((await store.listProviderKeys(app.id, "anthropic")).length).toBe(1);
  });

  test("a custom provider's pool is configured state: one row per key beside its declaration", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    const env = makeEnv(db);
    mockStatus(200, { data: [] });
    for (const key of [PLAIN_KEY, SECOND_KEY]) {
      const stored = await postForm(SETTINGS, "mallory", env, {
        op: "add-custom-provider",
        provider_id: "my-custom",
        base_url: "https://example.com/v1",
        api: "openai-completions",
        model_ids: "local-7b",
        key,
      });
      expect(stored.status).toBe(200);
    }
    expect((await store.listCustomProviderKeys(app.id, "my-custom")).length).toBe(2);

    const body = await getSettings(env);
    const firstId = await keyIdOf(PLAIN_KEY);
    const secondId = await keyIdOf(SECOND_KEY);
    const keyRows = body.configured_providers.filter((row) => row.kind === "key");
    expect(keyRows.map((row) => row.key_id).sort()).toEqual([firstId, secondId].sort());
    expect(keyRows.map((row) => row.last4).sort()).toEqual(
      [PLAIN_KEY.slice(-4), SECOND_KEY.slice(-4)].sort(),
    );
    expect(keyRows.every((row) => row.provider === "my-custom")).toBe(true);
    expect(keyRows.every((row) => row.verified_status === "reachable")).toBe(true);
    expect(
      body.keys.filter((row) => row.provider === "my-custom").map((row) => row.keyId).sort(),
    ).toEqual([firstId, secondId].sort());
    expect(body.configured_providers.filter((row) => row.kind === "custom")).toEqual([
      {
        kind: "custom",
        provider_id: "my-custom",
        base_url: "https://example.com/v1",
        api: "openai-completions",
        model_ids: ["local-7b"],
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(PLAIN_KEY);
    expect(JSON.stringify(body)).not.toContain(SECOND_KEY);
  });

  test("a custom per-key delete takes exactly that row: its sibling and the declaration stay", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    const env = makeEnv(db);
    mockStatus(200, { data: [] });
    const declared = await postForm(SETTINGS, "mallory", env, {
      op: "add-custom-provider",
      provider_id: "my-custom",
      base_url: "https://example.com/v1",
      api: "openai-completions",
      model_ids: "local-7b",
      key: PLAIN_KEY,
    });
    expect(declared.status).toBe(200);
    await store.addCustomProviderKey(app.id, "my-custom", SECOND_KEY, {
      base_url: "https://example.com/v1",
      api: "openai-completions",
    });

    const removed = await postForm(SETTINGS + "/key/delete", "mallory", env, {
      provider: "my-custom",
      key_id: await keyIdOf(PLAIN_KEY),
    });
    expect(removed.status).toBe(200);
    expect(await removed.text()).toContain("Removed the stored my-custom key for mallorys-app");
    expect(await store.listCustomProviderKeys(app.id, "my-custom")).toMatchObject([
      { keyId: await keyIdOf(SECOND_KEY) },
    ]);
    expect((await store.listCustomProviders(app.id)).map((row) => row.provider_id)).toEqual(["my-custom"]);
    expect(await store.listProviderKeys(app.id)).toEqual([]);

    const drained = await postForm(SETTINGS + "/key/delete", "mallory", env, {
      provider: "my-custom",
      key_id: await keyIdOf(SECOND_KEY),
    });
    expect(drained.status).toBe(200);
    expect(await store.listCustomProviderKeys(app.id, "my-custom")).toEqual([]);
    expect((await store.listCustomProviders(app.id)).map((row) => row.provider_id)).toEqual(["my-custom"]);
  });

  test("the delete route answers a machine-readable outcome: a removal vs the tolerant no-op", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.saveVerifiedKey(app.id, "anthropic", PLAIN_KEY, ["claude-sonnet-4-6"]);
    const cacheRows = () =>
      (db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_models WHERE bot_id = ?").get(app.id) as { n: number }).n;
    expect(cacheRows()).toBe(1);
    const env = makeEnv(db);
    const unmatched = await postForm(SETTINGS + "/key/delete", "mallory", env, {
      provider: "anthropic",
      key_id: "0".repeat(16),
    });
    expect(unmatched.status).toBe(200);
    const unmatchedBody = (await unmatched.json()) as { changed: boolean; message: string };
    expect(unmatchedBody.changed).toBe(false);
    expect(unmatchedBody.message).toContain("nothing changed");
    expect(cacheRows()).toBe(1);
    expect(await store.listProviderKeys(app.id, "anthropic")).toHaveLength(1);
    const matched = await postForm(SETTINGS + "/key/delete", "mallory", env, {
      provider: "anthropic",
      key_id: await keyIdOf(PLAIN_KEY),
    });
    expect(matched.status).toBe(200);
    const matchedBody = (await matched.json()) as { changed: boolean; message: string };
    expect(matchedBody.changed).toBe(true);
    expect(matchedBody.message).toContain("Removed the stored anthropic key for mallorys-app");
    expect(cacheRows()).toBe(0);
  });

  test("the ninth key is a clear 400 on the custom entry points — declaration and pool unchanged", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    const env = makeEnv(db);
    mockStatus(200, { data: [] });
    const seededCustom = await postForm(SETTINGS, "mallory", env, {
      op: "add-custom-provider",
      provider_id: "my-custom",
      base_url: "https://example.com/v1",
      api: "openai-completions",
      model_ids: "local-7b",
      key: PLAIN_KEY,
    });
    expect(seededCustom.status).toBe(200);
    const seededTemplate = await postForm(SETTINGS, "mallory", env, {
      op: "add-template-provider",
      template_id: "workers-ai",
      account_id: ACCOUNT_ID,
      key: PLAIN_KEY,
    });
    expect(seededTemplate.status).toBe(200);
    const declarations = await store.listCustomProviders(app.id);
    const endpointOf = (providerId: string) => {
      const decl = declarations.find((row) => row.provider_id === providerId)!;
      return { base_url: decl.base_url, api: decl.api };
    };
    for (let i = 1; i < MAX_KEYS_PER_PROVIDER; i++) {
      await store.addCustomProviderKey(app.id, "my-custom", sk(`custom-cap-${i}-${i}${i}${i}`), endpointOf("my-custom"));
      await store.addCustomProviderKey(app.id, "workers-ai", sk(`workers-cap-${i}-${i}${i}${i}`), endpointOf("workers-ai"));
    }
    const pools = await store.listCustomProviderKeys(app.id);
    expect(pools.filter((row) => row.provider === "my-custom")).toHaveLength(MAX_KEYS_PER_PROVIDER);
    expect(pools.filter((row) => row.provider === "workers-ai")).toHaveLength(MAX_KEYS_PER_PROVIDER);

    const custom = await postForm(SETTINGS, "mallory", env, {
      op: "add-custom-provider",
      provider_id: "my-custom",
      base_url: "https://example.com/v1",
      api: "openai-completions",
      model_ids: "local-7b",
      key: sk("custom-cap-over-9999"),
    });
    expect(custom.status).toBe(400);
    expect(await custom.json()).toMatchObject({
      key: "settings.error.providerKeyLimit",
      params: { provider: "my-custom", limit: MAX_KEYS_PER_PROVIDER },
    });
    const template = await postForm(SETTINGS, "mallory", env, {
      op: "add-template-provider",
      template_id: "workers-ai",
      account_id: ACCOUNT_ID,
      key: sk("workers-cap-over-9999"),
    });
    expect(template.status).toBe(400);
    expect(await template.json()).toMatchObject({
      key: "settings.error.providerKeyLimit",
      params: { provider: "workers-ai", limit: MAX_KEYS_PER_PROVIDER },
    });
    expect(await store.listCustomProviders(app.id)).toEqual(declarations);
    expect(await store.listCustomProviderKeys(app.id)).toEqual(pools);
  });

  test("the ninth key is a clear 400 on both add paths — the pool cap is never a silent no-op", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    for (let i = 0; i < MAX_KEYS_PER_PROVIDER; i++) {
      await store.addProviderKey(app.id, "anthropic", sk(`ant-pool-cap-${i}-${i}${i}${i}${i}`));
    }
    const before = (await store.listProviderKeys(app.id, "anthropic")).map((row) => row.keyId);
    mockModelsOk(["claude-sonnet-4-6"]);
    const ninth = sk("ant-pool-cap-over-9999");
    const verified = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: ninth });
    expect(verified.status).toBe(400);
    const verifiedBody = (await verified.json()) as {
      ok: boolean;
      reason: string;
      key: string;
      params: Record<string, string | number>;
    };
    expect(verifiedBody).toMatchObject({
      ok: false,
      key: "settings.error.providerKeyLimit",
      params: { provider: "anthropic", limit: MAX_KEYS_PER_PROVIDER },
    });
    const added = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: ninth,
    });
    expect(added.status).toBe(400);
    const addedBody = (await added.json()) as { key: string; params: Record<string, string | number> };
    expect(addedBody.key).toBe("settings.error.providerKeyLimit");
    expect(addedBody.params).toEqual({ provider: "anthropic", limit: MAX_KEYS_PER_PROVIDER });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get() as { n: number }).toEqual({
      n: MAX_KEYS_PER_PROVIDER,
    });
    expect((await store.listProviderKeys(app.id, "anthropic")).map((row) => row.keyId)).toEqual(before);
  });
});

describe("POST settings op=add-custom-provider-key (custom pool append)", () => {
  afterEach(() => {
    mock.restore();
  });

  const SECOND_KEY = sk("ant-mallory-custom-second-7788");
  const DECLARATION = {
    op: "add-custom-provider",
    provider_id: "my-custom",
    base_url: "https://example.com/v1",
    api: "openai-completions",
    model_ids: "local-7b",
    key: PLAIN_KEY,
  };

  async function declaredWorld() {
    const world = await seededWorld();
    mockStatus(200, { data: [] });
    const declared = await postForm(SETTINGS, "mallory", makeEnv(world.db), DECLARATION);
    expect(declared.status).toBe(200);
    return world;
  }

  test("appends a key to the EXISTING declaration: the stored endpoint is probed and nothing is rewritten", async () => {
    const { db, app } = await declaredWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    const before = await store.listCustomProviders(app.id);

    const spy = mockStatus(200, { data: [] });
    const added = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-custom-provider-key",
      provider_id: "my-custom",
      base_url: "https://evil.example.com/v1",
      api: "anthropic-messages",
      model_ids: "other-model",
      key: SECOND_KEY,
    });
    expect(added.status).toBe(200);
    expect(await added.text()).toContain("Added another my-custom key for mallorys-app");
    expect(spy).toHaveBeenCalledWith(
      "https://example.com/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
    expect(await store.listCustomProviders(app.id)).toEqual(before);
    expect((await store.listCustomProviderKeys(app.id, "my-custom")).map((row) => row.keyId).sort()).toEqual(
      [await keyIdOf(PLAIN_KEY), await keyIdOf(SECOND_KEY)].sort(),
    );
    const secondId = await keyIdOf(SECOND_KEY);
    const appended = (await store.listCustomProviderKeys(app.id, "my-custom")).find(
      (row) => row.keyId === secondId,
    )!;
    expect(appended.verifiedStatus).toBe("reachable");
    expect(appended.verifiedAt).toEqual(expect.any(String));
    const body = (await (await getJson(SETTINGS_JSON, "mallory", makeEnv(db))).json()) as {
      keys: Array<{ provider: string; last4: string }>;
    };
    expect(body.keys.filter((row) => row.provider === "my-custom").map((row) => row.last4).sort()).toEqual(
      [PLAIN_KEY.slice(-4), SECOND_KEY.slice(-4)].sort(),
    );
  });

  test("an appended key on an allow-listed endpoint records 'ok' — the declaration's own decision", async () => {
    const { db, app } = await seededWorld();
    mockStatus(200, { data: [] });
    const declared = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-custom-provider",
      provider_id: "typesafe-gate",
      base_url: "https://api.typesafe.ai",
      api: "typesafe",
      model_ids: "jev-latest",
      key: PLAIN_KEY,
    });
    expect(declared.status).toBe(200);
    mockStatus(200, { data: [] });
    const added = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-custom-provider-key",
      provider_id: "typesafe-gate",
      key: SECOND_KEY,
    });
    expect(added.status).toBe(200);
    const secondId = await keyIdOf(SECOND_KEY);
    const appended = (await createAppConfigStore(db, TEST_KEY).listCustomProviderKeys(app.id, "typesafe-gate")).find(
      (row) => row.keyId === secondId,
    )!;
    expect(appended.verifiedStatus).toBe("ok");
  });

  test("a declaration moved while the verify is in flight refuses the old-endpoint key", async () => {
    const { db, app } = await declaredWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    const replacement = sk("ant-mallory-custom-replaced-3344");
    const verifyStarted = Promise.withResolvers<void>();
    const verifyGate = Promise.withResolvers<void>();
    spyOn(globalThis, "fetch").mockImplementation(
      (async () => {
        verifyStarted.resolve();
        await verifyGate.promise;
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    );
    const pending = postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-custom-provider-key",
      provider_id: "my-custom",
      key: SECOND_KEY,
    });
    await verifyStarted.promise;
    await store.removeCustomProvider(app.id, "my-custom");
    await store.upsertCustomProvider(
      app.id,
      {
        provider_id: "my-custom",
        base_url: "https://replacement.example.com/v1",
        api: "openai-completions",
        model_ids: ["local-7b"],
      },
      replacement,
    );
    verifyGate.resolve();
    const refused = await pending;
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      key: "settings.error.providerEndpointLocked",
      params: { provider: "my-custom" },
    });
    expect((await store.listCustomProviderKeys(app.id, "my-custom")).map((row) => row.keyId)).toEqual([
      await keyIdOf(replacement),
    ]);
    expect((await store.listCustomProviders(app.id))[0]!.base_url).toBe("https://replacement.example.com/v1");
  });

  test("the ninth key is the keyed cap 400 — zero writes, pool byte-identical", async () => {
    const { db, app } = await declaredWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    const declared = (await store.listCustomProviders(app.id)).find((row) => row.provider_id === "my-custom")!;
    for (let i = 1; i < MAX_KEYS_PER_PROVIDER; i++) {
      await store.addCustomProviderKey(app.id, "my-custom", sk(`custom-append-${i}-${i}${i}${i}`), declared);
    }
    const before = await store.listCustomProviderKeys(app.id, "my-custom");
    expect(before).toHaveLength(MAX_KEYS_PER_PROVIDER);
    mockStatus(200, { data: [] });
    const ninth = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-custom-provider-key",
      provider_id: "my-custom",
      key: sk("custom-append-over-9999"),
    });
    expect(ninth.status).toBe(400);
    expect(await ninth.json()).toMatchObject({
      key: "settings.error.providerKeyLimit",
      params: { provider: "my-custom", limit: MAX_KEYS_PER_PROVIDER },
    });
    expect(await store.listCustomProviderKeys(app.id, "my-custom")).toEqual(before);
  });

  test("a rejected key keeps the existing structured reason and writes nothing", async () => {
    const { db, app } = await declaredWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    const before = await store.listCustomProviderKeys(app.id, "my-custom");
    mockStatus(401, {});
    const rejected = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-custom-provider-key",
      provider_id: "my-custom",
      key: SECOND_KEY,
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ ok: false, reason: "invalid_key" });
    expect(await store.listCustomProviderKeys(app.id, "my-custom")).toEqual(before);
  });

  test("an undeclared id — a built-in included — is refused and the built-in pool is never touched", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    const spy = mockStatus(200, { data: [] });
    for (const provider_id of ["my-custom", "anthropic"]) {
      const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
        op: "add-custom-provider-key",
        provider_id,
        key: PLAIN_KEY,
      });
      expect(res.status, provider_id).toBe(400);
      expect(await res.json()).toMatchObject({
        key: "settings.error.customProviderUndeclared",
        params: { provider: provider_id },
      });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(await store.listCustomProviderKeys(app.id)).toEqual([]);
    expect(await store.listProviderKeys(app.id)).toEqual([]);
  });
});

describe("GET settings provider_catalog display_group (AD-547)", () => {
  type CatalogRow = {
    id: string;
    tier: string;
    verifiable: boolean;
    eligibility: string;
    display_group: string;
  };

  async function getCatalog(env: Env): Promise<CatalogRow[]> {
    const res = await getJson(`/dashboard/default/api/apps/${APP_ID}/settings`, "mallory", env);
    expect(res.status).toBe(200);
    const body = (await readSettingsWithCatalog(res, env)) as { provider_catalog: CatalogRow[] };
    return body.provider_catalog;
  }

  test("every entry carries display_group; the common group is exactly the 5 frozen ids", async () => {
    const { db } = await seededWorld();
    const catalog = await getCatalog(makeEnv(db));
    expect(catalog.length).toBeGreaterThan(0);
    for (const row of catalog) {
      expect(row.display_group === "common" || row.display_group === "catalog").toBe(true);
    }
    expect(catalog.filter((p) => p.display_group === "common").map((p) => p.id)).toEqual([...PROVIDER_IDS_COMMON]);
  });

  test("builtin non-common entries are catalog-grouped while keeping tier and eligibility semantics", async () => {
    const { db } = await seededWorld();
    const catalog = await getCatalog(makeEnv(db));
    for (const id of ["azure-openai", "groq", "mistral", "ark"]) {
      expect(catalog.find((p) => p.id === id)).toMatchObject({
        tier: "builtin",
        eligibility: "builtin",
        display_group: "catalog",
      });
    }
    expect(catalog.find((p) => p.id === "azure-openai")?.verifiable).toBe(false);
    expect(catalog.find((p) => p.id === "groq")?.verifiable).toBe(true);
  });

  test("template entries are all catalog-grouped; the response array order is unchanged", async () => {
    const { db } = await seededWorld();
    const catalog = await getCatalog(makeEnv(db));
    expect(catalog.filter((p) => p.tier === "template").every((p) => p.display_group === "catalog")).toBe(true);
    const builtinCount = catalog.filter((p) => p.tier === "builtin").length;
    expect(catalog.slice(0, builtinCount).map((p) => p.id)).toEqual([...PROVIDER_IDS]);
    expect(catalog.slice(builtinCount).every((p) => p.tier === "template")).toBe(true);
  });
});

describe("GET settings provider_catalog usage_probe (per-key usage action)", () => {
  const MAPPED = [
    "commandcode",
    "opencode-go",
    "zai",
    "zai-coding-plan",
    "zhipuai",
    "zhipuai-coding-plan",
    "minimax-coding-plan",
    "minimax-cn-coding-plan",
    "cline-pass",
    "synthetic",
    "umans",
    "hyper",
    "cursor",
  ];

  type StampRow = { id: string; tier: string; usage_probe: boolean };

  async function getCatalogRows(env: Env): Promise<StampRow[]> {
    const res = await getJson(`/dashboard/default/api/apps/${APP_ID}/settings`, "mallory", env);
    expect(res.status).toBe(200);
    const body = (await readSettingsWithCatalog(res, env)) as { provider_catalog: StampRow[] };
    return body.provider_catalog;
  }

  test("both branches stamp usage_probe from the probe table — true exactly for the mapped ids", async () => {
    const { db } = await seededWorld();
    const rows = await getCatalogRows(makeEnv(db));

    for (const row of rows) expect(row.usage_probe, row.id).toBe(hasUsageProbe(row.id));
    for (const id of MAPPED) expect(Object.hasOwn(PROVIDER_CATALOG, id), id).toBe(true);
    expect(rows.filter((row) => row.usage_probe).map((row) => row.id).sort()).toEqual([...MAPPED].sort());

    expect(rows.filter((row) => row.tier === "builtin" && row.usage_probe).map((row) => row.id).sort()).toEqual(
      MAPPED.filter((id) => PROVIDER_CATALOG[id]?.tier === "builtin").sort(),
    );
    expect(rows.filter((row) => row.tier === "template" && row.usage_probe).map((row) => row.id).sort()).toEqual(
      MAPPED.filter((id) => PROVIDER_CATALOG[id]?.tier === "template").sort(),
    );
    expect(rows.find((row) => row.id === "anthropic")?.usage_probe).toBe(false);
  });
});

describe("GET settings provider_catalog — one row per provider, protocol as an option", () => {
  type CatalogRow = {
    id: string;
    api: string | null;
    base_url: string | null;
    models: string[];
    protocols?: Array<{ api: string; base_url: string | null; models: string[] }>;
  };

  async function catalogRows(env: Env): Promise<CatalogRow[]> {
    const res = await getJson(SETTINGS_JSON, "mallory", env);
    expect(res.status).toBe(200);
    const body = (await readSettingsWithCatalog(res, env)) as { provider_catalog: CatalogRow[] };
    return body.provider_catalog;
  }

  test("a mixed-protocol row carries its options (snake_case endpoints, default first); a single-protocol row carries none", async () => {
    const { db } = await seededWorld();
    const rows = await catalogRows(makeEnv(db));
    const merged = rows.filter((row) => row.protocols !== undefined);
    expect(merged.length).toBeGreaterThan(0);
    for (const row of merged) {
      const options = row.protocols!;
      expect(options.length, row.id).toBeGreaterThan(1);
      expect(row.api, row.id).toBe(options[0]!.api);
      expect(row.base_url, row.id).toBe(options[0]!.base_url);
      expect(options[0]!.models, row.id).toEqual(row.models);
      expect(new Set(options.map((option) => option.api)).size, row.id).toBe(options.length);
    }
    expect(rows.some((row) => row.protocols === undefined)).toBe(true);
    for (const row of rows) if (row.protocols === undefined) expect(row.protocols, row.id).toBeUndefined();
  });

  test("a declaration stored under a collapsed id carries legacy_of and resolves to the provider row", async () => {
    const { db, app } = await seededWorld();
    const mergedGroup = Object.entries(PROVIDER_CATALOG).find(([providerId, entry]) => {
      if (entry.protocols === undefined || entry.protocols.length < 2) return false;
      if (!Object.values(LEGACY_PROVIDER_IDS).includes(providerId)) return false;
      return entry.protocols.every((option) => option.baseUrl !== null && !option.baseUrl.includes("{"));
    });
    expect(mergedGroup).toBeDefined();
    const [providerId, entry] = mergedGroup!;
    const legacyId = Object.keys(LEGACY_PROVIDER_IDS).find((id) => LEGACY_PROVIDER_IDS[id] === providerId)!;
    const option = entry!.protocols![1]!;
    await createAppConfigStore(db, TEST_KEY).upsertCustomProvider(
      app.id,
      {
        provider_id: legacyId,
        base_url: option.baseUrl!,
        api: option.api as (typeof CUSTOM_PROVIDER_API_IDS)[number],
        model_ids: ["m1"],
      },
      PLAIN_KEY,
    );
    const res = await getJson(SETTINGS_JSON, "mallory", makeEnv(db));
    const body = (await readSettingsWithCatalog(res, makeEnv(db))) as {
      custom_providers: Array<{ provider_id: string; legacy_of?: string }>;
      provider_catalog: CatalogRow[];
    };
    const declaration = body.custom_providers.find((row) => row.provider_id === legacyId)!;
    expect(declaration).toBeDefined();
    expect(declaration.legacy_of).toBe(providerId);
    expect(body.provider_catalog.some((row) => row.id === legacyId)).toBe(false);
    expect(body.provider_catalog.some((row) => row.id === providerId)).toBe(true);
  });
});
