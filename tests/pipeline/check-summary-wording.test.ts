/**
 * note: Task 2 — the Check summary carries the persisted APPROVED wording, and only
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
 * note: A due row whose terminal intent is already frozen — the shape an unconfirmed
 * send leaves behind: the approved text and category are durable, the remote
 * update is not proven.
 */
async function frozenCapStop(db: TestD1): Promise<string> {
  // note: Past its own execution deadline: the point at which a frozen failure is
  // the conclusion the lane owes (a live row still waits for its proof).
  const { attempt, lease } = await claim(db, {
    nowMs: CLAIM_AT,
    holder: "settler",
    executionDeadlineMs: EXPIRED_DEADLINE,
  });
  const id = attempt.identity.attemptId;
  // note: Setup writes ride the claim's own lease: the reconciler's clock (T0) is
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
          // note: The run exists and is still running: the terminal write is due.
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
    // note: The send is the PERSISTED approval — not a re-decision, not a formatter.
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
          // note: What the run looks like when the earlier update LANDED and only its
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
    // note: Reading back what already landed is progress; re-sending it is a wasted
    // request against the same run.
    expect(updates).toBe(0);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("failure");
    expect(row.desired_summary).toBe(APPROVED);
    expect(row.terminal_failure_status).toBe("cap-stop");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("a conclusion-only match on a concluded run is never rewritten", async () => {
    const db = seededDb();
    const id = await frozenCapStop(db);
    let updates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0 + 1,
        credentials: scriptedCredentials(db, {
          // note: Same conclusion, but the run's own text is an OLDER wording (an
          // earlier writer's, or none at all) — and the run is CONCLUDED. A concluded
          // Check is never rewritten, so the wording is not delivered over it.
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
            return {
              kind: "completed",
              remote: remoteFor(identity, { id: checkRunId, conclusion: "failure", summary: conclusion.summary }),
            };
          },
        }),
      });
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect(updates).toBe(0);
    const row = await rawRow(db, id);
    // note: The disagreement is recorded as a spent attempt (the ladder ends honestly);
    // the run keeps its own concluded text and its own id.
    expect(row.check_run_id).toBe(4242);
    expect(row.observed).not.toBe("failure");
    expect(row.terminal_ms).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_ms).not.toBeNull();
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
      // note: The mismatch spends a recovery attempt and backs off; it is never
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

  test("a reply without the frozen text is not delivery — and a concluded run is never rewritten", async () => {
    const db = seededDb();
    const id = await frozenCapStop(db);
    let updates = 0;
    const fetchStub = stubFetch();
    try {
      // note: Pass 1: the update is dispatched, and its reply carries this attempt's
      // conclusion with NO readable output. The wording is what the user reads,
      // so this reply proves nothing.
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
      // note: Still owed, and still bound to the SAME run.
      expect(afterFirst.check_run_id).toBe(4242);
      expect(afterFirst.next_attempt_ms).not.toBeNull();

      // note: Pass 2: the run is now CONCLUDED and still lacks the text. A concluded
      // run is never rewritten, so nothing is sent and the row takes another deferral.
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
      expect(second.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect(updates).toBe(1);
    const row = await rawRow(db, id);
    // note: Nothing terminal was recorded from a concluded run's text-less record, and
    // the row keeps its own run and its frozen intent for the next ladder step.
    expect(row.check_run_id).toBe(4242);
    expect(row.observed).not.toBe("failure");
    expect(row.terminal_ms).toBeNull();
    expect(row.attempts).toBe(2);
    expect(row.desired_summary).toBe(APPROVED);
  });

  test("a waiting attempt keeps no failure text and is never examined", async () => {
    const db = seededDb();
    // note: The review is still running: the row wants `in_progress` and its own
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
    // note: The recovery lease the live attempt holds was never taken.
    expect(row.lease_until_ms).toBeGreaterThan(T0 + CHECK_RECOVERY_LEASE_MS - 1);
  });
});
