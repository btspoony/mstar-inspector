import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "./helpers";
import {
  deliveryKeyOf,
  landFailureEffect,
  listLostReplyLaunchSettlements,
  listUnpublishedLaunchSettlements,
  markAttemptSettled,
  reserveAttemptHandoff,
} from "../../src/store/review-route-store";
import { REVIEW_ATTEMPT_CAP_MAX_MS } from "../../src/dashboard/runtime-config-store";
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

describe("the lost-reply selector", () => {
  async function seedLaunched(
    db: TestD1,
    attemptId: string,
    options: { launchedAtMs: number; deadlineMs?: number | null; createdMs?: number },
  ): Promise<void> {
    const payload = payloadFor(attemptId);
    const createdMs = options.createdMs ?? NOW - 900_000;
    await reserveAttemptHandoff(db, {
      deliveryKey: deliveryKeyOf(payload),
      attemptId,
      payload,
      nowMs: createdMs,
      createdMs,
      enqueuedMs: 0,
      deadlineMs: options.deadlineMs ?? NOW,
    });
    if (options.deadlineMs === null) {
      db.raw.prepare("UPDATE review_attempt_handoffs SET deadline_ms = NULL WHERE attempt_id = ?").run(attemptId);
    }
    db.raw
      .prepare(
        `INSERT INTO review_launches (attempt_id, state, claimed_at_ms, launched_at_ms)
         VALUES (?, 'launched', ?, ?)`,
      )
      .run(attemptId, createdMs, options.launchedAtMs);
  }

  test("only a launched row past the bound with no failure record is selected", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT_ID, 424242);
    seedTarget(db, BOT_ID, { id: TARGET_ID });
    // A frozen deadline older than the bound is selected; one inside it is not.
    await seedLaunched(db, "attempt-old", { launchedAtMs: NOW - 900_000, deadlineMs: NOW - 1_200_000 });
    await seedLaunched(db, "attempt-new", { launchedAtMs: NOW - 1, deadlineMs: NOW - 300_000 });
    await seedLaunched(db, "attempt-recorded", { launchedAtMs: NOW - 900_000, deadlineMs: NOW - 1_200_000 });

    // A row another producer already recorded: the anti-join keeps it out.
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error, error_code, track_id, message, created_at)
         VALUES (?, ?, 123, 'acme', 'widgets', 7, ?, 'pipeline', 'recorded', 'review.paid.reply_lost', ?, 'recorded', datetime('now'))`,
      )
      .run("attempt-recorded", TARGET_ID, "a".repeat(40), "attempt-recorded");
    // A persisted row is not a lost reply: that lane owns it.
    db.raw
      .prepare(
        `INSERT INTO review_launches
           (attempt_id, state, claimed_at_ms, launched_at_ms, persisted_at_ms, result_json, result_outcome)
         VALUES ('attempt-persisted', 'persisted', ?, ?, ?, '{}', 'persisted')`,
      )
      .run(NOW - 900_000, NOW - 800_000, NOW - 700_000);

    const selected = await listLostReplyLaunchSettlements(db, {
      deadlineBeforeMs: NOW - 600_000,
      limit: 25,
    });
    expect(selected.map((handoff) => handoff.attemptId)).toEqual(["attempt-old"]);
    // The window edge itself: a frozen deadline exactly at the bound is selected.
    const atBound = await listLostReplyLaunchSettlements(db, {
      deadlineBeforeMs: NOW - 1_200_000,
      limit: 25,
    });
    expect(atBound.map((handoff) => handoff.attemptId)).toEqual(["attempt-old"]);
    // A row inside the window is not selected.
    const insideWindow = await listLostReplyLaunchSettlements(db, {
      deadlineBeforeMs: NOW - 1_300_000,
      limit: 25,
    });
    expect(insideWindow).toEqual([]);
  });

  test("a pre-column row with no frozen deadline settles only past the cap ceiling plus the window", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT_ID, 424242);
    seedTarget(db, BOT_ID, { id: TARGET_ID });
    const windowMs = 600_000;
    const ceilingBound = NOW - windowMs - REVIEW_ATTEMPT_CAP_MAX_MS;
    // Old enough: its hard stop (created + cap) is at worst `launched + the cap
    // ceiling`, so a launch past that plus the grace has no live child left.
    await seedLaunched(db, "legacy-stale", {
      launchedAtMs: ceilingBound - 1,
      deadlineMs: null,
      createdMs: ceilingBound - 1_001,
    });
    // Exactly at the bound is inside the bound (`<=`), like the anchored branch.
    await seedLaunched(db, "legacy-at-bound", {
      launchedAtMs: ceilingBound,
      deadlineMs: null,
      createdMs: ceilingBound - 1_000,
    });
    // Older than the window but younger than the ceiling: a paid child admitted
    // under a large cap could still be live, so this one is left alone.
    await seedLaunched(db, "legacy-inside-ceiling", {
      launchedAtMs: NOW - windowMs - 1,
      deadlineMs: null,
      createdMs: NOW - windowMs - 1_001,
    });

    const selected = await listLostReplyLaunchSettlements(db, {
      deadlineBeforeMs: NOW - windowMs,
      limit: 25,
    });
    // Both legacy rows carry a NULL deadline, so they order by delivery key.
    expect(selected.map((handoff) => handoff.attemptId)).toEqual(["legacy-at-bound", "legacy-stale"]);
    // The legacy rows carry no anchor: the pass must fall back to the ceiling.
    expect(selected.map((handoff) => handoff.deadlineMs)).toEqual([null, null]);
  });

  test("a row with neither a deadline nor a launch instant is skipped", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT_ID, 424242);
    seedTarget(db, BOT_ID, { id: TARGET_ID });
    await seedLaunched(db, "legacy-no-launch-instant", { launchedAtMs: NOW, deadlineMs: null });
    // The schema's own CHECK couples `launched` to its instant; this row is the
    // malformed shape the selector still has to refuse, so the constraint is
    // lifted just for the insert.
    db.raw.run("PRAGMA ignore_check_constraints = ON");
    db.raw.prepare("UPDATE review_launches SET launched_at_ms = NULL WHERE attempt_id = ?").run("legacy-no-launch-instant");
    db.raw.run("PRAGMA ignore_check_constraints = OFF");

    const selected = await listLostReplyLaunchSettlements(db, {
      deadlineBeforeMs: NOW + REVIEW_ATTEMPT_CAP_MAX_MS * 2,
      limit: 25,
    });
    expect(selected).toEqual([]);
  });
});

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
          code: "review.internal.unclassified",
      trackId: "t",
      message: "the review did not complete",
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
