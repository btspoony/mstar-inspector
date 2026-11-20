/**
 * The one review-budget derivation: the platform cap plus the named
 * post-runner ledger into a runner ceiling, and the single allocation clamp.
 *
 * These cases pin the TABLE contract (every tier maximum provably inside the
 * pre-runner cutoff over the supported terminalize range) and the allocation
 * arithmetic (a delayed start spends the one absolute deadline, and an
 * expired cutoff never yields a positive budget).
 */
import { describe, expect, test } from "bun:test";

import {
  anchorRunnerBudget,
  requestRunnerBudget,
  parseNumstatSize,
  deriveReviewBudget,
  CHECK_WINDOW_MS,
  ROUND_BUDGET_MS,
  RUNNER_BUDGET_FLOOR_MS,
  SIZE_SATURATION_WORK_UNITS,
  postRunnerReserveMs,
  reviewGuardTtlSeconds,
} from "../../src/review-budget";
import { CHECK_TERMINALIZE_MAX, CHECK_TERMINALIZE_MIN } from "../../src/dashboard/runtime-config-store";
import { RUNNER_MAX_BUDGET_MS, type ReviewLevel } from "../../packages/shared/src/runtime";

const LEVELS: readonly ReviewLevel[] = ["quick", "default", "deep"];
const ROUND_START = 1_700_000_000_000;

/** A round started at `ROUND_START` with the live terminalize budget. */
function budgetFor(level: ReviewLevel, terminalizeMs: number) {
  return deriveReviewBudget({
    roundStartMs: ROUND_START,
    capMs: ROUND_BUDGET_MS,
    terminalizeMs,
    level,
  });
}

describe("tier table inside the derived ceiling", () => {
  // The shipped maxima are only honest if every one of them fits the cutoff
  // the SMALLEST supported reserve leaves; testing the endpoints as a table is
  // the whole point of the contract.
  for (const terminalizeMs of [CHECK_TERMINALIZE_MIN, 10_000, CHECK_TERMINALIZE_MAX]) {
    test(`terminalize ${terminalizeMs}ms: quick < default < deep <= cap - reserve`, () => {
      const cutoff = ROUND_BUDGET_MS - postRunnerReserveMs(terminalizeMs);
      expect(RUNNER_MAX_BUDGET_MS.quick).toBeLessThan(RUNNER_MAX_BUDGET_MS.default);
      expect(RUNNER_MAX_BUDGET_MS.default).toBeLessThan(RUNNER_MAX_BUDGET_MS.deep);
      expect(RUNNER_MAX_BUDGET_MS.deep).toBeLessThanOrEqual(cutoff);
      for (const level of LEVELS) {
        expect(budgetFor(level, terminalizeMs).tierMaxMs).toBe(RUNNER_MAX_BUDGET_MS[level]);
      }
    });
  }

  test("the cutoff is the platform cap less the live reserve at each endpoint", () => {
    expect(budgetFor("deep", CHECK_TERMINALIZE_MIN).runnerCutoffMs - ROUND_START).toBe(675_000);
    expect(budgetFor("deep", 10_000).runnerCutoffMs - ROUND_START).toBe(666_000);
    expect(budgetFor("deep", CHECK_TERMINALIZE_MAX).runnerCutoffMs - ROUND_START).toBe(646_000);
    // The reserve is charged 1:1, never rounded: the cutoff moves by exactly
    // the terminalize delta.
    expect(
      budgetFor("deep", CHECK_TERMINALIZE_MAX).runnerCutoffMs -
        budgetFor("deep", CHECK_TERMINALIZE_MIN).runnerCutoffMs,
    ).toBe(-(CHECK_TERMINALIZE_MAX - CHECK_TERMINALIZE_MIN));
  });

  test("the deep ceiling holds at the store's own maximum — raising it breaks this proof", () => {
    // The range endpoints are the store's declarations, never a test-local
    // copy: one millisecond of drift in CHECK_TERMINALIZE_MAX shrinks the
    // cutoff below the shipped deep maximum and this assertion catches it.
    expect(RUNNER_MAX_BUDGET_MS.deep).toBeLessThanOrEqual(
      ROUND_BUDGET_MS - postRunnerReserveMs(CHECK_TERMINALIZE_MAX),
    );
  });

  test("preparation budget is what the round may spend before the cutoff", () => {
    const budget = budgetFor("deep", 10_000);
    expect(budget.preparationBudgetMs).toBe(budget.runnerCutoffMs - ROUND_START);
    expect(budget.roundEndMs).toBe(ROUND_START + ROUND_BUDGET_MS);
  });

  test("the guard TTL and Check windows share the level's tier maximum", () => {
    expect(budgetFor("quick", 10_000).guardTtlSeconds).toBe(2_292);
    expect(budgetFor("default", 10_000).guardTtlSeconds).toBe(2_412);
    expect(budgetFor("deep", 10_000).guardTtlSeconds).toBe(2_458);
    for (const level of LEVELS) {
      const budget = budgetFor(level, 10_000);
      expect(budget.checkWindowMs).toBe(ROUND_BUDGET_MS);
      expect(budget.checkLeaseMs).toBe(ROUND_BUDGET_MS);
    }
  });
});

