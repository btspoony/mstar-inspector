/**
 * Unit tests: migration 0006 + the per-App config store
 * (`app_provider_keys` BYOK keys + `app_model_config` model chain) + the
 * /dashboard/default/apps/:slug/settings route family (spec
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
 * importing pipeline/review code): PROVIDER_IDS ≡ the builtin id sequence
 * (a direct re-export of the generated contract, locked
 * against both the contract and the pipeline face), PROVIDER_META ≡ the
 * generated catalog (spec §5; full breadth since the catalog expansion),
 * parseModelChain ≡ the runtime-omp parseModelSelectors behavior, and
 * MODEL_ROLE_IDS ≡ the review-side seat vocabulary, all
 * asserted against the originals here.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../../src/worker/index";
import { createTestD1, type TestD1 } from "../store/helpers";
import { createAppsStore, type GithubAppRow } from "../../src/dashboard/apps-store";
import {
  CUSTOM_PROVIDER_API_IDS,
  MAX_CUSTOM_PROVIDER_COUNT,
  InvalidCustomProviderError,
  InvalidModelChainNameError,
  InvalidModelSelectorError,
  MAX_KEYS_PER_PROVIDER,
  MAX_MODEL_SELECTOR_LENGTH,
  MAX_PROVIDER_KEY_LENGTH,
  MODEL_ROLE_IDS,
  PROVIDER_IDS,
  PROVIDER_META,
  ProviderEndpointLockedError,
  ProviderKeyLimitError,
  ProviderKeyTooLongError,
  UnknownModelChainError,
  UnknownModelRoleError,
  createAppConfigStore,
  parseModelChain,
  type AppConfigD1,
  type AppConfigStatement,
  type AppCustomProvider,
} from "../../src/dashboard/app-config-store";
import { enabledSandboxImages, getSandboxImage, sandboxImageHostIds } from "../../src/contracts/sandbox-images";
import { composeModelOptions, findFailingSelector } from "../../src/dashboard/model-membership";
import { PROVIDER_CATALOG, PROVIDER_IDS_BUILTIN } from "../../src/contracts/provider-catalog.generated";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { PROVIDERS } from "../../src/pipeline/provider-catalog";
import { DEEP_SEAT_ROLES, parseModelSelectors } from "../../packages/runner/src/runtime-omp";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser, type DashboardD1 } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import type { D1StatementLike } from "../../src/store/types";
import { SPA_BOOT_MARKER, htmlGet, withSpaAssets } from "../helpers/spa";
import { sk, OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_KEY = Buffer.alloc(32, 11).toString("base64");
const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const PLAIN_ANTHROPIC_KEY = sk("ant-mallory-verysecret-9988");
const PLAIN_CHAIN = "ark-plan/deepseek-v4-flash, openai/gpt-5:thinking";
/** SQLite datetime('now') format the store writes (UTC "YYYY-MM-DD HH:MM:SS"). */
const SQLITE_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * First 16 hex chars of SHA-256(plaintext) — the pool id the store derives
 * for a key. A local mirror (the review-side parseModelSelectors precedent):
 * the tests lock the exact derivation, never re-derive it with store code.
 */
async function keyIdOf(plainKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plainKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

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
  // 0026: createApp writes its app_workspaces mapping in the same batch, so
  // every fixture that seeds an App needs the workspace data plane. Applied
  // after 0004 (its FK parent); the file only creates new tables.
  applyMigration(db, "0026_workspaces.sql");
  // 0028: the SPA boot reads pending invites.
  applyMigration(db, "0028_workspace_invites.sql");
  return db;
}

/**
 * The pre-pool shape (0006 → 0022, filename order): app_provider_keys still
 * carries ONE row per (App, provider) under the two-segment AAD and
 * app_custom_providers still carries its key column. The 0024 migration tests
 * seed this shape, then apply the migration, exactly like the wrangler order
 * on a live deployment.
 */
function createPreProviderPoolD1(): TestD1 {
  const db = createPopulatedPre0006D1();
  applyMigration(db, "0006_app_provider_config.sql");
  applyMigration(db, "0008_github_apps_ops.sql");
  applyMigration(db, "0009_app_model_roles.sql");
  // 0011: the settings page now renders the recent-deliveries
  // panel from webhook_deliveries on every render — the fixture must carry
  // the table or every settings route 500s.
  applyMigration(db, "0011_webhook_deliveries.sql");
  applyMigration(db, "0012_custom_providers_and_key_updated_at.sql");
  applyMigration(db, "0015_provider_verification.sql");
  // 0017: the chains store tests + the settings routes run on
  // the chains shape (app_model_chains + app_model_chain_seats).
  applyMigration(db, "0017_app_model_chains.sql");
  // 0018: the settings routes + the sandbox-image selection run on
  // the shape carrying github_apps.sandbox_image_id (the custom-provider
  // collision backstop resolves the App's selected image through it).
  applyMigration(db, "0018_app_sandbox_images.sql");
  // 0019: the settings JSON GET reads/writes the five github_*
  // metadata columns — the route must run on the production shape.
  applyMigration(db, "0019_github_apps_metadata.sql");
  // 0022: the settings read face serves github_apps.review_trigger_mode
  // (the SPA mode control's value) and the trigger-mode route validates
  // against the CHECK enum — the route tests run on the production shape.
  applyMigration(db, "0022_app_trigger_mode.sql");
  // 0023: createUser clears a removal record in the same batch as its insert,
  // so every membership-creating fixture needs the tombstone table too.
  applyMigration(db, "0023_removed_logins.sql");
  return db;
}

/**
 * Fully-migrated shape: the pre-pool one plus 0024 (the per-key pools), i.e.
 * what `wrangler d1 migrations apply` produces today. 0015 matters because the
 * store's key writes maintain the verified_* columns, so every config-store
 * test must run on the 0015-shaped schema.
 */
function createAppConfigD1(): TestD1 {
  const db = createPreProviderPoolD1();
  applyMigration(db, "0024_provider_multi_key.sql");
  applyMigration(db, "0025_provider_model_evidence.sql");
  // 0029/0031–0033: SPA dispatch reads the support-grant table, the plan
  // catalogue + subscriptions and `server_flags` while it builds the boot, so
  // the shell route runs on the production shape.
  applyMigration(db, "0029_operator_support.sql");
  applyMigration(db, "0031_plans_usage.sql");
  applyMigration(db, "0032_unlimited_plan.sql");
  applyMigration(db, "0033_platform_admin.sql");
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

/**
 * D1 double that runs `removeDeclaration` the first time the store prepares a
 * write into app_custom_provider_keys — the CONTROLLED interleaving the
 * ownership gate must absorb: the caller's declaration read has already
 * passed, the declaration (and its pool) is gone by the time the key write
 * executes. Everything else delegates to the real migrated double.
 */
function createDeclarationRaceD1(inner: AppConfigD1, removeDeclaration: () => void): AppConfigD1 {
  let fired = false;
  return {
    prepare: (query: string) => {
      const stmt = inner.prepare(query);
      if (fired || !query.includes("INSERT INTO app_custom_provider_keys")) return stmt;
      const raced: AppConfigStatement = {
        bind: (...values: unknown[]) => {
          stmt.bind(...values);
          return raced;
        },
        first: () => stmt.first(),
        all: () => stmt.all(),
        run: async () => {
          if (!fired) {
            fired = true;
            removeDeclaration();
          }
          return await stmt.run();
        },
      };
      return raced;
    },
    batch: (statements) => inner.batch(statements),
  };
}

/**
 * D1 double that injects a CONCURRENT same-id save at the one moment that
 * matters: after this caller's `isNew` / count pre-checks have already passed,
 * and BEFORE its batch executes. The injected save takes the App's LAST
 * declaration slot under the very id this caller is declaring.
 */
function createLastSlotRaceD1(inner: AppConfigD1, winLastSlot: () => Promise<void>): AppConfigD1 {
  let fired = false;
  return {
    prepare: (query: string) => inner.prepare(query),
    batch: async (statements) => {
      if (!fired) {
        fired = true;
        await winLastSlot();
      }
      return await inner.batch(statements);
    },
  };
}

/**
 * D1 double that commits a concurrent remove + re-declaration at ANOTHER
 * endpoint just before the FIRST statement that reads the custom-provider key
 * pool runs — the interleaving a two-statement consumer read splits on (the
 * declaration read has already happened when the pool statement executes).
 */
function createPoolReadRaceD1(inner: AppConfigD1, race: () => Promise<void>): AppConfigD1 {
  let fired = false;
  const fire = async () => {
    if (fired) return;
    fired = true;
    await race();
  };
  return {
    prepare: (query: string) => {
      const stmt = inner.prepare(query);
      if (fired || !query.includes("app_custom_provider_keys")) return stmt;
      const raced: AppConfigStatement = {
        bind: (...values: unknown[]) => {
          stmt.bind(...values);
          return raced;
        },
        first: async () => {
          await fire();
          return stmt.first();
        },
        all: async () => {
          await fire();
          return stmt.all();
        },
        run: async () => {
          await fire();
          return stmt.run();
        },
      };
      return raced;
    },
    batch: (statements) => inner.batch(statements),
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
    workspaceId: "default",
  });
}

/** mallory owns "mallorys-app"; ada owns "adas-app"; hubot owns none; octocat is admin. */
async function seededWorld(): Promise<{ db: ReturnType<typeof createAppConfigD1>; app: GithubAppRow; otherApp: GithubAppRow }> {
  const db = createAppConfigD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "ada", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  // Manage is the workspace role: `octocat` and `mallory` are owners, the
  // other two are plain members — the creator column grants nothing.
  db.raw
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT 'default', id, CASE github_login WHEN 'octocat' THEN 'owner' ELSE 'member' END,
              '2026-01-01T00:00:00.000Z'
       FROM users WHERE github_login <> 'mallory'`,
    )
    .run();
  db.raw
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT 'default', id, 'owner', '2026-01-01T00:00:00.000Z' FROM users WHERE github_login = 'mallory'`,
    )
    .run();
  const app = await seedApp(db, { slug: "mallorys-app", createdBy: "mallory", githubAppId: 1001 });
  const otherApp = await seedApp(db, { slug: "adas-app", createdBy: "ada", githubAppId: 1002 });
  return { db, app, otherApp };
}

// --- route drivers (same shape as apps-ui.test.ts) ---

