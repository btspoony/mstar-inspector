/**
 * The queue face of the maintenance window (D20). A closed platform acks the
 * batch without processing a single delivery: a mid-upgrade pipeline write could
 * land on a ledger row the backfill just repointed. Each dropped delivery leaves
 * one `maintenance_skip` line naming its PR — the only record of that review.
 *
 * Lives in tests/pipeline because it loads the real consumer through the
 * harness; `tests/worker/queue-wiring.test.ts` replaces the module process-wide,
 * so a consumer load from that directory can resolve the fake instead.
 */
import { describe, expect, test } from "bun:test";
import { setMaintenanceMode } from "../../src/dashboard/runtime-config-store";
import type { ConsumerLog, ConsumerLogFields } from "../../src/pipeline/consumer";
import { createConsumerHarness, loadConsumer, makePayload } from "../helpers/consumer-harness";
import { createMigratedTestD1 } from "../store/helpers";

/** A log double that keeps only the `maintenance_skip` lines. */
function skipLog(lines: ConsumerLogFields[]): ConsumerLog {
  const record = (fields: ConsumerLogFields) => {
    if (fields.event === "maintenance_skip") lines.push(fields);
  };
  return { info: record, warn: record, error: record };
}

describe("the queue maintenance gate", () => {
  test("a closed window acks every delivery and processes none", async () => {
    const db = createMigratedTestD1();
    await setMaintenanceMode(
      db,
      { enabled: true, reason: "repository backfill", actor: "Support-Bot" },
      "2026-11-17T09:00:00.000Z",
    );
    const h = createConsumerHarness();
    const lines: ConsumerLogFields[] = [];
    const { createReviewConsumer } = await loadConsumer();
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), skipLog(lines), h.overrides);

    await consumer(h.makeBatch(makePayload()));

    // Zero processing: no sandbox, no commenter, no KV, no failure row.
    expect(h.sandbox.calls).toHaveLength(0);
    expect(h.commenterCalls).toHaveLength(0);
    expect(h.kvPuts).toHaveLength(0);
    expect(db.raw.prepare("SELECT * FROM review_failures").all()).toHaveLength(0);
    // Acked, not retried: the batch drains instead of replaying the backlog.
    expect(h.messageAckCalls).toHaveLength(1);
    expect(h.messageRetryCalls).toHaveLength(0);
    // One line, naming the queue and the PR it dropped.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "maintenance_skip", queue: "review-queue" });
    expect(lines[0]!.pr_number).toBe(makePayload().pr_number);
  });

  test("the absent-row default leaves the round to run", async () => {
    const h = createConsumerHarness();
    const lines: ConsumerLogFields[] = [];
    const { createReviewConsumer } = await loadConsumer();
    const consumer = createReviewConsumer(await h.makeEnv(), skipLog(lines), h.overrides);

    await consumer(h.makeBatch(makePayload()));

    // The seeded App resolves, so the round reaches the sandbox and the window
    // never writes a line.
    expect(h.sandbox.calls.length).toBeGreaterThan(0);
    expect(lines).toHaveLength(0);
  });
});
