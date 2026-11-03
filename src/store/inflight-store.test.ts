/**
 * Unit tests: the in-flight review store (src/store/inflight-store.ts) over the
 * REAL migration DDL.
 *
 * The fixture is the bun:sqlite double in tests/store/helpers.ts with every
 * migration applied (`createMigratedTestD1`), so this file also proves 0041
 * applies to a fresh database and that the PRIMARY KEY / index shapes are what
 * the conditional acquire depends on.
 *
 * Locked surface:
 *   - room under both caps → acquired
 *   - a live row for the PR → `pr-held`; a live row anywhere → `system-cap`;
 *     a live row in the workspace → `workspace-cap`
 *   - an EXPIRED row does not hold the PR and does not count toward the caps
 *   - release deletes only the row its own `attempt_id` wrote
 *   - a storage failure → `error` with a `fault` cause naming the exception,
 *     never `ok`; a raced refusal names `released-between-statements`
 *   - a malformed `now`, a non-finite TTL, or a TTL of zero or less → `error`,
 *     never a throw and never an already-expired row reported as success
 *   - `owner`/`repo` are matched case-insensitively across insert, refusal and
 *     release (GitHub is case-insensitive; the PRIMARY KEY is not)
 */
import { describe, expect, test } from "bun:test";
import {
  acquireInflight,
  releaseInflight,
  type AcquireInflightOptions,
  type InflightKey,
} from "./inflight-store";
import type { D1Like, D1StatementLike } from "./types";
import { createMigratedTestD1, type TestD1 } from "../../tests/store/helpers";

const KEY: InflightKey = {
  installation_id: 42,
  owner: "acme",
  repo: "widgets",
  pr_number: 7,
  workspace_id: "ws_1",
};

const OPTS: AcquireInflightOptions = {
  systemCap: 32,
  workspaceCap: 16,
  attemptId: "attempt-1",
  ttlSeconds: 600,
  now: "2026-11-03T00:00:00Z",
};

/** One PR identity in another workspace (same cap math, distinct tenant). */
function otherPr(prNumber: number, workspaceId = KEY.workspace_id): InflightKey {
  return { ...KEY, pr_number: prNumber, workspace_id: workspaceId };
}

function freshDb(): TestD1 {
  return createMigratedTestD1();
}

/** A handle whose `prepare` throws synchronously — a dead D1 binding. */
const failingDb: D1Like = {
  prepare() {
    throw new Error("D1 unavailable");
  },
  async batch() {
    throw new Error("D1 unavailable");
  },
};