function makeEnv(db: unknown, overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
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

// SPA ownership: settings HTML GET is SPA-owned (shared spa helper).

const SETTINGS = "/dashboard/default/apps/mallorys-app/settings";

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
    // The DDL this test pins belongs to 0006, so it runs on the PRE-pool
    // shape: 0024 rebuilds the table onto the (app_id, provider, key_id) PK.
    const db = createPreProviderPoolD1();
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
    const db = createPreProviderPoolD1();
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
    await configStore(db).addProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
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

// --- migration 0012 (app_provider_keys.updated_at) ---

describe("migration 0012_custom_providers_and_key_updated_at.sql", () => {
  test("applies cleanly after 0006; pre-existing key rows keep created_at and carry NULL updated_at until the key is re-set", async () => {
    const db = createPopulatedPre0006D1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    applyMigration(db, "0006_app_provider_config.sql");
    // A key row written BEFORE 0012 (the pre-migration column set), under the
    // pre-pool two-segment AAD — what a live deployment carries across.
    const legacyEnc = await createSecretbox(TEST_KEY).encryptSecret(
      PLAIN_ANTHROPIC_KEY,
      `app_provider_keys.key_enc:${app.id}:anthropic`,
    );
    rawRun(
      db,
      `INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at)
       VALUES (?, 'anthropic', ?, '2026-01-01 00:00:00')`,
      app.id,
      legacyEnc,
    );
    expect(() => applyMigration(db, "0012_custom_providers_and_key_updated_at.sql")).not.toThrow();
    // 0015 next (the real sequence for these tables): the store's key writes
    // maintain the verified_* columns, so the re-set below must run on the
    // 0015-shaped schema; 0024 last — the pool shape the store now writes to.
    applyMigration(db, "0015_provider_verification.sql");
    applyMigration(db, "0024_provider_multi_key.sql");
    const row = db.raw.query("SELECT created_at, updated_at FROM app_provider_keys").get() as {
      created_at: string;
      updated_at: string | null;
    };
    expect(row.created_at).toBe("2026-01-01 00:00:00"); // untouched by the ALTER
    expect(row.updated_at).toBeNull(); // the 存量行 placeholder source
    // The store's re-set fills updated_at from a fresh clock read — a legacy
    // row becomes current — while created_at stays the key's entry time (the
    // pool order (created_at, key_id) does not shift on a re-submission).
    await configStore(db).addProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const afterReset = db.raw.query("SELECT created_at, updated_at FROM app_provider_keys").get() as {
      created_at: string;
      updated_at: string;
    };
    expect(afterReset.created_at).toBe("2026-01-01 00:00:00"); // unchanged: updated in place
    expect(afterReset.updated_at).toMatch(SQLITE_TS_RE);
    expect(afterReset.updated_at > "2026-01-01 00:00:00").toBe(true);
  });

  test("full-file direct run (0001→0012 order) creates app_custom_providers with the AL-23-1 DDL shape", async () => {
    const db = createPreProviderPoolD1(); // 0001→0022 in filename order (index skips are harmless)
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

// --- migration 0017 (default + named chains + backfill DML) ---

describe("migration 0017_app_model_chains.sql (spec §4.4)", () => {
  test("applies cleanly over a seeded production-shaped DB; backfill DML migrates the pre-chains shape", async () => {
    // A pre-0017 DB (0001–0016) with the pre-chains shape seeded RAW —
    // exactly the wrangler order on a live deployment.
    const db = createPopulatedPre0006D1();
    for (const name of [
      "0006_app_provider_config.sql",
      "0008_github_apps_ops.sql",
      "0009_app_model_roles.sql",
      "0011_webhook_deliveries.sql",
      "0012_custom_providers_and_key_updated_at.sql",
      "0015_provider_verification.sql",
      "0016_users_login_nocase_unique.sql",
    ]) {
      applyMigration(db, name);
    }
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    rawRun(
      db,
      `INSERT INTO app_model_config (app_id, model_chain, updated_at) VALUES (?, ?, datetime('now'))`,
      app.id,
      PLAIN_CHAIN,
    );
    rawRun(
      db,
      `INSERT INTO app_model_roles (app_id, role, selector) VALUES (?, 'code-reviewer', 'openai/gpt-5:thinking')`,
      app.id,
    );
    expect(() => applyMigration(db, "0017_app_model_chains.sql")).not.toThrow();
    // The backfill produced the chains shape from the pre-chains rows:
    // default row (verbatim chain) + seat-<role> named chain + seat ref.
    const chains = db.raw
      .query("SELECT name, chain, is_default FROM app_model_chains WHERE app_id = ? ORDER BY name")
      .all(app.id) as Array<{ name: string; chain: string; is_default: number }>;
    expect(chains).toEqual([
      { name: "default", chain: PLAIN_CHAIN, is_default: 1 },
      { name: "seat-code-reviewer", chain: "openai/gpt-5:thinking", is_default: 0 },
    ]);
    const seats = db.raw
      .query("SELECT role, chain_name FROM app_model_chain_seats WHERE app_id = ?")
      .all(app.id) as Array<{ role: string; chain_name: string }>;
    expect(seats).toEqual([{ role: "code-reviewer", chain_name: "seat-code-reviewer" }]);
  });

  test("backfill: an app with NO app_model_config row gets NO default row (fail-closed semantics preserved)", async () => {
    const db = createAppConfigD1();
    const bare = await seedApp(db, { slug: "bare", createdBy: "mallory" });
    const row = db.raw
      .query("SELECT chain FROM app_model_chains WHERE app_id = ? AND name = 'default'")
      .get(bare.id) as { chain: string } | null;
    expect(row).toBeNull();
    expect(await configStore(db).getModelChain(bare.id)).toBeNull();
  });
});

// --- migration 0024 (per-key provider pools) ---

describe("migration 0024_provider_multi_key.sql (per-key provider pools)", () => {
  const LEGACY_KEY = sk("legacy-anthropic-4242");
  const LEGACY_CUSTOM_KEY = sk("legacy-custom-5151");

  test("rebuilds app_provider_keys onto (app_id, provider, key_id) and carries legacy rows over verbatim", async () => {
    const db = createPreProviderPoolD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const legacyEnc = await createSecretbox(TEST_KEY).encryptSecret(
      LEGACY_KEY,
      `app_provider_keys.key_enc:${app.id}:anthropic`,
    );
    rawRun(
      db,
      `INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at, updated_at)
       VALUES (?, 'anthropic', ?, '2026-01-01 00:00:00', '2026-01-02 00:00:00')`,
      app.id,
      legacyEnc,
    );
    expect(() => applyMigration(db, "0024_provider_multi_key.sql")).not.toThrow();
    const cols = db.raw.query("PRAGMA table_info(app_provider_keys)").all() as Array<{ name: string; pk: number }>;
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["app_id", "provider", "key_id"]);
    // The row is carried over UNCHANGED: D1 migrations are SQL, and SQL cannot
    // decrypt — so the envelope keeps the two-segment AAD and the row keeps
    // its bookkeeping under the sentinel key_id. The store (which holds the
    // master key) completes the promotion on the first read.
    const row = db.raw
      .query("SELECT key_id, key_enc, created_at, updated_at FROM app_provider_keys")
      .get() as { key_id: string; key_enc: string; created_at: string; updated_at: string };
    expect(row.key_id).toBe("");
    expect(row.created_at).toBe("2026-01-01 00:00:00");
    expect(row.updated_at).toBe("2026-01-02 00:00:00");
    await expect(
      createSecretbox(TEST_KEY).decryptSecret(row.key_enc, `app_provider_keys.key_enc:${app.id}:anthropic`),
    ).resolves.toBe(LEGACY_KEY);
  });

  test("the pool PK admits several keys per (App, provider) and still rejects a duplicate (app_id, provider, key_id)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const sql = `INSERT INTO app_provider_keys (app_id, provider, key_id, key_enc, created_at)
       VALUES (?, 'anthropic', ?, 'v1.primary.aXZpdi.Y3Q=', '2026-01-01 00:00:00')`;
    rawRun(db, sql, app.id, "aaaaaaaaaaaaaaaa");
    rawRun(db, sql, app.id, "bbbbbbbbbbbbbbbb");
    expect(rawCount(db, "app_provider_keys")).toBe(2);
    expect(() => rawRun(db, sql, app.id, "aaaaaaaaaaaaaaaa")).toThrow(/UNIQUE constraint failed/);
    expect(rawCount(db, "app_provider_keys")).toBe(2);
  });

  test("moves custom-provider key material into app_custom_provider_keys and drops the key columns from the declaration table", async () => {
    const db = createPreProviderPoolD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const legacyEnc = await createSecretbox(TEST_KEY).encryptSecret(
      LEGACY_CUSTOM_KEY,
      `app_custom_providers.api_key_enc:${app.id}:my-custom`,
    );
    rawRun(
      db,
      `INSERT INTO app_custom_providers
         (app_id, provider_id, base_url, api, model_ids, api_key_enc, created_at, updated_at, verified_at, verified_status)
       VALUES (?, 'my-custom', 'https://example.com/v1', 'openai-completions', '["m1"]', ?,
               '2026-01-01 00:00:00', '2026-01-02 00:00:00', '2026-01-03 00:00:00', 'ok')`,
      app.id,
      legacyEnc,
    );
    expect(() => applyMigration(db, "0024_provider_multi_key.sql")).not.toThrow();
    // The declaration keeps its shape MINUS the key material and its
    // verification bookkeeping (both now belong to the key row).
    const declCols = (db.raw.query("PRAGMA table_info(app_custom_providers)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(declCols).toEqual(["app_id", "provider_id", "base_url", "api", "model_ids", "created_at", "updated_at"]);
    // The key material moved across verbatim (sentinel id, old AAD, old
    // bookkeeping) — the store promotes it on first read.
    const keyRow = db.raw
      .query("SELECT provider, key_id, key_enc, created_at, updated_at, verified_at, verified_status FROM app_custom_provider_keys")
      .get() as {
      provider: string;
      key_id: string;
      key_enc: string;
      created_at: string;
      updated_at: string;
      verified_at: string | null;
      verified_status: string | null;
    };
    expect(keyRow.provider).toBe("my-custom");
    expect(keyRow.key_id).toBe("");
    expect(keyRow.created_at).toBe("2026-01-01 00:00:00");
    expect(keyRow.updated_at).toBe("2026-01-02 00:00:00");
    expect(keyRow.verified_at).toBe("2026-01-03 00:00:00");
    expect(keyRow.verified_status).toBe("ok");
    await expect(
      createSecretbox(TEST_KEY).decryptSecret(keyRow.key_enc, `app_custom_providers.api_key_enc:${app.id}:my-custom`),
    ).resolves.toBe(LEGACY_CUSTOM_KEY);
  });
});

describe("migration 0025_provider_model_evidence.sql (per-key model evidence)", () => {
  test("rebuilds app_provider_models onto (app_id, provider, key_id) and carries NO aggregate row forward", async () => {
    const db = createPreProviderPoolD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    applyMigration(db, "0024_provider_multi_key.sql");
    // The pre-0025 aggregate: one un-attributable row per (App, provider).
    rawRun(
      db,
      `INSERT INTO app_provider_models (app_id, provider, models_json, fetched_at)
       VALUES (?, 'anthropic', '["m1","m2"]', '2026-01-01 00:00:00')`,
      app.id,
    );
    expect(() => applyMigration(db, "0025_provider_model_evidence.sql")).not.toThrow();
    const cols = db.raw.query("PRAGMA table_info(app_provider_models)").all() as Array<{ name: string; pk: number }>;
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["app_id", "provider", "key_id"]);
    // The copy is deliberately EMPTY: an aggregate cannot say which key
    // contributed which model, so carrying it forward would be dead data —
    // the next verification rebuilds the evidence per key.
    expect(rawCount(db, "app_provider_models")).toBe(0);
    const fks = db.raw.query("PRAGMA foreign_key_list(app_provider_models)").all() as Array<{ table: string }>;
    expect(fks).toHaveLength(1);
    expect(fks[0]!.table).toBe("github_apps");
  });

  test("the (app_id, provider, key_id) PK admits one evidence row per key and rejects a duplicate", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const sql = `INSERT INTO app_provider_models (app_id, provider, key_id, models_json, fetched_at)
       VALUES (?, 'anthropic', ?, '["m1"]', '2026-01-01 00:00:00')`;
    rawRun(db, sql, app.id, "aaaaaaaaaaaaaaaa");
    rawRun(db, sql, app.id, "bbbbbbbbbbbbbbbb");
    expect(rawCount(db, "app_provider_models")).toBe(2);
    expect(() => rawRun(db, sql, app.id, "aaaaaaaaaaaaaaaa")).toThrow(/UNIQUE constraint failed/);
  });
});

// --- store: provider keys ---

describe("app-config store (createAppConfigStore) — provider keys", () => {
  test("addProviderKey encrypts INSIDE the store under the per-key AAD (round-trip)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    await configStore(db).addProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const row = db.raw
      .query("SELECT app_id, provider, key_id, key_enc, created_at FROM app_provider_keys")
      .get() as { app_id: string; provider: string; key_id: string; key_enc: string; created_at: string };
    // Only ciphertext lands in D1: a v1 envelope, never the plaintext.
    expect(row.key_enc).toMatch(/^v1\.primary\./);
    expect(row.key_enc).not.toContain(PLAIN_ANTHROPIC_KEY);
    expect(row.app_id).toBe(app.id);
    expect(row.provider).toBe("anthropic");
    expect(row.key_id).toBe(await keyIdOf(PLAIN_ANTHROPIC_KEY));
    expect(row.created_at).toMatch(SQLITE_TS_RE);
    // The per-key AAD decrypts the exact plaintext back.
    const plain = await createSecretbox(TEST_KEY).decryptSecret(
      row.key_enc,
      `app_provider_keys.key_enc:${app.id}:anthropic:${row.key_id}`,
    );
    expect(plain).toBe(PLAIN_ANTHROPIC_KEY);
  });

  test("AAD anchor: the rowKey binds the app, the provider AND the key id — any other AAD fails the GCM tag", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    await configStore(db).addProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const row = db.raw.query("SELECT key_id, key_enc FROM app_provider_keys").get() as {
      key_id: string;
      key_enc: string;
    };
    const box = createSecretbox(TEST_KEY);
    // A different provider of the SAME app (cross-provider read)…
    await expect(
      box.decryptSecret(row.key_enc, `app_provider_keys.key_enc:${app.id}:openai:${row.key_id}`),
    ).rejects.toThrow(/AAD mismatch/);
    // …the same provider of a DIFFERENT app (cross-App read)…
    await expect(
      box.decryptSecret(row.key_enc, `app_provider_keys.key_enc:other-app:anthropic:${row.key_id}`),
    ).rejects.toThrow(/AAD mismatch/);
    // …and a SIBLING slot of the same pool (the three-segment extension: one
    // row's ciphertext is unusable for another slot).
    await expect(
      box.decryptSecret(row.key_enc, `app_provider_keys.key_enc:${app.id}:anthropic:${"0".repeat(16)}`),
    ).rejects.toThrow(/AAD mismatch/);
  });

  test("two keys for one (App, provider) coexist as separate pool rows", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    const one = sk("first-key-aaaa");
    const two = sk("second-key-bbbb");
    await store.addProviderKey(app.id, "anthropic", one);
    await store.addProviderKey(app.id, "anthropic", two);
    expect(rawCount(db, "app_provider_keys")).toBe(2);
    // Pool order is (created_at, key_id) — two adds in the same second order
    // by their derived ids, so the expectation is built the same way.
    const idOne = await keyIdOf(one);
    const idTwo = await keyIdOf(two);
    const first = idOne < idTwo ? one : two;
    const second = idOne < idTwo ? two : one;
    expect(await store.getAppConfig(app.id)).toEqual({
      appId: app.id,
      keys: { anthropic: [first, second] },
      modelChain: null,
    });
    const list = await store.listProviderKeys(app.id);
    expect(list.map((key) => key.keyId)).toEqual([first, second].map((key) => (key === one ? idOne : idTwo)));
    expect(list.map((key) => key.last4)).toEqual([first.slice(-4), second.slice(-4)]);
    expect(list.every((key) => key.provider === "anthropic")).toBe(true);
    expect(list.every((key) => key.verifiedAt === null && key.verifiedStatus === null)).toBe(true);
    // The optional provider filter scopes the list to one pool.
    expect((await store.listProviderKeys(app.id, "anthropic")).length).toBe(2);
    expect((await store.listProviderKeys(app.id, "openai")).length).toBe(0);
  });

  test("re-submitting the same key updates its row in place (no second row); a different key is a new slot", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    const one = sk("first-key-aaaa");
    const two = sk("second-key-bbbb");
    await store.addProviderKey(app.id, "anthropic", one);
    // Backdate BOTH stored timestamps to DISTINCT past values so the second
    // save's fresh clock read is observably later than the previous update,
    // not merely later than creation time. Deterministic: no sleeps, no fake
    // timers (the backdated-row case below uses the same mechanism).
    rawRun(
      db,
      "UPDATE app_provider_keys SET created_at = '2026-01-01 00:00:00', updated_at = '2026-02-01 00:00:00' WHERE app_id = ? AND provider = 'anthropic'",
      app.id,
    );
    const before = db.raw.query("SELECT key_enc, created_at, updated_at FROM app_provider_keys").get() as {
      key_enc: string;
      created_at: string;
      updated_at: string;
    };
    await store.addProviderKey(app.id, "anthropic", one);
    expect(rawCount(db, "app_provider_keys")).toBe(1);
    const after = db.raw.query("SELECT key_id, key_enc, created_at, updated_at FROM app_provider_keys").get() as {
      key_id: string;
      key_enc: string;
      created_at: string;
      updated_at: string;
    };
    expect(after.key_id).toBe(await keyIdOf(one));
    expect(after.key_enc).not.toBe(before.key_enc); // rewritten: a fresh IV
    // The shipped re-submission contract: created_at is the key's ENTRY time
    // and stays; updated_at moves FORWARD from a fresh clock read — strictly
    // past the previous update, which the distinct backdated fixture is the
    // counterexample guard for. `SQLITE_TS_RE` checks shape only, so the
    // strict `>` against the captured prior update (not against creation
    // time) is what rejects a stale or backwards update.
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at).toMatch(SQLITE_TS_RE);
    expect(after.updated_at > before.updated_at).toBe(true); // same-format string compare
    // A DIFFERENT key is a new pool slot, never an overwrite of the first.
    await store.addProviderKey(app.id, "anthropic", two);
    expect(rawCount(db, "app_provider_keys")).toBe(2);
    expect((await store.getAppConfig(app.id)).keys.anthropic!.slice().sort()).toEqual([one, two].sort());
  });

  test("the ninth key for one (App, provider) is refused with zero writes (MAX_KEYS_PER_PROVIDER)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    const keys = Array.from({ length: MAX_KEYS_PER_PROVIDER }, (_, i) => sk(`pool-cap-key-${i}-${i}${i}${i}${i}`));
    for (const key of keys) {
      await store.addProviderKey(app.id, "anthropic", key);
    }
    expect(rawCount(db, "app_provider_keys")).toBe(MAX_KEYS_PER_PROVIDER);
    await expect(store.addProviderKey(app.id, "anthropic", sk("pool-cap-key-over-9999"))).rejects.toThrow(
      ProviderKeyLimitError,
    );
    expect(rawCount(db, "app_provider_keys")).toBe(MAX_KEYS_PER_PROVIDER);
    // Growth-only per pool: re-submitting a stored key still lands (no growth)…
    await expect(store.addProviderKey(app.id, "anthropic", keys[0]!)).resolves.toBeUndefined();
    expect(rawCount(db, "app_provider_keys")).toBe(MAX_KEYS_PER_PROVIDER);
    // …and the cap is per (App, provider): another pool starts from zero.
    await expect(store.addProviderKey(app.id, "openai", sk("pool-openai-1-1111"))).resolves.toBeUndefined();
    expect(rawCount(db, "app_provider_keys")).toBe(MAX_KEYS_PER_PROVIDER + 1);
  });

  test("a legacy two-segment-AAD row still decrypts and is promoted to the three-segment form", async () => {
    const db = createPreProviderPoolD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    // The pre-pool row a live deployment carries across 0024.
    const legacyEnc = await createSecretbox(TEST_KEY).encryptSecret(
      PLAIN_ANTHROPIC_KEY,
      `app_provider_keys.key_enc:${app.id}:anthropic`,
    );
    rawRun(
      db,
      `INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at, updated_at, verified_at, verified_status)
       VALUES (?, 'anthropic', ?, '2026-01-01 00:00:00', '2026-01-02 00:00:00', '2026-01-03 00:00:00', 'ok')`,
      app.id,
      legacyEnc,
    );
    applyMigration(db, "0024_provider_multi_key.sql");
    const store = configStore(db);
    // The first read decrypts with the OLD AAD and serves the plaintext …
    expect(await store.getAppConfig(app.id)).toEqual({
      appId: app.id,
      keys: { anthropic: [PLAIN_ANTHROPIC_KEY] },
      modelChain: null,
    });
    // … and the row is rewritten under the three-segment AAD with the derived
    // id, keeping its timestamps and verification bookkeeping.
    const keyId = await keyIdOf(PLAIN_ANTHROPIC_KEY);
    const row = db.raw
      .query("SELECT key_id, key_enc, created_at, updated_at, verified_at, verified_status FROM app_provider_keys")
      .get() as {
      key_id: string;
      key_enc: string;
      created_at: string;
      updated_at: string;
      verified_at: string | null;
      verified_status: string | null;
    };
    expect(row.key_id).toBe(keyId);
    expect(row.created_at).toBe("2026-01-01 00:00:00");
    expect(row.updated_at).toBe("2026-01-02 00:00:00");
    expect(row.verified_at).toBe("2026-01-03 00:00:00");
    expect(row.verified_status).toBe("ok");
    const box = createSecretbox(TEST_KEY);
    await expect(
      box.decryptSecret(row.key_enc, `app_provider_keys.key_enc:${app.id}:anthropic:${keyId}`),
    ).resolves.toBe(PLAIN_ANTHROPIC_KEY);
    // The promotion is one-way: the old AAD no longer opens the row.
    await expect(
      box.decryptSecret(row.key_enc, `app_provider_keys.key_enc:${app.id}:anthropic`),
    ).rejects.toThrow(/AAD mismatch/);
    // A second read is a plain three-segment read (no churn on the row).
    expect(await store.listProviderKeys(app.id)).toEqual([
      {
        provider: "anthropic",
        keyId,
        last4: "9988",
        updatedAt: "2026-01-02 00:00:00",
        verifiedAt: "2026-01-03 00:00:00",
        verifiedStatus: "ok",
      },
    ]);
  });

  test("listProviderKeys masks to provider + key id + last-4 only — plaintext never returns", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.addProviderKey(app.id, "openai", sk("openai-key-7777"));
    await store.addProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const list = await store.listProviderKeys(app.id);
    // Provider-ascending; ONLY the masked tail of each key (plus the pool id
    // and the per-key bookkeeping — no key material).
    expect(list).toEqual([
      {
        provider: "anthropic",
        keyId: await keyIdOf(PLAIN_ANTHROPIC_KEY),
        last4: "9988",
        updatedAt: expect.stringMatching(SQLITE_TS_RE),
        verifiedAt: null,
        verifiedStatus: null,
      },
      {
        provider: "openai",
        keyId: await keyIdOf(sk("openai-key-7777")),
        last4: "7777",
        updatedAt: expect.stringMatching(SQLITE_TS_RE),
        verifiedAt: null,
        verifiedStatus: null,
      },
    ]);
    expect(JSON.stringify(list)).not.toContain(PLAIN_ANTHROPIC_KEY);
    expect(JSON.stringify(list)).not.toContain(sk("openai-key-7777"));
  });

  test("a key of ≤4 characters reveals NOTHING through the mask", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    // Non-hex short keys, so the containment asserts below cannot collide with
    // a derived (hex) key id.
    await store.addProviderKey(app.id, "groq", "wxyz");
    await store.addProviderKey(app.id, "kilo", "xyz");
    const list = await store.listProviderKeys(app.id);
    expect(list.map((key) => ({ provider: key.provider, last4: key.last4 }))).toEqual([
      { provider: "groq", last4: "" },
      { provider: "kilo", last4: "" },
    ]);
    expect(JSON.stringify(list)).not.toContain("wxyz");
    expect(JSON.stringify(list)).not.toContain("xyz");
  });

  test("ONE key's own report is cached verbatim, and a re-verify refreshes it upward (F4)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    const one = sk("first-key-aaaa");
    const cachedModels = async () => (await store.getVerifiedModels(app.id)).map((row) => row.models);

    // The runtime loads a one-key pool, so that key's own report IS the pool's
    // vocabulary — nothing to reconcile, and a later upstream model launch
    // must be able to land on the next re-verify.
    await store.saveVerifiedKey(app.id, "anthropic", one, ["m1", "m2"]);
    expect(await cachedModels()).toEqual([["m1", "m2"]]);
    await store.saveVerifiedKey(app.id, "anthropic", one, ["m1", "m2", "m3"]);
    expect(await cachedModels()).toEqual([["m1", "m2", "m3"]]);
  });

  test("a multi-key pool offers the INTERSECTION of the keys' OWN reports — identical lists included (F4)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    const one = sk("first-key-aaaa");
    const two = sk("second-key-bbbb");
    const cachedModels = async () => (await store.getVerifiedModels(app.id)).map((row) => row.models);

    // TWO keys with IDENTICAL reports: the intersection IS that list.
    await store.saveVerifiedKey(app.id, "anthropic", one, ["m2", "m3"]);
    await store.saveVerifiedKey(app.id, "anthropic", two, ["m2", "m3"]);
    expect(await cachedModels()).toEqual([["m2", "m3"]]);

    // A SUBSET: the offered set narrows to what BOTH can serve, so the
    // dropdown never offers a model the credential the runtime picks cannot.
    await store.saveVerifiedKey(app.id, "anthropic", one, ["m1", "m2", "m3"]);
    expect(await cachedModels()).toEqual([["m2", "m3"]]);
    // Not disjoint: B becomes a SUBSET of A, so the shared model is what
    // survives — the genuine disjoint case is "the disjoint path" below.
    await store.saveVerifiedKey(app.id, "anthropic", two, ["m3"]);
    expect(await cachedModels()).toEqual([["m3"]]);
  });

  test("the stale path: a re-verify after a deletion never publishes a model the surviving pool cannot serve (F4 Critical)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    const one = sk("first-key-aaaa");
    const two = sk("second-key-bbbb");
    const three = sk("third-key-cccc");
    const cachedModels = async () => (await store.getVerifiedModels(app.id)).map((row) => row.models);

    // A and B serve only "shared"; removing C must not erase THEIR evidence —
    // that erasure is what let the next INSERT cache ONE key's list verbatim
    // for a two-key pool.
    await store.saveVerifiedKey(app.id, "anthropic", one, ["shared"]);
    await store.saveVerifiedKey(app.id, "anthropic", two, ["shared"]);
    await store.saveVerifiedKey(app.id, "anthropic", three, ["shared"]);
    expect(await store.deleteProviderKey(app.id, "anthropic", await keyIdOf(three))).toBe(true);
    // B has since gained "b-only" while A still serves only "shared" — and the
    // runtime may resolve with A, so "b-only" must NOT be offered.
    await store.saveVerifiedKey(app.id, "anthropic", two, ["b-only", "shared"]);
    expect(await cachedModels()).toEqual([["shared"]]);
  });

  test("the growth path: a model BOTH keys gain appears once both are re-verified (F4 Important)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    const one = sk("first-key-aaaa");
    const two = sk("second-key-bbbb");
    const cachedModels = async () => (await store.getVerifiedModels(app.id)).map((row) => row.models);

    await store.saveVerifiedKey(app.id, "anthropic", one, ["m1"]);
    await store.saveVerifiedKey(app.id, "anthropic", two, ["m1"]);
    expect(await cachedModels()).toEqual([["m1"]]);
    // Both keys gained m2 upstream: each re-verify refreshes ITS OWN report, so
    // the recomputed intersection adds m2 back — the historical aggregate could
    // never do this.
    await store.saveVerifiedKey(app.id, "anthropic", one, ["m1", "m2"]);
    await store.saveVerifiedKey(app.id, "anthropic", two, ["m1", "m2"]);
    expect(await cachedModels()).toEqual([["m1", "m2"]]);
  });

  test("the disjoint path: a pool narrowed to [] recovers when both keys gain a common model (F4 Important)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    const one = sk("first-key-aaaa");
    const two = sk("second-key-bbbb");
    const cachedModels = async () => (await store.getVerifiedModels(app.id)).map((row) => row.models);

    await store.saveVerifiedKey(app.id, "anthropic", one, ["only-first"]);
    await store.saveVerifiedKey(app.id, "anthropic", two, ["only-second"]);
    // Empty models IS the probe-only signal: composeModelOptions yields no
    // options and findFailingSelector falls back to syntax-only for that
    // provider, so a chain naming either model still saves and the runtime
    // resolves it against the pool.
    expect(await cachedModels()).toEqual([[]]);
    const cached = await store.getVerifiedModels(app.id);
    expect(composeModelOptions(cached, [])).toEqual([
      { provider: "anthropic", source: "probe", selectors: [] },
    ]);
    expect(findFailingSelector(["anthropic/only-first", "anthropic/only-second"], cached, [])).toBeNull();
    // Both keys gained the same model: the recomputed intersection surfaces it
    // instead of staying stuck at the empty historical aggregate.
    await store.saveVerifiedKey(app.id, "anthropic", one, ["common"]);
    await store.saveVerifiedKey(app.id, "anthropic", two, ["common"]);
    expect(await cachedModels()).toEqual([["common"]]);
  });

  test("a pool key with NO report of its own leaves the pool's vocabulary unknown (F4)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.saveVerifiedKey(app.id, "anthropic", sk("first-key-aaaa"), ["m1", "m2"]);
    // The unverified sibling rides the same pool, so the runtime may resolve
    // with it: its vocabulary is unknown, and offering the verified key's list
    // is exactly the F4 failure. Unknown → nothing offered (probe face).
    await store.addProviderKey(app.id, "anthropic", sk("second-key-bbbb"));
    expect((await store.getVerifiedModels(app.id)).map((row) => row.models)).toEqual([[]]);
  });

  test("deleteProviderKey removes ONE pool slot and drops THAT key's evidence only", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    const one = sk("first-key-aaaa");
    const two = sk("second-key-bbbb");
    await store.saveVerifiedKey(app.id, "anthropic", one, ["claude-sonnet-4-6"]);
    await store.addProviderKey(app.id, "anthropic", two);
    expect(rawCount(db, "app_provider_models")).toBe(1);
    expect(await store.deleteProviderKey(app.id, "anthropic", await keyIdOf(one))).toBe(true);
    expect(rawCount(db, "app_provider_keys")).toBe(1);
    // The evidence is keyed by the credential that produced it, so deleting a
    // key drops only ITS evidence (models only the deleted credential could
    // serve can no longer be offered; the survivor keeps what it reported).
    // The sibling key itself survives…
    expect(rawCount(db, "app_provider_models")).toBe(0);
    expect((await store.getAppConfig(app.id)).keys.anthropic).toEqual([two]);
    // …and a re-verification of the surviving key rebuilds its own evidence.
    await store.saveVerifiedKey(app.id, "anthropic", two, ["claude-sonnet-4-6"]);
    expect(rawCount(db, "app_provider_models")).toBe(1);
    // The last key's delete clears its evidence too (a verified list for a
    // keyless provider is exactly the stale state the dropdown must never show).
    expect(await store.deleteProviderKey(app.id, "anthropic", await keyIdOf(two))).toBe(true);
    expect(rawCount(db, "app_provider_keys")).toBe(0);
    expect(rawCount(db, "app_provider_models")).toBe(0);
    // An unknown key id is an idempotent no-op.
    expect(await store.deleteProviderKey(app.id, "anthropic", "0".repeat(16))).toBe(false);
  });

  test("a MISSED per-key delete leaves the cache and every row untouched (the cache clears only on a real removal)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    const one = sk("first-key-aaaa");
    const two = sk("second-key-bbbb");
    await store.saveVerifiedKey(app.id, "anthropic", one, ["claude-sonnet-4-6"]);
    await store.addProviderKey(app.id, "anthropic", two);
    const poolBefore = db.raw.query("SELECT * FROM app_provider_keys WHERE app_id = ? ORDER BY key_id").all(app.id);
    // A STALE / unmatched key id while a sibling key still exists: the delete
    // statement matches nothing, so every row survives — wiping anything here
    // would contradict the route's own "nothing changed" report.
    expect(await store.deleteProviderKey(app.id, "anthropic", "0".repeat(16))).toBe(false);
    expect(rawCount(db, "app_provider_models")).toBe(1);
    expect(db.raw.query("SELECT * FROM app_provider_keys WHERE app_id = ? ORDER BY key_id").all(app.id)).toEqual(
      poolBefore,
    );
    // The verified key keeps its own evidence (`two` was added unverified, so it
    // has none — that is what makes the pool's vocabulary unknown).
    expect((await store.getVerifiedModels(app.id)).map((row) => ({ provider: row.provider, models: row.models }))).toEqual([
      { provider: "anthropic", models: [] },
    ]);
  });

  test("deleteProviderKey removes a migrated (not-yet-promoted) key by its derived id — no prior read needed", async () => {
    const db = createPreProviderPoolD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const legacy = sk("legacy-delete-me-4242");
    // The pre-pool row a live deployment carries across 0024.
    const legacyEnc = await createSecretbox(TEST_KEY).encryptSecret(
      legacy,
      `app_provider_keys.key_enc:${app.id}:anthropic`,
    );
    rawRun(
      db,
      `INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at, updated_at)
       VALUES (?, 'anthropic', ?, '2026-01-01 00:00:00', '2026-01-02 00:00:00')`,
      app.id,
      legacyEnc,
    );
    applyMigration(db, "0024_provider_multi_key.sql");
    applyMigration(db, "0025_provider_model_evidence.sql");
    // Carried verbatim under the sentinel id: only the DELETE's OWN promotion
    // can make the derived id addressable — no list/config call ran before it.
    const carried = db.raw.query("SELECT key_id FROM app_provider_keys").get() as { key_id: string };
    expect(carried.key_id).toBe("");
    expect(await configStore(db).deleteProviderKey(app.id, "anthropic", await keyIdOf(legacy))).toBe(true);
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });

  test("cross-App isolation: App X's config never contains App Y's keys (full-object assert)", async () => {
    const db = createAppConfigD1();
    const x = await seedApp(db, { slug: "app-x", createdBy: "mallory" });
    const y = await seedApp(db, { slug: "app-y", createdBy: "ada", githubAppId: 1002 });
    const store = configStore(db);
    await store.addProviderKey(x.id, "anthropic", sk("x-anthropic-key-1111"));
    await store.addProviderKey(y.id, "anthropic", sk("y-anthropic-key-2222"));
    await store.addProviderKey(y.id, "openai", sk("y-openai-key-3333"));
    const cfgX = await store.getAppConfig(x.id);
    expect(Object.keys(cfgX.keys)).toEqual(["anthropic"]);
    expect(cfgX.keys.anthropic).toEqual([sk("x-anthropic-key-1111")]);
    const serialized = JSON.stringify(cfgX);
    expect(serialized).not.toContain(sk("y-anthropic-key-2222"));
    expect(serialized).not.toContain(sk("y-openai-key-3333"));
    // The masked list is scoped the same way.
    const listX = await store.listProviderKeys(x.id);
    expect(listX.map((key) => key.keyId)).toEqual([await keyIdOf(sk("x-anthropic-key-1111"))]);
    expect(listX.map((key) => key.last4)).toEqual(["1111"]);
  });

  test("fresh insert: updated_at == created_at — one clock read for both (migration 0012)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    await configStore(db).addProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const row = db.raw.query("SELECT created_at, updated_at FROM app_provider_keys").get() as {
      created_at: string;
      updated_at: string;
    };
    expect(row.updated_at).toMatch(SQLITE_TS_RE);
    expect(row.updated_at).toBe(row.created_at);
  });

  test("re-submitting a stored key bumps its timestamps (the conflict path writes a fresh clock)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    const key = sk("v1-aaaa");
    await store.addProviderKey(app.id, "anthropic", key);
    // Backdate the row so the second write's clock is observably LATER.
    rawRun(
      db,
      "UPDATE app_provider_keys SET created_at = '2026-01-01 00:00:00', updated_at = '2026-01-01 00:00:00' WHERE app_id = ? AND provider = 'anthropic'",
      app.id,
    );
    await store.addProviderKey(app.id, "anthropic", key);
    expect(rawCount(db, "app_provider_keys")).toBe(1);
    const row = db.raw.query("SELECT created_at, updated_at FROM app_provider_keys").get() as {
      created_at: string;
      updated_at: string;
    };
    expect(row.updated_at).toMatch(SQLITE_TS_RE);
    // created_at is the key's ENTRY time and stays: a re-submission updates in
    // place, so the pool order (created_at, key_id) never shifts under a
    // re-verify.
    expect(row.created_at).toBe("2026-01-01 00:00:00");
    expect(row.updated_at > "2026-01-01 00:00:00").toBe(true); // same-format string compare
    // The masked list reflects the moved timestamp.
    const list = await store.listProviderKeys(app.id);
    expect(list).toEqual([
      {
        provider: "anthropic",
        keyId: await keyIdOf(key),
        last4: "aaaa",
        updatedAt: row.updated_at,
        verifiedAt: null,
        verifiedStatus: null,
      },
    ]);
  });

  test("listProviderKeys returns updatedAt per row; a pre-0012 row reads NULL until re-set", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.addProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    await store.addProviderKey(app.id, "kilo", sk("kilo-key-1234"));
    // The legacy shape: a pre-0012 row whose updated_at is NULL.
    rawRun(db, "UPDATE app_provider_keys SET updated_at = NULL WHERE provider = 'kilo'");
    const list = await store.listProviderKeys(app.id);
    expect(list).toHaveLength(2);
    // provider-ascending: anthropic (current) then kilo (legacy placeholder).
    expect(list[0]).toEqual({
      provider: "anthropic",
      keyId: await keyIdOf(PLAIN_ANTHROPIC_KEY),
      last4: "9988",
      updatedAt: expect.stringMatching(SQLITE_TS_RE),
      verifiedAt: null,
      verifiedStatus: null,
    });
    expect(list[1]).toEqual({
      provider: "kilo",
      keyId: await keyIdOf(sk("kilo-key-1234")),
      last4: "1234",
      updatedAt: null,
      verifiedAt: null,
      verifiedStatus: null,
    });
  });

  test("addProviderKey accepts a key of exactly 4096 characters (the bound is inclusive)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    await configStore(db).addProviderKey(app.id, "anthropic", "k".repeat(MAX_PROVIDER_KEY_LENGTH));
    expect(rawCount(db, "app_provider_keys")).toBe(1);
  });

  test("addProviderKey rejects a key over 4096 characters with the typed error — zero rows written", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    await expect(
      configStore(db).addProviderKey(app.id, "anthropic", "k".repeat(MAX_PROVIDER_KEY_LENGTH + 1)),
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
    const row = db.raw
      .query("SELECT chain, updated_at FROM app_model_chains WHERE name = 'default'")
      .get() as { chain: string | null; updated_at: string };
    expect(row.chain).toBe(PLAIN_CHAIN); // plaintext by design — not a secret
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("setModelChain upserts: a second save replaces the chain", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "first/model");
    await store.setModelChain(app.id, "second/model");
    expect(rawCount(db, "app_model_chains")).toBe(1);
    expect(await store.getModelChain(app.id)).toBe("second/model");
  });

  test("setModelChain(null) REMOVES the row (absent = unset; such an App's reviews fail closed — AL-24-5)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "first/model");
    await store.setModelChain(app.id, null);
    expect(rawCount(db, "app_model_chains")).toBe(0);
    expect(await store.getModelChain(app.id)).toBeNull();
    // Clearing an app that never had a chain is a quiet no-op.
    await expect(store.setModelChain(app.id, null)).resolves.toBeUndefined();
  });

  test("setModelChain(\"\") CLEARS the row — same path as null (empty = unset = fail closed)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "first/model");
    await store.setModelChain(app.id, "");
    expect(rawCount(db, "app_model_chains")).toBe(0);
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
    expect(rawCount(db, "app_model_chains")).toBe(0);
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
    // Zero-config is an EMPTY config, not a fallback: there is no global env
    // chain or key anymore — the consumer's assertAppConfigComplete
    // fail-closes such an App (missing model chain).
    expect(await configStore(db).getAppConfig(bare.id)).toEqual({
      appId: bare.id,
      keys: {},
      modelChain: null,
    });
    const configured = await seedApp(db, { slug: "full", createdBy: "ada", githubAppId: 1002 });
    const store = configStore(db);
    await store.addProviderKey(configured.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    await store.setModelChain(configured.id, PLAIN_CHAIN);
    const cfg = await store.getAppConfig(configured.id);
    expect(cfg).toEqual({
      appId: configured.id,
      keys: { anthropic: [PLAIN_ANTHROPIC_KEY] },
      modelChain: PLAIN_CHAIN,
    });
  });

  test("tampered ciphertext is a loud throw, never a silent skip", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.addProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    rawRun(db, "UPDATE app_provider_keys SET key_enc = 'v1.primary.aXZpdi.dGFtcGVyZWQ='");
    await expect(store.listProviderKeys(app.id)).rejects.toThrow(/secretbox/);
    await expect(store.getAppConfig(app.id)).rejects.toThrow(/secretbox/);
  });
});

// --- store: model chains + seats (spec §4.4) ---

describe("app-config store (createAppConfigStore) — model chains + seats", () => {
  test("setModelChain stores the default row VERBATIM (:thinking suffix and padding untouched); getModelChain reads it back", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "  ark-plan/deepseek-v4-flash:high ");
    expect(await store.getModelChain(app.id)).toBe("  ark-plan/deepseek-v4-flash:high ");
    const row = db.raw
      .query("SELECT app_id, name, chain, is_default FROM app_model_chains WHERE name = 'default'")
      .get() as { app_id: string; name: string; chain: string; is_default: number };
    expect(row.chain).toBe("  ark-plan/deepseek-v4-flash:high "); // plaintext by design — not a secret
    expect(row.is_default).toBe(1);
    expect(row.app_id).toBe(app.id);
  });

  test("setModelChain upserts: a second save replaces the chain (one default row per app)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "first/model");
    await store.setModelChain(app.id, "second/model");
    expect(rawCount(db, "app_model_chains")).toBe(1);
    expect(await store.getModelChain(app.id)).toBe("second/model");
  });

  test('setModelChain(null) CLEARS the default row; clearing an unset default is a quiet no-op', async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "first/model");
    await store.setModelChain(app.id, null);
    expect(rawCount(db, "app_model_chains")).toBe(0);
    expect(await store.getModelChain(app.id)).toBeNull();
    // Clearing a default that never existed resolves without error.
    await expect(store.setModelChain(app.id, "")).resolves.toBeUndefined();
  });

  test("a whitespace-only chain is blank = clear; a padded real chain upserts VERBATIM", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "   ");
    expect(rawCount(db, "app_model_chains")).toBe(0);
    const padded = "  openai/gpt-5 , anthropic/claude-x  ";
    await store.setModelChain(app.id, padded);
    expect(await store.getModelChain(app.id)).toBe(padded);
  });

  test("is_default uniqueness is enforced in ONE batch (clear-old-set-new): a rogue direct-DB default row is swept", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "first/model");
    // A rogue is_default=1 row (a direct-DB write the store never made —
    // the "race" shape the batch invariant must absorb).
    rawRun(
      db,
      `INSERT INTO app_model_chains (app_id, name, chain, is_default, created_at, updated_at)
       VALUES (?, 'rogue', 'x/y', 1, datetime('now'), datetime('now'))`,
      app.id,
    );
    await store.setModelChain(app.id, "second/model");
    // Exactly ONE is_default=1 row after the write, and it is the 'default' row.
    const defaults = db.raw
      .query("SELECT name, chain FROM app_model_chains WHERE app_id = ? AND is_default = 1")
      .all(app.id) as Array<{ name: string; chain: string }>;
    expect(defaults).toEqual([{ name: "default", chain: "second/model" }]);
  });

  test("upsertModelChain creates a named chain (is_default=0); getModelChains lists default first then named", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "ark-plan/deepseek-v4-flash");
    await store.upsertModelChain(app.id, "fast", "openai/gpt-5:thinking");
    await store.upsertModelChain(app.id, "cheap", "groq/llama-3-3");
    const chains = await store.getModelChains(app.id);
    expect(chains.map((c) => ({ name: c.name, chain: c.chain, is_default: c.is_default }))).toEqual([
      { name: "cheap", chain: "groq/llama-3-3", is_default: false },
      { name: "default", chain: "ark-plan/deepseek-v4-flash", is_default: true },
      { name: "fast", chain: "openai/gpt-5:thinking", is_default: false },
    ]);
  });

  test("upsertModelChain replaces an existing named chain; the reserved 'default' name is rejected (store backstop)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.upsertModelChain(app.id, "fast", "first/model");
    await store.upsertModelChain(app.id, "fast", "second/model");
    expect(rawCount(db, "app_model_chains")).toBe(1);
    expect((await store.getModelChains(app.id))[0]!.chain).toBe("second/model");
    for (const name of ["default", "Default", "UPPER", "has space", "-lead", "a".repeat(65)]) {
      await expect(store.upsertModelChain(app.id, name, "x/y")).rejects.toThrow(InvalidModelChainNameError);
    }
    expect(rawCount(db, "app_model_chains")).toBe(1);
  });

  test("upsertModelChain with a blank chain → InvalidModelSelectorError, zero rows written", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await expect(store.upsertModelChain(app.id, "fast", "   ")).rejects.toThrow(InvalidModelSelectorError);
    expect(rawCount(db, "app_model_chains")).toBe(0);
  });

  test("removeModelChain deletes the named chain AND its seat references in ONE atomic batch (seats fall back to default)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "ark-plan/deepseek-v4-flash");
    await store.upsertModelChain(app.id, "fast", "openai/gpt-5");
    await store.setModelChainSeat(app.id, "code-reviewer", "fast");
    await store.setModelChainSeat(app.id, "frontend-dev", "fast");
    expect(await store.removeModelChain(app.id, "fast")).toBe(true);
    // The chain row is gone AND both reference rows are gone (absent = default).
    expect(rawCount(db, "app_model_chains")).toBe(1); // only the default row
    expect(rawCount(db, "app_model_chain_seats")).toBe(0);
    expect(await store.getModelChainSeats(app.id)).toEqual({});
    // Removing an unknown name is an idempotent no-op returning false.
    expect(await store.removeModelChain(app.id, "nope")).toBe(false);
    // The reserved 'default' row cannot be removed via this method.
    await expect(store.removeModelChain(app.id, "default")).rejects.toThrow(InvalidModelChainNameError);
  });

  test("setModelChainSeat stores a chain reference; getModelChainSeats reads it back; blank/'default' clears (absent = default)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.upsertModelChain(app.id, "fast", "openai/gpt-5");
    await store.setModelChainSeat(app.id, "code-reviewer", "fast");
    expect(await store.getModelChainSeats(app.id)).toEqual({ "code-reviewer": "fast" });
    // Blank clears the reference row (the seat uses the default chain).
    await store.setModelChainSeat(app.id, "code-reviewer", "");
    expect(rawCount(db, "app_model_chain_seats")).toBe(0);
    expect(await store.getModelChainSeats(app.id)).toEqual({});
    // The reserved "default" name also clears (never stored as a reference).
    await store.setModelChainSeat(app.id, "code-reviewer", "fast");
    await store.setModelChainSeat(app.id, "code-reviewer", "default");
    expect(rawCount(db, "app_model_chain_seats")).toBe(0);
    // Clearing a seat that never had a reference resolves without error.
    await expect(store.setModelChainSeat(app.id, "code-reviewer", "")).resolves.toBeUndefined();
  });

  test("setModelChainSeat referencing a missing chain → UnknownModelChainError, zero rows written", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await expect(store.setModelChainSeat(app.id, "code-reviewer", "no-such-chain")).rejects.toThrow(
      UnknownModelChainError,
    );
    expect(rawCount(db, "app_model_chain_seats")).toBe(0);
  });

  test("off-vocabulary role → UnknownModelRoleError, zero rows written (setModelChainSeat/clearModelChainSeat/setModelChainSeats)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    for (const role of ["reviewer", "smol", "mstar-review-seat "]) {
      await expect(store.setModelChainSeat(app.id, role, "fast")).rejects.toThrow(UnknownModelRoleError);
      await expect(store.clearModelChainSeat(app.id, role)).rejects.toThrow(UnknownModelRoleError);
      await expect(store.setModelChainSeats(app.id, { [role]: "fast" })).rejects.toThrow(UnknownModelRoleError);
    }
    // Even a VALID role is rejected when it rides an invalid map entry.
    await expect(
      store.setModelChainSeats(app.id, { "code-reviewer": "fast", reviewer: "fast" }),
    ).rejects.toThrow(UnknownModelRoleError);
    expect(rawCount(db, "app_model_chain_seats")).toBe(0);
  });

  test("setModelChainSeats saves the full map in one call; one bad entry fails BEFORE any write", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.upsertModelChain(app.id, "fast", "openai/gpt-5");
    await store.setModelChainSeat(app.id, "code-reviewer", "fast");
    await store.setModelChainSeats(app.id, {
      "mstar-review-seat": "fast",
      "code-reviewer": "", // cleared by the same save (absent = default)
      "fullstack-dev": "fast",
      "frontend-dev": "",
    });
    expect(await store.getModelChainSeats(app.id)).toEqual({
      "fullstack-dev": "fast",
      "mstar-review-seat": "fast",
    });
    // Validation is whole-map-first: the valid entry in this map must NOT
    // reach the DB — zero rows touched by the failed call.
    await expect(
      store.setModelChainSeats(app.id, { "frontend-dev": "fast", "code-reviewer": "no-such-chain" }),
    ).rejects.toThrow(UnknownModelChainError);
    expect(rawCount(db, "app_model_chain_seats")).toBe(2);
  });

  test("F-001: seat references are canonicalized — padded names hit the real chain, never a dangling row (setModelChainSeat)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.upsertModelChain(app.id, "fast", "openai/gpt-5");
    // A padded known name stores the TRIMMED reference (the consumer read
    // must resolve it — no `references missing chain "fast "` failure).
    await store.setModelChainSeat(app.id, "code-reviewer", "  fast  ");
    expect(await store.getModelChainSeats(app.id)).toEqual({ "code-reviewer": "fast" });
    expect(rawCount(db, "app_model_chain_seats")).toBe(1);
    const chainName = db.raw
      .query("SELECT chain_name FROM app_model_chain_seats WHERE app_id = ? AND role = ?")
      .get(app.id, "code-reviewer") as { chain_name: string };
    expect(chainName.chain_name).toBe("fast");
    // A padded reference resolves instead of throwing (the fail-closed
    // consumer read is the exact failure F-001 prevented).
    await expect(store.getModelOverridesForConsumer(app.id)).resolves.toEqual({ "code-reviewer": "openai/gpt-5" });
    // Padded "default" / whitespace-only clear the reference row.
    await store.setModelChainSeat(app.id, "code-reviewer", "  default  ");
    expect(rawCount(db, "app_model_chain_seats")).toBe(0);
    await store.setModelChainSeat(app.id, "code-reviewer", "fast");
    await store.setModelChainSeat(app.id, "code-reviewer", " \t ");
    expect(rawCount(db, "app_model_chain_seats")).toBe(0);
  });

  test("F-001: bulk setModelChainSeats binds the trimmed name; a padded 'default' clears (zero dangling rows)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.upsertModelChain(app.id, "fast", "openai/gpt-5");
    await store.setModelChainSeats(app.id, {
      "code-reviewer": "fast ", // trailing space — must store "fast", not "fast "
      "frontend-dev": "  default  ", // padded reserved name — clears
    });
    expect(await store.getModelChainSeats(app.id)).toEqual({ "code-reviewer": "fast" });
    expect(rawCount(db, "app_model_chain_seats")).toBe(1);
    await expect(store.getModelOverridesForConsumer(app.id)).resolves.toEqual({ "code-reviewer": "openai/gpt-5" });
  });

  test("setModelChainSeats is ONE atomic batch: a batch failure leaves ZERO rows changed (Phase 5, PR #7 review)", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.upsertModelChain(app.id, "fast", "openai/gpt-5");
    await store.setModelChainSeat(app.id, "code-reviewer", "fast");
    const failing = createBatchRejectingD1(db);
    await expect(
      configStore(failing).setModelChainSeats(app.id, {
        "mstar-review-seat": "fast",
        "code-reviewer": "", // blank = clear — must not land either
      }),
    ).rejects.toThrow(/simulated D1 batch failure/);
    // The whole map rides ONE batch — there is no sequential-apply path.
    expect(failing.batchCalls()).toBe(1);
    // Atomic: the pre-existing row is untouched — nothing half-applied.
    expect(await configStore(db).getModelChainSeats(app.id)).toEqual({ "code-reviewer": "fast" });
    expect(rawCount(db, "app_model_chain_seats")).toBe(1);
  });

  test("getModelOverridesForConsumer resolves seats → chain values; default-referenced and absent seats are omitted", async () => {
    const db = createAppConfigD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const store = configStore(db);
    await store.setModelChain(app.id, "ark-plan/deepseek-v4-flash");
    await store.upsertModelChain(app.id, "fast", "openai/gpt-5:thinking, anthropic/claude-x");
    await store.upsertModelChain(app.id, "cheap", "groq/llama-3-3");
    // code-reviewer → named chain (in the map); mstar-review-seat → default
    // chain (omitted); fullstack-dev → no reference row (omitted).
    await store.setModelChainSeat(app.id, "code-reviewer", "fast");
    await store.setModelChainSeat(app.id, "mstar-review-seat", "default");
    expect(await store.getModelOverridesForConsumer(app.id)).toEqual({
      "code-reviewer": "openai/gpt-5:thinking, anthropic/claude-x",
    });
    // A seat referencing a missing chain (direct-DB tamper) fails loud.
    rawRun(
      db,
      `INSERT INTO app_model_chain_seats (app_id, role, chain_name) VALUES (?, 'frontend-dev', 'ghost')`,
      app.id,
    );
    await expect(store.getModelOverridesForConsumer(app.id)).rejects.toThrow(/references missing chain/);
  });

  test("getModelChainSeats on an app with no references is an EMPTY map (= every seat uses the default chain)", async () => {
    const db = createAppConfigD1();
    const bare = await seedApp(db, { slug: "bare", createdBy: "mallory" });
    expect(await configStore(db).getModelChainSeats(bare.id)).toEqual({});
    expect(await configStore(db).getModelOverridesForConsumer(bare.id)).toEqual({});
  });

  test("cross-App isolation: App X's chains/seats never contain App Y's (full-object assert)", async () => {
    const db = createAppConfigD1();
    const x = await seedApp(db, { slug: "app-x", createdBy: "mallory" });
    const y = await seedApp(db, { slug: "app-y", createdBy: "ada", githubAppId: 1002 });
    const store = configStore(db);
    await store.upsertModelChain(x.id, "fast", "openai/gpt-x");
    await store.setModelChainSeat(x.id, "code-reviewer", "fast");
    await store.upsertModelChain(y.id, "cheap", "anthropic/claude-y");
    await store.setModelChainSeat(y.id, "mstar-review-seat", "cheap");
    expect(await store.getModelChains(x.id)).toHaveLength(1);
    expect(await store.getModelChainSeats(x.id)).toEqual({ "code-reviewer": "fast" });
    expect(await store.getModelChainSeats(y.id)).toEqual({ "mstar-review-seat": "cheap" });
  });

  test("unknown app_id → FK violation on insert (fail-loud, same as every write here)", async () => {
    const db = createAppConfigD1();
    // upsertModelChain's name gate passes, so the INSERT hits the FK.
    await expect(
      configStore(db).upsertModelChain("no-such-app", "fast", "openai/gpt-5"),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});

// --- store: custom providers ---

describe("app-config store (createAppConfigStore) — custom providers", () => {
  const CUSTOM: AppCustomProvider = {
    // NOT a built-in: "ark" is a PROVIDER_IDS member from the
    // AL-24-5 ark-plan entry, so a custom declaration must use a free id.
    provider_id: "my-custom",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
    model_ids: ["deepseek-v4-flash", "deepseek-r1"],
  };
  const PLAIN_CUSTOM_KEY = sk("custom-ark-9988");

  test("upsert stores the declaration and its key row (secretbox envelope at rest); the list face carries NO key material", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    // The declaration keeps only what the runner needs — no key material.
    const decl = db.raw
      .query("SELECT * FROM app_custom_providers WHERE app_id = ? AND provider_id = ?")
      .get(app.id, CUSTOM.provider_id) as { model_ids: string; created_at: string; updated_at: string };
    // model_ids is stored as a TEXT JSON array (AL-23-1 DDL).
    expect(JSON.parse(decl.model_ids)).toEqual([...CUSTOM.model_ids]);
    expect(decl.created_at).toMatch(SQLITE_TS_RE);
    expect(decl.updated_at).toBe(decl.created_at);
    // At rest the key is a secretbox envelope in the per-key pool table.
    const keyRow = db.raw
      .query("SELECT provider, key_id, key_enc, verified_at, verified_status FROM app_custom_provider_keys WHERE app_id = ?")
      .get(app.id) as {
      provider: string;
      key_id: string;
      key_enc: string;
      verified_at: string | null;
      verified_status: string | null;
    };
    expect(keyRow.provider).toBe(CUSTOM.provider_id);
    expect(keyRow.key_id).toBe(await keyIdOf(PLAIN_CUSTOM_KEY));
    expect(keyRow.key_enc).toMatch(/^v1\.primary\./);
    expect(keyRow.key_enc).not.toContain(PLAIN_CUSTOM_KEY);
    // The declaration flow verifies before saving, so the key lands 'ok'.
    expect(keyRow.verified_status).toBe("ok");
    expect(keyRow.verified_at).toMatch(SQLITE_TS_RE);
    // The list faces are decrypt-free: declaration + masked tail, never keys.
    await expect(configStore(db).listCustomProviders(app.id)).resolves.toEqual([{ ...CUSTOM, has_keys: true }]);
    const keys = await configStore(db).listCustomProviderKeys(app.id);
    expect(keys.map((key) => ({ provider: key.provider, last4: key.last4, verifiedStatus: key.verifiedStatus }))).toEqual([
      { provider: CUSTOM.provider_id, last4: "9988", verifiedStatus: "ok" },
    ]);
    expect(JSON.stringify(keys)).not.toContain(PLAIN_CUSTOM_KEY);
  });

  test("AAD rowKey is the exact string app_custom_provider_keys.key_enc:<app_id>:<provider>:<key_id> — the consumer decrypts with it", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    const row = db.raw
      .query("SELECT key_id, key_enc FROM app_custom_provider_keys WHERE app_id = ? AND provider = ?")
      .get(app.id, CUSTOM.provider_id) as { key_id: string; key_enc: string };
    const box = createSecretbox(TEST_KEY);
    // The full-row rowKey (the 0006 L1 precedent, extended per key) decrypts.
    await expect(
      box.decryptSecret(row.key_enc, `app_custom_provider_keys.key_enc:${app.id}:${CUSTOM.provider_id}:${row.key_id}`),
    ).resolves.toBe(PLAIN_CUSTOM_KEY);
    // The envelope is bound to all THREE components — any single one off fails.
    await expect(
      box.decryptSecret(row.key_enc, `app_custom_provider_keys.key_enc:${app.id}:other:${row.key_id}`),
    ).rejects.toThrow();
    await expect(
      box.decryptSecret(row.key_enc, `app_custom_provider_keys.key_enc:other:${CUSTOM.provider_id}:${row.key_id}`),
    ).rejects.toThrow();
    await expect(
      box.decryptSecret(row.key_enc, `app_custom_provider_keys.key_enc:${app.id}:${CUSTOM.provider_id}:${"0".repeat(16)}`),
    ).rejects.toThrow();
  });

  test("re-upserting a provider_id updates the declaration; a re-submitted key stays one slot, a new key adds one", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    db.raw
      .prepare("UPDATE app_custom_providers SET updated_at = '2026-01-01 00:00:00' WHERE app_id = ? AND provider_id = ?")
      .run(app.id, CUSTOM.provider_id);
    await store.upsertCustomProvider(app.id, { ...CUSTOM, model_ids: ["deepseek-v4-flash"] }, PLAIN_CUSTOM_KEY);
    const decl = db.raw
      .query("SELECT model_ids, updated_at FROM app_custom_providers WHERE app_id = ? AND provider_id = ?")
      .get(app.id, CUSTOM.provider_id) as { model_ids: string; updated_at: string };
    expect(JSON.parse(decl.model_ids)).toEqual(["deepseek-v4-flash"]);
    expect(decl.updated_at).toMatch(SQLITE_TS_RE);
    expect(decl.updated_at > "2026-01-01 00:00:00").toBe(true);
    // The SAME key re-submitted updates its own slot (no second row)…
    expect(rawCount(db, "app_custom_provider_keys")).toBe(1);
    const keyRow = db.raw.query("SELECT key_enc FROM app_custom_provider_keys").get() as { key_enc: string };
    await expect(
      createSecretbox(TEST_KEY).decryptSecret(
        keyRow.key_enc,
        `app_custom_provider_keys.key_enc:${app.id}:${CUSTOM.provider_id}:${await keyIdOf(PLAIN_CUSTOM_KEY)}`,
      ),
    ).resolves.toBe(PLAIN_CUSTOM_KEY);
    // …while a DIFFERENT key becomes a second slot of the same declaration.
    await store.upsertCustomProvider(app.id, { ...CUSTOM, model_ids: ["deepseek-v4-flash"] }, sk("custom-ark-7777"));
    expect(rawCount(db, "app_custom_provider_keys")).toBe(2);
    const keys = await store.listCustomProviderKeys(app.id, CUSTOM.provider_id);
    expect(keys.map((key) => key.last4).sort()).toEqual(["7777", "9988"]);
  });

  test("an endpoint change is refused while the pool holds a key (A1) — zero writes; an emptied pool re-declares freely", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    await store.addCustomProviderKey(app.id, CUSTOM.provider_id, sk("custom-ark-7777"));
    const selectDeclaration = `SELECT base_url, api, model_ids, created_at, updated_at
       FROM app_custom_providers WHERE app_id = ? AND provider_id = ?`;
    const before = db.raw.query(selectDeclaration).get(app.id, CUSTOM.provider_id);
    // Both endpoint columns are locked while the pool carries credentials the
    // declaration flow verified for the CURRENT endpoint.
    for (const moved of [
      { ...CUSTOM, base_url: "https://elsewhere.example.com/v1" },
      { ...CUSTOM, api: "anthropic-messages" as const },
    ]) {
      await expect(store.upsertCustomProvider(app.id, moved, sk("custom-ark-8888"))).rejects.toThrow(
        ProviderEndpointLockedError,
      );
    }
    // Byte-identical declaration, untouched pool: the refusal wrote nothing.
    expect(db.raw.query(selectDeclaration).get(app.id, CUSTOM.provider_id)).toEqual(before);
    expect(rawCount(db, "app_custom_provider_keys")).toBe(2);
    // model_ids still move while the endpoint does not (declaration config,
    // never a credential binding).
    await store.upsertCustomProvider(app.id, { ...CUSTOM, model_ids: ["deepseek-r1"] }, PLAIN_CUSTOM_KEY);
    // An EMPTIED pool frees the endpoint: remove the credentials, re-declare.
    await store.deleteCustomProviderKey(app.id, CUSTOM.provider_id, await keyIdOf(PLAIN_CUSTOM_KEY));
    await store.deleteCustomProviderKey(app.id, CUSTOM.provider_id, await keyIdOf(sk("custom-ark-7777")));
    expect(rawCount(db, "app_custom_provider_keys")).toBe(0);
    await expect(
      store.upsertCustomProvider(app.id, { ...CUSTOM, base_url: "https://elsewhere.example.com/v1" }, PLAIN_CUSTOM_KEY),
    ).resolves.toBeUndefined();
    expect((await store.listCustomProviders(app.id))[0]!.base_url).toBe("https://elsewhere.example.com/v1");
  });

  test("the consumer face reads a declaration and its pool from ONE snapshot (A2): a remove + re-declare cannot pair endpoint A with key B", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    const MOVED: AppCustomProvider = { ...CUSTOM, base_url: "https://elsewhere.example.com/v1" };
    const MOVED_KEY = sk("custom-moved-6161");
    // Controlled interleaving: a concurrent remove + re-declaration commits at
    // the moment the OLD two-statement read had already taken the declaration
    // and not yet the pool (the first statement that reads the pool table).
    const racing = configStore(
      createPoolReadRaceD1(db, async () => {
        await configStore(db).removeCustomProvider(app.id, CUSTOM.provider_id);
        await configStore(db).upsertCustomProvider(app.id, MOVED, MOVED_KEY);
      }),
    );
    // Endpoint and credentials are ONE view: the snapshot is either {A, keyA} or
    // {B, keyB}, never {A, keyB}.
    await expect(racing.getCustomProvidersForConsumer(app.id)).resolves.toEqual([
      { ...MOVED, api_keys: [MOVED_KEY] },
    ]);
  });

  test("custom-provider keys resolve through the new pool table: ordered, maskable, deletable, legacy rows promoted", async () => {
    // A pre-pool DB: the declaration's key material still sits in the old column.
    const db = createPreProviderPoolD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const legacyEnc = await createSecretbox(TEST_KEY).encryptSecret(
      PLAIN_CUSTOM_KEY,
      `app_custom_providers.api_key_enc:${app.id}:${CUSTOM.provider_id}`,
    );
    rawRun(
      db,
      `INSERT INTO app_custom_providers
         (app_id, provider_id, base_url, api, model_ids, api_key_enc, created_at, updated_at, verified_at, verified_status)
       VALUES (?, ?, ?, ?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'ok')`,
      app.id,
      CUSTOM.provider_id,
      CUSTOM.base_url,
      CUSTOM.api,
      JSON.stringify(CUSTOM.model_ids),
      legacyEnc,
    );
    applyMigration(db, "0024_provider_multi_key.sql");
    const store = configStore(db);
    // The legacy row still decrypts through the consumer face and is promoted
    // to the three-segment AAD under its derived id.
    expect(await store.getCustomProvidersForConsumer(app.id)).toEqual([
      { ...CUSTOM, api_keys: [PLAIN_CUSTOM_KEY] },
    ]);
    const legacyRow = db.raw.query("SELECT key_id, key_enc FROM app_custom_provider_keys").get() as {
      key_id: string;
      key_enc: string;
    };
    expect(legacyRow.key_id).toBe(await keyIdOf(PLAIN_CUSTOM_KEY));
    await expect(
      createSecretbox(TEST_KEY).decryptSecret(
        legacyRow.key_enc,
        `app_custom_provider_keys.key_enc:${app.id}:${CUSTOM.provider_id}:${legacyRow.key_id}`,
      ),
    ).resolves.toBe(PLAIN_CUSTOM_KEY);
    // A second key joins the pool; order is (created_at, key_id) — the legacy
    // row was backdated, so it stays first.
    const second = sk("custom-ark-7777");
    await store.addCustomProviderKey(app.id, CUSTOM.provider_id, second);
    expect(rawCount(db, "app_custom_provider_keys")).toBe(2);
    const keys = await store.listCustomProviderKeys(app.id, CUSTOM.provider_id);
    expect(keys.map((key) => key.keyId)).toEqual([await keyIdOf(PLAIN_CUSTOM_KEY), await keyIdOf(second)]);
    expect(keys.map((key) => key.verifiedStatus)).toEqual(["ok", null]);
    expect(JSON.stringify(keys)).not.toContain(PLAIN_CUSTOM_KEY);
    expect(await store.getCustomProvidersForConsumer(app.id)).toEqual([
      { ...CUSTOM, api_keys: [PLAIN_CUSTOM_KEY, second] },
    ]);
    // One delete removes exactly ONE slot.
    expect(await store.deleteCustomProviderKey(app.id, CUSTOM.provider_id, await keyIdOf(second))).toBe(true);
    expect((await store.getCustomProvidersForConsumer(app.id))[0]!.api_keys).toEqual([PLAIN_CUSTOM_KEY]);
    expect(await store.deleteCustomProviderKey(app.id, CUSTOM.provider_id, "0".repeat(16))).toBe(false);
    // An undeclared provider id is a caller bug, never a silent slot.
    await expect(store.addCustomProviderKey(app.id, "not-declared", second)).rejects.toThrow(
      InvalidCustomProviderError,
    );
  });

  test("removeCustomProvider deletes the declaration AND its key rows; an unknown id is an idempotent no-op", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    await store.addCustomProviderKey(app.id, CUSTOM.provider_id, sk("custom-ark-7777"));
    expect(rawCount(db, "app_custom_provider_keys")).toBe(2);
    await expect(store.removeCustomProvider(app.id, "nope")).resolves.toBe(false);
    await expect(store.removeCustomProvider(app.id, CUSTOM.provider_id)).resolves.toBe(true);
    await expect(store.listCustomProviders(app.id)).resolves.toEqual([]);
    // The pool goes with the declaration — a leftover key row would be
    // unreachable data (and would resurface on a re-declaration).
    expect(rawCount(db, "app_custom_provider_keys")).toBe(0);
    await expect(store.removeCustomProvider(app.id, CUSTOM.provider_id)).resolves.toBe(false);
  });

  test("a refused ninth custom key commits NEITHER the key nor the changed declaration", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    for (let i = 1; i < MAX_KEYS_PER_PROVIDER; i++) {
      await store.addCustomProviderKey(app.id, CUSTOM.provider_id, sk(`custom-pool-key-${i}-${i}${i}${i}`));
    }
    expect(rawCount(db, "app_custom_provider_keys")).toBe(MAX_KEYS_PER_PROVIDER);
    // Backdate the declaration so ANY write to it is visible: datetime('now')
    // has one-second resolution, so a same-second rewrite could hide a commit.
    rawRun(
      db,
      `UPDATE app_custom_providers SET updated_at = '2026-01-01 00:00:00' WHERE app_id = ? AND provider_id = ?`,
      app.id,
      CUSTOM.provider_id,
    );
    const selectDeclaration = `SELECT base_url, api, model_ids, created_at, updated_at
       FROM app_custom_providers WHERE app_id = ? AND provider_id = ?`;
    const before = db.raw.query(selectDeclaration).get(app.id, CUSTOM.provider_id);
    const ninth = sk("custom-pool-key-ninth-9999");
    await expect(
      store.upsertCustomProvider(
        app.id,
        // The ENDPOINT stays put on purpose: an endpoint change with a populated
        // pool is refused earlier (A1, ProviderEndpointLockedError) — this case
        // pins the POOL-CAP refusal and its atomicity.
        { ...CUSTOM, model_ids: ["changed-model"] },
        ninth,
      ),
    ).rejects.toThrow(ProviderKeyLimitError);
    // Byte-identical declaration: the refusal committed neither write.
    expect(db.raw.query(selectDeclaration).get(app.id, CUSTOM.provider_id)).toEqual(before);
    expect(rawCount(db, "app_custom_provider_keys")).toBe(MAX_KEYS_PER_PROVIDER);
    const consumer = await store.getCustomProvidersForConsumer(app.id);
    expect(consumer[0]!.api_keys).toHaveLength(MAX_KEYS_PER_PROVIDER);
    expect(consumer[0]!.api_keys).not.toContain(ninth);
    expect(consumer[0]!.base_url).toBe(CUSTOM.base_url);
  });

  test("a crypto failure at declaration time leaves NO declaration behind", async () => {
    const { db, app } = await seededWorld();
    // No master key bound: the key can never be encrypted, so the declaration
    // must not be committed either (it was, when the declaration wrote first).
    const store = createAppConfigStore(db, undefined);
    await expect(store.upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY)).rejects.toThrow(/secretbox/);
    expect(rawCount(db, "app_custom_providers")).toBe(0);
    expect(rawCount(db, "app_custom_provider_keys")).toBe(0);
  });

  test("a declaration removed between the ownership read and the key write leaves no orphan credential", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    // Controlled interleaving: the removal (the same two DELETEs
    // removeCustomProvider runs as ONE batch) lands AFTER the caller's
    // declaration read and BEFORE its key write.
    const race = () => {
      rawRun(db, "DELETE FROM app_custom_provider_keys WHERE app_id = ? AND provider = ?", app.id, CUSTOM.provider_id);
      rawRun(db, "DELETE FROM app_custom_providers WHERE app_id = ? AND provider_id = ?", app.id, CUSTOM.provider_id);
    };
    await expect(
      configStore(createDeclarationRaceD1(db, race)).addCustomProviderKey(
        app.id,
        CUSTOM.provider_id,
        sk("custom-orphan-3131"),
      ),
    ).rejects.toThrow(InvalidCustomProviderError);
    expect(rawCount(db, "app_custom_providers")).toBe(0);
    expect(rawCount(db, "app_custom_provider_keys")).toBe(0);
    // Re-declaring the SAME id must not revive the refused credential.
    await store.upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    await expect(store.getCustomProvidersForConsumer(app.id)).resolves.toEqual([
      { ...CUSTOM, api_keys: [PLAIN_CUSTOM_KEY] },
    ]);
  });

  test("a declaration removed during upsertCustomProvider commits neither the declaration nor the key", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    const racing = configStore(
      createDeclarationRaceD1(db, () => {
        rawRun(db, "DELETE FROM app_custom_provider_keys WHERE app_id = ? AND provider = ?", app.id, CUSTOM.provider_id);
        rawRun(db, "DELETE FROM app_custom_providers WHERE app_id = ? AND provider_id = ?", app.id, CUSTOM.provider_id);
      }),
    );
    await expect(
      racing.upsertCustomProvider(app.id, { ...CUSTOM, model_ids: ["changed-model"] }, sk("custom-race-4141")),
    ).rejects.toThrow(InvalidCustomProviderError);
    expect(rawCount(db, "app_custom_providers")).toBe(0);
    expect(rawCount(db, "app_custom_provider_keys")).toBe(0);
  });

  test("a lost last-declaration-slot race leaves the losing save's key uncommitted (same-id concurrent create)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    // Seven declarations, so the App sits ONE slot below the cap.
    for (let i = 1; i < MAX_CUSTOM_PROVIDER_COUNT; i++) {
      await store.upsertCustomProvider(app.id, { ...CUSTOM, provider_id: `prov-${i}` }, PLAIN_CUSTOM_KEY);
    }
    expect(rawCount(db, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT - 1);
    const LOSING = sk("custom-losing-8282");
    const WINNING = sk("custom-winning-9292");
    const target = "prov-last";
    // The concurrent save wins the LAST slot under the SAME id "prov-last",
    // after this caller's absence/count reads passed and before its batch.
    const racing = configStore(
      createLastSlotRaceD1(db, async () => {
        await configStore(db).upsertCustomProvider(
          app.id,
          { ...CUSTOM, provider_id: target, base_url: "https://winner.example.com/v1", model_ids: ["winner-model"] },
          WINNING,
        );
      }),
    );
    await expect(
      racing.upsertCustomProvider(
        app.id,
        { ...CUSTOM, provider_id: target, base_url: "https://loser.example.com/v1", model_ids: ["loser-model"] },
        LOSING,
      ),
    ).rejects.toThrow("custom provider cap (8) reached");
    // The winner's declaration is intact — the loser's refused write committed
    // NEITHER a declaration change NOR a credential.
    expect(rawCount(db, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
    const decl = db.raw
      .query("SELECT base_url, model_ids FROM app_custom_providers WHERE app_id = ? AND provider_id = ?")
      .get(app.id, target) as { base_url: string; model_ids: string };
    expect(decl.base_url).toBe("https://winner.example.com/v1");
    expect(JSON.parse(decl.model_ids)).toEqual(["winner-model"]);
    // Exactly the winner's key — no losing row, hence no verification or
    // ciphertext update for the loser either. (One key per declaration: the
    // seven earlier ones plus the winner's.)
    expect(rawCount(db, "app_custom_provider_keys")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
    const consumer = await store.getCustomProvidersForConsumer(app.id);
    expect(consumer.find((row) => row.provider_id === target)!.api_keys).toEqual([WINNING]);

    // Same-key variant: the re-submitted identity already sits in the pool, so
    // pool admission's "key already there" branch passes — the growth gate is
    // the ONLY thing refusing it. The winner's ciphertext and verification
    // bookkeeping must survive byte-identical (a conflict-update would have
    // rewritten the envelope).
    const { db: db2, app: app2 } = await seededWorld();
    const store2 = configStore(db2);
    for (let i = 1; i < MAX_CUSTOM_PROVIDER_COUNT; i++) {
      await store2.upsertCustomProvider(app2.id, { ...CUSTOM, provider_id: `prov-${i}` }, PLAIN_CUSTOM_KEY);
    }
    let winnerRow: unknown = null;
    const racing2 = configStore(
      createLastSlotRaceD1(db2, async () => {
        await configStore(db2).upsertCustomProvider(
          app2.id,
          { ...CUSTOM, provider_id: target, base_url: "https://winner.example.com/v1", model_ids: ["winner-model"] },
          WINNING,
        );
        // Snapshot the winner's committed row the instant it lands: the
        // loser's refused re-submit must leave these columns byte-identical.
        winnerRow = db2.raw
          .query("SELECT key_enc, verified_at, verified_status FROM app_custom_provider_keys WHERE app_id = ? AND provider = ?")
          .get(app2.id, target);
      }),
    );
    await expect(
      racing2.upsertCustomProvider(app2.id, { ...CUSTOM, provider_id: target }, WINNING),
    ).rejects.toThrow("custom provider cap (8) reached");
    expect(winnerRow).not.toBeNull();
    expect(
      db2.raw
        .query("SELECT key_enc, verified_at, verified_status FROM app_custom_provider_keys WHERE app_id = ? AND provider = ?")
        .get(app2.id, target),
    ).toEqual(winnerRow);
    expect(rawCount(db2, "app_custom_provider_keys")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
  });

  test("a raced same-id create that lost the last slot at the SAME endpoint still admits its key and declaration update", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    // Seven declarations → the App sits ONE slot below the cap.
    for (let i = 1; i < MAX_CUSTOM_PROVIDER_COUNT; i++) {
      await store.upsertCustomProvider(app.id, { ...CUSTOM, provider_id: `prov-${i}` }, PLAIN_CUSTOM_KEY);
    }
    const WINNING = sk("custom-winner-same-endpoint-7171");
    const LOSING = sk("custom-loser-same-endpoint-6161");
    const target = "prov-last";
    // The concurrent save fills the LAST slot under the SAME id AND the SAME
    // endpoint after this caller's absence/count reads have passed: the caller
    // still carries `newDeclaration: true`, so its belief is stale — the row it
    // wants already exists, and updating it raises no declaration count.
    const racing = configStore(
      createLastSlotRaceD1(db, async () => {
        await configStore(db).upsertCustomProvider(
          app.id,
          { ...CUSTOM, provider_id: target, model_ids: ["winner-model"] },
          WINNING,
        );
      }),
    );
    await expect(
      racing.upsertCustomProvider(app.id, { ...CUSTOM, provider_id: target, model_ids: ["loser-model"] }, LOSING),
    ).resolves.toBeUndefined();
    // The declaration was UPDATEed in place (no ninth row) …
    expect(rawCount(db, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
    const decl = db.raw
      .query("SELECT base_url, model_ids FROM app_custom_providers WHERE app_id = ? AND provider_id = ?")
      .get(app.id, target) as { base_url: string; model_ids: string };
    expect(decl.base_url).toBe(CUSTOM.base_url);
    expect(JSON.parse(decl.model_ids)).toEqual(["loser-model"]);
    // … and both credentials live in the one pool: 7 seeded + winner + loser.
    expect(rawCount(db, "app_custom_provider_keys")).toBe(MAX_CUSTOM_PROVIDER_COUNT + 1);
    const consumer = await store.getCustomProvidersForConsumer(app.id);
    expect([...consumer.find((row) => row.provider_id === target)!.api_keys].sort()).toEqual(
      [WINNING, LOSING].sort(),
    );
    // A GENUINELY new declaration at the cap is still refused: the gate admits
    // exactly the writes that add no declaration row.
    await expect(
      store.upsertCustomProvider(app.id, { ...CUSTOM, provider_id: "prov-over" }, PLAIN_CUSTOM_KEY),
    ).rejects.toThrow("custom provider cap (8) reached");
    expect(rawCount(db, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
  });

  test("a concurrent first-time save of the SAME provider id adds its key instead of 500ing (A4)", async () => {
    const { db, app } = await seededWorld();
    const WINNING = sk("custom-winning-8282");
    const LOSING = sk("custom-losing-9292");
    // The concurrent save commits between this caller's absence read and its
    // batch: the caller's plain INSERT used to hit the (app_id, provider_id)
    // primary-key conflict and roll the whole batch back as a generic 500.
    const racing = configStore(
      createLastSlotRaceD1(db, async () => {
        await configStore(db).upsertCustomProvider(app.id, CUSTOM, WINNING);
      }),
    );
    await expect(racing.upsertCustomProvider(app.id, CUSTOM, LOSING)).resolves.toBeUndefined();
    // One declaration, BOTH keys: the loser's credential joins the declaration
    // that already carries its endpoint — no half state, no dropped key.
    expect(rawCount(db, "app_custom_providers")).toBe(1);
    const consumer = await configStore(db).getCustomProvidersForConsumer(app.id);
    expect(consumer).toHaveLength(1);
    expect(consumer[0]!.base_url).toBe(CUSTOM.base_url);
    expect([...consumer[0]!.api_keys].sort()).toEqual([WINNING, LOSING].sort());

    // Same-race variant at ANOTHER endpoint: the loser's credential was
    // verified for an endpoint the surviving declaration does not carry, so
    // the credit is refused loudly — and still commits nothing.
    const { db: db2, app: app2 } = await seededWorld();
    const winnerSnap = async () =>
      db2.raw.query("SELECT base_url, model_ids FROM app_custom_providers WHERE app_id = ?").get(app2.id);
    const racing2 = configStore(
      createLastSlotRaceD1(db2, async () => {
        await configStore(db2).upsertCustomProvider(
          app2.id,
          { ...CUSTOM, base_url: "https://winner.example.com/v1", model_ids: ["winner-model"] },
          WINNING,
        );
      }),
    );
    await expect(
      racing2.upsertCustomProvider(app2.id, { ...CUSTOM, base_url: "https://loser.example.com/v1" }, LOSING),
    ).rejects.toThrow(ProviderEndpointLockedError);
    expect(await winnerSnap()).toEqual({
      base_url: "https://winner.example.com/v1",
      model_ids: JSON.stringify(["winner-model"]),
    });
    expect(rawCount(db2, "app_custom_provider_keys")).toBe(1);
    expect(await configStore(db2).getCustomProvidersForConsumer(app2.id)).toEqual([
      {
        provider_id: CUSTOM.provider_id,
        base_url: "https://winner.example.com/v1",
        api: CUSTOM.api,
        model_ids: ["winner-model"],
        api_keys: [WINNING],
      },
    ]);
  });

  test("deleteCustomProviderKey removes a migrated (not-yet-promoted) key by its derived id — no prior read needed", async () => {
    const db = createPreProviderPoolD1();
    const app = await seedApp(db, { slug: "a", createdBy: "mallory" });
    const legacy = sk("custom-legacy-delete-5151");
    const legacyEnc = await createSecretbox(TEST_KEY).encryptSecret(
      legacy,
      `app_custom_providers.api_key_enc:${app.id}:${CUSTOM.provider_id}`,
    );
    rawRun(
      db,
      `INSERT INTO app_custom_providers
         (app_id, provider_id, base_url, api, model_ids, api_key_enc, created_at, updated_at, verified_at, verified_status)
       VALUES (?, ?, ?, ?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'ok')`,
      app.id,
      CUSTOM.provider_id,
      CUSTOM.base_url,
      CUSTOM.api,
      JSON.stringify(CUSTOM.model_ids),
      legacyEnc,
    );
    applyMigration(db, "0024_provider_multi_key.sql");
    const carried = db.raw.query("SELECT key_id FROM app_custom_provider_keys").get() as { key_id: string };
    expect(carried.key_id).toBe("");
    expect(
      await configStore(db).deleteCustomProviderKey(app.id, CUSTOM.provider_id, await keyIdOf(legacy)),
    ).toBe(true);
    expect(rawCount(db, "app_custom_provider_keys")).toBe(0);
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
      { base_url: "https://" }, // https prefix but NO host (PR #10 review)
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
    expect(rawCount(db, "app_custom_provider_keys")).toBe(0);
  });

  // QC wave-1 (seat3 W-1) rewording: the runner's base-wins merge
  // skips a custom id colliding with a capability host of the App's SELECTED
  // sandbox image (omp declares ark-plan) while the consumer STILL injects
  // its key — the declaration is silently dead on every review, so the
  // backstop refuses it (the App defaults to omp via migration 0018).
  test("store backstop: a selected-image capability host id (ark-plan) throws InvalidCustomProviderError before any write", async () => {
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
    ).rejects.toThrow("custom provider cap (8) reached");
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

  test("getCustomProvidersForConsumer decrypts the pool through the store face; a tampered row throws (fail-loud)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertCustomProvider(app.id, CUSTOM, PLAIN_CUSTOM_KEY);
    // Upsert → consumer face → keys match (the T4/T5 consume contract —
    // the round-trip goes through the store, not ad-hoc secretbox).
    await expect(store.getCustomProvidersForConsumer(app.id)).resolves.toEqual([
      { ...CUSTOM, api_keys: [PLAIN_CUSTOM_KEY] },
    ]);
    const row = db.raw
      .query("SELECT key_enc FROM app_custom_provider_keys WHERE app_id = ? AND provider = ?")
      .get(app.id, CUSTOM.provider_id) as { key_enc: string };
    // Tamper: replace the whole envelope. A last-char flip can land in the
    // base64 padding bits and decode to the same bytes, so the GCM tag would
    // still verify (~1/16 flake); same reasoning as
    // tests/worker/dashboard.test.ts.
    const tampered = "A".repeat(row.key_enc.length);
    db.raw
      .prepare("UPDATE app_custom_provider_keys SET key_enc = ? WHERE app_id = ? AND provider = ?")
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
  // PROVIDER_IDS — a direct re-export of the generated
  // contract's builtin sequence (src/contracts/provider-catalog.generated.ts;
  // dashboard → pipeline imports stay forbidden, so the mirror binds the
  // CONTRACT, not the pipeline face). The locks below fail on any drift
  // between the re-export, the contract, and the pipeline face's builtin
  // tier (the runner-consumable 19 — never weakened).
  test("PROVIDER_IDS mirrors the pipeline catalog's builtin key sequence exactly", () => {
    expect([...PROVIDER_IDS]).toEqual(Object.keys(PROVIDERS));
    expect([...PROVIDER_IDS]).toEqual([...PROVIDER_IDS_BUILTIN]);
    // 19 ids: the 18 built-in omp providers + `ark` (the
    // AL-24-5 entry — the in-image ark-plan base provider's keys ride the
    // per-App BYOK pool under this id in the credential payload).
    expect(PROVIDER_IDS).toHaveLength(19);
  });

  // PROVIDER_META (spec §5; breadth rewire) — the dashboard's
  // catalog mirror: now the FULL generated catalog re-export (builtin AND
  // template tier, breadth included) instead of a hand-maintained copy. The
  // lock guards the re-export: PROVIDER_META must equal the generated
  // PROVIDER_CATALOG (structurally — the mirror type ignores `envName`).
  test("PROVIDER_META mirrors the pipeline catalog's display metadata exactly", () => {
    expect(PROVIDER_META).toEqual(PROVIDER_CATALOG);
    // The mirror carries the builtin tier (the 19) plus the full template
    // tier (workers-ai + the snapshot breadth) — the provider list UI and
    // the materialization route consume it.
    expect(Object.keys(PROVIDER_META)).toHaveLength(214);
    expect(Object.keys(PROVIDER_META).filter((id) => PROVIDER_META[id]!.tier === "builtin")).toHaveLength(19);
    expect(PROVIDER_META["workers-ai"]!.tier).toBe("template");
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

  test("MODEL_ROLE_IDS mirrors the review-side seat vocabulary exactly (parity lock)", () => {
    // quick/default seat: the frontmatter `name:` of the agent definition the
    // runtime installs for Bun fan-out (packages/runner/src/seat-agent.md — the real
    // seat-name SSOT on the review side).
    const seatAgent = readFileSync(join(import.meta.dir, "../../packages/runner/src/seat-agent.md"), "utf8");
    const quickSeat = /^name:\s*(\S+)\s*$/m.exec(seatAgent)?.[1];
    expect(quickSeat).toBe("mstar-review-seat");
    // Deep seats: DEEP_SEAT_ROLES is exported from runtime-omp for
    // this parity lock ( the dashboard's own
    // import boundary — Q2 — stays: src/dashboard still has zero review
    // imports, the mirror constant remains its SSOT).
    const deepSeats: readonly string[] = DEEP_SEAT_ROLES;
    expect(deepSeats).toEqual(["code-reviewer", "fullstack-dev", "frontend-dev"]);
    // The mirror is exactly the quick seat followed by the deep seats.
    expect([...MODEL_ROLE_IDS]).toEqual([quickSeat!, ...(deepSeats ?? [])]);
    expect(MODEL_ROLE_IDS).toHaveLength(4); // spec § B6 语义锁: exactly the 4 audit seats
  });

  test("the custom-id collision vocabulary is the selected image's registry host ids (QC W-1 successor)", () => {
    // The dashboard keeps NO local base-provider mirror: the refusal set is
    // sandboxImageHostIds(app.sandbox_image_id) straight from the
    // src/contracts/sandbox-images.ts registry. Lock the registry shape the
    // refusal (and the consumer's neededEnvName mapping) rides on: omp is
    // the single enabled entry, and its capability host `ark-plan` resolves
    // its keys from catalog id `ark`'s provider pool (the `apiKeyEnv`
    // registry field is retained metadata, no longer a resolution input) —
    // the same semantics the synthesizer materializes into every per-review
    // models.yml.
    expect(enabledSandboxImages().map((image) => image.id)).toEqual(["omp"]);
    expect(sandboxImageHostIds("omp")).toEqual(["ark-plan"]);
    expect(sandboxImageHostIds("no-such-image")).toEqual([]);
    const arkHost = getSandboxImage("omp")!.hosts[0]!;
    expect(arkHost).toMatchObject({ id: "ark-plan", catalogProviderId: "ark", apiKeyEnv: "ARK_API_KEY" });
    expect(arkHost.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/plan");
    expect(arkHost.models.map((m) => m.id)).toEqual(["deepseek-v4-flash"]);
  });
});

// --- routes ---

describe("GET /dashboard/default/apps/:slug/settings (SPA-owned)", () => {
  test("HTML navigation GET is served by SPA dispatch (boot-injected index)", async () => {
    const { db } = await seededWorld();
    const res = await htmlGet(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, withSpaAssets(makeEnv(db)));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("the legacy SSR handler is gone: a non-HTML GET falls through to the legacy app (guard 302, never the old HTML)", async () => {
    const { db } = await seededWorld();
    const res = await get(SETTINGS, "", makeEnv(db));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });
});

describe("sandbox image selection (payload + op=save-sandbox-image)", () => {
  const SETTINGS_API = "/dashboard/default/api/apps/mallorys-app/settings";

  test("manage face: app.sandbox_image_id + sandbox_images ({ id, enabled } rows, enabled entries only)", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await get(SETTINGS_API, cookie, makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      can_manage: boolean;
      app: { sandbox_image_id: string };
      sandbox_images?: Array<{ id: string; enabled: boolean }>;
    };
    expect(body.can_manage).toBe(true);
    // Both faces carry the read-only selection; the manage face adds the
    // selector choices from the registry's enabled entries only.
    expect(body.app.sandbox_image_id).toBe("omp");
    expect(body.sandbox_images).toEqual([{ id: "omp", enabled: true }]);
  });

  test("non-manager face: sandbox_image_id and sandbox_images are both absent (identity-set only)", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("hubot")}`;
    const res = await get(SETTINGS_API, cookie, makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      can_manage: boolean;
      app: Record<string, unknown>;
      sandbox_images?: unknown;
    };
    expect(body.can_manage).toBe(false);
    expect("sandbox_image_id" in body.app).toBe(false);
    expect((body.app as { sandbox_image_id?: unknown }).sandbox_image_id).toBeUndefined();
    expect(body.sandbox_images).toBeUndefined();
  });

  test("owner saves the enabled registry id: 200, value persisted, updated_at bumped", async () => {
    const { db, app } = await seededWorld();
    rawRun(db, "UPDATE github_apps SET sandbox_image_id = 'omp', updated_at = '2026-01-01 00:00:00' WHERE id = ?", app.id);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "save-sandbox-image",
      sandbox_image_id: "omp",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Saved the omp runtime image for mallorys-app");
    const row = db.raw
      .query("SELECT sandbox_image_id, updated_at FROM github_apps WHERE id = ?")
      .get(app.id) as { sandbox_image_id: string; updated_at: string };
    expect(row.sandbox_image_id).toBe("omp");
    expect(row.updated_at).not.toBe("2026-01-01 00:00:00");
  });

  test("unknown or blank id: 400 with zero writes (the store-enforced enabled-registry domain)", async () => {
    const { db, app } = await seededWorld();
    rawRun(db, "UPDATE github_apps SET updated_at = '2026-01-01 00:00:00' WHERE id = ?", app.id);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    for (const imageId of ["not-a-registry-id", ""]) {
      const res = await postForm(SETTINGS, cookie, makeEnv(db), {
        op: "save-sandbox-image",
        sandbox_image_id: imageId,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Unknown or disabled sandbox image");
    }
    const row = db.raw
      .query("SELECT sandbox_image_id, updated_at FROM github_apps WHERE id = ?")
      .get(app.id) as { sandbox_image_id: string; updated_at: string };
    expect(row.sandbox_image_id).toBe("omp"); // nothing stored
    expect(row.updated_at).toBe("2026-01-01 00:00:00"); // no operator-mutation churn
  });

  test("non-manager (member, not creator) gets 403 and nothing is stored", async () => {
    const { db, app } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("ada")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "save-sandbox-image",
      sandbox_image_id: "omp",
    });
    expect(res.status).toBe(403);
    const row = db.raw
      .query("SELECT sandbox_image_id, updated_at FROM github_apps WHERE id = ?")
      .get(app.id) as { sandbox_image_id: string; updated_at: string };
    expect(row.sandbox_image_id).toBe("omp");
    expect(row.updated_at).toBe(app.updated_at); // ada's refused save touched nothing
  });

  test("app.review_trigger_mode: manager face carries the column default 'every_push'; non-manager face has no such key", async () => {
    // The seeded row never chose a mode, so the column default 'every_push'
    // is what the manager face must serve (spec review-trigger-policy §2).
    // The non-manager settings face is identity-set only — no trigger mode.
    const { db } = await seededWorld();
    const manage = await get(SETTINGS_API, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db));
    expect(manage.status).toBe(200);
    const manageBody = (await manage.json()) as { app: Record<string, unknown> };
    expect(manageBody.app.review_trigger_mode).toBe("every_push");
    const member = await get(SETTINGS_API, `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, makeEnv(db));
    expect(member.status).toBe(200);
    const memberBody = (await member.json()) as { app: Record<string, unknown> };
    expect("review_trigger_mode" in memberBody.app).toBe(false);
    expect(memberBody.app.review_trigger_mode).toBeUndefined();
  });
});

describe("POST /dashboard/default/apps/:slug/settings — add-key (op=add-key)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("owner stores a key: encrypted row lands, plain-text 200, never the plaintext", async () => {
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
    // The plain-text response never echoes the key material.
    expect(body).not.toContain(PLAIN_ANTHROPIC_KEY);
  });

  test("unknown provider → 400 (allowlist), zero rows written", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "add-key",
      provider: "not-a-provider",
      key: sk("whatever-1234"),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not a supported provider");
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });

  test("empty provider (untouched placeholder) → 400, zero rows written", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "add-key",
      provider: "",
      key: PLAIN_ANTHROPIC_KEY,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Pick a provider for the key.");
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

  test("key over 4096 characters → 400, zero rows written", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "add-key",
      provider: "anthropic",
      key: "k".repeat(MAX_PROVIDER_KEY_LENGTH + 1),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("limited to 4096 characters");
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

describe("POST /dashboard/default/apps/:slug/settings — save-chain (op=save-chain)", () => {
  test("owner saves the chain: stored VERBATIM (spaces and :thinking suffix kept)", async () => {
    const { db, app } = await seededWorld();
    const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      op: "save-chain",
      model_chain: PLAIN_CHAIN,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Saved the model chain for mallorys-app");
    const row = db.raw
      .query("SELECT chain FROM app_model_chains WHERE app_id = ? AND name = 'default'")
      .get(app.id) as { chain: string };
    expect(row.chain).toBe(PLAIN_CHAIN);
  });

  test("empty chain CLEARS the config (reviews then fail closed — AL-24-5); a second save replaces", async () => {
    const { db, app } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const env = makeEnv(db);
    const clear = await postForm(SETTINGS, cookie, env, { op: "save-chain", model_chain: "" });
    expect(clear.status).toBe(200);
    expect(await clear.text()).toContain("Cleared the model chain for mallorys-app");
    expect(rawCount(db, "app_model_chains")).toBe(0);
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
    expect(rawCount(db, "app_model_chains")).toBe(0);
  });

  test("chain over 400 chars → 400, zero rows written (AL-23-2 selector/chain cap)", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const res = await postForm(SETTINGS, cookie, makeEnv(db), {
      op: "save-chain",
      model_chain: "a".repeat(MAX_MODEL_SELECTOR_LENGTH + 1),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(`limited to ${MAX_MODEL_SELECTOR_LENGTH}`);
    expect(rawCount(db, "app_model_chains")).toBe(0);
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

  test("a duplicate model_chain field → 400, zero rows written (never a silent clear)", async () => {
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
    expect(await res.text()).toContain("submitted more than once");
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
    expect(rawCount(db, "app_model_chains")).toBe(0);
  });

  test("unknown op → 400 with the reason (consistent with other validation failures)", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      op: "something-else",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unknown settings operation");
  });
});

// --- the Role models editor (settings op save-roles) ---

/**
 * The exact body the Role models editor posts: the hidden op plus one
 * role_<role> field per MODEL_ROLE_IDS seat (blank = the seat uses the
 * default chain), plus any `extra` fields for the tampering cases.
 * F-002 (QC wave): the route now ENFORCES the full map — a partial
 * submission is a 400 naming the absent roles, so helpers for success
 * paths must always fill every seat.
 */
function roleForm(
  values: Record<string, string>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const fields: Record<string, string> = { op: "save-roles" };
  for (const role of MODEL_ROLE_IDS) fields[`role_${role}`] = values[role] ?? "";
  return { ...fields, ...extra };
}

describe("Role models editor (save-roles op, chain references)", () => {
  test("owner saves the map: chain references stored, plain-text 200", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertModelChain(app.id, "seat-mstar-review-seat", "ark-plan/deepseek-v4-flash:high");
    await store.upsertModelChain(app.id, "seat-code-reviewer", "  openai/gpt-5 , anthropic/claude-x  ");
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      roleForm({
        "mstar-review-seat": "seat-mstar-review-seat",
        "code-reviewer": "seat-code-reviewer",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Saved the role models for mallorys-app");
    expect(await store.getModelChainSeats(app.id)).toEqual({
      "mstar-review-seat": "seat-mstar-review-seat",
      "code-reviewer": "seat-code-reviewer",
    });
  });

  test("one save maps AND clears: blanks = the seat uses the default chain (full-map editor semantics)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertModelChain(app.id, "seat-mstar-review-seat", "new/model");
    await store.upsertModelChain(app.id, "seat-code-reviewer", "old/model");
    await store.setModelChainSeat(app.id, "code-reviewer", "seat-code-reviewer");
    await store.setModelChainSeat(app.id, "frontend-dev", "seat-code-reviewer");
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      roleForm({
        "mstar-review-seat": "seat-mstar-review-seat",
        // code-reviewer / frontend-dev posted blank → cleared by the same save
      }),
    );
    expect(res.status).toBe(200);
    expect(await store.getModelChainSeats(app.id)).toEqual({ "mstar-review-seat": "seat-mstar-review-seat" });
  });

  test("a D1 batch failure mid-save → 500, truthful 'nothing was stored', ZERO rows changed (Phase 5, PR #7 review)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertModelChain(app.id, "seat-mstar-review-seat", "new/model");
    await store.upsertModelChain(app.id, "seat-code-reviewer", "old/model");
    await store.setModelChainSeat(app.id, "code-reviewer", "seat-code-reviewer");
    const failing = createBatchRejectingD1(db);
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(failing),
      roleForm({ "mstar-review-seat": "seat-mstar-review-seat", "code-reviewer": "" }),
    );
    expect(res.status).toBe(500);
    // With the atomic batch the pre-existing copy is now TRUE — a failed
    // save genuinely stored nothing.
    expect(await res.text()).toContain("The dashboard database rejected the change — nothing was stored.");
    // Atomic: the store state is exactly as before the failed save.
    expect(await store.getModelChainSeats(app.id)).toEqual({ "code-reviewer": "seat-code-reviewer" });
    expect(rawCount(db, "app_model_chain_seats")).toBe(1);
  });

  test("an all-blank save clears every reference (empty = every seat uses the default chain)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertModelChain(app.id, "seat-code-reviewer", "old/model");
    await store.setModelChainSeat(app.id, "code-reviewer", "seat-code-reviewer");
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      roleForm({}),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Saved the role models for mallorys-app");
    expect(rawCount(db, "app_model_chain_seats")).toBe(0);
    expect(await store.getModelChainSeats(app.id)).toEqual({});
  });

  test("a chain reference naming a chain the App does not have → 400 naming the role, zero rows written (validate-all-first)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertModelChain(app.id, "seat-code-reviewer", "old/model");
    await store.setModelChainSeat(app.id, "code-reviewer", "seat-code-reviewer");
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      roleForm({
        "mstar-review-seat": "no-such-chain",
        "code-reviewer": "",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      "mstar-review-seat is not a known model chain",
    );
    // Zero partial writes: the valid entry never landed, the old row is intact.
    expect(await store.getModelChainSeats(app.id)).toEqual({ "code-reviewer": "seat-code-reviewer" });
  });

  test("F-001: a padded chain reference canonicalizes to the real chain — never a dangling row (bulk save path)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertModelChain(app.id, "seat-code-reviewer", "openai/gpt-5");
    // The route trims BEFORE bind: the known-chain check and the store
    // upsert see the same name, so "seat-code-reviewer " stores
    // "seat-code-reviewer" — the consumer read resolves instead of
    // throwing the fail-closed "references missing chain" error.
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      roleForm({ "code-reviewer": "seat-code-reviewer " }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Saved the role models for mallorys-app");
    expect(await store.getModelChainSeats(app.id)).toEqual({ "code-reviewer": "seat-code-reviewer" });
    const row = db.raw
      .query("SELECT chain_name FROM app_model_chain_seats WHERE app_id = ? AND role = ?")
      .get(app.id, "code-reviewer") as { chain_name: string };
    expect(row.chain_name).toBe("seat-code-reviewer");
    await expect(store.getModelOverridesForConsumer(app.id)).resolves.toEqual({ "code-reviewer": "openai/gpt-5" });
  });

  test("a tampered role_<unknown> field → 400, zero rows written", async () => {
    const { db, app } = await seededWorld();
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      roleForm({ "code-reviewer": "seat-code-reviewer" }, { role_root: "evil/model" }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("root is not a known review role");
    expect(rawCount(db, "app_model_chain_seats")).toBe(0);
  });
  test("a duplicate role_* field → 400, zero rows written (AL-23-2 explicit rejection)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertModelChain(app.id, "seat-code-reviewer", "old/model");
    await store.setModelChainSeat(app.id, "code-reviewer", "seat-code-reviewer");
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    // parseBody({ all: true }) aggregates duplicate keys into an array — the
    // handler must reject the duplicate explicitly, never silently last-wins.
    const res = await worker.fetch(
      new Request(`https://worker.local${SETTINGS}`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: "op=save-roles&role_code-reviewer=seat-code-reviewer&role_code-reviewer=seat-code-reviewer",
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("submitted more than once");
    // Zero writes: the pre-existing mapping survives untouched.
    expect(await store.getModelChainSeats(app.id)).toEqual({ "code-reviewer": "seat-code-reviewer" });
    expect(rawCount(db, "app_model_chain_seats")).toBe(1);
  });

  test("a save with NO role fields at all → 400 re-render, zero rows written (never a silent no-op)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertModelChain(app.id, "seat-code-reviewer", "old/model");
    await store.setModelChainSeat(app.id, "code-reviewer", "seat-code-reviewer");
    const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      op: "save-roles",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("No role chain references were submitted");
    // The existing mapping survives — an empty map was never saved.
    expect(await store.getModelChainSeats(app.id)).toEqual({ "code-reviewer": "seat-code-reviewer" });
  });

  test("F-002: a PARTIAL map (missing seat keys) → 400 naming the absent roles, zero writes (full-map contract)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertModelChain(app.id, "seat-code-reviewer", "old/model");
    await store.setModelChainSeat(app.id, "code-reviewer", "seat-code-reviewer");
    // Only ONE seat key is submitted — the other three are absent, and a
    // strict-subset save would silently keep their stale reference rows.
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("mallory")}`,
      makeEnv(db),
      { op: "save-roles", "role_code-reviewer": "seat-code-reviewer" },
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    // The error names exactly which seats are missing.
    expect(body).toContain("mstar-review-seat");
    expect(body).toContain("fullstack-dev");
    expect(body).toContain("frontend-dev");
    expect(body).not.toContain("code-reviewer role field is missing");
    expect(body).toContain("role fields are missing");
    // Zero writes: the pre-existing mapping is untouched.
    expect(await store.getModelChainSeats(app.id)).toEqual({ "code-reviewer": "seat-code-reviewer" });
    expect(rawCount(db, "app_model_chain_seats")).toBe(1);
  });

  test("non-owner member → 403, zero mutation; admin (non-creator) may save — owner-or-admin", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.upsertModelChain(app.id, "seat-code-reviewer", "openai/gpt-5");
    const res = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("hubot")}`,
      makeEnv(db),
      roleForm({ "code-reviewer": "seat-code-reviewer" }),
    );
    expect(res.status).toBe(403);
    expect(rawCount(db, "app_model_chain_seats")).toBe(0);
    const adminRes = await postForm(
      SETTINGS,
      `${SESSION_COOKIE}=${await sessionCookie("octocat")}`,
      makeEnv(db),
      roleForm({ "code-reviewer": "seat-code-reviewer" }),
    );
    expect(adminRes.status).toBe(200);
    expect(rawCount(db, "app_model_chain_seats")).toBe(1);
  });

});

