/**
 * Production queue wiring (spec §7.10): the Worker's `queue` handler must hand
 * the batch to the consumer AND forward the consumer's detached-terminalize
 * promise to `ctx.waitUntil`, so an overrun still finishes after the handler
 * returns instead of being reclaimed with the isolate.
 *
 * The consumer module is replaced with a fake whose runner hands exactly one
 * promise to the background sink. The wiring under test is the entry's; the
 * Check lifecycle is covered by tests/pipeline/checks.test.ts.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import "../helpers/cloudflare-workers-mock";
import type { ReviewJobPayload } from "../../src/contracts/review-job";

const consumerRuns: Array<{
  batch: unknown;
  sink: { waitUntil(promise: Promise<unknown>): void } | undefined;
  startAttempt: ((deps: unknown, ref: unknown) => Promise<void>) | undefined;
}> = [];

/** The promise the fake consumer hands to the invocation context. */
const handedByConsumer = Promise.withResolvers<void>();

mock.module("../../src/pipeline/consumer", () => ({
  createReviewConsumer: (
    _env: unknown,
    _log?: unknown,
    _overrides?: unknown,
    background?: { waitUntil(promise: Promise<unknown>): void },
    startAttempt?: (deps: unknown, ref: unknown) => Promise<void>,
  ) =>
    async (batch: unknown): Promise<{ errors: number }> => {
      consumerRuns.push({ batch, sink: background, startAttempt });
      background?.waitUntil(handedByConsumer.promise);
      return { errors: 0 };
    },
  // The entry's starter closes over the platform binding; this stands in for
  // the real classifier so the closure can be invoked without the module graph.
  createWorkflowInstance: async (
    workflow: { create(options: { id: string; params: unknown }): Promise<unknown> },
    ref: { attemptId: string },
  ) => {
    await workflow.create({ id: ref.attemptId, params: ref });
  },
  // The Workflow class in the entry's module graph links these at load time;
  // this suite never runs an instance, so the surface only has to exist.
  createProcessDeps: () => {
    throw new Error("queue-wiring: the workflow host is not exercised here");
  },
  hydrateAttemptHost: async () => "ready",
}));

// Dynamic on purpose: `mock.module` above must be registered BEFORE the entry's
// module graph resolves, and the entry pulls the workerd-only
// `cloudflare:workers` builtin that only the helper above can satisfy. A static
// import here would load the real consumer and defeat both.
const { default: worker } = await import("../../src/worker/entry");

afterAll(() => {
  mock.restore();
});

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
    // fake env carries one. The consumer itself is mocked below.
    const env = {
      REVIEW_WORKFLOW: { create: async () => ({}) },
    } as Parameters<NonNullable<typeof worker.queue>>[1];

    await worker.queue!(batch, env, ctx);

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
    const env = {
      REVIEW_WORKFLOW: {
        create: async (options: { id: string; params: unknown }) => {
          creates.push(options);
          return {};
        },
      },
    } as unknown as Parameters<NonNullable<typeof worker.queue>>[1];

    await worker.queue!(batch, env, ctx);
    const attempt = { attemptId: "attempt-route-1" };
    await consumerRuns.at(-1)!.startAttempt!({}, attempt);

    // One instance, keyed by the attempt identity — the platform's own id
    // uniqueness is a second fence under the consumer's D1 claim.
    expect(creates).toEqual([{ id: "attempt-route-1", params: attempt }]);
  });
});
