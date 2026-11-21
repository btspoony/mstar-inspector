/**
 * The attempt's ONE absolute hard stop: frozen at admission from the original
 * Queue send stamp plus the operator's end-to-end cap, carried on the delivery's
 * handoff row and on the Check attempt row, read by every step instead of being
 * re-derived.
 *
 * These cases pin four behaviours:
 *  - the paid exec is bounded by that instant, and a kill at it is a CONFIRMED
 *    stop (a returned status, recorded as one);
 *  - a lost reply is `unknown` — no failure row, no Check conclusion, no
 *    destruction;
 *  - a resumed prepare keeps the frozen instant even when the cap seam and the
 *    clock move;
 *  - a redelivery replays the recorded deadline rather than reading a cap the
 *    operator may have changed in between.
 */
import { beforeEach, describe, expect, test } from "bun:test";

// Load shim FIRST: the execution module statically imports ./sandbox → the
// workerd builtin `cloudflare:workers`. Every double is injected.
import "../helpers/cloudflare-workers-mock";

import {
  SHA,
  TEST_APP_ID,
  TEST_OWNER,
  TEST_PR_NUMBER,
  TEST_REPO,
  createSeededTestD1,
  registerGitOpsCommands,
} from "../helpers/consumer-fixtures";
import { createConsumerHarness, failureRows, makePayload } from "../helpers/consumer-harness";
import { withFrozenClock } from "../helpers/clock";
import { createArtifactStore } from "../../src/store/artifact-store";
import { createFailureStore } from "../../src/store/failure-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import { readReviewLaunch } from "../../src/pipeline/review-attempt";
import {
  CHECK_TERMINALIZE_DEFAULT,
  REVIEW_ATTEMPT_CAP_DEFAULT_MS,
  REVIEW_ATTEMPT_CAP_KEY,
  getReviewAttemptCap,
} from "../../src/dashboard/runtime-config-store";
import { postRunnerReserveMs, readReviewAttemptCapMs } from "../../src/review-budget";
import { BudgetExhaustedError, AttemptUnknownError } from "../../src/pipeline/review-attempt";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type {
  AttemptRef,
  CheckHandle,
  PrepareStep,
  ProcessDeps,
} from "../../src/pipeline/review-attempt-execution";

// Dynamic: the module graph under test must load after the workerd shim.
const {
  createCheckSettlement,
  prepareAttempt,
  reviewAttempt,
  settleAttemptFailure,
  cleanupAttempt,
} = await import("../../src/pipeline/review-attempt-execution");
const { createReviewConsumer, WorkflowCreateFailedError } = await import("../../src/pipeline/consumer");

const ATTEMPT_ID = "attempt-hard-stop-01";
const CAP_MS = 900_000;
const SCOPE: Scope = {
  appId: TEST_APP_ID,
  installationId: 123,
  owner: TEST_OWNER,
  repo: TEST_REPO,
  prNumber: TEST_PR_NUMBER,
};

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

/** The seeded D1 plus this case's doubles (a fresh host unless `share` is given). */
async function makeDeps(share?: { db: Awaited<ReturnType<typeof createSeededTestD1>> }): Promise<{
  deps: ProcessDeps;
  db: Awaited<ReturnType<typeof createSeededTestD1>>;
}> {
  const db = share?.db ?? (await createSeededTestD1());
  const deps: ProcessDeps = {
    env: await h.makeEnv({ DB: db as never }),
    store: createArtifactStore(db as never),
    targets: createTargetsStore(db as never),
    failureStore: createFailureStore(db as never),
    appCommenters: new Map(),
    createAppCommenter: () => h.fakeCommenter,
    log: h.testLog,
    getSandbox: h.overrides.getSandbox,
    selectPrHead: async () => null,
    findIncrementBase: async () => null,
    runnerConfigs: new Map(),
    checkSettlements: new Map(),
    credentials: new Map(),
  };
  deps.appCommenters.set(TEST_APP_ID, {
    commenter: h.fakeCommenter,
    fingerprint: "test-fingerprint",
    githubAppId: 424242,
  });
  deps.runnerConfigs.set(TEST_APP_ID, {
    appCfg: { keys: { ark: ["sk-test"] }, modelChain: "ark/deepseek-v4-flash" },
    modelOverrides: undefined,
    customProviders: undefined,
  });
  return { deps, db };
}

