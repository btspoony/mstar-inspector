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
  registerGitOpsCommands,
  seedOpenTarget,
  seedPriorPublication,
} from "../helpers/consumer-fixtures";
import { testAppPem } from "../helpers/rsa-key";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createConsumerHarness, makePayload } from "../helpers/consumer-harness";
import { FINDING_BODY_MAX } from "../../src/review/schema";
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

const {
  cleanupAttempt,
  collectAttempt,
  createCheckSettlement,
  prepareAttempt,
  publishAttempt,
  reviewAttempt,
} = await import("../../src/pipeline/review-attempt-execution");
const { runReviewAttemptWorkflow } = await import("../../src/workflow/review");
const { hydrateAttemptHost, ensureRunnerConfig } = await import("../../src/pipeline/consumer");
const { PublicationDeadlineSpent, postLineCommentsWithOctokit, postPreparedReviewWithOctokit, publicationSendGuard, PreparedSendRejected } = await import(
  "../../src/pipeline/comment"
);
const { RoundBudgetSpent } = await import("../../src/pipeline/review-attempt");
const { reconcileReviewLifecycle } = await import("../../src/worker/lifecycle-reconcile");
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
    const recoveryLease = await claimCheckRecovery(db as never, checkAttemptId, "recovery-test", now);
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

    await expect(prepareAttempt(deps, ref)).rejects.toMatchObject({ cause: expect.any(MovedHeadError) });

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
    await expect(publishAttempt(publishing, late, collected.collected.publicationId)).rejects.toThrow(
      /no first publication/,
    );

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
    await expect(collectAttempt(collecting, ref, prepared)).rejects.toMatchObject({
      cause: expect.any(RoundBudgetSpent),
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
    await expect(collectAttempt(collecting, { ...ref, deadlineMs: Date.now() - 1 }, prepared)).rejects.toThrow(
      /no first publication/,
    );
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
    expect(h.sandbox.destroyCalls).toBe(0);
    const inflight = db.raw.prepare("SELECT attempt_id FROM review_inflight").all() as Array<{ attempt_id: string }>;
    expect(inflight).toEqual([{ attempt_id: ATTEMPT_ID }]);
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
      const { deps, db, ref, prepared } = await reviewedEcho(echo, false);
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

      deps.credentials.set(ATTEMPT_ID, { token: "ghs_gate_token", secretValues: [KEY] });
      expect(await collectAttempt(deps, ref, prepared)).toEqual({ kind: "settled", outcome: { kind: "ok" } });

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
      expect(failure.some((row) => row.error.includes("publish gate refused"))).toBe(true);
      const handoff = db.raw
        .prepare("SELECT settled_ms FROM review_attempt_handoffs WHERE attempt_id = ?")
        .get(ATTEMPT_ID) as { settled_ms: number | null };
      expect(handoff.settled_ms).not.toBeNull();
    });
  }

  test("a resumed host without credentials records that the gate could not run", async () => {
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false);
    deps.credentials.delete(ATTEMPT_ID);
    const collected = await collectAttempt(deps, ref, prepared);
    expect(collected.kind).toBe("collected");
    expect(
      h.logLines.filter((line) => line.level === "warn" && line.msg.includes("publish gate could not run")),
    ).toHaveLength(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_publications WHERE head_sha = ?").get(SHA)).toMatchObject({ n: 1 });
  });

  test("a short key equal to trusted marker text is not refused", async () => {
    const { deps, ref, prepared } = await reviewedEcho("plain text", false);
    deps.credentials.set(ATTEMPT_ID, { token: "ghs_gate_token", secretValues: ["mstar"] });
    const collected = await collectAttempt(deps, ref, prepared);
    expect(collected.kind).toBe("collected");
    expect(h.logLines.some((line) => line.msg.includes("publish gate refused"))).toBe(false);
  });

  test("a key whose hex collides with the commit SHA does not refuse a clean review", async () => {
    const key = String.fromCharCode(0x01, 0x23, 0x45);
    expect(Buffer.from(key, "utf8").toString("hex")).toBe(SHA.slice(0, 6));
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false);
    deps.credentials.set(ATTEMPT_ID, { token: "ghs_gate_token", secretValues: [key] });

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
    deps.credentials.set(ATTEMPT_ID, { token: "ghs_gate_token", secretValues: [KEY] });

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
    expect(inline).not.toContain("```suggestion");
    expect(inline).toContain("after");
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
    deps.credentials.set(ATTEMPT_ID, { token: "ghs_gate_token", secretValues: [KEY] });
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

  test("a resumed degraded publish warns once and continues", async () => {
    const { deps, ref, prepared } = await brokenStdout(ECHOES.base64);
    deps.credentials.delete(ATTEMPT_ID);
    const collected = await collectAttempt(deps, ref, prepared);
    expect(collected.kind).toBe("settled");
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared-degraded")).toHaveLength(1);
    expect(
      h.logLines.filter((line) => line.level === "warn" && line.msg.includes("publish gate could not run")),
    ).toHaveLength(1);
  });

  test("the degraded gate exact-matches an encoding that is the whole stdout", async () => {
    const key = "{";
    const echo = Buffer.from(key).toString("base64url");
    expect(echo).toBe("ew");
    const { deps, db, ref, prepared } = await brokenStdout(echo, true);
    deps.credentials.set(ATTEMPT_ID, { token: "ghs_gate_token", secretValues: [key] });

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

    deps.credentials.set(ATTEMPT_ID, { token: "ghs_gate_token", secretValues: [KEY] });
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
