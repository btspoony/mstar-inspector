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
 *   - absent system row → 256; NULL workspace column → 32
 *   - effective = min(system, workspace)
 *   - the system value is an integer in 1..256 (the platform quota);
 *     the workspace value is an integer in 1..32, independent of the system
 *     quota — that quota applies at admission, never as a write refusal
 *   - a PRESENT but unparseable value degrades to the conservative cap
 *   - a PRESENT value that is not a string or number is untrusted, never
 *     coerced (`["16"]`, `true` and `{}` all degrade)
 *   - a read failure answers the conservative cap with `degraded: true` and
 *     never throws (both readers)
 *   - a workspace value above its maximum is clamped to the maximum by the
 *     read, so a deploy-window write cannot degrade that workspace to serial
 *   - a retired workspace (`deleted_at` set) is ABSENT to both reads — the
 *     default applies, matching the write's live-workspace predicate
 *   - a refused write changes no row and appends no audit row
 *   - accepted writes are audited through `platform_audit_events`, and the
 *     `before` of both the system row and the workspace column is `null`
 *     whenever the stored value is not one the readers would trust — never a
 *     `CAST`ed number nothing ever used
 *
 * The operator default review level (plan 036a) is the same table with a
 * vocabulary instead of a range: an absent row reads `"default"`, a value off
 * `REVIEW_LEVELS` reads `"default"` with `degraded: true` and never throws, and
 * a write outside the vocabulary is refused with no row and no audit row.
 */
import { describe, expect, test } from "bun:test";
import {
  CHECK_TERMINALIZE_DEFAULT,
  CHECK_TERMINALIZE_KEY,
  CHECK_UPDATE_DEFAULT,
  CHECK_UPDATE_KEY,
  CONCURRENCY_MIN,
  RECHECK_ASSIGNMENT_DEFAULT,
  RECHECK_ASSIGNMENT_KEY,
  RECHECK_ASSIGNMENT_MAX,
  RECHECK_ASSIGNMENT_MIN,
  REVIEW_LEVEL_DEFAULT,
  REVIEW_LEVEL_KEY,
  RuntimeConfigError,
  SYSTEM_CONCURRENCY_DEFAULT,
  SYSTEM_CONCURRENCY_KEY,
  SYSTEM_CONCURRENCY_MAX,
  WORKSPACE_CONCURRENCY_DEFAULT,
  WORKSPACE_CONCURRENCY_MAX,
  getCheckBudgets,
  getEffectiveConcurrency,
  getRecheckAssignmentMaxBytes,
  getSystemConcurrency,
  getWorkspaceConcurrency,
  readDefaultReviewLevel,
  setCheckBudgets,
  setDefaultReviewLevel,
  setRecheckAssignmentMaxBytes,
  setSystemConcurrency,
  setWorkspaceConcurrency,
} from "./runtime-config-store";
import type { ReviewLevel } from "../../packages/shared/src/runtime";
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

