import { RECONCILE_DEFAULTS } from "../../src/contracts/reconcile-settings";
import { beforeEach, describe, expect, test } from "bun:test";

import "../helpers/cloudflare-workers-mock";

import {
  SHA,
  TEST_APP_ID,
  TEST_KEY,
  TEST_OWNER,
  TEST_PR_NUMBER,
  TEST_REPO,
  VALID_DIFF,
  VALID_OUTPUT,
  createSeededTestD1,
  RUNNER_CMDS,
  registerGitOpsCommands,
  seedOpenTarget,
  seedPriorPublication,
} from "../helpers/consumer-fixtures";
import { testAppPem } from "../helpers/rsa-key";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createConsumerHarness, failureRows, makePayload } from "../helpers/consumer-harness";
import { FINDING_BODY_MAX } from "../../src/review/schema";
import { REDACTED } from "../../src/pipeline/redact";
import { FAILURE_SUMMARIES } from "../../src/contracts/failure-codes";
import { inlineWorkflowStep } from "../helpers/workflow-route";
import { createArtifactStore } from "../../src/store/artifact-store";
import { createFailureStore } from "../../src/store/failure-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import {
  MovedHeadError,
  abandonReviewLaunch,
  claimReviewAttempt,
  claimReviewLaunch,
  freezeAttemptIdentity,
  readReviewLaunch,
} from "../../src/pipeline/review-attempt";
import { PUBLICATION_LEASE_MS, applyPublishedLifecycle, claimDegradedTarget, claimPublication, claimPublicationLease, readLineBatchState, recordLineDispatchIntent, recordPublicationProof, readPublication } from "../../src/store/finding-lifecycle";
import {
  deliveryKeyOf,
  listIncompleteSettlements,
  readAttemptHandoff,
  reserveAttemptHandoff,
} from "../../src/store/review-route-store";
import { CHECK_NAME, attachCheckRunId, claimAttempt, claimCheckRecovery, releaseCheckClaim, setCheckCreateState } from "../../src/store/review-checks";
import { acquireInflight } from "../../src/store/inflight-store";
import type { WorkflowStep } from "cloudflare:workers";
import type { TestD1 } from "../store/helpers";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type { Lease } from "../../src/store/finding-lifecycle";
import type { PostOctokit, PostPreparedLineCommentsInput, PostPreparedReviewInput } from "../../src/pipeline/comment";
import type {
  AttemptRef,
  CheckHandle,
  PreparedAttempt,
  ProcessDeps,
} from "../../src/pipeline/review-attempt-execution";

const { phaseFailureRecord } = await import("../../src/pipeline/review-attempt-execution");
const { AttemptUnknownError } = await import("../../src/pipeline/review-attempt");
const {
  cleanupAttempt,
  collectAttempt,
  createCheckSettlement,
  errorClassOf,
  PhaseTransientError,
  prepareAttempt,
  publishAttempt,
  reviewAttempt,
  settleAttemptFailure,
  transientFactsOf,
} = await import("../../src/pipeline/review-attempt-execution");
const { ordinaryFailure, runReviewAttemptWorkflow } = await import("../../src/workflow/review");
const { hydrateAttemptHost, ensureRunnerConfig } = await import("../../src/pipeline/consumer");
const { PublicationDeadlineSpent, postLineCommentsWithOctokit, postPreparedReviewWithOctokit, publicationSendGuard, PreparedSendRejected } = await import(
  "../../src/pipeline/comment"
);
const { RoundBudgetSpent, openGateSecrets, sealGateSecrets, lastRunnerStage } = await import(
  "../../src/pipeline/review-attempt"
);
const { reconcileReviewLifecycle } = await import("../../src/worker/lifecycle-reconcile");
const { reconcileReviewRoute } = await import("../../src/pipeline/route-reconcile");
const { TERMINAL_FAILURE_TEXT, createCheckLifecycle, createChecksAdapter } = await import("../../src/pipeline/checks");
import type { ChecksOctokit } from "../../src/pipeline/checks";

const ATTEMPT_ID = "attempt-4b-0001";
const SCOPE: Scope = {
  appId: TEST_APP_ID,
  installationId: 123,
  owner: TEST_OWNER,
  repo: TEST_REPO,
  prNumber: TEST_PR_NUMBER,
};
const LEASE: Lease = { holder: `consumer:${ATTEMPT_ID}`, epoch: 1, untilMs: Date.now() + 60_000 };
const HANDLE: CheckHandle = { attemptId: ATTEMPT_ID, scope: SCOPE, githubAppId: 424242, headSha: SHA, lease: LEASE };

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

/**
 * note: The seeded D1 + this case's doubles, assembled by hand. `share` carries the
 * pieces a RESTART keeps: the same database and the same container, but fresh
 * maps — the host resolves the App again, and nothing in-memory survives.
 *
 * One `deps` is reused across prepare → review → collect ON PURPOSE: it models ONE
 * invocation (the inline route), which is exactly the production shape of the
 * three consecutive phases — the host channel (`runnerConfigs`, the minted token
 * in `credentials`) is that invocation's own memory, and consuming it in a later
 * phase of the SAME invocation is what the module's phase rule allows. Every
 * restart case builds a SECOND deps over the same database instead
 * (`makeDeps({ db })`), so nothing in-memory crosses the boundary there.
 */
async function makeDeps(
  share?: { db: Awaited<ReturnType<typeof createSeededTestD1>> },
): Promise<{ deps: ProcessDeps; db: Awaited<ReturnType<typeof createSeededTestD1>> }> {
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
    attemptCapMs: 900_000,
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

function makeRef(payload: ReviewJobPayload): AttemptRef {
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

const INSTANCE_DIED = "review workflow instance died mid-step";

/**
 * note: A durable step store — everything a resumed instance owns. A recorded step
 * replays its output instead of re-running, and once the instance reaches
 * `dieAt` it is gone: that step and everything after it never return.
 */
function stepStore(store: Map<string, unknown>, dieAt?: string): WorkflowStep {
  let died = false;
  return {
    do: async (name: string, configOrCallback: unknown, maybeCallback?: unknown): Promise<unknown> => {
      if (store.has(name)) return store.get(name);
      if (died || name === dieAt) {
        died = true;
        throw new Error(INSTANCE_DIED);
      }
      const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as (
        ctx: unknown,
      ) => Promise<unknown>;
      const output = await callback({ step: { name, count: 1 }, attempt: 1, config: {} });
      store.set(name, output);
      return output;
    },
    sleep: async () => {},
    sleepUntil: async () => {},
    waitForEvent: async (): Promise<never> => {
      throw new Error("the test step store does not wait for events");
    },
  } as unknown as WorkflowStep;
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
      deps,
      payload: makePayload(),
      attemptId: ATTEMPT_ID,
      checkBudgets: null,
      deadlineMs: Date.now() + 900_000,
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
      deps,
      payload: makePayload(),
      attemptId: ATTEMPT_ID,
      checkBudgets: null,
      deadlineMs: Date.now() + 900_000,
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
    h.kvState.getValue = "done";

    const step = await prepareAttempt(deps, makeRef(payload));

    expect(step).toEqual({ kind: "settled", outcome: { kind: "ok" } });
    expect(h.sandbox.calls.filter((call) => h.sandbox.gitOps.get(call.cmd) === "clone")).toHaveLength(1);
  });

  test("the handoff is data: no sandbox, no token, no Set survives a JSON round-trip", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    const step = await prepareAttempt(deps, makeRef(payload));
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);

    const handoff = step.prepared;
    expect(handoff.headSha).toBe(SHA);
    expect(JSON.parse(JSON.stringify(handoff))).toEqual(handoff);
    expect(handoff).not.toHaveProperty("sandbox");
    expect(handoff).not.toHaveProperty("token");
    expect(Array.isArray(handoff.catalogExcluded)).toBe(true);
  });
});

describe("the restart round trip", () => {
  test("prepare → review → collect → publish → cleanup runs from persisted records alone", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);

    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));

    const { deps: resumed } = await makeDeps({ db });
    const reviewed = await reviewAttempt(resumed, ref, prepared);
    if (!("state" in reviewed)) throw new Error(`review did not persist: ${reviewed.failure.message}`);
    expect(reviewed.state).toBe("persisted");
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("persisted");

    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    const staged = await readPublication(db as never, collected.collected.publicationId);
    expect(staged?.phase).toBe("prepared");
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);

    const { deps: publishing } = await makeDeps({ db });
    const outcome = await publishAttempt(publishing, ref, collected.collected.publicationId);
    expect(outcome).toEqual({ kind: "ok" });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(1);

    const { deps: cleaning } = await makeDeps({ db });
    expect(await cleanupAttempt(cleaning, ref)).toEqual({ retention: "retained" });
    expect(h.sandbox.destroyCalls).toBe(1);
  });

  test("a restarted publication re-adopts the Check it did not create", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const claimed = await claimAttempt(db as never, {
      scope: SCOPE,
      githubAppId: 424242,
      headSha: SHA,
      triggeredBy: "pull_request",
      action: "opened",
      holder: `consumer:${ATTEMPT_ID}`,
      nowMs: Date.now(),
      executionDeadlineMs: Date.now() + 600_000,
    });
    if (claimed.kind !== "claimed") throw new Error(`the test could not create the row: ${claimed.kind}`);
    const handle: CheckHandle = { ...HANDLE, attemptId: claimed.attempt.identity.attemptId };
    const checks = {
      begun: 0,
      terminalized: [] as Array<{ publicationId: string | null; outcome: string }>,
      begin: async () => {
        checks.begun += 1;
        return handle;
      },
      markInProgress: async () => ({ kind: "settled" as const, promoted: true }),
      terminalize: async (input: { publicationId: string | null; outcome: string }) => {
        checks.terminalized.push({ publicationId: input.publicationId, outcome: input.outcome });
      },
    };
    deps.checks = checks;

    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: resumed } = await makeDeps({ db });
    resumed.checks = checks;
    await reviewAttempt(resumed, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    collecting.checks = checks;
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    const begunBeforePublish = checks.begun;

    const { deps: publishing } = await makeDeps({ db });
    publishing.checks = checks;
    expect(await publishAttempt(publishing, ref, collected.collected.publicationId)).toEqual({ kind: "ok" });

    expect(checks.begun).toBe(begunBeforePublish + 1);
    expect(checks.terminalized).toEqual([
      { publicationId: collected.collected.publicationId, outcome: "publication-unknown" },
    ]);
  });
});

describe("§7.9a condition 2 — the no-Check lane's post-apply line batch", () => {
  test("foreground and recovery share one dispatch intent; the batch lands once even after its claim lapses", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);

    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    const publicationId = collected.collected.publicationId;
    const staged = await readPublication(db as never, publicationId);
    expect(staged?.payload.lineIntents).toHaveLength(1);

    const pem = await testAppPem();
    db.raw
      .prepare(`UPDATE review_bots SET private_key_enc = ? WHERE id = ?`)
      .run(
        await createSecretbox(TEST_KEY).encryptSecret(pem, `github_apps.private_key_enc:${TEST_APP_ID}`),
        TEST_APP_ID,
      );
    db.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
         VALUES (?, ?, 123, 'acme', datetime('now'))`,
      )
      .run(`inst-${TEST_APP_ID}-123`, TEST_APP_ID);
    const env = { DB: db as never, DASHBOARD_ENCRYPTION_KEY: TEST_KEY, REVIEW_QUEUE: { send: async () => {} } as never };

    const clock = { now: Date.now(), recoveryCreate: 0, recoveryReads: 0 };
    const batches: unknown[] = [];
    const lineOctokit: PostOctokit = {
      paginate: async () => [],
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          updateComment: async () => ({}),
          createComment: async () => ({}),
        },
        pulls: {
          createReview: async (params) => {
            batches.push(params);
            clock.now = Date.now() + PUBLICATION_LEASE_MS + 1;
            const realFetch = globalThis.fetch;
            globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
              const url = String(input);
              const json = (status: number, body: unknown) =>
                new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
              if (url.endsWith("/app")) return json(200, { id: 424242, slug: "acme-inspector" });
              if (url.endsWith("/access_tokens")) {
                return json(200, {
                  token: "ghs_recovery",
                  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
                  repositories: [{ id: 1, name: TEST_REPO }],
                  permissions: { contents: "write", metadata: "read", pull_requests: "write", issues: "write" },
                  repository_selection: "selected",
                });
              }
              if (url.includes("/pulls/") && url.includes("/reviews")) {
                if (init?.method === "POST") {
                  clock.recoveryCreate += 1;
                  return json(201, { id: 9100 });
                }
                clock.recoveryReads += 1;
                return json(200, []);
              }
              if (url.includes("/issues/") && init?.method === "POST") {
                clock.recoveryCreate += 1;
                return json(201, { id: 9100 });
              }
              return json(200, {});
            }) as unknown as typeof fetch;
            try {
              await reconcileReviewLifecycle(env as never, { log: { warn: () => {}, info: () => {} }, now: () => clock.now });
            } finally {
              globalThis.fetch = realFetch;
            }
            const comments = (params.comments as Array<Record<string, unknown>>).map((comment, index) => ({
              ...comment,
              id: 2001 + index,
            }));
            return { data: { id: 77, comments } };
          },
        },
      },
    };
    h.fakeCommenter.postLineComments = async (input) =>
      postLineCommentsWithOctokit(lineOctokit, input, publicationSendGuard(db as never, () => clock.now, input));

    const { deps: publishing } = await makeDeps({ db });
    expect(await publishAttempt(publishing, ref, publicationId)).toEqual({ kind: "ok" });

    expect(batches).toHaveLength(1);
    expect(clock.recoveryCreate).toBe(0);
    expect(clock.recoveryReads).toBeGreaterThanOrEqual(1);
    const after = await readLineBatchState(db as never, publicationId);
    expect(after).toEqual({ pending: false, dispatched: true, captures: 1 });
    const captured = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM review_threads WHERE publication_id = ? AND review_id IS NOT NULL`)
      .get(publicationId) as { n: number };
    expect(captured.n).toBe(1);

    expect(
      await recordLineDispatchIntent(db as never, publicationId, "recovery-again", clock.now + PUBLICATION_LEASE_MS * 4),
    ).toBeNull();
  });
});

describe("§7.9a condition 1 — only a `prepared` row may be dispatched", () => {
  test("a publication another lane already moved to `sending` is not sent by the foreground", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    const publicationId = collected.collected.publicationId;

    const earlier = await claimPublication(
      db as never,
      publicationId,
      "consumer:earlier",
      Date.now() - PUBLICATION_LEASE_MS - 1,
      "prepared",
    );
    expect(earlier).not.toBeNull();

    const { deps: publishing } = await makeDeps({ db });
    expect(await publishAttempt(publishing, ref, publicationId)).toEqual({ kind: "ok" });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    const row = db.raw
      .prepare(`SELECT phase, holder FROM review_publications WHERE id = ?`)
      .get(publicationId) as { phase: string; holder: string | null };
    expect(row.phase).toBe("sending");
    expect(row.holder).toBe("consumer:earlier");
  });
});

describe("§7.9a condition 1 — a refused dispatch keeps the publication link", () => {
  test("the refusal links the Check, and a later confirmation concludes from the proof", async () => {
    const { deps, db } = await makeDeps();
    const claimedCheck = await claimAttempt(db as never, {
      scope: SCOPE,
      githubAppId: 424242,
      headSha: SHA,
      triggeredBy: "pull_request",
      action: "opened",
      holder: `consumer:${ATTEMPT_ID}`,
      nowMs: Date.now(),
      executionDeadlineMs: Date.now() + 600_000,
    });
    if (claimedCheck.kind !== "claimed") throw new Error(`fixture: expected claimed, got ${claimedCheck.kind}`);
    const checkAttemptId = claimedCheck.attempt.identity.attemptId;
    const identity = claimedCheck.attempt.identity;
    expect(await setCheckCreateState(db as never, checkAttemptId, claimedCheck.lease, "sending", undefined, Date.now())).toBe(true);
    expect(await attachCheckRunId(db as never, checkAttemptId, claimedCheck.lease, 4242, Date.now())).toBe(true);
    expect(await releaseCheckClaim(db as never, checkAttemptId, claimedCheck.lease, Date.now())).toBe(true);

    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    const publicationId = collected.collected.publicationId;
    const frozen = db.raw
      .prepare(`SELECT attempt_key, generation FROM review_checks WHERE id = ?`)
      .get(checkAttemptId) as { attempt_key: string; generation: number };
    expect(await freezeAttemptIdentity(db as never, ref.attemptId, { key: frozen.attempt_key, generation: frozen.generation })).toBe(true);

    expect(
      await claimPublication(
        db as never,
        publicationId,
        "consumer:earlier",
        Date.now() - PUBLICATION_LEASE_MS - 1,
        "prepared",
      ),
    ).not.toBeNull();

    let now = Date.now();
    let updates = 0;
    let failedTerminal = false;
    const octokit: ChecksOctokit = {
      rest: {
        checks: {
          update: async (params) => {
            updates += 1;
            const terminal = "conclusion" in params ? params.conclusion : undefined;
            if (terminal !== undefined && !failedTerminal) {
              failedTerminal = true;
              throw new Error("checks update unavailable");
            }
            return {
              data: {
                id: 4242,
                name: CHECK_NAME,
                head_sha: identity.headSha,
                external_id: identity.externalId,
                status: "completed",
                conclusion: terminal,
                output: "output" in params ? (params.output as { title?: string; summary?: string }) : undefined,
                app: { id: identity.githubAppId },
              },
            };
          },
          create: async () => {
            throw new Error("no create expected");
          },
          get: async () => {
            throw new Error("no get expected");
          },
          listForRef: async () => {
            throw new Error("no list expected");
          },
        },
      },
    } as ChecksOctokit;
    const adapter = createChecksAdapter({ db, nowMs: () => now, getOctokit: async () => octokit });
    const gate = { minScore: 0, passVerdicts: ["needs fixes"] };
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => now,
      getAdapter: () => adapter,
      getCheckGate: async () => gate,
    });

    const { deps: publishing } = await makeDeps({ db });
    publishing.checks = lifecycle;
    expect(await publishAttempt(publishing, ref, publicationId)).toEqual({ kind: "ok" });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    let row = db.raw
      .prepare(`SELECT publication_id, desired, desired_summary, observed, recovery_state, terminal_ms FROM review_checks WHERE id = ?`)
      .get(checkAttemptId) as {
      publication_id: string | null;
      desired: string;
      desired_summary: string | null;
      observed: string;
      recovery_state: string;
      terminal_ms: number | null;
    };
    expect(row.publication_id).toBe(publicationId);
    expect(row.desired).toBe("failure");
    expect(row.desired_summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.terminal_ms).toBeNull();

    const confirmedAt = Date.now();
    const proofLease = await claimPublication(db as never, publicationId, "proof-lane", confirmedAt, "sending");
    if (proofLease === null) throw new Error("fixture: the proof claim was refused");
    const staged = await readPublication(db as never, publicationId);
    if (staged === null) throw new Error("fixture: the staged publication is gone");
    if (staged.payload.artifact !== null) {
      db.raw
        .prepare(`UPDATE review_publications SET payload_json = ? WHERE id = ?`)
        .run(
          JSON.stringify({
            ...staged.payload,
            artifact: {
              ...staged.payload.artifact,
              payload: {
                ...(staged.payload.artifact.payload as Record<string, unknown>),
                tally: {
                  verdict: "needs fixes",
                  scorePct: 92,
                  tally: { mustFix: 0, shouldFix: 1, nit: 0 },
                  chatHeader: "h",
                },
              },
            },
          }),
          publicationId,
        );
    }
    expect(
      await recordPublicationProof(db as never, publicationId, proofLease, {
        publicationId,
        scope: SCOPE,
        headSha: SHA,
        kind: "review",
        round: staged.payload.round,
        commentId: 9001,
        bodySha256: staged.payload.bodySha256,
        confirmedMs: confirmedAt,
      }),
    ).toBe(true);
    expect(await applyPublishedLifecycle(db as never, publicationId, proofLease, confirmedAt)).toBe(true);

    now = confirmedAt + 120_000;
    const recoveryLease = await claimCheckRecovery(db as never, checkAttemptId, "recovery-test", now, RECONCILE_DEFAULTS.checkMaxAttempts);
    if (recoveryLease === null) throw new Error("fixture: the recovery claim was refused");
    await lifecycle.terminalize({
      handle: { attemptId: checkAttemptId, scope: SCOPE, githubAppId: 424242, headSha: SHA, lease: recoveryLease },
      publicationId,
      outcome: "publication-unknown",
    });

    row = db.raw
      .prepare(`SELECT publication_id, desired, desired_summary, observed, terminal_ms FROM review_checks WHERE id = ?`)
      .get(checkAttemptId) as {
      publication_id: string | null;
      desired: string;
      desired_summary: string | null;
      observed: string;
      recovery_state: string;
      terminal_ms: number | null;
    };
    expect(row.publication_id).toBe(publicationId);
    expect(row.desired).toBe("success");
    expect(row.desired_summary).not.toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    expect(row.desired_summary).toContain(`Review gate met for ${SHA.slice(0, 7)}`);
    expect(row.observed).toBe(row.desired);
    expect(row.terminal_ms).not.toBeNull();
  });
});

describe("cleanupAttempt", () => {
  test("a launched row with no persisted result destroys nothing and releases nothing", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null);
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });

    expect(await cleanupAttempt(deps, ref)).toEqual({ retention: "unknown" });
    expect(h.sandbox.destroyCalls).toBe(0);
  });

  test("a concurrent launch wins the race: the CAS loses and the container survives", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null);
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });

    let resolved = 0;
    const guarded = {
      ...deps,
      getSandbox: async (binding: unknown, id: string) => {
        resolved += 1;
        return h.overrides.getSandbox(binding, id);
      },
    };

    expect(await cleanupAttempt(guarded, ref)).toEqual({ retention: "unknown" });
    expect(resolved).toBe(0);
    expect(h.sandbox.destroyCalls).toBe(0);
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("launched");
  });

  test("a row another cleanup abandoned is unknown for the second cleanup", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null);
    expect(await abandonReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toBe(true);

    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("abandoned");
    expect(await cleanupAttempt(deps, ref)).toEqual({ retention: "unknown" });
    expect(h.sandbox.destroyCalls).toBe(0);
  });

  test("no launch row still CLAIMS: absent is no exception", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());

    expect(await cleanupAttempt(deps, ref)).toEqual({ retention: "no-paid-work" });
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("abandoned");
    expect(h.sandbox.destroyCalls).toBe(0);
  });

  test("a persisted launch row authorises the teardown with the retained proof", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    await reviewAttempt(deps, ref, JSON.parse(JSON.stringify(step.prepared)));

    expect(await cleanupAttempt(deps, ref)).toEqual({ retention: "retained" });
    expect(h.sandbox.destroyCalls).toBe(1);
  });
});

