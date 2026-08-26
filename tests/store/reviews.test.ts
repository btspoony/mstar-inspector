/**
 * Repository layer tests (plan 05 Task 2) — `src/store/reviews.ts` against the
 * bun:sqlite test double running the real migration SQL (DDL single source).
 *
 * Acceptance points (brief T2 / plan Done criteria):
 *   - second insertReview for the same sha → { outcome: "duplicate" }, table
 *     still 1 row, no duplicate findings
 *   - findings rows are written 1:1 from ReviewOutput.findings
 *   - raw_output is truncated at 64KB (byte-exact)
 *   - empty head_sha cannot be inserted (store-layer rejection)
 */
import { describe, expect, test } from "bun:test";
import { createReviewStore } from "../../src/store/reviews";
import { createTestD1 } from "./helpers";
import type { ReviewInsert, ReviewRow } from "../../src/store/types";
import type { ReviewOutput } from "../../src/review/schema";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function output(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    verdict: "comment",
    summary_md: "No blocking issues.",
    findings: [
      {
        severity: "warning",
        category: "logic",
        file_path: "src/a.ts",
        line_start: 10,
        line_end: 12,
        title: "Null deref risk",
        body: "body",
        fingerprint_hint: "fp-1",
      },
    ],
    ...overrides,
  };
}

function insert(overrides: Partial<ReviewInsert> = {}): ReviewInsert {
  return {
    key: { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 42, head_sha: SHA },
    output: output(),
    raw: JSON.stringify({ verdict: "comment" }),
    ...overrides,
  };
}

describe("createReviewStore().insertReview", () => {
  test("inserts a review row and returns { outcome: 'inserted' } with the new id", async () => {
    const db = createTestD1();
    const store = createReviewStore(db);

    const result = await store.insertReview(insert());

    expect(result).toEqual({ outcome: "inserted", reviewId: expect.any(String) });
    if (result.outcome !== "inserted") throw new Error("expected inserted");
    const row = db.raw.query("SELECT * FROM reviews").get() as ReviewRow;
    expect(row.id).toBe(result.reviewId);
    expect(row.installation_id).toBe(123);
    expect(row.owner).toBe("acme");
    expect(row.repo).toBe("widgets");
    expect(row.pr_number).toBe(42);
    expect(row.head_sha).toBe(SHA);
    expect(row.verdict).toBe("comment");
    expect(row.summary_md).toBe("No blocking issues.");
    expect(row.raw_output).toBe(JSON.stringify({ verdict: "comment" }));
  });

  test("second insert for the same sha → { outcome: 'duplicate' }, still 1 review row, no duplicate findings", async () => {
    const db = createTestD1();
    const store = createReviewStore(db);

    const first = await store.insertReview(insert());
    const second = await store.insertReview(insert({ raw: "different raw" }));

    expect(first).toEqual({ outcome: "inserted", reviewId: expect.any(String) });
    expect(second).toEqual({ outcome: "duplicate" });

    const reviews = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviews.n).toBe(1);
    const findings = db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number };
    expect(findings.n).toBe(1);
  });

  test("findings rows are written 1:1 with fingerprint_hint stored in the fingerprint column", async () => {
    const db = createTestD1();
    const store = createReviewStore(db);

    const result = await store.insertReview(
      insert({
        output: output({
          findings: [
            {
              severity: "critical",
              category: "security",
              file_path: "src/b.ts",
              line_start: 1,
              line_end: 1,
              title: "Secrets in code",
              body: "b1",
              fingerprint_hint: "fp-sec",
            },
            {
              severity: "info",
              category: "style",
              file_path: null,
              line_start: null,
              line_end: null,
              title: "Nit",
              body: "b2",
            },
          ],
        }),
      }),
    );

    const rows = db.raw.query("SELECT * FROM findings ORDER BY title").all() as Array<{
      review_id: string;
      severity: string;
      category: string;
      file_path: string | null;
      line_start: number | null;
      line_end: number | null;
      title: string;
      body: string;
      fingerprint: string | null;
      status: string | null;
    }>;
    expect(rows).toHaveLength(2);
    if (result.outcome !== "inserted") throw new Error("expected inserted");
    for (const row of rows) {
      expect(row.review_id).toBe(result.reviewId);
      expect(row.status).toBe("open"); // column default
    }
    expect(rows[0]).toMatchObject({
      severity: "info",
      category: "style",
      file_path: null,
      line_start: null,
      line_end: null,
      title: "Nit",
      body: "b2",
      fingerprint: null,
    });
    expect(rows[1]).toMatchObject({
      severity: "critical",
      category: "security",
      file_path: "src/b.ts",
      line_start: 1,
      line_end: 1,
      title: "Secrets in code",
      body: "b1",
      fingerprint: "fp-sec",
    });
  });

  test("raw_output is truncated to 64KB of UTF-8 bytes", async () => {
    const db = createTestD1();
    const store = createReviewStore(db);

    const big = "x".repeat(70 * 1024);
    await store.insertReview(insert({ raw: big }));

    const row = db.raw.query("SELECT raw_output FROM reviews").get() as { raw_output: string };
    expect(new TextEncoder().encode(row.raw_output).byteLength).toBe(64 * 1024);
  });

  test("raw_output under 64KB is stored verbatim", async () => {
    const db = createTestD1();
    const store = createReviewStore(db);

    const raw = JSON.stringify({ verdict: "comment", note: "small" });
    await store.insertReview(insert({ raw }));

    const row = db.raw.query("SELECT raw_output FROM reviews").get() as { raw_output: string };
    expect(row.raw_output).toBe(raw);
  });

  test("an empty head_sha cannot be inserted (store-layer rejection)", async () => {
    const db = createTestD1();
    const store = createReviewStore(db);

    await expect(
      store.insertReview(insert({ key: { ...insert().key, head_sha: "" } })),
    ).rejects.toThrow(/head_sha must be a non-empty string/);

    const reviews = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviews.n).toBe(0);
  });

  test("model and skill_version are stored when provided, null otherwise", async () => {
    const db = createTestD1();
    const store = createReviewStore(db);

    await store.insertReview(insert({ model: "gpt-5", skill_version: "1.2.3" }));
    const row = db.raw.query("SELECT model, skill_version FROM reviews").get() as {
      model: string | null;
      skill_version: string | null;
    };
    expect(row).toEqual({ model: "gpt-5", skill_version: "1.2.3" });

    const db2 = createTestD1();
    const store2 = createReviewStore(db2);
    await store2.insertReview(insert());
    const row2 = db2.raw.query("SELECT model, skill_version FROM reviews").get() as {
      model: string | null;
      skill_version: string | null;
    };
    expect(row2).toEqual({ model: null, skill_version: null });
  });
});

