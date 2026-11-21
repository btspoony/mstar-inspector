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
import { createConsumerHarness, makePayload } from "../helpers/consumer-harness";
import { inlineWorkflowStep } from "../helpers/workflow-route";
import { acquireInflight } from "../../src/store/inflight-store";
import type { AttemptRef } from "../../src/pipeline/review-attempt-execution";
import type { WorkflowStepConfig } from "cloudflare:workers";

// Dynamic: the module graph under test must load after the workerd shim.
const { createReviewConsumer, createWorkflowInstance } = await import("../../src/pipeline/consumer");
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
    // twice, so the instance that may exist owns the attempt until TTL.
    expect(h.messageAckCalls).toHaveLength(1);
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(h.sandbox.calls).toHaveLength(0);
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
    expect(steps.map((step) => step.name)).toEqual(["prepare", "review", "collect", "publish"]);
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