// --- named chains (settings ops add-chain / remove-chain) ---

describe("POST /dashboard/default/apps/:slug/settings — named chains (op=add-chain / remove-chain)", () => {
  test("owner adds a named chain: stored with is_default=0, plain-text 200", async () => {
    const { db, app } = await seededWorld();
    const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      op: "add-chain",
      name: "fast",
      chain: "openai/gpt-5:thinking",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Saved the fast model chain for mallorys-app");
    const chains = await configStore(db).getModelChains(app.id);
    expect(chains).toEqual([
      { name: "fast", chain: "openai/gpt-5:thinking", is_default: false, created_at: expect.any(String), updated_at: expect.any(String) },
    ]);
  });

  test("add-chain replaces an existing named chain (upsert); the default row is untouched", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.setModelChain(app.id, "ark-plan/deepseek-v4-flash");
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const env = makeEnv(db);
    await postForm(SETTINGS, cookie, env, { op: "add-chain", name: "fast", chain: "first/model" });
    await postForm(SETTINGS, cookie, env, { op: "add-chain", name: "fast", chain: "second/model" });
    const chains = await store.getModelChains(app.id);
    expect(chains.find((c) => c.name === "fast")!.chain).toBe("second/model");
    expect(chains.find((c) => c.name === "default")!.chain).toBe("ark-plan/deepseek-v4-flash");
    expect(chains.find((c) => c.name === "default")!.is_default).toBe(true);
  });

  test("add-chain rejects the reserved 'default' name and bad grammar → 400, zero rows written", async () => {
    const { db } = await seededWorld();
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    for (const name of ["default", "UPPER", "has space", "-lead"]) {
      const res = await postForm(SETTINGS, cookie, makeEnv(db), { op: "add-chain", name, chain: "openai/gpt-5" });
      expect(res.status, name).toBe(400);
      expect(await res.text()).toContain("Chain names must be");
    }
    expect(rawCount(db, "app_model_chains")).toBe(0);
  });

  test("add-chain validates the selector chain like save-chain: garbage → 400, membership miss → 400, zero rows", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.saveVerifiedKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY, ["claude-sonnet-4-6"]);
    const cookie = `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;
    const env = makeEnv(db);
    const garbage = await postForm(SETTINGS, cookie, env, { op: "add-chain", name: "fast", chain: " , ," });
    expect(garbage.status).toBe(400);
    expect(await garbage.text()).toContain("at least one comma-separated model selector");
    const membership = await postForm(SETTINGS, cookie, env, { op: "add-chain", name: "fast", chain: "anthropic/nope" });
    expect(membership.status).toBe(400);
    expect(await membership.json()).toEqual({
      code: "not_in_verified_models",
      message: "Selector anthropic/nope is not in this App's verified models.",
      selector: "anthropic/nope",
    });
    expect(rawCount(db, "app_model_chains")).toBe(0);
  });

  test("remove-chain deletes the named chain AND its seat references (seats fall back to default)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.setModelChain(app.id, "ark-plan/deepseek-v4-flash");
    await store.upsertModelChain(app.id, "fast", "openai/gpt-5");
    await store.setModelChainSeat(app.id, "code-reviewer", "fast");
    const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      op: "remove-chain",
      name: "fast",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Removed the fast model chain for mallorys-app");
    expect(rawCount(db, "app_model_chains")).toBe(1); // only the default row
    expect(rawCount(db, "app_model_chain_seats")).toBe(0);
  });

  test("remove-chain rejects the reserved 'default' name → 400, zero rows written", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.setModelChain(app.id, "ark-plan/deepseek-v4-flash");
    const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      op: "remove-chain",
      name: "default",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("cannot be removed");
    expect(rawCount(db, "app_model_chains")).toBe(1);
    expect(await store.getModelChain(app.id)).toBe("ark-plan/deepseek-v4-flash");
  });

  test("non-owner member → 403, zero mutation (add-chain)", async () => {
    const { db } = await seededWorld();
    const res = await postForm(SETTINGS, `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, makeEnv(db), {
      op: "add-chain",
      name: "fast",
      chain: "openai/gpt-5",
    });
    expect(res.status).toBe(403);
    expect(rawCount(db, "app_model_chains")).toBe(0);
  });
});

