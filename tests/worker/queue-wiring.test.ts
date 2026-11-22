/**
 * Production queue wiring (spec §7.10): the Worker's `queue` handler must hand
 * the batch to the consumer AND forward the consumer's detached-terminalize
 * promise to `ctx.waitUntil`, so an overrun still finishes after the handler
 * returns instead of being reclaimed with the isolate.
 *
 * The consumer reaches the handler through `runReviewQueueBatch`'s loader
 * parameter, so this suite needs NO `mock.module`: Bun cannot undo a
 * process-wide module stub (measured — `mock.restore()` and re-mocking both
 * leave the stub in place), and a stubbed consumer would leak into every later
 * file that imports it.
 */
import { describe, expect, test } from "bun:test";
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import "../helpers/cloudflare-workers-mock";
import type { ReviewJobPayload } from "../../src/contracts/review-job";

const { runReviewQueueBatch } = await import("../../src/worker/index");

const consumerRuns: Array<{
  batch: unknown;
  sink: { waitUntil(promise: Promise<unknown>): void } | undefined;
  startAttempt: ((deps: unknown, ref: unknown) => Promise<void>) | undefined;
}> = [];

/** The promise the fake consumer hands to the invocation context. */
const handedByConsumer = Promise.withResolvers<void>();

type QueueEnv = Parameters<typeof runReviewQueueBatch>[1];

/**
 * The gate's D1 face. This suite exercises the queue WIRING, so the operating
 * switch reads `on`; the absent/unreadable refusals are covered by
 * `queue-route-gate.test.ts`.
 */
function envWithGate(extra: Record<string, unknown>): QueueEnv {
  const db = {
    prepare: () => ({
      bind: () => ({ first: async () => ({ value: "on" }) }),
    }),
  };
  return { DB: db, ...extra } as unknown as QueueEnv;
}

/** The fake consumer module: records the batch, the sink and the starter. */
function fakeConsumerModule() {
  return {
    createReviewConsumer: (
      _env: unknown,
      _log?: unknown,
      _overrides?: unknown,
      background?: { waitUntil(promise: Promise<unknown>): void },
      startAttempt?: (deps: unknown, ref: unknown) => Promise<void>,
    ) => {
      return async (batch: unknown): Promise<{ errors: number }> => {
        consumerRuns.push({ batch, sink: background, startAttempt });
        background?.waitUntil(handedByConsumer.promise);
        return { errors: 0 };
      };
    },
    // The entry's starter closes over the platform binding; this stands in for
    // the real classifier so the closure can be invoked without the module graph.
    createWorkflowInstance: async (
      workflow: { create(options: { id: string; params: unknown }): Promise<unknown> },
      ref: { attemptId: string },
    ) => {
      await workflow.create({ id: ref.attemptId, params: ref });
    },
  } as never;
}

describe("worker queue wiring (spec §7.10)", () => {
  test("the handler passes the batch to the consumer and forwards its terminalize promise to ctx.waitUntil", async () => {
    const batch = { queue: "review", messages: [] } as unknown as MessageBatch<ReviewJobPayload>;
    const waited: Array<Promise<unknown>> = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        waited.push(promise);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    // The queue handler owns the platform binding: it refuses to run without it
    // (a deploy that cannot create an instance must not admit reviews), so the
    // fake env carries one. The consumer arrives through the loader below.
    const env = envWithGate({ REVIEW_WORKFLOW: { create: async () => ({}) } });

    await runReviewQueueBatch(batch, env, ctx, async () => fakeConsumerModule());

    expect(consumerRuns).toHaveLength(1);
    expect(consumerRuns[0]!.batch).toBe(batch);
    expect(consumerRuns[0]!.sink).toBeDefined();
    expect(waited).toEqual([handedByConsumer.promise]);
  });

  test("the handler's starter creates one instance by the attempt id", async () => {
    const batch = { queue: "review", messages: [] } as unknown as MessageBatch<ReviewJobPayload>;
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const creates: Array<{ id: string; params: unknown }> = [];
    const env = envWithGate({
      REVIEW_WORKFLOW: {
        create: async (options: { id: string; params: unknown }) => {
          creates.push(options);
          return {};
        },
      },
    });

    await runReviewQueueBatch(batch, env, ctx, async () => fakeConsumerModule());
    const attempt = { attemptId: "attempt-route-1" };
    await consumerRuns.at(-1)!.startAttempt!({}, attempt);

    // One instance, keyed by the attempt identity — the platform's own id
    // uniqueness is a second fence under the consumer's D1 claim.
    expect(creates).toEqual([{ id: "attempt-route-1", params: attempt }]);
  });
});
