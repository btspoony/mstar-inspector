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
}> = [];

/** The promise the fake consumer hands to the invocation context. */
const handedByConsumer = Promise.withResolvers<void>();

mock.module("../../src/pipeline/consumer", () => ({
  createReviewConsumer: (
    _env: unknown,
    _log?: unknown,
    _overrides?: unknown,
    background?: { waitUntil(promise: Promise<unknown>): void },
  ) =>
    async (batch: unknown): Promise<{ errors: number }> => {
      consumerRuns.push({ batch, sink: background });
      background?.waitUntil(handedByConsumer.promise);
      return { errors: 0 };
    },
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
    const env = {} as Parameters<NonNullable<typeof worker.queue>>[1];

    await worker.queue!(batch, env, ctx);

    expect(consumerRuns).toHaveLength(1);
    expect(consumerRuns[0]!.batch).toBe(batch);
    expect(consumerRuns[0]!.sink).toBeDefined();
    expect(waited).toEqual([handedByConsumer.promise]);
  });
});
