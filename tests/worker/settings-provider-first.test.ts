/**
 * Plan 31 Task 4: provider-first settings routes — JSON verify, models
 * dropdown source, and save-chain/save-roles membership (spec §6.3).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createMigratedTestD1 } from "../store/helpers";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import {
  createAppConfigStore,
  MODEL_ROLE_IDS,
} from "../../src/dashboard/app-config-store";
import { composeModelOptions, findFailingSelector, selectorBase } from "../../src/dashboard/model-membership";
import { addKeyProviderIds } from "../../src/dashboard/provider-verify";
import { PROVIDER_IDS } from "../../src/dashboard/app-config-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import worker from "../../src/worker/index";

const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const PLAIN_KEY = "sk-ant-mallory-verify-9988";
const SETTINGS = "/dashboard/apps/mallorys-app/settings";
const VERIFY = "/dashboard/api/apps/mallorys-app/keys/verify";
const MODELS = "/dashboard/api/apps/mallorys-app/models";

async function seededWorld() {
  const db = createMigratedTestD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  const app = await createAppsStore(db).createApp({
    id,
    slug: "mallorys-app",
    githubAppId: 1001,
    name: "mallorys-app",
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
  });
  return { db, app };
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

describe("selector membership helpers (plan 31 T4, spec §6.3)", () => {
  test("selectorBase strips a :variant suffix and requires a provider prefix", () => {
    expect(selectorBase("anthropic/claude-sonnet-4-6:thinking")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      base: "anthropic/claude-sonnet-4-6",
    });
    expect(selectorBase("bare-model")).toBeNull();
  });

  test("composeModelOptions groups verified cache then custom declarations; probe rows have no selectors", () => {
    const groups = composeModelOptions(
      [
        { provider: "anthropic", models: ["claude-sonnet-4-6", "claude-opus-4-7"], fetched_at: "now" },
        { provider: "copilot", models: [], fetched_at: "now" },
        { provider: "ark-plan", models: ["doubao-seed-2-1-pro"], fetched_at: "now" },
      ],
      [{ provider_id: "my-custom", model_ids: ["local-7b"] }],
    );
    expect(groups).toEqual([
      { provider: "anthropic", source: "verified", selectors: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-7"] },
      { provider: "copilot", source: "probe", selectors: [] },
      { provider: "ark-plan", source: "verified", selectors: ["ark-plan/doubao-seed-2-1-pro"] },
      { provider: "my-custom", source: "custom", selectors: ["my-custom/local-7b"] },
    ]);
  });

  test("findFailingSelector: (a) cache hit / miss / variant; (b) probe-only + no-row syntax; (c) custom declaration", () => {
    const verified = [
      { provider: "anthropic", models: ["claude-sonnet-4-6"], fetched_at: "now" },
      { provider: "copilot", models: [], fetched_at: "now" },
    ];
    const custom = [{ provider_id: "my-custom", model_ids: ["local-7b"] }];
    expect(findFailingSelector(["anthropic/claude-sonnet-4-6:thinking"], verified, custom)).toBeNull();
    expect(findFailingSelector(["anthropic/claude-opus-4-7"], verified, custom)).toBe("anthropic/claude-opus-4-7");
    expect(findFailingSelector(["copilot/anything"], verified, custom)).toBeNull();
    expect(findFailingSelector(["openai/gpt-5"], verified, custom)).toBeNull();
    expect(findFailingSelector(["my-custom/local-7b"], verified, custom)).toBeNull();
    expect(findFailingSelector(["my-custom/nope"], verified, custom)).toBe("my-custom/nope");
  });
});

describe("POST /dashboard/api/apps/:slug/keys/verify (plan 31 T4)", () => {
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_provider_keys").get() as { n: number }).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_provider_models").get() as { n: number }).toEqual({ n: 0 });
  });

  test("network reject → 400 unreachable, nothing stored", async () => {
    const { db } = await seededWorld();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: PLAIN_KEY });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, reason: "unreachable" });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_provider_keys").get() as { n: number }).toEqual({ n: 0 });
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_provider_keys").get() as { n: number }).toEqual({ n: 0 });
  });

  test("other member 403", async () => {
    const { db } = await seededWorld();
    const res = await postForm(VERIFY, "hubot", makeEnv(db), { provider: "anthropic", key: PLAIN_KEY });
    expect(res.status).toBe(403);
  });
});

describe("GET /dashboard/api/apps/:slug/models (plan 31 T4)", () => {
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
      "sk-custom-9988",
    );
    const res = await getJson(MODELS, "mallory", makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Array<{ provider: string; source: string; selectors: string[] }> };
    expect(body.groups).toEqual([
      { provider: "anthropic", source: "verified", selectors: ["anthropic/claude-sonnet-4-6"] },
      { provider: "ark-plan", source: "verified", selectors: ["ark-plan/doubao-seed-2-1-pro"] },
      { provider: "copilot", source: "probe", selectors: [] },
      { provider: "my-custom", source: "custom", selectors: ["my-custom/local-7b"] },
    ]);
    expect(JSON.stringify(body)).not.toContain(PLAIN_KEY);
    expect(JSON.stringify(body)).not.toContain("sk-custom");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("POST save-chain / save-roles membership (plan 31 T4)", () => {
  test("selector in the verified cache (with variant) saves; unknown cache member 400s and is not stored", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.saveVerifiedKey(app.id, "anthropic", PLAIN_KEY, ["claude-sonnet-4-6"]);
    const env = makeEnv(db);
    const ok = await postForm(SETTINGS, "mallory", env, {
      op: "save-chain",
      model_chain: "anthropic/claude-sonnet-4-6:thinking",
    });
    expect(ok.status).toBe(200);
    expect(await store.getModelChain(app.id)).toBe("anthropic/claude-sonnet-4-6:thinking");
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
    expect(await store.getModelChain(app.id)).toBe("anthropic/claude-sonnet-4-6:thinking");
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

  test("custom provider membership uses declared model_ids, not app_provider_models", async () => {
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
      "sk-custom-9988",
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

  test("save-roles applies the same membership; blank still clears", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    await store.saveVerifiedKey(app.id, "anthropic", PLAIN_KEY, ["claude-sonnet-4-6"]);
    const env = makeEnv(db);
    const roles = Object.fromEntries(MODEL_ROLE_IDS.map((role) => [`role_${role}`, ""]));
    const fail = await postForm(SETTINGS, "mallory", env, {
      op: "save-roles",
      ...roles,
      "role_mstar-review-seat": "anthropic/nope",
    });
    expect(fail.status).toBe(400);
    expect(await fail.json()).toEqual({
      code: "not_in_verified_models",
      message: "Selector anthropic/nope is not in this App's verified models.",
      selector: "anthropic/nope",
    });
    const ok = await postForm(SETTINGS, "mallory", env, {
      op: "save-roles",
      ...roles,
      "role_mstar-review-seat": "anthropic/claude-sonnet-4-6:thinking",
    });
    expect(ok.status).toBe(200);
    expect(await store.getAppModelRoles(app.id)).toEqual({
      "mstar-review-seat": "anthropic/claude-sonnet-4-6:thinking",
    });
    const clear = await postForm(SETTINGS, "mallory", env, { op: "save-roles", ...roles });
    expect(clear.status).toBe(200);
    expect(await store.getAppModelRoles(app.id)).toEqual({});
  });
});

describe("POST /dashboard/apps/:slug/settings — pinned add-key / add-custom-provider verify (plan 31 T4)", () => {
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_provider_keys").get() as { n: number }).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_provider_models").get() as { n: number }).toEqual({ n: 0 });
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_provider_keys").get() as { n: number }).toEqual({ n: 0 });
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });
});

describe("GET settings includes delivery_summary for the sidebar (plan 31 T6)", () => {
  test("delivery_summary is present and never includes encrypted columns", async () => {
    const { db } = await seededWorld();
    const res = await getJson("/dashboard/api/apps/mallorys-app/settings", "mallory", makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      delivery_summary: { latest: null; rejected24h: number };
      provider_ids: string[];
    };
    expect(body.delivery_summary).toEqual({ latest: null, rejected24h: 0 });
    expect(JSON.stringify(body)).not.toContain("key_enc");
    expect(JSON.stringify(body)).not.toContain("private_key");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(body.provider_ids).not.toContain("azure-openai");
    expect(body.provider_ids).not.toContain("ai-gateway");
    expect(body.provider_ids).toEqual(addKeyProviderIds(PROVIDER_IDS));
  });
});