describe("runReviewAttemptWorkflow", () => {
  test("the workflow route composes the same five phases end to end", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);

    await runReviewAttemptWorkflow(deps, makeRef(payload), inlineWorkflowStep(), async () => {});

    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(1);
    expect(h.sandbox.destroyCalls).toBe(1);
  });
});

describe("the owed Check mark", () => {
  async function seedOwnedCheck(db: Awaited<ReturnType<typeof createSeededTestD1>>) {
    const claimed = await claimAttempt(db as never, {
      scope: SCOPE,
      githubAppId: 424242,
      headSha: SHA,
      triggeredBy: "pull_request",
      action: "opened",
      holder: `consumer:${ATTEMPT_ID}`,
      nowMs: Date.now(),
      executionDeadlineMs: Date.now() + 600_000,
    });
    if (claimed.kind !== "claimed") throw new Error(`the test could not create the row: ${claimed.kind}`);
    const row = db.raw
      .prepare("SELECT id, generation, attempt_key FROM review_checks WHERE id = ?")
      .get(claimed.attempt.identity.attemptId) as { id: string; generation: number; attempt_key: string };
    return { row, handle: { ...HANDLE, attemptId: row.id } };
  }

  async function preparedWithIdentity(db: Awaited<ReturnType<typeof createSeededTestD1>>, ref: AttemptRef) {
    const { row, handle } = await seedOwnedCheck(db);
    const { deps } = await makeDeps({ db });
    deps.checks = { begin: async () => handle, terminalize: async () => {} };
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    return { prepared: JSON.parse(JSON.stringify(step.prepared)) as PreparedAttempt, row, handle };
  }

  test("a rival freeze of a different head wins: this attempt settles as skipped", async () => {
    const { db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    const ref = makeRef(payload);
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), { key: "rival-head-key", generation: 1 });
    const { deps } = await makeDeps({ db });
    const { handle } = await seedOwnedCheck(db);
    deps.checks = { begin: async () => handle, terminalize: async () => {} };

    const movedStep = await prepareAttempt(deps, ref);
    expect(movedStep).toMatchObject({ kind: "failed", failure: { class: "moved-head" } });

    const row = db.raw
      .prepare("SELECT attempt_key FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { attempt_key: string };
    expect(row.attempt_key).toBe("rival-head-key");
  });

  test("a moved head records NO failure row and settles as skipped", async () => {
    const { db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    const ref = makeRef(payload);
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), { key: "rival-head-key", generation: 1 });
    const { deps } = await makeDeps({ db });
    const { handle } = await seedOwnedCheck(db);
    deps.checks = { begin: async () => handle, terminalize: async () => {} };

    const successors: ReviewJobPayload[] = [];
    await runReviewAttemptWorkflow(deps, ref, inlineWorkflowStep(), async (successor) => {
      successors.push(successor);
    });
    const failures = db.raw.prepare("SELECT COUNT(*) AS n FROM review_failures").get() as { n: number };
    expect(failures.n).toBe(0);
    const row = db.raw
      .prepare("SELECT attempt_key, state FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { attempt_key: string; state: string };
    expect(row.attempt_key).toBe("rival-head-key");
    expect(row.state).not.toBe("launched");
    expect(successors).toHaveLength(1);
    expect(successors[0]!.head_sha).toBe(SHA);
    expect(successors[0]!.head_at).toBeUndefined();
    expect(successors[0]!.successor_of).toBeString();
    expect(successors[0]!.attachDeliveryId).toMatch(/^successor:/);
    const outbox = db.raw.prepare("SELECT state FROM review_successors").all() as Array<{ state: string }>;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.state).toBe("delivered");
  });

  test("a same-identity freeze proceeds rather than skipping", async () => {
    const { db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    const ref = makeRef(payload);
    const { row, handle } = await seedOwnedCheck(db);
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), {
      key: row.attempt_key,
      generation: row.generation,
    });
    const { deps } = await makeDeps({ db });
    deps.checks = { begin: async () => handle, terminalize: async () => {} };

    const step = await prepareAttempt(deps, ref);
    expect(step.kind).toBe("prepared");
    const frozen = db.raw
      .prepare("SELECT attempt_key, attempt_generation FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { attempt_key: string; attempt_generation: number };
    expect(frozen).toEqual({ attempt_key: row.attempt_key, attempt_generation: row.generation });
  });

  test("a refused initial claim still freezes the identity the publication owes against", async () => {
    const { db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = { ...makeRef(payload), checkClaimSha: SHA };
    const claimed = await claimAttempt(db as never, {
      scope: SCOPE,
      githubAppId: 424242,
      headSha: SHA,
      triggeredBy: "pull_request",
      action: "opened",
      holder: "consumer:original",
      nowMs: Date.now(),
      executionDeadlineMs: Date.now() + 600_000,
    });
    if (claimed.kind !== "claimed") throw new Error("seed failed");
    const held = db.raw
      .prepare("SELECT id, generation, attempt_key FROM review_checks WHERE id = ?")
      .get(claimed.attempt.identity.attemptId) as { id: string; generation: number; attempt_key: string };

    const preparing = await makeDeps({ db });
    preparing.deps.checks = { begin: async () => null, terminalize: async () => {} };
    const step = await prepareAttempt(preparing.deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const frozen = db.raw
      .prepare("SELECT attempt_key, attempt_generation FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { attempt_key: string; attempt_generation: number };
    expect(frozen).toEqual({ attempt_key: held.attempt_key, attempt_generation: held.generation });

    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    const publishing = await makeDeps({ db });
    publishing.deps.checks = { begin: async () => null, terminalize: async () => {} };
    expect(await publishAttempt(publishing.deps, ref, collected.collected.publicationId)).toEqual({ kind: "ok" });

    const launch = db.raw
      .prepare("SELECT check_owed_ms, check_key, check_generation FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as {
      check_owed_ms: number | null;
      check_key: string | null;
      check_generation: number | null;
    };
    expect(launch.check_key).toBe(held.attempt_key);
    expect(launch.check_generation).toBe(held.generation);
    expect(launch.check_owed_ms).not.toBeNull();
  });

  test("a handle-less publisher still records the obligation, from the frozen identity", async () => {
    const { db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const { prepared, row } = await preparedWithIdentity(db, ref);
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);

    const publishing = await makeDeps({ db });
    publishing.deps.checks = { begin: async () => null, terminalize: async () => {} };
    expect(await publishAttempt(publishing.deps, ref, collected.collected.publicationId)).toEqual({ kind: "ok" });

    const launch = db.raw
      .prepare("SELECT check_owed_ms, check_key, check_generation FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as {
      check_owed_ms: number | null;
      check_key: string | null;
      check_generation: number | null;
    };
    expect(launch.check_key).toBe(row.attempt_key);
    expect(launch.check_generation).toBe(row.generation);
    expect(launch.check_owed_ms).toBeGreaterThan(Date.now());
    expect((await readPublication(db as never, collected.collected.publicationId))?.proof).not.toBeNull();
  });

  test("the mark uses the ROW's frozen identity, never a recomputation", async () => {
    const { db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const { prepared, row } = await preparedWithIdentity(db, ref);
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);

    db.raw.prepare("UPDATE review_checks SET attempt_key = 'frozen-by-hand' WHERE id = ?").run(row.id);
    db.raw.prepare("UPDATE review_launches SET attempt_key = 'frozen-by-hand' WHERE attempt_id = ?").run(ATTEMPT_ID);

    const publishing = await makeDeps({ db });
    publishing.deps.checks = { begin: async () => null, terminalize: async () => {} };
    expect(await publishAttempt(publishing.deps, ref, collected.collected.publicationId)).toEqual({ kind: "ok" });

    const launch = db.raw
      .prepare("SELECT check_owed_ms, check_key FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { check_owed_ms: number | null; check_key: string | null };
    expect(launch.check_key).toBe("frozen-by-hand");
    expect(launch.check_owed_ms).not.toBeNull();
  });

  test("an adopted Check that stays open records the frozen identity", async () => {
    const { db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const { prepared, row, handle } = await preparedWithIdentity(db, ref);
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);

    const publishing = await makeDeps({ db });
    publishing.deps.checks = { begin: async () => handle, terminalize: async () => {} };
    expect(await publishAttempt(publishing.deps, ref, collected.collected.publicationId)).toEqual({ kind: "ok" });

    const launch = db.raw
      .prepare("SELECT check_owed_ms, check_generation FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { check_owed_ms: number | null; check_generation: number | null };
    expect(launch.check_generation).toBe(row.generation);
    expect(launch.check_owed_ms).toBeGreaterThan(Date.now());
    expect(h.logLines.some((line) => line.fields.event === "check_settlement_owed")).toBe(true);
  });
});

describe("a first publication past the frozen instant", () => {
  test("publish refuses at/after the deadline, before the journal is claimed or anything is sent", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);

    const { deps: publishing } = await makeDeps({ db });
    const late = { ...ref, deadlineMs: Date.now() - 1 };
    // A budget stop is TERMINAL, so it crosses the step boundary as a record.
    expect(await publishAttempt(publishing, late, collected.collected.publicationId)).toMatchObject({
      kind: "failed",
      failure: { class: "budget", window: "runner", phase: "publish" },
    });

    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    expect((await readPublication(db as never, collected.collected.publicationId))?.phase).toBe("prepared");
  });

  test("a first send carries the frozen instant into the adapter, which enforces it at the mutation", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);

    const { deps: publishing } = await makeDeps({ db });
    expect(await publishAttempt(publishing, ref, collected.collected.publicationId)).toEqual({ kind: "ok" });

    const send = h.commenterCalls.find((call) => call.op === "post-prepared");
    expect((send?.args as { notAfterMs?: number } | undefined)?.notAfterMs).toBe(ref.deadlineMs);
  });

  test("the degraded notice carries the same instant", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = "not a verdict";
    const ref = makeRef(payload);
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    expect(await collectAttempt(collecting, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "degraded" } });

    const send = h.commenterCalls.find((call) => call.op === "post-prepared-degraded");
    expect((send?.args as { notAfterMs?: number } | undefined)?.notAfterMs).toBe(ref.deadlineMs);
  });

  test("a degraded UPDATE is not staged while its target is held by a cleanup", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = "not a verdict";
    h.fakeCommenter.planDegradedUpsert = async () => ({ action: "update", commentId: 7001, round: 2 });
    const ref = makeRef(payload);
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);

    const held = await claimDegradedTarget(db as never, {
      scope: SCOPE,
      commentId: 7001,
      holder: "cleanup:123:7001",
      nowMs: Date.now(),
    });
    expect(held).not.toBeNull();

    const { deps: collecting } = await makeDeps({ db });
    expect(await collectAttempt(collecting, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "degraded" } });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared-degraded")).toHaveLength(0);
    const staged = db.raw.prepare(`SELECT COUNT(*) AS n FROM review_publications WHERE kind = 'degraded'`).get() as { n: number };
    expect(staged.n).toBe(0);
  });

  test("a degraded send refused at the mutation settles as a wall-clock stop, never as a swallowed failure", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = "not a verdict";
    const ref = makeRef(payload);
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);

    h.commenterState.preparedDegradedError = new PublicationDeadlineSpent(
      "create comment: the attempt's frozen deadline passed 5ms ago — nothing was sent",
    );
    const { deps: collecting } = await makeDeps({ db });
    expect(await collectAttempt(collecting, ref, prepared)).toMatchObject({
      kind: "failed",
      failure: { class: "budget", window: "runner", phase: "collect" },
    });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared-degraded")).toHaveLength(1);
  });

  test("the degraded notice takes the same refusal", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = "not a verdict";
    const ref = makeRef(payload);
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);

    const { deps: collecting } = await makeDeps({ db });
    expect(await collectAttempt(collecting, { ...ref, deadlineMs: Date.now() - 1 }, prepared)).toMatchObject({
      kind: "failed",
      failure: { class: "budget", window: "runner", message: expect.stringContaining("no first publication") },
    });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared-degraded")).toHaveLength(0);
  });
});

