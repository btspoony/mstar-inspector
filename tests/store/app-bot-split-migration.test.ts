import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { applyMigration, createTestD1, execMigrationScript, splitSqlStatements } from "./helpers";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { TestD1 } from "./helpers";

// migrations/0115_app_bot_split.sql — the entity split: one pre-split
// `review_bots` row becomes a `github_apps` row (identity, credentials,
// publishing) plus a new `review_bots` row (configuration, multiplier, quota);
// migrations/0116 copies the App's sandbox image onto its bot and drops the
// App column.
//
// The split runs inside one transaction exactly the way D1 applies a migration
// file. That is not incidental: SQLite only rewrites children's foreign keys
// onto the renamed parent while enforcement is on, and `PRAGMA foreign_keys =
// OFF` is inert inside a transaction — so an autocommit apply would produce a
// DIFFERENT schema (publishing columns pointing at the new `review_bots`
// instead of `github_apps`). Every apply below is transactional.

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const MIGRATION = "0115_app_bot_split.sql";
const DROP_MIGRATION = "0116_github_apps_sandbox_image_drop.sql";

const CONFIG_TABLES = [
  "bot_provider_keys",
  "bot_model_config",
  "bot_model_roles",
  "bot_model_chains",
  "bot_model_chain_seats",
  "bot_custom_providers",
  "bot_custom_provider_keys",
  "bot_provider_models",
] as const;

const PUBLISHING_TABLES = [
  "review_targets",
  "pull_requests",
  "webhook_deliveries",
  "review_publications",
  "review_threads",
  "review_checks",
  "review_findings",
] as const;
function applyFile(db: TestD1, name: string): void {
  const script = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
  db.raw.transaction(() => {
    for (const statement of splitSqlStatements(script)) db.raw.prepare(statement).run();
  })();
}


const BACKFILL_SCRIPT = join(import.meta.dir, "../../scripts/app-bot-backfill.sql");

function backfillStatements(): string[] {
  return splitSqlStatements(readFileSync(BACKFILL_SCRIPT, "utf8"));
}

/**
 * Apply the split file, then execute the ACTUAL `scripts/app-bot-backfill.sql`
 * twice, back to back, inside the same transaction — the ADR's acceptance
 * shape: "the backfill run twice inside the split transaction leaves exactly
 * one row pair per pre-split row". 0115's inline DML does not count as one of
 * the two runs. `assertBetween` runs after EACH pass, so a first pass that
 * already violates the fixed point cannot hide behind the second.
 */
function applySplitWithBackfillTwice(db: TestD1, assertBetween: () => void): void {
  const script = readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8");
  db.raw.transaction(() => {
    for (const statement of splitSqlStatements(script)) db.raw.prepare(statement).run();
    for (let pass = 0; pass < 2; pass += 1) {
      for (const statement of backfillStatements()) db.raw.prepare(statement).run();
      assertBetween();
    }
  })();
}

function execBackfillFile(db: TestD1): void {
  db.raw.transaction(() => {
    for (const statement of backfillStatements()) db.raw.prepare(statement).run();
  })();
}

function createPreSplitD1(): TestD1 {
  const db = createTestD1();
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql") && name >= "0003" && name < MIGRATION)
    .sort();
  // Transactional apply, one file per transaction: the rename-chain rewrite
  // (0056 renames github_apps→review_bots mid-chain) only carries child
  // references onto the renamed parent when the file runs inside a
  // transaction — the way D1 runs it. Autocommit leaves references pointing
  // at the pre-rename table and 0115 then splits the wrong world.
  applyMigration(db.raw, names);
  return db;
}

