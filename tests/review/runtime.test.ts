/**
 * Unit tests for the AgentRuntime port + deterministic seat logic (plan 07
 * Task 2). Pure functions only — no SDK boundary involved:
 *   - port constants (REVIEW_SEATS) and the level guard;
 *   - partitionSeats: quick full-diff seat, default cluster balance,
 *     degenerate half-split, single-file overlap, empty universe;
 *   - mergeSeatOutputs: fingerprint dedupe + unverified union;
 *   - parseTarget: recon-fact folding into the envelope target.
 */

import { describe, expect, test } from "bun:test";

import { isReviewLevel, REVIEW_LEVELS, REVIEW_SEATS } from "../../src/review/runtime";
import { mergeSeatOutputs, partitionSeats, parseTarget } from "../../src/review/runtime-omp";

const numstat = (added: number | "-", deleted: number | "-", path: string): string =>
  `${added}\t${deleted}\t${path}`;

describe("REVIEW_SEATS (harness tier table)", () => {
  test("quick = 1 seat, default = 2 seats, deep tier exists but has no seats entry", () => {
    expect(REVIEW_LEVELS).toEqual(["quick", "default", "deep"]);
    expect(REVIEW_SEATS).toEqual({ quick: 1, default: 2 });
    expect(Object.keys(REVIEW_SEATS).sort()).toEqual(["default", "quick"]);
  });

  test("isReviewLevel accepts every tier incl. deep and rejects the rest", () => {
    expect(isReviewLevel("quick")).toBe(true);
    expect(isReviewLevel("default")).toBe(true);
    expect(isReviewLevel("deep")).toBe(true);
    expect(isReviewLevel(2)).toBe(false);
    expect(isReviewLevel(undefined)).toBe(false);
    // qc3 F-302: Object.prototype keys must NOT pass (`in` would accept them).
    expect(isReviewLevel("toString")).toBe(false);
    expect(isReviewLevel("constructor")).toBe(false);
    expect(isReviewLevel("hasOwnProperty")).toBe(false);
    expect(isReviewLevel("__proto__")).toBe(false);
  });
});

describe("partitionSeats", () => {
  test("quick: one full-diff/combined seat covering every changed file", () => {
    const facts = [numstat(10, 2, "src/a.ts"), numstat(1, 0, "docs/b.md")];
    const plans = partitionSeats(facts, "quick");

    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual({
      domain: "full-diff",
      seat: "combined",
      scope: ["docs/b.md", "src/a.ts"],
    });
  });

  test("default: clusters by top-level dir, balanced greedily into two groups", () => {
    const facts = [
      numstat(10, 2, "src/a.ts"), // src cluster: 12 lines
      numstat(5, 0, "src/b.ts"),
      numstat(8, 1, "lib/c.ts"), // lib cluster: 9 lines
    ];
    const plans = partitionSeats(facts, "default");

    expect(plans).toHaveLength(2);
    expect(plans[0]!.domain).toBe("changeset-1");
    expect(plans[0]!.seat).toBe("src");
    expect(plans[0]!.scope).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plans[1]!.domain).toBe("changeset-2");
    expect(plans[1]!.seat).toBe("lib");
    expect(plans[1]!.scope).toEqual(["lib/c.ts"]);

    // Combined coverage is exhaustive over the changed files.
    const covered = [...plans[0]!.scope, ...plans[1]!.scope];
    expect(covered.sort()).toEqual(["lib/c.ts", "src/a.ts", "src/b.ts"]);
  });

  test("default: greedy balance assigns the heavier cluster first regardless of order", () => {
    const facts = [
      numstat(1, 0, "lib/small.ts"), // lib: 1 line
      numstat(40, 0, "src/big.ts"), // src: 40 lines
    ];
    const [first, second] = partitionSeats(facts, "default");

    expect(first!.seat).toBe("src");
    expect(first!.scope).toEqual(["src/big.ts"]);
    expect(second!.seat).toBe("lib");
  });

  test("default: equal-weight clusters — the greedy tie goes to group 0", () => {
    // Equal lines → the cluster sort falls back to localeCompare (lib before
    // src), then `groups[1] < groups[0]` is false on the tie, so the first
    // cluster lands in changeset-1 (group 0) and the second in changeset-2.
    const facts = [numstat(3, 0, "src/a.ts"), numstat(3, 0, "lib/b.ts")];
    const [first, second] = partitionSeats(facts, "default");

    expect(first!.seat).toBe("lib");
    expect(first!.scope).toEqual(["lib/b.ts"]);
    expect(second!.seat).toBe("src");
    expect(second!.scope).toEqual(["src/a.ts"]);
  });

  test("default: root files cluster under one bucket; single (root) cluster → degenerate half split", () => {
    const facts = [numstat(3, 0, "README.md"), numstat(3, 0, "package.json")];
    const plans = partitionSeats(facts, "default");

    expect(plans).toHaveLength(2);
    // Single "(root)" cluster → degenerate sorted-path half split.
    expect(plans[0]!.seat).toBe("part-1");
    expect(plans[0]!.scope).toEqual(["README.md"]);
    expect(plans[1]!.seat).toBe("part-2");
    expect(plans[1]!.scope).toEqual(["package.json"]);
  });

  test("default: single top-level cluster falls back to sorted-path halves", () => {
    const facts = [numstat(4, 0, "src/c.ts"), numstat(2, 1, "src/a.ts"), numstat(1, 0, "src/b.ts")];
    const plans = partitionSeats(facts, "default");

    expect(plans[0]!.domain).toBe("changeset-1");
    expect(plans[0]!.scope).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plans[1]!.scope).toEqual(["src/c.ts"]);
  });

  test("default: one changed file → both seats take it (overlap allowed)", () => {
    const plans = partitionSeats([numstat(7, 0, "src/solo.ts")], "default");

    expect(plans).toHaveLength(2);
    expect(plans[0]!.scope).toEqual(["src/solo.ts"]);
    expect(plans[1]!.scope).toEqual(["src/solo.ts"]);
  });

  test("default: no numstat facts → both seats get full coverage, no scope list", () => {
    const plans = partitionSeats(["acme/widgets#7", "head abc1234"], "default");

    expect(plans).toHaveLength(2);
    expect(plans[0]!.scope).toEqual([]);
    expect(plans[1]!.scope).toEqual([]);
  });

  test("non-numstat facts are ignored as partition input", () => {
    const plans = partitionSeats(
      ["some prose fact", numstat(2, 0, "src/a.ts"), numstat(3, 0, "lib/b.ts")],
      "default",
    );

    expect(plans.flatMap((plan) => [...plan.scope]).sort()).toEqual(["lib/b.ts", "src/a.ts"]);
  });
});

