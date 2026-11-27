import { RECONCILE_DEFAULTS, RECONCILE_LIMITS } from "../../src/contracts/reconcile-settings";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import { bumpCheckOwed, clearConcludedCheckOwed } from "../../src/pipeline/review-attempt";
import {
  attachCheckRunId,
  CHECK_ATTACH_GRACE_MS,
  CHECK_ATTACH_WINDOW_MS,
  CHECK_BACKOFF_MS,
  CHECK_LEASE_MS,
  CHECK_NAME,
  CHECK_RECOVERY_LEASE_MS,
  CHECK_STALE_HOLDER_MS,
  claimCheckRecovery,
  rollbackCheckCreateDispatch,
  deferCheckRecovery,
  getCheckAttempt,
  listCheckReconcileBatch,
  releaseAttachedCheck,
  releaseCheckClaim,
  recordCheckObservation,
  recordTerminalDispatch,
  reopenTerminalCorrection,
  retryCheckRecovery,
  setCheckCreateState,
  setCheckDesired,
  checkSuspensionKindOf,
  checkSuspensionReason,
  listReenableableCheckPairs,
  suspendCheckRecovery,
  type CheckAttempt,
  type CheckConclusion,
  type Lease,
} from "../../src/store/review-checks";
import { claimPublication, recordPublicationProof } from "../../src/store/finding-lifecycle";
import {
  defaultCheckReconcileLog,
  reconcileReviewChecks,
  type CheckCredentialFactory,
  type CheckReconcileDeps,
  type CheckReconcileSummary,
  type CheckTransport,
} from "../../src/worker/check-reconcile";
import { CHECK_SUMMARIES, TERMINAL_FAILURE_TEXT, CheckRequestNotDispatched, isRequestNotDispatched, createCheckBeginLatch, createCheckLifecycle, type ChecksAdapter } from "../../src/pipeline/checks";
import type { ScheduledEnv } from "../../src/worker/env";
import { defaultReconcileLog } from "../../src/worker/lifecycle-reconcile";
import { defaultSweepLog } from "../../src/worker/sweep";
import { QUEUE_MAX_ATTEMPTS } from "../../src/store/failure-store";
import worker from "../../src/worker/index";
import { sha256Hex } from "../../src/pipeline/review-threads";
import { CHECK_UPDATE_DEFAULT } from "../../src/dashboard/runtime-config-store";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

import {
  APP,
  APP_B,
  NUMERIC_APP,
  NUMERIC_APP_B,
  SCOPE,
  SCOPE_B,
  SHA,
  T0,
  CLAIM_AT,
  EXPIRED_DEADLINE,
  SILENT_LOG,
  NOOP_QUEUE,
  UNCONFIRMED,
  agreeingScript,
  frozenSummaryOf,
  asEnv,
  claim,
  linkPublication,
  proofFor,
  rawRow,
  remoteFor,
  reviewEnvelope,
  reviewPayload,
  run,
  scriptedAdapter,
  scriptedCredentials,
  seedApp,
  seedJournal,
  seedPublication,
  seedReview,
  seededDb,
  OFFLINE_FETCH,
  stubFetch,
  withFailingReads,
} from "./helpers/check-reconcile";
import type { AdapterScript, AdoptOutcome, BeginOutcome, CompleteOutcome, FetchOutcome } from "./helpers/check-reconcile";

const SWEEP_FAILURE_THRESHOLD = QUEUE_MAX_ATTEMPTS + 1;

const REAL_FETCH = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = OFFLINE_FETCH;
});
afterAll(() => {
  globalThis.fetch = REAL_FETCH;
});


describe("budget and selector constants (spec §7.11.2)", () => {
  test("pins the §7.11.2 verbatim bounds", () => {
    expect(CHECK_RECOVERY_LEASE_MS).toBe(120_000);
    expect(CHECK_BACKOFF_MS).toEqual([60_000, 120_000, 240_000, 480_000, 960_000]);
  });
});


function terminalizeHarness(
  db: TestD1,
  clock: () => number,
  sent: CheckConclusion[],
  send: "completed" | "unavailable" = "completed",
) {
  return createCheckLifecycle({
    db,
    nowMs: clock,
    getAdapter: () => ({
      adoptCheckRun: async () => ({ kind: "absent" }),
      beginCheck: async () => ({ kind: "unavailable", reason: "no create in this fixture", requests: 0 }),
      fetchCheckRun: async () => ({ kind: "absent" }),
      completeCheck: async ({ identity, conclusion }) => {
        sent.push(conclusion);
        return send === "completed"
          ? { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) }
          : { kind: "unavailable", reason: "checks update unavailable", requests: 1 };
      },
    }),
    getCheckGate: async () => ({ minScore: 0, passVerdicts: ["ship it"] }),
  });
}

async function attachProvenRun(db: TestD1, attemptId: string, lease: Lease, atMs: number): Promise<void> {
  await setCheckCreateState(db, attemptId, lease, "sending", undefined, atMs);
  if (!(await attachCheckRunId(db, attemptId, lease, 4242, atMs))) {
    throw new Error("fixture: the run id was not attached");
  }
}

async function markedUnconfirmed(db: TestD1, headSha: string, publicationId: string): Promise<string> {
  const { attempt, lease } = await claim(db, { headSha, executionDeadlineMs: CLAIM_AT + CHECK_LEASE_MS });
  const attemptId = attempt.identity.attemptId;
  await attachProvenRun(db, attemptId, lease, CLAIM_AT + 1);
  db.raw
    .prepare(
      `INSERT INTO review_publications
         (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
          payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'review', 'sending', '{}', NULL, 0, 'pending', ?, ?)`,
    )
    .run(
      publicationId, SCOPE.appId, SCOPE.installationId, SCOPE.owner, SCOPE.repo,
      SCOPE.prNumber, headSha, CLAIM_AT + 500, CLAIM_AT + 500,
    );
  await terminalizeHarness(db, () => CLAIM_AT + 1_000, []).terminalize({
    handle: { attemptId, scope: SCOPE, githubAppId: NUMERIC_APP, headSha, lease },
    publicationId,
    outcome: "publication-unknown",
  });
  return attemptId;
}

async function owedCorrectionFixture(
  db: TestD1,
  scorePct = 96,
): Promise<{ attemptId: string; journalId: string; confirmedAt: number }> {
  const { attempt, lease } = await claim(db, { executionDeadlineMs: CLAIM_AT + CHECK_LEASE_MS });
  const attemptId = attempt.identity.attemptId;
  await attachProvenRun(db, attemptId, lease, CLAIM_AT + 1);
  const journalId = seedJournal(db, SCOPE, SHA, "sending", CLAIM_AT + 500);
  await terminalizeHarness(db, () => CLAIM_AT + 1_000, []).terminalize({
    handle: { attemptId, scope: SCOPE, githubAppId: NUMERIC_APP, headSha: SHA, lease },
    publicationId: journalId,
    outcome: "publication-unknown",
  });
  db.raw
    .prepare(`UPDATE review_publications SET payload_json = ? WHERE id = ?`)
    .run(JSON.stringify(reviewPayload(SCOPE, SHA, "ship it", scorePct)), journalId);
  const confirmedAt = CLAIM_AT + 61_000;
  const proofLease = await claimPublication(db as never, journalId, "proof-lane", confirmedAt, "sending");
  if (proofLease === null) throw new Error("fixture: the proof claim was refused");
  expect(
    await recordPublicationProof(db as never, journalId, proofLease, {
      publicationId: journalId,
      scope: SCOPE,
      headSha: SHA,
      kind: "review",
      round: 3,
      commentId: 9001,
      bodySha256: "a".repeat(64),
      confirmedMs: confirmedAt,
    }),
  ).toBe(true);
  return { attemptId, journalId, confirmedAt };
}

function deferredCorrectionCredentials(db: TestD1): CheckCredentialFactory {
  const resolution = scriptedCredentials(db, {
    fetch: async (identity) => ({
      kind: "found",
      remote: remoteFor(identity, { status: "in_progress", conclusion: null }),
    }),
  });
  return async (input) => {
    for (let i = 0; i < RECONCILE_DEFAULTS.checkRowMaxRequests; i += 1) {
      await input.transport.fetchImpl("https://api.github.com/checks");
    }
    return resolution(input);
  };
}

describe("an attach row nobody adopted (spec §7.9 / §7.11.2)", () => {
  test("the reconciler takes it at the attach grace and never creates a second run", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      nowMs: T0,
      holder: "delivery:attach",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    const id = attempt.identity.attemptId;
    await setCheckCreateState(db, id, lease, "sending", undefined, T0);
    expect(await attachCheckRunId(db, id, lease, 4242, T0)).toBe(true);
    const grace = T0 + CHECK_ATTACH_GRACE_MS;
    expect(await releaseAttachedCheck(db, id, lease, grace, T0)).toBe(true);

    const fetchStub = stubFetch();
    try {
      const early = await run(db, { now: () => grace - 1, credentials: scriptedCredentials(db, agreeingScript(db)) });
      expect(early.examined).toBe(0);

      const summary = await run(db, { now: () => grace, credentials: scriptedCredentials(db, agreeingScript(db)) });
      expect(summary.examined).toBe(1);
      expect(summary.deferred).toBe(1);
      expect(summary.errors).toBe(0);
      expect(fetchStub.urls).toHaveLength(0);
    } finally {
      fetchStub.restore();
    }

    const count = db.raw.query("SELECT COUNT(*) AS n FROM review_checks").get() as { n: number };
    expect(count.n).toBe(1);
    const row = await rawRow(db, id);
    expect(row.check_run_id).toBe(4242);
    expect(row.terminal_ms).toBeNull();
    expect(row.holder).toBeNull();
    expect(row.next_attempt_ms).toBe(grace + CHECK_BACKOFF_MS[0]!);
  });
});

describe("a store-only skip settlement (spec §7.9 / RL-10)", () => {
  test("the reconciler sends the frozen neutral intent on the next tick", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, { nowMs: T0, holder: "skip:settler", executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS });
    const id = attempt.identity.attemptId;
    await setCheckCreateState(db, id, lease, "sending", undefined, T0);
    expect(await attachCheckRunId(db, id, lease, 4242, T0)).toBe(true);
    expect(
      await setCheckDesired(
        db,
        id,
        lease,
        { desired: "neutral", title: CHECK_NAME, summary: CHECK_SUMMARIES.skippedByDelivery("review paused") },
        null,
        T0,
      ),
    ).toBe(true);
    expect(await releaseCheckClaim(db, id, lease, T0)).toBe(true);

    const script: AdapterScript = {
      ...agreeingScript(db, "neutral", 4242),
      complete: async (identity, checkRunId, conclusion) => ({
        kind: "completed",
        remote: remoteFor(identity, { id: checkRunId, status: "completed", conclusion: conclusion.desired }),
      }),
    };
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0 + 1, credentials: scriptedCredentials(db, script) });
      expect(summary.completed).toBe(1);
      expect(summary.deferred).toBe(0);
      expect(fetchStub.urls.length).toBeGreaterThanOrEqual(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.desired).toBe("neutral");
    expect(row.observed).toBe("neutral");
    expect(row.terminal_ms).not.toBeNull();
    expect(row.check_run_id).toBe(4242);
  });
});
describe("due selection (spec §7.11.2 predicate)", () => {
  test("a LIVE lease is never examined, claimed or mutated by a stale reconciler", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, { executionDeadlineMs: T0 + 900_000 });
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db) });
      expect(summary.examined).toBe(0);
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.holder).toBe(lease.holder);
    expect(row.lease_epoch).toBe(lease.epoch);
    expect(row.lease_until_ms).toBe(lease.untilMs);
    expect(row.terminal_ms).toBeNull();
    expect(fetchStub.urls).toHaveLength(0);
  });

  test("an expired ATTEMPT under a live LEASE stays protected (expiry is not a takeover)", async () => {
    const db = seededDb();
    const { attempt } = await claim(db, { nowMs: T0, executionDeadlineMs: T0 + 900_000 });
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0 + 1_000, credentials: scriptedCredentials(db) });
      expect(summary.examined).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, attempt.identity.attemptId)).terminal_ms).toBeNull();
  });

  test("an unreleased in_progress attempt is not due before its EXECUTION deadline", async () => {
    const db = seededDb();
    const { attempt } = await claim(db, { nowMs: T0, executionDeadlineMs: T0 + 900_000 });
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, attempts = 1 WHERE id = ?`)
      .run(attempt.identity.attemptId);
    expect(await listCheckReconcileBatch(db, T0 + 60_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(0);
    expect(await listCheckReconcileBatch(db, T0 + 900_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
  });

  test("a frozen intent stops waiting on a dead holder after CHECK_STALE_HOLDER_MS", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      nowMs: T0,
      holder: "consumer:x",
      executionDeadlineMs: T0 + 900_000,
    });
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, { desired: "success", title: CHECK_NAME, summary: "done" }, null, T0);
    expect((await rawRow(db, id)).lease_until_ms).toBe(T0 + 900_000);

    expect(await listCheckReconcileBatch(db, T0 + CHECK_STALE_HOLDER_MS - 1, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(0);
    expect(await listCheckReconcileBatch(db, T0 + CHECK_STALE_HOLDER_MS, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
    const taken = await claimCheckRecovery(db, id, "reconciler", T0 + CHECK_STALE_HOLDER_MS, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(taken).not.toBeNull();
    expect(taken!.epoch).toBe(lease.epoch + 1);
    expect((await rawRow(db, id)).holder).toBe("reconciler");
  });

  test("an in_progress row with the same silent holder keeps its lease authority", async () => {
    const db = seededDb();
    const { attempt } = await claim(db, {
      nowMs: T0,
      holder: "consumer:x",
      executionDeadlineMs: T0 + 900_000,
    });
    const id = attempt.identity.attemptId;
    expect(await listCheckReconcileBatch(db, T0 + CHECK_STALE_HOLDER_MS + 1, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(0);
    expect(await claimCheckRecovery(db, id, "reconciler", T0 + CHECK_STALE_HOLDER_MS + 1, RECONCILE_DEFAULTS.checkMaxAttempts)).toBeNull();
    expect((await rawRow(db, id)).holder).toBe("consumer:x");
  });

  test("a frozen intent written inside the stale window is not raced", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      nowMs: T0,
      holder: "consumer:x",
      executionDeadlineMs: T0 + 900_000,
    });
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, { desired: "failure", title: CHECK_NAME, summary: "gate" }, null, T0);
    expect(await listCheckReconcileBatch(db, T0 + 30_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(0);
  });

  test("a not-yet-due row and a row at the attempt cap are both left alone", async () => {
    const db = seededDb();
    const due = await claim(db, { action: "due" });
    const early = await claim(db, { action: "early", triggeredBy: "other" });
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, next_attempt_ms = ?, attempts = 1 WHERE id = ?`)
      .run(T0 + 60_000, early.attempt.identity.attemptId);
    const capped = await claim(db, { action: "capped", triggeredBy: "third" });
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, attempts = ? WHERE id = ?`)
      .run(RECONCILE_DEFAULTS.checkMaxAttempts, capped.attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db, agreeingScript(db)) });
      expect(summary.examined).toBe(1);
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, early.attempt.identity.attemptId)).terminal_ms).toBeNull();
    expect((await rawRow(db, capped.attempt.identity.attemptId)).attempts).toBe(RECONCILE_DEFAULTS.checkMaxAttempts);
    expect((await rawRow(db, capped.attempt.identity.attemptId)).terminal_ms).toBeNull();
  });

  test("a lease that goes LIVE between selection and claim stops the row (selection grants no ownership)", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: async () => {
          db.raw
            .prepare(`UPDATE review_checks SET holder = 'other-run', lease_epoch = 9, lease_until_ms = ? WHERE id = ?`)
            .run(T0 + CHECK_RECOVERY_LEASE_MS, attempt.identity.attemptId);
          return {
            kind: "ok",
            paused: false,
            adapter: {
              adoptCheckRun: async () => {
                throw new Error("adoption must not run: the claim fence refused first");
              },
              beginCheck: async () => {
                throw new Error("create must not run: the claim fence refused first");
              },
              fetchCheckRun: async () => {
                throw new Error("fetch must not run: the claim fence refused first");
              },
              completeCheck: async () => {
                throw new Error("complete must not run: the claim fence refused first");
              },
            },
          };
        },
      });
      expect(summary.completed).toBe(0);
      expect(summary.gaveUp).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.holder).toBe("other-run");
    expect(row.lease_epoch).toBe(9);
    expect(row.lease_until_ms).toBe(T0 + CHECK_RECOVERY_LEASE_MS);
    expect(row.attempts).toBe(0);
    expect(row.terminal_ms).toBeNull();
    expect(row.desired).toBe("in_progress");
    expect(lease.holder).toBe("consumer-run");
  });

  test("a suspended row of a DISABLED App is not examined and stays suspended", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, recovery_state = 'suspended' WHERE id = ?`)
      .run(attempt.identity.attemptId);
    db.raw.prepare(`UPDATE github_apps SET status = 'disabled' WHERE id = ?`).run(APP);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db) });
      expect(summary.examined).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, attempt.identity.attemptId)).recovery_state).toBe("suspended");
  });
});

// note: ---------------------------------------------------------------------------
// A persisted-but-unpublished launch (I-000684)
// ---------------------------------------------------------------------------

