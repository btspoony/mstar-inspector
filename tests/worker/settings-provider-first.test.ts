/**
 * provider-first settings routes — JSON verify, models
 * dropdown source, and save-chain/save-roles membership (spec §6.3).
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMigratedTestD1 } from "../store/helpers";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import {
  MAX_KEYS_PER_PROVIDER,
  createAppConfigStore,
  MODEL_ROLE_IDS,
} from "../../src/dashboard/app-config-store";
import { composeModelOptions, findFailingSelector, selectorBase } from "../../src/dashboard/model-membership";
import { PROVIDER_IDS } from "../../src/dashboard/app-config-store";
import { PROVIDER_IDS_COMMON } from "../../src/contracts/provider-catalog.generated";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import worker from "../../src/worker/index";
import { sk, OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const PLAIN_KEY = sk("ant-mallory-verify-9988");
const SETTINGS = "/dashboard/apps/mallorys-app/settings";
const VERIFY = "/dashboard/api/apps/mallorys-app/keys/verify";
const MODELS = "/dashboard/api/apps/mallorys-app/models";
const SETTINGS_JSON = "/dashboard/api/apps/mallorys-app/settings";

/**
 * One `configured_providers` wire row: a stored key (provider + pool identity +
 * masked tail + per-key verification) or a custom-provider declaration.
 */
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
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
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

/** First 16 hex chars of SHA-256(plaintext) — the pool id the store derives. */
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
      [{ provider_id: "my-custom", model_ids: ["local-7b"], has_keys: true }],
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
    const custom = [{ provider_id: "my-custom", model_ids: ["local-7b"], has_keys: true }];
    expect(findFailingSelector(["anthropic/claude-sonnet-4-6:thinking"], verified, custom)).toBeNull();
    expect(findFailingSelector(["anthropic/claude-opus-4-7"], verified, custom)).toBe("anthropic/claude-opus-4-7");
    expect(findFailingSelector(["copilot/anything"], verified, custom)).toBeNull();
    expect(findFailingSelector(["openai/gpt-5"], verified, custom)).toBeNull();
    expect(findFailingSelector(["my-custom/local-7b"], verified, custom)).toBeNull();
    expect(findFailingSelector(["my-custom/nope"], verified, custom)).toBe("my-custom/nope");
  });

  test("a KEYLESS custom declaration is offered nothing and rejected everywhere — an unknown provider still stays syntax-only", () => {
    const drained = [{ provider_id: "my-custom", model_ids: ["local-7b"], has_keys: false }];
    // (a) nothing to offer: the group is absent, not an empty one.
    expect(composeModelOptions([], drained)).toEqual([]);
    // (b) its declared model ids are NOT usable — the pool has no credential.
    expect(findFailingSelector(["my-custom/local-7b"], [], drained)).toBe("my-custom/local-7b");
    // The contrast that keeps (b) from over-reaching: a provider the App never
    // declared has no cache row either, and stays syntax-only (unchanged).
    expect(findFailingSelector(["openai/gpt-5"], [], drained)).toBeNull();
  });
});

