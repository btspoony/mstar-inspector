/**
 * Plan 14 B2 Task 1 tests: migration 0006 + the per-App config store
 * (`app_provider_keys` BYOK keys + `app_model_config` model chain) + the
 * /dashboard/apps/:slug/settings route family (spec
 * dashboard-multi-app-platform § Per-App BYOK + § Crypto envelope, architect
 * locks L1/L2).
 *
 * Production-shaped sequence (the 0004/0005 test precedent): the bun:sqlite
 * double applies 0001/0002, a row is SEEDED into the existing reviews table,
 * and only then do 0003 → 0006 apply in filename order — the append-only
 * assumption is exercised against a DB that already holds data, exactly like
 * `wrangler d1 migrations apply` on production.
 *
 * Crypto anchors (lock L1): the composite-PK AAD
 * `app_provider_keys.key_enc:<appId>:<provider>` is proven with a real
 * secretbox round-trip (any other AAD fails the GCM tag); the masked list
 * never returns plaintext; keys never appear in route HTML.
 *
 * Duplication locks (architect decision Q2 forbids the dashboard from
 * importing pipeline/review code, so the copies must be pinned):
 * PROVIDER_IDS ≡ the pipeline PROVIDERS key sequence, parseModelChain ≡
 * the runtime-omp parseModelSelectors behavior, and MODEL_ROLE_IDS ≡ the
 * review-side seat vocabulary (plan 17 B6), all asserted against the
 * originals here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../../src/worker/index";
import { createTestD1 } from "../store/helpers";
import { createAppsStore, type GithubAppRow } from "../../src/dashboard/apps-store";
import {
  CUSTOM_PROVIDER_API_IDS,
  IN_IMAGE_BASE_PROVIDER_IDS,
  MAX_CUSTOM_PROVIDER_COUNT,
  InvalidCustomProviderError,
  InvalidModelSelectorError,
  MAX_MODEL_SELECTOR_LENGTH,
  MAX_PROVIDER_KEY_LENGTH,
  MODEL_ROLE_IDS,
  PROVIDER_IDS,
  ProviderKeyTooLongError,
  UnknownModelRoleError,
  createAppConfigStore,
  parseModelChain,
  type AppConfigD1,
  type AppCustomProvider,
} from "../../src/dashboard/app-config-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { PROVIDERS } from "../../src/pipeline/providers";
import { DEEP_SEAT_ROLES, parseModelSelectors } from "../../src/review/runtime-omp";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser, type DashboardD1 } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_KEY = Buffer.alloc(32, 11).toString("base64");
const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";
const PLAIN_ANTHROPIC_KEY = "sk-ant-mallory-verysecret-9988";
const PLAIN_CHAIN = "ark-plan/deepseek-v4-flash, openai/gpt-5:thinking";
/** SQLite datetime('now') format the store writes (UTC "YYYY-MM-DD HH:MM:SS"). */
const SQLITE_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// --- fixtures ---

/** Synchronous parameterized write on the raw bun:sqlite handle. */
function rawRun(
  db: ReturnType<typeof createTestD1>,
  sql: string,
  ...params: (string | number | null)[]
): void {
  db.raw.prepare(sql).run(...params);
}

