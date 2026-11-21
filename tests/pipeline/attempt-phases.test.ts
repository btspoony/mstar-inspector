/**
 * The five attempt phases, each driven ALONE from a hand-built input.
 *
 * The point of the split is that a phase boundary carries serialisable values,
 * so a Workflow restart can resume at one instead of at a live stack. These
 * cases therefore never enter through `processMessage`: they construct the
 * attempt's run state, the phase's own input and the durable carrier, call the
 * phase, and assert on its explicit output.
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
  VALID_OUTPUT,
  createSeededTestD1,
  registerGitOpsCommands,
} from "../helpers/consumer-fixtures";
import { createConsumerHarness, makePayload } from "../helpers/consumer-harness";
import { createArtifactStore } from "../../src/store/artifact-store";
import { createFailureStore } from "../../src/store/failure-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import { claimReviewAttempt, readReviewLaunch } from "../../src/pipeline/review-attempt";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type { Lease } from "../../src/store/finding-lifecycle";
import type { ReviewSandbox } from "../../src/pipeline/sandbox";
import { buildGitOpsCommands } from "../../src/pipeline/gitops";
// Type-only (erased at compile time, so it cannot run before the shim above).
import type {
  AdmittedReviewAttempt,
  AttemptRun,
  CheckHandle,
  PreparedAttempt,
  ProcessDeps,
} from "../../src/pipeline/review-attempt-execution";

// Dynamic: the module graph under test must load after the workerd shim.
const {
  cleanupAttempt,
  collectAttempt,
  createCheckSettlement,
  journalHandoffRow,
  payloadIdentityFields,
  prepareAttempt,
  publishAttempt,
  reviewAttempt,
} = await import("../../src/pipeline/review-attempt-execution");

const ATTEMPT_ID = "attempt-4b-0001";
const SANDBOX_ID = `review-${ATTEMPT_ID}`;
const SCOPE: Scope = {
  appId: TEST_APP_ID,
  installationId: 123,
  owner: TEST_OWNER,
  repo: TEST_REPO,
  prNumber: TEST_PR_NUMBER,
};
const LEASE: Lease = { holder: `consumer:${SANDBOX_ID}`, epoch: 1, untilMs: Date.now() + 60_000 };
const HANDLE: CheckHandle = { attemptId: ATTEMPT_ID, scope: SCOPE, githubAppId: 424242, headSha: SHA, lease: LEASE };

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

/** The seeded D1 + this case's doubles, assembled by hand: nothing here is a live stack. */
async function makeDeps(): Promise<{ deps: ProcessDeps; db: Awaited<ReturnType<typeof createSeededTestD1>> }> {
  const db = await createSeededTestD1();
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
    roundBudgetMs: 900_000,
  };
  return { deps, db };
}

