/**
 * Prerequisite guard for the hand-listed fixture shapes: replay every shape
 * registered in `migration-shapes.ts` in order and assert each table a
 * migration indexes or alters already exists when that migration runs — the
 * failure a below-anchor reference otherwise reports as a bare
 * `no such table: <table>` from the middle of `db.raw.exec`.
 *
 * `FIXTURE_SHAPES` is the module's own registry, so a new shape is covered by
 * the `shape()` call that declares it; there is no list here to drift from.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createTestD1,
  execMigrationScript,
  splitSqlStatements,
  type TestD1,
} from "../store/helpers";
import { FIXTURE_SHAPES, applyMigrations, migrationSql } from "./migration-shapes";

/**
 * Every table a migration indexes or alters but does NOT create in the same
 * file, read from the file itself so a new tail migration extends the check
 * with no edit here.
 */
function touchedTables(sql: string): string[] {
  const ddl = sql.replace(/--.*$/gm, "");
  const created = new Set(
    [...ddl.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)/gi)].map((match) => match[1]!),
  );
  // A rename CREATES its target name in the same statement — `ALTER TABLE a
  // RENAME TO b` needs `b` absent and `a` present, so the target is no
  // below-anchor reference to chase.
  for (const match of ddl.matchAll(/ALTER\s+TABLE\s+"?(\w+)"?\s+RENAME\s+TO\s+"?(\w+)/gi)) created.add(match[2]!);
  const targets: string[] = [];
  for (const pattern of [
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+"?(\w+)/gi,
    /ALTER\s+TABLE\s+"?(\w+)/gi,
  ]) {
    for (const match of ddl.matchAll(pattern)) targets.push(match[1]!);
  }
  return targets.filter((table) => !created.has(table));
}

describe("fixture shapes (TAIL_PREREQUISITES)", () => {
  // An empty registry would report zero failures, i.e. the same vacuous green
  // this guard exists to prevent.
  test("the shape registry is populated", () => {
    expect(Object.keys(FIXTURE_SHAPES).length).toBeGreaterThan(0);
  });

  for (const [shape, migrations] of Object.entries(FIXTURE_SHAPES)) {
    test(`${shape}: every table a migration touches exists when it runs`, () => {
      const db = createTestD1();
      for (const name of migrations) {
        for (const table of touchedTables(migrationSql(name))) {
          // `get()` is undefined-capable (the D1 double's `first()` reads it
          // that way), so assert the ROW, not merely a non-null: a missing
          // table must never read as present.
          const row = db.raw
            .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table) as { present?: number } | null | undefined;
          expect(
            row?.present ?? null,
            `${shape}: ${name} touches "${table}", which no migration applied before it creates — add the migration that creates "${table}" to TAIL_PREREQUISITES`,
          ).toBe(1);
        }
        applyMigrations(db, [name]);
      }
    });
  }
});

/**
 * The App family is a review bot, and the derived tail renames it and then
 * splits the review configuration onto a target. A shape either carries that
 * tail — and must end on the bot vocabulary with a target table and no review
 * configuration on the bot row — or it stops below it, which only the pre-0015
 * provider world does today. Either way the world is pinned: a hand-listed
 * shape that drifts between the states cannot serve a suite that reads one of
 * the names.
 */
describe("fixture shapes (review bot vocabulary)", () => {
  const RENAME = "0056_review_bots_rename.sql";

  for (const [shape, migrations] of Object.entries(FIXTURE_SHAPES)) {
    test(`${shape}: matches the shape's bot and target vocabulary`, () => {
      const renamed = migrations.includes(RENAME);
      const db = createTestD1();
      applyMigrations(db, migrations);
      const tables = new Set(
        (db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      expect(tables.has("review_bots"), `${shape}: reviewed bot parent`).toBe(renamed);
      expect(tables.has("github_apps"), `${shape}: pre-rename parent`).toBe(!renamed);
      const reviews = (
        db.raw.query("PRAGMA table_info(reviews)").all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(reviews, `${shape}: review attribution column`).toContain(renamed ? "bot_id" : "app_id");
      // The split is the rename's tail: the target table exists exactly where
      // the bot vocabulary does, and the bot row no longer carries the review
      // configuration there, so no shape is left half-split.
      expect(tables.has("review_targets"), `${shape}: target table`).toBe(renamed);
      const botColumns = (
        db.raw.query(`PRAGMA table_info(${renamed ? "review_bots" : "github_apps"})`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);
      expect(botColumns.includes("review_trigger_mode"), `${shape}: review configuration on the bot row`).toBe(
        !renamed,
      );
    });
  }
});

/**
 * Every fixture migration must run through the fail-fast executor: a script
 * whose second statement fails has to abort, not leave the earlier statements
 * applied and the rest of the file skipped. A whole-file `exec` cannot promise
 * that — on the pinned bun a failing statement inside a multi-statement string
 * is skipped while the rest still runs.
 */
describe("fixture migrations (fail-fast)", () => {
  /** Two good statements around a failing one: `after` marks a skipped abort. */
  const SCRIPT = [
    "CREATE TABLE fail_fast_probe (v TEXT);",
    "INSERT INTO fail_fast_probe (v) VALUES ('first');",
    "INSERT INTO fail_fast_missing (v) VALUES ('boom');",
    "INSERT INTO fail_fast_probe (v) VALUES ('after');",
  ].join("\n");

  test("a failing statement aborts and the rest of the script never runs — fail-fast", () => {
    const db = createTestD1();
    try {
      expect(() => execMigrationScript(db.raw, SCRIPT)).toThrow("no such table: fail_fast_missing");
      expect(db.raw.query("SELECT v FROM fail_fast_probe").all()).toEqual([{ v: "first" }]);
    } finally {
      db.raw.close();
    }
  });

  test("applyMigrations hands each statement over on its own — fail-fast", () => {
    // A bare connection: the test is about what `applyMigrations` hands over,
    // and 0001 is one of the two files `createTestD1` has already applied.
    const db = new Database(":memory:");
    const handed: string[] = [];
    // `applyMigrations` touches nothing but the connection's `exec`, so
    // recording there is enough to see whether a script arrived whole.
    const recording = {
      raw: {
        exec: (sql: string) => {
          handed.push(sql);
          db.exec(sql);
        },
      },
    } as unknown as TestD1;
    try {
      applyMigrations(recording, ["0001_reviews.sql"]);
      expect(handed).toEqual(splitSqlStatements(migrationSql("0001_reviews.sql")));
    } finally {
      db.close();
    }
  });
});
