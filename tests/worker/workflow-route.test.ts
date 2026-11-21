/**
 * The review ROUTE: the queue handler admits, dedupes, settles skips and hands
 * one admitted delivery to exactly one Workflow instance. There is no second
 * execution route — the phases run only inside the Workflow composition, which
 * is what the end-to-end case below drives (with an in-place step, since the
 * tests own no durable step store).
 *
 * Cases:
 *   - one admitted delivery → exactly one instance, zero sandbox work, ack
 *   - a duplicate delivery (live admission row) → zero instances
 *   - a skipped delivery (paused App) → zero instances, explicit ack
 *   - an ambiguous create → ack with no retry (a redelivery could pay twice)
 *   - the workflow carries one review end to end: prepare → review → collect →
 *     publish with `retries: { limit: 0 }` on the paid step
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowStep } from "cloudflare:workers";

// Load shim FIRST: the workflow module statically imports ./sandbox → the
// workerd builtin `cloudflare:workers`. Every double is injected.
import "../helpers/cloudflare-workers-mock";

import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { createSeededTestD1, TEST_APP_ID, VALID_OUTPUT } from "../helpers/consumer-fixtures";
import { createConsumerHarness, failureRows, makePayload } from "../helpers/consumer-harness";
import { inlineWorkflowStep } from "../helpers/workflow-route";
import { acquireInflight } from "../../src/store/inflight-store";
import {
  deliveryKeyOf,
  listOwedSuccessors,
  readAttemptHandoff,
  recordSuccessorIntent,
  reserveAttemptHandoff,
  successorIntentOf,
  type AttemptHandoff,
} from "../../src/store/review-route-store";
import { reconcileReviewRoute } from "../../src/pipeline/route-reconcile";
import type { AttemptRef } from "../../src/pipeline/review-attempt-execution";
import type { WorkflowStepConfig } from "cloudflare:workers";
/** The KV the recovery pass writes failed-claim stamps to (a minimal double). */
const routeKv = { get: async () => null, put: async () => {}, delete: async () => {} };

// Dynamic: the module graph under test must load after the workerd shim.
const { WorkflowCreateAmbiguousError, createReviewConsumer, createWorkflowInstance } = await import(
  "../../src/pipeline/consumer"
);
const { runReviewAttemptWorkflow } = await import("../../src/workflow/review");

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

/** A starter that records its refs instead of running anything. */
function recordingStarter() {
  const started: AttemptRef[] = [];
  return {
    started,
    startAttempt: async (_deps: unknown, ref: AttemptRef) => {
      started.push(ref);
    },
  };
}