/** One admitted attempt's run state, built by hand — no `processMessage`. */
function makeRun(deps: ProcessDeps, payload: ReviewJobPayload, sandbox: ReviewSandbox | null = null): AttemptRun {
  const input: AdmittedReviewAttempt = {
    payload,
    deps,
    attemptId: ATTEMPT_ID,
    sandboxId: SANDBOX_ID,
    roundStartedAt: Date.now(),
    level: "default",
    commenter: h.fakeCommenter,
    githubAppId: 424242,
    workspaceId: "default",
    usageWorkspaceId: "default",
    usageSource: "byok",
    appCfg: { keys: { ark: ["sk-test"] }, modelChain: "ark/deepseek-v4-flash" },
    modelOverrides: undefined,
    customProviders: undefined,
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
  const progress = {
    failureStage: "pipeline" as const,
    secretValues: [] as string[],
    runnerStartedAt: undefined,
    runnerReturned: false,
  };
  let run!: AttemptRun;
  const check = createCheckSettlement({
    payload,
    deps,
    sandboxId: SANDBOX_ID,
    checkBudgets: null,
    logFields: () => run.fields ?? run.baseFields ?? payloadIdentityFields(payload),
  });
  run = {
    input,
    progress,
    check,
    baseFields: undefined,
    fields: undefined,
    sandbox,
    headSha: null,
    lifecycleScope: undefined,
    roundBudget: null,
    runnerAnchor: null,
    observedChangedLines: null,
    durableOutcome: false,
    containerUnproven: false,
    sendAttempt: null,
  };
  return run;
}

/** The checkout a handed-off `prepare` leaves: the durable read a restart would make. */
function makePrepared(payload: ReviewJobPayload): PreparedAttempt {
  return {
    headSha: SHA,
    token: "ghs_test",
    cmds: buildGitOpsCommands({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      prNumber: TEST_PR_NUMBER,
      cloneDir: "/home/user/clone",
      diffPath: "/home/user/diff.patch",
    }),
    sandbox: h.fakeSandbox as unknown as ReviewSandbox,
    fields: payloadIdentityFields(payload),
    lifecycleScope: SCOPE,
    key: {
      installation_id: 123,
      owner: TEST_OWNER,
      repo: TEST_REPO,
      pr_number: TEST_PR_NUMBER,
      head_sha: SHA,
    },
    targets: [],
    totalOpen: 0,
    captureFailed: false,
    pendingApplyFailed: false,
    sinceSha: null,
    diffText: "",
    catalogExcluded: new Set<string>(),
    catalogBudgetExcluded: new Set<string>(),
    budgetExcluded: new Set<string>(),
    discussion: { items: [], issueCoverage: "complete", issueModelCoverage: "complete", issueDigest: "", capturedMs: Date.now(), threads: [] },
    askedDiscussion: {
      items: [],
      issueCoverage: "complete",
      issueModelCoverage: "complete",
      issueDigest: "",
      capturedMs: Date.now(),
      threads: [],
    },
    recheckInput: undefined,
    recheckAssignmentMaxBytes: undefined,
    prContext: undefined,
    anchor: { kind: "allocated", requestedBudgetMs: 500_340, effectiveBudgetMs: 500_340, execDeadlineMs: Date.now() + 500_000 },
    observedChangedLines: 17,
    reconFacts: [],
  };
}

describe("createCheckSettlement", () => {
  test("a begin hands back the handle and the terminalize settles the run exactly once", async () => {
    const { deps } = await makeDeps();
    const calls: string[] = [];
    deps.checks = {
      begin: async () => {
        calls.push("begin");
        return HANDLE;
      },
      markInProgress: async () => {
        calls.push("markInProgress");
        return { kind: "settled", promoted: true };
      },
      terminalize: async () => {
        calls.push("terminalize");
      },
      abandonTerminalize: async () => {
        calls.push("abandon");
        return true;
      },
    };
    const settlement = createCheckSettlement({
      payload: makePayload(),
      deps,
      sandboxId: SANDBOX_ID,
      checkBudgets: null,
      logFields: () => payloadIdentityFields(makePayload()),
    });

    expect(await settlement.begin(SCOPE, 424242, SHA)).toEqual(HANDLE);
    expect(settlement.claimAttempted).toBe(false);
    await settlement.terminalize(null, "skipped", SHA);
    await settlement.terminalize(null, "pre-publication-failure");
    expect(calls).toEqual(["begin", "markInProgress", "terminalize"]);
    expect(settlement.terminalized).toBe(true);
  });

  test("the give-up handoff reaches the abandon seam and reports its answer", async () => {
    const { deps } = await makeDeps();
    let abandoned: { reason: string; outcome: string | undefined } | undefined;
    deps.checks = {
      begin: async () => HANDLE,
      terminalize: async () => {},
      abandonTerminalize: async (input) => {
        abandoned = { reason: input.reason, outcome: input.outcome };
        return true;
      },
    };
    const settlement = createCheckSettlement({
      payload: makePayload(),
      deps,
      sandboxId: SANDBOX_ID,
      checkBudgets: null,
      logFields: () => payloadIdentityFields(makePayload()),
    });
    settlement.handle = HANDLE;

    expect(await settlement.abandon(HANDLE, "proof is not durable", { outcome: "publication-unknown" })).toBe(true);
    expect(abandoned).toEqual({ reason: "proof is not durable", outcome: "publication-unknown" });
  });
});

describe("prepareAttempt", () => {
  test("an already-reviewed head settles at the dedupe gate, with the checkout's own sha", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    // The durable done-state: the delivery is a duplicate of this head.
    h.kvState.getValue = "done";
    const run = makeRun(deps, payload);

    const step = await prepareAttempt(run);

    expect(step).toEqual({ kind: "settled", outcome: { kind: "ok" } });
    // The phase carried the authoritative checkout sha out on the run state,
    // which is what a restart's failure path and cleanup read.
    expect(run.headSha).toBe(SHA);
    expect(run.sandbox).not.toBeNull();
    expect(h.sandbox.calls.filter((call) => h.sandbox.gitOps.get(call.cmd) === "clone")).toHaveLength(1);
  });
});

describe("reviewAttempt", () => {
  test("the paid step receives the anchored exec deadline and leaves a persisted launch row", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const run = makeRun(deps, payload);
    const prepared = makePrepared(payload);
    // The one durable fact the paid step reads: prepare's provisioning claim.
    await claimReviewAttempt(deps.env.DB, ATTEMPT_ID, Date.now());

    const reviewed = await reviewAttempt(run, prepared);

    expect(reviewed.execution.run.stdout).toBe(JSON.stringify(VALID_OUTPUT));
    // The launch row is the durable carrier: `persisted` after the reply, so
    // collection can be replayed without paying again.
    const launch = await readReviewLaunch(deps.env.DB, ATTEMPT_ID);
    expect(launch?.state).toBe("persisted");
  });
});

