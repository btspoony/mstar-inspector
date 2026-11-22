/**
 * why: Migration tests — the DDL in
 * `migrations/0001_reviews.sql` + `0002_mstar_review_v1.sql` is the single
 * source of truth; these tests execute it statement by statement through
 * `execMigrationScript` (`./helpers`) on the bun:sqlite test double, which is
 * fail-fast: a statement that fails aborts the file instead of being skipped,
 * so a schema that cannot be built is never half-applied here. They assert the
 * schema contract:
 *   - reviews / findings tables + indexes exist
 *   - UNIQUE (installation_id, owner, repo, pr_number, head_sha) rejects a
 *     second row for the same sha (authoritative dedup, must not weaken)
 *   - head_sha is NOT NULL — an empty sha cannot be inserted
 *   - 0002 adds reviews.envelope: TEXT, nullable (M1 rows), CHECK
 *     json_valid for v1 rows
 *   - 0036 renames github_apps.slug to webhook_path (values preserved) and
 *     adds the nullable, deliberately UNINDEXED github_slug cache
 *   - 0037 adds the nullable github_metadata_attempted_at marker that bounds
 *     an unsynced App's re-attempt to one fetch per TTL window
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createMigratedTestD1, createTestD1, execMigrationScript, migrationNumber, migrationsAfter } from "./helpers";
import {
  WORKSPACE_CONCURRENCY_MAX,
  getEffectiveConcurrency,
} from "../../src/dashboard/runtime-config-store";
import { GITHUB_RATE_LIMIT_PREFIX } from "../../src/contracts/failure-stages";
import { selectAssessmentTargets } from "../../src/store/finding-lifecycle";
import { createFailureStore } from "../../src/store/failure-store";
import { COMMENT_CLAIM_OUTBOX_SQL, MAINTENANCE_REPLAY_OUTBOX_SQL } from "../../src/worker/sweep";
import type { TestD1 } from "./helpers";
import type { D1Like } from "../../src/store/types";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

/**
 * why: The parent table of THIS fixture's shape: 0056 renames `github_apps` to
 * `review_bots`, and the describes below seed both the pre- and post-rename
 * schema, so a raw query cannot hard-code either name.
 */
function appTable(db: TestD1): "github_apps" | "review_bots" {
  const row = db.raw
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('github_apps','review_bots')")
    .get() as { name: string } | null | undefined;
  return row?.name === "review_bots" ? "review_bots" : "github_apps";
}

/**
 * why: The App route-key column of THIS fixture's shape. Migration 0036 renamed
 * `slug` to `webhook_path`, and the describes below seed both the pre- and
 * post-0036 schema, so a raw query cannot hard-code either name.
 */
function appPathColumn(db: TestD1): "slug" | "webhook_path" | null {
  const columns = db.raw.query(`PRAGMA table_info(${appTable(db)})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === "webhook_path")) return "webhook_path";
  return columns.some((c) => c.name === "slug") ? "slug" : null;
}

/**
 * why: Insert one github_apps row into whichever shape the fixture carries. The
 * local route key is `slug` before 0036, `webhook_path` until 0038, and gone
 * afterwards (the row id carries it) — this helper is the one place that
 * knows the difference.
 */
function insertGithubAppRow(
  db: TestD1,
  row: {
    id: string;
    githubAppId?: number;
    name?: string;
    createdBy?: string;
    /** note: SQL expression for deleted_at (defaults NULL). */
    deletedExpr?: string;
    extraColumns?: string;
    extraValues?: string;
  },
): void {
  const pathColumn = appPathColumn(db);
  const columns = [
    "id",
    ...(pathColumn ? [pathColumn] : []),
    "github_app_id",
    "name",
    "private_key_enc",
    "webhook_secret_enc",
    "created_by",
    "status",
    "deleted_at",
    ...(row.extraColumns ? [row.extraColumns] : []),
    "created_at",
    "updated_at",
  ].join(", ");
  const values = [
    "?",
    ...(pathColumn ? ["?"] : []),
    "?",
    "?",
    "'enc'",
    "'enc'",
    "?",
    "'active'",
    row.deletedExpr ?? "NULL",
    ...(row.extraValues ? [row.extraValues] : []),
    "datetime('now')",
    "datetime('now')",
  ].join(", ");
  db.raw
    .prepare(`INSERT INTO ${appTable(db)} (${columns}) VALUES (${values})`)
    .run(
      row.id,
      ...(pathColumn ? [row.id] : []),
      row.githubAppId ?? 1001,
      row.name ?? row.id,
      row.createdBy ?? "mallory",
    );
}

const REVIEW = {
  id: "review-1",
  installation_id: 123,
  owner: "acme",
  repo: "widgets",
  pr_number: 42,
  head_sha: "0123456789abcdef0123456789abcdef01234567",
  verdict: "comment",
  summary_md: "No blocking issues.",
};

function insertReview(db: D1Like, overrides: Partial<typeof REVIEW> = {}): Promise<unknown> {
  const row = { ...REVIEW, ...overrides };
  return db
    .prepare(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.installation_id, row.owner, row.repo, row.pr_number, row.head_sha, row.verdict, row.summary_md)
    .run();
}

/**
 * why: Every migration before review configuration moves off the bot row — the
 * chain a live database carries while the moved columns are still on it. The
 * split's own fixtures start here and apply that one file on top.
 */
const BEFORE_TARGET_SPLIT = migrationsAfter("0002_mstar_review_v1.sql").filter(
  (name) => migrationNumber(name) < migrationNumber("0057_review_targets.sql"),
);

/** note: A DB shaped like production immediately before the target split. */
function createBeforeSplitD1(): TestD1 {
  const db = createTestD1();
  for (const name of BEFORE_TARGET_SPLIT) execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  return db;
}

/** note: Every table / index name the schema holds. */
function schemaNames(db: TestD1, type: "table" | "index"): string[] {
  return (
    db.raw.query("SELECT name FROM sqlite_master WHERE type = ?").all(type) as Array<{ name: string }>
  ).map((row) => row.name);
}

/** note: Every column name of one table, in declaration order. */
function columnNames(db: TestD1, table: string): string[] {
  return (db.raw.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

/** note: The tables one column's foreign key references. */
function foreignKeyTargets(db: TestD1, table: string, column: string): string[] {
  return (db.raw.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ from: string; table: string }>)
    .filter((key) => key.from === column)
    .map((key) => key.table);
}

describe("migrations/0001_reviews.sql", () => {
  test("creates reviews and findings tables with the expected columns", () => {
    const db = createTestD1();
    const reviews = db.raw.query("PRAGMA table_info(reviews)").all() as Array<{ name: string; notnull: number; pk: number }>;
    const reviewCols: Record<string, number> = Object.fromEntries(reviews.map((c) => [c.name, c.notnull]));
    const reviewPks: Record<string, number> = Object.fromEntries(reviews.map((c) => [c.name, c.pk]));

    expect(reviewPks["id"]).toBe(1); // note: TEXT PRIMARY KEY (SQLite does not imply NOT NULL)
    expect(reviewCols["id"]).toBe(0);
    expect(reviewCols["installation_id"]).toBe(1);
    expect(reviewCols["owner"]).toBe(1);
    expect(reviewCols["repo"]).toBe(1);
    expect(reviewCols["pr_number"]).toBe(1);
    expect(reviewCols["head_sha"]).toBe(1); // note: NOT NULL — empty sha must never be stored
    expect(reviewCols["verdict"]).toBe(1);
    expect("base_sha" in reviewCols).toBe(true);
    expect("reviewed_at" in reviewCols).toBe(true);
    expect("summary_md" in reviewCols).toBe(true);
    expect("model" in reviewCols).toBe(true);
    expect("provider" in reviewCols).toBe(true);
    expect("skill_version" in reviewCols).toBe(true);
    expect("raw_output" in reviewCols).toBe(true);
    expect("envelope" in reviewCols).toBe(true); // note: migration 0002

    const findings = db.raw.query("PRAGMA table_info(findings)").all() as Array<{ name: string; notnull: number; pk: number }>;
    const findingCols: Record<string, number> = Object.fromEntries(findings.map((c) => [c.name, c.notnull]));
    const findingPks: Record<string, number> = Object.fromEntries(findings.map((c) => [c.name, c.pk]));
    expect(findingPks["id"]).toBe(1); // note: TEXT PRIMARY KEY
    expect(findingCols["id"]).toBe(0);
    expect(findingCols["review_id"]).toBe(1);
    expect(findingCols["severity"]).toBe(1);
    expect(findingCols["title"]).toBe(1);
    expect("category" in findingCols).toBe(true);
    expect("file_path" in findingCols).toBe(true);
    expect("line_start" in findingCols).toBe(true);
    expect("line_end" in findingCols).toBe(true);
    expect("body" in findingCols).toBe(true);
    expect("fingerprint" in findingCols).toBe(true);
    expect("status" in findingCols).toBe(true);
  });

  test("creates the review-store indexes", () => {
    const db = createTestD1();
    const indexes = db.raw.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name).sort();
    expect(names).toEqual(["idx_findings_fingerprint", "idx_findings_severity", "idx_reviews_repo"]);
  });

  test("UNIQUE (installation_id, owner, repo, pr_number, head_sha) rejects a second row for the same sha", async () => {
    const db = createTestD1();
    await insertReview(db);
    await expect(insertReview(db, { id: "review-2" })).rejects.toThrow(/UNIQUE constraint failed/);

    const count = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("the same PR with a different head_sha inserts a new row (synchronize semantics)", async () => {
    const db = createTestD1();
    await insertReview(db);
    await insertReview(db, { id: "review-2", head_sha: "ffffffffffffffffffffffffffffffffffffffff" });

    const count = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(count.n).toBe(2);
  });

  test("an empty head_sha cannot be inserted (CHECK head_sha <> '')", async () => {
    const db = createTestD1();
    await expect(insertReview(db, { id: "review-2", head_sha: "" })).rejects.toThrow(/CHECK constraint failed/);
  });

  test("findings rows cascade-delete with their review", async () => {
    const db = createTestD1();
    await insertReview(db);
    await db
      .prepare(
        `INSERT INTO findings (id, review_id, severity, category, title)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind("finding-1", REVIEW.id, "warning", "logic", "Null deref risk")
      .run();

    await db.prepare("DELETE FROM reviews WHERE id = ?").bind(REVIEW.id).run();
    const remaining = db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});

describe("migrations/0007_reviews_app_id_index.sql", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: ReturnType<typeof createTestD1>, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0006 with live rows)", () => {
    const db = createTestD1();
    // why: Reviews exist BEFORE the later migrations — the wrangler sequence on a
    // live deployment: a legacy row (app_id NULL) and, once 0004/0005 exist,
    // an attributed row.
    insertReview(db);
    insertReview(db, { id: "review-2", head_sha: "ffffffffffffffffffffffffffffffffffffffff" });
    for (const name of [
      "0003_dashboard_users.sql",
      "0004_github_apps.sql",
      "0005_reviews_app_id.sql",
      "0006_app_provider_config.sql",
    ]) {
      applyMigrationFile(db, name);
    }
    db.raw
      .prepare(
        `INSERT INTO github_apps (id, ${appPathColumn(db)}, github_app_id, name, private_key_enc, webhook_secret_enc,
           created_by, status, deleted_at, created_at, updated_at)
         VALUES ('app-1', 'acmes-app', 1001, 'acmes-app', 'enc', 'enc', 'mallory', 'active', NULL,
           datetime('now'), datetime('now'))`,
      )
      .run();
    db.raw.exec("UPDATE reviews SET app_id = 'app-1' WHERE id = 'review-2'");

    // why: Metadata-only CREATE INDEX builds over the live rows without rewriting.
    expect(() => applyMigrationFile(db, "0007_reviews_app_id_index.sql")).not.toThrow();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(count.n).toBe(2);
  });

  test("creates idx_reviews_bot_id ON reviews(bot_id) (fully migrated schema; 0056 recreated it under the bot name)", () => {
    const db = createMigratedTestD1();
    const index = db.raw
      .query("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_reviews_bot_id'")
      .get() as { tbl_name: string } | null;
    expect(index).not.toBeNull();
    expect(index!.tbl_name).toBe("reviews");
    const columns = db.raw.query("PRAGMA index_info(idx_reviews_bot_id)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual(["bot_id"]);
  });

  test("the per-bot attribution lookup uses the index (EXPLAIN QUERY PLAN)", () => {
    const db = createMigratedTestD1();
    const plan = db.raw
      .query("EXPLAIN QUERY PLAN SELECT id FROM reviews WHERE bot_id = 'app-1'")
      .all() as Array<{ detail: string }>;
    expect(plan.some((p) => p.detail.includes("USING INDEX idx_reviews_bot_id"))).toBe(true);
  });
});

