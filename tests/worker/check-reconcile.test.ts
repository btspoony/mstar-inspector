/**
 * M7 Check recovery reconciler tests (spec review-lifecycle
 * §7.11.2 + §7.11 composition) — `src/worker/check-reconcile.ts` over the REAL
 * migration DDL (bun:sqlite D1 double, tests/store/helpers.ts) with the
 * credential/adapter surface injected (no GitHub, no credentials in tests).
 *
 * Behaviors covered (brief verification list):
 *   - the exact §7.11.2 due selector: live leases, not-yet-due backoff, an
 *     `in_progress` attempt before its EXECUTION deadline, the attempt cap and
 *     suspended rows of an unusable App are all left alone
 *   - an expired `in_progress` attempt becomes a TERMINAL conclusion decided
 *     from persisted proof AND the App gate (normal meeting the gate → success,
 *     gate missed/unreadable or degraded → failure, none → unconfirmed
 *     failure); `in_progress` is never handed to `completeCheck`
 *   - adoption BEFORE create: a possibly-sent create is resolved read-only,
 *     a definitively `not-sent` row creates once, and an unproven/ambiguous
 *     absence never creates
 *   - a terminal response is validated against the persisted intent: a
 *     mismatch is not recorded, and an old-epoch response persists nothing
 *   - backoff 1/2/4/8/16 min and give-up at the fifth failure to `local-error`
 *     with `terminal_ms` and the remote id RETAINED
 *   - budgets: ≤6 requests/row, ≤100 requests/run, ≤5s/request clamped by the
 *     remaining run deadline — a deferral mutates nothing and spends no attempt
 *   - tenant/App isolation on the suspension path, plus the status-driven
 *     re-enable loop
 *   - a throwing dependency cannot escape the handler
 *   - the §7.11 scheduled composition: `runSweep` → `reconcileReviewLifecycle`
 *     on the shared cron, `reconcileReviewChecks` on its own every-minute cron,
 *     each stage caught independently
 */
import { describe, expect, test } from "bun:test";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import {
  CHECK_BACKOFF_MS,
  CHECK_MAX_ATTEMPTS,
  CHECK_NAME,
  CHECK_RECONCILE_LIMIT,
  CHECK_RECOVERY_LEASE_MS,
  claimCheckRecovery,
  rollbackCheckCreateDispatch,
  deferCheckRecovery,
  getCheckAttempt,
  listCheckReconcileBatch,
  retryCheckRecovery,
  setCheckCreateState,
  setCheckDesired,
  checkSuspensionKindOf,
  checkSuspensionReason,
  listReenableableCheckPairs,
  suspendCheckRecovery,
  type CheckAttempt,
  type CheckConclusion,
} from "../../src/store/review-checks";
import {
  CHECK_RECONCILE_MAX_REQUESTS,
  CHECK_RECONCILE_PER_REQUEST_MS,
  CHECK_RECONCILE_RUN_BUDGET_MS,
  CHECK_ROW_MAX_REQUESTS,
  defaultCheckReconcileLog,
  reconcileReviewChecks,
  type CheckCredentialFactory,
  type CheckReconcileDeps,
  type CheckReconcileSummary,
  type CheckTransport,
} from "../../src/worker/check-reconcile";
import { CheckRequestNotDispatched, isRequestNotDispatched, createCheckBeginLatch, createCheckLifecycle, type ChecksAdapter } from "../../src/pipeline/checks";
import type { ScheduledEnv } from "../../src/worker/env";
import { defaultReconcileLog } from "../../src/worker/lifecycle-reconcile";
import { defaultSweepLog } from "../../src/worker/sweep";
import worker from "../../src/worker/index";
import { sha256Hex } from "../../src/pipeline/review-threads";
import { CHECK_UPDATE_DEFAULT } from "../../src/dashboard/runtime-config-store";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

