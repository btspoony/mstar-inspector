/**
 * Route recovery claim 2 — the settle-once mark proves COMPLETION, not entry.
 *
 * The claim: an interruption after the mark but before the failure row, Check
 * conclusion and claim stamp must leave the settlement replayable, and the
 * settlement step must survive one transient error.
 *
 * Each case simulates the interruption rather than the happy path:
 * - the mark is read from the database AT the moment the settlement's first
 *   durable effect lands (an entry-mark would already be visible there);
 * - a host killed while the settlement's first effect is still in flight leaves
 *   no mark, and the resumed run settles;
 * - a completed settlement is not repeated when the step is re-executed;
 * - a transient fault inside the settlement is retried and completes.
 */
import { beforeEach, describe, expect, test } from "bun:test";

// Load shim FIRST: a static import of the execution module would be hoisted
// above it (it imports ./sandbox → `cloudflare:workers`, unresolvable in Bun's
// runner). The module graph under test is loaded dynamically on purpose.
import "../helpers/cloudflare-workers-mock";

import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { TEST_APP_ID, TEST_OWNER, TEST_PR_NUMBER, TEST_REPO, createSeededTestD1 } from "../helpers/consumer-fixtures";
import { createConsumerHarness, failureRows, makePayload } from "../helpers/consumer-harness";
import { createArtifactStore } from "../../src/store/artifact-store";
import { createFailureStore, type FailureStore } from "../../src/store/failure-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import { deliveryKeyOf, markAttemptSettled, reserveAttemptHandoff } from "../../src/store/review-route-store";
import { reconcileReviewRoute } from "../../src/pipeline/route-reconcile";
import { claimAttempt } from "../../src/store/review-checks";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type { AttemptRef, CheckSettlement, ProcessDeps } from "../../src/pipeline/review-attempt-execution";
import type { TestD1 } from "../store/helpers";

const { runReviewAttemptWorkflow } = await import("../../src/workflow/review");

const ATTEMPT_ID = "attempt-4d-settlement";
let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

function makeRef(payload: ReturnType<typeof makePayload>): AttemptRef {
  return {
    attemptId: ATTEMPT_ID,
    payload,
    level: "default",
    roundStartedAt: Date.now(),
    deadlineMs: Date.now() + 900_000,
    githubAppId: 424242,
    usageWorkspaceId: "default",
    usageSource: "byok",
    checkBudgets: null,
    checkClaimSha: null,
    inflight: {
      key: {
        installation_id: 123,
        owner: TEST_OWNER,
        repo: TEST_REPO,
        pr_number: TEST_PR_NUMBER,
        workspace_id: "default",
      },
      attemptId: ATTEMPT_ID,
      ttlSeconds: 900,
    },
    attempts: 1,
  };
}

async function makeDeps(db: TestD1, failureStore?: FailureStore): Promise<ProcessDeps> {
  return {
    env: await h.makeEnv({ DB: db as never }),
    store: createArtifactStore(db as never),
    targets: createTargetsStore(db as never),
    failureStore: failureStore ?? createFailureStore(db as never),
    appCommenters: new Map([
      [TEST_APP_ID, { commenter: h.fakeCommenter, fingerprint: "test-fingerprint", githubAppId: 424242 }],
    ]),
    createAppCommenter: () => h.fakeCommenter,
    log: h.testLog,
    getSandbox: h.overrides.getSandbox,
    selectPrHead: async () => null,
    findIncrementBase: async () => null,
    attemptCapMs: 900_000,
    runnerConfigs: new Map([
      [
        TEST_APP_ID,
        {
          appCfg: { keys: { ark: ["sk-test"] }, modelChain: "ark/deepseek-v4-flash" },
          modelOverrides: undefined,
          customProviders: undefined,
        },
      ],
    ]),
    checkSettlements: new Map(),
    credentials: new Map(),
  } as ProcessDeps;
}

/** The delivery's handoff row — where the settle-once mark lives. */
async function seedHandoff(db: TestD1, payload: ReturnType<typeof makePayload>): Promise<void> {
  await reserveAttemptHandoff(db as never, {
    deliveryKey: deliveryKeyOf(payload),
    attemptId: ATTEMPT_ID,
    payload,
    nowMs: 1_000,
    deadlineMs: Date.now() + 900_000,
  });
}