function rawCount(db: ReturnType<typeof createTestD1>, table: string): number {
  const row = db.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/** Apply one migration file verbatim (filename order = wrangler order). */
function applyMigration(db: ReturnType<typeof createTestD1>, name: string): void {
  db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
}

const PLAN_13_MIGRATIONS = [
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  "0005_reviews_app_id.sql",
];

/**
 * Production-shaped DB: 0001/0002 + a seeded review row, then the later
 * migrations in filename order (0006 is applied SEPARATELY by the migration
 * test so an app row can exist before it — the wrangler sequence).
 */
function createPopulatedPre0006D1(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  rawRun(
    db,
    `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md)
     VALUES ('review-1', 123, 'acme', 'widgets', 42, '0123456789abcdef0123456789abcdef01234567', 'comment', 'ok')`,
  );
  for (const name of PLAN_13_MIGRATIONS) applyMigration(db, name);
  return db;
}

/**
 * Fully-migrated shape with 0006 applied over the populated DB (0008 and 0009
 * too — plan 16: the settings page renders the Review switch and the
 * install-health panel from github_apps.review_enabled / last_webhook_at and
 * app_installations; plan 17: the role-models store tests need
 * app_model_roles — so the route tests run on the production shape; the 0007
 * index skip stays, harmless for these tables).
 */
function createAppConfigD1(): ReturnType<typeof createTestD1> {
  const db = createPopulatedPre0006D1();
  applyMigration(db, "0006_app_provider_config.sql");
  applyMigration(db, "0008_github_apps_ops.sql");
  applyMigration(db, "0009_app_model_roles.sql");
  // 0011 (plan 20): the settings page now renders the recent-deliveries
  // panel from webhook_deliveries on every render — the fixture must carry
  // the table or every settings route 500s.
  applyMigration(db, "0011_webhook_deliveries.sql");
  applyMigration(db, "0012_custom_providers_and_key_updated_at.sql");
  return db;
}

const configStore = (db: AppConfigD1) => createAppConfigStore(db, TEST_KEY);

/**
 * D1 double whose batch() ALWAYS rejects (Phase 5 fix, PR #7 review): every
 * other member delegates to the real migrated double, so the failure is
 * exactly "the batch was issued and failed". D1 batch is transactional (the
 * bun:sqlite helper brackets BEGIN/COMMIT/ROLLBACK the same way), so zero of
 * its statements may land — the atomicity the setModelRoles save now relies
 * on.
 */
function createBatchRejectingD1(inner: AppConfigD1): AppConfigD1 & { batchCalls(): number } {
  let batchCalls = 0;
  return {
    prepare: (query: string) => inner.prepare(query),
    batch: async () => {
      batchCalls += 1;
      throw new Error("simulated D1 batch failure");
    },
    batchCalls: () => batchCalls,
  };
}

/** Seed a github_apps row with genuinely decryptable encrypted columns. */
async function seedApp(
  db: DashboardD1,
  opts: { slug: string; createdBy: string; githubAppId?: number },
): Promise<GithubAppRow> {
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  return createAppsStore(db).createApp({
    id,
    slug: opts.slug,
    githubAppId: opts.githubAppId ?? 1001,
    name: opts.slug,
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${id}`),
    createdBy: opts.createdBy,
  });
}

/** mallory owns "mallorys-app"; ada owns "adas-app"; hubot owns none; octocat is admin. */
async function seededWorld(): Promise<{ db: ReturnType<typeof createAppConfigD1>; app: GithubAppRow; otherApp: GithubAppRow }> {
  const db = createAppConfigD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "ada", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  const app = await seedApp(db, { slug: "mallorys-app", createdBy: "mallory", githubAppId: 1001 });
  const otherApp = await seedApp(db, { slug: "adas-app", createdBy: "ada", githubAppId: 1002 });
  return { db, app, otherApp };
}

// --- route drivers (same shape as apps-ui.test.ts) ---

function makeEnv(db: unknown, overrides: Partial<Env> = {}): Env {
  return {
    APP_ID: "123",
    PRIVATE_KEY: "private-key",
    WEBHOOK_SECRET: "s3cret-webhook-secret",
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
    ...overrides,
  } as Env;
}

const sessionCookie = (login: string) => createSessionValue(login, null, SESSION_SECRET);

async function get(path: string, cookie: string, env: Env): Promise<Response> {
  return await worker.fetch(new Request(`https://worker.local${path}`, { headers: { Cookie: cookie } }), env);
}

async function postForm(
  path: string,
  cookie: string,
  env: Env,
  fields: Record<string, string>,
): Promise<Response> {
  return await worker.fetch(
    new Request(`https://worker.local${path}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
    env,
  );
}

const SETTINGS = "/dashboard/apps/mallorys-app/settings";

// --- migration 0006 ---

describe("migration 0006_app_provider_config.sql (on a seeded production-shaped DB)", () => {
  test("applies cleanly after 0001–0005 over existing review AND app rows", () => {
    const db = createPopulatedPre0006D1();
    // An app row exists BEFORE 0006 applies — the FK parent is populated,
    // exactly the wrangler order on a live deployment.
    return seedApp(db, { slug: "pre-existing", createdBy: "mallory" }).then(() => {
      expect(() => applyMigration(db, "0006_app_provider_config.sql")).not.toThrow();
      // Append-only: the seeded review row (app_id NULL = legacy) is untouched.
      const row = db.raw.query("SELECT app_id FROM reviews WHERE id = 'review-1'").get() as {
        app_id: string | null;
      };
      expect(row.app_id).toBeNull();
    });
  });

  test("app_provider_keys: composite PK (app_id, provider) rejects a duplicate pair; other apps may repeat the provider", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const other = await seedApp(db, { slug: "b", createdBy: "ada", githubAppId: 1002 });
    rawRun(
      db,
      `INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at)
       VALUES (?, 'anthropic', 'v1.primary.aXZpdi.Y3Q=', '2026-01-01 00:00:00')`,
      app.id,
    );
    expect(() =>
      rawRun(
        db,
        `INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at)
         VALUES (?, 'anthropic', 'v1.primary.aXZpdi.Y3Q=', '2026-01-01 00:00:00')`,
        app.id,
      ),
    ).toThrow(/UNIQUE constraint failed/);
    // The same provider under ANOTHER app is a distinct row (per-App keys).
    rawRun(
      db,
      `INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at)
       VALUES (?, 'anthropic', 'v1.primary.aXZpdi.Y3Q=', '2026-01-01 00:00:00')`,
      other.id,
    );
    expect(rawCount(db, "app_provider_keys")).toBe(2);
  });

  test("app_provider_keys: FK to github_apps — unknown app refused", async () => {
    const db = createAppConfigD1();
    expect(() =>
      rawRun(
        db,
        `INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at)
         VALUES ('no-such-app', 'anthropic', 'v1.primary.aXZpdi.Y3Q=', '2026-01-01 00:00:00')`,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("no ON DELETE: hard-deleting an app with config rows is refused (soft-delete is the only removal path)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    await configStore(db).setModelChain(app.id, "ark-plan/deepseek-v4-flash");
    expect(() => rawRun(db, "DELETE FROM github_apps WHERE id = ?", app.id)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  test("app_model_config: one row per app (PK app_id), FK enforced, model_chain nullable", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const other = await seedApp(db, { slug: "b", createdBy: "ada", githubAppId: 1002 });
    rawRun(
      db,
      `INSERT INTO app_model_config (app_id, model_chain, updated_at)
       VALUES (?, 'ark-plan/deepseek-v4-flash', '2026-01-01 00:00:00')`,
      app.id,
    );
    expect(() =>
      rawRun(
        db,
        `INSERT INTO app_model_config (app_id, model_chain, updated_at)
         VALUES (?, 'openai/gpt-5', '2026-01-01 00:00:00')`,
        app.id,
      ),
    ).toThrow(/UNIQUE constraint failed/);
    // NULL chain and a second app's row are both legal.
    rawRun(
      db,
      `INSERT INTO app_model_config (app_id, model_chain, updated_at)
       VALUES (?, NULL, '2026-01-01 00:00:00')`,
      other.id,
    );
    expect(rawCount(db, "app_model_config")).toBe(2);
    expect(() =>
      rawRun(
        db,
        `INSERT INTO app_model_config (app_id, model_chain, updated_at)
         VALUES ('no-such-app', 'x', '2026-01-01 00:00:00')`,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

// --- migration 0012 (plan 23 T1: app_provider_keys.updated_at) ---

describe("migration 0012_custom_providers_and_key_updated_at.sql (plan 23 T1)", () => {
  test("applies cleanly after 0006; pre-existing key rows keep created_at and carry NULL updated_at until the key is re-set", async () => {
    const db = createPopulatedPre0006D1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    applyMigration(db, "0006_app_provider_config.sql");
    // A key row written BEFORE 0012 (the pre-migration column set).
    rawRun(
      db,
      `INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at)
       VALUES (?, 'anthropic', 'v1.primary.aXZpdi.Y3Q=', '2026-01-01 00:00:00')`,
      app.id,
    );
    expect(() => applyMigration(db, "0012_custom_providers_and_key_updated_at.sql")).not.toThrow();
    let row = db.raw.query("SELECT created_at, updated_at FROM app_provider_keys").get() as {
      created_at: string;
      updated_at: string | null;
    };
    expect(row.created_at).toBe("2026-01-01 00:00:00"); // untouched by the ALTER
    expect(row.updated_at).toBeNull(); // the 存量行 placeholder source
    // The store's re-set fills updated_at from the SAME clock read as
    // created_at — a legacy row becomes current.
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    row = db.raw.query("SELECT created_at, updated_at FROM app_provider_keys").get() as {
      created_at: string;
      updated_at: string;
    };
    expect(row.updated_at).toMatch(SQLITE_TS_RE);
    expect(row.updated_at).toBe(row.created_at);
  });

  test("full-file direct run (0001→0012 order) creates app_custom_providers with the AL-23-1 DDL shape", async () => {
    const db = createAppConfigD1(); // 0001→0012 in filename order (0007 index skip, harmless)
    const cols = db.raw.query("PRAGMA table_info(app_custom_providers)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName: Record<string, { type: string; notnull: number; pk: number }> = {};
    for (const c of cols) byName[c.name] = c;
    // AL-23-1 DDL: app_id FK, provider_id, base_url, api, model_ids TEXT
    // (JSON array), api_key_enc NOT NULL, created_at/updated_at, composite
    // PK (app_id, provider_id) — the AAD rowKey source.
    for (const col of ["app_id", "provider_id", "base_url", "api", "model_ids", "api_key_enc", "created_at", "updated_at"]) {
      expect(byName[col], col).toBeDefined();
      expect(byName[col]!.notnull, col).toBe(1);
    }
    expect(byName["model_ids"]!.type).toBe("TEXT");
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkCols).toEqual(["app_id", "provider_id"]);
  });
});

// --- store: provider keys ---

describe("app-config store (createAppConfigStore) — provider keys", () => {
  test("setProviderKey encrypts INSIDE the store with the composite-PK AAD (round-trip)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const row = db.raw
      .query("SELECT app_id, provider, key_enc, created_at FROM app_provider_keys")
      .get() as { app_id: string; provider: string; key_enc: string; created_at: string };
    // Only ciphertext lands in D1: a v1 envelope, never the plaintext.
    expect(row.key_enc).toMatch(/^v1\.primary\./);
    expect(row.key_enc).not.toContain(PLAIN_ANTHROPIC_KEY);
    expect(row.app_id).toBe(app.id);
    expect(row.provider).toBe("anthropic");
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // The composite AAD (lock L1) decrypts the exact plaintext back.
    const plain = await createSecretbox(TEST_KEY).decryptSecret(
      row.key_enc,
      `app_provider_keys.key_enc:${app.id}:anthropic`,
    );
    expect(plain).toBe(PLAIN_ANTHROPIC_KEY);
  });

  test("AAD anchor: the composite rowKey binds BOTH PK columns — any other AAD fails the GCM tag", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const row = db.raw.query("SELECT key_enc FROM app_provider_keys").get() as { key_enc: string };
    const box = createSecretbox(TEST_KEY);
    // A different provider of the SAME app (cross-provider read)…
    await expect(
      box.decryptSecret(row.key_enc, `app_provider_keys.key_enc:${app.id}:openai`),
    ).rejects.toThrow(/AAD mismatch/);
    // …and the same provider of a DIFFERENT app (cross-App read).
    await expect(
      box.decryptSecret(row.key_enc, `app_provider_keys.key_enc:other-app:anthropic`),
    ).rejects.toThrow(/AAD mismatch/);
  });

  test("re-setting a provider replaces the ciphertext (composite PK upsert, one row)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setProviderKey(app.id, "anthropic", "sk-first-key-aaaa");
    await store.setProviderKey(app.id, "anthropic", "sk-second-key-bbbb");
    expect(rawCount(db, "app_provider_keys")).toBe(1);
    const list = await store.listProviderKeys(app.id);
    expect(list).toEqual([{ provider: "anthropic", last4: "bbbb", updated_at: expect.any(String) }]);
  });

  test("listProviderKeys masks to provider + last-4 only — plaintext never returns", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setProviderKey(app.id, "openai", "sk-openai-key-7777");
    await store.setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const list = await store.listProviderKeys(app.id);
    // Provider-ascending; ONLY the masked tail of each key.
    expect(list).toEqual([
      { provider: "anthropic", last4: "9988", updated_at: expect.any(String) },
      { provider: "openai", last4: "7777", updated_at: expect.any(String) },
    ]);
    expect(JSON.stringify(list)).not.toContain(PLAIN_ANTHROPIC_KEY);
    expect(JSON.stringify(list)).not.toContain("sk-openai-key-7777");
  });

  test("a key of ≤4 characters reveals NOTHING through the mask", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setProviderKey(app.id, "groq", "abcd");
    await store.setProviderKey(app.id, "kilo", "xyz");
    const list = await store.listProviderKeys(app.id);
    expect(list).toEqual([
      { provider: "groq", last4: "", updated_at: expect.any(String) },
      { provider: "kilo", last4: "", updated_at: expect.any(String) },
    ]);
    expect(JSON.stringify(list)).not.toContain("abcd");
    expect(JSON.stringify(list)).not.toContain("xyz");
  });

  test("removeProviderKey removes once, then is an idempotent no-op", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    expect(await store.removeProviderKey(app.id, "anthropic")).toBe(true);
    expect(rawCount(db, "app_provider_keys")).toBe(0);
    expect(await store.removeProviderKey(app.id, "anthropic")).toBe(false);
    expect(await store.removeProviderKey(app.id, "never-stored")).toBe(false);
  });

  test("cross-App isolation: App X's config never contains App Y's keys (full-object assert)", async () => {
    const db = createAppConfigD1();
    const x = await seedApp(db, { slug: "app-x", createdBy: "mallory" });
    const y = await seedApp(db, { slug: "app-y", createdBy: "ada", githubAppId: 1002 });
    const store = configStore(db);
    await store.setProviderKey(x.id, "anthropic", "sk-x-anthropic-key-1111");
    await store.setProviderKey(y.id, "anthropic", "sk-y-anthropic-key-2222");
    await store.setProviderKey(y.id, "openai", "sk-y-openai-key-3333");
    const cfgX = await store.getAppConfig(x.id);
    expect(Object.keys(cfgX.keys)).toEqual(["anthropic"]);
    expect(cfgX.keys.anthropic).toBe("sk-x-anthropic-key-1111");
    const serialized = JSON.stringify(cfgX);
    expect(serialized).not.toContain("sk-y-anthropic-key-2222");
    expect(serialized).not.toContain("sk-y-openai-key-3333");
    // The masked list is scoped the same way.
    const listX = await store.listProviderKeys(x.id);
    expect(listX).toEqual([{ provider: "anthropic", last4: "1111", updated_at: expect.any(String) }]);
  });

  test("fresh insert: updated_at == created_at — one clock read for both (migration 0012)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const row = db.raw.query("SELECT created_at, updated_at FROM app_provider_keys").get() as {
      created_at: string;
      updated_at: string;
    };
    expect(row.updated_at).toMatch(SQLITE_TS_RE);
    expect(row.updated_at).toBe(row.created_at);
  });

  test("re-set bumps updated_at forward (the upsert writes a fresh clock on conflict)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setProviderKey(app.id, "anthropic", "sk-v1-aaaa");
    // Backdate the row so the second write's clock is observably LATER.
    rawRun(
      db,
      "UPDATE app_provider_keys SET created_at = '2026-01-01 00:00:00', updated_at = '2026-01-01 00:00:00' WHERE app_id = ? AND provider = 'anthropic'",
      app.id,
    );
    await store.setProviderKey(app.id, "anthropic", "sk-v2-bbbb");
    const row = db.raw.query("SELECT created_at, updated_at FROM app_provider_keys").get() as {
      created_at: string;
      updated_at: string;
    };
    expect(row.updated_at).toMatch(SQLITE_TS_RE);
    expect(row.updated_at).toBe(row.created_at); // conflict path: same single-clock read
    expect(row.updated_at > "2026-01-01 00:00:00").toBe(true); // same-format string compare
    // The masked list reflects the moved timestamp.
    const list = await store.listProviderKeys(app.id);
    expect(list).toEqual([{ provider: "anthropic", last4: "bbbb", updated_at: row.updated_at }]);
  });

  test("listProviderKeys returns updated_at per row; a pre-0012 row reads NULL until re-set", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    await store.setProviderKey(app.id, "kilo", "sk-kilo-key-1234");
    // The legacy shape: a pre-0012 row whose updated_at is NULL.
    rawRun(db, "UPDATE app_provider_keys SET updated_at = NULL WHERE provider = 'kilo'");
    const list = await store.listProviderKeys(app.id);
    expect(list).toHaveLength(2);
    // provider-ascending: anthropic (current) then kilo (legacy placeholder).
    expect(list[0]).toEqual({ provider: "anthropic", last4: "9988", updated_at: expect.stringMatching(SQLITE_TS_RE) });
    expect(list[1]).toEqual({ provider: "kilo", last4: "1234", updated_at: null });
  });

  test("setProviderKey accepts a key of exactly 4096 characters (the bound is inclusive)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    await configStore(db).setProviderKey(app.id, "anthropic", "k".repeat(MAX_PROVIDER_KEY_LENGTH));
    expect(rawCount(db, "app_provider_keys")).toBe(1);
  });

  test("setProviderKey rejects a key over 4096 characters with the typed error — zero rows written", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    await expect(
      configStore(db).setProviderKey(app.id, "anthropic", "k".repeat(MAX_PROVIDER_KEY_LENGTH + 1)),
    ).rejects.toThrow(ProviderKeyTooLongError);
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });
});

// --- store: model chain + full config ---

describe("app-config store (createAppConfigStore) — model chain + getAppConfig", () => {
  test("setModelChain stores VERBATIM (spaces and :thinking suffixes untouched); getModelChain reads it back", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    await configStore(db).setModelChain(app.id, PLAIN_CHAIN);
    expect(await configStore(db).getModelChain(app.id)).toBe(PLAIN_CHAIN);
    const row = db.raw.query("SELECT model_chain, updated_at FROM app_model_config").get() as {
      model_chain: string | null;
      updated_at: string;
    };
    expect(row.model_chain).toBe(PLAIN_CHAIN); // plaintext by design — not a secret
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("setModelChain upserts: a second save replaces the chain", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "first/model");
    await store.setModelChain(app.id, "second/model");
    expect(rawCount(db, "app_model_config")).toBe(1);
    expect(await store.getModelChain(app.id)).toBe("second/model");
  });

  test("setModelChain(null) REMOVES the row (absent = unset = global fallback)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "first/model");
    await store.setModelChain(app.id, null);
    expect(rawCount(db, "app_model_config")).toBe(0);
    expect(await store.getModelChain(app.id)).toBeNull();
    // Clearing an app that never had a chain is a quiet no-op.
    await expect(store.setModelChain(app.id, null)).resolves.toBeUndefined();
  });

  test("setModelChain(\"\") CLEARS the row — same path as null (plan 15: empty = fallback)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "first/model");
    await store.setModelChain(app.id, "");
    expect(rawCount(db, "app_model_config")).toBe(0);
    expect(await store.getModelChain(app.id)).toBeNull();
    // Clearing an app with no stored chain is a quiet no-op, like null.
    await expect(store.setModelChain(app.id, "")).resolves.toBeUndefined();
  });

  test("a whitespace-only chain is blank = clear; a padded real chain upserts VERBATIM", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    // Route semantics (空 = 清除, raw.trim() === "") aligned at the store: a
    // blank chain never lands as a row, whatever the caller passed.
    await store.setModelChain(app.id, "   ");
    expect(rawCount(db, "app_model_config")).toBe(0);
    expect(await store.getModelChain(app.id)).toBeNull();
    // Interior/trailing whitespace in a chain WITH content is configuration —
    // stored exactly as given (the runner-side selector parse trims segments).
    const padded = "  openai/gpt-5 , anthropic/claude-x  ";
    await store.setModelChain(app.id, padded);
    expect(await store.getModelChain(app.id)).toBe(padded);
  });

  test("getAppConfig returns the decrypted keys + chain; an app without config is an EMPTY config", async () => {
    const db = createAppConfigD1();
    const bare = await seedApp(db, { slug: "bare", createdBy: "mallory" });
    // Zero-config compatibility: the consumer falls back to global env.
    expect(await configStore(db).getAppConfig(bare.id)).toEqual({
      appId: bare.id,
      keys: {},
      modelChain: null,
    });
    const configured = await seedApp(db, { slug: "full", createdBy: "ada", githubAppId: 1002 });
    const store = configStore(db);
    await store.setProviderKey(configured.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    await store.setModelChain(configured.id, PLAIN_CHAIN);
    const cfg = await store.getAppConfig(configured.id);
    expect(cfg).toEqual({
      appId: configured.id,
      keys: { anthropic: PLAIN_ANTHROPIC_KEY },
      modelChain: PLAIN_CHAIN,
    });
  });

  test("tampered ciphertext is a loud throw, never a silent skip", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    rawRun(db, "UPDATE app_provider_keys SET key_enc = 'v1.primary.aXZpdi.dGFtcGVyZWQ='");
    await expect(store.listProviderKeys(app.id)).rejects.toThrow(/secretbox/);
    await expect(store.getAppConfig(app.id)).rejects.toThrow(/secretbox/);
  });
});

// --- store: model roles (plan 17 B6) ---

describe("app-config store (createAppConfigStore) — model roles (plan 17 T1)", () => {
  test("setModelRole stores VERBATIM (:thinking suffix and padding untouched); getAppModelRoles reads it back", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelRole(app.id, "mstar-review-seat", "  ark-plan/deepseek-v4-flash:high ");
    await store.setModelRole(app.id, "code-reviewer", "openai/gpt-5:thinking, anthropic/claude-x");
    // Only the MAPPED roles appear; selectors come back exactly as stored.
    expect(await store.getAppModelRoles(app.id)).toEqual({
      "code-reviewer": "openai/gpt-5:thinking, anthropic/claude-x",
      "mstar-review-seat": "  ark-plan/deepseek-v4-flash:high ",
    });
    const row = db.raw.query("SELECT app_id, role, selector FROM app_model_roles WHERE role = 'mstar-review-seat'").get() as {
      app_id: string;
      role: string;
      selector: string;
    };
    expect(row.selector).toBe("  ark-plan/deepseek-v4-flash:high "); // plaintext by design — not a secret
    expect(row.app_id).toBe(app.id);
  });

  test("setModelRole upserts: a second save replaces the selector (one row per (app_id, role))", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelRole(app.id, "fullstack-dev", "first/model");
    await store.setModelRole(app.id, "fullstack-dev", "second/model");
    expect(rawCount(db, "app_model_roles")).toBe(1);
    expect(await store.getAppModelRoles(app.id)).toEqual({ "fullstack-dev": "second/model" });
  });

  test('setModelRole(role, "") CLEARS the mapping; clearing an unmapped role is a quiet no-op', async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelRole(app.id, "frontend-dev", "first/model");
    await store.setModelRole(app.id, "frontend-dev", "");
    expect(rawCount(db, "app_model_roles")).toBe(0);
    expect(await store.getAppModelRoles(app.id)).toEqual({});
    // Clearing a role that never had a mapping resolves without error.
    await expect(store.setModelRole(app.id, "frontend-dev", "")).resolves.toBeUndefined();
  });

  test("a whitespace-only selector is blank = clear; a padded real selector upserts VERBATIM", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    // The setModelChain 空 = 清除 convention aligned at the store: a blank
    // selector never lands as a row, whatever the caller passed.
    await store.setModelRole(app.id, "code-reviewer", "   ");
    expect(rawCount(db, "app_model_roles")).toBe(0);
    // Interior/trailing whitespace in a selector WITH content is
    // configuration — stored exactly as given (the runner-side parse trims).
    const padded = "  openai/gpt-5 , anthropic/claude-x  ";
    await store.setModelRole(app.id, "code-reviewer", padded);
    expect(await store.getAppModelRoles(app.id)).toEqual({ "code-reviewer": padded });
  });

  test("clearModelRole removes the row, then is an idempotent no-op like the blank-selector path", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelRole(app.id, "code-reviewer", "openai/gpt-5");
    await store.clearModelRole(app.id, "code-reviewer");
    expect(rawCount(db, "app_model_roles")).toBe(0);
    await expect(store.clearModelRole(app.id, "code-reviewer")).resolves.toBeUndefined();
    await expect(store.clearModelRole(app.id, "never-stored-role-name")).rejects.toThrow(
      UnknownModelRoleError,
    );
  });

  test("off-vocabulary role → UnknownModelRoleError, zero rows written (setModelRole/clearModelRole/setModelRoles)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    for (const role of ["reviewer", "smol", "mstar-review-seat "]) {
      await expect(store.setModelRole(app.id, role, "openai/gpt-5")).rejects.toThrow(UnknownModelRoleError);
      await expect(store.clearModelRole(app.id, role)).rejects.toThrow(UnknownModelRoleError);
      await expect(store.setModelRoles(app.id, { [role]: "openai/gpt-5" })).rejects.toThrow(UnknownModelRoleError);
    }
    // Even a VALID role is rejected when it rides an invalid map entry.
    await expect(
      store.setModelRoles(app.id, { "code-reviewer": "openai/gpt-5", reviewer: "openai/gpt-5" }),
    ).rejects.toThrow(UnknownModelRoleError);
    expect(rawCount(db, "app_model_roles")).toBe(0);
  });

  test("content-bearing selector that parses to zero selectors → InvalidModelSelectorError, zero rows written", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    for (const selector of [",, ,", " , , ,"]) {
      await expect(store.setModelRole(app.id, "code-reviewer", selector)).rejects.toThrow(
        InvalidModelSelectorError,
      );
    }
    expect(rawCount(db, "app_model_roles")).toBe(0);
  });

  test("setModelRoles saves the full map in one call; one bad entry fails BEFORE any write", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    // The settings single-save face (plan 17 T3): all four rows at once,
    // blank entries clearing their role.
    await store.setModelRole(app.id, "code-reviewer", "old/model");
    await store.setModelRoles(app.id, {
      "mstar-review-seat": "ark-plan/deepseek-v4-flash:high",
      "code-reviewer": "", // cleared by the same save
      "fullstack-dev": "openai/gpt-5",
      "frontend-dev": "",
    });
    expect(await store.getAppModelRoles(app.id)).toEqual({
      "fullstack-dev": "openai/gpt-5",
      "mstar-review-seat": "ark-plan/deepseek-v4-flash:high",
    });
    // Validation is whole-map-first: the valid entry in this map must NOT
    // reach the DB — zero rows touched by the failed call.
    await expect(
      store.setModelRoles(app.id, { "frontend-dev": "x/y", "code-reviewer": ",," }),
    ).rejects.toThrow(InvalidModelSelectorError);
    expect(rawCount(db, "app_model_roles")).toBe(2);
  });

  test("setModelRoles is ONE atomic batch: a batch failure leaves ZERO rows changed (Phase 5, PR #7 review)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelRole(app.id, "code-reviewer", "old/model");
    const failing = createBatchRejectingD1(db);
    await expect(
      configStore(failing).setModelRoles(app.id, {
        "mstar-review-seat": "new/model",
        "code-reviewer": "", // blank = clear — must not land either
      }),
    ).rejects.toThrow(/simulated D1 batch failure/);
    // The whole map rides ONE batch — there is no sequential-apply path.
    expect(failing.batchCalls()).toBe(1);
    // Atomic: the pre-existing row is untouched — nothing half-applied.
    expect(await configStore(db).getAppModelRoles(app.id)).toEqual({ "code-reviewer": "old/model" });
    expect(rawCount(db, "app_model_roles")).toBe(1);
  });

  test("getAppModelRoles on an app with no roles is an EMPTY map (= the chain behavior)", async () => {
    const db = createAppConfigD1();
    const bare = await seedApp(db, { slug: "bare", createdBy: "mallory" });
    expect(await configStore(db).getAppModelRoles(bare.id)).toEqual({});
  });

  test("cross-App isolation: App X's role map never contains App Y's roles (full-object assert)", async () => {
    const db = createAppConfigD1();
    const x = await seedApp(db, { slug: "app-x", createdBy: "mallory" });
    const y = await seedApp(db, { slug: "app-y", createdBy: "ada", githubAppId: 1002 });
    const store = configStore(db);
    await store.setModelRole(x.id, "code-reviewer", "openai/gpt-x");
    await store.setModelRole(y.id, "mstar-review-seat", "anthropic/claude-y");
    expect(await store.getAppModelRoles(x.id)).toEqual({ "code-reviewer": "openai/gpt-x" });
    expect(await store.getAppModelRoles(y.id)).toEqual({ "mstar-review-seat": "anthropic/claude-y" });
  });

  test("unknown app_id → FK violation on insert (fail-loud, same as every write here)", async () => {
    const db = createAppConfigD1();
    await expect(
      configStore(db).setModelRole("no-such-app", "code-reviewer", "openai/gpt-5"),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});

// --- store: custom providers (plan 23 T2) ---

describe("app-config store (createAppConfigStore) — custom providers (plan 23 T2)", () => {
  const CUSTOM: AppCustomProvider = {
    provider_id: "ark",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
    model_ids: ["deepseek-v4-flash", "deepseek-r1"],
  };
  const PLAIN_CUSTOM_KEY = "sk-custom-ark-9988";

  test("upsert encrypts the key at rest (secretbox envelope) and list returns the declaration with NO key material", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    // At rest: a secretbox envelope, never the plaintext.
    const row = db.raw
      .query("SELECT * FROM app_custom_providers WHERE app_id = ? AND provider_id = ?")
      .get(app.id, CUSTOM.provider_id) as {
      api_key_enc: string;
      model_ids: string;
      created_at: string;
      updated_at: string;
    };
    expect(row.api_key_enc).toMatch(/^v1\.primary\./);
    expect(row.api_key_enc).not.toContain(PLAIN_CUSTOM_KEY);
    // model_ids is stored as a TEXT JSON array (AL-23-1 DDL).
    expect(JSON.parse(row.model_ids)).toEqual([...CUSTOM.model_ids]);
    expect(row.created_at).toMatch(SQLITE_TS_RE);
    expect(row.updated_at).toBe(row.created_at);
    // The list face is decrypt-free: declaration only, never key material.
    await expect(configStore(db).listCustomProviders(app.id)).resolves.toEqual([CUSTOM]);
  });

  test("AAD rowKey is the exact composite string app_custom_providers.api_key_enc:<app_id>:<provider_id> — the T3 consumer decrypts with it", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    const row = db.raw
      .query("SELECT api_key_enc FROM app_custom_providers WHERE app_id = ? AND provider_id = ?")
      .get(app.id, CUSTOM.provider_id) as { api_key_enc: string };
    const box = createSecretbox(TEST_KEY);
    // The exact composite-PK rowKey (0006 L1 precedent) decrypts the envelope.
    await expect(
      box.decryptSecret(row.api_key_enc, `app_custom_providers.api_key_enc:${app.id}:${CUSTOM.provider_id}`),
    ).resolves.toBe(PLAIN_CUSTOM_KEY);
    // The envelope is bound to BOTH PK columns — any single component off fails.
    await expect(
      box.decryptSecret(row.api_key_enc, `app_custom_providers.api_key_enc:${app.id}:other`),
    ).rejects.toThrow();
    await expect(
      box.decryptSecret(row.api_key_enc, `app_custom_providers.api_key_enc:other:${CUSTOM.provider_id}`),
    ).rejects.toThrow();
  });

  test("re-upserting the same provider_id replaces the key and the declaration, bumping updated_at", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    db.raw
      .prepare("UPDATE app_custom_providers SET updated_at = '2026-01-01 00:00:00' WHERE app_id = ? AND provider_id = ?")
      .run(app.id, CUSTOM.provider_id);
    await configStore(db).upsertCustomProvider(
      app.id,
      { ...CUSTOM, model_ids: ["deepseek-v4-flash"] },
      "sk-custom-ark-7777",
    );
    const row = db.raw
      .query("SELECT api_key_enc, model_ids, updated_at FROM app_custom_providers WHERE app_id = ? AND provider_id = ?")
      .get(app.id, CUSTOM.provider_id) as { api_key_enc: string; model_ids: string; updated_at: string };
    await expect(
      createSecretbox(TEST_KEY).decryptSecret(row.api_key_enc, `app_custom_providers.api_key_enc:${app.id}:${CUSTOM.provider_id}`),
    ).resolves.toBe("sk-custom-ark-7777");
    expect(JSON.parse(row.model_ids)).toEqual(["deepseek-v4-flash"]);
    expect(row.updated_at).toMatch(SQLITE_TS_RE);
    expect(row.updated_at > "2026-01-01 00:00:00").toBe(true);
  });

  test("removeCustomProvider deletes the row and reports it; an unknown id is an idempotent no-op", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    await expect(configStore(db).removeCustomProvider(app.id, "nope")).resolves.toBe(false);
    await expect(configStore(db).removeCustomProvider(app.id, CUSTOM.provider_id)).resolves.toBe(true);
    await expect(configStore(db).listCustomProviders(app.id)).resolves.toEqual([]);
    await expect(configStore(db).removeCustomProvider(app.id, CUSTOM.provider_id)).resolves.toBe(false);
  });

  test("store backstop: an invalid declaration throws InvalidCustomProviderError before any write", async () => {
    const { db, app } = await seededWorld();
    // Record<string, unknown> so the enum-violating api literal type-checks;
    // the spread is cast to AppCustomProvider at the call site.
    const bad: Array<Record<string, unknown>> = [
      { provider_id: "Bad_ID" }, // uppercase — outside [a-z0-9][a-z0-9-]{0,63}
      { provider_id: "-lead" }, // leading hyphen
      { provider_id: "x".repeat(65) }, // over 64 chars
      { provider_id: "anthropic" }, // collides with a PROVIDER_IDS built-in (copy says NON-built-in)
      { base_url: "http://insecure.example.com" }, // http, not https
      { base_url: `https://example.com/${"x".repeat(2049)}` }, // over 2048 chars
      { api: "google-vertex" }, // outside the AL-23-1 three-form enum
      { model_ids: [] }, // empty
      { model_ids: ["ok", " "] }, // blank model id entry
      { model_ids: ["ok", "   "] }, // whitespace-only model id entry
      { model_ids: ["ok", "x".repeat(129)] }, // over-length model id
      { model_ids: Array.from({ length: 33 }, (_, i) => `m${i}`) }, // over 32 items
    ];
    for (const patch of bad) {
      await expect(
        configStore(db).upsertCustomProvider(app.id, { ...CUSTOM, ...patch } as AppCustomProvider, PLAIN_CUSTOM_KEY),
      ).rejects.toThrow(InvalidCustomProviderError);
    }
    // The key is required at declaration and bounded by the existing 4096 cap.
    await expect(configStore(db).upsertCustomProvider(app.id, CUSTOM, "")).rejects.toThrow(InvalidCustomProviderError);
    await expect(configStore(db).upsertCustomProvider(app.id, CUSTOM, "k".repeat(4097))).rejects.toThrow(ProviderKeyTooLongError);
    expect(rawCount(db, "app_custom_providers")).toBe(0);
  });

  // QC wave-1 (seat3 W-1): the runner's base-wins merge skips a custom id
  // colliding with the IN-IMAGE base models.yml (sandbox-image/omp-models.yml
  // declares ark-plan) while the consumer STILL injects its key — the
  // declaration is silently dead on every review, so the backstop refuses it.
  test("store backstop: an in-image base provider id (ark-plan) throws InvalidCustomProviderError before any write", async () => {
    const { db, app } = await seededWorld();
    await expect(
      configStore(db).upsertCustomProvider(
        app.id,
        { ...CUSTOM, provider_id: "ark-plan", base_url: "https://evil.example.com/" },
        PLAIN_CUSTOM_KEY,
      ),
    ).rejects.toThrow(InvalidCustomProviderError);
    expect(rawCount(db, "app_custom_providers")).toBe(0);
  });

  // QC wave-1 (seat3 W-2): every other AL-23-1/AL-23-2 input dimension is
  // bounded; the DECLARATION COUNT per App is the missing one (exec env +
  // runner input grow without bound). The cap is growth-only: updating an
  // existing declaration never counts against it.
  test("store backstop: at MAX_CUSTOM_PROVIDER_COUNT a NEW id throws; updating an existing id and another App are unaffected", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    for (let i = 1; i <= MAX_CUSTOM_PROVIDER_COUNT; i++) {
      await store.upsertCustomProvider(app.id, { ...CUSTOM, provider_id: `prov-${i}` }, PLAIN_CUSTOM_KEY);
    }
    expect(rawCount(db, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
    // Growth past the cap is refused with zero writes.
    await expect(
      store.upsertCustomProvider(app.id, { ...CUSTOM, provider_id: "prov-new" }, PLAIN_CUSTOM_KEY),
    ).rejects.toThrow(InvalidCustomProviderError);
    expect(rawCount(db, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
    // Re-declaring an EXISTING id is an update, not growth — allowed.
    await expect(
      store.upsertCustomProvider(app.id, { ...CUSTOM, provider_id: "prov-1", model_ids: ["fresh-model"] }, PLAIN_CUSTOM_KEY),
    ).resolves.toBeUndefined();
    expect(rawCount(db, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
    // The cap is per-App: a different App starts from zero.
    const other = await seededWorld();
    await expect(
      configStore(other.db).upsertCustomProvider(other.app.id, { ...CUSTOM, provider_id: "prov-1" }, PLAIN_CUSTOM_KEY),
    ).resolves.toBeUndefined();
    expect(rawCount(other.db, "app_custom_providers")).toBe(1);
  });

  test("unknown app_id → FK violation on insert (fail-loud, same as every write here)", async () => {
    const db = createAppConfigD1();
    await expect(
      configStore(db).upsertCustomProvider("no-such-app", CUSTOM, PLAIN_CUSTOM_KEY),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  test("getCustomProvidersForConsumer decrypts the key through the store face; a tampered row throws (fail-loud)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    // Upsert → consumer face → key matches (the Task 3 consume contract —
    // the round-trip goes through the store, not ad-hoc secretbox).
    await expect(store.getCustomProvidersForConsumer(app.id)).resolves.toEqual([
      { ...CUSTOM, api_key: PLAIN_CUSTOM_KEY },
    ]);
    // Tamper: flip the last base64 char of the stored envelope — the GCM
    // tag fails and the consumer face throws (never swallowed).
    const row = db.raw
      .query("SELECT api_key_enc FROM app_custom_providers WHERE app_id = ? AND provider_id = ?")
      .get(app.id, CUSTOM.provider_id) as { api_key_enc: string };
    const tampered = row.api_key_enc.slice(0, -1) + (row.api_key_enc.endsWith("A") ? "B" : "A");
    db.raw
      .prepare("UPDATE app_custom_providers SET api_key_enc = ? WHERE app_id = ? AND provider_id = ?")
      .run(tampered, app.id, CUSTOM.provider_id);
    await expect(store.getCustomProvidersForConsumer(app.id)).rejects.toThrow(/secretbox/);
  });

  test("listCustomProviders fails loud on a malformed model_ids row (non-array / non-string JSON)", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    for (const malformed of ["null", "{}", '"x"', "[1, \"ok\"]"]) {
      db.raw
        .prepare("UPDATE app_custom_providers SET model_ids = ? WHERE app_id = ? AND provider_id = ?")
        .run(malformed, app.id, CUSTOM.provider_id);
      await expect(configStore(db).listCustomProviders(app.id)).rejects.toThrow(/not a JSON array of strings/);
    }
  });
});

// --- duplication locks (Q2: dashboard may not import pipeline/review) ---

describe("duplication locks", () => {
  test("PROVIDER_IDS mirrors the pipeline PROVIDERS key sequence exactly", () => {
    expect([...PROVIDER_IDS]).toEqual(Object.keys(PROVIDERS));
    expect(PROVIDER_IDS).toHaveLength(18); // plan Scope: value domain locked to the 18 ids
  });

  test("parseModelChain behaves exactly like the runtime-omp parseModelSelectors", () => {
    const cases = [
      undefined,
      "",
      "   ",
      ",",
      " , ",
      "a,b",
      " a , b ",
      "a,,b",
      "ark-plan/deepseek-v4-flash",
      "openai/gpt-5:thinking, anthropic/claude-x",
      "x, ,y",
    ];
    for (const input of cases) {
      expect(parseModelChain(input)).toEqual(parseModelSelectors(input));
    }
  });

  test("MODEL_ROLE_IDS mirrors the review-side seat vocabulary exactly (plan 17 B6 parity lock)", () => {
    // quick/default seat: the frontmatter `name:` of the agent definition the
    // runtime installs for Bun fan-out (src/review/seat-agent.md — the real
    // seat-name SSOT on the review side).
    const seatAgent = readFileSync(join(import.meta.dir, "../../src/review/seat-agent.md"), "utf8");
    const quickSeat = /^name:\s*(\S+)\s*$/m.exec(seatAgent)?.[1];
    expect(quickSeat).toBe("mstar-review-seat");
    // Deep seats: DEEP_SEAT_ROLES is exported from runtime-omp since plan 17
    // Task 2 (the export exists for this parity lock; the dashboard's own
    // import boundary — Q2 — stays: src/dashboard still has zero review
    // imports, the mirror constant remains its SSOT).
    const deepSeats: readonly string[] = DEEP_SEAT_ROLES;
    expect(deepSeats).toEqual(["code-reviewer", "fullstack-dev", "frontend-dev"]);
    // The mirror is exactly the quick seat followed by the deep seats.
    expect([...MODEL_ROLE_IDS]).toEqual([quickSeat!, ...(deepSeats ?? [])]);
    expect(MODEL_ROLE_IDS).toHaveLength(4); // spec § B6 语义锁: exactly the 4 audit seats
  });

  test("IN_IMAGE_BASE_PROVIDER_IDS mirrors the in-image base models.yml provider ids (plan 23 QC W-1 parity lock)", () => {
    // SSOT: sandbox-image/omp-models.yml — installed in the runner image as
    // /opt/omp-agent/models.yml (src/review/models-synthesis.ts
    // BASE_MODELS_YAML_PATH), the base the Task 3 merge preserves verbatim.
    // A custom declaration colliding with one of these ids is skipped by the
    // base-wins merge (silently dead if the dashboard allowed it), so the
    // mirror MUST track the file exactly (the PROVIDER_IDS lock pattern).
    const baseYaml = readFileSync(join(import.meta.dir, "../../sandbox-image/omp-models.yml"), "utf8");
    const baseIds = [...baseYaml.matchAll(/^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/gm)].map((m) => m[1]!);
    expect(baseIds.length).toBeGreaterThan(0); // a base with no providers would make the mirror vacuous
    expect([...IN_IMAGE_BASE_PROVIDER_IDS]).toEqual(baseIds);
  });
});

// --- routes ---

describe("GET /dashboard/apps/:slug/settings", () => {
  test("guard covers the family: no session → 302 to login (GET and POST)", async () => {
    const { db } = await seededWorld();
    const getRes = await get(SETTINGS, "", makeEnv(db));
    expect(getRes.status).toBe(302);
    expect(getRes.headers.get("Location")).toBe("/dashboard/login");
    const postRes = await postForm(SETTINGS, "", makeEnv(db), { op: "add-key" });
    expect(postRes.status).toBe(302);
    expect(postRes.headers.get("Location")).toBe("/dashboard/login");
  });

  test("owner sees the masked list + chain editor — never plaintext key material", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    await store.setModelChain(app.id, PLAIN_CHAIN);
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    // Masked list (provider + last-4) and the chain prefilled verbatim.
    expect(body).toContain("<strong>anthropic</strong>");
    expect(body).toContain(`key ending <code class="id">9988</code>`);
    // Plan 23 T1 (migration 0012): the row also shows its last-update time —
    // a freshly stored key reads "just now".
    expect(body).toContain(`key ending <code class="id">9988</code> · updated just now`);
    expect(body).toContain(`value="${PLAIN_CHAIN}"`);
    // The zero-JS forms: add-key + save-chain on the pinned POST path, and
    // the per-key delete action path.
    expect(body).toContain('name="op" value="add-key"');
    expect(body).toContain('name="op" value="save-chain"');
    expect(body).toContain(`action="${SETTINGS}/key/delete"`);
    // NO full key material anywhere in the HTML.
    expect(body).not.toContain(PLAIN_ANTHROPIC_KEY);
    expect(body).not.toContain("key_enc");
  });

  test("plan 23 T1: a freshly stored key renders its last-update time in the masked row", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`key ending <code class="id">9988</code> · updated just now`);
  });

  test("plan 23 T1: a pre-0012 row (NULL updated_at) renders an em dash placeholder", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    rawRun(db, "UPDATE app_provider_keys SET updated_at = NULL WHERE app_id = ? AND provider = 'anthropic'", app.id);
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`key ending <code class="id">9988</code> · updated &mdash;`);
  });

  test("plan 23 T1: a hostile updated_at never renders raw — the meta degrades to the safe 'unknown' phrase", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    rawRun(
      db,
      "UPDATE app_provider_keys SET updated_at = '<img src=x onerror=alert(1)>' WHERE app_id = ? AND provider = 'anthropic'",
      app.id,
    );
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("<img");
    expect(body).not.toContain("onerror=alert(1)>");
    expect(body).toContain(`key ending <code class="id">9988</code> · updated unknown`);
  });

  test("non-owner member → 403; the owner of a DIFFERENT app → 403 (per-App scope)", async () => {
    const { db } = await seededWorld();
    for (const login of ["hubot", "ada"]) {
      const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie(login)}`, makeEnv(db));
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("restricted to dashboard admins");
    }
  });

  test("admin (non-creator) may read the settings — owner-or-admin", async () => {
    const { db } = await seededWorld();
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("octocat")}`, makeEnv(db));
    expect(res.status).toBe(200);
  });

  test("unknown slug → 404; soft-deleted app → 404", async () => {
    const { db, app } = await seededWorld();
    const missing = await get(
      "/dashboard/apps/no-such-app/settings",
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
    );
    expect(missing.status).toBe(404);
    await createAppsStore(db).softDeleteApp(app.id);
    const deleted = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    expect(deleted.status).toBe(404);
  });

  test("missing DASHBOARD_ENCRYPTION_KEY → 500 fail-closed, no page rendered", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const res = await get(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db, { DASHBOARD_ENCRYPTION_KEY: undefined }),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("9988");
  });
});