describe("migrations/0008_github_apps_ops.sql", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: ReturnType<typeof createTestD1>, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** note: Raw-insert one pre-0008-shaped github_apps row (the 0004 column list). */
  function insertPre0008App(db: ReturnType<typeof createTestD1>): void {
    insertGithubAppRow(db, { id: "app-1", name: "acmes-app", githubAppId: 1001 });
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0007 with live rows)", () => {
    const db = createTestD1();
    insertReview(db); // note: a live review predates the ALTER (wrangler order)
    for (const name of [
      "0003_dashboard_users.sql",
      "0004_github_apps.sql",
      "0005_reviews_app_id.sql",
      "0006_app_provider_config.sql",
      "0007_reviews_app_id_index.sql",
    ]) {
      applyMigrationFile(db, name);
    }
    insertPre0008App(db);

    // why: Metadata-only ADD COLUMNs alter the table without rewriting it (the
    // 0002/0005 precedent) — the live row survives untouched.
    expect(() => applyMigrationFile(db, "0008_github_apps_ops.sql")).not.toThrow();
    const row = db.raw
      .query(`SELECT ${appPathColumn(db) ?? "id"} AS webhook_path, status, review_enabled, last_webhook_at FROM github_apps WHERE id = 'app-1'`)
      .get() as { webhook_path: string; status: string; review_enabled: number; last_webhook_at: string | null };
    // note: Existing rows materialize to the resume default (L5: every App known
    // before the migration stays reviewing), last delivery never seen.
    expect(row.review_enabled).toBe(1);
    expect(row.last_webhook_at).toBeNull();
    expect(row.webhook_path).toBe("app-1");
    expect(row.status).toBe("active");
    const count = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("adds review_enabled (INTEGER NOT NULL DEFAULT 1) + last_webhook_at (TEXT nullable) to the parent row", () => {
    const db = createMigratedTestD1();
    const columns = db.raw.query("PRAGMA table_info(review_bots)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const reviewEnabled = columns.find((col) => col.name === "review_enabled");
    expect(reviewEnabled).toBeDefined();
    expect(reviewEnabled!.notnull).toBe(1); // note: NOT NULL is legal with a non-NULL DEFAULT (L5)
    expect(reviewEnabled!.dflt_value).toBe("1");
    const lastWebhookAt = columns.find((col) => col.name === "last_webhook_at");
    expect(lastWebhookAt).toBeDefined();
    expect(lastWebhookAt!.notnull).toBe(0);
    expect(lastWebhookAt!.dflt_value).toBeNull();
  });

  test("a row inserted without the new columns defaults to review_enabled=1, last_webhook_at NULL", () => {
    const db = createMigratedTestD1();
    insertPre0008App(db);
    const row = db.raw
      .query("SELECT review_enabled, last_webhook_at FROM review_bots WHERE id = 'app-1'")
      .get() as { review_enabled: number; last_webhook_at: string | null };
    expect(row.review_enabled).toBe(1);
    expect(row.last_webhook_at).toBeNull();
  });

  test("the ops columns are writable and read back (pause + last-delivery shapes)", () => {
    const db = createMigratedTestD1();
    insertPre0008App(db);
    db.raw.prepare("UPDATE review_bots SET review_enabled = 0, last_webhook_at = datetime('now') WHERE id = 'app-1'").run();
    const row = db.raw
      .query("SELECT review_enabled, last_webhook_at FROM review_bots WHERE id = 'app-1'")
      .get() as { review_enabled: number; last_webhook_at: string | null };
    expect(row.review_enabled).toBe(0);
    expect(row.last_webhook_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("migrations/0009_app_model_roles.sql", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: ReturnType<typeof createTestD1>, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** note: Raw-insert one github_apps row (the 0004 column list is sufficient). */
  function insertApp(db: ReturnType<typeof createTestD1>, id: string, githubAppId = 1001): void {
    insertGithubAppRow(db, { id, githubAppId });
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0008 with live rows)", () => {
    const db = createTestD1();
    insertReview(db); // note: a live review predates the CREATE TABLE (wrangler order)
    for (const name of [
      "0003_dashboard_users.sql",
      "0004_github_apps.sql",
      "0005_reviews_app_id.sql",
      "0006_app_provider_config.sql",
      "0007_reviews_app_id_index.sql",
      "0008_github_apps_ops.sql",
    ]) {
      applyMigrationFile(db, name);
    }
    insertApp(db, "app-1");

    // why: Append-only CREATE TABLE over the live rows — nothing existing changes.
    expect(() => applyMigrationFile(db, "0009_app_model_roles.sql")).not.toThrow();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("composite PK (bot_id, role) rejects a duplicate pair; other bots may repeat the role", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    insertApp(db, "app-2", 1002);
    db.raw
      .prepare(`INSERT INTO bot_model_roles (bot_id, role, selector) VALUES ('app-1', 'code-reviewer', 'openai/gpt-5')`)
      .run();
    expect(() =>
      db.raw
        .prepare(`INSERT INTO bot_model_roles (bot_id, role, selector) VALUES ('app-1', 'code-reviewer', 'x/y')`)
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    // invariant: The same role under ANOTHER bot is a distinct row (per-bot role maps).
    db.raw
      .prepare(`INSERT INTO bot_model_roles (bot_id, role, selector) VALUES ('app-2', 'code-reviewer', 'x/y')`)
      .run();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM bot_model_roles").get() as { n: number };
    expect(count.n).toBe(2);
  });

  test("FK to review_bots — unknown bot refused; a role not on the runner's seat names is storable (no CHECK — vocabulary is producer-side, lock L3)", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    expect(() =>
      db.raw
        .prepare(`INSERT INTO bot_model_roles (bot_id, role, selector) VALUES ('no-such-app', 'code-reviewer', 'x/y')`)
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    // note: Deliberate: the schema carries NO role CHECK — the store's MODEL_ROLE_IDS
    // mirror + parity test own the 4-name vocabulary (spec § B6 语义锁).
    db.raw
      .prepare(`INSERT INTO bot_model_roles (bot_id, role, selector) VALUES ('app-1', 'not-a-seat', 'x/y')`)
      .run();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM bot_model_roles").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("no ON DELETE: hard-deleting a bot with role rows is refused (soft-delete is the only removal path)", async () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    db.raw
      .prepare(`INSERT INTO bot_model_roles (bot_id, role, selector) VALUES ('app-1', 'mstar-review-seat', 'ark/deepseek-v4-flash:high')`)
      .run();
    expect(() => db.raw.prepare("DELETE FROM review_bots WHERE id = 'app-1'").run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe("migrations/0010_review_failures.sql", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: ReturnType<typeof createTestD1>, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** note: Raw-insert one failure row (full column control). */
  function insertFailure(
    db: ReturnType<typeof createTestD1>,
    overrides: Partial<Record<string, unknown>> = {},
  ): void {
    const row = {
      id: "failure-1",
      installation_id: 123,
      owner: "acme",
      repo: "widgets",
      pr_number: 42,
      head_sha: "0123456789abcdef0123456789abcdef01234567",
      stage: "parse",
      error: "not valid ReviewOutput JSON",
      ...overrides,
    };
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.installation_id, row.owner, row.repo, row.pr_number, row.head_sha, row.stage, row.error);
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0009 with live rows); existing tables untouched", () => {
    const db = createTestD1();
    insertReview(db); // note: a live review predates the CREATE TABLE (wrangler order)
    for (const name of [
      "0003_dashboard_users.sql",
      "0004_github_apps.sql",
      "0005_reviews_app_id.sql",
      "0006_app_provider_config.sql",
      "0007_reviews_app_id_index.sql",
      "0008_github_apps_ops.sql",
      "0009_app_model_roles.sql",
    ]) {
      applyMigrationFile(db, name);
    }

    // why: Append-only CREATE TABLE over the live rows — nothing existing changes.
    expect(() => applyMigrationFile(db, "0010_review_failures.sql")).not.toThrow();
    const reviewCount = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviewCount.n).toBe(1);
    const index = db.raw
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_failures_created'")
      .get();
    expect(index).toBeDefined();
  });

  test("created_at defaults to datetime('now'); every NOT NULL column rejects NULL", () => {
    const db = createMigratedTestD1();
    insertFailure(db);
    const row = db.raw.query("SELECT * FROM review_failures").get() as {
      id: string;
      created_at: string;
    };
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // invariant: A NULL in any one of the NOT NULL columns is refused while the rest
    // stay valid.
    const base = {
      installation_id: 123,
      owner: "acme",
      repo: "widgets",
      pr_number: 42,
      head_sha: "0123456789abcdef0123456789abcdef01234567",
      stage: "parse",
      error: "err",
    };
    for (const column of Object.keys(base)) {
      // why: The nulled column is only known at runtime; the cast restores the
      // static shape so bun:sqlite's binding types accept the spread.
      const values = { ...base, [column]: null } as typeof base;
      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
             VALUES ('f-null', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            values.installation_id,
            values.owner,
            values.repo,
            values.pr_number,
            values.head_sha,
            values.stage,
            values.error,
          ),
      ).toThrow(/NOT NULL constraint failed/);
    }
  });

  test("stage has NO CHECK — the vocabulary is producer-side (0009 precedent); any stage string is storable", () => {
    const db = createMigratedTestD1();
    insertFailure(db, { stage: "runner" });
    insertFailure(db, { id: "failure-2", stage: "sandbox" });
    insertFailure(db, { id: "failure-3", stage: "pipeline" });
    // note: Even a nonsense stage stores — the store leaf's FAILURE_STAGES gate is
    // the enforcement point, never the schema.
    insertFailure(db, { id: "failure-4", stage: "not-a-stage" });
    const count = db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get() as { n: number };
    expect(count.n).toBe(4);
  });

  test("rows are per-attempt events — the five-tuple is NOT unique; head_sha may be empty (pre-checkout failure)", () => {
    const db = createMigratedTestD1();
    insertFailure(db);
    insertFailure(db, { id: "failure-2" }); // note: same sha, attempt 2 (retry)
    insertFailure(db, { id: "failure-3", head_sha: "" }); // note: failed before the checkout resolved
    const count = db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get() as { n: number };
    expect(count.n).toBe(3);
  });

  test("era invariant: a failure row never writes reviews — the tables stay separate", () => {
    const db = createMigratedTestD1();
    insertFailure(db);
    const reviewCount = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviewCount.n).toBe(0);
  });
});

describe("migrations/0020_finding_lifecycle.sql (spec review-lifecycle §7.1)", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** note: Raw-insert one github_apps row (the 0004 column list is sufficient). */
  function insertApp(db: TestD1, id: string): void {
    insertGithubAppRow(db, { id });
  }

  /** note: The pre-0020 shape (0001–0019, filename order) — what production runs today. */
  function createPre0020Db(): TestD1 {
    const db = createTestD1();
    for (const name of [
      "0003_dashboard_users.sql",
      "0004_github_apps.sql",
      "0005_reviews_app_id.sql",
      "0006_app_provider_config.sql",
      "0007_reviews_app_id_index.sql",
      "0008_github_apps_ops.sql",
      "0009_app_model_roles.sql",
      "0010_review_failures.sql",
      "0011_webhook_deliveries.sql",
      "0012_custom_providers_and_key_updated_at.sql",
      "0013_findings_review_id_index.sql",
      "0014_idx_reviews_reviewed_at.sql",
      "0015_provider_verification.sql",
      "0016_users_login_nocase_unique.sql",
      "0017_app_model_chains.sql",
      "0018_app_sandbox_images.sql",
      "0019_github_apps_metadata.sql",
    ]) {
      applyMigrationFile(db, name);
    }
    return db;
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0019 with live rows)", () => {
    const db = createPre0020Db();
    insertReview(db); // note: a live review predates the CREATE TABLEs (wrangler order)
    insertApp(db, "app-1");
    // why: Append-only CREATE TABLEs + indexes over the live rows — nothing
    // existing changes.
    expect(() => applyMigrationFile(db, "0020_finding_lifecycle.sql")).not.toThrow();
    const reviewCount = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviewCount.n).toBe(1);
  });

  test("creates the four lifecycle tables and the recovery/rotation/scope indexes", () => {
    const db = createMigratedTestD1();
    const tables = db.raw
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('review_publications','review_findings','review_finding_rounds','review_threads') ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      "review_finding_rounds",
      "review_findings",
      "review_publications",
      "review_threads",
    ]);
    const indexes = db.raw
      .query("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' AND name IN ('idx_publication_recovery','idx_finding_rotation','idx_thread_recovery')")
      .all() as Array<{ name: string; tbl_name: string }>;
    expect(Object.fromEntries(indexes.map((i) => [i.name, i.tbl_name]))).toEqual({
      idx_publication_recovery: "review_publications",
      idx_finding_rotation: "review_findings",
      idx_thread_recovery: "review_threads",
    });
    // note: The rotation index covers the §7.2 scope+state prefix in order.
    const rotationColumns = db.raw.query("PRAGMA index_info(idx_finding_rotation)").all() as Array<{ name: string }>;
    expect(rotationColumns.map((c) => c.name)).toEqual([
      "bot_id", "installation_id", "owner", "repo", "pr_number", "state", "last_scheduled_ms", "id",
    ]);
  });

  test("UNIQUE (bot_id, installation_id, owner, repo, pr_number, head_sha, kind) rejects a second publication row", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    const insert = (id: string) =>
      db.raw
        .prepare(
          `INSERT INTO review_publications (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json, created_ms, updated_ms)
           VALUES (?, 'app-1', 123, 'acme', 'widgets', 42, ?, 'review', 'prepared', '{}', 1000, 1000)`,
        )
        .run(id, "0".repeat(40));
    insert("pub-1");
    expect(() => insert("pub-2")).toThrow(/UNIQUE constraint failed/);
    // invariant: Same SHA with a different kind is a distinct publication (review vs degraded).
    db.raw
      .prepare(
        `INSERT INTO review_publications (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json, created_ms, updated_ms)
         VALUES ('pub-deg', 'app-1', 123, 'acme', 'widgets', 42, ?, 'degraded', 'prepared', '{}', 1000, 1000)`,
      )
      .run("0".repeat(40));
    const count = db.raw.query("SELECT COUNT(*) AS n FROM review_publications").get() as { n: number };
    expect(count.n).toBe(2);
  });

  test("CHECK constraints pin the state vocabularies", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    db.raw
      .prepare(
        `INSERT INTO review_publications (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json, recovery_state, created_ms, updated_ms)
         VALUES ('pub-1', 'app-1', 123, 'acme', 'widgets', 42, ?, 'review', 'prepared', '{}', 'pending', 1000, 1000)`,
      )
      .run("0".repeat(40));
    expect(() =>
      db.raw.prepare("UPDATE review_publications SET phase = 'bogus' WHERE id = 'pub-1'").run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.raw.prepare("UPDATE review_publications SET kind = 'comment' WHERE id = 'pub-1'").run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.raw.prepare("UPDATE review_publications SET recovery_state = 'later' WHERE id = 'pub-1'").run(),
    ).toThrow(/CHECK constraint failed/);

    db.raw
      .prepare(
        `INSERT INTO review_findings (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
           first_publication_id, last_publication_id, first_seen_sha, last_seen_sha, first_seen_round, last_seen_round,
           state, created_ms, updated_ms)
         VALUES ('row-1', 'app-1', 123, 'acme', 'widgets', 42, 'f-1', '{}', 'pub-1', 'pub-1', ?, ?, 1, 1, 'open', 1000, 1000)`,
      )
      .run("0".repeat(40), "0".repeat(40));
    expect(() =>
      db.raw.prepare("UPDATE review_findings SET state = 'closed' WHERE id = 'row-1'").run(),
    ).toThrow(/CHECK constraint failed/);

    db.raw
      .prepare(
        `INSERT INTO review_threads (id, finding_row_id, publication_id, bot_id, installation_id, owner, repo, pr_number,
           original_sha, round, intent_json, resolution_state, created_ms, updated_ms)
         VALUES ('a-1', 'row-1', 'pub-1', 'app-1', 123, 'acme', 'widgets', 42, ?, 1, '{}', 'pending', 1000, 1000)`,
      )
      .run("0".repeat(40));
    expect(() =>
      db.raw.prepare("UPDATE review_threads SET resolution_state = 'maybe' WHERE id = 'a-1'").run(),
    ).toThrow(/CHECK constraint failed/);
  });

  test("FKs: unknown bots are refused; lifecycle rows require their publication/finding parents", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    // invariant: Publication with an unknown bot_id — FK refused.
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO review_publications (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json, created_ms, updated_ms)
           VALUES ('pub-x', 'no-such-app', 123, 'acme', 'widgets', 42, ?, 'review', 'prepared', '{}', 1000, 1000)`,
        )
        .run("0".repeat(40)),
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.raw
      .prepare(
        `INSERT INTO review_publications (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json, created_ms, updated_ms)
         VALUES ('pub-1', 'app-1', 123, 'acme', 'widgets', 42, ?, 'review', 'prepared', '{}', 1000, 1000)`,
      )
      .run("0".repeat(40));
    // invariant: A finding row needs its publication parents.
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO review_findings (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
             first_publication_id, last_publication_id, first_seen_sha, last_seen_sha, first_seen_round, last_seen_round,
             state, created_ms, updated_ms)
           VALUES ('row-1', 'app-1', 123, 'acme', 'widgets', 42, 'f-1', '{}', 'pub-missing', 'pub-1', ?, ?, 1, 1, 'open', 1000, 1000)`,
        )
        .run("0".repeat(40), "0".repeat(40)),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("creates idx_publication_scope on review_publications(scope…,kind,phase) and the journal probe uses it (P67-QC-019)", () => {
    const db = createMigratedTestD1();
    const index = db.raw
      .query("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_publication_scope'")
      .get() as { tbl_name: string } | null;
    expect(index).not.toBeNull();
    expect(index!.tbl_name).toBe("review_publications");
    // note: The §7.0 scope prefix leads, then the probe's discriminating equalities
    // — so the per-message lookup seeks instead of scanning every retained
    // row of the scope.
    const columns = db.raw.query("PRAGMA index_info(idx_publication_scope)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual([
      "bot_id", "installation_id", "owner", "repo", "pr_number", "kind", "phase",
    ]);

    // why: The degraded-journal probe (`hasUnprovenDegradedPublication`) is what
    // the index exists for: without it the planner falls back to the
    // scope-only UNIQUE autoindex and discards the whole non-degraded and
    // terminal remainder of the scope.
    const plan = db.raw
      .query(
        `EXPLAIN QUERY PLAN SELECT id FROM review_publications
         WHERE bot_id = 'app-1' AND installation_id = 123 AND owner = 'acme' AND repo = 'widgets' AND pr_number = 42
           AND kind = 'degraded' AND proof_json IS NULL AND phase IN ('prepared','sending','unknown')
         LIMIT 1`,
      )
      .all() as Array<{ detail: string }>;
    expect(plan.some((p) => p.detail.includes("USING INDEX idx_publication_scope"))).toBe(true);
  });

  test("the rotation query binds the scope prefix through idx_finding_rotation (recorded plan)", () => {
    // note: The §7.2 ORDER BY is an expression (COALESCE) → SQLite temp-sorts;
    // planner choice for expression-ordered queries is NOT asserted
    // (AL-21-2 convention) — the plan is recorded and the index existence +
    // column order is asserted above.
    const db = createMigratedTestD1();
    const plan = db.raw
      .query(
        `EXPLAIN QUERY PLAN SELECT id FROM review_findings
         WHERE bot_id = 'app-1' AND installation_id = 123 AND owner = 'acme' AND repo = 'widgets' AND pr_number = 42 AND state = 'open'
         ORDER BY COALESCE(last_scheduled_ms, created_ms), id LIMIT 25`,
      )
      .all() as Array<{ detail: string }>;
    console.log("EXPLAIN QUERY PLAN (lifecycle rotation query):");
    for (const p of plan) console.log(`  ${p.detail}`);
    expect(plan.length).toBeGreaterThan(0);
  });
});

