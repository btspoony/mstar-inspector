import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, execMigrationScript, type TestD1 } from "./helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";

const RETENTION = { days: 90, cap: 500 };

function capturing(db: TestD1, captured: string[]): TestD1 {
  return {
    ...db,
    prepare(sql) {
      captured.push(sql);
      return db.prepare(sql);
    },
  };
}

function seed(db: TestD1, prNumber: number, id: string, state: string, daysAgo: number): void {
  db.raw
    .prepare(
      `INSERT INTO pull_requests (id, bot_id, owner, repo, pr_number, state, last_seen_at)
       VALUES (?, 'bot', 'acme', 'widgets', ?, ?, datetime('now', ?))`,
    )
    .run(id, prNumber, state, `-${daysAgo} days`);
}

describe("terminal pull_requests retention sweep", () => {
  test("deletes only terminal rows past the retention window", async () => {
    const db = createMigratedTestD1();
    execMigrationScript(db.raw, "PRAGMA foreign_keys = OFF;");
    const old = RETENTION.days + 1;
    const recent = RETENTION.days - 1;
    seed(db, 1, "closed-old", "closed", old);
    seed(db, 2, "merged-old", "merged", old);
    seed(db, 3, "open-old", "open", old);
    seed(db, 4, "closed-recent", "closed", recent);
    seed(db, 5, "merged-recent", "merged", recent);

    expect(await createReviewBotsStore(db).sweepTerminalPullRequests(RETENTION)).toBe(2);
    const left = (db.raw.query("SELECT id FROM pull_requests ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    expect(left).toEqual(["closed-recent", "merged-recent", "open-old"]);
  });

  test("seeks expired terminal rows through idx_pull_requests_terminal_seen (EXPLAIN QUERY PLAN)", async () => {
    const db = createMigratedTestD1();
    const captured: string[] = [];
    await createReviewBotsStore(capturing(db, captured)).sweepTerminalPullRequests(RETENTION);
    const sql = captured.find((s) => s.includes("DELETE FROM pull_requests"));
    expect(sql).toBeDefined();
    const detail = (db.raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(`-${RETENTION.days} days`, RETENTION.cap) as Array<{ detail: string }>)
      .map(({ detail }) => detail)
      .join("\n");
    expect(detail).toMatch(/SEARCH pull_requests USING (COVERING )?INDEX idx_pull_requests_terminal_seen \(last_seen_at<\?\)/);
    expect(detail).not.toMatch(/^SCAN pull_requests$/m);
  });
});