describe("collectAttempt", () => {
  test("a valid envelope is staged BEFORE any GitHub mutation and handed to publish", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    const run = makeRun(deps, payload);
    const prepared = makePrepared(payload);
    const reviewed = {
      execution: {
        run: { stdout: JSON.stringify(VALID_OUTPUT), stderr: "", exitCode: 0 },
        recheck: null,
        report: null,
        appliedProvider: null,
      },
      recheckDoc: null,
      rejectedRowIds: new Set<string>(),
      anonymousRejectedRows: 0,
    };

    const step = await collectAttempt(run, prepared, reviewed);

    expect(step.kind).toBe("collected");
    if (step.kind !== "collected") return;
    expect(step.collected.preparedBody).toContain("Two issues found in the diff.");
    expect(step.collected.round).toBe(1);
    // Staged, not sent: the publication is on the journal and the commenter
    // has not been asked to post yet.
    const journal = await journalHandoffRow(deps.env.DB, SCOPE, SHA);
    expect(journal?.id).toBe(step.collected.stagedId);
    expect(journal?.phase).toBe("prepared");
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    expect(run.durableOutcome).toBe(true);
  });
});

describe("publishAttempt", () => {
  test("a staged payload is published once, without any runner work", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    const run = makeRun(deps, payload);
    const prepared = makePrepared(payload);
    const reviewed = {
      execution: {
        run: { stdout: JSON.stringify(VALID_OUTPUT), stderr: "", exitCode: 0 },
        recheck: null,
        report: null,
        appliedProvider: null,
      },
      recheckDoc: null,
      rejectedRowIds: new Set<string>(),
      anonymousRejectedRows: 0,
    };
    const step = await collectAttempt(run, prepared, reviewed);
    if (step.kind !== "collected") throw new Error(`collect did not hand off: ${step.kind}`);
    const runnerCallsBefore = h.sandbox.calls.length;

    const outcome = await publishAttempt(run, prepared, step.collected);

    expect(outcome).toEqual({ kind: "ok" });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(1);
    // No runner work in this phase: the paid result was already durable.
    expect(h.sandbox.calls.length).toBe(runnerCallsBefore);
  });
});

describe("cleanupAttempt", () => {
  /** A sandbox double that records the retention proof the teardown was authorised by. */
  function recordingSandbox(previous: ReviewSandbox): { sandbox: ReviewSandbox; retentions: unknown[] } {
    const retentions: unknown[] = [];
    return {
      sandbox: {
        runCommand: (...args) => previous.runCommand(...args),
        claimMarker: (marker) => previous.claimMarker(marker),
        runMarked: (marker, command, opts) => previous.runMarked(marker, command, opts),
        destroyMarked: async (marker, retention) => {
          retentions.push(retention);
          await previous.destroy();
          return "destroyed";
        },
        destroy: () => previous.destroy(),
      },
      retentions,
    };
  }

  test("no paid work destroys the container on that fact alone and releases the row", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    const { sandbox, retentions } = recordingSandbox(h.fakeSandbox as unknown as ReviewSandbox);
    const run = makeRun(deps, payload, sandbox);

    await cleanupAttempt(run);

    expect(retentions).toEqual([{ kind: "no-paid-work" }]);
    expect(h.sandbox.destroyCalls).toBe(1);
    expect(run.containerUnproven).toBe(false);
  });

  test("a paid call that returned WITHOUT a durable outcome is never destroyed", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    const { sandbox, retentions } = recordingSandbox(h.fakeSandbox as unknown as ReviewSandbox);
    const run = makeRun(deps, payload, sandbox);
    run.progress.runnerStartedAt = Date.now();
    run.progress.runnerReturned = true;
    run.durableOutcome = false;

    await cleanupAttempt(run);

    expect(retentions).toEqual([]);
    expect(h.sandbox.destroyCalls).toBe(0);
    expect(run.containerUnproven).toBe(true);
  });

  test("a retained result destroys the proven container and releases capacity", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    const { sandbox, retentions } = recordingSandbox(h.fakeSandbox as unknown as ReviewSandbox);
    const run = makeRun(deps, payload, sandbox);
    run.progress.runnerStartedAt = Date.now();
    run.progress.runnerReturned = true;
    run.durableOutcome = true;

    await cleanupAttempt(run);

    expect(retentions).toEqual([{ kind: "retained" }]);
    expect(h.sandbox.destroyCalls).toBe(1);
    expect(run.containerUnproven).toBe(false);
  });
});