describe("migrations/0002_mstar_review_v1.sql", () => {
  test("adds the envelope column to reviews (TEXT, nullable)", async () => {
    const db = createTestD1();
    // note: The M1-era insert path (no envelope) is unchanged by the ALTER, and a
    // fresh row defaults to envelope NULL.
    await insertReview(db);
    const row = db.raw.query("SELECT envelope FROM reviews").get() as { envelope: string | null };
    expect(row.envelope).toBeNull();
  });

  test("CHECK json_valid rejects a non-JSON envelope, NULL stays allowed (M1 rows)", async () => {
    const db = createTestD1();
    await insertReview(db);
    await expect(
      db.prepare("UPDATE reviews SET envelope = 'not json' WHERE id = ?").bind(REVIEW.id).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    // invariant: NULL envelope is legal — every M1-era row keeps envelope NULL.
    await db.prepare("UPDATE reviews SET envelope = NULL WHERE id = ?").bind(REVIEW.id).run();
    const row = db.raw.query("SELECT envelope FROM reviews").get() as { envelope: string | null };
    expect(row.envelope).toBeNull();
  });

  test("accepts a valid JSON envelope (era marker for v1 rows)", async () => {
    const db = createTestD1();
    await insertReview(db);
    await db
      .prepare("UPDATE reviews SET envelope = ? WHERE id = ?")
      .bind('{"schema":"mstar.review/v1"}', REVIEW.id)
      .run();
    const row = db.raw.query("SELECT envelope FROM reviews").get() as { envelope: string };
    expect(JSON.parse(row.envelope)).toEqual({ schema: "mstar.review/v1" });
  });
});
describe("migrations/0013_findings_review_id_index.sql", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0010 with live rows)", () => {
    const db = createTestD1();
    insertReview(db); // note: a live review AND finding predate the CREATE INDEX
    db.raw
      .prepare(
        `INSERT INTO findings (id, review_id, severity, category, title)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("finding-1", REVIEW.id, "warning", "logic", "Null deref risk");
    for (const name of [
      "0003_dashboard_users.sql",
      "0004_github_apps.sql",
      "0005_reviews_app_id.sql",
      "0006_app_provider_config.sql",
      "0007_reviews_app_id_index.sql",
      "0008_github_apps_ops.sql",
      "0009_app_model_roles.sql",
      "0010_review_failures.sql",
    ]) {
      applyMigrationFile(db, name);
    }

    // why: Metadata-only CREATE INDEX builds over the live rows without rewriting.
    expect(() => applyMigrationFile(db, "0013_findings_review_id_index.sql")).not.toThrow();
    const reviewCount = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviewCount.n).toBe(1);
    const findingCount = db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number };
    expect(findingCount.n).toBe(1);
  });

  test("creates idx_findings_review_id ON findings(review_id) (fully migrated schema)", () => {
    const db = createMigratedTestD1();
    const index = db.raw
      .query("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_findings_review_id'")
      .get() as { tbl_name: string } | null;
    expect(index).not.toBeNull();
    expect(index!.tbl_name).toBe("findings");
    const columns = db.raw.query("PRAGMA index_info(idx_findings_review_id)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual(["review_id"]);
  });

  test("the findings-by-review hot path uses the index (EXPLAIN QUERY PLAN)", () => {
    // note: Mirrors the 0007 index assertion: on the fully migrated (empty) schema
    // the equality probe binds to the index — same planner determinism the
    // 0007 test relies on. AL-21-2's planner-brittleness caveat applies to
    // the GROUP-BY recurrence query, not this single-column probe.
    const db = createMigratedTestD1();
    const plan = db.raw
      .query("EXPLAIN QUERY PLAN SELECT fingerprint FROM findings WHERE review_id = 'review-1'")
      .all() as Array<{ detail: string }>;
    expect(plan.some((p) => p.detail.includes("USING INDEX idx_findings_review_id"))).toBe(true);
  });
});
describe("migrations/0014_idx_reviews_reviewed_at.sql", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0013 with live rows)", () => {
    const db = createTestD1();
    insertReview(db); // note: a live review predates the CREATE INDEX
    for (const name of [
      "0003_dashboard_users.sql",
      "0004_github_apps.sql",
      "0005_reviews_app_id.sql",
      "0006_app_provider_config.sql",
      "0007_reviews_app_id_index.sql",
      "0008_github_apps_ops.sql",
      "0009_app_model_roles.sql",
      "0010_review_failures.sql",
      "0013_findings_review_id_index.sql",
    ]) {
      applyMigrationFile(db, name);
    }

    // why: Metadata-only CREATE INDEX builds over the live rows without rewriting.
    expect(() => applyMigrationFile(db, "0014_idx_reviews_reviewed_at.sql")).not.toThrow();
    const reviewCount = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviewCount.n).toBe(1);
  });

  test("creates idx_reviews_reviewed_at ON reviews(reviewed_at) (fully migrated schema)", () => {
    const db = createMigratedTestD1();
    const index = db.raw
      .query("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_reviews_reviewed_at'")
      .get() as { tbl_name: string } | null;
    expect(index).not.toBeNull();
    expect(index!.tbl_name).toBe("reviews");
    const columns = db.raw.query("PRAGMA index_info(idx_reviews_reviewed_at)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual(["reviewed_at"]);
  });

  test("the insights window predicate seeks the index (EXPLAIN QUERY PLAN)", () => {
    // why: The window predicate `reviewed_at >= datetime('now', …)` is a
    // range probe — with 0014 the planner seeks the window slice instead of
    // full-scanning reviews. Recorded for the record (plan convention);
    // planner choice is a runtime fact (AL-21-2 caveat applies to GROUP-BY
    // plans, not this single-column range seek).
    const db = createMigratedTestD1();
    const plan = db.raw
      .query(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) AS total FROM reviews r WHERE r.reviewed_at >= datetime('now', '-' || ? || ' days')",
      )
      .all(30) as Array<{ detail: string }>;
    console.log("EXPLAIN QUERY PLAN (insights window predicate):");
    for (const p of plan) console.log(`  ${p.detail}`);
    expect(plan.some((p) => p.detail.includes("idx_reviews_reviewed_at"))).toBe(true);
  });
});

describe("migrations/0016_users_login_nocase_unique.sql (QC W-1)", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  test("applies cleanly over a seeded production-shaped DB (0003 users with live rows)", () => {
    const db = createTestD1();
    applyMigrationFile(db, "0003_dashboard_users.sql");
    db.raw
      .prepare("INSERT INTO users (id, github_login, role, created_at) VALUES (?, ?, ?, ?)")
      .run("u-1", "OctoCat", "admin", "2026-01-01T00:00:00.000Z");
    // why: Metadata-only CREATE UNIQUE INDEX builds over the live rows without
    // rewriting — the append-only 0003+ convention.
    expect(() => applyMigrationFile(db, "0016_users_login_nocase_unique.sql")).not.toThrow();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("NOCASE unique index rejects a case-variant second row (W-1)", () => {
    const db = createTestD1();
    applyMigrationFile(db, "0003_dashboard_users.sql");
    applyMigrationFile(db, "0016_users_login_nocase_unique.sql");
    db.raw
      .prepare("INSERT INTO users (id, github_login, role, created_at) VALUES (?, ?, ?, ?)")
      .run("u-1", "OctoCat", "admin", "2026-01-01T00:00:00.000Z");
    // note: The 0003 BINARY UNIQUE does not fire across case variants — the 0016
    // NOCASE index is what makes the second row impossible.
    expect(() =>
      db.raw
        .prepare("INSERT INTO users (id, github_login, role, created_at) VALUES (?, ?, ?, ?)")
        .run("u-2", "octocat", "member", "2026-01-01T00:00:00.000Z"),
    ).toThrow(/UNIQUE constraint failed/);
  });

  test("exact-case duplicates are still rejected by the 0003 BINARY unique (index coexistence)", () => {
    const db = createTestD1();
    applyMigrationFile(db, "0003_dashboard_users.sql");
    applyMigrationFile(db, "0016_users_login_nocase_unique.sql");
    db.raw
      .prepare("INSERT INTO users (id, github_login, role, created_at) VALUES (?, ?, ?, ?)")
      .run("u-1", "octocat", "admin", "2026-01-01T00:00:00.000Z");
    expect(() =>
      db.raw
        .prepare("INSERT INTO users (id, github_login, role, created_at) VALUES (?, ?, ?, ?)")
        .run("u-2", "octocat", "member", "2026-01-01T00:00:00.000Z"),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe("migrations/0017_app_model_chains.sql (spec §4.4)", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** note: Raw-insert one github_apps row (the 0004 column list is sufficient). */
  function insertApp(db: TestD1, id: string, githubAppId = 1001): void {
    insertGithubAppRow(db, { id, githubAppId });
  }

  /** note: The pre-chains shape (0001–0016) with live app_model_config / app_model_roles rows. */
  function createPreChainsDb(): TestD1 {
    const db = createTestD1();
    for (const name of [
      "0003_dashboard_users.sql",
      "0004_github_apps.sql",
      "0005_reviews_app_id.sql",
      "0006_app_provider_config.sql",
      "0007_reviews_app_id_index.sql",
      "0008_github_apps_ops.sql",
      "0009_app_model_roles.sql",
      "0010_review_failures.sql",
      "0011_webhook_deliveries.sql",
      "0012_custom_providers_and_key_updated_at.sql",
      "0013_findings_review_id_index.sql",
      "0014_idx_reviews_reviewed_at.sql",
      "0015_provider_verification.sql",
      "0016_users_login_nocase_unique.sql",
    ]) {
      applyMigrationFile(db, name);
    }
    return db;
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0016 with live rows)", () => {
    const db = createPreChainsDb();
    insertApp(db, "app-1");
    db.raw
      .prepare(`INSERT INTO app_model_config (app_id, model_chain, updated_at) VALUES ('app-1', 'ark/deepseek-v4-flash', datetime('now'))`)
      .run();
    db.raw
      .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES ('app-1', 'code-reviewer', 'openai/gpt-5')`)
      .run();
    // why: Append-only CREATE TABLE + backfill DML over the live rows — nothing
    // existing changes (the first INSERT…SELECT in the migration set).
    expect(() => applyMigrationFile(db, "0017_app_model_chains.sql")).not.toThrow();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("backfill: app_model_config non-NULL chain → the 'default' row (is_default=1); NULL/absent → no default row", () => {
    const db = createPreChainsDb();
    insertApp(db, "app-1");
    insertApp(db, "app-2", 1002);
    // note: app-1 has a chain; app-2 has a NULL chain row; app-3 has no row at all.
    db.raw
      .prepare(`INSERT INTO app_model_config (app_id, model_chain, updated_at) VALUES ('app-1', 'ark/deepseek-v4-flash, openai/gpt-5:thinking', datetime('now'))`)
      .run();
    db.raw
      .prepare(`INSERT INTO app_model_config (app_id, model_chain, updated_at) VALUES ('app-2', NULL, datetime('now'))`)
      .run();
    applyMigrationFile(db, "0017_app_model_chains.sql");
    const rows = db.raw
      .query("SELECT app_id, name, chain, is_default FROM app_model_chains ORDER BY app_id")
      .all() as Array<{ app_id: string; name: string; chain: string; is_default: number }>;
    // invariant: Exactly one default row, holding the verbatim chain (byte-identical).
    expect(rows).toEqual([
      { app_id: "app-1", name: "default", chain: "ark/deepseek-v4-flash, openai/gpt-5:thinking", is_default: 1 },
    ]);
  });

  test("backfill: every app_model_roles row → one 'seat-<role>' named chain + the seat reference row", () => {
    const db = createPreChainsDb();
    insertApp(db, "app-1");
    db.raw
      .prepare(`INSERT INTO app_model_config (app_id, model_chain, updated_at) VALUES ('app-1', 'ark/deepseek-v4-flash', datetime('now'))`)
      .run();
    db.raw
      .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES ('app-1', 'mstar-review-seat', 'ark/deepseek-v4-flash:high')`)
      .run();
    db.raw
      .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES ('app-1', 'code-reviewer', 'openai/gpt-5:thinking, anthropic/claude-x')`)
      .run();
    applyMigrationFile(db, "0017_app_model_chains.sql");
    const chains = db.raw
      .query("SELECT name, chain, is_default FROM app_model_chains WHERE app_id = 'app-1' ORDER BY name")
      .all() as Array<{ name: string; chain: string; is_default: number }>;
    expect(chains).toEqual([
      { name: "default", chain: "ark/deepseek-v4-flash", is_default: 1 },
      { name: "seat-code-reviewer", chain: "openai/gpt-5:thinking, anthropic/claude-x", is_default: 0 },
      { name: "seat-mstar-review-seat", chain: "ark/deepseek-v4-flash:high", is_default: 0 },
    ]);
    const seats = db.raw
      .query("SELECT role, chain_name FROM app_model_chain_seats WHERE app_id = 'app-1' ORDER BY role")
      .all() as Array<{ role: string; chain_name: string }>;
    expect(seats).toEqual([
      { role: "code-reviewer", chain_name: "seat-code-reviewer" },
      { role: "mstar-review-seat", chain_name: "seat-mstar-review-seat" },
    ]);
  });

  test("bot_model_chains: composite PK (bot_id, name) rejects a duplicate pair; other bots may repeat the name", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    insertApp(db, "app-2", 1002);
    db.raw
      .prepare(`INSERT INTO bot_model_chains (bot_id, name, chain, is_default, created_at, updated_at) VALUES ('app-1', 'fast', 'openai/gpt-5', 0, datetime('now'), datetime('now'))`)
      .run();
    expect(() =>
      db.raw
        .prepare(`INSERT INTO bot_model_chains (bot_id, name, chain, is_default, created_at, updated_at) VALUES ('app-1', 'fast', 'x/y', 0, datetime('now'), datetime('now'))`)
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    // invariant: The same name under ANOTHER bot is a distinct row (per-bot chains).
    db.raw
      .prepare(`INSERT INTO bot_model_chains (bot_id, name, chain, is_default, created_at, updated_at) VALUES ('app-2', 'fast', 'x/y', 0, datetime('now'), datetime('now'))`)
      .run();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM bot_model_chains").get() as { n: number };
    expect(count.n).toBe(2);
  });

  test("bot_model_chain_seats: composite PK (bot_id, role) rejects a duplicate pair; FK to review_bots enforced", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    db.raw
      .prepare(`INSERT INTO bot_model_chains (bot_id, name, chain, is_default, created_at, updated_at) VALUES ('app-1', 'fast', 'openai/gpt-5', 0, datetime('now'), datetime('now'))`)
      .run();
    db.raw
      .prepare(`INSERT INTO bot_model_chain_seats (bot_id, role, chain_name) VALUES ('app-1', 'code-reviewer', 'fast')`)
      .run();
    expect(() =>
      db.raw
        .prepare(`INSERT INTO bot_model_chain_seats (bot_id, role, chain_name) VALUES ('app-1', 'code-reviewer', 'fast')`)
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      db.raw
        .prepare(`INSERT INTO bot_model_chain_seats (bot_id, role, chain_name) VALUES ('no-such-app', 'code-reviewer', 'fast')`)
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("no ON DELETE: hard-deleting a bot with chain rows is refused (soft-delete is the only removal path)", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    db.raw
      .prepare(`INSERT INTO bot_model_chains (bot_id, name, chain, is_default, created_at, updated_at) VALUES ('app-1', 'default', 'openai/gpt-5', 1, datetime('now'), datetime('now'))`)
      .run();
    db.raw
      .prepare(`INSERT INTO bot_model_chain_seats (bot_id, role, chain_name) VALUES ('app-1', 'code-reviewer', 'default')`)
      .run();
    expect(() => db.raw.prepare("DELETE FROM review_bots WHERE id = 'app-1'").run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe("migrations/0018_app_sandbox_images.sql (spec § Runtime-image contract)", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** note: Raw-insert one github_apps row (the 0004 column list is sufficient). */
  function insertApp(db: TestD1, id: string, opts: { githubAppId?: number; deleted?: boolean } = {}): void {
    insertGithubAppRow(db, {
      id,
      githubAppId: opts.githubAppId,
      deletedExpr: opts.deleted ? "datetime('now', '-1 hour')" : undefined,
    });
  }

  /** note: The pre-0018 shape (0001–0017, filename order) — what production runs today. */
  function createPre0018Db(): TestD1 {
    const db = createTestD1();
    for (const name of [
      "0003_dashboard_users.sql",
      "0004_github_apps.sql",
      "0005_reviews_app_id.sql",
      "0006_app_provider_config.sql",
      "0007_reviews_app_id_index.sql",
      "0008_github_apps_ops.sql",
      "0009_app_model_roles.sql",
      "0010_review_failures.sql",
      "0011_webhook_deliveries.sql",
      "0012_custom_providers_and_key_updated_at.sql",
      "0013_findings_review_id_index.sql",
      "0014_idx_reviews_reviewed_at.sql",
      "0015_provider_verification.sql",
      "0016_users_login_nocase_unique.sql",
      "0017_app_model_chains.sql",
    ]) {
      applyMigrationFile(db, name);
    }
    return db;
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0017 with live rows, incl. a soft-deleted app)", () => {
    const db = createPre0018Db();
    insertReview(db); // note: a live review predates the ALTER (wrangler order)
    insertApp(db, "app-1");
    insertApp(db, "app-gone", { githubAppId: 1002, deleted: true }); // note: soft-deleted rows backfill too
    // why: Metadata-only ADD COLUMN alters the table without rewriting it (the
    // 0008 precedent) — every live row survives untouched.
    expect(() => applyMigrationFile(db, "0018_app_sandbox_images.sql")).not.toThrow();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM github_apps").get() as { n: number };
    expect(count.n).toBe(2);
  });

  test("adds sandbox_image_id TEXT NOT NULL DEFAULT 'omp' to the parent row (the 0008 ADD COLUMN pattern)", () => {
    const db = createMigratedTestD1();
    const columns = db.raw.query("PRAGMA table_info(review_bots)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const col = columns.find((c) => c.name === "sandbox_image_id");
    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(1); // note: NOT NULL is legal with a non-NULL DEFAULT (0008 precedent)
    expect(col!.dflt_value).toBe("'omp'");
  });

  test("backfill: every existing row — live AND soft-deleted — materializes to 'omp' without a manager visit", () => {
    const db = createPre0018Db();
    insertApp(db, "app-1");
    insertApp(db, "app-gone", { githubAppId: 1002, deleted: true });
    applyMigrationFile(db, "0018_app_sandbox_images.sql");
    const rows = db.raw
      .query("SELECT id, sandbox_image_id, deleted_at FROM github_apps ORDER BY id")
      .all() as Array<{ id: string; sandbox_image_id: string; deleted_at: string | null }>;
    expect(rows).toEqual([
      { id: "app-1", sandbox_image_id: "omp", deleted_at: null },
      { id: "app-gone", sandbox_image_id: "omp", deleted_at: expect.any(String) },
    ]);
  });

  test("a row inserted without the column defaults to 'omp'; an explicit NULL is refused (NOT NULL)", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    const row = db.raw
      .query("SELECT sandbox_image_id FROM review_bots WHERE id = 'app-1'")
      .get() as { sandbox_image_id: string };
    expect(row.sandbox_image_id).toBe("omp");
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO review_bots (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, status, sandbox_image_id, created_at, updated_at)
           VALUES ('app-null', 1002, 'app-null', 'enc', 'enc', 'mallory', 'active', NULL, datetime('now'), datetime('now'))`,
        )
        .run(),
    ).toThrow(/NOT NULL constraint failed/);
    expect(() =>
      db.raw.prepare("UPDATE review_bots SET sandbox_image_id = NULL WHERE id = 'app-1'").run(),
    ).toThrow(/NOT NULL constraint failed/);
  });

  test("no CHECK: the value domain is store-enforced — a non-registry string stores at the schema level (0009 precedent)", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    db.raw.prepare("UPDATE review_bots SET sandbox_image_id = 'not-a-registry-id' WHERE id = 'app-1'").run();
    const row = db.raw
      .query("SELECT sandbox_image_id FROM review_bots WHERE id = 'app-1'")
      .get() as { sandbox_image_id: string };
    expect(row.sandbox_image_id).toBe("not-a-registry-id");
  });
});

describe("migrations/0019_github_apps_metadata.sql (AD-531)", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** note: Raw-insert one github_apps row (the 0004 column list is sufficient). */
  function insertApp(db: TestD1, id: string, opts: { githubAppId?: number; deleted?: boolean } = {}): void {
    insertGithubAppRow(db, {
      id,
      githubAppId: opts.githubAppId,
      deletedExpr: opts.deleted ? "datetime('now', '-1 hour')" : undefined,
    });
  }

  /** note: The pre-0019 shape (0001–0018, filename order) — what production runs today. */
  function createPre0019Db(): TestD1 {
    const db = createTestD1();
    for (const name of [
      "0003_dashboard_users.sql",
      "0004_github_apps.sql",
      "0005_reviews_app_id.sql",
      "0006_app_provider_config.sql",
      "0007_reviews_app_id_index.sql",
      "0008_github_apps_ops.sql",
      "0009_app_model_roles.sql",
      "0010_review_failures.sql",
      "0011_webhook_deliveries.sql",
      "0012_custom_providers_and_key_updated_at.sql",
      "0013_findings_review_id_index.sql",
      "0014_idx_reviews_reviewed_at.sql",
      "0015_provider_verification.sql",
      "0016_users_login_nocase_unique.sql",
      "0017_app_model_chains.sql",
      "0018_app_sandbox_images.sql",
    ]) {
      applyMigrationFile(db, name);
    }
    return db;
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0018 with live rows, incl. a soft-deleted app)", () => {
    const db = createPre0019Db();
    insertReview(db); // note: a live review predates the ALTER (wrangler order)
    insertApp(db, "app-1");
    insertApp(db, "app-gone", { githubAppId: 1002, deleted: true }); // note: soft-deleted rows backfill too
    // why: Metadata-only ADD COLUMNs alter the table without rewriting it (the
    // 0008 precedent) — every live row survives untouched, and old rows
    // read as "never synced" (all five columns NULL).
    expect(() => applyMigrationFile(db, "0019_github_apps_metadata.sql")).not.toThrow();
    const rows = db.raw
      .query("SELECT id, github_name, github_metadata_synced_at FROM github_apps ORDER BY id")
      .all() as Array<{ id: string; github_name: string | null; github_metadata_synced_at: string | null }>;
    expect(rows).toEqual([
      { id: "app-1", github_name: null, github_metadata_synced_at: null },
      { id: "app-gone", github_name: null, github_metadata_synced_at: null },
    ]);
  });

  test("adds the five profile columns as TEXT, nullable, no default (the 0008 last_webhook_at form)", () => {
    const db = createMigratedTestD1();
    const columns = db.raw.query("PRAGMA table_info(review_bots)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    for (const name of [
      "github_name",
      "github_description",
      "github_html_url",
      "github_avatar_url",
      "github_metadata_synced_at",
    ]) {
      const col = columns.find((c) => c.name === name);
      expect(col).toBeDefined();
      expect(col!.type).toBe("TEXT");
      expect(col!.notnull).toBe(0);
      expect(col!.dflt_value).toBeNull();
    }
  });

  test("the profile columns are writable and read back (the synced_at TEXT datetime convention)", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    db.raw
      .prepare(
        `UPDATE review_bots
         SET github_name = 'Acme Inspector', github_description = 'Reviews PRs',
             github_html_url = 'https://github.com/apps/acme-inspector',
             github_avatar_url = 'https://avatars.githubusercontent.com/u/1?v=4',
             github_metadata_synced_at = datetime('now')
         WHERE id = 'app-1'`,
      )
      .run();
    const row = db.raw
      .query("SELECT github_name, github_description, github_html_url, github_avatar_url, github_metadata_synced_at FROM review_bots WHERE id = 'app-1'")
      .get() as {
      github_name: string;
      github_description: string;
      github_html_url: string;
      github_avatar_url: string;
      github_metadata_synced_at: string;
    };
    expect(row.github_name).toBe("Acme Inspector");
    expect(row.github_description).toBe("Reviews PRs");
    expect(row.github_html_url).toBe("https://github.com/apps/acme-inspector");
    expect(row.github_avatar_url).toBe("https://avatars.githubusercontent.com/u/1?v=4");
    expect(row.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("migrations/0034_support_grant_indexes.sql (I-000167)", () => {
  /** note: The exact grant SQL of each lookup below, copied from its owner module. */
  const NEWEST = `g.rowid = (
            SELECT MAX(x.rowid) FROM support_grants x
             WHERE x.workspace_id = g.workspace_id
               AND x.operator_login = g.operator_login
          )`;
  const GRANT_COLUMNS = `id, workspace_id, operator_login, reason, granted_by, created_at, expires_at`;

  /** note: `EXPLAIN QUERY PLAN` detail lines, in the planner's order. */
  function plan(db: TestD1, sql: string): string[] {
    return (db.raw.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((p) => p.detail);
  }

  function indexColumns(db: TestD1, index: string): string[] {
    return (db.raw.query(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map((c) => c.name);
  }

  test("creates both grant indexes with the expected columns", () => {
    const db = createMigratedTestD1();
    expect(indexColumns(db, "support_grants_operator_window")).toEqual([
      "operator_login",
      "expires_at",
      "workspace_id",
    ]);
    expect(indexColumns(db, "support_grants_expires_at")).toEqual(["expires_at"]);
  });

  test("the operator_login-only grant count seeks the new operator window index", () => {
    const db = createMigratedTestD1();
    // note: `admin/users.ts` LIST_USERS_SQL: a login-keyed, expiry-bounded count that
    // has no workspace equality to lead `support_grants_lookup` with.
    expect(
      plan(
        db,
        `SELECT COUNT(*) FROM support_grants g
          WHERE g.operator_login = ? AND g.expires_at > ? AND ${NEWEST}`,
      ),
    ).toContain("SEARCH g USING COVERING INDEX support_grants_operator_window (operator_login=? AND expires_at>?)");
  });

  test("the all-workspaces grant list seeks the new expiry index", () => {
    const db = createMigratedTestD1();
    // note: `listAllActiveSupportGrants`: `expires_at` alone, so neither the lookup
    // index nor the operator window can bound it.
    const lines = plan(
      db,
      `SELECT ${GRANT_COLUMNS} FROM support_grants g
        WHERE g.expires_at > ? AND ${NEWEST}
        ORDER BY expires_at DESC, id ASC`,
    );
    expect(lines[0]).toBe("SEARCH g USING INDEX support_grants_expires_at (expires_at>?)");
  });

  test("the workspace-keyed grant lookups keep their 0029 index", () => {
    const db = createMigratedTestD1();
    expect(
      plan(
        db,
        `SELECT expires_at > ? AS live FROM support_grants
          WHERE workspace_id = ? AND operator_login = ?
          ORDER BY rowid DESC LIMIT 1`,
      ),
    ).toContain("SEARCH support_grants USING COVERING INDEX support_grants_lookup (workspace_id=? AND operator_login=?)");

    expect(
      plan(
        db,
        `SELECT ${GRANT_COLUMNS} FROM support_grants g
          WHERE g.workspace_id = ? AND g.expires_at > ? AND ${NEWEST}
          ORDER BY expires_at DESC, id ASC`,
      ),
    ).toContain("SEARCH g USING INDEX support_grants_lookup (workspace_id=?)");

    // note: The `NEWEST_GRANT_APPEND` correlation both reads above depend on.
    expect(
      plan(db, "SELECT MAX(x.rowid) FROM support_grants x WHERE x.workspace_id = ? AND x.operator_login = ?"),
    ).toContain("SEARCH x USING COVERING INDEX support_grants_lookup (workspace_id=? AND operator_login=?)");
  });
});

describe("migrations/0035_workspace_invite_expiry_index.sql (I-000096)", () => {
  /** note: The sweep's candidate SQL, copied from `expireLapsedInvites`'s subquery. */
  const CANDIDATES = `SELECT id FROM workspace_invites
     WHERE status = 'pending' AND expires_at <= ?
     ORDER BY expires_at, id LIMIT ?`;

  /** note: `EXPLAIN QUERY PLAN` detail lines, in the planner's order. */
  function plan(db: TestD1, sql: string): string[] {
    return (db.raw.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((p) => p.detail);
  }

  function indexColumns(db: TestD1, index: string): string[] {
    return (db.raw.query(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map((c) => c.name);
  }

  test("indexes the pending set by the candidate order (expires_at, id)", () => {
    const db = createMigratedTestD1();
    expect(indexColumns(db, "workspace_invites_expiry")).toEqual(["expires_at", "id"]);
    // note: Partial, like both 0028 indexes: only the live pending set is indexed.
    const row = db.raw
      .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'workspace_invites_expiry'")
      .get() as { sql: string };
    expect(row.sql).toContain("WHERE status = 'pending'");
  });

  test("the lapsed-candidate subquery seeks it with no sort over the pending set", () => {
    const db = createMigratedTestD1();
    const lines = plan(db, CANDIDATES);
    expect(lines[0]).toBe("SEARCH workspace_invites USING COVERING INDEX workspace_invites_expiry (expires_at<?)");
    // why: The trailing `id` index column is what keeps the ORDER BY out of a temp
    // B-tree — a `(expires_at)`-only index would sort every candidate row.
    expect(lines.join("\n")).not.toContain("TEMP B-TREE");
  });

  test("the update's own id lookup stays on the primary key", () => {
    const db = createMigratedTestD1();
    const lines = plan(db, `UPDATE workspace_invites SET status = 'expired' WHERE id IN (${CANDIDATES})`);
    expect(lines).toContain("SEARCH workspace_invites USING COVERING INDEX sqlite_autoindex_workspace_invites_1 (id=?)");
    expect(lines).toContain("SEARCH workspace_invites USING COVERING INDEX workspace_invites_expiry (expires_at<?)");
  });
});

describe("migrations/0036_app_identity.sql", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** note: The pre-0036 shape: the 0001–0035 chain, i.e. what production runs today. */
  function createPre0036Db(): TestD1 {
    // why: createTestD1 already applied the 0001/0002 base shape, so the chain here
    // starts at 0003 and stops before the migration under test.
    const db = createTestD1();
    const names = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql") && name >= "0003" && name < "0036")
      .sort();
    for (const name of names) applyMigrationFile(db, name);
    return db;
  }

  /** note: One live row, seeded by whichever shape this fixture carries. */
  function insertApp(db: TestD1, id: string, path: string, githubAppId: number): void {
    insertGithubAppRow(db, { id, name: path, githubAppId });
  }

  test("renames slug to webhook_path and keeps every stored value (live webhook URLs stay valid)", () => {
    const db = createPre0036Db();
    insertApp(db, "app-1", "acmes-app", 1001);
    insertApp(db, "app-2", "widgets-app", 1002);

    expect(() => applyMigrationFile(db, "0036_app_identity.sql")).not.toThrow();

    // invariant: The values are the point: a rename that dropped or rewrote them would
    // break every webhook URL GitHub already has registered.
    const rows = db.raw
      .query("SELECT id, webhook_path FROM github_apps ORDER BY id")
      .all() as Array<{ id: string; webhook_path: string }>;
    expect(rows).toEqual([
      { id: "app-1", webhook_path: "app-1" },
      { id: "app-2", webhook_path: "app-2" },
    ]);
    const columns = db.raw.query("PRAGMA table_info(github_apps)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).not.toContain("slug");
  });

  test("the rename carries NOT NULL and UNIQUE onto webhook_path (no table rebuild)", () => {
    const db = createPre0036Db();
    applyMigrationFile(db, "0036_app_identity.sql");
    const cols = db.raw.query("PRAGMA table_info(github_apps)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(cols.find((c) => c.name === "webhook_path")!.notnull).toBe(1);
    // invariant: Two rows may not share a route key (the constraint moved with the
    // rename, so it is still enforced on the new name).
    const insertWithPath = (id: string, githubAppId: number): void => {
      db.raw
        .prepare(
          `INSERT INTO github_apps (id, webhook_path, github_app_id, name, private_key_enc, webhook_secret_enc,
             created_by, status, deleted_at, created_at, updated_at)
           VALUES (?, 'taken', ?, 'taken', 'enc', 'enc', 'mallory', 'active', NULL, datetime('now'), datetime('now'))`,
        )
        .run(id, githubAppId);
    };
    insertWithPath("app-1", 2001);
    expect(() => insertWithPath("app-2", 2002)).toThrow(
      /UNIQUE constraint failed: github_apps.webhook_path/,
    );
  });

  test("github_slug is a nullable TEXT cache with no unique index", () => {
    const db = createMigratedTestD1();
    const cols = db.raw.query("PRAGMA table_info(review_bots)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const col = cols.find((c) => c.name === "github_slug");
    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
    // why: Deliberately unindexed: the column caches a mutable upstream fact, so no
    // index — unique or otherwise — may gate another App's write on it.
    expect(db.raw.query("PRAGMA index_info(review_bots_github_slug)").all()).toEqual([]);
  });

  test("several rows may hold a NULL github_slug (never synced) and two rows may share one slug (the cache is not an identity)", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1", "one", 3001);
    insertApp(db, "app-2", "two", 3002);
    // note: Both legacy rows migrated as "never synced" and must coexist.
    const nulls = db.raw.query("SELECT COUNT(*) AS n FROM review_bots WHERE github_slug IS NULL").get() as { n: number };
    expect(nulls.n).toBe(2);

    db.raw.prepare("UPDATE review_bots SET github_slug = 'acme-inspector' WHERE id = 'app-1'").run();
    // why: GitHub frees and reuses a slug, so a stale cached copy plus a live one is
    // a legitimate state, not a conflict. Identity is `github_app_id`.
    expect(() =>
      db.raw.prepare("UPDATE review_bots SET github_slug = 'acme-inspector' WHERE id = 'app-2'").run(),
    ).not.toThrow();
    const shared = db.raw.query("SELECT COUNT(*) AS n FROM review_bots WHERE github_slug = 'acme-inspector'").get() as { n: number };
    expect(shared.n).toBe(2);
  });
});

describe("migrations/0037_github_metadata_attempt.sql", () => {
  test("github_metadata_attempted_at is a nullable TEXT column with no default", () => {
    const db = createMigratedTestD1();
    const cols = db.raw.query("PRAGMA table_info(review_bots)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const col = cols.find((c) => c.name === "github_metadata_attempted_at");
    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
  });

  test("existing rows read NULL (never attempted) and the column round-trips the datetime TEXT form", () => {
    const db = createMigratedTestD1();
    insertGithubAppRow(db, { id: "app-1", name: "attempt-app", githubAppId: 4001 });
    // note: The ADD COLUMN is metadata-only: the live row survives and reads NULL,
    // which the read path treats as stale (one attempt after the deploy).
    const before = db.raw
      .query("SELECT github_metadata_attempted_at FROM review_bots WHERE id = 'app-1'")
      .get() as { github_metadata_attempted_at: string | null };
    expect(before.github_metadata_attempted_at).toBeNull();

    db.raw.prepare("UPDATE review_bots SET github_metadata_attempted_at = datetime('now') WHERE id = 'app-1'").run();
    const after = db.raw
      .query("SELECT github_metadata_attempted_at FROM review_bots WHERE id = 'app-1'")
      .get() as { github_metadata_attempted_at: string };
    expect(after.github_metadata_attempted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("migrations/0038_webhook_path_drop.sql (upgrade over live data)", () => {
  /** note: Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /**
   * why: One migration file as executable statements, comments stripped. The file
   * is executed statement by statement inside a caller-owned transaction so no
   * implicit commit can move a `PRAGMA` out of it — `exec(wholeFile)` is what
   * would make bun:sqlite commit early and turn the in-transaction
   * `PRAGMA foreign_keys = OFF` into a real switch.
   */
  function statementsOf(name: string): string[] {
    return readFileSync(join(MIGRATIONS_DIR, name), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
  }

  /** note: The pre-0038 shape: 0003 … 0037, i.e. what production runs today. */
  function createPre0038Db(): TestD1 {
    // why: createTestD1 already applied the 0001/0002 base shape, so the chain here
    // starts at 0003 and stops before the migration under test.
    const db = createTestD1();
    for (const name of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql") && name >= "0003" && name < "0038")
      .sort()) {
      applyMigrationFile(db, name);
    }
    return db;
  }

  /**
   * why: Two live Apps, each with its own workspace mapping, installation and
   * delivery — the child rows the rebuild must carry across its DROP TABLE.
   */
  function seedLiveData(db: TestD1): void {
    insertGithubAppRow(db, {
      id: "app-live-1",
      name: "Acme Reviewer",
      githubAppId: 1001,
      createdBy: "mallory",
    });
    insertGithubAppRow(db, {
      id: "app-live-2",
      name: "Widgets Reviewer",
      githubAppId: 1002,
      createdBy: "octocat",
      deletedExpr: "datetime('now')",
    });
    // safety: Distinguishable credentials per row: the copy must not swap them.
    db.raw
      .prepare("UPDATE github_apps SET private_key_enc = ?, webhook_secret_enc = ?, github_slug = ? WHERE id = ?")
      .run("v1.primary.cGVtLTE=", "v1.primary.c2VjcmV0LTE=", "acme-reviewer", "app-live-1");
    db.raw
      .prepare("UPDATE github_apps SET private_key_enc = ?, webhook_secret_enc = ?, github_slug = ? WHERE id = ?")
      .run("v1.primary.cGVtLTI=", "v1.primary.c2VjcmV0LTI=", "widgets-reviewer", "app-live-2");
    db.raw
      .prepare(
        `INSERT INTO app_workspaces (app_id, workspace_id) VALUES ('app-live-1', 'default')`,
      )
      .run();
    for (const [id, installationId] of [
      ["inst-1", 123],
      ["inst-2", 456],
    ] as const) {
      db.raw
        .prepare(
          `INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
           VALUES (?, ?, ?, 'acme', '2026-01-01 00:00:00')`,
        )
        .run(id, id === "inst-1" ? "app-live-1" : "app-live-2", installationId);
    }
    for (const [id, appId, outcome] of [
      ["delivery-1", "app-live-1", "ok"],
      ["delivery-2", "app-live-2", "rejected"],
    ] as const) {
      db.raw
        .prepare(
          `INSERT INTO webhook_deliveries (id, app_id, event_name, outcome, status_code, created_at)
           VALUES (?, ?, 'pull_request', ?, 401, '2026-01-02 00:00:00')`,
        )
        .run(id, appId, outcome);
    }
  }

  test("rebuilds the table with foreign keys ON inside one transaction: every row and child survives, the column is gone, UNIQUE holds", () => {
    const db = createPre0038Db();
    seedLiveData(db);
    const appsBefore = db.raw
      .query(
        `SELECT id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, status,
                deleted_at, review_enabled, sandbox_image_id, github_slug, review_trigger_mode
         FROM github_apps ORDER BY id`,
      )
      .all();
    expect(appsBefore).toHaveLength(2);
    const childrenBefore = {
      workspaces: db.raw.query("SELECT app_id, workspace_id FROM app_workspaces ORDER BY app_id").all(),
      installations: db.raw
        .query("SELECT id, app_id, installation_id, account_login, seen_at FROM app_installations ORDER BY id")
        .all(),
      deliveries: db.raw
        .query("SELECT id, app_id, event_name, outcome, status_code, created_at FROM webhook_deliveries ORDER BY id")
        .all(),
    };
    expect(childrenBefore.workspaces).toHaveLength(1);
    expect(childrenBefore.installations).toHaveLength(2);
    expect(childrenBefore.deliveries).toHaveLength(2);

    // why: D1 runs every migration file inside one implicit transaction with
    // foreign keys enforced. The statements run one by one inside a
    // caller-owned transaction so nothing can commit early: a whole-file
    // `exec` lets bun:sqlite commit, and the file's `PRAGMA foreign_keys = OFF`
    // would then really switch enforcement off — proving the plain-SQLite
    // branch instead of D1's (where the pragma inside a transaction is a no-op
    // and only `defer_foreign_keys` carries the gap across the parent DROP).
    db.raw.exec("PRAGMA foreign_keys = ON");
    const statements = statementsOf("0038_webhook_path_drop.sql");
    expect(statements.length).toBeGreaterThan(5);
    // note: Captured at the parent DROP, inside the transaction.
    const atDrop: { foreign_keys?: number; defer_foreign_keys?: number } = {};
    const apply = db.raw.transaction(() => {
      for (const statement of statements) {
        if (statement.startsWith("DROP TABLE github_apps\n") || statement.trim() === "DROP TABLE github_apps") {
          atDrop.foreign_keys = (db.raw.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
          atDrop.defer_foreign_keys = (
            db.raw.query("PRAGMA defer_foreign_keys").get() as { defer_foreign_keys: number }
          ).defer_foreign_keys;
        }
        db.raw.prepare(statement).run();
      }
    });
    expect(() => apply()).not.toThrow();

    // note: The in-transaction `PRAGMA foreign_keys = OFF` was ignored (SQLite keeps
    // the setting until the transaction ends), and the deferred check is the
    // one holding the parent DROP together.
    expect(atDrop).toEqual({ foreign_keys: 1, defer_foreign_keys: 1 });

    // invariant: The rows survive field for field, in the same order and with the same
    // values (the copy is positional, so a swapped column would show up here).
    const appsAfter = db.raw
      .query(
        `SELECT id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, status,
                deleted_at, review_enabled, sandbox_image_id, github_slug, review_trigger_mode
         FROM github_apps ORDER BY id`,
      )
      .all();
    expect(appsAfter).toEqual(appsBefore);
    expect(appsAfter.map((row) => (row as { github_app_id: number }).github_app_id)).toEqual([1001, 1002]);

    // invariant: No child row was cascaded, dropped or rewritten.
    expect(db.raw.query("SELECT app_id, workspace_id FROM app_workspaces ORDER BY app_id").all()).toEqual(
      childrenBefore.workspaces,
    );
    expect(
      db.raw
        .query("SELECT id, app_id, installation_id, account_login, seen_at FROM app_installations ORDER BY id")
        .all(),
    ).toEqual(childrenBefore.installations);
    expect(
      db.raw
        .query("SELECT id, app_id, event_name, outcome, status_code, created_at FROM webhook_deliveries ORDER BY id")
        .all(),
    ).toEqual(childrenBefore.deliveries);
    expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);

    // invariant: The column is gone, and the one remaining identity constraint still bites.
    const columns = db.raw.query("PRAGMA table_info(github_apps)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("webhook_path");
    expect(() =>
      insertGithubAppRow(db, { id: "app-dup", githubAppId: 1001 }),
    ).toThrow(/UNIQUE constraint failed: github_apps.github_app_id/);
    // invariant: FK enforcement is still live after the rebuild (the file restores it).
    expect(() =>
      db.raw
        .prepare("INSERT INTO app_installations (id, app_id, installation_id, seen_at) VALUES ('inst-x', 'nope', 1, '2026-01-01 00:00:00')")
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("replaying the file on an already-migrated schema is a no-op, leaving no staging table", () => {
    // note: No ledger exists in the test double, so the realistic second run is a raw
    // replay. The rebuild must be idempotent on the post-0038 shape (the
    // ledger is what normally prevents this call), and it must not leave the
    // staging table or a half-rebuilt schema behind. The world is bounded at
    // 0056: the rename gives the parent its bot name, which this historical
    // file predates.
    const db = createTestD1();
    for (const name of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql") && name >= "0003" && name < "0056")
      .sort()) {
      applyMigrationFile(db, name);
    }
    insertGithubAppRow(db, { id: "app-keep", githubAppId: 2001, name: "Keep" });
    db.raw
      .prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES ('app-keep', 'default')")
      .run();
    const appsBefore = db.raw.query("SELECT id, github_app_id, name FROM github_apps ORDER BY id").all();
    const childrenBefore = db.raw.query("SELECT app_id, workspace_id FROM app_workspaces ORDER BY app_id").all();

    const replay = db.raw.transaction(() => {
      for (const statement of statementsOf("0038_webhook_path_drop.sql")) db.raw.prepare(statement).run();
    });
    expect(() => replay()).not.toThrow();

    expect(db.raw.query("SELECT id, github_app_id, name FROM github_apps ORDER BY id").all()).toEqual(appsBefore);
    expect(db.raw.query("SELECT app_id, workspace_id FROM app_workspaces ORDER BY app_id").all()).toEqual(
      childrenBefore,
    );
    const tables = db.raw
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).not.toContain("github_apps_staging");
    expect(
      (db.raw.query("PRAGMA table_info(github_apps)").all() as Array<{ name: string }>).map((column) => column.name),
    ).not.toContain("webhook_path");
    // note: The file's own PRAGMA switches leave FK enforcement ON for the rest of
    // the run (the connection default the migration must not weaken).
    expect((db.raw.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
  });
});

describe("migrations/0043_workspace_concurrency_bound.sql", () => {
  test("clamps rows above the maximum when applied, and a replay is a no-op", async () => {
    // why: Apply everything BEFORE 0043, so the file runs for the first time over
    // rows that already exist — the real deploy order.
    const db = createTestD1();
    const before = readdirSync(MIGRATIONS_DIR)
      .filter(
        (name) =>
          name.endsWith(".sql") &&
          name >= "0003_dashboard_users.sql" &&
          name < "0043_workspace_concurrency_bound.sql",
      )
      .sort();
    for (const name of before) {
      execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    const insert = db.raw.prepare(
      `INSERT INTO workspaces (id, slug, name, created_at, max_concurrent_reviews)
       VALUES (?1, ?1, ?1, '2026-11-04T00:00:00.000Z', ?2)`,
    );
    // note: 33 and 64 were legal under the previous shared 1..64 range; 32 is the
    // new maximum, 8 an ordinary value, NULL the absent setting.
    for (const [id, cap] of [
      ["ws_40", 40],
      ["ws_33", 33],
      ["ws_32", WORKSPACE_CONCURRENCY_MAX],
      ["ws_8", 8],
      ["ws_null", null],
    ] as const) {
      insert.run(id, cap);
    }
    // note: The system row is deliberately outside the clamp's WHERE: its old
    // maximum (64) fits inside the new one (256).
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.concurrency.system', '64', '2026-11-04T00:00:00.000Z', 'migration-test')`,
      )
      .run();

    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, "0043_workspace_concurrency_bound.sql"), "utf8"));

    const rows = db.raw
      .query("SELECT id, max_concurrent_reviews AS cap FROM workspaces WHERE id LIKE 'ws\\_%' ESCAPE '\\' ORDER BY id")
      .all() as Array<{ id: string; cap: number | null }>;
    // why: The clamp literal in the migration is this constant's value; deriving the
    // expectation here makes a future bound change fail loudly.
    expect(Object.fromEntries(rows.map((row) => [row.id, row.cap]))).toEqual({
      ws_40: WORKSPACE_CONCURRENCY_MAX,
      ws_33: WORKSPACE_CONCURRENCY_MAX,
      ws_32: WORKSPACE_CONCURRENCY_MAX,
      ws_8: 8,
      ws_null: null,
    });

    // invariant: The migration's product promise: a formerly-64 value reads as an
    // ordinary, non-degraded cap after the clamp.
    expect(await getEffectiveConcurrency(db, "ws_40")).toEqual({
      system: 64,
      workspace: WORKSPACE_CONCURRENCY_MAX,
      effective: WORKSPACE_CONCURRENCY_MAX,
      degraded: false,
    });

    // invariant: The system row is untouched by the clamp.
    const system = db.raw
      .prepare("SELECT value FROM review_runtime_settings WHERE key = 'review.concurrency.system'")
      .get() as { value: string };
    expect(system.value).toBe("64");

    // invariant: The previous values survive in the migration's own record table.
    const recorded = db.raw
      .prepare(
        `SELECT workspace_id, previous_value, clamped_to
           FROM workspace_concurrency_clamp_0043 ORDER BY workspace_id`,
      )
      .all() as Array<{ workspace_id: string; previous_value: number; clamped_to: number }>;
    expect(recorded).toEqual([
      { workspace_id: "ws_33", previous_value: 33, clamped_to: WORKSPACE_CONCURRENCY_MAX },
      { workspace_id: "ws_40", previous_value: 40, clamped_to: WORKSPACE_CONCURRENCY_MAX },
    ]);

    // invariant: Replaying the file on the clamped schema is a no-op.
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, "0043_workspace_concurrency_bound.sql"), "utf8"));
    const replay = db.raw
      .query("SELECT id, max_concurrent_reviews AS cap FROM workspaces WHERE id LIKE 'ws\\_%' ESCAPE '\\' ORDER BY id")
      .all() as Array<{ id: string; cap: number | null }>;
    expect(replay).toEqual(rows);
    const recordedAgain = db.raw
      .query("SELECT COUNT(*) AS n FROM workspace_concurrency_clamp_0043")
      .get() as { n: number };
    expect(recordedAgain.n).toBe(2);
  });
});

