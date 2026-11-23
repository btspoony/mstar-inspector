import { describe, expect, test } from "bun:test";
import {
  FAILURE_CODES,
  FAILURE_SUMMARIES,
  isFailureCode,
  type FailureCode,
} from "../../src/contracts/failure-codes";

/**
 * The operator-facing deny list: no mechanism, no class names, no window or
 * timing arithmetic, no internal identifiers. A summary is written for a PR
 * author, so any of these means the leak came back.
 */
const DENY = ["container", "durable object", "marker", "attemptphaseerror", "ms", "timeout"];

describe("failure codes", () => {
  test("the set is closed: unique members, one summary each, no extras", () => {
    expect(new Set(FAILURE_CODES).size).toBe(FAILURE_CODES.length);
    expect(Object.keys(FAILURE_SUMMARIES).sort()).toEqual([...FAILURE_CODES].sort());
    for (const code of FAILURE_CODES) expect(code).toMatch(/^review\.[a-z_]+\.[a-z_]+$/);
  });

  test("every summary is a plain sentence stating what happened and the charge status", () => {
    for (const code of FAILURE_CODES) {
      const summary = FAILURE_SUMMARIES[code];
      expect(summary.length).toBeGreaterThan(20);
      expect(summary.endsWith(".")).toBe(true);
      expect(summary).toMatch(/charged|published/);
    }
  });

  test("no summary carries an internal term from the deny list", () => {
    for (const code of FAILURE_CODES) {
      const summary = FAILURE_SUMMARIES[code].toLowerCase();
      for (const term of DENY) expect(summary).not.toContain(term);
      expect(summary).not.toMatch(/\d+\s?ms/);
      expect(summary).not.toMatch(/\berror\b/);
      expect(summary).not.toMatch(/\b[a-z]+-[0-9a-z]{4,}\b/i);
    }
  });

  test("isFailureCode admits only members", () => {
    for (const code of FAILURE_CODES) expect(isFailureCode(code)).toBe(true);
    for (const value of ["", "review", "review.nope.nope", 42, null, undefined, {}]) {
      expect(isFailureCode(value)).toBe(false);
    }
    const narrowed: FailureCode | null = isFailureCode("review.internal.unclassified")
      ? "review.internal.unclassified"
      : null;
    expect(narrowed).toBe("review.internal.unclassified");
  });
});
