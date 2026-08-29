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
 * PROVIDER_IDS ≡ the pipeline PROVIDERS key sequence, and parseModelChain ≡
 * the runtime-omp parseModelSelectors behavior, both asserted against the
 * originals here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../../src/worker/index";
import { createTestD1 } from "../store/helpers";
import { createAppsStore, type GithubAppRow } from "../../src/dashboard/apps-store";
import {
  PROVIDER_IDS,
  createAppConfigStore,
  parseModelChain,
} from "../../src/dashboard/app-config-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { PROVIDERS } from "../../src/pipeline/providers";
import { parseModelSelectors } from "../../src/review/runtime-omp";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser, type DashboardD1 } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_KEY = Buffer.alloc(32, 11).toString("base64");
const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";
const PLAIN_ANTHROPIC_KEY = "sk-ant-mallory-verysecret-9988";
const PLAIN_CHAIN = "ark-plan/deepseek-v4-flash, openai/gpt-5:thinking";

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

/** Fully-migrated shape with 0006 applied over the populated DB. */
function createAppConfigD1(): ReturnType<typeof createTestD1> {
  const db = createPopulatedPre0006D1();
  applyMigration(db, "0006_app_provider_config.sql");
  return db;
}

const configStore = (db: DashboardD1) => createAppConfigStore(db, TEST_KEY);

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
    expect(list).toEqual([{ provider: "anthropic", last4: "bbbb" }]);
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
      { provider: "anthropic", last4: "9988" },
      { provider: "openai", last4: "7777" },
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
      { provider: "groq", last4: "" },
      { provider: "kilo", last4: "" },
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
    expect(listX).toEqual([{ provider: "anthropic", last4: "1111" }]);
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
    expect(body).toContain('<input type="password" name="key"');
    // The select is the only place a provider id can enter — bound to the
    // same allowlist the POST route 400s against.
    const options = [...body.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);
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