describe("migrations/0045_review_gate_and_owner_allowlist.sql", () => {
  const GATE_MIGRATION = "0045_review_gate_and_owner_allowlist.sql";

  /** note: A DB shaped like production at 0044: every earlier file, applied in order. */
  function preGateDb(): TestD1 {
    const db = createTestD1();
    const gate = migrationNumber(GATE_MIGRATION);
    for (const name of migrationsAfter("0002_mstar_review_v1.sql").filter(
      (migration) => migrationNumber(migration) < gate,
    )) {
      execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    return db;
  }

  test("existing rows materialize the gate and visibility defaults with no backfill", () => {
    const db = preGateDb();
    // note: A row written before the migration carries no gate configuration.
    insertGithubAppRow(db, { id: "legacy-app", githubAppId: 9001, name: "legacy-app" });
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, GATE_MIGRATION), "utf8"));

    const row = db.raw
      .query(
        `SELECT check_min_score, check_pass_verdicts, allowlist_enabled, github_visibility
           FROM github_apps WHERE id = 'legacy-app'`,
      )
      .get() as {
      check_min_score: number;
      check_pass_verdicts: string;
      allowlist_enabled: number;
      github_visibility: string | null;
    };
    expect(row).toEqual({
      check_min_score: 80,
      check_pass_verdicts: '["ship it"]',
      allowlist_enabled: 0,
      github_visibility: null,
    });

    // invariant: The columns' own contract: NOT NULL, and a nullable visibility (the
    // default VALUES themselves are pinned above, row-level).
    const cols = db.raw.query("PRAGMA table_info(github_apps)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const byName = Object.fromEntries(cols.map((col) => [col.name, col]));
    expect(byName.check_min_score).toMatchObject({ type: "INTEGER", notnull: 1 });
    expect(byName.check_pass_verdicts).toMatchObject({ type: "TEXT", notnull: 1 });
    expect(byName.allowlist_enabled).toMatchObject({ type: "INTEGER", notnull: 1 });
    expect(byName.github_visibility).toMatchObject({ type: "TEXT", notnull: 0 });

    // invariant: The score CHECK is two-sided: both directions reject, and 0 is the
    // accepted floor of `BETWEEN 0 AND 100`.
    for (const outOfRange of [101, -1]) {
      expect(() =>
        db.raw
          .prepare("UPDATE github_apps SET check_min_score = ? WHERE id = 'legacy-app'")
          .run(outOfRange),
      ).toThrow();
    }
    db.raw.prepare("UPDATE github_apps SET check_min_score = 0 WHERE id = 'legacy-app'").run();
    const floorRow = db.raw
      .query("SELECT check_min_score FROM github_apps WHERE id = 'legacy-app'")
      .get() as { check_min_score: number };
    expect(floorRow.check_min_score).toBe(0);
    // invariant: A fractional score sits INSIDE 0..100, so only the CHECK's own INTEGER
    // cast equality refuses it; without that clause it would be stored.
    expect(() =>
      db.raw.prepare("UPDATE github_apps SET check_min_score = 80.5 WHERE id = 'legacy-app'").run(),
    ).toThrow();
    // invariant: ...and the INTEGER affinity still normalizes a whole-number value, so the
    // tightening refuses fractions only.
    db.raw.prepare("UPDATE github_apps SET check_min_score = '90.0' WHERE id = 'legacy-app'").run();
    const wholeRow = db.raw
      .query("SELECT check_min_score, typeof(check_min_score) AS kind FROM github_apps WHERE id = 'legacy-app'")
      .get() as { check_min_score: number; kind: string };
    expect(wholeRow).toEqual({ check_min_score: 90, kind: "integer" });
    expect(() =>
      db.raw.prepare("UPDATE github_apps SET github_visibility = 'secret' WHERE id = 'legacy-app'").run(),
    ).toThrow();
    db.raw.prepare("UPDATE github_apps SET github_visibility = 'private' WHERE id = 'legacy-app'").run();
    // invariant: JSON well-formedness is enforced; enumeration is not expressible in
    // DDL, so a well-formed off-vocabulary array is still storable and the
    // store read path — not the CHECK — rejects it.
    expect(() =>
      db.raw.prepare(`UPDATE github_apps SET check_pass_verdicts = '{not json' WHERE id = 'legacy-app'`).run(),
    ).toThrow();
    db.raw.prepare(`UPDATE github_apps SET check_pass_verdicts = '["lgtm"]' WHERE id = 'legacy-app'`).run();
  });

  test("app_owner_allowlist is keyed per (app, owner) and references review_bots", () => {
    const db = createBeforeSplitD1();
    insertGithubAppRow(db, { id: "allow-app", githubAppId: 9002, name: "allow-app" });
    const insert = db.raw.prepare(
      `INSERT INTO app_owner_allowlist (app_id, owner_login, created_at)
       VALUES (?, ?, datetime('now'))`,
    );
    insert.run("allow-app", "acme");
    expect(() => insert.run("allow-app", "acme")).toThrow();
    insert.run("allow-app", "beta");
    // invariant: An unknown App is refused by the FK, not silently stored.
    expect(() => insert.run("ghost-app", "acme")).toThrow();

    const owners = db.raw
      .query("SELECT owner_login FROM app_owner_allowlist WHERE app_id = 'allow-app' ORDER BY owner_login")
      .all() as Array<{ owner_login: string }>;
    expect(owners.map((entry) => entry.owner_login)).toEqual(["acme", "beta"]);

    // invariant: No ON DELETE (NO ACTION), the 0006/app-config precedent: the parent →
    // child direction refuses too, so soft-delete stays the only removal path
    // and a bot can never lose its rows by hard deletion.
    expect(() => db.raw.prepare("DELETE FROM review_bots WHERE id = 'allow-app'").run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe("migrations/0046_reviews_context_incomplete.sql", () => {
  /** note: The shipped chain before the column: every migration below 0046. */
  function createPre0046Db(): TestD1 {
    const db = createTestD1();
    for (const name of migrationsAfter("0002_mstar_review_v1.sql").filter(
      (migration) => migrationNumber(migration) < 46,
    )) {
      execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    return db;
  }

  test("an existing row reads as 0 (a pre-column round stays an incremental base)", () => {
    const db = createPre0046Db();
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md)
         VALUES ('r1', 123, 'acme', 'widgets', 42, ?, 'needs fixes', 'old')`,
      )
      .run("a".repeat(40));

    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, "0046_reviews_context_incomplete.sql"), "utf8"));

    const row = db.raw.query("SELECT context_incomplete FROM reviews WHERE id = 'r1'").get() as {
      context_incomplete: number;
    };
    expect(row.context_incomplete).toBe(0);
    const column = (
      db.raw.query("PRAGMA table_info(reviews)").all() as Array<{ name: string; notnull: number; dflt_value: string }>
    ).find((c) => c.name === "context_incomplete")!;
    expect(column.notnull).toBe(1);
    expect(column.dflt_value).toBe("0");
  });
});

describe("migrations/0049_reviews_duration_ms.sql", () => {
  /** note: The shipped chain before the column: every migration below 0049. */
  function createPre0049Db(): TestD1 {
    const db = createTestD1();
    for (const name of migrationsAfter("0002_mstar_review_v1.sql").filter(
      (migration) => migrationNumber(migration) < 49,
    )) {
      execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    return db;
  }

  test("the column is nullable with no default, and an existing row reads NULL", () => {
    const db = createPre0049Db();
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md)
         VALUES ('r1', 123, 'acme', 'widgets', 42, ?, 'needs fixes', 'old')`,
      )
      .run("a".repeat(40));

    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, "0049_reviews_duration_ms.sql"), "utf8"));

    // invariant: No duration is fabricated for history: a pre-column round reports none,
    // and the UI omits the time rather than printing a made-up 0.
    const row = db.raw.query("SELECT duration_ms FROM reviews WHERE id = 'r1'").get() as {
      duration_ms: number | null;
    };
    expect(row.duration_ms).toBeNull();
    const column = (
      db.raw.query("PRAGMA table_info(reviews)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>
    )
      .map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }))
      .find((c) => c.name === "duration_ms");
    expect(column).toEqual({ name: "duration_ms", type: "INTEGER", notnull: 0, dflt_value: null });
  });
});