describe("allocation: one min(), one absolute deadline", () => {
  test("an unspent round gets the whole tier maximum and a deadline inside the reserve", () => {
    for (const level of LEVELS) {
      const budget = budgetFor(level, 10_000);
      const anchor = anchorRunnerBudget(budget, ROUND_START);
      expect(anchor.kind).toBe("allocated");
      if (anchor.kind !== "allocated") return;
      expect(anchor.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS[level]);
      expect(anchor.effectiveBudgetMs).toBe(RUNNER_MAX_BUDGET_MS[level]);
      expect(anchor.execDeadlineMs).toBe(ROUND_START + RUNNER_MAX_BUDGET_MS[level]);
      // The reserve still covers everything after the exec.
      expect(anchor.execDeadlineMs + budget.reserveMs).toBeLessThanOrEqual(budget.roundEndMs);
    }
  });

  test("a delayed start spends the cutoff, not the table (45s of setup at the default reserve)", () => {
    const budget = budgetFor("deep", 10_000);
    const anchor = anchorRunnerBudget(budget, ROUND_START + 45_000);
    expect(anchor.kind).toBe("allocated");
    if (anchor.kind !== "allocated") return;
    // min(646_000, 666_000 - 45_000) = 621_000 — the example the contract names.
    expect(anchor.effectiveBudgetMs).toBe(621_000);
    expect(anchor.execDeadlineMs).toBe(ROUND_START + 45_000 + 621_000);
    expect(anchor.execDeadlineMs + budget.reserveMs).toBe(budget.roundEndMs);
  });

  test("a start below the nominal floor keeps only the remaining wall clock", () => {
    const budget = budgetFor("deep", 10_000);
    const cutoff = budget.runnerCutoffMs;
    const anchor = anchorRunnerBudget(budget, cutoff - 10_000);
    expect(anchor.kind).toBe("allocated");
    if (anchor.kind !== "allocated") return;
    // The floor bounds the REQUEST, never the available wall clock.
    expect(anchor.effectiveBudgetMs).toBe(10_000);
    expect(anchor.execDeadlineMs).toBe(cutoff);
  });

  test("a smaller request (a future size-based caller) is honoured, never widened", () => {
    const budget = budgetFor("deep", 10_000);
    const anchor = anchorRunnerBudget(budget, ROUND_START, 120_000);
    expect(anchor.kind).toBe("allocated");
    if (anchor.kind !== "allocated") return;
    expect(anchor.requestedBudgetMs).toBe(120_000);
    expect(anchor.effectiveBudgetMs).toBe(120_000);
  });

  test("a request is bound to the tier maximum: AT it allocates, above it refuses", () => {
    const budget = budgetFor("default", 10_000);
    const tierMax = RUNNER_MAX_BUDGET_MS.default;

    // The boundary itself is a valid request — the ceiling is inclusive.
    const atMax = anchorRunnerBudget(budget, ROUND_START, tierMax);
    expect(atMax.kind).toBe("allocated");
    if (atMax.kind === "allocated") {
      expect(atMax.effectiveBudgetMs).toBe(tierMax);
      expect(atMax.requestedBudgetMs).toBe(tierMax);
    }

    // One ms over is a typed refusal inside the ONE derivation — the
    // requestedMs <= tierMaxMs invariant is enforced here, never by a
    // second silent clamp, and no caller can out-request the table.
    const over = anchorRunnerBudget(budget, ROUND_START, tierMax + 1);
    expect(over.kind).toBe("oversized");
    if (over.kind === "oversized") {
      expect(over.requestedBudgetMs).toBe(tierMax + 1);
      expect(over.tierMaxMs).toBe(tierMax);
    }
    // The refusal carries nothing a caller could mistake for a budget.
    expect("effectiveBudgetMs" in over).toBe(false);
    expect("execDeadlineMs" in over).toBe(false);
  });

  test("a malformed explicit request is invalid, never an allocation or a false exhaustion", () => {
    const budget = budgetFor("default", 10_000);
    for (const requestMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const refused = anchorRunnerBudget(budget, ROUND_START, requestMs);
      expect(refused.kind).toBe("invalid");
      if (refused.kind !== "invalid") return;
      expect(refused.requestedBudgetMs).toBe(requestMs);
      // The refusal carries nothing a caller could mistake for a budget or a
      // clock report — `exhausted` stays reserved for a spent cutoff.
      expect("effectiveBudgetMs" in refused).toBe(false);
      expect("execDeadlineMs" in refused).toBe(false);
      expect("remainingMs" in refused).toBe(false);
    }
    // A spent cutoff with a VALID request is still exhaustion — the new kind
    // sits on the request, not on the remaining clock.
    expect(anchorRunnerBudget(budget, budget.runnerCutoffMs).kind).toBe("exhausted");
  });

  test("time spent on the input write and startup comes out of the one deadline", () => {
    const budget = budgetFor("deep", 10_000);
    const anchor = anchorRunnerBudget(budget, ROUND_START + 5_000);
    expect(anchor.kind).toBe("allocated");
    if (anchor.kind !== "allocated") return;
    // 2s of input write + 3s of startup, measured against the SAME instant.
    const execStart = ROUND_START + 5_000 + 2_000 + 3_000;
    expect(anchor.execDeadlineMs - execStart).toBe(anchor.effectiveBudgetMs - 5_000);
    expect(anchor.execDeadlineMs).toBe(ROUND_START + 5_000 + anchor.effectiveBudgetMs);
  });

  test("a spent cutoff refuses instead of allocating a positive timeout", () => {
    const budget = budgetFor("default", 10_000);
    const refused = anchorRunnerBudget(budget, budget.runnerCutoffMs + 1);
    expect(refused.kind).toBe("exhausted");
    if (refused.kind !== "exhausted") return;
    expect(refused.remainingMs).toBe(-1);

    const exact = anchorRunnerBudget(budget, budget.runnerCutoffMs);
    expect(exact.kind).toBe("exhausted");

    // A refusal never carries a budget a caller could mistake for time left.
    expect("effectiveBudgetMs" in refused).toBe(false);
  });

  test("a smaller test cap moves the whole round, not the table", () => {
    const budget = deriveReviewBudget({
      roundStartMs: ROUND_START,
      capMs: 400_000,
      terminalizeMs: 10_000,
      level: "default",
    });
    expect(budget.roundEndMs).toBe(ROUND_START + 400_000);
    // 400_000 − 234_000 = 166_000, below the default tier maximum.
    expect(budget.runnerCutoffMs).toBe(ROUND_START + 166_000);
    const anchor = anchorRunnerBudget(budget, ROUND_START);
    expect(anchor.kind).toBe("allocated");
    if (anchor.kind !== "allocated") return;
    expect(anchor.effectiveBudgetMs).toBe(166_000);
  });
});

