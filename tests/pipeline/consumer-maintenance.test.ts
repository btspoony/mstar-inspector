/**
 * The queue face of the maintenance window (D20). A closed platform DEFERS the
 * batch — every delivery is retried (or the batch is failed when the runtime
 * offers no `retry`), never acked: the review is not dropped, it comes back
 * after the window. One `maintenance_defer` line per invocation names the queue
 * and the batch size.
 *
 * Lives in tests/pipeline because it loads the real consumer through the
 * harness; `tests/worker/queue-wiring.test.ts` replaces the module process-wide,
 * so a consumer load from that directory can resolve the fake instead.
 */
import { describe, expect, test } from "bun:test";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { setMaintenanceMode } from "../../src/dashboard/runtime-config-store";
import type { ConsumerLog, ConsumerLogFields } from "../../src/pipeline/consumer";
import { createConsumerHarness, loadConsumer, makePayload } from "../helpers/consumer-harness";
import { createMigratedTestD1 } from "../store/helpers";

/** A log double that keeps only the `maintenance_defer` lines. */
function deferLog(lines: ConsumerLogFields[]): ConsumerLog {
  const record = (fields: ConsumerLogFields) => {
    if (fields.event === "maintenance_defer") lines.push(fields);
  };
  return { info: record, warn: record, error: record };
}

async function closedWindowDB() {
  const db = createMigratedTestD1();
  await setMaintenanceMode(
    db,
    { enabled: true, reason: "repository backfill", actor: "Support-Bot" },
    "2026-11-17T09:00:00.000Z",
  );
  return db;
}

describe("the queue maintenance gate", () => {
  test("a closed window retries every delivery and processes none", async () => {
    const h = createConsumerHarness();
    const lines: ConsumerLogFields[] = [];
    const { createReviewConsumer } = await loadConsumer();
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: (await closedWindowDB()) as never }),
      deferLog(lines),
      h.overrides,
    );

    await consumer(h.makeBatch(makePayload()));

    // Zero processing: no sandbox, no commenter, no KV, no failure row.
    expect(h.sandbox.calls).toHaveLength(0);
    expect(h.commenterCalls).toHaveLength(0);
    expect(h.kvPuts).toHaveLength(0);
    // Deferred, not dropped: every message is retried 300s out, none acked.
    expect(h.messageAckCalls).toHaveLength(0);
    expect(h.messageRetryCalls).toEqual([{ attempts: 1, delaySeconds: 300 }]);
    // One line, naming the queue and the batch it deferred.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "maintenance_defer", queue: "review-queue", batch_size: 1 });
  });

  test("a runtime without message.retry fails the batch so the queue retries it", async () => {
    const h = createConsumerHarness();
    const lines: ConsumerLogFields[] = [];
    const acks: number[] = [];
    const { createReviewConsumer } = await loadConsumer();
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: (await closedWindowDB()) as never }),
      deferLog(lines),
      h.overrides,
    );

    const batch = h.makeBatch(makePayload());
    const deferred = {
      queue: batch.queue,
      messages: [{ ...batch.messages[0], retry: undefined, ack: () => acks.push(1) }],
    } as unknown as MessageBatch<ReviewJobPayload>;

    const error = await consumer(deferred).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("no message.retry");

    expect(h.sandbox.calls).toHaveLength(0);
    expect(acks).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "maintenance_defer", queue: "review-queue", batch_size: 1 });
  });

  test("the absent-row default leaves the round to run", async () => {
    const h = createConsumerHarness();
    const lines: ConsumerLogFields[] = [];
    const { createReviewConsumer } = await loadConsumer();
    const consumer = createReviewConsumer(await h.makeEnv(), deferLog(lines), h.overrides);

    await consumer(h.makeBatch(makePayload()));

    // The seeded App resolves, so the round reaches the sandbox and the window
    // never writes a line.
    expect(h.sandbox.calls.length).toBeGreaterThan(0);
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });
});
