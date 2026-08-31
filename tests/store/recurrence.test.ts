/**
 * Cross-PR recurrence aggregation contract lock (plan 21 Task 4, AC-21c) —
 * the store-layer query consumed by plan 22 (review-health-insights) for the
 * "复现 top" panel.
 *
 * `recurrenceByFingerprint` groups findings by fingerprint across reviews:
 *   - count = number of DISTINCT reviews containing the fingerprint; only
 *     count >= 2 groups are returned (recurrence definition, AL-21-2)
 *   - repos = distinct owner/repo pairs among those reviews
 *   - title_sample = any one title for the fingerprint (MIN, deterministic)
 *   - NULL fingerprints excluded — the era gate (pre-v0.8 rows were never
 *     backfilled, AC-21c)
 *   - optional repo filter (owner/repo pair) and window filter
 *     (reviews.reviewed_at within the last window_days; omitted = all-time)
 *
 * Fixtures seed through the REAL store.put where possible (exercises the
 * Task 2 persist-path fingerprint write end to end); era/window fixtures
 * raw-insert rows for explicit envelope / reviewed_at control.
 */
import { describe, expect, test } from "bun:test";
import type { MstarReviewFinding, MstarReviewV1 } from "@mstar-harness/engine";
import { createArtifactStore, recurrenceByFingerprint } from "../../src/store/artifact-store";
import { computeFindingFingerprint } from "../../src/store/fingerprint";
import { idemKey } from "../../src/contracts/idem";
import { createMigratedTestD1, type TestD1 } from "./helpers";

function payload(findings: MstarReviewFinding[]): MstarReviewV1 {
  return { schema: "mstar.review/v1", verdict: "needs fixes", summary_md: "No blocking issues.", findings };
}

/**
 * A finding that normalizes to the SAME fingerprint across reviews: same
 * file_path, same N=10 line bucket (line_start 10 → bucket "1"), same
 * normalized title. The two spellings below ("Null deref risk" vs
 * "Null Deref Risk!") normalize identically (lowercase + trailing
 * punctuation strip) — pinning that recurrence groups across title
 * surface variation.
 */
function recurringFinding(title = "Null deref risk"): MstarReviewFinding {
  return {
    mergeClass: "should-fix",
    category: "logic",
    file_path: "src/a.ts",
    line_start: 10,
    line_end: 12,
    title,
    body: "body",
  };
}

/** A finding with a fingerprint no other fixture shares. */
function uniqueFinding(title = "Unique issue"): MstarReviewFinding {
  return { mergeClass: "nit", category: "style", file_path: "src/b.ts", line_start: 1, title, body: "b" };
}

async function putReview(
  db: TestD1,
  key: { installation_id: number; owner: string; repo: string; pr_number: number; head_sha: string },
  findings: MstarReviewFinding[],
): Promise<void> {
  const store = createArtifactStore(db);
  await store.put({ kind: "review", key: idemKey(key), schema: "mstar.review/v1", payload: payload(findings) });
}

/**
 * Raw-insert a review + one finding with explicit control over
 * `reviewed_at` (SQLite datetime expression, same format the column
 * default writes) and `envelope` (era marker). Used by the window/era
 * fixtures where store.put's `datetime('now')` default is not enough.
 */