describe("an unreadable activation fact is unknown, never a review failure", () => {
  function rejectOnce<Db extends object>(db: Db, sqlMarker: string, method: "first" | "run"): Db {
    let failed = false;
    return new Proxy(db, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== "prepare" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const stmt = value.call(target, sql) as object;
          if (!sql.includes(sqlMarker)) return stmt;
          return new Proxy(stmt, {
            get(s, sp) {
              const member = Reflect.get(s, sp);
              if (sp !== "bind" || typeof member !== "function") {
                return typeof member === "function" ? member.bind(s) : member;
              }
              return (...bound: unknown[]) => {
                const b = member.apply(s, bound) as object;
                return new Proxy(b, {
                  get(bb, bp) {
                    const fn = Reflect.get(bb, bp);
                    if (bp !== method || typeof fn !== "function") {
                      return typeof fn === "function" ? fn.bind(bb) : fn;
                    }
                    return (...args: unknown[]) => {
                      if (!failed) {
                        failed = true;
                        return Promise.reject(new Error("the statement's reply was lost"));
                      }
                      return fn.apply(bb, args);
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
  }

  test("a rejected activation read concludes nothing, destroys nothing and releases nothing", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    expect(await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null)).toBe("claimed");
    const inflightKey = {
      installation_id: 123,
      owner: TEST_OWNER,
      repo: TEST_REPO,
      pr_number: TEST_PR_NUMBER,
      workspace_id: "default",
    };
    expect(
      await acquireInflight(db as never, inflightKey, {
        systemCap: 32,
        workspaceCap: 16,
        attemptId: ATTEMPT_ID,
        ttlSeconds: 900,
        headSha: SHA,
        now: new Date().toISOString(),
      }),
    ).toEqual({ ok: true });

    const concluded: string[] = [];
    deps.checks = {
      begin: async () => HANDLE,
      markInProgress: async () => ({ kind: "settled" as const, promoted: false }),
      terminalize: async (input: { outcome: string }) => {
        concluded.push(input.outcome);
      },
      abandonTerminalize: async () => true,
    };
    deps.env = {
      ...deps.env,
      DB: rejectOnce(db, "SELECT sandbox_id, activated_ms, revoked_ms FROM review_launches", "first"),
    } as unknown as typeof deps.env;
    const ref = { ...makeRef(payload), checkClaimSha: SHA };

    await runReviewAttemptWorkflow(deps, ref, inlineWorkflowStep(), async () => {});

    expect(concluded).toEqual([]);
    const failures = db.raw.prepare("SELECT COUNT(*) AS n FROM review_failures").get() as { n: number };
    expect(failures.n).toBe(0);
    // The launch row still proves `no-paid-work`, so cleanup releases capacity
    // and fences the slot: an unknown outcome holds nothing when D1 shows that
    // nothing paid could be lost (design D6, "behaviour change to note").
    expect(h.sandbox.destroyCalls).toBe(1);
    const inflight = db.raw.prepare("SELECT attempt_id FROM review_inflight").all() as Array<{ attempt_id: string }>;
    expect(inflight).toEqual([]);
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).not.toBe("failed");
  });
});

describe("the workflow host entry", () => {
  test("resolves the GitHub adapter without resolving the App's paid configuration", async () => {
    const { deps } = await makeDeps();
    deps.appCommenters.clear();
    deps.runnerConfigs.clear();
    const payload = makePayload();

    expect(await hydrateAttemptHost(payload, deps)).toBe("ready");
    expect(deps.appCommenters.has(TEST_APP_ID)).toBe(true);
    expect(deps.runnerConfigs.size).toBe(0);

    const config = await ensureRunnerConfig(payload, deps);
    expect(config.appCfg.modelChain).toBe("ark/deepseek-v4-flash");
    expect(deps.runnerConfigs.get(TEST_APP_ID)).toBe(config);
  });
});

describe("a resumed settlement claims only the frozen pair", () => {
  test("an attempt whose row froze no Check identity claims nothing at all", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const claimed = await claimAttempt(db as never, {
      scope: SCOPE,
      githubAppId: 424242,
      headSha: SHA,
      triggeredBy: "pull_request",
      action: "opened",
      holder: `consumer:${ATTEMPT_ID}`,
      nowMs: Date.now(),
      executionDeadlineMs: Date.now() + 600_000,
    });
    if (claimed.kind !== "claimed") throw new Error(`the test could not create the row: ${claimed.kind}`);
    const handle: CheckHandle = { ...HANDLE, attemptId: claimed.attempt.identity.attemptId };
    deps.checks = { begin: async () => handle, terminalize: async () => {} };
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);

    db.raw
      .prepare("UPDATE review_launches SET attempt_key = NULL, attempt_generation = NULL WHERE attempt_id = ?")
      .run(ATTEMPT_ID);

    let begun = 0;
    const publishing = await makeDeps({ db });
    publishing.deps.checks = {
      begin: async () => {
        begun += 1;
        return handle;
      },
      terminalize: async () => {},
    };
    expect(await publishAttempt(publishing.deps, ref, collected.collected.publicationId)).toEqual({ kind: "ok" });

    expect(begun).toBe(0);
    const launch = db.raw
      .prepare("SELECT check_owed_ms FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { check_owed_ms: number | null };
    expect(launch.check_owed_ms).toBeNull();
  });
});

describe("the publication settlement mark", () => {
  async function stagedPublication(): Promise<{
    db: Awaited<ReturnType<typeof createSeededTestD1>>;
    ref: AttemptRef;
    payload: ReviewJobPayload;
    publicationId: string;
  }> {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 500,
      deadlineMs: ref.deadlineMs,
    });
    return { db, ref, payload, publicationId: collected.collected.publicationId };
  }

  test("a send whose proof is not durable is NOT settled — discovery still owns it", async () => {
    const { db, ref, payload, publicationId } = await stagedPublication();
    const publishing = await makeDeps({ db });
    publishing.deps.checks = { begin: async () => null, terminalize: async () => {} };
    const failingDb = new Proxy(db as unknown as object, {
      get(target, prop) {
        if (prop === "prepare") {
          const underlying = target as { prepare(query: string): unknown };
          return (sql: string) => {
            if (sql.includes("proof_json = ?")) throw new Error("injected: the proof write is not durable");
            return underlying.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    publishing.deps.env.DB = failingDb as never;

    expect(await publishAttempt(publishing.deps, ref, publicationId)).toEqual({ kind: "ok" });

    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(1);
    expect((await readPublication(db as never, publicationId))?.phase).toBe("sending");
    expect((await readAttemptHandoff(db as never, deliveryKeyOf(payload)))?.settledMs).toBeNull();
  });

  test("a closed publication records the settlement the report's third bucket ends at", async () => {
    const { db, ref, payload, publicationId } = await stagedPublication();
    const publishing = await makeDeps({ db });
    publishing.deps.checks = { begin: async () => null, terminalize: async () => {} };

    expect(await publishAttempt(publishing.deps, ref, publicationId)).toEqual({ kind: "ok" });

    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
    expect(handoff?.settledMs).toEqual(expect.any(Number));
    expect(handoff?.settledEffects).toContain("publication");
  });

  test("a foreground settlement failure leaves nothing applied-but-unmeasured", async () => {
    const { db, ref, payload, publicationId } = await stagedPublication();
    const publishing = await makeDeps({ db });
    publishing.deps.checks = { begin: async () => null, terminalize: async () => {} };
    const underlying = db as unknown as { prepare(query: string): unknown };
    publishing.deps.env.DB = new Proxy(db as unknown as object, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("UPDATE review_attempt_handoffs")) {
              throw new Error("injected: the settlement write never landed");
            }
            return underlying.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as never;

    expect(await publishAttempt(publishing.deps, ref, publicationId)).toEqual({ kind: "ok" });

    expect((await readPublication(db as never, publicationId))?.phase).toBe("confirmed");
    expect((await readAttemptHandoff(db as never, deliveryKeyOf(payload)))?.settledMs).toBeNull();
  });

  test("a resumed publication whose Check is open and held elsewhere is not settled", async () => {
    const { db, ref, payload, publicationId } = await stagedPublication();
    const claimed = await claimAttempt(db as never, {
      scope: SCOPE,
      githubAppId: 424242,
      headSha: SHA,
      triggeredBy: "pull_request",
      action: "opened",
      holder: "someone-else",
      nowMs: Date.now(),
      executionDeadlineMs: Date.now() + 600_000,
    });
    if (claimed.kind !== "claimed") throw new Error(`test setup: claim failed: ${claimed.kind}`);
    const check = db.raw
      .prepare("SELECT attempt_key, generation FROM review_checks WHERE id = ?")
      .get(claimed.attempt.identity.attemptId) as { attempt_key: string; generation: number };
    db.raw
      .prepare("UPDATE review_launches SET attempt_key = ?, attempt_generation = ? WHERE attempt_id = ?")
      .run(check.attempt_key, check.generation, ATTEMPT_ID);

    const publishing = await makeDeps({ db });
    publishing.deps.checks = undefined;
    expect(await publishAttempt(publishing.deps, ref, publicationId)).toEqual({ kind: "ok" });

    expect((await readPublication(db as never, publicationId))?.phase).toBe("applied");
    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
    expect(handoff?.settledMs).toBeNull();
    expect(handoff?.settledEffects).toContain("publication");
  });

  test("a journal that refuses to close leaves the attempt unmeasured", async () => {
    const { db, ref, payload, publicationId } = await stagedPublication();
    const publishing = await makeDeps({ db });
    publishing.deps.checks = { begin: async () => null, terminalize: async () => {} };
    h.commenterState.preparedReviewReject = true;
    const underlying = db as unknown as { prepare(query: string): unknown };
    publishing.deps.env.DB = new Proxy(db as unknown as object, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("phase = 'failed'")) {
              throw new Error("injected: the journal refused to close");
            }
            return underlying.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as never;

    expect(await publishAttempt(publishing.deps, ref, publicationId)).toEqual({ kind: "ok" });

    expect((await readPublication(db as never, publicationId))?.phase).not.toBe("failed");
    expect((await readAttemptHandoff(db as never, deliveryKeyOf(payload)))?.settledMs).toBeNull();
  });

  test("a degraded notice settles the attempt it completed", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = "not a verdict";
    const ref = makeRef(payload);
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
    const { deps: reviewing } = await makeDeps({ db });
    await reviewAttempt(reviewing, ref, prepared);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 500,
      deadlineMs: ref.deadlineMs,
    });

    const { deps: collecting } = await makeDeps({ db });
    expect(await collectAttempt(collecting, ref, prepared)).toEqual({
      kind: "settled",
      outcome: { kind: "degraded" },
    });

    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
    expect(handoff?.settledMs).toEqual(expect.any(Number));
    expect(handoff?.settledEffects).toContain("publication");
  });
});

async function seedCheckRow(db: TestD1) {
  const claimed = await claimAttempt(db as never, {
    scope: SCOPE,
    githubAppId: 424242,
    headSha: SHA,
    triggeredBy: "pull_request",
    action: "opened",
    holder: `consumer:${ATTEMPT_ID}`,
    nowMs: Date.now(),
    executionDeadlineMs: Date.now() + 600_000,
  });
  if (claimed.kind !== "claimed") throw new Error(`the test could not create the row: ${claimed.kind}`);
  const handle: CheckHandle = { ...HANDLE, attemptId: claimed.attempt.identity.attemptId };
  expect(await setCheckCreateState(db as never, handle.attemptId, claimed.lease, "sending", undefined, Date.now())).toBe(true);
  expect(await attachCheckRunId(db as never, handle.attemptId, claimed.lease, 4242, Date.now())).toBe(true);
  expect(await releaseCheckClaim(db as never, handle.attemptId, claimed.lease, Date.now())).toBe(true);
  return { checkId: handle.attemptId, handle };
}

async function preparedPublication(
  db: TestD1,
  ref: AttemptRef,
  checks: ProcessDeps["checks"],
): Promise<{ publicationId: string; prepared: PreparedAttempt }> {
  const { deps } = await makeDeps({ db });
  deps.checks = checks;
  const step = await prepareAttempt(deps, ref);
  if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
  const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));
  await reviewAttempt(deps, ref, prepared);
  const collected = await collectAttempt(deps, ref, prepared);
  if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
  return { publicationId: collected.collected.publicationId, prepared };
}

describe("§7.9a condition 1 — a refused action lease keeps the publication link", () => {
  test("the Check's action lease held elsewhere leaves the link a confirmation can correct", async () => {
    const { db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const { checkId, handle } = await seedCheckRow(db);
    const { publicationId } = await preparedPublication(db, ref, {
      begin: async () => handle,
      terminalize: async () => {},
    });

    expect(
      await claimPublicationLease(db as never, {
        attemptId: checkId,
        actionKey: `comment:${publicationId}`,
        holder: "recovery:held",
        mode: "send",
        nowMs: Date.now(),
      }),
    ).not.toBeNull();
    const attempted: unknown[] = [];
    const transport: PostOctokit = {
      paginate: async () => {
        attempted.push("scan");
        return [];
      },
      rest: {
        issues: {
          listComments: async () => {
            attempted.push("list");
            return { data: [] };
          },
          createComment: async (params) => {
            attempted.push(params);
            return { data: { id: 9001 } };
          },
          updateComment: async (params) => {
            attempted.push(params);
            return { data: {} };
          },
        },
      },
    };

    const publishing = await makeDeps({ db });
    let now = Date.now();
    let terminalRefused = false;
    const octokit: ChecksOctokit = {
      rest: {
        checks: {
          update: async (params) => {
            const terminal = "conclusion" in params ? params.conclusion : undefined;
            if (terminal !== undefined && !terminalRefused) {
              terminalRefused = true;
              throw new Error("checks update unavailable");
            }
            return {
              data: {
                id: 4242,
                name: CHECK_NAME,
                head_sha: SHA,
                external_id: `mstar.review-check/v1:${SHA}:pull_request:opened`,
                status: "completed",
                conclusion: terminal,
                app: { id: 424242 },
              },
            };
          },
          create: async () => {
            throw new Error("no create expected");
          },
          get: async () => {
            throw new Error("no get expected");
          },
          listForRef: async () => {
            throw new Error("no list expected");
          },
        },
      },
    } as ChecksOctokit;
    const adapter = createChecksAdapter({ db, nowMs: () => now, getOctokit: async () => octokit });
    publishing.deps.checks = createCheckLifecycle({
      db,
      nowMs: () => now,
      getAdapter: () => adapter,
      getCheckGate: async () => ({ minScore: 0, passVerdicts: ["needs fixes"] }),
    });
    publishing.deps.appCommenters.set(TEST_APP_ID, {
      commenter: {
        ...h.fakeCommenter,
        postPreparedReview: async (input: PostPreparedReviewInput) =>
          postPreparedReviewWithOctokit(
            transport,
            input,
            publicationSendGuard(db as never, () => Date.now(), input),
          ),
      },
      fingerprint: "test-fingerprint",
      githubAppId: 424242,
    });

    expect(await publishAttempt(publishing.deps, ref, publicationId)).toEqual({ kind: "ok" });

    expect(attempted).toEqual([]);
    const row = db.raw
      .prepare(
        `SELECT publication_id, desired, desired_summary, recovery_state, terminal_ms
           FROM review_checks WHERE id = ?`,
      )
      .get(checkId) as {
      publication_id: string | null;
      desired: string;
      desired_summary: string | null;
      recovery_state: string;
      terminal_ms: number | null;
    };
    expect(row.publication_id).toBe(publicationId);
    expect(row.desired).toBe("failure");
    expect(row.desired_summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.terminal_ms).toBeNull();
  });

  test("a re-proof refusal keeps the link and leaves the publication unconfirmed", async () => {
    const { db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const { checkId, handle } = await seedCheckRow(db);
    const { publicationId } = await preparedPublication(db, ref, {
      begin: async () => handle,
      terminalize: async () => {},
    });

    const attempted: unknown[] = [];
    const transport: PostOctokit = {
      paginate: async () => {
        db.raw
          .prepare(
            `UPDATE publication_leases SET holder = NULL, lease_until_ms = NULL
              WHERE attempt_id = ? AND action_key = ?`,
          )
          .run(checkId, `comment:${publicationId}`);
        return [];
      },
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async (params) => {
            attempted.push(params);
            return { data: { id: 9001 } };
          },
          updateComment: async (params) => {
            attempted.push(params);
            return { data: {} };
          },
        },
      },
    };
    const publishing = await makeDeps({ db });
    const checksOctokit: ChecksOctokit = {
      rest: {
        checks: {
          update: async () => {
            throw new Error("checks update unavailable");
          },
          create: async () => {
            throw new Error("no create expected");
          },
          get: async () => {
            throw new Error("no get expected");
          },
          listForRef: async () => {
            throw new Error("no list expected");
          },
        },
      },
    } as ChecksOctokit;
    const adapter = createChecksAdapter({ db, nowMs: () => Date.now(), getOctokit: async () => checksOctokit });
    publishing.deps.checks = createCheckLifecycle({
      db,
      nowMs: () => Date.now(),
      getAdapter: () => adapter,
      getCheckGate: async () => ({ minScore: 0, passVerdicts: ["needs fixes"] }),
    });
    publishing.deps.appCommenters.set(TEST_APP_ID, {
      commenter: {
        ...h.fakeCommenter,
        postPreparedReview: async (input: PostPreparedReviewInput) =>
          postPreparedReviewWithOctokit(
            transport,
            input,
            publicationSendGuard(db as never, () => Date.now(), input),
          ),
      },
      fingerprint: "test-fingerprint",
      githubAppId: 424242,
    });

    expect(await publishAttempt(publishing.deps, ref, publicationId)).toEqual({ kind: "ok" });

    expect(attempted).toEqual([]);
    const publication = db.raw
      .prepare(`SELECT phase, holder FROM review_publications WHERE id = ?`)
      .get(publicationId) as { phase: string; holder: string | null };
    expect(publication.phase).toBe("prepared");
    expect(publication.holder).toBeNull();
    const row = db.raw
      .prepare(`SELECT publication_id, desired, recovery_state, terminal_ms FROM review_checks WHERE id = ?`)
      .get(checkId) as {
      publication_id: string | null;
      desired: string;
      recovery_state: string;
      terminal_ms: number | null;
    };
    expect(row.publication_id).toBe(publicationId);
    expect(row.desired).toBe("failure");
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.terminal_ms).toBeNull();
  });
});

describe("§7.9a condition 1 — no execution handle still contends for the Check lease", () => {
  test("the marker send is refused while the Check's own action lease is held", async () => {
    const { db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const { checkId, handle } = await seedCheckRow(db);
    const { publicationId } = await preparedPublication(db, ref, {
      begin: async () => handle,
      terminalize: async () => {},
    });
    expect(
      await claimPublicationLease(db as never, {
        attemptId: checkId,
        actionKey: `comment:${publicationId}`,
        holder: "recovery:held",
        mode: "send",
        nowMs: Date.now(),
      }),
    ).not.toBeNull();

    const attempted: unknown[] = [];
    const transport: PostOctokit = {
      paginate: async () => {
        attempted.push("scan");
        return [];
      },
      rest: {
        issues: {
          listComments: async () => {
            attempted.push("list");
            return { data: [] };
          },
          createComment: async (params) => {
            attempted.push(params);
            return { data: { id: 9001 } };
          },
          updateComment: async (params) => {
            attempted.push(params);
            return { data: {} };
          },
        },
      },
    };
    const publishing = await makeDeps({ db });
    publishing.deps.checks = {
      begin: async () => null,
      terminalize: async () => {},
    };
    publishing.deps.appCommenters.set(TEST_APP_ID, {
      commenter: {
        ...h.fakeCommenter,
        postPreparedReview: async (input: PostPreparedReviewInput) =>
          postPreparedReviewWithOctokit(
            transport,
            input,
            publicationSendGuard(db as never, () => Date.now(), input),
          ),
      },
      fingerprint: "test-fingerprint",
      githubAppId: 424242,
    });

    expect(await publishAttempt(publishing.deps, ref, publicationId)).toEqual({ kind: "ok" });

    expect(attempted).toEqual([]);
    expect((await readPublication(db as never, publicationId))?.phase).toBe("prepared");
  });
});

describe("a line-batch bookkeeping fault never vetoes the close-out", () => {
  test("a rejected dispatch intent leaves the batch to discovery and the Check still concludes", async () => {
    const { db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const { handle } = await seedCheckRow(db);
    const concluded: Array<{ publicationId: string | null; outcome: string }> = [];
    const checks = {
      begin: async () => handle,
      markInProgress: async () => ({ kind: "settled" as const, promoted: true }),
      terminalize: async (input: { publicationId: string | null; outcome: string }) => {
        concluded.push({ publicationId: input.publicationId, outcome: input.outcome });
      },
    };
    const { publicationId } = await preparedPublication(db, ref, checks);
    expect((await readPublication(db as never, publicationId))?.payload.lineIntents).toHaveLength(1);

    const publishing = await makeDeps({ db });
    publishing.deps.checks = checks;
    let failed = false;
    const flaky = new Proxy(db as object, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== "prepare" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const stmt = value.call(target, sql) as object;
          if (!sql.includes("line_dispatch_ms")) return stmt;
          return new Proxy(stmt, {
            get(s, sp) {
              const member = Reflect.get(s, sp);
              if (sp !== "bind" || typeof member !== "function") {
                return typeof member === "function" ? member.bind(s) : member;
              }
              return (...bound: unknown[]) => {
                const b = member.apply(s, bound) as object;
                return new Proxy(b, {
                  get(bb, bp) {
                    const fn = Reflect.get(bb, bp);
                    if (bp !== "run" || typeof fn !== "function") {
                      return typeof fn === "function" ? fn.bind(bb) : fn;
                    }
                    return (...args: unknown[]) => {
                      if (!failed) {
                        failed = true;
                        return Promise.reject(new Error("the dispatch intent's reply was lost"));
                      }
                      return fn.apply(bb, args);
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
    publishing.deps.env = { ...publishing.deps.env, DB: flaky } as unknown as typeof publishing.deps.env;

    expect(await publishAttempt(publishing.deps, ref, publicationId)).toEqual({ kind: "ok" });

    expect(concluded).toEqual([{ publicationId, outcome: "publication-unknown" }]);
    expect(h.commenterCalls.filter((call) => call.op === "line-comments")).toHaveLength(0);
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(1);
    const row = db.raw
      .prepare("SELECT line_dispatch_ms FROM review_publications WHERE id = ?")
      .get(publicationId) as { line_dispatch_ms: number | null };
    expect(row.line_dispatch_ms).toBeNull();
  });
});

describe("the SEC-01 publish gate", () => {
  const KEY = "p/a b";
  const ECHOES = {
    base64: Buffer.from(KEY).toString("base64"),
    "url-encoded": encodeURIComponent(KEY),
  } as const;

  async function reviewedEcho(
    echo: string,
    writeTimeKey: boolean,
    beforePrepare?: (db: TestD1) => Promise<void>,
  ): Promise<{
    deps: ProcessDeps;
    db: TestD1;
    ref: AttemptRef;
    prepared: PreparedAttempt;
  }> {
    const { deps, db } = await makeDeps();
    if (writeTimeKey) {
      deps.runnerConfigs.set(TEST_APP_ID, {
        appCfg: { keys: { ark: [KEY] }, modelChain: "ark/deepseek-v4-flash" },
        modelOverrides: undefined,
        customProviders: undefined,
      });
    }
    if (beforePrepare !== undefined) await beforePrepare(db);
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify({
      ...VALID_OUTPUT,
      findings: [{ ...VALID_OUTPUT.findings[0]!, body: `echo ${echo}` }],
    });
    const ref = makeRef(payload);
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared = JSON.parse(JSON.stringify(step.prepared)) as PreparedAttempt;
    await reviewAttempt(deps, ref, prepared);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 500,
      deadlineMs: ref.deadlineMs,
    });
    return { deps, db, ref, prepared };
  }

  for (const [name, echo] of Object.entries(ECHOES)) {
    test(`a short key echoed only as ${name} never reaches the stored result or the published body`, async () => {
      const { deps, db, ref, prepared } = await reviewedEcho(echo, true);

      const launch = db.raw
        .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
        .get(ATTEMPT_ID) as { result_json: string };
      const stored = JSON.parse(launch.result_json) as { run: { stdout: string } };
      expect(stored.run.stdout).not.toContain(echo);
      expect(stored.run.stdout).toContain("[REDACTED]");

      const collected = await collectAttempt(deps, ref, prepared);
      if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
      const { deps: publishing } = await makeDeps({ db });
      expect(await publishAttempt(publishing, ref, collected.collected.publicationId)).toEqual({ kind: "ok" });

      const send = h.commenterCalls.find((call) => call.op === "post-prepared");
      const body = (send?.args as { body: string } | undefined)?.body ?? "";
      expect(body).toContain("[REDACTED]");
      expect(body).not.toContain(echo);
    });

    test(`the publish gate refuses an outgoing body carrying a ${name} echo`, async () => {
      // RESUME-SHAPED: the paying step seals the session's OWN set onto the attempt
      // row, and the collector keeps nothing but the database — no in-process cache,
      // no re-sealed fixture. The credential must come back from that row.
      const { db, resumed, ref, prepared } = await paidThenResumed(echo, KEY);
      expect(resumed.credentials.size).toBe(0);
      expect(await openStoredGateSecrets(db)).toContain(KEY);
      // The settlement mark the gate writes lives on the attempt's handoff row.
      await reserveAttemptHandoff(db as never, {
        deliveryKey: deliveryKeyOf(ref.payload),
        attemptId: ATTEMPT_ID,
        payload: ref.payload,
        nowMs: Date.now(),
        createdMs: ref.roundStartedAt,
        enqueuedMs: 500,
        deadlineMs: ref.deadlineMs,
      });

      expect(await collectAttempt(resumed, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

      const staged = db.raw
        .prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?")
        .get(SHA) as { n: number };
      expect(staged.n).toBe(0);
      expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
      expect(
        h.logLines.some((line) => line.msg.includes("publish gate refused")),
      ).toBe(true);
      const failure = db.raw
        .prepare("SELECT error FROM review_failures WHERE head_sha = ?")
        .all(SHA) as { error: string }[];
      // The refusal names the ECHO — never the unrecoverable-set path — so this
      // case proves the gate actually scanned the recovered session credential.
      expect(failure.some((row) => row.error.includes("the outgoing body carries a credential echo"))).toBe(true);
      expect(failure.some((row) => row.error.includes("predates the sealed credential set"))).toBe(false);
      const handoff = db.raw
        .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
        .get(ATTEMPT_ID) as { settled_ms: number | null };
      expect(handoff.settled_ms).not.toBeNull();
    });
  }

  /**
   * note: A resume-shaped pair. The paying host resolves the config it holds and
   * the paid step seals the session's OWN set onto the attempt row; the resumed
   * host keeps nothing but the database — no credential cache, no resolved
   * config — so the row is its only carrier.
   */
  async function paidThenResumed(
    echo: string,
    paidKey = "sk-paid-session-1",
  ): Promise<{
    db: TestD1;
    resumed: ProcessDeps;
    ref: AttemptRef;
    prepared: PreparedAttempt;
    session: string[];
  }> {
    const { deps: paying, db } = await makeDeps();
    paying.runnerConfigs.set(TEST_APP_ID, {
      appCfg: { keys: { ark: [paidKey] }, modelChain: "ark/deepseek-v4-flash" },
      modelOverrides: undefined,
      customProviders: undefined,
    });
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    const step = await prepareAttempt(paying, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared = JSON.parse(JSON.stringify(step.prepared)) as PreparedAttempt;
    await reviewAttempt(paying, ref, prepared);
    const session = await openStoredGateSecrets(db);
    // The echo is in the PAID RESULT. Write-time redaction removes every form of
    // the values the paying host held, so a form it did not is written here —
    // which is exactly the body the gate exists to catch.
    stubStoredEcho(db, echo);
    const { deps: resumed } = await makeDeps({ db });
    resumed.runnerConfigs.clear();
    return { db, resumed, ref, prepared, session };
  }

  /**
   * note: Plant the gate set on the attempt row through the paid step's own seal —
   * the envelope is the ONLY source the gate reads.
   */
  async function sealStoredGateSecrets(db: TestD1, values: string[]): Promise<void> {
    const sealed = await sealGateSecrets(TEST_KEY, ATTEMPT_ID, values);
    db.raw
      .prepare("UPDATE review_launches SET gate_secrets_enc = ? WHERE attempt_id = ?")
      .run(sealed, ATTEMPT_ID);
  }

  /** The sealed set on the row, opened for assertions. */
  async function openStoredGateSecrets(db: TestD1): Promise<string[]> {
    const row = db.raw
      .prepare("SELECT gate_secrets_enc FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { gate_secrets_enc: string };
    return openGateSecrets(TEST_KEY, ATTEMPT_ID, row.gate_secrets_enc);
  }

  /** Rewrite the persisted paid result's first finding to carry `echo`. */
  function stubStoredEcho(db: TestD1, echo: string): void {
    const launch = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { result_json: string };
    const execution = JSON.parse(launch.result_json) as { run: { stdout: string; exitCode: number } };
    const output = JSON.parse(execution.run.stdout) as typeof VALID_OUTPUT;
    output.findings[0]!.body = `echo ${echo}`;
    execution.run.stdout = JSON.stringify(output);
    db.raw
      .prepare("UPDATE review_launches SET result_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(execution), ATTEMPT_ID);
  }

  /** Rewrite the persisted paid result's stdout wholesale (an unparseable body). */
  function stubStoredStdout(db: TestD1, stdout: string): void {
    const launch = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { result_json: string };
    const execution = JSON.parse(launch.result_json) as { run: { stdout: string; exitCode: number } };
    execution.run.stdout = stdout;
    db.raw
      .prepare("UPDATE review_launches SET result_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(execution), ATTEMPT_ID);
  }

  /**
   * A failure store whose `record` for ONE stage faults: `commitThenFail` models
   * D1 committing the write and losing the reply; `times` bounds how many calls
   * fault (Infinity = the row can never be written on this host).
   */
  type FailureStageName = ProcessDeps["failureStore"] extends { record: (input: infer T) => unknown }
    ? T extends { stage: infer S }
      ? S
      : never
    : never;

  function failureInsertFault(
    store: { record: (input: never) => Promise<void> } | ProcessDeps["failureStore"],
    stage: FailureStageName,
    mode: "fail" | "commitThenFail",
    times = 1,
  ): { store: ProcessDeps["failureStore"]; faults: () => number } {
    let faults = 0;
    const base = store as ProcessDeps["failureStore"];
    return {
      store: {
        ...base,
        record: async (input) => {
          if (input.stage !== stage || faults >= times) return base.record(input);
          if (mode === "commitThenFail") await base.record(input);
          faults += 1;
          throw new Error(`${stage} failure row insert lost`);
        },
      },
      faults: () => faults,
    };
  }

  /** The attempt's `recheck` shipped-failure rows. */
  function recheckRows(db: TestD1): Array<{ id: string; error: string }> {
    return db.raw.prepare("SELECT id, error FROM review_failures WHERE head_sha = ? AND stage = 'recheck'").all(SHA) as Array<{
      id: string;
      error: string;
    }>;
  }

  test("a resumed collect refuses the paid session's key echo after the config rotated", async () => {
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { db, resumed, ref, prepared, session } = await paidThenResumed(echo, paidKey);
    // note: The set the session actually handed the model is the paid key; the App
    // config a resumed host would re-resolve holds a DIFFERENT key (`ark-key`).
    expect(session).toContain(paidKey);
    expect(session).not.toContain("ark-key");
    // The encoded echo survived the paying host's own write-time redaction.
    const launch = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { result_json: string };
    expect(launch.result_json).toContain(echo);

    expect(await collectAttempt(resumed, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(true);
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
    const failure = db.raw.prepare("SELECT error FROM review_failures WHERE head_sha = ?").all(SHA) as {
      error: string;
    }[];
    expect(failure.some((row) => row.error.includes("publish gate refused"))).toBe(true);
  });

  test("a resumed collect refuses an encoded echo of the paid session's installation token", async () => {
    // note: The token is shape-redacted in its raw form only; its encoded form is
    // exactly what the gate must catch from the sealed set.
    const token = "ghs_installation_token";
    const echo = Buffer.from(token, "utf8").toString("base64");
    const { db, resumed, ref, prepared, session } = await paidThenResumed(echo);
    expect(session).toContain(token);

    expect(await collectAttempt(resumed, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(true);
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
  });

  test("a replayed paid step mints and caches nothing, and the gate scans the sealed set", async () => {
    // note: The review step RE-RUNS after the paid result is durable, on a host whose
    // current config resolves a different key and whose commenter would mint a new
    // token. It owns nothing: no token mint, no cache write — and collect still scans
    // the credentials the paid session actually handed the model.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { db, resumed, ref, prepared } = await paidThenResumed(echo, paidKey);
    h.commenterState.token = "ghs_rotated_installation_token";
    // The step that would spend resolves the config first, exactly as the workflow
    // does; only the CREDENTIALS must stay untouched.
    await ensureRunnerConfig(ref.payload, resumed);
    const mintsBefore = h.commenterCalls.filter((call) => call.op === "token").length;

    await reviewAttempt(resumed, ref, prepared);

    expect(h.commenterCalls.filter((call) => call.op === "token")).toHaveLength(mintsBefore);
    expect(resumed.credentials.size).toBe(0);

    expect(await collectAttempt(resumed, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });
    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(true);
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
  });

  test("a resumed collect whose envelope read faults does not publish", async () => {
    const { db, resumed, ref, prepared } = await paidThenResumed("plain text");
    // note: the envelope is on the row; the store read of it faults.
    const flaky = new Proxy(db as object, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop);
        return (sql: string) => {
          if (sql.includes("gate_secrets_enc")) throw new Error("gate-secrets read lost");
          return (target as { prepare: (statement: string) => unknown }).prepare(sql);
        };
      },
    });
    resumed.env = { ...resumed.env, DB: flaky as never };

    // note: A transient fault surfaces (the Workflow retries the step); it is never
    // absorbed into an empty set that would publish unscanned.
    await expect(collectAttempt(resumed, ref, prepared)).rejects.toThrow("gate-secrets read lost");
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
  });

  test("a pre-envelope attempt is refused at collect, not certified by provider keys", async () => {
    // note: An attempt paid before the sealed set existed carries no envelope, and
    // the App config a resumed host can read holds the CURRENT provider key — never
    // the session's. Nothing rebuilds a provider-keys-only set, so the attempt is
    // refused rather than certified by a list that cannot match the echo.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { db, resumed, ref, steps } = await paidWorkflowThenResumed(echo, paidKey);
    db.raw.prepare("UPDATE review_launches SET gate_secrets_enc = NULL WHERE attempt_id = ?").run(ATTEMPT_ID);

    await runReviewAttemptWorkflow(resumed, ref, stepStore(steps), async () => {});

    expect(h.logLines.some((line) => line.msg.includes("predates the sealed credential set"))).toBe(true);
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
    const failure = db.raw.prepare("SELECT error FROM review_failures WHERE head_sha = ?").all(SHA) as {
      error: string;
    }[];
    expect(failure.some((row) => row.error.includes("predates the sealed credential set"))).toBe(true);
    // note: No provider-keys-only set was rebuilt to stand in for the session's.
    expect(resumed.credentials.size).toBe(0);
  });

  test("an unreadable launch fence on a persisted replay is unknown, not a failure", async () => {
    // note: The leading paid-result probe carries the paid-entry ladder's semantics:
    // a store fault means the fence is UNOBSERVABLE, so the attempt is left
    // unresolved — a failure row plus a claim stamp on an already-paid review is
    // unrecoverable, and the next read may well succeed.
    const { db, resumed, ref, steps } = await paidWorkflowThenResumed("plain text");
    const replay = new Map([...steps].filter(([name]) => name === "prepare"));
    let faults = 0;
    const faulting = new Proxy(db as object, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop);
        return (sql: string) => {
          if (faults === 0 && sql.includes("SELECT state, claimed_at_ms")) {
            faults += 1;
            throw new Error("launch fence read lost");
          }
          return (target as { prepare: (statement: string) => unknown }).prepare(sql);
        };
      },
    });
    resumed.env = { ...resumed.env, DB: faulting as never };

    await runReviewAttemptWorkflow(resumed, ref, stepStore(replay), async () => {});

    expect(faults).toBe(1);
    // Unresolved: nothing concluded, nothing stamped, nothing published.
    expect(h.logLines.some((line) => line.msg.includes("review unresolved"))).toBe(true);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_failures WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    // The claim is NOT stamped: an unobserved fence does not condemn the commit.
    expect(h.kvPuts.filter((put) => put.key.startsWith("idem:"))).toHaveLength(0);
  });

  test("a refused degraded review still accounts its shipped recheck round", async () => {
    // note: The paid run captured the recheck round independently of the main
    // stdout's validity: a DEGRADED refusal owes the same two ledger artifacts.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, async (seedDb) => {
      await seedPriorPublication(seedDb);
      await seedOpenTarget(seedDb);
      h.sandbox.recheckFileContent = "";
      h.sandbox.recheckStatusContent = JSON.stringify({
        schema: "mstar.recheck-status/v1",
        headSha: SHA,
        outcome: "failed",
        reason: "seat-failed",
        rejected: 0,
        rejected_row_ids: [],
        error: "session aborted",
      });
    });
    await sealStoredGateSecrets(db, [paidKey]);
    stubStoredStdout(db, `not a review ${echo}`);
    expect(prepared.recheckInput).toBeDefined();

    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(true);
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared-degraded")).toHaveLength(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
    // Both artifacts, from the retained round facts.
    expect(h.logLines.filter((line) => line.fields.recheck_outcome !== undefined)).toHaveLength(1);
    expect(recheckRows(db)).toHaveLength(1);
  });

  test("a recheck row fault keeps the refusal unsettled until a retry writes it", async () => {
    // note: The shipped row is REQUIRED by the refusal: an insert fault must not
    // leave a settled attempt with an incomplete ledger.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, async (seedDb) => {
      await seedPriorPublication(seedDb);
      await seedOpenTarget(seedDb);
      h.sandbox.recheckFileContent = "";
      h.sandbox.recheckStatusContent = JSON.stringify({
        schema: "mstar.recheck-status/v1",
        headSha: SHA,
        outcome: "failed",
        reason: "seat-failed",
        rejected: 0,
        rejected_row_ids: [],
        error: "session aborted",
      });
    });
    await sealStoredGateSecrets(db, [paidKey]);
    stubStoredEcho(db, echo);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(ref.payload),
      attemptId: ATTEMPT_ID,
      payload: ref.payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 500,
      deadlineMs: ref.deadlineMs,
    });

    const healthy = deps.failureStore;
    const faulty = failureInsertFault(healthy, "recheck", "fail");
    deps.failureStore = faulty.store;

    await expect(collectAttempt(deps, ref, prepared)).rejects.toThrow("recheck failure row insert lost");
    expect(faulty.faults()).toBe(1);
    // Nothing settled, nothing recorded: the collect retries.
    expect(recheckRows(db)).toHaveLength(0);
    const unsettled = db.raw
      .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { settled_ms: number | null };
    expect(unsettled.settled_ms).toBeNull();

    // The retry writes the missing row, then the settlement completes.
    deps.failureStore = healthy;
    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });
    expect(recheckRows(db)).toHaveLength(1);
    const settled = db.raw
      .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { settled_ms: number | null };
    expect(settled.settled_ms).not.toBeNull();
  });

  test("a collect retry accounts the shipped recheck round once", async () => {
    // note: Attempt-keyed identity: a replay of the same refused round contributes
    // ONE durable record and ONE attribution line.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, async (seedDb) => {
      await seedPriorPublication(seedDb);
      await seedOpenTarget(seedDb);
      h.sandbox.recheckFileContent = "";
      h.sandbox.recheckStatusContent = JSON.stringify({
        schema: "mstar.recheck-status/v1",
        headSha: SHA,
        outcome: "failed",
        reason: "seat-failed",
        rejected: 0,
        rejected_row_ids: [],
        error: "session aborted",
      });
    });
    await sealStoredGateSecrets(db, [paidKey]);
    stubStoredEcho(db, echo);

    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });
    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    expect(h.logLines.filter((line) => line.fields.recheck_outcome !== undefined)).toHaveLength(1);
    expect(recheckRows(db)).toHaveLength(1);
  });

  test("a degraded parse diagnostic follows the ledger policy", async () => {
    // note: The stored/logged diagnostic is model-controlled text (unknown keys ride
    // the engine error), so it is redacted with the sealed set — not merely
    // shape+raw — before it reaches the row or the log.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false);
    await sealStoredGateSecrets(db, [paidKey]);
    stubStoredStdout(db, JSON.stringify({ ...VALID_OUTPUT, [echo]: true }));

    // The degraded body itself carries the form, so the gate refuses it — the parse
    // row was already written, which is exactly why it must be clean.
    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    const rows = db.raw.prepare("SELECT stage, error FROM review_failures WHERE head_sha = ?").all(SHA) as {
      stage: string;
      error: string;
    }[];
    const parseRow = rows.find((row) => row.stage === "parse");
    expect(parseRow).toBeDefined();
    expect(String(parseRow!.error)).not.toContain(echo);
    expect(String(parseRow!.error)).toContain("[REDACTED]");
    // Nothing this collect logged carries it either (the diagnostic rides the
    // degraded publication line on a body the gate clears).
    for (const line of h.logLines) expect(line.msg).not.toContain(echo);
  });

  test("a persisted launch is collected even when the App config no longer resolves", async () => {
    // note: The review step's output was never recorded (it died after the paid
    // result became durable), so the platform re-runs that step against an
    // already-persisted launch — on a host whose App config can no longer
    // complete. The replay owns no credentials and needs no config: collect
    // finishes on the sealed set, and nothing is settled as a failure.
    const paidKey = "sk-paid-session-1";
    const { db, resumed, ref, steps } = await paidWorkflowThenResumed("plain text", paidKey);
    db.raw.prepare("DELETE FROM bot_provider_keys").run();
    const replay = new Map([...steps].filter(([name]) => name === "prepare"));

    await runReviewAttemptWorkflow(resumed, ref, stepStore(replay), async () => {});

    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(1);
    expect(resumed.runnerConfigs.size).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_failures WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
  });

  test("a sealing fault fails the paid step and records no unsealed attempt", async () => {
    // note: A deployment whose envelope key is unusable cannot protect an outgoing
    // body. The paid step fails BEFORE it spends, through the existing failure
    // settlement — never by recording an attempt the gate could not protect.
    const { deps, db } = await makeDeps();
    deps.env = { ...deps.env, DASHBOARD_ENCRYPTION_KEY: "not-a-32-byte-key" };
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);

    // note: The settlement runs first and rethrows its cause once every effect is
    // durable — the delivery fails for real and a fresh delivery may retry.
    await expect(runReviewAttemptWorkflow(deps, ref, inlineWorkflowStep(), async () => {})).rejects.toThrow(
      /DASHBOARD_ENCRYPTION_KEY is not valid base64/,
    );

    // The runner was never paid: the seal precedes the exec, so a sealing fault
    // costs nothing and cannot leave a paid result behind (the boundary the
    // paid-launch fence cases count).
    expect(h.sandbox.calls.filter((call) => RUNNER_CMDS.has(call.cmd))).toHaveLength(0);
    const failures = db.raw.prepare("SELECT error FROM review_failures WHERE head_sha = ?").all(SHA) as {
      error: string;
    }[];
    expect(failures.length).toBeGreaterThan(0);
    const row = db.raw
      .prepare("SELECT state, gate_secrets_enc, result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { state: string; gate_secrets_enc: string | null; result_json: string | null };
    expect(row.state).not.toBe("persisted");
    expect(row.result_json).toBeNull();
    expect(row.gate_secrets_enc).toBeNull();
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
  });

  test("a tampered envelope fails the collect instead of publishing", async () => {
    // note: An undecryptable set is a fault of the step (the Workflow retries it),
    // never an empty set that would certify an unscanned body.
    const { db, resumed, ref, prepared } = await paidThenResumed("plain text");
    const row = db.raw
      .prepare("SELECT gate_secrets_enc FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { gate_secrets_enc: string };
    const parts = row.gate_secrets_enc.split(".");
    const bytes = Buffer.from(parts[3]!, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    parts[3] = bytes.toString("base64");
    db.raw
      .prepare("UPDATE review_launches SET gate_secrets_enc = ? WHERE attempt_id = ?")
      .run(parts.join("."), ATTEMPT_ID);

    await expect(collectAttempt(resumed, ref, prepared)).rejects.toThrow(/secretbox: decrypt failed/);
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
  });

  /**
   * note: The workflow-shaped resume: host A pays and the instance dies inside
   * `collect`, so only the database and the recorded step outputs survive; host B
   * keeps no credential cache and no resolved runner config.
   */
  async function paidWorkflowThenResumed(
    echo: string,
    paidKey = "sk-paid-session-1",
    seed?: (seedDb: TestD1) => Promise<void>,
  ): Promise<{ db: TestD1; resumed: ProcessDeps; ref: AttemptRef; steps: Map<string, unknown> }> {
    const { deps: paying, db } = await makeDeps();
    if (seed !== undefined) await seed(db);
    paying.runnerConfigs.set(TEST_APP_ID, {
      appCfg: { keys: { ark: [paidKey] }, modelChain: "ark/deepseek-v4-flash" },
      modelOverrides: undefined,
      customProviders: undefined,
    });
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const steps = new Map<string, unknown>();
    const ref = makeRef(payload);
    await expect(
      runReviewAttemptWorkflow(paying, ref, stepStore(steps, "collect"), async () => {}),
    ).rejects.toThrow(INSTANCE_DIED);
    // The echo is written into the paid result: write-time redaction covers every
    // form of the values this host held, so a form it did not is the gate's case.
    stubStoredEcho(db, echo);
    const { deps: resumed } = await makeDeps({ db });
    resumed.runnerConfigs.clear();
    return { db, resumed, ref, steps };
  }

  /** A shipped, failed recheck round for the workflow-shaped fixtures. */
  const shippedFailedRound = async (seedDb: TestD1): Promise<void> => {
    await seedPriorPublication(seedDb);
    await seedOpenTarget(seedDb);
    h.sandbox.recheckFileContent = "";
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "failed",
      reason: "seat-failed",
      rejected: 0,
      rejected_row_ids: [],
      error: "session aborted",
    });
  };

  test("the outer settlement cannot discharge a refusal whose recheck row is missing", async () => {
    // note: F-006 — the Workflow's terminal catch settles the attempt after the
    // collect rejects. The refused round's row is an OBLIGATION, so the settlement
    // lands the rest and leaves the attempt UNSETTLED until the row exists.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { db, resumed, ref, steps } = await paidWorkflowThenResumed(echo, paidKey, shippedFailedRound);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(ref.payload),
      attemptId: ATTEMPT_ID,
      payload: ref.payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 500,
      deadlineMs: ref.deadlineMs,
    });
    // The row can never be written on this host.
    const healthyStore = resumed.failureStore;
    const faulty = failureInsertFault(healthyStore, "recheck", "fail", Number.POSITIVE_INFINITY);
    resumed.failureStore = faulty.store;

    // The settlement runs (its effects land) and rethrows its cause, as documented.
    await expect(runReviewAttemptWorkflow(resumed, ref, stepStore(steps), async () => {})).rejects.toThrow(
      "recheck failure row insert lost",
    );

    expect(faulty.faults()).toBeGreaterThan(0);
    // The ordinary settlement landed; the round's row is still owed...
    const rows = db.raw.prepare("SELECT stage FROM review_failures WHERE head_sha = ?").all(SHA) as {
      stage: string;
    }[];
    expect(rows.some((row) => row.stage === "pipeline")).toBe(true);
    expect(recheckRows(db)).toHaveLength(0);
    // ...so the attempt is NOT settled.
    const unsettled = db.raw
      .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { settled_ms: number | null };
    expect(unsettled.settled_ms).toBeNull();
    // Recovery sees the same obligation: the attempt stays on the incomplete list.
    const incomplete = await listIncompleteSettlements(db as never, {
      settlingBeforeMs: Date.now() + 1,
      limit: 10,
    });
    expect(incomplete.map((row) => row.attemptId)).toContain(ATTEMPT_ID);

    // The collect retries on a healthy host: the row lands and the mark completes.
    resumed.failureStore = healthyStore;
    await runReviewAttemptWorkflow(resumed, ref, stepStore(steps), async () => {});
    expect(recheckRows(db)).toHaveLength(1);
    const settled = db.raw
      .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { settled_ms: number | null };
    expect(settled.settled_ms).not.toBeNull();
  });

  test("a committed recheck row whose reply was lost still emits its attribution line once", async () => {
    // note: F-007 — D1 commits and the reply is lost. The next collect sees the row
    // already there; the line's own fact (not the insert's change count) decides
    // delivery.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, shippedFailedRound);
    await sealStoredGateSecrets(db, [paidKey]);
    stubStoredEcho(db, echo);

    const lossy = failureInsertFault(deps.failureStore, "recheck", "commitThenFail");
    const healthy = deps.failureStore;
    deps.failureStore = lossy.store;
    await expect(collectAttempt(deps, ref, prepared)).rejects.toThrow("recheck failure row insert lost");
    expect(lossy.faults()).toBe(1);
    // The row committed, but its line was never emitted.
    expect(recheckRows(db)).toHaveLength(1);
    expect(h.logLines.filter((line) => line.fields.recheck_outcome !== undefined)).toHaveLength(0);

    deps.failureStore = healthy;
    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    expect(h.logLines.filter((line) => line.fields.recheck_outcome !== undefined)).toHaveLength(1);
    expect(recheckRows(db)).toHaveLength(1);
  });

  test("a degraded refusal retried after a recheck fault keeps one parse row", async () => {
    // note: F-008 — the parse diagnostic is attempt+stage keyed too: the immutable
    // stdout must not append a second row on the retry.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, async (seedDb) => {
      await shippedFailedRound(seedDb);
    });
    await sealStoredGateSecrets(db, [paidKey]);
    stubStoredStdout(db, `not a review ${echo}`);
    expect(prepared.recheckInput).toBeDefined();

    const healthy = deps.failureStore;
    const faulty = failureInsertFault(healthy, "recheck", "fail");
    deps.failureStore = faulty.store;
    await expect(collectAttempt(deps, ref, prepared)).rejects.toThrow("recheck failure row insert lost");
    expect(faulty.faults()).toBe(1);

    deps.failureStore = healthy;
    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    const stageRows = db.raw.prepare("SELECT stage FROM review_failures WHERE head_sha = ?").all(SHA) as {
      stage: string;
    }[];
    expect(stageRows.filter((row) => row.stage === "parse")).toHaveLength(1);
    expect(recheckRows(db)).toHaveLength(1);
  });

  test("a duty that cannot be recorded fails the refusal closed", async () => {
    // note: F-006 edge 1 — a refusal whose obligation cannot even be written must
    // not reach settlement: collect throws and the attempt stays unresolved.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, shippedFailedRound);
    await sealStoredGateSecrets(db, [paidKey]);
    stubStoredEcho(db, echo);
    const healthy = db as object;
    const faulting = new Proxy(healthy, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop);
        return (sql: string) => {
          if (sql.includes("INSERT INTO review_recheck_duties")) throw new Error("duty write lost");
          return (target as { prepare: (value: string) => unknown }).prepare(sql);
        };
      },
    });
    deps.env = { ...deps.env, DB: faulting as never };

    await expect(collectAttempt(deps, ref, prepared)).rejects.toThrow("duty write lost");
    // Nothing settled, no row, no line.
    expect(recheckRows(db)).toHaveLength(0);
    expect(h.logLines.filter((line) => line.fields.recheck_outcome !== undefined)).toHaveLength(0);
  });

  test("the route recovery pass finishes a stranded round and discharges the settlement", async () => {
    // note: F-006 edge 2 + F-009(a): the host wrote the duty and died before the row
    // and the line. The scheduled pass is the named owner: it writes the row, emits
    // the attribution once, and only then can the settlement discharge.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { db, resumed, ref, steps } = await paidWorkflowThenResumed(echo, paidKey, shippedFailedRound);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(ref.payload),
      attemptId: ATTEMPT_ID,
      payload: ref.payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 500,
      deadlineMs: ref.deadlineMs,
    });
    const healthyStore = resumed.failureStore;
    const faulty = failureInsertFault(healthyStore, "recheck", "fail", Number.POSITIVE_INFINITY);
    resumed.failureStore = faulty.store;
    await expect(runReviewAttemptWorkflow(resumed, ref, stepStore(steps), async () => {})).rejects.toThrow(
      "recheck failure row insert lost",
    );
    expect(recheckRows(db)).toHaveLength(0);

    // The dead host's settlement is now old enough for the recovery pass.
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET settling_ms = ? WHERE attempt_id = ?")
      .run(Date.now() - 60 * 60_000, ATTEMPT_ID);

    await reconcileReviewRoute(
      {
        DB: db as never,
        REVIEW_QUEUE: { send: async () => {} } as never,
        IDEMPOTENCY_KV: { get: async () => null, put: async () => {}, delete: async () => {} } as never,
        log: { info: (fields: Record<string, unknown>, msg: string) => h.testLog.info(fields as never, msg) },
      },
      Date.now(),
    );

    // The row, the attribution fact and the completion all land.
    expect(recheckRows(db)).toHaveLength(1);
    expect(h.logLines.filter((line) => line.msg.includes("replayed by the route recovery pass"))).toHaveLength(1);
    const settled = db.raw
      .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { settled_ms: number | null };
    expect(settled.settled_ms).not.toBeNull();
    // The duty is discharged.
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM review_recheck_duties WHERE attempt_id = ?").get(ATTEMPT_ID),
    ).toMatchObject({ n: 0 });
  });

  test("a replay with the attribution fact present neither re-emits nor blocks discharge", async () => {
    // note: F-009(b): the fact — not the log call — is the correctness evidence. A
    // second collect must not duplicate the line, and a fault on the fact's write
    // path is never reached.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, shippedFailedRound);
    await sealStoredGateSecrets(db, [paidKey]);
    stubStoredEcho(db, echo);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(ref.payload),
      attemptId: ATTEMPT_ID,
      payload: ref.payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 500,
      deadlineMs: ref.deadlineMs,
    });

    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });
    expect(h.logLines.filter((line) => line.fields.recheck_outcome !== undefined)).toHaveLength(1);

    // Any further write to the attribution fact would fault, and must not be needed.
    const healthy = db as object;
    const faulting = new Proxy(healthy, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop);
        return (sql: string) => {
          if (sql.includes("INSERT INTO review_recheck_attributions")) throw new Error("fact write lost");
          return (target as { prepare: (value: string) => unknown }).prepare(sql);
        };
      },
    });
    deps.env = { ...deps.env, DB: faulting as never };

    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });
    expect(h.logLines.filter((line) => line.fields.recheck_outcome !== undefined)).toHaveLength(1);
    const settled = db.raw
      .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { settled_ms: number | null };
    expect(settled.settled_ms).not.toBeNull();
  });

  test("a clean review still publishes when the round accounting cannot be stored", async () => {
    // note: F-010 — on the publish lane the WHOLE accounting is best-effort: a
    // cleared review stages and publishes regardless.
    const paidKey = "sk-paid-session-1";
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, async (seedDb) => {
      await seedPriorPublication(seedDb);
      await seedOpenTarget(seedDb);
      h.sandbox.recheckFileContent = "";
      h.sandbox.recheckStatusContent = JSON.stringify({
        schema: "mstar.recheck-status/v1",
        headSha: SHA,
        outcome: "failed",
        reason: "seat-failed",
        rejected: 0,
        rejected_row_ids: [],
        error: "session aborted",
      });
    });
    await sealStoredGateSecrets(db, [paidKey]);
    const healthy = db as object;
    const faulting = new Proxy(healthy, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop);
        return (sql: string) => {
          if (sql.includes("review_recheck")) throw new Error("accounting store lost");
          return (target as { prepare: (value: string) => unknown }).prepare(sql);
        };
      },
    });
    deps.env = { ...deps.env, DB: faulting as never };

    const collected = await collectAttempt(deps, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    expect(h.logLines.some((line) => line.msg.includes("continuing to publish"))).toBe(true);
    const staged = db.raw
      .prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?")
      .get(SHA) as { n: number };
    expect(staged.n).toBe(1);
    // And it PUBLISHES: the accounting store never gates the publication lane.
    const { deps: publishing } = await makeDeps({ db });
    expect(await publishAttempt(publishing, ref, collected.collected.publicationId)).toEqual({ kind: "ok" });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(1);
    expect(h.logLines.some((line) => line.msg.includes("publication-unknown"))).toBe(false);
  });

  test("a degraded warning carries the redacted diagnostic, not the short encoded form", async () => {
    // note: F-008 — the gate-CLEARED degraded path logs its diagnostic; a short
    // encoding the publication gate cannot match (below its substring floor) must
    // still be redacted in that warning.
    const shortKey = "xy";
    const shortEncoded = Buffer.from(shortKey, "utf8").toString("base64");
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false);
    await sealStoredGateSecrets(db, [shortKey]);
    stubStoredStdout(db, JSON.stringify({ ...VALID_OUTPUT, [shortEncoded]: true }));

    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "degraded" } });

    const warning = h.logLines.find((line) => line.msg.includes("review degraded"));
    expect(warning).toBeDefined();
    expect(warning!.msg).not.toContain(shortEncoded);
    expect(warning!.msg).toContain("[REDACTED]");
  });

  test("a duty-registration fault leaves the refusal pending until recovery finishes it", async () => {
    // note: Rulings 1+2 — the refusal MARKER is written first, so a duty that never
    // commits cannot make the refusal look like an ordinary failure: the settlement
    // stays open and the recovery pass discharges it.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { db, resumed, ref, steps } = await paidWorkflowThenResumed(echo, paidKey, shippedFailedRound);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(ref.payload),
      attemptId: ATTEMPT_ID,
      payload: ref.payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 500,
      deadlineMs: ref.deadlineMs,
    });
    const faulting = new Proxy(db as object, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop);
        return (sql: string) => {
          if (sql.includes("INSERT INTO review_recheck_duties")) throw new Error("duty registration lost");
          return (target as { prepare: (value: string) => unknown }).prepare(sql);
        };
      },
    });
    resumed.env = { ...resumed.env, DB: faulting as never };
    await expect(runReviewAttemptWorkflow(resumed, ref, stepStore(steps), async () => {})).rejects.toThrow(
      "duty registration lost",
    );

    // Marker present, duty absent, nothing settled and no row.
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_refusal_pending WHERE attempt_id = ?").get(ATTEMPT_ID)).toMatchObject({ n: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_recheck_duties WHERE attempt_id = ?").get(ATTEMPT_ID)).toMatchObject({ n: 0 });
    expect(recheckRows(db)).toHaveLength(0);
    const unsettled = db.raw
      .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { settled_ms: number | null };
    expect(unsettled.settled_ms).toBeNull();

    // Recovery registers the duty, emits the attribution and discharges.
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET settling_ms = ? WHERE attempt_id = ?")
      .run(Date.now() - 60 * 60_000, ATTEMPT_ID);
    await reconcileReviewRoute(
      {
        DB: db as never,
        REVIEW_QUEUE: { send: async () => {} } as never,
        IDEMPOTENCY_KV: { get: async () => null, put: async () => {}, delete: async () => {} } as never,
        log: { info: (fields: Record<string, unknown>, msg: string) => h.testLog.info(fields as never, msg) },
      },
      Date.now(),
    );
    expect(h.logLines.filter((line) => line.msg.includes("replayed by the route recovery pass"))).toHaveLength(1);
    const settled = db.raw
      .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { settled_ms: number | null };
    expect(settled.settled_ms).not.toBeNull();
    // Both markers are discharged.
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_refusal_pending WHERE attempt_id = ?").get(ATTEMPT_ID)).toMatchObject({ n: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_recheck_duties WHERE attempt_id = ?").get(ATTEMPT_ID)).toMatchObject({ n: 0 });
  });

  test("a recovery pass with no log sink leaves the claim unstamped", async () => {
    // note: Ruling 6 — the round's writes come BEFORE any claim, so a fault there
    // never orphans a stamped claim.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { db, resumed, ref, steps } = await paidWorkflowThenResumed(echo, paidKey, shippedFailedRound);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(ref.payload),
      attemptId: ATTEMPT_ID,
      payload: ref.payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 500,
      deadlineMs: ref.deadlineMs,
    });
    const healthyStore = resumed.failureStore;
    const faulty = failureInsertFault(healthyStore, "recheck", "fail", Number.POSITIVE_INFINITY);
    resumed.failureStore = faulty.store;
    await expect(runReviewAttemptWorkflow(resumed, ref, stepStore(steps), async () => {})).rejects.toThrow();
    db.raw
      .prepare("UPDATE review_attempt_handoffs SET settling_ms = ? WHERE attempt_id = ?")
      .run(Date.now() - 60 * 60_000, ATTEMPT_ID);
    const stampsBefore = h.kvPuts.filter((put) => put.key.startsWith("idem:")).length;

    await reconcileReviewRoute(
      {
        DB: db as never,
        REVIEW_QUEUE: { send: async () => {} } as never,
        IDEMPOTENCY_KV: { get: async () => null, put: async () => {}, delete: async () => {} } as never,
      },
      Date.now(),
    );

    // The round could not be finished, so the pass claimed and settled nothing.
    expect(h.kvPuts.filter((put) => put.key.startsWith("idem:"))).toHaveLength(stampsBefore);
    const handoff = db.raw
      .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { settled_ms: number | null };
    expect(handoff.settled_ms).toBeNull();
  });

  test("a never-claimed replay does no config or mint work", async () => {
    // note: Ruling 7 — with no launch row at all the attempt cannot pay, so the
    // phase reports it without resolving a config or minting a token.
    const { deps } = await makeDeps();
    deps.runnerConfigs.clear();
    const ref = makeRef(makePayload());
    const mintsBefore = h.commenterCalls.filter((call) => call.op === "token").length;

    await expect(reviewAttempt(deps, ref, {} as PreparedAttempt)).rejects.toThrow(/non-payable/);
    expect(h.commenterCalls.filter((call) => call.op === "token")).toHaveLength(mintsBefore);
    expect(deps.runnerConfigs.size).toBe(0);
  });

  test("a resumed collect opens the paid session's sealed set and refuses the encoded echo", async () => {
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { db, resumed, ref, steps } = await paidWorkflowThenResumed(echo, paidKey);
    const launch = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { result_json: string };
    expect(launch.result_json).toContain(echo);
    expect(resumed.credentials.size).toBe(0);

    await runReviewAttemptWorkflow(resumed, ref, stepStore(steps), async () => {});

    // note: Refused WITH credentials — the resumed host opens the paid session's own
    // set from the attempt row, so the encoded echo is a credential form again.
    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(true);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    const failure = db.raw.prepare("SELECT error FROM review_failures WHERE head_sha = ?").all(SHA) as {
      error: string;
    }[];
    expect(failure.some((row) => row.error.includes("publish gate refused"))).toBe(true);
  });

  test("a gate-refused review still accounts its recheck round", async () => {
    // note: The round SENT rows and lost its document, so it owes an attribution line
    // and a shipped-failure row — and it owes them even when the gate refuses the
    // body. The refusal settlement is a real failure; the accounting rides with it.
    const echo = ECHOES.base64;
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, async (seedDb) => {
      await seedPriorPublication(seedDb);
      await seedOpenTarget(seedDb);
    });
    await sealStoredGateSecrets(db, [KEY]);
    stubStoredEcho(db, echo);
    expect(prepared.targets.length).toBeGreaterThan(0);
    expect(prepared.recheckInput).toBeDefined();

    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    // The gate refused, and nothing was staged or posted.
    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(true);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 0 });
    // The round's own attribution line is in the ledger all the same (its message
    // depends on the round's outcome; the field is the stable marker).
    expect(h.logLines.filter((line) => line.fields.recheck_outcome !== undefined)).toHaveLength(1);
    const rows = db.raw.prepare("SELECT stage FROM review_failures WHERE head_sha = ?").all(SHA) as {
      stage: string;
    }[];
    expect(rows.filter((row) => row.stage === "recheck")).toHaveLength(1);
  });

  test("a gate-refused review redacts the recheck status text with the sealed set", async () => {
    // note: The seat's own `reason`/`error` are MODEL text: an encoded echo of a
    // sealed credential must not reach the attribution line or the failure row.
    const paidKey = "sk-paid-session-1";
    const echo = Buffer.from(paidKey, "utf8").toString("base64");
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, async (seedDb) => {
      await seedPriorPublication(seedDb);
      await seedOpenTarget(seedDb);
      // The seat wrote no document and said why — before the paid step reads it.
      h.sandbox.recheckFileContent = "";
      h.sandbox.recheckStatusContent = JSON.stringify({
        schema: "mstar.recheck-status/v1",
        headSha: SHA,
        outcome: "failed",
        reason: "seat-failed",
        rejected: 0,
        rejected_row_ids: [],
        error: `dump ${echo}`,
      });
    });
    await sealStoredGateSecrets(db, [paidKey]);
    stubStoredEcho(db, echo);
    expect(prepared.recheckInput).toBeDefined();

    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    // Refused, and the round is still accounted.
    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(true);
    const attributed = h.logLines.find((line) => line.fields.recheck_outcome !== undefined)!;
    expect(attributed).toBeDefined();
    const rows = db.raw.prepare("SELECT stage, error FROM review_failures WHERE head_sha = ?").all(SHA) as {
      stage: string;
      error: string;
    }[];
    const recheckRow = rows.find((row) => row.stage === "recheck");
    expect(recheckRow).toBeDefined();

    // Neither artifact carries a recognizable credential form. `reason` is a
    // validated vocabulary value (no free text), the free-text `error` is redacted.
    expect(attributed.fields.recheck_reason).toBe("seat-failed");
    for (const text of [String(attributed.fields.recheck_error), String(recheckRow!.error)]) {
      expect(text).not.toContain(echo);
      expect(text).toContain("[REDACTED]");
    }
  });

  test("a short sealed key embedded in the seat's text is redacted in both artifacts", async () => {
    // note: A short raw credential is exact-leaf only for the GATE (its anti-false-
    // positive rule). The ledger we write has the opposite cost: over-redaction is
    // cheap, a durable leak is not.
    const shortKey = "k5-ab";
    const encoded = Buffer.from(shortKey, "utf8").toString("base64");
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, async (seedDb) => {
      await seedPriorPublication(seedDb);
      await seedOpenTarget(seedDb);
      h.sandbox.recheckFileContent = "";
      h.sandbox.recheckStatusContent = JSON.stringify({
        schema: "mstar.recheck-status/v1",
        headSha: SHA,
        outcome: "failed",
        reason: "seat-failed",
        rejected: 0,
        rejected_row_ids: [],
        error: `seat dump ${shortKey} and ${encoded} end`,
      });
    });
    await sealStoredGateSecrets(db, [shortKey]);
    stubStoredEcho(db, encoded);
    expect(prepared.recheckInput).toBeDefined();

    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    // Refused, and the round is still accounted.
    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(true);
    const attributed = h.logLines.find((line) => line.fields.recheck_outcome !== undefined)!;
    const rows = db.raw.prepare("SELECT stage, error FROM review_failures WHERE head_sha = ?").all(SHA) as {
      stage: string;
      error: string;
    }[];
    const recheckRow = rows.find((row) => row.stage === "recheck");
    expect(recheckRow).toBeDefined();

    // No occurrence of the short key — raw mid-text or encoded — survives.
    for (const text of [String(attributed.fields.recheck_error), String(recheckRow!.error)]) {
      expect(text).not.toContain(shortKey);
      expect(text).not.toContain(encoded);
      expect(text).toContain("[REDACTED]");
    }
  });

  test("a short encoded credential form embedded in the seat's text is redacted", async () => {
    // note: An encoding under the gate's six-character substring floor is whole-leaf
    // for the GATE; the ledger removes it wherever it appears.
    const shortKey = "xy";
    const shortEncoded = Buffer.from(shortKey, "utf8").toString("base64");
    const longKey = "sk-paid-session-1";
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, async (seedDb) => {
      await seedPriorPublication(seedDb);
      await seedOpenTarget(seedDb);
      h.sandbox.recheckFileContent = "";
      h.sandbox.recheckStatusContent = JSON.stringify({
        schema: "mstar.recheck-status/v1",
        headSha: SHA,
        outcome: "failed",
        reason: "seat-failed",
        rejected: 0,
        rejected_row_ids: [],
        error: `seat dump ${shortEncoded} end`,
      });
    });
    await sealStoredGateSecrets(db, [shortKey, longKey]);
    stubStoredEcho(db, Buffer.from(longKey, "utf8").toString("base64"));
    expect(prepared.recheckInput).toBeDefined();

    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    // Refused, and the round is still accounted.
    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(true);
    const attributed = h.logLines.find((line) => line.fields.recheck_outcome !== undefined)!;
    const rows = db.raw.prepare("SELECT stage, error FROM review_failures WHERE head_sha = ?").all(SHA) as {
      stage: string;
      error: string;
    }[];
    const recheckRow = rows.find((row) => row.stage === "recheck");
    expect(recheckRow).toBeDefined();

    // Neither the short raw key nor its encoding survives in either artifact.
    for (const text of [String(attributed.fields.recheck_error), String(recheckRow!.error)]) {
      expect(text).not.toContain(shortEncoded);
      expect(text).not.toContain(shortKey);
      expect(text).toContain("[REDACTED]");
    }
  });

  test("a refused review with no sealed set withholds the recheck status text", async () => {
    // note: Without the exact set nothing can be certified, so the seat's text is not
    // emitted at all — the round is still accounted by its counts.
    const unrecognized = "unrecognized-seat-token-9f2c";
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, async (seedDb) => {
      await seedPriorPublication(seedDb);
      await seedOpenTarget(seedDb);
      h.sandbox.recheckFileContent = "";
      h.sandbox.recheckStatusContent = JSON.stringify({
        schema: "mstar.recheck-status/v1",
        headSha: SHA,
        outcome: "failed",
        reason: "seat-failed",
        rejected: 0,
        rejected_row_ids: [],
        error: `dump ${unrecognized}`,
      });
    });
    // A pre-envelope attempt: the gate refuses it, and no set can be applied.
    db.raw.prepare("UPDATE review_launches SET gate_secrets_enc = NULL WHERE attempt_id = ?").run(ATTEMPT_ID);

    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(true);
    const attributed = h.logLines.find((line) => line.fields.recheck_outcome !== undefined)!;
    expect(attributed.fields.recheck_reason).toBeNull();
    expect(attributed.fields.recheck_error).toBeNull();
    const rows = db.raw.prepare("SELECT stage, error FROM review_failures WHERE head_sha = ?").all(SHA) as {
      stage: string;
      error: string;
    }[];
    const recheckRow = rows.find((row) => row.stage === "recheck");
    expect(recheckRow).toBeDefined();
    expect(recheckRow!.error).not.toContain(unrecognized);
    expect(recheckRow!.error).toContain("withheld");
  });

  test("a clean collect accounts its recheck round exactly once", async () => {
    // note: Moving the accounting ahead of the gate must not double-fire it.
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, async (seedDb) => {
      await seedPriorPublication(seedDb);
      await seedOpenTarget(seedDb);
    });
    expect(prepared.recheckInput).toBeDefined();

    const collected = await collectAttempt(deps, ref, prepared);
    expect(collected.kind).toBe("collected");
    expect(h.logLines.filter((line) => line.fields.recheck_outcome !== undefined)).toHaveLength(1);
    const rows = db.raw.prepare("SELECT stage FROM review_failures WHERE head_sha = ?").all(SHA) as {
      stage: string;
    }[];
    expect(rows.filter((row) => row.stage === "recheck")).toHaveLength(1);
  });

  test("a short key equal to trusted marker text is not refused", async () => {
    // The body always carries `mstar-inspector` markers; the raw spelling of a
    // short key is exact-leaf redaction's job, never the publish gate's.
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false);
    await sealStoredGateSecrets(db, ["mstar"]);
    const collected = await collectAttempt(deps, ref, prepared);
    expect(collected.kind).toBe("collected");
    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(false);
  });

  test("a key whose hex collides with the commit SHA does not refuse a clean review", async () => {
    const key = String.fromCharCode(0x01, 0x23, 0x45);
    expect(Buffer.from(key, "utf8").toString("hex")).toBe(SHA.slice(0, 6));
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false);
    await sealStoredGateSecrets(db, [key]);

    const collected = await collectAttempt(deps, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(false);
    const { deps: publishing } = await makeDeps({ db });
    expect(await publishAttempt(publishing, ref, collected.collected.publicationId)).toEqual({ kind: "ok" });
    const send = h.commenterCalls.find((call) => call.op === "post-prepared");
    const body = (send?.args as { body: string } | undefined)?.body ?? "";
    expect(body).toContain(`commit ${SHA.slice(0, 7)}`);
    expect(body).toContain(`sha=${SHA}`);
  });

  test("a prior finding's title carrying an encoded echo is caught by the gate", async () => {
    const echo = ECHOES.base64;
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false, async (seedDb) => {
      await seedPriorPublication(seedDb);
      await seedOpenTarget(seedDb, { original: { title: `prior echo ${echo}` } });
    });
    await sealStoredGateSecrets(db, [KEY]);

    expect(prepared.targets.some((target) => target.original.title.includes(echo))).toBe(true);
    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });
    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(true);
    const staged = db.raw
      .prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?")
      .get(SHA) as { n: number };
    expect(staged.n).toBe(0);
  });

  test("a redacted suggestion is removed before publish", async () => {
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false);
    const launch = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { result_json: string };
    const execution = JSON.parse(launch.result_json) as { run: { stdout: string; exitCode: number } };
    const output = JSON.parse(execution.run.stdout) as typeof VALID_OUTPUT;
    output.findings[0]!.body = 'before\n```suggestion\nconst key = "sk-test";\n```\nafter';
    execution.run.stdout = JSON.stringify(output);
    db.raw
      .prepare("UPDATE review_launches SET result_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(execution), ATTEMPT_ID);

    const collected = await collectAttempt(deps, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    const publication = db.raw
      .prepare("SELECT payload_json FROM review_publications WHERE id = ?")
      .get(collected.collected.publicationId) as { payload_json: string };
    const payload = JSON.parse(publication.payload_json) as {
      artifact: { payload: { findings: Array<{ body: string }> } };
    };
    const body = payload.artifact.payload.findings[0]!.body;
    expect(body).not.toContain("```suggestion");
    expect(body).toContain("before");
    expect(body).toContain("after");
  });

  test("an inline line comment carries no suggestion fence after a redaction", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false);
    const launch = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { result_json: string };
    const execution = JSON.parse(launch.result_json) as { run: { stdout: string; exitCode: number } };
    const output = JSON.parse(execution.run.stdout) as typeof VALID_OUTPUT;
    output.findings[0]!.body = 'before\n```suggestion\nconst key = "sk-test";\n```\nafter';
    execution.run.stdout = JSON.stringify(output);
    db.raw
      .prepare("UPDATE review_launches SET result_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(execution), ATTEMPT_ID);

    const collected = await collectAttempt(deps, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    const publication = db.raw
      .prepare("SELECT payload_json FROM review_publications WHERE id = ?")
      .get(collected.collected.publicationId) as { payload_json: string };
    const payload = JSON.parse(publication.payload_json) as {
      lineIntents: Array<{ body: string }>;
    };
    const inline = payload.lineIntents.map((intent) => intent.body).join("\n");
    expect(payload.lineIntents.length).toBeGreaterThan(0);
    // The PATCH ITSELF is gone from both carriers — not merely its fence marker: a
    // path that stripped the fence and kept the code would still leak the change.
    const artifact = (
      JSON.parse(publication.payload_json) as {
        artifact: { payload: { findings: Array<{ body: string }> } };
      }
    ).artifact.payload.findings[0]!.body;
    for (const text of [artifact, inline]) {
      expect(text).not.toContain("const key =");
      expect(text).not.toContain("```");
    }
    expect(inline).toContain("after");
  });

  test("the inline render counts its generated heading against the same body budget", async () => {
    // note: The artifact body carries the explanation alone, so it may use the whole
    // budget; the inline comment prefixes a generated heading (title + merge-class
    // tag), and that heading is spent from the SAME budget — the retained explanation
    // is shorter, and the text never exceeds the limit.
    h.sandbox.diffStdout = VALID_DIFF;
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false);
    const explanation = "Z".repeat(FINDING_BODY_MAX - 10);
    const suggestion = '```suggestion\nconst key = "sk-test";\n```';
    const launch = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { result_json: string };
    const execution = JSON.parse(launch.result_json) as { run: { stdout: string; exitCode: number } };
    const output = JSON.parse(execution.run.stdout) as typeof VALID_OUTPUT;
    output.findings[0]!.body = `${suggestion}\n${explanation}`;
    execution.run.stdout = JSON.stringify(output);
    db.raw
      .prepare("UPDATE review_launches SET result_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(execution), ATTEMPT_ID);

    const collected = await collectAttempt(deps, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    const publication = db.raw
      .prepare("SELECT payload_json FROM review_publications WHERE id = ?")
      .get(collected.collected.publicationId) as { payload_json: string };
    const payload = JSON.parse(publication.payload_json) as {
      artifact: { payload: { findings: Array<{ body: string }> } };
      lineIntents: Array<{ body: string }>;
    };

    const artifactBody = payload.artifact.payload.findings[0]!.body;
    expect(artifactBody).toBe(explanation);
    expect(artifactBody.length).toBeLessThanOrEqual(FINDING_BODY_MAX);

    expect(payload.lineIntents.length).toBeGreaterThan(0);
    const inline = payload.lineIntents.map((intent) => intent.body).join("\n");
    // The heading is inside the budget, so the inline text fills it and clamps the
    // explanation the artifact kept whole.
    expect(inline.length).toBeLessThanOrEqual(FINDING_BODY_MAX);
    expect(inline).toContain(explanation.slice(0, 200));
    expect(inline.includes(explanation)).toBe(false);
    expect(inline.endsWith("…")).toBe(true);
  });

  test("the suggestion is dropped before the clamp, so the explanation stays intact", async () => {
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false);
    const explanation = "Z".repeat(FINDING_BODY_MAX - 10);
    const suggestion = '```suggestion\nconst key = "sk-test";\n```';
    const launch = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { result_json: string };
    const execution = JSON.parse(launch.result_json) as { run: { stdout: string; exitCode: number } };
    const output = JSON.parse(execution.run.stdout) as typeof VALID_OUTPUT;
    output.findings[0]!.body = `${suggestion}\n${explanation}`;
    execution.run.stdout = JSON.stringify(output);
    db.raw
      .prepare("UPDATE review_launches SET result_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(execution), ATTEMPT_ID);

    const collected = await collectAttempt(deps, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    const publication = db.raw
      .prepare("SELECT payload_json FROM review_publications WHERE id = ?")
      .get(collected.collected.publicationId) as { payload_json: string };
    const payload = JSON.parse(publication.payload_json) as {
      artifact: { payload: { findings: Array<{ body: string }> } };
    };
    const body = payload.artifact.payload.findings[0]!.body;
    expect(body).toBe(explanation);
    expect(body.length).toBeLessThanOrEqual(FINDING_BODY_MAX);
  });

  async function brokenStdout(echo: string, whole = false) {
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false);
    const launch = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { result_json: string };
    const execution = JSON.parse(launch.result_json) as { run: { stdout: string; exitCode: number } };
    execution.run.stdout = whole ? echo : `not a review ${echo}`;
    db.raw
      .prepare("UPDATE review_launches SET result_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(execution), ATTEMPT_ID);
    return { deps, db, ref, prepared };
  }

  test("the degraded publish path refuses a body carrying an encoded echo", async () => {
    const { deps, db, ref, prepared } = await brokenStdout(ECHOES.base64);
    await sealStoredGateSecrets(db, [KEY]);
    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

    expect(h.commenterCalls.filter((call) => call.op === "post-prepared-degraded")).toHaveLength(0);
    const staged = db.raw
      .prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?")
      .get(SHA) as { n: number };
    expect(staged.n).toBe(0);
    const handoff = db.raw
      .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { settled_ms: number | null };
    expect(handoff.settled_ms).not.toBeNull();
  });

  test("a resumed degraded publish runs the gate from the paid session's sealed set", async () => {
    const { deps, ref, prepared } = await brokenStdout(ECHOES.base64);
    // note: The attempt row carries the paid session's own set, whose keys the
    // echo does not encode — so it publishes.
    const collected = await collectAttempt(deps, ref, prepared);
    expect(collected.kind).toBe("settled");
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared-degraded")).toHaveLength(1);
    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(false);
  });

  test("the degraded gate exact-matches an encoding that is the whole stdout", async () => {
    const key = "{";
    const echo = Buffer.from(key).toString("base64url");
    expect(echo).toBe("ew");
    const { deps, db, ref, prepared } = await brokenStdout(echo, true);
    await sealStoredGateSecrets(db, [key]);

    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared-degraded")).toHaveLength(0);
    const staged = db.raw
      .prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?")
      .get(SHA) as { n: number };
    expect(staged.n).toBe(0);
  });

  test("an unproven failure settlement is not reported as a settled collect", async () => {
    const { deps, db, ref, prepared } = await reviewedEcho(ECHOES.base64, false);
    const launch = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { result_json: string };
    const execution = JSON.parse(launch.result_json) as { run: { stdout: string; exitCode: number } };
    const output = JSON.parse(execution.run.stdout) as typeof VALID_OUTPUT;
    output.findings[0]!.body = `echo ${ECHOES.base64}`;
    execution.run.stdout = JSON.stringify(output);
    db.raw
      .prepare("UPDATE review_launches SET result_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify(execution), ATTEMPT_ID);

    await sealStoredGateSecrets(db, [KEY]);
    // A live launch row plus an unwritable failure row: the failure settlement
    // returns `unknown` instead of certifying an outcome it cannot prove.
    deps.failureStore = {
      ...deps.failureStore,
      record: async () => {
        throw new Error("injected: no durable failure row");
      },
    };

    expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "unknown" } });
    const handoff = db.raw
      .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get(ATTEMPT_ID) as { settled_ms: number | null };
    expect(handoff.settled_ms).toBeNull();
    const staged = db.raw
      .prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?")
      .get(SHA) as { n: number };
    expect(staged.n).toBe(0);
    const pending = await listIncompleteSettlements(db as never, {
      settlingBeforeMs: Date.now() + 1,
      limit: 10,
    });
    expect(pending.some((row) => row.attemptId === ATTEMPT_ID)).toBe(true);
  });
});

