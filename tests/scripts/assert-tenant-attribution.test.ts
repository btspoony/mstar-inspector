/**
 * why: The deploy gate's parsing seam (`scripts/assert-tenant-attribution.ts`), one
 * describe per question it asks.
 *
 * The wrangler invocation is exercised by the workflow, not here: what must
 * hold is the VERDICT — a readable `COUNT(*) AS n` of 0 passes, any bot the
 * question names fails, and an answer that cannot be read is never treated as
 * a pass. Each query itself is EXECUTED against the real migration schema, so
 * the pinned literal is checked against behaviour and not only against a copy
 * of itself.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attributionVerdict,
  TARGETLESS_BOT_SQL,
  targetlessVerdict,
  ZERO_ORPHAN_SQL,
} from "../../scripts/assert-tenant-attribution";
import { createMigratedTestD1, mapAppToDefaultWorkspace, seedBot, seedTarget, type TestD1 } from "../store/helpers";

/** note: The file both deploy workflows replay: the repair this gate's pointer names. */
const REPAIR_SQL = readFileSync(join(import.meta.dir, "../../scripts/workspace-backfill.sql"), "utf8");

/** note: The wrangler 4.x `--json` shape: one entry per statement. */
function wranglerJson(n: unknown, success = true): string {
  return JSON.stringify([{ results: [{ n }], success, meta: { changes: 0, last_row_id: 0 } }]);
}

/** note: Run the gate's SQL on the migrated schema and feed the answer to the parser. */
function verdictFor(sql: string, db: TestD1) {
  return attributionVerdict(wranglerJson(countOf(sql, db)));
}

/** note: The second question, executed and parsed the same way. */
function targetlessFor(db: TestD1) {
  return targetlessVerdict(wranglerJson(countOf(TARGETLESS_BOT_SQL, db)));
}

/** note: Read the single `COUNT(*) AS n` row, refusing a shape the query did not produce. */
function countOf(sql: string, db: TestD1): number {
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
      message: "tenant attribution: 0 orphan Apps (every review_bots row has a bot_workspaces row)",
    });
  });

  test("n > 0 fails with the count and the repair pointer", () => {
    const verdict = attributionVerdict(wranglerJson(3));
    expect(verdict.ok).toBe(false);
    expect(verdict.count).toBe(3);
    expect(verdict.message).toContain("3 App(s) have no bot_workspaces row");
    expect(verdict.message).toContain("scripts/workspace-backfill.sql");
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

  test("the query is the column mapping the replay file backfills — executed, not restated", () => {
    // why: The independent literal: what the replay file guarantees, expressed in
    // the current names (it inserts a `bot_workspaces` row per `review_bots`
    // row that has none). A renamed/aliased/inverted column in ZERO_ORPHAN_SQL
    // breaks the execution below even when the test's expectation is untouched.
    const independent = "SELECT COUNT(*) AS n FROM review_bots WHERE id NOT IN (SELECT bot_id FROM bot_workspaces)";
    const db = createMigratedTestD1();
    try {
      // note: no Apps at all: both queries agree on zero
      expect(verdictFor(ZERO_ORPHAN_SQL, db).ok).toBe(true);
      expect(countOf(independent, db)).toBe(0);

      // note: one mapped App, one App whose workspace row is missing
      seedBot(db, "app-mapped", 1);
      seedBot(db, "app-orphan", 2);
      db.raw.prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('app-mapped', 'default')").run();

      const orphaned = verdictFor(ZERO_ORPHAN_SQL, db);
      expect(orphaned.ok).toBe(false);
      expect(orphaned.count).toBe(1);
      expect(orphaned.count).toBe(countOf(independent, db));
      expect(orphaned.message).toContain("workspace-backfill.sql");

      // why: The shipped replay file, verbatim: the gate goes green and the two
      // queries still agree.
      db.raw.exec(REPAIR_SQL);
      expect(verdictFor(ZERO_ORPHAN_SQL, db)).toEqual({
        ok: true,
        count: 0,
        message: "tenant attribution: 0 orphan Apps (every review_bots row has a bot_workspaces row)",
      });
      expect(countOf(independent, db)).toBe(0);
      // why: a soft-deleted App still needs its mapping: ownership is not liveness
      db.raw.prepare("UPDATE review_bots SET deleted_at = datetime('now') WHERE id = 'app-mapped'").run();
      db.raw.prepare("DELETE FROM bot_workspaces WHERE bot_id = 'app-mapped'").run();
      expect(verdictFor(ZERO_ORPHAN_SQL, db).count).toBe(1);
    } finally {
      db.raw.close();
    }
  });
});