function settledEffects(db: TestD1): string[] | null {
  const row = db.raw
    .prepare("SELECT settled_effects FROM review_attempt_handoffs WHERE attempt_id = ?")
    .get(ATTEMPT_ID) as { settled_effects: string | null } | null;
  return row?.settled_effects === null || row === null ? null : (JSON.parse(row.settled_effects) as string[]);
}

/** The settlement record of one DELIVERY (the replayer cases use another attempt id). */
function settlementOf(db: TestD1, deliveryKey: string): { settled_ms: number | null; settled_effects: string | null } {
  return db.raw
    .prepare("SELECT settled_ms, settled_effects FROM review_attempt_handoffs WHERE delivery_key = ?")
    .get(deliveryKey) as { settled_ms: number | null; settled_effects: string | null };
}

function settledMark(db: TestD1): number | null {
  const row = db.raw
    .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
    .get(ATTEMPT_ID) as { settled_ms: number | null } | null;
  return row?.settled_ms ?? null;
}

/**
 * A step host that runs each callback in place and models the platform's retry
 * policy from the SAME config the real host reads. `failOn` is a step that
 * threw before doing anything; `dieOn` is a HOST DEATH at that step — with
 * `inFlight: false` the step never started, with `inFlight: true` its callback
 * is started and abandoned mid-await, so whatever it landed before the kill
 * stays and it never completes.
 */
