import { beforeEach, describe, expect, test } from "bun:test";

import "../helpers/cloudflare-workers-mock";

import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { TEST_APP_ID, TEST_OWNER, TEST_PR_NUMBER, TEST_REPO, createSeededTestD1 } from "../helpers/consumer-fixtures";
import { createConsumerHarness, failureRows, makePayload } from "../helpers/consumer-harness";
import { createArtifactStore } from "../../src/store/artifact-store";
import { createFailureStore, type FailureStore } from "../../src/store/failure-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import {
  deliveryKeyOf,
  listUnpublishedLaunchSettlements,
  markAttemptSettled,
  reserveAttemptHandoff,
  stampOwedSettlementClaim,
} from "../../src/store/review-route-store";
import { idemKey } from "../../src/contracts/idem";
import { reconcileReviewRoute } from "../../src/pipeline/route-reconcile";
import { claimAttempt } from "../../src/store/review-checks";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type { AttemptRef, CheckSettlement, ProcessDeps } from "../../src/pipeline/review-attempt-execution";
import type { D1Like, D1StatementLike } from "../../src/store/types";
import type { TestD1 } from "../store/helpers";

const { runReviewAttemptWorkflow } = await import("../../src/workflow/review");
const { createReviewConsumer } = await import("../../src/pipeline/consumer");
const { AttemptPhaseError, cleanupAttempt, settleAttemptFailure } = await import(
  "../../src/pipeline/review-attempt-execution"
);
const { BudgetExhaustedError, claimReviewAttempt, claimReviewLaunch } = await import(
  "../../src/pipeline/review-attempt"
);

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

async function seedHandoff(db: TestD1, payload: ReturnType<typeof makePayload>): Promise<void> {
  await reserveAttemptHandoff(db as never, {
    deliveryKey: deliveryKeyOf(payload),
    attemptId: ATTEMPT_ID,
    payload,
    nowMs: 1_000,
    enqueuedMs: 0,
    deadlineMs: Date.now() + 900_000,
  });
}

function settledEffects(db: TestD1): string[] | null {
  const row = db.raw
    .prepare("SELECT settled_effects FROM review_attempt_handoffs WHERE attempt_id = ?")
    .get(ATTEMPT_ID) as { settled_effects: string | null } | null;
  return row?.settled_effects === null || row === null ? null : (JSON.parse(row.settled_effects) as string[]);
}

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

    expect(failureRows(db)).toHaveLength(0);
    expect(settledMark(db)).toBeNull();

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

    const host = stepHost({ failOn: "prepare" });
    await runReviewAttemptWorkflow(await makeDeps(db), makeRef(payload), host.step, async () => {});
    expect(host.runs).toContain("settle-failure");
    expect(failureRows(db)).toHaveLength(afterFirst);
  });

  test("a rejected failure-row write leaves no completion mark, and the replay writes it", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seedHandoff(db, payload);
    const broken = {
      ...createFailureStore(db as never),
      record: async () => {
        throw new Error("D1 unavailable");
      },
    };
    await expect(
      runReviewAttemptWorkflow(await makeDeps(db, broken), makeRef(payload), stepHost({ failOn: "prepare" }).step, async () => {}),
    ).rejects.toThrow();

    expect(failureRows(db)).toHaveLength(0);
    expect(settledMark(db)).toBeNull();

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
    h.kvState.putError = new Error("KV unavailable");
    await expect(
      runReviewAttemptWorkflow(await makeDeps(db), makeRef(payload), stepHost({ failOn: "prepare" }).step, async () => {}),
    ).rejects.toThrow();

    expect(failureRows(db).length).toBeGreaterThanOrEqual(1);
    expect(settledEffects(db)).toEqual(["failure-row"]);
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
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET settling_ms = ?, settled_effects = ? WHERE delivery_key = ?")
      .run(1_000, null, key);
    db.raw
      .prepare(
        `INSERT INTO review_launches (attempt_id, state, claimed_at_ms, launched_at_ms, failed_at_ms, result_outcome)
         VALUES (?, 'failed', ?, ?, ?, 'failed')`,
      )
      .run(ATTEMPT_ID, 900, 950, 990);
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 60_000);
    expect(failureRows(db)).toHaveLength(0);
    expect(settledMark(db)).toBeNull();

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 5 * 60_000 + 1);
    expect(failureRows(db)).toHaveLength(1);
    expect(String(failureRows(db)[0]!.error)).toContain("settlement replay");
    expect(h.kvPuts.some((put) => put.value === "failed")).toBe(true);
    expect(settledMark(db)).toEqual(expect.any(Number));
    expect(settledEffects(db)).toEqual(["claim-stamp", "failure-row"]);

    const rowsAfter = failureRows(db).length;
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 10 * 60_000);
    expect(failureRows(db)).toHaveLength(rowsAfter);
  });

  test("two settlement executions accumulate their effects instead of overwriting each other", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const key = deliveryKeyOf(payload);
    await seedHandoff(db, payload);

    await markAttemptSettled(db as never, key, ["failure-row"], ["failure-row", "claim-stamp"], 2_000);
    expect(settledEffects(db)).toEqual(["failure-row"]);
    expect(settledMark(db)).toBeNull();

    await markAttemptSettled(db as never, key, ["claim-stamp"], ["failure-row", "claim-stamp"], 3_000);
    expect(settledEffects(db)).toEqual(["claim-stamp", "failure-row"]);
    expect(settledMark(db)).toEqual(3_000);

    await markAttemptSettled(db as never, key, [], ["failure-row", "claim-stamp"], 4_000);
    expect(settledEffects(db)).toEqual(["claim-stamp", "failure-row"]);
    expect(settledMark(db)).toEqual(3_000);
  });

  test("the pass refuses an unknown paid state and a skipped delivery before writing anything", async () => {
    const db = await createSeededTestD1();
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    const unknownPayload = makePayload();
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(unknownPayload),
      attemptId: "attempt-unknown",
      payload: unknownPayload,
      nowMs: 1_000,
      enqueuedMs: 0,
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

    const skipPayload = makePayload({ head_sha: "9999999999999999999999999999999999999999" });
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(skipPayload),
      attemptId: "attempt-skip",
      payload: skipPayload,
      nowMs: 1_000,
      enqueuedMs: 0,
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
      enqueuedMs: 0,
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

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 5 * 60_000 + 1);
    expect(failureRows(db)).toHaveLength(1);
    expect(JSON.parse(settlementOf(db, key).settled_effects!)).toEqual(["claim-stamp", "failure-row"]);
    expect(settlementOf(db, key).settled_ms).toBeNull();

    db.raw.prepare("UPDATE review_checks SET terminal_ms = ? WHERE id = ?").run(Date.now(), claimed.attempt.identity.attemptId);
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 10 * 60_000);
    expect(JSON.parse(settlementOf(db, key).settled_effects!)).toEqual(["check", "claim-stamp", "failure-row"]);
    expect(settlementOf(db, key).settled_ms).toEqual(expect.any(Number));

    const rows = failureRows(db).length;
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 1_000 + 15 * 60_000);
    expect(failureRows(db)).toHaveLength(rows);
  });

  test("one transient error inside the settlement is retried and completes", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seedHandoff(db, payload);
    const deps = await makeDeps(db);
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
          throw new Error("Checks API unavailable");
        }
        settlement.terminalized = true;
      },
    };
    deps.checkSettlements.set(ATTEMPT_ID, settlement);

    await expect(
      runReviewAttemptWorkflow(deps, makeRef(payload), stepHost({ failOn: "prepare" }).step, async () => {}),
    ).rejects.toThrow();

    expect(terminalizeCalls).toBeGreaterThanOrEqual(2);
    expect(settlement.terminalized).toBe(true);
    expect(settledMark(db)).toEqual(expect.any(Number));
  });
});

