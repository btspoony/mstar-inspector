/**
 * The settings POST family's plain-text 400s carry a
 * machine-readable key — the SPA gets JSON `{ key, message, params? }`
 * (`message` keeps the English face, `params` replays the interpolation in
 * the operator's locale), native form posts keep the legacy 302, and the
 * CARRY-2 verify-route eligibility rejection gains the same keyed face with
 * no new reason value. Static-key bodies carry no `params` field.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { createMigratedTestD1, seedDefaultMemberships, type TestD1 } from "../store/helpers";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import worker from "../../src/worker/index";
import { sk, OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
/** The App's immutable GitHub App id — the only App address form (D0). */
const APP_ID = 1001;
const SETTINGS = `/dashboard/default/apps/${APP_ID}/settings`;
const VERIFY = `/dashboard/default/api/apps/${APP_ID}/keys/verify`;
const ACCOUNT_ID = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

async function seededWorld(malloryRole: "owner" | "member" = "owner") {
  const db = createMigratedTestD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  seedDefaultMemberships(db, { octocat: "owner", mallory: malloryRole });
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  const app = await createAppsStore(db).createApp({
    id,
    githubSlug: "mallorys-app",
    githubAppId: APP_ID,
    name: "mallorys-app",
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
    workspaceId: "default",
  });
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

function rawRun(db: ReturnType<typeof createMigratedTestD1>, sql: string, ...params: (string | number | null)[]): void {
  db.raw.prepare(sql).run(...params);
}

/** Row count of one table — the zero-writes assertion after a refused request. */
function rawCount(db: ReturnType<typeof createMigratedTestD1>, table: string): number {
  const row = db.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

async function postForm(
  path: string,
  login: string,
  env: Env,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local${path}`, {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(fields),
    }),
    env,
  );
}

/** GET helper for the settings JSON face (the read side of the depth control). */
async function getJson(path: string, login: string, env: Env): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local${path}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}` },
    }),
    env,
  );
}

