/** note: The App write-route permission matrix (spec §2 权限矩阵).
 *
 * The T1b audit confirmed every App write route — config (settings family:
 * add-key / save-chain / save-roles / add-custom-provider /
 * add-template-provider / remove-custom-provider / key/delete / keys/verify /
 * keys/usage, plus the chain ops add-chain / remove-chain) and ops
 * (disable / enable / delete) — funnels through the SAME
 * server-side workspace owner/admin gate (`canManageApp` in
 * src/dashboard/index.ts,
 * `canManageRole` = workspace owner/admin). This file locks that matrix as
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
import { createMigratedTestD1, seedTarget, type TestD1 } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import { sk, OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";
import { testAppPem } from "../helpers/rsa-key";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
/** invariant: base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const PLAIN_KEY = sk("ant-matrix-9988");

/** note: The pool id the store derives from PLAIN_KEY (first 16 hex of SHA-256) — the
 * `keyId` the usage route takes, so the manager sweep can reach its 200 face.
 */
async function keyIdOf(plainKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plainKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
const PLAIN_KEY_ID = await keyIdOf(PLAIN_KEY);

/** invariant: The App's immutable GitHub App id — the only App address form (D0). */
const APP_ID = 1001;
/** note: The App's repository target in `default` — the ledger/insights address. */
const TARGET_ID = "target-matrix";
/** note: The bot the platform shares: the create-target route's subject. */
const SHARED_BOT_ID = "bot-shared-matrix";
/** note: The shared bot's immutable GitHub App id — its App-addressed routes. */
const SHARED_BOT_APP_ID = 1099;
/** note: One pending installation of that bot, seeded with the world. */
const SHARED_INSTALLATION_ID = 1200;
/** note: A second shared bot with no target here — the create-target route's subject. */
const CREATE_BOT_ID = "bot-create-matrix";
const CREATE_BOT_APP_ID = 1098;
const SETTINGS = `/dashboard/default/apps/${APP_ID}/settings`;
const VERIFY = `/dashboard/default/api/apps/${APP_ID}/keys/verify`;
const USAGE = `/dashboard/default/api/apps/${APP_ID}/keys/usage`;

/** note: Seeded world (spec §2 actors): octocat = workspace `owner`; mallory created
 * "mallorys-app" but is a plain member; ada created a DIFFERENT app; hubot is
 * a plain member. Manage is the workspace role, so only octocat may write.
 */
async function seededWorld(): Promise<TestD1> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "ada", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  // note: Manage is the workspace role: `octocat` is the workspace owner, mallory a
  // plain member — so `creator` and `admin` no longer mean the same thing.
  db.raw
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT 'default', id, CASE WHEN github_login = 'octocat' THEN 'owner' ELSE 'member' END,
              '2026-01-01T00:00:00.000Z'
       FROM users`,
    )
    .run();
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  await createReviewBotsStore(db).createApp({
    id,
    githubSlug: "mallorys-app",
    githubAppId: APP_ID,
    name: "mallorys-app",
    // A real PKCS#8 PEM: the refresh-metadata route's 200 side mints an App
    // JWT, and WebCrypto rejects a placeholder body before any request leaves.
    privateKeyEnc: await box.encryptSecret(await testAppPem(), `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
    workspaceId: "default",
    maxApps: null,
  });
  // note: One ledger row: the detail face's 200 side needs a real tuple, and every
  // deny path must still answer before the lookup. Creation writes no target
  // (D13), so the fixture seeds the App's repository target and attributes the
  // row to it.
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
  // note: Two shared bots owned by a second workspace. The first already carries
  // THIS workspace's target and one pending installation (the bind route's
  // subject); the second carries no target here, so the create-target route's
  // 200 side is its own first write.
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
    db.raw
      .prepare(
        `INSERT INTO review_bots
           (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, scope, shared_at, created_at, updated_at)
         VALUES (?, 'platform-app', ?, 'platform-app', 'enc', 'enc', 'octocat', 'active',
                 'shared', datetime('now'), datetime('now'), datetime('now'))`,
      )
      .run(botId, githubAppId);
    db.raw
      .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, 'ws-shared')")
      .run(botId);
  }
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
       VALUES ('target-platform', 'default', ?, 'platform-app', 'octocat',
               datetime('now'), datetime('now'))`,
    )
    .run(SHARED_BOT_ID);
  // note: One installation the bot already carries, bound to no target: the bind
  // route's pending read is what admits it (the sweep's 200 side).
  db.raw
    .prepare(
      `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
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
  const row = db.raw.query("SELECT status FROM review_bots WHERE github_app_id = ?").get(appId) as {
    status: string;
  } | null;
  return row?.status ?? null;
}

function reviewEnabled(db: TestD1, appId: number): number | null {
  const row = db.raw.query("SELECT review_enabled FROM review_bots WHERE github_app_id = ?").get(appId) as {
    review_enabled: number;
  } | null;
  return row?.review_enabled ?? null;
}

