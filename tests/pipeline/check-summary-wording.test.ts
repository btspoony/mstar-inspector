/**
 * Task 2 — the Check summary carries the persisted APPROVED wording, and only
 * counts as delivered when that wording actually reached the run (spec §7.9,
 * plan "Persistence and reconciliation contract").
 *
 * Behaviors covered:
 *   - a send from a frozen intent carries the frozen approved text and its
 *     category, never a re-derived or formatted message;
 *   - a lost reply followed by a read of the SAME conclusion and text is
 *     reconciliation: the run is recorded, nothing is re-sent;
 *   - a conclusion-only match is NOT delivery: the wording never reached the
 *     user, so the frozen intent is sent to that same run;
 *   - a different conclusion is reported, never overwritten;
 *   - a waiting attempt shows no failure text at all.
 */
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

/**
 * A due row whose terminal intent is already frozen — the shape an unconfirmed
 * send leaves behind: the approved text and category are durable, the remote
 * update is not proven.
 */
async function frozenCapStop(db: TestD1): Promise<string> {
  // Past its own execution deadline: the point at which a frozen failure is
  // the conclusion the lane owes (a live row still waits for its proof).
  const { attempt, lease } = await claim(db, {
    nowMs: CLAIM_AT,
    holder: "settler",
    executionDeadlineMs: EXPIRED_DEADLINE,
  });
  const id = attempt.identity.attemptId;
  // Setup writes ride the claim's own lease: the reconciler's clock (T0) is
  // past it, which is exactly why recovery owns the row by then.
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
          // The run exists and is still running: the terminal write is due.
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
    // The send is the PERSISTED approval — not a re-decision, not a formatter.
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
          // What the run looks like when the earlier update LANDED and only its
          // reply was lost: completed, same conclusion, same approved text.
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
    // Reading back what already landed is progress; re-sending it is a wasted
    // request against the same run.
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
          // Same conclusion, but the run's own text is an OLDER wording (an
          // earlier writer's, or none at all): the user never read the
          // approved one.
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
    // The SAME run is corrected — never replaced by a fresh one.
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
      // The mismatch spends a recovery attempt and backs off; it is never
      // recorded as this row's outcome and never rewritten from here.
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

  test("a waiting attempt keeps no failure text and is never examined", async () => {
    const db = seededDb();
    // The review is still running: the row wants `in_progress` and its own
    // execution deadline has not passed.
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
    // The recovery lease the live attempt holds was never taken.
    expect(row.lease_until_ms).toBeGreaterThan(T0 + CHECK_RECOVERY_LEASE_MS - 1);
  });
});
