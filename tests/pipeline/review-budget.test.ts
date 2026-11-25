import { describe, expect, test } from "bun:test";

import {
  anchorRunnerBudget,
  requestRunnerBudget,
  parseNumstatSize,
  deriveReviewBudget,
  CHECK_WINDOW_MS,
  ROUND_BUDGET_MS,
  PUBLICATION_TAIL_MS,
  postRunnerReserveMs,
  reviewGuardTtlSeconds,
} from "../../src/review-budget";
import {
  CHECK_TERMINALIZE_MAX,
  CHECK_TERMINALIZE_MIN,
  REVIEW_ATTEMPT_CAP_DEFAULT_MS,
} from "../../src/dashboard/runtime-config-store";
import { PR_REVIEW_TIER_BUDGETS } from "@mstar-harness/engine";
import { RUNNER_MAX_BUDGET_MS, type ReviewLevel } from "../../packages/shared/src/runtime";

const LEVELS: readonly ReviewLevel[] = ["quick", "default", "deep"];
const ROUND_START = 1_700_000_000_000;

function budgetFor(level: ReviewLevel, terminalizeMs: number) {
  return deriveReviewBudget({
    roundStartMs: ROUND_START,
    deadlineMs: ROUND_START + REVIEW_ATTEMPT_CAP_DEFAULT_MS,
    terminalizeMs,
    level,
  });
}

