import { describe, expect, test } from "bun:test";

import "../helpers/cloudflare-workers-mock";

import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import {
  SEATS_SMALL_DIFF_LINES_DEFAULT,
  SEATS_SMALL_DIFF_LINES_KEY,
  SEATS_SMALL_DIFF_SEATS_DEFAULT,
  SEATS_SMALL_DIFF_SEATS_KEY,
  getReviewSeatSettings,
  setReviewSeatSettings,
} from "../../src/dashboard/runtime-config-store";

// `await import` keeps module evaluation AFTER the cloudflare-workers mock
// registers — the same loading-boundary idiom as token-usage.test.ts.
const { selectAttemptSeats } = await import("../../src/pipeline/review-attempt-execution");

function setSetting(db: TestD1, key: string, value: string): void {
  db.raw
    .prepare(
      "INSERT INTO review_runtime_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'fixture')",
    )
    .run(key, value, new Date().toISOString());
}

describe("selectAttemptSeats", () => {
  test("a 57-line diff takes the stored small-diff seats, not the tier's", async () => {
    // Non-default stored value, so the assertion cannot pass on the default.
    const db = createMigratedTestD1();
    setSetting(db, SEATS_SMALL_DIFF_SEATS_KEY, "2");
    const selection = selectAttemptSeats("default", 57, await getReviewSeatSettings(db));
    expect(selection).toEqual({ seats: 2, reason: "small-diff" });
  });

  test("a 500-line diff takes the level's own seat count", async () => {
    const db = createMigratedTestD1();
    const selection = selectAttemptSeats("default", 500, await getReviewSeatSettings(db));
    expect(selection).toEqual({ seats: 2, reason: "level" });
  });

  test("absent rows answer the documented defaults (120 lines / 1 seat)", async () => {
    const db = createMigratedTestD1();
    expect(await getReviewSeatSettings(db)).toEqual({
      smallDiffMaxLines: SEATS_SMALL_DIFF_LINES_DEFAULT,
      smallDiffSeats: SEATS_SMALL_DIFF_SEATS_DEFAULT,
      degraded: false,
    });
    expect(SEATS_SMALL_DIFF_LINES_DEFAULT).toBe(120);
    expect(SEATS_SMALL_DIFF_SEATS_DEFAULT).toBe(1);
  });

  test("a small-diff seat count above the level's count is clamped", async () => {
    const db = createMigratedTestD1();
    // quick fans out to one seat; a stored 2 must never hand it a second seat.
    setSetting(db, SEATS_SMALL_DIFF_SEATS_KEY, "2");
    const selection = selectAttemptSeats("quick", 57, await getReviewSeatSettings(db));
    expect(selection).toEqual({ seats: 1, reason: "small-diff" });
  });

  test("a configured threshold applies the small-diff count at its bound only", async () => {
    const db = createMigratedTestD1();
    setSetting(db, SEATS_SMALL_DIFF_LINES_KEY, "50");
    const settings = await getReviewSeatSettings(db);
    expect(selectAttemptSeats("default", 50, settings).reason).toBe("small-diff");
    expect(selectAttemptSeats("default", 51, settings)).toEqual({ seats: 2, reason: "level" });
  });

  test("an unknown changed-line count takes the level's count (no small-diff guess)", async () => {
    const db = createMigratedTestD1();
    const selection = selectAttemptSeats("default", null, await getReviewSeatSettings(db));
    expect(selection).toEqual({ seats: 2, reason: "level" });
  });

  test("deep asks for no seat count — it has no partition", async () => {
    const db = createMigratedTestD1();
    const selection = selectAttemptSeats("deep", 57, await getReviewSeatSettings(db));
    expect(selection).toEqual({ seats: undefined, reason: "level" });
  });

  test("an untrusted stored row answers both defaults, degraded", async () => {
    const db = createMigratedTestD1();
    setSetting(db, SEATS_SMALL_DIFF_SEATS_KEY, "not-a-number");
    const settings = await getReviewSeatSettings(db);
    expect(settings).toEqual({
      smallDiffMaxLines: SEATS_SMALL_DIFF_LINES_DEFAULT,
      smallDiffSeats: SEATS_SMALL_DIFF_SEATS_DEFAULT,
      degraded: true,
    });
  });
});

describe("setReviewSeatSettings", () => {
  test("the write path lands both rows and the selection follows them", async () => {
    const db = createMigratedTestD1();
    const ACTOR = "operator@example.com";
    await setReviewSeatSettings(db, { smallDiffMaxLines: 60, smallDiffSeats: 2 }, ACTOR);
    const settings = await getReviewSeatSettings(db);
    expect(settings).toEqual({ smallDiffMaxLines: 60, smallDiffSeats: 2, degraded: false });
    // A 57-line diff — the issue's own case — now asks for the stored two
    // seats; one line above the new threshold takes the level's count again.
    expect(selectAttemptSeats("default", 57, settings)).toEqual({ seats: 2, reason: "small-diff" });
    expect(selectAttemptSeats("default", 61, settings)).toEqual({ seats: 2, reason: "level" });
  });

  test("an out-of-range value refuses the whole write with no rows", async () => {
    const db = createMigratedTestD1();
    await expect(
      setReviewSeatSettings(db, { smallDiffMaxLines: 0, smallDiffSeats: 1 }, "op"),
    ).rejects.toThrow("small-diff line threshold");
    await expect(
      setReviewSeatSettings(db, { smallDiffMaxLines: 120, smallDiffSeats: 3 }, "op"),
    ).rejects.toThrow("small-diff seat count");
    expect(await getReviewSeatSettings(db)).toMatchObject({
      smallDiffMaxLines: SEATS_SMALL_DIFF_LINES_DEFAULT,
      smallDiffSeats: SEATS_SMALL_DIFF_SEATS_DEFAULT,
    });
  });
});
