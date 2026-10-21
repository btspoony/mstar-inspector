/**
 * The zero-orphan deploy gate's parsing seam (`scripts/assert-tenant-attribution.ts`).
 *
 * The wrangler invocation is exercised by the workflow, not here: what must
 * hold is the VERDICT — a readable `COUNT(*) AS n` of 0 passes, any App
 * without an `app_workspaces` row fails, and an answer that cannot be read is
 * never treated as a pass.
 */
import { describe, expect, test } from "bun:test";
import { attributionVerdict, ZERO_ORPHAN_SQL } from "../../scripts/assert-tenant-attribution";

/** The wrangler 4.x `--json` shape: one entry per statement. */
function wranglerJson(n: unknown, success = true): string {
  return JSON.stringify([{ results: [{ n }], success, meta: { changes: 0, last_row_id: 0 } }]);
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
    const malformed = [
      "",
      "not json",
      "null",
      "{}",
      "[]",
      '[{"results":[],"success":true}]',
      '[{"results":[{"n":"0"}],"success":true}]',
      '[{"results":[{"n":-1}],"success":true}]',
      '[{"results":[{"n":1.5}],"success":true}]',
      wranglerJson(0, false),
    ];
    for (const stdout of malformed) {
      const verdict = attributionVerdict(stdout);
      expect(verdict.ok, stdout).toBe(false);
      expect(verdict.count, stdout).toBeNull();
      expect(verdict.message, stdout).toContain("tenant attribution:");
    }
  });

  test("the query is the column mapping 0027 backfills", () => {
    expect(ZERO_ORPHAN_SQL).toBe(
      "SELECT COUNT(*) AS n FROM github_apps g LEFT JOIN app_workspaces w ON w.app_id = g.id WHERE w.app_id IS NULL",
    );
  });
});
