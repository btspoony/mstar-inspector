/**
 * Unit tests: the `usage_events` ledger leaf (migration 0031, metered by 0064).
 *
 * The seq mint is the one thing tests can observe that callers depend on:
 * one review may hold several rows (attempt number), distinct reviews each
 * start at 1, and the FK refuses an unattributable row. Migration 0064 adds the
 * `rp` charge, written by the SAME statement so `seq` and cost cannot disagree —
 * and `0` stays the pre-metering marker that contributes nothing to a ceiling.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "./helpers";
import { recordUsageEvent, sumMonthlyRp } from "../../src/store/usage-store";

const AT = "2026-10-24T00:00:00.000Z";

describe("recordUsageEvent", () => {
  test("same review mints 1 then 2; distinct reviews each start at 1", async () => {
    const db = createMigratedTestD1();
    await recordUsageEvent(db, {
      reviewId: "review-a",
      executionToken: "token-a1",
      workspaceId: "default",
      occurredAt: AT,
      rp: 60,
    });
    await recordUsageEvent(db, {
      reviewId: "review-a",
      executionToken: "token-a2",
      workspaceId: "default",
      occurredAt: AT,
      rp: 2,
    });
    await recordUsageEvent(db, {
      reviewId: "review-b",
      executionToken: "token-b1",
      workspaceId: "default",
      occurredAt: AT,
      rp: 1,
    });

    const rows = db.raw
      .query(
        "SELECT review_id, seq, execution_token, workspace_id, occurred_at, rp FROM usage_events ORDER BY review_id, seq",
      )
      .all();
    expect(rows).toEqual([
      {
        review_id: "review-a",
        seq: 1,
        execution_token: "token-a1",
        workspace_id: "default",
        occurred_at: AT,
        rp: 60,
      },
      {
        review_id: "review-a",
        seq: 2,
        execution_token: "token-a2",
        workspace_id: "default",
        occurred_at: AT,
        rp: 2,
      },
      {
        review_id: "review-b",
        seq: 1,
        execution_token: "token-b1",
        workspace_id: "default",
        occurred_at: AT,
        rp: 1,
      },
    ]);
  });

  test("an unknown workspace is rejected by the FK", async () => {
    const db = createMigratedTestD1();
    await expect(
      recordUsageEvent(db, {
        reviewId: "review-a",
        executionToken: "token-x",
        workspaceId: "no-such-workspace",
        occurredAt: AT,
        rp: 1,
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    const count = db.raw.query("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("usage_events.rp (migration 0064)", () => {
  const MONTH = { startIso: "2026-10-01T00:00:00.000Z", endIso: "2026-11-01T00:00:00.000Z" };

  test("the column is NOT NULL, defaults to 0 and is an INTEGER", () => {
    const db = createMigratedTestD1();
    expect(
      db.raw.prepare(`SELECT type, "notnull", dflt_value FROM pragma_table_info('usage_events') WHERE name = 'rp'`).get(),
    ).toEqual({ type: "INTEGER", notnull: 1, dflt_value: "0" });
  });

  test("the charge lands beside the seq the same statement minted", async () => {
    const db = createMigratedTestD1();
    await recordUsageEvent(db, {
      reviewId: "review-a",
      executionToken: "token-a1",
      workspaceId: "default",
      occurredAt: "2026-10-05T00:00:00.000Z",
      rp: 60,
    });
    // A genuine retry of the same review: the next seq carries its own RP.
    await recordUsageEvent(db, {
      reviewId: "review-a",
      executionToken: "token-a2",
      workspaceId: "default",
      occurredAt: "2026-10-06T00:00:00.000Z",
      rp: 1,
    });

    expect(db.raw.query("SELECT seq, rp FROM usage_events ORDER BY seq").all()).toEqual([
      { seq: 1, rp: 60 },
      { seq: 2, rp: 1 },
    ]);
    expect(await sumMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso)).toBe(61);
  });

  test("a pre-metering row defaults to 0 and contributes nothing", async () => {
    const db = createMigratedTestD1();
    // Written the way a row that predates 0064 reads: the column's default.
    db.raw
      .prepare(
        `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at)
         VALUES ('old-review', 1, 'old-token', 'default', '2026-10-02T00:00:00.000Z')`,
      )
      .run();
    expect(db.raw.query("SELECT rp FROM usage_events").get()).toEqual({ rp: 0 });
    expect(await sumMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso)).toBe(0);
  });

  test("the window is half-open and per workspace", async () => {
    const db = createMigratedTestD1();
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_at) VALUES ('other', 'other', 'Other', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    for (const [reviewId, workspaceId, occurredAt, rp] of [
      // The first instant of the month counts …
      ["at-start", "default", "2026-10-01T00:00:00.000Z", 1],
      // … the first instant of the next month does not …
      ["after-end", "default", "2026-11-01T00:00:00.000Z", 100],
      // … and another workspace's rows are its own.
      ["other-ws", "other", "2026-10-10T00:00:00.000Z", 10],
    ] as const) {
      db.raw
        .prepare(
          `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp)
           VALUES (?, 1, ?, ?, ?, ?)`,
        )
        .run(reviewId, `token-${reviewId}`, workspaceId, occurredAt, rp);
    }
    expect(await sumMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso)).toBe(1);
  });
});