// The shared fixtures live in one module so the journal/proof-wait suite
// drives the same production surface (see tests/worker/helpers/check-reconcile).
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
  asEnv,
  claim,
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
  stubFetch,
  withFailingReads,
} from "./helpers/check-reconcile";
import type { AdapterScript, AdoptOutcome, BeginOutcome, CompleteOutcome, FetchOutcome } from "./helpers/check-reconcile";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("budget and selector constants (spec §7.11.2)", () => {
  test("pins the §7.11.2 verbatim bounds", () => {
    expect(CHECK_RECONCILE_MAX_REQUESTS).toBe(100);
    expect(CHECK_RECONCILE_RUN_BUDGET_MS).toBe(60_000);
    expect(CHECK_RECONCILE_PER_REQUEST_MS).toBe(5_000);
    expect(CHECK_ROW_MAX_REQUESTS).toBe(6);
    expect(CHECK_MAX_ATTEMPTS).toBe(5);
    expect(CHECK_RECONCILE_LIMIT).toBe(25);
    expect(CHECK_RECOVERY_LEASE_MS).toBe(120_000);
    expect(CHECK_BACKOFF_MS).toEqual([60_000, 120_000, 240_000, 480_000, 960_000]);
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe("due selection (spec §7.11.2 predicate)", () => {
  test("a LIVE lease is never examined, claimed or mutated by a stale reconciler", async () => {
    const db = seededDb();
    // The consumer still holds an unexpired claim lease.
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
    // The execution deadline has passed, but the recovery lease the claim
    // carries is still live: an expired attempt is not an expired lease.
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
    // Nobody released this row to recovery (no due time was ever recorded), so
    // nothing but the deadline can make it due — bookkeeping is not release.
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, attempts = 1 WHERE id = ?`)
      .run(attempt.identity.attemptId);
    expect(await listCheckReconcileBatch(db, T0 + 60_000)).toHaveLength(0);
    expect(await listCheckReconcileBatch(db, T0 + 900_000)).toHaveLength(1);
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
      .run(CHECK_MAX_ATTEMPTS, capped.attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db, agreeingScript()) });
      expect(summary.examined).toBe(1);
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, early.attempt.identity.attemptId)).terminal_ms).toBeNull();
    expect((await rawRow(db, capped.attempt.identity.attemptId)).attempts).toBe(CHECK_MAX_ATTEMPTS);
    expect((await rawRow(db, capped.attempt.identity.attemptId)).terminal_ms).toBeNull();
  });

  test("a lease that goes LIVE between selection and claim stops the row (selection grants no ownership)", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const fetchStub = stubFetch();
    try {
      // The row is due when selected; before this lane can claim it, another
      // invocation acquires a live lease (the credentials step runs in that
      // window). The conditional reacquire must then refuse, and the lane must
      // write NOTHING — selection alone grants no ownership (§7.11.2 step 1).
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
    // The other holder's lease, epoch and timestamps are untouched.
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

// ---------------------------------------------------------------------------
// Proof-based terminal conclusions for an expired attempt
// ---------------------------------------------------------------------------

describe("expired attempt → terminal conclusion from persisted proof (spec §7.9)", () => {
  test("a normal publication whose applied review meets the gate concludes success and marks observed", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const proof = proofFor(attempt.identity, "review");
    // The gate reads the review THIS publication carried, never the scope/SHA
    // `reviews` projection (see `readPublishedReview`), so the envelope lives in
    // the publication payload.
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85));
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            // The lane must never hand an `in_progress` value to the update,
            // and the shipped text is the frozen proof-derived intent.
            expect(conclusion.desired).toBe("success");
            expect(conclusion.title).toBe(CHECK_NAME);
            expect(conclusion.summary).toContain("Review gate met for 0123456 (round 3)");
            expect(conclusion.summary).toContain('verdict "ship it"');
            expect(conclusion.summary).toContain("score 85");
            expect(conclusion.summary).toContain("floor 60");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "success" }) };
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
    seedPublication(db, SCOPE, SHA, proofFor(attempt.identity, "degraded"), "applied");
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
            expect(conclusion.summary).toBe("Review output was invalid; a degraded summary comment was published.");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure" }) };
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

  test("an expired attempt with NO proof concludes an honest unconfirmed failure", async () => {
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
            expect(conclusion.summary).toBe(
              "Review attempt could not be confirmed complete; publication status is unknown.",
            );
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure" }) };
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
    // Seed a CONFIRMED publication proof plus a readable review envelope inside
    // it, so the decision actually reaches the gate: without them the lane
    // concludes from the absent proof alone and never issues the two reads this
    // case is about.
    const proof = proofFor(attempt.identity);
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 96));
    // The gate and the review payload are the two reads a failing D1 keeps
    // failing; after migration 0045 a corrupt `check_pass_verdicts` no longer
    // throws either — `getCheckGate` reports it as null, the same UNREADABLE
    // input. Neither is a reason to skip the terminal conclusion: an attempt
    // that only retried would never conclude its Check.
    const degraded = withFailingReads(db, /check_pass_verdicts|SELECT payload_json FROM review_publications/);
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
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure" }) };
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
    expect(pushed[0]?.summary).toBe("Review gate could not be evaluated for 0123456: the App's gate configuration could not be read.");
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.desired).toBe("failure");
    expect(row.observed).toBe("failure");
    expect(row.recovery_state).toBe("done");
  });

  test("a newly discovered proof CORRECTS a persisted unknown failure to success on the same run", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    // The consumer already froze an unconfirmed failure with no proof link.
    expect(
      await setCheckDesired(
        db,
        attempt.identity.attemptId,
        lease,
        { desired: "failure", title: CHECK_NAME, summary: "unconfirmed" },
        null,
        CLAIM_AT,
      ),
    ).toBe(true);
    const proof = proofFor(attempt.identity, "review");
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 92));
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
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "success" }) };
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
    // The correction happened on the SAME owned run — no second generation.
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM review_checks`).first<{ n: number }>()).toEqual({ n: 1 });
  });

  test("the gate reads the attempt's OWN publication, not the scope/SHA reviews row", async () => {
    // `reviews` holds ONE row per scope/SHA (UNIQUE key, first write wins) and
    // the journal holds ONE review publication per scope/SHA, so under RL-12 a
    // later attempt re-uses that publication while the `reviews` projection can
    // still be the FIRST attempt's result — or not applied at all. The gate
    // must read the envelope the proof's publication carried; a stale row must
    // not decide a fresh round.
    const db = seededDb();
    const { attempt } = await claim(db);
    const proof = proofFor(attempt.identity, "review");
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 95));
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
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "success" }) };
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
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure" }) };
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

// ---------------------------------------------------------------------------
// Adopt before create
// ---------------------------------------------------------------------------

describe("adoption before creation (spec §7.9 / RL-12)", () => {
  test("a possibly-sent create is resolved by read-only adoption, never a second create", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    // A create was attempted (durable `sending`) and its run exists remotely.
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
          complete: async (identity, runId) => {
            expect(runId).toBe(909);
            return { kind: "completed", remote: remoteFor(identity, { id: 909, conclusion: "failure" }) };
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
          complete: async (identity) => ({ kind: "completed", remote: remoteFor(identity, { id: 555, conclusion: "failure" }) }),
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
    // `sending` means a create request may have reached GitHub. An absence in
    // the listForRef window is NOT proof none was created — GitHub's own
    // listing is bounded — so the honest answer is read-only recovery only.
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

// ---------------------------------------------------------------------------
// Response validation / stale epoch
// ---------------------------------------------------------------------------

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
          // The remote closed with a DIFFERENT conclusion (a manual close or
          // another writer) — evidence of something else, never an observation
          // of this attempt's intended outcome.
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
          complete: async (identity) => {
            // Between the validated response and the local write, another
            // invocation's recovery claim takes the row over (new epoch).
            db.raw
              .prepare(`UPDATE review_checks SET lease_epoch = lease_epoch + 1 WHERE id = ?`)
              .run(identity.attemptId);
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure" }) };
          },
        }),
      });
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    // The stale writer advanced neither `observed` nor terminality.
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

// ---------------------------------------------------------------------------
// Backoff and give-up
// ---------------------------------------------------------------------------

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
      .run(CHECK_MAX_ATTEMPTS - 1, attempt.identity.attemptId);
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
    // Nothing dropped, nothing cleared, no false closure claimed.
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
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[3]!); // 8 minutes
    expect(row.terminal_ms).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