describe("a launch whose paid result is durable but whose Check is still open (I-000684)", () => {
  /** The paid step's own durable outcome on the attempt's launch row. */
  function seedPersistedLaunch(db: TestD1, attempt: CheckAttempt): void {
    const check = db.raw
      .prepare(`SELECT attempt_key, generation FROM review_checks WHERE id = ?`)
      .get(attempt.identity.attemptId) as { attempt_key: string; generation: number };
    db.raw
      .prepare(
        `INSERT INTO review_launches
           (attempt_id, state, claimed_at_ms, launched_at_ms, persisted_at_ms, result_json, result_outcome,
            attempt_key, attempt_generation)
         VALUES (?, 'persisted', ?, ?, ?, '{}', 'persisted', ?, ?)`,
      )
      .run(attempt.identity.attemptId, CLAIM_AT, CLAIM_AT, T0 - 60_000, check.attempt_key, check.generation);
  }

  test("the reconciler selects it inside the execution window and concludes from the publication proof", async () => {
    const db = seededDb();
    // note: The delivery attached the run and the paid step then persisted its result;
    // the host died after giving the row back (a release, a failed send, a
    // settlement give-back) while the execution window still had time left. Nobody
    // holds the lease, so only the launch's own durable state can make it due.
    const { attempt } = await claim(db, { nowMs: T0 - 240_000, executionDeadlineMs: T0 + 900_000 });
    seedPersistedLaunch(db, attempt);
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL WHERE id = ?`)
      .run(attempt.identity.attemptId);
    // note: The publish step's proof landed after admission — the review IS
    // published, only the Check never received its conclusion.
    const proof = proofFor(attempt.identity, "review");
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85), T0 - 100_000);
    linkPublication(db, attempt.identity.attemptId, proof.publicationId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async () => ({ kind: "found", remote: remoteFor(attempt.identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            expect(conclusion.desired).toBe("success");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "success", summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.examined).toBe(1);
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.desired).toBe("success");
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).toBe(T0);
  });

  test("F-D: an already-concluded remote run is never rewritten", async () => {
    const db = seededDb();
    // note: The reported shape: a released Check row, a persisted launch and a landed
    // publication proof — while the remote run was concluded by another actor with its
    // own text. An already-concluded run is never rewritten.
    const { attempt } = await claim(db, { nowMs: T0 - 240_000, executionDeadlineMs: T0 + 900_000 });
    seedPersistedLaunch(db, attempt);
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL WHERE id = ?`)
      .run(attempt.identity.attemptId);
    const proof = proofFor(attempt.identity, "review");
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85), T0 - 100_000);
    linkPublication(db, attempt.identity.attemptId, proof.publicationId);
    let rewrites = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { status: "completed", conclusion: "success", summary: "the run's own earlier text" }),
          }),
          complete: async () => {
            rewrites += 1;
            throw new Error("an already-concluded run must never be rewritten");
          },
        }),
      });
      expect(rewrites).toBe(0);
      expect(summary.completed).toBe(0);
      // note: The row takes the attempt ladder's deferral instead of a remote write.
      expect(summary.unconfirmed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.terminal_ms).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_ms).toEqual(expect.any(Number));
  });

  test("F-N1: a dispatched update is read back without spending an attempt", async () => {
    const db = seededDb();
    // note: Pass 1 dispatches the terminal update and its reply carries no readable
    // text, so the row stays owed with a durable dispatch marker. Pass 2 then reads a
    // CONCLUDED run at the intended conclusion with stale text: it must wait for the
    // dispatched reply without rewriting the run and without spending an attempt.
    const { attempt } = await claim(db, { nowMs: T0 - 240_000, executionDeadlineMs: T0 + 900_000 });
    seedPersistedLaunch(db, attempt);
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL WHERE id = ?`)
      .run(attempt.identity.attemptId);
    const proof = proofFor(attempt.identity, "review");
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85), T0 - 100_000);
    linkPublication(db, attempt.identity.attemptId, proof.publicationId);
    let rewrites = 0;
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => ({
            kind: "completed",
            remote: remoteFor(identity, {
              id: 4242,
              status: "completed",
              conclusion: "success",
              summary: null,
            }),
          }),
        }),
      });
      const afterFirst = await rawRow(db, attempt.identity.attemptId);
      expect(afterFirst.attempts).toBe(1);
      expect(afterFirst.terminal_ms).toBeNull();
      // note: What the real Checks adapter leaves behind a dispatched update: the durable
      // marker (the scripted double does not write it), under the row's own lease.
      const fixtureLease = { holder: "fixture-dispatch", epoch: Number(afterFirst.lease_epoch), untilMs: T0 + 1_000 };
      db.raw
        .prepare(`UPDATE review_checks SET holder = ?, lease_until_ms = ? WHERE id = ?`)
        .run(fixtureLease.holder, fixtureLease.untilMs, attempt.identity.attemptId);
      expect(
        await recordTerminalDispatch(db, attempt.identity.attemptId, fixtureLease, T0 + 1_000),
      ).toBe(true);
      db.raw
        .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL WHERE id = ?`)
        .run(attempt.identity.attemptId);
      expect((await rawRow(db, attempt.identity.attemptId)).terminal_dispatch_ms).not.toBeNull();

      const second = await run(db, {
        now: () => T0 + 61_000,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { id: 4242, status: "completed", conclusion: "success", summary: "the run's own earlier text" }),
          }),
          complete: async () => {
            rewrites += 1;
            throw new Error("readback only — never rewritten");
          },
        }),
      });
      expect(rewrites).toBe(0);
      expect(second.gaveUp).toBe(0);
      expect(second.unconfirmed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    // note: No attempt spent by the readback pass, nothing terminal, still owed.
    expect(row.attempts).toBe(1);
    expect(row.terminal_ms).toBeNull();
  });

  test("F-D: an in-progress remote run still concludes as before", async () => {
    const db = seededDb();
    const { attempt } = await claim(db, { nowMs: T0 - 240_000, executionDeadlineMs: T0 + 900_000 });
    seedPersistedLaunch(db, attempt);
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL WHERE id = ?`)
      .run(attempt.identity.attemptId);
    const proof = proofFor(attempt.identity, "review");
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85), T0 - 100_000);
    linkPublication(db, attempt.identity.attemptId, proof.publicationId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => ({
            kind: "completed",
            remote: remoteFor(identity, { conclusion: "success", summary: conclusion.summary }),
          }),
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).toBe(T0);
  });

  test("a live execution holder keeps its lease and its own conclusion still lands", async () => {
    const db = seededDb();
    // note: The paid step just persisted its result and the consumer is still
    // collecting: its lease is live and its last write can predate the paid step's
    // completion. Recovery must not take the row — taking it bumps the epoch and the
    // consumer's own terminalize (a staging conflict's `pre-publication-failure`,
    // say) would then be fenced out, losing a conclusion it actually knows.
    const { attempt, lease } = await claim(db, { nowMs: T0 - 240_000, executionDeadlineMs: T0 + 900_000 });
    seedPersistedLaunch(db, attempt);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db, agreeingScript(db)) });
      expect(summary.examined).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.holder).toBe(lease.holder);
    expect(row.lease_epoch).toBe(lease.epoch);
    // note: The holder's conclusion is still saved under its own lease.
    expect(
      await setCheckDesired(
        db,
        attempt.identity.attemptId,
        lease,
        { desired: "failure", title: CHECK_NAME, summary: "pre-publication-failure" },
        null,
        T0 + 1_000,
      ),
    ).toBe(true);
    expect((await rawRow(db, attempt.identity.attemptId)).desired).toBe("failure");
  });

  test("a Check that already concluded is never touched", async () => {
    const db = seededDb();
    const { attempt } = await claim(db, { nowMs: T0 - 240_000, executionDeadlineMs: T0 + 900_000 });
    seedPersistedLaunch(db, attempt);
    db.raw
      .prepare(
        `UPDATE review_checks SET terminal_ms = ?, desired = 'success', observed = 'success', recovery_state = 'done' WHERE id = ?`,
      )
      .run(T0 - 120_000, attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db, agreeingScript(db, "success")) });
      expect(summary.examined).toBe(0);
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.terminal_ms).toBe(T0 - 120_000);
    expect(row.desired).toBe("success");
    expect(fetchStub.urls).toHaveLength(0);
  });
});

// note: ---------------------------------------------------------------------------
// Proof-based terminal conclusions for an expired attempt
// ---------------------------------------------------------------------------

describe("expired attempt → terminal conclusion from persisted proof (spec §7.9)", () => {
  test("a normal publication whose applied review meets the gate concludes success and marks observed", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const proof = proofFor(attempt.identity, "review");
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85));
    linkPublication(db, attempt.identity.attemptId, proof.publicationId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            expect(conclusion.desired).toBe("success");
            expect(conclusion.title).toBe(CHECK_NAME);
            expect(conclusion.summary).toContain("Review gate met for 0123456 (round 3)");
            expect(conclusion.summary).toContain('verdict "ship it"');
            expect(conclusion.summary).toContain("score 85");
            expect(conclusion.summary).toContain("floor 60");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "success", summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
      expect(summary.gaveUp).toBe(0);
      expect(summary.unconfirmed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.desired).toBe("success");
    expect(row.observed).toBe("success");
    expect(row.recovery_state).toBe("done");
    expect(row.terminal_ms).toBe(T0);
    expect(row.publication_id).toBe(proof.publicationId);
  });

  test("a confirmed degraded publication concludes failure, not neutral", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const degraded = proofFor(attempt.identity, "degraded");
    seedPublication(db, SCOPE, SHA, degraded, "applied");
    linkPublication(db, attempt.identity.attemptId, degraded.publicationId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            expect(conclusion.desired).toBe("failure");
            expect(conclusion.failureStatus).toBe("unknown-failure");
            expect(conclusion.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure", summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.desired).toBe("failure");
    expect(row.observed).toBe("failure");
  });

  test("an expired attempt with NO journal row concludes the approved failure wording", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            expect(conclusion.desired).toBe("failure");
            expect(conclusion.failureStatus).toBe("unknown-failure");
            expect(conclusion.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure", summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, attempt.identity.attemptId)).observed).toBe("failure");
  });

  test("a persistent gate/review read failure still terminalizes the attempt (QC3-F-001)", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const proof = proofFor(attempt.identity);
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 96));
    linkPublication(db, attempt.identity.attemptId, proof.publicationId);
    const degraded = withFailingReads(db, /FROM review_targets|SELECT payload_json FROM review_publications/);
    const fetchStub = stubFetch();
    const pushed: CheckConclusion[] = [];
    try {
      const summary = await run(degraded, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            pushed.push(conclusion);
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure", summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.errors).toBe(0);
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.desired).toBe("failure");
    expect(pushed[0]?.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.desired).toBe("failure");
    expect(row.observed).toBe("failure");
    expect(row.recovery_state).toBe("done");
  });

  test("a newly discovered proof CORRECTS a persisted unknown failure to success on the same run", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const proof = proofFor(attempt.identity, "review");
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 92));
    expect(
      await setCheckDesired(
        db,
        attempt.identity.attemptId,
        lease,
        { desired: "failure", title: CHECK_NAME, summary: "unconfirmed" },
        proof.publicationId,
        CLAIM_AT,
      ),
    ).toBe(true);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            expect(conclusion.desired).toBe("success");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "success", summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.desired).toBe("success");
    expect(row.publication_id).toBe(proof.publicationId);
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM review_checks`).first<{ n: number }>()).toEqual({ n: 1 });
  });

  test("§7.9a: a TERMINAL unconfirmed failure is revised once from its own publication's confirmation", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, { executionDeadlineMs: CLAIM_AT + CHECK_LEASE_MS });
    const attemptId = attempt.identity.attemptId;
    await attachProvenRun(db, attemptId, lease, CLAIM_AT + 1);
    const journalId = seedJournal(db, SCOPE, SHA, "sending", CLAIM_AT + 500);
    let clock = CLAIM_AT + 1_000;
    const sent: CheckConclusion[] = [];
    const lifecycle = terminalizeHarness(db, () => clock, sent);

    await lifecycle.terminalize({
      handle: { attemptId, scope: SCOPE, githubAppId: NUMERIC_APP, headSha: SHA, lease },
      publicationId: journalId,
      outcome: "publication-unknown",
    });
    let row = await rawRow(db, attemptId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.desired).toBe("failure");
    expect(row.desired).toBe("failure");
    expect(row.desired_summary).toBe(UNCONFIRMED);
    expect(row.observed).toBe("failure");
    expect(row.publication_id).toBe(journalId);
    expect(row.terminal_ms).not.toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");

    db.raw
      .prepare(`UPDATE review_publications SET payload_json = ? WHERE id = ?`)
      .run(JSON.stringify(reviewPayload(SCOPE, SHA, "ship it", 96)), journalId);
    const confirmedAt = clock + 60_000;
    const proofLease = await claimPublication(db as never, journalId, "proof-lane", confirmedAt, "sending");
    if (proofLease === null) throw new Error("fixture: the proof claim was refused");
    expect(
      await recordPublicationProof(db as never, journalId, proofLease, {
        publicationId: journalId,
        scope: SCOPE,
        headSha: SHA,
        kind: "review",
        round: 3,
        commentId: 9001,
        bodySha256: "a".repeat(64),
        confirmedMs: confirmedAt,
      }),
    ).toBe(true);

    clock = confirmedAt + 1_000;
    const pushed: CheckConclusion[] = [];
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => clock,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            pushed.push(conclusion);
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.desired).toBe("success");
    expect(pushed[0]!.summary).toContain('verdict "ship it"');
    expect(pushed[0]!.summary).toContain("score 96");
    row = await rawRow(db, attemptId);
    expect(row.desired).toBe("success");
    expect(row.observed).toBe("success");
    expect(row.desired_summary).not.toBe(UNCONFIRMED);
    expect(row.publication_id).toBe(journalId);
    expect(row.terminal_ms).not.toBeNull();
    expect(row.recovery_state).toBe("done");

    const second = await run(db, {
      now: () => clock + 60_000,
      credentials: scriptedCredentials(db, {
        complete: async () => {
          throw new Error("a second correction must not be sent");
        },
      }),
    });
    expect(second.examined).toBe(0);
    expect(await reopenTerminalCorrection(db, attemptId, journalId, "success", clock + 60_000)).toBe(false);
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM review_checks`).first<{ n: number }>()).toEqual({ n: 1 });
  });

  test("§7.9a: the correction replaces the failure GitHub already carries, on that same run", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, { executionDeadlineMs: CLAIM_AT + CHECK_LEASE_MS });
    const attemptId = attempt.identity.attemptId;
    await attachProvenRun(db, attemptId, lease, CLAIM_AT + 1);
    const journalId = seedJournal(db, SCOPE, SHA, "sending", CLAIM_AT + 500);
    let clock = CLAIM_AT + 1_000;
    const sent: CheckConclusion[] = [];
    const lifecycle = terminalizeHarness(db, () => clock, sent);

    await lifecycle.terminalize({
      handle: { attemptId, scope: SCOPE, githubAppId: NUMERIC_APP, headSha: SHA, lease },
      publicationId: journalId,
      outcome: "publication-unknown",
    });
    let row = await rawRow(db, attemptId);
    expect(sent).toHaveLength(1);
    expect(row.desired).toBe("failure");
    expect(row.desired_summary).toBe(UNCONFIRMED);
    expect(row.observed).toBe("failure");
    expect(row.recovery_state).toBe("remote-unconfirmed");

    db.raw
      .prepare(`UPDATE review_publications SET payload_json = ? WHERE id = ?`)
      .run(JSON.stringify(reviewPayload(SCOPE, SHA, "ship it", 96)), journalId);
    const confirmedAt = clock + 60_000;
    const proofLease = await claimPublication(db as never, journalId, "proof-lane", confirmedAt, "sending");
    if (proofLease === null) throw new Error("fixture: the proof claim was refused");
    expect(
      await recordPublicationProof(db as never, journalId, proofLease, {
        publicationId: journalId,
        scope: SCOPE,
        headSha: SHA,
        kind: "review",
        round: 3,
        commentId: 9001,
        bodySha256: "a".repeat(64),
        confirmedMs: confirmedAt,
      }),
    ).toBe(true);

    clock = confirmedAt + 1_000;
    const pushed: CheckConclusion[] = [];
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => clock,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { status: "completed", conclusion: "failure", summary: UNCONFIRMED }),
          }),
          complete: async (identity, _id, conclusion) => {
            pushed.push(conclusion);
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.desired).toBe("success");
    expect(pushed[0]!.summary).toContain('verdict "ship it"');
    row = await rawRow(db, attemptId);
    expect(row.desired).toBe("success");
    expect(row.observed).toBe("success");
    expect(row.recovery_state).toBe("done");

    expect(await reopenTerminalCorrection(db, attemptId, journalId, "success", clock + 60_000)).toBe(false);
    const second = await run(db, {
      now: () => clock + 60_000,
      credentials: scriptedCredentials(db, {
        complete: async () => {
          throw new Error("a second correction must not be sent");
        },
      }),
    });
    expect(second.examined).toBe(0);
    expect(pushed).toHaveLength(1);
  });

  test("§7.9a: a correction the request budget defers is delivered on the NEXT pass", async () => {
    const db = seededDb();
    const { attemptId, confirmedAt } = await owedCorrectionFixture(db);
    const clock = confirmedAt + 1_000;
    const pushed: CheckConclusion[] = [];
    const fetchStub = stubFetch();
    try {
      const first = await run(db, {
        now: () => clock,
        credentials: scriptedCredentials(db, {
          requestsPerCall: RECONCILE_DEFAULTS.checkRowMaxRequests,
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { status: "completed", conclusion: "failure", summary: UNCONFIRMED }),
          }),
          complete: async (identity, _id, conclusion) => {
            pushed.push(conclusion);
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
          },
        }),
      });
      expect(first.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect(pushed).toHaveLength(0);
    let row = await rawRow(db, attemptId);
    expect(row.terminal_ms).toBeNull();
    expect(row.correction_desired).toBe("success");
    expect(row.correction_generation).toBe(1);

    const second = await run(db, {
      now: () => clock + 60_000,
      credentials: scriptedCredentials(db, {
        fetch: async (identity) => ({
          kind: "found",
          remote: remoteFor(identity, { status: "completed", conclusion: "failure", summary: UNCONFIRMED }),
        }),
        complete: async (identity, _id, conclusion) => {
          pushed.push(conclusion);
          return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
        },
      }),
    });
    expect(second.completed).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.desired).toBe("success");
    expect(pushed[0]!.summary).toContain('verdict "ship it"');
    row = await rawRow(db, attemptId);
    expect(row.desired).toBe("success");
    expect(row.observed).toBe("success");
    expect(row.recovery_state).toBe("done");
    expect(row.correction_desired).toBeNull();
    expect(row.correction_generation).toBeNull();
  });

  test("§7.9a: two deferrals in a row still deliver the correction once", async () => {
    const db = seededDb();
    const { attemptId, confirmedAt } = await owedCorrectionFixture(db);
    const clock = confirmedAt + 1_000;
    const pushed: CheckConclusion[] = [];
    const deferring = () =>
      scriptedCredentials(db, {
        requestsPerCall: RECONCILE_DEFAULTS.checkRowMaxRequests,
        fetch: async (identity) => ({
          kind: "found",
          remote: remoteFor(identity, { status: "completed", conclusion: "failure", summary: UNCONFIRMED }),
        }),
        complete: async (identity, _id, conclusion) => {
          pushed.push(conclusion);
          return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
        },
      });
    const fetchStub = stubFetch();
    try {
      for (const at of [clock, clock + 60_000]) {
        const deferred = await run(db, { now: () => at, credentials: deferring() });
        expect(deferred.completed).toBe(0);
      }
    } finally {
      fetchStub.restore();
    }
    expect(pushed).toHaveLength(0);
    expect((await rawRow(db, attemptId)).correction_generation).toBe(1);

    const delivered = await run(db, {
      now: () => clock + 120_000,
      credentials: scriptedCredentials(db, {
        fetch: async (identity) => ({
          kind: "found",
          remote: remoteFor(identity, { status: "completed", conclusion: "failure", summary: UNCONFIRMED }),
        }),
        complete: async (identity, _id, conclusion) => {
          pushed.push(conclusion);
          return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
        },
      }),
    });
    expect(delivered.completed).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.desired).toBe("success");
    expect((await rawRow(db, attemptId)).observed).toBe("success");
  });

  test("§7.9a: an owed correction whose target generation moved sends nothing", async () => {
    const db = seededDb();
    const { attemptId, confirmedAt } = await owedCorrectionFixture(db);
    const clock = confirmedAt + 1_000;
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => clock,
        credentials: scriptedCredentials(db, {
          requestsPerCall: RECONCILE_DEFAULTS.checkRowMaxRequests,
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { status: "in_progress", conclusion: null }),
          }),
        }),
      });
    } finally {
      fetchStub.restore();
    }
    const owed = await rawRow(db, attemptId);
    expect(owed.correction_generation).toBe(1);
    expect(owed.desired).toBe("success");

    db.raw.prepare(`UPDATE review_checks SET generation = generation + 1 WHERE id = ?`).run(attemptId);

    const summary = await run(db, {
      now: () => clock + 60_000,
      credentials: scriptedCredentials(db, {
        fetch: async (identity) => ({
          kind: "found",
          remote: remoteFor(identity, { status: "in_progress", conclusion: null }),
        }),
        complete: async () => {
          throw new Error("a stale correction must not be sent");
        },
      }),
    });
    expect(summary.completed).toBe(0);
    expect(summary.errors).toBe(0);
    const row = await rawRow(db, attemptId);
    expect(row.correction_desired).toBeNull();
    expect(row.correction_generation).toBeNull();
    expect(row.desired).toBe("in_progress");
    expect(row.observed).toBe("failure");
    expect(row.terminal_ms).not.toBeNull();
    expect(row.recovery_state).toBe("local-error");
    expect(row.next_attempt_ms).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("no longer targets this row");
    const selected = await listCheckReconcileBatch(db, clock + 60_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit);
    expect(selected.map((candidate) => candidate.identity.attemptId)).not.toContain(attemptId);

    const after = await run(db, {
      now: () => clock + 120_000,
      credentials: scriptedCredentials(db, {
        complete: async () => {
          throw new Error("a parked correction must not be sent");
        },
      }),
    });
    expect(after.examined).toBe(0);
    expect(after.completed).toBe(0);
  });

  test("§7.9a: an unreadable gate on a deferred pass keeps the owed correction", async () => {
    const db = seededDb();
    const { attemptId, confirmedAt } = await owedCorrectionFixture(db);
    const clock = confirmedAt + 1_000;
    const pushed: CheckConclusion[] = [];
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => clock,
        credentials: scriptedCredentials(db, {
          requestsPerCall: RECONCILE_DEFAULTS.checkRowMaxRequests,
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { status: "in_progress", conclusion: null }),
          }),
        }),
      });
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, attemptId)).correction_generation).toBe(1);

    const degraded = withFailingReads(db, /FROM review_targets/);
    const held = await run(degraded, {
      now: () => clock + 30_000,
      credentials: scriptedCredentials(db, {
        fetch: async (identity) => ({
          kind: "found",
          remote: remoteFor(identity, { status: "in_progress", conclusion: null }),
        }),
        complete: async () => {
          throw new Error("a held correction must not be sent");
        },
      }),
    });
    expect(held.completed).toBe(0);
    expect(held.errors).toBe(0);
    let row = await rawRow(db, attemptId);
    expect(row.correction_desired).toBe("success");
    expect(row.correction_generation).toBe(1);
    expect(row.attempts).toBe(0);
    expect(row.holder).toBeNull();

    const delivered = await run(db, {
      now: () => clock + 60_000,
      credentials: scriptedCredentials(db, {
        fetch: async (identity) => ({
          kind: "found",
          remote: remoteFor(identity, { status: "in_progress", conclusion: null }),
        }),
        complete: async (identity, _id, conclusion) => {
          pushed.push(conclusion);
          return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
        },
      }),
    });
    expect(delivered.completed).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.desired).toBe("success");
    row = await rawRow(db, attemptId);
    expect(row.correction_generation).toBeNull();
    expect(row.observed).toBe("success");
  });

  test("§7.9a: an unreadable gate never records a correction the row did not earn", async () => {
    const db = seededDb();
    const { attemptId, confirmedAt } = await owedCorrectionFixture(db);
    const clock = confirmedAt + 1_000;
    const pushed: CheckConclusion[] = [];
    const degraded = withFailingReads(db, /FROM review_targets/);
    const fetchStub = stubFetch();
    try {
      const first = await run(degraded, {
        now: () => clock,
        credentials: scriptedCredentials(db, {
          complete: async (identity, _id, conclusion) => {
            pushed.push(conclusion);
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
          },
        }),
      });
      expect(first.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect(pushed).toHaveLength(0);
    let row = await rawRow(db, attemptId);
    expect(row.terminal_ms).not.toBeNull();
    expect(row.correction_desired).toBeNull();
    expect(row.correction_generation).toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");

    const second = await run(db, {
      now: () => clock + 60_000,
      credentials: scriptedCredentials(db, {
        fetch: async (identity) => ({
          kind: "found",
          remote: remoteFor(identity, { status: "completed", conclusion: "failure", summary: UNCONFIRMED }),
        }),
        complete: async (identity, _id, conclusion) => {
          pushed.push(conclusion);
          return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
        },
      }),
    });
    expect(second.completed).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.desired).toBe("success");
    row = await rawRow(db, attemptId);
    expect(row.observed).toBe("success");
    expect(row.correction_generation).toBeNull();
  });

  test("§7.9a: a lowered score floor re-decides the owed correction instead of dropping it", async () => {
    const db = seededDb();
    db.raw.prepare(`UPDATE review_targets SET check_min_score = 90 WHERE app_id = ?`).run(APP);
    const { attemptId, confirmedAt } = await owedCorrectionFixture(db, 80);
    const clock = confirmedAt + 1_000;
    const fetchStub = stubFetch();
    try {
      const deferred = await run(db, { now: () => clock, credentials: deferredCorrectionCredentials(db) });
      expect(deferred.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    let row = await rawRow(db, attemptId);
    expect(row.correction_desired).toBe("failure");
    expect(row.correction_dispatched_ms).toBeNull();

    db.raw.prepare(`UPDATE review_targets SET check_min_score = 70 WHERE app_id = ?`).run(APP);

    const pushed: CheckConclusion[] = [];
    const delivered = await run(db, {
      now: () => clock + 60_000,
      credentials: scriptedCredentials(db, {
        fetch: async (identity) => ({
          kind: "found",
          remote: remoteFor(identity, { status: "completed", conclusion: "failure", summary: UNCONFIRMED }),
        }),
        complete: async (identity, _id, conclusion) => {
          pushed.push(conclusion);
          return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
        },
      }),
    });
    expect(delivered.completed).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.desired).toBe("success");
    row = await rawRow(db, attemptId);
    expect(row.desired).toBe("success");
    expect(row.observed).toBe("success");
    expect(row.recovery_state).toBe("done");
    expect(row.correction_desired).toBeNull();
    expect(row.correction_dispatched_ms).toBeNull();
  });

  test("§7.9a: a possibly-dispatched revision is read back, never rewritten", async () => {
    const db = seededDb();
    db.raw.prepare(`UPDATE review_targets SET check_min_score = 90 WHERE app_id = ?`).run(APP);
    const { attemptId, confirmedAt } = await owedCorrectionFixture(db, 80);
    const clock = confirmedAt + 1_000;
    const fetchStub = stubFetch();
    try {
      await run(db, { now: () => clock, credentials: deferredCorrectionCredentials(db) });
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, attemptId)).correction_desired).toBe("failure");

    const lease = await claimCheckRecovery(db, attemptId, "correction-guard", clock + 30_000, RECONCILE_DEFAULTS.checkMaxAttempts);
    if (lease === null) throw new Error("fixture: the row was not claimable");
    expect(await recordTerminalDispatch(db, attemptId, lease, clock + 30_000)).toBe(true);
    expect(await releaseCheckClaim(db, attemptId, lease, clock + 31_000)).toBe(true);
    let row = await rawRow(db, attemptId);
    expect(row.correction_dispatched_ms).not.toBeNull();

    db.raw.prepare(`UPDATE review_targets SET check_min_score = 70 WHERE app_id = ?`).run(APP);
    const pushed: CheckConclusion[] = [];
    const dropping = await run(db, {
      now: () => clock + 60_000,
      credentials: scriptedCredentials(db, {
        fetch: async (identity) => ({
          kind: "found",
          remote: remoteFor(identity, { status: "completed", conclusion: "failure", summary: UNCONFIRMED }),
        }),
        complete: async (identity, _id, conclusion) => {
          pushed.push(conclusion);
          return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
        },
      }),
    });
    expect(dropping.completed).toBe(0);
    expect(pushed).toHaveLength(0);
    row = await rawRow(db, attemptId);
    expect(row.correction_desired).toBeNull();
    expect(row.correction_generation).toBeNull();
    expect(row.terminal_dispatch_ms).not.toBeNull();

    let readbackUpdates = 0;
    const readback = await run(db, {
      now: () => clock + 120_000,
      credentials: scriptedCredentials(db, {
        fetch: async (identity) => ({
          kind: "found",
          remote: remoteFor(identity, { status: "completed", conclusion: "failure", summary: UNCONFIRMED }),
        }),
        complete: async () => {
          readbackUpdates += 1;
          throw new Error("a possibly-sent correction must never be re-sent");
        },
      }),
    });
    expect(readbackUpdates).toBe(0);
    expect(readback.completed).toBe(0);
  });

  test("§7.9a: agreeing with an older failure never settles an owed success", async () => {
    const db = seededDb();
    const { attemptId, confirmedAt } = await owedCorrectionFixture(db);
    const clock = confirmedAt + 1_000;
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => clock,
        credentials: scriptedCredentials(db, {
          requestsPerCall: RECONCILE_DEFAULTS.checkRowMaxRequests,
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { status: "in_progress", conclusion: null }),
          }),
        }),
      });
    } finally {
      fetchStub.restore();
    }
    db.raw
      .prepare(`UPDATE review_checks SET desired = 'failure', desired_title = ?, desired_summary = ? WHERE id = ?`)
      .run(CHECK_NAME, UNCONFIRMED, attemptId);
    const lease = await claimCheckRecovery(db, attemptId, "correction-guard", clock + 30_000, RECONCILE_DEFAULTS.checkMaxAttempts);
    if (lease === null) throw new Error("fixture: the row was not claimable");
    const attempt = await getCheckAttempt(db, attemptId);
    if (attempt === null) throw new Error("fixture: the row vanished");
    expect(
      await recordCheckObservation(
        db,
        attemptId,
        lease,
        remoteFor(attempt.identity, { status: "completed", conclusion: "failure", summary: UNCONFIRMED }),
        clock + 30_000,
      ),
    ).toBe(true);
    let row = await rawRow(db, attemptId);
    expect(row.observed).toBe("failure");
    expect(row.correction_desired).toBe("success");
    expect(row.correction_generation).toBe(1);
    expect(row.terminal_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");

    expect(await releaseCheckClaim(db, attemptId, lease, clock + 31_000)).toBe(true);
    const pushed: CheckConclusion[] = [];
    const delivered = await run(db, {
      now: () => clock + 60_000,
      credentials: scriptedCredentials(db, {
        fetch: async (identity) => ({
          kind: "found",
          remote: remoteFor(identity, { status: "in_progress", conclusion: null }),
        }),
        complete: async (identity, _id, conclusion) => {
          pushed.push(conclusion);
          return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
        },
      }),
    });
    expect(delivered.completed).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.desired).toBe("success");
    row = await rawRow(db, attemptId);
    expect(row.observed).toBe("success");
    expect(row.correction_generation).toBeNull();
  });

  test("§7.9a: a positive intent the evidence denies is never sent", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, { executionDeadlineMs: CLAIM_AT + CHECK_LEASE_MS });
    const attemptId = attempt.identity.attemptId;
    await attachProvenRun(db, attemptId, lease, CLAIM_AT + 1);
    const proof = proofFor(attempt.identity);
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "needs work", 10));
    expect(
      await setCheckDesired(
        db,
        attemptId,
        lease,
        { desired: "success", title: CHECK_NAME, summary: "all good" },
        proof.publicationId,
        CLAIM_AT,
      ),
    ).toBe(true);

    const pushed: CheckConclusion[] = [];
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { status: "in_progress", conclusion: null }),
          }),
          complete: async (identity, _id, conclusion) => {
            pushed.push(conclusion);
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect(pushed).toHaveLength(0);
    const row = await rawRow(db, attemptId);
    expect(row.desired).toBe("success");
    expect(row.last_error).toContain("could not be replaced by failure");
  });

  test("§7.9a: a DIFFERENT publication's confirmation never revises a linked terminal record", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, { executionDeadlineMs: CLAIM_AT + CHECK_LEASE_MS });
    const attemptId = attempt.identity.attemptId;
    await attachProvenRun(db, attemptId, lease, CLAIM_AT + 1);
    const journalId = seedJournal(db, SCOPE, SHA, "sending", CLAIM_AT + 500);
    const clock = CLAIM_AT + 1_000;
    const lifecycle = terminalizeHarness(db, () => clock, []);
    await lifecycle.terminalize({
      handle: { attemptId, scope: SCOPE, githubAppId: NUMERIC_APP, headSha: SHA, lease },
      publicationId: journalId,
      outcome: "publication-unknown",
    });

    seedPublication(
      db,
      SCOPE,
      SHA,
      {
        publicationId: "publication-other",
        scope: SCOPE,
        headSha: SHA,
        kind: "degraded",
        round: 2,
        commentId: 88,
        bodySha256: "b".repeat(64),
        confirmedMs: clock + 30_000,
      },
      "confirmed",
      reviewPayload(SCOPE, SHA, "ship it", 96),
    );

    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => clock + 60_000,
        credentials: scriptedCredentials(db, {
          complete: async () => {
            throw new Error("a foreign confirmation must not send");
          },
        }),
      });
      expect(summary.examined).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect(await reopenTerminalCorrection(db, attemptId, "publication-other", "success", clock + 60_000)).toBe(false);
    expect(await reopenTerminalCorrection(db, attemptId, journalId, "success", clock + 60_000)).toBe(false);

    let row = await rawRow(db, attemptId);
    expect(row.terminal_ms).not.toBeNull();
    expect(row.desired_summary).toBe(UNCONFIRMED);
    expect(row.recovery_state).toBe("remote-unconfirmed");

    const ownProofLease = await claimPublication(db as never, journalId, "proof-lane", clock + 90_000, "sending");
    if (ownProofLease === null) throw new Error("fixture: the proof claim was refused");
    expect(
      await recordPublicationProof(db as never, journalId, ownProofLease, {
        publicationId: journalId,
        scope: SCOPE,
        headSha: SHA,
        kind: "review",
        round: 3,
        commentId: 9001,
        bodySha256: "a".repeat(64),
        confirmedMs: clock + 90_000,
      }),
    ).toBe(true);
    expect(await reopenTerminalCorrection(db, attemptId, "publication-other", "success", clock + 120_000)).toBe(false);
    expect(await reopenTerminalCorrection(db, attemptId, journalId, "success", clock + 120_000)).toBe(true);
    expect(await reopenTerminalCorrection(db, attemptId, journalId, "success", clock + 120_000)).toBe(false);
    row = await rawRow(db, attemptId);
    expect(row.terminal_ms).toBeNull();
    expect(row.desired_summary).toBe(UNCONFIRMED);
  });

  test("§7.9a: an unconfirmed terminal record with NO publication link is never revised", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, { executionDeadlineMs: CLAIM_AT + CHECK_LEASE_MS });
    const attemptId = attempt.identity.attemptId;
    await attachProvenRun(db, attemptId, lease, CLAIM_AT + 1);
    const clock = CLAIM_AT + 1_000;
    const lifecycle = terminalizeHarness(db, () => clock, []);
    await lifecycle.terminalize({
      handle: { attemptId, scope: SCOPE, githubAppId: NUMERIC_APP, headSha: SHA, lease },
      publicationId: null,
      outcome: "publication-unknown",
    });

    const row = await rawRow(db, attemptId);
    expect(row.terminal_ms).not.toBeNull();
    expect(row.publication_id).toBeNull();
    expect(row.desired_summary).toBe(UNCONFIRMED);
    expect(row.recovery_state).toBe("done");
    const summary = await run(db, {
      now: () => clock + 60_000,
      credentials: scriptedCredentials(db, { complete: async () => { throw new Error("no send expected"); } }),
    });
    expect(summary.examined).toBe(0);
    expect(await reopenTerminalCorrection(db, attemptId, "publication-other", "success", clock + 60_000)).toBe(false);
  });

  test("§7.9a: the revision is fenced on the TERMINAL record itself", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, { executionDeadlineMs: CLAIM_AT + CHECK_LEASE_MS });
    const attemptId = attempt.identity.attemptId;
    await attachProvenRun(db, attemptId, lease, CLAIM_AT + 1);
    const journalId = seedJournal(db, SCOPE, SHA, "sending", CLAIM_AT + 500);
    const clock = CLAIM_AT + 1_000;
    const lifecycle = terminalizeHarness(db, () => clock, []);
    await lifecycle.terminalize({
      handle: { attemptId, scope: SCOPE, githubAppId: NUMERIC_APP, headSha: SHA, lease },
      publicationId: journalId,
      outcome: "publication-unknown",
    });
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ? WHERE id = ?`)
      .run(JSON.stringify({ ...proofFor(attempt.identity), publicationId: journalId }), journalId);
    db.raw.prepare(`UPDATE review_checks SET terminal_ms = NULL WHERE id = ?`).run(attemptId);
    expect(await reopenTerminalCorrection(db, attemptId, journalId, "success", clock + 60_000)).toBe(false);
  });

  test("§7.9a: a record SUPERSEDED by a newer open generation is never reopened", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, { executionDeadlineMs: CLAIM_AT + CHECK_LEASE_MS });
    const attemptId = attempt.identity.attemptId;
    await attachProvenRun(db, attemptId, lease, CLAIM_AT + 1);
    const journalId = seedJournal(db, SCOPE, SHA, "sending", CLAIM_AT + 500);
    const clock = CLAIM_AT + 1_000;
    const lifecycle = terminalizeHarness(db, () => clock, []);
    await lifecycle.terminalize({
      handle: { attemptId, scope: SCOPE, githubAppId: NUMERIC_APP, headSha: SHA, lease },
      publicationId: journalId,
      outcome: "publication-unknown",
    });
    const next = await claim(db, { nowMs: CLAIM_AT + 2_000, executionDeadlineMs: CLAIM_AT + CHECK_LEASE_MS + 2_000 });
    expect(next.attempt.identity.generation).toBe(2);
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ? WHERE id = ?`)
      .run(JSON.stringify({ ...proofFor(attempt.identity), publicationId: journalId }), journalId);
    expect(await reopenTerminalCorrection(db, attemptId, journalId, "success", clock + 60_000)).toBe(false);
    const row = await rawRow(db, attemptId);
    expect(row.terminal_ms).not.toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");
  });

  test("§7.9a: an unconfirmed failure whose OWN update never landed stays with the ordinary lane", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, { executionDeadlineMs: CLAIM_AT + CHECK_LEASE_MS });
    const attemptId = attempt.identity.attemptId;
    await attachProvenRun(db, attemptId, lease, CLAIM_AT + 1);
    const journalId = seedJournal(db, SCOPE, SHA, "sending", CLAIM_AT + 500);
    const clock = CLAIM_AT + 1_000;
    const lifecycle = terminalizeHarness(db, () => clock, [], "unavailable");
    await lifecycle.terminalize({
      handle: { attemptId, scope: SCOPE, githubAppId: NUMERIC_APP, headSha: SHA, lease },
      publicationId: journalId,
      outcome: "publication-unknown",
    });

    const row = await rawRow(db, attemptId);
    expect(row.terminal_ms).toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.desired_summary).toBe(UNCONFIRMED);
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ? WHERE id = ?`)
      .run(JSON.stringify({ ...proofFor(attempt.identity), publicationId: journalId }), journalId);
    expect(await reopenTerminalCorrection(db, attemptId, journalId, "success", clock + 1)).toBe(false);
  });

  test("§7.9a: a mark that never confirms cannot displace one that is ready", async () => {
    const db = seededDb();
    const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
    const DUE_SHA = "0123456789abcdef0123456789abcdef0123456f";
    const staleId = await markedUnconfirmed(db, SHA, "publication-stale");
    const readyId = await markedUnconfirmed(db, OTHER_SHA, "publication-ready");
    await claim(db, { headSha: DUE_SHA, executionDeadlineMs: CLAIM_AT + 1_000 });
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          publicationId: "publication-ready",
          scope: SCOPE,
          headSha: OTHER_SHA,
          kind: "review",
          round: 3,
          commentId: 77,
          bodySha256: "a".repeat(64),
          confirmedMs: CLAIM_AT + 2_000,
        }),
        "publication-ready",
      );

    const two = await listCheckReconcileBatch(db, CLAIM_AT + 5_000, RECONCILE_DEFAULTS.checkMaxAttempts, 2);
    expect(two.map((row) => row.identity.attemptId)).toEqual([readyId, expect.any(String)]);
    expect(two.map((row) => row.identity.attemptId)).not.toContain(staleId);
    const three = await listCheckReconcileBatch(db, CLAIM_AT + 5_000, RECONCILE_DEFAULTS.checkMaxAttempts, 3);
    expect(three).toHaveLength(3);
    expect(three[0]!.identity.attemptId).toBe(readyId);
    expect(three[2]!.identity.attemptId).toBe(staleId);
  });

  test("§7.9a: a valid but foreign-scoped link is never correctable (I-000673)", async () => {
    const db = seededDb();
    const DUE_SHA = "0123456789abcdef0123456789abcdef0123456f";
    const READY_SHA = "fedcba9876543210fedcba9876543210fedcba98";
    const foreignId = await markedUnconfirmed(db, SHA, "publication-foreign");
    const readyId = await markedUnconfirmed(db, READY_SHA, "publication-ready");
    // Both links carry valid, self-referential JSON naming their own row; the
    // foreign one's embedded scope names another installation than the journal
    // row — and the Check — it is stored on.
    const scopedProof = (publicationId: string, headSha: string, installationId: number) =>
      JSON.stringify({
        publicationId,
        scope: { ...SCOPE, installationId },
        headSha,
        kind: "review",
        round: 3,
        commentId: 77,
        bodySha256: "a".repeat(64),
        confirmedMs: CLAIM_AT + 2_000,
      });
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ? WHERE id = ?`)
      .run(scopedProof("publication-foreign", SHA, SCOPE.installationId + 1), "publication-foreign");
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ? WHERE id = ?`)
      .run(scopedProof("publication-ready", READY_SHA, SCOPE.installationId), "publication-ready");
    const due = await claim(db, { headSha: DUE_SHA, executionDeadlineMs: CLAIM_AT + 1_000 });
    const dueId = due.attempt.identity.attemptId;

    // The foreign link is not a proof the reader would accept: the store guard
    // refuses the reopen, and the batch orders the mark behind ready work.
    expect(await reopenTerminalCorrection(db, foreignId, "publication-foreign", "success", CLAIM_AT + 5_000)).toBe(false);
    const one = await listCheckReconcileBatch(db, CLAIM_AT + 5_000, RECONCILE_DEFAULTS.checkMaxAttempts, 1);
    expect(one.map((row) => row.identity.attemptId)).toEqual([readyId]);
    const all = await listCheckReconcileBatch(db, CLAIM_AT + 5_000, RECONCILE_DEFAULTS.checkMaxAttempts, 3);
    expect(all.map((row) => row.identity.attemptId)).toEqual([readyId, dueId, foreignId]);
    // The genuine mark still reopens exactly once for its own proof.
    expect(await reopenTerminalCorrection(db, readyId, "publication-ready", "success", CLAIM_AT + 5_000)).toBe(true);
    expect(await reopenTerminalCorrection(db, readyId, "publication-ready", "success", CLAIM_AT + 5_000)).toBe(false);
  });

  test("§7.9a: the ordering class is exactly the transition's precondition", async () => {
    const db = seededDb();
    const CORRUPT_SHA = "fedcba9876543210fedcba9876543210fedcba99";
    const blockedId = await markedUnconfirmed(db, SHA, "publication-blocked");
    const next = await claim(db, { nowMs: CLAIM_AT + 2_000, executionDeadlineMs: CLAIM_AT + 3_000 });
    expect(next.attempt.identity.generation).toBe(2);
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          publicationId: "publication-blocked",
          scope: SCOPE,
          headSha: SHA,
          kind: "review",
          round: 3,
          commentId: 77,
          bodySha256: "a".repeat(64),
          confirmedMs: CLAIM_AT + 2_500,
        }),
        "publication-blocked",
      );
    const corruptId = await markedUnconfirmed(db, CORRUPT_SHA, "publication-corrupt");
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ? WHERE id = ?`)
      .run("{not json", "publication-corrupt");

    const one = await listCheckReconcileBatch(db, CLAIM_AT + 5_000, RECONCILE_DEFAULTS.checkMaxAttempts, 1);
    expect(one.map((row) => row.identity.attemptId)).toEqual([next.attempt.identity.attemptId]);
    const all = await listCheckReconcileBatch(db, CLAIM_AT + 5_000, RECONCILE_DEFAULTS.checkMaxAttempts, 5);
    expect(all[0]!.identity.attemptId).toBe(next.attempt.identity.attemptId);
    expect(all.slice(1).map((row) => row.identity.attemptId).sort()).toEqual([blockedId, corruptId].sort());
  });

  test("§7.9a: a mark whose App pair is unusable is ordered behind due work", async () => {
    const db = seededDb();
    const blockedId = await markedUnconfirmed(db, SHA, "publication-disabled");
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          publicationId: "publication-disabled",
          scope: SCOPE,
          headSha: SHA,
          kind: "review",
          round: 3,
          commentId: 77,
          bodySha256: "a".repeat(64),
          confirmedMs: CLAIM_AT + 2_500,
        }),
        "publication-disabled",
      );
    db.raw.prepare(`UPDATE github_apps SET status = 'disabled' WHERE id = ?`).run(APP);
    const other = await claim(db, {
      scope: SCOPE_B,
      githubAppId: NUMERIC_APP_B,
      headSha: SHA,
      executionDeadlineMs: CLAIM_AT + 1_000,
    });
    const one = await listCheckReconcileBatch(db, CLAIM_AT + 5_000, RECONCILE_DEFAULTS.checkMaxAttempts, 1);
    expect(one.map((row) => row.identity.attemptId)).toEqual([other.attempt.identity.attemptId]);
    const both = await listCheckReconcileBatch(db, CLAIM_AT + 5_000, RECONCILE_DEFAULTS.checkMaxAttempts, 2);
    expect(both.map((row) => row.identity.attemptId)).toEqual([other.attempt.identity.attemptId, blockedId]);
  });

  test("§7.9a: the recovery lane's own proof-free `expired` carries the same mark", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, { executionDeadlineMs: CLAIM_AT + CHECK_LEASE_MS });
    const attemptId = attempt.identity.attemptId;
    await attachProvenRun(db, attemptId, lease, CLAIM_AT + 1);
    const journalId = seedJournal(db, SCOPE, SHA, "sending", CLAIM_AT + 500);
    const clock = CLAIM_AT + 1_000;
    await terminalizeHarness(db, () => clock, [], "unavailable").terminalize({
      handle: { attemptId, scope: SCOPE, githubAppId: NUMERIC_APP, headSha: SHA, lease },
      publicationId: journalId,
      outcome: "publication-unknown",
    });

    const atDeadline = CLAIM_AT + CHECK_LEASE_MS + 1_000;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => atDeadline,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            expect(conclusion.desired).toBe("failure");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure", summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    let row = await rawRow(db, attemptId);
    expect(row.terminal_ms).not.toBeNull();
    expect(row.publication_id).toBe(journalId);
    expect(row.recovery_state).toBe("remote-unconfirmed");

    db.raw
      .prepare(`UPDATE review_publications SET payload_json = ? WHERE id = ?`)
      .run(JSON.stringify(reviewPayload(SCOPE, SHA, "ship it", 96)), journalId);
    const confirmedAt = atDeadline + 60_000;
    const proofLease = await claimPublication(db as never, journalId, "proof-lane", confirmedAt, "sending");
    if (proofLease === null) throw new Error("fixture: the proof claim was refused");
    expect(
      await recordPublicationProof(db as never, journalId, proofLease, {
        publicationId: journalId,
        scope: SCOPE,
        headSha: SHA,
        kind: "review",
        round: 3,
        commentId: 9001,
        bodySha256: "a".repeat(64),
        confirmedMs: confirmedAt,
      }),
    ).toBe(true);
    const pushed: CheckConclusion[] = [];
    const fetchStub2 = stubFetch();
    try {
      const summary = await run(db, {
        now: () => confirmedAt + 1_000,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            pushed.push(conclusion);
            return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub2.restore();
    }
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.desired).toBe("success");
    row = await rawRow(db, attemptId);
    expect(row.desired).toBe("success");
    expect(row.observed).toBe("success");
    expect(row.recovery_state).toBe("done");
  });

  test("the gate reads the attempt's OWN publication, not the scope/SHA reviews row", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const proof = proofFor(attempt.identity, "review");
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 95));
    linkPublication(db, attempt.identity.attemptId, proof.publicationId);
    seedReview(db, SCOPE, SHA, "blocked", 40);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            expect(conclusion.desired).toBe("success");
            expect(conclusion.summary).toContain('verdict "ship it"');
            expect(conclusion.summary).toContain("score 95");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "success", summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.desired).toBe("success");
    expect(row.observed).toBe("success");
    expect(row.publication_id).toBe(proof.publicationId);
  });

  test("proof from ANOTHER SHA never decides this attempt's conclusion", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    seedPublication(db, SCOPE, `f${SHA.slice(1)}`, proofFor(attempt.identity, "review"));
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            expect(conclusion.desired).toBe("failure");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure", summary: conclusion.summary }) };
          },
        }),
      });
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.desired).toBe("failure");
    expect(row.publication_id).toBeNull();
  });
});


describe("adoption before creation (spec §7.9 / RL-12)", () => {
  test("a possibly-sent create is resolved by read-only adoption, never a second create", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw.prepare(`UPDATE review_checks SET create_state = 'sending' WHERE id = ?`).run(attempt.identity.attemptId);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { id: 909, status: "in_progress", conclusion: null }),
          }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { id: 909, status: "in_progress", conclusion: null }) }),
          complete: async (identity, runId, conclusion) => {
            expect(runId).toBe(909);
            return { kind: "completed", remote: remoteFor(identity, { id: 909, conclusion: "failure", summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.check_run_id).toBe(909);
    expect(row.create_state).toBe("known");
  });

  test("a definitively unsent attempt creates exactly once when adoption proves absence", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { id: 555, status: "in_progress", conclusion: null }) };
          },
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { id: 555, status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => ({ kind: "completed", remote: remoteFor(identity, { id: 555, conclusion: "failure", summary: conclusion.summary }) }),
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(1);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.check_run_id).toBe(555);
    expect(row.create_state).toBe("known");
  });

  test("an UNPROVEN absence (incomplete walk) never creates and stays recoverable", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "incomplete" }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
        }),
      });
      expect(summary.unconfirmed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.check_run_id).toBeNull();
    expect(row.create_state).toBe("not-sent");
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[0]!);
    expect(row.attempts).toBe(1);
  });

  test("a possibly-sent create with an OBSERVED absence is still never re-created (uncertain stays remote-unconfirmed)", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw.prepare(`UPDATE review_checks SET create_state = 'sending' WHERE id = ?`).run(attempt.identity.attemptId);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
        }),
      });
      expect(summary.unconfirmed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.create_state).toBe("sending");
    expect(row.check_run_id).toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[0]!);
  });

  test("an ambiguous walk (two matching candidates) never creates", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "ambiguous" }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
        }),
      });
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    expect((await rawRow(db, attempt.identity.attemptId)).recovery_state).toBe("remote-unconfirmed");
  });
});


describe("response validation and stale-epoch writes (spec §7.11.2 step 4)", () => {
  test("a terminal response that does not match the persisted intent is NOT recorded", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity) => ({ kind: "completed", remote: remoteFor(identity, { conclusion: "cancelled" }) }),
        }),
      });
      expect(summary.completed).toBe(0);
      expect(summary.unconfirmed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.observed).toBe("unknown");
    expect(row.desired).toBe("failure");
    expect(row.terminal_ms).toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");
  });

  test("an old-epoch response cannot persist an observation once the lease moved", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            db.raw
              .prepare(`UPDATE review_checks SET lease_epoch = lease_epoch + 1 WHERE id = ?`)
              .run(identity.attemptId);
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure", summary: conclusion.summary }) };
          },
        }),
      });
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.observed).toBe("unknown");
    expect(row.terminal_ms).toBeNull();
  });

  test("a known remote id is RETAINED when its run is absent remotely (never cleared to create a lookalike)", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 321 WHERE id = ?`)
      .run(attempt.identity.attemptId);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
          fetch: async () => ({ kind: "absent" }),
        }),
      });
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.check_run_id).toBe(321);
    expect(row.create_state).toBe("known");
    expect(row.recovery_state).toBe("remote-unconfirmed");
  });
});