describe("POST /dashboard/apps/:slug/settings — add-key (op=add-key)", () => {
  test("owner stores a key: encrypted row lands, notice confirms, HTML shows only the mask", async () => {
    const { db, app } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: PLAIN_ANTHROPIC_KEY,
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Stored the anthropic key for mallorys-app");
    const row = db.raw
      .query("SELECT key_enc FROM app_provider_keys WHERE app_id = ? AND provider = 'anthropic'")
      .get(app.id) as { key_enc: string };
    expect(row.key_enc).toMatch(/^v1\.primary\./);
    // The response re-renders the page: masked tail only, never the plaintext.
    expect(body).toContain(`key ending <code class="id">9988</code>`);
    expect(body).not.toContain(PLAIN_ANTHROPIC_KEY);
  });

  test("unknown provider → 400 (allowlist), zero rows written", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "add-key",
      provider: "not-a-provider",
      key: "sk-whatever-1234",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not a supported provider");
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });

  test("empty provider (untouched placeholder) → 400 re-render, zero rows written", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "add-key",
      provider: "",
      key: PLAIN_ANTHROPIC_KEY,
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Pick a provider for the key.");
    // 400 is the full page re-render — the user can retry inline.
    expect(body).toContain('name="op" value="add-key"');
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });

  test("empty / whitespace-only key → 400, zero rows written", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    for (const key of ["", "   "]) {
      const res = await postForm(SETTINGS, cookie, makeEnv(db), {
        op: "add-key",
        provider: "anthropic",
        key,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Enter an API key");
    }
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });

  test("key over 4096 characters → 400 full-page re-render, zero rows written (plan 15 input bounds)", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: "k".repeat(MAX_PROVIDER_KEY_LENGTH + 1),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("limited to 4096 characters");
    // 400 is the full page re-render — the user can retry inline.
    expect(body).toContain('name="op" value="add-key"');
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });

  test("a key of exactly 4096 characters stores fine (the bound is inclusive)", async () => {
    const { db, app } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: "k".repeat(MAX_PROVIDER_KEY_LENGTH),
    });
    expect(res.status).toBe(200);
    const row = db.raw
      .query("SELECT key_enc FROM app_provider_keys WHERE app_id = ? AND provider = 'anthropic'")
      .get(app.id) as { key_enc: string };
    expect(row.key_enc).toMatch(/^v1\.primary\./);
  });

  test("non-owner member → 403, zero mutation; owner of a DIFFERENT app → 403", async () => {
    const { db } = await seededWorld();
    for (const login of ["hubot", "ada"]) {
      const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie(login)}`, makeEnv(db), {
        op: "add-key",
        provider: "anthropic",
        key: PLAIN_ANTHROPIC_KEY,
      });
      expect(res.status).toBe(403);
    }
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });

  test("admin (non-creator) may add a key — owner-or-admin", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("octocat")}`, makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: PLAIN_ANTHROPIC_KEY,
    });
    expect(res.status).toBe(200);
    expect(rawCount(db, "app_provider_keys")).toBe(1);
  });

  test("missing DASHBOARD_ENCRYPTION_KEY → 500 fail-closed, zero rows written", async () => {
    const { db } = await seededWorld();
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db, { DASHBOARD_ENCRYPTION_KEY: undefined }),
      { op: "add-key", provider: "anthropic", key: PLAIN_ANTHROPIC_KEY },
    );
    expect(res.status).toBe(500);
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });
});

