import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "./helpers";
import { RECONCILE_DEFAULTS } from "../../src/contracts/reconcile-settings";
import { listLineBatchRecovery } from "../../src/store/finding-lifecycle";

function capturing(db: TestD1, captured: string[]): TestD1 {
  return {
    ...db,
    prepare(sql) {
      captured.push(sql);
      return db.prepare(sql);
    },
  };
}

async function linePlan(db: TestD1): Promise<string> {
  const captured: string[] = [];
  await listLineBatchRecovery(capturing(db, captured), 1_000, RECONCILE_DEFAULTS.lifecycleSelectLimit);
  const sql = captured.find((s) => s.includes("FROM review_publications p"));
  expect(sql).toBeDefined();
  return (db.raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(0, 0) as Array<{ detail: string }>)
    .map(({ detail }) => detail)
    .join("\n");
}

describe("line-batch recovery on review_threads (EXPLAIN QUERY PLAN)", () => {
  test("the selection is driven from idx_thread_uncaptured, not from every applied publication", async () => {
    const detail = await linePlan(createMigratedTestD1());
    expect(detail).toMatch(/SCAN t USING COVERING INDEX idx_thread_uncaptured/);
    expect(detail).toMatch(/SEARCH p USING INDEX sqlite_autoindex_review_publications_1 \(id=\?\)/);
    expect(detail).not.toMatch(/^SCAN p\b/m);
  });

  test("a full-history publication index does not displace the partial one", async () => {
    const db = createMigratedTestD1();
    db.raw.run("CREATE INDEX IF NOT EXISTS idx_thread_publication ON review_threads (publication_id, review_id)");
    const detail = await linePlan(db);
    expect(detail).toMatch(/USING COVERING INDEX idx_thread_uncaptured/);
    expect(detail).not.toMatch(/^SCAN p\b/m);
  });
});