describe("design D6 — a terminal outcome crosses the step boundary as data", () => {
  /**
   * note: The step double replays a cached `failed` record: the callback never
   * runs again, so a replay sees the SAME record and no phase work.
   */
  function replayStep(store: Map<string, unknown>, onRun: (name: string) => void): WorkflowStep {
    return {
      do: async (name: string, configOrCallback: unknown, maybeCallback?: unknown): Promise<unknown> => {
        if (store.has(name)) return store.get(name);
        onRun(name);
        const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as (
          ctx: unknown,
        ) => Promise<unknown>;
        const output = await callback({ step: { name, count: 1 }, attempt: 1, config: {} });
        store.set(name, output);
        return output;
      },
      sleep: async () => {},
      sleepUntil: async () => {},
      waitForEvent: async (): Promise<never> => {
        throw new Error("the replay step store does not wait for events");
      },
    } as unknown as WorkflowStep;
  }

  test("a cached `failed` record replays without re-invoking the phase, and cleanup decides from the row", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = "not a verdict";
    h.commenterState.preparedDegradedError = new PublicationDeadlineSpent(
      "create comment: the attempt's frozen deadline passed 5ms ago — nothing was sent",
    );
    const ref = makeRef(payload);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });
    const prepared = await prepareAttempt(deps, ref);
    if (prepared.kind !== "prepared") throw new Error(`prepare did not hand off: ${prepared.kind}`);
    const reviewed = await reviewAttempt(deps, ref, prepared.prepared);
    if ("failure" in reviewed) throw new Error("the paid step failed unexpectedly");
    // The collect's budget stop is the record that will be replayed.
    const failed = await collectAttempt(deps, ref, prepared.prepared);
    if (!("failure" in failed)) throw new Error(`collect did not fail: ${failed.kind}`);
    expect(failed.failure.class).toBe("budget");

    const store = new Map<string, unknown>([
      ["prepare", prepared],
      ["review", reviewed],
      ["collect", failed],
    ]);
    const ran: string[] = [];
    const { deps: first } = await makeDeps({ db });
    await runReviewAttemptWorkflow(first, ref, replayStep(store, (name) => ran.push(name)), async () => {});
    expect(ran).toEqual(["settle-failure", "cleanup"]);
    const budgetRows = failureRows(db).filter((row) => String(row.error).includes("budget-exhausted:"));
    expect(budgetRows).toHaveLength(1);

    // The engine died before the settlement's checkpoint: the SAME step store
    // replays, and no phase is re-invoked. (The mark itself is owed a claim
    // stamp this branch does not write, so `settle-failure` re-runs — what the
    // record owns is that the phases below it never do.)
    const reran: string[] = [];
    const { deps: resumed } = await makeDeps({ db });
    const uncheckpointed = new Map([...store].filter(([name]) => name !== "cleanup"));
    await runReviewAttemptWorkflow(resumed, ref, replayStep(uncheckpointed, (name) => reran.push(name)), async () => {});
    expect(reran).toEqual(["cleanup"]);
    // The cleanup decision is the ROW's, identical to the uninterrupted run.
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("persisted");
  });

  test("a failure whose row proves no paid work releases capacity; a launched row holds it", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    // No launch row at all: nothing paid could be lost, so cleanup releases.
    expect(await cleanupAttempt(deps, ref)).toEqual({ retention: "no-paid-work" });
    expect(h.sandbox.destroyCalls).toBe(0);

    // A `launched` row proves the paid step was SENT: capacity is held.
    const launched = { ...ref, attemptId: "attempt-d6-launched" };
    expect(await claimReviewAttempt(db as never, launched.attemptId, Date.now(), null)).toBe("claimed");
    expect(await claimReviewLaunch(db as never, launched.attemptId, Date.now())).toEqual({ ok: true });
    expect(await cleanupAttempt(deps, launched)).toEqual({ retention: "unknown" });
  });

  test("a cause with a throwing enumerable getter cannot break the record", () => {
    // The record is built from KNOWN fields, never `Object.entries(cause)`.
    const hostile = new AttemptUnknownError("the container could not be read", "review.paid.reply_lost");
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter must never run");
      },
    });
    const record = phaseFailureRecord(
      {
        phase: "collect",
        stage: "pipeline",
        headSha: SHA,
        runnerReturned: true,
        tier: "default",
        budgetMs: 0,
        changedLines: null,
        sendAttemptPublicationId: null,
      },
      hostile,
    );
    expect(record).toMatchObject({ class: "unknown", message: "the container could not be read" });
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  test("an unobserved outcome says whether a paid step could still be live", () => {
    // Two meanings share `class: "unknown"`. Only the post-paid one may hold
    // capacity, so the record must carry the distinction and the classifier must
    // derive it from the phase, never from the error's text.
    const ctx = {
      stage: "pipeline" as const,
      headSha: SHA,
      runnerReturned: false,
      tier: "default" as const,
      budgetMs: 0,
      changedLines: null,
      sendAttemptPublicationId: null,
    };
    const prePaid = phaseFailureRecord(
      { ...ctx, phase: "prepare" },
      new AttemptUnknownError("unavailable", "review.container.unavailable"),
    );
    const postPaid = phaseFailureRecord(
      { ...ctx, phase: "collect" },
      new AttemptUnknownError("unreadable", "review.paid.reply_lost"),
    );
    expect(prePaid).toMatchObject({
      class: "unknown",
      containerStateUnknown: false,
      code: "review.container.unavailable",
    });
    expect(postPaid).toMatchObject({
      class: "unknown",
      containerStateUnknown: true,
      code: "review.paid.reply_lost",
    });
  });

  test("a retired slot is never rendered as retryable-unavailable", () => {
    // The cause the throw site observed drives the record: a slot that can never
    // run again must not reach `review.container.unavailable` just because the
    // failure happened in `prepare`.
    const record = phaseFailureRecord(
      {
        phase: "prepare",
        stage: "pipeline",
        headSha: SHA,
        runnerReturned: false,
        tier: "default",
        budgetMs: 0,
        changedLines: null,
        sendAttemptPublicationId: null,
      },
      new AttemptUnknownError("the attempt's slot is retired", "review.container.retired"),
    );
    expect(record).toMatchObject({ class: "unknown", containerStateUnknown: false, code: "review.container.retired" });
  });

  test("a budget stop in prepare settles with the record's own window", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    const concluded: string[] = [];
    deps.checks = {
      begin: async () => HANDLE,
      terminalize: async (input: { outcome: string }) => {
        concluded.push(input.outcome);
      },
    };
    // The Check this attempt's prepare entry would have opened: settlement
    // concludes THAT run rather than claiming a new one.
    const check = createCheckSettlement({
      deps,
      payload,
      attemptId: ATTEMPT_ID,
      checkBudgets: null,
      deadlineMs: Date.now() + 900_000,
    });
    check.handle = HANDLE;
    deps.checkSettlements.set(ATTEMPT_ID, check);
    // The frozen window is already spent by the post-runner reserve.
    const createdMs = Date.now() - 100_000;
    const ref = { ...makeRef(payload), budgetStartMs: createdMs, deadlineMs: createdMs + 233_000 };

    const step = await prepareAttempt(deps, ref);
    if (!("failure" in step)) throw new Error(`prepare did not refuse: ${step.kind}`);
    expect(step.failure).toMatchObject({ class: "budget", phase: "prepare", window: "preparation" });

    expect(await settleAttemptFailure(deps, ref, step.failure, null)).toMatchObject({
      kind: "budget-exhausted",
      outcome: { budgetWindow: "preparation" },
    });
    expect(concluded).toEqual(["budget-exhausted"]);
    const row = failureRows(db)[0]!;
    expect(String(row.error)).toContain("budget-exhausted:");
    // The operator face: the code and track id are columns, the first line is the
    // plain summary, and the mechanism text follows it in the same cell.
    expect(row.error_code).toBe("review.budget.preparation_spent");
    expect(row.track_id).toBe(ATTEMPT_ID);
    expect(row.message).toBe(FAILURE_SUMMARIES["review.budget.preparation_spent"]);
    const failed = h.logLines.find((line) => line.level === "error" && line.msg.startsWith("review failed:"));
    expect(failed?.fields.error_code).toBe("review.budget.preparation_spent");
    expect(failed?.fields.attempt_id).toBe(ATTEMPT_ID);
    // The refusal is the FIRST entry's: nothing was provisioned.
    expect(h.sandbox.calls).toHaveLength(0);
  });

  test("an unclassified ordinary failure reports its phase, class and bounded message, never the bare sentence", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    const concluded: Array<{ outcome: string; failureDetail?: string }> = [];
    deps.checks = {
      begin: async () => HANDLE,
      terminalize: async (input: { outcome: string; failureDetail?: string }) => {
        concluded.push(input);
      },
    };
    const check = createCheckSettlement({ deps, payload: ref.payload, attemptId: ATTEMPT_ID, checkBudgets: null, deadlineMs: Date.now() + 900_000 });
    check.handle = HANDLE;
    deps.checkSettlements.set(ATTEMPT_ID, check);
    const settlement = await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "pipeline",
        headSha: SHA,
        runnerReturned: false,
        message: "the runner input write failed: exit 3",
        errorClass: "TypeError",
        sendAttemptPublicationId: null,
      },
      null,
    );
    expect(settlement.kind).not.toBe("unknown");
    const row = failureRows(db)[0]!;
    expect(row.error_code).toBe("review.internal.unclassified");
    expect(row.track_id).toBe(ATTEMPT_ID);
    expect(String(row.error)).toBe(
      `internal error in phase review (stage pipeline): TypeError: the runner input write failed: exit 3 (attempt ${ATTEMPT_ID})`,
    );
    // The platform's bare sentence would fail this assertion: it names neither
    // the phase nor the class, so removing the plumbing turns the test red.
    expect(String(row.error)).not.toBe("the runner input write failed: exit 3");
    expect(row.message).toBe(FAILURE_SUMMARIES["review.internal.unclassified"]);
    // The Check carries the PUBLISHABLE half — phase, stage, class, attempt —
    // never the runner-controlled message the row keeps for the operator.
    expect(concluded).toHaveLength(1);
    expect(concluded[0]!.failureDetail).toBe(
      `internal error in phase review (stage pipeline): TypeError — the detail is recorded with the failure, not published here (attempt ${ATTEMPT_ID})`,
    );
    expect(concluded[0]!.failureDetail).not.toContain("the runner input write failed");
    const failed = h.logLines.find((line) => line.level === "error" && line.msg.startsWith("review failed:"));
    expect(failed?.fields).toMatchObject({
      error_code: "review.internal.unclassified",
      attempt_id: ATTEMPT_ID,
    });
  });
  test("a container lost after the claim is named apart from one lost before it", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    const settlement = await settleAttemptFailure(
      deps,
      ref,
      {
        class: "container-lost",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: false,
        message: "the attempt container was lost after its launch was claimed (not-running)",
      },
      null,
    );
    expect(settlement.kind).not.toBe("unknown");
    expect(failureRows(db)[0]!.error_code).toBe("review.container.lost_after_claim");
  });

  test("an unobservable outcome records the phase's own cause, and the container is still not destroyed", async () => {
    // The reported shape: the paid exec was issued, its reply never arrived, and
    // the launch row is the only authority — it cannot say what happened. The
    // phase's own cause must survive to the reconciler, which can only see "no
    // reply"; it carries it as an OBSERVATION on the attempt's handoff row and
    // writes NO failure row of its own.
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    const ref = makeRef(payload);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });
    expect(await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null)).toBe("claimed");
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });

    const cause = "Error: runner rpc failed: check the diff (after 1200ms)";
    const detail = `the attempt container could not be read at the review step (reply-lost) — ${cause} — nothing may be concluded`;
    const settlement = await settleAttemptFailure(
      deps,
      ref,
      {
        class: "unknown",
        phase: "collect",
        stage: "runner",
        headSha: SHA,
        runnerReturned: false,
        containerStateUnknown: true,
        code: "review.paid.reply_lost",
        message: detail,
        cause,
      },
      null,
    );

    expect(settlement).toEqual({ kind: "unknown" });
    // No failure row: the reconciler is the ONE writer, and no reconciler has run.
    expect(failureRows(db)).toHaveLength(0);
    // What the phase leaves is the OBSERVATION — the cause it actually saw.
    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
    expect(handoff?.observation?.code).toBe("review.paid.reply_lost");
    expect(handoff?.observation?.message).toContain(detail);
    expect(handoff?.observation?.cause).toBe(cause);
    // The observation is row state, never queue payload: a recovery re-enqueue
    // must not hand the next delivery a polluted body.
    expect(handoff?.payload).not.toHaveProperty("attemptObservation");
    // ... and nothing is concluded: the launch row still holds the container and
    // the capacity slot, which is the retention veto the reconciler later lifts.
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("launched");
    expect(await cleanupAttempt(deps, ref, { headSha: SHA })).toEqual({ retention: "unknown" });
    expect(h.sandbox.destroyCalls).toBe(0);
  });

  test("a read that loses its reply AFTER the runner returns still carries its cause", async () => {
    // The reported shape: the paid exec returned, then a post-runner document
    // read lost its reply. The launch row is still `launched` with no outcome,
    // so this settles as unknown and the reconciler writes the row later — from
    // the observation this settlement records. Without it the reconciler can
    // only say "no reply ever arrived", which names neither the read that
    // failed nor its cause.
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    const ref = makeRef(payload);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });
    expect(await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null)).toBe("claimed");
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });

    const cause = "Error: report read: transport closed (after 1200ms)";
    const detail = `the attempt container could not be read (reply-lost) — ${cause} — its result is not collected`;
    const settlement = await settleAttemptFailure(
      deps,
      ref,
      {
        class: "unknown",
        phase: "review",
        stage: "pipeline",
        headSha: SHA,
        runnerReturned: true,
        containerStateUnknown: false,
        code: "review.paid.reply_lost",
        message: detail,
        cause,
        lastStage: "synthesize",
      },
      null,
    );

    // A returned runner proves the paid child gone, so nothing is HELD — but the
    // cause is still recorded, because it is the only evidence of the read.
    expect(settlement).toEqual({ kind: "unknown" });
    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
    expect(handoff?.observation?.code).toBe("review.paid.reply_lost");
    expect(handoff?.observation?.cause).toBe(cause);
    expect(handoff?.observation?.message).toContain("report read: transport closed");
    expect(handoff?.observation?.message).toContain("(last stage: synthesize)");
    // The unresolved LINE carries the same field: an operator filtering the log
    // stream by `last_stage` must see where an unobservable outcome stopped.
    const unresolved = h.logLines.find((entry) => entry.msg.startsWith("review unresolved:"));
    expect(unresolved?.fields.last_stage).toBe("synthesize");
  });

  test("a failure row that already tells the attempt's story is not replaced by the phase's observation", async () => {
    // The ordering the recovery lanes depend on. A row written first (the
    // persisted-but-unpublished lane, which saw the durable result) is the
    // authoritative account; the phase's later "reply lost" observation must not
    // be recorded, or that lane's next pass would compose its row from the stale
    // text instead of its own sentence.
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    const ref = makeRef(payload);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });
    const laneStory = "publication never started: the attempt persisted its paid result but nothing was staged";
    await createFailureStore(db as never).record({
      id: ATTEMPT_ID,
      target_id: payload.targetId,
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      head_sha: payload.head_sha!,
      stage: "pipeline",
      code: "review.internal.unclassified",
      trackId: ATTEMPT_ID,
      message: "the review's result never reached the PR",
      error: laneStory,
    });

    const settlement = await settleAttemptFailure(
      deps,
      ref,
      {
        class: "unknown",
        phase: "collect",
        stage: "runner",
        headSha: SHA,
        runnerReturned: false,
        containerStateUnknown: true,
        code: "review.paid.reply_lost",
        message: "the attempt container could not be read (reply-lost) — nothing may be concluded",
        cause: "Error: read failed (after 900ms)",
      },
      null,
    );

    expect(settlement).toEqual({ kind: "unknown" });
    // Nothing was recorded over the lane's row...
    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
    expect(handoff?.observation).toBeNull();
    // ... and the durable row still carries the lane's own sentence.
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.error)).toBe(laneStory);
    expect(rows[0]!.error_code).toBe("review.internal.unclassified");
  });

  test("a CLASSIFIED post-runner throw records the stage the attempt already holds", async () => {
    // The lost-doc-read path throws `AttemptUnknownError`, which carries a code
    // and a cause but no `lastStage` own property — and the runner has already
    // returned. Without the wrapper's progress the record could not say where it
    // stopped, which is exactly what the reconciler's row would then lack.
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    const ref = makeRef(payload);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });

    const record = phaseFailureRecord(
      {
        phase: "review",
        stage: "pipeline",
        headSha: SHA,
        runnerReturned: true,
        tier: "default",
        budgetMs: 600_000,
        changedLines: 17,
        sendAttemptPublicationId: null,
        lastStage: "synthesize",
      },
      new AttemptUnknownError(
        "the attempt container could not be read (reply-lost) — its result is not collected",
        "review.paid.reply_lost",
      ),
    );
    expect(record).not.toBeNull();
    expect(record!.lastStage).toBe("synthesize");
  });

  test("no secret value appears in any step return value", async () => {
    const paidKey = "sk-step-boundary-secret-1";
    const { deps, db } = await makeDeps();
    deps.runnerConfigs.set(TEST_APP_ID, {
      appCfg: { keys: { ark: [paidKey] }, modelChain: "ark/deepseek-v4-flash" },
      modelOverrides: undefined,
      customProviders: undefined,
    });
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerStdout = "";
    h.sandbox.runnerStderr = `authentication failed for ${paidKey}`;
    h.sandbox.runnerExitCode = 3;
    const ref = makeRef(payload);

    const store = new Map<string, unknown>();
    const returns: unknown[] = [];
    const recording: WorkflowStep = {
      do: async (name: string, configOrCallback: unknown, maybeCallback?: unknown): Promise<unknown> => {
        const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as (
          ctx: unknown,
        ) => Promise<unknown>;
        const output = await callback({ step: { name, count: 1 }, attempt: 1, config: {} });
        store.set(name, output);
        returns.push(output);
        return output;
      },
      sleep: async () => {},
      sleepUntil: async () => {},
      waitForEvent: async (): Promise<never> => {
        throw new Error("the recording step store does not wait for events");
      },
    } as unknown as WorkflowStep;
    // An unclassified error (a plain runner failure) is rethrown once its
    // effects are durable, exactly as before — a fresh delivery may retry it.
    await expect(runReviewAttemptWorkflow(deps, ref, recording, async () => {})).rejects.toThrow(/runner failed/);

    const serialized = JSON.stringify(returns);
    expect(serialized).not.toContain(paidKey);
    // The row that settlement did write is redacted where the text is produced.
    const rows = failureRows(db);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(String(row.error)).not.toContain(paidKey);
  });
});

