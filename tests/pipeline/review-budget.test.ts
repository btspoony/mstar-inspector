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
  deriveReviewBudget,
  RUNNER_MAX_BUDGET_MS,
  ROUND_BUDGET_MS,
  TERMINALIZE_MAX_MS,
  TERMINALIZE_MIN_MS,
  postRunnerReserveMs,
} from "../../src/review-budget";
import type { ReviewLevel } from "../../packages/shared/src/runtime";

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
  for (const terminalizeMs of [TERMINALIZE_MIN_MS, 10_000, TERMINALIZE_MAX_MS]) {
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
    expect(budgetFor("deep", TERMINALIZE_MIN_MS).runnerCutoffMs - ROUND_START).toBe(675_000);
    expect(budgetFor("deep", 10_000).runnerCutoffMs - ROUND_START).toBe(666_000);
    expect(budgetFor("deep", TERMINALIZE_MAX_MS).runnerCutoffMs - ROUND_START).toBe(646_000);
    // The reserve is charged 1:1, never rounded: the cutoff moves by exactly
    // the terminalize delta.
    expect(
      budgetFor("deep", TERMINALIZE_MAX_MS).runnerCutoffMs -
        budgetFor("deep", TERMINALIZE_MIN_MS).runnerCutoffMs,
    ).toBe(-(TERMINALIZE_MAX_MS - TERMINALIZE_MIN_MS));
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
