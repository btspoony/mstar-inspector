/**
 * note: Route recovery claims 3 and 4 — the moved head's successor.
 *
 * 3. The successor outbox row exists BEFORE the moved-head settlement that
 *    terminalizes the old Check, so an interruption leaves an owed row rather
 *    than nothing.
 * 4. The successor dedupe key fences sends and identifies its owner: the stored
 *    winning payload is what gets sent, the key includes the App/target and the
 *    originating delivery, and a replay of one intent cannot produce two
 *    admissions.
 *
 * The cases read the outbox AT the instant the old Check is terminalized (the
 * ordering the claim names), and drive admission with the exact payload the
 * outbox would send.
 */
import { beforeEach, describe, expect, test } from "bun:test";

// note: Load shim FIRST: a static import of the execution module would be hoisted
// above it (it imports ./sandbox → `cloudflare:workers`, unresolvable in Bun's
// runner). The module graph under test is loaded dynamically on purpose.
import "../helpers/cloudflare-workers-mock";

import {
  SHA,
  TEST_APP_ID,
  TEST_PR_NUMBER,
  TEST_OWNER,
  TEST_REPO,
  createSeededTestD1,
  registerGitOpsCommands,
} from "../helpers/consumer-fixtures";
import { createConsumerHarness, makePayload } from "../helpers/consumer-harness";
import { inlineWorkflowStep } from "../helpers/workflow-route";
import { createArtifactStore } from "../../src/store/artifact-store";
import { createFailureStore } from "../../src/store/failure-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import { claimAttempt } from "../../src/store/review-checks";
import { claimReviewAttempt } from "../../src/pipeline/review-attempt";
import {
  deliveryKeyOf,
  listOwedSuccessors,
  recordSuccessorIntent,
  successorIntentOf,
} from "../../src/store/review-route-store";
import { reconcileReviewRoute } from "../../src/pipeline/route-reconcile";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type { Lease } from "../../src/store/finding-lifecycle";
import type { AttemptRef, CheckHandle, ProcessDeps } from "../../src/pipeline/review-attempt-execution";
import type { TestD1 } from "../store/helpers";
/** note: The KV the recovery pass writes failed-claim stamps to (a minimal double). */
const routeKv = { get: async () => null, put: async () => {}, delete: async () => {} };

const { runReviewAttemptWorkflow } = await import("../../src/workflow/review");
const { createReviewConsumer } = await import("../../src/pipeline/consumer");

const ATTEMPT_ID = "attempt-4d-successor";
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