describe("POST /dashboard/api/apps/:slug/keys/verify", () => {
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

describe("GET /dashboard/api/apps/:slug/models", () => {
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
      { provider: "ark-plan", source: "verified", selectors: ["ark-plan/doubao-seed-2-1-pro"] },
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

    // The keyed state: both faces carry the declaration's models.
    type ModelsBody = { groups: Array<{ provider: string; selectors: string[] }> };
    const before = await getJson(MODELS, "mallory", env);
    const beforeBody = (await before.json()) as ModelsBody;
    expect(beforeBody.groups.map((group) => group.provider)).toContain("my-custom");
    const keyedChain = await postForm(SETTINGS, "mallory", env, { op: "save-chain", model_chain: "my-custom/local-7b" });
    expect(keyedChain.status).toBe(200);

    // Drain the pool: the declaration survives, the pool is empty.
    await store.deleteCustomProviderKey(app.id, "my-custom", await keyIdOf(PLAIN_KEY));
    expect(await store.listCustomProviderKeys(app.id, "my-custom")).toEqual([]);

    // (a) the model-options face no longer offers this provider's models.
    const after = await getJson(MODELS, "mallory", env);
    const afterBody = (await after.json()) as ModelsBody;
    expect(afterBody.groups.map((group) => group.provider)).not.toContain("my-custom");
    expect(afterBody.groups.flatMap((group) => group.selectors)).not.toContain("my-custom/local-7b");

    // (b) the membership face rejects a chain referencing it.
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
    // The earlier saved chain is untouched by the refused write.
    expect(await store.getModelChain(app.id)).toBe("my-custom/local-7b");

    // (c) the declaration itself is still listed — present and re-keyable.
    const settings = await getJson(SETTINGS_JSON, "mallory", env);
    const payload = (await settings.json()) as { configured_providers: ConfiguredRow[] };
    expect(payload.configured_providers.filter((row) => row.kind === "custom")).toEqual([
      { kind: "custom", ...decl },
    ]);

    // (d) re-adding a key restores BOTH faces.
    await store.addCustomProviderKey(app.id, "my-custom", sk("custom-ark-5555"));
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
    await store.upsertModelChain(app.id, "seat-mstar-review-seat", "anthropic/claude-sonnet-4-6:thinking");
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
    expect(await ok.text()).toContain("Saved the omp runtime image");
    expect(db.raw.query("SELECT sandbox_image_id FROM github_apps WHERE id = ?").get(app.id)).toEqual({
      sandbox_image_id: "omp",
    });
    // The JSON face (not the SPA page path) reflects the saved selection.
    const payload = await getJson("/dashboard/api/apps/mallorys-app/settings", "mallory", env);
    const body = (await payload.json()) as {
      app: { sandbox_image_id: string };
      sandbox_images?: Array<{ id: string; enabled: boolean }>;
    };
    expect(body.app.sandbox_image_id).toBe("omp");
    // The manage face's choices are enabled registry entries ONLY — never
    // image-local configuration, yaml, or secrets, and omp is not a provider
    // catalog entry.
    expect(body.sandbox_images).toEqual([{ id: "omp", enabled: true }]);
    expect(JSON.stringify(body)).not.toContain("models.yml");
  });

  test("unknown or disabled id → 400, nothing stored", async () => {
    const { db, app } = await seededWorld();
    const env = makeEnv(db);
    for (const imageId of ["no-such-image", "", "ark-plan"]) {
      const res = await postForm(SETTINGS, "mallory", env, { op: "save-sandbox-image", sandbox_image_id: imageId });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Unknown or disabled sandbox image");
    }
    // The refusals store nothing: the row keeps the migration default.
    expect(db.raw.query("SELECT sandbox_image_id FROM github_apps WHERE id = ?").get(app.id)).toEqual({
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
    expect(db.raw.query("SELECT sandbox_image_id FROM github_apps WHERE id = ?").get(app.id)).toEqual({
      sandbox_image_id: "omp",
    });
  });
});

describe("POST /dashboard/apps/:slug/settings — pinned add-key / add-custom-provider verify", () => {
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

/** Synchronous parameterized write on the raw bun:sqlite handle (fixture-only). */
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
    // No second registry entry exists today, so the only representable
    // non-omp state is a row pinned outside the registry — the fail-closed
    // unknown-id branch the precheck must cover (store-validated in prod).
    rawRun(db, "UPDATE github_apps SET sandbox_image_id = 'legacy-runtime' WHERE id = ?", app.id);
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called for an ineligible App");
    }) as unknown as typeof fetch);
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: PLAIN_KEY });
    expect(res.status).toBe(400);
    // CARRY-2: the closed `{ ok, reason }` family gains the
    // optional keyed face — same key as the settings POST family's
    // eligibility site, no new reason value.
    expect(await res.json()).toEqual({
      ok: false,
      reason: "unsupported_provider",
      key: "settings.error.providerUnavailableOnImage",
      message:
        "anthropic is not available under this App's selected runtime image (legacy-runtime) — nothing was stored.",
      params: { provider: "anthropic", image: "legacy-runtime" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_provider_keys").get() as { n: number }).toEqual({ n: 0 });
  });

  test("verify: omp selected image → precheck passes, existing verify-first flow stores the key", async () => {
    const { db, app } = await seededWorld();
    rawRun(db, "UPDATE github_apps SET sandbox_image_id = 'omp' WHERE id = ?", app.id);
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
    rawRun(db, "UPDATE github_apps SET sandbox_image_id = 'legacy-runtime' WHERE id = ?", app.id);
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_provider_keys").get() as { n: number }).toEqual({ n: 0 });
  });

  test("add-key: omp selected image → precheck passes, existing flow stores the key", async () => {
    const { db, app } = await seededWorld();
    rawRun(db, "UPDATE github_apps SET sandbox_image_id = 'omp' WHERE id = ?", app.id);
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

describe("POST /dashboard/apps/:slug/settings — add-template-provider materialization (spec §5)", () => {
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
    // The custom probe hit the materialized models endpoint (custom
    // probe path: {base}/models for a base already ending in /v1).
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
    // The prefill vocabulary is the template's representative models.
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_custom_providers").get() as { n: number }).toEqual({ n: 0 });
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_custom_providers").get() as { n: number }).toEqual({ n: 0 });
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_custom_providers").get() as { n: number }).toEqual({ n: 0 });
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });

  // --- breadth generalization (spec § Providers contract 1b) ---

  test("a no-placeholder breadth template materializes WITHOUT an account id (catalog base URL prefill)", async () => {
    const { db, app } = await seededWorld();
    fetchSpy = mockStatus(200, { data: [] });
    // `subconscious` is a snapshot breadth row: https base URL, no
    // {account_id} placeholder. No account_id field is sent at all.
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "subconscious",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Subconscious");
    // The probe hit the catalog-prefilled base URL (custom probe
    // path: {base}/models for a base already ending in /v1).
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
    // The prefill vocabulary is the breadth entry's snapshot model list.
    expect(declared[0]!.model_ids).toEqual(["subconscious/glm-5.2", "subconscious/tim-qwen3.6-27b"]);
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });

  test("a template with a null catalog base URL and no override → 400 incomplete, zero rows stored", async () => {
    const { db } = await seededWorld();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called for an incomplete template");
    }) as unknown as typeof fetch);
    // `watsonx` is a snapshot breadth row whose `api` (base URL) is null —
    // the "incomplete" 400 fires only when BOTH the catalog and the form
    // base URL are absent.
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "watsonx",
      key: PLAIN_KEY,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("incomplete");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_custom_providers").get() as { n: number }).toEqual({ n: 0 });
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_custom_providers").get() as { n: number }).toEqual({ n: 0 });
  });
});