/**
 * why: The recheck rotation's PR-scoped thread probe (migration 0047).
 *
 * `selectAssessmentTargets` (spec §7.2) also selects ADDRESSED findings that
 * own a non-terminal association, so every rotation pass probes
 * `review_threads` by PR scope. `review_threads` is cross-installation, so
 * without this index that probe scans the whole table on every round. The
 * index is identified BY NAME: 0047 is already carried by two merged
 * migrations, so the filename is not a stable locator.
 */
describe("idx_thread_pr_scope (migration 0047_thread_pr_scope.sql)", () => {
  const SCOPE = { appId: "scope-app", installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  /** note: The scope/publication rows the lifecycle FKs require, plus two findings. */
  function seedRotationFixture(): TestD1 {
    const db = createMigratedTestD1();
    insertGithubAppRow(db, { id: SCOPE.appId, githubAppId: 9003, name: "scope-app" });
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, created_ms, updated_ms)
         VALUES ('pub-1', ?, ?, ?, ?, ?, ?, 'review', 'applied', '{}', 1, 1)`,
      )
      .run(SCOPE.appId, SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA);
    const insertFinding = (id: string, state: string, createdMs: number): void => {
      db.raw
        .prepare(
          `INSERT INTO review_findings
             (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
              first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
              first_seen_round, last_seen_round, state, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 'pub-1', 'pub-1', ?, ?, 1, 1, ?, ?, ?)`,
        )
        .run(
          id,
          SCOPE.appId,
          SCOPE.installationId,
          SCOPE.owner,
          SCOPE.repo,
          SCOPE.prNumber,
          `f-${id}`,
          SHA,
          SHA,
          state,
          createdMs,
          createdMs,
        );
    };
    insertFinding("row-open", "open", 1000);
    insertFinding("row-addressed", "addressed", 2000);
    // note: An addressed row with no association: the probe must not select it.
    insertFinding("row-untracked", "addressed", 3000);
    db.raw
      .prepare(
        `INSERT INTO review_threads
           (id, finding_row_id, publication_id, bot_id, installation_id, owner, repo, pr_number,
            original_sha, round, intent_json, resolution_state, created_ms, updated_ms)
         VALUES ('t-1', 'row-addressed', 'pub-1', ?, ?, ?, ?, ?, ?, 1, '{}', 'pending', 1000, 1000)`,
      )
      .run(SCOPE.appId, SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA);
    return db;
  }

  test("declares the PR scope followed by resolution_state", () => {
    const db = createMigratedTestD1();
    const columns = (
      db.raw.query("PRAGMA index_info(idx_thread_pr_scope)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toEqual(["bot_id", "installation_id", "owner", "repo", "pr_number", "resolution_state"]);
  });

  test("the selector's association probe rides the index instead of scanning review_threads", async () => {
    const db = seedRotationFixture();
    // why: Record the statement the REAL selector prepares — never a copy.
    const prepared: string[] = [];
    const recording: D1Like = {
      prepare(sql: string) {
        prepared.push(sql);
        return db.prepare(sql);
      },
      batch: (statements) => db.batch(statements),
    };
    const selected = await selectAssessmentTargets(recording, SCOPE, 25);
    expect(selected.map((target) => target.rowId)).toEqual(["row-open", "row-addressed"]);

    const probe = prepared.find((sql) => sql.includes("EXISTS"))!;
    const plan = (db.raw.query(`EXPLAIN QUERY PLAN ${probe}`).all() as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("SEARCH t USING INDEX idx_thread_pr_scope");
    // invariant: A full scan of the cross-installation table is the regression this pins.
    expect(plan.split("\n").some((line) => line.startsWith("SCAN t"))).toBe(false);
  });
});

/**
 * why: migration 0048 — the durable comment-trigger claim.
 *
 * The table is the at-most-once proof for a bot-mention comment: the worker
 * inserts one row before its queue send, so the PRIMARY KEY (never a KV
 * get-then-put) decides which delivery owns the comment. These assertions pin
 * the identity columns, the state vocabulary and the outbox index the sweep
 * scans.
 */
describe("migrations/0048_comment_trigger_claims.sql", () => {
  test("declares the five-column identity, the state vocabulary and the timestamps", () => {
    const db = createMigratedTestD1();
    const columns = db.raw.query("PRAGMA table_info(comment_trigger_claims)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    expect(columns.map((c) => c.name)).toEqual([
      "installation_id",
      "owner",
      "repo",
      "pr_number",
      "comment_id",
      "state",
      "payload_json",
      "attempts",
      "created_ms",
      "queued_ms",
      "consumed_ms",
    ]);
    // invariant: The PK IS the dedup: exactly the five identity columns, in that order.
    expect(columns.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
      "installation_id",
      "owner",
      "repo",
      "pr_number",
      "comment_id",
    ]);
    // invariant: Two nullable columns: `consumed_ms` is only set at consumption, and
    // `payload_json` is cleared there (a tombstone keeps no payload).
    const NULLABLE: Record<string, true> = { consumed_ms: true, payload_json: true };
    for (const column of columns) {
      expect(column.notnull, column.name).toBe(NULLABLE[column.name] === true ? 0 : 1);
    }
    expect(columns.find((c) => c.name === "attempts")?.dflt_value).toBe("0");
  });

  test("the primary key refuses a second claim for the same comment id, and refuses an unknown state", () => {
    const db = createMigratedTestD1();
    const insert = db.raw.prepare(
      `INSERT INTO comment_trigger_claims
         (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms)
       VALUES (1, 'acme', 'widgets', 42, 9001, ?, '{}', 0, 1, 1)`,
    );

    insert.run("queued");
    // invariant: The whole point: one comment id, one claim.
    expect(() => insert.run("queued")).toThrow();

    // invariant: The same comment id on another PR is a different claim.
    db.raw
      .prepare(
        `INSERT INTO comment_trigger_claims
           (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms)
         VALUES (1, 'acme', 'widgets', 43, 9001, 'queued', '{}', 0, 1, 1)`,
      )
      .run();

    // invariant: The vocabulary is closed: a typo can never strand a claim unreadable.
    expect(() => insert.run("claimed")).toThrow();
    for (const state of ["consumed", "expired"] as const) {
      db.raw
        .prepare("UPDATE comment_trigger_claims SET state = ? WHERE pr_number = 42 AND comment_id = 9001")
        .run(state);
      expect(db.raw.query("SELECT state FROM comment_trigger_claims WHERE pr_number = 42").get()).toEqual({ state });
    }
  });

  test("the outbox index serves the sweep's own scan", () => {
    const db = createMigratedTestD1();
    const indexColumns = (
      db.raw.query("PRAGMA index_info(idx_comment_claim_outbox)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(indexColumns).toEqual(["state", "queued_ms"]);

    // why: The statement the sweep prepares — projection, `attempts` predicate and
    // the operator LIMIT included — never a hand-written twin that can drift.
    const plan = (
      db.raw
        .query(`EXPLAIN QUERY PLAN ${COMMENT_CLAIM_OUTBOX_SQL}`)
        .all() as Array<{ detail: string }>
    )
      .map((p) => p.detail)
      .join("\n");
    expect(plan).toContain("idx_comment_claim_outbox");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});

describe("migrations/0049_workspace_check_min_score.sql", () => {
  const SCORE_MIGRATION = "0049_workspace_check_min_score.sql";

  /** note: A DB shaped like production at 0048: every earlier file, applied in order. */
  function preScoreDb(): TestD1 {
    const db = createTestD1();
    for (const name of migrationsAfter("0002_mstar_review_v1.sql").filter(
      (migration) => migrationNumber(migration) < migrationNumber(SCORE_MIGRATION),
    )) {
      execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    return db;
  }

  test("adds a nullable, CHECK-guarded column without touching any row", () => {
    const db = preScoreDb();
    db.raw
      .prepare("INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES ('ws', 'ws', 'ws', 't', datetime('now'))")
      .run();
    insertGithubAppRow(db, { id: "app-kept", githubAppId: 9301 });
    db.raw
      .prepare("INSERT INTO pull_requests (id, app_id, owner, repo, pr_number, state) VALUES ('pr-1', 'app-kept', 'acme', 'widgets', 7, 'open')")
      .run();

    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, SCORE_MIGRATION), "utf8"));

    // note: The workspace keeps its row and starts at the absent state (the platform
    // default lives in code, not in a column default that could freeze it).
    expect(db.raw.query("SELECT check_min_score FROM workspaces WHERE id = 'ws'").get()).toEqual({
      check_min_score: null,
    });
    const column = (
      db.raw.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
    ).find((c) => c.name === "check_min_score");
    expect(column).toMatchObject({ notnull: 0, dflt_value: null });

    // invariant: The migration must never rebuild `github_apps`: that DROP TABLE would
    // fire `pull_requests`' ON DELETE CASCADE and empty the PR ledger.
    expect(db.raw.query("SELECT id FROM pull_requests").all()).toEqual([{ id: "pr-1" }]);
    expect(db.raw.query("SELECT check_min_score FROM github_apps WHERE id = 'app-kept'").get()).toEqual({
      check_min_score: 80,
    });
  });

  test("the CHECK refuses a non-integer or out-of-range floor", () => {
    const db = createMigratedTestD1();
    for (const bad of [101, -1, 60.5]) {
      expect(() =>
        db.raw.prepare("UPDATE workspaces SET check_min_score = ? WHERE id = 'default'").run(bad),
      ).toThrow();
    }
    db.raw.prepare("UPDATE workspaces SET check_min_score = 0 WHERE id = 'default'").run();
    expect(db.raw.query("SELECT check_min_score FROM workspaces WHERE id = 'default'").get()).toEqual({
      check_min_score: 0,
    });
  });
});

describe("migrations/0050_reviews_round.sql", () => {
  const ROUND_MIGRATION = "0050_reviews_round.sql";

  /** note: A DB shaped like production at 0049: every earlier file, applied in order. */
  function preRoundDb(): TestD1 {
    const db = createTestD1();
    for (const name of migrationsAfter("0002_mstar_review_v1.sql").filter(
      (migration) => migrationNumber(migration) < migrationNumber(ROUND_MIGRATION),
    )) {
      execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    return db;
  }

  test("adds a nullable, default-free column without touching any row", () => {
    const db = preRoundDb();
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, reviewed_at)
         VALUES ('r-1', 1, 'acme', 'widgets', 7, 'sha-1', 'comment', '2026-01-01 00:00:00')`,
      )
      .run();

    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, ROUND_MIGRATION), "utf8"));

    // note: Pre-column rows read NULL, which is exactly the branch the detail read
    // turns into its positional fallback.
    expect(db.raw.query("SELECT round FROM reviews WHERE id = 'r-1'").get()).toEqual({ round: null });
    const column = (
      db.raw.query("PRAGMA table_info(reviews)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
    ).find((c) => c.name === "round");
    expect(column).toMatchObject({ notnull: 0, dflt_value: null });

    // invariant: ALTER TABLE must preserve the row.
    expect(db.raw.query("SELECT id FROM reviews").all()).toEqual([{ id: "r-1" }]);
  });
});

