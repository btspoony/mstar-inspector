import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, migrationsAfter, type TestD1 } from "./helpers";

// migrations/0127_review_bots_archived.sql — `review_bots.archived_at`.
//
// Archive is a product state: the row, its chains and its usage stay, the relay
// stops selecting it, and NULL means live. The file is an ALTER ADD, so it is
// apply-once (0117's rule): a second apply aborts on the existing column and
// leaves the first apply's schema and rows exactly as they were — the only
// re-apply safety SQLite's ALTER TABLE can express, and what these cases pin.
// A rebuild that tolerated a duplicate column would be a different, costlier
// migration, not this one.

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const MIGRATION = "0127_review_bots_archived.sql";
const TS = "2026-10-24T00:00:00.000Z";

type Column = { name: string; type: string; notnull: number; dflt_value: unknown };

function columns(db: TestD1): Column[] {
  return db.raw.query("PRAGMA table_info(review_bots)").all() as Column[];
}

function seedBot(db: TestD1, id: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, workspace_id, name, scope, multiplier, created_at, updated_at)
       VALUES (?, 'default', ?, 'owned', 1, ?, ?)`,
    )
    .run(id, id, TS, TS);
}

describe("migrations/0127_review_bots_archived.sql", () => {
  test("adds a nullable, unindexed, undefaulted archived_at to review_bots", () => {
    const db = createMigratedTestD1();

    const added = columns(db).find((column) => column.name === "archived_at");
    expect(added).toBeDefined();
    expect(added!.type).toBe("TEXT");
    expect(added!.notnull).toBe(0);
    // No default: a row that never saw the archive writer reads NULL = live.
    expect(added!.dflt_value).toBeNull();

    const indexes = db.raw
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'review_bots'")
      .all() as Array<{ name: string }>;
    for (const index of indexes) {
      const indexed = db.raw.query(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>;
      expect([index.name, indexed.some((c) => c.name === "archived_at")]).toEqual([index.name, false]);
    }
    db.raw.close();
  });

  test("a second apply aborts on the duplicate column and leaves one column and the same rows", () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-a");
    db.raw.prepare("UPDATE review_bots SET archived_at = ? WHERE id = 'bot-a'").run(TS);
    const before = db.raw.query("SELECT id, archived_at FROM review_bots ORDER BY id").all();

    const script = readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8");
    expect(() => db.raw.run(script)).toThrow(/duplicate column/i);

    expect(columns(db).filter((column) => column.name === "archived_at")).toHaveLength(1);
    expect(db.raw.query("SELECT id, archived_at FROM review_bots ORDER BY id").all()).toEqual(before);
    db.raw.close();
  });

  test("is the migration after 0126, so the chain that carries it ends with this column", () => {
    expect(migrationsAfter(126)).toEqual([MIGRATION]);
  });

  test("leaves the family's foreign keys intact and still enforced", () => {
    const db = createMigratedTestD1();

    expect(db.raw.query("PRAGMA foreign_key_list(review_bots)").all()).toContainEqual(
      expect.objectContaining({ table: "workspaces", from: "workspace_id", to: "id" }),
    );
    for (const [table, column] of [
      ["usage_events", "bot_id"],
      ["review_checks", "executor_bot_id"],
    ] as const) {
      const foreignKeys = db.raw.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{
        table: string;
        from: string;
        to: string;
      }>;
      expect(foreignKeys).toContainEqual(expect.objectContaining({ table: "review_bots", from: column, to: "id" }));
    }

    // Enforcement, not just metadata: the owner reference still rejects an
    // unknown workspace, so an ALTER ADD did not rebuild the table without FKs.
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO review_bots (id, workspace_id, name, scope, multiplier, created_at, updated_at)
           VALUES ('bot-orphan', 'missing', 'bot-orphan', 'owned', 1, ?, ?)`,
        )
        .run(TS, TS),
    ).toThrow();
    expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.raw.close();
  });
});
