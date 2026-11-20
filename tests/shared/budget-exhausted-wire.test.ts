/**
 * mstar.review-budget-exhausted/v1 signal guard — the fail-closed gate the
 * Worker parses runner stdout with before it may classify a run as a
 * terminal budget stop.
 *
 * The contract under test: the exact schema literal as the whole
 * discriminator, exactly the three own keys, and safe-integer counts with
 * `0 <= seatsStopped <= seatsDispatched`. Anything else is unrelated stdout
 * (or a fabricated document) and never parses as a runner fact.
 */
import { describe, expect, test } from "bun:test";

import {
  isReviewBudgetExhaustedSignal,
  REVIEW_BUDGET_EXHAUSTED_SCHEMA,
} from "../../packages/shared/src/budget-exhausted-wire";

const SIGNAL = {
  schema: REVIEW_BUDGET_EXHAUSTED_SCHEMA,
  seatsDispatched: 2,
  seatsStopped: 1,
};

describe("isReviewBudgetExhaustedSignal", () => {
  test("accepts the exact signal document", () => {
    expect(isReviewBudgetExhaustedSignal(SIGNAL)).toBe(true);
  });

  test("rejects a document whose schema tag is missing", () => {
    const { schema: _schema, ...noTag } = SIGNAL;
    // Counts alone prove nothing: without the literal the document is
    // unrelated stdout that happens to carry two numbers.
    expect(isReviewBudgetExhaustedSignal(noTag)).toBe(false);
  });

  test("rejects a document claiming a different schema tag", () => {
    expect(
      isReviewBudgetExhaustedSignal({ ...SIGNAL, schema: "mstar.review/v1" }),
    ).toBe(false);
    expect(
      isReviewBudgetExhaustedSignal({ ...SIGNAL, schema: "mstar.review-budget-exhausted/v2" }),
    ).toBe(false);
  });

  test("rejects an extra own key — the signal's key set is closed", () => {
    expect(isReviewBudgetExhaustedSignal({ ...SIGNAL, note: "model text" })).toBe(false);
  });

  test("rejects an inherited-name key parsed from stdout JSON", () => {
    // `constructor` is a name the `in` operator resolves through Object's
    // prototype: an own-key check must see it as an EXTRA document key, not a
    // member of the allowed set.
    const forged = JSON.parse(
      '{"schema":"mstar.review-budget-exhausted/v1","seatsDispatched":1,"seatsStopped":1,"constructor":{}}',
    ) as unknown;
    expect(isReviewBudgetExhaustedSignal(forged)).toBe(false);
  });

  test("rejects a required field that exists only on the prototype", () => {
    // Own keys alone prove nothing: `Object.keys` sees no extra keys on a
    // document whose fields ride the prototype, and property reads traverse
    // it — so each required field must be demanded as an OWN property.
    for (const field of ["schema", "seatsDispatched", "seatsStopped"] as const) {
      const { [field]: lifted, ...own } = SIGNAL;
      const forged = Object.assign(Object.create({ [field]: lifted }), own);
      expect(isReviewBudgetExhaustedSignal(forged)).toBe(false);
    }
  });

  test("rejects a document whose every required field is inherited", () => {
    expect(isReviewBudgetExhaustedSignal(Object.create(SIGNAL))).toBe(false);
  });

  test("rejects a document missing a count key", () => {
    const { seatsStopped: _stopped, ...missing } = SIGNAL;
    expect(isReviewBudgetExhaustedSignal(missing)).toBe(false);
  });

  test("rejects counts outside the observed-fact bounds", () => {
    expect(isReviewBudgetExhaustedSignal({ ...SIGNAL, seatsStopped: 3 })).toBe(false);
    expect(isReviewBudgetExhaustedSignal({ ...SIGNAL, seatsStopped: -1 })).toBe(false);
    expect(isReviewBudgetExhaustedSignal({ ...SIGNAL, seatsDispatched: 1.5 })).toBe(false);
    expect(
      isReviewBudgetExhaustedSignal({ ...SIGNAL, seatsDispatched: "2", seatsStopped: 1 }),
    ).toBe(false);
  });

  test("rejects non-documents and arrays", () => {
    for (const value of [null, undefined, 0, "signal", true, [1, 2]]) {
      expect(isReviewBudgetExhaustedSignal(value)).toBe(false);
    }
  });
});
