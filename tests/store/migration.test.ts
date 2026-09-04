/**
 * Migration tests (plan 05 Task 1 + plan 07 Task 4) — the DDL in
 * `migrations/0001_reviews.sql` + `0002_mstar_review_v1.sql` is the single
 * source of truth; these tests execute it verbatim through the bun:sqlite
 * test double and assert the schema contract:
 *   - reviews / findings tables + indexes exist
 *   - UNIQUE (installation_id, owner, repo, pr_number, head_sha) rejects a
 *     second row for the same sha (authoritative dedup, must not weaken)
 *   - head_sha is NOT NULL — an empty sha cannot be inserted
 *   - 0002 adds reviews.envelope: TEXT, nullable (M1 rows), CHECK
 *     json_valid for v1 rows
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedTestD1, createTestD1 } from "./helpers";
import type { TestD1 } from "./helpers";
import type { D1Like } from "../../src/store/types";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

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

describe("migrations/0001_reviews.sql", () => {
  test("creates reviews and findings tables with the expected columns", () => {
    const db = createTestD1();
    const reviews = db.raw.query("PRAGMA table_info(reviews)").all() as Array<{ name: string; notnull: number; pk: number }>;
    const reviewCols: Record<string, number> = Object.fromEntries(reviews.map((c) => [c.name, c.notnull]));
    const reviewPks: Record<string, number> = Object.fromEntries(reviews.map((c) => [c.name, c.pk]));

    expect(reviewPks["id"]).toBe(1); // TEXT PRIMARY KEY (SQLite does not imply NOT NULL)
    expect(reviewCols["id"]).toBe(0);
    expect(reviewCols["installation_id"]).toBe(1);
    expect(reviewCols["owner"]).toBe(1);
    expect(reviewCols["repo"]).toBe(1);
    expect(reviewCols["pr_number"]).toBe(1);
    expect(reviewCols["head_sha"]).toBe(1); // NOT NULL — empty sha must never be stored
    expect(reviewCols["verdict"]).toBe(1);
    expect("base_sha" in reviewCols).toBe(true);
    expect("reviewed_at" in reviewCols).toBe(true);
    expect("summary_md" in reviewCols).toBe(true);
    expect("model" in reviewCols).toBe(true);
    expect("provider" in reviewCols).toBe(true);
    expect("skill_version" in reviewCols).toBe(true);
    expect("raw_output" in reviewCols).toBe(true);
    expect("envelope" in reviewCols).toBe(true); // migration 0002

    const findings = db.raw.query("PRAGMA table_info(findings)").all() as Array<{ name: string; notnull: number; pk: number }>;
    const findingCols: Record<string, number> = Object.fromEntries(findings.map((c) => [c.name, c.notnull]));
    const findingPks: Record<string, number> = Object.fromEntries(findings.map((c) => [c.name, c.pk]));
    expect(findingPks["id"]).toBe(1); // TEXT PRIMARY KEY
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
  /** Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: ReturnType<typeof createTestD1>, name: string): void {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0006 with live rows)", () => {
    const db = createTestD1();
    // Reviews exist BEFORE the later migrations — the wrangler sequence on a
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
        `INSERT INTO github_apps (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
           created_by, status, deleted_at, created_at, updated_at)
         VALUES ('app-1', 'acmes-app', 1001, 'acmes-app', 'enc', 'enc', 'mallory', 'active', NULL,
           datetime('now'), datetime('now'))`,
      )
      .run();
    db.raw.exec("UPDATE reviews SET app_id = 'app-1' WHERE id = 'review-2'");

    // Metadata-only CREATE INDEX builds over the live rows without rewriting.
    expect(() => applyMigrationFile(db, "0007_reviews_app_id_index.sql")).not.toThrow();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(count.n).toBe(2);
  });

  test("creates idx_reviews_app_id ON reviews(app_id) (fully migrated schema)", () => {
    const db = createMigratedTestD1();
    const index = db.raw
      .query("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_reviews_app_id'")
      .get() as { tbl_name: string } | null;
    expect(index).not.toBeNull();
    expect(index!.tbl_name).toBe("reviews");
    const columns = db.raw.query("PRAGMA index_info(idx_reviews_app_id)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual(["app_id"]);
  });

  test("the per-App attribution lookup uses the index (EXPLAIN QUERY PLAN)", () => {
    const db = createMigratedTestD1();
    const plan = db.raw
      .query("EXPLAIN QUERY PLAN SELECT id FROM reviews WHERE app_id = 'app-1'")
      .all() as Array<{ detail: string }>;
    expect(plan.some((p) => p.detail.includes("USING INDEX idx_reviews_app_id"))).toBe(true);
  });
});

describe("migrations/0008_github_apps_ops.sql", () => {
  /** Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: ReturnType<typeof createTestD1>, name: string): void {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** Raw-insert one pre-0008-shaped github_apps row (the 0004 column list). */
  function insertPre0008App(db: ReturnType<typeof createTestD1>): void {
    db.raw
      .prepare(
        `INSERT INTO github_apps (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
           created_by, status, deleted_at, created_at, updated_at)
         VALUES ('app-1', 'acmes-app', 1001, 'acmes-app', 'enc', 'enc', 'mallory', 'active', NULL,
           datetime('now'), datetime('now'))`,
      )
      .run();
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0007 with live rows)", () => {
    const db = createTestD1();
    insertReview(db); // a live review predates the ALTER (wrangler order)
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

    // Metadata-only ADD COLUMNs alter the table without rewriting it (the
    // 0002/0005 precedent) — the live row survives untouched.
    expect(() => applyMigrationFile(db, "0008_github_apps_ops.sql")).not.toThrow();
    const row = db.raw
      .query("SELECT slug, status, review_enabled, last_webhook_at FROM github_apps WHERE id = 'app-1'")
      .get() as { slug: string; status: string; review_enabled: number; last_webhook_at: string | null };
    // Existing rows materialize to the resume default (L5: every App known
    // before the migration stays reviewing), last delivery never seen.
    expect(row.review_enabled).toBe(1);
    expect(row.last_webhook_at).toBeNull();
    expect(row.slug).toBe("acmes-app");
    expect(row.status).toBe("active");
    const count = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("adds review_enabled (INTEGER NOT NULL DEFAULT 1) + last_webhook_at (TEXT nullable) to github_apps", () => {
    const db = createMigratedTestD1();
    const columns = db.raw.query("PRAGMA table_info(github_apps)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const reviewEnabled = columns.find((col) => col.name === "review_enabled");
    expect(reviewEnabled).toBeDefined();
    expect(reviewEnabled!.notnull).toBe(1); // NOT NULL is legal with a non-NULL DEFAULT (L5)
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
      .query("SELECT review_enabled, last_webhook_at FROM github_apps WHERE id = 'app-1'")
      .get() as { review_enabled: number; last_webhook_at: string | null };
    expect(row.review_enabled).toBe(1);
    expect(row.last_webhook_at).toBeNull();
  });

  test("the ops columns are writable and read back (pause + last-delivery shapes)", () => {
    const db = createMigratedTestD1();
    insertPre0008App(db);
    db.raw.prepare("UPDATE github_apps SET review_enabled = 0, last_webhook_at = datetime('now') WHERE id = 'app-1'").run();
    const row = db.raw
      .query("SELECT review_enabled, last_webhook_at FROM github_apps WHERE id = 'app-1'")
      .get() as { review_enabled: number; last_webhook_at: string | null };
    expect(row.review_enabled).toBe(0);
    expect(row.last_webhook_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("migrations/0009_app_model_roles.sql", () => {
  /** Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: ReturnType<typeof createTestD1>, name: string): void {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** Raw-insert one github_apps row (the 0004 column list is sufficient). */
  function insertApp(db: ReturnType<typeof createTestD1>, id: string, githubAppId = 1001): void {
    db.raw
      .prepare(
        `INSERT INTO github_apps (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
           created_by, status, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'enc', 'enc', 'mallory', 'active', NULL,
           datetime('now'), datetime('now'))`,
      )
      .run(id, id, githubAppId, id);
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0008 with live rows)", () => {
    const db = createTestD1();
    insertReview(db); // a live review predates the CREATE TABLE (wrangler order)
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

    // Append-only CREATE TABLE over the live rows — nothing existing changes.
    expect(() => applyMigrationFile(db, "0009_app_model_roles.sql")).not.toThrow();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("composite PK (app_id, role) rejects a duplicate pair; other apps may repeat the role", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    insertApp(db, "app-2", 1002);
    db.raw
      .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES ('app-1', 'code-reviewer', 'openai/gpt-5')`)
      .run();
    expect(() =>
      db.raw
        .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES ('app-1', 'code-reviewer', 'x/y')`)
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    // The same role under ANOTHER app is a distinct row (per-App role maps).
    db.raw
      .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES ('app-2', 'code-reviewer', 'x/y')`)
      .run();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM app_model_roles").get() as { n: number };
    expect(count.n).toBe(2);
  });

  test("FK to github_apps — unknown app refused; a role not on the runner's seat names is storable (no CHECK — vocabulary is producer-side, lock L3)", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    expect(() =>
      db.raw
        .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES ('no-such-app', 'code-reviewer', 'x/y')`)
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    // Deliberate: the schema carries NO role CHECK — the store's MODEL_ROLE_IDS
    // mirror + parity test own the 4-name vocabulary (spec § B6 语义锁).
    db.raw
      .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES ('app-1', 'not-a-seat', 'x/y')`)
      .run();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM app_model_roles").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("no ON DELETE: hard-deleting an app with role rows is refused (soft-delete is the only removal path)", async () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    db.raw
      .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES ('app-1', 'mstar-review-seat', 'ark-plan/deepseek-v4-flash:high')`)
      .run();
    expect(() => db.raw.prepare("DELETE FROM github_apps WHERE id = 'app-1'").run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe("migrations/0010_review_failures.sql", () => {
  /** Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: ReturnType<typeof createTestD1>, name: string): void {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** Raw-insert one failure row (full column control). */
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
    insertReview(db); // a live review predates the CREATE TABLE (wrangler order)
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

    // Append-only CREATE TABLE over the live rows — nothing existing changes.
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

    // A NULL in any one of the NOT NULL columns is refused while the rest
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
      // The nulled column is only known at runtime; the cast restores the
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
    // Even a nonsense stage stores — the store leaf's FAILURE_STAGES gate is
    // the enforcement point, never the schema.
    insertFailure(db, { id: "failure-4", stage: "not-a-stage" });
    const count = db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get() as { n: number };
    expect(count.n).toBe(4);
  });

  test("rows are per-attempt events — the five-tuple is NOT unique; head_sha may be empty (pre-checkout failure)", () => {
    const db = createMigratedTestD1();
    insertFailure(db);
    insertFailure(db, { id: "failure-2" }); // same sha, attempt 2 (retry)
    insertFailure(db, { id: "failure-3", head_sha: "" }); // failed before the checkout resolved
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

describe("migrations/0002_mstar_review_v1.sql", () => {
  test("adds the envelope column to reviews (TEXT, nullable)", async () => {
    const db = createTestD1();
    // The M1-era insert path (no envelope) is unchanged by the ALTER, and a
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
    // NULL envelope is legal — every M1-era row keeps envelope NULL.
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
  /** Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0010 with live rows)", () => {
    const db = createTestD1();
    insertReview(db); // a live review AND finding predate the CREATE INDEX
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

    // Metadata-only CREATE INDEX builds over the live rows without rewriting.
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
    // Mirrors the 0007 index assertion: on the fully migrated (empty) schema
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
  /** Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0013 with live rows)", () => {
    const db = createTestD1();
    insertReview(db); // a live review predates the CREATE INDEX
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

    // Metadata-only CREATE INDEX builds over the live rows without rewriting.
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
    // The plan-22 window predicate `reviewed_at >= datetime('now', …)` is a
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

describe("migrations/0016_users_login_nocase_unique.sql (plan 34 QC W-1)", () => {
  /** Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  test("applies cleanly over a seeded production-shaped DB (0003 users with live rows)", () => {
    const db = createTestD1();
    applyMigrationFile(db, "0003_dashboard_users.sql");
    db.raw
      .prepare("INSERT INTO users (id, github_login, role, created_at) VALUES (?, ?, ?, ?)")
      .run("u-1", "OctoCat", "admin", "2026-01-01T00:00:00.000Z");
    // Metadata-only CREATE UNIQUE INDEX builds over the live rows without
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
    // The 0003 BINARY UNIQUE does not fire across case variants — the 0016
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

describe("migrations/0017_app_model_chains.sql (plan 35 T2, spec §4.4)", () => {
  /** Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: TestD1, name: string): void {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** Raw-insert one github_apps row (the 0004 column list is sufficient). */
  function insertApp(db: TestD1, id: string, githubAppId = 1001): void {
    db.raw
      .prepare(
        `INSERT INTO github_apps (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
           created_by, status, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'enc', 'enc', 'mallory', 'active', NULL,
           datetime('now'), datetime('now'))`,
      )
      .run(id, id, githubAppId, id);
  }

  /** The pre-chains shape (0001–0016) with live app_model_config / app_model_roles rows. */
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
      .prepare(`INSERT INTO app_model_config (app_id, model_chain, updated_at) VALUES ('app-1', 'ark-plan/deepseek-v4-flash', datetime('now'))`)
      .run();
    db.raw
      .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES ('app-1', 'code-reviewer', 'openai/gpt-5')`)
      .run();
    // Append-only CREATE TABLE + backfill DML over the live rows — nothing
    // existing changes (the first INSERT…SELECT in the migration set).
    expect(() => applyMigrationFile(db, "0017_app_model_chains.sql")).not.toThrow();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("backfill: app_model_config non-NULL chain → the 'default' row (is_default=1); NULL/absent → no default row", () => {
    const db = createPreChainsDb();
    insertApp(db, "app-1");
    insertApp(db, "app-2", 1002);
    // app-1 has a chain; app-2 has a NULL chain row; app-3 has no row at all.
    db.raw
      .prepare(`INSERT INTO app_model_config (app_id, model_chain, updated_at) VALUES ('app-1', 'ark-plan/deepseek-v4-flash, openai/gpt-5:thinking', datetime('now'))`)
      .run();
    db.raw
      .prepare(`INSERT INTO app_model_config (app_id, model_chain, updated_at) VALUES ('app-2', NULL, datetime('now'))`)
      .run();
    applyMigrationFile(db, "0017_app_model_chains.sql");
    const rows = db.raw
      .query("SELECT app_id, name, chain, is_default FROM app_model_chains ORDER BY app_id")
      .all() as Array<{ app_id: string; name: string; chain: string; is_default: number }>;
    // Exactly one default row, holding the verbatim chain (byte-identical).
    expect(rows).toEqual([
      { app_id: "app-1", name: "default", chain: "ark-plan/deepseek-v4-flash, openai/gpt-5:thinking", is_default: 1 },
    ]);
  });

  test("backfill: every app_model_roles row → one 'seat-<role>' named chain + the seat reference row", () => {
    const db = createPreChainsDb();
    insertApp(db, "app-1");
    db.raw
      .prepare(`INSERT INTO app_model_config (app_id, model_chain, updated_at) VALUES ('app-1', 'ark-plan/deepseek-v4-flash', datetime('now'))`)
      .run();
    db.raw
      .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES ('app-1', 'mstar-review-seat', 'ark-plan/deepseek-v4-flash:high')`)
      .run();
    db.raw
      .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES ('app-1', 'code-reviewer', 'openai/gpt-5:thinking, anthropic/claude-x')`)
      .run();
    applyMigrationFile(db, "0017_app_model_chains.sql");
    const chains = db.raw
      .query("SELECT name, chain, is_default FROM app_model_chains WHERE app_id = 'app-1' ORDER BY name")
      .all() as Array<{ name: string; chain: string; is_default: number }>;
    expect(chains).toEqual([
      { name: "default", chain: "ark-plan/deepseek-v4-flash", is_default: 1 },
      { name: "seat-code-reviewer", chain: "openai/gpt-5:thinking, anthropic/claude-x", is_default: 0 },
      { name: "seat-mstar-review-seat", chain: "ark-plan/deepseek-v4-flash:high", is_default: 0 },
    ]);
    const seats = db.raw
      .query("SELECT role, chain_name FROM app_model_chain_seats WHERE app_id = 'app-1' ORDER BY role")
      .all() as Array<{ role: string; chain_name: string }>;
    expect(seats).toEqual([
      { role: "code-reviewer", chain_name: "seat-code-reviewer" },
      { role: "mstar-review-seat", chain_name: "seat-mstar-review-seat" },
    ]);
  });

  test("app_model_chains: composite PK (app_id, name) rejects a duplicate pair; other apps may repeat the name", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    insertApp(db, "app-2", 1002);
    db.raw
      .prepare(`INSERT INTO app_model_chains (app_id, name, chain, is_default, created_at, updated_at) VALUES ('app-1', 'fast', 'openai/gpt-5', 0, datetime('now'), datetime('now'))`)
      .run();
    expect(() =>
      db.raw
        .prepare(`INSERT INTO app_model_chains (app_id, name, chain, is_default, created_at, updated_at) VALUES ('app-1', 'fast', 'x/y', 0, datetime('now'), datetime('now'))`)
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    // The same name under ANOTHER app is a distinct row (per-App chains).
    db.raw
      .prepare(`INSERT INTO app_model_chains (app_id, name, chain, is_default, created_at, updated_at) VALUES ('app-2', 'fast', 'x/y', 0, datetime('now'), datetime('now'))`)
      .run();
    const count = db.raw.query("SELECT COUNT(*) AS n FROM app_model_chains").get() as { n: number };
    expect(count.n).toBe(2);
  });

  test("app_model_chain_seats: composite PK (app_id, role) rejects a duplicate pair; FK to github_apps enforced", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    db.raw
      .prepare(`INSERT INTO app_model_chains (app_id, name, chain, is_default, created_at, updated_at) VALUES ('app-1', 'fast', 'openai/gpt-5', 0, datetime('now'), datetime('now'))`)
      .run();
    db.raw
      .prepare(`INSERT INTO app_model_chain_seats (app_id, role, chain_name) VALUES ('app-1', 'code-reviewer', 'fast')`)
      .run();
    expect(() =>
      db.raw
        .prepare(`INSERT INTO app_model_chain_seats (app_id, role, chain_name) VALUES ('app-1', 'code-reviewer', 'fast')`)
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      db.raw
        .prepare(`INSERT INTO app_model_chain_seats (app_id, role, chain_name) VALUES ('no-such-app', 'code-reviewer', 'fast')`)
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("no ON DELETE: hard-deleting an app with chain rows is refused (soft-delete is the only removal path)", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-1");
    db.raw
      .prepare(`INSERT INTO app_model_chains (app_id, name, chain, is_default, created_at, updated_at) VALUES ('app-1', 'default', 'openai/gpt-5', 1, datetime('now'), datetime('now'))`)
      .run();
    db.raw
      .prepare(`INSERT INTO app_model_chain_seats (app_id, role, chain_name) VALUES ('app-1', 'code-reviewer', 'default')`)
      .run();
    expect(() => db.raw.prepare("DELETE FROM github_apps WHERE id = 'app-1'").run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});
