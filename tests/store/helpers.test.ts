/**
 * The test D1 double's change-count contract: a row-returning write reports the
 * rows it modified, as D1's `meta.changes` does — `1` when a guarded
 * `INSERT … SELECT … RETURNING` matched, `0` when it did not — with `results`
 * unchanged and a plain read changing nothing.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "./helpers";

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
});