describe("createReviewStore().findByIdempotencyKey", () => {
  test("returns the row for an existing key and null for an unknown key", async () => {
    const db = createTestD1();
    const store = createReviewStore(db);

    const input = insert();
    await store.insertReview(input);

    const found = await store.findByIdempotencyKey(input.key);
    expect(found).not.toBeNull();
    expect(found?.head_sha).toBe(SHA);
    expect(found?.owner).toBe("acme");

    const missing = await store.findByIdempotencyKey({ ...input.key, head_sha: "ffffffffffffffffffffffffffffffffffffffff" });
    expect(missing).toBeNull();
  });
});

describe("createReviewStore().listByRepo", () => {
  test("returns reviews for the repo, newest first, honoring limit", async () => {
    const db = createTestD1();
    const store = createReviewStore(db);

    await store.insertReview(insert({ key: { ...insert().key, head_sha: SHA } }));
    await store.insertReview(
      insert({ key: { ...insert().key, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }),
    );
    await store.insertReview(
      insert({ key: { ...insert().key, head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }),
    );
    // A different repo must not leak in.
    await store.insertReview(
      insert({ key: { ...insert().key, repo: "other", head_sha: "cccccccccccccccccccccccccccccccccccccccc" } }),
    );

    // reviewed_at has 1-second resolution (datetime('now')) — pin distinct
    // timestamps so the ORDER BY reviewed_at DESC contract is deterministic.
    const shas = [SHA, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"];
    for (const [i, sha] of shas.entries()) {
      db.raw
        .query("UPDATE reviews SET reviewed_at = ? WHERE head_sha = ?")
        .run(`2026-08-26 00:00:0${i}`, sha);
    }

    const all = await store.listByRepo("acme", "widgets");
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.head_sha)).toEqual([
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      SHA,
    ]);

    const limited = await store.listByRepo("acme", "widgets", 2);
    expect(limited).toHaveLength(2);
  });
});