describe("the runner's last traced stage", () => {
  const stageLine = (name: string): string => JSON.stringify({ event: "review_stage", stage: name });

  test("lastRunnerStage keeps the LAST stage line, skips non-events, and bounds the name", () => {
    expect(
      lastRunnerStage(
        `${stageLine("clone")}\n${stageLine("seats")}\nnot json at all\n${JSON.stringify({ event: "other", stage: "x" })}\n${stageLine("synthesize")}\n`,
      ),
    ).toBe("synthesize");
    expect(lastRunnerStage("no traces here\n")).toBeUndefined();
    // A name that carries a credential SHAPE is redacted by the same helper the
    // stderr tail uses — the stage field cannot become a leak.
    expect(lastRunnerStage(stageLine("leak ghp_abcdefghijklmnop"))).toBe(`leak ${REDACTED}`);
    expect(lastRunnerStage(stageLine("z".repeat(200)))!.length).toBeLessThanOrEqual(60);
  });

  test("a stage that IS an exact session secret is redacted by the exact-value pass", () => {
    // Shape redaction cannot see a UUID-shaped or plain-word credential; only the
    // session's own sealed values can. The stage is runner-controlled text, so it
    // gets the same two layers the stderr tail gets.
    const sealed = "9d1f4c0a-77b3-4a1e-9a55-c0ffee123456";
    expect(lastRunnerStage(stageLine(sealed), [sealed])).toBe(REDACTED);
    expect(lastRunnerStage(stageLine(`seats ${sealed} done`), [sealed])).toBe(`seats ${REDACTED} done`);
    // ...and with no secret set it is only shape-redacted, as before.
    expect(lastRunnerStage(stageLine(sealed))).toBe(sealed);
  });

  test("a real runner failure carries the stage into `error` and the log field", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerExitCode = 1;
    h.sandbox.runnerStderr = `${stageLine("clone")}\n${stageLine("synthesize")}\nboom\n`;
    const ref = makeRef(payload);

    // A non-zero exit is a TRANSIENT error: it becomes a record only once the
    // workflow's retries run out, so the whole route is what has to run.
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });
    await expect(runReviewAttemptWorkflow(deps, ref, stepStore(new Map()), async () => {})).rejects.toThrow(
      /last stage: synthesize/,
    );
    const row = failureRows(db)[0]!;
    expect(String(row.error)).toContain("(last stage: synthesize)");
    // The author-facing sentence keeps no internal mechanism wording.
    expect(row.message).not.toContain("synthesize");
    const line = h.logLines.find((entry) => entry.msg.startsWith("review failed:"));
    expect(line?.fields.last_stage).toBe("synthesize");
    // Prepare recorded the head the checkout resolved on the attempt's OWN row,
    // before any paid step: a failure recovered later is attributed to it rather
    // than to the Check identity admission pinned.
    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
    expect(handoff?.reviewedHeadSha).toBe(SHA);
    expect(handoff?.payload).not.toHaveProperty("reviewedHeadSha");
  });

  test("an exact session secret in a stage never reaches the row or the log field", async () => {
    // The end-to-end half of the exact-value rule: the stage is read from the
    // runner's own stderr, so a run that pasted its key into a stage name must
    // still be redacted everywhere the value can surface.
    const paidKey = "9d1f4c0a-77b3-4a1e-9a55-c0ffee123456";
    const { deps, db } = await makeDeps();
    deps.runnerConfigs.set(TEST_APP_ID, {
      appCfg: { keys: { ark: [paidKey] }, modelChain: "ark/deepseek-v4-flash" },
      modelOverrides: undefined,
      customProviders: undefined,
    });
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerExitCode = 1;
    h.sandbox.runnerStderr = `${stageLine(`seats ${paidKey}`)}\nboom\n`;
    const ref = makeRef(payload);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });

    await expect(runReviewAttemptWorkflow(deps, ref, stepStore(new Map()), async () => {})).rejects.toThrow(
      /runner failed/,
    );

    const row = failureRows(db)[0]!;
    expect(String(row.error)).toContain(`(last stage: seats ${REDACTED})`);
    expect(String(row.error)).not.toContain(paidKey);
    const line = h.logLines.find((entry) => entry.msg.startsWith("review failed:"));
    expect(line?.fields.last_stage).toBe(`seats ${REDACTED}`);
    // Nothing on the boundary leaked it either.
    expect(JSON.stringify(h.logLines)).not.toContain(paidKey);
  });

  test("a budget stop carries the stage of the seat that ran out of time", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    h.sandbox.runnerExitCode = 0;
    h.sandbox.runnerStdout = JSON.stringify({
      schema: "mstar.review-budget-exhausted/v1",
      seatsDispatched: 5,
      seatsStopped: 3,
    });
    h.sandbox.runnerStderr = `${stageLine("seats")}\n${stageLine("seat 3/5")}\n`;
    const ref = makeRef(payload);

    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const reviewed = await reviewAttempt(deps, ref, step.prepared);
    if (!("failure" in reviewed) || reviewed.failure.class !== "budget") {
      throw new Error("the budget stop was not classified");
    }
    expect(reviewed.failure.lastStage).toBe("seat 3/5");
    expect(reviewed.failure.message).toContain("(last stage: seat 3/5)");

    const settled = await settleAttemptFailure(deps, ref, reviewed.failure, step.prepared);
    expect(settled.kind).toBe("budget-exhausted");
    const row = failureRows(db)[0]!;
    expect(String(row.error)).toContain("(last stage: seat 3/5)");
    // The Check's author-facing summary is budget wording only: the stage is an
    // operator fact and must not leak into the sentence an author reads.
    expect(row.message).not.toContain("seat 3/5");
    const line = h.logLines.find(
      (entry) => entry.msg.startsWith("review failed:") && entry.fields.error_code !== undefined,
    );
    expect(line?.fields.last_stage).toBe("seat 3/5");
  });
});