describe("backoff and honest give-up (spec §7.11.2 steps 4–5)", () => {
  test("a first failure defers with the 1-minute backoff, releases the lease and spends one attempt", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async () => ({ kind: "unavailable", reason: "check create failed: socket hang up" }),
        }),
      });
      expect(summary.unconfirmed).toBe(1);
      expect(summary.gaveUp).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[0]!);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.terminal_ms).toBeNull();
  });

  test("the fifth failure gives up to local-error with terminal_ms and every remote identity RETAINED", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw
      .prepare(
        `UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, attempts = ?, create_state = 'known', check_run_id = 777 WHERE id = ?`,
      )
      .run(RECONCILE_DEFAULTS.checkMaxAttempts - 1, attempt.identity.attemptId);
    const warned: { event: string; detail: string }[] = [];
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        log: { warn: (fields) => void warned.push(fields), info: () => {} },
        credentials: scriptedCredentials(db, {
          fetch: async () => ({ kind: "unavailable", reason: "check get failed: 502" }),
        }),
      });
      expect(summary.gaveUp).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.recovery_state).toBe("local-error");
    expect(row.terminal_ms).toBe(T0);
    expect(row.check_run_id).toBe(777);
    expect(row.external_id).toBe(attempt.identity.externalId);
    expect(row.generation).toBe(attempt.identity.generation);
    const giveUp = warned.find((entry) => entry.event === "ops_check_reconcile_gave_up");
    expect(giveUp).toBeDefined();
    expect(giveUp!.detail).toContain(`app=${APP}`);
    expect(giveUp!.detail).toContain(`work=${attempt.identity.attemptId}`);
    expect(giveUp!.detail).not.toContain(SHA);
  });

  test("give-up never fires below the cap, and the deferral follows the 1/2/4/8 ladder", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw.prepare(`UPDATE review_checks SET attempts = 3 WHERE id = ?`).run(attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async () => ({ kind: "unavailable", reason: "check create failed: 500" }),
        }),
      });
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[3]!);
    expect(row.terminal_ms).toBeNull();
  });
});


