/**
 * Operator-facing failure codes — the ONE closed vocabulary a `review_failures`
 * row can be looked up by (`review_failures.error_code`), and the sentence a PR
 * author reads as the first line of that failure.
 *
 * Deliberately dependency-free: the Worker writes a code, the SPA renders one,
 * and neither should pull the other's graph in to name a failure.
 *
 * A summary states what happened AND whether anything was charged or published,
 * in plain words. It never names our mechanism (the sandbox, its markers, our
 * class names, our millisecond arithmetic): the mechanism stays in the row's
 * `error` detail, which the UI only shows inside the collapsed block.
 */

/** The closed set of operator-facing failure codes. Adding one is a deliberate act. */
export const FAILURE_CODES = [
  "review.config.unresolved",
  "review.container.unavailable",
  "review.container.lost_before_paid",
  "review.container.lost_after_claim",
  "review.container.retired",
  "review.budget.preparation_spent",
  "review.budget.runner_spent",
  "review.paid.reply_lost",
  "review.output.invalid",
  "review.output.degraded_published",
  "review.publish.deadline_spent",
  "review.github.rate_limited",
  "review.github.unavailable",
  "review.admission.refused",
  "review.delivery.deferred",
  "review.delivery.quota_exhausted",
  "review.delivery.entitlement_unreadable",
  "review.metering.unrecorded",
  "review.recheck.unaccounted",
  "review.internal.unclassified",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(FAILURE_CODES);

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && CODE_SET.has(value);
}

/** One plain sentence for a PR author: what happened, and whether it was charged. */
export const FAILURE_SUMMARIES: Record<FailureCode, string> = {
  "review.config.unresolved":
    "The review could not start because this repository's review setup is not usable. Nothing was charged; an operator has to fix the setup.",
  "review.container.unavailable":
    "The review environment could not be started. Nothing was charged; it will be retried.",
  "review.container.lost_before_paid":
    "The review environment was restarted before the review began. Nothing was charged. Ask for a review again, or push a new commit, to run a fresh attempt.",
  "review.container.lost_after_claim":
    "The review was interrupted right after it started, before it produced any result. Nothing was charged. Ask for a review again, or push a new commit, to run a fresh attempt.",
  "review.container.retired":
    "This review attempt was cancelled for good, so it will not run again. Nothing was charged; ask for a new review to retry.",
  "review.budget.preparation_spent":
    "This review did not get past its preparation within its time budget. Nothing was charged.",
  "review.budget.runner_spent":
    "This review used up its time budget while analysing the changes. Nothing was published.",
  "review.paid.reply_lost":
    "The review process was started but its result never came back. Whether it finished is unknown, and nothing was published.",
  "review.output.invalid":
    "The review finished but its result was not a readable review. Nothing was published.",
  "review.output.degraded_published":
    "The review result was not readable as a normal review, so a reduced review was posted instead. No normal review was published.",
  "review.publish.deadline_spent":
    "The review finished its analysis, but there was no time left to publish it. Nothing was published.",
  "review.github.rate_limited":
    "GitHub asked the bot to slow down before the review could be published. Nothing was published; the next review may go through.",
  "review.github.unavailable":
    "GitHub could not be reached while the review was being published. Nothing was published; it will be retried.",
  "review.admission.refused":
    "This commit was not reviewed: another review already holds a slot for this pull request, or the workspace's limit on concurrent reviews was reached. Nothing was charged.",
  "review.delivery.deferred":
    "This commit was not reviewed: the platform was closed and the queued delivery expired. Nothing was charged.",
  "review.delivery.quota_exhausted":
    "This commit was not reviewed: the workspace's review quota for this period is used up. Nothing was charged.",
  "review.delivery.entitlement_unreadable":
    "This commit was not reviewed: the bot could not confirm its access to this repository. Nothing was charged.",
  "review.metering.unrecorded":
    "The review's usage row was recorded late or more than once. Usage figures may be off; the review itself is unaffected and nothing extra was charged.",
  "review.recheck.unaccounted":
    "A follow-up check could not be reconciled. The review result stands and nothing extra was charged; the check may need a manual re-run.",
  "review.internal.unclassified":
    "The review stopped for a reason that has not been classified yet. Whether anything was charged is unknown; an operator can look it up by this code.",
};