function unreadableLaunchDb(db: TestD1): D1Like {
  const row = {
    state: "launched",
    claimed_at_ms: 1,
    launched_at_ms: 2,
    persisted_at_ms: null,
    failed_at_ms: null,
    abandoned_at_ms: null,
    result_json: null,
    result_outcome: "persisted",
    check_owed_ms: null,
  };
  return {
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      if (!sql.includes("FROM review_launches") || !sql.includes("WHERE attempt_id = ?")) return statement;
      const unreadable: D1StatementLike = {
        bind: () => unreadable,
        first: async <T = Record<string, unknown>>() => row as T,
        all: async () => ({ results: [] }),
        run: async () => ({ results: [], meta: { changes: 0, last_row_id: 0 } }),
      };
      return unreadable;
    },
    batch: (statements: D1StatementLike[]) => db.batch(statements),
  };
}

describe("a rejection is not an observation", () => {
  async function launchedAttempt(db: TestD1): Promise<void> {
    const now = Date.now();
    expect(await claimReviewAttempt(db as never, ATTEMPT_ID, now, null)).toBe("claimed");
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, now)).toEqual({ ok: true });
  }

  function launchState(db: TestD1): string {
    const row = db.raw.prepare("SELECT state FROM review_launches WHERE attempt_id = ?").get(ATTEMPT_ID) as {
      state: string;
    } | null;
    return row?.state ?? "absent";
  }

  test("a step-level rejection concludes nothing over an unknown paid state", async () => {
    const db = await createSeededTestD1();
    const ref = makeRef(makePayload());
    await launchedAttempt(db);

    const outcome = await settleAttemptFailure(
      await makeDeps(db),
      ref,
      new Error("the review step timed out waiting for the reply"),
      {},
    );

    expect(outcome).toEqual({ kind: "unknown" });
    expect(failureRows(db)).toHaveLength(0);
    expect(launchState(db)).toBe("launched");
  });

  test("an unreadable launch row is unobservable: nothing settles, whatever the phase saw", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const ref = makeRef(payload);
    await seedHandoff(db, payload);
    await launchedAttempt(db);
    const deps = await makeDeps(db);
    deps.env = { ...deps.env, DB: unreadableLaunchDb(db) as never };

    const err = new BudgetExhaustedError(
      {
        kind: "budget-exhausted",
        cause: "runner-deadline",
        tier: "default",
        budgetWindow: "runner",
        budgetMs: 600_000,
        seatsDispatched: 1,
        seatsStopped: 1,
        changedLines: null,
      },
      "runner signalled budget exhaustion",
    );
    const phase = new AttemptPhaseError(
      {
        phase: "review",
        stage: "runner",
        headSha: null,
        secretValues: [],
        runnerStartedAt: 1,
        runnerReturned: true,
        runnerEffectiveBudgetMs: 600_000,
        changedLines: null,
        sendAttemptPublicationId: null,
      },
      err,
    );

    const outcome = await settleAttemptFailure(deps, ref, phase, {});

    expect(outcome).toEqual({ kind: "unknown" });
    expect(failureRows(db)).toHaveLength(0);
    expect(settledMark(db)).toBeNull();
    expect(launchState(db)).toBe("launched");
  });

  test("a returned status IS settled: the row records its outcome after the durable failure row", async () => {
    const db = await createSeededTestD1();
    const ref = makeRef(makePayload());
    await launchedAttempt(db);
    const err = new BudgetExhaustedError(
      {
        kind: "budget-exhausted",
        cause: "runner-deadline",
        tier: "default",
        budgetWindow: "runner",
        budgetMs: 600_000,
        seatsDispatched: 1,
        seatsStopped: 1,
        changedLines: null,
      },
      "runner signalled budget exhaustion",
    );
    const phase = new AttemptPhaseError(
      {
        phase: "review",
        stage: "runner",
        headSha: null,
        secretValues: [],
        runnerStartedAt: 1,
        runnerReturned: true,
        runnerEffectiveBudgetMs: 600_000,
        changedLines: null,
        sendAttemptPublicationId: null,
      },
      err,
    );

    const outcome = await settleAttemptFailure(await makeDeps(db), ref, phase, {});

    expect(outcome.kind).toBe("budget-exhausted");
    expect(failureRows(db)).toHaveLength(1);
    expect(launchState(db)).toBe("failed");
  });
});