describe("the runner's last traced stage — settlement text", () => {
  const stage = (name: string): string => `${JSON.stringify({ event: "review_stage", stage: name })}\n`;

  test("the LAST of two stage lines lands in `error` and in the log field", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    const failed = await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        message: "runner failed: exit 1, stdout 0B, stderr tail: boom (last stage: synthesize)",
        lastStage: "synthesize",
        sendAttemptPublicationId: null,
      },
      null,
    );
    expect(failed.kind).not.toBe("unknown");
    const row = failureRows(db)[0]!;
    expect(String(row.error)).toContain("(last stage: synthesize)");
    // The author-facing sentence keeps no internal mechanism wording.
    expect(row.message).not.toContain("synthesize");
    const line = h.logLines.find((entry) => entry.msg.startsWith("review failed:"));
    expect(line?.fields.last_stage).toBe("synthesize");
  });

  test("a runner that traced no stage leaves the text and the field untouched", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        message: "runner failed: exit 1, stdout 0B, stderr tail: boom",
        sendAttemptPublicationId: null,
      },
      null,
    );
    expect(String(failureRows(db)[0]!.error)).toBe(
      `internal error in phase review (stage runner): runner failed: exit 1, stdout 0B, stderr tail: boom (attempt ${ATTEMPT_ID})`,
    );
    const line = h.logLines.find((entry) => entry.msg.startsWith("review failed:"));
    expect(line?.fields.last_stage).toBeUndefined();
  });

  test("a stage name carrying a credential shape never reaches the row or its log field", async () => {
    // The stage is runner-controlled text. A throw site that did NOT obtain it
    // from `lastRunnerStage` (which already redacts shape and exact values) must
    // still not be able to leak it: the raw value goes in here, and the settled
    // row and its log field must carry the marker instead.
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    const rawStage = "leak ghp_abcdefghijklmnop";
    await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        message: `runner failed: exit 1, stdout 0B, stderr tail: boom (last stage: ${rawStage})`,
        lastStage: rawStage,
        sendAttemptPublicationId: null,
      },
      null,
    );
    const row = failureRows(db)[0]!;
    expect(String(row.error)).toContain(`(last stage: leak ${REDACTED})`);
    expect(String(row.error)).not.toContain("ghp_");
    const line = h.logLines.find((entry) => entry.msg.startsWith("review failed:"));
    expect(line?.fields.last_stage).toBe(`leak ${REDACTED}`);
  });
});

