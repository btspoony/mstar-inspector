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
  listIncompleteSettlements,
  listLostReplyLaunchSettlements,
  listUnpublishedLaunchSettlements,
  markAttemptSettled,
  readAttemptHandoff,
  recordAttemptObservation,
  recordReviewedHead,
  reserveAttemptHandoff,
  stampOwedSettlementClaim,
} from "../../src/store/review-route-store";
import { FAILURE_SUMMARIES } from "../../src/contracts/failure-codes";
import { idemKey } from "../../src/contracts/idem";
import {
  HANDOFF_RECOVERY_AFTER_MS,
  ROUTE_RECOVERY_LIMIT,
  reconcileReviewRoute,
  type ReviewRouteLogFields,
} from "../../src/pipeline/route-reconcile";
import { LOST_REPLY_SETTLE_MIN_MS, REVIEW_ATTEMPT_CAP_MAX_MS } from "../../src/dashboard/runtime-config-store";
import { claimAttempt } from "../../src/store/review-checks";
import { acquireInflight } from "../../src/store/inflight-store";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type { AttemptRef, CheckSettlement, ProcessDeps } from "../../src/pipeline/review-attempt-execution";
import type { D1Like, D1StatementLike } from "../../src/store/types";
import type { TestD1 } from "../store/helpers";

const { runReviewAttemptWorkflow } = await import("../../src/workflow/review");
const { createReviewConsumer, priorAttemptStopEvidence } = await import("../../src/pipeline/consumer");
const { cleanupAttempt, settleAttemptFailure } = await import(
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
    budgetStartMs: Date.now(),
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
    createdMs: 1_000,
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

/** The launch row's capacity-revocation instant: the arm an expired admission row needs. */

/**
 * A database whose settle-once MARK write refuses at execution — and only that
 * write. Batch members run unwrapped, so a release batch that already landed the
 * landed fact survives the fault.
 */
/**
 * A database whose settlement-record insert refuses at execution — and only that
 * statement, so the batch stays atomic and the fault lands inside it.
 */
function insertFaults(db: TestD1): D1Like {
  const wrap = (sql: string, st: D1StatementLike): D1StatementLike => ({
    bind: (...values: unknown[]) => wrap(sql, st.bind(...values)),
    first: () => st.first(),
    all: () => st.all(),
    run: async () => {
      if (sql.includes("INSERT INTO review_failures")) throw new Error("insert unavailable");
      return st.run();
    },
  });
  return {
    prepare: (sql: string) => wrap(sql, db.prepare(sql)),
    batch: (statements: D1StatementLike[]) => db.batch(statements),
    raw: db.raw,
  } as unknown as D1Like;
}

function markWriteFaults(db: TestD1): D1Like {
  const wrap = (sql: string, st: D1StatementLike): D1StatementLike => ({
    bind: (...values: unknown[]) => wrap(sql, st.bind(...values)),
    first: () => st.first(),
    all: () => st.all(),
    run: async () => {
      if (sql.includes("settled_ms = CASE")) throw new Error("D1 mark write failed");
      return st.run();
    },
  });
  return {
    prepare: (sql: string) => wrap(sql, db.prepare(sql)),
    batch: (statements: D1StatementLike[]) => db.batch(statements),
    raw: db.raw,
  } as unknown as D1Like;
}
function revokedAt(db: TestD1, attemptId: string): number | null {
  const row = db.raw
    .prepare("SELECT revoked_ms FROM review_launches WHERE attempt_id = ?")
    .get(attemptId) as { revoked_ms: number | null } | null;
  return row?.revoked_ms ?? null;
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

  // The bounded retry lane (I-000709): a settlement whose observation read
  // keeps faulting must not consume the pass's whole batch ahead of newer
  // work. The seeded shape is the defect itself: more permanently faulting
  // rows than the 25-row limit, plus one healthy row behind them all.
  const FAULT_READ_MARKER = "FROM review_attempt_handoffs WHERE attempt_id = ?";
  // Per-pass record of which rows the pass actually attempted: every faulting
  // observation read appends the attempt id in selection order before it
  // throws. The tests drain `attempts` between passes, so "read in pass 1" and
  // "read again in pass 2" are separately provable — a cumulative count could
  // not tell a pass reading a row twice from a retry.
  function faultingObservationReads(db: TestD1, faultAttempts: Set<string>, attempts: string[]): TestD1 {
    return {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (!sql.includes(FAULT_READ_MARKER)) return stmt;
        return {
          bind(...values: unknown[]) {
            const attemptId = String(values[0]);
            if (faultAttempts.has(attemptId)) {
              attempts.push(attemptId);
              throw new Error("injected: the observation read faulted");
            }
            return stmt.bind(...values);
          },
          first: stmt.first.bind(stmt),
          all: stmt.all.bind(stmt),
          run: stmt.run.bind(stmt),
        } as D1StatementLike;
      },
      batch: (statements) => db.batch(statements),
      raw: db.raw,
    } as TestD1;
  }
  async function seedSettlementRow(db: TestD1, index: number, settlingMs: number): Promise<string> {
    // 40 distinct hex chars per index — the delivery key needs a distinct head.
    const headSha = String(index).padStart(4, "0").repeat(10);
    const payload = makePayload({ head_sha: headSha });
    const attemptId = `attempt-fair-${index}`;
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId,
      payload,
      nowMs: 900,
      createdMs: 900,
      enqueuedMs: 0,
      deadlineMs: Date.now() + 600_000,
    });
    db.raw.prepare("UPDATE review_attempt_handoffs SET settling_ms = ? WHERE attempt_id = ?").run(settlingMs, attemptId);
    db.raw
      .prepare(
        `INSERT INTO review_launches (attempt_id, state, claimed_at_ms, launched_at_ms, failed_at_ms, result_outcome)
         VALUES (?, 'failed', 890, 895, 899, 'failed')`,
      )
      .run(attemptId);
    return attemptId;
  }
  // Raw bun:sqlite row of the handoffs table — the shape the tests seed themselves.
  type StampRow = { settle_attempt_ms: number | null; settled_ms: number | null };
  function stampOf(db: TestD1, attemptId: string): StampRow {
    const row = db.raw.prepare("SELECT settle_attempt_ms, settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?").get(attemptId) as StampRow | null;
    if (row === null) throw new Error(`fixture: the seeded settlement row ${attemptId} is missing`);
    return row;
  }

  test("a stalled majority cannot starve the healthy settlement (two passes, I-000709)", async () => {
    const db = await createSeededTestD1();
    const faultIdsInOrder: string[] = [];
    const attempts: string[] = [];
    for (let index = 0; index < ROUTE_RECOVERY_LIMIT + 1; index++) {
      faultIdsInOrder.push(await seedSettlementRow(db, index, 900 + index));
    }
    const healthyId = await seedSettlementRow(db, 99, 950);
    const env = await h.makeEnv({ DB: faultingObservationReads(db, new Set(faultIdsInOrder), attempts) as never });
    const queue = { send: async () => {} };
    const now = 1_000 + 5 * 60_000 + 1;

    // Pass 1: the batch is exactly the 25 oldest unattempted faulting rows,
    // in selection order — the healthy row is reached only when a later pass
    // re-orders attempted rows behind unattempted ones.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, now);
    const pass1 = attempts.splice(0);
    expect(pass1).toEqual(faultIdsInOrder.slice(0, ROUTE_RECOVERY_LIMIT));
    expect(stampOf(db, healthyId).settle_attempt_ms).toBeNull();
    expect(stampOf(db, healthyId).settled_ms).toBeNull();

    // Pass 2 — the documented bound: unattempted rows go first, so the
    // healthy row settles while every faulting row is still owed.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, now);
    expect(stampOf(db, healthyId).settled_ms).not.toBeNull();
    const settled = db.raw.prepare("SELECT settled_effects FROM review_attempt_handoffs WHERE attempt_id = ?").get(healthyId) as {
      settled_effects: string;
    };
    const effects = JSON.parse(settled.settled_effects) as string[];
    expect(effects).toEqual(expect.arrayContaining(["failure-row", "claim-stamp"]));
    for (const faultId of faultIdsInOrder) {
      expect(stampOf(db, faultId).settle_attempt_ms).not.toBeNull();
      expect(stampOf(db, faultId).settled_ms).toBeNull();
    }
  });

  test("a persistently faulting row is retried after the others, never dropped (I-000709)", async () => {
    const db = await createSeededTestD1();
    const faultIds = new Set<string>();
    const attempts: string[] = [];
    for (let index = 0; index < ROUTE_RECOVERY_LIMIT + 1; index++) {
      faultIds.add(await seedSettlementRow(db, index, 900 + index));
    }
    const env = await h.makeEnv({ DB: faultingObservationReads(db, faultIds, attempts) as never });
    const queue = { send: async () => {} };
    const now = 1_000 + 5 * 60_000 + 1;

    // Pass 1: exactly the 25 oldest rows take their turn; the newest faulting
    // row is beyond the limit and is not attempted yet.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, now);
    const newest = `attempt-fair-${ROUTE_RECOVERY_LIMIT}`;
    const pass1 = attempts.splice(0);
    expect(pass1).toHaveLength(ROUTE_RECOVERY_LIMIT);
    expect(pass1).not.toContain(newest);

    // Pass 2: the previously unattempted row takes the first slot — every
    // stamp-less row leads — and the oldest faulting row is read AGAIN behind
    // it: retried after the others, never dropped.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, now);
    const pass2 = attempts.splice(0);
    expect(pass2.at(0)).toBe(newest);
    expect(pass2.at(1)).toBe("attempt-fair-0");
    for (const faultId of faultIds) {
      expect(stampOf(db, faultId).settled_ms).toBeNull();
    }
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
      createdMs: 1_000,
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
      createdMs: 1_000,
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
      createdMs: 1_000,
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

/**
 * The reconciler's own read/batch seam, for the interleavings a durable row
 * cannot otherwise be raced into. `afterSelection` runs on the first statement
 * the pass issues AFTER the lost-reply selector answered — i.e. after the
 * selected handoffs were mapped, which is exactly the window between the
 * selector's snapshot and the insert. `beforeBatch` runs before a batch
 * executes (the narrower window: after the pass's own re-read). Every query
 * passes straight through.
 */
function withReconcilerRace(
  db: TestD1,
  hooks: {
    afterSelection?: () => void;
    beforeBatch?: (statements: readonly D1StatementLike[]) => void | Promise<void>;
  },
): D1Like {
  let selected = false;
  return {
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      // Bound to the lost-reply selector's own shape: the unpublished lane's
      // selector shares the table, the join and the ORDER BY, and only this one
      // carries the pre-column launch-instant arm.
      const isLostReplySelector =
        sql.includes("FROM review_attempt_handoffs h") &&
        sql.includes("l.launched_at_ms <= ?2");
      if (isLostReplySelector) {
        let bound = statement;
        const racing: D1StatementLike = {
          bind: (...values: unknown[]) => {
            bound = bound.bind(...values);
            return racing;
          },
          first: <T = Record<string, unknown>>() => bound.first<T>(),
          run: <T = Record<string, unknown>>() => bound.run<T>(),
          all: async <T = Record<string, unknown>>() => {
            const answer = await bound.all<T>();
            selected = true;
            return answer;
          },
        };
        return racing;
      }
      if (selected && hooks.afterSelection !== undefined) {
        selected = false;
        hooks.afterSelection();
      }
      return statement;
    },
    batch: async (statements: D1StatementLike[]) => {
      await hooks.beforeBatch?.(statements);
      return db.batch(statements);
    },
  };
}

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
      {
        class: "failure",
        phase: "review",
        stage: "pipeline",
        headSha: null,
        runnerReturned: false,
        message: "the review step timed out waiting for the reply",
        sendAttemptPublicationId: null,
      },
      null,
    );

    // The row is `launched` and the paid state was never observed: unobservable.
    // No failure row is written — the reconciler is the ONE writer — and nothing
    // is concluded: the launch row is untouched, so the container and the
    // capacity slot stay held.
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

    const phase = {
      class: "budget",
      phase: "review",
      stage: "runner",
      headSha: null,
      runnerReturned: true,
      message: "runner signalled budget exhaustion",
      window: "runner",
      outcome: {
        kind: "budget-exhausted",
        cause: "runner-deadline",
        tier: "default",
        budgetWindow: "runner",
        budgetMs: 600_000,
        seatsDispatched: 1,
        seatsStopped: 1,
        changedLines: null,
      },
      sendAttemptPublicationId: null,
    } as const;

    const outcome = await settleAttemptFailure(deps, ref, phase, null);

    expect(outcome).toEqual({ kind: "unknown" });
    // The reason is recorded as an observation on the handoff row; the ATTEMPT is
    // what stays un-settled: no row, no mark, no terminal move, the slot held.
    expect(failureRows(db)).toHaveLength(0);
    const observed = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
    expect(observed?.observation?.message).toContain("runner signalled budget exhaustion");
    expect(settledMark(db)).toBeNull();
    expect(launchState(db)).toBe("launched");
  });

  test("a returned status IS settled: the row records its outcome after the durable failure row", async () => {
    const db = await createSeededTestD1();
    const ref = makeRef(makePayload());
    await launchedAttempt(db);
    const phase = {
      class: "budget",
      phase: "review",
      stage: "runner",
      headSha: null,
      runnerReturned: true,
      message: "runner signalled budget exhaustion",
      window: "runner",
      outcome: {
        kind: "budget-exhausted",
        cause: "runner-deadline",
        tier: "default",
        budgetWindow: "runner",
        budgetMs: 600_000,
        seatsDispatched: 1,
        seatsStopped: 1,
        changedLines: null,
      },
      sendAttemptPublicationId: null,
    } as const;

    const outcome = await settleAttemptFailure(await makeDeps(db), ref, phase, null);

    expect(outcome.kind).toBe("budget-exhausted");
    expect(failureRows(db)).toHaveLength(1);
    expect(launchState(db)).toBe("failed");
  });

  test("a settled failure frees the PR's slot, and a replay lands nothing new", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const ref = makeRef(payload);
    await launchedAttempt(db);
    await seedHandoff(db, payload);
    // The paid attempt activated, and its admission row is live but expired: an
    // activated attempt holds that row's slot until its launch row carries an
    // outcome.
    db.raw.prepare("UPDATE review_launches SET activated_ms = ? WHERE attempt_id = ?").run(Date.now(), ATTEMPT_ID);
    const holdKey = {
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      workspace_id: "default",
    };
    db.raw
      .prepare(
        `INSERT INTO review_inflight
           (installation_id, owner, repo, pr_number, workspace_id, attempt_id, head_sha, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, 'default', ?, ?, ?, ?)`,
      )
      .run(
        holdKey.installation_id,
        holdKey.owner,
        holdKey.repo,
        holdKey.pr_number,
        ATTEMPT_ID,
        payload.head_sha ?? "",
        new Date(Date.now() - 1_200_000).toISOString(),
        new Date(Date.now() - 1).toISOString(),
      );
    const admission = {
      systemCap: 32,
      workspaceCap: 16,
      ttlSeconds: 600,
      headSha: payload.head_sha ?? null,
      now: new Date().toISOString(),
    };
    // note: Held: the expired lease alone is not enough while the activated
    // attempt's launch row carries no outcome.
    expect(await acquireInflight(db as never, holdKey, { ...admission, attemptId: "attempt-fresh" })).toMatchObject({
      ok: false,
      reason: "pr-held",
    });

    const deps = await makeDeps(db);
    const phase = {
      class: "failure",
      phase: "review",
      stage: "pipeline",
      headSha: null,
      runnerReturned: true,
      message: "the review step returned a failing status",
      sendAttemptPublicationId: null,
    } as const;
    expect(await settleAttemptFailure(deps, ref, phase, null)).toEqual({ kind: "ok" });

    // note: ONE attempt-keyed record, and the launch row is no longer
    // `launched` — that move is what stops `PAID_STATE_UNKNOWN` holding the
    // slot. The row is NOT revoked: a revoked attempt can never be torn down or
    // retried, so the cleanup below could never release it.
    const settled = failureRows(db);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.id).toBe(ATTEMPT_ID);
    expect(launchState(db)).toBe("failed");
    expect(revokedAt(db, ATTEMPT_ID)).toBeNull();

    // note: A replay writes no second record and no second terminal outcome.
    expect(await settleAttemptFailure(deps, ref, phase, null)).toEqual({ kind: "ok" });
    expect(failureRows(db)).toEqual(settled);
    expect(launchState(db)).toBe("failed");

    // note: The cleanup that follows the settlement proves the container gone
    // and releases the admission row, so the next head's admission succeeds.
    await cleanupAttempt(deps, ref);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_inflight").get()).toEqual({ n: 0 });
    expect(await acquireInflight(db as never, holdKey, { ...admission, attemptId: "attempt-fresh" })).toEqual({
      ok: true,
    });
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
      createdMs: WINDOW_CLOSED_AT - 900_000,
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
// The lost-reply observation window (I-000694)
// ---------------------------------------------------------------------------