async function makeDeps(db: TestD1): Promise<ProcessDeps> {
  return {
    env: await h.makeEnv({ DB: db as never }),
    store: createArtifactStore(db as never),
    targets: createTargetsStore(db as never),
    failureStore: createFailureStore(db as never),
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

/** note: A real open Check row this attempt owns, plus the handle that adopts it. */
async function seedOwnedCheck(db: TestD1): Promise<{ handle: CheckHandle }> {
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
    .prepare("SELECT id FROM review_checks WHERE id = ?")
    .get(claimed.attempt.identity.attemptId) as { id: string };
  return { handle: { ...HANDLE, attemptId: row.id } };
}

/**
 * note: Drive the whole route to a moved head. The rival's identity is frozen on this
 * attempt's row, so the checkout's head is a foreign one and the attempt settles
 * as skipped. `dieOn` makes the step host die at that step (a killed isolate:
 * nothing after it runs), which is how an interruption is simulated here.
 */
async function runMovedHead(
  db: TestD1,
  options: { dieOn?: string; onTerminalize?: () => void } = {},
): Promise<{ successors: ReviewJobPayload[] }> {
  const payload = makePayload();
  registerGitOpsCommands(h.sandbox, payload);
  h.sandbox.resolvedSha = SHA;
  await claimReviewAttempt(db as never, ATTEMPT_ID, Date.now(), { key: "rival-head-key", generation: 1 });
  const { handle } = await seedOwnedCheck(db);
  const deps = await makeDeps(db);
  deps.checks = {
    begin: async () => handle,
    terminalize: async () => {
      options.onTerminalize?.();
    },
  };
  const successors: ReviewJobPayload[] = [];
  const inline = inlineWorkflowStep();
  const inlineDo = inline.do.bind(inline) as (...args: unknown[]) => Promise<unknown>;
  const step = {
    ...inline,
    do: async (...args: unknown[]) => {
      if (options.dieOn === String(args[0])) throw new Error(`the host died during ${String(args[0])}`);
      return inlineDo(...args);
    },
  } as unknown as typeof inline;
  await runReviewAttemptWorkflow(deps, makeRef(payload), step, async (successor) => {
    successors.push(successor);
  });
  return { successors };
}

function outboxRows(db: TestD1): Array<{ state: string; payload_json: string }> {
  return db.raw.query("SELECT state, payload_json FROM review_successors ORDER BY created_ms").all() as Array<{
    state: string;
    payload_json: string;
  }>;
}

describe("claim 3 — the outbox row precedes the moved-head settlement", () => {
  test("the successor intent exists at the instant the old Check is terminalized", async () => {
    const db = await createSeededTestD1();
    let rowsAtTerminalize: number | undefined;
    const { successors } = await runMovedHead(db, {
      onTerminalize: () => {
        // note: The Check conclusion is the settlement's terminal effect: a successor
        // recorded after it would be lost by an interruption between the two.
        rowsAtTerminalize = outboxRows(db).length;
      },
    });

    expect(rowsAtTerminalize).toBe(1);
    expect(successors).toHaveLength(1);
    expect(successors[0]!.head_sha).toBe(SHA);
    expect(outboxRows(db)).toHaveLength(1);
    expect(outboxRows(db)[0]!.state).toBe("delivered");
  });

  test("a host killed before the successor step leaves an owed row the recovery pass delivers", async () => {
    const db = await createSeededTestD1();
    // note: The host dies right after the old Check was terminalized: the moved-head
    // signal and the outbox row exist, but the send never ran.
    const run = runMovedHead(db, { dieOn: "settle-failure" });
    await expect(run).rejects.toThrow(/died during settle-failure/);

    // note: The row was written BEFORE the settlement, so the head is owed rather
    // than lost — and nothing was sent.
    const owed = outboxRows(db);
    expect(owed).toHaveLength(1);
    expect(owed[0]!.state).toBe("owed");
    expect(h.successorEnqueues).toHaveLength(0);

    const sent: ReviewJobPayload[] = [];
    await reconcileReviewRoute(
      {
        DB: db as never,
        IDEMPOTENCY_KV: routeKv as never,
        REVIEW_QUEUE: { send: async (message: ReviewJobPayload) => void sent.push(message) } as never,
      },
      Date.now(),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.head_sha).toBe(SHA);
    expect(outboxRows(db)[0]!.state).toBe("delivered");
  });
});

describe("claim 4 — the dedupe key fences sends and names its owner", () => {
  test("the workflow sends the STORED winner, never its own rebuilt payload", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    // note: Another execution of the same intent already recorded a winner — with a
    // payload this delivery would never build (a different attach identity and
    // an ordering stamp the moved head does not have).
    const intent = successorIntentOf(payload, SHA)!;
    const storedWinner: ReviewJobPayload = {
      ...intent.payload,
      attachDeliveryId: "stored-winner",
      head_at: "2000-01-01T00:00:00.000Z",
    };
    await recordSuccessorIntent(db as never, {
      dedupeKey: intent.dedupeKey,
      payload: storedWinner,
      nowMs: 1,
    });

    // note: The whole route runs to the moved head, so the real `recordSuccessor`
    // builds its own payload, hits the conflict and must enqueue the stored one.
    const { successors } = await runMovedHead(db);

    expect(successors).toHaveLength(1);
    expect(successors[0]!.attachDeliveryId).toBe("stored-winner");
    expect(successors[0]!.head_at).toBe("2000-01-01T00:00:00.000Z");
    expect(outboxRows(db)).toHaveLength(1);
    expect(outboxRows(db)[0]!.state).toBe("delivered");
  });

  test("a replay of one intent admits once; independent origins on the head are serialized, not collided", async () => {
    const db = await createSeededTestD1();
    const base = makePayload();
    const head = "feedfacefeedfacefeedfacefeedfacefeedface";
    const intent = successorIntentOf(base, head)!;

    // note: The same intent recorded twice is one row and the stored payload wins.
    await recordSuccessorIntent(db as never, { dedupeKey: intent.dedupeKey, payload: intent.payload, nowMs: 1 });
    const stored = await recordSuccessorIntent(db as never, {
      dedupeKey: intent.dedupeKey,
      payload: { ...intent.payload, attachDeliveryId: "another local build" },
      nowMs: 2,
    });
    expect(stored.payload).toEqual(intent.payload);
    expect(await listOwedSuccessors(db as never, 10)).toHaveLength(1);

    // note: Admission of that payload twice creates exactly one attempt.
    const started: AttemptRef[] = [];
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      startAttempt: async (_deps, ref) => {
        started.push(ref);
      },
    });
    await consumer(h.makeBatch(stored.payload));
    await consumer(h.makeBatch(stored.payload));
    expect(started).toHaveLength(1);

    // note: A DIFFERENT origin observing the same head is a legitimate separate
    // trigger: it is not silently refused by the first origin's key (the guard
    // serializes it), so neither head is lost to a permanent collision.
    const otherOrigin = successorIntentOf({ ...base, comment_id: 4242 }, head)!;
    expect(otherOrigin.dedupeKey).not.toBe(intent.dedupeKey);
    await consumer(h.makeBatch(otherOrigin.payload));
    expect(started).toHaveLength(1);
    expect(h.messageRetryCalls).toHaveLength(1);
  });

  test("the key names the App/target and the originating delivery", () => {
    const base = makePayload();
    const head = "feedfacefeedfacefeedfacefeedfacefeedface";

    // note: One origin, one intent: a replay is the same row.
    expect(successorIntentOf(base, head)!.dedupeKey).toBe(successorIntentOf({ ...base }, head)!.dedupeKey);

    // note: Independent origins observing the same head are NOT one another's
    // collision: a later legitimate trigger keeps its own row.
    const otherOrigin = successorIntentOf({ ...base, comment_id: 4242 }, head)!;
    expect(otherOrigin.dedupeKey).not.toBe(successorIntentOf(base, head)!.dedupeKey);

    // note: Another App/target observing the same head keeps its own row too.
    const otherApp = successorIntentOf(
      { ...base, botRef: { appId: "another-app" }, targetId: "target-another-app" },
      head,
    )!;
    expect(otherApp.dedupeKey).not.toBe(successorIntentOf(base, head)!.dedupeKey);

    // note: And the intent carries only the ordering it actually has: no stamp for a
    // head this delivery never saw.
    expect(successorIntentOf(base, head)!.payload.head_at).toBeUndefined();
    expect(successorIntentOf(base, SHA)!.payload.head_at).toBe(base.head_at);
  });
});
