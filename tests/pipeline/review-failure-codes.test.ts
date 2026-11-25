import { describe, expect, test } from "bun:test";

import { FAILURE_CODES, type FailureCode } from "../../src/contracts/failure-codes";
import { failureCodeOf } from "../../src/pipeline/review-attempt-execution";
import type { PhaseFailure } from "../../src/pipeline/review-attempt-execution";

const BASE = {
  stage: "pipeline" as const,
  headSha: null,
  runnerReturned: false,
  message: "mechanism detail for the operator",
};

const BUDGET_OUTCOME = {
  kind: "budget-exhausted" as const,
  cause: "consumer-deadline" as const,
  cappedBy: "level-budget" as const,
  tier: "default" as const,
  budgetMs: 233_000,
  seatsDispatched: 0,
  seatsStopped: 0,
  changedLines: null,
};

function failureOf(over: Partial<PhaseFailure> & Pick<PhaseFailure, "class">): PhaseFailure {
  const base = { ...BASE, phase: "prepare" as const, ...over };
  if (over.class === "budget") {
    return { ...base, class: "budget", window: "preparation", outcome: BUDGET_OUTCOME, sendAttemptPublicationId: null } as PhaseFailure;
  }
  if (over.class === "container-lost") {
    return { ...base, class: "container-lost", phase: "review" } as PhaseFailure;
  }
  if (over.class === "moved-head") {
    return { ...base, class: "moved-head", phase: "prepare" } as PhaseFailure;
  }
  if (over.class === "failure") {
    return { ...base, class: "failure", phase: "review", sendAttemptPublicationId: null } as PhaseFailure;
  }
  return {
    ...base,
    class: "unknown",
    phase: "review",
    containerStateUnknown: false,
    code: "review.container.unavailable",
  } as PhaseFailure;
}

describe("failureCodeOf — the single classification point", () => {
  test("a preparation-window budget stop spends the preparation budget", () => {
    expect(failureCodeOf(failureOf({ class: "budget", phase: "prepare" }))).toBe(
      "review.budget.preparation_spent",
    );
  });

  test("a runner-window budget stop spends the runner budget, wherever it was observed", () => {
    const runner: PhaseFailure = {
      ...BASE,
      class: "budget",
      phase: "review",
      window: "runner",
      outcome: { ...BUDGET_OUTCOME, budgetWindow: "runner", cause: "sandbox-kill" },
      sendAttemptPublicationId: null,
    };
    expect(failureCodeOf(runner)).toBe("review.budget.runner_spent");
  });

  test("a container proven lost after the launch claim is told apart from one lost before it", () => {
    expect(failureCodeOf(failureOf({ class: "container-lost", stage: "runner" }))).toBe(
      "review.container.lost_after_claim",
    );
    expect(failureCodeOf(failureOf({ class: "container-lost", stage: "sandbox" }))).toBe(
      "review.container.lost_before_paid",
    );
  });

  test("an ordinary or inconclusive stop classifies as unclassified, never as a made-up code", () => {
    expect(failureCodeOf(failureOf({ class: "failure" }))).toBe("review.internal.unclassified");
    expect(failureCodeOf(failureOf({ class: "moved-head" }))).toBe("review.internal.unclassified");
  });

  test("an unobservable outcome names WHICH incident it was, off the code the throw site chose", () => {
    const unknown = (code: FailureCode, containerStateUnknown = false): PhaseFailure => ({
      ...BASE,
      class: "unknown",
      phase: "review",
      containerStateUnknown,
      code,
    });
    expect(failureCodeOf(unknown("review.container.retired"))).toBe("review.container.retired");
    expect(failureCodeOf(unknown("review.paid.reply_lost", true))).toBe("review.paid.reply_lost");
    expect(failureCodeOf(unknown("review.container.unavailable"))).toBe("review.container.unavailable");
    // The four branches this round told apart, each reachable from a record alone.
    expect(failureCodeOf(unknown("review.container.lost_after_claim", true))).toBe(
      "review.container.lost_after_claim",
    );
    expect(failureCodeOf(unknown("review.container.lost_before_paid"))).toBe(
      "review.container.lost_before_paid",
    );
    expect(failureCodeOf(unknown("review.internal.unclassified"))).toBe("review.internal.unclassified");
  });

  test("the mapping is total: every class yields a member of the closed set", () => {
    const classes = ["budget", "unknown", "moved-head", "container-lost", "failure"] as const;
    for (const cls of classes) {
      const code: FailureCode = failureCodeOf(failureOf({ class: cls }));
      expect(FAILURE_CODES).toContain(code);
    }
    const unforeseen = { ...failureOf({ class: "failure" }), class: "not-a-class" } as unknown as PhaseFailure;
    expect(failureCodeOf(unforeseen)).toBe("review.internal.unclassified");
  });
});