describe("targetlessVerdict", () => {
  test("a bot with no live target fails — the target-less question", () => {
    const db = createMigratedTestD1();
    try {
      seedBot(db, "bot-targetless", 1);
      const verdict = targetlessFor(db);
      expect(verdict.ok).toBe(false);
      expect(verdict.count).toBe(1);
      expect(verdict.message).toContain("1 bot(s) have no live review target");
      expect(verdict.message).toContain("0057_review_targets.sql cannot be replayed whole");
      expect(verdict.message).toContain("restore the missing target rows");
    } finally {
      db.raw.close();
    }
  });

  test("a healthy fixture passes both questions", async () => {
    const db = createMigratedTestD1();
    try {
      for (const [botId, githubAppId] of [["bot-one", 1], ["bot-two", 2]] as const) {
        seedBot(db, botId, githubAppId);
        seedTarget(db, botId, { id: `target-${botId}` });
        await mapAppToDefaultWorkspace(db, botId);
      }
      expect(verdictFor(ZERO_ORPHAN_SQL, db)).toEqual({
        ok: true,
        count: 0,
        message: "tenant attribution: 0 orphan Apps (every review_bots row has a bot_workspaces row)",
      });
      expect(targetlessFor(db)).toEqual({
        ok: true,
        count: 0,
        message: "tenant attribution: 0 target-less bots (every live review_bots row has a live review_targets row)",
      });
    } finally {
      db.raw.close();
    }
  });

  test("the two questions' reasons are distinguishable and both refuse an unreadable answer", () => {
    const orphan = attributionVerdict(wranglerJson(2));
    const targetless = targetlessVerdict(wranglerJson(2));
    expect(orphan.ok).toBe(false);
    expect(targetless.ok).toBe(false);
    expect(orphan.message).not.toBe(targetless.message);
    expect(orphan.message).toContain("have no bot_workspaces row");
    expect(targetless.message).toContain("have no live review target");
    for (const stdout of ["", "not json", "[]", wranglerJson(0, false)]) {
      expect(targetlessVerdict(stdout).ok, stdout).toBe(false);
      expect(targetlessVerdict(stdout).count, stdout).toBeNull();
    }
  });

  test("the target-less query runs against the migrated schema — liveness on both sides", () => {
    // why: The independent literal: a live bot with no live target. A renamed,
    // aliased or de-livened column in TARGETLESS_BOT_SQL breaks the agreement
    // below even when the expectation here is untouched.
    const independent =
      "SELECT COUNT(*) AS n FROM review_bots WHERE deleted_at IS NULL AND id NOT IN " +
      "(SELECT bot_id FROM review_targets WHERE deleted_at IS NULL)";
    const db = createMigratedTestD1();
    try {
      expect(targetlessFor(db).ok).toBe(true);
      expect(countOf(independent, db)).toBe(0);

      // note: A soft-deleted bot owes no target: the question is about live bots.
      seedBot(db, "bot-live", 1);
      seedBot(db, "bot-gone", 2);
      db.raw.prepare("UPDATE review_bots SET deleted_at = datetime('now') WHERE id = 'bot-gone'").run();
      expect(targetlessFor(db).count).toBe(1);
      expect(targetlessFor(db).count).toBe(countOf(independent, db));

      const targetId = seedTarget(db, "bot-live", { id: "target-live" });
      expect(targetlessFor(db).ok).toBe(true);
      expect(countOf(independent, db)).toBe(0);

      // note: A soft-deleted target does not excuse the bot: it is still target-less.
      db.raw.prepare("UPDATE review_targets SET deleted_at = datetime('now') WHERE id = ?").run(targetId);
      expect(targetlessFor(db).count).toBe(1);
      expect(targetlessFor(db).count).toBe(countOf(independent, db));
    } finally {
      db.raw.close();
    }
  });
});