describe("request budgets (spec §7.11.2 step 5)", () => {
  test("admission stops a row at ≤6 dispatched requests, mutating nothing and spending no attempt", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          requestsPerCall: 4,
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
        }),
      });
      expect(summary.gaveUp).toBe(0);
      expect(summary.errors).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect(fetchStub.urls).toHaveLength(RECONCILE_DEFAULTS.checkRowMaxRequests);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
    expect(row.terminal_ms).toBeNull();
  });

  test("the run refuses at ≤100 requests and never dispatches the 101st", async () => {
    const db = seededDb();
    await claim(db);
    const capture: { transport?: CheckTransport } = {};
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: async ({ transport }) => {
          capture.transport = transport;
          return { kind: "unavailable", reason: "missing" };
        },
      });
      const transport = capture.transport;
      if (transport === undefined) throw new Error("the run never built a transport");
      const before = fetchStub.urls.length;
      for (let i = 0; i < RECONCILE_DEFAULTS.checkMaxRequests; i += 1) {
        await transport.fetchImpl(`https://api.github.com/x?n=${i}`);
      }
      expect(fetchStub.urls.length - before).toBe(RECONCILE_DEFAULTS.checkMaxRequests);
      await expect(transport.fetchImpl("https://api.github.com/x?over=1")).rejects.toThrow(/budget exhausted/);
      expect(fetchStub.urls.length - before).toBe(RECONCILE_DEFAULTS.checkMaxRequests);
    } finally {
      fetchStub.restore();
    }
  });

  test("each request is bounded at ≤5s and clamped by the remaining run deadline", async () => {
    const db = seededDb();
    await claim(db);
    const capture: { transport?: CheckTransport } = {};
    let clock = T0;
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => clock,
        credentials: async ({ transport }) => {
          capture.transport = transport;
          return { kind: "unavailable", reason: "missing" };
        },
      });
      const transport = capture.transport!;
      expect(transport.boundMs()).toBe(RECONCILE_DEFAULTS.checkPerRequestMs);
      clock = T0 + RECONCILE_DEFAULTS.checkRunBudgetMs - 10;
      expect(transport.boundMs()).toBe(10);
      clock = T0 + RECONCILE_DEFAULTS.checkRunBudgetMs;
      expect(transport.boundMs()).toBe(1);
    } finally {
      fetchStub.restore();
    }
  });

  test("an exhausted run stops before claiming, leaving the row due with no attempt spent", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    let clock = T0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => {
          const value = clock;
          clock = T0 + RECONCILE_DEFAULTS.checkRunBudgetMs;
          return value;
        },
        credentials: scriptedCredentials(db, agreeingScript(db)),
      });
      expect(summary.examined).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect(fetchStub.urls).toHaveLength(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.terminal_ms).toBeNull();
  });
});