describe("an unclassified internal error reports its stage and cause", () => {
  test("the whole route records the phase, the error class and a bounded message — never the platform sentence", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    // A non-zero exit is the incident's own shape: an UNCLASSIFIED error thrown
    // inside the paid phase, settled once the workflow's retries run out.
    h.sandbox.runnerExitCode = 1;
    h.sandbox.runnerStderr = "boom\n";
    const ref = makeRef(payload);
    const concluded: Array<{ outcome: string; failureDetail?: string }> = [];
    deps.checks = {
      begin: async () => HANDLE,
      terminalize: async (input: { outcome: string; failureDetail?: string }) => {
        concluded.push(input);
      },
    };
    const check = createCheckSettlement({ deps, payload, attemptId: ATTEMPT_ID, checkBudgets: null, deadlineMs: Date.now() + 900_000 });
    check.handle = HANDLE;
    deps.checkSettlements.set(ATTEMPT_ID, check);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });

    await expect(runReviewAttemptWorkflow(deps, ref, stepStore(new Map()), async () => {})).rejects.toThrow(
      /runner failed/,
    );

    const row = failureRows(db)[0]!;
    expect(row.error_code).toBe("review.internal.unclassified");
    // The row names where it stopped and what threw — the phase, the error
    // class and the bounded message — plus the attempt it belongs to.
    expect(String(row.error)).toBe(
      `internal error in phase review (stage runner): Error: runner failed: exit 1, stdout 0B, stderr tail: boom (attempt ${ATTEMPT_ID})`,
    );
    // The observed stage is the step's own report, not the pipeline fallthrough.
    expect(row.stage).toBe("runner");
    // The platform's bare sentence alone no longer satisfies the row.
    expect(String(row.error)).not.toBe("runner failed: exit 1, stdout 0B, stderr tail: boom");
    expect(String(row.error)).not.toBe("Attempt failed due to internal workflows error");
    // The row keeps the operator-facing detail — the runner's stderr excerpt
    // included — but the Check carries only the publishable half.
    expect(String(row.error)).toContain("stderr tail: boom");
    expect(concluded).toHaveLength(1);
    expect(concluded[0]!.failureDetail).toBe(
      `internal error in phase review (stage runner): Error — the detail is recorded with the failure, not published here (attempt ${ATTEMPT_ID})`,
    );
    expect(concluded[0]!.failureDetail).not.toContain("stderr tail");
    expect(concluded[0]!.failureDetail).not.toContain("boom");
    // The operator-facing first line no longer promises the cause is unknown.
    expect(row.message).not.toContain("has not been classified");
  });

  test("a flood of stderr cannot push the runner's traced stage out of the row", async () => {
    // The P7 regression: the free-text message is bounded, and without a
    // reservation for it, the `(last stage: …)` clause is always the part the
    // bound cuts first — the operator regresses from `synthesize` to `runner`.
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    const ref = makeRef(payload);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });
    const concluded: Array<{ outcome: string; failureDetail?: string }> = [];
    deps.checks = {
      begin: async () => HANDLE,
      terminalize: async (input: { outcome: string; failureDetail?: string }) => {
        concluded.push(input);
      },
    };
    const check = createCheckSettlement({ deps, payload, attemptId: ATTEMPT_ID, checkBudgets: null, deadlineMs: Date.now() + 900_000 });
    check.handle = HANDLE;
    deps.checkSettlements.set(ATTEMPT_ID, check);
    const flood = "runner diagnostics flood ".repeat(30); // ~750 characters
    h.sandbox.runnerExitCode = 1;
    h.sandbox.runnerStderr = `${flood}\n${JSON.stringify({ event: "review_stage", stage: "synthesize" })}\n${flood}`;

    await expect(runReviewAttemptWorkflow(deps, ref, stepStore(new Map()), async () => {})).rejects.toThrow(
      /runner failed/,
    );

    const row = failureRows(db)[0]!;
    // Structural facts survive the flood: the traced stage is in the row…
    expect(String(row.error)).toContain("(last stage: synthesize)");
    expect(String(row.error)).toContain("internal error in phase review (stage runner)");
    expect(String(row.error)).toContain("Error:");
    expect(String(row.error)).toContain(`(attempt ${ATTEMPT_ID})`);
    // …the flood itself is cut, and the Check never publishes any of it.
    expect(String(row.error).length).toBeLessThan(600);
    expect(concluded).toHaveLength(1);
    expect(concluded[0]!.failureDetail).not.toContain("last stage");
    expect(concluded[0]!.failureDetail).not.toContain("diagnostics flood");
    expect(concluded[0]!.failureDetail).toContain("(stage runner)");
  });

  test("the thrown error's class crosses a prototype-less rebuild as data", async () => {
    // The platform rebuilds a thrown error across a step retry WITHOUT its
    // prototype: own serializable properties survive, `instanceof` and the
    // constructor do not. The class the throw site captured in `facts` is the
    // only nameable identity left, so it must read back unchanged.
    const cause = new RangeError("sandbox id outside the lease window");
    const thrown = new PhaseTransientError(
      {
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        sendAttemptPublicationId: null,
        rateLimited: null,
      },
      cause,
    );
    expect(thrown.facts.errorClass).toBe("RangeError");

    const rebuilt = new Error(thrown.message);
    for (const key of Object.keys(thrown)) {
      (rebuilt as unknown as Record<string, unknown>)[key] = (thrown as unknown as Record<string, unknown>)[key];
    }
    // The rebuild cannot be asked for its prototype...
    expect(rebuilt).not.toBeInstanceOf(PhaseTransientError);
    // ...its own surviving `name` is the wrapper's, which a specific-name read
    // reports instead of collapsing to the rebuilt constructor...
    expect(errorClassOf(rebuilt)).toBe("PhaseTransientError");
    // ...and a rebuilt plain error carrying a platform name reads THAT.
    const platformRebuilt = Object.assign(new Error("denied"), { name: "RangeError" });
    expect(errorClassOf(platformRebuilt)).toBe("RangeError");
    // ...but the facts carry the real class verbatim either way.
    expect(transientFactsOf(rebuilt)?.errorClass).toBe("RangeError");
    expect(transientFactsOf(rebuilt)?.stage).toBe("runner");
  });

  test("a credential shape in the thrown message reaches neither the row nor the Check detail", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    const concluded: Array<{ outcome: string; failureDetail?: string }> = [];
    deps.checks = {
      begin: async () => HANDLE,
      terminalize: async (input: { outcome: string; failureDetail?: string }) => {
        concluded.push(input);
      },
    };
    const check = createCheckSettlement({ deps, payload: ref.payload, attemptId: ATTEMPT_ID, checkBudgets: null, deadlineMs: Date.now() + 900_000 });
    check.handle = HANDLE;
    deps.checkSettlements.set(ATTEMPT_ID, check);
    await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "pipeline",
        headSha: SHA,
        runnerReturned: false,
        message: "the token ghp_abcdefghijklmnop was refused by the upstream",
        errorClass: "Error",
        sendAttemptPublicationId: null,
      },
      null,
    );
    const row = failureRows(db)[0]!;
    expect(String(row.error)).not.toContain("ghp_abcdefghijklmnop");
    expect(String(row.error)).toContain(REDACTED);
    expect(concluded[0]!.failureDetail).not.toContain("ghp_abcdefghijklmnop");
  });

  test("a runaway message is bounded in the row and the Check detail", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    const longMessage = `the write failed: ${"x".repeat(2000)}`;
    await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "collect",
        stage: "pipeline",
        headSha: SHA,
        runnerReturned: false,
        message: longMessage,
        errorClass: "Error",
        sendAttemptPublicationId: null,
      },
      null,
    );
    const row = failureRows(db)[0]!;
    expect(String(row.error).length).toBeLessThan(600);
    expect(String(row.error)).toContain("internal error in phase collect (stage pipeline): Error:");
    expect(String(row.error)).toContain(`(attempt ${ATTEMPT_ID})`);
  });
});

describe("sanitization precedes the bound (C1/W4/W6 hardening)", () => {
  /** Seed the launch row and seal a credential set on it, as the paid step would. */
  async function sealLaunchSecrets(db: TestD1, values: string[]): Promise<void> {
    expect(await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null)).toBe("claimed");
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });
    const sealed = await sealGateSecrets(TEST_KEY, ATTEMPT_ID, values);
    db.raw
      .prepare("UPDATE review_launches SET gate_secrets_enc = ? WHERE attempt_id = ?")
      .run(sealed, ATTEMPT_ID);
  }

  test("a sealed credential straddling the message bound reaches no durable sink", async () => {
    // The regression the short shaped token cannot catch: the credential has no
    // recognizable shape (only exact redaction sees it), and it straddles the
    // 400-character cut, so a cut-first composition would leave its plaintext
    // prefix in the row.
    const secret = `k${"s".repeat(460)}`;
    const { deps, db } = await makeDeps();
    await sealLaunchSecrets(db, [secret]);
    const ref = makeRef(makePayload());
    const concluded: Array<{ outcome: string; failureDetail?: string }> = [];
    deps.checks = {
      begin: async () => HANDLE,
      terminalize: async (input: { outcome: string; failureDetail?: string }) => {
        concluded.push(input);
      },
    };
    const check = createCheckSettlement({ deps, payload: ref.payload, attemptId: ATTEMPT_ID, checkBudgets: null, deadlineMs: Date.now() + 900_000 });
    check.handle = HANDLE;
    deps.checkSettlements.set(ATTEMPT_ID, check);
    // The secret sits across the bound: padding before it, padding after it.
    // The message half is cut where the stage clause's reservation ends — the
    // exact length is not the test's concern, only that the credential straddles
    // it — so the padding is sized to the bounded cap (380) in effect here.
    const message = `${"p".repeat(340)}${secret}${"q".repeat(80)}`;
    await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        message,
        errorClass: "Error",
        sendAttemptPublicationId: null,
      },
      null,
    );
    const row = failureRows(db)[0]!;
    expect(String(row.error)).not.toContain(secret);
    // The biting assertion: ANY run of the credential's own character after
    // the padding is a leak — with a cut-first composition the fragment before
    // the cut (the credential's opening characters) survives redaction verbatim.
    expect(String(row.error)).not.toMatch(/ks{5,}/);
    expect(String(row.error)).toContain(REDACTED);
    expect(concluded[0]!.failureDetail).not.toContain(secret);
    expect(concluded[0]!.failureDetail).not.toMatch(/ks{5,}/);
  });

  test("an unopenable seal settles as unknown: no row, no observation, no raw byte anywhere", async () => {
    // The envelope exists but decryption cannot complete — a wrong key, a
    // tampered row. The paid-state question must stay OPEN: nothing is written,
    // because nothing derived from the raw message can be proven clean, and a
    // conclusive "it failed" would be a worse answer than the original defect.
    const { deps, db } = await makeDeps();
    expect(await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null)).toBe("claimed");
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });
    db.raw
      .prepare("UPDATE review_launches SET gate_secrets_enc = ? WHERE attempt_id = ?")
      .run("not-a-valid-envelope", ATTEMPT_ID);
    const ref = makeRef(makePayload());
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(ref.payload),
      attemptId: ATTEMPT_ID,
      payload: ref.payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });
    const settlement = await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        message: "the raw detail that must never be persisted",
        errorClass: "Error",
        sendAttemptPublicationId: null,
      },
      null,
    );
    // The outcome is unknown — the reconciler, not a fabricated failure row,
    // owns what happens next.
    expect(settlement).toEqual({ kind: "unknown" });
    expect(failureRows(db)).toHaveLength(0);
    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(ref.payload));
    expect(handoff?.observation ?? null).toBeNull();
    expect(JSON.stringify(handoff)).not.toContain("the raw detail that must never be persisted");
  });

  test("an empty message says so instead of rendering a bare colon", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        message: "",
        errorClass: "Error",
        sendAttemptPublicationId: null,
      },
      null,
    );
    const row = failureRows(db)[0]!;
    expect(String(row.error)).toContain("(no message recorded)");
    expect(String(row.error)).not.toMatch(/Error:  \(attempt/);
  });

  test("a runaway class token is normalized and bounded", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    const hugeClass = `Weird Error ${"C".repeat(500)}`;
    await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        message: "boom",
        errorClass: hugeClass,
        sendAttemptPublicationId: null,
      },
      null,
    );
    const row = failureRows(db)[0]!;
    expect(String(row.error)).not.toContain("WeirdError" + "C".repeat(100));
    expect(String(row.error).length).toBeLessThan(600);
    expect(String(row.error)).toContain("WeirdError");
  });

  test("errorClassOf never throws on hostile objects and prefers specific names", () => {
    const hostile = {};
    Object.defineProperty(hostile, "constructor", {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(errorClassOf(hostile)).toBeUndefined();
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("revoked");
        },
      },
    );
    expect(errorClassOf(proxy)).toBeUndefined();
    // A constructor whose OWN `name` getter throws: the second read must be as
    // guarded as the first.
    const hostileCtor = {};
    Object.defineProperty(hostileCtor, "name", {
      get() {
        throw new Error("hostile constructor name");
      },
    });
    // Degrades to the surviving generic name — never throws.
    expect(errorClassOf(Object.assign(new Error("x"), { constructor: hostileCtor }))).toBe("Error");
    // A node-style code outranks a generic name.
    expect(errorClassOf(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("ECONNRESET");
    // A specific constructor still wins over everything.
    expect(errorClassOf(new TypeError("x"))).toBe("TypeError");
  });

  test("a nested transient error keeps the class the inner throw captured", () => {
    const inner = new PhaseTransientError(
      { stage: "runner", headSha: SHA, runnerReturned: true, sendAttemptPublicationId: null, rateLimited: null },
      new RangeError("inner detail"),
    );
    const outer = new PhaseTransientError(
      { stage: "pipeline", headSha: SHA, runnerReturned: false, sendAttemptPublicationId: null, rateLimited: null },
      inner,
    );
    expect(outer.facts.errorClass).toBe("RangeError");
  });

  test("a nested transient error with no captured class records none — never the wrapper's name", () => {
    // The inner cause is a plain Error: no class was captured, and the wrapper's
    // own name is not a class that threw anything.
    const inner = new PhaseTransientError(
      { stage: "runner", headSha: SHA, runnerReturned: true, sendAttemptPublicationId: null, rateLimited: null },
      "a bare string throw",
    );
    const outer = new PhaseTransientError(
      { stage: "pipeline", headSha: SHA, runnerReturned: false, sendAttemptPublicationId: null, rateLimited: null },
      inner,
    );
    expect(outer.facts.errorClass).toBeUndefined();
  });

  test("a class instance without its own name reads its constructor's class", () => {
    class LeaseLostError extends Error {}
    // The instance's `name` is the generic Error one; the constructor carries
    // the real class. Reading it requires the constructor path to accept
    // function-valued constructors.
    expect(errorClassOf(new LeaseLostError("expired"))).toBe("LeaseLostError");
  });

  test("a transient D1 read fault propagates as a settlement throw, not an unknown outcome", async () => {
    // A store fault is retryable evidence about nothing: it must NOT take the
    // unopenable-seal branch, which would suppress the row and the Check.
    const { deps, db } = await makeDeps();
    expect(await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null)).toBe("claimed");
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });
    db.raw.prepare("DROP TABLE IF EXISTS review_launches").run();
    const ref = makeRef(makePayload());
    await expect(
      settleAttemptFailure(
        deps,
        ref,
        {
          class: "failure",
          phase: "review",
          stage: "runner",
          headSha: SHA,
          runnerReturned: true,
          message: "the runner input write failed: exit 3",
          errorClass: "Error",
          sendAttemptPublicationId: null,
        },
        null,
      ),
    ).rejects.toThrow();
  });
});

