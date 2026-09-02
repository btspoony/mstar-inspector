/**
 * Plan 31 Tasks 2+3 tests: migration 0015 (verification columns +
 * app_provider_models) + the provider verify service
 * (src/dashboard/provider-verify.ts) + the store wiring (saveVerifiedKey /
 * getVerifiedModels).
 *
 * Production-shaped sequence (the 0004/0005 + 0012 precedent): the
 * bun:sqlite double applies 0001/0002, a row is SEEDED, and only then do
 * 0003 → 0012 apply in filename order; 0015 is applied SEPARATELY over the
 * populated DB — the append-only assumption is exercised against a DB that
 * already holds data, exactly like `wrangler d1 migrations apply`.
 *
 * Verify-service tests use a mocked fetch: success+models / 401 / timeout /
 * non-JSON / custom-provider happy+401, plus the endpoint-map parity lock
 * (PROVIDER_VERIFY_ENDPOINTS ≡ PROVIDER_IDS — a future provider id must
 * get an explicit verify entry).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedTestD1, createTestD1, type TestD1 } from "../store/helpers";
import { createAppsStore, type GithubAppRow } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import {
  IN_IMAGE_BASE_PROVIDER_IDS,
  MAX_PROVIDER_KEY_LENGTH,
  PROVIDER_IDS,
  ProviderKeyTooLongError,
  createAppConfigStore,
  modelCacheProviderKey,
  type AppConfigD1,
} from "../../src/dashboard/app-config-store";
import {
  PROVIDER_VERIFY_ENDPOINTS,
  VERIFY_TIMEOUT_MS,
  verifyProviderKey,
  type VerifyDeps,
} from "../../src/dashboard/provider-verify";
import type { DashboardD1 } from "../../src/dashboard/users";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const PLAIN_KEY = "sk-ant-test-provider-1234";
/** SQLite datetime('now') format the store writes (UTC "YYYY-MM-DD HH:MM:SS"). */
const SQLITE_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// --- fixtures ---

/** Apply one migration file verbatim (filename order = wrangler order). */
function applyMigration(db: TestD1, name: string): void {
  db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
}

/** Synchronous parameterized write on the raw bun:sqlite handle. */
function rawRun(db: TestD1, sql: string, ...params: (string | number | null)[]): void {
  db.raw.prepare(sql).run(...params);
}

/** Seed a github_apps row with genuinely decryptable encrypted columns. */
async function seedApp(db: DashboardD1, slug: string): Promise<GithubAppRow> {
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  return createAppsStore(db).createApp({
    id,
    slug,
    githubAppId: 1001,
    name: slug,
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
  });
}

/**
 * Production-shaped DB through 0012 (the state 0015 must apply over, per the
 * locked order: AFTER 0004 and AFTER 0012), with an App plus one
 * pre-0015 key row and one pre-0015 custom-provider row seeded.
 */
async function createPopulatedPre0015D1(): Promise<TestD1> {
  const db = createTestD1();
  for (const name of [
    "0003_dashboard_users.sql",
    "0004_github_apps.sql",
    "0005_reviews_app_id.sql",
    "0006_app_provider_config.sql",
    "0008_github_apps_ops.sql",
    "0009_app_model_roles.sql",
    "0011_webhook_deliveries.sql",
    "0012_custom_providers_and_key_updated_at.sql",
  ]) {
    applyMigration(db, name);
  }
  const app = await seedApp(db, "legacy-app");
  const box = createSecretbox(TEST_KEY);
  // A key row written BEFORE 0015 — the pre-migration column set.
  rawRun(
    db,
    `INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at, updated_at)
     VALUES (?, 'anthropic', ?, datetime('now'), datetime('now'))`,
    app.id,
    await box.encryptSecret(PLAIN_KEY, `app_provider_keys.key_enc:${app.id}:anthropic`),
  );
  // A custom-provider declaration written BEFORE 0015.
  rawRun(
    db,
    `INSERT INTO app_custom_providers (app_id, provider_id, base_url, api, model_ids, api_key_enc, created_at, updated_at)
     VALUES (?, 'legacy-custom', 'https://example.com/v1', 'openai-completions', '["m1"]', ?, datetime('now'), datetime('now'))`,
    app.id,
    await box.encryptSecret(PLAIN_KEY, `app_custom_providers.api_key_enc:${app.id}:legacy-custom`),
  );
  return db;
}