describe("GET settings includes delivery_summary for the sidebar", () => {
  test("delivery_summary is present and never includes encrypted columns", async () => {
    const { db } = await seededWorld();
    const res = await getJson("/dashboard/api/apps/mallorys-app/settings", "mallory", makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      delivery_summary: { latest: null; rejected24h: number };
      configured_providers?: Array<{ kind: string }>;
      provider_catalog?: Array<{ id: string; label: string; tier: string; verifiable: boolean; eligibility: string }>;
      app: { sandbox_image_id: string };
      sandbox_images?: Array<{ id: string; enabled: boolean }>;
    };
    expect(body.delivery_summary).toEqual({ latest: null, rejected24h: 0 });
    // payload shape: the selected image id on the app meta + the
    // enabled-registry selector choices on the manage face.
    expect(body.app.sandbox_image_id).toBe("omp");
    expect(body.sandbox_images).toEqual([{ id: "omp", enabled: true }]);
    expect(JSON.stringify(body)).not.toContain("key_enc");
    expect(JSON.stringify(body)).not.toContain("private_key");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    // clean cutover: a fresh App is the unconfigured case — empty
    // configured state while the discovery catalog stays fully populated
    // (builtin ids in PROVIDER_IDS order + the template tier, with
    // verifiable flags and eligibility vs the selected omp image).
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
    const res = await getJson("/dashboard/api/apps/mallorys-app/settings", "hubot", makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      can_manage: boolean;
      app: { slug: string };
      keys?: unknown;
      configured_providers?: unknown;
      provider_catalog?: unknown;
      model_chains?: unknown;
      model_roles?: unknown;
      custom_providers?: unknown;
    };
    expect(body.can_manage).toBe(false);
    expect(body.app.slug).toBe("mallorys-app");
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
    const res = await getJson("/dashboard/api/apps/mallorys-app/settings", "mallory", env);
    expect(res.status).toBe(200);
    return (await res.json()) as {
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
    // The masked key row — masked tail only, never plaintext — plus its pool
    // identity (the per-key delete handle) and the verification bookkeeping.
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
    // The same id still lives in the catalog as DISCOVERY metadata: an
    // anthropic catalog row exists, but nothing catalog-shaped leaked into
    // the configured list (and vice versa).
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
      // The materialized pool's own rows: a template provider is managed per
      // key exactly like a free-form custom declaration.
      {
        kind: "key",
        provider: "workers-ai",
        key_id: expect.any(String),
        last4: PLAIN_KEY.slice(-4),
        updated_at: expect.any(String),
        verified_at: expect.any(String),
        verified_status: "ok",
      },
      {
        kind: "custom",
        provider_id: "workers-ai",
        base_url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`,
        api: "openai-completions",
        model_ids: expect.any(Array),
      },
    ]);
    // The catalog entry stays template-tier discovery metadata.
    expect(body.provider_catalog.find((p) => p.id === "workers-ai")).toMatchObject({
      tier: "template",
      eligibility: "template",
    });
    expect(JSON.stringify(body)).not.toContain(PLAIN_KEY);
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
      // Its key is a row of its own — the delete handle the whole-provider
      // removal deliberately is not.
      {
        kind: "key",
        provider: "my-custom",
        key_id: expect.any(String),
        last4: PLAIN_KEY.slice(-4),
        updated_at: expect.any(String),
        verified_at: expect.any(String),
        verified_status: "ok",
      },
      {
        kind: "custom",
        provider_id: "my-custom",
        base_url: "https://example.com/v1",
        api: "openai-completions",
        model_ids: ["local-7b"],
      },
    ]);
    // "my-custom" is NOT a catalog id — only the configured row exists.
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

  /** One row of the payload's `keys` face (the store's ProviderKeySummary). */
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
    // The settings POST family and the SPA verify route write the same pool.
    const first = await postForm(VERIFY, "mallory", env, { provider: "anthropic", key: PLAIN_KEY });
    expect(first.status).toBe(200);
    const second = await postForm(SETTINGS, "mallory", env, {
      op: "add-key",
      provider: "anthropic",
      key: SECOND_KEY,
    });
    expect(second.status).toBe(200);
    // Re-submitting the FIRST key updates in place — it never opens a third slot.
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
    // keys[]: one row per stored key — identity, mask, per-key bookkeeping.
    expect(body.keys).toHaveLength(2);
    expect(body.keys.every((row) => row.provider === "anthropic")).toBe(true);
    expect(body.keys.map((row) => row.keyId).sort()).toEqual([firstId, secondId].sort());
    expect(body.keys.map((row) => row.last4).sort()).toEqual([PLAIN_KEY.slice(-4), SECOND_KEY.slice(-4)].sort());
    const verifiedOnce = body.keys.find((row) => row.keyId === firstId)!;
    const neverVerified = body.keys.find((row) => row.keyId === secondId)!;
    expect(verifiedOnce.verifiedStatus).toBe("ok");
    expect(verifiedOnce.verifiedAt).toEqual(expect.any(String));
    expect(neverVerified).toMatchObject({ verifiedAt: null, verifiedStatus: null });
    // configured_providers carries the same two rows, each addressable by key_id.
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
    // The declaration lands with its first key; a second submission with a
    // DIFFERENT key appends to the same pool instead of opening a declaration.
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
    // One row per stored key, each carrying its own identity, mask and
    // verification state — a pool size never renders as one declaration row.
    const keyRows = body.configured_providers.filter((row) => row.kind === "key");
    expect(keyRows.map((row) => row.key_id).sort()).toEqual([firstId, secondId].sort());
    expect(keyRows.map((row) => row.last4).sort()).toEqual(
      [PLAIN_KEY.slice(-4), SECOND_KEY.slice(-4)].sort(),
    );
    expect(keyRows.every((row) => row.provider === "my-custom")).toBe(true);
    expect(keyRows.every((row) => row.verified_status === "ok")).toBe(true);
    // The add flow's per-provider face carries them too — a materialized
    // template's pool is listed there before another key is appended.
    expect(
      body.keys.filter((row) => row.provider === "my-custom").map((row) => row.keyId).sort(),
    ).toEqual([firstId, secondId].sort());
    // The declaration row survives as its own entry — the whole-provider
    // action's target, next to the per-key rows.
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
    await store.addCustomProviderKey(app.id, "my-custom", SECOND_KEY);

    const removed = await postForm(SETTINGS + "/key/delete", "mallory", env, {
      provider: "my-custom",
      key_id: await keyIdOf(PLAIN_KEY),
    });
    expect(removed.status).toBe(200);
    expect(await removed.text()).toContain("Removed the stored my-custom key for mallorys-app");
    expect(await store.listCustomProviderKeys(app.id, "my-custom")).toMatchObject([
      { keyId: await keyIdOf(SECOND_KEY) },
    ]);
    // Only remove-custom-provider takes the declaration (and the whole pool).
    expect((await store.listCustomProviders(app.id)).map((row) => row.provider_id)).toEqual(["my-custom"]);
    // The App's built-in pool was never in play.
    expect(await store.listProviderKeys(app.id)).toEqual([]);

    // Draining the last key leaves the declaration in place (the editable,
    // re-keyable state) instead of orphaning anything.
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
    await store.addProviderKey(app.id, "anthropic", PLAIN_KEY);
    const env = makeEnv(db);
    const unmatched = await postForm(SETTINGS + "/key/delete", "mallory", env, {
      provider: "anthropic",
      key_id: "0".repeat(16),
    });
    expect(unmatched.status).toBe(200);
    const unmatchedBody = (await unmatched.json()) as { changed: boolean; message: string };
    // `changed: false` is the SPA's no-change face: a stale dialog must not
    // render "Changes saved." for a row that was already gone.
    expect(unmatchedBody.changed).toBe(false);
    expect(unmatchedBody.message).toContain("nothing changed");
    const matched = await postForm(SETTINGS + "/key/delete", "mallory", env, {
      provider: "anthropic",
      key_id: await keyIdOf(PLAIN_KEY),
    });
    expect(matched.status).toBe(200);
    const matchedBody = (await matched.json()) as { changed: boolean; message: string };
    expect(matchedBody.changed).toBe(true);
    expect(matchedBody.message).toContain("Removed the stored anthropic key for mallorys-app");
  });

  test("the ninth key is a clear 400 on the custom entry points — declaration and pool unchanged", async () => {
    const { db, app } = await seededWorld();
    const store = createAppConfigStore(db, TEST_KEY);
    const env = makeEnv(db);
    mockStatus(200, { data: [] });
    // Both custom paths (a free-form id and a materialized template) start
    // with one stored key; the store's append API fills each pool to the cap.
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
    for (let i = 1; i < MAX_KEYS_PER_PROVIDER; i++) {
      await store.addCustomProviderKey(app.id, "my-custom", sk(`custom-cap-${i}-${i}${i}${i}`));
      await store.addCustomProviderKey(app.id, "workers-ai", sk(`workers-cap-${i}-${i}${i}${i}`));
    }
    const declarations = await store.listCustomProviders(app.id);
    const pools = await store.listCustomProviderKeys(app.id);
    expect(pools.filter((row) => row.provider === "my-custom")).toHaveLength(MAX_KEYS_PER_PROVIDER);
    expect(pools.filter((row) => row.provider === "workers-ai")).toHaveLength(MAX_KEYS_PER_PROVIDER);

    // The ENDPOINT stays put on purpose: with a populated pool an endpoint
    // change is refused earlier (A1, settings.error.providerEndpointLocked —
    // pinned in tests/worker/app-config.test.ts), so this case isolates the
    // pool-cap face of the same route.
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
    // Both refusals are zero-write: the declarations and every existing pool
    // row are exactly as they were.
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
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_provider_keys").get() as { n: number }).toEqual({
      n: MAX_KEYS_PER_PROVIDER,
    });
    // Neither refusal moved an existing row: the pool is byte-identical.
    expect((await store.listProviderKeys(app.id, "anthropic")).map((row) => row.keyId)).toEqual(before);
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
    const res = await getJson("/dashboard/api/apps/mallorys-app/settings", "mallory", env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider_catalog: CatalogRow[] };
    return body.provider_catalog;
  }

  test("every entry carries display_group; the common group is exactly the 5 frozen ids", async () => {
    const { db } = await seededWorld();
    const catalog = await getCatalog(makeEnv(db));
    expect(catalog.length).toBeGreaterThan(0);
    // (a) every entry carries the field with a valid word only.
    for (const row of catalog) {
      expect(row.display_group === "common" || row.display_group === "catalog").toBe(true);
    }
    // (b) common = exactly PROVIDER_IDS_COMMON, no more, no fewer.
    expect(catalog.filter((p) => p.display_group === "common").map((p) => p.id)).toEqual([...PROVIDER_IDS_COMMON]);
  });

  test("builtin non-common entries are catalog-grouped while keeping tier and eligibility semantics", async () => {
    const { db } = await seededWorld();
    const catalog = await getCatalog(makeEnv(db));
    // (c) the original builtin rows that fell out of the common tier keep
    // their builtin tier (the mechanics key) and omp eligibility.
    for (const id of ["azure-openai", "groq", "mistral", "ark"]) {
      expect(catalog.find((p) => p.id === id)).toMatchObject({
        tier: "builtin",
        eligibility: "builtin",
        display_group: "catalog",
      });
    }
    // The console-only verifiable flag is untouched by the regroup.
    expect(catalog.find((p) => p.id === "azure-openai")?.verifiable).toBe(false);
    expect(catalog.find((p) => p.id === "groq")?.verifiable).toBe(true);
  });

  test("template entries are all catalog-grouped; the response array order is unchanged", async () => {
    const { db } = await seededWorld();
    const catalog = await getCatalog(makeEnv(db));
    // (d) template tier → catalog group, uniformly.
    expect(catalog.filter((p) => p.tier === "template").every((p) => p.display_group === "catalog")).toBe(true);
    // Red line: the array order contract survives — builtin ids first in
    // PROVIDER_IDS order, then the template tier (server does NOT regroup;
    // grouping is a client-side display concern).
    const builtinCount = catalog.filter((p) => p.tier === "builtin").length;
    expect(catalog.slice(0, builtinCount).map((p) => p.id)).toEqual([...PROVIDER_IDS]);
    expect(catalog.slice(builtinCount).every((p) => p.tier === "template")).toBe(true);
  });
});
