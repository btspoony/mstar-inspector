import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "./helpers";
import { listIncompleteSettlements } from "../../src/store/review-route-store";

function capturing(db: TestD1, captured: string[]): TestD1 {
  return {
    ...db,
    prepare(sql) {
      captured.push(sql);
      return db.prepare(sql);
    },
  };
}

describe("incomplete settlements on review_attempt_handoffs (EXPLAIN QUERY PLAN)", () => {
  test("the route reconcile seeks open settlements through idx_review_attempt_handoffs_settling", async () => {
    const db = createMigratedTestD1();
    const captured: string[] = [];
    await listIncompleteSettlements(capturing(db, captured), { settlingBeforeMs: 1_000, limit: 25 });
    const sql = captured.find((s) => s.includes("FROM review_attempt_handoffs"));
    expect(sql).toBeDefined();
    const detail = (db.raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(0, 0) as Array<{ detail: string }>)
      .map(({ detail }) => detail)
      .join("\n");
    expect(detail).toMatch(/SEARCH review_attempt_handoffs USING INDEX idx_review_attempt_handoffs_settling/);
    expect(detail).not.toMatch(/^SCAN review_attempt_handoffs$/m);
  });
});