/**
 * why: Ordinal hygiene. This table IS the keep-and-order decision — not a
 * convenience list: applied state is not determinable from the repo, so the
 * five pairs were kept, nothing was renamed, and their apply order is the
 * filename byte order the total comparator in `./helpers` produces.
 *
 * | Ordinal | Files, in apply order                                                      |
 * |---------|-----------------------------------------------------------------------------|
 * | `0043`  | `0043_webhook_delivery_repository.sql` → `0043_workspace_concurrency_bound.sql` |
 * | `0047`  | `0047_review_level_per_app.sql` → `0047_thread_pr_scope.sql`                |
 * | `0048`  | `0048_comment_trigger_claims.sql` → `0048_review_failures_pipeline_window.sql` |
 * | `0049`  | `0049_reviews_duration_ms.sql` → `0049_workspace_check_min_score.sql`       |
 * | `0087`  | `0087_review_attempt_queue_wait.sql` → `0087_terminal_failure_status.sql`   |
 *
 * When a pair stops colliding, delete its entry — the tests below fail until
 * you do.
 */
const KEPT_DUPLICATE_ORDINALS: ReadonlyMap<number, readonly string[]> = new Map([
  [43, ["0043_webhook_delivery_repository.sql", "0043_workspace_concurrency_bound.sql"]],
  [47, ["0047_review_level_per_app.sql", "0047_thread_pr_scope.sql"]],
  [48, ["0048_comment_trigger_claims.sql", "0048_review_failures_pipeline_window.sql"]],
  [49, ["0049_reviews_duration_ms.sql", "0049_workspace_check_min_score.sql"]],
  [87, ["0087_review_attempt_queue_wait.sql", "0087_terminal_failure_status.sql"]],
]);

/** note: Group migration filenames by numeric prefix; a group of 2+ is a repeated ordinal. */
function groupByOrdinal(names: readonly string[]): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const name of names) {
    const ordinal = migrationNumber(name);
    groups.set(ordinal, [...(groups.get(ordinal) ?? []), name]);
  }
  return groups;
}

/**
 * why: Throw for any repeated ordinal the table does not record, or whose file set
 * differs from the recorded pair (a third file for `0043` is undocumented too).
 */
function assertOnlyRecordedDuplicates(names: readonly string[]): void {
  for (const [ordinal, files] of groupByOrdinal(names)) {
    if (files.length < 2) continue;
    const recorded = KEPT_DUPLICATE_ORDINALS.get(ordinal);
    if (recorded === undefined || files.length !== recorded.length || files.some((f, i) => f !== recorded[i])) {
      throw new Error(
        `migrations/ ordinal ${String(ordinal).padStart(4, "0")} repeats as [${files.join(", ")}], ` +
          `which is not the recorded pair [${recorded?.join(", ") ?? "none"}]`,
      );
    }
  }
}

describe("migrations/ ordinals", () => {
  /** note: Readdir order is a filesystem detail; byte order is what the decision states. */
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  test("only the five recorded ordinals repeat, each as its recorded pair", () => {
    assertOnlyRecordedDuplicates(names);
  });

  test("each recorded pair is present exactly and applies in the recorded filename order", () => {
    for (const [ordinal, recorded] of KEPT_DUPLICATE_ORDINALS) {
      expect(names.filter((name) => migrationNumber(name) === ordinal)).toEqual([...recorded]);
      expect(migrationsAfter(ordinal - 1).filter((name) => migrationNumber(name) === ordinal)).toEqual([...recorded]);
    }
  });

  test("a second file for an unrecorded ordinal — a hypothetical fifth duplicate — fails the guard", () => {
    expect(() => assertOnlyRecordedDuplicates([...names, "0050_reviews_round_second.sql"])).toThrow(
      /ordinal 0050 repeats as \[0050_reviews_round\.sql, 0050_reviews_round_second\.sql\]/,
    );
    expect(() => assertOnlyRecordedDuplicates([...names, "0043_third_claim.sql"])).toThrow(/ordinal 0043/);
  });
});

/**
 * why: migration 0051 — the trailing-24h secondary-rate-limit count's index.
 *
 * The read (`countGithubRateLimited24h`) states a `created_at` window and an
 * `error` prefix test, and no stage predicate — so 0048's partial index cannot
 * serve it, and the 0010 `created_at` index still forces a table read per row
 * of the window to evaluate the LIKE. The index must seek the window and carry
 * `error`, and the statement the store prepares must seek it.
 */
