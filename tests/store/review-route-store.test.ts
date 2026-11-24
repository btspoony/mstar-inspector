import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "./helpers";
import {
  deliveryKeyOf,
  readAttemptHandoff,
  recordReviewedHead,
  reserveAttemptHandoff,
} from "../../src/store/review-route-store";
import type { ReviewJobPayload } from "../../src/contracts/review-job";

/**
 * The reviewed head's row-state write. The value travels through `json_set`, so
 * its JSON TYPE is what a later reader sees: the handoff reader keeps it only
 * when it is a string. A bare binding is JSON-text-typed on some engines — a
 * digits-only SHA would land as a NUMBER and be dropped, and the quarantining
 * has to hold on every engine, so both shapes are pinned here.
 */
const BOT_ID = "bot-reviewed-head";

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
    targetId: `target-${BOT_ID}`,
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