describe("tier table inside the derived ceiling", () => {
  for (const terminalizeMs of [CHECK_TERMINALIZE_MIN, 10_000, CHECK_TERMINALIZE_MAX]) {
    test(`terminalize ${terminalizeMs}ms: quick < default < deep <= deadline - reserve`, () => {
      const cutoff = REVIEW_ATTEMPT_CAP_DEFAULT_MS - postRunnerReserveMs(terminalizeMs);
      expect(RUNNER_MAX_BUDGET_MS.quick).toBeLessThan(RUNNER_MAX_BUDGET_MS.default);
      expect(RUNNER_MAX_BUDGET_MS.default).toBeLessThan(RUNNER_MAX_BUDGET_MS.deep);
      expect(RUNNER_MAX_BUDGET_MS.deep).toBeLessThanOrEqual(cutoff);
      for (const level of LEVELS) {
        expect(budgetFor(level, terminalizeMs).tierMaxMs).toBe(RUNNER_MAX_BUDGET_MS[level]);
      }
    });
  }

  test("the cutoff is the frozen deadline less the live reserve at each endpoint", () => {
    expect(budgetFor("deep", CHECK_TERMINALIZE_MIN).runnerCutoffMs - ROUND_START).toBe(975_000);
    expect(budgetFor("deep", 10_000).runnerCutoffMs - ROUND_START).toBe(966_000);
    expect(budgetFor("deep", CHECK_TERMINALIZE_MAX).runnerCutoffMs - ROUND_START).toBe(946_000);
    expect(
      budgetFor("deep", CHECK_TERMINALIZE_MAX).runnerCutoffMs -
        budgetFor("deep", CHECK_TERMINALIZE_MIN).runnerCutoffMs,
    ).toBe(-(CHECK_TERMINALIZE_MAX - CHECK_TERMINALIZE_MIN));
  });

  test("the deep ceiling holds at the store's own maximum — raising it breaks this proof", () => {
    expect(RUNNER_MAX_BUDGET_MS.deep).toBeLessThanOrEqual(
      REVIEW_ATTEMPT_CAP_DEFAULT_MS - postRunnerReserveMs(CHECK_TERMINALIZE_MAX),
    );
  });

  test("preparation budget is what the round may spend before the cutoff", () => {
    const budget = budgetFor("deep", 10_000);
    expect(budget.preparationBudgetMs).toBe(budget.runnerCutoffMs - ROUND_START);
    expect(budget.roundEndMs).toBe(ROUND_START + REVIEW_ATTEMPT_CAP_DEFAULT_MS);
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
      expect(anchor.execDeadlineMs + budget.reserveMs).toBeLessThanOrEqual(budget.roundEndMs);
    }
  });

  test("a delayed start spends the cutoff, not the table (350s of setup at the default reserve)", () => {
    const budget = budgetFor("deep", 10_000);
    const anchor = anchorRunnerBudget(budget, ROUND_START + 350_000);
    expect(anchor.kind).toBe("allocated");
    if (anchor.kind !== "allocated") return;
    expect(anchor.effectiveBudgetMs).toBe(616_000);
    expect(anchor.execDeadlineMs).toBe(ROUND_START + 350_000 + 616_000);
    expect(anchor.execDeadlineMs + budget.reserveMs).toBe(budget.roundEndMs);
  });

  test("a start below the nominal floor keeps only the remaining wall clock", () => {
    const budget = budgetFor("deep", 10_000);
    const cutoff = budget.runnerCutoffMs;
    const anchor = anchorRunnerBudget(budget, cutoff - 10_000);
    expect(anchor.kind).toBe("allocated");
    if (anchor.kind !== "allocated") return;
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

    const atMax = anchorRunnerBudget(budget, ROUND_START, tierMax);
    expect(atMax.kind).toBe("allocated");
    if (atMax.kind === "allocated") {
      expect(atMax.effectiveBudgetMs).toBe(tierMax);
      expect(atMax.requestedBudgetMs).toBe(tierMax);
    }

    const over = anchorRunnerBudget(budget, ROUND_START, tierMax + 1);
    expect(over.kind).toBe("oversized");
    if (over.kind === "oversized") {
      expect(over.requestedBudgetMs).toBe(tierMax + 1);
      expect(over.tierMaxMs).toBe(tierMax);
    }
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
      expect("effectiveBudgetMs" in refused).toBe(false);
      expect("execDeadlineMs" in refused).toBe(false);
      expect("remainingMs" in refused).toBe(false);
    }
    expect(anchorRunnerBudget(budget, budget.runnerCutoffMs).kind).toBe("exhausted");
  });

  test("time spent on the input write and startup comes out of the one deadline", () => {
    const budget = budgetFor("deep", 10_000);
    const anchor = anchorRunnerBudget(budget, ROUND_START + 5_000);
    expect(anchor.kind).toBe("allocated");
    if (anchor.kind !== "allocated") return;
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

    expect("effectiveBudgetMs" in refused).toBe(false);
  });

  test("a smaller test cap moves the whole attempt, not the table", () => {
    const budget = deriveReviewBudget({
      roundStartMs: ROUND_START,
      deadlineMs: ROUND_START + 400_000,
      terminalizeMs: 10_000,
      level: "default",
    });
    expect(budget.roundEndMs).toBe(ROUND_START + 400_000);
    expect(budget.runnerCutoffMs).toBe(ROUND_START + 166_000);
    const anchor = anchorRunnerBudget(budget, ROUND_START);
    expect(anchor.kind).toBe("allocated");
    if (anchor.kind !== "allocated") return;
    expect(anchor.effectiveBudgetMs).toBe(166_000);
  });
});

