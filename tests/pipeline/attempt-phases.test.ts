/**
 * note: The five attempt phases, each driven ALONE from a hand-built input — and one
 * case that simulates a RESTART: after `prepare`, only the returned data and the
 * attempt's sandbox id survive; `review`, `collect`, `publish` and `cleanup`
 * then run from the persisted records alone.
 *
 * The rule these cases enforce is the module's own: a phase may hold live
 * objects internally, but its input and output are DATA. `JSON.parse(JSON.
 * stringify(handoff))` is therefore a faithful restart input, and every phase
 * re-derives the container, the adapter and the token from `deps`.
 */
import { RECONCILE_DEFAULTS } from "../../src/contracts/reconcile-settings";
import { beforeEach, describe, expect, test } from "bun:test";

// note: Load shim FIRST: the execution module statically imports ./sandbox → the
// workerd builtin `cloudflare:workers`. Every double is injected.
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
import type { WorkflowStep } from "cloudflare:workers";
import type { TestD1 } from "../store/helpers";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type { Lease } from "../../src/store/finding-lifecycle";
import type { PostOctokit, PostPreparedLineCommentsInput, PostPreparedReviewInput } from "../../src/pipeline/comment";
// note: Type-only (erased at compile time, so it cannot run before the shim above).
import type {
  AttemptRef,
  CheckHandle,
  PreparedAttempt,
  ProcessDeps,
} from "../../src/pipeline/review-attempt-execution";

// note: Dynamic: the module graph under test must load after the workerd shim.
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
// note: Dynamic so the module graph loads AFTER the workerd shim above (same reason
// every product module in this file is loaded dynamically).
const { PublicationDeadlineSpent, postLineCommentsWithOctokit, postPreparedReviewWithOctokit, publicationSendGuard, PreparedSendRejected } = await import(
  "../../src/pipeline/comment"
);
const { RoundBudgetSpent, openGateSecrets, sealGateSecrets } = await import("../../src/pipeline/review-attempt");
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
  // note: The host channel: the adapter and the keys the host resolved for this
  // delivery. A phase never receives either across a boundary.
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