describe("size-aware request: floor → tier maximum at 20,000 work units", () => {
  const size = (changedLines: number, workUnits: number) => ({ changedLines, workUnits });

  test("a zero-line diff requests the floor, not a refusal and not zero", () => {
    for (const level of LEVELS) {
      const request = requestRunnerBudget(level, size(0, 0));
      expect(request.kind).toBe("requested");
      if (request.kind !== "requested") return;
      expect(request.requestedBudgetMs).toBe(RUNNER_BUDGET_FLOOR_MS);
      expect(request.workUnits).toBe(0);
    }
  });

  test("an unknown size requests the tier maximum — never the floor and never a second numstat", () => {
    for (const level of LEVELS) {
      const request = requestRunnerBudget(level, null);
      expect(request.kind).toBe("requested");
      if (request.kind !== "requested") return;
      expect(request.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS[level]);
      expect(request.workUnits).toBeNull();
    }
  });

  test("binary-only files pay one unit each — zero textual lines still size the diff", () => {
    // `git apply --numstat` prints "-\t-\tpath" for binary rows; the parser
    // reports 0 textual lines for them, and the per-file minimum turns each
    // into exactly one work unit.
    const request = requestRunnerBudget("default", size(0, 3));
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
    expect(request.workUnits).toBe(3);
    // 120_000 + floor(480_000 * 3 / 20_000) = 120_072.
    expect(request.requestedBudgetMs).toBe(120_072);
  });

  test("a zero-text row beside real lines pays its own unit (the per-file minimum is per file)", () => {
    const request = requestRunnerBudget("default", size(5, 7));
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
    // Σ max(1, linesInFile) = 5 + 1 + 1 = 7, not 5 — binary files cost a unit
    // even when a sibling file carries the lines.
    expect(request.workUnits).toBe(7);
  });

  test("a saturated diff requests the tier maximum and no more", () => {
    for (const level of LEVELS) {
      const request = requestRunnerBudget(level, size(25_000, 25_000));
      expect(request.kind).toBe("requested");
      if (request.kind !== "requested") return;
      expect(request.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS[level]);
      expect(request.workUnits).toBe(25_000);
    }
  });

  test("units at exactly the saturation point land on the tier maximum; one below stays inside", () => {
    const at = requestRunnerBudget("default", size(SIZE_SATURATION_WORK_UNITS, SIZE_SATURATION_WORK_UNITS));
    expect(at.kind).toBe("requested");
    if (at.kind !== "requested") return;
    expect(at.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS.default);

    const below = requestRunnerBudget("default", size(SIZE_SATURATION_WORK_UNITS - 1, SIZE_SATURATION_WORK_UNITS - 1));
    expect(below.kind).toBe("requested");
    if (below.kind !== "requested") return;
    expect(below.requestedBudgetMs).toBeLessThan(RUNNER_MAX_BUDGET_MS.default);
    expect(below.requestedBudgetMs).toBeGreaterThan(RUNNER_BUDGET_FLOOR_MS);
  });

  test("the ramp honours floor and ceiling on every interior size and every tier", () => {
    for (const level of LEVELS) {
      for (const units of [1, 100, 1_000, 10_000, SIZE_SATURATION_WORK_UNITS + 500]) {
        const request = requestRunnerBudget(level, size(units, units));
        expect(request.kind).toBe("requested");
        if (request.kind !== "requested") return;
        expect(Number.isInteger(request.requestedBudgetMs)).toBe(true);
        expect(request.requestedBudgetMs).toBeGreaterThanOrEqual(RUNNER_BUDGET_FLOOR_MS);
        expect(request.requestedBudgetMs).toBeLessThanOrEqual(RUNNER_MAX_BUDGET_MS[level]);
      }
    }
  });

  test("floor arithmetic is floor, not rounding: deep, 2 work units → 120_052 ms", () => {
    // floor((646_000 − 120_000) × 2 / 20_000) = floor(52.6) = 52 — Math.round
    // or Math.ceil would produce 120_053, so this literal is the only pin
    // that distinguishes the contract's floor semantics from rounding.
    const request = requestRunnerBudget("deep", size(2, 2));
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
    expect(request.requestedBudgetMs).toBe(120_052);
  });

  test("malformed size input is invalid — never treated as an empty diff", () => {
    const badSizes: [number, number][] = [
      [-1, 0],               // negative total
      [1.5, 2],              // non-integer line count
      [0, -1],               // negative work units
      [1, 0],                // work units below the changed lines
      [Number.MAX_SAFE_INTEGER + 1, 0], // an inexact scalar is not a count
    ];
    for (const level of LEVELS) {
      for (const [changedLines, workUnits] of badSizes) {
        const refused = requestRunnerBudget(level, size(changedLines, workUnits));
        expect(refused.kind).toBe("invalid");
        if (refused.kind !== "invalid") return;
        // The refusal carries nothing a caller could mistake for a request.
        expect("effectiveBudgetMs" in refused).toBe(false);
        expect("workUnits" in refused).toBe(false);
      }
    }
  });

  test("the computed request feeds the one anchor — no second clamp, same cutoff math", () => {
    const budget = budgetFor("default", 10_000);
    const request = requestRunnerBudget("default", size(2_000, 2_000));
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
    // 2,000 units → 120_000 + floor(480_000 * 2_000 / 20_000) = 168_000.
    expect(request.requestedBudgetMs).toBe(168_000);
    const anchor = anchorRunnerBudget(budget, ROUND_START, request.requestedBudgetMs);
    expect(anchor.kind).toBe("allocated");
    if (anchor.kind !== "allocated") return;
    expect(anchor.requestedBudgetMs).toBe(168_000);
    expect(anchor.effectiveBudgetMs).toBe(168_000);
  });

});