describe("POST /dashboard/default/apps/:slug/settings/key/delete (per-key delete route)", () => {
  const SECOND_ANTHROPIC_KEY = sk("ant-mallory-second-7766");

  test("owner removes ONE stored key by its id: that row goes, its sibling stays", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.addProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    await store.addProviderKey(app.id, "anthropic", SECOND_ANTHROPIC_KEY);
    const res = await postForm(SETTINGS + "/key/delete", `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      provider: "anthropic",
      key_id: await keyIdOf(PLAIN_ANTHROPIC_KEY),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Removed the stored anthropic key for mallorys-app");
    const remaining = await store.listProviderKeys(app.id, "anthropic");
    expect(remaining.map((key) => key.keyId)).toEqual([await keyIdOf(SECOND_ANTHROPIC_KEY)]);
  });

  test("an unmatched key id (or a never-stored provider) is a tolerant warn — zero mutation", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    await store.addProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const res = await postForm(SETTINGS + "/key/delete", `${SESSION_COOKIE}=${await sessionCookie("mallory")}`, makeEnv(db), {
      provider: "openai",
      key_id: await keyIdOf(PLAIN_ANTHROPIC_KEY),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("nothing changed");
    expect(rawCount(db, "app_provider_keys")).toBe(1);
  });

  test("non-owner member → 403, zero mutation", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).addProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const res = await postForm(SETTINGS + "/key/delete", `${SESSION_COOKIE}=${await sessionCookie("hubot")}`, makeEnv(db), {
      provider: "anthropic",
      key_id: await keyIdOf(PLAIN_ANTHROPIC_KEY),
    });
    expect(res.status).toBe(403);
    expect(rawCount(db, "app_provider_keys")).toBe(1);
  });

  test("admin (non-creator) may remove a key — owner-or-admin", async () => {
    const { db, app } = await seededWorld();
    await configStore(db).addProviderKey(app.id, "anthropic", PLAIN_ANTHROPIC_KEY);
    const res = await postForm(SETTINGS + "/key/delete", `${SESSION_COOKIE}=${await sessionCookie("octocat")}`, makeEnv(db), {
      provider: "anthropic",
      key_id: await keyIdOf(PLAIN_ANTHROPIC_KEY),
    });
    expect(res.status).toBe(200);
    expect(rawCount(db, "app_provider_keys")).toBe(0);
  });
});

// --- custom provider declarations (settings ops) ---

describe("POST /dashboard/default/apps/:slug/settings — custom providers (op=add-custom-provider / remove-custom-provider)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch);
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const CUSTOM_FORM: Record<string, string> = {
    op: "add-custom-provider",
    provider_id: "my-custom",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
    model_ids: "deepseek-v4-flash, deepseek-r1",
    key: sk("custom-ark-9988"),
  };
  const mallory = async () => `${SESSION_COOKIE}=${await sessionCookie("mallory")}`;

  test("add stores the declaration (key encrypted at rest), plain-text 200", async () => {
    const { db, app } = await seededWorld();
    const res = await postForm(SETTINGS, await mallory(), makeEnv(db), CUSTOM_FORM);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Declared custom provider my-custom for mallorys-app");
    const row = db.raw
      .query("SELECT key_enc FROM app_custom_provider_keys WHERE app_id = ? AND provider = 'my-custom'")
      .get(app.id) as { key_enc: string };
    expect(row.key_enc).toMatch(/^v1\.primary\./);
    expect(row.key_enc).not.toContain(sk("custom-ark-9988"));
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
      { patch: { base_url: "https://" }, label: "https baseUrl with no host (PR #10 review)" },
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
      await store.upsertCustomProvider(app.id, decl(`prov-${i}`), sk("custom-ark-9988"));
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
  test("a raced same-id create at the cap is NOT refused by the route cap pre-check — the concurrent winner's row exempts it (both orders)", async () => {
    const decl = (providerId: string, modelIds = ["deepseek-v4-flash"]): AppCustomProvider => ({
      provider_id: providerId,
      base_url: "https://ark.cn-beijing.volces.com/api/v3",
      api: "openai-completions",
      model_ids: modelIds,
    });
    const target = "prov-last";

    // Order 1 — the competing same-id save commits AFTER the route's
    // listCustomProviders read and the store's absence/count reads, before the
    // caller's write batch: the route read saw 7 rows (below the cap), so it
    // admits; the store's growth gate admits it too because the row it wants
    // already exists. Driven through the REAL request path.
    const { db, app } = await seededWorld();
    const store = configStore(db);
    for (let i = 1; i < MAX_CUSTOM_PROVIDER_COUNT; i++) {
      await store.upsertCustomProvider(app.id, decl(`prov-${i}`), sk("custom-ark-seed-1"));
    }
    const WINNING = sk("custom-winner-route-11");
    const LOSING = sk("custom-loser-route-22");
    const raced = createLastSlotRaceD1(db, async () => {
      await configStore(db).upsertCustomProvider(app.id, decl(target, ["winner-model"]), WINNING);
    });
    const res = await postForm(SETTINGS, await mallory(), makeEnv(raced), {
      ...CUSTOM_FORM,
      provider_id: target,
      model_ids: "loser-model",
      key: LOSING,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`Declared custom provider ${target}`);
    // The declaration was updated in place (no ninth row) …
    expect(rawCount(db, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
    const row = db.raw
      .query("SELECT model_ids FROM app_custom_providers WHERE app_id = ? AND provider_id = ?")
      .get(app.id, target) as { model_ids: string };
    expect(JSON.parse(row.model_ids)).toEqual(["loser-model"]);
    // … and both credentials share the one pool (7 seeded + winner + loser).
    expect(rawCount(db, "app_custom_provider_keys")).toBe(MAX_CUSTOM_PROVIDER_COUNT + 1);

    // Order 2 — the competing save already committed when the request arrives:
    // the read now sees 8 rows INCLUDING the target id, so the `.some()` arm
    // exempts it (dropping that arm would 400 a legitimate update).
    const { db: db2, app: app2 } = await seededWorld();
    const store2 = configStore(db2);
    for (let i = 1; i < MAX_CUSTOM_PROVIDER_COUNT; i++) {
      await store2.upsertCustomProvider(app2.id, decl(`prov-${i}`), sk("custom-ark-seed-2"));
    }
    await store2.upsertCustomProvider(app2.id, decl(target, ["winner-model"]), sk("custom-winner-route-33"));
    const late = await postForm(SETTINGS, await mallory(), makeEnv(db2), {
      ...CUSTOM_FORM,
      provider_id: target,
      model_ids: "loser-model",
      key: sk("custom-loser-route-44"),
    });
    expect(late.status).toBe(200);
    expect(rawCount(db2, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);

    // The boundary still holds: a genuinely NEW id at the cap is 400 with the
    // cap key and zero writes (the pre-check is not weakened to admit growth).
    const over = await postForm(SETTINGS, await mallory(), makeEnv(db2), {
      ...CUSTOM_FORM,
      provider_id: "prov-over",
    });
    expect(over.status).toBe(400);
    const overBody = (await over.json()) as { key: string };
    expect(overBody.key).toBe("settings.error.customProviderMax");
    expect(rawCount(db2, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
  });

  test("a raced same-id template create at the cap is NOT refused by the templateMaterializeMax pre-check", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    const decl = (providerId: string): AppCustomProvider => ({
      provider_id: providerId,
      base_url: "https://example.com/v1",
      api: "openai-completions",
      model_ids: ["m1"],
    });
    for (let i = 1; i < MAX_CUSTOM_PROVIDER_COUNT; i++) {
      await store.upsertCustomProvider(app.id, decl(`prov-${i}`), sk("template-seed-key"));
    }
    // The competing save of the SAME template id lands after the route read and
    // the store's reads, before this request's batch.
    const raced = createLastSlotRaceD1(db, async () => {
      await configStore(db).upsertCustomProvider(
        app.id,
        {
          provider_id: "subconscious",
          base_url: "https://api.subconscious.dev/v1",
          api: "openai-completions",
          model_ids: ["subconscious/glm-5.2"],
        },
        sk("template-winner-key"),
      );
    });
    const res = await postForm(SETTINGS, await mallory(), makeEnv(raced), {
      op: "add-template-provider",
      template_id: "subconscious",
      key: sk("template-loser-key"),
    });
    expect(res.status).toBe(200);
    expect(rawCount(db, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);

    // Order 2 — the competing save already committed when the request arrives:
    // the read sees 8 rows INCLUDING the template id, so the
    // `storedDeclaration !== undefined` arm is the ONLY thing admitting this
    // legitimate re-materialization (a plain `length >= cap` gate would 400 it).
    const { db: db2, app: app2 } = await seededWorld();
    const store2 = configStore(db2);
    for (let i = 1; i < MAX_CUSTOM_PROVIDER_COUNT; i++) {
      await store2.upsertCustomProvider(app2.id, decl(`prov-${i}`), sk("template-seed-key-2"));
    }
    await store2.upsertCustomProvider(
      app2.id,
      {
        provider_id: "subconscious",
        base_url: "https://api.subconscious.dev/v1",
        api: "openai-completions",
        model_ids: ["subconscious/glm-5.2"],
      },
      sk("template-winner-key-2"),
    );
    const late = await postForm(SETTINGS, await mallory(), makeEnv(db2), {
      op: "add-template-provider",
      template_id: "subconscious",
      key: sk("template-late-key"),
    });
    expect(late.status).toBe(200);
    expect(rawCount(db2, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);

    // The boundary: a genuinely NEW template id at the cap is still refused.
    const over = await postForm(SETTINGS, await mallory(), makeEnv(db2), {
      op: "add-template-provider",
      template_id: "tokengo",
      key: sk("template-over-key"),
    });
    expect(over.status).toBe(400);
    const overBody = (await over.json()) as { key: string };
    expect(overBody.key).toBe("settings.error.templateMaterializeMax");
    expect(rawCount(db2, "app_custom_providers")).toBe(MAX_CUSTOM_PROVIDER_COUNT);
  });

  test("400: the store's atomic cap throw (race — pre-check passed, insert lost) maps to 400, not 500 (PR #10)", async () => {
    const { db } = await seededWorld();
    // The route pre-check reads listCustomProviders (7 rows → passes); the
    // store's atomic conditional INSERT then matches zero rows (a concurrent
    // save won the last slot) → InvalidCustomProviderError → the route must
    // answer 400 (the keyed rejection face since the SPA 400 rework), never 500.
    const sevenRows = Array.from({ length: 7 }, (_, i) => ({
      provider_id: `prov-${i + 1}`,
      base_url: "https://example.com/v1",
      api: "openai-completions",
      model_ids: JSON.stringify(["m1"]),
    }));
    const fakeStmt = (overrides: {
      first?: unknown;
      all?: unknown[];
      run?: { changes: number };
    }): D1StatementLike => {
      const stmt: D1StatementLike = {
        bind(..._values: unknown[]): D1StatementLike {
          return stmt;
        },
        async first<T = Record<string, unknown>>(): Promise<T | null> {
          return (overrides.first ?? null) as T | null;
        },
        async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
          return { results: (overrides.all ?? []) as T[] };
        },
        async run<T = Record<string, unknown>>(): Promise<{
          results: T[];
          meta: { changes: number; last_row_id: number };
        }> {
          return { results: [] as T[], meta: { changes: overrides.run?.changes ?? 0, last_row_id: 0 } };
        },
      };
      return stmt;
    };
    const raceLosing: AppConfigD1 = {
      prepare(query: string): D1StatementLike {
        if (query.includes("SELECT * FROM app_custom_providers")) {
          return fakeStmt({ all: sevenRows }); // route pre-check: 7 < 8 → passes
        }
        if (query.includes("SELECT provider_id FROM app_custom_providers")) {
          return fakeStmt({ first: null }); // new id
        }
        if (query.includes("SELECT COUNT(*) AS n FROM app_custom_providers")) {
          return fakeStmt({ first: { n: 7 } }); // store pre-check passes
        }
        // The race lost: a concurrent save took the last slot, so BOTH
        // statements of the batch — the key, which runs first, and the
        // declaration, which shares its growth gate — match zero rows.
        if (query.includes("INSERT INTO app_custom_provider_keys")) {
          return fakeStmt({ run: { changes: 0 } });
        }
        if (query.includes("INSERT INTO app_custom_providers")) {
          return fakeStmt({ run: { changes: 0 } });
        }
        return db.prepare(query);
      },
      batch: (statements) => db.batch(statements),
    };
    const res = await postForm(SETTINGS, await mallory(), makeEnv(raceLosing), {
      ...CUSTOM_FORM,
      provider_id: "prov-9",
    });
    expect(res.status).toBe(400);
    // the keyed 400 face replaces the store's developer-facing
    // err.message ("custom provider cap (8) reached") — the route pre-checks
    // make the cap race the realistic backstop cause, and the operator copy
    // now localizes. The PR #10 contract (400, never 500) is unchanged.
    const raceBody = (await res.json()) as { key: string; message: string };
    expect(raceBody.key).toBe("settings.error.customProviderDeclRejected");
    expect(raceBody.message).toContain("The custom provider was rejected");
  });

  test("400 keyed: an endpoint change on a provider whose pool holds a key is refused — custom and template save paths (A1)", async () => {
    const { db } = await seededWorld();
    const declared = await postForm(SETTINGS, await mallory(), makeEnv(db), CUSTOM_FORM);
    expect(declared.status).toBe(200);
    const moved = await postForm(SETTINGS, await mallory(), makeEnv(db), {
      ...CUSTOM_FORM,
      base_url: "https://elsewhere.example.com/v1",
      key: sk("custom-ark-7777"),
    });
    expect(moved.status).toBe(400);
    expect(await moved.json()).toEqual({
      key: "settings.error.providerEndpointLocked",
      message:
        "my-custom already stores keys for its current endpoint — remove them before changing its base URL or API protocol. Nothing was stored.",
      params: { provider: "my-custom" },
    });
    expect(rawCount(db, "app_custom_provider_keys")).toBe(1);
    // The template save path carries the same guard (its own provider id).
    const tpl = await postForm(SETTINGS, await mallory(), makeEnv(db), {
      op: "add-template-provider",
      template_id: "subconscious",
      key: sk("sub-template-0001"),
    });
    expect(tpl.status).toBe(200);
    const tplMoved = await postForm(SETTINGS, await mallory(), makeEnv(db), {
      op: "add-template-provider",
      template_id: "subconscious",
      base_url: "https://gateway.example.com/v1",
      key: sk("sub-template-0002"),
    });
    expect(tplMoved.status).toBe(400);
    expect(await tplMoved.json()).toEqual({
      key: "settings.error.providerEndpointLocked",
      message:
        "subconscious already stores keys for its current endpoint — remove them before changing its base URL or API protocol. Nothing was stored.",
      params: { provider: "subconscious" },
    });
    expect(rawCount(db, "app_custom_providers")).toBe(2);
    expect(rawCount(db, "app_custom_provider_keys")).toBe(2);
  });

  test("append against an EXISTING declaration keeps the STORED api/model_ids (F2)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    // A template id may legitimately hold a declaration whose api/model_ids
    // differ from the catalog's (only built-in and capability-host ids are
    // refused at declaration). The catalog prefill is what the operator's
    // FIRST save materialized; a later append must not rewrite it.
    await store.upsertCustomProvider(
      app.id,
      {
        provider_id: "subconscious",
        base_url: "https://api.subconscious.dev/v1",
        api: "anthropic-messages",
        model_ids: ["operator-chosen-a", "operator-chosen-b"],
      },
      sk("sub-template-existing"),
    );
    // The append submits a base URL but no protocol/model ids (the template
    // form has no control for either).
    const appended = await postForm(SETTINGS, await mallory(), makeEnv(db), {
      op: "add-template-provider",
      template_id: "subconscious",
      key: sk("sub-template-appended"),
    });
    expect(appended.status).toBe(200);
    const [decl] = await store.listCustomProviders(app.id);
    expect(decl).toEqual({
      provider_id: "subconscious",
      base_url: "https://api.subconscious.dev/v1",
      api: "anthropic-messages",
      model_ids: ["operator-chosen-a", "operator-chosen-b"],
      has_keys: true,
    });
    expect(rawCount(db, "app_custom_provider_keys")).toBe(2);
  });

  test("the first-time template CREATE path still materializes the catalog's values (F2)", async () => {
    const { db, app } = await seededWorld();
    const store = configStore(db);
    const created = await postForm(SETTINGS, await mallory(), makeEnv(db), {
      op: "add-template-provider",
      template_id: "subconscious",
      key: sk("sub-template-first"),
    });
    expect(created.status).toBe(200);
    const [decl] = await store.listCustomProviders(app.id);
    expect(decl!.api).toBe("openai-completions"); // the catalog's protocol
    expect(decl!.model_ids).toEqual(["subconscious/glm-5.2", "subconscious/tim-qwen3.6-27b"]);
  });

  test("remove-custom-provider deletes the row; an unknown id is a tolerant no-op", async () => {
    const { db } = await seededWorld();
    await postForm(SETTINGS, await mallory(), makeEnv(db), CUSTOM_FORM);
    const res = await postForm(SETTINGS, await mallory(), makeEnv(db), {
      op: "remove-custom-provider",
      provider_id: "my-custom",
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
