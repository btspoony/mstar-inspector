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
import { createTestD1 } from "../store/helpers";
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
