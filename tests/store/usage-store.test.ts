import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "./helpers";
import {
  readMonthlyRp,
  readMonthlyRpByWorkspace,
  recordUsageEvent,
  sumMonthlyRp,
} from "../../src/store/usage-store";

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
      source: "shared",
    });
    await recordUsageEvent(db, {
      reviewId: "review-a",
      executionToken: "token-a2",
      workspaceId: "default",
      occurredAt: AT,
      rp: 2,
      source: "byok",
    });
    await recordUsageEvent(db, {
      reviewId: "review-b",
      executionToken: "token-b1",
      workspaceId: "default",
      occurredAt: AT,
      rp: 1,
      source: "byok",
    });

    const rows = db.raw
      .query(
        "SELECT review_id, seq, execution_token, workspace_id, occurred_at, rp, source FROM usage_events ORDER BY review_id, seq",
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
        source: "shared",
      },
      {
        review_id: "review-a",
        seq: 2,
        execution_token: "token-a2",
        workspace_id: "default",
        occurred_at: AT,
        rp: 2,
        source: "byok",
      },
      {
        review_id: "review-b",
        seq: 1,
        execution_token: "token-b1",
        workspace_id: "default",
        occurred_at: AT,
        rp: 1,
        source: "byok",
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
        source: "byok",
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
      source: "shared",
    });
    await recordUsageEvent(db, {
      reviewId: "review-a",
      executionToken: "token-a2",
      workspaceId: "default",
      occurredAt: "2026-10-06T00:00:00.000Z",
      rp: 1,
      source: "byok",
    });

    expect(db.raw.query("SELECT seq, rp FROM usage_events ORDER BY seq").all()).toEqual([
      { seq: 1, rp: 60 },
      { seq: 2, rp: 1 },
    ]);
    expect(await sumMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso)).toBe(61);
  });

  test("a pre-metering row defaults to 0 and contributes nothing", async () => {
    const db = createMigratedTestD1();
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
      ["at-start", "default", "2026-10-01T00:00:00.000Z", 1],
      ["after-end", "default", "2026-11-01T00:00:00.000Z", 100],
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

describe("usage_events.source (migration 0065)", () => {
  const MONTH = { startIso: "2026-10-01T00:00:00.000Z", endIso: "2026-11-01T00:00:00.000Z" };

  test("one shared and one BYOK event split into the two rows, and the parts are the total", async () => {
    const db = createMigratedTestD1();
    await recordUsageEvent(db, {
      reviewId: "shared-deep",
      executionToken: "token-shared",
      workspaceId: "default",
      occurredAt: "2026-10-05T00:00:00.000Z",
      rp: 60,
      source: "shared",
    });
    await recordUsageEvent(db, {
      reviewId: "byok-standard",
      executionToken: "token-byok",
      workspaceId: "default",
      occurredAt: "2026-10-06T00:00:00.000Z",
      rp: 2,
      source: "byok",
    });

    const [usage] = await readMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso);
    expect(usage).toEqual({ workspaceId: "default", total: 62, sharedRp: 60, byokRp: 2 });
    expect(await sumMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso)).toBe(usage!.total);
  });

  test("a pre-column row counts in the total and in neither split", async () => {
    const db = createMigratedTestD1();
    db.raw
      .prepare(
        `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp)
         VALUES ('unrecorded', 1, 'token-unrecorded', 'default', '2026-10-07T00:00:00.000Z', 6)`,
      )
      .run();
    await recordUsageEvent(db, {
      reviewId: "byok-quick",
      executionToken: "token-byok",
      workspaceId: "default",
      occurredAt: "2026-10-08T00:00:00.000Z",
      rp: 1,
      source: "byok",
    });

    const [usage] = await readMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso);
    expect(usage).toEqual({ workspaceId: "default", total: 7, sharedRp: 0, byokRp: 1 });
    expect(usage!.sharedRp + usage!.byokRp).toBeLessThan(usage!.total);
  });

  test("the operator form answers every workspace in one statement", async () => {
    const db = createMigratedTestD1();
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_at) VALUES ('other', 'other', 'Other', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    for (const [reviewId, workspaceId, source] of [
      ["a", "default", "shared"],
      ["b", "other", "byok"],
    ] as const) {
      db.raw
        .prepare(
          `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp, source)
           VALUES (?, 1, ?, ?, '2026-10-10T00:00:00.000Z', 3, ?)`,
        )
        .run(reviewId, `token-${reviewId}`, workspaceId, source);
    }
    expect(await readMonthlyRpByWorkspace(db, MONTH.startIso, MONTH.endIso)).toEqual([
      { workspaceId: "default", total: 3, sharedRp: 3, byokRp: 0 },
      { workspaceId: "other", total: 3, sharedRp: 0, byokRp: 3 },
    ]);
    expect(await readMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso)).toEqual([
      { workspaceId: "default", total: 3, sharedRp: 3, byokRp: 0 },
    ]);
  });
});

function usageByWorkspaceSql(extraWhere = ""): string {
  return `SELECT workspace_id AS workspaceId, COALESCE(SUM(rp), 0) AS total
            FROM usage_events
           WHERE ${extraWhere === "" ? "" : `${extraWhere} AND `}occurred_at >= '2026-10-01T00:00:00.000Z' AND occurred_at < '2026-11-01T00:00:00.000Z'
           GROUP BY workspace_id`;
}

describe("migration 0066 (the preview's month index)", () => {
  test("occurred_at leads and the aggregated columns are carried", () => {
    const db = createMigratedTestD1();
    expect(db.raw.prepare(`PRAGMA index_info('idx_usage_events_occurred_rp')`).all()).toEqual([
      { seqno: 0, cid: expect.any(Number), name: "occurred_at" },
      { seqno: 1, cid: expect.any(Number), name: "workspace_id" },
      { seqno: 2, cid: expect.any(Number), name: "rp" },
      { seqno: 3, cid: expect.any(Number), name: "source" },
    ]);
  });

  test("both month reads are index-served: the preview by the window, the tenant by its workspace", () => {
    const db = createMigratedTestD1();
    const plan = (sql: string) =>
      (db.raw.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join(" | ");
    expect(plan(usageByWorkspaceSql())).toContain("idx_usage_events_occurred_rp");
    expect(plan(usageByWorkspaceSql("workspace_id = 'default'"))).toContain("usage_events_workspace_occurred");
  });
});
