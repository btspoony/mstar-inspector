/**
 * Plan 45 T4: the settings POST family's plain-text 400s carry a
 * machine-readable key — the SPA gets JSON `{ key, message, params? }`
 * (`message` keeps the English face, `params` replays the interpolation in
 * the operator's locale), native form posts keep the plan-29 302, and the
 * CARRY-2 verify-route eligibility rejection gains the same keyed face with
 * no new reason value. Static-key bodies carry no `params` field.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "../store/helpers";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import worker from "../../src/worker/index";
import { sk, OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const SETTINGS = "/dashboard/apps/mallorys-app/settings";
const VERIFY = "/dashboard/api/apps/mallorys-app/keys/verify";
const ACCOUNT_ID = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

async function seededWorld() {
  const db = createMigratedTestD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
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

function rawRun(db: ReturnType<typeof createMigratedTestD1>, sql: string, ...params: (string | number | null)[]): void {
  db.raw.prepare(sql).run(...params);
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

describe("settings 400 key transport (plan 45 T4)", () => {
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
      key: "settings.error.providerUnavailableOnImage",
      message:
        "anthropic is not available under this App's selected runtime image (legacy-runtime) — nothing was stored.",
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

  test("add-template-provider missing Cloudflare account id (plan-42 slot) → keyed JSON", async () => {
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
      key: "settings.error.sandboxImageUnknown",
      message: "Unknown or disabled sandbox image — nothing was stored.",
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

  test("native HTML form post keeps the plan-29 302 — the keyed body is never seen", async () => {
    const { db } = await seededWorld();
    const res = await postForm(
      SETTINGS,
      "mallory",
      makeEnv(db),
      { op: "add-key", provider: "not-a-provider", key: sk("whatever") },
      { Accept: "text/html" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/apps/mallorys-app/settings");
  });
});

describe("CARRY-2: verify-route eligibility rejection gains the keyed face (plan 45 T4)", () => {
  test("/keys/verify precheck → same key as the settings POST family, reason unchanged", async () => {
    const { db, app } = await seededWorld();
    rawRun(db, "UPDATE github_apps SET sandbox_image_id = 'legacy-runtime' WHERE id = ?", app.id);
    const res = await postForm(VERIFY, "mallory", makeEnv(db), { provider: "anthropic", key: sk("ant-123") });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "unsupported_provider",
      key: "settings.error.providerUnavailableOnImage",
      message:
        "anthropic is not available under this App's selected runtime image (legacy-runtime) — nothing was stored.",
      params: { provider: "anthropic", image: "legacy-runtime" },
    });
  });
});
