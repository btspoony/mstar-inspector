import { beforeEach, describe, expect, test } from "bun:test";

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
import type { D1Like, D1StatementLike } from "../../src/store/types";
import type { TestD1 } from "../store/helpers";

const { runReviewAttemptWorkflow } = await import("../../src/workflow/review");
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