/** One write action's ledger detail, parsed, in insert order. */
function auditDetails(db: TestD1, action: string): Array<{ before: unknown; after: unknown }> {
  const rows = db.raw
    .prepare(
      `SELECT detail_json FROM platform_audit_events
        WHERE action = ?1 ORDER BY rowid`,
    )
    .all(action) as Array<{ detail_json: string }>;
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
  test("absent system row falls back to 256", async () =>
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
    await setSystemConcurrency(db, SYSTEM_CONCURRENCY_MAX, ACTOR);
    db.raw
      .prepare("UPDATE review_runtime_settings SET value = ?2 WHERE key = ?1")
      .run(SYSTEM_CONCURRENCY_KEY, String(SYSTEM_CONCURRENCY_MAX + 1));
    expect(await getEffectiveConcurrency(db, WS)).toMatchObject({
      effective: CONCURRENCY_MIN,
      degraded: true,
    });
  });

  test("a workspace value above its maximum reads as the maximum, not degraded", async () => {
    // 0043 lowers the rows that exist when it applies, but the window between
    // "migrations applied" and "new Worker live" can admit one more 33..64
    // write. The read clamps it so the workspace keeps a real cap instead of
    // degrading to serial.
    const db = fixture();
    db.raw
      .prepare("UPDATE workspaces SET max_concurrent_reviews = ?1 WHERE id = ?2")
      .run(WORKSPACE_CONCURRENCY_MAX + 8, WS);
    expect(await getWorkspaceConcurrency(db, WS)).toEqual({
      concurrency: WORKSPACE_CONCURRENCY_MAX,
      degraded: false,
    });
    expect(await getEffectiveConcurrency(db, WS)).toEqual({
      system: SYSTEM_CONCURRENCY_DEFAULT,
      workspace: WORKSPACE_CONCURRENCY_MAX,
      effective: WORKSPACE_CONCURRENCY_MAX,
      degraded: false,
    });
  });

  test("a D1 failure on the workspace reader answers the conservative cap", async () =>
    expect(await getWorkspaceConcurrency(failingDb, WS)).toEqual({
      concurrency: CONCURRENCY_MIN,
      degraded: true,
    }));

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

  test("a workspace value above its own maximum is refused and writes nothing", async () => {
    const db = fixture();
    await expect(
      setWorkspaceConcurrency(db, WS, WORKSPACE_CONCURRENCY_MAX + 1, ACTOR),
    ).rejects.toThrow();
    expect(storedWorkspace(db)).toBeNull();
    expect(auditRows(db)).toEqual([]);
  });

  test("a workspace write is never refused for the system quota's sake", async () => {
    // Refusing on the system cap would let a tenant binary-search the platform
    // number; the quota applies at admission as min(system, workspace).
    const db = fixture();
    await setSystemConcurrency(db, 8, ACTOR);
    expect(await setWorkspaceConcurrency(db, WS, 16, ACTOR)).toBe(16);
    expect(storedWorkspace(db)).toBe(16);
    expect(await getEffectiveConcurrency(db, WS)).toEqual({
      system: 8,
      workspace: 16,
      effective: 8,
      degraded: false,
    });
  });

  test("a refused workspace write leaves an existing value untouched", async () => {
    const db = fixture();
    await setWorkspaceConcurrency(db, WS, 12, ACTOR);
    await expect(
      setWorkspaceConcurrency(db, WS, WORKSPACE_CONCURRENCY_MAX + 1, ACTOR),
    ).rejects.toThrow();
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
    await expect(setSystemConcurrency(db, SYSTEM_CONCURRENCY_MAX + 1, ACTOR)).rejects.toThrow();
    expect(storedSystemRows(db)).toEqual([]);
    expect(auditRows(db)).toEqual([]);
  });

  test("a refused system value leaves an existing value untouched", async () => {
    const db = fixture();
    await setSystemConcurrency(db, 8, ACTOR);
    await expect(setSystemConcurrency(db, SYSTEM_CONCURRENCY_MAX + 1, ACTOR)).rejects.toThrow();
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
    for (const corrupt of ["abc", " 8", String(SYSTEM_CONCURRENCY_MAX + 1)]) {
      seed.run(SYSTEM_CONCURRENCY_KEY, corrupt);
      expect(await setSystemConcurrency(db, 20, ACTOR)).toBe(20);
      expect(storedSystemRows(db)).toEqual([{ value: "20" }]);
      expect(auditDetails(db, "runtime.concurrency.system.set").at(-1)).toEqual({
        before: null,
        after: 20,
      });
    }
  });

  test("a readable system row audits its stored value as before", async () => {
    const db = fixture();
    await setSystemConcurrency(db, 20, ACTOR);
    await setSystemConcurrency(db, 24, ACTOR);
    expect(auditDetails(db, "runtime.concurrency.system.set")).toEqual([
      { before: null, after: 20 },
      { before: 20, after: 24 },
    ]);
  });

  test("a corrupt workspace row audits what the reader applied and the write repairs it", async () => {
    const db = fixture();
    const seed = db.raw.prepare(
      "UPDATE workspaces SET max_concurrent_reviews = ?1 WHERE id = ?2",
    );
    // The ledger mirrors the reader: non-canonical text is `null`, an
    // above-maximum value is the maximum the read clamped it to.
    for (const [corrupt, before] of [
      ["abc", null],
      [WORKSPACE_CONCURRENCY_MAX + 1, WORKSPACE_CONCURRENCY_MAX],
    ] as const) {
      seed.run(corrupt, WS);
      expect(await setWorkspaceConcurrency(db, WS, 12, ACTOR)).toBe(12);
      expect(storedWorkspace(db)).toBe(12);
      expect(auditDetails(db, "workspace.concurrency.set").at(-1)).toEqual({
        before,
        after: 12,
      });
    }
    // A readable stored value is still recorded as itself.
    expect(await setWorkspaceConcurrency(db, WS, 8, ACTOR)).toBe(8);
    expect(auditDetails(db, "workspace.concurrency.set").at(-1)).toEqual({
      before: 12,
      after: 8,
    });
  });

  test("a refused workspace value below 1 writes nothing", async () => {
    const db = fixture();
    await expect(setWorkspaceConcurrency(db, WS, 0, ACTOR)).rejects.toThrow();
    expect(storedWorkspace(db)).toBeNull();
    expect(auditRows(db)).toEqual([]);
  });

  test("a corrupt system row does not affect workspace writes", async () => {
    // The tenant path never parses the system row, so an unreadable quota can
    // neither refuse a write nor leak its fallback through one.
    const db = fixture();
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at)
         VALUES (?1, ' 8', '2026-11-03T00:00:00.000Z')`,
      )
      .run(SYSTEM_CONCURRENCY_KEY);
    expect(await setWorkspaceConcurrency(db, WS, 20, ACTOR)).toBe(20);
    expect(storedWorkspace(db)).toBe(20);
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

describe("check budgets", () => {
  /** Both stored budget rows, raw, keyed by PK. */
  function storedBudgetsRaw(db: TestD1): Record<string, string> {
    const rows = db.raw
      .prepare("SELECT key, value FROM review_runtime_settings ORDER BY key")
      .all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  test("absent rows fall back to the documented defaults without degrading", async () =>
    expect(await getCheckBudgets(fixture())).toEqual({
      terminalizeMs: CHECK_TERMINALIZE_DEFAULT,
      updateMs: CHECK_UPDATE_DEFAULT,
      degraded: false,
    }));

  test("an untrusted or out-of-range stored value answers the defaults with degraded: true", async () => {
    for (const value of ["not-a-number", "999999", "0"]) {
      const db = fixture();
      db.raw
        .prepare(
          `INSERT INTO review_runtime_settings (key, value, updated_at)
           VALUES (?1, ?2, '2026-11-03T00:00:00.000Z')`,
        )
        .run(CHECK_UPDATE_KEY, value);
      expect(await getCheckBudgets(db), value).toEqual({
        terminalizeMs: CHECK_TERMINALIZE_DEFAULT,
        updateMs: CHECK_UPDATE_DEFAULT,
        degraded: true,
      });
    }
  });

  test("a read failure answers the defaults with degraded: true and never throws", async () =>
    expect(await getCheckBudgets(failingDb)).toEqual({
      terminalizeMs: CHECK_TERMINALIZE_DEFAULT,
      updateMs: CHECK_UPDATE_DEFAULT,
      degraded: true,
    }));

  test("an out-of-range pair is refused and writes nothing", async () => {
    const db = fixture();
    for (const pair of [
      { terminalizeMs: 999, updateMs: 5_000 },
      { terminalizeMs: 30_001, updateMs: 5_000 },
      { terminalizeMs: 10_000, updateMs: 499 },
      { terminalizeMs: 10_000, updateMs: 15_001 },
      { terminalizeMs: 10_000.5, updateMs: 5_000 },
    ]) {
      await expect(setCheckBudgets(db, pair, ACTOR)).rejects.toBeInstanceOf(RuntimeConfigError);
    }
    expect(storedBudgetsRaw(db)).toEqual({});
    expect(auditRows(db)).toEqual([]);
  });

  test("a pair whose wait does not exceed the send budget is refused with the relation only", async () => {
    const db = fixture();
    for (const pair of [
      { terminalizeMs: 5_000, updateMs: 5_000 },
      { terminalizeMs: 4_000, updateMs: 5_000 },
    ]) {
      const error = await setCheckBudgets(db, pair, ACTOR).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(RuntimeConfigError);
      // The refusal states the RELATION, never the other stored value.
      expect((error as Error).message).toBe(
        "the terminalize timeout must be greater than the check update budget",
      );
    }
    expect(storedBudgetsRaw(db)).toEqual({});
    expect(auditRows(db)).toEqual([]);
  });

  test("an accepted pair lands both rows with one audit row, and reads back", async () => {
    const db = fixture();
    expect(await setCheckBudgets(db, { terminalizeMs: 12_000, updateMs: 7_000 }, ACTOR)).toEqual({
      terminalizeMs: 12_000,
      updateMs: 7_000,
    });
    expect(storedBudgetsRaw(db)).toEqual({
      [CHECK_TERMINALIZE_KEY]: "12000",
      [CHECK_UPDATE_KEY]: "7000",
    });
    expect(await getCheckBudgets(db)).toEqual({
      terminalizeMs: 12_000,
      updateMs: 7_000,
      degraded: false,
    });
    expect(auditRows(db)).toEqual([
      { action: "runtime.check_budgets.set", target_id: "review.check.budgets" },
    ]);
    expect(auditDetails(db, "runtime.check_budgets.set")).toEqual([
      {
        before: { terminalizeMs: null, updateMs: null },
        after: { terminalizeMs: 12_000, updateMs: 7_000 },
      },
    ]);

    // A second save records the previous pair as `before`.
    await setCheckBudgets(db, { terminalizeMs: 9_000, updateMs: 6_000 }, ACTOR);
    expect(auditDetails(db, "runtime.check_budgets.set")[1]).toEqual({
      before: { terminalizeMs: 12_000, updateMs: 7_000 },
      after: { terminalizeMs: 9_000, updateMs: 6_000 },
    });
  });
});

describe("default review level", () => {
  /** The stored default-level row, raw. */
  function storedLevel(db: TestD1): string | null {
    const row = db.raw
      .prepare("SELECT value FROM review_runtime_settings WHERE key = ?")
      .get(REVIEW_LEVEL_KEY) as { value: string } | null;
    return row?.value ?? null;
  }

  /** That row as another writer left it, bypassing the store. */
  function seedLevel(db: TestD1, value: string): void {
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at)
         VALUES (?1, ?2, '2026-11-03T00:00:00.000Z')`,
      )
      .run(REVIEW_LEVEL_KEY, value);
  }

  test("an absent row reads the documented default without degrading", async () =>
    expect(await readDefaultReviewLevel(fixture())).toEqual({
      value: REVIEW_LEVEL_DEFAULT,
      degraded: false,
    }));

  test("a stored level reads back as itself", async () => {
    const db = fixture();
    seedLevel(db, "deep");
    expect(await readDefaultReviewLevel(db)).toEqual({ value: "deep", degraded: false });
  });

  test("an off-vocabulary stored value answers the default with degraded: true", async () => {
    for (const value of ["turbo", "QUICK", " deep", ""]) {
      const db = fixture();
      seedLevel(db, value);
      expect(await readDefaultReviewLevel(db), value).toEqual({
        value: REVIEW_LEVEL_DEFAULT,
        degraded: true,
      });
    }
  });

  test("a read failure answers the default with degraded: true and never throws", async () =>
    expect(await readDefaultReviewLevel(failingDb)).toEqual({
      value: REVIEW_LEVEL_DEFAULT,
      degraded: true,
    }));

  test("an off-vocabulary write is refused and writes nothing", async () => {
    const db = fixture();
    for (const value of ["turbo", "QUICK", ""]) {
      await expect(setDefaultReviewLevel(db, value as ReviewLevel, ACTOR)).rejects.toBeInstanceOf(
        RuntimeConfigError,
      );
    }
    expect(storedLevel(db)).toBeNull();
    expect(auditRows(db)).toEqual([]);
  });

  test("an accepted write lands the row with one audit row, and reads back", async () => {
    const db = fixture();
    expect(await setDefaultReviewLevel(db, "deep", ACTOR)).toBe("deep");
    expect(storedLevel(db)).toBe("deep");
    expect(await readDefaultReviewLevel(db)).toEqual({ value: "deep", degraded: false });
    expect(auditRows(db)).toEqual([
      { action: "runtime.review_level.set", target_id: REVIEW_LEVEL_KEY },
    ]);
    expect(auditDetails(db, "runtime.review_level.set")).toEqual([
      { before: null, after: "deep" },
    ]);

    // A second save records the previous level as `before`.
    await setDefaultReviewLevel(db, "quick", ACTOR);
    expect(auditDetails(db, "runtime.review_level.set")[1]).toEqual({
      before: "deep",
      after: "quick",
    });
  });

  test("a corrupt stored level is audited as null, not as the raw text", async () => {
    const db = fixture();
    seedLevel(db, "turbo");
    await setDefaultReviewLevel(db, "deep", ACTOR);
    expect(auditDetails(db, "runtime.review_level.set")).toEqual([{ before: null, after: "deep" }]);
  });
});