describe("size-aware request: the tier ceiling at every size", () => {
  const size = (changedLines: number, workUnits: number) => ({ changedLines, workUnits });

  test("a zero-line diff requests the tier ceiling, not a refusal and not the floor", () => {
    for (const level of LEVELS) {
      const request = requestRunnerBudget(level, size(0, 0));
      expect(request.kind).toBe("requested");
      if (request.kind !== "requested") return;
      expect(request.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS[level]);
      expect(request.workUnits).toBe(0);
    }
  });

  test("a 44-line diff allocates the whole default ceiling — size never shrinks the window", () => {
    const request = requestRunnerBudget("default", size(44, 44));
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
    expect(request.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS.default);
    expect(request.workUnits).toBe(44);
    const budget = budgetFor("default", CHECK_TERMINALIZE_MAX);
    const anchor = anchorRunnerBudget(budget, ROUND_START, request.requestedBudgetMs);
    expect(anchor.kind).toBe("allocated");
    if (anchor.kind !== "allocated") return;
    expect(anchor.effectiveBudgetMs).toBe(RUNNER_MAX_BUDGET_MS.default);
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
    const request = requestRunnerBudget("default", size(0, 3));
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
    expect(request.workUnits).toBe(3);
    expect(request.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS.default);
  });

  test("a zero-text row beside real lines pays its own unit (the per-file minimum is per file)", () => {
    const size = parseNumstatSize("5\t0\ta.ts\n-\t-\tb.bin\n-\t-\tc.bin\n", false);
    expect(size).toEqual({ changedLines: 5, workUnits: 7 });
    const request = requestRunnerBudget("default", size);
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
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

  test("every interior size requests the tier ceiling on every tier — no ramp, no buckets", () => {
    for (const level of LEVELS) {
      for (const units of [1, 100, 1_000, 5_000, 10_000]) {
        const request = requestRunnerBudget(level, size(units, units));
        expect(request.kind).toBe("requested");
        if (request.kind !== "requested") return;
        expect(request.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS[level]);
      }
    }
  });

  test("malformed size input is invalid — never treated as an empty diff", () => {
    const badSizes: [number, number][] = [
      [-1, 0],
      [1.5, 2],
      [0, -1],
      [1, 0],
      [Number.MAX_SAFE_INTEGER + 1, 0],
    ];
    for (const level of LEVELS) {
      for (const [changedLines, workUnits] of badSizes) {
        const refused = requestRunnerBudget(level, size(changedLines, workUnits));
        expect(refused.kind).toBe("invalid");
        if (refused.kind !== "invalid") return;
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
    expect(request.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS.default);
    const anchor = anchorRunnerBudget(budget, ROUND_START, request.requestedBudgetMs);
    expect(anchor.kind).toBe("allocated");
    if (anchor.kind !== "allocated") return;
    expect(anchor.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS.default);
    expect(anchor.effectiveBudgetMs).toBe(RUNNER_MAX_BUDGET_MS.default);
  });

});

describe("admission windows cover the whole allocation range", () => {
  const size = (changedLines: number, workUnits: number) => ({ changedLines, workUnits });

  test("a measured small diff ends inside the earliest-acquired windows", () => {
    for (const level of LEVELS) {
      const budget = budgetFor(level, CHECK_TERMINALIZE_MAX);
      const request = requestRunnerBudget(level, size(0, 1));
      expect(request.kind).toBe("requested");
      if (request.kind !== "requested") return;
      const anchor = anchorRunnerBudget(budget, ROUND_START, request.requestedBudgetMs);
      expect(anchor.kind).toBe("allocated");
      if (anchor.kind !== "allocated") return;
      expect(anchor.effectiveBudgetMs).toBe(request.requestedBudgetMs);
      expect(anchor.execDeadlineMs + budget.reserveMs).toBeLessThanOrEqual(budget.roundEndMs);
      expect(budget.roundEndMs).toBeLessThanOrEqual(ROUND_START + budget.guardTtlSeconds * 1000);
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
      expect(anchor.execDeadlineMs + budget.reserveMs).toBeLessThanOrEqual(budget.roundEndMs);
      expect(budget.roundEndMs).toBeLessThanOrEqual(ROUND_START + budget.guardTtlSeconds * 1000);
    }
  });

  test("late start at the maximum terminalize: a spent preparation still leaves the tail inside both windows", () => {
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
    }
  });

  test("a small request never shortens either window — both read the ceiling, not the allocation", () => {
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
      expect(floor.effectiveBudgetMs).toBe(ceiling.effectiveBudgetMs);
      expect(floor.guardTtlSeconds).toBe(ceiling.guardTtlSeconds);
      expect(floor.checkWindowMs).toBe(ceiling.checkWindowMs);
      expect(floor.checkLeaseMs).toBe(ceiling.checkLeaseMs);
      expect(floor.guardTtlSeconds).toBe(reviewGuardTtlSeconds(level));
      expect(floor.checkWindowMs).toBe(CHECK_WINDOW_MS);
      expect(floor.checkLeaseMs).toBe(CHECK_WINDOW_MS);
    }
  });
});

describe("numstat size parse: complete vs truncated vs unknown", () => {
  test("a truncated tail row is unknown size — never an undersized complete set", () => {
    expect(parseNumstatSize("10\t2\tsrc/auth.ts\n5\t0\tsrc/docs.md", false)).toBeNull();
    expect(parseNumstatSize("10\t2\n", false)).toBeNull();
    expect(parseNumstatSize("10\t2\tsrc/auth.ts\n5\t0\tsrc/docs.md\n", false)).toEqual({
      changedLines: 17,
      workUnits: 17,
    });
  });

  test("a binary-only diff carries zero textual lines per file, not null", () => {
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
    expect(parseNumstatSize("", true)).toEqual({ changedLines: 0, workUnits: 0 });
    expect(parseNumstatSize("", false)).toBeNull();
    expect(parseNumstatSize(undefined, true)).toBeNull();
  });

  test("a negative or non-numeric count row is unknown size, never a count", () => {
    expect(parseNumstatSize("-3\t1\tsrc/auth.ts\n", false)).toBeNull();
    expect(parseNumstatSize("abc\t1\tsrc/auth.ts\n", false)).toBeNull();
    expect(parseNumstatSize("-\t1\tsrc/auth.ts\n", false)).toBeNull();
    expect(parseNumstatSize("1.5\t0\tsrc/auth.ts\n", false)).toBeNull();
    const request = requestRunnerBudget("default", parseNumstatSize("abc\t1\tx.ts\n", false));
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
    expect(request.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS.default);
  });

  test("a blank count or an empty path row is unknown size, never a count", () => {
    expect(parseNumstatSize("\t1\tfile\n", false)).toBeNull();
    expect(parseNumstatSize(" \t1\tfile\n", false)).toBeNull();
    expect(parseNumstatSize("1\t\tfile\n", false)).toBeNull();
    expect(parseNumstatSize("1\t0\t\n", false)).toBeNull();
    expect(parseNumstatSize("1\t0\t \n", false)).toBeNull();
    expect(parseNumstatSize("1\t0\ta.ts\n \n2\t0\tb.ts\n", false)).toBeNull();
  });

  test("a row with extra fields or an inexact count is unknown size — never a small allocation", () => {
    expect(parseNumstatSize("1\t0\tfile\textra\n", false)).toBeNull();
    expect(parseNumstatSize("9007199254740993\t0\tfile\n", false)).toBeNull();
    expect(
      parseNumstatSize("9007199254740991\t1\ta.ts\n9007199254740991\t1\tb.ts\n", false),
    ).toBeNull();
    const request = requestRunnerBudget(
      "default",
      parseNumstatSize("9007199254740993\t0\tfile\n", false),
    );
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
    expect(request.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS.default);
    expect(request.workUnits).toBeNull();
  });
  test("a trailing binary row after a near-maximum total is unknown size — the unit must not overflow", () => {
    expect(parseNumstatSize("9007199254740991\t0\ta.ts\n-\t-\tb.bin\n", false)).toBeNull();
    expect(parseNumstatSize("-\t-\tb.bin\n9007199254740991\t0\ta.ts\n", false)).toBeNull();
    const request = requestRunnerBudget(
      "default",
      parseNumstatSize("9007199254740991\t0\ta.ts\n-\t-\tb.bin\n", false),
    );
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") return;
    expect(request.requestedBudgetMs).toBe(RUNNER_MAX_BUDGET_MS.default);
    expect(request.workUnits).toBeNull();
  });
});