function rawCount(db: TestD1, table: string): number {
  const row = db.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/** invariant: The config tables the write-route sweep may never touch on a deny path. */
const MUTABLE_APP_TABLES = [
  "bot_provider_keys",
  "bot_provider_models",
  "bot_model_config",
  "bot_model_chains",
  "bot_model_chain_seats",
  "bot_custom_providers",
] as const;

/** note: The deny path's whole mutation contract in one place: the app row keeps its
 * status and review switch, and none of the config tables gained a row. One
 * list, so a new swept table cannot land in one sweep and not the other.
 */
function expectZeroAppMutations(db: TestD1): void {
  expect(appStatus(db, APP_ID)).toBe("active");
  expect(reviewEnabled(db, APP_ID)).toBe(1);
  for (const table of MUTABLE_APP_TABLES) expect(rawCount(db, table), table).toBe(0);
  // invariant: The seeded world holds exactly two targets: the App's, and the one this
  // workspace already has on the platform bot (the bind route's subject). A
  // deny path that reached a create/bind write would show a third.
  expect(rawCount(db, "review_targets")).toBe(2);
}

type MatrixRoute = {
  name: string;
  path: string;
  fields?: Record<string, string>;
  /** note: routes whose 200 side performs an outbound provider verification */
  verifies?: boolean;
};

/** note: Every App write route, in an order that keeps each 200-side mutation valid
 * for the allowed actors (delete soft-deletes, so it runs LAST).
 */
const MATRIX_ROUTES: MatrixRoute[] = [
  // note: --- edit family: settings POST (config) ---
  // A provider with a usage probe, so the keys/usage entry below finds a stored
  // key and reaches its 200 face from this same sweep.
  { name: "settings add-key", path: SETTINGS, fields: { op: "add-key", provider: "zai", key: PLAIN_KEY }, verifies: true },
  { name: "settings save-chain (clear)", path: SETTINGS, fields: { op: "save-chain", model_chain: "" } },
  // note: QC wave (F-002): save-roles is a FULL-map save — every seat key is
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
  // invariant: Chain ops (QC wave, seat1): add-chain must also exercise the
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
  { name: "keys/verify", path: VERIFY, fields: { provider: "anthropic", key: PLAIN_KEY }, verifies: true },
  { name: "keys/usage", path: USAGE, fields: { provider: "zai", keyId: PLAIN_KEY_ID }, verifies: true },
  // invariant: Removes the row `settings add-key` seeded (zai + PLAIN_KEY). It runs after
  // keys/usage — which still needs that row — so the 200 face deletes a REAL
  // row instead of finding nothing.
  { name: "settings key/delete", path: `${SETTINGS}/key/delete`, fields: { provider: "zai", key_id: PLAIN_KEY_ID } },
  // invariant: (D5) The manager's forced metadata refresh — a manager-only write whose 200
  // side additionally calls api.github.com (GET /app + the bot avatar leg), so
  // the sweep's stub answers those URLs too.
  { name: "refresh-metadata", path: `/dashboard/default/api/apps/${APP_ID}/refresh-metadata` },
  // note: --- workspace-scoped installation binding ---
  // The target page's bind entry: the world's shared bot carries one pending
  // installation.
  {
    name: "bind-installation",
    path: `/dashboard/default/api/apps/${SHARED_BOT_APP_ID}/bind-installation`,
    fields: { installationId: String(SHARED_INSTALLATION_ID) },
  },
  // note: --- ops family: pinned action paths ---
  { name: "disable", path: `/dashboard/default/apps/${APP_ID}/disable` },
  { name: "enable", path: `/dashboard/default/apps/${APP_ID}/enable` },
  { name: "delete", path: `/dashboard/default/apps/${APP_ID}/delete` },
];

const ACTORS = [
  { name: "workspace owner", login: "octocat", expected: 200 },
  { name: "plain member", login: "hubot", expected: 403 },
  // invariant: The App's creator is a plain workspace member: creation grants nothing.
  { name: "creator of the App", login: "mallory", expected: 403 },
  { name: "creator of a different app", login: "ada", expected: 403 },
] as const;

describe("App write-route permission matrix (T1b, spec §2)", () => {
  // invariant: Strength pin (F3–F8): before any per-actor gate can even
  // run, the mount-level membership guard bounces a session-less POST on
  // every App write route into the OAuth flow — 302 to login, and the
  // identical zero-mutation invariants as the member sweeps below.
  test("matrix: anonymous (no session) × every App write route → 302 login, zero mutations", async () => {
    const db = await seededWorld();
    const env = makeEnv(db);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => {
        // invariant: The guard fires before validation, verification, or writes — no
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
            // invariant: The deny path must short-circuit BEFORE any outbound call —
            // the guard fires before validation, verification, or writes.
            throw new Error(`deny path (${actor.login}) must never call fetch`);
          }
          // note: Models-list shape for built-in verify; any 2xx for the custom
          // probe (its body is never scraped — models = declared model_ids).
          // The refresh-metadata route's profile leg needs the GET /app shape
          // (a `name` string is its identity gate); its bot-avatar leg accepts
          // any 2xx body.
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
        // note: `settings key/delete` removed the row `settings add-key` seeded (zai):
        // the delete's 200 face did real work rather than matching nothing, and
        // only the row `keys/verify` stored (anthropic) is left in the pool.
        expect(
          db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys WHERE provider = 'zai'").get(),
        ).toEqual({ n: 0 });
        expect(rawCount(db, "bot_provider_keys")).toBe(1);
      } else {
        // invariant: Zero mutation on every deny path: the app row is untouched and no
        // config table gained a row.
        expectZeroAppMutations(db);
      }
    });
  }
});

