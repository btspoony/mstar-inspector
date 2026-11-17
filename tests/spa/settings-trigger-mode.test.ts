/**
 * The review-trigger vocabulary across the bundle boundary (spec
 * review-trigger-policy §2): the SPA's copy of the frozen migration-0022 enum
 * must match the store's, and the guard must refuse everything else. The
 * control itself lives on the repository detail's settings tab
 * (TargetSettingsTab), whose faces are pinned by targets-page.test.tsx.
 */
import { describe, expect, test } from "bun:test";
import { REVIEW_TRIGGER_MODES as STORE_REVIEW_TRIGGER_MODES } from "../../src/dashboard/targets-store";
import { REVIEW_TRIGGER_MODES, isReviewTriggerMode } from "../../src/spa/pages/data";

describe("review trigger vocabulary (duplication lock)", () => {
  test("the SPA vocabulary mirrors the store's frozen migration-0022 enum (drift fails here)", () => {
    // Same duplication-lock convention as DEFAULT_CHAIN_NAME: data.ts mirrors
    // the store across the bundle boundary (documented, deliberately not
    // imported) — a one-sided rename would desync the wire values the policy
    // POSTs from the values the DB CHECK admits. (Store declares
    // `readonly ReviewTriggerMode[]`; the SPA copy is the const tuple — the
    // joined forms pin identical members in order.)
    expect(REVIEW_TRIGGER_MODES.join()).toBe("open,every_push,manual");
    expect(STORE_REVIEW_TRIGGER_MODES.join()).toBe("open,every_push,manual");
    expect(isReviewTriggerMode("open")).toBe(true);
    expect(isReviewTriggerMode("every_push")).toBe(true);
    expect(isReviewTriggerMode("manual")).toBe(true);
    // Radix's type="single" deselect emits "" — the guard must refuse it.
    expect(isReviewTriggerMode("")).toBe(false);
    expect(isReviewTriggerMode("EVERY_PUSH")).toBe(false);
    expect(isReviewTriggerMode("whenever")).toBe(false);
  });
});
