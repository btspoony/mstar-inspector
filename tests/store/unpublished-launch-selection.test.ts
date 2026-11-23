import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "./helpers";
import {
  deliveryKeyOf,
  landFailureEffect,
  listUnpublishedLaunchSettlements,
  markAttemptSettled,
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
    createdMs: NOW - 900_000,
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

function effectsOf(db: TestD1, attemptId: string): { settled_ms: number | null; settled_effects: string | null } {
  return db.raw
    .prepare("SELECT settled_ms, settled_effects FROM review_attempt_handoffs WHERE attempt_id = ?")
    .get(attemptId) as { settled_ms: number | null; settled_effects: string | null };
}

describe("the unpublished-launch selector's failure-row exclusion", () => {
  test("only a failure-row without a landed claim stamp leaves the lane", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT_ID, 424242);
    seedTarget(db, BOT_ID, { id: TARGET_ID });
    const landedPayload = await seedWindow(db, "attempt-landed");
    const livePayload = await seedWindow(db, "attempt-live");
    await seedWindow(db, "attempt-owed");

    // The interrupted owner pass: the record landed, the claim write never did.
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

    // The healthy owner pass: both effects landed, the Check is still open, so the
    // settlement must stay open — and the row must keep being selected.
    await markAttemptSettled(
      db,
      deliveryKeyOf(livePayload),
      ["failure-row", "claim-stamp"],
      ["failure-row", "claim-stamp", "check"],
      NOW,
    );

    // The record landed but the head-wide claim stamp stays owed — and no later
    // pass can ever write it — so the mark must stay open.
    expect(JSON.parse(effectsOf(db, "attempt-landed").settled_effects!)).toEqual(["failure-row"]);
    expect(effectsOf(db, "attempt-landed").settled_ms).toBeNull();
    expect(JSON.parse(effectsOf(db, "attempt-live").settled_effects!).sort()).toEqual(["claim-stamp", "failure-row"]);
    expect(effectsOf(db, "attempt-live").settled_ms).toBeNull();

    const selected = await listUnpublishedLaunchSettlements(db, { deadlineBeforeMs: NOW, limit: 25 });
    expect(selected.map((handoff) => handoff.attemptId)).toEqual(["attempt-live", "attempt-owed"]);
  });
});