/** note: The attempt's data input — what a step host rebuilds from the queue message. */
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
    // note: The durable done-state: the delivery is a duplicate of this head.
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
    // note: A fresh head: prepare runs to the end of its phase.
    const step = await prepareAttempt(deps, makeRef(payload));
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);

    const handoff = step.prepared;
    expect(handoff.headSha).toBe(SHA);
    // note: The ONLY thing a restart may carry: this JSON document plus the attempt
    // id. A live handle, a token or a Set would fail this equality.
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

    // note: --- invocation 1: prepare -------------------------------------------
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));

    // note: --- invocation 2: a NEW host (fresh maps), same database + container --
    const { deps: resumed } = await makeDeps({ db });
    const reviewed = await reviewAttempt(resumed, ref, prepared);
    expect(reviewed.state).toBe("persisted");
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("persisted");

    // note: --- invocation 3: collect, reading the paid result from the row ------
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    // note: The publication id is the whole handoff, and it is on the journal.
    const staged = await readPublication(db as never, collected.collected.publicationId);
    expect(staged?.phase).toBe("prepared");
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);

    // note: --- invocation 4: publish, from the journal row alone ----------------
    const { deps: publishing } = await makeDeps({ db });
    const outcome = await publishAttempt(publishing, ref, collected.collected.publicationId);
    expect(outcome).toEqual({ kind: "ok" });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(1);

    // note: --- invocation 5: cleanup, whose proof comes from the launch row -----
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
    // note: A REAL Check row: the launch row's frozen identity is read from it, and a
    // resumed settlement may claim only that generation.
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
    // note: The §7.10 seam, with its own record of what was adopted and concluded.
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

    // note: The publishing host created no settlement: it must ADOPT the attempt's
    // Check from D1 rather than leave the run `in_progress` after a success.
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
    // note: The fixture's diff covers the finding's line, so the staged publication
    // carries exactly one frozen line intent (the batch under test).
    const staged = await readPublication(db as never, publicationId);
    expect(staged?.payload.lineIntents).toHaveLength(1);

    // note: A REAL decryptable PEM: the recovery lane in the hook must resolve this
    // App for itself (it is the production factory, not an injected reviewer).
    const pem = await testAppPem();
    db.raw
      .prepare(`UPDATE review_bots SET private_key_enc = ? WHERE id = ?`)
      .run(
        await createSecretbox(TEST_KEY).encryptSecret(pem, `github_apps.private_key_enc:${TEST_APP_ID}`),
        TEST_APP_ID,
      );
    // note: The recovery lane routes by the EXACT (bot, installation) pair.
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
            // note: The foreground's send window lapses HERE, inside the mutation —
            // then the recovery lane runs against the SAME applied batch.
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
                  // note: A second createReview: the forbidden duplicate batch.
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
            // note: GitHub's real response omits ids; the capture reads them back by
            // the trusted thread marker, so echo the created batch with ids.
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

    // note: One mutation for one eligible batch: the foreground sent it; recovery
    // found the durable intent and only read back (no second create).
    expect(batches).toHaveLength(1);
    expect(clock.recoveryCreate).toBe(0);
    expect(clock.recoveryReads).toBeGreaterThanOrEqual(1);
    const after = await readLineBatchState(db as never, publicationId);
    // One capture write persisted against the batch (the foreground's).
    expect(after).toEqual({ pending: false, dispatched: true, captures: 1 });
    const captured = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM review_threads WHERE publication_id = ? AND review_id IS NOT NULL`)
      .get(publicationId) as { n: number };
    expect(captured.n).toBe(1);

    // note: The intent is terminal for sending: even with the lease long lapsed, the
    // same batch can never be claimed again.
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

    // note: An earlier lane claimed it and then lapsed: the row is `sending`, the
    // state the discovery lane owns — not a phase this send may dispatch from.
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
    // note: A Check attempt with an attached run, released so the settlement adopts it.
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
    // note: The attempt's frozen Check identity (what the consumer's claim records in
    // production), so the publish phase can adopt THIS generation's row.
    const frozen = db.raw
      .prepare(`SELECT attempt_key, generation FROM review_checks WHERE id = ?`)
      .get(checkAttemptId) as { attempt_key: string; generation: number };
    expect(await freezeAttemptIdentity(db as never, ref.attemptId, { key: frozen.attempt_key, generation: frozen.generation })).toBe(true);

    // note: Another lane claimed the publication and lapsed: this send may not
    // dispatch from `sending`.
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
                // note: Delivery is the conclusion AND the frozen text (spec §7.9).
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

    // note: The refusal: the phase sends nothing, and the Check freezes the
    // unconfirmed failure LINKED to the publication it was about to send. The
    // remote update fails, so the row stays recoverable.
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

    // note: The publication is then confirmed through the normal proof path.
    const confirmedAt = Date.now();
    const proofLease = await claimPublication(db as never, publicationId, "proof-lane", confirmedAt, "sending");
    if (proofLease === null) throw new Error("fixture: the proof claim was refused");
    const staged = await readPublication(db as never, publicationId);
    if (staged === null) throw new Error("fixture: the staged publication is gone");
    // note: The confirmed publication carries a readable tally, so its confirmation
    // can actually revise the unconfirmed failure — the worker twin's shape.
    // Without a tally the proof-derived conclusion is the SAME failure and
    // there is nothing to revise.
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

    // note: The recovery conclusion reads THAT publication (the link), so the Check
    // now concludes from the proof — a proof-derived summary, not the
    // unconfirmed fallback.
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
    // note: The confirmation REVISED the record: the proof's readable tally turns the
    // unconfirmed failure into the gate's own verdict, not the failure fallback.
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
    // note: The claim was written AND the paid step was taken: no proof it returned.
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null);
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });

    expect(await cleanupAttempt(deps, ref)).toEqual({ retention: "unknown" });
    expect(h.sandbox.destroyCalls).toBe(0);
  });

  test("a concurrent launch wins the race: the CAS loses and the container survives", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null);
    // note: The attempt is still `provisioned` when this cleanup decides to destroy —
    // and a concurrent review takes the paid step in between.
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });

    let resolved = 0;
    const guarded = {
      ...deps,
      getSandbox: async (binding: unknown, id: string) => {
        resolved += 1;
        return h.overrides.getSandbox(binding, id);
      },
    };

    // note: The CAS on `provisioned` loses, so nothing is destroyed and no handle is
    // even resolved: the container may be paying.
    expect(await cleanupAttempt(guarded, ref)).toEqual({ retention: "unknown" });
    expect(resolved).toBe(0);
    expect(h.sandbox.destroyCalls).toBe(0);
    // note: Cleanup did not rewrite the row it lost: the launch stands.
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("launched");
  });

  test("a row another cleanup abandoned is unknown for the second cleanup", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null);
    // note: The first cleanup won the CAS and is still destroying the container.
    expect(await abandonReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toBe(true);

    // note: The second cleanup loses the CAS, and the row DECODES as `abandoned`: it
    // returns unknown and touches neither the container nor capacity — never
    // `no-paid-work`, which would release a container somebody else owns.
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("abandoned");
    expect(await cleanupAttempt(deps, ref)).toEqual({ retention: "unknown" });
    expect(h.sandbox.destroyCalls).toBe(0);
  });

  test("no launch row still CLAIMS: absent is no exception", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());

    // note: Absent is a state read like any other: the claim INSERTs the row already
    // `abandoned`, so a first-provisioning caller can no longer insert a paid
    // row after this cleanup decided there was none.
    expect(await cleanupAttempt(deps, ref)).toEqual({ retention: "no-paid-work" });
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("abandoned");
    // note: Nothing was ever activated, and activation precedes every container
    // handle — so there is no container to destroy and none is addressed.
    expect(h.sandbox.destroyCalls).toBe(0);
  });

  test("a persisted launch row authorises the teardown with the retained proof", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    // note: The durable facts a restart would find: prepared, launched, persisted.
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
  /** note: A real open Check row this attempt owns, and the handle that adopts it. */
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

  /** note: Prepare with a REAL Check row, so the launch row's identity is frozen. */
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
    // note: A rival froze its own head on this attempt's row before the checkout.
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), { key: "rival-head-key", generation: 1 });
    const { deps } = await makeDeps({ db });
    const { handle } = await seedOwnedCheck(db); // note: this attempt's live claim: a different head
    deps.checks = { begin: async () => handle, terminalize: async () => {} };

    // note: The phase wraps its cause; the moved head is that cause.
    await expect(prepareAttempt(deps, ref)).rejects.toMatchObject({ cause: expect.any(MovedHeadError) });

    // note: The rival's identity stands, and nothing was reviewed under ours.
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

    // note: The whole route runs: a moved head settles as skipped — no failure row,
    // no pre-publication settlement, no retry — and the observed head is
    // re-admitted so a successor attempt owns it.
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
    // note: Nothing was launched on our identity.
    expect(row.state).not.toBe("launched");
    // note: The successor carries the identity and ordering it actually has: the
    // marker for the skipped delivery, its own attach identity, and no
    // fabricated head_at (this delivery's stamp describes the SAME head, and
    // this payload has none).
    expect(successors).toHaveLength(1);
    expect(successors[0]!.head_sha).toBe(SHA);
    expect(successors[0]!.head_at).toBeUndefined();
    expect(successors[0]!.successor_of).toBeString();
    expect(successors[0]!.attachDeliveryId).toMatch(/^successor:/);
    // note: The durable outbox was written before the send and is marked delivered
    // once the queue accepted it.
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
    // note: The identity this attempt will freeze is ALREADY there, identical.
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
    // note: The admitted claim is refused (another holder owns the row), so no handle
    // exists — the identity is still the admitted claim's own row.
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

    // note: Publishing resumes with NO adoptable handle, and the obligation is still
    // recorded — from the durable publication and the FROZEN identity.
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

    // note: A key this attempt could never RE-DERIVE from its payload, frozen on both
    // rows: a recomputation would find no Check and write no mark.
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

    // note: The settlement adopts the attempt's own Check row, but its conclusion does
    // not land, so the row stays open and the obligation is the durable record.
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

    // note: The paid result is durable, but the attempt's instant has passed: the
    // plan's cap "prevents starting ... a first result publication at or after
    // expiry", and a delayed or resumed host must honour it.
    const { deps: publishing } = await makeDeps({ db });
    const late = { ...ref, deadlineMs: Date.now() - 1 };
    await expect(publishAttempt(publishing, late, collected.collected.publicationId)).rejects.toThrow(
      /no first publication/,
    );

    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    // note: Nothing was claimed, so no `sending` row pretends a send was attempted.
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

    // note: The phase cannot be authoritative alone: the marker scan inside the send
    // is an unbounded await, so the instant rides the send and the adapter
    // checks it on the last line before the first write.
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

    // note: The cleanup owns the exact target: the staging path must take the same
    // exclusion before it stages (and before its UPDATE).
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

    // note: The adapter's guard refused at the mutation — nothing left the Worker.
    h.commenterState.preparedDegradedError = new PublicationDeadlineSpent(
      "create comment: the attempt's frozen deadline passed 5ms ago — nothing was sent",
    );
    const { deps: collecting } = await makeDeps({ db });
    await expect(collectAttempt(collecting, ref, prepared)).rejects.toMatchObject({
      cause: expect.any(RoundBudgetSpent),
    });
    // note: A refusal is not an outcome: the collect did not settle as `degraded`.
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared-degraded")).toHaveLength(1);
  });

  test("the degraded notice takes the same refusal", async () => {
    const { deps, db } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    // note: Invalid output: this collect would stage and send a DEGRADED notice.
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
  /**
   * note: The attempt's D1 face with ONE statement class rejecting exactly once: the
   * fault then heals, so the assertions below read what the code concluded from
   * a failure it could not read through.
   */
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
    // note: A prior entry provisioned AND activated this attempt: a container may
    // exist, and the next entry's activation read is the only fact left.
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

    // note: The settlement this attempt owns: concluding it would claim an outcome
    // nobody observed.
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
    // note: The launch row keeps the provisioning fact: nothing stamped a failure.
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).not.toBe("failed");
  });
});

describe("the workflow host entry", () => {
  test("resolves the GitHub adapter without resolving the App's paid configuration", async () => {
    const { deps } = await makeDeps();
    deps.appCommenters.clear();
    deps.runnerConfigs.clear();
    const payload = makePayload();

    // note: A restart that only has `collect`/`publish` left must not need the paid
    // provider: a removed or rotated key would otherwise settle a durable,
    // already-paid result as a failure.
    expect(await hydrateAttemptHost(payload, deps)).toBe("ready");
    expect(deps.appCommenters.has(TEST_APP_ID)).toBe(true);
    expect(deps.runnerConfigs.size).toBe(0);

    // note: The step that SPENDS the key resolves it, once, and caches it.
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
    // note: A real Check row, so prepare freezes the pair on the launch row.
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

    // note: The pair a resumed host has to claim on is gone: passing `undefined` would
    // select the unrestricted fresh-claim path, which may MINT a generation.
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

/**
 * note: The attempt's publication settlement mark — the operator report's third
 * bucket end. It is written only when NO publication work remains: a proof that
 * never landed, or a lifecycle apply still owed to recovery, leaves the
 * attempt's publication interval open, and marking it would understate the
 * duration the cap is chosen from.
 */
describe("the publication settlement mark", () => {
  /**
   * note: The attempt up to its staged publication, with the handoff row whose mark
   * the report reads. Returns the publication id `publishAttempt` sends.
   */
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
    // note: The proof UPDATE fails; nothing else does. A plain D1 double with one
    // statement refused, named here so the access is checked at this seam.
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

    // note: The send happened, and its staged/sending row is the recovery evidence.
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(1);
    expect((await readPublication(db as never, publicationId))?.phase).toBe("sending");
    // note: The publication lane has NOT closed, so no end-to-end interval exists yet.
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
    // note: The settlement rides the apply transaction; its failure rolls the apply
    // back, so the journal stays recoverable instead of applied-and-unmeasured.
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

    // note: Confirmed and still due for recovery: never `applied` without its mark.
    expect((await readPublication(db as never, publicationId))?.phase).toBe("confirmed");
    expect((await readAttemptHandoff(db as never, deliveryKeyOf(payload)))?.settledMs).toBeNull();
  });

  test("a resumed publication whose Check is open and held elsewhere is not settled", async () => {
    const { db, ref, payload, publicationId } = await stagedPublication();
    // note: The attempt froze a Check pair; ANOTHER holder owns the open row, so the
    // resumed host's `settlementFor` finds nothing to adopt.
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

    // note: The rule discovers the frozen pair: the open row is an obligation, so the
    // publication is recorded but the attempt is not certified as settled.
    expect((await readPublication(db as never, publicationId))?.phase).toBe("applied");
    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
    expect(handoff?.settledMs).toBeNull();
    expect(handoff?.settledEffects).toContain("publication");
  });

  test("a journal that refuses to close leaves the attempt unmeasured", async () => {
    const { db, ref, payload, publicationId } = await stagedPublication();
    const publishing = await makeDeps({ db });
    publishing.deps.checks = { begin: async () => null, terminalize: async () => {} };
    // note: The send is definitively rejected, but the failed-phase mark cannot land:
    // the journal stays recoverable, so the publication lane is still open.
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
    // note: Invalid output: collect publishes a degraded notice instead of a review.
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

/** note: A real Check row this attempt owns; its id is the publication lease's key. */
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
  // note: An attached run and a released lease: a settlement that adops this row can
  // conclude it, and a refusal leaves it recoverable.
  expect(await setCheckCreateState(db as never, handle.attemptId, claimed.lease, "sending", undefined, Date.now())).toBe(true);
  expect(await attachCheckRunId(db as never, handle.attemptId, claimed.lease, 4242, Date.now())).toBe(true);
  expect(await releaseCheckClaim(db as never, handle.attemptId, claimed.lease, Date.now())).toBe(true);
  return { checkId: handle.attemptId, handle };
}

/** note: Prepare + review + collect against a Check row this attempt owns. */
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

    // note: Another lane owns the send's exact action: this one is refused at the
    // guard, before any request.
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

    // note: The publishing host adopts the Check through the REAL lifecycle, and sends
    // through the PRODUCTION composition (guard + verb) over a scripted
    // transport.
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

    // note: Nothing was sent, and the Check still names the publication that a later
    // confirmation must correct it from.
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

    // note: The send ACQUIRES the action, then its marker scan outlives the lease:
    // the last-line re-proof finds it gone. That is still no authority — never
    // proof the prepared target is wrong.
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
    // note: The row is handed back for recovery, never marked failed on a refusal
    // that proved nothing about the prepared target.
    const publication = db.raw
      .prepare(`SELECT phase, holder FROM review_publications WHERE id = ?`)
      .get(publicationId) as { phase: string; holder: string | null };
    expect(publication.phase).toBe("prepared");
    expect(publication.holder).toBeNull();
    // note: And the Check keeps the one publication a later confirmation corrects it from.
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

    // note: No adoptable handle on this host: the eligibility is not authority, so the
    // send must still present — and lose to — the Check row's action lease.
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

    // note: The batch's dispatch intent cannot be recorded (one lost reply; the row
    // itself is untouched). The review is already published and applied.
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

    // note: The applied review closed out: the Check concluded from its own proof.
    expect(concluded).toEqual([{ publicationId, outcome: "publication-unknown" }]);
    // note: The batch was never sent, and no unproven intent was cleared.
    expect(h.commenterCalls.filter((call) => call.op === "line-comments")).toHaveLength(0);
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(1);
    const row = db.raw
      .prepare("SELECT line_dispatch_ms FROM review_publications WHERE id = ?")
      .get(publicationId) as { line_dispatch_ms: number | null };
    expect(row.line_dispatch_ms).toBeNull();
  });
});

describe("the SEC-01 publish gate", () => {
  // A short (<8) value: its raw form is exact-leaf only, its encoded forms
  // are substring-matched.
  const KEY = "p/a b";
  const ECHOES = {
    base64: Buffer.from(KEY).toString("base64"),
    "url-encoded": encodeURIComponent(KEY),
  } as const;

  /** prepare + review with an echo in the first finding's body. */
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
      // The host that pays holds this key, so its write-time redaction knows it.
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
    // The settlement mark the gate writes lives on the attempt's handoff row.
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

      // Write-time redaction removed the encoded echo from the stored stdout.
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
      // The attempt is durably settled through the FAILURE path, not just
      // returned as settled: a failure row exists and the handoff says closed.
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
    expect(session[0]).toBe(token);

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
  ): Promise<{ db: TestD1; resumed: ProcessDeps; ref: AttemptRef; steps: Map<string, unknown> }> {
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
    expect(shortEncoded).toBe("eHk=");
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
    // 0x01 0x23 0x45 renders as "012345" — the SHA's own prefix.
    const key = String.fromCharCode(0x01, 0x23, 0x45);
    expect(Buffer.from(key, "utf8").toString("hex")).toBe(SHA.slice(0, 6));
    const { deps, db, ref, prepared } = await reviewedEcho("plain text", false);
    await sealStoredGateSecrets(db, [key]);

    const collected = await collectAttempt(deps, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    // Host template is model-free: the SHA never enters the scan.
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
    // The body only fits once the removed patch stops consuming the budget.
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

  /** The paid result rewritten to a schema-invalid body carrying `echo`. */
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
    // `{` encodes to a 2-char base64url; the gate must see the stdout on its
    // own, not concatenated with the parse error, or the exact match is lost.
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
    // The handoff is marked settling before the settlement, so the reconciler
    // still selects this unknown outcome.
    const pending = await listIncompleteSettlements(db as never, {
      settlingBeforeMs: Date.now() + 1,
      limit: 10,
    });
    expect(pending.some((row) => row.attemptId === ATTEMPT_ID)).toBe(true);
  });
});
