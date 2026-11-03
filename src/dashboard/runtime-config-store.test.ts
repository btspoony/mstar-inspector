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
 *   - values are integers in 1..64 (the max is the deployed queue ceiling); a
 *     workspace value above the system cap is REFUSED by the write itself,
 *     never clamped
 *   - a PRESENT but unparseable value degrades to the conservative cap
 *   - a PRESENT value that is not a string or number is untrusted, never
 *     coerced (`["16"]`, `true` and `{}` all degrade)
 *   - a read failure answers the conservative cap with `degraded: true` and
 *     never throws
 *   - a retired workspace (`deleted_at` set) is ABSENT to both reads — the
 *     default applies, matching the write's live-workspace predicate
 *   - a refused write changes no row and appends no audit row
 *   - accepted writes are audited through `platform_audit_events`, and the
 *     system row's `before` is `null` whenever the stored value is not one the
 *     readers would trust — never a `CAST`ed number nothing ever used
 */
import { describe, expect, test } from "bun:test";
import {
  AboveSystemError,
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  SYSTEM_CONCURRENCY_DEFAULT,
  SYSTEM_CONCURRENCY_KEY,
  WORKSPACE_CONCURRENCY_DEFAULT,
  getEffectiveConcurrency,
  getSystemConcurrency,
  setSystemConcurrency,
  setWorkspaceConcurrency,
} from "./runtime-config-store";
import type { DashboardD1, DashboardD1Statement } from "./users";
import { createMigratedTestD1, type TestD1 } from "../../tests/store/helpers";

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

/** The stored workspace column, read raw so a refused write is observable. */
function storedWorkspace(db: TestD1): number | null {
  const row = db.raw
    .prepare("SELECT max_concurrent_reviews AS value FROM workspaces WHERE id = ?")
    .get(WS) as { value: number | null } | null;
  return row?.value ?? null;
}

/** Every stored system row, raw. */
function storedSystemRows(db: TestD1): Array<{ value: string }> {
  return db.raw.prepare("SELECT value FROM review_runtime_settings").all() as Array<{
    value: string;
  }>;
}

/** The audit ledger, raw. */
function auditRows(db: TestD1): Array<{ action: string; target_id: string }> {
  return db.raw
    .prepare("SELECT action, target_id FROM platform_audit_events ORDER BY action")
    .all() as Array<{ action: string; target_id: string }>;
}