describe("the review step's phase attribution", () => {
  test("a platform failure of the review step is attributed to review, never to prepare", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    const ref = makeRef(payload);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });

    // The step boundary itself fails BEFORE invoking the review callback: the
    // platform's own fault, with no facts any wrapper could have captured. The
    // attribution must come from the workflow's own phase tracking.
    const failingReview: WorkflowStep = {
      do: async (name: string, configOrCallback: unknown, maybeCallback?: unknown): Promise<unknown> => {
        if (name === "review") {
          throw Object.assign(new Error("the workflow engine lost the step"), { name: "WorkflowStepError" });
        }
        const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as (
          ctx: unknown,
        ) => Promise<unknown>;
        return callback({ step: { name, count: 1 }, attempt: 1, config: {} });
      },
      sleep: async () => {},
      sleepUntil: async () => {},
      waitForEvent: async (): Promise<never> => {
        throw new Error("the test step store does not wait for events");
      },
    } as unknown as WorkflowStep;

    await expect(runReviewAttemptWorkflow(deps, ref, failingReview, async () => {})).rejects.toThrow(
      /workflow engine lost the step/,
    );
    const row = failureRows(db)[0]!;
    expect(String(row.error)).toContain("internal error in phase review");
    expect(String(row.error)).not.toContain("internal error in phase prepare");
    // The platform error's own name is the class the row reports.
    expect(String(row.error)).toContain("WorkflowStepError");
  });
});

describe("the delivered Check summary of an unclassified failure", () => {
  test("the real lifecycle's completed Check carries the stage, phase and class", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    // The Check row the settlement terminalizes, claimed the way the §7.10 lane
    // claims it — through the real store, and the handle carries the lease the
    // claim actually minted: the lifecycle's fences compare it against the row.
    const claimedCheck = await claimAttempt(db as never, {
      scope: SCOPE,
      githubAppId: 424242,
      headSha: SHA,
      triggeredBy: "pull_request",
      action: "opened",
      holder: `consumer:${ATTEMPT_ID}`,
      nowMs: Date.now(),
      executionDeadlineMs: Date.now() + 600_000,
    });
    if (claimedCheck.kind !== "claimed") throw new Error(`fixture: expected claimed, got ${claimedCheck.kind}`);
    const checkRowId = claimedCheck.attempt.identity.attemptId;
    expect(await setCheckCreateState(db as never, checkRowId, claimedCheck.lease, "sending", undefined, Date.now())).toBe(true);
    expect(await attachCheckRunId(db as never, checkRowId, claimedCheck.lease, 4242, Date.now())).toBe(true);
    // The claim is NOT released: the settlement terminalizes the run it still
    // owns, and the lifecycle's ownership fence reads the holder off the row.
    const handle: CheckHandle = { attemptId: checkRowId, scope: SCOPE, githubAppId: 424242, headSha: SHA, lease: claimedCheck.lease };

    // The REAL lifecycle: the same begin/terminalize production wires, with only
    // the GitHub transport doubled. The completed Check's summary is what the PR
    // page shows.
    let delivered: { conclusion?: string; output?: { title?: string; summary?: string } } | null = null;
    const octokit: ChecksOctokit = {
      rest: {
        checks: {
          update: async (params: Record<string, unknown>) => {
            delivered = {
              conclusion: "conclusion" in params ? (params.conclusion as string) : undefined,
              output: "output" in params ? (params.output as { title?: string; summary?: string }) : undefined,
            };
            return {
              data: {
                id: 4242,
                name: CHECK_NAME,
                head_sha: handle.headSha,
                external_id: "",
                status: "completed",
                conclusion: "conclusion" in params ? params.conclusion : undefined,
                output: "output" in params ? params.output : undefined,
                app: { id: handle.githubAppId },
              },
            };
          },
          create: async () => {
            throw new Error("no create expected");
          },
          get: async () => {
            throw new Error("no get expected");
          },
          listForRef: async () => {
            throw new Error("no list expected");
          },
        },
      },
    } as ChecksOctokit;
    const adapter = createChecksAdapter({ db: db as never, nowMs: () => Date.now(), getOctokit: async () => octokit });
    const lifecycle = createCheckLifecycle({
      db: db as never,
      nowMs: () => Date.now(),
      getAdapter: () => adapter,
      getCheckGate: async () => ({ minScore: 0, passVerdicts: ["ship it"] }),
    });
    deps.checks = lifecycle;
    const check = createCheckSettlement({ deps, payload: ref.payload, attemptId: ATTEMPT_ID, checkBudgets: null, deadlineMs: Date.now() + 900_000 });
    check.handle = handle;
    deps.checkSettlements.set(ATTEMPT_ID, check);

    await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        message: "the runner input write failed: exit 3",
        errorClass: "TypeError",
        sendAttemptPublicationId: null,
      },
      null,
    );

    expect(delivered).not.toBeNull();
    expect(delivered!.conclusion).toBe("failure");
    const summary = delivered!.output?.summary ?? "";
    // The approved sentence stands first; the recorded facts follow it — the
    // phase AND the observed stage AND the class, so a red Check already says
    // where and what.
    expect(summary.startsWith(TERMINAL_FAILURE_TEXT["unknown-failure"])).toBe(true);
    expect(summary).toContain("internal error in phase review");
    expect(summary).toContain("stage runner");
    expect(summary).toContain("TypeError");
    expect(summary).toContain(`attempt ${ATTEMPT_ID}`);
  });
});

describe("the observation carries sanitized, then bounded text", () => {
  test("a sealed credential straddling the cause bound never reaches the handoff observation", async () => {
    const secret = `k${"s".repeat(460)}`;
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    const ref = makeRef(payload);
    expect(await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null)).toBe("claimed");
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });
    const sealed = await sealGateSecrets(TEST_KEY, ATTEMPT_ID, [secret]);
    db.raw
      .prepare("UPDATE review_launches SET gate_secrets_enc = ? WHERE attempt_id = ?")
      .run(sealed, ATTEMPT_ID);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });

    // The cause straddles the 500-character observation bound: exact redaction
    // must see it whole, or the fragment before the cut persists as plaintext.
    const cause = `Error: read failed ${"p".repeat(400)}${secret}${"q".repeat(120)}`;
    const settlement = await settleAttemptFailure(
      deps,
      ref,
      {
        class: "unknown",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        containerStateUnknown: false,
        code: "review.paid.reply_lost",
        message: "the attempt container could not be read (reply-lost) — its result is not collected",
        cause,
      },
      null,
    );
    expect(settlement).toEqual({ kind: "unknown" });
    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
    expect(handoff?.observation?.cause).not.toContain(secret);
    expect(handoff?.observation?.cause).not.toMatch(/ks{5,}/);
    expect(handoff?.observation?.cause).toContain(REDACTED);
    expect(handoff?.observation?.message).not.toContain(secret);
  });

  test("an abandoned terminalize hands the detail to the fallback freeze", async () => {
    // The promotion-abandoned lane: the terminalize that never starts must not
    // freeze the bare sentence when the settlement already knows where and what.
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    const abandonedInputs: Array<{ outcome?: string; failureDetail?: string }> = [];
    deps.checks = {
      begin: async () => HANDLE,
      terminalize: async () => {},
      abandonTerminalize: async (input: { outcome?: string; failureDetail?: string }) => {
        abandonedInputs.push(input);
        return true;
      },
    };
    const check = createCheckSettlement({ deps, payload: ref.payload, attemptId: ATTEMPT_ID, checkBudgets: null, deadlineMs: Date.now() + 900_000 });
    check.handle = HANDLE;
    // The promotion was abandoned: the terminalize hands off instead of sending.
    check.promotionAbandoned = HANDLE.attemptId;
    deps.checkSettlements.set(ATTEMPT_ID, check);
    await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        message: "the runner input write failed: exit 3",
        errorClass: "TypeError",
        sendAttemptPublicationId: null,
      },
      null,
    );
    expect(abandonedInputs).toHaveLength(1);
    expect(abandonedInputs[0]!.failureDetail).toContain("internal error in phase review");
    expect(abandonedInputs[0]!.failureDetail).toContain("stage runner");
    expect(abandonedInputs[0]!.failureDetail).toContain("TypeError");
  });
});

describe("exact redaction precedes the shape pass (R1/R4 hardening)", () => {
  test("a sealed credential the shape pass would clip leaves no suffix fragment anywhere", async () => {
    // QC's repro: the shape pass matches only the `ghp_…` PREFIX, so exact-first
    // ordering is the only way `-and-more` — still part of the credential — can
    // be removed.
    const secret = `ghp_${"a".repeat(32)}-and-more`;
    const { deps, db } = await makeDeps();
    expect(await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null)).toBe("claimed");
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });
    const sealed = await sealGateSecrets(TEST_KEY, ATTEMPT_ID, [secret]);
    db.raw
      .prepare("UPDATE review_launches SET gate_secrets_enc = ? WHERE attempt_id = ?")
      .run(sealed, ATTEMPT_ID);
    const ref = makeRef(makePayload());
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(ref.payload),
      attemptId: ATTEMPT_ID,
      payload: ref.payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });
    await settleAttemptFailure(
      deps,
      ref,
      {
        class: "unknown",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        containerStateUnknown: false,
        code: "review.paid.reply_lost",
        message: `boom ${secret} end`,
        cause: `Error: read failed ${secret} trailing`,
      },
      null,
    );
    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(ref.payload));
    expect(handoff?.observation?.cause).not.toContain(secret);
    expect(handoff?.observation?.cause).not.toContain("-and-more");
    expect(handoff?.observation?.message).not.toContain(secret);
    expect(handoff?.observation?.message).not.toContain("-and-more");
  });

  test("a hostile error object cannot abort settlement — a row is still written", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    const ref = makeRef(payload);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });

    // The review step's boundary hands back an object whose every interesting
    // property throws when read: settlement must degrade, never die.
    const hostile: Record<string, unknown> = {};
    for (const key of ["message", "cause", "facts", "lastStage", "name", "constructor"]) {
      Object.defineProperty(hostile, key, {
        get() {
          throw new Error(`hostile ${key}`);
        },
        enumerable: true,
      });
    }
    const hostileSteps: WorkflowStep = {
      do: async (name: string, configOrCallback: unknown, maybeCallback?: unknown): Promise<unknown> => {
        if (name === "review") throw hostile;
        const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as (
          ctx: unknown,
        ) => Promise<unknown>;
        return callback({ step: { name, count: 1 }, attempt: 1, config: {} });
      },
      sleep: async () => {},
      sleepUntil: async () => {},
      waitForEvent: async (): Promise<never> => {
        throw new Error("the test step store does not wait for events");
      },
    } as unknown as WorkflowStep;

    await runReviewAttemptWorkflow(deps, ref, hostileSteps, async () => {}).catch(() => {});
    const rows = failureRows(db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.error_code).toBe("review.internal.unclassified");
    expect(String(rows[0]!.error)).toContain("internal error in phase review");
  });
});

describe("the observation cause resists a pre-cut regression (R7)", () => {
  test("a credential straddling the 240 boundary in an ordinaryFailure cause leaves no fragment", async () => {
    const secret = `k${"s".repeat(59)}`;
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    // The launched row the unobservable verdict needs, plus the envelope the
    // exact pass reads — the same rows the paid step would have left.
    expect(await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null)).toBe("claimed");
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });
    const sealed = await sealGateSecrets(TEST_KEY, ATTEMPT_ID, [secret]);
    db.raw
      .prepare("UPDATE review_launches SET gate_secrets_enc = ? WHERE attempt_id = ?")
      .run(sealed, ATTEMPT_ID);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(ref.payload),
      attemptId: ATTEMPT_ID,
      payload: ref.payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });

    // The record is built by ordinaryFailure itself — the same composer the
    // workflow's catch uses — so a pre-cut inside it is exactly what this test
    // inverts against. The padding places the secret so it straddles offset
    // 240 of the composed `TypeError: <message>` cause: a `slice(0, 240)` there
    // would leave the credential's opening fragment beyond redaction's reach.
    const padding = "p".repeat(218);
    const longMessage = `${padding}${secret}${"q".repeat(60)}`;
    const failure = ordinaryFailure(new TypeError(longMessage), "review", null, undefined);
    expect(failure.cause?.length).toBeGreaterThan(240);

    const settlement = await settleAttemptFailure(deps, ref, failure, null);
    expect(settlement).toEqual({ kind: "unknown" });
    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(ref.payload));
    expect(handoff?.observation?.cause).not.toContain(secret);
    expect(handoff?.observation?.cause ?? "").not.toMatch(/ks{5,}/);
    expect(handoff?.observation?.cause).toContain(REDACTED);
  });
});

describe("the log sink carries only sanitized free text (T1/T2)", () => {
  test("a shapeless sealed value in lastStage never reaches the structured log fields", async () => {
    const secret = `k${"s".repeat(59)}`;
    const { deps, db } = await makeDeps();
    expect(await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null)).toBe("claimed");
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });
    const sealed = await sealGateSecrets(TEST_KEY, ATTEMPT_ID, [secret]);
    db.raw
      .prepare("UPDATE review_launches SET gate_secrets_enc = ? WHERE attempt_id = ?")
      .run(sealed, ATTEMPT_ID);
    const ref = makeRef(makePayload());
    await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        message: "the runner input write failed: exit 3",
        errorClass: "Error",
        lastStage: `synthesize ${secret}`,
        sendAttemptPublicationId: null,
      },
      null,
    );
    for (const line of h.logLines) {
      // The WHOLE captured line — fields AND the message text: a credential
      // that leaked into either half of the sink must fail this test.
      const captured = `${JSON.stringify(line.fields)} ${line.msg}`;
      expect(captured).not.toContain(secret);
      expect(captured).not.toMatch(/ks{5,}/);
    }
    const errorLine = h.logLines.find((line) => line.level === "error");
    expect(errorLine?.fields?.last_stage).toContain(REDACTED);
  });

  test("a has-trap that throws only on errorClass cannot abort settlement", async () => {
    // QC3's trap: the optional-key `in` probe itself throws. The classification
    // degrades to undefined — and settlement still writes the row.
    // The target carries the REQUIRED keys so validation reaches the optional
    // probe — a bare target would exit at the first missing required key and
    // the trap would never fire.
    const trapped = new Proxy(
      {
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        sendAttemptPublicationId: null,
        rateLimited: null,
      },
      {
        has(target, key) {
          if (key === "errorClass") throw new Error("hostile has-trap");
          return key in target;
        },
      },
    );
    expect(transientFactsOf(Object.assign(new Error("x"), { facts: trapped }))).toBeUndefined();

    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    const ref = makeRef(payload);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId: ATTEMPT_ID,
      payload,
      nowMs: Date.now(),
      createdMs: ref.roundStartedAt,
      enqueuedMs: 0,
      deadlineMs: ref.deadlineMs,
    });
    const trapSteps: WorkflowStep = {
      do: async (name: string, configOrCallback: unknown, maybeCallback?: unknown): Promise<unknown> => {
        if (name === "review") {
          throw Object.assign(new Error("the step failed"), { facts: trapped });
        }
        const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as (
          ctx: unknown,
        ) => Promise<unknown>;
        return callback({ step: { name, count: 1 }, attempt: 1, config: {} });
      },
      sleep: async () => {},
      sleepUntil: async () => {},
      waitForEvent: async (): Promise<never> => {
        throw new Error("the test step store does not wait for events");
      },
    } as unknown as WorkflowStep;

    await runReviewAttemptWorkflow(deps, ref, trapSteps, async () => {}).catch(() => {});
    expect(failureRows(db).length).toBe(1);
    expect(failureRows(db)[0]!.error_code).toBe("review.internal.unclassified");
  });
});

describe("the delivered Check summary never carries free text (P3 bite)", () => {
  test("a sealed credential inside the error class reaches neither the delivered Check summary nor the row", async () => {
    // The publishable detail's only free-text interpolation left is the error
    // class. This is the bite the removed vacuous loop pretended to have: the
    // REAL lifecycle's delivered update is asserted, not a hook input shape.
    const secret = `ghp_${"a".repeat(32)}-and-more`;
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    expect(await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null)).toBe("claimed");
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });
    const sealed = await sealGateSecrets(TEST_KEY, ATTEMPT_ID, [secret]);
    db.raw
      .prepare("UPDATE review_launches SET gate_secrets_enc = ? WHERE attempt_id = ?")
      .run(sealed, ATTEMPT_ID);
    const claimedCheck = await claimAttempt(db as never, {
      scope: SCOPE,
      githubAppId: 424242,
      headSha: SHA,
      triggeredBy: "pull_request",
      action: "opened",
      holder: `consumer:${ATTEMPT_ID}`,
      nowMs: Date.now(),
      executionDeadlineMs: Date.now() + 600_000,
    });
    if (claimedCheck.kind !== "claimed") throw new Error(`fixture: expected claimed, got ${claimedCheck.kind}`);
    const checkRowId = claimedCheck.attempt.identity.attemptId;
    expect(await setCheckCreateState(db as never, checkRowId, claimedCheck.lease, "sending", undefined, Date.now())).toBe(true);
    expect(await attachCheckRunId(db as never, checkRowId, claimedCheck.lease, 4242, Date.now())).toBe(true);
    const handle: CheckHandle = { attemptId: checkRowId, scope: SCOPE, githubAppId: 424242, headSha: SHA, lease: claimedCheck.lease };

    let delivered: { conclusion?: string; output?: { title?: string; summary?: string } } | null = null;
    const octokit: ChecksOctokit = {
      rest: {
        checks: {
          update: async (params: Record<string, unknown>) => {
            delivered = {
              conclusion: "conclusion" in params ? (params.conclusion as string) : undefined,
              output: "output" in params ? (params.output as { title?: string; summary?: string }) : undefined,
            };
            return {
              data: {
                id: 4242,
                name: CHECK_NAME,
                head_sha: handle.headSha,
                external_id: "",
                status: "completed",
                conclusion: "conclusion" in params ? params.conclusion : undefined,
                output: "output" in params ? params.output : undefined,
                app: { id: handle.githubAppId },
              },
            };
          },
          create: async () => {
            throw new Error("no create expected");
          },
          get: async () => {
            throw new Error("no get expected");
          },
          listForRef: async () => {
            throw new Error("no list expected");
          },
        },
      },
    } as ChecksOctokit;
    const adapter = createChecksAdapter({ db: db as never, nowMs: () => Date.now(), getOctokit: async () => octokit });
    const lifecycle = createCheckLifecycle({
      db: db as never,
      nowMs: () => Date.now(),
      getAdapter: () => adapter,
      getCheckGate: async () => ({ minScore: 0, passVerdicts: ["ship it"] }),
    });
    deps.checks = lifecycle;
    const check = createCheckSettlement({ deps, payload: ref.payload, attemptId: ATTEMPT_ID, checkBudgets: null, deadlineMs: Date.now() + 900_000 });
    check.handle = handle;
    deps.checkSettlements.set(ATTEMPT_ID, check);

    await settleAttemptFailure(
      deps,
      ref,
      {
        class: "failure",
        phase: "review",
        stage: "runner",
        headSha: SHA,
        runnerReturned: true,
        message: `boom ${secret} end`,
        errorClass: `Evil${secret}Error`,
        sendAttemptPublicationId: null,
      },
      null,
    );

    expect(delivered).not.toBeNull();
    const summary = delivered!.output?.summary ?? "";
    expect(summary).not.toContain(secret);
    expect(summary).not.toContain("-and-more");
    // The runner-controlled message body never reaches the public surface at all.
    expect(summary).not.toContain("boom");
    // What the Check DOES say: the structural facts.
    expect(summary).toContain("internal error in phase review");
    expect(summary).toContain("stage runner");
    expect(summary).toContain(`attempt ${ATTEMPT_ID}`);
    // The row, operator-facing, still carries the full composed detail — with
    // the credential exact-redacted out of it.
    const row = failureRows(db)[0]!;
    expect(String(row.error)).not.toContain(secret);
    expect(String(row.error)).not.toContain("-and-more");
    expect(String(row.error)).toContain("boom");
  });
});