describe("review route — the queue handler hands off only", () => {
  test("one admitted delivery creates exactly one instance and does no review work", async () => {
    const db = await createSeededTestD1();
    const route = recordingStarter();
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      { ...h.overrides, startAttempt: route.startAttempt },
    );

    await consumer(h.makeBatch(makePayload()));

    // One instance, keyed by the attempt identity the consumer minted.
    expect(route.started).toHaveLength(1);
    expect(route.started[0]!.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    // No runner, credential mint or container on this side of the handoff.
    expect(h.sandbox.calls).toHaveLength(0);
    expect(h.sandbox.destroyCalls).toBe(0);
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(0);
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(h.messageAckCalls).toHaveLength(1);
  });

  test("a duplicate delivery (live admission row) creates no instance", async () => {
    const db = await createSeededTestD1();
    const seeded = await acquireInflight(
      db as never,
      {
        installation_id: 123,
        owner: "acme",
        repo: "widgets",
        pr_number: 42,
        workspace_id: "default",
      },
      {
        systemCap: 32,
        workspaceCap: 16,
        attemptId: "seed-attempt",
        ttlSeconds: 1320,
        headSha: makePayload().head_sha ?? null,
        now: new Date().toISOString(),
      },
    );
    expect(seeded).toEqual({ ok: true });
    const route = recordingStarter();
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      { ...h.overrides, startAttempt: route.startAttempt },
    );

    await consumer(h.makeBatch(makePayload()));

    // The live row refuses admission: the guard schedules its own retry and no
    // attempt — therefore no instance — is born.
    expect(route.started).toHaveLength(0);
    expect(h.messageRetryCalls).toHaveLength(1);
    expect(h.sandbox.calls).toHaveLength(0);
  });

  test("a skipped delivery still acks and creates no instance", async () => {
    const db = await createSeededTestD1();
    // The paused gate: the skip is settled, zero container, zero instance.
    db.raw.prepare("UPDATE review_bots SET review_enabled = 0 WHERE id = ?").run(TEST_APP_ID);
    const route = recordingStarter();
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      { ...h.overrides, startAttempt: route.startAttempt },
    );

    await consumer(h.makeBatch(makePayload()));

    expect(route.started).toHaveLength(0);
    expect(h.messageAckCalls).toHaveLength(1);
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(h.sandbox.calls).toHaveLength(0);
  });

  test("an ambiguous create acks and is never retried", async () => {
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      {
        ...h.overrides,
        // The platform reply is lost: the instance MAY exist.
        startAttempt: (_deps, ref) =>
          createWorkflowInstance(
            {
              create: async () => {
                throw new Error("Workflows API unavailable");
              },
            } as never,
            ref,
          ),
      },
    );

    await consumer(h.makeBatch(makePayload()));

    // Ack, never retry: a redelivery mints a fresh attempt id and could pay
    // twice, so the instance that may exist owns the attempt until TTL. The
    // handoff row stays `ambiguous` for the recovery pass.
    expect(h.messageAckCalls).toHaveLength(1);
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(h.sandbox.calls).toHaveLength(0);
    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(makePayload()));
    expect(handoff?.state).toBe("ambiguous");
  });
});

describe("review route — the workflow is the only paid route", () => {
  test("one admitted attempt runs prepare → review → collect → publish, with the paid step non-retryable", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const steps: Array<{ name: string; config: WorkflowStepConfig | undefined }> = [];
    const started: AttemptRef[] = [];
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      {
        ...h.overrides,
        startAttempt: async (deps, ref) => {
          started.push(ref);
          await runReviewAttemptWorkflow(deps, ref, recordingStep(steps), async () => {});
        },
      },
    );

    await consumer(h.makeBatch(makePayload() as ReviewJobPayload));

    expect(started).toHaveLength(1);
    // Every post-paid transition is its own durable step; cleanup is one, so an
    // interrupted host still destroys what the retention table allows.
    expect(steps.map((step) => step.name)).toEqual(["prepare", "review", "collect", "publish", "cleanup"]);
    // The platform cannot retry the paid step.
    expect(steps.find((step) => step.name === "review")!.config?.retries?.limit).toBe(0);
    // The paid route really ran: one publication, the launch row persisted,
    // and the attempt-scoped container was destroyed.
    expect(h.commenterCalls.filter((call) => call.op === "post-prepared")).toHaveLength(1);
    const launch = db.raw
      .prepare("SELECT state FROM review_launches WHERE attempt_id = ?")
      .get(started[0]!.attemptId) as { state: string };
    expect(launch.state).toBe("persisted");
    expect(h.sandbox.destroyCalls).toBe(1);
  });
});