describe("inflight-store", () => {
  test("acquires when both caps have room", async () => {
    const db = freshDb();
    expect(await acquireInflight(db, KEY, OPTS)).toEqual({ ok: true });
    const rows = db.raw.query("SELECT * FROM review_inflight").all();
    expect(rows).toHaveLength(1);
  });

  test("refuses a second attempt for the same PR", async () => {
    const db = freshDb();
    expect(await acquireInflight(db, KEY, OPTS)).toEqual({ ok: true });
    expect(await acquireInflight(db, KEY, { ...OPTS, attemptId: "attempt-2" })).toEqual({
      ok: false,
      reason: "pr-held",
    });
  });

  test("refuses when the system cap is reached", async () => {
    const db = freshDb();
    expect(await acquireInflight(db, KEY, { ...OPTS, systemCap: 0 })).toEqual({
      ok: false,
      reason: "system-cap",
    });
  });

  test("refuses when the workspace cap is reached", async () => {
    const db = freshDb();
    expect(await acquireInflight(db, KEY, { ...OPTS, workspaceCap: 0 })).toEqual({
      ok: false,
      reason: "workspace-cap",
    });
  });

  test("a cap reached by another workspace refuses only that workspace", async () => {
    const db = freshDb();
    expect(await acquireInflight(db, otherPr(1, "ws_1"), { ...OPTS, systemCap: 2 })).toEqual({
      ok: true,
    });
    expect(await acquireInflight(db, otherPr(2, "ws_2"), { ...OPTS, systemCap: 2 })).toEqual({
      ok: true,
    });
    // System cap is spent; a third workspace gets `system-cap`, not a slot.
    expect(await acquireInflight(db, otherPr(3, "ws_3"), { ...OPTS, systemCap: 2 })).toEqual({
      ok: false,
      reason: "system-cap",
    });
    // A second PR of ws_2 is refused by the workspace cap, not the PR lock.
    expect(
      await acquireInflight(db, otherPr(4, "ws_2"), {
        ...OPTS,
        systemCap: 3,
        workspaceCap: 1,
      }),
    ).toEqual({ ok: false, reason: "workspace-cap" });
  });

  test("an expired row is reclaimed by the next acquire", async () => {
    const db = freshDb();
    expect(await acquireInflight(db, KEY, { ...OPTS, ttlSeconds: 60 })).toEqual({ ok: true });
    expect(
      await acquireInflight(db, KEY, {
        ...OPTS,
        attemptId: "attempt-2",
        now: "2026-11-03T00:02:00Z",
      }),
    ).toEqual({ ok: true });
    // The reclaim replaced the row in place — one row, the newer attempt's.
    const rows = db.raw.query("SELECT * FROM review_inflight").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempt_id).toBe("attempt-2");
  });

  test("an expired row does not count toward the caps", async () => {
    const db = freshDb();
    expect(await acquireInflight(db, KEY, { ...OPTS, ttlSeconds: 60 })).toEqual({ ok: true });
    expect(
      await acquireInflight(db, otherPr(8), {
        ...OPTS,
        systemCap: 1,
        workspaceCap: 1,
        now: "2026-11-03T00:02:00Z",
      }),
    ).toEqual({ ok: true });
  });

  test("release is scoped to attemptId and cannot delete a newer attempt", async () => {
    const db = freshDb();
    await acquireInflight(db, KEY, OPTS);
    await releaseInflight(db, KEY, "stale-attempt");
    expect(await acquireInflight(db, KEY, { ...OPTS, attemptId: "attempt-2" })).toEqual({
      ok: false,
      reason: "pr-held",
    });
  });

  test("release with this attempt's id frees the PR", async () => {
    const db = freshDb();
    await acquireInflight(db, KEY, OPTS);
    await releaseInflight(db, KEY, OPTS.attemptId);
    const rows = db.raw.query("SELECT * FROM review_inflight").all();
    expect(rows).toHaveLength(0);
    expect(await acquireInflight(db, KEY, { ...OPTS, attemptId: "attempt-2" })).toEqual({
      ok: true,
    });
  });

  test("a raced zero-row acquire is distinguishable from a fault", async () => {
    // The insert reports zero rows while the follow-up read still shows room:
    // the capacity was released between the two statements. That is a benign
    // race, not a dead binding, and the result must say so.
    const db = freshDb();
    const zeroRow: D1StatementLike = {
      bind: () => zeroRow,
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ results: [], meta: { changes: 0, last_row_id: 0 } }),
    };
    const racingDb: D1Like = {
      prepare: (sql: string) =>
        sql.includes("INSERT INTO review_inflight") ? zeroRow : db.prepare(sql),
      batch: (statements) => db.batch(statements),
    };
    expect(await acquireInflight(racingDb, KEY, OPTS)).toEqual({
      ok: false,
      reason: "error",
      cause: { kind: "released-between-statements" },
    });
  });

  test("a D1 error returns reason error with the fault cause and never ok", async () => {
    expect(await acquireInflight(failingDb, KEY, OPTS)).toEqual({
      ok: false,
      reason: "error",
      cause: { kind: "fault", detail: "D1 unavailable" },
    });
  });

  test("a malformed `now` or non-finite TTL answers error instead of throwing", async () => {
    const db = freshDb();
    const malformed = await acquireInflight(db, KEY, { ...OPTS, now: "not-a-date" });
    expect(malformed.ok).toBe(false);
    expect(malformed).toMatchObject({ reason: "error", cause: { kind: "fault" } });
    const badTtl = await acquireInflight(db, KEY, { ...OPTS, ttlSeconds: Number.NaN });
    expect(badTtl).toMatchObject({ reason: "error", cause: { kind: "fault" } });
    // Neither refusal wrote a row — fail-closed never admits.
    expect(db.raw.query("SELECT * FROM review_inflight").all()).toHaveLength(0);
  });

  test("a zero or negative TTL is refused, never an already-expired success", async () => {
    // A non-positive TTL writes `expires_at <= now`: the row holds no PR and
    // reserves no slot, so reporting `ok` would admit a review the lock never
    // guarded. Both must answer the fault refusal and write nothing.
    const db = freshDb();
    for (const ttlSeconds of [0, -1, -600]) {
      expect(await acquireInflight(db, KEY, { ...OPTS, ttlSeconds })).toMatchObject({
        ok: false,
        reason: "error",
        cause: { kind: "fault" },
      });
    }
    expect(db.raw.query("SELECT * FROM review_inflight").all()).toHaveLength(0);
  });

  test("owner/repo case does not split or evade the per-PR lock", async () => {
    // GitHub owner/repo are case-insensitive; the row's PRIMARY KEY is not.
    // Insert, refusal read and release must all land on ONE normalized key.
    const db = freshDb();
    expect(await acquireInflight(db, { ...KEY, owner: "Acme", repo: "Widgets" }, OPTS)).toEqual({
      ok: true,
    });
    expect(
      await acquireInflight(db, { ...KEY, owner: "acme", repo: "widgets" }, { ...OPTS, attemptId: "attempt-2" }),
    ).toEqual({ ok: false, reason: "pr-held" });
    const rows = db.raw.query("SELECT * FROM review_inflight").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBe("acme");
    // Release through the OTHER spelling frees the row the first spelling wrote.
    await releaseInflight(db, { ...KEY, owner: "ACME", repo: "WIDGETS" }, OPTS.attemptId);
    expect(db.raw.query("SELECT * FROM review_inflight").all()).toHaveLength(0);
  });
});
