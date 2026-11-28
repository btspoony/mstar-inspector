import { describe, expect, spyOn, test } from "bun:test";
import worker from "../../src/worker/index";
import { syncSplitPair, createMigratedTestD1, seedTarget, type TestD1 } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import { sk, OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";
import { testAppPem } from "../helpers/rsa-key";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const PLAIN_KEY = sk("ant-matrix-9988");

async function keyIdOf(plainKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plainKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
const PLAIN_KEY_ID = await keyIdOf(PLAIN_KEY);

const APP_ID = 1001;
const ROW_APP_ID = "app-matrix";
const TARGET_ID = "target-matrix";
const SHARED_BOT_ID = "bot-shared-matrix";
const SHARED_BOT_APP_ID = 1099;
const SHARED_INSTALLATION_ID = 1200;
const CREATE_BOT_ID = "bot-create-matrix";
const CREATE_BOT_APP_ID = 1098;
const SETTINGS = `/dashboard/default/review-bots/${ROW_APP_ID}/settings`;
const VERIFY = `/dashboard/default/api/review-bots/${ROW_APP_ID}/keys/verify`;
const USAGE = `/dashboard/default/api/review-bots/${ROW_APP_ID}/keys/usage`;

async function seededWorld(): Promise<TestD1> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "ada", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  db.raw
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT 'default', id, CASE WHEN github_login = 'octocat' THEN 'owner' ELSE 'member' END,
              '2026-01-01T00:00:00.000Z'
       FROM users`,
    )
    .run();
  const id = ROW_APP_ID;
  const box = createSecretbox(TEST_KEY);
  await createReviewBotsStore(db).createApp({
    id,
    githubSlug: "mallorys-app",
    githubAppId: APP_ID,
    name: "mallorys-app",
    privateKeyEnc: await box.encryptSecret(await testAppPem(), `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
    workspaceId: "default",
    maxApps: null,
  });
  const targetId = seedTarget(db, id, { id: TARGET_ID, name: "mallorys-app" });
  await createReviewBotsStore(db).upsertPullRequest({
    appId: id,
    targetId,
    owner: "acme",
    repo: "widgets",
    prNumber: 131,
    title: "Add a thing",
    state: "open",
    headSha: "sha-1",
  });
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_by, created_at)
       VALUES ('ws-shared', 'ws-shared', 'Shared', 'octocat', datetime('now'))`,
    )
    .run();
  for (const [botId, githubAppId] of [
    [SHARED_BOT_ID, SHARED_BOT_APP_ID],
    [CREATE_BOT_ID, CREATE_BOT_APP_ID],
  ] as const) {
    db.raw.prepare(
      `INSERT INTO github_apps
           (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, scope, shared_at, created_at, updated_at)
         VALUES (?, 'platform-app', ?, 'platform-app', 'enc', 'enc', 'octocat', 'active',
                 'shared', datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(botId, githubAppId);
  // The split pair: the bot row and the default-workspace mapping the
  // same-id invariant of this release requires beside the App row.
  syncSplitPair(db);
    db.raw
      .prepare("INSERT OR REPLACE INTO app_workspaces (app_id, workspace_id) VALUES (?, 'ws-shared')")
      .run(botId);
  }
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, app_id, name, created_by, created_at, updated_at)
       VALUES ('target-platform', 'default', ?, 'platform-app', 'octocat',
               datetime('now'), datetime('now'))`,
    )
    .run(SHARED_BOT_ID);
  db.raw
    .prepare(
      `INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at, removed_at)
       VALUES ('install-matrix', ?, ?, 'acme', '2026-01-01 00:00:00', NULL)`,
    )
    .run(SHARED_BOT_ID, SHARED_INSTALLATION_ID);
  return db;
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

function appStatus(db: TestD1, appId: number): string | null {
  const row = db.raw.query("SELECT status FROM github_apps WHERE github_app_id = ?").get(appId) as {
    status: string;
  } | null;
  return row?.status ?? null;
}

function reviewEnabled(db: TestD1, appId: number): number | null {
  const row = db.raw.query("SELECT review_enabled FROM github_apps WHERE github_app_id = ?").get(appId) as {
    review_enabled: number;
  } | null;
  return row?.review_enabled ?? null;
}

function rawCount(db: TestD1, table: string): number {
  const row = db.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

const MUTABLE_APP_TABLES = [
  "bot_provider_keys",
  "bot_provider_models",
  "bot_model_config",
  "bot_model_chains",
  "bot_model_chain_seats",
  "bot_custom_providers",
] as const;

function expectZeroAppMutations(db: TestD1): void {
  expect(appStatus(db, APP_ID)).toBe("active");
  expect(reviewEnabled(db, APP_ID)).toBe(1);
  for (const table of MUTABLE_APP_TABLES) expect(rawCount(db, table), table).toBe(0);
  expect(rawCount(db, "review_targets")).toBe(2);
}

type MatrixRoute = {
  name: string;
  path: string;
  fields?: Record<string, string>;
  verifies?: boolean;
};

const MATRIX_ROUTES: MatrixRoute[] = [
  { name: "settings add-key", path: SETTINGS, fields: { op: "add-key", provider: "zai", key: PLAIN_KEY }, verifies: true },
  { name: "settings save-chain (clear)", path: SETTINGS, fields: { op: "save-chain", model_chain: "" } },
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
  { name: "keys/verify", path: VERIFY, fields: { provider: "anthropic", key: PLAIN_KEY }, verifies: true },
  { name: "keys/usage", path: USAGE, fields: { provider: "zai", keyId: PLAIN_KEY_ID }, verifies: true },
  { name: "settings key/delete", path: `${SETTINGS}/key/delete`, fields: { provider: "zai", key_id: PLAIN_KEY_ID } },
  { name: "refresh-metadata", path: `/dashboard/default/api/apps/${APP_ID}/refresh-metadata` },
  {
    name: "bind-installation",
    path: `/dashboard/default/api/apps/${SHARED_BOT_APP_ID}/bind-installation`,
    fields: { installationId: String(SHARED_INSTALLATION_ID) },
  },
  { name: "disable", path: `/dashboard/default/apps/${APP_ID}/disable` },
  { name: "enable", path: `/dashboard/default/apps/${APP_ID}/enable` },
  { name: "delete", path: `/dashboard/default/apps/${APP_ID}/delete` },
];

const ACTORS = [
  { name: "workspace owner", login: "octocat", expected: 200 },
  { name: "plain member", login: "hubot", expected: 403 },
  { name: "creator of the App", login: "mallory", expected: 403 },
  { name: "creator of a different app", login: "ada", expected: 403 },
] as const;

describe("App write-route permission matrix (T1b, spec §2)", () => {
  test("matrix: anonymous (no session) × every App write route → 302 login, zero mutations", async () => {
    const db = await seededWorld();
    const env = makeEnv(db);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => {
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
    expectZeroAppMutations(db);
  });

  for (const actor of ACTORS) {
    test(`matrix: ${actor.name} (${actor.login}) × every App write route → ${actor.expected}`, async () => {
      const db = await seededWorld();
      const env = makeEnv(db);
      const allowed = actor.expected === 200;
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        (async (input: unknown) => {
          const allowedUrl = String(input);
          if (!allowed) {
            throw new Error(`deny path (${actor.login}) must never call fetch`);
          }
          return new Response(
            JSON.stringify(
              allowedUrl === "https://api.github.com/app"
                ? { name: "mallorys-app", html_url: "https://github.com/apps/mallorys-app", slug: "mallorys-app" }
                : { data: [{ id: "claude-sonnet-4-6" }] },
            ),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
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
      if (allowed) {
        expect(
          db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys WHERE provider = 'zai'").get(),
        ).toEqual({ n: 0 });
        expect(rawCount(db, "bot_provider_keys")).toBe(1);
      } else {
        expectZeroAppMutations(db);
      }
    });
  }
});

describe("App detail read-face permission matrix (settings JSON)", () => {
  const FACE = `/dashboard/default/api/review-bots/${ROW_APP_ID}/settings`;

  async function getFace(login: string, env: Env): Promise<Response> {
    return worker.fetch(
      new Request(`https://worker.local${FACE}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}` },
      }),
      env,
    );
  }

  test("non-manager (other member) → exactly the identity-only payload", async () => {
    const db = await seededWorld();
    const res = await getFace("hubot", makeEnv(db));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as {
      can_manage: unknown;
      can_edit_chain: unknown;
      workspace_id: unknown;
      target_id: unknown;
      app: Record<string, unknown>;
    };
    expect(Object.keys(body).sort()).toEqual([
      "app",
      "blocked",
      "blocked_reason",
      "can_edit_chain",
      "can_manage",
      "target_id",
      "viewer_relation",
      "workspace_id",
    ]);
    // A bot route serves no App chain: the key must be present and false.
    expect(body.can_edit_chain).toBe(false);
    expect(body.workspace_id).toBe("default");
    const target = db.raw
      .prepare(
        "SELECT t.id FROM review_targets t JOIN github_apps b ON b.id = t.app_id WHERE b.github_app_id = ?",
      )
      .get(APP_ID) as { id: string };
    expect(body.target_id).toBe(target.id);
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
      "github_slug",
      "id",
      "review_enabled",
      "status",
    ]);
    // F2: App identity is null on the bot-config payload.
    expect(body.app.github_app_id).toBeNull();
    expect(body.app.github_slug).toBeNull();
    expect(typeof body.app.id).toBe("string");
    expect(body.app.created_by).toBeNull();
    expect(typeof body.app.created_at).toBe("string");
    expect(JSON.stringify(body)).not.toContain("installations");
    expect(JSON.stringify(body)).not.toContain("deliveries");
    expect(JSON.stringify(body)).not.toContain("sandbox_image_id");
    expect(JSON.stringify(body)).not.toContain("review_trigger_mode");
    expect(JSON.stringify(body)).not.toContain("last_webhook_at");
    expect(JSON.stringify(body)).not.toContain("private_key_enc");
  });

  for (const actor of [ACTORS[0]] as const) {
    test(`manager (${actor.name}) → unchanged base+health shape`, async () => {
      const res = await getFace(actor.login, makeEnv(await seededWorld()));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        can_manage: boolean;
        app: Record<string, unknown>;
        installations: unknown[];
        delivery_summary: { rejected24h: number };
        deliveries?: unknown;
        keys?: unknown;
      };
      expect(body.can_manage).toBe(true);
      expect(body.app.sandbox_image_id).toBe("omp");
      expect(body.app).toHaveProperty("last_webhook_at");
      expect(body.app).toHaveProperty("review_trigger_mode");
      expect(body.installations).toEqual([]);
      expect(body.deliveries).toBeUndefined();
      expect(body.delivery_summary.rejected24h).toBe(0);
      expect(body.keys).toEqual([]);
    });
  }

  test("unknown App id → 404", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/default/api/review-bots/9999/settings", {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue("hubot", null, SESSION_SECRET)}` },
      }),
      makeEnv(await seededWorld()),
    );
    expect(res.status).toBe(404);
  });

  for (const alias of ["0x1f", "1e3", "0x3e9", "1.001e3", "+1001"]) {
    test(`App-id segment spelled ${alias} → 404 (not an alias)`, async () => {
      const res = await worker.fetch(
        new Request(`https://worker.local/dashboard/default/api/review-bots/${alias}/settings`, {
          headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue("hubot", null, SESSION_SECRET)}` },
        }),
        makeEnv(await seededWorld()),
      );
      expect(res.status).toBe(404);
    });
  }
});

describe("Bot settings read-face permission matrix", () => {
  const FACE = `/dashboard/default/api/review-bots/${ROW_APP_ID}/bot`;

  async function getFace(login: string, env: Env): Promise<Response> {
    return worker.fetch(
      new Request(`https://worker.local${FACE}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}` },
      }),
      env,
    );
  }

  test("workspace owner → 200, can_manage true", async () => {
    const res = await getFace("octocat", makeEnv(await seededWorld()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { can_manage: unknown };
    expect(body.can_manage).toBe(true);
  });

  test("plain member → 200 with the same sections, can_manage false", async () => {
    const res = await getFace("hubot", makeEnv(await seededWorld()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { can_manage: unknown; keys: unknown; installations: unknown };
    expect(body.can_manage).toBe(false);
    expect(body.keys).toEqual([]);
    expect(body.installations).toEqual([]);
  });

  test("unknown App id → 404", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/default/api/review-bots/9999/bot", {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue("hubot", null, SESSION_SECRET)}` },
      }),
      makeEnv(await seededWorld()),
    );
    expect(res.status).toBe(404);
  });
});