describe("review route — every handoff is a durable record", () => {
  test("the handoff row is written before the instance is created", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const seen: { handoff: AttemptHandoff | null } = { handoff: null };
    let observedKey = "";
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      {
        ...h.overrides,
        // A create can only run AFTER the record exists: the callback reads it.
        startAttempt: async (_deps, ref) => {
          observedKey = deliveryKeyOf(payload);
          seen.handoff = await readAttemptHandoff(db as never, observedKey);
          return "created";
        },
      },
    );

    await consumer(h.makeBatch(payload));

    expect(seen.handoff?.state).toBe("owed");
    expect(seen.handoff?.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    // The confirmed outcome is recorded on the same row.
    expect((await readAttemptHandoff(db as never, observedKey))?.state).toBe("created");
  });

  test("a definite create failure is settled as a failure, and the redelivery replays the same attempt id", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const ids: string[] = [];
    let calls = 0;
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      {
        ...h.overrides,
        startAttempt: async (_deps, ref) => {
          ids.push(ref.attemptId);
          calls += 1;
          const workflow =
            calls === 1
              ? {
                  create: async () => {
                    // A definite configuration rejection: no instance exists.
                    throw Object.assign(new Error("invalid workflow configuration"), { status: 400 });
                  },
                }
              : { create: async () => ({}) };
          return createWorkflowInstance(workflow as never, ref);
        },
      },
    );

    await expect(consumer(h.makeBatch(payload))).rejects.toThrow(/could not be created/);

    // A definite failure is a FAILURE: the attempt was settled (failure row
    // written, claim released) and its handoff records the failure.
    expect(failureRows(db)).toHaveLength(1);
    const key = deliveryKeyOf(payload);
    expect((await readAttemptHandoff(db as never, key))?.state).toBe("failed");
    expect(ids).toHaveLength(1);

    // The redelivery replays the SAME attempt id — never a second attempt.
    await consumer(h.makeBatch(payload));

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect((await readAttemptHandoff(db as never, key))?.state).toBe("created");
  });

  test("a redelivery after a confirmed create acks without creating a second instance", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const ids: string[] = [];
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      {
        ...h.overrides,
        startAttempt: async (_deps, ref) => {
          ids.push(ref.attemptId);
          return "created";
        },
      },
    );

    await consumer(h.makeBatch(payload));
    await consumer(h.makeBatch(payload));

    expect(ids).toHaveLength(1);
    expect(h.messageAckCalls).toHaveLength(2);
  });

  test("a successor is an outbox row: one per observed head, delivered once, retried by the recovery pass", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const movedHeadSha = "feedfacefeedfacefeedfacefeedfacefeedface";
    const intent = successorIntentOf(payload, movedHeadSha)!;

    // Two records of the same intent collapse to one outbox row, and the
    // sender is handed the STORED payload, never a locally rebuilt variant.
    await recordSuccessorIntent(db as never, { dedupeKey: intent.dedupeKey, payload: intent.payload, nowMs: 1 });
    const stored = await recordSuccessorIntent(db as never, {
      dedupeKey: intent.dedupeKey,
      payload: { ...intent.payload, attachDeliveryId: "a different local build" },
      nowMs: 2,
    });
    expect(stored.payload.attachDeliveryId).toBe(intent.payload.attachDeliveryId);
    expect(await listOwedSuccessors(db as never, 10)).toHaveLength(1);

    const sent: ReviewJobPayload[] = [];
    const env = {
      DB: db as never,
      IDEMPOTENCY_KV: routeKv as never,
      REVIEW_QUEUE: {
        send: async (message: ReviewJobPayload) => {
          sent.push(message);
        },
      } as never,
    };
    await reconcileReviewRoute(env, 3);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.head_sha).toBe(movedHeadSha);
    // Delivered rows are not re-sent.
    expect(await listOwedSuccessors(db as never, 10)).toHaveLength(0);
    await reconcileReviewRoute(env, 4);
    expect(sent).toHaveLength(1);
  });

  test("the recovery pass re-enqueues an unconfirmed handoff for the same attempt", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const key = deliveryKeyOf(payload);
    // A host died after writing the handoff, before create created anything.
    await reserveAttemptHandoff(db as never, {
      deliveryKey: key,
      attemptId: "attempt-stranded",
      payload,
      nowMs: 1_000,
      deadlineMs: 1_200_000,
    });
    const sent: ReviewJobPayload[] = [];
    const env = {
      DB: db as never,
      IDEMPOTENCY_KV: routeKv as never,
      REVIEW_QUEUE: {
        send: async (message: ReviewJobPayload) => {
          sent.push(message);
        },
      } as never,
    };

    // Too fresh: a live delivery may still be trying.
    await reconcileReviewRoute(env, 2_000);
    expect(sent).toHaveLength(0);

    // Past the quiet period: the payload is re-enqueued (the queue handler
    // replays the recorded attempt id), and the row's clock is bumped.
    await reconcileReviewRoute(env, 1_000 + 5 * 60_000 + 1);
    expect(sent).toHaveLength(1);
    expect(deliveryKeyOf(sent[0]!)).toBe(key);
  });
});

