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
import { createTestD1 } from "./helpers";
import type { D1Like } from "../../src/store/types";

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