describe("admission windows cover the whole allocation range", () => {
  // The invariant `execDeadline + reserve <= roundEnd <= min(guardExpiry,
  // checkLeaseExpiry)` must hold for EVERY allocation the tier can produce —
  // not only the tier maximum — so the two allocation extremes run under the
  // tightest reserve (the supported 30s terminalize ceiling). The windows are
  // ceiling-derived, so the earliest an acquisition may stamp them is the
  // round's own start: `roundStart + guardTtl` / `roundStart + checkLease` is
  // the lowest each expiry can ever be, and any later origin only widens it.
  const size = (changedLines: number, workUnits: number) => ({ changedLines, workUnits });

  test("floor request: the smallest allocation still ends inside the earliest-acquired windows", () => {
    for (const level of LEVELS) {
      const budget = budgetFor(level, CHECK_TERMINALIZE_MAX);
      const request = requestRunnerBudget(level, size(0, 1));
      expect(request.kind).toBe("requested");
      if (request.kind !== "requested") return;
      const anchor = anchorRunnerBudget(budget, ROUND_START, request.requestedBudgetMs);
      expect(anchor.kind).toBe("allocated");
      if (anchor.kind !== "allocated") return;
      // One work unit still requests the floor (its ms may sit above the
      // literal floor by the ramp's rounding — assert the contract, not the
      // arithmetic, which the request cases already pin).
      expect(anchor.effectiveBudgetMs).toBe(request.requestedBudgetMs);
      expect(anchor.execDeadlineMs + budget.reserveMs).toBeLessThanOrEqual(budget.roundEndMs);
      expect(budget.roundEndMs).toBeLessThanOrEqual(ROUND_START + budget.guardTtlSeconds * 1000);
      expect(budget.roundEndMs).toBeLessThanOrEqual(ROUND_START + budget.checkLeaseMs);
    }
  });

  test("ceiling request: the tier maximum leaves the tail exactly at the round end", () => {
    for (const level of LEVELS) {
      const budget = budgetFor(level, CHECK_TERMINALIZE_MAX);
      const request = requestRunnerBudget(level, null);
      expect(request.kind).toBe("requested");
      if (request.kind !== "requested") return;
      const anchor = anchorRunnerBudget(budget, ROUND_START, request.requestedBudgetMs);
      expect(anchor.kind).toBe("allocated");
      if (anchor.kind !== "allocated") return;
      expect(anchor.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS[level]);
      // deep binds AT the cutoff: the tail IS the round end — the tightest
      // the invariant runs; quick/default end earlier by the same windows.
      expect(anchor.execDeadlineMs + budget.reserveMs).toBeLessThanOrEqual(budget.roundEndMs);
      expect(budget.roundEndMs).toBeLessThanOrEqual(ROUND_START + budget.guardTtlSeconds * 1000);
      expect(budget.roundEndMs).toBeLessThanOrEqual(ROUND_START + budget.checkLeaseMs);
    }
  });

  test("late start at the maximum terminalize: a spent preparation still leaves the tail inside both windows", () => {
    // 200s of preparation under a 30s terminalize: the cutoff binds, so the
    // exec ends at `roundEnd - reserve` and the tail is exactly the round end
    // — while the windows were stamped at the round's own start.
    const budget = budgetFor("deep", CHECK_TERMINALIZE_MAX);
    for (const request of [
      requestRunnerBudget("deep", size(0, 1)),
      requestRunnerBudget("deep", null),
    ]) {
      expect(request.kind).toBe("requested");
      if (request.kind !== "requested") return;
      const anchor = anchorRunnerBudget(budget, ROUND_START + 200_000, request.requestedBudgetMs);
      expect(anchor.kind).toBe("allocated");
      if (anchor.kind !== "allocated") return;
      expect(anchor.execDeadlineMs + budget.reserveMs).toBeLessThanOrEqual(budget.roundEndMs);
      expect(budget.roundEndMs).toBeLessThanOrEqual(ROUND_START + budget.guardTtlSeconds * 1000);
      expect(budget.roundEndMs).toBeLessThanOrEqual(ROUND_START + budget.checkLeaseMs);
    }
  });

  test("a small request never shortens either window — both read the ceiling, not the allocation", () => {
    // Two INDEPENDENT derivations — one exercised under a floor request, one
    // under the tier maximum — must carry identical windows. Comparing the
    // window triple of two separately-driven rounds (never one budget's
    // fields against themselves) is what fails if a future change routes the
    // allocation into `guardTtlSeconds`, `checkWindowMs` or `checkLeaseMs`.
    for (const level of LEVELS) {
      const anchoredWindows = (diffSize: { changedLines: number; workUnits: number } | null) => {
        const budget = budgetFor(level, CHECK_TERMINALIZE_MAX);
        const request = requestRunnerBudget(level, diffSize);
        expect(request.kind).toBe("requested");
        if (request.kind !== "requested") throw new Error("unreachable");
        const anchor = anchorRunnerBudget(budget, ROUND_START, request.requestedBudgetMs);
        expect(anchor.kind).toBe("allocated");
        if (anchor.kind !== "allocated") throw new Error("unreachable");
        return {
          effectiveBudgetMs: anchor.effectiveBudgetMs,
          guardTtlSeconds: budget.guardTtlSeconds,
          checkWindowMs: budget.checkWindowMs,
          checkLeaseMs: budget.checkLeaseMs,
        };
      };
      const floor = anchoredWindows(size(0, 1));
      const ceiling = anchoredWindows(null);
      // Distinct inputs: the pair cannot pass by both runs taking the same
      // path — the requests, and so the allocations, differ.
      expect(floor.effectiveBudgetMs).not.toBe(ceiling.effectiveBudgetMs);
      expect(floor.guardTtlSeconds).toBe(ceiling.guardTtlSeconds);
      expect(floor.checkWindowMs).toBe(ceiling.checkWindowMs);
      expect(floor.checkLeaseMs).toBe(ceiling.checkLeaseMs);
      // The windows are the level's own derivation, never the allocation's.
      expect(floor.guardTtlSeconds).toBe(reviewGuardTtlSeconds(level));
      expect(floor.checkWindowMs).toBe(CHECK_WINDOW_MS);
      expect(floor.checkLeaseMs).toBe(CHECK_WINDOW_MS);
    }
  });
});