function rawReviewWithFinding(
  db: TestD1,
  opts: {
    id: string;
    owner: string;
    repo: string;
    pr_number: number;
    daysAgo: number;
    title: string;
    fingerprint: string | null;
    envelope?: string | null;
  },
): void {
  db.raw
    .query(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, summary_md, envelope)
       VALUES (?, 123, ?, ?, ?, 'sha', datetime('now', '-' || ? || ' days'), 'needs fixes', 's', ?)`,
    )
    .run(opts.id, opts.owner, opts.repo, opts.pr_number, opts.daysAgo, opts.envelope ?? null);
  db.raw
    .query(
      `INSERT INTO findings (id, review_id, severity, title, body, fingerprint)
       VALUES (?, ?, 'should-fix', ?, 'b', ?)`,
    )
    .run(`${opts.id}-f`, opts.id, opts.title, opts.fingerprint);
}

describe("recurrenceByFingerprint", () => {
  test("same fingerprint across 2 PRs in different repos → count 2 + repos aggregated", async () => {
    const db = createMigratedTestD1();
    await putReview(
      db,
      { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 1, head_sha: "a".repeat(40) },
      [recurringFinding("Null deref risk")],
    );
    await putReview(
      db,
      { installation_id: 123, owner: "other", repo: "lib", pr_number: 2, head_sha: "b".repeat(40) },
      [recurringFinding("Null Deref Risk!")],
    );
    // A single-occurrence fingerprint must NOT be returned (count=1).
    await putReview(
      db,
      { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 3, head_sha: "c".repeat(40) },
      [uniqueFinding()],
    );

    const rows = await recurrenceByFingerprint(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fingerprint).toBe(computeFindingFingerprint(recurringFinding("Null deref risk")));
    // title_sample = any one title for the fingerprint (surface variation allowed).
    expect(["Null deref risk", "Null Deref Risk!"]).toContain(rows[0]!.title_sample);
    expect(rows[0]!.count).toBe(2);
    expect(rows[0]!.repos).toEqual(["acme/widgets", "other/lib"]);
  });

  test("count=1 fingerprints are excluded (recurrence = count >= 2)", async () => {
    const db = createMigratedTestD1();
    await putReview(
      db,
      { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 1, head_sha: "a".repeat(40) },
      [uniqueFinding("Issue one")],
    );
    await putReview(
      db,
      { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 2, head_sha: "b".repeat(40) },
      [uniqueFinding("Issue two")],
    );

    expect(await recurrenceByFingerprint(db)).toEqual([]);
  });

  test("NULL fingerprints are excluded (era: pre-v0.8 rows never backfilled, AC-21c)", async () => {
    const db = createMigratedTestD1();
    // Two v1 reviews sharing a fingerprint → count 2.
    await putReview(
      db,
      { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 1, head_sha: "a".repeat(40) },
      [recurringFinding()],
    );
    await putReview(
      db,
      { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 2, head_sha: "b".repeat(40) },
      [recurringFinding()],
    );
    // M1-era review (envelope NULL) whose finding would match the group IF
    // it carried a fingerprint — it is NULL, so it must not inflate count.
    rawReviewWithFinding(db, {
      id: "m1-row",
      owner: "acme",
      repo: "widgets",
      pr_number: 99,
      daysAgo: 0,
      title: "Null deref risk",
      fingerprint: null,
      envelope: null,
    });
    // A NULL-fingerprint finding under a v1 review is excluded the same way.
    const v1 = db.raw.query("SELECT id FROM reviews WHERE pr_number = 1").get() as { id: string };
    db.raw
      .query(
        `INSERT INTO findings (id, review_id, severity, title, body, fingerprint)
         VALUES ('null-fp-v1', ?, 'nit', 'Null deref risk', 'b', NULL)`,
      )
      .run(v1.id);

    const rows = await recurrenceByFingerprint(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
    expect(rows[0]!.repos).toEqual(["acme/widgets"]);
  });

  test("repo filter restricts the aggregation to one owner/repo pair", async () => {
    const db = createMigratedTestD1();
    // Same fingerprint in acme/widgets (2 PRs) and other/lib (1 PR).
    await putReview(
      db,
      { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 1, head_sha: "a".repeat(40) },
      [recurringFinding()],
    );
    await putReview(
      db,
      { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 2, head_sha: "b".repeat(40) },
      [recurringFinding()],
    );
    await putReview(
      db,
      { installation_id: 123, owner: "other", repo: "lib", pr_number: 3, head_sha: "c".repeat(40) },
      [recurringFinding()],
    );

    const all = await recurrenceByFingerprint(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.count).toBe(3);
    expect(all[0]!.repos).toEqual(["acme/widgets", "other/lib"]);

    const filtered = await recurrenceByFingerprint(db, { repo: { owner: "acme", repo: "widgets" } });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.count).toBe(2);
    expect(filtered[0]!.repos).toEqual(["acme/widgets"]);

    expect(await recurrenceByFingerprint(db, { repo: { owner: "nope", repo: "missing" } })).toEqual([]);
  });

  test("window filter keeps only reviews reviewed within the last window_days", async () => {
    const db = createMigratedTestD1();
    const fp = computeFindingFingerprint(recurringFinding());
    rawReviewWithFinding(db, {
      id: "r-recent",
      owner: "acme",
      repo: "widgets",
      pr_number: 1,
      daysAgo: 1,
      title: "Null deref risk",
      fingerprint: fp,
      envelope: "{}",
    });
    rawReviewWithFinding(db, {
      id: "r-old",
      owner: "acme",
      repo: "widgets",
      pr_number: 2,
      daysAgo: 40,
      title: "Null deref risk",
      fingerprint: fp,
      envelope: "{}",
    });

    // window_days=30 → only the recent review → count 1 → excluded.
    expect(await recurrenceByFingerprint(db, { window_days: 30 })).toEqual([]);
    // window_days=60 → both reviews → count 2.
    const wide = await recurrenceByFingerprint(db, { window_days: 60 });
    expect(wide).toHaveLength(1);
    expect(wide[0]!.count).toBe(2);
    // Omitted window_days → all-time → count 2.
    const all = await recurrenceByFingerprint(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.count).toBe(2);
  });

  test("records EXPLAIN QUERY PLAN (recording only — planner choice NOT asserted, AL-21-2)", async () => {
    const db = createMigratedTestD1();
    await putReview(
      db,
      { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 1, head_sha: "a".repeat(40) },
      [recurringFinding()],
    );
    await putReview(
      db,
      { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 2, head_sha: "b".repeat(40) },
      [recurringFinding()],
    );
    // Canonical SQL mirroring recurrenceByFingerprint's default (no-filter)
    // query — kept in sync with src/store/artifact-store.ts. The plan is
    // RECORDED in the test output for the record; asserting the planner
    // picks idx_findings_fingerprint is brittle across SQLite versions
    // (AL-21-2). Index existence is locked by tests/store/migration.test.ts.
    const plan = db.raw
      .query(
        `EXPLAIN QUERY PLAN
         SELECT f.fingerprint, MIN(f.title), COUNT(DISTINCT f.review_id), GROUP_CONCAT(DISTINCT r.owner || '/' || r.repo)
         FROM findings f JOIN reviews r ON r.id = f.review_id
         WHERE f.fingerprint IS NOT NULL
         GROUP BY f.fingerprint
         HAVING COUNT(DISTINCT f.review_id) >= 2`,
      )
      .all() as Array<{ id: number; parent: number; notused: number; detail: string }>;
    console.log("EXPLAIN QUERY PLAN (recurrenceByFingerprint):");
    for (const step of plan) console.log(`  ${step.detail}`);
    expect(plan.length).toBeGreaterThan(0);
  });
});