describe("recheck assignment budget", () => {
  /** The stored budget row, raw so a refused write is observable. */
  function storedBudget(db: TestD1): string | null {
    const row = db.raw
      .prepare("SELECT value FROM review_runtime_settings WHERE key = ?")
      .get(RECHECK_ASSIGNMENT_KEY) as { value: string } | null;
    return row?.value ?? null;
  }

  /** That row as another writer left it, bypassing the store. */
  function seedBudget(db: TestD1, value: string): void {
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at)
         VALUES (?1, ?2, '2026-11-03T00:00:00.000Z')`,
      )
      .run(RECHECK_ASSIGNMENT_KEY, value);
  }

  test("an absent row reads the runner's documented default without degrading", async () =>
    expect(await getRecheckAssignmentMaxBytes(fixture())).toEqual({
      maxBytes: RECHECK_ASSIGNMENT_DEFAULT,
      degraded: false,
    }));

  test("a stored value reads back as itself", async () => {
    const db = fixture();
    seedBudget(db, "131072");
    expect(await getRecheckAssignmentMaxBytes(db)).toEqual({ maxBytes: 131_072, degraded: false });
  });

  test("an untrusted or out-of-range stored value answers the default with degraded: true", async () => {
    for (const value of ["not-a-number", String(RECHECK_ASSIGNMENT_MIN - 1), String(RECHECK_ASSIGNMENT_MAX + 1), "0"]) {
      const db = fixture();
      seedBudget(db, value);
      expect(await getRecheckAssignmentMaxBytes(db), value).toEqual({
        maxBytes: RECHECK_ASSIGNMENT_DEFAULT,
        degraded: true,
      });
    }
  });

  test("a read failure answers the default with degraded: true and never throws", async () =>
    expect(await getRecheckAssignmentMaxBytes(failingDb)).toEqual({
      maxBytes: RECHECK_ASSIGNMENT_DEFAULT,
      degraded: true,
    }));

  test("an out-of-range or non-integer write is refused and writes nothing", async () => {
    const db = fixture();
    for (const value of [
      RECHECK_ASSIGNMENT_MIN - 1,
      RECHECK_ASSIGNMENT_MAX + 1,
      131_072.5,
      0,
    ]) {
      await expect(setRecheckAssignmentMaxBytes(db, value, ACTOR)).rejects.toBeInstanceOf(
        RuntimeConfigError,
      );
    }
    expect(storedBudget(db)).toBeNull();
    expect(auditRows(db)).toEqual([]);
  });

  test("an accepted write lands the row with one audit row, and reads back", async () => {
    const db = fixture();
    expect(await setRecheckAssignmentMaxBytes(db, 131_072, ACTOR)).toBe(131_072);
    expect(storedBudget(db)).toBe("131072");
    expect(await getRecheckAssignmentMaxBytes(db)).toEqual({ maxBytes: 131_072, degraded: false });
    expect(auditRows(db)).toEqual([
      { action: "runtime.recheck_assignment.set", target_id: RECHECK_ASSIGNMENT_KEY },
    ]);
    expect(auditDetails(db, "runtime.recheck_assignment.set")).toEqual([
      { before: { maxBytes: null }, after: { maxBytes: 131_072 } },
    ]);

    // A second save records the previous value as `before`.
    await setRecheckAssignmentMaxBytes(db, 200_000, ACTOR);
    expect(auditDetails(db, "runtime.recheck_assignment.set")[1]).toEqual({
      before: { maxBytes: 131_072 },
      after: { maxBytes: 200_000 },
    });
  });

  test("a corrupt stored value is audited as null, not as the raw text", async () => {
    const db = fixture();
    seedBudget(db, "not-a-number");
    await setRecheckAssignmentMaxBytes(db, 65_536, ACTOR);
    expect(auditDetails(db, "runtime.recheck_assignment.set")).toEqual([
      { before: { maxBytes: null }, after: { maxBytes: 65_536 } },
    ]);
  });
});