describe("migrations/0051_review_failures_rate_limit_window.sql", () => {
  test("seeks the window on created_at with error covered; the count's own statement uses it", async () => {
    const db = createMigratedTestD1();
    const indexColumns = (
      db.raw.query("PRAGMA index_info(idx_review_failures_rate_limited_created)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(indexColumns).toEqual(["created_at", "error"]);
    const indexSql = (
      db.raw
        .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_failures_rate_limited_created'")
        .get() as { sql: string } | null
    )?.sql;
    // note: Not partial: the read states no stage, and its LIKE prefix arrives as a
    // bound value, which no index predicate could be matched against.
    expect(indexSql).not.toContain("WHERE");

    // why: The statement the REAL store prepares — never a hand-written twin.
    const prepared: string[] = [];
    const recording: D1Like = {
      prepare(sql: string) {
        prepared.push(sql);
        return db.prepare(sql);
      },
      batch: (statements) => db.batch(statements),
    };
    await createFailureStore(recording).countGithubRateLimited24h();

    const countSql = prepared.find((sql) => sql.includes("COUNT(*)"))!;
    const plan = (
      db.raw.query(`EXPLAIN QUERY PLAN ${countSql}`).all(`${GITHUB_RATE_LIMIT_PREFIX}%`) as Array<{ detail: string }>
    ).map((row) => row.detail);
    console.log("EXPLAIN QUERY PLAN (24h secondary-limit count):", plan.join("\n"));
    expect(plan.join("\n")).toContain(
      "SEARCH review_failures USING COVERING INDEX idx_review_failures_rate_limited_created (created_at>?)",
    );
  });
});

/**
 * why: migration 0056 — `github_apps` is a review bot, and the family it owns plus
 * every row that records which bot acted takes the bot vocabulary. The rename
 * is in place: `ALTER TABLE ... RENAME` rewrites the foreign keys and index
 * definitions SQLite holds, so no table is rebuilt and no row is rewritten.
 */
describe("migrations/0056_review_bots_rename.sql", () => {
  /** note: Table pairs, in the order the file renames them (parent first). */
  const RENAMED_TABLES = [
    ["github_apps", "review_bots"],
    ["app_installations", "bot_installations"],
    ["app_workspaces", "bot_workspaces"],
    ["app_provider_keys", "bot_provider_keys"],
    ["app_model_config", "bot_model_config"],
    ["app_model_roles", "bot_model_roles"],
    ["app_model_chains", "bot_model_chains"],
    ["app_model_chain_seats", "bot_model_chain_seats"],
    ["app_custom_providers", "bot_custom_providers"],
    ["app_custom_provider_keys", "bot_custom_provider_keys"],
    ["app_provider_models", "bot_provider_models"],
  ] as const;

  /** note: Every table whose row attributes a fact to the bot that produced it. */
  const BOT_ATTRIBUTED = [
    "bot_installations",
    "bot_workspaces",
    "bot_provider_keys",
    "bot_model_config",
    "bot_model_roles",
    "bot_model_chains",
    "bot_model_chain_seats",
    "bot_custom_providers",
    "bot_custom_provider_keys",
    "bot_provider_models",
    "reviews",
    "pull_requests",
    "webhook_deliveries",
    "review_publications",
    "review_findings",
    "review_threads",
    "review_checks",
  ] as const;

  test("renames the bot-owned table family and leaves no old name behind", () => {
    const db = createBeforeSplitD1();
    const tables = schemaNames(db, "table");
    for (const [oldName, newName] of RENAMED_TABLES) {
      expect(tables, `${oldName} → ${newName}`).toContain(newName);
      expect(tables, `${oldName} is gone`).not.toContain(oldName);
    }
  });

  test("app_owner_allowlist keeps its own name and its app_id column", () => {
    const db = createBeforeSplitD1();
    expect(schemaNames(db, "table")).toContain("app_owner_allowlist");
    expect(columnNames(db, "app_owner_allowlist")).toContain("app_id");
    expect(columnNames(db, "app_owner_allowlist")).not.toContain("bot_id");
  });

  test("renames every bot attribution column to bot_id", () => {
    const db = createBeforeSplitD1();
    for (const table of BOT_ATTRIBUTED) {
      const columns = columnNames(db, table);
      expect(columns, `${table}.bot_id`).toContain("bot_id");
      expect(columns, `${table}.app_id`).not.toContain("app_id");
    }
  });

  test("recreates the three App-named indexes and keeps the three it does not touch", () => {
    const db = createBeforeSplitD1();
    const indexes = schemaNames(db, "index");
    for (const name of ["idx_reviews_app_id", "idx_webhook_deliveries_app_created", "idx_pull_requests_app_pr"]) {
      expect(indexes, `${name} is gone`).not.toContain(name);
    }
    for (const name of ["idx_reviews_bot_id", "idx_webhook_deliveries_bot_created", "idx_pull_requests_bot_pr"]) {
      expect(indexes, name).toContain(name);
    }
    // invariant: RENAME COLUMN rewrote these definitions; their names are unchanged.
    for (const name of ["idx_publication_scope", "idx_finding_rotation", "idx_thread_pr_scope"]) {
      expect(indexes, name).toContain(name);
    }
  });

  test("the rename carries foreign keys with it — no dangling reference, no rebuild", () => {
    const db = createBeforeSplitD1();
    for (const [table, column] of [
      ["bot_installations", "bot_id"],
      ["bot_workspaces", "bot_id"],
      ["bot_provider_keys", "bot_id"],
      ["reviews", "bot_id"],
      ["pull_requests", "bot_id"],
      ["review_checks", "bot_id"],
      // invariant: The allowlist's column keeps its name; its foreign key follows the parent.
      ["app_owner_allowlist", "app_id"],
    ] as const) {
      const targets = (
        db.raw.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; from: string }>
      )
        .filter((key) => key.from === column)
        .map((key) => key.table);
      expect(targets, `${table}.${column} → review_bots`).toEqual(["review_bots"]);
    }
  });

  test("applies over a populated pre-rename schema without rewriting a row", () => {
    // note: The deploy's real input: the pre-rename schema already carrying rows.
    const db = createTestD1();
    for (const name of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql") && name >= "0003" && name < "0056")
      .sort()) {
      execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    insertGithubAppRow(db, { id: "app-1", name: "Acme Reviewer", githubAppId: 5001 });
    db.raw.exec(
      `INSERT INTO app_workspaces (app_id, workspace_id) VALUES ('app-1', 'default');
       INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
         VALUES ('inst-1', 'app-1', 123, 'acme', '2026-01-01 00:00:00');
       INSERT INTO app_owner_allowlist (app_id, owner_login, created_at)
         VALUES ('app-1', 'acme', '2026-01-01 00:00:00');`,
    );
    insertReview(db);
    db.raw.exec("UPDATE reviews SET app_id = 'app-1' WHERE id = 'review-1'");

    // invariant: Each read projects the post-rename column name, so equality compares the
    // row and not the spelling.
    const before = {
      bot: db.raw.query("SELECT * FROM github_apps").all(),
      workspaces: db.raw.query("SELECT app_id AS bot_id, workspace_id FROM app_workspaces").all(),
      installations: db.raw
        .query("SELECT id, app_id AS bot_id, installation_id, account_login, seen_at FROM app_installations")
        .all(),
      allowlist: db.raw.query("SELECT app_id, owner_login, created_at FROM app_owner_allowlist").all(),
      reviewBotId: db.raw.query("SELECT app_id AS bot_id FROM reviews WHERE id = 'review-1'").get(),
    };
    expect(before.bot).toHaveLength(1);

    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, "0056_review_bots_rename.sql"), "utf8"));

    expect(db.raw.query("SELECT * FROM review_bots").all()).toEqual(before.bot);
    expect(db.raw.query("SELECT bot_id, workspace_id FROM bot_workspaces").all()).toEqual(before.workspaces);
    expect(
      db.raw.query("SELECT id, bot_id, installation_id, account_login, seen_at FROM bot_installations").all(),
    ).toEqual(before.installations);
    expect(db.raw.query("SELECT app_id, owner_login, created_at FROM app_owner_allowlist").all()).toEqual(
      before.allowlist,
    );
    expect(db.raw.query("SELECT bot_id FROM reviews WHERE id = 'review-1'").get()).toEqual(before.reviewBotId);
    expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

/**
 * why: migration 0057 — review configuration leaves the bot for a workspace-owned
 * target. One target per bot carries the moved settings, both attribution
 * columns point at it, the owner allowlist moves onto it, and the bot row keeps
 * only the columns an execution identity owns.
 */
describe("migrations/0057_review_targets.sql", () => {
  const SPLIT_MIGRATION = "0057_review_targets.sql";

  /** note: The columns an execution identity keeps, in declaration order. */
  const BOT_COLUMNS = [
    "id",
    "github_app_id",
    "name",
    "private_key_enc",
    "webhook_secret_enc",
    "created_by",
    "status",
    "deleted_at",
    "created_at",
    "updated_at",
    "review_enabled",
    "last_webhook_at",
    "sandbox_image_id",
    "github_name",
    "github_description",
    "github_html_url",
    "github_avatar_url",
    "github_metadata_synced_at",
    "github_slug",
    "github_metadata_attempted_at",
    "github_visibility",
  ];

  /**
   * note: The target's declaration order at the shipped schema: 0057's columns minus
   * the installation-keyed trio 0067 dropped, plus the repository identity and
   * the inheritance switch it appended.
   */
  const TARGET_COLUMNS = [
    "id",
    "workspace_id",
    "bot_id",
    "name",
    "review_enabled",
    "review_trigger_mode",
    "review_level",
    "check_min_score",
    "check_pass_verdicts",
    "created_by",
    "created_at",
    "updated_at",
    "deleted_at",
    "repo_id",
    "repo_owner",
    "repo_name",
    "follow_workspace_defaults",
    // note: 0070 appends the draft-review gate after the split's columns.
    "review_drafts",
  ];

  /** note: The bot columns the target inherits, projected the same on both sides. */
  const INHERITED =
    "name, review_enabled, review_trigger_mode, review_level, check_min_score, " +
    "check_pass_verdicts, allowlist_enabled, created_by, created_at, updated_at, deleted_at";

  function applySplit(db: TestD1): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, SPLIT_MIGRATION), "utf8"));
  }

  function insertClaim(db: TestD1, commentId: number, state: string, payload: string | null): void {
    db.raw
      .prepare(
        `INSERT INTO comment_trigger_claims
           (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms)
         VALUES (123, 'acme', 'widgets', 42, ?, ?, ?, 0, 1, 1)`,
      )
      .run(commentId, state, payload);
  }

  function insertTarget(db: TestD1, row: { id: string; installationId: number | null }): void {
    db.raw
      .prepare(
        `INSERT INTO review_targets
           (id, workspace_id, bot_id, name, installation_id, created_by, created_at, updated_at)
         VALUES (?, 'default', 'bot-b', ?, ?, 'mallory', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run(row.id, row.id, row.installationId);
  }

  /**
   * note: The live shape the migration upgrades: two bots (one active with a single
   * live installation and an owner allowlist, one soft-deleted with two live
   * installations), a review and a PR ledger row under each plus a legacy
   * review with no bot attribution, one queued claim and one tombstone.
   * Returns the bot rows' inherited columns as the target must copy them — the
   * columns are gone afterwards, so they are read before the migration.
   */
  function seedBeforeSplit(db: TestD1): Array<Record<string, unknown>> {
    insertGithubAppRow(db, { id: "bot-a", githubAppId: 5001, name: "Acme Reviewer", createdBy: "mallory" });
    insertGithubAppRow(db, {
      id: "bot-b",
      githubAppId: 5002,
      name: "Widgets Reviewer",
      createdBy: "octocat",
      deletedExpr: "datetime('now')",
    });
    db.raw
      .prepare(
        `UPDATE review_bots
            SET review_enabled = ?, review_trigger_mode = ?, review_level = ?, check_min_score = ?,
                check_pass_verdicts = ?, allowlist_enabled = ?, github_slug = ?, github_visibility = ?
          WHERE id = ?`,
      )
      .run(1, "open", "deep", 70, '["ship it","comment"]', 1, "acme-reviewer", "private", "bot-a");
    db.raw
      .prepare(
        `UPDATE review_bots
            SET review_enabled = ?, review_trigger_mode = ?, review_level = ?, check_min_score = ?,
                check_pass_verdicts = ?, allowlist_enabled = ?, github_visibility = ?
          WHERE id = ?`,
      )
      .run(0, "manual", null, 90, '["ship it"]', 0, null, "bot-b");

    // note: bot-a: one live installation plus a removed one — a removed row is not a
    // binding and does not lift the live count off one. bot-b: two live rows, so
    // its target stays unbound.
    db.raw.exec(`INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('bot-a', 'default'), ('bot-b', 'default');

      INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at) VALUES
        ('inst-a-live', 'bot-a', 123, 'acme', '2026-01-01T00:00:00Z', NULL),
        ('inst-a-old',  'bot-a', 111, 'old-owner', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
        ('inst-b-1',    'bot-b', 456, 'acme-two', '2026-01-01T00:00:00Z', NULL),
        ('inst-b-2',    'bot-b', 457, 'acme-three', '2026-01-01T00:00:00Z', NULL);

      INSERT INTO app_owner_allowlist (app_id, owner_login, created_at) VALUES
        ('bot-a', 'acme', '2026-01-01T00:00:00Z'),
        ('bot-a', 'octocat', '2026-01-02T00:00:00Z');

      INSERT INTO pull_requests (id, bot_id, owner, repo, pr_number, state) VALUES
        ('pr-a', 'bot-a', 'acme', 'widgets', 42, 'open'),
        ('pr-b', 'bot-b', 'acme', 'widgets', 44, 'open');`);

    insertReview(db);
    insertReview(db, { id: "review-b", pr_number: 44 });
    insertReview(db, { id: "review-legacy", pr_number: 43 });
    db.raw.exec(`UPDATE reviews SET bot_id = 'bot-a' WHERE id = 'review-1';
                 UPDATE reviews SET bot_id = 'bot-b' WHERE id = 'review-b';`);

    insertClaim(
      db,
      9001,
      "queued",
      JSON.stringify({
        installation_id: 123,
        owner: "acme",
        repo: "widgets",
        pr_number: 42,
        head_sha: null,
        action: "created",
        triggered_by: "issue_comment",
        comment_id: 9001,
        appRef: { appId: "bot-a" },
      }),
    );
    // invariant: A tombstone: a terminal row keeps no payload, so the rewrite never sees it.
    insertClaim(db, 9002, "consumed", null);

    return db.raw.query(`SELECT id, ${INHERITED} FROM review_bots ORDER BY id`).all() as Array<
      Record<string, unknown>
    >;
  }

  test("gives every bot exactly one target carrying the row's moved configuration", () => {
    const db = createBeforeSplitD1();
    const before = seedBeforeSplit(db);
    applySplit(db);

    expect(db.raw.query("SELECT bot_id, COUNT(*) AS n FROM review_targets GROUP BY bot_id").all()).toEqual([
      { bot_id: "bot-a", n: 1 },
      { bot_id: "bot-b", n: 1 },
    ]);
    // invariant: The read projects the target's column names, so equality compares the row
    // and not the spelling.
    expect(db.raw.query(`SELECT bot_id AS id, ${INHERITED} FROM review_targets ORDER BY bot_id`).all()).toEqual(
      before,
    );
    // invariant: The workspace is the bot's; the target copies the bot's soft-delete stamp.
    expect(db.raw.query("SELECT bot_id, workspace_id FROM review_targets ORDER BY bot_id").all()).toEqual([
      { bot_id: "bot-a", workspace_id: "default" },
      { bot_id: "bot-b", workspace_id: "default" },
    ]);
  });

  test("clears the bot's operational pause while the target holds the business pause", () => {
    const db = createBeforeSplitD1();
    seedBeforeSplit(db);
    expect(db.raw.query("SELECT id, review_enabled FROM review_bots ORDER BY id").all()).toEqual([
      { id: "bot-a", review_enabled: 1 },
      { id: "bot-b", review_enabled: 0 },
    ]);
    applySplit(db);

    // invariant: A settings resume can never be blocked by a stale copy of the old flag.
    expect(db.raw.query("SELECT id, review_enabled FROM review_bots ORDER BY id").all()).toEqual([
      { id: "bot-a", review_enabled: 1 },
      { id: "bot-b", review_enabled: 1 },
    ]);
    // invariant: Effective pause (either flag 0) is the old flag: the paused bot's target
    // holds the 0.
    expect(db.raw.query("SELECT bot_id, review_enabled FROM review_targets ORDER BY bot_id").all()).toEqual([
      { bot_id: "bot-a", review_enabled: 1 },
      { bot_id: "bot-b", review_enabled: 0 },
    ]);
  });

  test("binds the installation only when the bot has exactly one live row", () => {
    const db = createBeforeSplitD1();
    seedBeforeSplit(db);
    applySplit(db);

    expect(db.raw.query("SELECT bot_id, installation_id, account_login FROM review_targets ORDER BY bot_id").all()).toEqual(
      [
        { bot_id: "bot-a", installation_id: 123, account_login: "acme" },
        { bot_id: "bot-b", installation_id: null, account_login: null },
      ],
    );
  });

  test("attributes every review and ledger row through its bot, and leaves a botless review targetless", () => {
    const db = createBeforeSplitD1();
    seedBeforeSplit(db);
    applySplit(db);
    const targets = Object.fromEntries(
      (db.raw.query("SELECT bot_id, id FROM review_targets").all() as Array<{ bot_id: string; id: string }>).map(
        (row) => [row.bot_id, row.id],
      ),
    );

    expect(db.raw.query("SELECT id, bot_id, target_id FROM reviews ORDER BY id").all()).toEqual([
      { id: "review-1", bot_id: "bot-a", target_id: targets["bot-a"] },
      { id: "review-b", bot_id: "bot-b", target_id: targets["bot-b"] },
      { id: "review-legacy", bot_id: null, target_id: null },
    ]);
    // invariant: The ledger has no botless row: every row names a target.
    const ledger = db.raw.query("SELECT id, bot_id, target_id FROM pull_requests ORDER BY id").all() as Array<{
      id: string;
      bot_id: string;
      target_id: string | null;
    }>;
    expect(ledger).toEqual([
      { id: "pr-a", bot_id: "bot-a", target_id: targets["bot-a"]! },
      { id: "pr-b", bot_id: "bot-b", target_id: targets["bot-b"]! },
    ]);
    expect(ledger.every((row) => row.target_id !== null)).toBe(true);
  });

  test("copies the owner allowlist onto the target and drops the old table", () => {
    const db = createBeforeSplitD1();
    seedBeforeSplit(db);
    const before = db.raw
      .query("SELECT app_id, owner_login, created_at FROM app_owner_allowlist ORDER BY owner_login")
      .all() as Array<{ app_id: string; owner_login: string; created_at: string }>;
    applySplit(db);

    expect(
      db.raw
        .query(
          `SELECT t.bot_id, a.owner_login, a.created_at
             FROM target_owner_allowlist a
             JOIN review_targets t ON t.id = a.target_id
            ORDER BY a.owner_login`,
        )
        .all(),
    ).toEqual(before.map((row) => ({ bot_id: row.app_id, owner_login: row.owner_login, created_at: row.created_at })));
    expect(schemaNames(db, "table")).not.toContain("app_owner_allowlist");
  });

  test("the partial unique index rejects a second binding for one bot and allows an unbound target", () => {
    const db = createBeforeSplitD1();
    seedBeforeSplit(db);
    applySplit(db);

    // note: bot-b's backfilled target is unbound, so the slot is open…
    insertTarget(db, { id: "target-456", installationId: 456 });
    // note: …and the second claim of the same installation is what the index refuses.
    expect(() => insertTarget(db, { id: "target-456-again", installationId: 456 })).toThrow(
      /UNIQUE constraint failed/,
    );
    // invariant: A different installation is a different binding; NULL is never indexed.
    insertTarget(db, { id: "target-457", installationId: 457 });
    insertTarget(db, { id: "target-unbound-1", installationId: null });
    insertTarget(db, { id: "target-unbound-2", installationId: null });

    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_targets WHERE bot_id = 'bot-b'").get()).toEqual({ n: 5 });
  });

  test("rewrites a queued claim's job JSON to the bot ref and target id, and never touches a tombstone", () => {
    const db = createBeforeSplitD1();
    seedBeforeSplit(db);
    applySplit(db);
    const targetA = (db.raw.query("SELECT id FROM review_targets WHERE bot_id = 'bot-a'").get() as { id: string }).id;

    const claims = db.raw
      .query("SELECT comment_id, state, payload_json FROM comment_trigger_claims ORDER BY comment_id")
      .all() as Array<{ comment_id: number; state: string; payload_json: string | null }>;
    expect(JSON.parse(claims[0]!.payload_json!)).toEqual({
      installation_id: 123,
      owner: "acme",
      repo: "widgets",
      pr_number: 42,
      head_sha: null,
      action: "created",
      triggered_by: "issue_comment",
      comment_id: 9001,
      // note: The sweep resends this row verbatim: the bot ref replaces the old key
      // and the target id rides along.
      botRef: { appId: "bot-a" },
      targetId: targetA,
    });
    expect(claims[0]!.payload_json).not.toContain("appRef");
    expect(claims[1]).toEqual({ comment_id: 9002, state: "consumed", payload_json: null });
  });

  test("the bot row keeps only its own columns, and the ledger key moves to the target", () => {
    const db = createBeforeSplitD1();
    seedBeforeSplit(db);
    applySplit(db);

    expect(columnNames(db, "review_bots")).toEqual(BOT_COLUMNS);
    // invariant: Rows keep their values: the columns are dropped in place, nothing is copied.
    expect(
      db.raw
        .query("SELECT id, name, private_key_enc, webhook_secret_enc, github_slug, github_visibility, status FROM review_bots ORDER BY id")
        .all(),
    ).toEqual([
      {
        id: "bot-a",
        name: "Acme Reviewer",
        private_key_enc: "enc",
        webhook_secret_enc: "enc",
        github_slug: "acme-reviewer",
        github_visibility: "private",
        status: "active",
      },
      {
        id: "bot-b",
        name: "Widgets Reviewer",
        private_key_enc: "enc",
        webhook_secret_enc: "enc",
        github_slug: null,
        github_visibility: null,
        status: "active",
      },
    ]);
    // invariant: The parent keeps its own constraints.
    const insertBot = db.raw.prepare(
      `INSERT INTO review_bots (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, created_at, updated_at)
       VALUES (?, ?, 'fresh', 'enc', 'enc', 'mallory', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    expect(() => insertBot.run("bot-dup", 5001)).toThrow(/UNIQUE constraint failed/);
    insertBot.run("bot-c", 5003);
    expect(() => db.raw.prepare("UPDATE review_bots SET status = 'paused' WHERE id = 'bot-c'").run()).toThrow();

    // invariant: The PR ledger is untouched — nothing drops the parent its foreign key
    // cascades from — and the old per-bot key is replaced by the per-target one.
    expect(db.raw.query("SELECT id FROM pull_requests ORDER BY id").all()).toEqual([{ id: "pr-a" }, { id: "pr-b" }]);
    const indexes = schemaNames(db, "index");
    expect(indexes).toContain("idx_reviews_bot_id");
    expect(indexes).toContain("idx_reviews_target_id");
    expect(indexes).not.toContain("idx_pull_requests_bot_pr");
    const targetKey = (db.raw.query("PRAGMA index_list(pull_requests)").all() as Array<{ name: string; unique: number }>).find(
      (index) => index.name === "idx_pull_requests_target_pr",
    );
    expect(targetKey).toMatchObject({ unique: 1 });
    expect(
      (db.raw.query("PRAGMA index_info(idx_pull_requests_target_pr)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    ).toEqual(["target_id", "owner", "repo", "pr_number"]);
    expect(
      (db.raw.query("PRAGMA index_info(idx_reviews_target_id)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    ).toEqual(["target_id"]);

    // invariant: Every child still resolves the parent, and the two new
    // attribution columns resolve the target.
    for (const table of ["reviews", "pull_requests", "bot_installations", "review_targets"]) {
      expect(foreignKeyTargets(db, table, "bot_id"), `${table}.bot_id`).toEqual(["review_bots"]);
    }
    for (const table of ["reviews", "pull_requests", "target_owner_allowlist"]) {
      expect(foreignKeyTargets(db, table, "target_id"), `${table}.target_id`).toEqual(["review_targets"]);
    }
    expect(foreignKeyTargets(db, "review_targets", "workspace_id")).toEqual(["workspaces"]);
    expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("every guarded count is zero after the backfill, and no guard table survives", () => {
    const db = createBeforeSplitD1();
    seedBeforeSplit(db);
    applySplit(db);
    const count = (sql: string): number => (db.raw.query(sql).get() as { n: number }).n;

    expect(
      count(
        `SELECT COUNT(*) AS n FROM review_bots b
          WHERE NOT EXISTS (SELECT 1 FROM bot_workspaces w WHERE w.bot_id = b.id)`,
      ),
    ).toBe(0);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM review_bots b
          WHERE (SELECT COUNT(*) FROM review_targets t WHERE t.bot_id = b.id) <> 1`,
      ),
    ).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM reviews WHERE bot_id IS NOT NULL AND target_id IS NULL")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM pull_requests WHERE target_id IS NULL")).toBe(0);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM comment_trigger_claims
          WHERE state = 'queued' AND payload_json IS NOT NULL
            AND (json_extract(payload_json, '$.targetId') IS NULL
                 OR json_extract(payload_json, '$.appRef') IS NOT NULL)`,
      ),
    ).toBe(0);
    expect(schemaNames(db, "table").filter((name) => name.startsWith("guard_"))).toEqual([]);
  });

  test("fails the migration when a bot has no workspace row instead of skipping it", () => {
    const db = createBeforeSplitD1();
    seedBeforeSplit(db);
    // invariant: The INSERT…SELECT joins the workspace row, so an orphan bot would get no
    // target silently; the guard is what makes it fail.
    insertGithubAppRow(db, { id: "bot-orphan", githubAppId: 5003 });

    expect(() => applySplit(db)).toThrow(/guard_bot_without_workspace/);
  });

  test("fails the migration when a queued claim names a bot that has no target", () => {
    const db = createBeforeSplitD1();
    seedBeforeSplit(db);
    insertClaim(db, 9003, "queued", JSON.stringify({ appRef: { appId: "ghost-bot" }, owner: "acme" }));

    expect(() => applySplit(db)).toThrow(/guard_queued_claim_without_target/);
  });

  test("creates idx_review_targets_bot_id ON review_targets(bot_id)", () => {
    const db = createMigratedTestD1();
    const index = db.raw
      .query("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_targets_bot_id'")
      .get() as { tbl_name: string } | null;
    expect(index).not.toBeNull();
    expect(index!.tbl_name).toBe("review_targets");
    const columns = db.raw.query("PRAGMA index_info(idx_review_targets_bot_id)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((c) => c.name)).toEqual(["bot_id"]);
  });

  test("the per-bot target lookup uses the index, not a table scan (EXPLAIN QUERY PLAN)", () => {
    // note: 0067 replaced the single-column index with the composite `(bot_id,
    // repo_id)`: its leading column still answers a bare `bot_id` predicate, so
    // every dashboard read, webhook fallback and backfill UPDATE seeks.
    const db = createMigratedTestD1();
    const plan = db.raw
      .query("EXPLAIN QUERY PLAN SELECT id FROM review_targets WHERE bot_id = 'bot-1'")
      .all() as Array<{ detail: string }>;
    expect(plan.some((p) => p.detail.includes("USING INDEX idx_review_targets_bot_repo"))).toBe(true);
    expect(plan.some((p) => p.detail.includes("SCAN review_targets"))).toBe(false);
  });

  test("creates the target table with the shipped columns, defaults and checks", () => {
    const db = createMigratedTestD1();
    expect(columnNames(db, "review_targets")).toEqual(TARGET_COLUMNS);
    expect(columnNames(db, "reviews")).toContain("target_id");
    expect(columnNames(db, "pull_requests")).toContain("target_id");
    // note: 0067 dropped the installation-keyed identity and the owner allowlist.
    expect(schemaNames(db, "table")).not.toContain("app_owner_allowlist");
    expect(schemaNames(db, "table")).not.toContain("target_owner_allowlist");

    db.raw
      .prepare(
        `INSERT INTO review_bots (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, created_at, updated_at)
         VALUES ('bot-fresh', 7001, 'Fresh', 'enc', 'enc', 'mallory', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO review_targets (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
         VALUES ('target-fresh', 'default', 'bot-fresh', 'Fresh', 'mallory', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run();

    expect(
      db.raw
        .query(
          `SELECT review_enabled, review_trigger_mode, review_level, check_min_score, check_pass_verdicts,
                  follow_workspace_defaults, repo_id, repo_owner, repo_name, deleted_at
             FROM review_targets WHERE id = 'target-fresh'`,
        )
        .get(),
    ).toEqual({
      review_enabled: 1,
      review_trigger_mode: "every_push",
      review_level: null,
      check_min_score: 80,
      check_pass_verdicts: '["ship it"]',
      // note: 0067's added columns: a row created with its own config does not
      // inherit, and an unclaimed target carries no repository identity.
      follow_workspace_defaults: 0,
      repo_id: null,
      repo_owner: null,
      repo_name: null,
      deleted_at: null,
    });

    for (const [column, bad] of [
      ["review_trigger_mode", "always"],
      ["review_level", "medium"],
      ["check_min_score", 101],
      ["check_min_score", 80.5],
      ["check_pass_verdicts", "{not json"],
      ["follow_workspace_defaults", 2],
    ] as const) {
      expect(
        () => db.raw.prepare(`UPDATE review_targets SET ${column} = ? WHERE id = 'target-fresh'`).run(bad),
        `${column} = ${bad}`,
      ).toThrow();
    }
  });
});

describe("migrations/0058_review_bot_scope.sql", () => {
  const SCOPE_MIGRATION = "0058_review_bot_scope.sql";

  /** note: Production's shape at 0057: every file before this one, in order. */
  function preScopeDb(): TestD1 {
    const db = createTestD1();
    for (const name of migrationsAfter("0002_mstar_review_v1.sql").filter(
      (migration) => migrationNumber(migration) < migrationNumber(SCOPE_MIGRATION),
    )) {
      execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    return db;
  }

  function botColumns(db: TestD1): Array<{ name: string; notnull: number; dflt_value: unknown }> {
    return db.raw.query("PRAGMA table_info(review_bots)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
  }

  test("adds the two columns with the contract's NOT NULL default and nothing else", () => {
    const db = preScopeDb();
    db.raw
      .prepare(
        `INSERT INTO review_bots
           (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
            status, created_at, updated_at)
         VALUES ('bot-pre-scope', 9001, 'bot-pre-scope', 'enc', 'enc', 'acme',
                 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, SCOPE_MIGRATION), "utf8"));

    const columns = botColumns(db);
    expect(columns.find((c) => c.name === "scope")).toMatchObject({ notnull: 1 });
    expect(columns.find((c) => c.name === "scope")?.dflt_value).toBe("'owned'");
    expect(columns.find((c) => c.name === "shared_at")).toMatchObject({ notnull: 0, dflt_value: null });

    // note: A pre-column bot is owned and has never been shared: the default is the
    // whole backfill.
    expect(db.raw.query("SELECT scope, shared_at FROM review_bots WHERE id = 'bot-pre-scope'").get()).toEqual({
      scope: "owned",
      shared_at: null,
    });
  });

  test("the CHECK refuses an unknown scope and admits both contract values", () => {
    const db = createMigratedTestD1();
    db.raw
      .prepare(
        `INSERT INTO review_bots
           (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
            status, created_at, updated_at)
         VALUES ('bot-scope-check', 9002, 'bot-scope-check', 'enc', 'enc', 'acme',
                 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    expect(db.raw.query("SELECT scope, shared_at FROM review_bots WHERE id = 'bot-scope-check'").get()).toEqual({
      scope: "owned",
      shared_at: null,
    });

    for (const scope of ["shared", "owned"] as const) {
      db.raw.prepare("UPDATE review_bots SET scope = ? WHERE id = 'bot-scope-check'").run(scope);
      expect(db.raw.query("SELECT scope FROM review_bots WHERE id = 'bot-scope-check'").get()).toEqual({ scope });
    }

    for (const bad of ["global", "SHARED", "", "owned ", 1]) {
      expect(
        () => db.raw.prepare("UPDATE review_bots SET scope = ? WHERE id = 'bot-scope-check'").run(bad),
        `scope = ${String(bad)}`,
      ).toThrow();
    }
  });
});

/**
 * why: Migration 0081 retires the claim table the earlier migrations built: 0067
 * recreated it bot-level for a setup redirect this deployment never receives,
 * so the table's whole life is two statements — created by 0067, dropped here.
 */
describe("migrations/0081_drop_install_claims.sql", () => {
  const RETIRE = "0081_drop_install_claims.sql";
  const CREATE = "0067_repo_target_identity.sql";

  /** note: The schema exactly before 0067 — 0059's target-keyed claim table is live. */
  function dbAt0066(): TestD1 {
    const db = createTestD1();
    for (const name of migrationsAfter("0002_mstar_review_v1.sql").filter(
      (migration) => migrationNumber(migration) <= 66,
    )) {
      execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    return db;
  }

  test("0067 still recreates the claim table bot-level, so 0081 has something to drop", () => {
    const db = dbAt0066();
    // note: 0059's target-keyed table is what 0067 finds: same name, other key.
    expect(columnNames(db, "install_claims")).toContain("target_id");
    expect(columnNames(db, "install_claims")).not.toContain("bot_id");
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, CREATE), "utf8"));
    expect(schemaNames(db, "table")).toContain("install_claims");
    expect(columnNames(db, "install_claims")).toEqual([
      "id",
      "user_id",
      "workspace_id",
      "bot_id",
      "created_at",
      "expires_at",
      "consumed_at",
      "consumed_token",
    ]);
    expect(schemaNames(db, "index")).toEqual(
      expect.arrayContaining(["install_claims_user_open", "install_claims_live_bot"]),
    );
  });

  test("0081 removes the table and both of its indexes from the shipped schema", () => {
    const db = createMigratedTestD1();
    expect(schemaNames(db, "table")).not.toContain("install_claims");
    expect(schemaNames(db, "index")).not.toContain("install_claims_user_open");
    expect(schemaNames(db, "index")).not.toContain("install_claims_live_bot");
    // invariant: The retirement is the file's only statement: applying it over the
    // 0067-era schema leaves the claim table gone and nothing else touched.
    const before = dbAt0066();
    execMigrationScript(before.raw, readFileSync(join(MIGRATIONS_DIR, CREATE), "utf8"));
    const otherTables = schemaNames(before, "table").filter((name) => name !== "install_claims");
    execMigrationScript(before.raw, readFileSync(join(MIGRATIONS_DIR, RETIRE), "utf8"));
    expect(schemaNames(before, "table")).not.toContain("install_claims");
    expect(schemaNames(before, "table")).toEqual(otherTables);
  });
});

describe("migrations/0060_execution_ledger_target.sql", () => {
  const LEDGER_TARGET_MIGRATION = "0060_execution_ledger_target.sql";

  /** note: Production's shape at 0059: every file before this one, in order. */
  function preLedgerTargetDb(): TestD1 {
    const db = createTestD1();
    for (const name of migrationsAfter("0002_mstar_review_v1.sql").filter(
      (migration) => migrationNumber(migration) < migrationNumber(LEDGER_TARGET_MIGRATION),
    )) {
      execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    return db;
  }

  function applyLedgerTargetMigration(db: TestD1): void {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, LEDGER_TARGET_MIGRATION), "utf8"));
  }

  /**
   * note: One bot, its workspace mapping, one target, and the installation the bot
   * holds — the tuple a failure row reaches its bot through (it carries no
   * bot id of its own).
   */
  function seedParents(db: TestD1): void {
    db.raw
      .prepare(
        `INSERT INTO review_bots
           (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
            status, created_at, updated_at)
         VALUES ('bot-a', 9101, 'bot-a', 'enc', 'enc', 'acme', 'active',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.raw.prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('bot-a', 'default')").run();
    db.raw
      .prepare(
        `INSERT INTO review_targets (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
         VALUES ('target-a', 'default', 'bot-a', 'target-a', 'acme',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
         VALUES ('install-a', 'bot-a', 123, 'acme', datetime('now'))`,
      )
      .run();
  }

  /** note: The ledger row an execution row is attributed through. */
  function seedPullRequest(db: TestD1, id: string, prNumber: number): void {
    db.raw
      .prepare(
        `INSERT INTO pull_requests
           (id, bot_id, target_id, owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at)
         VALUES (?, 'bot-a', 'target-a', 'acme', 'widgets', ?, 'PR', 'open', 'sha',
                 datetime('now'), datetime('now'))`,
      )
      .run(id, prNumber);
  }

  function seedPublication(db: TestD1, id: string, prNumber: number): void {
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, created_ms, updated_ms)
         VALUES (?, 'bot-a', 123, 'acme', 'widgets', ?, 'sha', 'review', 'applied', '{}', 1, 1)`,
      )
      .run(id, prNumber);
  }

  function seedFinding(db: TestD1, id: string, prNumber: number): void {
    seedPublication(db, `pub-${id}`, prNumber);
    db.raw
      .prepare(
        `INSERT INTO review_findings
           (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
            first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
            first_seen_round, last_seen_round, state, created_ms, updated_ms)
         VALUES (?, 'bot-a', 123, 'acme', 'widgets', ?, 'finding-1', '{}',
                 ?, ?, 'sha', 'sha', 1, 1, 'open', 1, 1)`,
      )
      .run(id, prNumber, `pub-${id}`, `pub-${id}`);
  }

  function seedFailure(db: TestD1, id: string, prNumber: number): void {
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
         VALUES (?, 123, 'acme', 'widgets', ?, 'sha', 'runner', 'boom')`,
      )
      .run(id, prNumber);
  }

  function seedAuditEvent(db: TestD1, id: string): void {
    db.raw
      .prepare(
        `INSERT INTO audit_events (id, workspace_id, actor_login, action, created_at)
         VALUES (?, 'default', 'octocat', 'support.read', '2026-01-01T00:00:00.000Z')`,
      )
      .run(id);
  }

  function columns(db: TestD1, table: string): Array<{ name: string; notnull: number; dflt_value: unknown }> {
    return db.raw.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
  }

  test("adds a nullable target_id to both execution ledgers and to the audit log, and nothing else", () => {
    const db = preLedgerTargetDb();
    const before = {
      findings: columns(db, "review_findings").map((column) => column.name),
      failures: columns(db, "review_failures").map((column) => column.name),
      audit: columns(db, "audit_events").map((column) => column.name),
    };

    applyLedgerTargetMigration(db);

    for (const [table, prior] of [
      ["review_findings", before.findings],
      ["review_failures", before.failures],
      ["audit_events", before.audit],
    ] as const) {
      const after = columns(db, table);
      // invariant: Appended, never inserted mid-table: every pre-migration column keeps
      // its ordinal, so a `SELECT *` reader's positions do not shift.
      expect(after.map((column) => column.name).slice(0, prior.length), table).toEqual(prior);
      expect(after.map((column) => column.name), table).toEqual([...prior, "target_id"]);
      // invariant: Nullable on the add: a NOT NULL add would need a dummy default, and the
      // guard below is what refuses an unattributed row.
      expect(after.find((column) => column.name === "target_id"), table).toMatchObject({
        notnull: 0,
        dflt_value: null,
      });
    }
  });

  test("attributes every existing finding and failure through its pull-request row", () => {
    const db = preLedgerTargetDb();
    seedParents(db);
    seedPullRequest(db, "pr-42", 42);
    seedFinding(db, "finding-42", 42);
    seedFailure(db, "failure-42", 42);
    // note: An audit row predates the column and carries no target: the migration
    // adds the column without inventing attribution for history.
    seedAuditEvent(db, "audit-1");

    applyLedgerTargetMigration(db);

    expect(db.raw.query("SELECT id, target_id FROM review_findings").all()).toEqual([
      { id: "finding-42", target_id: "target-a" },
    ]);
    expect(db.raw.query("SELECT id, target_id FROM review_failures").all()).toEqual([
      { id: "failure-42", target_id: "target-a" },
    ]);
    expect(db.raw.query("SELECT id, target_id FROM audit_events").all()).toEqual([
      { id: "audit-1", target_id: null },
    ]);
  });

  test("leaves a finding whose PR row was swept NULL, and does not abort", () => {
    const db = preLedgerTargetDb();
    seedParents(db);
    // note: The ledger row is gone (the 90-day sweep removes terminal PRs), so no
    // target can ever be derived for this finding — the same history shape the
    // failures guard was narrowed for.
    seedFinding(db, "finding-orphan", 77);

    applyLedgerTargetMigration(db);

    expect(db.raw.query("SELECT id, target_id FROM review_findings").all()).toEqual([
      { id: "finding-orphan", target_id: null },
    ]);
  });

  test("leaves a failure whose PR row was swept NULL, and does not abort", () => {
    const db = preLedgerTargetDb();
    seedParents(db);
    // note: The PR ledger row is gone: no target can ever be derived for this
    // failure, which is the shape production history has (a pruned ledger).
    seedFailure(db, "failure-orphan", 77);

    applyLedgerTargetMigration(db);

    expect(db.raw.query("SELECT id, target_id FROM review_failures").all()).toEqual([
      { id: "failure-orphan", target_id: null },
    ]);
  });

  test("a moved installation resolves to the live binding, whichever order the rows were seeded", () => {
    // note: One installation, two binding rows: bot-a's is removed, bot-b's is live,
    // each with its own ledger row at the same PR key. The guard counts one live
    // candidate; the UPDATE must agree rather than take SQLite's scan order, so
    // both seeded orders must answer target-b.
    for (const liveFirst of [false, true]) {
      const db = preLedgerTargetDb();
      seedParents(db);
      seedPullRequest(db, "pr-42", 42);
      seedFailure(db, "failure-42", 42);
      db.raw
        .prepare(
          `INSERT INTO workspaces (id, slug, name, created_by, created_at)
           VALUES ('ws-other', 'ws-other', 'ws-other', 'acme', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO review_bots
             (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
              status, created_at, updated_at)
           VALUES ('bot-b', 9102, 'bot-b', 'enc', 'enc', 'acme', 'active',
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      db.raw
        .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('bot-b', 'ws-other')")
        .run();
      db.raw
        .prepare(
          `INSERT INTO review_targets (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
           VALUES ('target-b', 'ws-other', 'bot-b', 'target-b', 'acme',
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      // note: `seedParents` already gave bot-a an installation row; mark it removed
      // rather than inserting a second one (the pair is unique), then add the
      // live binding, in the order this iteration asks for.
      const removeA = (): void => {
        db.raw
          .prepare("UPDATE bot_installations SET removed_at = '2026-01-01T00:00:00.000Z' WHERE bot_id = 'bot-a'")
          .run();
      };
      const addLive = (): void => {
        db.raw
          .prepare(
            `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
             VALUES ('install-live', 'bot-b', 123, 'acme', datetime('now'))`,
          )
          .run();
      };
      if (liveFirst) {
        addLive();
        removeA();
      } else {
        removeA();
        addLive();
      }
      db.raw
        .prepare(
          `INSERT INTO pull_requests
             (id, bot_id, target_id, owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at)
           VALUES ('pr-b', 'bot-b', 'target-b', 'acme', 'widgets', 42, 'PR', 'open', 'sha',
                   datetime('now'), datetime('now'))`,
        )
        .run();

      applyLedgerTargetMigration(db);

      expect(
        db.raw.query("SELECT id, target_id FROM review_failures").all(),
        `liveFirst=${liveFirst}`,
      ).toEqual([{ id: "failure-42", target_id: "target-b" }]);
    }
  });

  test("refuses a finding whose bot resolves to two different targets", () => {
    const db = preLedgerTargetDb();
    seedParents(db);
    // note: The same shape as the failures case, on the findings path: one bot, two
    // ledger rows at the same (owner, repo, pr_number) under different targets.
    // Without the ambiguity guard the scalar subquery would pick one of them,
    // and the row would be invisible to the other workspace's face.
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES ('ws-other', 'ws-other', 'ws-other', 'acme', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO review_targets (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
         VALUES ('target-b', 'ws-other', 'bot-a', 'target-b', 'acme',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO pull_requests
           (id, bot_id, target_id, owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at)
         VALUES ('pr-b', 'bot-a', 'target-b', 'acme', 'widgets', 42, 'PR', 'open', 'sha',
                 datetime('now'), datetime('now'))`,
      )
      .run();
    seedPullRequest(db, "pr-a", 42);
    seedFinding(db, "finding-42", 42);

    expect(() => applyLedgerTargetMigration(db)).toThrow(
      "CHECK constraint failed: guard_findings_ambiguous_target",
    );
    expect(db.raw.query("SELECT id, target_id FROM review_findings").all()).toEqual([
      { id: "finding-42", target_id: null },
    ]);
  });

  test("an unattributed candidate row is not a candidate: both guards leave the NULL alone", () => {
    const db = preLedgerTargetDb();
    seedParents(db);
    // note: A pull_requests row exists at the key but carries no target of its own
    // (the column is nullable since 0057). Nothing can be derived from it, so
    // both ledgers must pass rather than abort — and must not read it as an
    // attribution the UPDATE missed.
    db.raw
      .prepare(
        `INSERT INTO pull_requests
           (id, bot_id, target_id, owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at)
         VALUES ('pr-null', 'bot-a', NULL, 'acme', 'widgets', 55, 'PR', 'open', 'sha',
                 datetime('now'), datetime('now'))`,
      )
      .run();
    seedFinding(db, "finding-55", 55);
    seedFailure(db, "failure-55", 55);

    applyLedgerTargetMigration(db);

    expect(db.raw.query("SELECT id, target_id FROM review_findings").all()).toEqual([
      { id: "finding-55", target_id: null },
    ]);
    expect(db.raw.query("SELECT id, target_id FROM review_failures").all()).toEqual([
      { id: "failure-55", target_id: null },
    ]);
  });

  test("refuses a failure whose installation resolves to two different targets", () => {
    const db = preLedgerTargetDb();
    seedParents(db);
    // note: A second bot in a second workspace, holding the SAME installation id and
    // its own pull-request row at the same key, pointing at its own target.
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES ('ws-other', 'ws-other', 'ws-other', 'acme', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO review_bots
           (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
            status, created_at, updated_at)
         VALUES ('bot-b', 9102, 'bot-b', 'enc', 'enc', 'acme', 'active',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.raw.prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('bot-b', 'ws-other')").run();
    db.raw
      .prepare(
        `INSERT INTO review_targets (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
         VALUES ('target-b', 'ws-other', 'bot-b', 'target-b', 'acme',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
         VALUES ('install-b', 'bot-b', 123, 'acme', datetime('now'))`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO pull_requests
           (id, bot_id, target_id, owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at)
         VALUES ('pr-b', 'bot-b', 'target-b', 'acme', 'widgets', 42, 'PR', 'open', 'sha',
                 datetime('now'), datetime('now'))`,
      )
      .run();
    seedPullRequest(db, "pr-a", 42);
    seedFailure(db, "failure-42", 42);

    // invariant: One row of several is NOT an attribution: the guard refuses before the
    // UPDATE, so nothing is written and no workspace reads a borrowed row.
    expect(() => applyLedgerTargetMigration(db)).toThrow(
      "CHECK constraint failed: guard_failures_ambiguous_target",
    );
    expect(db.raw.query("SELECT id, target_id FROM review_failures").all()).toEqual([
      { id: "failure-42", target_id: null },
    ]);
  });

  test("the tenant predicate is served by each ledger's own target index", () => {
    const db = createMigratedTestD1();
    for (const [index, table] of [
      ["idx_review_findings_target", "review_findings"],
      ["idx_review_failures_target", "review_failures"],
    ] as const) {
      expect(
        db.raw.query("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index),
        index,
      ).toEqual({ tbl_name: table });
      expect(
        (db.raw.query(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map((row) => row.name),
        index,
      ).toEqual(["target_id", "owner", "repo", "pr_number"]);
    }
  });
});

describe("migrations/0073_maintenance_replay_rotation_index.sql", () => {
  test("the replay drain is index-ordered, so a retained dead backlog is not sorted per selection", () => {
    const db = createMigratedTestD1();
    // why: The drain's own statement, not a copy: a change to its predicate or
    // ORDER BY must keep seeking the rotation index or fail here.
    const plan = db.raw
      .query(`EXPLAIN QUERY PLAN ${MAINTENANCE_REPLAY_OUTBOX_SQL}`)
      .all(JSON.stringify([]), 1) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("USING INDEX idx_review_failures_maintenance_replay_rotation");
    // invariant: The whole point: LIMIT stops the scan. A temp B-tree means the pending
    // set was read and sorted in full, which is the backlog-proportional work
    // the finding named.
    expect(details).not.toContain("TEMP B-TREE");
  });
});