describe("request budgets (spec §7.11.2 step 5)", () => {
  test("admission stops a row at ≤6 dispatched requests, mutating nothing and spending no attempt", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      // Each adapter call issues 4 real requests, so the row's flow would need
      // 8 (adopt + create) — the per-row bound must refuse the last two
      // BEFORE dispatch.
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
    expect(fetchStub.urls).toHaveLength(CHECK_ROW_MAX_REQUESTS);
    const row = await rawRow(db, attempt.identity.attemptId);
    // The deferral mutated NOTHING and spent NO attempt: the row stays due.
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
      for (let i = 0; i < CHECK_RECONCILE_MAX_REQUESTS; i += 1) {
        await transport.fetchImpl(`https://api.github.com/x?n=${i}`);
      }
      expect(fetchStub.urls.length - before).toBe(CHECK_RECONCILE_MAX_REQUESTS);
      await expect(transport.fetchImpl("https://api.github.com/x?over=1")).rejects.toThrow(/budget exhausted/);
      expect(fetchStub.urls.length - before).toBe(CHECK_RECONCILE_MAX_REQUESTS);
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
      expect(transport.boundMs()).toBe(CHECK_RECONCILE_PER_REQUEST_MS);
      clock = T0 + CHECK_RECONCILE_RUN_BUDGET_MS - 10;
      expect(transport.boundMs()).toBe(10);
      clock = T0 + CHECK_RECONCILE_RUN_BUDGET_MS;
      expect(transport.boundMs()).toBe(1); // never zero or negative
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
      // The run's deadline is computed at the pass's start (T0), then the clock
      // jumps past it: no request can be admitted, so nothing is claimed.
      const summary = await run(db, {
        now: () => {
          const value = clock;
          clock = T0 + CHECK_RECONCILE_RUN_BUDGET_MS;
          return value;
        },
        credentials: scriptedCredentials(db, agreeingScript()),
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

// ---------------------------------------------------------------------------
// Tenant / App isolation and re-enable
// ---------------------------------------------------------------------------

describe("tenant/App isolation and status-driven re-enable (spec §7.6)", () => {
  test("only the unusable pair is suspended; the healthy pair still completes", async () => {
    const db = seededDb();
    const good = await claim(db, { action: "good" });
    const bad = await claim(db, { scope: SCOPE_B, githubAppId: NUMERIC_APP_B, action: "bad" });
    // The bad pair's row carries a remote run id, so its suspension path is
    // reached without any create/adopt for a pair that has no credentials.
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 42 WHERE id = ?`)
      .run(bad.attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db, agreeingScript()) });
      expect(summary.completed).toBe(1);
      expect(summary.suspended).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, good.attempt.identity.attemptId)).recovery_state).toBe("done");
    const badRow = await rawRow(db, bad.attempt.identity.attemptId);
    expect(badRow.recovery_state).toBe("suspended");
    expect(badRow.terminal_ms).toBeNull();
    // The suspended row kept its whole identity for a later inspection.
    expect(badRow.external_id).toBe(bad.attempt.identity.externalId);
    expect(badRow.app_id).toBe(APP_B);
    expect(badRow.attempts).toBe(0);
  });

  test("re-enable never touches a suspended row of a NOT-active App", async () => {
    const db = seededDb();
    const healthy = await claim(db, { action: "healthy" });
    const disabled = await claim(db, { scope: SCOPE_B, githubAppId: NUMERIC_APP_B, action: "disabled" });
    // Both rows carry a status-resumable `disabled` suspension.
    for (const id of [healthy.attempt.identity.attemptId, disabled.attempt.identity.attemptId]) {
      db.raw
        .prepare(
          `UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, recovery_state = 'suspended', last_error = ? WHERE id = ?`,
        )
        .run(checkSuspensionReason("disabled", "app disabled"), id);
    }
    // The second row's App row is NOT active: its suspension must survive even
    // though its recorded kind is the status-resumable one.
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
      // Only the healthy pair was examined. The not-active App's row stayed
      // suspended and was never claimed, asked about, or terminalized.
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

// ---------------------------------------------------------------------------
// Throw-proofing
// ---------------------------------------------------------------------------

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
    // A throwing credential path is an unusable PAIR (M8's precedent): the row
    // is suspended durably and nothing propagates out of the pass.
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
    // The other row must be IN FLIGHT durably for adoption to be legal on it.
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
            remote: remoteFor(identity, { id: checkRunId, status: "completed", conclusion: "failure" }),
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

// ---------------------------------------------------------------------------
// Scheduled composition (spec §7.11)
// ---------------------------------------------------------------------------

/**
 * Capture each stage's own structured log sink. The three stages report
 * through three different default sinks, and each emits its terminal line
 * exactly once per pass — so the ORDER of those lines is direct evidence of
 * the composition order (§7.11) rather than an assertion about wiring.
 */
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
    // A breached failure window makes the sweep stage emit its alert line; the
    // Check lane must leave no trace at all in this expression.
    const store = db.raw;
    for (let i = 0; i < 6; i += 1) {
      store
        .prepare(
          `INSERT INTO review_failures (installation_id, owner, repo, pr_number, head_sha, stage, error, created_at)
           VALUES (1, 'acme', 'widgets', 1, '', 'runner', ?, datetime('now'))`,
        )
        .run(`boom-${i}`);
    }
    // A due Check row exists, yet this expression must not touch it.
    const { attempt } = await claim(db);

    const events = await captureComposition({ DB: db as unknown as ScheduledEnv["DB"], REVIEW_QUEUE: NOOP_QUEUE });

    const sweepAt = events.indexOf("ops_sweep_alert");
    const lifecycleAt = events.indexOf("ops_lifecycle_reconcile");
    expect(sweepAt).toBeGreaterThanOrEqual(0);
    expect(lifecycleAt).toBeGreaterThan(sweepAt);
    // The Check lane belongs to the MINUTE expression alone: both fire on
    // :00/:15/:30/:45, so running it here would duplicate every pass (and its
    // suspension/backoff writes) in that minute.
    expect(events).not.toContain("ops_check_reconcile");
    // This pass therefore touched nothing Check-side.
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.terminal_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
  });

  test("a throwing sweep and a throwing lifecycle lane never escape the handler", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw.prepare(`DELETE FROM app_installations WHERE app_id = ?`).run(APP);
    // A broken DB makes the sweep's own D1 read throw and both reconcilers'
    // internal catch fire — one stage's failure never becomes another's.
    const broken = {
      prepare(): never {
        throw new Error("d1 down");
      },
      batch: async () => [],
    } as unknown as TestD1;

    const events = await captureComposition({ DB: broken as unknown as ScheduledEnv["DB"], REVIEW_QUEUE: NOOP_QUEUE });

    expect(events[0]).toBe("retention_swept_failed");
    expect(events).toContain("ops_sweep_failed");
    expect(events).toContain("ops_lifecycle_reconcile_failed");
    // The Check lane is not part of this expression at all.
    expect(events).not.toContain("ops_check_reconcile");

    // And with a working DB both later lanes still reach their terminal lines.
    const events2 = await captureComposition({ DB: db as unknown as ScheduledEnv["DB"], REVIEW_QUEUE: NOOP_QUEUE });
    expect(events2).toContain("ops_lifecycle_reconcile");
    expect(events2).not.toContain("ops_check_reconcile");
  });

  test("routes by controller.cron: the minute expression runs the Checks lane ALONE", async () => {
    const db = seededDb();
    // A breached failure window (the sweep WOULD alert) plus a due Check row
    // (the minute lane must act on it): the two effects discriminate routing.
    for (let i = 0; i < 6; i += 1) {
      db.raw
        .prepare(
          `INSERT INTO review_failures (installation_id, owner, repo, pr_number, head_sha, stage, error, created_at)
           VALUES (1, 'acme', 'widgets', 1, '', 'runner', ?, datetime('now'))`,
        )
        .run(`boom-${i}`);
    }
    const { attempt } = await claim(db);
    db.raw.prepare(`DELETE FROM app_installations WHERE app_id = ?`).run(APP);
    const env = { DB: db as unknown as ScheduledEnv["DB"], REVIEW_QUEUE: NOOP_QUEUE };

    const minute = await captureComposition(env, "* * * * *");
    // The Check lane alone — none of the other stages' lines — and it really
    // ran (its durable suspension is present).
    expect(minute).not.toContain("ops_sweep_alert");
    expect(minute).not.toContain("ops_lifecycle_reconcile");
    expect(minute).toContain("ops_check_reconcile");
    expect((await rawRow(db, attempt.identity.attemptId)).recovery_state).toBe("suspended");

    const quarter = await captureComposition(env, "*/15 * * * *");
    expect(quarter).toContain("ops_sweep_alert");
    expect(quarter).toContain("ops_lifecycle_reconcile");
    // The minute expression is the ONLY Check driver — the quarter hour must
    // not run the same lane a second time.
    expect(quarter).not.toContain("ops_check_reconcile");
  });
});

// ---------------------------------------------------------------------------
// L2 fix 1 — claim eligibility, live-safe suspension, pause, budget release
// ---------------------------------------------------------------------------

describe("claim repeats the selector's eligibility (L2 fix 1 finding 1)", () => {
  /**
   * Drive one pass while mutating a row into an ineligible state AFTER the
   * selector produced it. The mutation rides the credential step, which is the
   * real window between selection and claim.
   */
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
    // Nothing mutated: no timestamp, no attempt, no lease taken.
    expect(row.lease_epoch).toBe(1);
    expect(row.lease_until_ms).toBe(EXPIRED_DEADLINE);
    expect(row.attempts).toBe(0);
    expect(row.holder).toBe("consumer-run");
    expect(row.next_attempt_ms).toBe(T0 + 60_000);
  });

  test("reaching the attempt cap after selection blocks the claim", async () => {
    const { summary, row, urls } = await withPostSelectionMutation((db, id) => {
      db.raw.prepare(`UPDATE review_checks SET attempts = ? WHERE id = ?`).run(CHECK_MAX_ATTEMPTS, id);
    });
    expect(summary.examined).toBe(1);
    expect(summary.gaveUp).toBe(0);
    expect(urls).toHaveLength(0);
    expect(row.attempts).toBe(CHECK_MAX_ATTEMPTS); // not incremented further
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
    // Row A: released, terminal intent — suspendable.
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
    // Row B: same pair, LIVE lease held by another invocation mid-operation.
    const live = await claim(db, { action: "live", triggeredBy: "other", nowMs: T0, executionDeadlineMs: T0 + 900_000 });
    const before = await rawRow(db, live.attempt.identity.attemptId);

    const suspended = await suspendCheckRecovery(
      db,
      { appId: APP, installationId: SCOPE.installationId },
      "app disabled",
      T0,
    );
    // Only the free row was suspended; the live one was left completely alone.
    expect(suspended).toBe(1);
    expect((await rawRow(db, free.attempt.identity.attemptId)).recovery_state).toBe("suspended");
    const after = await rawRow(db, live.attempt.identity.attemptId);
    expect(after.holder).toBe(before.holder);
    expect(after.lease_epoch).toBe(before.lease_epoch);
    expect(after.lease_until_ms).toBe(before.lease_until_ms);
    expect(after.updated_ms).toBe(before.updated_ms);
    expect(after.recovery_state).toBe("pending");
    // Its fenced write still works — proof the lease was never erased.
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
    // The claim lease is past; the row is nobody's in-flight work.
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
    // A create was attempted and its run exists: pause must not strand it.
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
          complete: async (identity) => ({ kind: "completed", remote: remoteFor(identity, { id: 909, conclusion: "failure" }) }),
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
    // P68-QC-006: the row is deferred OUT of the due batch through a durable
    // `paused` suspension — no attempt spent, no lease withheld, identity kept.
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.recovery_state).toBe("suspended");
    expect(row.create_state).toBe("not-sent");
    expect(row.check_run_id).toBeNull();
    expect(row.terminal_ms).toBeNull();
    // NOT immediately due: the deferral is what stops the every-pass credential
    // mint + adoption re-walk this finding names.
    expect(await listCheckReconcileBatch(db, T0)).toHaveLength(0);
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
            remote: remoteFor(identity, { status: "completed", conclusion: "failure" }),
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
    // 20 due rows on DISTINCT pairs (distinct installation ids). Each pair
    // spends 5 probe + 6 row requests before its create, so 20 pairs are far
    // more than the ≤100 per-RUN cap — the exact shape the run-level ceiling
    // exists for. Nothing that was refused may be left claimed, charged or
    // written.
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
          // Burn 5 of the row's ≤6 allowance in the credential probe (the real
          // cost of a mint + identity proof), then hand back the adapter double
          // so every further call is metered through the same transport.
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

    // The run ceiling held exactly, which is what makes the claims below
    // meaningful rather than vacuous.
    expect(fetchStub.urls.length).toBe(CHECK_RECONCILE_MAX_REQUESTS);
    // The ceiling stopped work BEFORE any create could leave.
    expect(creates).toBe(0);

    // No row was left claimed, leased or terminal by a refused operation, and
    // no attempt was charged for one.
    for (const row of rows) {
      const after = await rawRow(db, row.id);
      expect(after.holder).toBeNull();
      expect(after.lease_until_ms).toBeNull();
      expect(after.terminal_ms).toBeNull();
      expect(after.attempts).toBe(row.before.attempts);
      expect(after.recovery_state).toBe("pending");
    }

    // And the rows the run never even reached are byte-identical.
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
      // The credential probe costs nothing; each adapter call costs 5, so the
      // row's second operation is refused by the ≤6 per-row bound AFTER the
      // claim was taken — the exact window finding 4 describes.
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
    // Released, not withheld: due again immediately, no attempt charged.
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.recovery_state).toBe("pending");
    expect(row.desired).not.toBe("in_progress"); // intent still persisted
    // The load-bearing assertion: the selector sees the row due at the very
    // clock instant the refusal happened. A withheld 120s recovery lease would
    // hide it here, which is precisely the defect finding 4 names.
    expect(await listCheckReconcileBatch(db, T0)).toHaveLength(1);
    // …and a SECOND pass in the same window can claim it again immediately.
    const reclaim = await claimCheckRecovery(db, attempt.identity.attemptId, "reconciler", T0);
    expect(reclaim, "the released row must be immediately reclaimable").not.toBeNull();
  });

  test("a refusal inside ADOPTION releases the claim too", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      // One more request than the row allows: the 7th is refused INSIDE the
      // adoption call itself, so the refusal must unwind through that branch.
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          requestsPerCall: CHECK_ROW_MAX_REQUESTS + 1,
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
    expect(await listCheckReconcileBatch(db, T0)).toHaveLength(1);
  });

  test("a refusal inside the owned-run FETCH releases the claim too", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    // A known run id: adoption is skipped, so the fetch is the first operation.
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 321 WHERE id = ?`)
      .run(attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          requestsPerCall: CHECK_ROW_MAX_REQUESTS + 1,
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
    expect(row.check_run_id).toBe(321); // identity retained
    expect(await listCheckReconcileBatch(db, T0)).toHaveLength(1);
  });

  test("a refusal inside the terminal UPDATE releases the claim too", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    // Known run id and a non-terminal remote read, so the flow reaches the
    // update — where the 7th request is refused.
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 321 WHERE id = ?`)
      .run(attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          // adoption is skipped (id known): fetch spends 1, the update the rest.
          requestsPerCall: CHECK_ROW_MAX_REQUESTS,
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
    expect(await listCheckReconcileBatch(db, T0)).toHaveLength(1);
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
            // Mirror the live post-`sending`, pre-call lease fence: no Checks
            // callable ever runs, so the adapter proves zero dispatch.
            creates += 1;
            return { kind: "unavailable", reason: "lease expired before the create request", requests: 0 };
          },
        }),
      });
      expect(summary.completed).toBe(0);
      expect(summary.gaveUp).toBe(0);
      // NOT a spent attempt: nothing ran.
      expect(summary.unconfirmed).toBe(0);
      expect(summary.errors).toBe(0);
    } finally {
      fetchStub.restore();
    }
    // The adapter's rollback of the `sending` mark: nothing is possibly-sent.
    const row = await rawRow(db, id);
    expect(row.create_state).toBe("not-sent");
    expect(row.check_run_id).toBeNull();
    // No attempt, backoff or error mutation.
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.terminal_ms).toBeNull();
    // T3 released its own claim, so the row is selector-due AT THIS INSTANT…
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
    expect(await listCheckReconcileBatch(db, T0)).toHaveLength(1);
    // …and immediately reclaimable.
    expect(await claimCheckRecovery(db, id, "reconciler", T0)).not.toBeNull();
    void creates;
  });

  test("a zero-dispatch refusal still releases when the clock passes T3's own recovery lease", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    // T3's recovery lease runs 120s from its claim. A slow credential step or
    // adapter call can push the clock past it, at which point a liveness-fenced
    // release would write NOTHING and the row would stay leased — not "left
    // due" as §7.11.2 step 5 requires. The identity fence is what makes the
    // release work here.
    let clock = T0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => clock,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async () => {
            // The call outlives T3's own recovery lease.
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
    // Released despite the expiry, with nothing else moved.
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.last_error).toBeNull();
    // Immediately selector-due and reclaimable at that same instant.
    expect(await listCheckReconcileBatch(db, clock)).toHaveLength(1);
    expect(await claimCheckRecovery(db, id, "reconciler", clock)).not.toBeNull();
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
    // RL-12 honesty: a dispatched create may have landed, so the row keeps its
    // `sending` mark for read-only adoption and pays an attempt + backoff.
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
    // No `requests` field: treated as possibly sent, never as a zero-dispatch
    // refusal, so the row cannot be made createable on a guess.
    expect(row.create_state).toBe("sending");
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.attempts).toBe(1);
  });

  test("a stale-epoch rollback race leaves a newer holder's row untouched", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    // The adapter's rollback loses: a newer claim bumped the epoch after the
    // `sending` write, so the identity fence refuses and T3's release misses.
    // Written inside the claim lease (the claim's own clock), then taken over.
    expect(await setCheckCreateState(db, id, lease, "sending", undefined, CLAIM_AT)).toBe(true);
    db.raw
      .prepare(`UPDATE review_checks SET holder = 'other-run', lease_epoch = ?, lease_until_ms = ? WHERE id = ?`)
      .run(lease.epoch + 1, T0 + CHECK_RECOVERY_LEASE_MS, id);

    expect(await rollbackCheckCreateDispatch(db, id, lease, CLAIM_AT)).toBe(false);
    const row = await rawRow(db, id);
    // The newer holder's ownership and state are exactly as it left them.
    expect(row.holder).toBe("other-run");
    expect(row.lease_epoch).toBe(lease.epoch + 1);
    expect(row.create_state).toBe("sending");
    expect(row.attempts).toBe(0);
  });
});

describe("operator retry accepts a recorded in-progress observation (L2 fix 1 finding 5)", () => {
  test("an in_progress observation survives give-up and is reopened by retry with its identity intact", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    // The lane observed the run as running (a validated non-terminal payload),
    // then exhausted its attempts and gave up. That durable `in_progress`
    // observation must not strand the row — it is exactly the "external run
    // still pending" state the spec's operator retry exists for.
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 321, observed = 'in_progress', recovery_state = 'local-error', terminal_ms = ?, attempts = ? WHERE id = ?`)
      .run(T0, CHECK_MAX_ATTEMPTS, id);

    // A live lease is still refused.
    const reacquired = await claimCheckRecovery(db, id, "reconciler", T0 - 1);
    expect(reacquired).toBeNull();

    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: T0 })).toBe(true);
    const row = await rawRow(db, id);
    expect(row.recovery_state).toBe("pending");
    expect(row.terminal_ms).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.check_run_id).toBe(321); // remote identity retained
    expect(row.external_id).toBe(attempt.identity.externalId);
    expect(row.generation).toBe(attempt.identity.generation);
    // The observation is RETAINED, never rewritten to a fake completion.
    expect(row.observed).toBe("in_progress");
    // …and the row is a selector candidate again.
    expect(await listCheckReconcileBatch(db, T0)).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// QC zero-residual fix wave — P68-QC-003/004/005/006
// ---------------------------------------------------------------------------

describe("credential suspension is durable, not churn (P68-QC-003)", () => {
  /** Seed a suspended pair whose row records `kind` and `fingerprint`. */
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
    // The digest the production factory would derive from the STORED envelope —
    // so the next pass's comparison is exercising the real value, not a fiction.
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
    // Without the digest on the row, the next pass cannot tell "same
    // credentials, same failure" from "the operator corrected them" — which is
    // the whole mechanism that stops the churn. So the persisted value is the
    // contract, not an implementation detail.
    const row = await rawRow(db, id);
    expect(row.recovery_state).toBe("suspended");
    expect(checkSuspensionKindOf(row.last_error as string)).toBe("identity-mismatch");
    expect(row.last_error).toContain(`cred=${DIGEST}`);
    // And the pair is then skipped with NO probe while the envelope is unchanged.
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
    // The row records an identity-mismatch proven against the digest of the
    // envelope currently stored on the App row.
    const envelope = db.raw.prepare(`SELECT private_key_enc FROM github_apps WHERE id = ?`).get(APP) as {
      private_key_enc: string;
    };
    const digest = await sha256Hex(envelope.private_key_enc);
    const id = await seedSuspended(db, "identity-mismatch", digest);

    let probes = 0;
    const fetchStub = stubFetch();
    try {
      // TWO passes: the second is the one that used to churn.
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
    // ZERO credential probes across both passes: the digest proved the
    // credentials were untouched, so no identity question was reopened.
    expect(probes).toBe(0);
    expect(fetchStub.urls).toHaveLength(0);
    const row = await rawRow(db, id);
    expect(row.recovery_state).toBe("suspended");
    expect(row.attempts).toBe(0);
    // And it never occupied the bounded batch.
    expect(await listCheckReconcileBatch(db, T0 + 15 * 60_000)).toHaveLength(0);
  });

  test("an operator-corrected envelope reopens the pair and resumes the SAME attempt identity", async () => {
    const db = seededDb();
    const envelope = db.raw.prepare(`SELECT private_key_enc FROM github_apps WHERE id = ?`).get(APP) as {
      private_key_enc: string;
    };
    const oldDigest = await sha256Hex(envelope.private_key_enc);
    const id = await seedSuspended(db, "identity-mismatch", oldDigest);
    // The operator replaces the credentials.
    db.raw.prepare(`UPDATE github_apps SET private_key_enc = 'enc-pem-rotated' WHERE id = ?`).run(APP);

    let probes = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: async (input) => {
          probes += 1;
          return scriptedCredentials(db, agreeingScript())(input);
        },
      });
      // The changed digest earned exactly ONE proof, and the pair resumed.
      expect(probes).toBeGreaterThanOrEqual(1);
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    expect(row.observed).toBe("failure");
    // The SAME historical identity — never a new generation or a new id.
    expect(row.generation).toBe(1);
    expect(row.external_id).toBe((await rawRow(db, id)).external_id);
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
      // The corrected envelope earned exactly ONE proof; the still-failing pair
      // is re-stamped rather than returned to the due batch.
      expect(probes).toBe(1);
      expect(summary.examined).toBe(0);
      // Second pass on the now-stamped digest: D1-only, no probe at all.
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
    // The re-stamp carries the NEW digest, so the next pass is D1-only.
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
          return scriptedCredentials(db, agreeingScript())(input);
        },
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    // Status was the proof, so no separate re-enable probe was issued.
    expect(probes).toBe(1); // only the row loop's own resolution
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
      // Out of the batch — the per-pass churn is gone.
      expect(await listCheckReconcileBatch(db, T0)).toHaveLength(0);

      // A SECOND paused pass costs nothing: the row is not even selected, so no
      // credential resolution and no adoption walk is issued for it.
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

      // The kill switch lifts: the SAME row resumes and creates under a fresh
      // claim, addressing the SAME historical identity.
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
            remote: remoteFor(identity, { status: "completed", conclusion: "failure" }),
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
    expect(row.attempts).toBe(0); // the pause never charged an attempt
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
          complete: async (identity) => ({
            kind: "completed",
            remote: remoteFor(identity, { id: 909, conclusion: "failure" }),
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
    // Capture the transport the lane builds and refuse at its first admission.
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
      // Exhaust the run budget so the NEXT admission is refused pre-dispatch.
      for (let i = 0; i < CHECK_RECONCILE_MAX_REQUESTS; i += 1) {
        await transport!.fetchImpl("https://api.github.com/probe");
      }
      // The refusal must be the UPSTREAM marker class, not a local look-alike:
      // `sendRequests` walks the error chain for that exact class by identity.
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
          // A create whose REQUEST left the process and failed: one request.
          begin: async () => ({ kind: "unavailable", reason: "check create failed: socket hang up", requests: 1 }),
        }),
      });
      // Not a deferral: the row pays an attempt and takes a backoff rung,
      // because GitHub may hold a run this lane cannot see.
      expect(summary.unconfirmed).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, id);
    // The `sending` mark is RETAINED (never rolled back) and recovery is
    // adopt-only — the RL-12 posture a possibly-sent create demands.
    expect(row.create_state).toBe("sending");
    expect(row.check_run_id).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[0]!);
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.terminal_ms).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// QC3 revalidation — F-004 admission-gated re-enable probe
// ---------------------------------------------------------------------------

