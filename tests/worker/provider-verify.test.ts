/**
 * Provider verification tests: migration 0015 (verification columns +
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
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedTestD1, createTestD1, type TestD1 } from "../store/helpers";
import { createAppsStore, type GithubAppRow } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import {
  MAX_PROVIDER_KEY_LENGTH,
  PROVIDER_IDS,
  ProviderKeyTooLongError,
  createAppConfigStore,
  modelCacheProviderKey,
  type AppConfigD1,
} from "../../src/dashboard/app-config-store";
import { getSandboxImage } from "../../src/contracts/sandbox-images";
import {
  KEY_REJECTING_MODELS_PROBE_URLS,
  PROVIDER_VERIFY_ENDPOINTS,
  VERIFY_TIMEOUT_MS,
  VERIFY_USER_AGENT,
  builtinProbeCanRejectKey,
  customProbeCanRejectKey,
  ompProviderIdFor,
  verifyFetch,
  verifyProviderKey,
  type VerifyDeps,
} from "../../src/dashboard/provider-verify";
import type { DashboardD1 } from "../../src/dashboard/users";
import ompApiKeyProviders from "../../scripts/provider-catalog/omp-api-key-providers.json";
import ompProviderVerify from "../../scripts/provider-catalog/omp-provider-verify.json";
import { sk } from "../helpers/fake-secrets";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const PLAIN_KEY = sk("ant-test-provider-1234");
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
    githubSlug: slug,
    githubAppId: 1001,
    name: slug,
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
    workspaceId: "default",
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
    // 0036: the cached github_slug column (createApp writes it).
    "0036_app_identity.sql",
    "0005_reviews_app_id.sql",
    "0006_app_provider_config.sql",
    "0008_github_apps_ops.sql",
    "0009_app_model_roles.sql",
    "0011_webhook_deliveries.sql",
    "0012_custom_providers_and_key_updated_at.sql",
    // 0026: createApp's atomic app_workspaces mapping.
    "0026_workspaces.sql",
    // 0038 rebuilds github_apps, so the fixture must carry every column the
    // rebuild copies.
    "0018_app_sandbox_images.sql",
    "0019_github_apps_metadata.sql",
    "0022_app_trigger_mode.sql",
    "0037_github_metadata_attempt.sql",
    "0038_webhook_path_drop.sql",
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

/** A response carrying the URL and redirect flag a real fetch produces when it
 *  followed a Location header (a stubbed Response cannot set either itself). */
function redirected(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url });
  Object.defineProperty(response, "redirected", { value: true });
  return response;
}

/** Every verify request's headers: the key's auth shape plus the two client
 *  headers (an explicit Accept and User-Agent) no request may go without. */
