import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "./helpers";
import {
  attemptFailureStoryExists,
  deliveryKeyOf,
  settlementRecordInsertStatement,
  LOST_REPLY_FALLBACK_ERROR,
  LOST_REPLY_FALLBACK_SHAPE,
  readAttemptHandoff,
  recordReviewedHead,
  reserveAttemptHandoff,
} from "../../src/store/review-route-store";
import { createFailureStore, type ReviewFailureInput } from "../../src/store/failure-store";
import type { ReviewJobPayload } from "../../src/contracts/review-job";

/**
 * The reviewed head's row-state write. The value travels through `json_set`, so
 * its JSON TYPE is what a later reader sees: the handoff reader keeps it only
 * when it is a string. A bare binding is JSON-text-typed on some engines — a
 * digits-only SHA would land as a NUMBER and be dropped, and the quarantining
 * has to hold on every engine, so both shapes are pinned here.
 */
const BOT_ID = "bot-reviewed-head";
const TARGET_ID = `target-${BOT_ID}`;

/** The bot + target the failure row's foreign keys need; one call per database. */
function seedTargetOnce(db: TestD1): void {
  seedBot(db, BOT_ID, 424242);
  seedTarget(db, BOT_ID, { id: TARGET_ID, name: "widgets" });
}

function payloadFor(): ReviewJobPayload {
  return {
    installation_id: 123,
    owner: "acme",
    repo: "widgets",
    pr_number: 7,
    head_sha: null,
    action: "created",
    triggered_by: "issue_comment",
    botRef: { appId: BOT_ID },
    targetId: TARGET_ID,
  };
}

async function seedHandoff(db: TestD1, attemptId: string): Promise<ReviewJobPayload> {
  const payload = payloadFor();
  await reserveAttemptHandoff(db, {
    deliveryKey: deliveryKeyOf(payload),
    attemptId,
    payload,
    nowMs: 1_000,
    createdMs: 1_000,
    enqueuedMs: 0,
    deadlineMs: 900_000,
  });
  return payload;
}

function storedJsonType(db: TestD1): string {
  const row = db.raw
    .prepare(`SELECT json_type(payload_json, '$.reviewedHeadSha') AS kind FROM review_attempt_handoffs`)
    .get() as { kind: string | null };
  return String(row.kind);
}

describe("recordReviewedHead row state", () => {
  const HEX_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const DIGITS_SHA = "1234567890123456789012345678901234567890";

  for (const [label, sha] of [
    ["a hex SHA", HEX_SHA],
    ["a digits-only SHA", DIGITS_SHA],
  ] as const) {
    test(`${label} round-trips as a JSON string and is read back unchanged`, async () => {
      const db = createMigratedTestD1();
      const payload = await seedHandoff(db, "attempt-reviewed-head");

      expect(await recordReviewedHead(db, { attemptId: "attempt-reviewed-head", headSha: sha, nowMs: 2_000 })).toBe(
        true,
      );

      // The stored leaf is a JSON string, never a number or an object: the
      // reader's `typeof === "string"` guard is what keeps it out of the row.
      expect(storedJsonType(db)).toBe("text");

      const first = await readAttemptHandoff(db, deliveryKeyOf(payload));
      expect(typeof first?.reviewedHeadSha).toBe("string");
      expect(first?.reviewedHeadSha).toBe(sha);

      // A re-read answers the same value, and the payload the recovery lane
      // re-enqueues never carries the row-state key.
      const again = await readAttemptHandoff(db, deliveryKeyOf(payload));
      expect(again?.reviewedHeadSha).toBe(sha);
      expect(again?.payload).not.toHaveProperty("reviewedHeadSha");
    });
  }
});

/**
 * The settlement record's own guard: one record per attempt, for any build's
 * row, decided in the insert rather than by a read before it.
 */
