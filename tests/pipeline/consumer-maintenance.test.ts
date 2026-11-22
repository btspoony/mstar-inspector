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

function deferLog(lines: ConsumerLogFields[]): ConsumerLog {
  const record = (fields: ConsumerLogFields) => {
    if (fields.event === "maintenance_defer") lines.push(fields);
  };
  return { info: record, warn: record, error: record };
}

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

    expect(h.sandbox.calls).toHaveLength(0);
    expect(h.commenterCalls).toHaveLength(0);
    expect(h.kvPuts).toHaveLength(0);
    expect(h.messageAckCalls).toHaveLength(0);
    expect(h.messageRetryCalls).toEqual([{ attempts: 1, delaySeconds: 300 }]);
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

    expect(h.sandbox.calls.length).toBeGreaterThan(0);
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });
});