describe("POST /dashboard/apps/:slug/settings — save-chain (op=save-chain)", () => {
  test("owner saves the chain: stored VERBATIM (spaces and :thinking suffix kept)", async () => {
    const { db, app } = await seededWorld();
    const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      op: "save-chain",
      model_chain: PLAIN_CHAIN,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Saved the model chain for mallorys-app");
    const row = db.raw
      .query("SELECT model_chain FROM app_model_config WHERE app_id = ?")
      .get(app.id) as { model_chain: string };
    expect(row.model_chain).toBe(PLAIN_CHAIN);
  });

  test("empty chain CLEARS the config (global fallback); a second save replaces", async () => {
    const { db, app } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const env = makeEnv(db);
    const clear = await postForm(SETTINGS, cookie, env, { op: "save-chain", model_chain: "" });
    expect(clear.status).toBe(200);
    expect(await clear.text()).toContain("Cleared the model chain for mallorys-app");
    expect(rawCount(db, "app_model_config")).toBe(0);
    // Then a real save replaces…
    await postForm(SETTINGS, cookie, env, { op: "save-chain", model_chain: "first/model" });
    expect(await configStore(db).getModelChain(app.id)).toBe("first/model");
    await postForm(SETTINGS, cookie, env, { op: "save-chain", model_chain: "second/model" });
    expect(await configStore(db).getModelChain(app.id)).toBe("second/model");
  });

  test("selector-less garbage (only commas/whitespace) → 400, zero rows written", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), { op: "save-chain", model_chain: " , ," });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("at least one comma-separated model selector");
    expect(rawCount(db, "app_model_config")).toBe(0);
  });

  test("chain over 400 chars → 400 re-render, zero rows written (AL-23-2 selector/chain cap)", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "save-chain",
      model_chain: "a".repeat(MAX_MODEL_SELECTOR_LENGTH + 1),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain(`limited to ${MAX_MODEL_SELECTOR_LENGTH}`);
    expect(rawCount(db, "app_model_config")).toBe(0);
  });

  test("a chain of exactly 400 chars saves (the bound is inclusive)", async () => {
    const { db, app } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "save-chain",
      model_chain: "a".repeat(MAX_MODEL_SELECTOR_LENGTH),
    });
    expect(res.status).toBe(200);
    expect(await configStore(db).getModelChain(app.id)).toBe("a".repeat(MAX_MODEL_SELECTOR_LENGTH));
  });

  test("a duplicate model_chain field → 400 re-render, zero rows written (never a silent clear)", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setModelChain(app.id, "existing/model");
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    // parseBody({ all: true }) aggregates duplicate keys into an array — the
    // handler must reject, never treat the array as an empty clear.
    const res = await worker.fetch(
      new Request(`https://worker.local${SETTINGS}`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: "op=save-chain&model_chain=first/model&model_chain=second/model",
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("submitted more than once");
    // The stored chain is untouched — the duplicate was never a clear.
    expect(await configStore(db).getModelChain(app.id)).toBe("existing/model");
  });

  test("non-owner member → 403, zero mutation", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, makeEnv(db), {
      op: "save-chain",
      model_chain: "ark-plan/deepseek-v4-flash",
    });
    expect(res.status).toBe(403);
    expect(rawCount(db, "app_model_config")).toBe(0);
  });

  test("unknown op → 400 re-rendered as the HTML page (T2 fold: consistent with other validation failures)", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      op: "something-else",
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Unknown settings operation");
  });
});

