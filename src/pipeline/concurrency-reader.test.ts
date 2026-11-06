/**
 * Unit tests: the pipeline's review-concurrency reader
 * (src/pipeline/concurrency-reader.ts) — the logging wrapper the queue
 * consumer calls at admission over the runtime-config store.
 *
 * The fixture is the bun:sqlite double executing the REAL migrations, so the
 * reader's one statement runs against the production schema (migration 0040
 * included).
 *
 * Locked surface:
 *   - a healthy read exposes BOTH caps separately plus their effective min, and
 *     logs nothing
 *   - a workspace cap below the system cap stays distinct from it
 *   - a degraded read returns the conservative cap (1, i.e. serial) for both
 *     levels, never throws, and logs EXACTLY one structured warn carrying the
 *     store's reason
 *   - both degradation paths warn: a throwing read, and a PRESENT value the
 *     store cannot trust
 */
import { describe, expect, test } from "bun:test";
import type { DashboardD1 } from "../dashboard/users";
import { createMigratedTestD1 } from "../../tests/store/helpers";
import { readReviewConcurrency, type ReviewConcurrencyLogFields } from "./concurrency-reader";

const WS = "ws_1";

/** A migrated database with one workspace row at the NULL (default) cap. */
function fixture() {
  const db = createMigratedTestD1();
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_at) VALUES (?1, ?1, 'ws one', '2026-11-03T00:00:00.000Z')`,
    )
    .run(WS);
  return db;
}

/** Captures every structured warn line the reader emits. */
function capture() {
  const warns: Array<{ fields: ReviewConcurrencyLogFields; msg?: string }> = [];
  const log = {
    warn: (fields: ReviewConcurrencyLogFields, msg?: string) => void warns.push({ fields, msg }),
  };
  return { warns, log };
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

describe("readReviewConcurrency", () => {
  test("a healthy read exposes both caps and their effective min, and logs nothing", async () => {
    const { warns, log } = capture();
    // Absent settings: system defaults to 256, the workspace column to 32.
    expect(await readReviewConcurrency(fixture(), WS, log)).toEqual({
      system: 256,
      workspace: 32,
      effective: 32,
      degraded: false,
    });
    expect(warns).toEqual([]);
  });

  test("a workspace cap below the system cap stays separate from it", async () => {
    const db = fixture();
    db.raw.prepare(`UPDATE workspaces SET max_concurrent_reviews = 2 WHERE id = ?1`).run(WS);
    const { warns, log } = capture();
    expect(await readReviewConcurrency(db, WS, log)).toEqual({
      system: 256,
      workspace: 2,
      effective: 2,
      degraded: false,
    });
    expect(warns).toEqual([]);
  });

  test("a failed read answers the conservative cap and logs exactly one warn", async () => {
    const { warns, log } = capture();
    const read = readReviewConcurrency(failingDb, WS, log);
    expect(await read).toEqual({
      system: 1,
      workspace: 1,
      effective: 1,
      degraded: true,
      reason: "read-failed",
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields).toEqual({
      event: "review_concurrency_degraded",
      workspace_id: WS,
      effective: 1,
      degraded_reason: "read-failed",
    });
  });

  test("a present but untrusted stored value degrades instead of taking the default", async () => {
    const db = fixture();
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at) VALUES ('review.concurrency.system', 'abc', '2026-11-03T00:00:00.000Z')`,
      )
      .run();
    const { warns, log } = capture();
    expect(await readReviewConcurrency(db, WS, log)).toEqual({
      system: 1,
      workspace: 1,
      effective: 1,
      degraded: true,
      reason: "untrusted",
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields.degraded_reason).toBe("untrusted");
  });
});