describe("tenant/App isolation and status-driven re-enable (spec §7.6)", () => {
  test("only the unusable pair is suspended; the healthy pair still completes", async () => {
    const db = seededDb();
    const good = await claim(db, { action: "good" });
    const bad = await claim(db, { scope: SCOPE_B, githubAppId: NUMERIC_APP_B, action: "bad" });
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 42 WHERE id = ?`)
      .run(bad.attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db, agreeingScript(db)) });
      expect(summary.completed).toBe(1);
      expect(summary.suspended).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, good.attempt.identity.attemptId)).recovery_state).toBe("done");
    const badRow = await rawRow(db, bad.attempt.identity.attemptId);
    expect(badRow.recovery_state).toBe("suspended");
    expect(badRow.terminal_ms).toBeNull();
    expect(badRow.external_id).toBe(bad.attempt.identity.externalId);
    // 0115 renamed review_checks.bot_id back to app_id.
    expect(badRow.app_id).toBe(APP_B);
    expect(badRow.attempts).toBe(0);
  });

  test("re-enable never touches a suspended row of a NOT-active App", async () => {
    const db = seededDb();
    const healthy = await claim(db, { action: "healthy" });
    const disabled = await claim(db, { scope: SCOPE_B, githubAppId: NUMERIC_APP_B, action: "disabled" });
    for (const id of [healthy.attempt.identity.attemptId, disabled.attempt.identity.attemptId]) {
      db.raw
        .prepare(
          `UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, recovery_state = 'suspended', last_error = ? WHERE id = ?`,
        )
        .run(checkSuspensionReason("disabled", "app disabled"), id);
    }
    db.raw.prepare(`UPDATE github_apps SET status = 'disabled' WHERE id = ?`).run(APP_B);
    const asked: string[] = [];
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: async ({ scope }) => {
          asked.push(scope.appId);
          return { kind: "unavailable", reason: "missing" };
        },
      });
      expect(summary.examined).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(asked).toEqual([APP]);
    const disabledRow = await rawRow(db, disabled.attempt.identity.attemptId);
    expect(disabledRow.recovery_state).toBe("suspended");
    expect(disabledRow.terminal_ms).toBeNull();
    expect(disabledRow.holder).toBeNull();
  });
});


describe("throw-proofing (spec §7.11 composition)", () => {
  test("a throwing credential factory is contained: the pair is suspended, never a throw", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const warned: { event: string }[] = [];
    const summary = await run(db, {
      now: () => T0,
      log: { warn: (fields) => void warned.push(fields), info: () => {} },
      credentials: async () => {
        throw new Error("token mint exploded");
      },
    });
    expect(summary.suspended).toBe(1);
    expect(summary.errors).toBe(0);
    expect(warned.some((entry) => entry.event === "ops_check_reconcile_credential_failed")).toBe(true);
    expect((await rawRow(db, attempt.identity.attemptId)).recovery_state).toBe("suspended");
  });

  test("an unbound DB binding and a broken D1 both resolve without throwing", async () => {
    const unbound = await reconcileReviewChecks({} as ScheduledEnv, { log: SILENT_LOG });
    expect(unbound).toEqual({ examined: 0, completed: 0, unconfirmed: 0, suspended: 0, gaveUp: 0, errors: 0, deferred: 0 });

    const broken = {
      prepare(): never {
        throw new Error("d1 down");
      },
      batch: async () => [],
    } as unknown as TestD1;
    const summary = await run(broken);
    expect(summary.errors).toBe(1);
  });

  test("a throwing adapter on one row never stops the other due row", async () => {
    const db = seededDb();
    const first = await claim(db, { action: "first" });
    const second = await claim(db, { action: "second", triggeredBy: "other", headSha: `f${SHA.slice(1)}` });
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'sending' WHERE id = ?`)
      .run(second.attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async (identity) => {
            if (identity.attemptId === first.attempt.identity.attemptId) throw new Error("adapter exploded");
            return { kind: "found", remote: remoteFor(identity, { id: 61, status: "in_progress", conclusion: null }) };
          },
          fetch: async (identity, checkRunId) => ({
            kind: "found",
            remote: remoteFor(identity, {
              id: checkRunId,
              status: "completed",
              conclusion: "failure",
              summary: frozenSummaryOf(db, identity.attemptId),
            }),
          }),
        }),
      });
      expect(summary.examined).toBe(2);
      expect(summary.completed).toBe(1);
      expect(summary.errors).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, second.attempt.identity.attemptId)).observed).toBe("failure");
  });
});


async function captureComposition(env: ScheduledEnv, cron = ""): Promise<string[]> {
  const events: string[] = [];
  const sweepWarn = defaultSweepLog.warn;
  const lifecycleWarn = defaultReconcileLog.warn;
  const lifecycleInfo = defaultReconcileLog.info;
  const checkWarn = defaultCheckReconcileLog.warn;
  const checkInfo = defaultCheckReconcileLog.info;
  defaultSweepLog.warn = (fields) => void events.push(String((fields as { event?: unknown }).event));
  defaultReconcileLog.warn = (fields) => void events.push(fields.event);
  defaultReconcileLog.info = (fields) => void events.push(String(fields.event));
  defaultCheckReconcileLog.warn = (fields) => void events.push(fields.event);
  defaultCheckReconcileLog.info = (fields) => void events.push(String(fields.event));
  try {
    await worker.scheduled({ cron } as never, env, {} as never);
  } finally {
    defaultSweepLog.warn = sweepWarn;
    defaultReconcileLog.warn = lifecycleWarn;
    defaultReconcileLog.info = lifecycleInfo;
    defaultCheckReconcileLog.warn = checkWarn;
    defaultCheckReconcileLog.info = checkInfo;
  }
  return events;
}

describe("scheduled composition (spec §7.11)", () => {
  test("the quarter-hour expression composes runSweep → reconcileReviewLifecycle, WITHOUT the Check lane", async () => {
    const db = seededDb();
    const store = db.raw;
    for (let i = 0; i < SWEEP_FAILURE_THRESHOLD + 1; i += 1) {
      store
        .prepare(
          `INSERT INTO review_failures (installation_id, owner, repo, pr_number, head_sha, stage, error, created_at)
           VALUES (1, 'acme', 'widgets', 1, '', 'runner', ?, datetime('now'))`,
        )
        .run(`boom-${i}`);
    }
    const { attempt } = await claim(db);

    const events = await captureComposition({ DB: db as unknown as ScheduledEnv["DB"], REVIEW_QUEUE: NOOP_QUEUE });

    const sweepAt = events.indexOf("ops_sweep_alert");
    const lifecycleAt = events.indexOf("ops_lifecycle_reconcile");
    expect(sweepAt).toBeGreaterThanOrEqual(0);
    expect(lifecycleAt).toBeGreaterThan(sweepAt);
    expect(events).not.toContain("ops_check_reconcile");
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.terminal_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
  });

  test("a throwing sweep and a throwing lifecycle lane never escape the handler", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw.prepare(`DELETE FROM github_app_installations WHERE app_id = ?`).run(APP);
    const broken = {
      prepare(sql: string): never | { bind: () => { all: () => Promise<{ results: never[] }> } } {
        if (sql.includes("review_runtime_settings WHERE key IN")) {
          return { bind: () => ({ all: async () => ({ results: [] }) }) };
        }
        throw new Error("d1 down");
      },
      batch: async () => [],
    } as unknown as TestD1;

    const events = await captureComposition({ DB: broken as unknown as ScheduledEnv["DB"], REVIEW_QUEUE: NOOP_QUEUE });

    expect(events[0]).toBe("retention_swept_failed");
    expect(events).toContain("ops_sweep_failed");
    expect(events).toContain("ops_lifecycle_reconcile_failed");
    expect(events).not.toContain("ops_check_reconcile");

    const events2 = await captureComposition({ DB: db as unknown as ScheduledEnv["DB"], REVIEW_QUEUE: NOOP_QUEUE });
    expect(events2).toContain("ops_lifecycle_reconcile");
    expect(events2).not.toContain("ops_check_reconcile");
  });

  test("routes by controller.cron: the minute expression runs the Checks lane ALONE", async () => {
    const db = seededDb();
    for (let i = 0; i < SWEEP_FAILURE_THRESHOLD + 1; i += 1) {
      db.raw
        .prepare(
          `INSERT INTO review_failures (installation_id, owner, repo, pr_number, head_sha, stage, error, created_at)
           VALUES (1, 'acme', 'widgets', 1, '', 'runner', ?, datetime('now'))`,
        )
        .run(`boom-${i}`);
    }
    const { attempt } = await claim(db);
    db.raw.prepare(`DELETE FROM github_app_installations WHERE app_id = ?`).run(APP);
    const env = { DB: db as unknown as ScheduledEnv["DB"], REVIEW_QUEUE: NOOP_QUEUE };

    const minute = await captureComposition(env, "* * * * *");
    expect(minute).not.toContain("ops_sweep_alert");
    expect(minute).not.toContain("ops_lifecycle_reconcile");
    expect(minute).toContain("ops_check_reconcile");
    expect((await rawRow(db, attempt.identity.attemptId)).recovery_state).toBe("suspended");

    const quarter = await captureComposition(env, "*/15 * * * *");
    expect(quarter).toContain("ops_sweep_alert");
    expect(quarter).toContain("ops_lifecycle_reconcile");
    expect(quarter).not.toContain("ops_check_reconcile");
  });
});


describe("claim repeats the selector's eligibility (L2 fix 1 finding 1)", () => {
  async function withPostSelectionMutation(
    mutate: (db: TestD1, id: string) => void,
  ): Promise<{ summary: CheckReconcileSummary; row: Record<string, string | number | null>; urls: string[] }> {
    const db = seededDb();
    const { attempt } = await claim(db);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: async () => {
          mutate(db, attempt.identity.attemptId);
          return {
            kind: "ok",
            paused: false,
            adapter: {
              adoptCheckRun: async () => {
                creates += 1;
                return { kind: "absent" } as const;
              },
              beginCheck: async ({ identity }) => {
                creates += 1;
                return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
              },
              fetchCheckRun: async ({ identity }) => ({
                kind: "found" as const,
                remote: remoteFor(identity, { status: "completed", conclusion: "failure" }),
              }),
              completeCheck: async ({ identity }) => ({
                kind: "completed" as const,
                remote: remoteFor(identity, { conclusion: "failure" }),
              }),
            },
          };
        },
      });
      expect(creates).toBe(0);
      return { summary, row: await rawRow(db, attempt.identity.attemptId), urls: fetchStub.urls };
    } finally {
      fetchStub.restore();
    }
  }

  test("a backoff that moves into the future after selection blocks the claim", async () => {
    const { summary, row, urls } = await withPostSelectionMutation((db, id) => {
      db.raw.prepare(`UPDATE review_checks SET next_attempt_ms = ? WHERE id = ?`).run(T0 + 60_000, id);
    });
    expect(summary.examined).toBe(1);
    expect(summary.completed).toBe(0);
    expect(summary.unconfirmed).toBe(0);
    expect(urls).toHaveLength(0);
    expect(row.lease_epoch).toBe(1);
    expect(row.lease_until_ms).toBe(EXPIRED_DEADLINE);
    expect(row.attempts).toBe(0);
    expect(row.holder).toBe("consumer-run");
    expect(row.next_attempt_ms).toBe(T0 + 60_000);
  });

  test("reaching the attempt cap after selection blocks the claim", async () => {
    const { summary, row, urls } = await withPostSelectionMutation((db, id) => {
      db.raw.prepare(`UPDATE review_checks SET attempts = ? WHERE id = ?`).run(RECONCILE_DEFAULTS.checkMaxAttempts, id);
    });
    expect(summary.examined).toBe(1);
    expect(summary.gaveUp).toBe(0);
    expect(urls).toHaveLength(0);
    expect(row.attempts).toBe(RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(row.holder).toBe("consumer-run");
    expect(row.terminal_ms).toBeNull();
  });

  test("a row that returns to in_progress inside its execution deadline blocks the claim", async () => {
    const { summary, row, urls } = await withPostSelectionMutation((db, id) => {
      db.raw
        .prepare(`UPDATE review_checks SET desired = 'in_progress', execution_deadline_ms = ? WHERE id = ?`)
        .run(T0 + 900_000, id);
    });
    expect(summary.examined).toBe(1);
    expect(summary.completed).toBe(0);
    expect(urls).toHaveLength(0);
    expect(row.execution_deadline_ms).toBe(T0 + 900_000);
    expect(row.holder).toBe("consumer-run");
    expect(row.attempts).toBe(0);
  });

  test("a lease that goes live after selection blocks the claim", async () => {
    const { summary, row, urls } = await withPostSelectionMutation((db, id) => {
      db.raw
        .prepare(`UPDATE review_checks SET holder = 'other-run', lease_epoch = 9, lease_until_ms = ? WHERE id = ?`)
        .run(T0 + CHECK_RECOVERY_LEASE_MS, id);
    });
    expect(summary.examined).toBe(1);
    expect(urls).toHaveLength(0);
    expect(row.holder).toBe("other-run");
    expect(row.lease_epoch).toBe(9);
    expect(row.attempts).toBe(0);
  });

  test("a suspended row selected earlier is not claimed", async () => {
    const { summary, row, urls } = await withPostSelectionMutation((db, id) => {
      db.raw.prepare(`UPDATE review_checks SET recovery_state = 'suspended' WHERE id = ?`).run(id);
    });
    expect(summary.examined).toBe(1);
    expect(urls).toHaveLength(0);
    expect(row.recovery_state).toBe("suspended");
    expect(row.attempts).toBe(0);
  });
});

describe("suspension is fenced to free rows (L2 fix 1 finding 2)", () => {
  test("a live holder/lease on the same pair survives suspension untouched", async () => {
    const db = seededDb();
    const free = await claim(db, { action: "free" });
    await setCheckDesired(db, free.attempt.identity.attemptId, free.lease, {
      desired: "failure",
      title: CHECK_NAME,
      summary: "unconfirmed",
    }, null, T0);
    await deferCheckRecovery(db, free.attempt.identity.attemptId, free.lease, {
      state: "pending",
      nextAttemptMs: T0,
      reason: "release",
    }, T0);
    const live = await claim(db, { action: "live", triggeredBy: "other", nowMs: T0, executionDeadlineMs: T0 + 900_000 });
    const before = await rawRow(db, live.attempt.identity.attemptId);

    const suspended = await suspendCheckRecovery(
      db,
      { appId: APP, installationId: SCOPE.installationId },
      "app disabled",
      T0,
    );
    expect(suspended).toBe(1);
    expect((await rawRow(db, free.attempt.identity.attemptId)).recovery_state).toBe("suspended");
    const after = await rawRow(db, live.attempt.identity.attemptId);
    expect(after.holder).toBe(before.holder);
    expect(after.lease_epoch).toBe(before.lease_epoch);
    expect(after.lease_until_ms).toBe(before.lease_until_ms);
    expect(after.updated_ms).toBe(before.updated_ms);
    expect(after.recovery_state).toBe("pending");
    expect(
      await setCheckCreateState(db, live.attempt.identity.attemptId, live.lease, "unknown", "still down", T0),
    ).toBe(true);
  });

  test("an EXPIRED holder's row is suspendable (fire-and-forget leftover lease)", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    await setCheckDesired(db, attempt.identity.attemptId, lease, {
      desired: "failure",
      title: CHECK_NAME,
      summary: "unconfirmed",
    }, null, CLAIM_AT);
    const suspended = await suspendCheckRecovery(
      db,
      { appId: APP, installationId: SCOPE.installationId },
      "app disabled",
      T0,
    );
    expect(suspended).toBe(1);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.recovery_state).toBe("suspended");
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
  });
});

describe("pause / kill switch (L2 fix 1 finding 3)", () => {
  test("a paused App TERMINALIZES an already-known Check (read-only adoption then update)", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw.prepare(`UPDATE review_checks SET create_state = 'sending' WHERE id = ?`).run(attempt.identity.attemptId);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { id: 909, status: "in_progress", conclusion: null }),
          }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { id: 909, status: "in_progress", conclusion: null }),
          }),
          complete: async (identity, _id, conclusion) => ({ kind: "completed", remote: remoteFor(identity, { id: 909, conclusion: "failure", summary: conclusion.summary }) }),
        }, undefined, SCOPE, true),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.observed).toBe("failure");
    expect(row.recovery_state).toBe("done");
  });

  test("a paused App's never-sent row with a complete absent walk issues NO create and leaves the due batch", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
        }, undefined, SCOPE, true),
      });
      expect(summary.completed).toBe(0);
      expect(summary.gaveUp).toBe(0);
      expect(summary.unconfirmed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.recovery_state).toBe("suspended");
    expect(row.create_state).toBe("not-sent");
    expect(row.check_run_id).toBeNull();
    expect(row.terminal_ms).toBeNull();
    expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(0);
  });

  test("an UNPAUSED App with the same shape still creates exactly once", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, {
              status: "completed",
              conclusion: "failure",
              summary: frozenSummaryOf(db, identity.attemptId),
            }),
          }),
        }, undefined, SCOPE, false),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(1);
    expect((await rawRow(db, attempt.identity.attemptId)).observed).toBe("failure");
  });
});

describe("budget refusal releases the claim (L2 fix 1 finding 4)", () => {
  test("an exhausted RUN budget leaves later rows unclaimed and completely untouched", async () => {
    const db = seededDb();
    const rows: { id: string; before: Record<string, string | number | null> }[] = [];
    for (let i = 0; i < 20; i += 1) {
      const { attempt, lease } = await claim(db, {
        scope: { ...SCOPE, installationId: 1000 + i },
        action: `row-${i}`,
      });
      await setCheckDesired(db, attempt.identity.attemptId, lease, {
        desired: "failure",
        title: CHECK_NAME,
        summary: "unconfirmed",
      }, null, CLAIM_AT);
      await deferCheckRecovery(
        db,
        attempt.identity.attemptId,
        lease,
        { state: "pending", nextAttemptMs: CLAIM_AT, reason: "release" },
        CLAIM_AT,
      );
      db.raw.prepare(`UPDATE review_checks SET created_ms = ? WHERE id = ?`).run(CLAIM_AT + i, attempt.identity.attemptId);
      rows.push({ id: attempt.identity.attemptId, before: await rawRow(db, attempt.identity.attemptId) });
    }

    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: async ({ transport }) => {
          for (let i = 0; i < 5; i += 1) {
            try {
              await transport.fetchImpl("https://api.github.com/probe");
            } catch {
              return { kind: "unavailable", reason: "missing" };
            }
          }
          return {
            kind: "ok",
            paused: false,
            adapter: scriptedAdapter(db, {
              adopt: async () => ({ kind: "absent" }),
              begin: async (identity) => {
                creates += 1;
                return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
              },
            }, transport),
          };
        },
      });
      expect(summary.examined).toBe(20);
      expect(summary.completed).toBe(0);
      expect(summary.gaveUp).toBe(0);
    } finally {
      fetchStub.restore();
    }

    expect(fetchStub.urls.length).toBe(RECONCILE_DEFAULTS.checkMaxRequests);
    expect(creates).toBe(0);

    for (const row of rows) {
      const after = await rawRow(db, row.id);
      expect(after.holder).toBeNull();
      expect(after.lease_until_ms).toBeNull();
      expect(after.terminal_ms).toBeNull();
      expect(after.attempts).toBe(row.before.attempts);
      expect(after.recovery_state).toBe("pending");
    }

    const unreached: string[] = [];
    for (const row of rows) {
      if (JSON.stringify(await rawRow(db, row.id)) === JSON.stringify(row.before)) unreached.push(row.id);
    }
    expect(unreached.length).toBeGreaterThan(0);
  });

  test("a per-row refusal mid-operation releases the claim without spending an attempt", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          requestsPerCall: 5,
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
        }),
      });
      expect(summary.unconfirmed).toBe(0);
      expect(summary.gaveUp).toBe(0);
      expect(summary.errors).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.recovery_state).toBe("pending");
    expect(row.desired).not.toBe("in_progress");
    expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
    const reclaim = await claimCheckRecovery(db, attempt.identity.attemptId, "reconciler", T0, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(reclaim, "the released row must be immediately reclaimable").not.toBeNull();
  });

  test("a refusal inside ADOPTION releases the claim too", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          requestsPerCall: RECONCILE_DEFAULTS.checkRowMaxRequests + 1,
          adopt: async () => ({ kind: "absent" }),
        }),
      });
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.recovery_state).toBe("pending");
    expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
  });

  test("a refusal inside the owned-run FETCH releases the claim too", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 321 WHERE id = ?`)
      .run(attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          requestsPerCall: RECONCILE_DEFAULTS.checkRowMaxRequests + 1,
          fetch: async () => ({ kind: "unavailable", reason: "should not be reached" }),
        }),
      });
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.recovery_state).toBe("pending");
    expect(row.check_run_id).toBe(321);
    expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
  });

  test("a refusal inside the terminal UPDATE releases the claim too", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 321 WHERE id = ?`)
      .run(attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          requestsPerCall: RECONCILE_DEFAULTS.checkRowMaxRequests,
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { id: 321, status: "in_progress", conclusion: null }),
          }),
        }),
      });
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.recovery_state).toBe("pending");
    expect(row.observed).toBe("unknown");
    expect(row.check_run_id).toBe(321);
    expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
  });
});

