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
import {
  CHECK_BACKOFF_MS,
  CHECK_NAME,
  CHECK_RECONCILE_LIMIT,
  deferCheckRecovery,
  listCheckReconcileBatch,
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
  linkPublication,
  proofFor,
  rawRow,
  remoteFor,
  reviewPayload,
  run,
  scriptedCredentials,
  seedJournal,
  seedPublication,
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
  // The phases are ENUMERATED here on purpose: the behaviour cases below are
  // the contract, so dropping a phase from the wait set fails them rather than
  // a source-shape assertion.
  for (const phase of ["prepared", "sending", "unknown"] as const) {
    test(`a ${phase} journal defers the pass, then concludes from the arrived proof`, async () => {
      const db = seededDb();
      const { attempt, id } = await handedOverAttempt(db);
      const journalId = seedJournal(db, SCOPE, SHA, phase);
      // The journal row IS this attempt's own publication — the link its intent
      // write records. Without it no proof on this head can decide the attempt.
      linkPublication(db, id, journalId);

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

      // The credential factory never ran — the readable `unknown` PHASE
      // included, which is a real journal state, not a failed read — and no
      // remote operation happened at all. A stray adopt/begin/create would leave
      // the create mark no longer `not-sent`.
      expect(factoryCalls).toBe(0);
      expect(calls).toEqual({ adopt: 0, begin: 0, complete: 0 });
      const waiting = await rawRow(db, id);
      expect(waiting.create_state).toBe("not-sent");
      expect(waiting.terminal_ms).toBeNull();
      expect(waiting.observed).toBe("unknown");
      expect(waiting.desired).toBe("failure");
      expect(waiting.desired_summary).toBe(UNCONFIRMED);
      expect(waiting.attempts).toBe(1); // the wait spends NO attempt
      expect(waiting.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[1]!);
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
      expect(deferredLine.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[1]!);

      // The publication now proves itself: the SAME attempt concludes from it.
      const proof = { ...proofFor(attempt.identity, "review"), publicationId: journalId };
      db.raw
        .prepare(`UPDATE review_publications SET phase = 'confirmed', proof_json = ?, payload_json = ? WHERE id = ?`)
        .run(JSON.stringify(proof), JSON.stringify(reviewPayload(SCOPE, SHA, "ship it", 85)), journalId);

      const secondStub = stubFetch();
      const sent: { desired: string | null } = { desired: null };
      try {
        const second = await run(db, {
          now: () => T0 + 300_000,
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

  test("a wait-terminal row of a disabled App still takes the durable suspension", async () => {
    const db = seededDb();
    // Wait-terminal shape: no journal row since admission and no link of its
    // own, so the probe alone already ends this lane's wait. The D1 pair gate
    // still LEADS the wait (spec §7.11.2 step 2), so a disabled App suspends the
    // pair exactly as the credential path would, instead of leaving the row to
    // burn its window until the deadline.
    const { id } = await abandonedRow(db);
    db.raw.prepare(`UPDATE github_apps SET status = 'disabled' WHERE id = ?`).run(SCOPE.appId);

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
      // The lifecycle gate WINS over the dead-attempt short-circuit.
      expect(summary.suspended).toBe(1);
      expect(summary.deferred).toBe(0);
      expect(summary.completed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const row = await rawRow(db, id);
    expect(row.recovery_state).toBe("suspended");
    expect(row.terminal_ms).toBeNull();
    expect(row.observed).toBe("unknown");
    expect(row.attempts).toBe(1); // no attempt spent
    expect(row.next_attempt_ms).toBeNull(); // the suspension owns the row now
    expect(row.holder).toBeNull();
    expect(warned.some((fields) => fields.event === "ops_check_reconcile_pair_suspended")).toBe(true);
    expect(
      warned.some((fields) => fields.event === "check_recovery_deferred_pending_publication"),
    ).toBe(false);
  });

  test("a confirmed journal whose proof is not applied yet still holds the wait", async () => {
    const db = seededDb();
    const { attempt, id } = await handedOverAttempt(db);
    // `confirmed` WITHOUT `proof_json`: the publication exists but its proof is
    // not readable yet, so concluding now would freeze an unconfirmed failure
    // that the arriving proof could no longer correct.
    const journalId = seedJournal(db, SCOPE, SHA, "confirmed");
    linkPublication(db, id, journalId);

    const firstStub = stubFetch();
    let factoryCalls = 0;
    const scripted = scriptedCredentials(db, countingScript({ adopt: 0, begin: 0, complete: 0 }));
    try {
      const first = await run(db, {
        now: () => T0 + 120_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scripted(input);
        },
      });
      expect(first.deferred).toBe(1);
      expect(first.completed).toBe(0);
    } finally {
      firstStub.restore();
    }

    expect(factoryCalls).toBe(0);
    const waiting = await rawRow(db, id);
    expect(waiting.terminal_ms).toBeNull();
    expect(waiting.create_state).toBe("not-sent");
    expect(waiting.attempts).toBe(1);

    // The proof lands; the row was already `confirmed`.
    const proof = { ...proofFor(attempt.identity, "review"), publicationId: journalId };
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ?, payload_json = ? WHERE id = ?`)
      .run(JSON.stringify(proof), JSON.stringify(reviewPayload(SCOPE, SHA, "ship it", 85)), journalId);

    const secondStub = stubFetch();
    const sent: { desired: string | null } = { desired: null };
    try {
      const second = await run(db, {
        now: () => T0 + 300_000,
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

  test("an OLDER proof on another journal row never ends the wait", async () => {
    const db = seededDb();
    const { attempt, id } = await handedOverAttempt(db);
    // A DEGRADED publication for the same head already has proof; the
    // publication THIS attempt owns is a newer NORMAL one, still prepared. Both
    // are staged after this attempt's admission, so the wait is bound to the
    // NEWEST — an older head proof would freeze a degraded failure while the
    // normal review was still in flight.
    const degraded = proofFor(attempt.identity, "degraded");
    seedPublication(db, SCOPE, SHA, degraded, "confirmed", reviewPayload(SCOPE, SHA, "needs fixes", 40), T0 + 1_000);
    const journalId = seedJournal(db, SCOPE, SHA, "prepared", T0 + 2_000);
    linkPublication(db, id, journalId);

    const stub = stubFetch();
    let factoryCalls = 0;
    const scripted = scriptedCredentials(db, countingScript({ adopt: 0, begin: 0, complete: 0 }));
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scripted(input);
        },
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
      expect(summary.unconfirmed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const row = await rawRow(db, id);
    expect(row.terminal_ms).toBeNull();
    expect(row.observed).toBe("unknown");
    expect(row.desired_summary).toBe(UNCONFIRMED);

    // The NEWEST row now proves itself: the conclusion must come from THAT row
    // (its publication id and round), not from the older degraded one.
    const proof = { ...proofFor(attempt.identity, "review"), publicationId: journalId };
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ?, payload_json = ? WHERE id = ?`)
      .run(JSON.stringify(proof), JSON.stringify(reviewPayload(SCOPE, SHA, "ship it", 85)), journalId);

    const secondStub = stubFetch();
    const settled: { desired: string | null } = { desired: null };
    try {
      const second = await run(db, {
        now: () => T0 + 300_000,
        credentials: scriptedCredentials(db, {
          ...countingScript({ adopt: 0, begin: 0, complete: 0 }),
          complete: async (identity, _runId, conclusion) => {
            settled.desired = conclusion.desired;
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired }) };
          },
        }),
      });
      expect(second.completed).toBe(1);
      expect(second.deferred).toBe(0);
    } finally {
      secondStub.restore();
    }

    expect(settled.desired).toBe("success");
    const closed = await rawRow(db, id);
    expect(closed.publication_id).toBe(journalId); // the NEWEST row's proof
    expect(String(closed.desired_summary)).toContain(`Review gate met for ${SHA.slice(0, 7)}`);
    expect(closed.observed).toBe("success");
  });

  /**
   * The state `abandonUnterminalized` leaves behind: the lease released at the
   * first backoff rung, NO frozen intent and `publication_id` still NULL —
   * abandonment is not a conclusion, so the reconciler owes the row one.
   */
  async function abandonedRow(db: TestD1) {
    const { attempt, lease } = await claim(db, { nowMs: T0, executionDeadlineMs: DEADLINE });
    const id = attempt.identity.attemptId;
    expect(
      await deferCheckRecovery(
        db,
        id,
        lease,
        {
          state: "remote-unconfirmed",
          nextAttemptMs: T0 + 60_000,
          reason: "the creating invocation was abandoned by the consumer budget",
        },
        T0,
      ),
    ).toBe(true);
    return { attempt, id };
  }

  test("an abandoned attempt concludes from the newest journal row's proof, with that id", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedRow(db);
    // The consumer abandoned this attempt before it linked anything, then the
    // SAME message published: the journal row for this head — staged after this
    // attempt was admitted — holds the proof, and the row carries no
    // `publication_id` of its own. Its exact id is what the Check must conclude
    // from; waiting for a self-link would freeze the unconfirmed failure at the
    // deadline while the review comment exists.
    const proof = { ...proofFor(attempt.identity, "review"), publicationId: "pub-published-after-abandon" };
    seedPublication(db, SCOPE, SHA, proof, "applied", reviewPayload(SCOPE, SHA, "ship it", 85), T0 + 1_000);

    const stub = stubFetch();
    const sent: { desired: string | null; summary: string | null } = { desired: null, summary: null };
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: scriptedCredentials(db, {
          ...countingScript({ adopt: 0, begin: 0, complete: 0 }),
          complete: async (identity, _runId, conclusion) => {
            sent.desired = conclusion.desired;
            sent.summary = conclusion.summary;
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired }) };
          },
        }),
      });
      expect(summary.examined).toBe(1);
      expect(summary.completed).toBe(1);
      expect(summary.deferred).toBe(0);
    } finally {
      stub.restore();
    }

    // Gate-derived from the published envelope (85 ≥ the App's floor).
    expect(sent.desired).toBe("success");
    expect(sent.summary).toContain(`Review gate met for ${SHA.slice(0, 7)}`);
    const row = await rawRow(db, id);
    expect(row.publication_id).toBe(proof.publicationId);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("an abandoned attempt defers while the newest journal row has no proof", async () => {
    const db = seededDb();
    const { id } = await abandonedRow(db);
    seedJournal(db, SCOPE, SHA, "prepared");

    const stub = stubFetch();
    let factoryCalls = 0;
    const scripted = scriptedCredentials(db, countingScript({ adopt: 0, begin: 0, complete: 0 }));
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scripted(input);
        },
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
      expect(summary.unconfirmed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const row = await rawRow(db, id);
    expect(row.publication_id).toBeNull();
    expect(row.terminal_ms).toBeNull();
    expect(row.desired).toBe("in_progress");
    expect(row.observed).toBe("unknown");
    expect(row.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[1]!);
  });

  test("a previous generation's proof never ends an abandoned attempt's wait", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedRow(db);
    // The previous generation's DEGRADED publication for this head already has
    // proof and is staged after admission; this attempt's own normal row is
    // NEWER and still has no proof. The wait is bound to that newest row: a
    // proof on the older one would freeze a degraded failure while the review
    // this attempt is producing was still in flight.
    const prior = { ...proofFor(attempt.identity, "degraded"), publicationId: "pub-previous-generation" };
    seedPublication(db, SCOPE, SHA, prior, "applied", reviewPayload(SCOPE, SHA, "needs fixes", 40), T0 + 1_000);
    seedJournal(db, SCOPE, SHA, "sending", T0 + 2_000);

    const stub = stubFetch();
    let factoryCalls = 0;
    const scripted = scriptedCredentials(db, countingScript({ adopt: 0, begin: 0, complete: 0 }));
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scripted(input);
        },
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const row = await rawRow(db, id);
    expect(row.publication_id).toBeNull();
    expect(row.terminal_ms).toBeNull();
    expect(row.observed).toBe("unknown");
  });

  test("a previous generation's proof with no journal row of this attempt's ends the WAIT, not the deadline", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedRow(db);
    // Nothing this attempt staged exists: the only publication for the head was
    // staged before it was admitted. The abandoned row has no link of its own,
    // so nothing in the wait can ever answer it — the probe is terminal for the
    // lane on the FIRST pass, and it is not repeated: no claim, no defer, and
    // no proof re-read of the attempt's link (the D1 pair gate still leads the
    // wait). The deadline still owns the conclusion, so the proof is never
    // adopted.
    const prior = { ...proofFor(attempt.identity), publicationId: "pub-only-previous-generation" };
    seedPublication(db, SCOPE, SHA, prior, "applied", reviewPayload(SCOPE, SHA, "ship it", 90));

    const stub = stubFetch();
    let factoryCalls = 0;
    const scripted = scriptedCredentials(db, countingScript({ adopt: 0, begin: 0, complete: 0 }));
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scripted(input);
        },
      });
      // Not deferred: it is not a wait this lane can make progress on. Not
      // concluded either — `completed`/`unconfirmed` stay 0 until the deadline.
      expect(summary.deferred).toBe(0);
      expect(summary.completed).toBe(0);
      expect(summary.unconfirmed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const row = await rawRow(db, id);
    expect(row.publication_id).toBeNull();
    expect(row.terminal_ms).toBeNull();
    expect(row.observed).toBe("unknown");
    expect(row.attempts).toBe(1);
    // One unclaimed write moved the due time onto the FIRST rung — no claim, no
    // defer, no attempt spent. The row is not concludable, but it also does not
    // hold the head of the bounded due batch, and it is re-probed a minute
    // later, so a journal row that lands is seen about as soon as it exists.
    expect(row.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[0]!);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
  });

  test("a dead attempt still converges the moment a journal row lands", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedRow(db);
    const stub = stubFetch();
    try {
      // First pass: no journal row yet — terminal for the wait. Only its own
      // due time moves (one unclaimed write), so the row no longer holds the
      // head of the due batch.
      const first = await run(db, { now: () => T0 + 120_000 });
      expect(first.deferred).toBe(0);
      expect(first.completed).toBe(0);

      // The publication is staged and proves itself before that pushed due time.
      const journalId = seedJournal(db, SCOPE, SHA, "confirmed", T0 + 130_000);
      const proof = { ...proofFor(attempt.identity, "review"), publicationId: journalId };
      db.raw
        .prepare(`UPDATE review_publications SET proof_json = ?, payload_json = ? WHERE id = ?`)
        .run(JSON.stringify(proof), JSON.stringify(reviewPayload(SCOPE, SHA, "ship it", 85)), journalId);

      const dueAt = Number((await rawRow(db, id)).next_attempt_ms);
      const sent: { desired: string | null } = { desired: null };
      const second = await run(db, {
        now: () => dueAt,
        credentials: scriptedCredentials(db, {
          ...countingScript({ adopt: 0, begin: 0, complete: 0 }),
          complete: async (identity, _runId, conclusion) => {
            sent.desired = conclusion.desired;
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired }) };
          },
        }),
      });
      expect(second.deferred).toBe(0);
      expect(second.completed).toBe(1);
      expect(sent.desired).toBe("success");
    } finally {
      stub.restore();
    }

    const row = await rawRow(db, id);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("the attempt's OWN linked proof ends the wait even while its phase is prepared", async () => {
    const db = seededDb();
    const { attempt, id } = await handedOverAttempt(db);
    const journalId = seedJournal(db, SCOPE, SHA, "prepared");
    linkPublication(db, id, journalId);
    // The proof is readable on the waiting row itself, so the conclusion can be
    // decided now — the phase alone does not keep the wait alive.
    const proof = { ...proofFor(attempt.identity, "review"), publicationId: journalId };
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ?, payload_json = ? WHERE id = ?`)
      .run(JSON.stringify(proof), JSON.stringify(reviewPayload(SCOPE, SHA, "ship it", 85)), journalId);

    const stub = stubFetch();
    const sent: { desired: string | null } = { desired: null };
    let deferred = -1;
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
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
    expect(sent.desired).toBe("success");
    const row = await rawRow(db, id);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("a present-but-corrupt proof does not end the wait", async () => {
    const db = seededDb();
    const { id } = await handedOverAttempt(db);
    const journalId = seedJournal(db, SCOPE, SHA, "prepared");
    // `proof_json` EXISTS but is not valid JSON: the proof is not READABLE, so
    // the wait must continue rather than conclude on an unparseable envelope.
    db.raw.prepare(`UPDATE review_publications SET proof_json = ? WHERE id = ?`).run("{not json", journalId);

    const stub = stubFetch();
    let factoryCalls = 0;
    const scripted = scriptedCredentials(db, countingScript({ adopt: 0, begin: 0, complete: 0 }));
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scripted(input);
        },
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
      expect(summary.unconfirmed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const row = await rawRow(db, id);
    expect(row.terminal_ms).toBeNull();
    expect(row.desired_summary).toBe(UNCONFIRMED);
  });

  test("an unreadable journal probe defers inside the window instead of terminalizing", async () => {
    const db = seededDb();
    const { id } = await handedOverAttempt(db);
    // The journal probe's OWN read fails (it is the only journal query the
    // probe makes now). "Unknown" is NOT "nothing pending": the publication may
    // still be in flight, and this attempt is inside its window, so the lane
    // must wait exactly as it does for a readable journal.
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
    expect(row.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[1]!);
  });

  test("an unreadable journal probe at the deadline still fails closed", async () => {
    const db = seededDb();
    const { id } = await handedOverAttempt(db);
    // The same unreadable probe as the case above, but the wait is over: the
    // `now() < execution_deadline_ms` guard, not the probe's answer, is what
    // decides here — past the deadline the lane must conclude.
    const unreadable = withFailingReads(db, /FROM review_publications/);
    const stub = stubFetch();
    const sent: { desired: string | null } = { desired: null };
    let deferred = -1;
    try {
      const summary = await run(unreadable, {
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

/**
 * Counts every D1 statement a pass prepares, so the wait's per-pass cost is
 * MEASURED. A pass with nothing due is the baseline (the selector alone).
 */
function countingDb(db: TestD1): { db: TestD1; statements: () => number } {
  let prepared = 0;
  return {
    db: {
      prepare(sql: string) {
        prepared += 1;
        return db.prepare(sql);
      },
      batch: (statements) => {
        prepared += statements.length;
        return db.batch(statements);
      },
      raw: db.raw,
    } as TestD1,
    statements: () => prepared,
  };
}

describe("the journal-less short-circuit (spec §7.9/§7.11.2)", () => {
  test("an attempt with no journal row costs the probe and the pair gate, and is not deferred", async () => {
    const baseline = countingDb(seededDb());
    await run(baseline.db, { now: () => T0 + 120_000 });
    const selectorOnly = baseline.statements();

    const dead = countingDb(seededDb());
    await handedOverAttempt(dead.db);
    const before = dead.statements();
    const summary = await run(dead.db, { now: () => T0 + 120_000 });

    // THREE statements for the dead attempt — the shared determination's journal
    // probe, the D1 pair gate that LEADS the wait (spec §7.11.2 step 2), and the
    // one unclaimed due-time write that keeps the row off the head of the due
    // batch. The proof read, the claim and the re-leasing defer are all gone;
    // the row stays live and still owes its deadline conclusion.
    expect(summary.examined).toBe(1);
    expect(summary.deferred).toBe(0);
    expect(dead.statements() - before - selectorOnly).toBe(3);
  });

  test("a journal row staggers the wait onto the widening ladder instead of every minute", async () => {
    const db = seededDb();
    const { id } = await handedOverAttempt(db);
    seedJournal(db, SCOPE, SHA, "prepared");

    const first = await run(db, { now: () => T0 + 120_000 });
    expect(first.deferred).toBe(1);
    // 120 s of wait already outlived the 60 s rung, so the next rung is due.
    expect((await rawRow(db, id)).next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[1]!);

    const second = await run(db, { now: () => T0 + 120_000 + CHECK_BACKOFF_MS[1]! });
    expect(second.deferred).toBe(1);
    // Widened again: three probes inside the 900 s window, not fifteen.
    expect((await rawRow(db, id)).next_attempt_ms).toBe(
      T0 + 120_000 + CHECK_BACKOFF_MS[1]! + CHECK_BACKOFF_MS[2]!,
    );
  });

  test("more wait-terminal rows than the batch bound cannot starve a publishable attempt", async () => {
    const db = seededDb();
    // CHECK_RECONCILE_LIMIT + 1 rows that can never progress, every one due
    // BEFORE the one attempt that can publish. The selector orders by
    // `COALESCE(next_attempt_ms, created_ms), id LIMIT 25`, so a wait-terminal
    // row left at its early due time occupies a slot on EVERY pass: the same 25
    // are re-read each time and the publishable attempt behind them is never
    // examined until its deadline.
    const deadIds: string[] = [];
    for (let index = 0; index < CHECK_RECONCILE_LIMIT + 1; index += 1) {
      const { attempt, lease } = await claim(db, {
        headSha: `${index.toString(16).padStart(2, "0")}${"0".repeat(38)}`,
        nowMs: T0,
        executionDeadlineMs: DEADLINE,
      });
      const id = attempt.identity.attemptId;
      expect(
        await deferCheckRecovery(
          db,
          id,
          lease,
          { state: "remote-unconfirmed", nextAttemptMs: T0 + 60_000, reason: "the creating invocation was abandoned" },
          T0,
        ),
      ).toBe(true);
      deadIds.push(id);
    }

    // The one attempt that CAN publish: its journal row has already proved
    // itself, and its due time sits behind every dead row's.
    const publishableSha = "f".repeat(40);
    const { attempt: publishable, lease: publishableLease } = await claim(db, {
      headSha: publishableSha,
      nowMs: T0,
      executionDeadlineMs: DEADLINE,
    });
    const publishableId = publishable.identity.attemptId;
    expect(
      await deferCheckRecovery(
        db,
        publishableId,
        publishableLease,
        { state: "remote-unconfirmed", nextAttemptMs: T0 + 90_000, reason: "publication journal handoff" },
        T0,
      ),
    ).toBe(true);
    const journalId = seedJournal(db, SCOPE, publishableSha, "confirmed", T0 + 10_000);
    const proof = { ...proofFor(publishable.identity, "review"), publicationId: journalId };
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ?, payload_json = ? WHERE id = ?`)
      .run(JSON.stringify(proof), JSON.stringify(reviewPayload(SCOPE, publishableSha, "ship it", 85)), journalId);

    const stub = stubFetch();
    try {
      const first = await run(db, {
        now: () => T0 + 120_000,
        credentials: scriptedCredentials(db, countingScript({ adopt: 0, begin: 0, complete: 0 })),
      });
      // The bound still applies: one pass reads exactly `CHECK_RECONCILE_LIMIT`
      // rows and the publishable attempt is the 27th…
      expect(first.examined).toBe(CHECK_RECONCILE_LIMIT);
      expect(first.completed).toBe(0);

      // …but the dead rows it read no longer hold the head — the very next
      // selection is the one straggler plus the publishable attempt.
      const nextIds = (await listCheckReconcileBatch(db, T0 + 120_000)).map((row) => row.identity.attemptId);
      expect(nextIds).toHaveLength(2);
      expect(nextIds).toContain(publishableId);

      // The reorder spent nothing: the dead row keeps its attempt count, holds
      // no lease, and is due again one rung later — not at the deadline.
      const reorderedId = deadIds.find((id) => !nextIds.includes(id))!;
      const reordered = await rawRow(db, reorderedId);
      expect(reordered.attempts).toBe(1);
      expect(reordered.holder).toBeNull();
      expect(reordered.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[0]!);

      const second = await run(db, {
        now: () => T0 + 120_000,
        credentials: scriptedCredentials(db, {
          ...countingScript({ adopt: 0, begin: 0, complete: 0 }),
          complete: async (identity, _runId, conclusion) => ({
            kind: "completed" as const,
            remote: remoteFor(identity, { conclusion: conclusion.desired }),
          }),
        }),
      });
      expect(second.examined).toBe(2);
      expect(second.completed).toBe(1);
    } finally {
      stub.restore();
    }

    const settled = await rawRow(db, publishableId);
    expect(settled.observed).toBe("success");
    expect(settled.terminal_ms).not.toBeNull();
  });
});