function count(db: TestD1, table: string): number {
  return (db.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function columnNames(db: TestD1, table: string): string[] {
  return (db.raw.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function foreignKeyTarget(db: TestD1, table: string, column: string): { table: string; onDelete: string } | null {
  const key = (db.raw.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ from: string; table: string; on_delete: string }>)
    .find((entry) => entry.from === column);
  return key === undefined ? null : { table: key.table, onDelete: key.on_delete };
}

const TS = "2026-01-01T00:00:00.000Z";
// A 32-byte base64 master key for the secretbox fixtures (test-only).
const TEST_KEY = btoa("0123456789abcdef0123456789abcdef");
const box = createSecretbox(TEST_KEY);
const PRIVATE_KEY_PLAIN = "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n";
const PROVIDER_KEY_PLAIN = "sk-fixture-provider-key";

async function insertPreSplitBot(
  db: TestD1,
  row: { id: string; githubAppId: number; scope: "owned" | "shared"; sharedAt?: string | null; sandboxImageId?: string },
): Promise<void> {
  const privateKeyEnc = await box.encryptSecret(PRIVATE_KEY_PLAIN, `github_apps.private_key_enc:${row.id}`);
  db.raw
    .prepare(
      `INSERT INTO review_bots (
         id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, status,
         created_at, updated_at, scope, shared_at, sandbox_image_id
       ) VALUES (?, ?, ?, ?, 'enc', 'mallory', 'active', ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.githubAppId, row.id, privateKeyEnc, TS, TS, row.scope, row.sharedAt ?? null, row.sandboxImageId ?? "omp");
}

function seedWorkspace(db: TestD1, id: string): void {
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, id, id, TS);
}

/**
 * Publish one extra quota profile. `effectiveFrom` uses the same ISO instant
 * shape the operator console writes, which is what `resolveQuotaProfile`
 * compares lexically.
 */
function publishProfile(db: TestD1, row: { id: string; version: number; effectiveFrom: string; sourceShared: number }): void {
  db.raw
    .prepare(
      `INSERT INTO quota_profiles (
         id, version, effective_from, base_quick, base_standard, base_deep,
         source_byok, source_shared, rp_per_credit, notes, created_at, created_by
       ) VALUES (?, ?, ?, 1, 2, 6, 1, ?, 20, 'fixture', ?, 'fixture')`,
    )
    .run(row.id, row.version, row.effectiveFrom, row.sourceShared, TS);
  db.raw
    .prepare(
      `INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp)
       VALUES (?, 'free', 2000), (?, 'pro', 20000), (?, 'unlimited', NULL)`,
    )
    .run(row.id, row.id, row.id);
}

async function seedPopulatedPreSplit(): Promise<TestD1> {
  const db = createPreSplitD1();
  seedWorkspace(db, "ws-other");
  await insertPreSplitBot(db, { id: "bot-own", githubAppId: 7001, scope: "owned", sandboxImageId: "custom-image" });
  await insertPreSplitBot(db, { id: "bot-shared", githubAppId: 7002, scope: "shared", sharedAt: TS });
  db.raw.run(
    `INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('bot-own', 'default'), ('bot-shared', 'ws-other')`,
  );
  db.raw.run(
    `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
       VALUES ('inst-1', 'bot-own', 101, 'acme', '${TS}'), ('inst-2', 'bot-shared', 102, 'globex', '${TS}')`,
  );
  // One row in every configuration table, split across the two bots. The
  // provider key is sealed with the production AAD literal so the post-split
  // decrypt proves the row id — and therefore the AAD — never moved.
  const providerKeyEnc = await box.encryptSecret(PROVIDER_KEY_PLAIN, "app_provider_keys.key_enc:bot-own:openai:k1");
  db.raw
    .prepare(
      `INSERT INTO bot_provider_keys (bot_id, provider, key_id, key_enc, created_at)
       VALUES ('bot-own', 'openai', 'k1', ?, '${TS}')`,
    )
    .run(providerKeyEnc);
  db.raw.run(
    `INSERT INTO bot_model_config (bot_id, model_chain, updated_at) VALUES ('bot-shared', 'gpt-5,gpt-5-mini', '${TS}');
     INSERT INTO bot_model_roles (bot_id, role, selector) VALUES ('bot-own', 'reviewer', 'gpt-5');
     INSERT INTO bot_model_chains (bot_id, name, chain, is_default, created_at, updated_at)
       VALUES ('bot-shared', 'default', '["gpt-5"]', 1, '${TS}', '${TS}');
     INSERT INTO bot_model_chain_seats (bot_id, role, chain_name) VALUES ('bot-own', 'reviewer', 'default');
     INSERT INTO bot_custom_providers (bot_id, provider_id, base_url, api, model_ids, created_at, updated_at)
       VALUES ('bot-shared', 'cp', 'https://example.com', 'openai', '["m"]', '${TS}', '${TS}');
     INSERT INTO bot_custom_provider_keys (bot_id, provider, key_id, key_enc, created_at)
       VALUES ('bot-own', 'cp', 'k2', 'enc2', '${TS}');
     INSERT INTO bot_provider_models (bot_id, provider, key_id, models_json, fetched_at)
       VALUES ('bot-shared', 'openai', 'k1', '["gpt-5"]', '${TS}')`,
  );
  // One review attributed to each bot.
  db.raw.run(
    `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, bot_id)
       VALUES ('rev-1', 101, 'acme', 'widgets', 42, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'comment', 'ok', 'bot-own'),
              ('rev-2', 102, 'globex', 'gadgets', 7, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'comment', 'ok', 'bot-shared')`,
  );
  // One queued comment-trigger claim carrying a pre-split payload without botRef.botId.
  db.raw.run(
    `INSERT INTO comment_trigger_claims (installation_id, owner, repo, pr_number, comment_id, state, payload_json, created_ms, queued_ms)
       VALUES (101, 'acme', 'widgets', 42, 555, 'queued',
         '{"installation_id":101,"owner":"acme","repo":"widgets","pr_number":42,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"created","triggered_by":"issue_comment","botRef":{"appId":"bot-own"},"targetId":"target-1"}',
         1000, 1000)`,
  );
  return db;
}

function applySplit(db: TestD1): void {
  applyFile(db, MIGRATION);
}

function claimPayload(db: TestD1, commentId = 555): { botRef?: { appId?: string; botId?: string } } {
  const row = db.raw
    .prepare("SELECT payload_json AS payload FROM comment_trigger_claims WHERE comment_id = ?")
    .get(commentId) as { payload: string };
  return JSON.parse(row.payload) as { botRef?: { appId?: string; botId?: string } };
}

function expectUnsplit(db: TestD1): void {
  const tables = db.raw
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((table) => table.name);
  expect(names).toContain("review_bots");
  expect(names).not.toContain("github_apps");
  expect(names).not.toContain("app_workspaces");
  expect(names).not.toContain("app_installations");
  expect(names).toContain("bot_workspaces");
}

describe("migrations/0115_app_bot_split.sql", () => {
  test("applies on a fresh database: schema splits with one row pair per pre-split row", () => {
    const db = createPreSplitD1();
    applySplit(db);

    expect(count(db, "github_apps")).toBe(0);
    expect(count(db, "review_bots")).toBe(0);
    expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    for (const table of ["app_installations", "app_install_bots"]) {
      expect(columnNames(db, table).length, `${table} exists`).toBeGreaterThan(0);
      expect(count(db, table)).toBe(0);
    }
    db.raw.close();
  });

  test("row counts per split table equal the pre-split counts and both entity ids equal the old id", async () => {
    const db = await seedPopulatedPreSplit();
    const before = {
      config: new Map(CONFIG_TABLES.map((table) => [table, count(db, table)] as const)),
      // Pre-split names: the snapshot is taken before applySplit.
      installations: count(db, "bot_installations"),
      workspaces: count(db, "bot_workspaces"),
    };
    applySplit(db);

    expect(count(db, "github_apps")).toBe(2);
    expect(count(db, "review_bots")).toBe(2);
    const appIds = (db.raw.query("SELECT id FROM github_apps ORDER BY id").all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
    expect(appIds).toEqual(["bot-own", "bot-shared"]);
    const botIds = (db.raw.query("SELECT id FROM review_bots ORDER BY id").all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
    expect(botIds).toEqual(appIds);
    for (const table of CONFIG_TABLES) {
      expect(count(db, table), table).toBe(before.config.get(table)!);
    }
    expect(count(db, "github_app_installations")).toBe(before.installations);
    expect(count(db, "app_workspaces")).toBe(before.workspaces);
    db.raw.close();
  });

  test("every rebuilt configuration table preserves its row values, not only its count", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);

    const expectRow = (sql: string, expected: Record<string, unknown>) => {
      const row = db.raw.query(sql).get() as Record<string, unknown> | null;
      expect(row).not.toBeNull();
      for (const [key, value] of Object.entries(expected)) {
        expect(row![key], `${sql} — ${key}`).toEqual(value);
      }
    };
    expectRow("SELECT * FROM bot_provider_keys WHERE bot_id = 'bot-own'", { provider: "openai", key_id: "k1" });
    expectRow("SELECT * FROM bot_model_config WHERE bot_id = 'bot-shared'", { model_chain: "gpt-5,gpt-5-mini" });
    expectRow("SELECT * FROM bot_model_roles WHERE bot_id = 'bot-own'", { role: "reviewer", selector: "gpt-5" });
    expectRow("SELECT * FROM bot_model_chains WHERE bot_id = 'bot-shared'", { name: "default", chain: '["gpt-5"]', is_default: 1 });
    expectRow("SELECT * FROM bot_model_chain_seats WHERE bot_id = 'bot-own'", { role: "reviewer", chain_name: "default" });
    expectRow("SELECT * FROM bot_custom_providers WHERE bot_id = 'bot-shared'", { provider_id: "cp", base_url: "https://example.com" });
    expectRow("SELECT * FROM bot_custom_provider_keys WHERE bot_id = 'bot-own'", { provider: "cp", key_id: "k2", key_enc: "enc2" });
    expectRow("SELECT * FROM bot_provider_models WHERE bot_id = 'bot-shared'", { provider: "openai", models_json: '["gpt-5"]' });
    db.raw.close();
  });

  test("the pre-split credential envelope and provider-key envelope decrypt under their AAD after the split", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);

    const app = db.raw.query("SELECT private_key_enc FROM github_apps WHERE id = 'bot-own'").get() as {
      private_key_enc: string;
    };
    const pem = await box.decryptSecret(app.private_key_enc, "github_apps.private_key_enc:bot-own");
    expect(pem).toBe(PRIVATE_KEY_PLAIN);

    const key = db.raw
      .query("SELECT key_enc FROM bot_provider_keys WHERE bot_id = 'bot-own' AND provider = 'openai' AND key_id = 'k1'")
      .get() as { key_enc: string };
    const plain = await box.decryptSecret(key.key_enc, "app_provider_keys.key_enc:bot-own:openai:k1");
    expect(plain).toBe(PROVIDER_KEY_PLAIN);
    db.raw.close();
  });

  test("the bot inherits the workspace, scope and the default image; the multiplier follows the profile in force", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);

    const own = db.raw.query("SELECT * FROM review_bots WHERE id = 'bot-own'").get() as Record<string, unknown>;
    expect(own.workspace_id).toBe("default");
    expect(own.scope).toBe("owned");
    expect(own.shared_at).toBeNull();
    expect(own.multiplier).toBe(1);
    expect(own.monthly_rp).toBeNull();
    // The bot starts at the table default; the App's value copies over in 0116
    // — the split file reads no column the drop removes.
    expect(own.sandbox_image_id).toBe("omp");

    // Soft-delete is a product need of the bot: the pair inherits the
    // pre-split row's deleted_at together (NULL here — both fixtures are live).
    expect(own.deleted_at).toBeNull();

    const shared = db.raw.query("SELECT * FROM review_bots WHERE id = 'bot-shared'").get() as Record<string, unknown>;
    expect(shared.workspace_id).toBe("ws-other");
    expect(shared.scope).toBe("shared");
    expect(shared.shared_at).toBe(TS);
    expect(shared.deleted_at).toBeNull();
    // The split backfills a shared bot's multiplier from the profile in force
    // (0063, v1, source_shared = 10). That value is what keeps the bot's price
    // unchanged when Task 3 switches the formula to ceil(base × multiplier).
    expect(shared.multiplier).toBe(10);
    expect(shared.monthly_rp).toBeNull();
    db.raw.close();
  });

  test("a profile effective on the migration day wins over the older one — the ISO comparison is exact", async () => {
    const db = createPreSplitD1();
    seedWorkspace(db, "ws-other");
    await insertPreSplitBot(db, { id: "bot-shared", githubAppId: 7002, scope: "shared", sharedAt: TS });
    db.raw.run("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('bot-shared', 'ws-other')");
    // An older profile, then one effective a millisecond ago TODAY. With the
    // space-formatted datetime('now') comparison the second row sorted after
    // "now" and was skipped; the ISO strftime comparison keeps it in force.
    publishProfile(db, { id: "qp-old", version: 2, effectiveFrom: "2020-01-01T00:00:00.000Z", sourceShared: 3 });
    publishProfile(db, {
      id: "qp-today",
      version: 3,
      effectiveFrom: new Date(Date.now() - 1000).toISOString(),
      sourceShared: 42,
    });
    applySplit(db);

    const shared = db.raw.query("SELECT multiplier FROM review_bots WHERE id = 'bot-shared'").get() as {
      multiplier: number;
    };
    expect(shared.multiplier).toBe(42);
    db.raw.close();
  });

  test("no bot_id column references github_apps and no publishing column references review_bots", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);

    for (const table of CONFIG_TABLES) {
      expect(foreignKeyTarget(db, table, "bot_id")?.table, table).toBe("review_bots");
    }
    for (const table of PUBLISHING_TABLES) {
      expect(columnNames(db, table), table).not.toContain("bot_id");
      expect(foreignKeyTarget(db, table, "app_id")?.table, table).toBe("github_apps");
    }
    // pull_requests keeps the cascade — the one child a parent rebuild would empty.
    expect(foreignKeyTarget(db, "pull_requests", "app_id")?.onDelete).toBe("CASCADE");

    expect(foreignKeyTarget(db, "reviews", "app_id")?.table).toBe("github_apps");
    expect(foreignKeyTarget(db, "reviews", "bot_id")?.table).toBe("review_bots");
    expect(foreignKeyTarget(db, "app_workspaces", "app_id")?.table).toBe("github_apps");
    expect(foreignKeyTarget(db, "github_app_installations", "app_id")?.table).toBe("github_apps");

    for (const table of ["lifecycle_recovery_cursor", "check_reenable_cursor", "degraded_target_leases"]) {
      expect(columnNames(db, table), table).toContain("app_id");
      expect(columnNames(db, table), table).not.toContain("bot_id");
    }
    db.raw.close();
  });

  test("neither entity carries a column for the other (D34)", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);
    expect(columnNames(db, "review_bots")).not.toContain("github_app_id");
    expect(columnNames(db, "github_apps")).not.toContain("default_bot_id");
    db.raw.close();
  });

  test("an orphan chain row is refused with foreign-key enforcement on", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);
    expect((db.raw.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(() =>
      db.raw
        .prepare(
          "INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id) VALUES ('bot-own', 'default', 1, 'bot-own')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(count(db, "app_install_bots")).toBe(0);
    db.raw.close();
  });

  test("reviews.app_id backfills equal to the renamed app_id value", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);
    const rows = db.raw.query("SELECT id, app_id, bot_id FROM reviews ORDER BY id").all() as Array<{
      id: string;
      app_id: string;
      bot_id: string;
    }>;
    expect(rows).toEqual([
      { id: "rev-1", app_id: "bot-own", bot_id: "bot-own" },
      { id: "rev-2", app_id: "bot-shared", bot_id: "bot-shared" },
    ]);
    db.raw.close();
  });

  test("the queued comment-trigger payload carries botRef.botId equal to botRef.appId", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);
    const payload = claimPayload(db);
    expect(payload.botRef?.appId).toBe("bot-own");
    expect(payload.botRef?.botId).toBe("bot-own");
    db.raw.close();
  });

  test("PRAGMA foreign_key_check is empty over populated data", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);
    expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.raw.close();
  });

  test("the backfill file executed twice inside the split transaction is a fixed point — one row pair per pre-split row", async () => {
    const db = await seedPopulatedPreSplit();
    applySplitWithBackfillTwice(db, () => {
      expect(count(db, "github_apps")).toBe(2);
      expect(count(db, "review_bots")).toBe(2);
    });

    expect(count(db, "github_apps")).toBe(2);
    expect(count(db, "review_bots")).toBe(2);
    expect(
      (db.raw.query("SELECT id, app_id, app_id FROM reviews ORDER BY id").all() as Array<{ app_id: string }>).map(
        (row) => row.app_id,
      ),
    ).toEqual(["bot-own", "bot-shared"]);
    expect(claimPayload(db).botRef?.botId).toBe("bot-own");
    expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.raw.close();
  });

  test("scripts/app-bot-backfill.sql replays as a no-op in a later transaction", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);

    const snapshot = {
      bots: db.raw.query("SELECT * FROM review_bots ORDER BY id").all(),
      reviews: db.raw.query("SELECT id, app_id, app_id FROM reviews ORDER BY id").all(),
      payload: claimPayload(db),
    };

    expect(backfillStatements().length).toBeGreaterThanOrEqual(2);
    execBackfillFile(db);

    expect(db.raw.query("SELECT * FROM review_bots ORDER BY id").all()).toEqual(snapshot.bots);
    expect(db.raw.query("SELECT id, app_id, app_id FROM reviews ORDER BY id").all()).toEqual(snapshot.reviews);
    expect(claimPayload(db)).toEqual(snapshot.payload);
    expect(count(db, "review_bots")).toBe(2);
    expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.raw.close();
  });

  test("a pre-split row without an owner row aborts the whole file and leaves the schema unsplit", async () => {
    const db = createPreSplitD1();
    await insertPreSplitBot(db, { id: "bot-orphan", githubAppId: 7003, scope: "owned" });
    expect(() => applySplit(db)).toThrow();

    expectUnsplit(db);
    expect(count(db, "review_bots")).toBe(1);
    db.raw.close();
  });

  test("a queued payload with no botRef.appId aborts the whole file", async () => {
    const db = await seedPopulatedPreSplit();
    db.raw.run(
      `INSERT INTO comment_trigger_claims (installation_id, owner, repo, pr_number, comment_id, state, payload_json, created_ms, queued_ms)
         VALUES (101, 'acme', 'widgets', 42, 556, 'queued',
           '{"installation_id":101,"owner":"acme","repo":"widgets","pr_number":42,"action":"created","triggered_by":"issue_comment","targetId":"target-1"}',
           1000, 1000)`,
    );
    expect(() => applySplit(db)).toThrow();
    expectUnsplit(db);
    db.raw.close();
  });

  test("a queued payload naming an unknown App aborts the whole file", async () => {
    const db = await seedPopulatedPreSplit();
    db.raw.run(
      `INSERT INTO comment_trigger_claims (installation_id, owner, repo, pr_number, comment_id, state, payload_json, created_ms, queued_ms)
         VALUES (101, 'acme', 'widgets', 42, 557, 'queued',
           '{"installation_id":101,"owner":"acme","repo":"widgets","pr_number":42,"action":"created","triggered_by":"issue_comment","botRef":{"appId":"no-such-app"},"targetId":"target-1"}',
           1000, 1000)`,
    );
    expect(() => applySplit(db)).toThrow();
    expectUnsplit(db);
    db.raw.close();
  });

  test("the apply-once guard: a second full-file apply fails on the rename, proving forward-only DDL", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);
    // The split's DDL is forward-only like every rename in migrations/: the
    // idempotence the acceptance binds is the data statements', covered above.
    expect(() => applySplit(db)).toThrow(/github_apps/);
    expect(count(db, "github_apps")).toBe(2);
    expect(count(db, "review_bots")).toBe(2);
    expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.raw.close();
  });
});

describe("migrations/0116_github_apps_sandbox_image_drop.sql", () => {
  test("copies the App's image onto its bot before dropping the column", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);
    applyFile(db, DROP_MIGRATION);

    const own = db.raw.query("SELECT sandbox_image_id FROM review_bots WHERE id = 'bot-own'").get() as {
      sandbox_image_id: string;
    };
    expect(own.sandbox_image_id).toBe("custom-image");
    const shared = db.raw.query("SELECT sandbox_image_id FROM review_bots WHERE id = 'bot-shared'").get() as {
      sandbox_image_id: string;
    };
    expect(shared.sandbox_image_id).toBe("omp");
    expect(columnNames(db, "github_apps")).not.toContain("sandbox_image_id");
    expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.raw.close();
  });

  test("scripts/app-bot-backfill.sql still re-runs clean after the drop file has applied (D9)", async () => {
    const db = await seedPopulatedPreSplit();
    applySplit(db);
    applyFile(db, DROP_MIGRATION);

    const snapshot = {
      bots: db.raw.query("SELECT id, workspace_id, name, scope, multiplier FROM review_bots ORDER BY id").all(),
      reviews: db.raw.query("SELECT id, app_id, app_id FROM reviews ORDER BY id").all(),
      payload: claimPayload(db),
    };

    // The backfill file reads no dropped column, so it re-runs on the post-drop
    // schema without an error and without changing a row (D9).
    execBackfillFile(db);

    expect(db.raw.query("SELECT id, workspace_id, name, scope, multiplier FROM review_bots ORDER BY id").all()).toEqual(
      snapshot.bots,
    );
    expect(db.raw.query("SELECT id, app_id, app_id FROM reviews ORDER BY id").all()).toEqual(snapshot.reviews);
    expect(claimPayload(db)).toEqual(snapshot.payload);
    expect(count(db, "review_bots")).toBe(2);
    expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.raw.close();
  });
});