describe("mergeSeatOutputs", () => {
  test("dedupes findings by fingerprint_hint, first seat wins", () => {
    const merged = mergeSeatOutputs([
      {
        findings: [
          { mergeClass: "must-fix", title: "SQL injection", body: "b1", fingerprint_hint: "fp-1" },
          { mergeClass: "nit", title: "Typo", body: "b2" },
        ],
      },
      {
        findings: [
          // Same fingerprint → dropped; no hint → file:line:title composite.
          { mergeClass: "nit", title: "SQL injection", body: "duplicate", fingerprint_hint: "fp-1" },
          { mergeClass: "nit", title: "Typo", body: "duplicate-composite" },
        ],
        unverified: ["flag A", "flag B"],
      },
      { findings: [], unverified: ["flag A"] }, // duplicate unverified
    ]);

    expect(merged.findings).toHaveLength(2);
    expect(merged.findings[0]!.body).toBe("b1");
    expect(merged.findings[1]).toEqual({
      mergeClass: "nit",
      title: "Typo",
      body: "b2",
    });
    expect(merged.unverifiedCount).toBe(2);
  });

  test("composite fingerprint distinguishes line numbers and titles", () => {
    const merged = mergeSeatOutputs([
      { findings: [{ mergeClass: "nit", title: "Same title", body: "a", file_path: "f.ts", line_start: 1 }] },
      { findings: [{ mergeClass: "nit", title: "Same title", body: "b", file_path: "f.ts", line_start: 2 }] },
    ]);

    expect(merged.findings).toHaveLength(2);
  });
});

describe("parseTarget", () => {
  test("folds owner/repo#pr and head sha facts into the target", () => {
    expect(parseTarget(["acme/widgets#7", "head abc1234567890abcdef1234567890abcdef12"])).toEqual({
      owner: "acme",
      repo: "widgets",
      pr: 7,
      head_sha: "abc1234567890abcdef1234567890abcdef12",
    });
  });

  test("returns undefined without matching facts and tolerates partial matches", () => {
    expect(parseTarget(["nothing relevant"])).toBeUndefined();
    expect(parseTarget(["head deadbeef"])).toEqual({ head_sha: "deadbeef" });
  });
});