/** The attempt's data input, with its FROZEN deadline supplied by the caller. */
function makeRef(payload: ReviewJobPayload, deadlineMs: number): AttemptRef {
  return {
    attemptId: ATTEMPT_ID,
    payload,
    level: "default",
    roundStartedAt: Date.now(),
    deadlineMs,
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

/** A harness whose first `prepare` has completed, returning the sealed handoff. */
async function prepareFor(deps: ProcessDeps, ref: AttemptRef): Promise<PrepareStep> {
  registerGitOpsCommands(h.sandbox, ref.payload);
  h.sandbox.resolvedSha = SHA;
  return prepareAttempt(deps, ref);
}

describe("the paid exec at the frozen deadline", () => {
  test("the exec's timeout is the deadline remainder, and a kill at it is a confirmed stop", async () => {
    const { deps, db } = await makeDeps();
    h.sandbox.runnerExitCode = 124;
    // A saturated diff requests the tier maximum, so the cutoff is not the
    // binding term and the exec's own bound is the absolute remainder.
    h.sandbox.numstatStdout = "5000\t0\tsrc/auth.ts\n";
    const terminalized: Array<{ outcome: string; exhaustion: unknown }> = [];
    const handle: CheckHandle = {
      attemptId: ATTEMPT_ID,
      scope: SCOPE,
      githubAppId: 424242,
      headSha: SHA,
      lease: { holder: `consumer:${ATTEMPT_ID}`, epoch: 1, untilMs: Number.MAX_SAFE_INTEGER },
    };
    deps.checks = {
      begin: async () => handle,
      terminalize: async (input) => {
        terminalized.push({ outcome: input.outcome, exhaustion: input.budgetExhaustion });
      },
    };

    await withFrozenClock(async (clock) => {
      const ref = makeRef(makePayload(), clock.now + CAP_MS);
      const step = await prepareFor(deps, ref);
      if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
      // The runner deadline is the tier maximum INSIDE the frozen cutoff.
      expect(step.prepared.budget.cutoff_ms).toBe(clock.now + CAP_MS - postRunnerReserveMs(CHECK_TERMINALIZE_DEFAULT));
      expect(step.prepared.runnerDeadlineMs).toBe(clock.now + 600_000);

      let thrown: unknown;
      try {
        await reviewAttempt(deps, ref, step.prepared);
      } catch (err) {
        thrown = err;
      }
      // The container answered with a status: exit 124 at the anchored instant.
      // It is a stop, recorded as one — never `unknown`.
      expect(thrown).toBeInstanceOf(Error);
      const failure = thrown as { cause?: unknown };
      const cause = failure.cause;
      expect(cause).toBeInstanceOf(BudgetExhaustedError);
      expect((cause as BudgetExhaustedError).outcome.cause).toBe("sandbox-kill");

      // The exec carried the absolute remainder as its own bound: a hung child
      // dies at that instant, with no further checkpoint.
      const runnerCall = h.sandbox.calls.find((call) => call.cmd.includes("--input"));
      expect(runnerCall).toBeDefined();
      const runnerOpts = runnerCall!.opts as { timeout?: number };
      expect(runnerOpts.timeout).toBe(600_000);
      // The runner input document carries the SAME absolute instant.
      const written: { outerDeadlineEpochMs?: number } = JSON.parse(h.sandbox.writtenInputJson!);
      expect(written.outerDeadlineEpochMs).toBe(clock.now + 600_000);

      // Settled: the durable stop record and the Check conclusion agree.
      const ref2 = ref;
      const cleanup = {};
      expect(await settleAttemptFailure(deps, ref2, thrown, cleanup)).toEqual({
        kind: "budget-exhausted",
        outcome: expect.objectContaining({ kind: "budget-exhausted", cause: "sandbox-kill" }),
      });
      expect(failureRows(db)).toHaveLength(1);
      expect(String(failureRows(db)[0]!.error)).toContain("budget-exhausted:");
      expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("failed");
      expect(terminalized).toEqual([
        {
          outcome: "budget-exhausted",
          exhaustion: expect.objectContaining({ kind: "budget-exhausted", cause: "sandbox-kill" }),
        },
      ]);
    });
  });

  test("a lost reply is unknown: no failure row, no Check conclusion, nothing destroyed", async () => {
    const { deps, db } = await makeDeps();
    // The container accepted the exec (the launch fence is taken) and the reply
    // never came back.
    h.sandbox.runnerError = new Error("the exec's reply was lost");
    let terminalizeCalls = 0;
    deps.checks = {
      begin: async () => null,
      terminalize: async () => {
        terminalizeCalls += 1;
      },
    };

    await withFrozenClock(async (clock) => {
      const ref = makeRef(makePayload(), clock.now + CAP_MS);
      const step = await prepareFor(deps, ref);
      if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);

      let thrown: unknown;
      try {
        await reviewAttempt(deps, ref, step.prepared);
      } catch (err) {
        thrown = err;
      }
      const failure = thrown as { cause?: unknown };
      const cause = failure.cause;
      expect(cause).toBeInstanceOf(AttemptUnknownError);

      const cleanup = {};
      expect(await settleAttemptFailure(deps, ref, thrown, cleanup)).toEqual({ kind: "unknown" });
      // Ambiguity is not a stop and not a failure: nothing is recorded as
      // either, and no Check copy is frozen over a possibly-running call.
      expect(failureRows(db)).toHaveLength(0);
      expect(terminalizeCalls).toBe(0);
      expect(cleanup).toEqual({ headSha: SHA, unproven: true });
      expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("launched");

      // The retention table is the gate: `launched` with no outcome holds the
      // container and capacity.
      expect(await cleanupAttempt(deps, ref, cleanup)).toEqual({ retention: "unknown" });
      expect(h.sandbox.destroyCalls).toBe(0);
    });
  });
});

describe("the frozen deadline survives a resume", () => {
  test("a replayed prepare derives the same cutoff from the recorded instant, not the cap seam", async () => {
    const { deps, db } = await makeDeps();
    await withFrozenClock(async (clock) => {
      const ref = makeRef(makePayload(), clock.now + CAP_MS);
      const first = await prepareFor(deps, ref);
      if (first.kind !== "prepared") throw new Error(`prepare did not hand off: ${first.kind}`);
      const cutoff = first.prepared.budget.cutoff_ms;
      expect(cutoff).toBe(clock.now + CAP_MS - postRunnerReserveMs(CHECK_TERMINALIZE_DEFAULT));
      expect(first.prepared.budget.deadline_ms).toBe(first.prepared.runnerDeadlineMs);

      // A NEW host, the same attempt row, a moved clock and a much larger cap
      // override: the replayed prepare must still bill the recorded instant.
      clock.now += 300_000;
      const { deps: resumed } = await makeDeps({ db });
      resumed.attemptCapMs = 5_000_000;
      const again = await prepareFor(resumed, { ...ref, roundStartedAt: clock.now });
      if (again.kind !== "prepared") throw new Error(`replayed prepare did not hand off: ${again.kind}`);
      expect(again.prepared.budget.cutoff_ms).toBe(cutoff);
      expect(again.prepared.runnerDeadlineMs).toBeLessThanOrEqual(cutoff);
    });
  });

  test("the Check row is claimed with the attempt's frozen deadline", async () => {
    const { deps } = await makeDeps();
    const captured: number[] = [];
    deps.checks = {
      begin: async (input) => {
        captured.push(input.executionDeadlineMs);
        return null;
      },
      terminalize: async () => {},
    };
    const settlement = createCheckSettlement({
      deps,
      payload: makePayload(),
      attemptId: ATTEMPT_ID,
      checkBudgets: null,
      deadlineMs: 4_242_000,
    });
    await settlement.begin(SCOPE, 424242, SHA);
    expect(captured).toEqual([4_242_000]);
  });
});

describe("admission freezes the deadline durably", () => {
  test("a redelivery replays the recorded instant even after the operator changes the cap", async () => {
    const db = await createSeededTestD1();
    await db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, '2026-11-21T00:00:00.000Z')`,
      )
      .run(REVIEW_ATTEMPT_CAP_KEY, String(CAP_MS));
    const seen: AttemptRef[] = [];
    // A DEFINITE create failure keeps the handoff row and releases admission, so
    // the same message can be delivered again and must replay the same attempt.
    const startAttempt = async (_deps: unknown, ref: AttemptRef): Promise<void> => {
      seen.push(ref);
      throw new WorkflowCreateFailedError(ref.attemptId, new Error("no instance"));
    };
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      startAttempt,
    });

    await withFrozenClock(async (clock) => {
      const admittedAt = clock.now;
      const payload = makePayload();
      await consumer(h.makeBatch(payload)).catch(() => {});
      expect(seen).toHaveLength(1);
      expect(seen[0]!.deadlineMs).toBe(admittedAt + CAP_MS);

      // The operator doubles the cap and the queue redelivers the same message
      // later: the attempt may not be extended by either.
      db.raw.prepare(`UPDATE review_runtime_settings SET value = ? WHERE key = ?`).run("1800000", REVIEW_ATTEMPT_CAP_KEY);
      clock.now += 60_000;
      await consumer(h.makeBatch(payload)).catch(() => {});
      expect(seen).toHaveLength(2);
      expect(seen[1]!.attemptId).toBe(seen[0]!.attemptId);
      expect(seen[1]!.deadlineMs).toBe(seen[0]!.deadlineMs);
    });
  });
});

describe("the cap's settings read", () => {
  test("an absent row answers the documented 20-minute default without a warn", async () => {
    const db = await createSeededTestD1();
    await expect(getReviewAttemptCap(db as never)).resolves.toEqual({
      capMs: REVIEW_ATTEMPT_CAP_DEFAULT_MS,
      degraded: false,
    });
    expect(REVIEW_ATTEMPT_CAP_DEFAULT_MS).toBe(1_200_000);
  });

  test("a stored cap is read; an untrusted one degrades and refuses admission", async () => {
    const db = await createSeededTestD1();
    const upsert = db.raw.prepare(
      `INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, '2026-11-21T00:00:00.000Z')
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    );
    upsert.run(REVIEW_ATTEMPT_CAP_KEY, "1000000");
    expect(await getReviewAttemptCap(db as never)).toEqual({ capMs: 1_000_000, degraded: false });

    upsert.run(REVIEW_ATTEMPT_CAP_KEY, "not-a-duration");
    expect(await getReviewAttemptCap(db as never)).toEqual({
      capMs: REVIEW_ATTEMPT_CAP_DEFAULT_MS,
      degraded: true,
      reason: "untrusted",
    });
    const warns: Array<{ event: string }> = [];
    await expect(
      readReviewAttemptCapMs(db as never, { warn: (fields) => warns.push({ event: fields.event }) }),
    ).rejects.toThrow(/not readable/);
    expect(warns).toEqual([{ event: "review_attempt_cap_degraded" }]);
  });
});
