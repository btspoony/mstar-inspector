/**
 * The test D1 double's change-count contract: a row-returning write reports the
 * rows it modified, as D1's `meta.changes` does — `1` when a guarded
 * `INSERT … SELECT … RETURNING` matched, `0` when it did not — with `results`
 * unchanged and a plain read changing nothing.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, createTestD1, migrationNumber, migrationsAfter } from "./helpers";
import {
  APP_CONFIG_BASE_MIGRATIONS,
  APP_CONFIG_MIGRATIONS,
  APP_CONFIG_PRE_POOL_MIGRATIONS,
  APPS_UI_MIGRATIONS,
  DERIVED_TAIL,
  PROVIDER_VERIFY_MIGRATIONS,
  SPA_PAGE_APIS_MIGRATIONS,
  WEBHOOK_DELIVERIES_MIGRATIONS,
  WEBHOOK_DELIVERIES_TAIL,
  applyMigrations,
  migrationSql,
} from "../helpers/migration-shapes";

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

// --- derived tail prerequisites ---

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

describe("derived-tail prerequisites (TAIL_PREREQUISITES)", () => {
  // The five fixtures, each as the full ordered list it replays.
  const SHAPES: Record<string, readonly string[]> = {
    "apps-ui": APPS_UI_MIGRATIONS,
    "provider-verify": PROVIDER_VERIFY_MIGRATIONS,
    "spa-page-apis": SPA_PAGE_APIS_MIGRATIONS,
    "webhook-deliveries": [...WEBHOOK_DELIVERIES_MIGRATIONS, ...WEBHOOK_DELIVERIES_TAIL],
    "app-config": [...APP_CONFIG_BASE_MIGRATIONS, ...APP_CONFIG_PRE_POOL_MIGRATIONS, ...APP_CONFIG_MIGRATIONS],
  };

  for (const [shape, migrations] of Object.entries(SHAPES)) {
    test(`${shape}: every table the derived tail touches exists when the tail reaches it`, () => {
      const db = createTestD1();
      for (const name of migrations) {
        if (DERIVED_TAIL.includes(name)) {
          for (const table of touchedTables(migrationSql(name))) {
            const exists = db.raw.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
            expect(
              exists,
              `${shape}: ${name} touches "${table}", which no migration applied before it creates — add the migration that creates "${table}" to TAIL_PREREQUISITES`,
            ).not.toBeNull();
          }
        }
        applyMigrations(db, [name]);
      }
    });
  }
});