describe("settings 400 key transport", () => {
  test("add-key unknown provider → keyed JSON with the English face and params", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-key",
      provider: "not-a-provider",
      key: sk("whatever"),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.providerUnknown",
      message: "not-a-provider is not a supported provider — pick one from the list.",
      params: { provider: "not-a-provider" },
    });
  });

  test("add-key eligibility precheck (non-omp image) → keyed JSON naming provider + image", async () => {
    const { db, app } = await seededWorld();
    rawRun(db, "UPDATE github_apps SET sandbox_image_id = 'legacy-runtime' WHERE id = ?", app.id);
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: sk("ant-123"),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.providerUnavailableOnHarness",
      message:
        "anthropic is not available under this App's selected runtime harness (legacy-runtime) — nothing was stored.",
      params: { provider: "anthropic", image: "legacy-runtime" },
    });
  });

  test("save-roles partial map → plural missing-seats key with the roles param", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "save-roles",
      "role_code-reviewer": "",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.roleFieldsMissing",
      message:
        "The mstar-review-seat, fullstack-dev, frontend-dev role fields are missing — the Role models form always saves every seat (blank = default chain). Nothing was saved.",
      params: { roles: "mstar-review-seat, fullstack-dev, frontend-dev" },
    });
  });

  test("add-chain bad name grammar → keyed JSON with the bound param", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-chain",
      name: "Not A Chain",
      chain: "anthropic/claude-sonnet-4-6",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.chainNameInvalid",
      message:
        'Chain names must be 1–64 lowercase letters, digits or hyphens — and "default" is reserved. Nothing was saved.',
      params: { limit: 64 },
    });
  });

  test("remove-chain reserved default → static keyed JSON with no params field", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), { op: "remove-chain", name: "default" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.defaultChainRemoveProtected",
      message: 'The "default" chain cannot be removed — clear it instead. Nothing was saved.',
    });
  });

  test("add-custom-provider builtin collision → keyed JSON naming the id", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-custom-provider",
      provider_id: "anthropic",
      base_url: "https://example.com/v1",
      api: "openai-completions",
      model_ids: "local-7b",
      key: sk("custom-123"),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.providerIdBuiltin",
      message: "anthropic is a built-in provider — custom providers must use a new id. Nothing was stored.",
      params: { provider: "anthropic" },
    });
  });

  test("add-template-provider missing Cloudflare account id (the Cloudflare slot) → keyed JSON", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-template-provider",
      template_id: "workers-ai",
      key: sk("cf-123"),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.accountIdRequired",
      message: "Enter your Cloudflare account id to complete the Workers AI base URL.",
    });
  });

  test("save-sandbox-image unknown id → keyed JSON", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "save-sandbox-image",
      sandbox_image_id: "not-an-image",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.runtimeHarnessUnknown",
      message: "Unknown or disabled runtime harness — nothing was stored.",
    });
  });

  test("review-trigger-mode invalid value → keyed JSON naming the rejected mode", async () => {
    const { db } = await seededWorld();
    const res = await postForm(`/dashboard/default/apps/${APP_ID}/review-trigger-mode`, "mallory", makeEnv(db), {
      mode: "whenever",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.triggerModeUnknown",
      message: "whenever is not a review trigger mode — use open, every_push, or manual. Nothing was stored.",
      params: { mode: "whenever" },
    });
  });

  test("unknown op → keyed JSON", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), { op: "not-an-op" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.unknownOperation",
      message: "Unknown settings operation — resubmit one of this page's forms.",
    });
  });

  test("native HTML form post keeps the legacy 302 — the keyed body is never seen", async () => {
    const { db } = await seededWorld();
    const res = await postForm(
      SETTINGS,
      "mallory",
      makeEnv(db),
      { op: "add-key", provider: "not-a-provider", key: sk("whatever") },
      { Accept: "text/html" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/dashboard/default/apps/${APP_ID}/settings`);
  });
});

describe("F1: a `!`-prefixed key is refused where the operator types it", () => {
  // The review runtime's credential store is resolved through the SDK's
  // config-value resolver, which RUNS any `!`-prefixed value as a shell
  // command. The runner's payload decoder refuses the shape fail-closed; these
  // pin the dashboard-side refusal so the operator sees the cause on the form
  // instead of getting a failed review run later. Zero writes on every path.
  const COMMAND_KEY = "!touch /tmp/pwned";

  test("add-key → keyed 400, zero writes", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: COMMAND_KEY,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.apiKeyCommandPrefix",
      message:
        'That API key starts with "!" — the review runtime would run it as a shell command, so keys of that shape are refused. Nothing was stored.',
    });
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });

  test("keys/verify → keyed 400 on the closed reason enum, zero writes", async () => {
    const { db } = await seededWorld();
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: COMMAND_KEY });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "unexpected",
      key: "settings.error.apiKeyCommandPrefix",
      message:
        'That API key starts with "!" — the review runtime would run it as a shell command, so keys of that shape are refused. Nothing was stored.',
    });
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });

  test("add-custom-provider and add-template-provider → keyed 400, zero writes", async () => {
    const { db } = await seededWorld();
    for (const fields of [
      {
        op: "add-custom-provider",
        provider_id: "my-custom",
        base_url: "https://example.com/v1",
        api: "openai-completions",
        model_ids: "local-7b",
        key: COMMAND_KEY,
      },
      { op: "add-template-provider", template_id: "subconscious", key: COMMAND_KEY },
    ] as Record<string, string>[]) {
      const res = await postForm(SETTINGS, "mallory", makeEnv(db), fields);
      expect(res.status, fields.op).toBe(400);
      expect(await res.json()).toEqual({
        key: "settings.error.apiKeyCommandPrefix",
        message:
          'That API key starts with "!" — the review runtime would run it as a shell command, so keys of that shape are refused. Nothing was stored.',
      });
    }
    expect(rawCount(db, "app_custom_providers")).toBe(0);
    expect(rawCount(db, "app_custom_provider_keys")).toBe(0);
  });

  test("a key that merely CONTAINS `!` still stores (only the leading prefix is the command shape)", async () => {
    const { db } = await seededWorld();
    // The refusal tests above never reach the network (the guard precedes the
    // probe); this one does, so stub the provider's model-list endpoint.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), { status: 200 })) as unknown as typeof fetch,
    );
    try {
      const res = await postForm(SETTINGS, "mallory", makeEnv(db), {
        op: "add-key",
        provider: "anthropic",
        key: sk("ant-mid!bang-1234"),
      });
      expect(res.status).toBe(200);
      expect(rawCount(db, "app_provider_keys")).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("verify route: a provider the App never declared", () => {
  test("an undeclared non-builtin id → keyed 400 customProviderUndeclared, zero writes, no probe", async () => {
    const { db } = await seededWorld();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch must not be called without a declaration");
    }) as unknown as typeof fetch);
    try {
      const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "opencode-go", key: sk("ant-123") });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        reason: "unexpected",
        key: "settings.error.customProviderUndeclared",
        message:
          "opencode-go is not a declared custom provider for this App — declare it before adding keys. Nothing was stored.",
        params: { provider: "opencode-go" },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(rawCount(db, "app_custom_providers")).toBe(0);
      expect(rawCount(db, "app_custom_provider_keys")).toBe(0);
      expect(rawCount(db, "app_provider_keys")).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("CARRY-2: verify-route eligibility rejection gains the keyed face", () => {
  test("/keys/verify precheck → same key as the settings POST family, reason unchanged", async () => {
    const { db, app } = await seededWorld();
    rawRun(db, "UPDATE github_apps SET sandbox_image_id = 'legacy-runtime' WHERE id = ?", app.id);
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: sk("ant-123") });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "unsupported_provider",
      key: "settings.error.providerUnavailableOnHarness",
      message:
        "anthropic is not available under this App's selected runtime harness (legacy-runtime) — nothing was stored.",
      params: { provider: "anthropic", image: "legacy-runtime" },
    });
  });
});

describe("verify route: a spent provider account keeps its own reason", () => {
  test("a provider quota refusal reaches the SPA as quota_exhausted, zero writes", async () => {
    const { db } = await seededWorld();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify({ error: { message: "insufficient credits" } }), { status: 402 })) as unknown as typeof fetch,
    );
    try {
      const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: sk("ant-123") });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, reason: "quota_exhausted" });
      expect(rawCount(db, "app_provider_keys")).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("review depth op (per-App review level)", () => {
  const SETTINGS_API = `/dashboard/default/api/apps/${APP_ID}/settings`;

  /** The operator-default depth leaf's exact statement, counted per request. */
  const DEFAULT_LEVEL_SQL = "SELECT value FROM review_runtime_settings WHERE key = ?";
  const countDefaultLevelReads = (db: TestD1): { db: TestD1; reads: () => number } => {
    let reads = 0;
    return {
      db: {
        ...db,
        prepare(sql: string) {
          if (sql.trim() === DEFAULT_LEVEL_SQL) reads++;
          return db.prepare(sql);
        },
      } as TestD1,
      reads: () => reads,
    };
  };

  /** The stored column — the zero-write / stored assertion. */
  const storedLevel = (db: TestD1, appId: string): string | null => {
    const row = db.raw.query("SELECT review_level FROM github_apps WHERE id = ?").get(appId) as {
      review_level: string | null;
    } | null;
    return row?.review_level ?? null;
  };

  test("off-vocabulary level → keyed 400 naming the value, zero writes", async () => {
    const { db, app } = await seededWorld();
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), { op: "save-review-level", level: "turbo" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      key: "settings.error.reviewLevelUnknown",
      message:
        "turbo is not a review depth — use quick, default, or deep (or inherit to follow the operator default). Nothing was stored.",
      params: { level: "turbo" },
    });
    expect(storedLevel(db, app.id)).toBeNull();
  });

  test("a level stores; the inherit face writes the column back to NULL", async () => {
    const { db, app } = await seededWorld();
    const stored = await postForm(SETTINGS, "mallory", makeEnv(db), { op: "save-review-level", level: "deep" });
    expect(stored.status).toBe(200);
    expect(storedLevel(db, app.id)).toBe("deep");
    const inherit = await postForm(SETTINGS, "mallory", makeEnv(db), { op: "save-review-level", level: "inherit" });
    expect(inherit.status).toBe(200);
    expect(storedLevel(db, app.id)).toBeNull();
  });

  test("native form navigation keeps the 302 back to the settings tab", async () => {
    const { db, app } = await seededWorld();
    const res = await postForm(
      SETTINGS,
      "mallory",
      makeEnv(db),
      { op: "save-review-level", level: "quick" },
      { Accept: "text/html" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/dashboard/default/apps/${APP_ID}/settings`);
    expect(storedLevel(db, app.id)).toBe("quick");
  });

  test("a plain member's save answers 403 and stores nothing", async () => {
    const { db, app } = await seededWorld("member");
    const res = await postForm(SETTINGS, "mallory", makeEnv(db), { op: "save-review-level", level: "deep" });
    expect(res.status).toBe(403);
    expect(storedLevel(db, app.id)).toBeNull();
  });

  test("the manager face carries review_level + the operator default; the member face carries neither", async () => {
    const { db } = await seededWorld("member");
    rawRun(
      db,
      "INSERT INTO review_runtime_settings (key, value, updated_at, updated_by) VALUES ('review.level.default', 'deep', '2026-01-01T00:00:00.000Z', 'octocat')",
    );
    const counted = countDefaultLevelReads(db);
    const manager = await getJson(SETTINGS_API, "octocat", makeEnv(counted.db));
    expect(manager.status).toBe(200);
    const managerBody = (await manager.json()) as { app: Record<string, unknown> };
    expect(managerBody.app.review_level).toBeNull();
    expect(managerBody.app.default_review_level).toBe("deep");
    // The manager face names the inherit target: exactly one operator-default read.
    expect(counted.reads()).toBe(1);

    const member = await getJson(SETTINGS_API, "mallory", makeEnv(counted.db));
    expect(member.status).toBe(200);
    const memberBody = (await member.json()) as { app: Record<string, unknown> };
    expect("review_level" in memberBody.app).toBe(false);
    expect("default_review_level" in memberBody.app).toBe(false);
    // The identity-only face renders no depth control, so it pays no settings read.
    expect(counted.reads()).toBe(1);
  });
});
