import { beforeEach, describe, expect, test } from "bun:test";

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
import { deliveryKeyOf, readAttemptHandoff, reserveAttemptHandoff } from "../../src/store/review-route-store";
import {
  CHECK_TERMINALIZE_DEFAULT,
  REVIEW_ATTEMPT_CAP_DEFAULT_MS,
  REVIEW_ATTEMPT_CAP_KEY,
  getReviewAttemptCap,
} from "../../src/dashboard/runtime-config-store";
import { postRunnerReserveMs, readReviewAttemptCapMs } from "../../src/review-budget";
import { CHECK_LEASE_MS, CHECK_NAME } from "../../src/store/review-checks";
import { BudgetExhaustedError, AttemptUnknownError } from "../../src/pipeline/review-attempt";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type {
  AttemptRef,
  CheckHandle,
  PrepareStep,
  ProcessDeps,
} from "../../src/pipeline/review-attempt-execution";

const {
  createCheckSettlement,
  prepareAttempt,
  reviewAttempt,
  settleAttemptFailure,
  cleanupAttempt,
} = await import("../../src/pipeline/review-attempt-execution");
const { createReviewConsumer, WorkflowCreateFailedError } = await import("../../src/pipeline/consumer");
const { createCheckLifecycle, createChecksAdapter } = await import("../../src/pipeline/checks");

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

