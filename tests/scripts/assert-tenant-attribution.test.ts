/**
 * The zero-orphan deploy gate's parsing seam (`scripts/assert-tenant-attribution.ts`).
 *
 * The wrangler invocation is exercised by the workflow, not here: what must
 * hold is the VERDICT — a readable `COUNT(*) AS n` of 0 passes, any App
 * without an `app_workspaces` row fails, and an answer that cannot be read is
 * never treated as a pass. The query itself is EXECUTED against the real
 * migration schema, so the pinned literal is checked against behaviour and not
 * only against a copy of itself.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attributionVerdict, ZERO_ORPHAN_SQL } from "../../scripts/assert-tenant-attribution";
import { createMigratedTestD1 } from "../store/helpers";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** The wrangler 4.x `--json` shape: one entry per statement. */
function wranglerJson(n: unknown, success = true): string {
  return JSON.stringify([{ results: [{ n }], success, meta: { changes: 0, last_row_id: 0 } }]);
}

/** Run the gate's SQL on the migrated schema and feed the answer to the parser. */
function verdictFor(sql: string, db: ReturnType<typeof createMigratedTestD1>) {
  return attributionVerdict(wranglerJson(countOf(sql, db)));
}

/** Read the single `COUNT(*) AS n` row, refusing a shape the query did not produce. */
function countOf(sql: string, db: ReturnType<typeof createMigratedTestD1>): number {
  const row: unknown = db.raw.prepare(sql).get();
  if (typeof row !== "object" || row === null || !("n" in row) || typeof row.n !== "number") {
    throw new Error(`expected one { n: number } row, got ${JSON.stringify(row)} — from: ${sql}`);
  }
  return row.n;
}

describe("attributionVerdict", () => {
  test("n = 0 passes and reports the count", () => {
    const verdict = attributionVerdict(wranglerJson(0));
    expect(verdict).toEqual({
      ok: true,
      count: 0,
      message: "tenant attribution: 0 orphan Apps (every github_apps row has an app_workspaces row)",
    });
  });

  test("n > 0 fails with the count and the repair pointer", () => {
    const verdict = attributionVerdict(wranglerJson(3));
    expect(verdict.ok).toBe(false);
    expect(verdict.count).toBe(3);
    expect(verdict.message).toContain("3 App(s) have no app_workspaces row");
    expect(verdict.message).toContain("migrations/0027_workspace_backfill.sql");
  });

  test("unreadable output fails — never a silent pass", () => {
    const malformed: Array<[string, string]> = [
      ["empty stdout", ""],
      ["non-JSON", "not json"],
      ["null", "null"],
      ["object, not an array", "{}"],
      ["empty array (no statement)", "[]"],
      ["two statements", '[{"results":[{"n":0}],"success":true},{"results":[{"n":0}],"success":true}]'],
      ["null statement", "[null]"],
      ["string statement", '["ok"]'],
      ["missing success", '[{"results":[{"n":0}]}]'],
      ["success: false", wranglerJson(0, false)],
      ["success: \"false\" (string)", '[{"results":[{"n":0}],"success":"false"}]'],
      ["zero rows", '[{"results":[],"success":true}]'],
      ["two result rows", '[{"results":[{"n":0},{"n":0}],"success":true}]'],
      ["results not an array", '[{"results":{"n":0},"success":true}]'],
      ["null row", '[{"results":[null],"success":true}]'],
      ["string count", '[{"results":[{"n":"0"}],"success":true}]'],
      ["negative count", '[{"results":[{"n":-1}],"success":true}]'],
      ["fractional count", '[{"results":[{"n":1.5}],"success":true}]'],
      ["missing n", '[{"results":[{"count":0}],"success":true}]'],
    ];
    for (const [shape, stdout] of malformed) {
      const verdict = attributionVerdict(stdout);
      expect(verdict.ok, shape).toBe(false);
      expect(verdict.count, shape).toBeNull();
      expect(verdict.message, shape).toContain("tenant attribution:");
    }
  });

  test("the query is the column mapping 0027 backfills — executed, not restated", () => {
    // The independent literal: what 0027 guarantees, expressed in 0027's own
    // terms (it inserts an `app_workspaces` row per `github_apps` row that has
    // none). A renamed/aliased/inverted column in ZERO_ORPHAN_SQL breaks the
    // execution below even when the test's expectation is untouched.
    const independent = "SELECT COUNT(*) AS n FROM github_apps WHERE id NOT IN (SELECT app_id FROM app_workspaces)";
    const db = createMigratedTestD1();
    try {
      // no Apps at all: both queries agree on zero
      expect(verdictFor(ZERO_ORPHAN_SQL, db).ok).toBe(true);
      expect(countOf(independent, db)).toBe(0);

      // one mapped App, one App whose workspace row is missing
      const insertApp = db.raw.prepare(
        `INSERT INTO github_apps
           (id, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, 'k', 'w', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
      );
      insertApp.run("app-mapped", 1, "mapped");
      insertApp.run("app-orphan", 2, "orphan");
      db.raw.prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES ('app-mapped', 'default')").run();

      const orphaned = verdictFor(ZERO_ORPHAN_SQL, db);
      expect(orphaned.ok).toBe(false);
      expect(orphaned.count).toBe(1);
      expect(orphaned.count).toBe(countOf(independent, db));
      expect(orphaned.message).toContain("0027_workspace_backfill.sql");

      // 0027 repairs it: the gate goes green and the two queries still agree
      db.raw.exec(readFileSync(join(REPO_ROOT, "migrations", "0027_workspace_backfill.sql"), "utf8"));
      expect(verdictFor(ZERO_ORPHAN_SQL, db)).toEqual({
        ok: true,
        count: 0,
        message: "tenant attribution: 0 orphan Apps (every github_apps row has an app_workspaces row)",
      });
      expect(countOf(independent, db)).toBe(0);
      // a soft-deleted App still needs its mapping: ownership is not liveness
      db.raw.prepare("UPDATE github_apps SET deleted_at = datetime('now') WHERE id = 'app-mapped'").run();
      db.raw.prepare("DELETE FROM app_workspaces WHERE app_id = 'app-mapped'").run();
      expect(verdictFor(ZERO_ORPHAN_SQL, db).count).toBe(1);
    } finally {
      db.raw.close();
    }
  });
});