describe("the settlement record's insert", () => {
  const ATTEMPT = "attempt-settlement-record";

  function recordInput(): ReviewFailureInput {
    return {
      target_id: TARGET_ID,
      installation_id: 123,
      owner: "acme",
      repo: "widgets",
      pr_number: 7,
      head_sha: "a".repeat(40),
      stage: "pipeline",
      code: "review.internal.unclassified",
      trackId: ATTEMPT,
      message: "the review failed",
      error: "runner exited 1",
    };
  }

  test("a retry carrying the same attempt id cannot add a second record", async () => {
    const db = createMigratedTestD1();
    seedTargetOnce(db);
    const input = recordInput();

    const first = await settlementRecordInsertStatement(db as never, input, ATTEMPT).run();
    const retry = await settlementRecordInsertStatement(db as never, input, ATTEMPT).run();

    expect(first.meta.changes).toBe(1);
    // The record the first attempt wrote IS the guard: a Workflow retry replaying
    // the same attempt id finds it and writes nothing.
    expect(retry.meta.changes).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 1 });
  });

  test("a new attempt id legitimately gets its own record", async () => {
    const db = createMigratedTestD1();
    seedTargetOnce(db);
    const input = recordInput();

    await settlementRecordInsertStatement(db as never, input, ATTEMPT).run();
    const next = await settlementRecordInsertStatement(db as never, { ...input, trackId: "attempt-next" }, "attempt-next").run();

    // A retry under a NEW attempt id is a different attempt: no guard may fold
    // its record into the previous attempt's.
    expect(next.meta.changes).toBe(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 2 });
  });

  test("a diagnostic sub-stage row never stands in for the attempt's record", async () => {
    const db = createMigratedTestD1();
    seedTargetOnce(db);
    const input = recordInput();
    // Every sub-record of one attempt: two in the attempt's own id namespace
    // (`<attempt>:<stage>`) and one diagnostics row whose id is a random uuid and
    // whose only link to the attempt is `track_id`.
    const subRecords = [
      { id: `${ATTEMPT}:recheck`, stage: "recheck" },
      { id: `${ATTEMPT}:usage`, stage: "usage" },
      { id: "3f9c1a52-8b7e-4a51-9f0d-6d2b1c7e4a10", stage: "usage" },
    ];
    for (const sub of subRecords) {
      await createFailureStore(db as never).record({
        id: sub.id,
        target_id: TARGET_ID,
        installation_id: 123,
        owner: "acme",
        repo: "widgets",
        pr_number: 7,
        head_sha: "a".repeat(40),
        stage: sub.stage as never,
        code: "review.internal.unclassified" as never,
        trackId: ATTEMPT,
        message: "a sub-record",
        error: "a sub-record",
      });
    }

    // None of them is the settlement: the id namespace and the attribution stage
    // vocabulary are both required for a cross-build row to count.
    const written = await settlementRecordInsertStatement(db as never, input, ATTEMPT).run();
    expect(written.meta.changes).toBe(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 4 });
  });
});

describe("attemptFailureStoryExists", () => {
  const ATTEMPT = "attempt-story-guard";

  /** The row a recovery lane composes for this attempt: attempt-keyed (`id`). */
  async function recordRow(
    db: TestD1,
    input: { id: string; code: string; error: string; message: string },
  ): Promise<void> {
    await createFailureStore(db as never).record({
      id: input.id,
      target_id: TARGET_ID,
      installation_id: 123,
      owner: "acme",
      repo: "widgets",
      pr_number: 7,
      head_sha: "a".repeat(40),
      stage: "pipeline",
      code: input.code as never,
      trackId: ATTEMPT,
      message: input.message,
      error: input.error,
    });
  }

  test("no row at all lets the observation through", async () => {
    const db = createMigratedTestD1();
    await seedHandoff(db, ATTEMPT);
    expect(await attemptFailureStoryExists(db, ATTEMPT)).toBe(false);
  });

  test("the lost-reply lane's placeholder is not a story", async () => {
    // Written exactly the way `settleLostReplies` writes it: attempt-keyed, the
    // lane's code, its fallback sentence and the fallback summary.
    const db = createMigratedTestD1();
    seedTargetOnce(db);
    await seedHandoff(db, ATTEMPT);
    await recordRow(db, {
      id: ATTEMPT,
      code: LOST_REPLY_FALLBACK_SHAPE.fallbackCode,
      error: LOST_REPLY_FALLBACK_ERROR,
      message: LOST_REPLY_FALLBACK_SHAPE.fallbackMessage,
    });
    expect(await attemptFailureStoryExists(db, ATTEMPT)).toBe(false);
  });

  test("a lane-authored row refuses the observation", async () => {
    // The persisted-but-unpublished lane's own sentence: it saw the durable
    // result and the missing publication, so the phase must not replace it.
    const db = createMigratedTestD1();
    seedTargetOnce(db);
    await seedHandoff(db, ATTEMPT);
    await recordRow(db, {
      id: ATTEMPT,
      code: "review.internal.unclassified",
      error: "publication never started: the attempt persisted its paid result but nothing was staged",
      message: "the review's result never reached the PR",
    });
    expect(await attemptFailureStoryExists(db, ATTEMPT)).toBe(true);
  });

  test("a row keyed by anything but the attempt is not the attempt's story", async () => {
    // The per-stage recheck row shares the attempt's `track_id` but is not the
    // attempt's own settlement record, so it refuses nothing — and the lookup
    // stays a primary-key hit.
    const db = createMigratedTestD1();
    seedTargetOnce(db);
    await seedHandoff(db, ATTEMPT);
    await recordRow(db, {
      id: `${ATTEMPT}:recheck`,
      code: "review.recheck.unaccounted",
      error: "the refused round was never accounted",
      message: "the review was refused before it started",
    });
    expect(await attemptFailureStoryExists(db, ATTEMPT)).toBe(false);
  });
});