// --- plan 17 T3: the Role models editor (settings op save-roles) ---

/**
 * The exact body the Role models editor posts: the hidden op plus one
 * role_<role> field per MODEL_ROLE_IDS seat (blank = clear), plus any
 * `extra` fields for the tampering cases.
 */
function roleForm(
  values: Record<string, string>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const fields: Record<string, string> = { op: "save-roles" };
  for (const role of MODEL_ROLE_IDS) fields[`role_${role}`] = values[role] ?? "";
  return { ...fields, ...extra };
}

describe("Role models editor (plan 17 T3 — view + save-roles op)", () => {
  test("GET renders the 4 seat rows prefilled from the stored map (unmapped = blank), one blue-700 save, empty = chain copy", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setModelRole(app.id, "code-reviewer", "openai/gpt-5:thinking");
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    // The section: heading, copy, hidden op, single blue-700 save.
    expect(body).toContain("<h2>Role models</h2>");
    expect(body).toContain("Empty = use the App model chain.");
    expect(body).toContain('name="op" value="save-roles"');
    expect(body).toContain('<button type="submit" class="primary">Save role models</button>');
    expect(body.match(/Save role models</g)).toHaveLength(1);
    // The 4 rows, prefilled / blank exactly per the stored map.
    expect(body).toContain('name="role_mstar-review-seat" value=""');
    expect(body).toContain('name="role_code-reviewer" value="openai/gpt-5:thinking"');
    expect(body).toContain('name="role_fullstack-dev" value=""');
    expect(body).toContain('name="role_frontend-dev" value=""');
    // Rows render in MODEL_ROLE_IDS order (the quick/default seat first).
    const seat = body.indexOf('name="role_mstar-review-seat"');
    expect(seat).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('name="role_code-reviewer"')).toBeGreaterThan(seat);
  });

  test("owner saves the map: stored VERBATIM (:thinking suffix and padding kept), success notice, editor re-rendered", async () => {
    const { db, app } = await seededWorld();
    const padded = "  openai/gpt-5 , anthropic/claude-x  ";
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      roleForm({
        "mstar-review-seat": "ark-plan/deepseek-v4-flash:high",
        "code-reviewer": padded,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Saved the role models for mallorys-app");
    expect(body).toContain('name="op" value="save-roles"');
    expect(await configStore(db).getAppModelRoles(app.id)).toEqual({
      "mstar-review-seat": "ark-plan/deepseek-v4-flash:high",
      "code-reviewer": padded,
    });
  });

  test("one save maps AND clears: blanks = cleared, content = upserted (full-map editor semantics)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.setModelRole(app.id, "code-reviewer", "old/model");
    await store.setModelRole(app.id, "frontend-dev", "old-2/model");
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      roleForm({
        "mstar-review-seat": "new/model",
        // code-reviewer / frontend-dev posted blank → cleared by the same save
      }),
    );
    expect(res.status).toBe(200);
    expect(await store.getAppModelRoles(app.id)).toEqual({ "mstar-review-seat": "new/model" });
  });

  test("a D1 batch failure mid-save → 500 re-render, truthful 'nothing was stored' notice, ZERO rows changed (Phase 5, PR #7 review)", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setModelRole(app.id, "code-reviewer", "old/model");
    const failing = createBatchRejectingD1(db);
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(failing),
      roleForm({ "mstar-review-seat": "new/model", "code-reviewer": "" }),
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    // With the atomic batch the pre-existing copy is now TRUE — a failed
    // save genuinely stored nothing.
    expect(body).toContain("The dashboard database rejected the change — nothing was stored.");
    // The 500 is the full page re-render showing the TRUE stored state.
    expect(body).toContain('name="role_code-reviewer" value="old/model"');
    // Atomic: the store state is exactly as before the failed save.
    expect(await configStore(db).getAppModelRoles(app.id)).toEqual({ "code-reviewer": "old/model" });
    expect(rawCount(db, "app_model_roles")).toBe(1);
  });

  test("an all-blank save clears every mapping (empty = the App model chain)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.setModelRole(app.id, "code-reviewer", "old/model");
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      roleForm({}),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Saved the role models for mallorys-app");
    expect(rawCount(db, "app_model_roles")).toBe(0);
    expect(await store.getAppModelRoles(app.id)).toEqual({});
  });

  test("invalid selector grammar → 400 re-render naming the role, zero rows written (validate-all-first)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.setModelRole(app.id, "code-reviewer", "old/model");
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      roleForm({
        "mstar-review-seat": "new/model",
        "code-reviewer": " , ,",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("<!doctype html>"); // HTML page, never a plain-text 400
    expect(body).toContain("The code-reviewer selector needs at least one comma-separated model selector");
    // Zero partial writes: the valid entry never landed, the old row is intact.
    expect(await store.getAppModelRoles(app.id)).toEqual({ "code-reviewer": "old/model" });
  });

  test("a tampered role_<unknown> field → 400 re-render, zero rows written", async () => {
    const { db, app } = await seededWorld();
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      roleForm({ "code-reviewer": "openai/gpt-5" }, { role_root: "evil/model" }),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("root is not a known review role");
    expect(rawCount(db, "app_model_roles")).toBe(0);
  });
  test("a duplicate role_* field → 400 re-render, zero rows written (AL-23-2 explicit rejection)", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setModelRole(app.id, "code-reviewer", "old/model");
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    // parseBody({ all: true }) aggregates duplicate keys into an array — the
    // handler must reject the duplicate explicitly, never silently last-wins.
    const res = await worker.fetch(
      new Request(`https://worker.local${SETTINGS}`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: "op=save-roles&role_code-reviewer=openai/gpt-5&role_code-reviewer=anthropic/claude-x",
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("submitted more than once");
    // Zero writes: the pre-existing mapping survives untouched.
    expect(await configStore(db).getAppModelRoles(app.id)).toEqual({ "code-reviewer": "old/model" });
    expect(rawCount(db, "app_model_roles")).toBe(1);
  });

  test("a role selector over 400 chars → 400 re-render, zero rows written (AL-23-2 selector cap)", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setModelRole(app.id, "code-reviewer", "old/model");
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      roleForm({ "code-reviewer": "a".repeat(MAX_MODEL_SELECTOR_LENGTH + 1) }),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain(`limited to ${MAX_MODEL_SELECTOR_LENGTH}`);
    // Zero partial writes: the valid entries never landed, the old row is intact.
    expect(await configStore(db).getAppModelRoles(app.id)).toEqual({ "code-reviewer": "old/model" });
  });

  test("a save with NO role fields at all → 400 re-render, zero rows written (never a silent no-op)", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setModelRole(app.id, "code-reviewer", "old/model");
    const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      op: "save-roles",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("No role selectors were submitted");
    // The existing mapping survives — an empty map was never saved.
    expect(await configStore(db).getAppModelRoles(app.id)).toEqual({ "code-reviewer": "old/model" });
  });

  test("non-owner member → 403, zero mutation; admin (non-creator) may save — owner-or-admin", async () => {
    const { db } = await seededWorld();
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("hubot")}`,
      makeEnv(db),
      roleForm({ "code-reviewer": "openai/gpt-5" }),
    );
    expect(res.status).toBe(403);
    expect(rawCount(db, "app_model_roles")).toBe(0);
    const adminRes = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("octocat")}`,
      makeEnv(db),
      roleForm({ "code-reviewer": "openai/gpt-5" }),
    );
    expect(adminRes.status).toBe(200);
    expect(rawCount(db, "app_model_roles")).toBe(1);
  });

  test("a stored selector with HTML-special characters renders escaped in the role input (attribute context)", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setModelRole(app.id, "code-reviewer", '"><script>alert(1)</script>');
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain(`name="role_code-reviewer" value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"`);
  });
});