const configStore = (db: AppConfigD1) => createAppConfigStore(db, TEST_KEY);

// --- mocked fetch helpers ---

type FetchCall = {
  url: string;
  method: string | undefined;
  headers: Record<string, string> | undefined;
  body: string | undefined;
  signal: AbortSignal | null | undefined;
};

/** build a deps.fetch from a canned response, recording every call. */
function mockFetch(response: Response, calls: FetchCall[] = []): VerifyDeps["fetch"] {
  return (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? undefined) as Record<string, string> | undefined,
      body: init?.body as string | undefined,
      signal: init?.signal ?? undefined,
    });
    return response;
  }) as VerifyDeps["fetch"];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch that never resolves on its own — it rejects only when the request
 *  signal aborts (the module's AbortSignal.timeout firing). */
const TIMEOUT_FETCH: VerifyDeps["fetch"] = ((_input, init) => {
  const { promise, reject } = Promise.withResolvers<Response>();
  init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
  return promise;
}) as VerifyDeps["fetch"];

const REJECT_FETCH: VerifyDeps["fetch"] = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as VerifyDeps["fetch"];

// --- migration 0015 ---

describe("migration 0015_provider_verification.sql (on a seeded production-shaped DB)", () => {
  test("applies cleanly after 0012 over existing key AND custom rows; pre-0015 rows carry NULL verification columns", async () => {
    const db = await createPopulatedPre0015D1();
    expect(() => applyMigration(db, "0015_provider_verification.sql")).not.toThrow();
    // Append-only: both pre-existing rows survive with NULL verification fields.
    const keyRow = db.raw
      .query("SELECT verified_at, verified_status FROM app_provider_keys WHERE provider = 'anthropic'")
      .get() as { verified_at: string | null; verified_status: string | null };
    expect(keyRow.verified_at).toBeNull();
    expect(keyRow.verified_status).toBeNull();
    const customRow = db.raw
      .query("SELECT verified_at, verified_status FROM app_custom_providers WHERE provider_id = 'legacy-custom'")
      .get() as { verified_at: string | null; verified_status: string | null };
    expect(customRow.verified_at).toBeNull();
    expect(customRow.verified_status).toBeNull();
    // The new columns are nullable TEXT on both tables.
    for (const table of ["app_provider_keys", "app_custom_providers"]) {
      const cols = db.raw.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number }>;
      for (const name of ["verified_at", "verified_status"]) {
        const col = cols.find((c) => c.name === name);
        expect(col, `${table}.${name} exists`).toBeDefined();
        expect(col!.type).toBe("TEXT");
        expect(col!.notnull).toBe(0);
      }
    }
  });

  test("app_provider_models DDL: composite PK (app_id, provider), FK to github_apps, NO ON DELETE", () => {
    const db = createMigratedTestD1(); // 0001 → 0015 in filename order
    const cols = db.raw.query("PRAGMA table_info(app_provider_models)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c])) as Record<string, (typeof cols)[number]>;
    expect(Object.keys(byName).sort()).toEqual(["app_id", "fetched_at", "models_json", "provider"]);
    expect(byName.app_id!.notnull).toBe(1);
    expect(byName.app_id!.pk).toBe(1);
    expect(byName.provider!.notnull).toBe(1);
    expect(byName.provider!.pk).toBe(2); // second column of the composite PK
    expect(byName.models_json!.notnull).toBe(1);
    expect(byName.fetched_at!.notnull).toBe(1);
    const fks = db.raw.query("PRAGMA foreign_key_list(app_provider_models)").all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    expect(fks).toHaveLength(1);
    expect(fks[0]!.table).toBe("github_apps");
    expect(fks[0]!.from).toBe("app_id");
    expect(fks[0]!.to).toBe("id");
    expect(fks[0]!.on_delete).toBe("NO ACTION");
  });
});

// --- endpoint map parity ---

describe("PROVIDER_VERIFY_ENDPOINTS parity lock", () => {
  test("is keyed exactly by PROVIDER_IDS (a new provider id must get an explicit verify entry)", () => {
    expect(Object.keys(PROVIDER_VERIFY_ENDPOINTS).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(Object.keys(PROVIDER_VERIFY_ENDPOINTS)).toHaveLength(19);
  });

  test("every entry is a recognized spec kind (models | probe | unsupported)", () => {
    for (const [provider, spec] of Object.entries(PROVIDER_VERIFY_ENDPOINTS)) {
      if (spec.kind === "models") {
        expect(spec.url.startsWith("https://")).toBe(true);
        expect(["bearer", "x-api-key", "x-goog-api-key"]).toContain(spec.auth);
      } else if (spec.kind === "probe") {
        expect(spec.url.startsWith("https://")).toBe(true);
        expect(["GET", "POST"]).toContain(spec.method);
        expect(["bearer", "x-api-key"]).toContain(spec.auth);
      } else {
        // unsupported — per-resource-host providers carry a documented note
        expect(spec.note.length).toBeGreaterThan(10);
        expect(["azure-openai", "ai-gateway"]).toContain(provider);
      }
    }
  });

  test("modelCacheProviderKey maps ark → ark-plan (spec §6.1) and leaves others unchanged", () => {
    expect(modelCacheProviderKey("ark")).toBe("ark-plan");
    expect(modelCacheProviderKey("anthropic")).toBe("anthropic");
    // The selector-facing id set is exactly the in-image base provider ids.
    expect(modelCacheProviderKey("ark")).toBe(IN_IMAGE_BASE_PROVIDER_IDS[0]!);
  });
});

// --- built-in verification ---

describe("verifyProviderKey — built-in providers (mocked fetch)", () => {
  test("openai: Bearer GET /v1/models, 2xx parses data[].id and dedupes", async () => {
    const calls: FetchCall[] = [];
    const result = await verifyProviderKey(
      { fetch: mockFetch(json(200, { data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }, { id: "gpt-5" }] }), calls) },
      "openai",
      PLAIN_KEY,
    );
    expect(result).toEqual({ ok: true, models: ["gpt-5", "gpt-5-mini"] });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/models");
    expect(call.method).toBe("GET");
    expect(call.headers).toEqual({ authorization: `Bearer ${PLAIN_KEY}` });
  });

  test("anthropic: x-api-key + anthropic-version headers", async () => {
    const calls: FetchCall[] = [];
    const result = await verifyProviderKey(
      { fetch: mockFetch(json(200, { data: [{ id: "claude-sonnet-4-6", type: "model" }] }), calls) },
      "anthropic",
      PLAIN_KEY,
    );
    expect(result).toEqual({ ok: true, models: ["claude-sonnet-4-6"] });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/models");
    expect(call.headers).toEqual({ "x-api-key": PLAIN_KEY, "anthropic-version": "2023-06-01" });
  });

  test("gemini: x-goog-api-key header (key never in the URL) + Gemini models[].name shape", async () => {
    const calls: FetchCall[] = [];
    const result = await verifyProviderKey(
      {
        fetch: mockFetch(
          json(200, { models: [{ name: "models/gemini-2.5-flash" }, { name: "models/gemini-3-pro" }] }),
          calls,
        ),
      },
      "gemini",
      PLAIN_KEY,
    );
    expect(result).toEqual({ ok: true, models: ["gemini-2.5-flash", "gemini-3-pro"] });
    const call = calls[0]!;
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(call.headers).toEqual({ "x-goog-api-key": PLAIN_KEY });
    expect(call.url.includes(PLAIN_KEY)).toBe(false);
  });

  test("401 → invalid_key (and the body is never parsed)", async () => {
    const result = await verifyProviderKey({ fetch: mockFetch(json(401, { error: { message: "nope" } })) }, "openai", PLAIN_KEY);
    expect(result).toEqual({ ok: false, reason: "invalid_key" });
  });

  test("403 → invalid_key", async () => {
    const result = await verifyProviderKey({ fetch: mockFetch(json(403, {})) }, "openai", PLAIN_KEY);
    expect(result).toEqual({ ok: false, reason: "invalid_key" });
  });

  test("other non-2xx (500) → unexpected_response", async () => {
    const result = await verifyProviderKey({ fetch: mockFetch(json(500, {})) }, "openai", PLAIN_KEY);
    expect(result).toEqual({ ok: false, reason: "unexpected_response" });
  });

  test("2xx but non-JSON body → unexpected_response", async () => {
    const html = new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
    const result = await verifyProviderKey({ fetch: mockFetch(html) }, "openai", PLAIN_KEY);
    expect(result).toEqual({ ok: false, reason: "unexpected_response" });
  });

  test("2xx with an unrecognized shape (error envelope) → unexpected_response", async () => {
    const result = await verifyProviderKey({ fetch: mockFetch(json(200, { error: { message: "??" } })) }, "openai", PLAIN_KEY);
    expect(result).toEqual({ ok: false, reason: "unexpected_response" });
  });

  test("timeout (fetch rejects on the AbortSignal abort) → unreachable", async () => {
    const result = await verifyProviderKey({ fetch: TIMEOUT_FETCH, timeoutMs: 25 }, "openai", PLAIN_KEY);
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  test("network rejection → unreachable", async () => {
    const result = await verifyProviderKey({ fetch: REJECT_FETCH }, "openai", PLAIN_KEY);
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  test("probe provider (copilot): 2xx → ok with models [] (probe-only)", async () => {
    const calls: FetchCall[] = [];
    const result = await verifyProviderKey(
      { fetch: mockFetch(json(200, { login: "somebody" }), calls) },
      "copilot",
      PLAIN_KEY,
    );
    expect(result).toEqual({ ok: true, models: [] });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.github.com/user");
    expect(call.headers).toEqual({ authorization: `Bearer ${PLAIN_KEY}` });
  });

  test("probe provider (kilo): POSTs a 1-token chat body with Bearer auth", async () => {
    const calls: FetchCall[] = [];
    const result = await verifyProviderKey(
      { fetch: mockFetch(json(200, { choices: [{ message: { content: "pong" } }] }), calls) },
      "kilo",
      PLAIN_KEY,
    );
    expect(result).toEqual({ ok: true, models: [] });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.kilo.ai/api/gateway/chat/completions");
    expect(call.method).toBe("POST");
    expect(JSON.parse(call.body!)).toEqual({
      model: "kilo-auto/small",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
  });

  test("cursor: GET /v1/models is a MODELS endpoint — a 2xx list is parsed and cached (not discarded as probe-only)", async () => {
    const calls: FetchCall[] = [];
    const result = await verifyProviderKey(
      { fetch: mockFetch(json(200, { data: [{ id: "cursor-fast" }, { id: "cursor-premium" }] }), calls) },
      "cursor",
      PLAIN_KEY,
    );
    expect(result).toEqual({ ok: true, models: ["cursor-fast", "cursor-premium"] });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.cursor.com/v1/models");
    expect(call.method).toBe("GET");
    expect(call.headers).toEqual({ authorization: `Bearer ${PLAIN_KEY}` });
  });

  test("cursor: 401 still maps to invalid_key (token rejected)", async () => {
    const result = await verifyProviderKey({ fetch: mockFetch(json(401, {})) }, "cursor", PLAIN_KEY);
    expect(result).toEqual({ ok: false, reason: "invalid_key" });
  });

  test("unsupported provider (azure-openai) → unsupported_provider and fetch is NEVER called", async () => {
    let fetchCalls = 0;
    const deps: VerifyDeps = {
      fetch: (async () => {
        fetchCalls += 1;
        return json(200, {});
      }) as unknown as VerifyDeps["fetch"],
    };
    const result = await verifyProviderKey(deps, "azure-openai", PLAIN_KEY);
    expect(result).toEqual({ ok: false, reason: "unsupported_provider" });
    expect(fetchCalls).toBe(0);
  });

  test("unknown provider id → unsupported_provider", async () => {
    const result = await verifyProviderKey({ fetch: mockFetch(json(200, {})) }, "no-such-provider", PLAIN_KEY);
    expect(result).toEqual({ ok: false, reason: "unsupported_provider" });
  });
});

// --- custom-provider verification ---

describe("verifyProviderKey — custom providers (mocked fetch)", () => {
  const CUSTOM = {
    baseUrl: "https://custom.example.com/v1",
    api: "openai-completions" as const,
    modelIds: ["my-model-a", "my-model-b"],
  };

  test("openai-completions happy path: Bearer probe on {baseUrl}/v1/models; 2xx echoes the DECLARED model_ids — even when the body carries a parseable vendor list (spec §6.1 回显, 无抓取)", async () => {
    const calls: FetchCall[] = [];
    const result = await verifyProviderKey(
      { fetch: mockFetch(json(200, { data: [{ id: "vendor-model-1" }] }), calls) },
      "custom",
      PLAIN_KEY,
      CUSTOM,
    );
    expect(result).toEqual({ ok: true, models: ["my-model-a", "my-model-b"] });
    const call = calls[0]!;
    expect(call.url).toBe("https://custom.example.com/v1/models");
    expect(call.headers).toEqual({ authorization: `Bearer ${PLAIN_KEY}` });
  });

  test("base URL without the /v1 suffix still probes {base}/v1/models", async () => {
    const calls: FetchCall[] = [];
    await verifyProviderKey(
      { fetch: mockFetch(json(200, { data: [{ id: "m" }] }), calls) },
      "custom",
      PLAIN_KEY,
      { ...CUSTOM, baseUrl: "https://custom.example.com" },
    );
    expect(calls[0]!.url).toBe("https://custom.example.com/v1/models");
  });

  test("base URL trailing slash is normalized (https://custom.example.com/v1/)", async () => {
    const calls: FetchCall[] = [];
    await verifyProviderKey(
      { fetch: mockFetch(json(200, { data: [{ id: "m" }] }), calls) },
      "custom",
      PLAIN_KEY,
      { ...CUSTOM, baseUrl: "https://custom.example.com/v1/" },
    );
    expect(calls[0]!.url).toBe("https://custom.example.com/v1/models");
  });

  test("2xx with an unparseable body echoes the DECLARED model_ids (spec §6.1 回显)", async () => {
    const result = await verifyProviderKey(
      { fetch: mockFetch(json(200, { weird: "body" })) },
      "custom",
      PLAIN_KEY,
      CUSTOM,
    );
    expect(result).toEqual({ ok: true, models: ["my-model-a", "my-model-b"] });
  });

  test("2xx with an empty data array echoes the DECLARED model_ids", async () => {
    const result = await verifyProviderKey(
      { fetch: mockFetch(json(200, { data: [] })) },
      "custom",
      PLAIN_KEY,
      CUSTOM,
    );
    expect(result).toEqual({ ok: true, models: ["my-model-a", "my-model-b"] });
  });

  test("401 → invalid_key", async () => {
    const result = await verifyProviderKey(
      { fetch: mockFetch(json(401, {})) },
      "custom",
      PLAIN_KEY,
      CUSTOM,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_key" });
  });

  test("anthropic-messages custom provider probes with x-api-key + anthropic-version and echoes the DECLARED model_ids", async () => {
    const calls: FetchCall[] = [];
    const result = await verifyProviderKey(
      { fetch: mockFetch(json(200, { data: [{ id: "claude-model" }] }), calls) },
      "custom",
      PLAIN_KEY,
      { ...CUSTOM, api: "anthropic-messages" },
    );
    expect(result).toEqual({ ok: true, models: CUSTOM.modelIds });
    expect(calls[0]!.headers).toEqual({ "x-api-key": PLAIN_KEY, "anthropic-version": "2023-06-01" });
  });

  test("timeout → unreachable", async () => {
    const result = await verifyProviderKey(
      { fetch: TIMEOUT_FETCH, timeoutMs: 25 },
      "custom",
      PLAIN_KEY,
      CUSTOM,
    );
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });
});

// --- store wiring ---

describe("store wiring — saveVerifiedKey + getVerifiedModels", () => {
  test("saveVerifiedKey encrypts the key (real AAD round-trip), writes verified bookkeeping, and caches the models", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "verified-app");
    const store = configStore(db);
    await store.saveVerifiedKey(app.id, "anthropic", PLAIN_KEY, ["claude-sonnet-4-6", "claude-opus-4-7"]);

    const keyRow = db.raw
      .query("SELECT * FROM app_provider_keys WHERE app_id = ? AND provider = 'anthropic'")
      .get(app.id) as Record<string, string | null>;
    expect(keyRow.verified_at).toMatch(SQLITE_TS_RE);
    expect(keyRow.verified_status).toBe("ok");
    expect(keyRow.created_at).toMatch(SQLITE_TS_RE);
    expect(keyRow.updated_at).toBe(keyRow.created_at); // one clock read (0012 T1 convention)
    // The plaintext key is only recoverable through the real composite-PK AAD.
    const plain = await createSecretbox(TEST_KEY).decryptSecret(
      keyRow.key_enc!,
      `app_provider_keys.key_enc:${app.id}:anthropic`,
    );
    expect(plain).toBe(PLAIN_KEY);

    const cached = await store.getVerifiedModels(app.id);
    expect(cached).toEqual([
      { provider: "anthropic", models: ["claude-sonnet-4-6", "claude-opus-4-7"], fetched_at: expect.stringMatching(SQLITE_TS_RE) },
    ]);
  });

  test("ark key verifies under BYOK id but caches under the selector-facing ark-plan row (spec §6.1)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "ark-app");
    const store = configStore(db);
    await store.saveVerifiedKey(app.id, "ark", PLAIN_KEY, ["doubao-seed-2-1-pro"]);

    const keyRow = db.raw
      .query("SELECT provider, verified_status FROM app_provider_keys WHERE app_id = ?")
      .all(app.id) as Array<{ provider: string; verified_status: string }>;
    expect(keyRow).toEqual([{ provider: "ark", verified_status: "ok" }]);
    const cacheRow = db.raw
      .query("SELECT provider, models_json FROM app_provider_models WHERE app_id = ?")
      .all(app.id) as Array<{ provider: string; models_json: string }>;
    expect(cacheRow).toEqual([{ provider: "ark-plan", models_json: JSON.stringify(["doubao-seed-2-1-pro"]) }]);
  });

  test("removeProviderKey deletes the verified-model cache row with the key (save → remove → getVerifiedModels empty)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "remove-app");
    const store = configStore(db);
    await store.saveVerifiedKey(app.id, "anthropic", PLAIN_KEY, ["claude-sonnet-4-6"]);
    expect(await store.getVerifiedModels(app.id)).toHaveLength(1);
    expect(await store.removeProviderKey(app.id, "anthropic")).toBe(true);
    expect(await store.getVerifiedModels(app.id)).toEqual([]);
    const cacheCount = db.raw
      .query("SELECT COUNT(*) AS n FROM app_provider_models WHERE app_id = ?")
      .get(app.id) as { n: number };
    expect(cacheCount.n).toBe(0);
  });

  test("removeProviderKey('ark') deletes the ark-plan cache row (modelCacheProviderKey normalization)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "remove-ark-app");
    const store = configStore(db);
    await store.saveVerifiedKey(app.id, "ark", PLAIN_KEY, ["doubao-seed-2-1-pro"]);
    expect((await store.getVerifiedModels(app.id)).map((c) => c.provider)).toEqual(["ark-plan"]);
    expect(await store.removeProviderKey(app.id, "ark")).toBe(true);
    expect(await store.getVerifiedModels(app.id)).toEqual([]);
    const cacheCount = db.raw
      .query("SELECT COUNT(*) AS n FROM app_provider_models WHERE app_id = ?")
      .get(app.id) as { n: number };
    expect(cacheCount.n).toBe(0);
    const keyCount = db.raw
      .query("SELECT COUNT(*) AS n FROM app_provider_keys WHERE app_id = ?")
      .get(app.id) as { n: number };
    expect(keyCount.n).toBe(0);
  });

  test("setProviderKey overwriting a verified row resets verified_* to NULL (verification belongs to the (provider, key) pair)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "overwrite-app");
    const store = configStore(db);
    await store.saveVerifiedKey(app.id, "openai", PLAIN_KEY, ["gpt-5"]);
    let row = db.raw
      .query("SELECT verified_at, verified_status FROM app_provider_keys WHERE app_id = ?")
      .get(app.id) as { verified_at: string | null; verified_status: string | null };
    expect(row.verified_status).toBe("ok");
    await store.setProviderKey(app.id, "openai", "sk-overwrite-key-7777");
    const after = db.raw
      .query("SELECT verified_at, verified_status, key_enc FROM app_provider_keys WHERE app_id = ?")
      .get(app.id) as { verified_at: string | null; verified_status: string | null; key_enc: string };
    expect(after.verified_at).toBeNull();
    expect(after.verified_status).toBeNull();
    // The unverified overwrite replaced the verified envelope (AAD round-trip).
    await expect(
      createSecretbox(TEST_KEY).decryptSecret(after.key_enc, `app_provider_keys.key_enc:${app.id}:openai`),
    ).resolves.toBe("sk-overwrite-key-7777");
  });

  test("getVerifiedModels fails loud on a malformed app_provider_models row, citing app_provider_models.models_json (not app_custom_providers.model_ids)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "malformed-cache-app");
    const store = configStore(db);
    await store.saveVerifiedKey(app.id, "openai", PLAIN_KEY, ["gpt-5"]);
    db.raw
      .prepare("UPDATE app_provider_models SET models_json = ? WHERE app_id = ? AND provider = ?")
      .run("null", app.id, "openai");
    await expect(store.getVerifiedModels(app.id)).rejects.toThrow(
      /app_provider_models\.models_json is not a JSON array of strings/,
    );
  });

  test("re-save upserts both rows (no duplicates) and refreshes the cached models", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "resave-app");
    const store = configStore(db);
    await store.saveVerifiedKey(app.id, "openai", PLAIN_KEY, ["gpt-5"]);
    await store.saveVerifiedKey(app.id, "openai", "sk-new-key-9999", ["gpt-5", "gpt-5-mini"]);

    const keyCount = db.raw.query("SELECT COUNT(*) AS n FROM app_provider_keys WHERE app_id = ?").get(app.id) as { n: number };
    const cacheCount = db.raw
      .query("SELECT COUNT(*) AS n FROM app_provider_models WHERE app_id = ?")
      .get(app.id) as { n: number };
    expect(keyCount.n).toBe(1);
    expect(cacheCount.n).toBe(1);
    const cached = await store.getVerifiedModels(app.id);
    expect(cached).toHaveLength(1);
    expect(cached[0]!.models).toEqual(["gpt-5", "gpt-5-mini"]);
    // The new key replaced the old envelope (decryptable only with the AAD).
    const row = db.raw.query("SELECT key_enc FROM app_provider_keys WHERE app_id = ?").get(app.id) as { key_enc: string };
    await expect(
      createSecretbox(TEST_KEY).decryptSecret(row.key_enc, `app_provider_keys.key_enc:${app.id}:openai`),
    ).resolves.toBe("sk-new-key-9999");
  });

  test("getVerifiedModels orders by provider ascending and parses each models_json", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "order-app");
    const store = configStore(db);
    await store.saveVerifiedKey(app.id, "mistral", PLAIN_KEY, ["mistral-large"]);
    await store.saveVerifiedKey(app.id, "openai", PLAIN_KEY, ["gpt-5"]);
    await store.saveVerifiedKey(app.id, "ark", PLAIN_KEY, ["doubao"]);
    const cached = await store.getVerifiedModels(app.id);
    expect(cached.map((c) => c.provider)).toEqual(["ark-plan", "mistral", "openai"]);
  });

  test("legacy setProviderKey still writes unverified rows (NULL verified columns) — old callers keep compiling", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "legacy-write-app");
    const store = configStore(db);
    await store.setProviderKey(app.id, "xai", PLAIN_KEY); // the unverified path Task 4 switches over
    const row = db.raw
      .query("SELECT verified_at, verified_status FROM app_provider_keys WHERE app_id = ?")
      .get(app.id) as { verified_at: string | null; verified_status: string | null };
    expect(row.verified_at).toBeNull();
    expect(row.verified_status).toBeNull();
    // The legacy read faces still work over the 0015 shape.
    const masked = await store.listProviderKeys(app.id);
    expect(masked).toEqual([{ provider: "xai", last4: "1234", updated_at: expect.stringMatching(SQLITE_TS_RE) }]);
    const appConfig = await store.getAppConfig(app.id);
    expect(appConfig.keys.xai).toBe(PLAIN_KEY);
    expect(await store.getVerifiedModels(app.id)).toEqual([]); // no cache row yet
  });

  test("saveVerifiedKey rejects an over-long key before any write (ProviderKeyTooLongError)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "bounds-app");
    const store = configStore(db);
    await expect(
      store.saveVerifiedKey(app.id, "openai", "x".repeat(MAX_PROVIDER_KEY_LENGTH + 1), ["gpt-5"]),
    ).rejects.toBeInstanceOf(ProviderKeyTooLongError);
    const keyCount = db.raw.query("SELECT COUNT(*) AS n FROM app_provider_keys WHERE app_id = ?").get(app.id) as { n: number };
    expect(keyCount.n).toBe(0);
  });

  test("listCustomProviders still reads over the 0015-shaped custom table (verified columns added)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "custom-app");
    const store = configStore(db);
    await store.upsertCustomProvider(
      app.id,
      { provider_id: "my-custom", base_url: "https://example.com/v1", api: "openai-completions", model_ids: ["m1"] },
      PLAIN_KEY,
    );
    const list = await store.listCustomProviders(app.id);
    expect(list).toEqual([
      { provider_id: "my-custom", base_url: "https://example.com/v1", api: "openai-completions", model_ids: ["m1"] },
    ]);
    // Custom providers never write app_provider_models rows (spec §6.1).
    expect(await store.getVerifiedModels(app.id)).toEqual([]);
  });

  test("VERIFY_TIMEOUT_MS is 10s and the default deps path uses it", () => {
    expect(VERIFY_TIMEOUT_MS).toBe(10_000);
  });
});