function makeRef(payload: ReviewJobPayload, deadlineMs: number): AttemptRef {
  return {
    attemptId: ATTEMPT_ID,
    payload,
    level: "default",
    roundStartedAt: Date.now(),
    budgetStartMs: Date.now(),
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

async function prepareFor(deps: ProcessDeps, ref: AttemptRef): Promise<PrepareStep> {
  registerGitOpsCommands(h.sandbox, ref.payload);
  h.sandbox.resolvedSha = SHA;
  return prepareAttempt(deps, ref);
}

describe("the paid exec at the frozen deadline", () => {
  test("the exec's timeout is the deadline remainder, and a kill at it is a confirmed stop", async () => {
    const { deps, db } = await makeDeps();
    h.sandbox.runnerExitCode = 124;
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
      expect(step.prepared.budget.cutoff_ms).toBe(clock.now + CAP_MS - postRunnerReserveMs(CHECK_TERMINALIZE_DEFAULT));
      expect(step.prepared.runnerDeadlineMs).toBe(clock.now + 600_000);

      const reviewed = await reviewAttempt(deps, ref, step.prepared);
      if (!("failure" in reviewed)) throw new Error("the budget stop was not classified");
      expect(reviewed.failure.class).toBe("budget");
      if (reviewed.failure.class !== "budget") throw new Error("unreachable");
      expect(reviewed.failure.window).toBe("runner");
      expect(reviewed.failure.outcome.cause).toBe("sandbox-kill");

      const runnerCall = h.sandbox.calls.find((call) => call.cmd.includes("--input"));
      expect(runnerCall).toBeDefined();
      const runnerOpts = runnerCall!.opts as { deadlineEpochMs?: number };
      expect(runnerOpts.deadlineEpochMs).toBe(clock.now + 600_000);
      const written: { outerDeadlineEpochMs?: number } = JSON.parse(h.sandbox.writtenInputJson!);
      expect(written.outerDeadlineEpochMs).toBe(runnerOpts.deadlineEpochMs);

      expect(await settleAttemptFailure(deps, ref, reviewed.failure, step.prepared)).toEqual({
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

  test("a lost reply is unknown: its own cause is recorded, no Check conclusion, nothing destroyed", async () => {
    const { deps, db } = await makeDeps();
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
      // Admission's own row, as the consumer leaves it before the instance runs:
      // the observation rides THIS record, and it is what the reconciler reads.
      await reserveAttemptHandoff(db as never, {
        deliveryKey: deliveryKeyOf(ref.payload),
        attemptId: ATTEMPT_ID,
        payload: ref.payload,
        nowMs: clock.now,
        createdMs: clock.now,
        enqueuedMs: 0,
        deadlineMs: clock.now + CAP_MS,
      });
      const step = await prepareFor(deps, ref);
      if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);

      const reviewed = await reviewAttempt(deps, ref, step.prepared);
      if (!("failure" in reviewed)) throw new Error("the lost reply was not classified");
      expect(reviewed.failure.class).toBe("unknown");

      expect(await settleAttemptFailure(deps, ref, reviewed.failure, step.prepared)).toEqual({ kind: "unknown" });
      // The phase's own cause is durable as an OBSERVATION (the reconciler that
      // later releases the slot can otherwise only observe that no reply
      // arrived); no failure row is written here — the reconciler is its ONE
      // writer — and the ATTEMPT stays un-settled: no Check conclusion, no
      // terminal move.
      expect(failureRows(db)).toHaveLength(0);
      const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(ref.payload));
      expect(handoff?.observation?.error).toContain("the exec's reply was lost");
      expect(handoff?.observation?.code).toBe("review.paid.reply_lost");
      expect(terminalizeCalls).toBe(0);
      expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("launched");

      // A `launched` row is the veto cleanup reads for itself: no proof that
      // nothing paid could be lost, so the slot is left alone.
      expect(await cleanupAttempt(deps, ref, { headSha: SHA })).toEqual({ retention: "unknown" });
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
    const live = Date.now() + 4_242_000;
    const settlement = createCheckSettlement({
      deps,
      payload: makePayload(),
      attemptId: ATTEMPT_ID,
      checkBudgets: null,
      deadlineMs: live,
    });
    await settlement.begin(SCOPE, 424242, SHA);
    expect(captured).toEqual([live]);
  });

  test("a live attempt's instant is byte-identical even with less than one lease left", async () => {
    const { deps, db } = await makeDeps();
    const live = Date.now() + 60_000;
    const octokit = {
      rest: {
        checks: {
          create: async (params: { head_sha: string; external_id: string }) => ({
            data: {
              id: 4242,
              name: CHECK_NAME,
              head_sha: params.head_sha,
              external_id: params.external_id,
              app: { id: 424242 },
              status: "queued",
              conclusion: null,
            },
          }),
          update: async () => {
            throw new Error("not used here");
          },
          get: async () => {
            throw new Error("not used here");
          },
          listForRef: async () => {
            throw new Error("not used here");
          },
        },
      },
    };
    deps.checks = createCheckLifecycle({
      db,
      nowMs: () => Date.now(),
      getAdapter: () =>
        createChecksAdapter({ db, nowMs: () => Date.now(), getOctokit: async () => octokit }),
      getCheckGate: async () => null,
    });
    const settlement = createCheckSettlement({
      deps,
      payload: makePayload(),
      attemptId: ATTEMPT_ID,
      checkBudgets: null,
      deadlineMs: live,
    });
    const handle = await settlement.begin(SCOPE, 424242, SHA);
    expect(handle).not.toBeNull();

    const row = await db
      .prepare("SELECT execution_deadline_ms, lease_until_ms FROM review_checks WHERE id = ?")
      .bind(handle!.attemptId)
      .first<{ execution_deadline_ms: number; lease_until_ms: number }>();
    expect(row!.execution_deadline_ms).toBe(live);
    expect(row!.lease_until_ms).toBe(live);
  });

  test("a claim after the attempt's hard stop opens a settlement window instead", async () => {
    const { deps } = await makeDeps();
    const captured: number[] = [];
    deps.checks = {
      begin: async (input) => {
        captured.push(input.executionDeadlineMs);
        return null;
      },
      terminalize: async () => {},
    };
    const spent = Date.now() - 60_000;
    const settlement = createCheckSettlement({
      deps,
      payload: makePayload(),
      attemptId: ATTEMPT_ID,
      checkBudgets: null,
      deadlineMs: spent,
    });
    await settlement.begin(SCOPE, 424242, SHA);
    expect(captured).toHaveLength(1);
    expect(captured[0]!).toBeGreaterThan(Date.now());
    expect(captured[0]!).toBeLessThanOrEqual(Date.now() + CHECK_LEASE_MS);
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

function claimSpendingDb(db: unknown, spentMs: number, clock: { now: number }): unknown {
  const real = db as { prepare(query: string): { bind(...values: unknown[]): unknown } };
  return {
    prepare(query: string) {
      const statement = real.prepare(query);
      if (!query.includes("SET state = 'launched'")) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values) as { run(): Promise<unknown> };
          return {
            run: async () => {
              clock.now += spentMs;
              return bound.run();
            },
          };
        },
      };
    },
  };
}

describe("the launch claim is part of the attempt's clock", () => {
  test("the exec bound is taken after the claim, so the claim's round trip is charged", async () => {
    const { deps } = await makeDeps();
    await withFrozenClock(async (clock) => {
      const ref = makeRef(makePayload(), clock.now + CAP_MS);
      const step = await prepareFor(deps, ref);
      if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);

      deps.env = { ...deps.env, DB: claimSpendingDb(deps.env.DB, 10_000, clock) as never };
      await reviewAttempt(deps, ref, step.prepared);

      const runnerCall = h.sandbox.calls.find((call) => call.cmd.includes("--input"));
      expect(runnerCall).toBeDefined();
      const runnerOpts = runnerCall!.opts as { deadlineEpochMs?: number };
      expect(runnerOpts.deadlineEpochMs).toBe(step.prepared.runnerDeadlineMs);
    });
  });

  test("a claim that spends the whole window refuses the exec and records a confirmed stop", async () => {
    const { deps, db } = await makeDeps();
    await withFrozenClock(async (clock) => {
      const ref = makeRef(makePayload(), clock.now + CAP_MS);
      const step = await prepareFor(deps, ref);
      if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);

      deps.env = {
        ...deps.env,
        DB: claimSpendingDb(deps.env.DB, step.prepared.runnerDeadlineMs - clock.now, clock) as never,
      };
      const reviewed = await reviewAttempt(deps, ref, step.prepared);
      if (!("failure" in reviewed)) throw new Error("the cap stop was not classified");
      expect(reviewed.failure.class).toBe("budget");
      if (reviewed.failure.class !== "budget") throw new Error("unreachable");
      expect(reviewed.failure.outcome).toMatchObject({
        kind: "budget-exhausted",
        cause: "consumer-deadline",
        budgetWindow: "runner",
        seatsDispatched: 0,
        seatsStopped: 0,
      });
      expect(h.sandbox.calls.some((call) => call.cmd.includes("--input"))).toBe(false);
      expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("failed");

      expect(await settleAttemptFailure(deps, ref, reviewed.failure, step.prepared)).toMatchObject({
        kind: "budget-exhausted",
      });
      expect(failureRows(db)).toHaveLength(1);
      expect(await cleanupAttempt(deps, ref, { headSha: SHA })).toEqual({ retention: "retained" });
      expect(h.sandbox.destroyCalls).toBe(1);
    });
  });
});

describe("the admission guard and the attempt deadline agree", () => {
  test("a cap beyond the level ceiling widens the guard to the attempt's own stop", async () => {
    const db = await createSeededTestD1();
    await db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, '2026-11-21T00:00:00.000Z')`,
      )
      .run(REVIEW_ATTEMPT_CAP_KEY, "3000000");
    const seen: AttemptRef[] = [];
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      startAttempt: async (_deps, ref) => {
        seen.push(ref);
      },
    });

    await withFrozenClock(async (clock) => {
      await consumer(h.makeBatch(makePayload()));
      expect(seen).toHaveLength(1);
      expect(seen[0]!.deadlineMs).toBe(clock.now + 3_000_000);
      const rows = db.raw.query("SELECT acquired_at, expires_at FROM review_inflight").all() as Array<{
        acquired_at: string;
        expires_at: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(Date.parse(rows[0]!.expires_at) - Date.parse(rows[0]!.acquired_at)).toBe(3_060_000);
    });
  });
});

describe("a pre-deadline handoff row is anchored once", () => {
  test("a NULL deadline is taken from the row's own admission stamp, not the delivery clock", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const key = deliveryKeyOf(payload);
    const createdMs = 1_000_000;
    await db.raw
      .prepare(
        `INSERT INTO review_attempt_handoffs
           (delivery_key, attempt_id, payload_json, state, created_ms, updated_ms)
         VALUES (?, ?, ?, 'owed', ?, ?)`,
      )
      .run(key, "legacy-attempt", JSON.stringify(payload), createdMs, createdMs);
    const seen: AttemptRef[] = [];
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      startAttempt: async (_deps, ref) => {
        seen.push(ref);
        throw new WorkflowCreateFailedError(ref.attemptId, new Error("no instance"));
      },
    });

    await withFrozenClock(async (clock) => {
      await consumer(h.makeBatch(payload)).catch(() => {});
      expect(seen).toHaveLength(1);
      expect(seen[0]!.attemptId).toBe("legacy-attempt");
      expect(seen[0]!.deadlineMs).toBe(createdMs + REVIEW_ATTEMPT_CAP_DEFAULT_MS);
      expect((await readAttemptHandoff(db as never, key))?.deadlineMs).toBe(createdMs + REVIEW_ATTEMPT_CAP_DEFAULT_MS);

      clock.now += 60_000;
      await consumer(h.makeBatch(payload)).catch(() => {});
      expect(seen).toHaveLength(2);
      expect(seen[1]!.deadlineMs).toBe(seen[0]!.deadlineMs);
    });
  });
});

describe("a container-side deadline refusal is a confirmed stop", () => {
  test("a request whose proof consumed the window starts nothing and records the cap stop", async () => {
    const { deps, db } = await makeDeps();
    deps.getSandbox = async () => ({
      runCommand: h.fakeSandbox.runCommand,
      runMarked: async (marker: string, cmd: string, opts?: unknown) =>
        cmd.includes("--input")
          ? ({ kind: "deadline-spent", remainingMs: 0 } as const)
          : h.fakeSandbox.runMarked(marker, cmd, opts),
      provision: h.fakeSandbox.provision,
      destroyMarked: h.fakeSandbox.destroyMarked,
      destroy: h.fakeSandbox.destroy,
    });

    await withFrozenClock(async (clock) => {
      const ref = makeRef(makePayload(), clock.now + CAP_MS);
      const step = await prepareFor(deps, ref);
      if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);

      const reviewed = await reviewAttempt(deps, ref, step.prepared);
      if (!("failure" in reviewed)) throw new Error("the cap stop was not classified");
      expect(reviewed.failure.class).toBe("budget");
      if (reviewed.failure.class !== "budget") throw new Error("unreachable");
      expect(reviewed.failure.outcome).toMatchObject({
        kind: "budget-exhausted",
        cause: "consumer-deadline",
        budgetWindow: "runner",
        seatsDispatched: 0,
        seatsStopped: 0,
      });
      expect(h.sandbox.calls.some((call) => call.cmd.includes("--input"))).toBe(false);
      expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("failed");

      expect(await settleAttemptFailure(deps, ref, reviewed.failure, step.prepared)).toMatchObject({
        kind: "budget-exhausted",
      });
      expect(failureRows(db)).toHaveLength(1);
      expect(await cleanupAttempt(deps, ref, { headSha: SHA })).toEqual({ retention: "retained" });
      expect(h.sandbox.destroyCalls).toBe(1);
    });
  });
});
