/**
 * The publication-journal proof WAIT (spec §7.9/§7.11.2).
 *
 * A Check handed over by the consumer's journal hand-off must not be
 * terminalized while its publication is still in flight — the lane gives the
 * recovery claim back and re-checks on the next tick — and must still fail
 * closed once the attempt's execution deadline passes.
 *
 * Split out of `check-reconcile.test.ts` so this contract has its own suite;
 * every fixture comes from `./helpers/check-reconcile`, so the two suites drive
 * the same production surface.
 */
import { describe, expect, test } from "bun:test";
import { PUBLICATION_IN_FLIGHT_PHASES } from "../../src/store/finding-lifecycle";
import {
  CHECK_NAME,
  deferCheckRecovery,
  setCheckDesired,
  type CheckConclusion,
  type CheckIdentity,
} from "../../src/store/review-checks";
import type { TestD1 } from "../store/helpers";
import type { AdapterScript } from "./helpers/check-reconcile";
import {
  SCOPE,
  SHA,
  T0,
  UNCONFIRMED,
  claim,
  proofFor,
  rawRow,
  remoteFor,
  reviewPayload,
  run,
  scriptedCredentials,
  seedJournal,
  seededDb,
  stubFetch,
  withFailingReads,
} from "./helpers/check-reconcile";

/** The attempt's own execution deadline (the wait's hard stop). */
const DEADLINE = T0 + 900_000;

/**
 * The state the consumer's journal hand-off leaves behind: the unconfirmed
 * fallback frozen, the claim released at the first backoff rung, no proof yet.
 */
async function handedOverAttempt(db: TestD1) {
  const { attempt, lease } = await claim(db, { nowMs: T0, executionDeadlineMs: DEADLINE });
  const id = attempt.identity.attemptId;
  expect(
    await setCheckDesired(db, id, lease, { desired: "failure", title: CHECK_NAME, summary: UNCONFIRMED }, null, T0),
  ).toBe(true);
  expect(
    await deferCheckRecovery(
      db,
      id,
      lease,
      { state: "remote-unconfirmed", nextAttemptMs: T0 + 60_000, reason: "publication journal handoff" },
      T0,
    ),
  ).toBe(true);
  return { attempt, id };
}

/** Counts adapter operations — a waiting pass must issue none of them. */
type AdapterCalls = { adopt: number; begin: number; complete: number };

