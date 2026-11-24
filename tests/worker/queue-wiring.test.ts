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

const handedByConsumer = Promise.withResolvers<void>();

type QueueEnv = Parameters<typeof runReviewQueueBatch>[1];

const deferRuns: Array<{ batch: unknown; deps: unknown; halt: unknown }> = [];

function envWithGate(
  extra: Record<string, unknown>,
  maintenanceRows: Array<{ key: string; value: string }> = [],
): QueueEnv {
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        // The route gate reads `value`; the platform switch (`server_flags`)
        // reads `enabled`. Both answer "open" so the wiring tests exercise the
        // review path, not either gate. The maintenance read asks for the
        // `key IN (…)` row SET (`all`), and answers empty = window open.
        first: async () => (sql.includes("server_flags") ? { enabled: 1 } : { value: "on" }),
        all: async () => ({
          results: sql.includes("review_runtime_settings WHERE key IN") ? maintenanceRows : [],
        }),
      }),
    }),
  };
  return { DB: db, ...extra } as unknown as QueueEnv;
}

function fakeConsumerModule() {
  return {
    createProcessDeps: (env: unknown) => ({ env }),
    deferMaintenanceBatch: async (batch: unknown, deps: unknown, halt?: unknown): Promise<void> => {
      deferRuns.push({ batch, deps, halt });
    },
    settleHaltedBatch: async (): Promise<void> => {},
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

    expect(creates).toEqual([{ id: "attempt-route-1", params: attempt }]);
  });

  test("a closed maintenance window defers the batch instead of running the review path", async () => {
    const batch = { queue: "review", messages: [] } as unknown as MessageBatch<ReviewJobPayload>;
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const env = envWithGate({ REVIEW_WORKFLOW: { create: async () => ({}) } }, [
      { key: "platform.maintenance.enabled", value: "1" },
    ]);
    const consumerCallsBefore = consumerRuns.length;
    const deferCallsBefore = deferRuns.length;

    await runReviewQueueBatch(batch, env, ctx, async () => fakeConsumerModule());

    expect(consumerRuns).toHaveLength(consumerCallsBefore);
    expect(deferRuns).toHaveLength(deferCallsBefore + 1);
    expect(deferRuns.at(-1)!.batch).toBe(batch);
    // The maintenance answer is no halt of its own — the defer gets no cause.
    expect(deferRuns.at(-1)!.halt).toBeUndefined();
  });
});
