import { describe, expect, test } from "bun:test";
import { REVIEW_TRIGGER_MODES as STORE_REVIEW_TRIGGER_MODES } from "../../src/dashboard/targets-store";
import { REVIEW_TRIGGER_MODES, isReviewTriggerMode } from "../../src/spa/pages/data";

describe("review trigger vocabulary (duplication lock)", () => {
  test("the SPA vocabulary mirrors the store's frozen migration-0022 enum (drift fails here)", () => {
    expect(REVIEW_TRIGGER_MODES.join()).toBe("open,every_push,manual");
    expect(STORE_REVIEW_TRIGGER_MODES.join()).toBe("open,every_push,manual");
    expect(isReviewTriggerMode("open")).toBe(true);
    expect(isReviewTriggerMode("every_push")).toBe(true);
    expect(isReviewTriggerMode("manual")).toBe(true);
    expect(isReviewTriggerMode("")).toBe(false);
    expect(isReviewTriggerMode("EVERY_PUSH")).toBe(false);
    expect(isReviewTriggerMode("whenever")).toBe(false);
  });
});