function countingScript(calls: AdapterCalls): AdapterScript {
  return {
    adopt: async () => {
      calls.adopt += 1;
      return { kind: "absent" as const };
    },
    begin: async (identity: CheckIdentity) => {
      calls.begin += 1;
      return { kind: "ready" as const, remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
    },
    fetch: async (identity: CheckIdentity, checkRunId: number) => ({
      kind: "found" as const,
      remote: remoteFor(identity, { id: checkRunId, status: "in_progress", conclusion: null }),
    }),
    complete: async (identity: CheckIdentity, _runId: number, conclusion: CheckConclusion) => {
      calls.complete += 1;
      return { kind: "completed" as const, remote: remoteFor(identity, { conclusion: conclusion.desired }) };
    },
  };
}

describe("publication-journal proof wait (spec §7.9/§7.11.2)", () => {
  test("the in-flight phase set is exactly the three unproven phases", () => {
    // Pinned so dropping a phase from the constant fails HERE, and every phase
    // below is proven to defer in its own case.
    expect([...PUBLICATION_IN_FLIGHT_PHASES]).toEqual(["prepared", "sending", "unknown"]);
  });

  for (const phase of PUBLICATION_IN_FLIGHT_PHASES) {
    test(`a ${phase} journal defers the pass, then concludes from the arrived proof`, async () => {
      const db = seededDb();
      const { attempt, id } = await handedOverAttempt(db);
      const journalId = seedJournal(db, SCOPE, SHA, phase);

      const firstStub = stubFetch();
      const calls = { adopt: 0, begin: 0, complete: 0 };
      // The COUNTER is on the factory itself: adapter counters cannot tell
      // "waited before the credential factory" from "waited after it".
      let factoryCalls = 0;
      const scripted = scriptedCredentials(db, countingScript(calls));
      const events: Array<Record<string, unknown>> = [];
      try {
        const first = await run(db, {
          now: () => T0 + 120_000, // due, far inside the execution deadline
          log: { warn: () => {}, info: (fields) => void events.push(fields) },
          credentials: async (input) => {
            factoryCalls += 1;
            return scripted(input);
          },
        });
        expect(first.examined).toBe(1);
        expect(first.deferred).toBe(1);
        expect(first.completed).toBe(0);
      } finally {
        firstStub.restore();
      }

      // The credential factory never ran, no remote operation happened at all,
      // and the create mark never moved: a stray adopt/begin/create would leave
      // the row no longer `not-sent`.
      expect(factoryCalls).toBe(0);
      expect(calls).toEqual({ adopt: 0, begin: 0, complete: 0 });
      const waiting = await rawRow(db, id);
      expect(waiting.create_state).toBe("not-sent");
      expect(waiting.terminal_ms).toBeNull();
      expect(waiting.observed).toBe("unknown");
      expect(waiting.desired).toBe("failure");
      expect(waiting.desired_summary).toBe(UNCONFIRMED);
      expect(waiting.attempts).toBe(1); // the wait spends NO attempt
      expect(waiting.next_attempt_ms).toBe(T0 + 120_000 + 60_000);
      expect(waiting.holder).toBeNull();
      expect(waiting.lease_until_ms).toBeNull();

      const deferredLines = events.filter(
        (fields) => fields.event === "check_recovery_deferred_pending_publication",
      );
      // ONE event per deferred row, carrying the probe's answer AND the phase.
      expect(deferredLines).toHaveLength(1);
      const deferredLine = deferredLines[0]!;
      expect(deferredLine.attempt_id).toBe(id);
      expect(deferredLine.probe_state).toBe("pending");
      expect(deferredLine.phase).toBe(phase);
      expect(deferredLine.next_attempt_ms).toBe(T0 + 120_000 + 60_000);

      // The publication now proves itself: the SAME attempt concludes from it.
      const proof = { ...proofFor(attempt.identity, "review"), publicationId: journalId };
      db.raw
        .prepare(`UPDATE review_publications SET phase = 'confirmed', proof_json = ?, payload_json = ? WHERE id = ?`)
        .run(JSON.stringify(proof), JSON.stringify(reviewPayload(SCOPE, SHA, "ship it", 85)), journalId);

      const secondStub = stubFetch();
      const sent: { desired: string | null } = { desired: null };
      try {
        const second = await run(db, {
          now: () => T0 + 200_000,
          credentials: scriptedCredentials(db, {
            ...countingScript({ adopt: 0, begin: 0, complete: 0 }),
            complete: async (identity, _runId, conclusion) => {
              sent.desired = conclusion.desired;
              return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired }) };
            },
          }),
        });
        expect(second.completed).toBe(1);
        expect(second.deferred).toBe(0);
      } finally {
        secondStub.restore();
      }

      expect(sent.desired).toBe("success");
      const settled = await rawRow(db, id);
      expect(settled.observed).toBe("success");
      expect(settled.terminal_ms).not.toBeNull();
    });
  }

  for (const lifecycle of ["disabled", "deleted"] as const) {
    test(`a ${lifecycle} App enters suspension instead of the wait (the D1 gate leads)`, async () => {
      const db = seededDb();
      const { id } = await handedOverAttempt(db);
      seedJournal(db, SCOPE, SHA, "prepared");
      db.raw
        .prepare(
          lifecycle === "disabled"
            ? `UPDATE github_apps SET status = 'disabled' WHERE id = ?`
            : `UPDATE github_apps SET deleted_at = datetime('now') WHERE id = ?`,
        )
        .run("11111111-2222-3333-4444-555555555555");

      const stub = stubFetch();
      let factoryCalls = 0;
      const warned: Array<Record<string, unknown>> = [];
      try {
        const summary = await run(db, {
          now: () => T0 + 120_000,
          log: { warn: (fields) => void warned.push(fields), info: () => {} },
          credentials: async (input) => {
            factoryCalls += 1;
            return scriptedCredentials(db)(input);
          },
        });
        // The lifecycle gate WINS over the wait: suspended, never deferred.
        expect(summary.suspended).toBe(1);
        expect(summary.deferred).toBe(0);
      } finally {
        stub.restore();
      }

      // No credential was minted and no Check work was produced.
      expect(factoryCalls).toBe(0);
      const row = await rawRow(db, id);
      expect(row.recovery_state).toBe("suspended");
      expect(row.terminal_ms).toBeNull();
      expect(
        warned.some((fields) => fields.event === "ops_check_reconcile_pair_suspended"),
      ).toBe(true);
      expect(
        warned.some((fields) => fields.event === "check_recovery_deferred_pending_publication"),
      ).toBe(false);
    });
  }

  test("an unreadable journal probe defers inside the window instead of terminalizing", async () => {
    const db = seededDb();
    const { id } = await handedOverAttempt(db);
    // The probe's own read fails. "Unknown" is NOT "nothing pending": the
    // publication may still be in flight, and this attempt is inside its
    // window, so the lane must wait exactly as it does for a readable journal.
    const unreadable = withFailingReads(db, /FROM review_publications/);
    const stub = stubFetch();
    const calls = { adopt: 0, begin: 0, complete: 0 };
    const events: Array<Record<string, unknown>> = [];
    try {
      const summary = await run(unreadable, {
        now: () => T0 + 120_000,
        log: { warn: () => {}, info: (fields) => void events.push(fields) },
        credentials: scriptedCredentials(db, countingScript(calls)),
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
      expect(summary.unconfirmed).toBe(0);
    } finally {
      stub.restore();
    }

    // The probe's answer is `unknown`; the phase is absent because no journal
    // was read — never the literal phase 'unknown'.
    const deferredLines = events.filter(
      (fields) => fields.event === "check_recovery_deferred_pending_publication",
    );
    expect(deferredLines).toHaveLength(1);
    expect(deferredLines[0]!.probe_state).toBe("unknown");
    expect("phase" in deferredLines[0]!).toBe(false);

    expect(calls).toEqual({ adopt: 0, begin: 0, complete: 0 });
    const row = await rawRow(db, id);
    expect(row.terminal_ms).toBeNull();
    expect(row.observed).toBe("unknown");
    expect(row.next_attempt_ms).toBe(T0 + 120_000 + 60_000);
  });

  test("the execution deadline is the hard stop: a pending journal no longer defers there", async () => {
    const db = seededDb();
    const { id } = await handedOverAttempt(db);
    seedJournal(db, SCOPE, SHA, "prepared");

    const stub = stubFetch();
    const sent: { desired: string | null } = { desired: null };
    let deferred = -1;
    try {
      const summary = await run(db, {
        now: () => DEADLINE,
        credentials: scriptedCredentials(db, {
          ...countingScript({ adopt: 0, begin: 0, complete: 0 }),
          complete: async (identity, _runId, conclusion) => {
            sent.desired = conclusion.desired;
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired }) };
          },
        }),
      });
      deferred = summary.deferred;
    } finally {
      stub.restore();
    }

    expect(deferred).toBe(0);
    expect(sent.desired).toBe("failure");
    const row = await rawRow(db, id);
    expect(row.observed).toBe("failure");
    expect(row.terminal_ms).not.toBeNull();
  });
});