describe("zero-dispatch create refusal is left due (integrated seam fix 2)", () => {
  test("sending → live fence refuses → requests: 0 → rollback, released, no attempt, immediately due", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async () => {
            creates += 1;
            return { kind: "unavailable", reason: "lease expired before the create request", requests: 0 };
          },
        }),
      });
      expect(summary.completed).toBe(0);
      expect(summary.gaveUp).toBe(0);
      expect(summary.unconfirmed).toBe(0);
      expect(summary.errors).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.create_state).toBe("not-sent");
    expect(row.check_run_id).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.terminal_ms).toBeNull();
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
    expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
    expect(await claimCheckRecovery(db, id, "reconciler", T0, RECONCILE_DEFAULTS.checkMaxAttempts)).not.toBeNull();
    void creates;
  });

  test("a zero-dispatch refusal still releases when the clock passes T3's own recovery lease", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    let clock = T0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => clock,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async () => {
            clock = T0 + CHECK_RECOVERY_LEASE_MS + 1;
            return { kind: "unavailable", reason: "lease expired before the create request", requests: 0 };
          },
        }),
      });
      expect(summary.completed).toBe(0);
      expect(summary.gaveUp).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.create_state).toBe("not-sent");
    expect(row.check_run_id).toBeNull();
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.last_error).toBeNull();
    expect(await listCheckReconcileBatch(db, clock, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
    expect(await claimCheckRecovery(db, id, "reconciler", clock, RECONCILE_DEFAULTS.checkMaxAttempts)).not.toBeNull();
  });

  test("requests > 0 stays possibly-sent: a spent attempt with backoff, no rollback", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async () => ({ kind: "unavailable", reason: "check create failed: socket hang up", requests: 1 }),
        }),
      });
      expect(summary.unconfirmed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.create_state).toBe("sending");
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[0]!);
  });

  test("an older adapter that cannot report requests stays conservative", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async () => ({ kind: "unavailable", reason: "no create scripted" }),
        }),
      });
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.create_state).toBe("sending");
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.attempts).toBe(1);
  });

  test("a stale-epoch rollback race leaves a newer holder's row untouched", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(await setCheckCreateState(db, id, lease, "sending", undefined, CLAIM_AT)).toBe(true);
    db.raw
      .prepare(`UPDATE review_checks SET holder = 'other-run', lease_epoch = ?, lease_until_ms = ? WHERE id = ?`)
      .run(lease.epoch + 1, T0 + CHECK_RECOVERY_LEASE_MS, id);

    expect(await rollbackCheckCreateDispatch(db, id, lease, CLAIM_AT)).toBe(false);
    const row = await rawRow(db, id);
    expect(row.holder).toBe("other-run");
    expect(row.lease_epoch).toBe(lease.epoch + 1);
    expect(row.create_state).toBe("sending");
    expect(row.attempts).toBe(0);
  });
});

describe("zero-dispatch fetch/complete refusals stay due (no attempt spent)", () => {
  test("a client-resolution failure on the terminal UPDATE keeps the row due instead of giving up", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 321 WHERE id = ?`)
      .run(id);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { id: 321, status: "in_progress", conclusion: null }),
          }),
          complete: async () => ({
            kind: "unavailable",
            reason: "no review-write Checks client for this App: token mint failed",
            requests: 0,
          }),
        }),
      });
      expect(summary.gaveUp).toBe(0);
      expect(summary.unconfirmed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.terminal_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
    expect(row.desired).toBe("failure");
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
  });

  test("a zero-dispatch read refusal releases the claim without spending an attempt", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 321 WHERE id = ?`)
      .run(id);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          fetch: async () => ({
            kind: "unavailable",
            reason: "no review-write Checks client for this App: token mint failed",
            requests: 0,
          }),
        }),
      });
      expect(summary.gaveUp).toBe(0);
      expect(summary.unconfirmed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.terminal_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
    expect(row.holder).toBeNull();
    expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
  });
});

describe("operator retry accepts a recorded in-progress observation (L2 fix 1 finding 5)", () => {
  test("an in_progress observation survives give-up and is reopened by retry with its identity intact", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 321, observed = 'in_progress', recovery_state = 'local-error', terminal_ms = ?, attempts = ? WHERE id = ?`)
      .run(T0, RECONCILE_DEFAULTS.checkMaxAttempts, id);

    const reacquired = await claimCheckRecovery(db, id, "reconciler", T0 - 1, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(reacquired).toBeNull();

    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: T0 })).toBe(true);
    const row = await rawRow(db, id);
    expect(row.recovery_state).toBe("pending");
    expect(row.terminal_ms).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.check_run_id).toBe(321);
    expect(row.external_id).toBe(attempt.identity.externalId);
    expect(row.generation).toBe(attempt.identity.generation);
    expect(row.observed).toBe("in_progress");
    expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
  });

  test("a TERMINAL observation is still refused (settled evidence is not reopened)", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    db.raw
      .prepare(`UPDATE review_checks SET observed = 'success', recovery_state = 'done', terminal_ms = ? WHERE id = ?`)
      .run(T0, id);
    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: T0 + 1 })).toBe(false);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).toBe(T0);
    expect(row.recovery_state).toBe("done");
  });
});


describe("credential suspension is durable, not churn (P68-QC-003)", () => {
  async function seedSuspended(
    db: TestD1,
    kind: Parameters<typeof checkSuspensionReason>[0],
    fingerprint: string,
    appId = APP,
  ): Promise<string> {
    const { attempt } = await claim(db, { scope: { ...SCOPE, appId }, action: `attempt-${kind}-${appId}` });
    db.raw
      .prepare(
        `UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, recovery_state = 'suspended', attempts = 0, last_error = ? WHERE id = ?`,
      )
      .run(checkSuspensionReason(kind, "suspended", fingerprint), attempt.identity.attemptId);
    return attempt.identity.attemptId;
  }

  test("a suspension WRITES the kind and the envelope digest the verdict was proven against", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    const envelope = db.raw.prepare(`SELECT private_key_enc FROM github_apps WHERE id = ?`).get(APP) as {
      private_key_enc: string;
    };
    const DIGEST = await sha256Hex(envelope.private_key_enc);
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: async () => ({ kind: "unavailable", reason: "identity-mismatch", credentialFingerprint: DIGEST }),
      });
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.recovery_state).toBe("suspended");
    expect(checkSuspensionKindOf(row.last_error as string)).toBe("identity-mismatch");
    expect(row.last_error).toContain(`cred=${DIGEST}`);
    let probes = 0;
    const second = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0 + 15 * 60_000,
        credentials: async () => {
          probes += 1;
          return { kind: "unavailable", reason: "identity-mismatch", credentialFingerprint: DIGEST };
        },
      });
      expect(summary.examined).toBe(0);
      expect(summary.suspended).toBe(0);
    } finally {
      second.restore();
    }
    expect(probes).toBe(0);
  });

  test("an UNCHANGED credential failure is never re-probed and never re-enters the batch", async () => {
    const db = seededDb();
    const envelope = db.raw.prepare(`SELECT private_key_enc FROM github_apps WHERE id = ?`).get(APP) as {
      private_key_enc: string;
    };
    const digest = await sha256Hex(envelope.private_key_enc);
    const id = await seedSuspended(db, "identity-mismatch", digest);

    let probes = 0;
    const fetchStub = stubFetch();
    try {
      for (const at of [T0, T0 + 15 * 60_000]) {
        const summary = await run(db, {
          now: () => at,
          credentials: async () => {
            probes += 1;
            return { kind: "unavailable", reason: "identity-mismatch", credentialFingerprint: digest };
          },
        });
        expect(summary.examined).toBe(0);
        expect(summary.suspended).toBe(0);
      }
    } finally {
      fetchStub.restore();
    }
    expect(probes).toBe(0);
    expect(fetchStub.urls).toHaveLength(0);
    const row = await rawRow(db, id);
    expect(row.recovery_state).toBe("suspended");
    expect(row.attempts).toBe(0);
    expect(await listCheckReconcileBatch(db, T0 + 15 * 60_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(0);
  });

  test("an operator-corrected envelope reopens the pair and resumes the SAME attempt identity", async () => {
    const db = seededDb();
    const envelope = db.raw.prepare(`SELECT private_key_enc FROM github_apps WHERE id = ?`).get(APP) as {
      private_key_enc: string;
    };
    const oldDigest = await sha256Hex(envelope.private_key_enc);
    const id = await seedSuspended(db, "identity-mismatch", oldDigest);
    db.raw.prepare(`UPDATE github_apps SET private_key_enc = 'enc-pem-rotated' WHERE id = ?`).run(APP);

    let probes = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: async (input) => {
          probes += 1;
          return scriptedCredentials(db, agreeingScript(db))(input);
        },
      });
      expect(probes).toBeGreaterThanOrEqual(1);
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.observed).toBe("failure");
    expect(row.generation).toBe(1);
    expect(row.external_id).toBe((await rawRow(db, id)).external_id);
  });

  async function seedSuspendedBacklog(db: TestD1, unchanged: number) {
    const suspend = async (appId: string, githubAppId: number, installationId: number) => {
      seedApp(db, appId, githubAppId, { installationId });
      const { attempt } = await claim(db, {
        scope: { ...SCOPE, appId, installationId },
        githubAppId,
        action: `stuck-${installationId}`,
      });
      db.raw
        .prepare(
          `UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, recovery_state = 'suspended', attempts = 0, last_error = ? WHERE id = ?`,
        )
        .run(
          checkSuspensionReason("identity-mismatch", "suspended", await sha256Hex("enc-pem")),
          attempt.identity.attemptId,
        );
      return attempt.identity.attemptId;
    };
    const stuckIds: string[] = [];
    for (let index = 0; index < unchanged; index += 1) {
      const appId = `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
      stuckIds.push(await suspend(appId, 5_000 + index, 200 + index));
    }
    const repairedScope = { ...SCOPE, appId: "ffffffff-ffff-ffff-ffff-ffffffffffff", installationId: 9_999 };
    const repairedId = await suspend(repairedScope.appId, 9_999, repairedScope.installationId);
    db.raw.prepare(`UPDATE github_apps SET private_key_enc = 'enc-pem-rotated' WHERE id = ?`).run(repairedScope.appId);
    return { stuckIds, repairedId, repairedScope };
  }

  async function passUntilResumed(db: TestD1, repairedId: string, repairedScope: Scope, maxPasses: number) {
    const probed: string[] = [];
    const fetchStub = stubFetch();
    let passes = 0;
    try {
      while (passes < maxPasses && (await rawRow(db, repairedId)).recovery_state === "suspended") {
        passes += 1;
        await run(db, {
          now: () => T0,
          credentials: async (input) => {
            probed.push(input.scope.appId);
            return scriptedCredentials(db, agreeingScript(db), undefined, repairedScope)(input);
          },
        });
      }
    } finally {
      fetchStub.restore();
    }
    return { passes, probed };
  }

  test("unchanged pairs filling a whole scan page never starve a repaired pair that sorts after them", async () => {
    const db = seededDb();
    const { stuckIds, repairedId, repairedScope } = await seedSuspendedBacklog(db, RECONCILE_DEFAULTS.checkSelectLimit);

    const { passes, probed } = await passUntilResumed(db, repairedId, repairedScope, 3);

    expect(passes).toBe(2);
    expect(new Set(probed)).toEqual(new Set([repairedScope.appId]));
    expect((await rawRow(db, repairedId)).recovery_state).toBe("done");
    for (const id of stuckIds) {
      expect((await rawRow(db, id)).recovery_state).toBe("suspended");
    }
  });

  test("the re-enable scan rotates through a backlog of several pages and wraps back to the start", async () => {
    const db = seededDb();
    const backlog = RECONCILE_DEFAULTS.checkSelectLimit * 3;
    const { stuckIds, repairedId, repairedScope } = await seedSuspendedBacklog(db, backlog);

    const { passes } = await passUntilResumed(db, repairedId, repairedScope, 10);

    expect(passes).toBe(Math.ceil((backlog + 1) / RECONCILE_DEFAULTS.checkSelectLimit));
    expect((await rawRow(db, repairedId)).recovery_state).toBe("done");
    const wrappedPairs = passes * RECONCILE_DEFAULTS.checkSelectLimit - (backlog + 1);
    const cursor = db.raw.prepare(`SELECT installation_id FROM check_reenable_cursor`).get() as { installation_id: number };
    expect(cursor.installation_id).toBe(200 + wrappedPairs - 1);
    for (const id of stuckIds) {
      expect((await rawRow(db, id)).recovery_state).toBe("suspended");
    }
  });

  test("a KEPT-failing corrected envelope re-stamps with the new digest instead of churning", async () => {
    const db = seededDb();
    const envelope = db.raw.prepare(`SELECT private_key_enc FROM github_apps WHERE id = ?`).get(APP) as {
      private_key_enc: string;
    };
    const oldDigest = await sha256Hex(envelope.private_key_enc);
    const id = await seedSuspended(db, "identity-mismatch", oldDigest);
    db.raw.prepare(`UPDATE github_apps SET private_key_enc = 'enc-pem-rotated' WHERE id = ?`).run(APP);
    const newDigest = await sha256Hex("enc-pem-rotated");

    let probes = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: async () => {
          probes += 1;
          return { kind: "unavailable", reason: "identity-mismatch", credentialFingerprint: newDigest };
        },
      });
      expect(probes).toBe(1);
      expect(summary.examined).toBe(0);
      const second = await run(db, {
        now: () => T0 + 15 * 60_000,
        credentials: async () => {
          probes += 1;
          return { kind: "unavailable", reason: "identity-mismatch", credentialFingerprint: newDigest };
        },
      });
      expect(second.examined).toBe(0);
      expect(probes).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.recovery_state).toBe("suspended");
    expect(checkSuspensionKindOf(row.last_error as string)).toBe("identity-mismatch");
    expect(row.last_error).toContain(newDigest);
  });

  test("a DISABLED suspension still resumes on App status alone, with no probe", async () => {
    const db = seededDb();
    const id = await seedSuspended(db, "disabled", "a".repeat(64));
    let probes = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: async (input) => {
          probes += 1;
          return scriptedCredentials(db, agreeingScript(db))(input);
        },
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(probes).toBe(1);
    expect((await rawRow(db, id)).observed).toBe("failure");
  });
});

describe("paused work leaves the due batch and resumes without attempt spend (P68-QC-006)", () => {
  test("a paused never-sent row is deferred once, costs nothing per pass, and resumes with the same identity", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    const externalId = attempt.identity.externalId;
    db.raw.prepare(`UPDATE github_apps SET review_enabled = 0 WHERE id = ?`).run(APP);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
        }, undefined, SCOPE, true),
      });
      expect(summary.suspended).toBe(1);
      const row = await rawRow(db, id);
      expect(row.recovery_state).toBe("suspended");
      expect(row.attempts).toBe(0);
      expect(checkSuspensionKindOf(row.last_error as string)).toBe("paused");
      expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(0);

      let probes = 0;
      const second = await run(db, {
        now: () => T0 + 15 * 60_000,
        credentials: async () => {
          probes += 1;
          return { kind: "unavailable", reason: "missing" };
        },
      });
      expect(second.examined).toBe(0);
      expect(probes).toBe(0);
      expect(creates).toBe(0);

      db.raw.prepare(`UPDATE github_apps SET review_enabled = 1 WHERE id = ?`).run(APP);
      const resumed = await run(db, {
        now: () => T0 + 30 * 60_000,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, {
              status: "completed",
              conclusion: "failure",
              summary: frozenSummaryOf(db, identity.attemptId),
            }),
          }),
        }),
      });
      expect(resumed.completed).toBe(1);
      expect(creates).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.external_id).toBe(externalId);
    expect(row.generation).toBe(1);
    expect(row.attempts).toBe(0);
    expect(row.observed).toBe("failure");
  });

  test("a paused App STILL adopt-and-terminalizes an already-known run", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw.prepare(`UPDATE review_checks SET create_state = 'sending' WHERE id = ?`).run(attempt.identity.attemptId);
    db.raw.prepare(`UPDATE github_apps SET review_enabled = 0 WHERE id = ?`).run(APP);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { id: 909, status: "in_progress", conclusion: null }),
          }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { id: 909, status: "in_progress", conclusion: null }),
          }),
          complete: async (identity, _id, conclusion) => ({
            kind: "completed",
            remote: remoteFor(identity, { id: 909, conclusion: "failure", summary: conclusion.summary }),
          }),
        }, undefined, SCOPE, true),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.observed).toBe("failure");
    expect(row.recovery_state).toBe("done");
  });
});

describe("pre-dispatch refusal is typed end to end (P68-QC-005)", () => {
  test("the lane's own transport throws the SHARED marker, which the adapter classifies as zero-dispatch", async () => {
    const db = seededDb();
    await claim(db);
    let transport: CheckTransport | undefined;
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: async ({ transport: t }) => {
          transport = t;
          return { kind: "unavailable", reason: "missing" };
        },
      });
      expect(transport).toBeDefined();
      for (let i = 0; i < RECONCILE_DEFAULTS.checkMaxRequests; i += 1) {
        await transport!.fetchImpl("https://api.github.com/probe");
      }
      const err = await transport!.fetchImpl("https://api.github.com/checks").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CheckRequestNotDispatched);
      expect(isRequestNotDispatched(err)).toBe(true);
    } finally {
      fetchStub.restore();
    }
  });

  test("a possibly-sent create failure stays conservatively adopt-only (requests > 0)", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async () => ({ kind: "unavailable", reason: "check create failed: socket hang up", requests: 1 }),
        }),
      });
      expect(summary.unconfirmed).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.create_state).toBe("sending");
    expect(row.check_run_id).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[0]!);
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.terminal_ms).toBeNull();
  });
});


