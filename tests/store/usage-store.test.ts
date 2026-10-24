/**
 * Unit tests: the `usage_events` ledger leaf (migration 0031).
 *
 * The seq mint is the one thing tests can observe that callers depend on:
 * one review may hold several rows (attempt number), distinct reviews each
 * start at 1, and the FK refuses an unattributable row.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "./helpers";
import { recordUsageEvent } from "../../src/store/usage-store";

const AT = "2026-10-24T00:00:00.000Z";

describe("recordUsageEvent", () => {
  test("same review mints 1 then 2; distinct reviews each start at 1", async () => {
    const db = createMigratedTestD1();
    await recordUsageEvent(db, { reviewId: "review-a", workspaceId: "default", occurredAt: AT });
    await recordUsageEvent(db, { reviewId: "review-a", workspaceId: "default", occurredAt: AT });
    await recordUsageEvent(db, { reviewId: "review-b", workspaceId: "default", occurredAt: AT });

    const rows = db.raw
      .query("SELECT review_id, seq, workspace_id, occurred_at FROM usage_events ORDER BY review_id, seq")
      .all();
    expect(rows).toEqual([
      { review_id: "review-a", seq: 1, workspace_id: "default", occurred_at: AT },
      { review_id: "review-a", seq: 2, workspace_id: "default", occurred_at: AT },
      { review_id: "review-b", seq: 1, workspace_id: "default", occurred_at: AT },
    ]);
  });

  test("an unknown workspace is rejected by the FK", async () => {
    const db = createMigratedTestD1();
    await expect(
      recordUsageEvent(db, { reviewId: "review-a", workspaceId: "no-such-workspace", occurredAt: AT }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    const count = db.raw.query("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
