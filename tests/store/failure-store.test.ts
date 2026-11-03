/**
 * Failure-store tests (architect AL-1 + AL-6) — the
 * `review_failures` leaf (src/store/failure-store.ts) over the REAL
 * migration DDL (bun:sqlite D1 double, tests/store/helpers.ts).
 *
 * The store is an append-only event log: record (create) + listRecent
 * (read) are the only faces — update/delete do not exist by design
 * (audit-log semantics: the sweep counts rows, it never mutates
 * them). The best-effort contract lives at the consumer call sites; the
 * store itself fails loud.
 */

import { describe, expect, test } from "bun:test";
import {
  createFailureStore,
  FAILURE_STAGES,
  PAGING_EXCLUDED_STAGES,
  type FailureStage,
} from "../../src/store/failure-store";
import { createMigratedTestD1 } from "./helpers";

const BASE = {
  installation_id: 123,
  owner: "acme",
  repo: "widgets",
  pr_number: 42,
  head_sha: "0123456789abcdef0123456789abcdef01234567",
};

/**
 * The paging classification of every producer stage — the register a stage
 * must join before the sweep's SQL may ignore it. `paging` rows are review
 * failures the ops sweep counts; `attribution` rows record a review that
 * CONTINUED and only the dashboard's history shows them. Keyed by
 * `FailureStage`, so a new union member cannot compile until it is classified
 * here, and the membership test below catches a stage added only to the array.
 */
const PAGING_CLASSIFICATION: Record<FailureStage, "paging" | "attribution"> = {
  parse: "paging",
  runner: "paging",
  sandbox: "paging",
  pipeline: "paging",
  usage: "attribution",
  recheck: "attribution",
};

describe("createFailureStore", () => {
  test("record persists every column; id is a uuid; created_at defaults to datetime('now')", async () => {
    const db = createMigratedTestD1();
    const store = createFailureStore(db);
    await store.record({ ...BASE, stage: "parse", error: "not valid ReviewOutput JSON" });

    const rows = db.raw.query("SELECT * FROM review_failures").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ...BASE,
      stage: "parse",
      error: "not valid ReviewOutput JSON",
    });
    expect(typeof rows[0]!.id).toBe("string");
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // BUG-03 created_at contract: `record` NEVER writes created_at — the
    // column is ALWAYS the DDL DEFAULT `datetime('now')` (migration 0010),
    // i.e. the `YYYY-MM-DD HH:MM:SS` UTC format the sweep's TEXT window
    // comparison depends on. A producer writing ISO-8601/epoch would
    // silently break the sweep — this pin is the guard.
    expect(rows[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("record appends — per-attempt events share the five-tuple (no UNIQUE)", async () => {
    const db = createMigratedTestD1();
    const store = createFailureStore(db);
    for (const attempt of [1, 2, 3]) {
      await store.record({ ...BASE, stage: "runner", error: `runner failed: exit ${attempt}` });
    }
    expect((await store.listRecent()).length).toBe(3);
  });

  test("record rejects an off-vocabulary stage BEFORE any row is written (producer-side enforcement)", async () => {
    const db = createMigratedTestD1();
    const store = createFailureStore(db);
    await expect(store.record({ ...BASE, stage: "not-a-stage" as never, error: "boom" })).rejects.toThrow(
      /not on the producer vocabulary/,
    );
    expect((await store.listRecent()).length).toBe(0);
  });

  test("FAILURE_STAGES is exactly the classified register (a new stage must be classified before it compiles or lands)", () => {
    // The vocabulary is an explicit literal contract, NOT the paging list plus
    // a restated copy: a stage added to the array without a classification,
    // or classified without reaching the array, fails here. The register is
    // `Record<FailureStage, …>`, so a new union member is a type error first.
    expect([...FAILURE_STAGES].sort()).toEqual(
      (Object.keys(PAGING_CLASSIFICATION) as FailureStage[]).sort(),
    );
    // The paging SQL's exclusion set is the attribution half of that register
    // — the sweep must never stop counting a stage this register calls a
    // review failure, and must never page ops for one it calls attribution.
    const excluded: string[] = [...PAGING_EXCLUDED_STAGES];
    expect(excluded.sort()).toEqual(
      (Object.keys(PAGING_CLASSIFICATION) as FailureStage[])
        .filter((stage) => PAGING_CLASSIFICATION[stage] === "attribution")
        .sort(),
    );
  });

  test("listRecent returns newest-first with a rowid tiebreak, bounded by limit", async () => {
    const db = createMigratedTestD1();
    const store = createFailureStore(db);
    const ids: string[] = [];
    for (const stage of ["parse", "runner", "sandbox", "pipeline"] as const) {
      await store.record({ ...BASE, stage, error: `boom-${stage}` });
    }
    ids.push(...(db.raw.query("SELECT id FROM review_failures ORDER BY rowid").all() as Array<{ id: string }>).map((r) => r.id));

    const recent = await store.listRecent(3);
    expect(recent.map((row) => row.id)).toEqual([ids[3]!, ids[2]!, ids[1]!]); // newest first
    // Default limit covers everything written in this test.
    expect((await store.listRecent()).length).toBe(4);
    // Same-second inserts keep a total order via rowid (first written = oldest).
    expect(recent[0]!.stage).toBe("pipeline");
  });
});