describe("the re-enable probe is admission-gated and never invents a verdict (F-004)", () => {
  async function correctedPair(db: TestD1): Promise<{ id: string; before: Record<string, string | number | null> }> {
    const { attempt, lease } = await claim(db, { action: "corrected" });
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, { desired: "failure", title: CHECK_NAME, summary: "unconfirmed" }, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);
    expect(
      await suspendCheckRecovery(db, { appId: APP, installationId: SCOPE.installationId },
        checkSuspensionReason("identity-mismatch", "mismatch", "a".repeat(64)), T0),
    ).toBe(1);
    return { id, before: await rawRow(db, id) };
  }

  test("an unaffordable probe is skipped: zero factory calls, zero writes, prior state intact", async () => {
    const db = seededDb();
    const { id, before } = await correctedPair(db);
    const DISTRACTOR = 100;
    db.raw
      .prepare(
        `INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at)
         VALUES ('inst-distractor', ?, ?, 'acme', datetime('now'))`,
      )
      .run(APP, DISTRACTOR);
    await claim(db, { scope: { ...SCOPE, installationId: DISTRACTOR } });
    expect(
      await suspendCheckRecovery(
        db,
        { appId: APP, installationId: DISTRACTOR },
        checkSuspensionReason("identity-mismatch", "mismatch", "a".repeat(64)),
        T0,
      ),
    ).toBe(1);

    let factoryCalls = 0;
    const warned: { event: string; detail: string }[] = [];
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        log: { warn: (fields) => void warned.push(fields), info: () => {} },
        credentials: async ({ scope, transport }) => {
          if (scope.installationId === DISTRACTOR) {
            for (let i = 0; i < RECONCILE_DEFAULTS.checkMaxRequests + 5; i += 1) {
              try {
                await transport.fetchImpl(`https://api.github.com/burn/${i}`);
              } catch {
                break;
              }
            }
            return { kind: "unavailable", reason: "identity-mismatch" };
          }
          factoryCalls += 1;
          return { kind: "unavailable", reason: "identity-mismatch", credentialFingerprint: "b".repeat(64) };
        },
      });
      expect(summary.errors).toBe(0);
      expect(summary.examined).toBe(0);
      expect(
        warned
          .filter((entry) => entry.event === "ops_check_reconcile_reenable_probe_deferred")
          .map((entry) => entry.detail),
      ).toContain(`pair=(${APP}, ${SCOPE.installationId})`);
    } finally {
      fetchStub.restore();
    }
    expect(factoryCalls).toBe(0);
    expect(await rawRow(db, id)).toEqual(before);
  });

  test("a probe refused before dispatch writes NO verdict and remains eligible next pass", async () => {
    const db = seededDb();
    const { id, before } = await correctedPair(db);
    const warned: { event: string }[] = [];
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        log: { warn: (fields) => void warned.push(fields), info: () => {} },
        credentials: async ({ scope, transport }) => {
          if (scope.appId !== APP) return { kind: "unavailable", reason: "missing" };
          throw new CheckRequestNotDispatched("test: probe refused before dispatch");
        },
      });
      expect(summary.errors).toBe(0);
      expect(warned.map((entry) => entry.event)).toContain("ops_check_reconcile_reenable_probe_deferred");
    } finally {
      fetchStub.restore();
    }
    const after = await rawRow(db, id);
    expect(after).toEqual(before);
    expect(after.recovery_state).toBe("suspended");
    expect(after.last_error).toBe(before.last_error);
    expect(warned.some((entry) => entry.event === "ops_check_reconcile_reenable_probe_deferred")).toBe(true);
    expect(
      await listReenableableCheckPairs(db, [
        { appId: APP, installationId: SCOPE.installationId, currentFingerprint: "b".repeat(64) },
      ]),
    ).toEqual([{ appId: APP, installationId: SCOPE.installationId }]);
  });

  test("a factory that RETURNS unavailable after a refused request is a deferral too", async () => {
    const db = seededDb();
    const { id, before } = await correctedPair(db);
    const warned: { event: string }[] = [];
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        log: { warn: (fields) => void warned.push(fields), info: () => {} },
        credentials: async ({ scope, transport }) => {
          if (scope.appId !== APP) return { kind: "unavailable", reason: "missing" };
          try {
            for (let i = 0; i <= RECONCILE_DEFAULTS.checkMaxRequests; i += 1) {
              await transport.fetchImpl("https://api.github.com/probe");
            }
          } catch {
            return { kind: "unavailable", reason: "identity-mismatch", credentialFingerprint: "b".repeat(64) };
          }
          return { kind: "unavailable", reason: "identity-mismatch", credentialFingerprint: "b".repeat(64) };
        },
      });
    } finally {
      fetchStub.restore();
    }
    expect(await rawRow(db, id)).toEqual(before);
    expect(warned.some((entry) => entry.event === "ops_check_reconcile_reenable_probe_deferred")).toBe(true);
  });

  test("a genuine (non-refusal) probe failure DOES re-stamp, so the next pass is D1-only", async () => {
    const db = seededDb();
    const { id, before } = await correctedPair(db);
    const NEW = "d".repeat(64);
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: async ({ scope }) => {
          if (scope.appId !== APP) return { kind: "unavailable", reason: "missing" };
          return { kind: "unavailable", reason: "identity-mismatch", credentialFingerprint: NEW };
        },
      });
    } finally {
      fetchStub.restore();
    }
    const after = await rawRow(db, id);
    expect(after.last_error).not.toBe(before.last_error);
    expect(checkSuspensionKindOf(after.last_error as string)).toBe("identity-mismatch");
    expect(after.last_error).toContain(NEW);
  });

  test("a successful probe resumes the pair (the operator path still works)", async () => {
    const db = seededDb();
    const { id } = await correctedPair(db);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: async ({ scope, transport }) => {
          if (scope.appId !== APP) return { kind: "unavailable", reason: "missing" };
          return { kind: "ok", paused: false, adapter: scriptedAdapter(db, agreeingScript(db), transport) };
        },
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.recovery_state).toBe("done");
    expect(row.observed).toBe("failure");
  });
});

describe("configured Check update budget (spec §7.10)", () => {
  function capturingCredentials(db: TestD1, seen: Array<number | undefined>): CheckCredentialFactory {
    return async (input) => {
      seen.push(input.updateBudgetMs);
      return input.scope.appId === SCOPE.appId
        ? { kind: "ok", paused: false, adapter: scriptedAdapter(db, agreeingScript(db), input.transport) }
        : { kind: "unavailable", reason: "missing" };
    };
  }

  test("the operator-configured value reaches the credential lane", async () => {
    const db = seededDb();
    db.raw
      .prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?1, ?2, ?3)")
      .run("review.check.update_timeout_ms", "700", new Date().toISOString());
    await claim(db);
    const seen: Array<number | undefined> = [];
    await run(db, { now: () => T0, credentials: capturingCredentials(db, seen) });
    expect(seen).toEqual([700]);
  });

  test("an absent row answers the documented default", async () => {
    const db = seededDb();
    await claim(db);
    const seen: Array<number | undefined> = [];
    await run(db, { now: () => T0, credentials: capturingCredentials(db, seen) });
    expect(seen).toEqual([CHECK_UPDATE_DEFAULT]);
  });

  test("a degraded read uses the defaults and logs exactly one warn", async () => {
    const db = seededDb();
    db.raw
      .prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?1, ?2, ?3)")
      .run("review.check.update_timeout_ms", "not-a-number", new Date().toISOString());
    await claim(db);
    const seen: Array<number | undefined> = [];
    const warns: string[] = [];
    const credentials = capturingCredentials(db, seen);
    const summary = await run(db, {
      now: () => T0,
      credentials,
      log: {
        warn: (fields) => { warns.push(fields.event); },
        info: () => {},
      },
    });
    expect(seen).toEqual([CHECK_UPDATE_DEFAULT]);
    expect(warns.filter((event) => event === "ops_check_reconcile_budgets_degraded")).toHaveLength(1);
    expect(summary.errors).toBe(0);
  });
});


const FUTURE_DEADLINE = T0 + 900_000;

async function abandonedAttempt(db: TestD1, deadlineMs: number = FUTURE_DEADLINE): Promise<{ attempt: CheckAttempt; id: string }> {
  const transport: CheckTransport = {
    boundMs: () => RECONCILE_DEFAULTS.checkPerRequestMs,
    fetchImpl: (input, init) => fetch(input, init),
  };
  const lifecycle = createCheckLifecycle({
    db,
    nowMs: () => T0,
    getAdapter: () =>
      scriptedAdapter(
        db,
        {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({
            kind: "ready",
            remote: remoteFor(identity, { status: "in_progress", conclusion: null }),
          }),
        },
        transport,
      ),
    getCheckGate: async () => null,
  });
  const latch = createCheckBeginLatch();
  latch.abandon();

  const handle = await lifecycle.begin({
    scope: SCOPE,
    githubAppId: NUMERIC_APP,
    headSha: SHA,
    triggeredBy: "octocat",
    action: "review",
    executionDeadlineMs: deadlineMs,
    latch,
  });
  expect(handle).toBeNull();

  const row = (await db.prepare(`SELECT * FROM review_checks WHERE head_sha = ?`).bind(SHA).first()) as
    | { id: string }
    | null;
  const id = row?.id;
  if (id === undefined || id === null) throw new Error("the abandoned begin left no attempt row");
  const attempt = await getCheckAttempt(db, id);
  if (attempt === null) throw new Error("the abandoned begin left no readable attempt");

  expect(attempt.desired).toBe("in_progress");
  expect(attempt.createState).toBe("known");
  expect(attempt.recoveryState).toBe("remote-unconfirmed");
  return { attempt, id };
}

function publishingScript(sent: { desired?: string; summary?: string }): AdapterScript {
  return {
    adopt: async () => ({ kind: "absent" }),
    begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
    fetch: async (identity, checkRunId) => ({
      kind: "found",
      remote: remoteFor(identity, { id: checkRunId, status: "in_progress", conclusion: null }),
    }),
    complete: async (identity, _runId, conclusion) => {
      sent.desired = conclusion.desired;
      sent.summary = conclusion.summary;
      return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) };
    },
  };
}