/** The system write's ledger detail, parsed, in insert order. */
function systemAuditDetails(db: TestD1): Array<{ before: unknown; after: unknown }> {
  const rows = db.raw
    .prepare(
      `SELECT detail_json FROM platform_audit_events
        WHERE action = 'runtime.concurrency.system.set' ORDER BY rowid`,
    )
    .all() as Array<{ detail_json: string }>;
  return rows.map((row) => JSON.parse(row.detail_json) as { before: unknown; after: unknown });
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

/** A D1 face whose every `first()` yields this row verbatim — the row-shape path. */
function dbWithRow(row: Record<string, unknown>): DashboardD1 {
  return {
    prepare() {
      const statement: DashboardD1Statement = {
        bind: () => statement,
        first: async () => row as never,
        all: async () => ({ results: [] }),
        run: async () => ({ results: [], meta: { changes: 0, last_row_id: 0 } }),
      };
      return statement;
    },
    batch: async () => [],
  };
}

/** A row double carrying both settings, so either reader shape resolves it. */
function dbWithValues(setting: { system: unknown; workspace: unknown }): DashboardD1 {
  return dbWithRow({
    value: setting.system,
    system_value: setting.system,
    workspace_value: setting.workspace,
  });
}

describe("runtime-config-store", () => {
  test("absent system row falls back to 32", async () =>
    expect(await getSystemConcurrency(fixture())).toEqual({
      concurrency: SYSTEM_CONCURRENCY_DEFAULT,
      degraded: false,
    }));

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

  test("a present but unparseable value degrades to the conservative cap", async () => {
    const db = fixture();
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at)
         VALUES (?1, 'not-a-number', '2026-11-03T00:00:00.000Z')`,
      )
      .run(SYSTEM_CONCURRENCY_KEY);
    expect(await getEffectiveConcurrency(db, WS)).toEqual({
      system: CONCURRENCY_MIN,
      workspace: CONCURRENCY_MIN,
      effective: CONCURRENCY_MIN,
      degraded: true,
    });
    expect(await getSystemConcurrency(db)).toEqual({ concurrency: CONCURRENCY_MIN, degraded: true });
  });

  test("a present but unparseable workspace value degrades to the conservative cap", async () => {
    const db = fixture();
    db.raw.prepare("UPDATE workspaces SET max_concurrent_reviews = 'abc' WHERE id = ?").run(WS);
    expect(await getEffectiveConcurrency(db, WS)).toEqual({
      system: CONCURRENCY_MIN,
      workspace: CONCURRENCY_MIN,
      effective: CONCURRENCY_MIN,
      degraded: true,
    });
  });

  test("an out-of-range stored value is untrusted, not a default", async () => {
    const db = fixture();
    await setSystemConcurrency(db, CONCURRENCY_MAX, ACTOR);
    db.raw
      .prepare("UPDATE review_runtime_settings SET value = ?2 WHERE key = ?1")
      .run(SYSTEM_CONCURRENCY_KEY, String(CONCURRENCY_MAX + 1));
    expect(await getEffectiveConcurrency(db, WS)).toMatchObject({
      effective: CONCURRENCY_MIN,
      degraded: true,
    });
  });

  test("an unreadable result row degrades instead of guessing defaults", async () => {
    const rowlessDb: DashboardD1 = {
      prepare() {
        const statement: DashboardD1Statement = {
          bind: () => statement,
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ results: [], meta: { changes: 0, last_row_id: 0 } }),
        };
        return statement;
      },
      batch: async () => [],
    };
    expect(await getEffectiveConcurrency(rowlessDb, WS)).toEqual({
      system: CONCURRENCY_MIN,
      workspace: CONCURRENCY_MIN,
      effective: CONCURRENCY_MIN,
      degraded: true,
    });
  });

  test("a present row with a missing field degrades instead of defaulting", async () => {
    // A row that exists but does not carry the selected column: absent is
    // `first() === null`, so a missing field must be untrusted, not a default.
    const degraded = {
      system: CONCURRENCY_MIN,
      workspace: CONCURRENCY_MIN,
      effective: CONCURRENCY_MIN,
      degraded: true,
    };
    for (const row of [{}, { workspace_value: 16 }, { system_value: "8" }]) {
      const db = dbWithRow(row);
      expect(await getSystemConcurrency(db)).toEqual({ concurrency: CONCURRENCY_MIN, degraded: true });
      expect(await getEffectiveConcurrency(db, WS)).toEqual(degraded);
    }
  });

  test("a present array, boolean or object value degrades instead of being coerced", async () => {
    // D1's declared column types constrain nothing a row actually carries, so a
    // stored non-string must never reach `Number()`: `["16"]` would read as 16
    // and `true` as 1, admitting concurrency the setting never granted.
    const untrusted = [["16"], true, { nested: "16" }, new Uint8Array([8])];
    for (const bad of untrusted) {
      const db = dbWithValues({ system: bad, workspace: bad });
      const degraded = {
        system: CONCURRENCY_MIN,
        workspace: CONCURRENCY_MIN,
        effective: CONCURRENCY_MIN,
        degraded: true,
      };
      expect(await getSystemConcurrency(db)).toEqual({ concurrency: CONCURRENCY_MIN, degraded: true });
      expect(await getEffectiveConcurrency(db, WS)).toEqual(degraded);
    }
    // One untrusted field is enough: the trusted sibling never rescues the read.
    expect(
      await getEffectiveConcurrency(
        dbWithValues({ system: ["8"], workspace: WORKSPACE_CONCURRENCY_DEFAULT }),
        WS,
      ),
    ).toEqual({
      system: CONCURRENCY_MIN,
      workspace: CONCURRENCY_MIN,
      effective: CONCURRENCY_MIN,
      degraded: true,
    });
  });

  test("a stored numeric string in range still reads as its value", async () => {
    const db = fixture();
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at)
         VALUES (?1, '8', '2026-11-03T00:00:00.000Z')`,
      )
      .run(SYSTEM_CONCURRENCY_KEY);
    db.raw.prepare("UPDATE workspaces SET max_concurrent_reviews = '12' WHERE id = ?").run(WS);
    expect(await getSystemConcurrency(db)).toEqual({ concurrency: 8, degraded: false });
    expect(await getEffectiveConcurrency(db, WS)).toEqual({
      system: 8,
      workspace: 12,
      effective: 8,
      degraded: false,
    });
  });

  test("a D1 read failure returns the conservative cap and degraded:true", async () =>
    expect(await getEffectiveConcurrency(failingDb, WS)).toEqual({
      system: CONCURRENCY_MIN,
      workspace: CONCURRENCY_MIN,
      effective: CONCURRENCY_MIN,
      degraded: true,
    }));

  test("a first workspace write above the system value is refused and writes nothing", async () => {
    const db = fixture();
    await expect(setWorkspaceConcurrency(db, WS, 64, ACTOR)).rejects.toThrow();
    expect(storedWorkspace(db)).toBeNull();
    expect(auditRows(db)).toEqual([]);
  });

  test("a refused workspace write leaves an existing value untouched", async () => {
    const db = fixture();
    await setWorkspaceConcurrency(db, WS, 12, ACTOR);
    await expect(setWorkspaceConcurrency(db, WS, 64, ACTOR)).rejects.toThrow();
    expect(storedWorkspace(db)).toBe(12);
    // Only the accepted write is in the ledger.
    expect(auditRows(db)).toEqual([{ action: "workspace.concurrency.set", target_id: WS }]);
  });

  test("an unknown workspace write is refused and appends no audit row", async () => {
    const db = fixture();
    await expect(setWorkspaceConcurrency(db, "ws_missing", 4, ACTOR)).rejects.toThrow();
    expect(auditRows(db)).toEqual([]);
  });

  test("a retired workspace reads as the default on both reads, never its pinned value", async () => {
    // The settings WRITE already requires a live workspace; the READ must use
    // the same predicate, or a deleted workspace keeps governing its queued
    // jobs with a value nobody can change any more.
    const db = fixture();
    await setWorkspaceConcurrency(db, WS, 12, ACTOR);
    db.raw.prepare("UPDATE workspaces SET deleted_at = '2026-11-04T00:00:00.000Z' WHERE id = ?").run(WS);
    // Absence (not untrusted data), so the effective read is NOT degraded.
    expect(await getEffectiveConcurrency(db, WS)).toEqual({
      system: SYSTEM_CONCURRENCY_DEFAULT,
      workspace: WORKSPACE_CONCURRENCY_DEFAULT,
      effective: WORKSPACE_CONCURRENCY_DEFAULT,
      degraded: false,
    });
  });

  test("non-integer and out-of-range system values are refused and write nothing", async () => {
    const db = fixture();
    await expect(setSystemConcurrency(db, 0, ACTOR)).rejects.toThrow();
    await expect(setSystemConcurrency(db, 2.5, ACTOR)).rejects.toThrow();
    await expect(setSystemConcurrency(db, CONCURRENCY_MAX + 1, ACTOR)).rejects.toThrow();
    expect(storedSystemRows(db)).toEqual([]);
    expect(auditRows(db)).toEqual([]);
  });

  test("a refused system value leaves an existing value untouched", async () => {
    const db = fixture();
    await setSystemConcurrency(db, 8, ACTOR);
    await expect(setSystemConcurrency(db, CONCURRENCY_MAX + 1, ACTOR)).rejects.toThrow();
    expect(storedSystemRows(db)).toEqual([{ value: "8" }]);
  });

  test("a corrupt system row audits before: null and the write repairs it", async () => {
    const db = fixture();
    const seed = db.raw.prepare(
      `INSERT OR REPLACE INTO review_runtime_settings (key, value, updated_at)
       VALUES (?1, ?2, '2026-11-03T00:00:00.000Z')`,
    );
    // A bare CAST would ledger 0 for 'abc', 8 for ' 8' and 99 for the
    // out-of-range row: numbers no reader and no write predicate ever used.
    for (const corrupt of ["abc", " 8", String(CONCURRENCY_MAX + 1)]) {
      seed.run(SYSTEM_CONCURRENCY_KEY, corrupt);
      expect(await setSystemConcurrency(db, 20, ACTOR)).toBe(20);
      expect(storedSystemRows(db)).toEqual([{ value: "20" }]);
      expect(systemAuditDetails(db).at(-1)).toEqual({ before: null, after: 20 });
    }
  });

  test("a readable system row audits its stored value as before", async () => {
    const db = fixture();
    await setSystemConcurrency(db, 20, ACTOR);
    await setSystemConcurrency(db, 24, ACTOR);
    expect(systemAuditDetails(db)).toEqual([
      { before: null, after: 20 },
      { before: 20, after: 24 },
    ]);
  });

  test("a refused workspace value below 1 writes nothing", async () => {
    const db = fixture();
    await expect(setWorkspaceConcurrency(db, WS, 0, ACTOR)).rejects.toThrow();
    expect(storedWorkspace(db)).toBeNull();
    expect(auditRows(db)).toEqual([]);
  });

  test("the above_system refusal quotes the cap the write predicate enforced", async () => {
    // A hand-edited `" 8"` (leading space) is a value the write predicate does
    // NOT accept as a cap: `systemCapSql` answers the conservative 1, so every
    // workspace write above 1 is refused. A second parser reading the row would
    // report 8, i.e. a ceiling no write was ever compared against.
    const db = fixture();
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at)
         VALUES (?1, ' 8', '2026-11-03T00:00:00.000Z')`,
      )
      .run(SYSTEM_CONCURRENCY_KEY);
    const refusal = await setWorkspaceConcurrency(db, WS, 4, ACTOR).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AboveSystemError);
    expect((refusal as AboveSystemError).system).toBe(CONCURRENCY_MIN);
    expect((refusal as AboveSystemError).message).toBe(
      `workspace concurrency 4 exceeds the system cap ${CONCURRENCY_MIN}`,
    );
    expect(storedWorkspace(db)).toBeNull();
  });

  test("a system cap lowered during the write refuses it instead of racing the check", async () => {
    const db = fixture();
    await setSystemConcurrency(db, 32, ACTOR);
    // The cap drops to 8 after any pre-write read but before the UPDATE runs, so
    // a separate check would still see 32 and admit 16.
    const racing = lowerCapAtWrite(db, 8);
    await expect(setWorkspaceConcurrency(racing, WS, 16, ACTOR)).rejects.toThrow(/system cap 8/);
    expect(storedWorkspace(db)).toBeNull();
    expect(auditRows(db)).toEqual([
      { action: "runtime.concurrency.system.set", target_id: SYSTEM_CONCURRENCY_KEY },
    ]);
  });

  test("a workspace value at the current system cap is accepted", async () => {
    const db = fixture();
    await setSystemConcurrency(db, 8, ACTOR);
    expect(await setWorkspaceConcurrency(db, WS, 8, ACTOR)).toBe(8);
    expect(storedWorkspace(db)).toBe(8);
  });

  test("an accepted write is stored and audited with its actor", async () => {
    const db = fixture();
    expect(await setWorkspaceConcurrency(db, WS, 12, ACTOR)).toBe(12);
    expect(await setSystemConcurrency(db, 20, ACTOR)).toBe(20);
    expect(await getSystemConcurrency(db)).toEqual({ concurrency: 20, degraded: false });
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
});

/**
 * Wrap the fixture so the system cap is lowered the instant the write batch
 * starts — after any read the store might do first, before its UPDATE.
 */
function lowerCapAtWrite(db: TestD1, cap: number): DashboardD1 {
  return {
    prepare: (query: string) => db.prepare(query),
    async batch(statements) {
      db.raw
        .prepare("UPDATE review_runtime_settings SET value = ?2 WHERE key = ?1")
        .run(SYSTEM_CONCURRENCY_KEY, String(cap));
      return db.batch(statements);
    },
  };
}
