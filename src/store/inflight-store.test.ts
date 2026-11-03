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
 *   - a storage failure → `error`, never `ok`
 *   - the default TTL is the `default` level's guard budget
 */
// Side-effect ONLY: the TTL pin below loads the consumer, which transitively
// loads the sandbox adapter (the one `cloudflare:workers` importer Bun's test
// runner cannot resolve). Every such file imports the shared registration.
import "../../tests/helpers/cloudflare-workers-mock";
import { describe, expect, test } from "bun:test";
import {
  INFLIGHT_DEFAULT_TTL_SECONDS,
  acquireInflight,
  countInflight,
  releaseInflight,
  type AcquireInflightOptions,
  type InflightKey,
} from "./inflight-store";
import type { D1Like } from "./types";
import { createMigratedTestD1, type TestD1 } from "../../tests/store/helpers";

// Dynamic on purpose: `consumer.ts` statically imports the sandbox adapter, and
// a static import here would be linked before the mock above is registered.
const { reviewGuardTtlSeconds } = await import("../pipeline/consumer");

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
    expect(await countInflight(db, OPTS.now)).toEqual({ total: 1, byWorkspace: 1 });
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
    expect(await countInflight(db, "2026-11-03T00:02:00Z")).toEqual({ total: 1, byWorkspace: 1 });
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
    expect(await countInflight(db, OPTS.now)).toEqual({ total: 0, byWorkspace: 0 });
    expect(await acquireInflight(db, KEY, { ...OPTS, attemptId: "attempt-2" })).toEqual({
      ok: true,
    });
  });

  test("a D1 error returns reason error and never ok", async () => {
    expect(await acquireInflight(failingDb, KEY, OPTS)).toEqual({ ok: false, reason: "error" });
  });

  test("the default TTL tracks the default level's guard budget", () => {
    expect(INFLIGHT_DEFAULT_TTL_SECONDS).toBe(reviewGuardTtlSeconds("default"));
  });
});
