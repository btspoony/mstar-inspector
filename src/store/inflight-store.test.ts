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

const SHA = "0123456789abcdef0123456789abcdef01234567";

const OPTS: AcquireInflightOptions = {
  systemCap: 32,
  workspaceCap: 16,
  attemptId: "attempt-1",
  ttlSeconds: 600,
  headSha: SHA,
  now: "2026-11-03T00:00:00Z",
};

function otherPr(prNumber: number, workspaceId = KEY.workspace_id): InflightKey {
  return { ...KEY, pr_number: prNumber, workspace_id: workspaceId };
}

function freshDb(): TestD1 {
  return createMigratedTestD1();
}

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
      heldHeadSha: SHA,
      heldAttemptId: "attempt-1",
      heldExpired: false,
    });
  });

  test("the row carries the reviewed sha; a null sha reads back as ''", async () => {
    const db = freshDb();
    expect(await acquireInflight(db, KEY, OPTS)).toEqual({ ok: true });
    const rows = db.raw.query("SELECT head_sha FROM review_inflight").all() as Array<{ head_sha: string }>;
    expect(rows[0]!.head_sha).toBe(SHA);

    expect(await acquireInflight(db, otherPr(9), { ...OPTS, headSha: null })).toEqual({ ok: true });
    const commentRow = db.raw
      .query("SELECT head_sha FROM review_inflight WHERE pr_number = 9")
      .get() as { head_sha: string };
    expect(commentRow.head_sha).toBe("");
    expect(
      await acquireInflight(db, otherPr(9), { ...OPTS, attemptId: "attempt-2", headSha: "a".repeat(40) }),
    ).toEqual({ ok: false, reason: "pr-held", heldHeadSha: "", heldAttemptId: "attempt-1", heldExpired: false });
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
    expect(await acquireInflight(db, otherPr(3, "ws_3"), { ...OPTS, systemCap: 2 })).toEqual({
      ok: false,
      reason: "system-cap",
    });
    expect(
      await acquireInflight(db, otherPr(4, "ws_2"), {
        ...OPTS,
        systemCap: 3,
        workspaceCap: 1,
      }),
    ).toEqual({ ok: false, reason: "workspace-cap" });
  });

  test("expiry alone never reassigns the PR — only its own attempt may re-acquire it", async () => {
    const db = freshDb();
    expect(await acquireInflight(db, KEY, { ...OPTS, ttlSeconds: 60 })).toEqual({ ok: true });
    expect(
      await acquireInflight(db, KEY, {
        ...OPTS,
        attemptId: "attempt-2",
        now: "2026-11-03T00:02:00Z",
      }),
    ).toEqual({
      ok: false,
      reason: "pr-held",
      heldHeadSha: SHA,
      heldAttemptId: "attempt-1",
      heldExpired: true,
    });
    let rows = db.raw.query("SELECT * FROM review_inflight").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempt_id).toBe("attempt-1");
    expect(await acquireInflight(db, KEY, { ...OPTS, ttlSeconds: 60, now: "2026-11-03T00:02:00Z" })).toEqual({
      ok: true,
    });
    rows = db.raw.query("SELECT * FROM review_inflight").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempt_id).toBe("attempt-1");
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
      heldHeadSha: SHA,
      heldAttemptId: "attempt-1",
      heldExpired: false,
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
    expect(db.raw.query("SELECT * FROM review_inflight").all()).toHaveLength(0);
  });

  test("a zero or negative TTL is refused, never an already-expired success", async () => {
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
    const db = freshDb();
    expect(await acquireInflight(db, { ...KEY, owner: "Acme", repo: "Widgets" }, OPTS)).toEqual({
      ok: true,
    });
    expect(
      await acquireInflight(db, { ...KEY, owner: "acme", repo: "widgets" }, { ...OPTS, attemptId: "attempt-2" }),
    ).toEqual({ ok: false, reason: "pr-held", heldHeadSha: SHA, heldAttemptId: "attempt-1", heldExpired: false });
    const rows = db.raw.query("SELECT * FROM review_inflight").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBe("acme");
    await releaseInflight(db, { ...KEY, owner: "ACME", repo: "WIDGETS" }, OPTS.attemptId);
    expect(db.raw.query("SELECT * FROM review_inflight").all()).toHaveLength(0);
  });
});