// note: --- Read-face matrix: GET /dashboard/default/api/apps/:appId/settings ---
// Identity-only non-manager detail face: a member who is neither creator nor
// admin gets the D4 identity set (the GET /api/apps list fields + created_at
// + the cached public GitHub profile) and can_manage:false — NO health or
// ops data (installations / deliveries / delivery_summary / last_webhook_at
// / sandbox_image_id / review_trigger_mode). The manager face keeps the
// full base+health payload unchanged. Read-only, so the status/shape
// assertions are the matrix itself.
describe("App detail read-face permission matrix (settings JSON)", () => {
  const FACE = `/dashboard/default/api/apps/${APP_ID}/settings`;

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
      workspace_id: unknown;
      target_id: unknown;
      app: Record<string, unknown>;
    };
    // invariant: The derived Blocked pair rides both faces: a member must know why the
    // target is silent, so it is part of the identity set.
    expect(Object.keys(body).sort()).toEqual([
      "app",
      "blocked",
      "blocked_reason",
      "can_manage",
      "target_id",
      "workspace_id",
    ]);
    // note: The delivery URL's workspace segment: the server-resolved stable id.
    expect(body.workspace_id).toBe("default");
    // note: The review configuration this App resolved to inside that workspace.
    const target = db.raw
      .prepare(
        "SELECT t.id FROM review_targets t JOIN review_bots b ON b.id = t.bot_id WHERE b.github_app_id = ?",
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
    expect(body.app.github_app_id).toBe(APP_ID);
    expect(body.app.github_slug).toBe("mallorys-app");
    // note: The local App UID is the payload's other identifier (the webhook URL's
    // app segment); its value is the caller-supplied row id.
    expect(typeof body.app.id).toBe("string");
    expect(body.app.created_by).toBe("mallory");
    expect(typeof body.app.created_at).toBe("string");
    // invariant: ops fields never ride the non-manager payload
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
      // why: The delivery log has its own paged read face, so the settings payload
      // no longer carries the fixed recent list.
      expect(body.deliveries).toBeUndefined();
      expect(body.delivery_summary.rejected24h).toBe(0);
      expect(body.keys).toEqual([]);
    });
  }

  test("unknown App id → 404", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/default/api/apps/9999/settings", {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue("hubot", null, SESSION_SECRET)}` },
      }),
      makeEnv(await seededWorld()),
    );
    expect(res.status).toBe(404);
  });

  // invariant: The segment is GitHub's numeric App id, spelled in decimal digits only.
  // `0x1f` / `1e3` are number spellings, not ids; `0x3e9` / `1.001e3` are the
  // dangerous ones — `Number()` parses both to the seeded 1001, so a lax
  // parser would alias the App under four URLs.
  for (const alias of ["0x1f", "1e3", "0x3e9", "1.001e3", "+1001"]) {
    test(`App-id segment spelled ${alias} → 404 (not an alias)`, async () => {
      const res = await worker.fetch(
        new Request(`https://worker.local/dashboard/default/api/apps/${alias}/settings`, {
          headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue("hubot", null, SESSION_SECRET)}` },
        }),
        makeEnv(await seededWorld()),
      );
      expect(res.status).toBe(404);
    });
  }
});

// note: --- Bot settings read face: GET /api/apps/:appId/bot ---
// The page that carries the bot-owned sections renders for every member; the
// payload's `can_manage` decides whether the SPA offers bot-scoped writes, and
// the bot-scoped POST family refuses them for a shared bot anyway.
describe("Bot settings read-face permission matrix", () => {
  const FACE = `/dashboard/default/api/apps/${APP_ID}/bot`;

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
      new Request("https://worker.local/dashboard/default/api/apps/9999/bot", {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue("hubot", null, SESSION_SECRET)}` },
      }),
      makeEnv(await seededWorld()),
    );
    expect(res.status).toBe(404);
  });
});

// note: --- PR-ledger read faces: the list and one-PR detail (migration 0039) ---
// Same canManageApp rule as every other target read: the workspace role decides,
// and target authorship grants nothing. The address is the target plus the
// ledger's own key (owner/repo/number).
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
          // note: The manager gate is what answered — not the App resolution.
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

// note: --- Read-face matrix: GET /dashboard/default/api/targets/:targetId/insights/summary ---
// The target insights data face rides the SAME workspace owner/admin rule
// (canManageApp) as every write route above, plus the target-in-workspace
// lookup (unknown/soft-deleted/foreign → 404). Read-only, so no zero-mutation
// sweep is needed — the assertions are the status matrix itself.
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
        // invariant: JSON-only deny body — this face never renders an HTML page.
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
    // note: This route sets no header of its own — the 404 inherits it from the
    // `/:workspaceRef/api/*` prefix middleware, which is exactly what this
    // asserts.
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