// note: ---------------------------------------------------------------------------
// A persisted launch that never staged a publication (I-000684)
// ---------------------------------------------------------------------------

/**
 * note: The same database whose settle-once MARK write refuses AT EXECUTION, not at
 * preparation: the batch's INSERT has already run when the mark throws, so the only
 * way the assertions below can find neither is D1's transaction rolling the insert
 * back. Everything else (reads, the insert itself, the KV) still works.
 */
function withoutMarkWrites(db: TestD1): TestD1 {
  const wrap = (sql: string, st: D1StatementLike): D1StatementLike => ({
    bind: (...values: unknown[]) => wrap(sql, st.bind(...values)),
    first: () => st.first(),
    all: () => st.all(),
    run: async () => {
      if (/UPDATE review_attempt_handoffs/.test(sql)) throw new Error("D1 mark write failed");
      return st.run();
    },
  });
  return {
    prepare: (sql: string) => wrap(sql, db.prepare(sql)),
    batch: (statements: Parameters<TestD1["batch"]>[0]) => db.batch(statements),
    raw: db.raw,
  } as TestD1;
}

describe("a persisted launch that never staged a publication", () => {
  // note: Another attempt id, so this suite's `settledMark` helper stays scoped to
  // the delivery fixtures above.
  const UNPUBLISHED_ATTEMPT = "attempt-4d-unpublished";
  const WINDOW_CLOSED_AT = 10_000_000;

  /**
   * The crash window: the paid step persisted its result, the host died before
   * `collect` staged anything, and the attempt's own hard stop has passed. No
   * publication row exists for the scope/head, so the publication lane — which
   * only ever walks journal rows — cannot own the outcome. `check` carries the
   * Check identity the attempt froze, when it had one.
   */
  async function seedUnpublished(
    db: TestD1,
    payload: ReviewJobPayload,
    options: {
      attemptId?: string;
      check?: { attempt_key: string | null; generation: number };
    } = {},
  ): Promise<void> {
    const attemptId = options.attemptId ?? UNPUBLISHED_ATTEMPT;
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId,
      payload,
      nowMs: WINDOW_CLOSED_AT - 900_000,
      enqueuedMs: 0,
      deadlineMs: WINDOW_CLOSED_AT - 1,
    });
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET state = 'created' WHERE attempt_id = ?")
      .run(attemptId);
    db.raw
      .prepare(
        `INSERT INTO review_launches
           (attempt_id, state, claimed_at_ms, launched_at_ms, persisted_at_ms, result_json, result_outcome,
            attempt_key, attempt_generation)
         VALUES (?, 'persisted', ?, ?, ?, '{}', 'persisted', ?, ?)`,
      )
      .run(
        attemptId,
        WINDOW_CLOSED_AT - 900_000,
        WINDOW_CLOSED_AT - 800_000,
        WINDOW_CLOSED_AT - 700_000,
        options.check?.attempt_key ?? null,
        options.check?.generation ?? null,
      );
  }

  function unpublishedSettlement(
    db: TestD1,
    attemptId = UNPUBLISHED_ATTEMPT,
  ): { settled_ms: number | null; settled_effects: string | null } {
    return db.raw
      .prepare("SELECT settled_ms, settled_effects FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(attemptId) as { settled_ms: number | null; settled_effects: string | null };
  }

  test("the pass records the terminal failure a failed review gets and settles the attempt", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seedUnpublished(db, payload);
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT);

    // note: Visible and retryable instead of a paid result hidden behind a queued
    // Check: the failure row carries the reason, the head's abandoned claim stops a
    // silent re-pay, and the settle-once mark records the completion.
    expect(failureRows(db)).toHaveLength(1);
    expect(String(failureRows(db)[0]!.error)).toContain("publication never started");
    expect(failureRows(db)[0]!.head_sha).toBe(payload.head_sha!);
    expect(h.kvPuts.some((put) => put.value === "failed")).toBe(true);
    expect(unpublishedSettlement(db).settled_ms).toEqual(expect.any(Number));
    expect(JSON.parse(unpublishedSettlement(db).settled_effects!)).toEqual(["claim-stamp", "failure-row"]);

    // note: Completed: a second pass writes nothing more.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT + 60_000);
    expect(failureRows(db)).toHaveLength(1);
  });

  /** The reported shape: a persisted launch whose attempt froze a Check identity. */
  async function seedWithOpenCheck(db: TestD1, payload: ReviewJobPayload): Promise<string> {
    const claimed = await claimAttempt(db as never, {
      scope: {
        appId: payload.botRef!.appId,
        installationId: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.pr_number,
      },
      githubAppId: 424242,
      headSha: payload.head_sha!,
      triggeredBy: "octocat",
      action: "opened",
      holder: "consumer-run",
      nowMs: WINDOW_CLOSED_AT - 900_000,
      executionDeadlineMs: WINDOW_CLOSED_AT - 1,
    });
    if (claimed.kind !== "claimed") throw new Error(`expected a claimed Check row, got ${claimed.kind}`);
    const attemptId = claimed.attempt.identity.attemptId;
    const check = db.raw
      .prepare("SELECT attempt_key, generation FROM review_checks WHERE id = ?")
      .get(attemptId) as { attempt_key: string; generation: number };
    await seedUnpublished(db, payload, { check });
    return attemptId;
  }

  /** The Check lane's own transition: never written by this pass. */
  function concludeCheck(db: TestD1, attemptId: string): void {
    db.raw
      .prepare(
        `UPDATE review_checks SET terminal_ms = ?, recovery_state = 'done', desired = 'failure', observed = 'failure' WHERE id = ?`,
      )
      .run(WINDOW_CLOSED_AT - 60_000, attemptId);
  }

  test("a landed claim stamp keeps the row selected, and the settlement completes once the Check concludes", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = await seedWithOpenCheck(db, payload);
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    // note: The healthy OWNER pass lands the record and the head-wide claim stamp;
    // the open Check is the only obligation left, so nothing is certified yet.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT);
    expect(failureRows(db)).toHaveLength(1);
    expect(JSON.parse(unpublishedSettlement(db).settled_effects!)).toEqual(["claim-stamp", "failure-row"]);
    expect(unpublishedSettlement(db).settled_ms).toBeNull();
    const stamps = h.kvPuts.filter((put) => put.value === "failed").length;
    expect(stamps).toBe(1);

    // note: The row still owes the Check, so it stays in this lane: its landing
    // stamp proves ownership, so nothing here is unrepairable. Excluding it would
    // strand a settlement every remaining obligation is about to satisfy.
    const selected = await listUnpublishedLaunchSettlements(db, { deadlineBeforeMs: WINDOW_CLOSED_AT, limit: 25 });
    expect(selected.map((handoff) => handoff.attemptId)).toEqual([UNPUBLISHED_ATTEMPT]);

    // note: The Check concludes; the next pass lands that fact from durable state
    // and discharges the settlement. The stamp already landed, and only its owner
    // may write it — so this pass must not touch the KV key again.
    concludeCheck(db, attemptId);
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT + 60_000);

    expect(unpublishedSettlement(db).settled_ms).toEqual(expect.any(Number));
    expect(JSON.parse(unpublishedSettlement(db).settled_effects!)).toEqual(["check", "claim-stamp", "failure-row"]);
    expect(failureRows(db)).toHaveLength(1);
    expect(h.kvPuts.filter((put) => put.value === "failed").length).toBe(stamps);
  });

  test("a settlement whose claim stamp never landed leaves the lane", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = await seedWithOpenCheck(db, payload);
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    // note: Pass 1 is INTERRUPTED after the row and its fact landed: the claim write
    // faults, so the obligation stays open (no `settled_ms`).
    h.kvState.putError = new Error("KV write failed");
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT);
    expect(failureRows(db)).toHaveLength(1);
    expect(unpublishedSettlement(db).settled_ms).toBeNull();
    expect(JSON.parse(unpublishedSettlement(db).settled_effects!)).toEqual(["failure-row"]);

    // note: A clean pass cannot prove ownership of the stamp (KV has no
    // compare-and-set), so it writes nothing — and the row leaves the lane: only
    // the unwritable stamp is left. Its residual sentinel decays on its own TTL.
    h.kvState.putError = undefined;
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT + 60_000);
    expect(failureRows(db)).toHaveLength(1);
    expect(unpublishedSettlement(db).settled_ms).toBeNull();
    expect(JSON.parse(unpublishedSettlement(db).settled_effects!)).toEqual(["failure-row"]);

    // note: The Check concluding changes nothing: the settlement can never be
    // discharged, so recording its fact would only buy this batch another pass.
    concludeCheck(db, attemptId);
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT + 120_000);
    expect(failureRows(db)).toHaveLength(1);
    expect(unpublishedSettlement(db).settled_ms).toBeNull();
    expect(JSON.parse(unpublishedSettlement(db).settled_effects!)).toEqual(["failure-row"]);
  });

  test("an interrupted retry leaves exactly one failure row", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seedUnpublished(db, payload);
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    // note: The failure row lands, then the claim write faults: the pass leaves the
    // obligation open (no `settled_ms`) instead of certifying it.
    h.kvState.putError = new Error("KV write failed");
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT);
    expect(failureRows(db)).toHaveLength(1);
    expect(unpublishedSettlement(db).settled_ms).toBeNull();

    // note: Repeated passes never re-record the effect they can read back. The stamp is
    // owed and unrepairable by a non-owner (KV has no compare-and-set), so the settlement
    // stays incomplete — no duplicate failure row, no false completion.
    h.kvState.putError = undefined;
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT + 60_000);
    expect(failureRows(db)).toHaveLength(1);
    expect(unpublishedSettlement(db).settled_ms).toBeNull();

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT + 120_000);
    expect(failureRows(db)).toHaveLength(1);
  });

  test("a mark fault between the row and its fact lands neither, and the retry lands one", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seedUnpublished(db, payload);
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    // note: The settle-once mark throws WHILE the batch executes — after its INSERT has
    // run. One persistence step means the transaction takes the insert down with it:
    // a row without its fact could never be recognized by a later pass.
    await reconcileReviewRoute(
      { ...env, DB: withoutMarkWrites(db) as never, REVIEW_QUEUE: queue as never },
      WINDOW_CLOSED_AT,
    );
    expect(failureRows(db)).toHaveLength(0);
    expect(unpublishedSettlement(db).settled_ms).toBeNull();
    expect(unpublishedSettlement(db).settled_effects).toBeNull();

    // note: The healthy retry lands both, once — and a repeated pass changes nothing:
    // the completed settlement and the effects it records stay exactly as written.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT + 60_000);
    expect(failureRows(db)).toHaveLength(1);
    const completed = unpublishedSettlement(db);
    expect(completed.settled_ms).toEqual(expect.any(Number));

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT + 120_000);
    expect(failureRows(db)).toHaveLength(1);
    expect(unpublishedSettlement(db)).toEqual(completed);
  });

  test("a staged publication keeps the outcome with the publication lane", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seedUnpublished(db, payload);
    // note: `collect` DID stage the body — the M8 lane may still send it, so this pass
    // must not declare the review lost.
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms)
         VALUES ('pub-staged', ?, ?, ?, ?, ?, ?, 'review', 'prepared', '{}', NULL, 0, 'pending', ?, ?)`,
      )
      .run(
        payload.botRef!.appId,
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        payload.head_sha,
        WINDOW_CLOSED_AT - 800_000,
        WINDOW_CLOSED_AT - 800_000,
      );
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, WINDOW_CLOSED_AT);

    expect(failureRows(db)).toHaveLength(0);
    expect(unpublishedSettlement(db).settled_ms).toBeNull();
  });
});

// note: ---------------------------------------------------------------------------
// The recorded failure's retry entry (I-000684)
// ---------------------------------------------------------------------------

describe("the recorded publication failure leaves the head re-triggerable", () => {
  test("the reconcile → KV → consumer chain runs a fresh delivery for the same head", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    // note: The same crash window as above: persisted, window closed, nothing staged.
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: "attempt-4d-retryable",
      payload,
      nowMs: 9_100_000,
      enqueuedMs: 0,
      deadlineMs: 9_999_999,
    });
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET state = 'created' WHERE attempt_id = ?")
      .run("attempt-4d-retryable");
    db.raw
      .prepare(
        `INSERT INTO review_launches
           (attempt_id, state, claimed_at_ms, launched_at_ms, persisted_at_ms, result_json, result_outcome)
         VALUES (?, 'persisted', ?, ?, ?, '{}', 'persisted')`,
      )
      .run("attempt-4d-retryable", 9_100_000, 9_200_000, 9_300_000);
    // note: A KV whose writes are readable, seeded with the claim the worker wrote when it
    // enqueued this head: the consumer assertion below must observe what the pass wrote,
    // not a value the test installed.
    const kvStore = new Map<string, string>();
    const claimKey = idemKey({
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      head_sha: payload.head_sha!,
    });
    kvStore.set(claimKey, "1");
    const kv = {
      get: async (key: string) => kvStore.get(key) ?? null,
      put: async (key: string, value: string) => {
        kvStore.set(key, value);
      },
      delete: async (key: string) => {
        kvStore.delete(key);
      },
    };
    const env = { ...(await h.makeEnv({ DB: db as never })), IDEMPOTENCY_KV: kv as never };
    const queue = { send: async () => {} };
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, 10_000_000);

    expect(failureRows(db)).toHaveLength(1);
    // note: The pass replaced the enqueue marker with the abandon claim — "a commit that
    // was NOT reviewed, so a redelivery must enqueue again" (`src/contracts/idem.ts`).
    expect(kvStore.get(claimKey)).toBe("failed");

    const started: AttemptRef[] = [];
    const consumer = createReviewConsumer(env, h.testLog, {
      ...h.overrides,
      startAttempt: async (_deps, ref) => {
        started.push(ref);
        return "created";
      },
    });
    // note: A fresh delivery of the same head (its own attach identity) — what a
    // re-trigger is. It reads the claim the pass wrote and runs.
    await consumer(h.makeBatch(makePayload({ attachDeliveryId: "redelivery-2" })));

    expect(started).toHaveLength(1);
    expect(h.messageAckCalls).toHaveLength(1);
    expect(h.messageRetryCalls).toHaveLength(0);
  });
});

// note: ---------------------------------------------------------------------------
// QC findings on the publication-failure settlement (route pass)
// ---------------------------------------------------------------------------

/**
 * note: The same database that plays the overlapping-pass interleaving the moment a
 * stale pass re-reads its handoff: A's settlement lands and a fresh delivery re-claims
 * the head, BOTH before that pass decides whether to write the head-wide claim.
 */
function settleDuringFenceRead(
  db: TestD1,
  input: { deliveryKey: string; claimKey: string; claims: Map<string, string>; nowMs: number },
): TestD1 {
  let fired = false;
  const wrap = (statement: D1StatementLike): D1StatementLike => ({
    bind: (...values: unknown[]) => wrap(statement.bind(...values)),
    first: async () => {
      fired = true;
      await markAttemptSettled(
        db as never,
        input.deliveryKey,
        ["claim-stamp", "failure-row"],
        ["claim-stamp", "failure-row"],
        input.nowMs,
      );
      input.claims.set(input.claimKey, "1");
      return statement.first();
    },
    all: () => statement.all(),
    run: () => statement.run(),
  });
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return fired || !/FROM review_attempt_handoffs WHERE attempt_id = \?/.test(sql) ? statement : wrap(statement);
    },
    batch: (statements: Parameters<TestD1["batch"]>[0]) => db.batch(statements),
    raw: db.raw,
  } as TestD1;
}

describe("the publication-failure settlement under QC scrutiny", () => {
  const NOW = 10_000_000;

  /** A KV whose reads and writes share one readable map (a real claim store). */
  function claimKv(seed: Record<string, string> = {}): {
    claims: Map<string, string>;
    kv: { get: (key: string) => Promise<string | null>; put: (key: string, value: string) => Promise<void>; delete: (key: string) => Promise<void> };
    claimKey: string;
  } {
    const claims = new Map(Object.entries(seed));
    return {
      claims,
      kv: {
        get: async (key) => claims.get(key) ?? null,
        put: async (key, value) => {
          claims.set(key, value);
        },
        delete: async (key) => {
          claims.delete(key);
        },
      },
      claimKey: "",
    };
  }

  async function seed(db: TestD1, payload: ReviewJobPayload, attemptId = "attempt-qc"): Promise<void> {
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId,
      payload,
      nowMs: NOW - 900_000,
      enqueuedMs: 0,
      deadlineMs: NOW - 1,
    });
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET state = 'created' WHERE attempt_id = ?")
      .run(attemptId);
    db.raw
      .prepare(
        `INSERT INTO review_launches
           (attempt_id, state, claimed_at_ms, launched_at_ms, persisted_at_ms, result_json, result_outcome)
         VALUES (?, 'persisted', ?, ?, ?, '{}', 'persisted')`,
      )
      .run(attemptId, NOW - 900_000, NOW - 800_000, NOW - 700_000);
  }

  function settlement(db: TestD1, attemptId = "attempt-qc"): { settled_ms: number | null; settled_effects: string | null } {
    return db.raw
      .prepare("SELECT settled_ms, settled_effects FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(attemptId) as { settled_ms: number | null; settled_effects: string | null };
  }

  test("F-A: an unreadable claim is owed, not settled — and no non-owner repairs it", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seed(db, payload);
    const { claims, kv } = claimKv();
    const claimKey = idemKey({
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      head_sha: payload.head_sha!,
    });
    claims.set(claimKey, "1");
    let failReads = true;
    const env = {
      ...(await h.makeEnv({ DB: db as never })),
      IDEMPOTENCY_KV: {
        ...kv,
        get: async (key: string) => {
          if (failReads) throw new Error("KV read failed");
          return kv.get(key);
        },
      } as never,
    };
    const queue = { send: async () => {} };

    // note: The row and its fact land, but the claim could not be READ — so the stamp is
    // not a fact and the settlement must stay owed.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, NOW);
    expect(failureRows(db)).toHaveLength(1);
    expect(settlement(db).settled_ms).toBeNull();
    expect(claims.get(claimKey)).toBe("1");

    // residual: the owner's write faulted, so the stamp stays owed. A later pass cannot
    // prove it owns the settlement (KV has no compare-and-set), so no repair is attempted:
    // the head's stale sentinel remains, and exactly one failure row stands.
    failReads = false;
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, NOW + 60_000);
    expect(claims.get(claimKey)).toBe("1");
    expect(settlement(db).settled_ms).toBeNull();
    expect(failureRows(db)).toHaveLength(1);
  });

  test("F-B: a completed settlement never acts on the head-wide claim", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seed(db, payload);
    const { claims, kv } = claimKv();
    const claimKey = idemKey({
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      head_sha: payload.head_sha!,
    });
    claims.set(claimKey, "1");
    const env = { ...(await h.makeEnv({ DB: db as never })), IDEMPOTENCY_KV: kv as never };
    const queue = { send: async () => {} };

    // note: A settles and a fresh delivery re-claims the head before this stale pass
    // writes: it must leave the fresh claim alone.
    const racing = settleDuringFenceRead(db, {
      deliveryKey: deliveryKeyOf(payload),
      claimKey,
      claims,
      nowMs: NOW,
    });
    await reconcileReviewRoute({ ...env, DB: racing as never, REVIEW_QUEUE: queue as never }, NOW);

    expect(claims.get(claimKey)).toBe("1");
    expect(failureRows(db)).toHaveLength(1);
    expect(settlement(db).settled_ms).toEqual(expect.any(Number));
  });

  test("F-B3: only the pass that LANDED the record may abandon the head", async () => {
    // note: KV has no compare-and-set and cannot tell one delivery's `1` from another's,
    // so exclusivity is the rule: the insert winner writes, everyone else writes nothing.
    const settleOnce = async (payload: ReviewJobPayload, effects: string[] | null): Promise<TestD1> => {
      const db = await createSeededTestD1();
      await seed(db, payload);
      if (effects !== null) {
        db.raw
          .prepare(`UPDATE review_attempt_handoffs SET settled_effects = ? WHERE attempt_id = ?`)
          .run(JSON.stringify(effects), "attempt-qc");
      }
      return db;
    };
    const keyOf = (payload: ReviewJobPayload) =>
      idemKey({
        installation_id: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        pr_number: payload.pr_number,
        head_sha: payload.head_sha!,
      });

    // (1) The interleaving both seats named: B lost the insert, A stamped and settled,
    // and a fresh delivery re-claimed the head. B must write nothing.
    const settledDb = await settleOnce(makePayload(), ["claim-stamp", "failure-row"]);
    const settledKey = keyOf(makePayload());
    await markAttemptSettled(
      settledDb as never,
      deliveryKeyOf(makePayload()),
      ["claim-stamp", "failure-row"],
      ["claim-stamp", "failure-row"],
      NOW,
    );
    const settledKv = claimKv();
    settledKv.claims.set(settledKey, "1");
    expect(
      await stampOwedSettlementClaim(settledDb as never, settledKv.kv as never, {
        attemptId: "attempt-qc",
        key: settledKey,
        ttlSeconds: 1_800,
        owned: false,
      }),
    ).toBeNull();
    expect(settledKv.claims.get(settledKey)).toBe("1");

    // (2) The insert-losing pass whose guard still reads "unstamped, unsettled": it still
    // cannot prove its generation, so the head-wide key stays with the fresh delivery.
    const loserDb = await settleOnce(makePayload(), ["failure-row"]);
    const loserKey = keyOf(makePayload());
    const loserKv = claimKv();
    loserKv.claims.set(loserKey, "1");
    expect(
      await stampOwedSettlementClaim(loserDb as never, loserKv.kv as never, {
        attemptId: "attempt-qc",
        key: loserKey,
        ttlSeconds: 1_800,
        owned: false,
      }),
    ).toBeNull();
    expect(loserKv.claims.get(loserKey)).toBe("1");

    // (3) The insert WINNER does write — that is the pass the stamp exists for.
    const ownerDb = await settleOnce(makePayload(), ["failure-row"]);
    const ownerKey = keyOf(makePayload());
    const ownerKv = claimKv();
    ownerKv.claims.set(ownerKey, "1");
    expect(
      await stampOwedSettlementClaim(ownerDb as never, ownerKv.kv as never, {
        attemptId: "attempt-qc",
        key: ownerKey,
        ttlSeconds: 1_800,
        owned: true,
      }),
    ).toBe("written");
    expect(ownerKv.claims.get(ownerKey)).toBe("failed");
  });

  test("F-B3: an owner whose write faulted leaves the settlement owed, and no loser writes", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seed(db, payload);
    const claimKey = idemKey({
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      head_sha: payload.head_sha!,
    });
    const { claims, kv } = claimKv();
    claims.set(claimKey, "1");
    let failPut = true;
    const env = {
      ...(await h.makeEnv({ DB: db as never })),
      IDEMPOTENCY_KV: {
        ...kv,
        put: async (key: string, value: string) => {
          if (failPut) throw new Error("KV write failed");
          claims.set(key, value);
        },
      } as never,
    };
    const queue = { send: async () => {} };

    // note: The owner's write faults: the record stands, the stamp is owed.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, NOW);
    failPut = false;
    expect(failureRows(db)).toHaveLength(1);
    expect(settlement(db).settled_ms).toBeNull();
    expect(claims.get(claimKey)).toBe("1");

    // note: Every later pass is a non-owner: it may not repair the stamp (KV has no CAS).
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, NOW + 60_000);
    expect(failureRows(db)).toHaveLength(1);
    expect(settlement(db).settled_ms).toBeNull();
    expect(claims.get(claimKey)).toBe("1");
  });

  test("F-C2: a headless attempt's OWN staged journal keeps the publication ownership", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload({ head_sha: null });
    await seed(db, payload);
    // note: The attempt resolved its checkout head and staged its own body there: the
    // publication lane owns it, whatever the payload's head is (or is not).
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms)
         VALUES ('pub-own', ?, ?, ?, ?, ?, ?, 'review', 'prepared', ?, NULL, 0, 'pending', ?, ?)`,
      )
      .run(
        payload.botRef!.appId,
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        "fedcba9876543210fedcba9876543210fedcba98",
        JSON.stringify({ admittedAttemptId: "attempt-qc" }),
        NOW - 800_000,
        NOW - 800_000,
      );
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, NOW);

    expect(failureRows(db)).toHaveLength(0);
    expect(settlement(db).settled_ms).toBeNull();
  });

  test("F-N2: another tenant's journal never suppresses this attempt's failure", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seed(db, payload);
    // note: A FOREIGN tenant's journal — even one whose payload carries this attempt's id —
    // is outside the scope-prefixed identity arm and cannot keep this launch unrecorded.
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms)
         VALUES ('pub-foreign', ?, ?, ?, ?, ?, ?, 'review', 'prepared', ?, NULL, 0, 'pending', ?, ?)`,
      )
      .run(
        payload.botRef!.appId,
        999,
        "other-owner",
        "other-repo",
        99,
        payload.head_sha,
        JSON.stringify({ admittedAttemptId: "attempt-qc" }),
        NOW - 800_000,
        NOW - 800_000,
      );
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, NOW);

    expect(failureRows(db)).toHaveLength(1);
    expect(settlement(db).settled_ms).toEqual(expect.any(Number));
  });

  test("F-C: a prior generation's terminal journal never suppresses this attempt's failure", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await seed(db, payload);
    // note: One row exists per scope/head/kind; this is the OLD attempt's closed journal.
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms)
         VALUES ('pub-old', ?, ?, ?, ?, ?, ?, 'review', 'failed', ?, NULL, 1, 'done', ?, ?)`,
      )
      .run(
        payload.botRef!.appId,
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        payload.head_sha,
        JSON.stringify({ admittedAttemptId: "attempt-old" }),
        NOW - 800_000,
        NOW - 800_000,
      );
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, NOW);

    expect(failureRows(db)).toHaveLength(1);
    expect(String(failureRows(db)[0]!.error)).toContain("publication never started");
    expect(settlement(db).settled_ms).toEqual(expect.any(Number));
  });

  test("F-C: a headless persisted launch is still recorded, with no claim write", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload({ head_sha: null });
    await seed(db, payload);
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, NOW);

    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]!.head_sha).toBe("");
    // note: A headless delivery has no claim key: the settlement completes on the failure
    // row alone (no journal, no head-wide write, no body restage).
    expect(h.kvPuts.some((put) => put.value === "failed")).toBe(false);
    expect(settlement(db).settled_ms).toEqual(expect.any(Number));
    expect(JSON.parse(settlement(db).settled_effects!)).toEqual(["failure-row"]);
  });
});