describe("a launched attempt whose paid reply was lost", () => {
  const CREATED_AT = 19_400_000;
  const LAUNCHED_AT = 20_000_000;
  const CAP_MS = 1_200_000;
  const DEADLINE_MS = CREATED_AT + CAP_MS;
  const WINDOW_MS = 900_000;
  const SETTLES_AT = DEADLINE_MS + WINDOW_MS;

  /**
   * The reported shape: the paid exec was issued, its reply never arrived, and
   * the live settlement deliberately left the row `launched` with no outcome —
   * because a paid child may still be running. `check` carries the attempt's
   * frozen Check identity when the attempt had one.
   */
  async function seedLaunched(
    db: TestD1,
    payload: ReturnType<typeof makePayload>,
    options: { attemptId: string; launchedAtMs: number; check?: { attempt_key: string; generation: number } },
  ): Promise<void> {
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: options.attemptId,
      payload,
      nowMs: CREATED_AT,
      createdMs: CREATED_AT,
      enqueuedMs: 0,
      deadlineMs: DEADLINE_MS,
    });
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET state = 'created' WHERE attempt_id = ?")
      .run(options.attemptId);
    db.raw
      .prepare(
        `INSERT INTO review_launches
           (attempt_id, state, claimed_at_ms, launched_at_ms, activated_ms, attempt_key, attempt_generation)
         VALUES (?, 'launched', ?, ?, ?, ?, ?)`,
      )
      .run(
        options.attemptId,
        CREATED_AT,
        options.launchedAtMs,
        CREATED_AT,
        options.check?.attempt_key ?? null,
        options.check?.generation ?? null,
      );
  }

  /** The attempt's Check row, claimed the way the consumer claims it. */
  async function openCheck(
    db: TestD1,
    payload: ReturnType<typeof makePayload>,
    nowMs: number,
  ): Promise<{ attempt_key: string; generation: number; id: string }> {
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
      nowMs,
      executionDeadlineMs: nowMs + 900_000,
    });
    if (claimed.kind !== "claimed") throw new Error(`expected a claimed Check row, got ${claimed.kind}`);
    const id = claimed.attempt.identity.attemptId;
    const row = db.raw
      .prepare("SELECT attempt_key, generation FROM review_checks WHERE id = ?")
      .get(id) as { attempt_key: string; generation: number };
    // note: Released, as the dead host's invocation leaves it.
    db.raw.prepare("UPDATE review_checks SET holder = NULL, lease_until_ms = NULL WHERE id = ?").run(id);
    return { ...row, id };
  }

  function launchRow(db: TestD1, attemptId: string): { state: string; result_outcome: string | null } {
    return db.raw
      .prepare("SELECT state, result_outcome FROM review_launches WHERE attempt_id = ?")
      .get(attemptId) as { state: string; result_outcome: string | null };
  }

  test("a row past the window settles once as a lost reply, and the launch row stops holding capacity", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply";
    const check = await openCheck(db, payload, LAUNCHED_AT);
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT, check });
    // note: The attempt's own admission row, expired by TTL: before the settlement
    // the launch row's `launched`/no-outcome shape keeps it holding its slot.
    const holdKey = {
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      workspace_id: "default",
    };
    const admission = {
      systemCap: 32,
      workspaceCap: 16,
      ttlSeconds: 600,
      headSha: payload.head_sha ?? null,
      now: new Date(SETTLES_AT).toISOString(),
    };
    db.raw
      .prepare(
        `INSERT INTO review_inflight
           (installation_id, owner, repo, pr_number, workspace_id, attempt_id, head_sha, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, 'default', ?, ?, ?, ?)`,
      )
      .run(
        holdKey.installation_id,
        holdKey.owner,
        holdKey.repo,
        holdKey.pr_number,
        attemptId,
        payload.head_sha ?? "",
        new Date(LAUNCHED_AT - 600_000).toISOString(),
        new Date(SETTLES_AT - 1).toISOString(),
      );
    // note: Held: an expired TTL is not enough while the launch row reads `launched`
    // with no outcome, so a fresh admission for the same PR is refused.
    expect(await acquireInflight(db as never, holdKey, { ...admission, attemptId: "attempt-refused" })).toMatchObject({
      ok: false,
      reason: "pr-held",
    });
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    // note: Visible and terminal: the failure row carries the approved code, its
    // record names the raw observation, and the launch row left `launched` — which
    // is what stops `PAID_STATE_UNKNOWN` holding the capacity slot.
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]!.error_code).toBe("review.paid.reply_lost");
    expect(failureRows(db)[0]!.track_id).toBe(attemptId);
    expect(failureRows(db)[0]!.error).toBe(
      "its attempt deadline plus the post-deadline grace elapsed, and no reply ever arrived",
    );
    expect(failureRows(db)[0]!.message).toContain("never came back");
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
    // note: That move IS the capacity release. Both arms of the hold are gone: the
    // launch row no longer reads `launched` with no outcome, and it is revoked, so
    // the expired admission row stops counting even though the attempt activated.
    const settledLaunch = db.raw
      .prepare("SELECT activated_ms, revoked_ms FROM review_launches WHERE attempt_id = ?")
      .get(attemptId) as { activated_ms: number | null; revoked_ms: number | null };
    expect(settledLaunch.revoked_ms).toEqual(expect.any(Number));
    // note: The takeover a successor performs for that freed slot succeeds.
    expect(await acquireInflight(db as never, holdKey, {
      ...admission,
      attemptId: "attempt-fresh",
      priorStopped: { attemptId },
    })).toEqual({ ok: true });
    // note: The Check keeps its obligation: the lane that concludes it owns the
    // terminal update, and this pass only made the attempt terminal.
    const checkRow = db.raw
      .prepare("SELECT terminal_ms, desired FROM review_checks WHERE id = ?")
      .get(check.id) as { terminal_ms: number | null; desired: string };
    expect(checkRow.terminal_ms).toBeNull();

    // note: Completed: a second pass writes nothing new — the failure row is
    // attempt-keyed and the launch row no longer matches the selector.
    const settled = failureRows(db);
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT + 60_000);
    expect(failureRows(db)).toEqual(settled);
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
  });

  test("the crash window's handoff is released, and stops being scheduled once its Check concludes", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-crash-window";
    const check = await openCheck(db, payload, LAUNCHED_AT);
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT, check });
    // The dead live settlement's exact state: it began settling, committed its
    // attempt-keyed record, and stopped before it could move the launch row.
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET settling_ms = ? WHERE attempt_id = ?")
      .run(SETTLES_AT - 10 * 60_000, attemptId);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error, error_code, track_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pipeline', 'the phase returned', 'review.internal.unclassified', ?, 'the phase returned', datetime('now'))`,
      )
      .run(
        attemptId,
        payload.targetId,
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        payload.head_sha,
        attemptId,
      );
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    const incomplete = { settlingBeforeMs: SETTLES_AT, limit: ROUTE_RECOVERY_LIMIT };
    const scheduled = async (at: number): Promise<string[]> =>
      (await listIncompleteSettlements(db as never, { ...incomplete, settlingBeforeMs: at })).map(
        (row) => row.attemptId,
      );

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    // note: The release, and only the release: one record, no revoke, no claim —
    // a non-owner writes none of the other's effects.
    expect(failureRows(db)).toHaveLength(1);
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
    expect(revokedAt(db, attemptId)).toBeNull();
    expect(h.kvPuts).toHaveLength(0);
    // note: The Check is still owed, so the handoff STAYS scheduled for the lane
    // that can land it — a settlement every remaining obligation can still
    // satisfy is never dropped.
    expect(await scheduled(SETTLES_AT)).toEqual([attemptId]);
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT + 60_000);
    expect(failureRows(db)).toHaveLength(1);
    expect(await scheduled(SETTLES_AT + 60_000)).toEqual([attemptId]);
    expect(h.kvPuts).toHaveLength(0);

    // note: The Check concludes. The next pass lands that fact, and the only
    // effect still owed is the head-wide stamp no non-owner may write — so the
    // row leaves the lane instead of being retried forever.
    db.raw
      .prepare(
        `UPDATE review_checks SET terminal_ms = ?, recovery_state = 'done', desired = 'failure', observed = 'failure' WHERE id = ?`,
      )
      .run(SETTLES_AT - 60_000, check.id);
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT + 120_000);

    expect(await scheduled(SETTLES_AT + 120_000)).toEqual([]);
    expect(failureRows(db)).toHaveLength(1);
    expect(h.kvPuts).toHaveLength(0);
  });

  test("a record a previous build wrote under a random id is reused, never duplicated", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-legacy-record";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    // The pre-change live settlement's row: a random id, the attempt in `track_id`.
    const legacyId = "9f1c0e6a-0000-4000-8000-000000000001";
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error, error_code, track_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pipeline', 'recorded by the old build', 'review.internal.unclassified', ?, 'recorded by the old build', datetime('now'))`,
      )
      .run(
        legacyId,
        payload.targetId,
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        payload.head_sha,
        attemptId,
      );
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    // note: The old row IS the settlement's record: reused byte-identical, with
    // the release on top and no second row for the same attempt.
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]!.id).toBe(legacyId);
    expect(String(failureRows(db)[0]!.error)).toBe("recorded by the old build");
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
    expect(h.kvPuts).toHaveLength(0);
  });

  test("a crash window over a legacy record releases once: no second record, no revoke, no claim", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-legacy-crash";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    noteContainerId(db, attemptId);
    seedHeldAdmission(db, payload, attemptId);
    // The dead live settlement's state: it began settling, and the record it left
    // is a previous build's (random id, the attempt only in `track_id`). The
    // launch row never moved.
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET settling_ms = ? WHERE attempt_id = ?")
      .run(SETTLES_AT - 10 * 60_000, attemptId);
    const legacyId = "6c1f0d2e-1111-4222-8333-944455556666";
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error, error_code, track_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pipeline', 'recorded by the old build', 'review.internal.unclassified', ?, 'recorded by the old build', datetime('now'))`,
      )
      .run(
        legacyId,
        payload.targetId,
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        payload.head_sha,
        attemptId,
      );
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    const ledgerOf = (): { settled_ms: number | null; settled_effects: string | null; settling_ms: number | null } =>
      db.raw
        .prepare("SELECT settled_ms, settled_effects, settling_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
        .get(attemptId) as { settled_ms: number | null; settled_effects: string | null; settling_ms: number | null };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    // ONE record: the legacy row, untouched — the guarded insert proved it exists,
    // so this pass created nothing.
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]!.id).toBe(legacyId);
    expect(String(failureRows(db)[0]!.error)).toBe("recorded by the old build");
    // The release landed, and the landed fact rode in the same batch as it.
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
    expect(JSON.parse(ledgerOf().settled_effects ?? "[]") as string[]).toContain("failure-row");
    // A pass that created no record revokes nothing and claims nothing.
    expect(revokedAt(db, attemptId)).toBeNull();
    expect(h.kvPuts).toHaveLength(0);
    // The PR is still held: taking the slot is the stop proof's call, not a
    // silent handover from a non-owner.
    expect(
      await acquireInflight(db as never, holdOf(payload), { ...admissionAt(SETTLES_AT, payload), attemptId: "attempt-fresh" }),
    ).toMatchObject({ ok: false, reason: "pr-held" });

    // A second pass changes nothing: one record, still no revoke, still no claim.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT + 60_000);
    expect(failureRows(db)).toHaveLength(1);
    expect(revokedAt(db, attemptId)).toBeNull();
    expect(h.kvPuts).toHaveLength(0);
  });

  test("an insert fault revokes nothing and leaves the slot held", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-insert-fault";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    noteContainerId(db, attemptId);
    seedHeldAdmission(db, payload, attemptId);
    const env = await h.makeEnv({ DB: insertFaults(db) as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    // note: The insert never ran: the batch rolled back, so the row was neither
    // retired nor released, and the lane retries it on the next pass.
    expect(failureRows(db)).toHaveLength(0);
    expect(launchRow(db, attemptId)).toEqual({ state: "launched", result_outcome: null });
    expect(revokedAt(db, attemptId)).toBeNull();
    expect(
      await acquireInflight(db as never, holdOf(payload), { ...admissionAt(SETTLES_AT, payload), attemptId: "attempt-fresh" }),
    ).toMatchObject({ ok: false, reason: "pr-held" });

    // note: The clean retry is the owner: one record, and the revoke that only a
    // creating pass may write.
    await reconcileReviewRoute(
      { ...(await h.makeEnv({ DB: db as never })), REVIEW_QUEUE: queue as never },
      SETTLES_AT + 60_000,
    );
    expect(failureRows(db)).toHaveLength(1);
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
    expect(revokedAt(db, attemptId)).toEqual(expect.any(Number));
  });

  test("the release records its landed fact in the batch, so a mark fault still proves it", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-fact-before-mark";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET settling_ms = ? WHERE attempt_id = ?")
      .run(SETTLES_AT - 10 * 60_000, attemptId);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error, error_code, track_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pipeline', 'recorded elsewhere', 'review.internal.unclassified', ?, 'recorded elsewhere', datetime('now'))`,
      )
      .run(
        attemptId,
        payload.targetId,
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        payload.head_sha,
        attemptId,
      );
    // note: The MARK write is what fails: the release batch itself (with the
    // landed fact) is unaffected, because batch statements execute unwrapped.
    const env = await h.makeEnv({ DB: markWriteFaults(db) as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    const ledger = db.raw
      .prepare("SELECT settled_ms, settled_effects FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(attemptId) as { settled_ms: number | null; settled_effects: string | null };
    // note: The batch's own fact is the only proof left: the mark never landed,
    // and the next pass reads this to know the record exists.
    expect(JSON.parse(ledger.settled_effects ?? "[]") as string[]).toContain("failure-row");
    expect(ledger.settled_ms).toBeNull();
    expect(failureRows(db)).toHaveLength(1);
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
  });

  test("a per-stage recheck row is not the attempt's settlement record", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-recheck-only";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    for (const stageId of [`${attemptId}:recheck`, `${attemptId}:usage`]) {
      db.raw
        .prepare(
          `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error, error_code, track_id, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pipeline', 'a sub-record', 'review.internal.unclassified', ?, 'a sub-record', datetime('now'))`,
        )
        .run(
          stageId,
          payload.targetId,
          payload.installation_id,
          payload.owner,
          payload.repo,
          payload.pr_number,
          payload.head_sha,
          attemptId,
        );
    }
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    // note: Sub-stage rows share the attempt's `track_id` but are not the
    // settlement record — the `<attempt>:<stage>` namespace is excluded by shape,
    // so the lane still writes the attempt's own one row.
    expect(failureRows(db).map((row) => row.id).sort()).toEqual(
      [`${attemptId}:recheck`, `${attemptId}:usage`, attemptId].sort(),
    );
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
  });

  test("a row past its deadline but inside the post-deadline grace is left alone", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-young";
    const check = await openCheck(db, payload, LAUNCHED_AT);
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT, check });
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    // note: The deadline passed but the grace has not elapsed: a paid child may
    // still be finishing its post-runner reads, and the live settlement's hold
    // is exactly what protects it.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT - 1);

    expect(failureRows(db)).toHaveLength(0);
    expect(launchRow(db, attemptId)).toEqual({ state: "launched", result_outcome: null });
  });

  test("a row at the floor window with its deadline still ahead is left alone", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-live-deadline";
    const check = await openCheck(db, payload, LAUNCHED_AT);
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT, check });
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at) VALUES ('review.lostReply.settle_ms', ?, ?)`,
      )
      .run(String(LOST_REPLY_SETTLE_MIN_MS), new Date().toISOString());
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    // note: Well past `launched + min` — where the launch-anchored window used to
    // settle — but one ms short of the attempt's deadline: the child is still
    // live, so nothing is declared lost.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, DEADLINE_MS - 1);

    expect(failureRows(db)).toHaveLength(0);
    expect(launchRow(db, attemptId)).toEqual({ state: "launched", result_outcome: null });
  });

  test("a settlement fault after the batch is logged, and the row stays terminal", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-fault-after-batch";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    // note: The fault lands AFTER the guarded batch committed `failed`/revoked:
    // the head-wide claim stamp is the first effect that writes KV.
    h.kvState.putError = new Error("kv unavailable");
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    const before = h.logLines.length;

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never, log: h.testLog }, SETTLES_AT);

    // note: The attempt is already terminal — only the incomplete-settlement lane
    // can finish it — so the fault must be visible, not swallowed.
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
    const faultLine = h.logLines.slice(before).find((line) => line.fields.attempt_id === attemptId);
    expect(faultLine?.msg).toContain("incomplete-settlement lane owes the rest");
    expect(faultLine?.fields.error_cause).toBe("kv unavailable");
    expect(faultLine?.fields.head_sha).toBe(payload.head_sha!);
  });

  test("a pre-column row with no frozen deadline settles once the cap ceiling plus the window has passed", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-unanchored";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    // note: A pre-column row: it froze no deadline, so the only bound that can
    // prove its child dead is the cap's own validation ceiling above its launch.
    db.raw.prepare("UPDATE review_attempt_handoffs SET deadline_ms = NULL WHERE attempt_id = ?").run(attemptId);
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    const bound = LAUNCHED_AT + REVIEW_ATTEMPT_CAP_MAX_MS + WINDOW_MS;

    // note: Older than the window but younger than the ceiling: a paid child
    // admitted under a large cap may still be live, so it is left alone.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, bound - 1);
    expect(failureRows(db)).toHaveLength(0);
    expect(launchRow(db, attemptId)).toEqual({ state: "launched", result_outcome: null });

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, bound);

    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]!.error_code).toBe("review.paid.reply_lost");
    expect(String(failureRows(db)[0]!.error)).toContain("no frozen deadline");
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
  });

  test("a row that terminalized between the selector and the batch writes nothing", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-persisted";
    const check = await openCheck(db, payload, LAUNCHED_AT);
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT, check });
    // note: The paid exec's result lands between the SELECT and the settlement
    // batch: the launch row terminalizes to `persisted` just before the guarded
    // move runs. No failure record may be written and nothing may be revoked —
    // the persisted result stays publishable.
    let raced = false;
    const racingDb = new Proxy(db as unknown as D1Like, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "batch" || raced) return value;
        raced = true;
        return async (statements: D1StatementLike[]) => {
          db.raw
            .prepare(
              `UPDATE review_launches SET state = 'persisted', result_outcome = 'persisted', persisted_at_ms = ?, result_json = '{}'
                WHERE attempt_id = ? AND state = 'launched'`,
            )
            .run(SETTLES_AT, attemptId);
          return db.batch(statements);
        };
      },
    });
    const env = await h.makeEnv({ DB: racingDb as never });
    const queue = { send: async () => {} };

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    expect(failureRows(db)).toHaveLength(0);
    const untouched = db.raw
      .prepare("SELECT state, result_outcome, revoked_ms FROM review_launches WHERE attempt_id = ?")
      .get(attemptId) as { state: string; result_outcome: string | null; revoked_ms: number | null };
    expect(untouched).toEqual({ state: "persisted", result_outcome: "persisted", revoked_ms: null });
    const settlement = db.raw
      .prepare("SELECT settled_ms, settling_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(attemptId) as { settled_ms: number | null; settling_ms: number | null };
    expect(settlement.settled_ms).toBeNull();
    expect(settlement.settling_ms).toBeNull();
  });

  test("the window is the operator setting, read per pass", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-configured";
    const check = await openCheck(db, payload, LAUNCHED_AT);
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT, check });
    const longer = DEADLINE_MS + 1_800_000;
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at) VALUES ('review.lostReply.settle_ms', ?, ?)`,
      )
      .run(String(1_800_000), new Date().toISOString());
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };

    // note: Inside the DEFAULT window but short of the saved one — the stored
    // value is what the pass judges from.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);
    expect(failureRows(db)).toHaveLength(0);

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, longer);
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]!.error_code).toBe("review.paid.reply_lost");
  });

  test("a row whose failure record is already durable is released, and never recorded twice", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-recorded";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    noteContainerId(db, attemptId);
    // note: The crash window's shape: a settlement recorded this attempt's failure
    // and died before it could move the launch row — the slot stays held, and
    // nothing can release it (the revoke is guarded on `launched`).
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error, error_code, track_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pipeline', 'recorded elsewhere', 'review.paid.reply_lost', ?, 'recorded elsewhere', datetime('now'))`,
      )
      .run(
        attemptId,
        payload.targetId,
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        payload.head_sha,
        attemptId,
      );
    // note: The attempt's own admission row, expired, still holding the PR.
    seedHeldAdmission(db, payload, attemptId);
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    const selector = { deadlineBeforeMs: SETTLES_AT, limit: ROUTE_RECOVERY_LIMIT };
    const admission = admissionAt(SETTLES_AT, payload);

    expect((await listLostReplyLaunchSettlements(db as never, selector)).map((row) => row.attemptId)).toEqual([
      attemptId,
    ]);
    expect(await acquireInflight(db as never, holdOf(payload), { ...admission, attemptId: "attempt-fresh" })).toMatchObject({
      ok: false,
      reason: "pr-held",
    });

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    // note: The record stands untouched (ONE row), and the slot is released by
    // the launch row's terminal move. The row is NOT revoked: a revoked attempt
    // can never be torn down (`reviewAttemptSandbox` refuses it), which is the
    // veto this branch must not hand the cleanup or the successor.
    expect(failureRows(db)).toHaveLength(1);
    expect(String(failureRows(db)[0]!.error)).toBe("recorded elsewhere");
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
    expect(revokedAt(db, attemptId)).toBeNull();
    // note: The foreign settlement is not adopted into this lane's: no claim
    // stamp is written for a record this pass never landed.
    expect(h.kvPuts).toHaveLength(0);
    // note: The expired lease still holds the PR: the release is the launch row,
    // and who may take the slot is the stop proof's call, not a silent handover.
    expect(await acquireInflight(db as never, holdOf(payload), { ...admission, attemptId: "attempt-fresh" })).toMatchObject({
      ok: false,
      reason: "pr-held",
    });

    // note: The release is the ONE move: the selector has nothing left to reach.
    expect(await listLostReplyLaunchSettlements(db as never, selector)).toEqual([]);
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT + 60_000);
    expect(failureRows(db)).toHaveLength(1);
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });

    // note: The teardown the release left possible: cleanup proves the container
    // gone, and the admission row goes with it — a revoked row could never get
    // here, which is what kept the PR held forever.
    const deps = await makeDeps(db);
    const ref = makeRef(payload);
    await cleanupAttempt(deps, { ...ref, attemptId, inflight: { ...ref.inflight!, attemptId } });
    expect(h.sandbox.destroyCalls).toBe(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_inflight").get()).toEqual({ n: 0 });
    expect(await acquireInflight(db as never, holdOf(payload), { ...admission, attemptId: "attempt-fresh" })).toEqual({
      ok: true,
    });
  });

  /** The container this attempt minted: what the teardown and stop proofs address. */
  function noteContainerId(db: TestD1, attemptId: string): void {
    db.raw
      .prepare("UPDATE review_launches SET sandbox_id = ? WHERE attempt_id = ?")
      .run(`review-${attemptId}`, attemptId);
  }

  /** The attempt's own admission row, expired but still holding its PR. */
  function seedHeldAdmission(db: TestD1, payload: ReviewJobPayload, attemptId: string): void {
    db.raw
      .prepare(
        `INSERT INTO review_inflight
           (installation_id, owner, repo, pr_number, workspace_id, attempt_id, head_sha, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, 'default', ?, ?, ?, ?)`,
      )
      .run(
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        attemptId,
        payload.head_sha ?? "",
        new Date(LAUNCHED_AT - 600_000).toISOString(),
        new Date(SETTLES_AT - 1).toISOString(),
      );
  }

  function holdOf(payload: ReviewJobPayload) {
    return {
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      workspace_id: "default",
    };
  }

  function admissionAt(nowMs: number, payload: ReviewJobPayload) {
    return {
      systemCap: 32,
      workspaceCap: 16,
      ttlSeconds: 600,
      headSha: payload.head_sha ?? null,
      now: new Date(nowMs).toISOString(),
    };
  }

  test("a released row's slot is handed back by the successor's own stop proof", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-successor";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    noteContainerId(db, attemptId);
    seedHeldAdmission(db, payload, attemptId);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error, error_code, track_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pipeline', 'recorded elsewhere', 'review.paid.reply_lost', ?, 'recorded elsewhere', datetime('now'))`,
      )
      .run(
        attemptId,
        payload.targetId,
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        payload.head_sha,
        attemptId,
      );
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    const holdKey = holdOf(payload);
    const admission = admissionAt(SETTLES_AT, payload);

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
    // note: Still held: the released row was NOT revoked, so the expired lease
    // keeps counting until someone proves where the container is.
    expect(await acquireInflight(db as never, holdKey, { ...admission, attemptId: "attempt-fresh" })).toMatchObject({
      ok: false,
      reason: "pr-held",
    });

    // note: The production stop-proof path decides it: the container answers
    // stopped, the attempt is marked revoked, and only then does the takeover
    // acquire — the same sequence a successor runs for a live failure's attempt.
    const sandbox = { revoke: async () => ({ revoked: true, running: false }) };
    expect(
      await priorAttemptStopEvidence(db as never, async () => sandbox as never, undefined, attemptId),
    ).toBe("revoked");
    expect(
      await acquireInflight(db as never, holdKey, {
        ...admission,
        attemptId: "attempt-fresh",
        priorStopped: { attemptId },
      }),
    ).toEqual({ ok: true });
  });

  test("the phase's observation is what the row records, and the reconciler is its only writer", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-cause";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });

    // The LIVE settlement, on the real branch: the launch row proves the paid
    // step was sent and cannot say what happened, so nothing is concluded — and
    // the phase's own cause is recorded as an OBSERVATION, before the reconciler
    // can only see that no reply arrived.
    const cause = "Error: runner rpc failed: check the diff (after 1200ms)";
    const deps = await makeDeps(db);
    const ref = { ...makeRef(payload), attemptId };
    expect(
      await settleAttemptFailure(
        deps,
        ref,
        {
          class: "unknown",
          phase: "collect",
          stage: "runner",
          headSha: payload.head_sha!,
          runnerReturned: false,
          containerStateUnknown: true,
          code: "review.paid.reply_lost",
          message: `the attempt container could not be read at the review step (reply-lost) — ${cause} — nothing may be concluded`,
          cause,
        },
        null,
      ),
    ).toEqual({ kind: "unknown" });
    // The phase wrote NO row: one writer, and it has not run yet.
    expect(failureRows(db)).toHaveLength(0);
    // Nothing was released yet: the launch row still holds the slot.
    expect(launchRow(db, attemptId)).toEqual({ state: "launched", result_outcome: null });

    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    // ONE row, composed from the observation: the observed cause in `error` AND in
    // the author-facing `message`, with the mechanism vocabulary elided there.
    const settled = failureRows(db);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.id).toBe(attemptId);
    expect(settled[0]!.error_code).toBe("review.paid.reply_lost");
    expect(String(settled[0]!.error)).toContain(cause);
    expect(String(settled[0]!.error)).not.toContain("no reply ever arrived");
    // The author's sentence carries the CAUSE, not the generic summary alone.
    expect(String(settled[0]!.message)).toContain("Runner rpc failed: check the diff");
    expect(String(settled[0]!.message)).not.toBe(FAILURE_SUMMARIES["review.paid.reply_lost"]);
    // ... and names no internal mechanism: neither the wrapper's vocabulary nor
    // the millisecond suffix survives into the author's line.
    expect(String(settled[0]!.message)).not.toContain("container");
    expect(String(settled[0]!.message)).not.toContain("reply-lost");
    expect(String(settled[0]!.message)).not.toContain("1200ms");
    expect(String(settled[0]!.message)).not.toContain("Error:");
    // ... and the release it owns did happen: the terminal move, the revoke and
    // the head's claim stamp all landed, so the settlement can discharge.
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
    const released = db.raw
      .prepare("SELECT revoked_ms FROM review_launches WHERE attempt_id = ?")
      .get(attemptId) as { revoked_ms: number | null };
    expect(released.revoked_ms).toEqual(expect.any(Number));
    const mark = db.raw
      .prepare("SELECT settled_ms, settled_effects FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(attemptId) as { settled_ms: number | null; settled_effects: string | null };
    expect(JSON.parse(mark.settled_effects ?? "[]") as string[]).toEqual(
      expect.arrayContaining(["failure-row", "claim-stamp"]),
    );
    expect(h.kvPuts.map((put) => put.value)).toContain("failed");
    expect(mark.settled_ms).toEqual(expect.any(Number));

    // A second pass writes nothing new.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT + 60_000);
    expect(failureRows(db)).toEqual(settled);
  });

  test("a comment-triggered lost reply lands on the head it actually reviewed, not the Check identity", async () => {
    // The reported shape: a `@bot review` comment carries NO head, so the
    // delivery cannot name one. Admission pinned the GitHub Check identity to a
    // commit the PR ledger already knew, the checkout landed on a NEWER one, and
    // the superseded Check's handoff failed — so the frozen identity keeps the
    // OLDER commit. The failure must name the commit that was reviewed, or the
    // row is filed under a commit nobody reviewed and disappears from the
    // current-head view.
    const db = await createSeededTestD1();
    const payload = makePayload({ head_sha: null, triggered_by: "issue_comment", action: "created" });
    const attemptId = "attempt-lost-reply-comment";
    const supersededSha = "b".repeat(40);
    const reviewedSha = "a".repeat(40);
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    // The identity the attempt froze: the Check's key, whose tuple head is the
    // admitted commit (index 5 of the canonical attempt key).
    const key = JSON.stringify([
      TEST_APP_ID,
      123,
      TEST_OWNER,
      TEST_REPO,
      TEST_PR_NUMBER,
      supersededSha,
      "octocat",
      "created",
    ]);
    db.raw
      .prepare("UPDATE review_launches SET attempt_key = ?, attempt_generation = 1 WHERE attempt_id = ?")
      .run(key, attemptId);
    // What prepare recorded once the checkout resolved its head.
    expect(
      await recordReviewedHead(db as never, { attemptId, headSha: reviewedSha, nowMs: LAUNCHED_AT }),
    ).toBe(true);

    const env = await h.makeEnv({ DB: db as never });
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: { send: async () => {} } as never }, SETTLES_AT);

    const settled = failureRows(db);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.error_code).toBe("review.paid.reply_lost");
    // The row names the reviewed head, so the head-scoped query sees it...
    expect(settled[0]!.head_sha).toBe(reviewedSha);
    // ... and never the identity's superseded commit.
    expect(settled[0]!.head_sha).not.toBe(supersededSha);
  });

  test("a settlement whose attempt froze no identity keeps the empty-head rule", async () => {
    // The other half of the rule: an attempt that never learned a head names
    // none, so the reader must answer nothing rather than invent a commit.
    const db = await createSeededTestD1();
    const payload = makePayload({ head_sha: null, triggered_by: "issue_comment", action: "created" });
    const attemptId = "attempt-lost-reply-no-identity";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });

    const env = await h.makeEnv({ DB: db as never });
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: { send: async () => {} } as never }, SETTLES_AT);

    const settled = failureRows(db);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.head_sha).toBe("");
  });

  test("an observation recorded after the fallback row exists is synced into that same row once", async () => {
    // The other order. A recovery pass can win the row before the invocation has
    // recorded anything (only reachable when that invocation never got to its
    // settlement — otherwise it observes at the deadline, strictly before this
    // window opens). The pass writes the ONE row it is allowed to write, stating
    // only what IT saw; the phase's cause then arrives and the pass's
    // late-observation sync applies it to that same row.
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-reconciler-first";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });

    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    const settled = failureRows(db);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.id).toBe(attemptId);
    // No observation existed, so the pass states only what IT observed — the
    // deadline and the grace — and never invents a cause. The generic summary is
    // the honest fallback, and no mechanism word appears in it.
    expect(String(settled[0]!.error)).toContain("no reply ever arrived");
    expect(settled[0]!.message).toBe(FAILURE_SUMMARIES["review.paid.reply_lost"]);
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });

    // The phase records what it actually saw. An existing row is NOT a reason to
    // refuse it — the write lands, and the sync needs no clock: the row is
    // selected while its content is still the reconciler's own fallback, and
    // `nowMs` here even sits BEHIND the row's insert instant.
    expect(
      await recordAttemptObservation(db as never, {
        attemptId,
        observation: {
          code: "review.paid.reply_lost",
          message:
            "the attempt container could not be read at the review step (reply-lost) — Error: late cause (after 900ms) — nothing may be concluded",
          cause: "Error: late cause (after 900ms)",
        },
        nowMs: SETTLES_AT,
      }),
    ).toBe(true);

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT + 60_000);
    const synced = failureRows(db);
    // ONE row, same identity: the observation was applied, never a second row.
    expect(synced).toHaveLength(1);
    expect(synced[0]!.id).toBe(attemptId);
    expect(String(synced[0]!.error)).toContain("late cause");
    expect(String(synced[0]!.message)).toContain("Late cause");
    expect(synced[0]!.message).not.toBe(FAILURE_SUMMARIES["review.paid.reply_lost"]);

    // ... and once is once: the synced row leaves the selector, so a further pass
    // issues no failure-row write at all.
    let rowWrites = 0;
    const counting: D1Like = {
      prepare: (sql: string) => {
        if (sql.startsWith("UPDATE review_failures")) rowWrites += 1;
        return db.prepare(sql);
      },
      batch: (statements: D1StatementLike[]) => db.batch(statements),
    } as unknown as D1Like;
    const again = await h.makeEnv({ DB: counting as never });
    await reconcileReviewRoute({ ...again, REVIEW_QUEUE: queue as never }, SETTLES_AT + 120_000);
    expect(rowWrites).toBe(0);
    expect(failureRows(db)).toEqual(synced);
  });

  test("a phase settling after the lane's fallback row still records its cause, and the sync repairs that row", async () => {
    // The ordering the settlement's guard must NOT block: the lost-reply lane
    // settles the attempt first with its placeholder sentence, and the invocation
    // only then records what it actually saw. The placeholder is not a story — it
    // exists until exactly this cause arrives — so the observation lands and the
    // sync rewrites that same row in place: one row, the real cause.
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-fallback-first";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });

    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);
    const fallback = failureRows(db);
    expect(fallback).toHaveLength(1);
    expect(String(fallback[0]!.error)).toContain("no reply ever arrived");

    // The phase now settles the same attempt. Recording its cause must succeed:
    // the row above is the lane's placeholder, not a lane-authored story.
    const deps = await makeDeps(db);
    const cause = "Error: runner rpc failed: read the diff (after 1200ms)";
    expect(
      await settleAttemptFailure(
        deps,
        { ...makeRef(payload), attemptId },
        {
          class: "unknown",
          phase: "collect",
          stage: "runner",
          headSha: payload.head_sha!,
          runnerReturned: false,
          containerStateUnknown: true,
          code: "review.paid.reply_lost",
          message: `the attempt container could not be read at the review step (reply-lost) — ${cause} — nothing may be concluded`,
          cause,
        },
        null,
      ),
    ).toEqual({ kind: "unknown" });
    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
    expect(handoff?.observation?.cause).toBe(cause);

    // The sync lane replaces the placeholder text in place.
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT + 60_000);
    const synced = failureRows(db);
    expect(synced).toHaveLength(1);
    expect(synced[0]!.id).toBe(attemptId);
    expect(String(synced[0]!.error)).toContain("read the diff");
    expect(String(synced[0]!.error)).not.toContain("no reply ever arrived");
  });

  test("a delayed workflow settling an already-settled handoff writes no second row", async () => {
    // The gate the late-cause path actually relies on. A recovery pass can win
    // the row while the invocation is still running (or after it died); when that
    // invocation's settlement step finally runs it must find the mark and stop,
    // so ONE row exists and only the late-observation sync ever touches it. The
    // direct-write tests above pin the sync; this one pins the OTHER half — that
    // the workflow's own settle step cannot mint a rival row for the same
    // attempt once the mark is durable.
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-delayed-workflow";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });

    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);
    const settled = failureRows(db);
    expect(settled).toHaveLength(1);
    expect(String(settled[0]!.error)).toContain("no reply ever arrived");

    // The settlement writes through `deps.failureStore` (not the DB handle), so
    // that is what has to be observed: a row count alone proves nothing here,
    // because the insert is attempt-keyed with `ON CONFLICT DO NOTHING`.
    const settlementWrites = async (at: TestD1, id: string): Promise<number> => {
      const deps = await makeDeps(at);
      let writes = 0;
      deps.failureStore = {
        ...deps.failureStore,
        record: async (input) => {
          writes += 1;
          await createFailureStore(at as never).record(input);
        },
      };
      const host = stepHost({ failOn: "prepare" });
      await runReviewAttemptWorkflow(deps, { ...makeRef(payload), attemptId: id }, host.step, async () => {});
      expect(host.runs).toContain("settle-failure");
      return writes;
    };

    // The gate: with the mark durable, the settlement writes NOTHING.
    expect(await settlementWrites(db, attemptId)).toBe(0);
    expect(failureRows(db)).toEqual(settled);

    // ...and the control that proves this probe CAN see a write: an unsettled
    // handoff of the same shape takes the same step and records its row.
    const fresh = await createSeededTestD1();
    await seedHandoff(fresh, payload);
    expect(await settlementWrites(fresh, ATTEMPT_ID)).toBe(1);
    expect(failureRows(fresh)).toHaveLength(1);

    // Now the phase's cause arrives. The sync applies it to that same row —
    // still ONE row — which is what makes the gate safe rather than lossy.
    await recordAttemptObservation(db as never, {
      attemptId,
      observation: {
        code: "review.paid.reply_lost",
        message:
          "the attempt container could not be read at the review step (reply-lost) — Error: delayed cause (after 900ms) — nothing may be concluded",
        cause: "Error: delayed cause (after 900ms)",
      },
      nowMs: SETTLES_AT,
    });
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT + 60_000);
    const synced = failureRows(db);
    expect(synced).toHaveLength(1);
    expect(synced[0]!.id).toBe(attemptId);
    expect(String(synced[0]!.error)).toContain("delayed cause");
  });

  test("a cause recorded AFTER the selector ran still reaches the one row the pass writes", async () => {
    // The reported race, at its widest: the selector reads the handoff (nothing
    // observed yet), and only then does the live phase record its cause. The pass
    // must not write the generic fallback over a cause that is already durable —
    // so it re-reads the handoff at insertion time instead of trusting the
    // selector's snapshot.
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-late-cause";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });

    const cause = "Error: runner rpc failed: check the diff (after 1200ms)";
    const observedMessage = `the attempt container could not be read at the review step (reply-lost) — ${cause} — nothing may be concluded`;
    let recorded = false;
    const racing = withReconcilerRace(db, {
      afterSelection: () => {
        if (recorded) return;
        recorded = true;
        db.raw
          .prepare(
            "UPDATE review_attempt_handoffs SET payload_json = json_set(payload_json, '$.attemptObservation', json(?)) WHERE attempt_id = ?",
          )
          .run(JSON.stringify({ code: "review.paid.reply_lost", message: observedMessage, cause }), attemptId);
      },
    });

    const env = await h.makeEnv({ DB: racing as never });
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: { send: async () => {} } as never }, SETTLES_AT);

    expect(recorded).toBe(true);
    const settled = failureRows(db);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.error_code).toBe("review.paid.reply_lost");
    expect(String(settled[0]!.error)).toContain(cause);
    expect(String(settled[0]!.message)).toContain("Runner rpc failed: check the diff");
  });

  test("a cause recorded between the pass's read and its insert is synced onto the row it wrote", async () => {
    // The narrow window the read-gate cannot cover: the phase records after the
    // pass has read the handoff but before its insert lands. The row is then
    // written from the pass's own sentence, and the pass's late-observation sync
    // applies the cause to that same row — same id, one row, one story.
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-mid-insert";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });

    const observedCause = "Error: socket hang up (after 800ms)";
    const observedMessage = `the attempt container could not be read at the review step (reply-lost) — ${observedCause} — nothing may be concluded`;
    let injected = false;
    // The pass composes the record BEFORE its release batch, so the window this
    // test targets is "composition done, batch not yet run": the release batch is
    // the first one this pass issues.
    const racing = withReconcilerRace(db, {
      beforeBatch: async () => {
        if (injected) return;
        injected = true;
        // The phase's own writer. Its stamp deliberately sits BEHIND the row's
        // `created_at` — the sync selects on content, never on time.
        await recordAttemptObservation(db as never, {
          attemptId,
          observation: { code: "review.paid.reply_lost", message: observedMessage, cause: observedCause },
          nowMs: SETTLES_AT,
        });
      },
    });

    const env = await h.makeEnv({ DB: racing as never });
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: { send: async () => {} } as never }, SETTLES_AT);

    expect(injected).toBe(true);
    const settled = failureRows(db);
    expect(settled).toHaveLength(1);
    expect(String(settled[0]!.error)).toBe(observedMessage);
    expect(String(settled[0]!.message)).toContain("Socket hang up");
    expect(String(settled[0]!.message)).not.toContain("800ms");
    // Same row identity throughout: the sync is an UPDATE, never a second row.
    expect(settled[0]!.id).toBe(attemptId);
  });

  test("a failed handoff read skips the attempt, and the next pass settles it with the observation", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-read-fault";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });

    const cause = "Error: runner rpc failed: check the diff (after 1200ms)";
    const observedMessage = `the attempt container could not be read at the review step (reply-lost) — ${cause} — nothing may be concluded`;

    // The composition read fails. A lost read is NOT evidence that nothing was
    // observed, so the pass must skip this attempt rather than settle it from the
    // selector's older snapshot — the next pass composes from the observation.
    // One-shot on purpose: letting later reads succeed is what separates "skipped"
    // from "settled from the stale snapshot".
    let faults = 1;
    let injected = false;
    const racing = withReconcilerRace(db, {
      afterSelection: () => {
        if (injected) return;
        injected = true;
        db.raw
          .prepare(
            `UPDATE review_attempt_handoffs
                SET payload_json = json_set(payload_json, '$.attemptObservation', json(?)),
                    updated_ms = ?
              WHERE attempt_id = ?`,
          )
          .run(JSON.stringify({ code: "review.paid.reply_lost", message: observedMessage, cause }), SETTLES_AT, attemptId);
      },
    });
    const faulty: D1Like = {
      prepare: (sql: string) => {
        if (faults > 0 && sql.includes("FROM review_attempt_handoffs WHERE attempt_id = ?")) {
          faults -= 1;
          throw new Error("handoff read unavailable");
        }
        return racing.prepare(sql);
      },
      batch: (statements: D1StatementLike[]) => racing.batch(statements),
    } as unknown as D1Like;

    const env = await h.makeEnv({ DB: faulty as never });
    const queue = { send: async () => {} };
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    expect(injected).toBe(true);
    // Nothing was written from the snapshot, and the row is not marked landed.
    expect(failureRows(db)).toHaveLength(0);
    const ledger = db.raw
      .prepare("SELECT settled_ms, settled_effects FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(attemptId) as { settled_ms: number | null; settled_effects: string | null };
    expect(JSON.parse(ledger.settled_effects ?? "[]") as string[]).not.toContain("failure-row");
    // The lane that owed it still selects it: the attempt is terminal, its
    // settlement mark is set, and a later pass finishes it.
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
    expect(ledger.settled_ms).toBeNull();

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT + HANDOFF_RECOVERY_AFTER_MS + 1);

    const settled = failureRows(db);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.id).toBe(attemptId);
    expect(settled[0]!.error_code).toBe("review.paid.reply_lost");
    expect(String(settled[0]!.error)).toContain(cause);
    expect(String(settled[0]!.message)).toContain("Runner rpc failed: check the diff");
    const done = db.raw
      .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(attemptId) as { settled_ms: number | null };
    expect(done.settled_ms).toEqual(expect.any(Number));
  });

  test("a cause carrying the delimiter and a negative reason keeps its distinguishing text", async () => {
    // The cause itself uses the throw sites' ` — ` convention: it is carried as
    // data, never split, so the whole reason reaches the author-facing sentence.
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-negative-cause";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    await recordAttemptObservation(db as never, {
      attemptId,
      observation: {
        code: "review.paid.reply_lost",
        message:
          "the attempt container could not be read at the review step (reply-lost) — Error: request rejected — no capacity available (after 1200ms) — nothing may be concluded",
        cause: "Error: request rejected — no capacity available (after 1200ms)",
      },
      nowMs: Date.now(),
    });

    const env = await h.makeEnv({ DB: db as never });
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: { send: async () => {} } as never }, SETTLES_AT);

    const settled = failureRows(db);
    expect(settled).toHaveLength(1);
    expect(String(settled[0]!.message).toLowerCase()).toContain("request rejected");
    expect(String(settled[0]!.message)).toContain("no capacity available");
    // The wrapper and the elapsed envelope are still gone.
    expect(String(settled[0]!.message)).not.toContain("container");
    expect(String(settled[0]!.message)).not.toContain("nothing may be concluded");
    expect(String(settled[0]!.message)).not.toContain("1200ms");
  });

  test("a failure row another producer wrote is never promoted into this lane's settlement", async () => {
    // The exact promotion shape: a foreign row PLUS a `failure-row` fact on the
    // row's own settlement ledger. The re-admission arm that used to exist here
    // (row-OR-fact) would select this attempt, find the insert a no-op, and then
    // stamp the head-wide claim as its own — adopting a failure it never wrote.
    // With one writer there is no promotion: the row is never landed or marked
    // again and no claim is written. What this pass owes is only the RELEASE —
    // the record it inherited authorises the launch row's move.
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-foreign";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET settled_effects = ? WHERE attempt_id = ?")
      .run(JSON.stringify(["failure-row"]), attemptId);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error, error_code, track_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pipeline', 'recorded elsewhere', 'review.paid.reply_lost', ?, 'recorded elsewhere', datetime('now'))`,
      )
      .run(
        attemptId,
        payload.targetId,
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        payload.head_sha,
        attemptId,
      );

    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    expect(failureRows(db)).toHaveLength(1);
    expect(String(failureRows(db)[0]!.error)).toBe("recorded elsewhere");
    // The release the inherited record authorises: terminal, and deliberately
    // NOT revoked — the successor's stop proof is what takes the row.
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
    expect(revokedAt(db, attemptId)).toBeNull();
    expect(h.kvPuts).toHaveLength(0);

    // The sync lane must not adopt it either: the phase's observation arrives
    // after the foreign row exists, and the row is not the reconciler's own
    // fallback shape — so the pass leaves it byte-identical.
    const before = failureRows(db)[0]!;
    await recordAttemptObservation(db as never, {
      attemptId,
      observation: {
        code: "review.paid.reply_lost",
        message:
          "the attempt container could not be read (reply-lost) — Error: the real cause (after 500ms) — its result is not collected",
        cause: "Error: the real cause (after 500ms)",
      },
      nowMs: SETTLES_AT,
    });
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT + 60_000);
    expect(failureRows(db)).toEqual([before]);
    expect(launchRow(db, attemptId)).toEqual({ state: "failed", result_outcome: "failed" });
  });

  test("an observation stamped behind the row's creation still syncs onto the fallback row", async () => {
    // The reported second-boundary interleaving: the pass read the handoff at
    // .100, the phase recorded its cause at .900, and the fallback row was
    // inserted a second LATER — so the observation's `updated_ms` sits behind
    // the row's `created_at`. No clock decides the lane: the row is selected
    // while its content is still the reconciler's own fallback, and it leaves
    // the lane the moment it carries the observation.
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-second-boundary";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });

    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);

    const fallback = failureRows(db);
    expect(fallback).toHaveLength(1);
    expect(String(fallback[0]!.error)).toBe(
      "its attempt deadline plus the post-deadline grace elapsed, and no reply ever arrived",
    );

    // The observation lands with a stamp BEFORE the row's own creation — the
    // ordering the old timestamp predicate could never see.
    await recordAttemptObservation(db as never, {
      attemptId,
      observation: {
        code: "review.paid.reply_lost",
        message:
          "the attempt container could not be read (reply-lost) — Error: boundary cause (after 700ms) — its result is not collected",
        cause: "Error: boundary cause (after 700ms)",
      },
      nowMs: CREATED_AT,
    });

    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT + 60_000);
    const synced = failureRows(db);
    expect(synced).toHaveLength(1);
    expect(synced[0]!.id).toBe(attemptId);
    expect(String(synced[0]!.error)).toContain("boundary cause");
    expect(String(synced[0]!.message)).toContain("Boundary cause");
  });

  test("a cause that reads like a disposition is kept verbatim", async () => {
    // `nothing was charged because the account is suspended` is the CAUSE the
    // throw site carried, not a wrapper disposition: it reaches the
    // author-facing sentence verbatim.
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-disposition-cause";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });
    await recordAttemptObservation(db as never, {
      attemptId,
      observation: {
        code: "review.paid.reply_lost",
        message:
          "the attempt container could not be read (reply-lost) — Error: request rejected — nothing was charged because the account is suspended (after 1200ms)",
        cause: "Error: request rejected — nothing was charged because the account is suspended (after 1200ms)",
      },
      nowMs: SETTLES_AT,
    });

    const env = await h.makeEnv({ DB: db as never });
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: { send: async () => {} } as never }, SETTLES_AT);

    const settled = failureRows(db);
    expect(settled).toHaveLength(1);
    expect(String(settled[0]!.message)).toContain("Request rejected — nothing was charged because the account is suspended");
    expect(String(settled[0]!.message)).not.toContain("1200ms");
  });

  test("a faulting selector and a faulting sync are logged, and the pass still completes", async () => {
    // Both catches in the repair lane used to swallow their reason: a lane that
    // failed every pass was invisible. Each fault now emits one line — the
    // selector's carries the cause (it covers every selected row), the per-row
    // sync's carries the attempt it left selected.
    //
    // A local sink typed to the pass's own port: the shared harness recorder is
    // PR-scoped, and these two lines deliberately name no PR.
    const lines: Array<{ fields: ReviewRouteLogFields; msg: string }> = [];
    const log = {
      info(fields: ReviewRouteLogFields, msg: string): void {
        lines.push({ fields, msg });
      },
    };
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-inert-lane";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });

    // A row that already settled from the fallback, so the sync lane has work.
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);
    expect(failureRows(db)).toHaveLength(1);
    await recordAttemptObservation(db as never, {
      attemptId,
      observation: {
        code: "review.paid.reply_lost",
        message: "the attempt container could not be read (reply-lost) — Error: never synced (after 10ms)",
        cause: "Error: never synced (after 10ms)",
      },
      nowMs: SETTLES_AT,
    });

    // The selector fault: every row of the lane is invisible for this pass.
    const selectorFault = new Error("late-observation selector unavailable");
    const syncFault = new Error("late-observation sync unavailable");
    const failing: D1Like = {
      prepare: (sql: string) => {
        if (sql.includes("$.attemptObservation.message') IS NOT NULL")) throw selectorFault;
        if (sql.startsWith("UPDATE review_failures SET error_code")) throw syncFault;
        return db.prepare(sql);
      },
      batch: (statements: D1StatementLike[]) => db.batch(statements),
    } as unknown as D1Like;
    const faultyEnv = await h.makeEnv({ DB: failing as never });

    await reconcileReviewRoute({ ...faultyEnv, REVIEW_QUEUE: queue as never, log }, SETTLES_AT + 60_000);

    const selectorLine = lines.find(
      (line) => line.fields.event === "review_late_observation_selector_failed",
    );
    expect(selectorLine?.fields.error_cause).toBe("late-observation selector unavailable");
    expect(selectorLine?.msg).toContain("next pass retries");
    // The pass completed: the row is untouched and still selected for the next pass.
    expect(failureRows(db)).toHaveLength(1);
    expect(String(failureRows(db)[0]!.error)).not.toContain("never synced");

    // Now let the selector work and fault only the sync: the per-row line names
    // the attempt and the cause, and the row stays selected.
    const syncOnly: D1Like = {
      prepare: (sql: string) => {
        if (sql.startsWith("UPDATE review_failures SET error_code")) throw syncFault;
        return db.prepare(sql);
      },
      batch: (statements: D1StatementLike[]) => db.batch(statements),
    } as unknown as D1Like;
    const syncEnv = await h.makeEnv({ DB: syncOnly as never });
    lines.length = 0;

    await reconcileReviewRoute({ ...syncEnv, REVIEW_QUEUE: queue as never, log }, SETTLES_AT + 120_000);

    const syncLine = lines.find((line) => line.fields.event === "review_late_observation_sync_failed");
    expect(syncLine?.fields.attempt_id).toBe(attemptId);
    expect(syncLine?.fields.error_cause).toBe("late-observation sync unavailable");
    expect(syncLine?.msg).toContain("stays selected");
    expect(failureRows(db)).toHaveLength(1);
    expect(String(failureRows(db)[0]!.error)).not.toContain("never synced");
  });

  test("a faulting repair still lets the lanes after it run in the same pass", async () => {
    // The repair lane sits in the MIDDLE of the pass: the comment-claim hand-back
    // runs after it. A fault that ended the pass early would strand every claim
    // behind it, so the assertion is not "it logged" but "the later lane ran" —
    // the queued re-delivery is the observable proof.
    const db = await createSeededTestD1();
    const payload = makePayload();
    const attemptId = "attempt-lost-reply-fault-mid-pass";
    await seedLaunched(db, payload, { attemptId, launchedAtMs: LAUNCHED_AT });

    // A row that already settled from the fallback, so the sync lane has work.
    const env = await h.makeEnv({ DB: db as never });
    const queue = { send: async () => {} };
    await reconcileReviewRoute({ ...env, REVIEW_QUEUE: queue as never }, SETTLES_AT);
    await recordAttemptObservation(db as never, {
      attemptId,
      observation: {
        code: "review.paid.reply_lost",
        message: "the attempt container could not be read (reply-lost) — Error: unsynced (after 10ms)",
        cause: "Error: unsynced (after 10ms)",
      },
      nowMs: SETTLES_AT,
    });

    // An orphaned comment claim, old enough for the hand-back lane to pick up.
    const orphan = makePayload({
      head_sha: null,
      action: "created",
      triggered_by: "issue_comment",
      comment_id: 9511,
    });
    const consumedMs = SETTLES_AT + 60_000 - HANDOFF_RECOVERY_AFTER_MS - 1;
    db.raw
      .prepare(
        `INSERT INTO comment_trigger_claims
           (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms, consumed_ms)
         VALUES (?, ?, ?, ?, ?, 'consumed', ?, 0, ?, ?, ?)`,
      )
      .run(
        orphan.installation_id,
        orphan.owner,
        orphan.repo,
        orphan.pr_number,
        9511,
        JSON.stringify(orphan),
        1,
        1,
        consumedMs,
      );

    // The repair's selector faults, exactly as it would on a D1 hiccup.
    const failing: D1Like = {
      prepare: (sql: string) => {
        if (sql.includes("$.attemptObservation.message') IS NOT NULL")) {
          throw new Error("late-observation selector unavailable");
        }
        return db.prepare(sql);
      },
      batch: (statements: D1StatementLike[]) => db.batch(statements),
    } as unknown as D1Like;
    const faultyEnv = await h.makeEnv({ DB: failing as never });
    const sent: ReviewJobPayload[] = [];
    const lines: Array<{ fields: ReviewRouteLogFields; msg: string }> = [];
    const log = {
      info(fields: ReviewRouteLogFields, msg: string): void {
        lines.push({ fields, msg });
      },
    };

    await reconcileReviewRoute(
      { ...faultyEnv, REVIEW_QUEUE: { send: async (message: ReviewJobPayload) => void sent.push(message) } as never, log },
      SETTLES_AT + 60_000,
    );

    // The fault happened...
    expect(
      lines.some((line) => line.fields.event === "review_late_observation_selector_failed"),
    ).toBe(true);
    // ...AND the lane behind it ran: the claim is back in the outbox and was sent.
    const claim = db.raw
      .query("SELECT state, consumed_ms FROM comment_trigger_claims WHERE comment_id = 9511")
      .get() as { state: string; consumed_ms: number | null };
    expect(claim).toEqual({ state: "queued", consumed_ms: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.comment_id).toBe(9511);
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
      createdMs: 9_100_000,
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
      createdMs: NOW - 900_000,
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
