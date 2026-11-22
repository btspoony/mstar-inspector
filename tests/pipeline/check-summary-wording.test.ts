import { describe, expect, test } from "bun:test";
import {
  CHECK_ATTACH_WINDOW_MS,
  CHECK_NAME,
  attachCheckRunId,
  releaseCheckClaim,
  setCheckCreateState,
  setCheckDesired,
  type CheckConclusion,
} from "../../src/store/review-checks";
import { TERMINAL_FAILURE_TEXT } from "../../src/pipeline/checks";
import {
  CLAIM_AT,
  EXPIRED_DEADLINE,
  claim,
  rawRow,
  remoteFor,
  run,
  scriptedCredentials,
  seededDb,
  stubFetch,
  T0,
} from "../worker/helpers/check-reconcile";
import { CHECK_RECOVERY_LEASE_MS } from "../../src/store/review-checks";
import type { CheckReconcileSummary } from "../../src/worker/check-reconcile";
import type { TestD1 } from "../store/helpers";

const APPROVED = TERMINAL_FAILURE_TEXT["cap-stop"];

async function frozenCapStop(db: TestD1): Promise<string> {
  const { attempt, lease } = await claim(db, {
    nowMs: CLAIM_AT,
    holder: "settler",
    executionDeadlineMs: EXPIRED_DEADLINE,
  });
  const id = attempt.identity.attemptId;
  const setupAt = CLAIM_AT + 1;
  await setCheckCreateState(db, id, lease, "sending", undefined, setupAt);
  expect(await attachCheckRunId(db, id, lease, 4242, setupAt)).toBe(true);
  const conclusion: CheckConclusion = {
    desired: "failure",
    title: CHECK_NAME,
    summary: APPROVED,
    failureStatus: "cap-stop",
  };
  expect(await setCheckDesired(db, id, lease, conclusion, null, setupAt)).toBe(true);
  expect(await releaseCheckClaim(db, id, lease, setupAt)).toBe(true);
  return id;
}