describe("POST /dashboard/apps/:slug/settings/key/delete (delete-key route)", () => {
  test("owner removes a stored key: row gone, notice confirms", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const res = await postForm(SETTINGS + "/key/delete", `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      provider: "anthropic",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Removed the stored anthropic key for mallorys-app");
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });

  test("removing a never-stored provider is a tolerant warn — zero mutation", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const res = await postForm(SETTINGS + "/key/delete", `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      provider: "openai",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("nothing changed");
    expect(rawCount(db, "app_provider_keys")).toBe(1);
  });

  test("non-owner member → 403, zero mutation", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const res = await postForm(SETTINGS + "/key/delete", `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, makeEnv(db), {
      provider: "anthropic",
    });
    expect(res.status).toBe(403);
    expect(rawCount(db, "app_provider_keys")).toBe(1);
  });

  test("admin (non-creator) may remove a key — owner-or-admin", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const res = await postForm(SETTINGS + "/key/delete", `${SESSION_COOKIE}=${await sessionCookie("octocat")}`, makeEnv(db), {
      provider: "anthropic",
    });
    expect(res.status).toBe(200);
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });
});

// --- plan 23 T2: custom provider declarations (settings ops) ---

describe("POST /dashboard/apps/:slug/settings — custom providers (op=add-custom-provider / remove-custom-provider, plan 23 T2)", () => {
  const CUSTOM_FORM: Record<string, string> = {
    op: "add-custom-provider",
    provider_id: "ark",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
    model_ids: "deepseek-v4-flash, deepseek-r1",
    key: "sk-custom-ark-9988",
  };
  const mallory = async () => `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;

  test("add stores the declaration (key encrypted at rest) and re-renders the page with it listed", async () => {
    const { db, app } = await seededWorld();
    const res = await postForm(SETTINGS, await mallory(), makeEnv(db), CUSTOM_FORM);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Custom providers");
    expect(body).toContain("<strong>ark</strong>");
    expect(body).toContain("deepseek-v4-flash");
    const row = db.raw
      .query("SELECT api_key_enc FROM app_custom_providers WHERE app_id = ? AND provider_id = 'ark'")
      .get(app.id) as { api_key_enc: string };
    expect(row.api_key_enc).toMatch(/^v1\.primary\./);
    expect(row.api_key_enc).not.toContain("sk-custom-ark-9988");
  });

  test("400 matrix: bad id / http baseUrl / enum-violating api / empty model_ids / over-length — zero writes", async () => {
    const { db } = await seededWorld();
    const cases: Array<{ patch: Record<string, string>; label: string }> = [
      { patch: { provider_id: "Bad_ID" }, label: "uppercase id" },
      { patch: { provider_id: "-lead" }, label: "leading hyphen" },
      { patch: { provider_id: "x".repeat(65) }, label: "id over 64 chars" },
      { patch: { provider_id: "anthropic" }, label: "built-in provider id collision" },
      { patch: { provider_id: "ark-plan" }, label: "in-image base provider id collision (QC W-1)" },
      { patch: { base_url: "http://insecure.example.com" }, label: "http baseUrl" },
      { patch: { base_url: `https://example.com/${"x".repeat(2049)}` }, label: "baseUrl over 2048 chars" },
      { patch: { api: "google-vertex" }, label: "api outside the AL-23-1 enum" },
      { patch: { model_ids: "  ,  " }, label: "empty model_ids" },
      { patch: { model_ids: `ok, ${"x".repeat(129)}` }, label: "model id over 128 chars" },
      { patch: { model_ids: Array.from({ length: 33 }, (_, i) => `m${i}`).join(",") }, label: "over 32 model ids" },
      { patch: { key: "" }, label: "empty key" },
      { patch: { key: "k".repeat(4097) }, label: "key over 4096 chars" },
    ];
    for (const { patch, label } of cases) {
      const res = await postForm(SETTINGS, await mallory(), makeEnv(db), { ...CUSTOM_FORM, ...patch });
      expect(res.status, label).toBe(400);
    }
    expect(rawCount(db, "app_custom_providers")).toBe(0);
  });

  test("400: a NEW declaration beyond the 8-provider cap → 400 re-render, zero writes; filling the cap and updating an existing id stay allowed (QC W-2)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    // A local declaration fixture (the store describe's CUSTOM is scoped
    // there; the route describe carries CUSTOM_FORM instead).
    const decl = (providerId: string): AppCustomProvider => ({
      provider_id: providerId,
      base_url: "https://ark.cn-beijing.volces.com/api/v3",
      api: "openai-completions",
      model_ids: ["deepseek-v4-flash"],
    });
    // The bound is inclusive: with 7 declared, the 8th NEW id is allowed.
    for (let i = 1; i < MAX_CUSTOM_PROVIDER_COUNT; i++) {
      await store.upsertCustomProvider(app.id, decl(`prov-${i}`), "sk-custom-ark-9988");
    }
    const fill = await postForm(SETTINGS, await mallory(), makeEnv(db), { ...CUSTOM_FORM, provider_id: "prov-8" });
    expect(fill.status).toBe(200);
    expect(rawCount(db, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
    // A 9th NEW id → 400 with a cap message, zero writes.
    const over = await postForm(SETTINGS, await mallory(), makeEnv(db), { ...CUSTOM_FORM, provider_id: "prov-9" });
    expect(over.status).toBe(400);
    expect(await over.text()).toContain("custom providers");
    expect(rawCount(db, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
    // Updating an EXISTING declaration at the cap stays allowed (no growth).
    const update = await postForm(SETTINGS, await mallory(), makeEnv(db), {
      ...CUSTOM_FORM,
      provider_id: "prov-1",
      model_ids: "fresh-model",
    });
    expect(update.status).toBe(200);
    expect(rawCount(db, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
  });

  test("remove-custom-provider deletes the row; an unknown id is a tolerant no-op", async () => {
    const { db } = await seededWorld();
    await postForm(SETTINGS, await mallory(), makeEnv(db), CUSTOM_FORM);
    const res = await postForm(SETTINGS, await mallory(), makeEnv(db), {
      op: "remove-custom-provider",
      provider_id: "ark",
    });
    expect(res.status).toBe(200);
    expect(rawCount(db, "app_custom_providers")).toBe(0);
    const noop = await postForm(SETTINGS, await mallory(), makeEnv(db), {
      op: "remove-custom-provider",
      provider_id: "ghost",
    });
    expect(noop.status).toBe(200);
    expect(await noop.text()).toContain("nothing changed");
  });

  test("non-owner member → 403, zero mutation; admin (non-creator) may add", async () => {
    const { db } = await seededWorld();
    const denied = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, makeEnv(db), CUSTOM_FORM);
    expect(denied.status).toBe(403);
    expect(rawCount(db, "app_custom_providers")).toBe(0);
    const admin = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("octocat")}`, makeEnv(db), CUSTOM_FORM);
    expect(admin.status).toBe(200);
    expect(rawCount(db, "app_custom_providers")).toBe(1);
  });
});

// --- plan 14 T2: the settings view (views.ts) + DESIGN mapping ---

describe("settings view DESIGN mapping (plan 14 T2)", () => {
  const getSettingsPage = async (login: string): Promise<string> => {
    const { db } = await seededWorld();
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie(login)}`, makeEnv(db));
    expect(res.status).toBe(200);
    return res.text();
  };

  test("single column; Add key / Save model chain are the blue-700 primary; per-key Remove is red-700 danger", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.text();
    // Single column: the page never mounts the shell's lg 3-column grid.
    expect(body).not.toContain('class="sections"');
    // Constructive submits = the blue-700 primary class; destructive remove =
    // the red-700 danger class (spec § DESIGN.md 意图, no new tokens).
    expect(body).toContain('<button type="submit" class="primary">Add key</button>');
    expect(body).toContain('<button type="submit" class="primary">Save model chain</button>');
    expect(body).toContain('<button type="submit" class="danger">Remove</button>');
  });

  test("add-key form: password input; provider select offers EXACTLY the 18-id allowlist", async () => {
    const body = await getSettingsPage("mallory");
    // autocomplete=new-password: the pasted provider API key is a new secret
    // per submit — never a saved dashboard login for password managers.
    expect(body).toContain('<input type="password" name="key" autocomplete="new-password"');
    // The select leads with an empty disabled placeholder (preselected), so a
    // forgetful submit sends provider="" — the route's 400 path — instead of
    // silently picking the first allowlist id.
    expect(body).toContain('<option value="" disabled selected>Select a provider…</option>');
    // The select is the only place a provider id can enter — bound to the
    // same allowlist the POST route 400s against. Scoped to the provider
    // select: the plan-23 T2 custom-providers section adds its own api
    // select to the page, so a whole-page option scan would pick those up.
    const providerSelect = /<select name="provider">([\s\S]*?)<\/select>/.exec(body)?.[1] ?? "";
    const options = [...providerSelect.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);
    expect(options).toEqual([...PROVIDER_IDS]);
  });

  test("model chain copy states the empty = deployment-default fallback explicitly (whitespace-only save clears)", async () => {
    const body = await getSettingsPage("mallory");
    expect(body).toContain("fall back to the deployment default");
  });

  test("a key of ≤4 characters renders the no-tail copy — the mask never reveals a whole key", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).setProviderKey(app.id, "groq", "abcd");
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    const body = await res.text();
    expect(body).toContain("key too short to show a tail");
    expect(body).not.toContain("abcd");
  });

  test("key-list hint is replace-aware (upsert bumps the row timestamp — recency is never labeled 'created')", async () => {
    const body = await getSettingsPage("mallory");
    expect(body).toContain("Re-adding a provider replaces its stored key");
  });

  test("user-controlled strings are escaped — a stored chain with HTML-special characters never renders raw", async () => {
    const { db, app } = await seededWorld();
    // The chain is stored VERBATIM (configuration, not a secret) — the view
    // must escape it on the way out (attribute context).
    await configStore(db).setModelChain(app.id, '"><script>alert(1)</script>');
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain(`value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"`);
  });
});

// --- plan 23 T2: the settings view custom-providers section ---

describe("settings view — custom providers section (plan 23 T2)", () => {
  const getSettingsPage = async (login: string): Promise<string> => {
    const { db } = await seededWorld();
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie(login)}`, makeEnv(db));
    expect(res.status).toBe(200);
    return res.text();
  };

  test("the section sits between Model chain and Role models; the add form has the api enum select and a password key input", async () => {
    const body = await getSettingsPage("mallory");
    const modelChain = body.indexOf("Model chain");
    const custom = body.indexOf("Custom providers");
    const roleModels = body.indexOf("Role models");
    expect(modelChain).toBeGreaterThanOrEqual(0);
    expect(custom).toBeGreaterThan(modelChain);
    expect(roleModels).toBeGreaterThan(custom);
    // The api select offers EXACTLY the AL-23-1 three-form enum (the empty
    // disabled placeholder does not match the value regex — same discipline
    // as the provider select).
    const apiSelect = /<select name="api">([\s\S]*?)<\/select>/.exec(body)?.[1] ?? "";
    const values = [...apiSelect.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    expect(values).toEqual([...CUSTOM_PROVIDER_API_IDS]);
    // The key input reuses the password semantics of the provider-key form.
    expect(body).toContain('<input type="password" name="key" autocomplete="new-password"');
  });

  test("a stored declaration renders with escaped user-controlled strings (base_url / model_ids)", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).upsertCustomProvider(
      app.id,
      {
        provider_id: "ark",
        base_url: 'https://evil.example.com/?q="><script>alert(1)</script>',
        api: "openai-completions",
        model_ids: ['"><img src=x onerror=alert(1)>'],
      },
      "sk-custom-ark-9988",
    );
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("the remove form posts op=remove-custom-provider with the provider_id", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).upsertCustomProvider(
      app.id,
      { provider_id: "ark", base_url: "https://ark.example.com", api: "openai-completions", model_ids: ["deepseek-v4-flash"] },
      "sk-custom-ark-9988",
    );
    // Same db as the stored declaration — getSettingsPage builds a FRESH
    // world, so the page must be fetched over the db that holds the row.
    const res = await get(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    const body = await res.text();
    expect(body).toContain('<input type="hidden" name="op" value="remove-custom-provider">');
    expect(body).toContain('<input type="hidden" name="provider_id" value="ark">');
  });
});

describe("Apps list → settings nav (plan 14 T2)", () => {
  test("manageable Apps (owner / admin) get a Settings link; a non-owner sees none", async () => {
    const { db } = await seededWorld();
    const owner = await get("/dashboard/apps", `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    const ownerBody = await owner.text();
    expect(ownerBody).toContain('href="/dashboard/apps/mallorys-app/settings"');
    expect(ownerBody).not.toContain('href="/dashboard/apps/adas-app/settings"');
    const admin = await get("/dashboard/apps", `${SESSION_COOKIE}=${await sessionCookie("octocat")}`, makeEnv(db));
    const adminBody = await admin.text();
    expect(adminBody).toContain('href="/dashboard/apps/mallorys-app/settings"');
    expect(adminBody).toContain('href="/dashboard/apps/adas-app/settings"');
  });
});
