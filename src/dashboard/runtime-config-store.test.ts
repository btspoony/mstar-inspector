/**
 * Unit tests: the runtime configuration store
 * (src/dashboard/runtime-config-store.ts) over the REAL migration DDL.
 *
 * The fixture is the bun:sqlite double in tests/store/helpers.ts, not a hand
 * rolled row map: the store's SQL uses correlated subqueries, `json_object` and
 * `COALESCE`, so running it against the applied migrations is the only check
 * that means anything. It also proves migration 0040 applies to a fresh
 * database.
 *
 * Locked surface:
 *   - absent system row → 32; NULL workspace column → 16
 *   - effective = min(system, workspace)
 *   - values are integers in 1..250; a workspace value above the system cap is
 *     REFUSED at write time, never clamped
 *   - a read failure answers the conservative cap with `degraded: true` and
 *     never throws
 *   - accepted writes are audited through `platform_audit_events`
 */
import { describe, expect, test } from "bun:test";
import {
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  SYSTEM_CONCURRENCY_DEFAULT,
  WORKSPACE_CONCURRENCY_DEFAULT,
  getEffectiveConcurrency,
  getSystemConcurrency,
  getWorkspaceConcurrency,
  setSystemConcurrency,
  setWorkspaceConcurrency,
} from "./runtime-config-store";
import type { DashboardD1 } from "./users";
import { createMigratedTestD1 } from "../../tests/store/helpers";

const WS = "ws_1";
const ACTOR = "operator";

/** A migrated database with one workspace row at the NULL default. */
function fixture() {
  const db = createMigratedTestD1();
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_at) VALUES (?1, ?1, 'ws one', '2026-11-03T00:00:00.000Z')`,
    )
    .run(WS);
  return db;
}

/** A D1 face whose every statement fails — the degraded read path. */
const failingDb: DashboardD1 = {
  prepare() {
    throw new Error("D1 unavailable");
  },
  batch() {
    throw new Error("D1 unavailable");
  },
};

describe("runtime-config-store", () => {
  test("absent system row falls back to 32", async () =>
    expect(await getSystemConcurrency(fixture())).toBe(SYSTEM_CONCURRENCY_DEFAULT));

  test("workspace NULL falls back to 16", async () =>
    expect(await getWorkspaceConcurrency(fixture(), WS)).toBe(WORKSPACE_CONCURRENCY_DEFAULT));

  test("effective is the smaller of the two caps", async () => {
    const db = fixture();
    expect(await getEffectiveConcurrency(db, WS)).toEqual({
      system: SYSTEM_CONCURRENCY_DEFAULT,
      workspace: WORKSPACE_CONCURRENCY_DEFAULT,
      effective: WORKSPACE_CONCURRENCY_DEFAULT,
      degraded: false,
    });
    await setSystemConcurrency(db, 8, ACTOR);
    expect(await getEffectiveConcurrency(db, WS)).toEqual({
      system: 8,
      workspace: WORKSPACE_CONCURRENCY_DEFAULT,
      effective: 8,
      degraded: false,
    });
  });

  test("a workspace value above the system value is refused, not clamped", async () => {
    const db = fixture();
    await expect(setWorkspaceConcurrency(db, WS, 64, ACTOR)).rejects.toThrow();
    expect(await getWorkspaceConcurrency(db, WS)).toBe(WORKSPACE_CONCURRENCY_DEFAULT);
  });

  test("non-integer and out-of-range values are refused", async () => {
    const db = fixture();
    await expect(setSystemConcurrency(db, 0, ACTOR)).rejects.toThrow();
    await expect(setSystemConcurrency(db, 2.5, ACTOR)).rejects.toThrow();
    await expect(setSystemConcurrency(db, CONCURRENCY_MAX + 1, ACTOR)).rejects.toThrow();
    // A valid write still lands, so the refusals above wrote nothing.
    await expect(setSystemConcurrency(db, CONCURRENCY_MIN, ACTOR)).resolves.toBe(CONCURRENCY_MIN);
    expect(await getSystemConcurrency(db)).toBe(CONCURRENCY_MIN);
  });

  test("a D1 read failure returns the conservative cap and degraded:true", async () =>
    expect(await getEffectiveConcurrency(failingDb, WS)).toEqual({
      system: CONCURRENCY_MIN,
      workspace: CONCURRENCY_MIN,
      effective: CONCURRENCY_MIN,
      degraded: true,
    }));

  test("an accepted write is stored and audited with its actor", async () => {
    const db = fixture();
    expect(await setWorkspaceConcurrency(db, WS, 12, ACTOR)).toBe(12);
    expect(await setSystemConcurrency(db, 20, ACTOR)).toBe(20);
    expect(await getWorkspaceConcurrency(db, WS)).toBe(12);
    expect(await getSystemConcurrency(db)).toBe(20);
    const rows = db.raw
      .prepare(`SELECT actor_login, action, target_id FROM platform_audit_events ORDER BY action`)
      .all() as Array<{ actor_login: string; action: string; target_id: string }>;
    expect(rows).toEqual([
      {
        actor_login: ACTOR,
        action: "runtime.concurrency.system.set",
        target_id: "review.concurrency.system",
      },
      { actor_login: ACTOR, action: "workspace.concurrency.set", target_id: WS },
    ]);
  });

  test("an unknown workspace write is refused and appends no audit row", async () => {
    const db = fixture();
    await expect(setWorkspaceConcurrency(db, "ws_missing", 4, ACTOR)).rejects.toThrow();
    const rows = db.raw.prepare("SELECT id FROM platform_audit_events").all();
    expect(rows).toEqual([]);
  });
});
