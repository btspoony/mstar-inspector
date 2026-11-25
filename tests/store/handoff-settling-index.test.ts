import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "./helpers";
import { listIncompleteSettlements, recordSettlementAttempt } from "../../src/store/review-route-store";

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

  // The bounded retry order (I-000709): rows the pass already attempted and
  // could not settle sort behind rows not yet attempted, and take their turns
  // again oldest-stamp first — yielded, never dropped. The EXPLAIN sibling
  // above proves the seek stays on 0097's partial index; this ORDER BY sorts
  // only the open-settlement rows that index already matched.
  test("an attempted settlement yields to unattempted rows and is retried after them", async () => {
    const db = createMigratedTestD1();
    const seed = (key: string, attemptId: string, settlingMs: number | null, settleAttemptMs: number | null) => {
      db.raw
        .prepare(
          `INSERT INTO review_attempt_handoffs
             (delivery_key, attempt_id, payload_json, state, created_ms, updated_ms, settling_ms, settle_attempt_ms)
           VALUES (?, ?, '{}', 'created', 0, 0, ?, ?)`,
        )
        .run(key, attemptId, settlingMs, settleAttemptMs);
    };
    seed("k-attempted", "a-attempted", 100, 5_000);
    seed("k-fresh-older", "a-fresh-older", 200, null);
    seed("k-fresh-newer", "a-fresh-newer", 300, null);
    seed("k-open", "a-open", 400, null);

    const rows = await listIncompleteSettlements(db, { settlingBeforeMs: 1_000, limit: 10 });
    expect(rows.map((row) => row.attemptId)).toEqual(["a-fresh-older", "a-fresh-newer", "a-open", "a-attempted"]);

    // The pass takes a row: its stamp pushes it behind every unattempted row
    // on the next pass — after the older attempted row too, until that row's
    // own stamp is refreshed past it.
    await recordSettlementAttempt(db, "k-fresh-older", 6_000);
    const again = await listIncompleteSettlements(db, { settlingBeforeMs: 1_000, limit: 10 });
    expect(again.map((row) => row.attemptId)).toEqual(["a-fresh-newer", "a-open", "a-attempted", "a-fresh-older"]);

    // A row settled in between owes nothing, so it is never re-stamped.
    db.raw.prepare("UPDATE review_attempt_handoffs SET settled_ms = 7_000 WHERE attempt_id = 'a-fresh-newer'").run();
    await recordSettlementAttempt(db, "k-fresh-newer", 8_000);
    const settled = db.raw.prepare("SELECT settle_attempt_ms FROM review_attempt_handoffs WHERE attempt_id = 'a-fresh-newer'").get() as {
      settle_attempt_ms: number | null;
    };
    expect(settled.settle_attempt_ms).toBeNull();
  });
});
