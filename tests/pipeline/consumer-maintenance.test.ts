/**
 * The queue face of the maintenance window (D20). A closed platform DEFERS the
 * batch — every delivery is retried while the queue still allows it; a delivery
 * with no redelivery left (a runtime without `retry`, or the last platform
 * attempt) is dropped through `review_failures` (stage `maintenance_deferred`)
 * so the failure sweep alerts, then acked. One `maintenance_defer` line per
 * invocation names the queue and the batch size.
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
import { QUEUE_MAX_ATTEMPTS } from "../../src/store/failure-store";
import {
  createConsumerHarness,
  failureRows,
  loadConsumer,
  makePayload,
} from "../helpers/consumer-harness";
import { createSeededTestD1 } from "../helpers/consumer-fixtures";

/** A log double that keeps only the `maintenance_defer` lines. */
function deferLog(lines: ConsumerLogFields[]): ConsumerLog {
  const record = (fields: ConsumerLogFields) => {
    if (fields.event === "maintenance_defer") lines.push(fields);
  };
  return { info: record, warn: record, error: record };
}

/**
 * A closed window over the seeded shape: the drop carrier binds the payload's
 * `target_id`, whose `review_targets` row (FK) is what the seeded App owns.
 */
async function closedWindowDB() {
  const db = await createSeededTestD1();
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

  test("a runtime without message.retry records the delivery loss and acks", async () => {
    const h = createConsumerHarness();
    const lines: ConsumerLogFields[] = [];
    const db = await closedWindowDB();
    const { createReviewConsumer } = await loadConsumer();
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), deferLog(lines), h.overrides);

    const payload = makePayload();
    const batch = h.makeBatch(payload);
    const acks: number[] = [];
    const deferred = {
      queue: batch.queue,
      messages: [{ ...batch.messages[0], retry: undefined, ack: () => acks.push(1) }],
    } as unknown as MessageBatch<ReviewJobPayload>;

    // No redelivery is available, so the delivery is dropped — but not silently:
    // one failure row carries the identity the sweep alerts on.
    await consumer(deferred);

    expect(h.sandbox.calls).toHaveLength(0);
    expect(acks).toHaveLength(1);
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stage: "maintenance_deferred",
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      installation_id: payload.installation_id,
      target_id: payload.targetId,
    });
    expect(String(rows[0]!.error)).toContain("maintenance_window");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "maintenance_defer", queue: "review-queue", batch_size: 1 });
  });

  test("a delivery on its last platform attempt is recorded and acked instead of retried", async () => {
    const h = createConsumerHarness();
    const lines: ConsumerLogFields[] = [];
    const db = await closedWindowDB();
    const { createReviewConsumer } = await loadConsumer();
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), deferLog(lines), h.overrides);

    // QUEUE_MAX_ATTEMPTS is the last delivery a retry() would still fit in.
    h.queueState.attempts = QUEUE_MAX_ATTEMPTS;
    const payload = makePayload();
    await consumer(h.makeBatch(payload));

    expect(h.messageRetryCalls).toHaveLength(0);
    expect(h.messageAckCalls).toHaveLength(1);
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "maintenance_deferred", pr_number: payload.pr_number });
    expect(String(rows[0]!.error)).toContain(`attempt ${QUEUE_MAX_ATTEMPTS}`);
  });

  test("a final maintenance delivery is not acked when its failure record rejects", async () => {
    const h = createConsumerHarness();
    const db = await closedWindowDB();
    const writeError = new Error("failure store unavailable");
    const broken = {
      ...db,
      prepare(query: string) {
        if (query.includes("INSERT INTO review_failures")) throw writeError;
        return db.prepare(query);
      },
    };
    const { createReviewConsumer } = await loadConsumer();
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: broken as never }),
      deferLog([]),
      h.overrides,
    );
    h.queueState.attempts = QUEUE_MAX_ATTEMPTS;

    const delivery = consumer(h.makeBatch(makePayload()));
    await expect(delivery).rejects.toBe(writeError);
    expect(h.messageAckCalls).toHaveLength(0);
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(failureRows(db)).toHaveLength(0);
    expect(h.sandbox.calls).toHaveLength(0);
  });

  test("an unreadable window defers too — an unknowable fence is not open", async () => {
    const h = createConsumerHarness();
    const lines: ConsumerLogFields[] = [];
    const db = await closedWindowDB();
    // Every maintenance read throws: the reader answers `unreadable`, and the
    // queue takes the same deferral as a stated window rather than running a
    // pipeline write on a ledger the backfill may be repointing.
    const broken = {
      ...db,
      prepare(query: string) {
        if (query.includes("review_runtime_settings WHERE key IN")) throw new Error("settings unavailable");
        return db.prepare(query);
      },
    };
    const { createReviewConsumer } = await loadConsumer();
    const consumer = createReviewConsumer(await h.makeEnv({ DB: broken as never }), deferLog(lines), h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.sandbox.calls).toHaveLength(0);
    expect(h.messageAckCalls).toHaveLength(0);
    expect(h.messageRetryCalls).toEqual([{ attempts: 1, delaySeconds: 300 }]);
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
