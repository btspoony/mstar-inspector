import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "./helpers";
import {
  deliveryKeyOf,
  landFailureEffect,
  listUnpublishedLaunchSettlements,
  reserveAttemptHandoff,
} from "../../src/store/review-route-store";
import type { ReviewJobPayload } from "../../src/contracts/review-job";

const NOW = 1_000_000;
const BOT_ID = "bot-selector";
const TARGET_ID = `target-${BOT_ID}`;

function payloadFor(attemptId: string): ReviewJobPayload {
  return {
    installation_id: 123,
    owner: "acme",
    repo: "widgets",
    pr_number: 7,
    head_sha: attemptId.padEnd(40, "a"),
    action: "opened",
    triggered_by: "pull_request",
    botRef: { appId: BOT_ID },
    targetId: TARGET_ID,
  };
}

/**
 * The crash window's row: a persisted launch, no publication staged for the
 * attempt, and its hard stop already passed.
 */
async function seedWindow(db: TestD1, attemptId: string): Promise<ReviewJobPayload> {
  const payload = payloadFor(attemptId);
  await reserveAttemptHandoff(db, {
    deliveryKey: deliveryKeyOf(payload),
    attemptId,
    payload,
    nowMs: NOW - 900_000,
    enqueuedMs: 0,
    deadlineMs: NOW - 1,
  });
  db.raw.prepare("UPDATE review_attempt_handoffs SET state = 'created' WHERE attempt_id = ?").run(attemptId);
  db.raw
    .prepare(
      `INSERT INTO review_launches
         (attempt_id, state, claimed_at_ms, launched_at_ms, persisted_at_ms, result_json, result_outcome)
       VALUES (?, 'persisted', ?, ?, ?, '{}', 'persisted')`,
    )
    .run(attemptId, NOW - 900_000, NOW - 800_000, NOW - 700_000);
  return payload;
}

describe("the unpublished-launch selector's failure-row exclusion", () => {
  test("a landed failure-row leaves the lane; a row without it is still selected", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT_ID, 424242);
    seedTarget(db, BOT_ID, { id: TARGET_ID });
    const landedPayload = await seedWindow(db, "attempt-landed");
    await seedWindow(db, "attempt-owed");

    const recorded = await landFailureEffect(
      db,
      {
        attemptId: "attempt-landed",
        landed: [],
        failure: {
          target_id: TARGET_ID,
          installation_id: landedPayload.installation_id,
          owner: landedPayload.owner,
          repo: landedPayload.repo,
          pr_number: landedPayload.pr_number,
          head_sha: landedPayload.head_sha!,
          stage: "pipeline",
          error: "publication never started",
        },
      },
      NOW,
    );
    expect(recorded).toEqual({ landed: true, owned: true });

    // The record landed but the head-wide claim stamp stays owed — and no later
    // pass can ever write it — so the mark must stay open.
    const row = db.raw
      .prepare("SELECT settled_ms, settled_effects FROM review_attempt_handoffs WHERE attempt_id = ?")
      .get("attempt-landed") as { settled_ms: number | null; settled_effects: string | null };
    expect(JSON.parse(row.settled_effects!)).toEqual(["failure-row"]);
    expect(row.settled_ms).toBeNull();

    const selected = await listUnpublishedLaunchSettlements(db, { deadlineBeforeMs: NOW, limit: 25 });
    expect(selected.map((handoff) => handoff.attemptId)).toEqual(["attempt-owed"]);
  });
});
