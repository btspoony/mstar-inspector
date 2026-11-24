import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "./helpers";
import { findCheckAttemptByRunId } from "../../src/store/review-checks";

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

describe("check_run.rerequested reverse lookup (0108 idx_review_checks_app_run)", () => {
  test("findCheckAttemptByRunId probes (github_app_id, check_run_id) through the partial index — never a table scan", async () => {
    const db = createMigratedTestD1();
    const index = db.raw
      .query(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_checks_app_run'`,
      )
      .get() as { sql: string } | null;
    expect(index?.sql).toContain("check_run_id IS NOT NULL");

    const captured: string[] = [];
    await findCheckAttemptByRunId(capturing(db, captured), 9001, 4242);
    const sql = captured.find((s) => s.includes("FROM review_checks"));
    expect(sql).toBeDefined();
    const detail = plan(db, sql!);
    expect(detail).toMatch(/review_checks USING (COVERING )?INDEX idx_review_checks_app_run/);
    expect(detail).not.toMatch(/^SCAN review_checks$/m);
  });
});
