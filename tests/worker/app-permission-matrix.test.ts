/**
 * Plan 35 T1b: the App write-route permission matrix (spec §2 权限矩阵).
 *
 * The T1b audit confirmed every App write route — config (settings family:
 * add-key / save-chain / save-roles / add-custom-provider /
 * add-template-provider / remove-custom-provider / key/delete / keys/verify,
 * plus the plan 35 T2/T3 chain ops add-chain / remove-chain) and ops
 * (pause / resume / disable / enable / delete) — funnels through the SAME
 * creator-or-admin gate (`canManageApp`, src/dashboard/index.ts:947-949;
 * SPA mirror src/spa/pages/data.ts:84-86). This file locks that matrix as
 * ONE systematic sweep: creator / admin / other / other-creator × every
 * write route → 200/403, with zero mutation and zero outbound network on
 * every deny path (the guard fires before any validation or store write).
 *
 * The 200-side of the network-verifying routes (add-key / add-custom-provider
 * / add-template-provider / keys/verify) is stubbed exactly like the
 * existing per-route tests (app-config.test.ts /
 * settings-provider-first.test.ts); the deny side asserts fetch is NEVER
 * called.
 */
import { describe, expect, spyOn, test } from "bun:test";
import worker from "../../src/worker/index";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";

const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const PLAIN_KEY = "sk-ant-matrix-9988";

const SETTINGS = "/dashboard/apps/mallorys-app/settings";
const VERIFY = "/dashboard/api/apps/mallorys-app/keys/verify";

/**
 * Seeded world (spec §2 actors): octocat = admin; mallory owns
 * "mallorys-app" (creator); ada owns a DIFFERENT app (other-creator);
 * hubot owns none (other member).
 */
async function seededWorld(): Promise<TestD1> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "ada", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  await createAppsStore(db).createApp({
    id,
    slug: "mallorys-app",
    githubAppId: 1001,
    name: "mallorys-app",
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
  });
  return db;
}

function makeEnv(db: unknown): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
  } as Env;
}

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
        Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    }),
    env,
  );
}

function appStatus(db: TestD1, slug: string): string | null {
  const row = db.raw.query("SELECT status FROM github_apps WHERE slug = ?").get(slug) as {
    status: string;
  } | null;
  return row?.status ?? null;
}

function reviewEnabled(db: TestD1, slug: string): number | null {
  const row = db.raw.query("SELECT review_enabled FROM github_apps WHERE slug = ?").get(slug) as {
    review_enabled: number;
  } | null;
  return row?.review_enabled ?? null;
}

function rawCount(db: TestD1, table: string): number {
  const row = db.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

type MatrixRoute = {
  name: string;
  path: string;
  fields?: Record<string, string>;
  /** routes whose 200 side performs an outbound provider verification */
  verifies?: boolean;
};

/**
 * Every App write route, in an order that keeps each 200-side mutation valid
 * for the allowed actors (delete soft-deletes, so it runs LAST).
 */
const MATRIX_ROUTES: MatrixRoute[] = [
  // --- edit family: settings POST (config) ---
  { name: "settings add-key", path: SETTINGS, fields: { op: "add-key", provider: "anthropic", key: PLAIN_KEY }, verifies: true },
  { name: "settings save-chain (clear)", path: SETTINGS, fields: { op: "save-chain", model_chain: "" } },
  // QC wave (F-002): save-roles is a FULL-map save — every seat key is
  // required (blanks = default chain), so the matrix must post all four.
  {
    name: "settings save-roles (clear)",
    path: SETTINGS,
    fields: {
      op: "save-roles",
      "role_mstar-review-seat": "",
      "role_code-reviewer": "",
      "role_fullstack-dev": "",
      "role_frontend-dev": "",
    },
  },
  // Plan 35 T2/T3 ops (QC wave, seat1): add-chain must also exercise the
  // route's membership layer, so its selector names an unverified provider
  // (syntax-only check passes); remove-chain then removes it again so the
  // sweep's later routes see a clean chain table.
  { name: "settings add-chain", path: SETTINGS, fields: { op: "add-chain", name: "matrix", chain: "matrix-7b/good" } },
  { name: "settings remove-chain", path: SETTINGS, fields: { op: "remove-chain", name: "matrix" } },
  {
    name: "settings add-custom-provider",
    path: SETTINGS,
    fields: {
      op: "add-custom-provider",
      provider_id: "matrix-custom",
      base_url: "https://matrix.example.com/v1",
      api: "openai-completions",
      model_ids: "matrix-7b",
      key: PLAIN_KEY,
    },
    verifies: true,
  },
  {
    name: "settings add-template-provider",
    path: SETTINGS,
    fields: { op: "add-template-provider", template_id: "workers-ai", account_id: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", key: PLAIN_KEY },
    verifies: true,
  },
  { name: "settings remove-custom-provider", path: SETTINGS, fields: { op: "remove-custom-provider", provider_id: "nope" } },
  { name: "settings key/delete", path: `${SETTINGS}/key/delete`, fields: { provider: "anthropic" } },
  { name: "keys/verify", path: VERIFY, fields: { provider: "anthropic", key: PLAIN_KEY }, verifies: true },
  // --- ops family: pinned action paths ---
  { name: "pause", path: "/dashboard/apps/mallorys-app/pause" },
  { name: "resume", path: "/dashboard/apps/mallorys-app/resume" },
  { name: "disable", path: "/dashboard/apps/mallorys-app/disable" },
  { name: "enable", path: "/dashboard/apps/mallorys-app/enable" },
  { name: "delete", path: "/dashboard/apps/mallorys-app/delete" },
];

const ACTORS = [
  { name: "creator", login: "mallory", expected: 200 },
  { name: "admin (non-creator)", login: "octocat", expected: 200 },
  { name: "other member", login: "hubot", expected: 403 },
  { name: "creator of a different app", login: "ada", expected: 403 },
] as const;

describe("App write-route permission matrix (plan 35 T1b, spec §2)", () => {
  for (const actor of ACTORS) {
    test(`matrix: ${actor.name} (${actor.login}) × every App write route → ${actor.expected}`, async () => {
      const db = await seededWorld();
      const env = makeEnv(db);
      const allowed = actor.expected === 200;
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        (async () => {
          if (!allowed) {
            // The deny path must short-circuit BEFORE any outbound call —
            // the guard fires before validation, verification, or writes.
            throw new Error(`deny path (${actor.login}) must never call fetch`);
          }
          // Models-list shape for built-in verify; any 2xx for the custom
          // probe (its body is never scraped — models = declared model_ids).
          return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as unknown as typeof fetch,
      );
      try {
        for (const route of MATRIX_ROUTES) {
          const res = await postForm(route.path, actor.login, env, route.fields ?? {});
          expect(res.status, `${actor.name} × ${route.name}`).toBe(actor.expected);
        }
      } finally {
        fetchSpy.mockRestore();
      }
      if (!allowed) {
        // Zero mutation on every deny path: the app row is untouched and no
        // config table gained a row.
        expect(appStatus(db, "mallorys-app")).toBe("active");
        expect(reviewEnabled(db, "mallorys-app")).toBe(1);
        expect(rawCount(db, "app_provider_keys")).toBe(0);
        expect(rawCount(db, "app_provider_models")).toBe(0);
        expect(rawCount(db, "app_model_config")).toBe(0);
        expect(rawCount(db, "app_model_chains")).toBe(0);
        expect(rawCount(db, "app_model_chain_seats")).toBe(0);
        expect(rawCount(db, "app_custom_providers")).toBe(0);
      }
    });
  }
});
