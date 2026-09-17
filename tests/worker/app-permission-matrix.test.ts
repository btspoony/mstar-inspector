/**
 * The App write-route permission matrix (spec §2 权限矩阵).
 *
 * The T1b audit confirmed every App write route — config (settings family:
 * add-key / save-chain / save-roles / add-custom-provider /
 * add-template-provider / remove-custom-provider / key/delete / keys/verify,
 * plus the chain ops add-chain / remove-chain) and ops
 * (pause / resume / disable / enable / delete) — funnels through the SAME
 * server-side creator-or-admin gate (`canManageApp`,
 * src/dashboard/index.ts:952-954). This file locks that matrix as
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
import { sk, OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const PLAIN_KEY = sk("ant-matrix-9988");

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
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
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
  // Chain ops (QC wave, seat1): add-chain must also exercise the
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

describe("App write-route permission matrix (T1b, spec §2)", () => {
  // Strength pin (F3–F8): before any per-actor gate can even
  // run, the mount-level membership guard bounces a session-less POST on
  // every App write route into the OAuth flow — 302 to login, and the
  // identical zero-mutation invariants as the member sweeps below.
  test("matrix: anonymous (no session) × every App write route → 302 login, zero mutations", async () => {
    const db = await seededWorld();
    const env = makeEnv(db);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => {
        // The guard fires before validation, verification, or writes — no
        // anonymous request may reach an outbound call.
        throw new Error("deny path (anonymous) must never call fetch");
      }) as unknown as typeof fetch,
    );
    try {
      for (const route of MATRIX_ROUTES) {
        const res = await worker.fetch(
          new Request(`https://worker.local${route.path}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(route.fields ?? {}),
          }),
          env,
        );
        expect(res.status, `anonymous × ${route.name}`).toBe(302);
        expect(res.headers.get("Location"), `anonymous × ${route.name}`).toBe("/dashboard/login");
      }
    } finally {
      fetchSpy.mockRestore();
    }
    expect(appStatus(db, "mallorys-app")).toBe("active");
    expect(reviewEnabled(db, "mallorys-app")).toBe(1);
    expect(rawCount(db, "app_provider_keys")).toBe(0);
    expect(rawCount(db, "app_provider_models")).toBe(0);
    expect(rawCount(db, "app_model_config")).toBe(0);
    expect(rawCount(db, "app_model_chains")).toBe(0);
    expect(rawCount(db, "app_model_chain_seats")).toBe(0);
    expect(rawCount(db, "app_custom_providers")).toBe(0);
  });

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

// --- Read-face matrix: GET /dashboard/api/apps/:slug/settings ---
// Identity-only non-manager detail face: a member who is neither creator nor
// admin gets the D4 identity set (the GET /api/apps list fields + created_at
// + the cached public GitHub profile) and can_manage:false — NO health or
// ops data (installations / deliveries / delivery_summary / last_webhook_at
// / sandbox_image_id / review_trigger_mode). The manager face keeps the
// full base+health payload unchanged. Read-only, so the status/shape
// assertions are the matrix itself.
describe("App detail read-face permission matrix (settings JSON)", () => {
  const FACE = "/dashboard/api/apps/mallorys-app/settings";

  async function getFace(login: string, env: Env): Promise<Response> {
    return worker.fetch(
      new Request(`https://worker.local${FACE}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}` },
      }),
      env,
    );
  }

  test("non-manager (other member) → exactly the identity-only payload", async () => {
    const res = await getFace("hubot", makeEnv(await seededWorld()));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as { can_manage: unknown; app: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(["app", "can_manage"]);
    expect(body.can_manage).toBe(false);
    expect(Object.keys(body.app).sort()).toEqual([
      "created_at",
      "created_by",
      "github_app_id",
      "github_avatar_url",
      "github_description",
      "github_html_url",
      "github_metadata_synced_at",
      "github_name",
      "review_enabled",
      "slug",
      "status",
    ]);
    expect(body.app.slug).toBe("mallorys-app");
    expect(body.app.github_app_id).toBe(1001);
    expect(body.app.created_by).toBe("mallory");
    expect(typeof body.app.created_at).toBe("string");
    // ops fields never ride the non-manager payload
    expect(JSON.stringify(body)).not.toContain("installations");
    expect(JSON.stringify(body)).not.toContain("deliveries");
    expect(JSON.stringify(body)).not.toContain("sandbox_image_id");
    expect(JSON.stringify(body)).not.toContain("review_trigger_mode");
    expect(JSON.stringify(body)).not.toContain("last_webhook_at");
    expect(JSON.stringify(body)).not.toContain("private_key_enc");
  });

  for (const actor of [ACTORS[0], ACTORS[1]] as const) {
    test(`manager (${actor.name}) → unchanged base+health shape`, async () => {
      const res = await getFace(actor.login, makeEnv(await seededWorld()));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        can_manage: boolean;
        app: Record<string, unknown>;
        installations: unknown[];
        deliveries: unknown[];
        delivery_summary: { rejected24h: number };
        keys?: unknown;
      };
      expect(body.can_manage).toBe(true);
      expect(body.app.sandbox_image_id).toBe("omp");
      expect(body.app).toHaveProperty("last_webhook_at");
      expect(body.app).toHaveProperty("review_trigger_mode");
      expect(body.installations).toEqual([]);
      expect(body.deliveries).toEqual([]);
      expect(body.delivery_summary.rejected24h).toBe(0);
      expect(body.keys).toEqual([]);
    });
  }

  test("unknown slug → 404", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/api/apps/no-such-app/settings", {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue("hubot", null, SESSION_SECRET)}` },
      }),
      makeEnv(await seededWorld()),
    );
    expect(res.status).toBe(404);
  });
});

// --- Read-face matrix: GET /dashboard/api/apps/:slug/insights/summary ---
// The per-App insights data face rides the SAME creator-or-admin rule
// (canManageApp) as every write route above, plus the slug lookup
// (unknown/soft-deleted → 404). Read-only, so no zero-mutation sweep is
// needed — the assertions are the status matrix itself.
describe("App insights read-face permission matrix", () => {
  const FACE = "/dashboard/api/apps/mallorys-app/insights/summary";

  async function getFace(login: string, env: Env): Promise<Response> {
    return worker.fetch(
      new Request(`https://worker.local${FACE}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}` },
      }),
      env,
    );
  }

  test("anonymous (no session) → 302 login", async () => {
    const res = await worker.fetch(new Request(`https://worker.local${FACE}`), makeEnv(await seededWorld()));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  for (const actor of ACTORS) {
    test(`read face: ${actor.name} (${actor.login}) → ${actor.expected}`, async () => {
      const res = await getFace(actor.login, makeEnv(await seededWorld()));
      expect(res.status).toBe(actor.expected);
      if (actor.expected !== 200) {
        // JSON-only deny body — this face never renders an HTML page.
        const body = (await res.json()) as { error?: string };
        expect(body.error).toBeDefined();
      } else {
        expect(res.headers.get("Content-Type")).toContain("application/json");
      }
    });
  }

  test("read face: unknown slug → 404 for a manager", async () => {
    const db = await seededWorld();
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/api/apps/no-such-app/insights/summary", {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue("mallory", null, SESSION_SECRET)}` },
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(404);
  });
});