describe("the Check summary carries the approved wording", () => {
  test("a landed update sends the frozen text and its category verbatim", async () => {
    const db = seededDb();
    const id = await frozenCapStop(db);
    let sent: CheckConclusion | null = null;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0 + 1,
        credentials: scriptedCredentials(db, {
          fetch: async (identity, checkRunId) => ({
            kind: "found",
            remote: remoteFor(identity, { id: checkRunId, status: "in_progress", conclusion: null }),
          }),
          complete: async (identity, checkRunId, conclusion) => {
            sent = conclusion;
            return {
              kind: "completed",
              remote: remoteFor(identity, { id: checkRunId, conclusion: "failure", summary: conclusion.summary }),
            };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(sent).not.toBeNull();
    expect(sent!.summary).toBe(APPROVED);
    expect(sent!.failureStatus).toBe("cap-stop");
    expect(sent!.desired).toBe("failure");
    const row = await rawRow(db, id);
    expect(row.observed).toBe("failure");
    expect(row.terminal_failure_status).toBe("cap-stop");
    expect(row.desired_summary).toBe(APPROVED);
  });

  test("a lost reply plus a matching read is reconciliation, not a resend", async () => {
    const db = seededDb();
    const id = await frozenCapStop(db);
    let updates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0 + 1,
        credentials: scriptedCredentials(db, {
          fetch: async (identity, checkRunId) => ({
            kind: "found",
            remote: remoteFor(identity, {
              id: checkRunId,
              status: "completed",
              conclusion: "failure",
              summary: APPROVED,
            }),
          }),
          complete: async (identity, checkRunId, conclusion) => {
            updates += 1;
            return { kind: "completed", remote: remoteFor(identity, { id: checkRunId, summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(updates).toBe(0);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("failure");
    expect(row.desired_summary).toBe(APPROVED);
    expect(row.terminal_failure_status).toBe("cap-stop");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("a conclusion-only match is not delivery — the frozen text is sent to that run", async () => {
    const db = seededDb();
    const id = await frozenCapStop(db);
    let sent: CheckConclusion | null = null;
    let updates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0 + 1,
        credentials: scriptedCredentials(db, {
          fetch: async (identity, checkRunId) => ({
            kind: "found",
            remote: remoteFor(identity, {
              id: checkRunId,
              status: "completed",
              conclusion: "failure",
              summary: "Review failed.",
            }),
          }),
          complete: async (identity, checkRunId, conclusion) => {
            updates += 1;
            sent = conclusion;
            return {
              kind: "completed",
              remote: remoteFor(identity, { id: checkRunId, conclusion: "failure", summary: conclusion.summary }),
            };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(updates).toBe(1);
    expect(sent!.summary).toBe(APPROVED);
    expect(sent!.failureStatus).toBe("cap-stop");
    const row = await rawRow(db, id);
    expect(row.check_run_id).toBe(4242);
    expect(row.observed).toBe("failure");
    expect(row.desired_summary).toBe(APPROVED);
  });

  test("a run finished with a DIFFERENT conclusion is reported, never overwritten", async () => {
    const db = seededDb();
    const id = await frozenCapStop(db);
    let updates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0 + 1,
        credentials: scriptedCredentials(db, {
          fetch: async (identity, checkRunId) => ({
            kind: "found",
            remote: remoteFor(identity, { id: checkRunId, status: "completed", conclusion: "success", summary: "ok" }),
          }),
          complete: async (identity, checkRunId, conclusion) => {
            updates += 1;
            return { kind: "completed", remote: remoteFor(identity, { id: checkRunId, summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect(updates).toBe(0);
    const row = await rawRow(db, id);
    expect(row.observed).not.toBe("failure");
    expect(row.terminal_ms).toBeNull();
    expect(row.attempts).toBe(1);
  });

  test("a reply without the frozen text is not delivery — that run is sent again", async () => {
    const db = seededDb();
    const id = await frozenCapStop(db);
    let updates = 0;
    const fetchStub = stubFetch();
    try {
      const first = await run(db, {
        now: () => T0 + 1,
        credentials: scriptedCredentials(db, {
          fetch: async (identity, checkRunId) => ({
            kind: "found",
            remote: remoteFor(identity, { id: checkRunId, status: "in_progress", conclusion: null }),
          }),
          complete: async (identity, checkRunId) => {
            updates += 1;
            return {
              kind: "completed",
              remote: remoteFor(identity, {
                id: checkRunId,
                status: "completed",
                conclusion: "failure",
                summary: null,
              }),
            };
          },
        }),
      });
      expect(first.completed).toBe(0);
      const afterFirst = await rawRow(db, id);
      expect(afterFirst.observed).not.toBe("failure");
      expect(afterFirst.terminal_ms).toBeNull();
      expect(afterFirst.desired_summary).toBe(APPROVED);
      expect(afterFirst.check_run_id).toBe(4242);
      expect(afterFirst.next_attempt_ms).not.toBeNull();

      const second = await run(db, {
        now: () => T0 + 61_000,
        credentials: scriptedCredentials(db, {
          fetch: async (identity, checkRunId) => ({
            kind: "found",
            remote: remoteFor(identity, {
              id: checkRunId,
              status: "completed",
              conclusion: "failure",
              summary: null,
            }),
          }),
          complete: async (identity, checkRunId, conclusion) => {
            updates += 1;
            return {
              kind: "completed",
              remote: remoteFor(identity, {
                id: checkRunId,
                status: "completed",
                conclusion: "failure",
                summary: conclusion.summary,
              }),
            };
          },
        }),
      });
      expect(second.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(updates).toBe(2);
    const row = await rawRow(db, id);
    expect(row.check_run_id).toBe(4242);
    expect(row.observed).toBe("failure");
    expect(row.terminal_ms).not.toBeNull();
    expect(row.desired_summary).toBe(APPROVED);
  });

  test("a waiting attempt keeps no failure text and is never examined", async () => {
    const db = seededDb();
    const { attempt } = await claim(db, { executionDeadlineMs: T0 + 900_000 });
    const id = attempt.identity.attemptId;
    const fetchStub = stubFetch();
    let summary: CheckReconcileSummary;
    try {
      summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db) });
    } finally {
      fetchStub.restore();
    }
    expect(summary.examined).toBe(0);
    expect(summary.completed).toBe(0);
    const row = await rawRow(db, id);
    expect(row.desired).toBe("in_progress");
    expect(row.terminal_failure_status).toBeNull();
    expect(row.desired_summary).toBeNull();
    expect(row.terminal_ms).toBeNull();
    expect(row.lease_until_ms).toBeGreaterThan(T0 + CHECK_RECOVERY_LEASE_MS - 1);
  });
});
