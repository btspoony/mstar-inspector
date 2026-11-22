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

const DEADLINE = T0 + 900_000;

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
      return { kind: "completed" as const, remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
    },
  };
}

describe("publication-journal proof wait (spec §7.9/§7.11.2)", () => {
  for (const phase of ["prepared", "sending", "unknown"] as const) {
    test(`a ${phase} journal defers the pass, then concludes from the arrived proof`, async () => {
      const db = seededDb();
      const { attempt, id } = await handedOverAttempt(db);
      const journalId = seedJournal(db, SCOPE, SHA, phase);
      linkPublication(db, id, journalId);

      const firstStub = stubFetch();
      const calls = { adopt: 0, begin: 0, complete: 0 };
      let factoryCalls = 0;
      const scripted = scriptedCredentials(db, countingScript(calls));
      const events: Array<Record<string, unknown>> = [];
      try {
        const first = await run(db, {
          now: () => T0 + 120_000,
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

      expect(factoryCalls).toBe(0);
      expect(calls).toEqual({ adopt: 0, begin: 0, complete: 0 });
      const waiting = await rawRow(db, id);
      expect(waiting.create_state).toBe("not-sent");
      expect(waiting.terminal_ms).toBeNull();
      expect(waiting.observed).toBe("unknown");
      expect(waiting.desired).toBe("failure");
      expect(waiting.desired_summary).toBe(UNCONFIRMED);
      expect(waiting.attempts).toBe(1);
      expect(waiting.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[0]!);
      expect(waiting.holder).toBeNull();
      expect(waiting.lease_until_ms).toBeNull();

      const deferredLines = events.filter(
        (fields) => fields.event === "check_recovery_deferred_pending_publication",
      );
      expect(deferredLines).toHaveLength(1);
      const deferredLine = deferredLines[0]!;
      expect(deferredLine.attempt_id).toBe(id);
      expect(deferredLine.probe_state).toBe("pending");
      expect(deferredLine.phase).toBe(phase);
      expect(deferredLine.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[0]!);

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
              return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
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
            ? `UPDATE review_bots SET status = 'disabled' WHERE id = ?`
            : `UPDATE review_bots SET deleted_at = datetime('now') WHERE id = ?`,
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
        expect(summary.suspended).toBe(1);
        expect(summary.deferred).toBe(0);
      } finally {
        stub.restore();
      }

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
    const { id } = await abandonedRow(db);
    db.raw.prepare(`UPDATE review_bots SET status = 'disabled' WHERE id = ?`).run(SCOPE.appId);

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
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.holder).toBeNull();
    expect(warned.some((fields) => fields.event === "ops_check_reconcile_pair_suspended")).toBe(true);
    expect(
      warned.some((fields) => fields.event === "check_recovery_deferred_pending_publication"),
    ).toBe(false);
  });

  test("a confirmed journal whose proof is not applied yet still holds the wait", async () => {
    const db = seededDb();
    const { attempt, id } = await handedOverAttempt(db);
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
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
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
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
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
    expect(closed.publication_id).toBe(journalId);
    expect(String(closed.desired_summary)).toContain(`Review gate met for ${SHA.slice(0, 7)}`);
    expect(closed.observed).toBe("success");
  });

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
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.examined).toBe(1);
      expect(summary.completed).toBe(1);
      expect(summary.deferred).toBe(0);
    } finally {
      stub.restore();
    }

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
    expect(row.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[0]!);
  });

  test("a previous generation's proof never ends an abandoned attempt's wait", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedRow(db);
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
    expect(row.observed).toBe("unknown");
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[0]!);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
  });

  test("a dead attempt still converges the moment a journal row lands", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedRow(db);
    const stub = stubFetch();
    try {
      const first = await run(db, { now: () => T0 + 120_000 });
      expect(first.deferred).toBe(1);
      expect(first.completed).toBe(0);

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
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
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
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
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
    const unreadable = withFailingReads(db, /FROM review_publications\s+WHERE/);
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
    expect(row.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[0]!);
  });

  test("an unreadable journal probe at the deadline still fails closed", async () => {
    const db = seededDb();
    const { id } = await handedOverAttempt(db);
    const unreadable = withFailingReads(db, /FROM review_publications\s+WHERE/);
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
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
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
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
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

describe("the proof wait's per-pass cost (spec §7.9/§7.11.2)", () => {
  test("an attempt with no journal row pays the same six statements as any wait", async () => {
    const baseline = countingDb(seededDb());
    await run(baseline.db, { now: () => T0 + 120_000 });
    const selectorOnly = baseline.statements();

    const dead = countingDb(seededDb());
    const { id } = await handedOverAttempt(dead.db);
    const before = dead.statements();
    const summary = await run(dead.db, { now: () => T0 + 120_000 });

    expect(summary.examined).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(dead.statements() - before - selectorOnly).toBe(6);
    const row = await rawRow(dead.db, id);
    expect(row.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[0]!);
    expect(row.holder).toBeNull();
  });

  test("a journal row re-probes the wait on the first rung instead of widening", async () => {
    const db = seededDb();
    const { id } = await handedOverAttempt(db);
    seedJournal(db, SCOPE, SHA, "prepared");

    const first = await run(db, { now: () => T0 + 120_000 });
    expect(first.deferred).toBe(1);
    expect((await rawRow(db, id)).next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[0]!);

    const second = await run(db, { now: () => T0 + 120_000 + CHECK_BACKOFF_MS[0]! });
    expect(second.deferred).toBe(1);
    expect((await rawRow(db, id)).next_attempt_ms).toBe(
      T0 + 120_000 + CHECK_BACKOFF_MS[0]! + CHECK_BACKOFF_MS[0]!,
    );
  });

  test("a journal-present wait costs the probe, the pair gate, the claim, the defer and the bump", async () => {
    const baseline = countingDb(seededDb());
    await run(baseline.db, { now: () => T0 + 120_000 });
    const selectorOnly = baseline.statements();

    const counted = countingDb(seededDb());
    const { id } = await handedOverAttempt(counted.db);
    seedJournal(counted.db, SCOPE, SHA, "prepared");
    const before = counted.statements();
    const summary = await run(counted.db, { now: () => T0 + 120_000 });

    expect(summary.deferred).toBe(1);
    expect(counted.statements() - before - selectorOnly).toBe(6);
    expect((await rawRow(counted.db, id)).holder).toBeNull();
  });

  test("more wait-terminal rows than the batch bound cannot starve a publishable attempt", async () => {
    const db = seededDb();
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
      expect(first.examined).toBe(CHECK_RECONCILE_LIMIT);
      expect(first.completed).toBe(0);

      const nextIds = (await listCheckReconcileBatch(db, T0 + 120_000)).map((row) => row.identity.attemptId);
      expect(nextIds).toHaveLength(2);
      expect(nextIds).toContain(publishableId);

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
            remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }),
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
