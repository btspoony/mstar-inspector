/**
 * The test D1 double's change-count contract: a row-returning write reports the
 * rows it modified, as D1's `meta.changes` does — `1` when a guarded
 * `INSERT … SELECT … RETURNING` matched, `0` when it did not — with `results`
 * unchanged and a plain read changing nothing.
 */
import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { createMigratedTestD1, createTestD1, migrationNumber, migrationsAfter } from "./helpers";

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

/**
 * The REAL `node:fs` exports, captured before any mock. Bun's `mock.module`
 * registry is process-global (see `tests/review/runtime-omp.test.ts`), and
 * `mock.restore()` does not undo a builtin mock, so the synthetic-directory
 * case below restores `node:fs` by re-registering this snapshot.
 */
const REAL_FS = { ...fs };

describe("migration order", () => {
  test("a synthetic duplicate pair orders by filename, never by readdir order", async () => {
    // `zzz` before `aaa` is the order a non-lexical directory listing hands
    // back. `number(a) - number(b)` alone keeps it; the byte-order tie-break
    // is what the duplicates in `migrations/` depend on, so reverting that
    // tie-break fails exactly here.
    mock.module("node:fs", () => ({
      ...REAL_FS,
      readdirSync: () => ["0043_zzz_synthetic.sql", "0043_aaa_synthetic.sql"],
    }));
    // Dynamic import with a query: the mock must be registered before
    // `./helpers` loads, and the query keeps this file's registry key apart
    // from the statically imported real module above.
    const SPEC = "./helpers.ts?synthetic-ordinals";
    try {
      const synthetic = (await import(SPEC)) as { migrationsAfter: typeof migrationsAfter };
      expect(synthetic.migrationsAfter(0)).toEqual([
        "0043_aaa_synthetic.sql",
        "0043_zzz_synthetic.sql",
      ]);
    } finally {
      mock.module("node:fs", () => REAL_FS);
    }
  });
});
