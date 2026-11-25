import { describe, expect, test } from "bun:test";
import type { Message, MessageBatch } from "@cloudflare/workers-types";
import "../helpers/cloudflare-workers-mock";
import type { ConsumerLog } from "../../src/pipeline/consumer";
import { loadConsumer } from "../helpers/consumer-harness";
import { createSeededTestD1, SHA, TEST_APP_ID } from "../helpers/consumer-fixtures";
import { failureRows, makePayload } from "../helpers/consumer-harness";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { createFailureStore } from "../../src/store/failure-store";
import type { TestD1 } from "../store/helpers";

// The consumer loads through the harness's cached dynamic import: the workerd
// shim above must be registered before the module (and its sandbox import).
const { settleHaltedBatch, HALT_SETTLE_CONCURRENCY } = await loadConsumer();

const silentLog: ConsumerLog = { info: () => {}, warn: () => {}, error: () => {} };

function makeEnv(db: TestD1) {
  return {
    DB: db as never,
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    } as never,
  } as never;
}

type Settled = { acks: string[]; retries: string[]; batch: MessageBatch<ReviewJobPayload> };

/**
 * A batch of `count` DISTINCT bot mentions. Each message records its own ack
 * so "settled exactly once" is checked per message, not per batch.
 */
function batchOf(count: number): Settled {
  const acks: string[] = [];
  const retries: string[] = [];
  const messages = Array.from({ length: count }, (_unused, index) => {
    const id = `m${index}`;
    const body = makePayload({
      head_sha: SHA,
      action: "created",
      triggered_by: "issue_comment",
      comment_id: 9700 + index,
      attachDeliveryId: `attach-${index}`,
    });
    return {
      id,
      timestamp: new Date(),
      attempts: 1,
      body,
      ack: () => acks.push(id),
      retry: () => retries.push(id),
    } as unknown as Message<ReviewJobPayload>;
  });
  return { acks, retries, batch: { queue: "review-queue", messages } as unknown as MessageBatch<ReviewJobPayload> };
}

/**
 * A Checks double that measures overlap WITHOUT a clock: every settlement
 * parks until `width` of them are in flight, so a serial loop never releases
 * (the test times out) and a pool releases deterministically at its own width.
 */
function barrierChecks(width: number) {
  let inFlight = 0;
  let peak = 0;
  const settled: string[] = [];
  const gate = Promise.withResolvers<void>();
  const checks = {
    settleSkipped: async (input: { attachDeliveryId?: string }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      settled.push(input.attachDeliveryId ?? "");
      if (inFlight === width) gate.resolve();
      await gate.promise;
      inFlight -= 1;
    },
  };
  return { checks, settled, peak: () => peak };
}

describe("a halted batch settles bounded-concurrent", () => {
  test("a batch larger than the bound settles every message exactly once, never exceeding the width", async () => {
    const db = await createSeededTestD1();
    const count = HALT_SETTLE_CONCURRENCY * 3;
    const { acks, retries, batch } = batchOf(count);
    const tracked = barrierChecks(HALT_SETTLE_CONCURRENCY);

    await settleHaltedBatch(batch, makeEnv(db), "paused-platform", silentLog, {
      checks: tracked.checks as never,
    });

    // Per-message ack, once each, and no retry: the pool never double-settles.
    expect(acks).toHaveLength(count);
    expect(new Set(acks).size).toBe(count);
    expect(retries).toHaveLength(0);
    expect(tracked.settled).toHaveLength(count);

    // One durable row per delivery, keyed by its own mention identity.
    const rows = failureRows(db);
    expect(rows).toHaveLength(count);
    expect(new Set(rows.map((row) => row.id)).size).toBe(count);
    const ids = rows.map((row) => row.id);
    for (let index = 0; index < count; index += 1) {
      expect(ids).toContain(`platform_paused:comment:target-${TEST_APP_ID}:${9700 + index}`);
    }

    // The width is real and exact: work overlapped at the bound, never past it.
    expect(tracked.peak()).toBe(HALT_SETTLE_CONCURRENCY);
  });

  test("a replay of the same batch writes no second failure row and acks each message once", async () => {
    const db = await createSeededTestD1();
    const count = HALT_SETTLE_CONCURRENCY + 2;
    const first = batchOf(count);
    const tracked = barrierChecks(HALT_SETTLE_CONCURRENCY);
    const env = makeEnv(db);

    await settleHaltedBatch(first.batch, env, "paused-platform", silentLog, { checks: tracked.checks as never });
    expect(failureRows(db)).toHaveLength(count);

    const replay = batchOf(count);
    await settleHaltedBatch(replay.batch, env, "paused-platform", silentLog, { checks: tracked.checks as never });

    expect(failureRows(db)).toHaveLength(count);
    expect(replay.acks).toHaveLength(count);
    expect(new Set(replay.acks).size).toBe(count);
  });

  test("two settlement failures are both logged with their causes while the messages stay unacked", async () => {
    const db = await createSeededTestD1();
    const count = HALT_SETTLE_CONCURRENCY;
    const { acks, retries, batch } = batchOf(count);
    // Two DISTINCT causes: the failure row write declines m1 and m5.
    const real = createFailureStore(db as never);
    const faultyStore = {
      ...real,
      record: async (input: { id: string }) => {
        if (input.id.endsWith(":9701")) throw new Error("d1 disk is full");
        if (input.id.endsWith(":9705")) throw new Error("d1 deadline exceeded");
        return real.record(input as never);
      },
    };
    const warnLines: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    const log: ConsumerLog = {
      info: () => {},
      warn: (fields, msg) => warnLines.push({ fields: fields as Record<string, unknown>, msg: msg ?? "" }),
      error: () => {},
    };

    await expect(
      settleHaltedBatch(batch, makeEnv(db), "paused-platform", log, { failureStore: faultyStore as never }),
    ).rejects.toThrow("d1 disk is full");

    // Both causes are in the log, each on a line naming its own delivery.
    const fails = warnLines.filter((line) => line.fields.event === "review_halt_settle_failed");
    expect(fails).toHaveLength(2);
    expect(fails.map((line) => line.msg).join("\n")).toContain("d1 disk is full");
    expect(fails.map((line) => line.msg).join("\n")).toContain("d1 deadline exceeded");
    expect(fails.every((line) => line.fields.pr_number === 42)).toBe(true);

    // The two failed messages stay unacked; the rest settled exactly once,
    // each with the row its own identity names.
    expect(acks).toHaveLength(count - 2);
    expect(acks).not.toContain("m1");
    expect(acks).not.toContain("m5");
    expect(retries).toHaveLength(0);
    const rows = failureRows(db);
    expect(rows).toHaveLength(count - 2);
    expect(rows.map((row) => row.id)).not.toContain(`platform_paused:comment:target-${TEST_APP_ID}:9701`);
    expect(rows.map((row) => row.id)).not.toContain(`platform_paused:comment:target-${TEST_APP_ID}:9705`);
  });
});