describe("the re-enable probe is admission-gated and never invents a verdict (F-004)", () => {
  /** A suspended pair whose recorded digest does NOT match the stored envelope. */
  async function correctedPair(db: TestD1): Promise<{ id: string; before: Record<string, string | number | null> }> {
    const { attempt, lease } = await claim(db, { action: "corrected" });
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, { desired: "failure", title: CHECK_NAME, summary: "unconfirmed" }, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);
    // Recorded digest is stale, so the CURRENT one differs and a proof is owed.
    expect(
      await suspendCheckRecovery(db, { appId: APP, installationId: SCOPE.installationId },
        checkSuspensionReason("identity-mismatch", "mismatch", "a".repeat(64)), T0),
    ).toBe(1);
    return { id, before: await rawRow(db, id) };
  }

  test("an unaffordable probe is skipped: zero factory calls, zero writes, prior state intact", async () => {
    const db = seededDb();
    const { id, before } = await correctedPair(db);
    // A DISTRACTOR pair with a LOWER installation id, so the scan probes it
    // first and it spends the run's entire request budget. The clock stays
    // FIXED: the refusal must come from the spent cap, never from a
    // side-effecting `now`.
    const DISTRACTOR = 100;
    db.raw
      .prepare(
        `INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
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
            // Burn the whole run cap here; the last request is refused before
            // dispatch, which stops the loop.
            for (let i = 0; i < CHECK_RECONCILE_MAX_REQUESTS + 5; i += 1) {
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
      // The pass RAN and left the target pair queued: the sibling warn names it.
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
    // NOT ONE factory call for the target pair: its stored state is
    // byte-identical, so a later pass with budget retries it. Writing a verdict
    // here is F-004.
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
          // Refuse the probe's own request BEFORE dispatch: the shared transport
          // throws the typed marker, which the factory must NOT swallow into a
          // credential verdict.
          throw new CheckRequestNotDispatched("test: probe refused before dispatch");
        },
      });
      // Positive signal: the pass ran and reported the pair as deferred.
      expect(summary.errors).toBe(0);
      expect(warned.map((entry) => entry.event)).toContain("ops_check_reconcile_reenable_probe_deferred");
    } finally {
      fetchStub.restore();
    }
    // No re-stamp: the recorded digest and reason are exactly as before, and the
    // pair was reported as deferred rather than as a credential failure.
    const after = await rawRow(db, id);
    expect(after).toEqual(before);
    expect(after.recovery_state).toBe("suspended");
    expect(after.last_error).toBe(before.last_error);
    expect(warned.some((entry) => entry.event === "ops_check_reconcile_reenable_probe_deferred")).toBe(true);
    // The next pass is still free to prove it.
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
          // The realistic shape: the transport refuses the probe's request, the
          // factory catches it and answers `unavailable` rather than rethrowing.
          try {
            // One MORE than the run's whole allowance, so the last request is
            // refused before dispatch and the budget flag is set.
            for (let i = 0; i <= CHECK_RECONCILE_MAX_REQUESTS; i += 1) {
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
    // The refusal must NOT be recorded as a credential verdict: the row keeps
    // its exact prior reason and digest, and the pass reports a deferral.
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
          return { kind: "ok", paused: false, adapter: scriptedAdapter(db, agreeingScript(), transport) };
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
  /**
   * The budget is read ONCE per run and handed to the credential lane, which
   * forwards it into the Checks adapter. Capturing at that seam pins the two
   * halves this lane owns: the store read and the threading (the adapter's own
   * honoring of `updateBudgetMs` is `tests/pipeline/checks.test.ts`'s case).
   */
  function capturingCredentials(db: TestD1, seen: Array<number | undefined>): CheckCredentialFactory {
    return async (input) => {
      seen.push(input.updateBudgetMs);
      return input.scope.appId === SCOPE.appId
        ? { kind: "ok", paused: false, adapter: scriptedAdapter(db, agreeingScript(), input.transport) }
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
    // A degraded settings read never fails the pass.
    expect(summary.errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Abandonment is not a conclusion: the wait for the persisted proof
// ---------------------------------------------------------------------------

/** The attempt's own execution deadline — the wait's hard stop. */
const FUTURE_DEADLINE = T0 + 900_000;

/**
 * The row a REAL abandonment leaves behind, driven through the production seam.
 * `createCheckLifecycle.begin` creates the run, finds its own latch already
 * tripped (the consumer's begin budget elapsed while the create ran) and hands
 * the attempt to recovery: the run id is attached so recovery adopts it,
 * `desired` stays `in_progress` because abandonment concludes nothing, and the
 * release records the first backoff rung as the row's own due time.
 */
async function abandonedAttempt(db: TestD1): Promise<{ attempt: CheckAttempt; id: string }> {
  const transport: CheckTransport = {
    boundMs: () => CHECK_RECONCILE_PER_REQUEST_MS,
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
    executionDeadlineMs: FUTURE_DEADLINE,
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

  // The real post-abandonment state this suite is about — no hand-set intent.
  expect(attempt.desired).toBe("in_progress");
  expect(attempt.createState).toBe("known");
  expect(attempt.recoveryState).toBe("remote-unconfirmed");
  return { attempt, id };
}

/** A script that creates the run, finds it in progress and records the send. */
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
      return { kind: "completed", remote: remoteFor(identity, { conclusion: conclusion.desired }) };
    },
  };
}

function recordFailure(db: TestD1, stage: string, error: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA, stage, error);
}

describe("the publication-proof wait decides when abandonment may conclude (spec §7.9)", () => {
  test("no proof and a future deadline: the pass defers and spends no attempt", async () => {
    const db = seededDb();
    const { id } = await abandonedAttempt(db);
    // The whole point of the released-row eligibility: a row whose intent is
    // still `in_progress` is SELECTED long before its execution deadline.
    expect(await listCheckReconcileBatch(db, T0 + 120_000)).toHaveLength(1);
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

    // Nothing was minted and no attempt was spent: the row is simply not
    // concludable while the head can still publish, and abandonment froze no
    // conclusion of its own.
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
    expect(row.next_attempt_ms).toBe(T0 + 120_000 + 60_000);

    // The journal probe found nothing to report; the still-publishable verdict
    // is what held the wait, and the line says so.
    const deferred = events.filter((fields) => fields.event === "check_recovery_deferred_pending_publication");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.probe_state).toBe("none");
  });

  test("a proof that lands before the deadline yields the gate-derived conclusion", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedAttempt(db);
    const proof = proofFor(attempt.identity);
    seedPublication(db, SCOPE, SHA, proof, "confirmed", reviewPayload(SCOPE, SHA, "ship it", 85));

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

    // The unconfirmed fallback is NOT what ships: the proof decided, and the
    // row's intent was still `in_progress` when the pass selected it.
    expect(deferred).toBe(0);
    expect(sent.desired).toBe("success");
    expect(sent.summary).toContain(`Review gate met for ${SHA.slice(0, 7)}`);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("an admission drop is terminal: the head can publish nothing more", async () => {
    const db = seededDb();
    const { id } = await abandonedAttempt(db);
    recordFailure(db, "pipeline", "review dropped after 3 refused retries: pr-held (admission)");

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

    // Nothing more can land for this head, so the wait is over on this pass.
    expect(deferred).toBe(0);
    expect(sent.desired).toBe("failure");
    expect(sent.summary).toBe(UNCONFIRMED);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("failure");
    expect(row.terminal_ms).not.toBeNull();
  });

  test("a parse-stage failure row is NOT terminal: the degraded publication still decides", async () => {
    const db = seededDb();
    const { attempt, id } = await abandonedAttempt(db);
    // The parse branch records this row FIRST and only then publishes the
    // degraded comment. With no journal yet it proves nothing about the head.
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

    // Deferred, not concluded: no conclusion was frozen and no attempt spent.
    expect(factoryCalls).toBe(0);
    const deferredRow = await rawRow(db, id);
    expect(deferredRow.terminal_ms).toBeNull();
    expect(deferredRow.attempts).toBe(1);
    expect(deferredRow.desired).toBe("in_progress");
    expect(deferredRow.desired_summary).toBeNull();
    expect(deferredRow.observed).toBe("unknown");

    // The degrade path lands its publication: applied proof for this head.
    seedPublication(db, SCOPE, SHA, proofFor(attempt.identity, "degraded"), "applied");

    const sent: { desired?: string; summary?: string } = {};
    const secondStub = stubFetch();
    let secondDeferred = -1;
    try {
      const summary = await run(db, {
        now: () => T0 + 180_000,
        credentials: scriptedCredentials(db, publishingScript(sent)),
      });
      secondDeferred = summary.deferred;
      expect(summary.completed).toBe(1);
    } finally {
      secondStub.restore();
    }

    // The proof decides — a degraded publication never passes the gate.
    expect(secondDeferred).toBe(0);
    expect(sent.desired).toBe("failure");
    expect(sent.summary).toBe("Review output was invalid; a degraded summary comment was published.");
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
    // The abandoned claim's own deadline has already passed: no wait applies.
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    // Both writes are fenced on the claim's OWN live lease, so they land at the
    // claim instant, before that lease runs out.
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
});