function verifyHeaders(auth: Record<string, string>): Record<string, string> {
  return { ...auth, accept: "application/json", "user-agent": VERIFY_USER_AGENT };
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

  test("app_provider_models DDL: PK (app_id, provider, key_id), FK to github_apps, NO ON DELETE", () => {
    const db = createMigratedTestD1(); // 0001 → 0025 in filename order
    const cols = db.raw.query("PRAGMA table_info(app_provider_models)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c])) as Record<string, (typeof cols)[number]>;
    expect(Object.keys(byName).sort()).toEqual(["app_id", "fetched_at", "key_id", "models_json", "provider"]);
    expect(byName.app_id!.notnull).toBe(1);
    expect(byName.app_id!.pk).toBe(1);
    expect(byName.provider!.notnull).toBe(1);
    expect(byName.provider!.pk).toBe(2); // second column of the composite PK
    // 0025 moved the table from one aggregate row per (app_id, provider) to one
    // EVIDENCE row per key: the third PK column is the credential's own id.
    expect(byName.key_id!.notnull).toBe(1);
    expect(byName.key_id!.pk).toBe(3);
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

  test("unsupported built-ins are exactly azure-openai + ai-gateway (the settings face's verifiable flag)", () => {
    const unsupported = PROVIDER_IDS.filter((id) => PROVIDER_VERIFY_ENDPOINTS[id]?.kind === "unsupported");
    expect(unsupported).toEqual(["azure-openai", "ai-gateway"]);
  });

  test("each builtin's 2xx means ok or only reachable — the shared allow-list decides", () => {
    // true = the provider answers non-2xx for a bogus key (probed 2026-10-30);
    // false = no probe at all (unsupported) OR a probe whose PUBLIC model list
    // answers 200 for any bearer, so its 2xx proves reachability only.
    expect(Object.fromEntries(PROVIDER_IDS.map((id) => [id, builtinProbeCanRejectKey(id)]))).toEqual({
      anthropic: true,
      openai: true,
      gemini: true,
      copilot: true,
      "azure-openai": false,
      groq: true,
      cerebras: true,
      openrouter: false,
      kilo: false,
      mistral: true,
      zai: true,
      umans: false,
      minimax: true,
      opencode: true,
      cursor: true,
      "ai-gateway": false,
      ark: true,
      xai: true,
      "wafer-serverless": true,
    });
  });

  test("the allow-list is the spec table's own marker — one definition, no copied URL list", () => {
    // builtinProbeCanRejectKey ≡ spec exists ∧ kind ≠ unsupported ∧ keyRejecting.
    for (const id of PROVIDER_IDS) {
      const spec = PROVIDER_VERIFY_ENDPOINTS[id]!;
      expect(builtinProbeCanRejectKey(id), id).toBe(spec.kind !== "unsupported" && spec.keyRejecting === true);
    }
    // The exported set is exactly the marked spec URLs plus the one documented
    // supplement (TypeSafe): a hand-copied second list cannot survive this.
    const marked = new Set(
      Object.values(PROVIDER_VERIFY_ENDPOINTS).flatMap((spec) =>
        spec.kind !== "unsupported" && spec.keyRejecting === true ? [spec.url] : [],
      ),
    );
    marked.add("https://api.typesafe.ai/v1/models");
    expect(new Set(Object.keys(KEY_REJECTING_MODELS_PROBE_URLS))).toEqual(marked);
  });

  test("every entry is a recognized spec kind (models | probe | unsupported)", () => {
    for (const [provider, spec] of Object.entries(PROVIDER_VERIFY_ENDPOINTS)) {
      if (spec.kind === "models") {
        expect(spec.url.startsWith("https://")).toBe(true);
        expect(["bearer", "x-api-key", "x-goog-api-key"]).toContain(spec.auth);
      } else if (spec.kind === "probe") {
        expect(spec.url.startsWith("https://")).toBe(true);
        expect(["bearer", "x-api-key"]).toContain(spec.auth);
      } else {
        // unsupported — per-resource-host / undocumented-endpoint providers
        // carry a documented note.
        expect(spec.note.length).toBeGreaterThan(10);
        expect(["azure-openai", "ai-gateway"]).toContain(provider);
      }
    }
  });

  test("modelCacheProviderKey maps ark → ark-plan (spec §6.1) and leaves others unchanged", () => {
    expect(modelCacheProviderKey("ark")).toBe("ark-plan");
    expect(modelCacheProviderKey("anthropic")).toBe("anthropic");
    // The selector-facing id is the omp registry entry's capability host id —
    // resolved through the host's catalogProviderId `ark` (the host
    // list lives in src/contracts/sandbox-images.ts and is synthesized into
    // every per-review models.yml).
    const arkHost = getSandboxImage("omp")!.hosts.find((host) => host.catalogProviderId === "ark");
    expect(arkHost).toBeDefined();
    expect(modelCacheProviderKey("ark")).toBe(arkHost!.id);
  });
});

// --- omp alignment: the vendored validate data and the no-inference invariant ---

describe("omp 18.13.3 validate data (vendored verify snapshot)", () => {
  test("the snapshot names its source version, extraction date and the three headers hooks", () => {
    expect(ompProviderVerify.source.version).toBe("18.13.3");
    expect(ompProviderVerify.source.extracted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ompProviderVerify.source.headersHooks).toEqual([
      "cline-pass-client",
      "coreweave-project",
      "kimi-fingerprint",
    ]);
    // Every models-endpoint entry omp 18.13.3 carries is vendored verbatim.
    expect(ompProviderVerify.endpoints).toHaveLength(28);
    expect(ompProviderVerify.endpoints.find((entry) => entry.id === "coreweave")).toMatchObject({
      url: "https://api.inference.wandb.ai/v1/models",
      headersHook: "coreweave-project",
    });
  });

  test("inspector ids resolve to omp ids through the union alias map — no second mapping", () => {
    expect(ompProviderIdFor("gemini")).toBe("google");
    expect(ompProviderIdFor("azure-openai")).toBe("azure");
    expect(ompProviderIdFor("opencode")).toBe("opencode-zen");
    // A builtin whose id IS its omp id resolves to itself; an unknown id too.
    expect(ompProviderIdFor("xai")).toBe("xai");
    expect(ompProviderIdFor("not-a-provider")).toBe("not-a-provider");
    // The whole map, in the alias→catalog direction the verify surface reads.
    for (const [ompId, catalogId] of Object.entries(ompApiKeyProviders.excluded.alias)) {
      expect(ompProviderIdFor(catalogId)).toBe(ompId);
    }
  });

  test("builtin specs come from that data wherever omp validates a plain-Bearer models endpoint", () => {
    const byOmpId = new Map(ompProviderVerify.endpoints.map((entry) => [entry.id, entry]));
    let derived = 0;
    for (const [provider, spec] of Object.entries(PROVIDER_VERIFY_ENDPOINTS)) {
      const entry = byOmpId.get(ompProviderIdFor(provider));
      // A headers-hook entry is omp's own request (it computes hook headers the
      // dashboard cannot), so the documented entry answers for that id.
      if (entry === undefined || entry.headersHook !== undefined) continue;
      derived += 1;
      // An omp validate entry returns 2xx only for a valid key, so it also
      // carries the keyRejecting marker.
      expect(spec).toEqual({ kind: "models", url: entry.url, auth: "bearer", keyRejecting: true });
    }
    // xai + wafer-serverless are supplied ONLY by that data (the documented
    // table deliberately omits them), so a broken derivation fails here.
    expect(derived).toBe(2);
    expect(PROVIDER_VERIFY_ENDPOINTS["xai"]).toEqual({
      kind: "models",
      url: "https://api.x.ai/v1/models",
      auth: "bearer",
      keyRejecting: true,
    });
    expect(PROVIDER_VERIFY_ENDPOINTS["wafer-serverless"]).toEqual({
      kind: "models",
      url: "https://pass.wafer.ai/v1/models",
      auth: "bearer",
      keyRejecting: true,
    });
  });
});

describe("validation-only invariant (no inference in the verify surface)", () => {
  test("a verification only ever requests the models/probe endpoint — never a chat/completions URL", async () => {
    // I-000209: the invariant is the OUTBOUND REQUESTS, not the module's text.
    // A stub fetch returns a 2xx for anything and records every URL it was
    // asked for, so a verification that also tried an inference probe would
    // show up here whatever the source reads like.
    const requested: string[] = [];
    const record: VerifyDeps["fetch"] = async (input) => {
      requested.push(String(input));
      return json(200, { data: [], models: [] });
    };

    for (const [provider, spec] of Object.entries(PROVIDER_VERIFY_ENDPOINTS)) {
      if (spec.kind === "unsupported") continue;
      requested.length = 0;
      await verifyProviderKey({ fetch: record }, provider, PLAIN_KEY);
      // Exactly one request, to the spec's own models/probe URL — and that URL
      // is never an inference path (the retired kilo/zai/umans chat probes).
      expect(requested, provider).toEqual([spec.url]);
      expect(requested[0], provider).not.toMatch(/chat\/completions|completions|generateContent|invocations/);
    }

    // The custom path derives its own probe URL from the declared base and
    // requests exactly that one.
    requested.length = 0;
    const custom = await verifyProviderKey({ fetch: record }, "my-gateway", PLAIN_KEY, {
      baseUrl: "https://models.test/v1",
      api: "openai-completions",
      modelIds: ["m-1"],
    });
    expect(custom).toEqual({ ok: true, models: ["m-1"] });
    expect(requested).toEqual(["https://models.test/v1/models"]);
  });

  test("every verifiable builtin issues exactly one GET carrying no body", async () => {
    for (const [provider, spec] of Object.entries(PROVIDER_VERIFY_ENDPOINTS)) {
      if (spec.kind === "unsupported") continue;
      expect(spec.url).not.toMatch(/completions|generateContent|invocations/);
      const calls: FetchCall[] = [];
      await verifyProviderKey(
        { fetch: mockFetch(json(200, { data: [], models: [] }), calls) },
        provider,
        PLAIN_KEY,
      );
      expect(calls, provider).toHaveLength(1);
      expect(calls[0]!.method, provider).toBe("GET");
      expect(calls[0]!.body, provider).toBeUndefined();
    }
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
    expect(call.headers).toEqual(verifyHeaders({ authorization: `Bearer ${PLAIN_KEY}` }));
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
    expect(call.headers).toEqual(verifyHeaders({ "x-api-key": PLAIN_KEY, "anthropic-version": "2023-06-01" }));
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
    expect(call.headers).toEqual(verifyHeaders({ "x-goog-api-key": PLAIN_KEY }));
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
    expect(call.method).toBe("GET");
    expect(call.headers).toEqual(verifyHeaders({ authorization: `Bearer ${PLAIN_KEY}` }));
  });

  test("kilo / umans verify on their PUBLIC models list (no inference) — a 2xx parses the list", async () => {
    for (const [provider, url] of [
      ["kilo", "https://api.kilo.ai/api/gateway/models"],
      ["umans", "https://api.code.umans.ai/v1/models"],
    ] as const) {
      const calls: FetchCall[] = [];
      const result = await verifyProviderKey(
        { fetch: mockFetch(json(200, { data: [{ id: "m-1" }] }), calls) },
        provider,
        PLAIN_KEY,
      );
      expect(result, provider).toEqual({ ok: true, models: ["m-1"] });
      expect(calls, provider).toHaveLength(1);
      expect(calls[0]!.url, provider).toBe(url);
      expect(calls[0]!.method, provider).toBe("GET");
      expect(calls[0]!.headers, provider).toEqual(verifyHeaders({ authorization: `Bearer ${PLAIN_KEY}` }));
      // Public list: a 401 there is impossible, so the probe proves
      // reachability only — the store records the weaker state.
      expect(builtinProbeCanRejectKey(provider), provider).toBe(false);
    }
  });

  test("zai: Bearer GET /api/paas/v4/models — a measured 401 is invalid_key, never unsupported", async () => {
    const calls: FetchCall[] = [];
    const result = await verifyProviderKey({ fetch: mockFetch(json(401, { error: { code: "1000" } }), calls) }, "zai", "bogus");
    expect(result).toEqual({ ok: false, reason: "invalid_key" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.z.ai/api/paas/v4/models");
    expect(call.method).toBe("GET");
    expect(call.headers).toEqual(verifyHeaders({ authorization: "Bearer bogus" }));
    // Measured, not documented: only 401/403 reads as a rejected key.
    expect(await verifyProviderKey({ fetch: mockFetch(json(500, {})) }, "zai", "bogus")).toEqual({
      ok: false,
      reason: "unexpected_response",
    });
    expect(await verifyProviderKey({ fetch: mockFetch(json(200, { data: [{ id: "glm-4.6" }] })) }, "zai", "bogus")).toEqual({
      ok: true,
      models: ["glm-4.6"],
    });
    expect(builtinProbeCanRejectKey("zai")).toBe(true);
  });

  test("a cross-origin redirect is unexpected_response on all three verify paths", async () => {
    const crossOrigin = (url: string) => mockFetch(redirected(json(200, { data: [{ id: "m-1" }] }), url));
    // models endpoint
    expect(
      await verifyProviderKey({ fetch: crossOrigin("https://evil.example/v1/models") }, "openai", PLAIN_KEY),
    ).toEqual({ ok: false, reason: "unexpected_response" });
    // identity probe
    expect(
      await verifyProviderKey({ fetch: crossOrigin("https://evil.example/user") }, "copilot", PLAIN_KEY),
    ).toEqual({ ok: false, reason: "unexpected_response" });
    // custom-provider probe
    expect(
      await verifyProviderKey({ fetch: crossOrigin("https://evil.example/v1/models") }, "my-custom", PLAIN_KEY, {
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        modelIds: ["m1"],
      }),
    ).toEqual({ ok: false, reason: "unexpected_response" });
  });

  test("a same-origin redirect keeps the ordinary decision", async () => {
    const ok = redirected(json(200, { data: [{ id: "m-1" }] }), "https://api.openai.com/v1/models");
    expect(await verifyProviderKey({ fetch: mockFetch(ok) }, "openai", PLAIN_KEY)).toEqual({ ok: true, models: ["m-1"] });
    const rejected = redirected(json(401, {}), "https://api.openai.com/v1/models");
    expect(await verifyProviderKey({ fetch: mockFetch(rejected) }, "openai", PLAIN_KEY)).toEqual({
      ok: false,
      reason: "invalid_key",
    });
  });

  test("openrouter verifies on its PUBLIC model list — the chain dropdown needs it — and records reachable", async () => {
    const calls: FetchCall[] = [];
    const result = await verifyProviderKey(
      { fetch: mockFetch(json(200, { data: [{ id: "openai/gpt-5" }, { id: "anthropic/claude-4" }] }), calls) },
      "openrouter",
      PLAIN_KEY,
    );
    // Models ARE cached: /api/v1/auth/key would answer account data instead,
    // leaving the cache empty and the model picker with nothing to offer.
    expect(result).toEqual({ ok: true, models: ["openai/gpt-5", "anthropic/claude-4"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/models");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers).toEqual(verifyHeaders({ authorization: `Bearer ${PLAIN_KEY}` }));
    // The public catalog answers 200 for ANY bearer, so the store records the
    // weaker reachable state — never ok.
    expect(builtinProbeCanRejectKey("openrouter")).toBe(false);
  });

  test("openrouter: 401/403 on the model list is invalid_key (a bogus key never reads as ok)", async () => {
    for (const status of [401, 403]) {
      const result = await verifyProviderKey(
        { fetch: mockFetch(json(status, { error: { message: "No auth credentials found" } })) },
        "openrouter",
        PLAIN_KEY,
      );
      expect(result, String(status)).toEqual({ ok: false, reason: "invalid_key" });
    }
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
    expect(call.headers).toEqual(verifyHeaders({ authorization: `Bearer ${PLAIN_KEY}` }));
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

// --- fetch binding contract ---

describe("deps.fetch binding (workerd `Illegal invocation` regression)", () => {
  /** The runtime shape that broke production: a native fetch that refuses a
   *  receiver other than the global, exactly like workerd's. */
  const strictGlobalFetch = function (this: unknown) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(json(200, { data: [{ id: "gpt-5" }] }));
  };

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("verifyFetch keeps the global receiver: the built-in models spec verifies ok", async () => {
    globalThis.fetch = strictGlobalFetch as unknown as typeof fetch;
    const result = await verifyProviderKey({ fetch: verifyFetch }, "openai", PLAIN_KEY);
    expect(result).toEqual({ ok: true, models: ["gpt-5"] });
  });

  test("a dereferenced global fetch is the bug: the same deps shape fails as unreachable", async () => {
    globalThis.fetch = strictGlobalFetch as unknown as typeof fetch;
    // `deps.fetch(...)` calls the stored reference with `this = deps` — the
    // dereference every verify call site used to pass.
    const result = await verifyProviderKey({ fetch: globalThis.fetch }, "openai", PLAIN_KEY);
    expect(result).toEqual({ ok: false, reason: "unreachable" });
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
    expect(call.method).toBe("GET");
    expect(call.headers).toEqual(verifyHeaders({ authorization: `Bearer ${PLAIN_KEY}` }));
  });

  // Every documented base-URL shape resolves to EXACTLY one well-formed
  // models URL — the string-concatenation defects (a doubled `/models`, a
  // query/fragment riding the probe) are gone.
  test("base-URL shapes resolve to exactly one models URL (query and fragment never ride the probe)", async () => {
    const cases: Array<[string, string]> = [
      ["https://custom.example.com", "https://custom.example.com/v1/models"],
      ["https://custom.example.com/", "https://custom.example.com/v1/models"],
      ["https://custom.example.com/v1", "https://custom.example.com/v1/models"],
      ["https://custom.example.com/v1/", "https://custom.example.com/v1/models"],
      ["https://custom.example.com/v1/models", "https://custom.example.com/v1/models"],
      ["https://custom.example.com/v1/models/", "https://custom.example.com/v1/models"],
      ["https://custom.example.com/v1?x=1", "https://custom.example.com/v1/models"],
      ["https://custom.example.com/v1#frag", "https://custom.example.com/v1/models"],
      ["https://custom.example.com/#frag", "https://custom.example.com/v1/models"],
      ["https://custom.example.com/api/proxy/v1", "https://custom.example.com/api/proxy/v1/models"],
      ["https://api.typesafe.ai", "https://api.typesafe.ai/v1/models"],
      ["https://API.TYPESAFE.AI/v1/", "https://api.typesafe.ai/v1/models"],
    ];
    for (const [baseUrl, expected] of cases) {
      const calls: FetchCall[] = [];
      await verifyProviderKey(
        { fetch: mockFetch(json(200, { data: [] }), calls) },
        "custom",
        PLAIN_KEY,
        { ...CUSTOM, baseUrl },
      );
      expect(calls[0]!.url, baseUrl).toBe(expected);
    }
  });

  test("an unparseable base URL is unreachable — never a throw, never a request", async () => {
    for (const baseUrl of ["not a url", "//missing-scheme.example.com/v1", ""]) {
      const calls: FetchCall[] = [];
      const result = await verifyProviderKey(
        { fetch: mockFetch(json(200, { data: [] }), calls) },
        "custom",
        PLAIN_KEY,
        { ...CUSTOM, baseUrl },
      );
      expect(result, baseUrl).toEqual({ ok: false, reason: "unreachable" });
      expect(calls, baseUrl).toHaveLength(0);
    }
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
    expect(calls[0]!.headers).toEqual(verifyHeaders({ "x-api-key": PLAIN_KEY, "anthropic-version": "2023-06-01" }));
  });

  test("typesafe custom provider uses the OpenAI-shaped Bearer probe on {baseUrl}/v1/models", async () => {
    const calls: FetchCall[] = [];
    const result = await verifyProviderKey(
      { fetch: mockFetch(json(200, { data: [{ id: "jev-latest" }] }), calls) },
      "custom",
      PLAIN_KEY,
      { ...CUSTOM, api: "typesafe" },
    );
    expect(result).toEqual({ ok: true, models: CUSTOM.modelIds });
    expect(calls[0]!.url).toBe("https://custom.example.com/v1/models");
    expect(calls[0]!.headers).toEqual(verifyHeaders({ authorization: `Bearer ${PLAIN_KEY}` }));
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
      `app_provider_keys.key_enc:${app.id}:anthropic:${keyRow.key_id!}`,
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

  test("addProviderKey overwriting a verified row resets verified_* to NULL (verification belongs to the (provider, key) pair)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "overwrite-app");
    const store = configStore(db);
    await store.saveVerifiedKey(app.id, "openai", PLAIN_KEY, ["gpt-5"]);
    let row = db.raw
      .query("SELECT verified_at, verified_status FROM app_provider_keys WHERE app_id = ?")
      .get(app.id) as { verified_at: string | null; verified_status: string | null };
    expect(row.verified_status).toBe("ok");
    // The SAME key re-submitted on the unverified path collapses onto its own
    // pool row (a re-submission, not a second slot) and must reset the
    // verified bookkeeping.
    await store.addProviderKey(app.id, "openai", PLAIN_KEY);
    const after = db.raw
      .query("SELECT verified_at, verified_status, key_enc, key_id FROM app_provider_keys WHERE app_id = ?")
      .get(app.id) as { verified_at: string | null; verified_status: string | null; key_enc: string; key_id: string };
    expect(after.verified_at).toBeNull();
    expect(after.verified_status).toBeNull();
    // The unverified overwrite replaced the verified envelope (AAD round-trip).
    await expect(
      createSecretbox(TEST_KEY).decryptSecret(after.key_enc, `app_provider_keys.key_enc:${app.id}:openai:${after.key_id}`),
    ).resolves.toBe(PLAIN_KEY);
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
    // Re-saving the SAME key upserts its row in place (no duplicate slot) and
    // refreshes the provider's cached model list.
    await store.saveVerifiedKey(app.id, "openai", PLAIN_KEY, ["gpt-5", "gpt-5-mini"]);

    const keyCount = db.raw.query("SELECT COUNT(*) AS n FROM app_provider_keys WHERE app_id = ?").get(app.id) as { n: number };
    const cacheCount = db.raw
      .query("SELECT COUNT(*) AS n FROM app_provider_models WHERE app_id = ?")
      .get(app.id) as { n: number };
    expect(keyCount.n).toBe(1);
    expect(cacheCount.n).toBe(1);
    const cached = await store.getVerifiedModels(app.id);
    expect(cached).toHaveLength(1);
    expect(cached[0]!.models).toEqual(["gpt-5", "gpt-5-mini"]);
    // The row carries the same key envelope (decryptable only with the AAD).
    const row = db.raw.query("SELECT key_enc, key_id FROM app_provider_keys WHERE app_id = ?").get(app.id) as {
      key_enc: string;
      key_id: string;
    };
    await expect(
      createSecretbox(TEST_KEY).decryptSecret(row.key_enc, `app_provider_keys.key_enc:${app.id}:openai:${row.key_id}`),
    ).resolves.toBe(PLAIN_KEY);
  });

  test("a builtin whose probe cannot reject a bogus key stamps 'reachable' — never 'ok'", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "public-builtin-app");
    const store = configStore(db);
    // Kilo's model list is public (200 for a bogus bearer), so the 2xx proved
    // the ENDPOINT answered; the key itself is unproven.
    await store.saveVerifiedKey(app.id, "kilo", PLAIN_KEY, ["kilo-auto/efficient"]);
    const row = db.raw
      .query("SELECT verified_at, verified_status FROM app_provider_keys WHERE app_id = ?")
      .get(app.id) as { verified_at: string | null; verified_status: string | null };
    expect(row.verified_at).toMatch(SQLITE_TS_RE);
    expect(row.verified_status).toBe("reachable");
    // The model evidence is still recorded: the probe DID read the list.
    expect(await store.getVerifiedModels(app.id)).toEqual([
      { provider: "kilo", models: ["kilo-auto/efficient"], fetched_at: expect.stringMatching(SQLITE_TS_RE) },
    ]);
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

  test("addProviderKey writes unverified rows (NULL verified columns)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "legacy-write-app");
    const store = configStore(db);
    await store.addProviderKey(app.id, "xai", PLAIN_KEY);
    const row = db.raw
      .query("SELECT verified_at, verified_status FROM app_provider_keys WHERE app_id = ?")
      .get(app.id) as { verified_at: string | null; verified_status: string | null };
    expect(row.verified_at).toBeNull();
    expect(row.verified_status).toBeNull();
    // The read faces work over the 0015 shape: the masked list carries the
    // derived pool id, the tail and the update stamp — never key material.
    const masked = await store.listProviderKeys(app.id);
    expect(masked).toEqual([
      {
        provider: "xai",
        keyId: expect.stringMatching(/^[0-9a-f]{16}$/),
        last4: "1234",
        updatedAt: expect.stringMatching(SQLITE_TS_RE),
        verifiedAt: null,
        verifiedStatus: null,
      },
    ]);
    const appConfig = await store.getAppConfig(app.id);
    expect(appConfig.keys.xai).toEqual([PLAIN_KEY]);
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
      {
        provider_id: "my-custom",
        base_url: "https://example.com/v1",
        api: "openai-completions",
        model_ids: ["m1"],
        has_keys: true,
      },
    ]);
    // Custom providers never write app_provider_models rows (spec §6.1).
    expect(await store.getVerifiedModels(app.id)).toEqual([]);
  });

  test("VERIFY_TIMEOUT_MS is 10s and the default deps path uses it", () => {
    expect(VERIFY_TIMEOUT_MS).toBe(10_000);
  });

  test("a declaration on an unproven host stamps 'reachable', never 'ok'", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "public-probe-app");
    const store = configStore(db);
    // Command Code's models endpoint answers 2xx with no valid credential, so
    // nothing there proves the key. Both of its catalog rows
    // (openai-responses and anthropic-messages) share that host.
    for (const decl of [
      { provider_id: "commandcode", base_url: "https://api.commandcode.ai/provider/v1", api: "openai-responses" as const },
      { provider_id: "commandcode-anthropic", base_url: "https://api.commandcode.ai/provider", api: "anthropic-messages" as const },
    ]) {
      const verified = await verifyProviderKey({ fetch: mockFetch(json(200, { data: [] })) }, decl.provider_id, PLAIN_KEY, {
        baseUrl: decl.base_url,
        api: decl.api,
        modelIds: ["m1"],
      });
      expect(verified.ok).toBe(true);
      await store.upsertCustomProvider(app.id, { ...decl, model_ids: ["m1"] }, PLAIN_KEY);
    }
    const rows = db.raw
      .query("SELECT provider, verified_at, verified_status FROM app_custom_provider_keys WHERE app_id = ? ORDER BY provider")
      .all(app.id) as Array<{ provider: string; verified_at: string | null; verified_status: string | null }>;
    expect(rows).toEqual([
      { provider: "commandcode", verified_at: expect.stringMatching(SQLITE_TS_RE), verified_status: "reachable" },
      { provider: "commandcode-anthropic", verified_at: expect.stringMatching(SQLITE_TS_RE), verified_status: "reachable" },
    ]);
    // The settings faces carry that weaker state, so the SPA never renders it
    // as "verified at …".
    expect((await store.listCustomProviderKeys(app.id)).map((row) => row.verifiedStatus)).toEqual([
      "reachable",
      "reachable",
    ]);
  });

  test("the probe-rejectability allow-list never matches an Object prototype key", () => {
    // A declaration may name any https host; these must stay unproven rather
    // than inherit a prototype member as if it were an allow-list entry.
    for (const host of ["constructor", "toString", "__proto__"]) {
      expect(customProbeCanRejectKey(`https://${host}/v1`)).toBe(false);
    }
    expect(customProbeCanRejectKey("https://api.typesafe.ai")).toBe(true);
    // Unparseable input is unproven too (the store refuses such a URL first).
    expect(customProbeCanRejectKey("not a url")).toBe(false);
  });

  test("the allow-list matches the PROBED URL, not the host: only shapes deriving /v1/models qualify", () => {
    // Evidence for api.typesafe.ai names GET /v1/models exactly, and
    // customModelsUrl normalizes whatever the declaration carries into one
    // well-formed models URL (its query/fragment is dropped, so it cannot send
    // the key anywhere else).
    for (const baseUrl of [
      "https://api.typesafe.ai",
      "https://api.typesafe.ai/",
      "https://api.typesafe.ai/v1",
      "https://api.typesafe.ai/v1/",
      "https://API.TYPESAFE.AI/v1",
      "https://api.typesafe.ai/#x",
      "https://api.typesafe.ai/v1?x=1",
    ]) {
      expect(customProbeCanRejectKey(baseUrl), baseUrl).toBe(true);
    }
    // Same host, a different PATH → the probe lands elsewhere → unproven.
    for (const baseUrl of [
      "https://api.typesafe.ai/console",
      "https://api.typesafe.ai/v1/keys",
      "https://api.typesafe.ai:8443/v1",
      "http://api.typesafe.ai",
    ]) {
      expect(customProbeCanRejectKey(baseUrl), baseUrl).toBe(false);
    }
  });

  test("an unknown host records 'reachable' — a 2xx there cannot prove the key", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "auth-probe-app");
    const store = configStore(db);
    // Nothing in this repo proves that an arbitrary operator-declared host
    // rejects a bogus key, so the probe only proved the ENDPOINT answered.
    await store.upsertCustomProvider(
      app.id,
      { provider_id: "my-custom", base_url: "https://example.com/v1", api: "openai-completions", model_ids: ["m1"] },
      PLAIN_KEY,
    );
    const row = db.raw
      .query("SELECT verified_status FROM app_custom_provider_keys WHERE app_id = ?")
      .get(app.id) as { verified_status: string | null };
    expect(row.verified_status).toBe("reachable");
  });

  test("an allow-listed key-rejecting host still records 'ok' (api.typesafe.ai answers 401/403 for a bogus key)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db, "allow-listed-probe-app");
    const store = configStore(db);
    // omp's auth rule validates GET https://api.typesafe.ai/v1/models — the
    // exact path the custom probe hits — so a 2xx there IS proof of the key.
    await store.upsertCustomProvider(
      app.id,
      { provider_id: "typesafe", base_url: "https://api.typesafe.ai", api: "typesafe", model_ids: ["jev-latest"] },
      PLAIN_KEY,
    );
    const row = db.raw
      .query("SELECT verified_status FROM app_custom_provider_keys WHERE app_id = ?")
      .get(app.id) as { verified_status: string | null };
    expect(row.verified_status).toBe("ok");
  });
});