describe("Target pull-request ledger read-face permission matrix", () => {
  const LIST = `/dashboard/default/api/targets/${TARGET_ID}/pull-requests`;
  const DETAIL = `${LIST}/acme/widgets/131`;

  async function getFace(path: string, login: string, env: Env): Promise<Response> {
    return worker.fetch(
      new Request(`https://worker.local${path}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}` },
      }),
      env,
    );
  }

  for (const path of [LIST, DETAIL]) {
    test(`${path}: anonymous → 302 login`, async () => {
      const res = await worker.fetch(new Request(`https://worker.local${path}`), makeEnv(await seededWorld()));
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard/login");
    });

    for (const actor of ACTORS) {
      test(`${path}: ${actor.name} (${actor.login}) → ${actor.expected}`, async () => {
        const res = await getFace(path, actor.login, makeEnv(await seededWorld()));
        expect(res.status).toBe(actor.expected);
        if (actor.expected === 403) {
          expect(await res.json()).toEqual({ error: "forbidden" });
        }
      });
    }

    test(`${path}: deny answers are not cacheable`, async () => {
      const res = await getFace(path, "hubot", makeEnv(await seededWorld()));
      expect(res.status).toBe(403);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    });
  }

  test("detail: unknown PR number → 404 for a manager, also not cacheable", async () => {
    const res = await getFace(`${LIST}/acme/widgets/999`, "octocat", makeEnv(await seededWorld()));
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("Target insights read-face permission matrix", () => {
  const FACE = `/dashboard/default/api/targets/${TARGET_ID}/insights/summary`;

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
        const body = (await res.json()) as { error?: string };
        expect(body.error).toBeDefined();
      } else {
        expect(res.headers.get("Content-Type")).toContain("application/json");
      }
    });
  }

  test("read face: unknown target id → 404 for a manager", async () => {
    const db = await seededWorld();
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/default/api/targets/no-such-target/insights/summary", {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}` },
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("read face: the manager 403 is not cacheable", async () => {
    const denied = await getFace("hubot", makeEnv(await seededWorld()));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("read face: a malformed window 400 is not cacheable", async () => {
    const res = await worker.fetch(
      new Request(`https://worker.local${FACE}?window=abc`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}` },
      }),
      makeEnv(await seededWorld()),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
