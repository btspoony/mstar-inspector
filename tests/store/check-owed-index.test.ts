import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "./helpers";
import { RECONCILE_DEFAULTS } from "../../src/contracts/reconcile-settings";
import { listCheckReconcileBatch } from "../../src/store/review-checks";
import { clearConcludedCheckOwed } from "../../src/pipeline/review-attempt";

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

describe("owed-Check marks on review_launches (EXPLAIN QUERY PLAN)", () => {
  test("the due batch probes owed marks through idx_review_launches_check_owed", async () => {
    const db = createMigratedTestD1();
    const captured: string[] = [];
    await listCheckReconcileBatch(capturing(db, captured), 1_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit);
    const sql = captured.find((s) => s.includes("FROM review_launches l"));
    expect(sql).toBeDefined();
    const detail = plan(db, sql!);
    expect(detail).toMatch(/SEARCH l USING (COVERING )?INDEX idx_review_launches_check_owed/);
    expect(detail).not.toMatch(/SCAN l\b/);
  });

  test("clearing concluded marks walks only the marked rows", async () => {
    const db = createMigratedTestD1();
    const captured: string[] = [];
    await clearConcludedCheckOwed(capturing(db, captured));
    const sql = captured.find((s) => s.includes("UPDATE review_launches"));
    expect(sql).toBeDefined();
    const detail = plan(db, sql!);
    expect(detail).toMatch(/review_launches USING (COVERING )?INDEX idx_review_launches_check_owed/);
    expect(detail).not.toMatch(/^SCAN review_launches$/m);
  });
});
