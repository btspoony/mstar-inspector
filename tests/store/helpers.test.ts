/**
 * The test D1 double's change-count contract: a row-returning write reports the
 * rows it modified, as D1's `meta.changes` does — `1` when a guarded
 * `INSERT … SELECT … RETURNING` matched, `0` when it did not — with `results`
 * unchanged and a plain read changing nothing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createMigratedTestD1,
  createTestD1,
  execMigrationScript,
  migrationNumber,
  migrationsAfter,
  splitSqlStatements,
} from "./helpers";

const AT = "2026-10-27T00:00:00.000Z";
/** Same shape as the operator store's guarded audit append. */
const GUARDED_AUDIT_INSERT = `INSERT INTO audit_events (id, workspace_id, actor_login, action, created_at)
  SELECT ?, w.id, 'tester', 'probe', ? FROM workspaces w WHERE w.id = ? RETURNING workspace_id`;

describe("test D1 double", () => {
  test("a row-returning write reports the rows it changed", async () => {
    const db = createMigratedTestD1();
    const insert = (id: string, workspaceId: string) =>
      db.prepare(GUARDED_AUDIT_INSERT).bind(id, AT, workspaceId).run<{ workspace_id: string }>();

    const hit = await insert("event-1", "default");
    expect(hit.results).toEqual([{ workspace_id: "default" }]);
    expect(hit.meta.changes).toBe(1);

    // A batch runs every statement through `run()`, SELECTs included; the
    // previous write's count must not leak into a read.
    const read = await db.prepare("SELECT id FROM audit_events").run<{ id: string }>();
    expect(read.results).toEqual([{ id: "event-1" }]);
    expect(read.meta.changes).toBe(0);

    // The guarded subquery finds no workspace, so the statement writes nothing.
    const miss = await insert("event-2", "no-such-workspace");
    expect(miss.results).toEqual([]);
    expect(miss.meta.changes).toBe(0);
  });

  test("a .sql without a numeric prefix fails by name instead of vanishing from the order", () => {
    // Wrangler orders migrations by numeric prefix. A file with none has no
    // apply order, so it must fail loudly — a silent drop would build a
    // partial schema on a fresh database and hide the cause.
    expect(() => migrationNumber("add_index.sql")).toThrow(/add_index\.sql has no numeric prefix/);
    expect(() => migrationNumber("0043_review_inflight.sql")).not.toThrow();
    expect(migrationNumber("0043_review_inflight.sql")).toBe(43);
  });

  test("both anchor forms select the same tail: the prefix number and the filename", () => {
    // A fixture declares either anchor; they must not diverge.
    expect(migrationsAfter("0036_app_identity.sql")).toEqual(migrationsAfter(36));
    expect(() => migrationsAfter("add_index.sql")).toThrow(/no numeric prefix/);
  });
});

describe("migration order", () => {
  test("a synthetic duplicate pair orders by filename, never by readdir order", () => {
    // `zzz` before `aaa` is the order a non-lexical directory listing hands
    // back. `number(a) - number(b)` alone keeps it; the byte-order tie-break
    // is what the duplicates in `migrations/` depend on, so reverting that
    // tie-break fails exactly here. The listing is injected, not mocked:
    // `mock.module("node:fs")` leaves a process-wide registry entry that
    // every later suite inherits.
    const synthetic = migrationsAfter(0, () => [
      "0043_zzz_synthetic.sql",
      "0043_aaa_synthetic.sql",
    ]);
    expect(synthetic).toEqual(["0043_aaa_synthetic.sql", "0043_zzz_synthetic.sql"]);
  });

  test("a real readdirSync property still sees the builtin", async () => {
    // The ordinal case above must leave the process-wide module registry as it
    // found it: the next reader of `node:fs` gets the builtin, not a mock entry
    // that only happens to carry the real functions.
    const live = await import("node:fs");
    expect(live.readdirSync(join(import.meta.dir, "../../migrations"))).toContain(
      "0001_reviews.sql",
    );
  });
});

describe("migration script execution", () => {
  test("splits on statement boundaries only: quotes and comments stay whole", () => {
    const script = [
      "-- a comment with a ; in it",
      "CREATE TABLE t (n INTEGER NOT NULL CONSTRAINT g CHECK (n = 0));",
      "INSERT INTO t (n) SELECT ';' WHERE ';' <> ''; -- trailing ; comment",
      "/* block ; comment */ DROP TABLE t;",
    ].join("\n");
    // Three statements: the `;` inside the string literal and the two inside
    // comments never split, and each statement keeps its own leading comment.
    expect(splitSqlStatements(script)).toHaveLength(3);
    expect(splitSqlStatements(script)).toEqual([
      expect.stringContaining("CREATE TABLE t"),
      expect.stringContaining("INSERT INTO t (n) SELECT ';' WHERE ';' <> ''"),
      expect.stringContaining("DROP TABLE t"),
    ]);
  });

  test("a failing statement aborts the migration instead of being skipped", () => {
    // `Database.exec` on bun 1.4.0 (CI's pinned version) silently skips the
    // failing statement of a multi-statement script and runs the rest; D1
    // aborts. This helper must abort on every runtime, or a guard that exists
    // to fail a migration passes on CI alone.
    const db = createTestD1();
    expect(() =>
      execMigrationScript(
        db.raw,
        `CREATE TABLE guard_probe (n INTEGER NOT NULL CONSTRAINT guard_probe CHECK (n = 0));
         INSERT INTO guard_probe (n) VALUES (1);
         CREATE TABLE after_guard (id TEXT);`,
      ),
    ).toThrow(/guard_probe/);
    // The failing statement stopped the script: nothing after it ran.
    expect(
      (db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'after_guard'").get() ?? null),
    ).toBeNull();
  });

  test("every shipped migration splits into statements that all execute", () => {
    const db = createMigratedTestD1();
    const empty = migrationsAfter(0).filter((name) => splitSqlStatements(
      readFileSync(join(import.meta.dir, "../../migrations", name), "utf8"),
    ).length === 0);
    expect(empty).toEqual([]);
    // …and the fully-migrated schema is the proof the statements ran.
    expect(db.raw.query("SELECT COUNT(*) AS n FROM workspaces").get()).toEqual({ n: 1 });
  });
});