function recordFailure(db: TestD1, stage: string, error: string, createdAtMs: number = Date.now()): void {
  db.raw
    .prepare(
      `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      SCOPE.installationId,
      SCOPE.owner,
      SCOPE.repo,
      SCOPE.prNumber,
      SHA,
      stage,
      error,
      new Date(createdAtMs).toISOString().slice(0, 19).replace("T", " "),
    );
}

describe("the publication-proof wait decides when abandonment may conclude (spec §7.9)", () => {
  test("no proof and a future deadline: the pass claims, gives the claim back and spends no attempt", async () => {
    const db = seededDb();
    const { id } = await abandonedAttempt(db);
    expect(await listCheckReconcileBatch(db, T0 + 120_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
    const stub = stubFetch();
    let factoryCalls = 0;
    const events: Array<Record<string, unknown>> = [];
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        log: { warn: () => {}, info: (fields) => void events.push(fields) },
        credentials: async (input) => {
          factoryCalls += 1;
          return scriptedCredentials(db)(input);
        },
      });
      expect(summary.examined).toBe(1);
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
      expect(summary.unconfirmed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const row = await rawRow(db, id);
    expect(row.terminal_ms).toBeNull();
    expect(row.execution_deadline_ms).toBe(FUTURE_DEADLINE);
    expect(row.attempts).toBe(1);
    expect(row.desired).toBe("in_progress");
    expect(row.desired_title).toBeNull();
    expect(row.desired_summary).toBeNull();
    expect(row.observed).toBe("unknown");
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.next_attempt_ms).toBe(T0 + 120_000 + CHECK_BACKOFF_MS[0]!);

    const deferred = events.filter((fields) => fields.event === "check_recovery_deferred_pending_publication");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.probe_state).toBe("none");
  });

  test("a deadline inside the deferred rung selects the row on the pass after it, not only after next_attempt_ms", async () => {
    const db = seededDb();
    const deadline = T0 + 150_000;
    const deferredAt = T0 + 120_000;
    expect(deadline).toBeLessThan(deferredAt + CHECK_BACKOFF_MS[0]!);
    const { id } = await abandonedAttempt(db, deadline);
    const stub = stubFetch();
    try {
      const waiting = await run(db, {
        now: () => deferredAt,
        credentials: scriptedCredentials(db),
      });
      expect(waiting.deferred).toBe(1);
      expect((await rawRow(db, id)).next_attempt_ms).toBe(deadline);

      expect(await listCheckReconcileBatch(db, deadline + 1_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
      const summary = await run(db, {
        now: () => deadline + 1_000,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => ({ kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }) }),
        }),
      });
      expect(summary.examined).toBe(1);
      expect(summary.completed).toBe(1);
    } finally {
      stub.restore();
    }
    expect((await rawRow(db, id)).terminal_ms).not.toBeNull();
  });

  test("a proof linked to THIS attempt ends the wait before the deadline and decides", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedAttempt(db);
    const proof = proofFor(attempt.identity);
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85));
    linkPublication(db, id, proof.publicationId);

    const stub = stubFetch();
    const sent: { desired?: string; summary?: string } = {};
    let deferred = -1;
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      deferred = summary.deferred;
      expect(summary.completed).toBe(1);
    } finally {
      stub.restore();
    }

    expect(deferred).toBe(0);
    expect(sent.desired).toBe("success");
    expect(sent.summary).toContain(`Review gate met for ${SHA.slice(0, 7)}`);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("an applied payload that fails the gate decides, not a passing live score", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedAttempt(db);
    seedReview(db, SCOPE, SHA, "ship it", 95);
    db.raw.prepare(`UPDATE reviews SET app_id = ? WHERE head_sha = ?`).run(SCOPE.appId, SHA);
    const proof = proofFor(attempt.identity);
    seedPublication(db, SCOPE, SHA, proof, "applied", reviewPayload(SCOPE, SHA, "needs fixes", 40));
    linkPublication(db, id, proof.publicationId);

    const stub = stubFetch();
    const sent: { desired?: string; summary?: string } = {};
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      expect(summary.completed).toBe(1);
    } finally {
      stub.restore();
    }

    expect(sent.desired).toBe("failure");
    expect(sent.summary).toContain("Review gate missed");
    expect(sent.summary).toContain("needs fixes");
    expect(sent.summary).toContain("score 40");
    const row = await rawRow(db, id);
    expect(row.observed).toBe("failure");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("an admission-drop row never ends the wait: the publication still decides", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedAttempt(db);
    recordFailure(
      db,
      "pipeline",
      "review dropped after 3 refused retries: pr-held (admission)",
      T0 + 1_000,
    );

    const stub = stubFetch();
    let factoryCalls = 0;
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scriptedCredentials(db)(input);
        },
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const waitingRow = await rawRow(db, id);
    expect(waitingRow.terminal_ms).toBeNull();
    expect(waitingRow.attempts).toBe(1);
    expect(waitingRow.desired).toBe("in_progress");
    expect(waitingRow.observed).toBe("unknown");

    const proof = proofFor(attempt.identity);
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85));
    linkPublication(db, id, proof.publicationId);
    const dueAt = Number((await rawRow(db, id)).next_attempt_ms);
    const sent: { desired?: string; summary?: string } = {};
    const secondStub = stubFetch();
    let secondDeferred = -1;
    try {
      const summary = await run(db, {
        now: () => dueAt,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      secondDeferred = summary.deferred;
      expect(summary.completed).toBe(1);
    } finally {
      secondStub.restore();
    }

    expect(secondDeferred).toBe(0);
    expect(sent.desired).toBe("success");
    const row = await rawRow(db, id);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("a reviews row from an EARLIER attempt never ends the wait: this attempt's own proof decides", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedAttempt(db);
    seedReview(db, SCOPE, SHA, "needs fixes", 40);

    const stub = stubFetch();
    let factoryCalls = 0;
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scriptedCredentials(db)(input);
        },
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const waitingRow = await rawRow(db, id);
    expect(waitingRow.terminal_ms).toBeNull();
    expect(waitingRow.attempts).toBe(1);
    expect(waitingRow.desired).toBe("in_progress");
    expect(waitingRow.desired_summary).toBeNull();
    expect(waitingRow.observed).toBe("unknown");

    const proof = proofFor(attempt.identity);
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85));
    linkPublication(db, id, proof.publicationId);
    const dueAt = Number((await rawRow(db, id)).next_attempt_ms);
    const sent: { desired?: string; summary?: string } = {};
    const secondStub = stubFetch();
    let secondDeferred = -1;
    try {
      const summary = await run(db, {
        now: () => dueAt,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      secondDeferred = summary.deferred;
      expect(summary.completed).toBe(1);
    } finally {
      secondStub.restore();
    }

    expect(secondDeferred).toBe(0);
    expect(sent.desired).toBe("success");
    expect(sent.summary).toContain(`Review gate met for ${SHA.slice(0, 7)}`);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("a PRIOR attempt's proof never ends the wait: only a proof linked to this attempt can", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedAttempt(db);
    const prior = { ...proofFor(attempt.identity), publicationId: `pub-prior-${attempt.identity.attemptId}` };
    seedPublication(db, SCOPE, SHA, prior, "applied", reviewPayload(SCOPE, SHA, "ship it", 90));

    const stub = stubFetch();
    let factoryCalls = 0;
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scriptedCredentials(db)(input);
        },
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const waitingRow = await rawRow(db, id);
    expect(waitingRow.publication_id).toBeNull();
    expect(waitingRow.terminal_ms).toBeNull();
    expect(waitingRow.attempts).toBe(1);
    expect(waitingRow.desired).toBe("in_progress");
    expect(waitingRow.observed).toBe("unknown");

    const secondStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0 + 180_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scriptedCredentials(db)(input);
        },
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      secondStub.restore();
    }
    expect(factoryCalls).toBe(0);
    expect((await rawRow(db, id)).terminal_ms).toBeNull();

    const own = { ...proofFor(attempt.identity, "degraded"), publicationId: `pub-own-${attempt.identity.attemptId}` };
    seedPublication(db, SCOPE, SHA, own, "confirmed");
    linkPublication(db, id, own.publicationId);
    const sent: { desired?: string; summary?: string } = {};
    const thirdStub = stubFetch();
    let thirdDeferred = -1;
    try {
      const summary = await run(db, {
        now: () => T0 + 240_000,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      thirdDeferred = summary.deferred;
      expect(summary.completed).toBe(1);
    } finally {
      thirdStub.restore();
    }

    expect(thirdDeferred).toBe(0);
    expect(sent.desired).toBe("failure");
    expect(sent.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    const row = await rawRow(db, id);
    expect(row.publication_id).toBe(own.publicationId);
    expect(row.observed).toBe("failure");
  });

  test("a re-trigger publishing on a pre-existing journal row concludes success from its last write", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedAttempt(db);
    const proof = proofFor(attempt.identity);
    seedPublication(
      db,
      SCOPE,
      SHA,
      proof,
      "applied",
      reviewPayload(SCOPE, SHA, "ship it", 85),
      T0 - 5_000,
    );

    const stub = stubFetch();
    const sent: { desired?: string; summary?: string } = {};
    let deferred = -1;
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      deferred = summary.deferred;
      expect(summary.completed).toBe(1);
    } finally {
      stub.restore();
    }

    expect(deferred).toBe(0);
    expect(sent.desired).toBe("success");
    expect(sent.summary).toContain(`Review gate met for ${SHA.slice(0, 7)}`);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("a re-trigger whose journal row was never written after admission stays unconfirmed at the deadline", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedAttempt(db);
    const proof = proofFor(attempt.identity);
    seedPublication(db, SCOPE, SHA, proof, "applied", reviewPayload(SCOPE, SHA, "ship it", 85));

    const stub = stubFetch();
    const sent: { desired?: string; summary?: string } = {};
    let deferred = -1;
    try {
      const summary = await run(db, {
        now: () => FUTURE_DEADLINE + 60_000,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      deferred = summary.deferred;
      expect(summary.completed).toBe(1);
    } finally {
      stub.restore();
    }

    expect(deferred).toBe(0);
    expect(sent.desired).toBe("failure");
    expect(sent.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    const row = await rawRow(db, id);
    expect(row.publication_id).toBeNull();
    expect(row.observed).toBe("failure");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("a re-trigger whose pre-existing journal row is claimed mid-wait never concludes from it", async () => {
    const db = seededDb();
    const { id } = await abandonedAttempt(db);
    const journalId = seedJournal(db, SCOPE, SHA, "prepared", T0 - 5_000);
    expect(await claimPublication(db, journalId, "earlier-generation", T0 + 5_000, "prepared")).not.toBeNull();

    const stub = stubFetch();
    let factoryCalls = 0;
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scriptedCredentials(db)(input);
        },
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const waitingRow = await rawRow(db, id);
    expect(waitingRow.publication_id).toBeNull();
    expect(waitingRow.terminal_ms).toBeNull();
    expect(waitingRow.attempts).toBe(1);
    expect(waitingRow.desired).toBe("in_progress");
    expect(waitingRow.observed).toBe("unknown");

    const sent: { desired?: string; summary?: string } = {};
    const deadlineStub = stubFetch();
    let deadlineDeferred = -1;
    try {
      const summary = await run(db, {
        now: () => FUTURE_DEADLINE + 60_000,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      deadlineDeferred = summary.deferred;
      expect(summary.completed).toBe(1);
    } finally {
      deadlineStub.restore();
    }

    expect(deadlineDeferred).toBe(0);
    expect(sent.desired).toBe("failure");
    expect(sent.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    const row = await rawRow(db, id);
    expect(row.publication_id).toBeNull();
    expect(row.observed).toBe("failure");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("a parse-stage failure row stays open: the degraded publication still decides", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedAttempt(db);
    recordFailure(db, "parse", "model output failed validation");

    const stub = stubFetch();
    let factoryCalls = 0;
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scriptedCredentials(db)(input);
        },
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const deferredRow = await rawRow(db, id);
    expect(deferredRow.terminal_ms).toBeNull();
    expect(deferredRow.attempts).toBe(1);
    expect(deferredRow.desired).toBe("in_progress");
    expect(deferredRow.desired_summary).toBeNull();
    expect(deferredRow.observed).toBe("unknown");

    const degraded = proofFor(attempt.identity, "degraded");
    seedPublication(db, SCOPE, SHA, degraded, "applied");
    linkPublication(db, id, degraded.publicationId);

    const dueAt = Number((await rawRow(db, id)).next_attempt_ms);
    const sent: { desired?: string; summary?: string } = {};
    const secondStub = stubFetch();
    let secondDeferred = -1;
    try {
      const summary = await run(db, {
        now: () => dueAt,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      secondDeferred = summary.deferred;
      expect(summary.completed).toBe(1);
    } finally {
      secondStub.restore();
    }

    expect(secondDeferred).toBe(0);
    expect(sent.desired).toBe("failure");
    expect(sent.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("failure");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("a retryable infra failure keeps the row open: the retry can still publish", async () => {
    const db = seededDb();
    const { id } = await abandonedAttempt(db);
    recordFailure(db, "runner", "the review run exited 1");

    const stub = stubFetch();
    const events: Array<Record<string, unknown>> = [];
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        log: { warn: () => {}, info: (fields) => void events.push(fields) },
        credentials: scriptedCredentials(db),
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      stub.restore();
    }

    const row = await rawRow(db, id);
    expect(row.terminal_ms).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.observed).toBe("unknown");
    expect(
      events.some((fields) => fields.event === "check_recovery_deferred_pending_publication"),
    ).toBe(true);
  });

  test("an elapsed deadline still concludes failure/unconfirmed (existing semantics)", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(
      await setCheckDesired(db, id, lease, { desired: "failure", title: CHECK_NAME, summary: UNCONFIRMED }, null, CLAIM_AT),
    ).toBe(true);
    expect(
      await deferCheckRecovery(
        db,
        id,
        lease,
        { state: "remote-unconfirmed", nextAttemptMs: EXPIRED_DEADLINE, reason: "terminalize budget exceeded" },
        CLAIM_AT,
      ),
    ).toBe(true);

    const stub = stubFetch();
    const sent: { desired?: string; summary?: string } = {};
    let deferred = -1;
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      deferred = summary.deferred;
      expect(summary.completed).toBe(1);
    } finally {
      stub.restore();
    }

    expect(deferred).toBe(0);
    expect(sent.desired).toBe("failure");
    expect(sent.summary).toBe(UNCONFIRMED);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("failure");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("a category frozen under the recovery lease is DELIVERED, never re-decided as unknown", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    const frozen = await claimCheckRecovery(db, id, "recovery:fixture", T0, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(frozen).not.toBeNull();
    expect(
      await setCheckDesired(
        db,
        id,
        frozen!,
        {
          desired: "failure",
          title: CHECK_NAME,
          summary: TERMINAL_FAILURE_TEXT["cap-stop"],
          failureStatus: "cap-stop",
        },
        null,
        T0,
      ),
    ).toBe(true);
    expect(await releaseCheckClaim(db, id, frozen!, T0)).toBe(true);

    const stub = stubFetch();
    const sent: { desired?: string; summary?: string } = {};
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      expect(summary.completed).toBe(1);
    } finally {
      stub.restore();
    }

    expect(sent.desired).toBe("failure");
    expect(sent.summary).toBe(TERMINAL_FAILURE_TEXT["cap-stop"]);
    const row = await rawRow(db, id);
    expect(row.terminal_failure_status).toBe("cap-stop");
    expect(row.terminal_ms).not.toBeNull();
  });
});


describe("the deadline conclusion carries the approved wording", () => {
  test("(b) a staged journal row without proof concludes the approved wording, never a proof-less success", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const journalId = seedJournal(db, SCOPE, SHA, "confirmed", T0 + 1_000);
    linkPublication(db, attempt.identity.attemptId, journalId);

    const stub = stubFetch();
    const sent: { desired?: string; summary?: string } = {};
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      expect(summary.completed).toBe(1);
    } finally {
      stub.restore();
    }

    expect(sent.desired).toBe("failure");
    expect(sent.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
  });

  test("(c) a staged journal row whose proof read fails still concludes the approved wording", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const journalId = seedJournal(db, SCOPE, SHA, "confirmed", T0 + 1_000);
    linkPublication(db, attempt.identity.attemptId, journalId);
    const unreadable = withFailingReads(db, /SELECT proof_json FROM review_publications/);

    const stub = stubFetch();
    const sent: { desired?: string; summary?: string } = {};
    try {
      const summary = await run(unreadable, {
        now: () => T0,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      expect(summary.completed).toBe(1);
    } finally {
      stub.restore();
    }

    expect(sent.desired).toBe("failure");
    expect(sent.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
  });

  test("(d) an unlinked attempt's staged row with malformed proof bytes defers, then concludes the approved wording", async () => {
    const db = seededDb();
    const { id } = await abandonedAttempt(db);
    const journalId = seedJournal(db, SCOPE, SHA, "confirmed", T0 + 1_000);
    db.raw
      .prepare(`UPDATE review_publications SET proof_json = ? WHERE id = ?`)
      .run('{"publicationId":', journalId);

    const stub = stubFetch();
    let factoryCalls = 0;
    try {
      const summary = await run(db, {
        now: () => T0 + 120_000,
        credentials: async (input) => {
          factoryCalls += 1;
          return scriptedCredentials(db)(input);
        },
      });
      expect(summary.deferred).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      stub.restore();
    }

    expect(factoryCalls).toBe(0);
    const waitingRow = await rawRow(db, id);
    expect(waitingRow.publication_id).toBeNull();
    expect(waitingRow.terminal_ms).toBeNull();
    expect(waitingRow.attempts).toBe(1);
    expect(waitingRow.desired).toBe("in_progress");
    expect(waitingRow.observed).toBe("unknown");

    const sent: { desired?: string; summary?: string } = {};
    const deadlineStub = stubFetch();
    let deadlineDeferred = -1;
    try {
      const summary = await run(db, {
        now: () => FUTURE_DEADLINE + 60_000,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      deadlineDeferred = summary.deferred;
      expect(summary.completed).toBe(1);
    } finally {
      deadlineStub.restore();
    }

    expect(deadlineDeferred).toBe(0);
    expect(sent.desired).toBe("failure");
    expect(sent.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    const row = await rawRow(db, id);
    expect(row.publication_id).toBeNull();
    expect(row.observed).toBe("failure");
    expect(row.terminal_ms).not.toBeNull();
  });
});

describe("an owed Check settlement has a reader and a clearer", () => {
  test("the sweep clears only a CONCLUDED Check: a missing row is not a conclusion", async () => {
    const db = seededDb();
    const launchId = `attempt-row-${crypto.randomUUID()}`;
    db.raw
      .prepare(`INSERT INTO review_launches (attempt_id, state, claimed_at_ms) VALUES (?, 'provisioned', ?)`)
      .run(launchId, T0);
    db.raw
      .prepare(
        `UPDATE review_launches SET check_owed_ms = ?, check_key = ?, check_generation = ? WHERE attempt_id = ?`,
      )
      .run(T0, "key-with-no-check-row", 1, launchId);

    expect(await clearConcludedCheckOwed(db)).toBe(0);
    const still = db.raw
      .prepare("SELECT check_owed_ms FROM review_launches WHERE attempt_id = ?")
      .get(launchId) as { check_owed_ms: number | null };
    expect(still.check_owed_ms).toBe(T0);
  });


  test("a failed attempt advances the obligation's due instant, so the backoff is honoured", async () => {
    const db = seededDb();
    const { attempt } = await claim(db, { nowMs: T0, executionDeadlineMs: FUTURE_DEADLINE });
    const attemptId = attempt.identity.attemptId;
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, attempts = 1 WHERE id = ?`)
      .run(attemptId);
    const identity = db.raw
      .prepare("SELECT attempt_key, generation FROM review_checks WHERE id = ?")
      .get(attemptId) as { attempt_key: string; generation: number };
    const launchId = `attempt-row-${crypto.randomUUID()}`;
    db.raw
      .prepare(`INSERT INTO review_launches (attempt_id, state, claimed_at_ms) VALUES (?, 'provisioned', ?)`)
      .run(launchId, T0);
    db.raw
      .prepare(
        `UPDATE review_launches SET check_owed_ms = ?, check_key = ?, check_generation = ? WHERE attempt_id = ?`,
      )
      .run(T0 + 60_000, identity.attempt_key, identity.generation, launchId);
    expect(await listCheckReconcileBatch(db, T0 + 60_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);

    expect(await bumpCheckOwed(db, attemptId, T0 + 120_000)).toBe(true);
    expect(await listCheckReconcileBatch(db, T0 + 60_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(0);
    expect(await listCheckReconcileBatch(db, T0 + 120_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
  });


  test("the owed attempt row makes its Check due now, and concluding it clears the flag", async () => {
    const db = seededDb();
    const { attempt } = await claim(db, { nowMs: T0, executionDeadlineMs: FUTURE_DEADLINE });
    const attemptId = attempt.identity.attemptId;
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, attempts = 1 WHERE id = ?`)
      .run(attemptId);
    expect(await listCheckReconcileBatch(db, T0 + 60_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(0);

    const checkIdentity = db.raw
      .prepare("SELECT attempt_key, generation FROM review_checks WHERE id = ?")
      .get(attemptId) as { attempt_key: string; generation: number };
    const checkKey = checkIdentity.attempt_key;
    const launchId = `attempt-row-${crypto.randomUUID()}`;
    expect(launchId).not.toBe(attemptId);
    db.raw
      .prepare(`INSERT INTO review_launches (attempt_id, state, claimed_at_ms) VALUES (?, 'provisioned', ?)`)
      .run(launchId, T0);
    db.raw
      .prepare(
        `UPDATE review_launches SET check_owed_ms = ?, check_key = ?, check_generation = ? WHERE attempt_id = ?`,
      )
      .run(T0 + 60_000, checkKey, checkIdentity.generation, launchId);

    expect((await listCheckReconcileBatch(db, T0 + 60_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).map((row) => row.identity.attemptId)).toEqual([attemptId]);

    const proof = proofFor(attempt.identity, "review");
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85));
    linkPublication(db, attemptId, proof.publicationId);
    const fetchStub = stubFetch();
    let completeCalls = 0;
    try {
      const summary = await run(db, {
        now: () => T0 + 60_000,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({
            kind: "ready",
            remote: remoteFor(identity, { status: "in_progress", conclusion: null }),
          }),
          fetch: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { status: "in_progress", conclusion: null }),
          }),
          complete: async (identity, _id, conclusion) => {
            completeCalls += 1;
            expect(conclusion.desired).toBe("success");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "success", summary: conclusion.summary }) };
          },
        }),
      });
      expect(summary.examined).toBe(1);
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(completeCalls).toBe(1);

    const row = await rawRow(db, attemptId);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).toBe(T0 + 60_000);
    const launch = db.raw
      .prepare("SELECT check_owed_ms, check_key, check_generation FROM review_launches WHERE attempt_id = ?")
      .get(launchId) as { check_owed_ms: number | null; check_key: string | null; check_generation: number | null };
    expect(launch.check_owed_ms).toBeNull();
    expect(launch.check_key).toBeNull();
    expect(launch.check_generation).toBeNull();
    expect(await listCheckReconcileBatch(db, T0 + 60_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(0);
  });
});

describe("runtime reconciler snapshot", () => {
  test("minimum request budgets complete a cold Check instead of leaving it pending every run", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    for (const [key, value] of [
      ["platform.reconcile.check.max_requests", RECONCILE_LIMITS.checkMaxRequests.min],
      ["platform.reconcile.check.row_max_requests", RECONCILE_LIMITS.checkRowMaxRequests.min],
    ] as const) db.raw.prepare("INSERT INTO review_runtime_settings (key,value,updated_at) VALUES (?,?,'now')").run(key, String(value));
    let coldPairs = 0;
    const credentials: CheckCredentialFactory = async (input) => {
      coldPairs += 1;
      await input.transport.fetchImpl("https://api.github.com/app");
      await input.transport.fetchImpl("https://api.github.com/app/installations/123/access_tokens");
      return scriptedCredentials(db, {
        ...agreeingScript(db),
        fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
        complete: async (identity, _id, conclusion) => ({
          kind: "completed",
          remote: remoteFor(identity, { conclusion: conclusion.desired, summary: conclusion.summary }),
        }),
      })(input);
    };
    const summaries: CheckReconcileSummary[] = [];
    const fetch = stubFetch();
    try {
      for (const now of [T0, T0 + 60_000]) {
        summaries.push(await run(db, { now: () => now, credentials }));
        if (summaries.at(-1)!.completed > 0) break;
      }
      const row = await rawRow(db, attempt.identity.attemptId);
      expect(summaries.some((summary) => summary.completed === 1), JSON.stringify({ summaries, coldPairs, attempts: row.attempts, state: row.recovery_state })).toBe(true);
      expect(coldPairs).toBe(1);
      expect(row.recovery_state).toBe("done");
      expect(row.check_run_id).not.toBeNull();
    } finally {
      fetch.restore();
    }
  });

  test("an attempt at the configured cap is excluded with exactly one settings read", async () => {
    const db = seededDb();
    const first = await claim(db);
    db.raw.prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, ?)").run("platform.reconcile.check.max_attempts", "2", "now");
    db.raw.prepare("UPDATE review_checks SET attempts = 2 WHERE id = ?").run(first.attempt.identity.attemptId);
    const before = await rawRow(db, first.attempt.identity.attemptId);
    let reads = 0;
    const original = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const statement = original(sql);
      if (sql.includes("review_runtime_settings WHERE key IN")) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args: unknown[]) => {
          if (args.includes("platform.reconcile.check.max_attempts")) reads += 1;
          return bind(...args);
        };
      }
      return statement;
    };
    const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db, agreeingScript(db)) });
    expect(summary.examined).toBe(0);
    expect(reads).toBe(1);
    const after = await rawRow(db, first.attempt.identity.attemptId);
    expect(after.attempts).toBe(before.attempts);
    expect(after.holder).toBe(before.holder);
    expect(after.lease_until_ms).toBe(before.lease_until_ms);
    expect(after.lease_epoch).toBe(before.lease_epoch);
  });

  test("selection limit one examines only one of two eligible rows", async () => {
    const db = seededDb();
    await claim(db);
    await claim(db, { headSha: "b".repeat(40) });
    db.raw.prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, ?)").run("platform.reconcile.check.select_limit", "1", "now");
    const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db, agreeingScript(db)) });
    expect(summary.examined).toBe(1);
  });
});

describe("reconciler settings diagnostics", () => {
  test("invalid settings continue recovery with defaults and warn without the stored value", async () => {
    const db = seededDb();
    await claim(db);
    db.raw.prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, ?)").run("platform.reconcile.check.max_attempts", "private-invalid-value", "now");
    const warnings: Array<{ event: string; detail: string }> = [];
    const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db, agreeingScript(db)), log: { warn: (fields) => { warnings.push(fields); }, info: () => {} } });
    expect(summary.examined).toBe(1);
    const diagnostic = warnings.filter((entry) => entry.event === "ops_check_reconcile_settings_degraded");
    expect(diagnostic).toHaveLength(1);
    expect(JSON.parse(diagnostic[0]!.detail)).toEqual({ kind: "invalid_rows", keys: ["platform.reconcile.check.max_attempts"] });
  });

  test("a failed settings read continues recovery and logs a different redacted cause", async () => {
    const db = seededDb();
    await claim(db);
    const original = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const statement = original(sql);
      if (sql.includes("review_runtime_settings WHERE key IN")) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args: unknown[]) => {
          if (args.includes("platform.reconcile.check.max_attempts")) throw new Error("private read error");
          return bind(...args);
        };
      }
      return statement;
    };
    const warnings: Array<{ event: string; detail: string }> = [];
    const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db, agreeingScript(db)), log: { warn: (fields) => { warnings.push(fields); }, info: () => {} } });
    expect(summary.examined).toBe(1);
    const diagnostic = warnings.filter((entry) => entry.event === "ops_check_reconcile_settings_degraded");
    expect(diagnostic).toHaveLength(1);
    expect(JSON.parse(diagnostic[0]!.detail)).toEqual({ kind: "read_failed" });
  });
});

describe("the Check names the executing Bot from the row (migration 0126)", () => {
  test("the recovery lane's own first freeze composes the same line, with no job payload", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedAttempt(db);
    const proof = proofFor(attempt.identity);
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85));
    linkPublication(db, id, proof.publicationId);
    // What `begin` stamps from the job payload in production; the reconciler
    // holds no payload at all and reads it back from this column.
    db.raw.prepare(`UPDATE review_checks SET executor_bot_id = ? WHERE id = ?`).run(APP, id);
    db.raw.prepare(`UPDATE review_bots SET name = 'infra-review' WHERE id = ?`).run(APP);
    db.raw.prepare(`UPDATE github_apps SET github_name = 'acme-bot' WHERE id = ?`).run(APP);

    const stub = stubFetch();
    const sent: { summary?: string } = {};
    try {
      const summary = await run(db, { now: () => T0 + 120_000, credentials: scriptedCredentials(db, publishingScript(sent)) });
      expect(summary.completed).toBe(1);
    } finally {
      stub.restore();
    }

    expect(sent.summary).toContain('Executed by review bot "infra-review"');
    expect(sent.summary).toContain('published as GitHub App "acme-bot"');
    expect((await rawRow(db, id)).desired_summary).toBe(sent.summary);
  });

  test("a row with no executor id still settles, naming the Bot as \"unknown\"", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedAttempt(db);
    const proof = proofFor(attempt.identity);
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85));
    linkPublication(db, id, proof.publicationId);

    const stub = stubFetch();
    const sent: { summary?: string } = {};
    try {
      const summary = await run(db, { now: () => T0 + 120_000, credentials: scriptedCredentials(db, publishingScript(sent)) });
      expect(summary.completed).toBe(1);
    } finally {
      stub.restore();
    }
    expect(sent.summary).toContain('Executed by review bot "unknown"');
  });
});
