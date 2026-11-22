import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createTestD1,
  execMigrationScript,
  splitSqlStatements,
  type TestD1,
} from "../store/helpers";
import { FIXTURE_SHAPES, applyMigrations, migrationSql } from "./migration-shapes";

function touchedTables(sql: string): string[] {
  const ddl = sql.replace(/--.*$/gm, "");
  const created = new Set(
    [...ddl.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)/gi)].map((match) => match[1]!),
  );
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
  test("the shape registry is populated", () => {
    expect(Object.keys(FIXTURE_SHAPES).length).toBeGreaterThan(0);
  });

  for (const [shape, migrations] of Object.entries(FIXTURE_SHAPES)) {
    test(`${shape}: every table a migration touches exists when it runs`, () => {
      const db = createTestD1();
      for (const name of migrations) {
        for (const table of touchedTables(migrationSql(name))) {
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

describe("fixture migrations (fail-fast)", () => {
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
    const db = new Database(":memory:");
    const handed: string[] = [];
    const recording = {
      raw: {
        exec: (sql: string) => {
          handed.push(sql);
          db.exec(sql);
        },
      },
    } as unknown as TestD1;
    try {
      applyMigrations(recording, ["0059_install_claims.sql"]);
      expect(handed).toHaveLength(3);
      expect(
        handed.map((statement) =>
          (statement
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line !== "" && !line.startsWith("--")) ?? ""
          )
            .split(/\s+/)
            .slice(0, 3)
            .join(" "),
        ),
      ).toEqual([
        "CREATE TABLE install_claims",
        "CREATE INDEX install_claims_user_open",
        "CREATE UNIQUE INDEX",
      ]);
      expect(
        db
          .query(
            `SELECT name FROM sqlite_master
              WHERE tbl_name = 'install_claims' AND type IN ('table','index')
                AND name NOT LIKE 'sqlite_%'
              ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: "install_claims" },
        { name: "install_claims_live_target" },
        { name: "install_claims_user_open" },
      ]);
    } finally {
      db.close();
    }
  });
});