/** The in-place step, recording each step's name and config. */
function recordingStep(steps: Array<{ name: string; config: WorkflowStepConfig | undefined }>): WorkflowStep {
  const base = inlineWorkflowStep();
  const doStep = base.do.bind(base) as (
    name: string,
    configOrCallback: unknown,
    maybeCallback?: unknown,
  ) => Promise<unknown>;
  return {
    ...base,
    do: async (name: string, configOrCallback: unknown, maybeCallback?: unknown) => {
      const config = typeof configOrCallback === "function" ? undefined : (configOrCallback as WorkflowStepConfig);
      steps.push({ name, config });
      return doStep(name, configOrCallback, maybeCallback);
    },
  } as unknown as WorkflowStep;
}

describe("review route — a confirmed stop releases what it held", () => {
  test("the runner's exhaustion signal is recorded on the launch row, and cleanup frees the container and capacity", async () => {
    // A supported terminal response: the runner returned exit 0 with the typed
    // signal. The paid phase OBSERVED the return, so the attempt owes both
    // terminal facts — a durable failure row and the row's own outcome.
    h.sandbox.runnerStdout = JSON.stringify({
      schema: "mstar.review-budget-exhausted/v1",
      seatsDispatched: 1,
      seatsStopped: 1,
    });
    const db = await createSeededTestD1();
    const started: AttemptRef[] = [];
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      {
        ...h.overrides,
        startAttempt: async (deps, ref) => {
          started.push(ref);
          await runReviewAttemptWorkflow(deps, ref, recordingStep([]), async () => {});
        },
      },
    );

    await consumer(h.makeBatch(makePayload()));

    const attemptId = started[0]!.attemptId;
    const launch = db.raw
      .prepare("SELECT state, result_outcome FROM review_launches WHERE attempt_id = ?")
      .get(attemptId) as { state: string; result_outcome: string | null };
    expect(launch).toEqual({ state: "failed", result_outcome: "failed" });
    // A confirmed stop is releasable: the container is destroyed and the
    // admission row is not held to TTL (which would block later reviews).
    expect(h.sandbox.destroyCalls).toBe(1);
    const held = db.raw.prepare("SELECT COUNT(*) AS n FROM review_inflight").get() as { n: number };
    expect(held.n).toBe(0);
  });
});

describe("review route — a conflict is resolved by the exact instance", () => {
  function ref(): AttemptRef {
    return { attemptId: "attempt-create-fence", payload: makePayload() } as unknown as AttemptRef;
  }

  test("a definite 4xx whose instance exists is a confirmation, not a failure", async () => {
    // The status alone is not proof the create did not land: the readback of
    // THIS attempt's instance decides, for every rejection class.
    const verdict = await createWorkflowInstance(
      {
        create: async () => {
          throw Object.assign(new Error("invalid params"), { status: 422 });
        },
        get: async () => ({ status: async () => ({ status: "running" }) }),
      } as never,
      ref(),
    );

    expect(verdict).toBe("exists");
  });

  test("a 409 with no instance for this id stays unknown — acked, never settled as failed", async () => {
    // No 4xx status may skip the exact-instance readback: a conflict is a
    // statement about existence, and the attempt id is the only fact that
    // answers it.
    await expect(
      createWorkflowInstance(
        {
          create: async () => {
            throw Object.assign(new Error("instance already exists"), { status: 409 });
          },
          get: async () => {
            throw new Error("no such instance");
          },
        } as never,
        ref(),
      ),
    ).rejects.toBeInstanceOf(WorkflowCreateAmbiguousError);
  });
});