function stepHost(options: { failOn?: string; dieOn?: string; inFlight?: boolean } = {}): {
  step: WorkflowStep;
  runs: string[];
} {
  const runs: string[] = [];
  const step = {
    do: async (name: string, configOrCallback: unknown, maybeCallback?: unknown): Promise<unknown> => {
      const config = (typeof configOrCallback === "function" ? {} : configOrCallback) as
        | WorkflowStepConfig
        | undefined;
      const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<
        unknown
      >;
      runs.push(name);
      if (options.failOn === name) throw new Error(`${name} failed before it did any work`);
      if (options.dieOn === name) {
        if (options.inFlight === true) void callback();
        throw new Error(`the host died during ${name}`);
      }
      const limit = config?.retries?.limit ?? 0;
      let lastError: unknown;
      for (let attempt = 0; attempt <= limit; attempt += 1) {
        try {
          return await callback();
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError;
    },
    sleep: async () => {},
    sleepUntil: async () => {},
    waitForEvent: async () => {
      throw new Error("the in-place workflow step does not wait for events");
    },
  } as unknown as WorkflowStep;
  return { step, runs };
}

describe("claim 2 — the mark proves completion, not entry", () => {
  test("the settlement's first durable effect lands while the mark is still absent", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seedHandoff(db, payload);
    const real = createFailureStore(db as never);
    let markWhenRowLanded: number | null | undefined;
    const deps = await makeDeps(db, {
      ...real,
      record: async (input) => {
        // The instant the settlement's durable outcome is written.
        markWhenRowLanded = settledMark(db);
        await real.record(input);
      },
    });
    await runReviewAttemptWorkflow(deps, makeRef(payload), stepHost({ failOn: "prepare" }).step, async () => {});

    expect(markWhenRowLanded).toBeNull();
    expect(failureRows(db)).toHaveLength(1);
    expect(settledMark(db)).toEqual(expect.any(Number));
  });

  test("a host killed inside the settlement leaves no mark, and the resumed run settles", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seedHandoff(db, payload);
    // The settlement's first effect never returns: the host dies awaiting it.
    const hungWrite = Promise.withResolvers<void>();
    const hung = {
      ...createFailureStore(db as never),
      record: () => hungWrite.promise,
    };
    await expect(
      runReviewAttemptWorkflow(
        await makeDeps(db, hung),
        makeRef(payload),
        stepHost({ failOn: "prepare", dieOn: "settle-failure", inFlight: true }).step,
        async () => {},
      ),
    ).rejects.toThrow(/died during settle-failure/);

    // Nothing durable came of it, and the mark does NOT claim otherwise.
    expect(failureRows(db)).toHaveLength(0);
    expect(settledMark(db)).toBeNull();

    // The resumed host settles: the mark was never set by the dead attempt.
    await runReviewAttemptWorkflow(
      await makeDeps(db),
      makeRef(payload),
      stepHost({ failOn: "prepare" }).step,
      async () => {},
    );
    expect(failureRows(db)).toHaveLength(1);
    expect(settledMark(db)).toEqual(expect.any(Number));
  });

  test("a completed settlement is not repeated when the step is re-executed", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seedHandoff(db, payload);
    await runReviewAttemptWorkflow(
      await makeDeps(db),
      makeRef(payload),
      stepHost({ failOn: "prepare" }).step,
      async () => {},
    );
    const afterFirst = failureRows(db).length;
    expect(afterFirst).toBe(1);

    // A resumed host whose durable step result was lost re-runs the step: the
    // completion mark means it does not settle a second time.
    const host = stepHost({ failOn: "prepare" });
    await runReviewAttemptWorkflow(await makeDeps(db), makeRef(payload), host.step, async () => {});
    expect(host.runs).toContain("settle-failure");
    expect(failureRows(db)).toHaveLength(afterFirst);
  });

  test("a rejected failure-row write leaves no completion mark, and the replay writes it", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seedHandoff(db, payload);
    // The settlement's durable outcome never lands (an infra fault on the row),
    // and no container exists, so the settlement continues to its end.
    const broken = {
      ...createFailureStore(db as never),
      record: async () => {
        throw new Error("D1 unavailable");
      },
    };
    await expect(
      runReviewAttemptWorkflow(await makeDeps(db, broken), makeRef(payload), stepHost({ failOn: "prepare" }).step, async () => {}),
    ).rejects.toThrow();

    // The mark must NOT certify a settlement whose row is missing: the retry
    // would skip it and the failure would vanish.
    expect(failureRows(db)).toHaveLength(0);
    expect(settledMark(db)).toBeNull();

    // A healthy replay finishes the settlement and only then marks it.
    await runReviewAttemptWorkflow(
      await makeDeps(db),
      makeRef(payload),
      stepHost({ failOn: "prepare" }).step,
      async () => {},
    );
    expect(failureRows(db)).toHaveLength(1);
    expect(settledMark(db)).toEqual(expect.any(Number));
  });

  test("a lost claim stamp is recorded on the mark, not swallowed, and a replay finishes it", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seedHandoff(db, payload);
    // The commit's failed-claim stamp cannot be written: the settlement's other
    // effects land, so this is a PARTIAL settlement and must say so.
    h.kvState.putError = new Error("KV unavailable");
    await expect(
      runReviewAttemptWorkflow(await makeDeps(db), makeRef(payload), stepHost({ failOn: "prepare" }).step, async () => {}),
    ).rejects.toThrow();

    // The step retried the settlement once (the mark was not complete), so the
    // tolerated duplicate event row may be present — never a second claim.
    expect(failureRows(db).length).toBeGreaterThanOrEqual(1);
    // This failure is pre-checkout, so no Check conclusion was owed: the mark
    // must record exactly the effects this settlement had, and not the stamp.
    // The array is a SET (the mark's union sorts it), not an ordered log.
    expect(settledEffects(db)).toEqual(["failure-row"]);
    // Not complete: a replay must finish the missing stamp, so the mark must
    // not skip the settlement.
    expect(settledMark(db)).toBeNull();

    h.kvState.putError = undefined;
    await runReviewAttemptWorkflow(
      await makeDeps(db),
      makeRef(payload),
      stepHost({ failOn: "prepare" }).step,
      async () => {},
    );
    expect(settledEffects(db)).toEqual(["claim-stamp", "failure-row"]);
    expect(settledMark(db)).toEqual(expect.any(Number));
  });

  test("the recovery pass finishes a settlement that outlived the step and the instance", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const key = deliveryKeyOf(payload);
    await seedHandoff(db, payload);
    // The settlement started (the Workflow step wrote its in-progress marker)
    // and only the Check effect landed before the execution vanished.
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET settling_ms = ?, settled_effects = ? WHERE delivery_key = ?")
      .run(1_000, null, key);
    // The attempt's outcome is durable on its launch row — the only condition
    // under which the pass may write.
    db.raw
      .prepare(
        `INSERT INTO review_launches (attempt_id, state, claimed_at_ms, launched_at_ms, failed_at_ms, result_outcome)
         VALUES (?, 'failed', ?, ?, ?, 'failed')`,
      )
      .run(ATTEMPT_ID, 900, 950, 990);
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    // Too fresh: a live step may still be finishing.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 60_000);
    expect(failureRows(db)).toHaveLength(0);
    expect(settledMark(db)).toBeNull();

    // Past the quiet window the pass lands what needs no dead host's memory.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 5 * 60_000 + 1);
    expect(failureRows(db)).toHaveLength(1);
    expect(String(failureRows(db)[0]!.error)).toContain("settlement replay");
    expect(h.kvPuts.some((put) => put.value === "failed")).toBe(true);
    expect(settledMark(db)).toEqual(expect.any(Number));
    expect(settledEffects(db)).toEqual(["claim-stamp", "failure-row"]);

    // Completed: a second pass does nothing.
    const rowsAfter = failureRows(db).length;
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 10 * 60_000);
    expect(failureRows(db)).toHaveLength(rowsAfter);
  });

  test("two settlement executions accumulate their effects instead of overwriting each other", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const key = deliveryKeyOf(payload);
    await seedHandoff(db, payload);

    // Execution A landed the failure row; execution B landed the stamp. Neither
    // alone is the obligation, and B must not erase A's progress.
    await markAttemptSettled(db as never, key, ["failure-row"], ["failure-row", "claim-stamp"], 2_000);
    expect(settledEffects(db)).toEqual(["failure-row"]);
    expect(settledMark(db)).toBeNull();

    await markAttemptSettled(db as never, key, ["claim-stamp"], ["failure-row", "claim-stamp"], 3_000);
    expect(settledEffects(db)).toEqual(["claim-stamp", "failure-row"]);
    expect(settledMark(db)).toEqual(3_000);

    // A later empty write keeps the union and the completion.
    await markAttemptSettled(db as never, key, [], ["failure-row", "claim-stamp"], 4_000);
    expect(settledEffects(db)).toEqual(["claim-stamp", "failure-row"]);
    expect(settledMark(db)).toEqual(3_000);
  });

  test("the pass refuses an unknown paid state and a skipped delivery before writing anything", async () => {
    const db = await createSeededTestD1();
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    // (a) launched, no outcome: the container may still be running.
    const unknownPayload = makePayload();
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(unknownPayload),
      attemptId: "attempt-unknown",
      payload: unknownPayload,
      nowMs: 1_000,
      deadlineMs: Date.now() + 600_000,
    });
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET settling_ms = ? WHERE delivery_key = ?")
      .run(1_000, deliveryKeyOf(unknownPayload));
    db.raw
      .prepare(
        `INSERT INTO review_launches (attempt_id, state, claimed_at_ms, launched_at_ms)
         VALUES (?, 'launched', ?, ?)`,
      )
      .run("attempt-unknown", 900, 950);

    // (b) a moved-head skip: no paid outcome, and it is not a failure.
    const skipPayload = makePayload({ head_sha: "9999999999999999999999999999999999999999" });
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(skipPayload),
      attemptId: "attempt-skip",
      payload: skipPayload,
      nowMs: 1_000,
      deadlineMs: Date.now() + 600_000,
    });
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET settling_ms = ? WHERE delivery_key = ?")
      .run(1_000, deliveryKeyOf(skipPayload));
    db.raw
      .prepare(
        `INSERT INTO review_launches (attempt_id, state, claimed_at_ms)
         VALUES (?, 'provisioned', ?)`,
      )
      .run("attempt-skip", 900);

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 5 * 60_000 + 1);

    // Nothing was written for either: no failure row, no claim stamp, no mark.
    expect(failureRows(db)).toHaveLength(0);
    expect(h.kvPuts).toHaveLength(0);
    const rows = db.raw
      .query("SELECT settled_ms FROM review_attempt_handoffs ORDER BY created_ms")
      .all() as Array<{ settled_ms: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.settled_ms === null)).toBe(true);
  });

  test("no mark completes over an open Check; the pass finishes it once the Check is terminal", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const key = deliveryKeyOf(payload);
    const scope: Scope = {
      appId: TEST_APP_ID,
      installationId: 123,
      owner: TEST_OWNER,
      repo: TEST_REPO,
      prNumber: TEST_PR_NUMBER,
    };
    // A real Check row for this attempt, still open (no terminal_ms).
    const claimed = await claimAttempt(db as never, {
      scope,
      githubAppId: 424242,
      headSha: payload.head_sha!,
      triggeredBy: "pull_request",
      action: "opened",
      holder: "consumer:attempt-open-check",
      nowMs: Date.now(),
      executionDeadlineMs: Date.now() + 600_000,
    });
    if (claimed.kind !== "claimed") throw new Error(`the test could not create the Check: ${claimed.kind}`);
    const identity = claimed.attempt.identity;
    // The Check row's own attempt key — the identity the launch row freezes.
    const checkKey = (
      db.raw.query("SELECT attempt_key FROM review_checks WHERE id = ?").get(identity.attemptId) as {
        attempt_key: string;
      }
    ).attempt_key;
    await reserveAttemptHandoff(db as never, {
      deliveryKey: key,
      attemptId: identity.attemptId,
      payload,
      nowMs: 1_000,
      deadlineMs: Date.now() + 600_000,
    });
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET settling_ms = ? WHERE delivery_key = ?")
      .run(1_000, key);
    db.raw
      .prepare(
        `INSERT INTO review_launches
           (attempt_id, attempt_key, attempt_generation, state, claimed_at_ms, launched_at_ms, failed_at_ms, result_outcome)
         VALUES (?, ?, ?, 'failed', ?, ?, ?, 'failed')`,
      )
      .run(identity.attemptId, checkKey, identity.generation, 900, 950, 990);
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    // The Check is open: the row and stamp land, but the mark must NOT complete.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 5 * 60_000 + 1);
    expect(failureRows(db)).toHaveLength(1);
    expect(JSON.parse(settlementOf(db, key).settled_effects!)).toEqual(["claim-stamp", "failure-row"]);
    expect(settlementOf(db, key).settled_ms).toBeNull();

    // The check reconciler closes the Check at its lease; the next pass records
    // that conclusion and only then completes.
    db.raw.prepare("UPDATE review_checks SET terminal_ms = ? WHERE id = ?").run(Date.now(), claimed.attempt.identity.attemptId);
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 10 * 60_000);
    expect(JSON.parse(settlementOf(db, key).settled_effects!)).toEqual(["check", "claim-stamp", "failure-row"]);
    expect(settlementOf(db, key).settled_ms).toEqual(expect.any(Number));

    // Completed: no further writes.
    const rows = failureRows(db).length;
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 15 * 60_000);
    expect(failureRows(db)).toHaveLength(rows);
  });

  test("one transient error inside the settlement is retried and completes", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seedHandoff(db, payload);
    const deps = await makeDeps(db);
    // A Check conclusion that fails once — a transient fault inside the
    // settlement, after its failure row.
    let terminalizeCalls = 0;
    const settlement: CheckSettlement = {
      handle: null,
      claimAttempted: true,
      promotionAbandoned: null,
      terminalized: false,
      begin: async () => null,
      abandon: async () => true,
      terminalize: async () => {
        terminalizeCalls += 1;
        if (terminalizeCalls === 1) {
          // Only the first settlement attempt hits this: the retry re-runs the
          // whole settlement, which is why the mark must not be set yet.
          throw new Error("Checks API unavailable");
        }
        settlement.terminalized = true;
      },
    };
    deps.checkSettlements.set(ATTEMPT_ID, settlement);

    // The step retries once; the retried settlement finishes, then propagates
    // the attempt's own error (the route's terminal outcome).
    await expect(
      runReviewAttemptWorkflow(deps, makeRef(payload), stepHost({ failOn: "prepare" }).step, async () => {}),
    ).rejects.toThrow();

    expect(terminalizeCalls).toBeGreaterThanOrEqual(2);
    expect(settlement.terminalized).toBe(true);
    expect(settledMark(db)).toEqual(expect.any(Number));
  });
});