describe("numstat size parse: complete vs truncated vs unknown", () => {
  test("a truncated tail row is unknown size — never an undersized complete set", () => {
    // Every complete row the parser accepts ends in a newline; a stdout that
    // stops mid-row cannot be told apart from a complete set whose counts
    // happen to be self-consistent — so it must not size the diff at all.
    expect(parseNumstatSize("10\t2\tsrc/auth.ts\n5\t0\tsrc/docs.md", false)).toBeNull();
    // A row that lost its path field is truncated the same way even when the
    // newline happened to survive.
    expect(parseNumstatSize("10\t2\n", false)).toBeNull();
    // The same text with a valid terminator parses normally.
    expect(parseNumstatSize("10\t2\tsrc/auth.ts\n5\t0\tsrc/docs.md\n", false)).toEqual({
      changedLines: 17,
      workUnits: 17,
    });
  });

  test("a binary-only diff carries zero textual lines per file, not null", () => {
    // `-\t-` is git's binary marker: deliberate data, not a failure — each
    // file still pays the per-file minimum unit inside the request.
    const size = parseNumstatSize("-\t-\tassets/logo.png\n-\t-\tassets/fonts.bin\n", false);
    expect(size).toEqual({ changedLines: 0, workUnits: 2 });
    const request = requestRunnerBudget("default", size);
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
    expect(request.workUnits).toBe(2);
  });

  test("a complete mixed diff sums textual lines and keeps binary rows at zero", () => {
    const size = parseNumstatSize(
      "10\t2\tsrc/auth.ts\n-\t-\tassets/logo.png\n0\t3\tdocs/readme.md\n",
      false,
    );
    expect(size).toEqual({ changedLines: 15, workUnits: 16 });
  });

  test("an empty diff is a known zero only when the diff file proved empty", () => {
    // The same empty stdout means two different things: the same round's
    // diff-file evidence decides which — the parser never guesses.
    expect(parseNumstatSize("", true)).toEqual({ changedLines: 0, workUnits: 0 });
    expect(parseNumstatSize("", false)).toBeNull();
    // No stdout at all is unproven empty under any file state.
    expect(parseNumstatSize(undefined, true)).toBeNull();
  });

  test("a negative or non-numeric count row is unknown size, never a count", () => {
    expect(parseNumstatSize("-3\t1\tsrc/auth.ts\n", false)).toBeNull();
    expect(parseNumstatSize("abc\t1\tsrc/auth.ts\n", false)).toBeNull();
    // `abc` on one side is not the `-\t-` binary pair.
    expect(parseNumstatSize("-\t1\tsrc/auth.ts\n", false)).toBeNull();
    // A non-integer count is malformed the same way.
    expect(parseNumstatSize("1.5\t0\tsrc/auth.ts\n", false)).toBeNull();
    // An unproven-empty read still yields the tier maximum, not the floor.
    const request = requestRunnerBudget("default", parseNumstatSize("abc\t1\tx.ts\n", false));
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
    expect(request.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS.default);
  });

  test("a blank count or an empty path row is unknown size, never a count", () => {
    // Number("") and Number(" ") are 0, so a missing or whitespace count
    // would parse as a real zero without a shape check.
    expect(parseNumstatSize("\t1\tfile\n", false)).toBeNull();
    expect(parseNumstatSize(" \t1\tfile\n", false)).toBeNull();
    expect(parseNumstatSize("1\t\tfile\n", false)).toBeNull();
    // A present-but-empty path field is the same malformed row.
    expect(parseNumstatSize("1\t0\t\n", false)).toBeNull();
    expect(parseNumstatSize("1\t0\t \n", false)).toBeNull();
    // A whitespace-only line is a malformed row, not a blank to skip.
    expect(parseNumstatSize("1\t0\ta.ts\n \n2\t0\tb.ts\n", false)).toBeNull();
  });

  test("a row with extra fields or an inexact count is unknown size — never a small allocation", () => {
    // More than the three expected fields means the parse cannot trust what
    // it read: this row would otherwise look like ONE work unit (120_024 ms
    // at the default tier instead of the 600_000 ms tier maximum).
    expect(parseNumstatSize("1\t0\tfile\textra\n", false)).toBeNull();
    // 9007199254740993 = 2^53 + 1: Number() silently rounds it to
    // 9007199254740992, an exact-looking integer that never was the count.
    expect(parseNumstatSize("9007199254740993\t0\tfile\n", false)).toBeNull();
    // Two finite counts whose sum cannot be represented exactly are the same
    // unknown — the totals must not overflow into a fabricated value.
    expect(
      parseNumstatSize("9007199254740991\t1\ta.ts\n9007199254740991\t1\tb.ts\n", false),
    ).toBeNull();
    // Unknown size keeps the tier-maximum request, never an exec-time refusal.
    const request = requestRunnerBudget(
      "default",
      parseNumstatSize("9007199254740993\t0\tfile\n", false),
    );
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
    expect(request.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS.default);
    expect(request.workUnits).toBeNull();
  });
});
