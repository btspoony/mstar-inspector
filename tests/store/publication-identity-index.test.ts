import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "./helpers";
import { listUnpublishedLaunchSettlements } from "../../src/store/review-route-store";

function capturing(db: TestD1, captured: string[]): TestD1 {
  return {
    ...db,
    prepare(sql) {
      captured.push(sql);
      return db.prepare(sql);
    },
  };
}

function plan(db: TestD1, sql: string): string {
  const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 0);
  return (db.raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map(({ detail }) => detail)
    .join("\n");
}

describe("the attempt-identity journal probe (EXPLAIN QUERY PLAN)", () => {
  test("seeks by the scope-prefixed attempt identity, never scanning the publication history", async () => {
    const db = createMigratedTestD1();
    const captured: string[] = [];
    await listUnpublishedLaunchSettlements(capturing(db, captured), { deadlineBeforeMs: 1_000, limit: 25 });
    const sql = captured.find((statement) => statement.includes("FROM review_publications p"));
    expect(sql).toBeDefined();
    const detail = plan(db, sql!);
    expect(detail).toMatch(/idx_review_publications_attempt_identity/);
    expect(detail).not.toMatch(/SCAN p\b/);
    expect(detail).not.toMatch(/SCAN review_publications/);
  });
});
