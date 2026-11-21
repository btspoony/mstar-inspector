/**
 * The five attempt phases, each driven ALONE from a hand-built input — and one
 * case that simulates a RESTART: after `prepare`, only the returned data and the
 * attempt's sandbox id survive; `review`, `collect`, `publish` and `cleanup`
 * then run from the persisted records alone.
 *
 * The rule these cases enforce is the module's own: a phase may hold live
 * objects internally, but its input and output are DATA. `JSON.parse(JSON.
 * stringify(handoff))` is therefore a faithful restart input, and every phase
 * re-derives the container, the adapter and the token from `deps`.
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
import { inlineWorkflowStep } from "../helpers/workflow-route";
import { createArtifactStore } from "../../src/store/artifact-store";
import { createFailureStore } from "../../src/store/failure-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import {
  MovedHeadError,
  abandonReviewLaunch,
  claimReviewAttempt,
  claimReviewLaunch,
  readReviewLaunch,
} from "../../src/pipeline/review-attempt";
import { readPublication } from "../../src/store/finding-lifecycle";
import { claimAttempt } from "../../src/store/review-checks";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type { Lease } from "../../src/store/finding-lifecycle";
// Type-only (erased at compile time, so it cannot run before the shim above).
import type {
  AttemptRef,
  CheckHandle,
  PreparedAttempt,
  ProcessDeps,
} from "../../src/pipeline/review-attempt-execution";

// Dynamic: the module graph under test must load after the workerd shim.
const {
  cleanupAttempt,
  collectAttempt,
  createCheckSettlement,
  prepareAttempt,
  publishAttempt,
  reviewAttempt,
} = await import("../../src/pipeline/review-attempt-execution");
const { runReviewAttemptWorkflow } = await import("../../src/workflow/review");

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
 * The seeded D1 + this case's doubles, assembled by hand. `share` carries the
 * pieces a RESTART keeps: the same database and the same container, but fresh
 * maps — the host resolves the App again, and nothing in-memory survives.
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
    roundBudgetMs: 900_000,
    runnerConfigs: new Map(),
    checkSettlements: new Map(),
    credentials: new Map(),
  };
  // The host channel: the adapter and the keys the host resolved for this
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

/** The attempt's data input — what a step host rebuilds from the queue message. */
function makeRef(payload: ReviewJobPayload): AttemptRef {
  return {
    attemptId: ATTEMPT_ID,
    payload,
    level: "default",
    roundStartedAt: Date.now(),
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

    const step = await prepareAttempt(deps, makeRef(payload));

    expect(step).toEqual({ kind: "settled", outcome: { kind: "ok" } });
    expect(h.sandbox.calls.filter((call) => h.sandbox.gitOps.get(call.cmd) === "clone")).toHaveLength(1);
  });

  test("the handoff is data: no sandbox, no token, no Set survives a JSON round-trip", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.resolvedSha = SHA;
    // A fresh head: prepare runs to the end of its phase.
    const step = await prepareAttempt(deps, makeRef(payload));
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);

    const handoff = step.prepared;
    expect(handoff.headSha).toBe(SHA);
    // The ONLY thing a restart may carry: this JSON document plus the attempt
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

    // --- invocation 1: prepare -------------------------------------------
    const step = await prepareAttempt(deps, ref);
    if (step.kind !== "prepared") throw new Error(`prepare did not hand off: ${step.kind}`);
    const prepared: PreparedAttempt = JSON.parse(JSON.stringify(step.prepared));

    // --- invocation 2: a NEW host (fresh maps), same database + container --
    const { deps: resumed } = await makeDeps({ db });
    const reviewed = await reviewAttempt(resumed, ref, prepared);
    expect(reviewed.state).toBe("persisted");
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("persisted");

    // --- invocation 3: collect, reading the paid result from the row ------
    const { deps: collecting } = await makeDeps({ db });
    const collected = await collectAttempt(collecting, ref, prepared);
    if (collected.kind !== "collected") throw new Error(`collect did not hand off: ${collected.kind}`);
    // The publication id is the whole handoff, and it is on the journal.
    const staged = await readPublication(db as never, collected.collected.publicationId);
    expect(staged?.phase).toBe("prepared");
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);

    // --- invocation 4: publish, from the journal row alone ----------------
    const { deps: publishing } = await makeDeps({ db });
    const outcome = await publishAttempt(publishing, ref, collected.collected.publicationId);
    expect(outcome).toEqual({ kind: "ok" });
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(1);

    // --- invocation 5: cleanup, whose proof comes from the launch row -----
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
    // The §7.10 seam, with its own record of what was adopted and concluded.
    const checks = {
      begun: 0,
      terminalized: [] as Array<{ publicationId: string | null; outcome: string }>,
      begin: async () => {
        checks.begun += 1;
        return HANDLE;
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

    // The publishing host created no settlement: it must ADOPT the attempt's
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

describe("cleanupAttempt", () => {
  test("a launched row with no persisted result destroys nothing and releases nothing", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    // The claim was written AND the paid step was taken: no proof it returned.
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null);
    expect(await claimReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toEqual({ ok: true });

    expect(await cleanupAttempt(deps, ref)).toEqual({ retention: "unknown" });
    expect(h.sandbox.destroyCalls).toBe(0);
  });

  test("a concurrent launch wins the race: the CAS loses and the container survives", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null);
    // The attempt is still `provisioned` when this cleanup decides to destroy —
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

    // The CAS on `provisioned` loses, so nothing is destroyed and no handle is
    // even resolved: the container may be paying.
    expect(await cleanupAttempt(guarded, ref)).toEqual({ retention: "unknown" });
    expect(resolved).toBe(0);
    expect(h.sandbox.destroyCalls).toBe(0);
    // Cleanup did not rewrite the row it lost: the launch stands.
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("launched");
  });

  test("a row another cleanup abandoned is unknown for the second cleanup", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), null);
    // The first cleanup won the CAS and is still destroying the container.
    expect(await abandonReviewLaunch(db as never, ATTEMPT_ID, Date.now())).toBe(true);

    // The second cleanup loses the CAS, and the row DECODES as `abandoned`: it
    // returns unknown and touches neither the container nor capacity — never
    // `no-paid-work`, which would release a container somebody else owns.
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("abandoned");
    expect(await cleanupAttempt(deps, ref)).toEqual({ retention: "unknown" });
    expect(h.sandbox.destroyCalls).toBe(0);
  });

  test("no launch row still CLAIMS: absent is no exception", async () => {
    const { deps, db } = await makeDeps();
    const ref = makeRef(makePayload());

    // Absent is a state read like any other: the claim INSERTs the row already
    // `abandoned`, so a first-provisioning caller can no longer insert a paid
    // row after this cleanup decided there was none.
    expect(await cleanupAttempt(deps, ref)).toEqual({ retention: "no-paid-work" });
    expect((await readReviewLaunch(db as never, ATTEMPT_ID))?.state).toBe("abandoned");
    expect(h.sandbox.destroyCalls).toBe(1);
  });

  test("a persisted launch row authorises the teardown with the retained proof", async () => {
    const { deps } = await makeDeps();
    const payload = makePayload();
    registerGitOpsCommands(h.sandbox, payload);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const ref = makeRef(payload);
    // The durable facts a restart would find: prepared, launched, persisted.
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
  /** A real open Check row this attempt owns, and the handle that adopts it. */
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

  /** Prepare with a REAL Check row, so the launch row's identity is frozen. */
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
    // A rival froze its own head on this attempt's row before the checkout.
    await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), { key: "rival-head-key", generation: 1 });
    const { deps } = await makeDeps({ db });
    const { handle } = await seedOwnedCheck(db); // this attempt's live claim: a different head
    deps.checks = { begin: async () => handle, terminalize: async () => {} };

    // The phase wraps its cause; the moved head is that cause.
    await expect(prepareAttempt(deps, ref)).rejects.toMatchObject({ cause: expect.any(MovedHeadError) });

    // The rival's identity stands, and nothing was reviewed under ours.
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

    // The whole route runs: a moved head settles as skipped — no failure row,
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
    // Nothing was launched on our identity.
    expect(row.state).not.toBe("launched");
    // The successor carries the identity and ordering it actually has: the
    // marker for the skipped delivery, its own attach identity, and no
    // fabricated head_at (this delivery's stamp describes the SAME head, and
    // this payload has none).
    expect(successors).toHaveLength(1);
    expect(successors[0]!.head_sha).toBe(SHA);
    expect(successors[0]!.head_at).toBeUndefined();
    expect(successors[0]!.successor_of).toBeString();
    expect(successors[0]!.attachDeliveryId).toMatch(/^successor:/);
    // The durable outbox was written before the send and is marked delivered
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
    // The identity this attempt will freeze is ALREADY there, identical.
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
    // The admitted claim is refused (another holder owns the row), so no handle
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

    // Publishing resumes with NO adoptable handle, and the obligation is still
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

    // A key this attempt could never RE-DERIVE from its payload, frozen on both
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

    // The settlement adopts the attempt's own Check row, but its conclusion does
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
