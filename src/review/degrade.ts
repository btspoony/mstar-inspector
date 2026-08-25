/**
 * Local summary fallback (plan 02 Task 3).
 *
 * When the model output cannot be parsed into a ReviewOutput, reviewDiff
 * degrades to summary mode (plan Clarify #4): verdict "comment", empty
 * findings, and a non-empty summary_md that prefers the raw assistant text
 * and falls back to a fixed sentence when the raw text is empty. The degrade
 * path never throws and never produces an empty summary.
 */

import type { ReviewOutput } from "./schema";

/** Fixed fallback sentence when the raw output is empty (plan Clarify #4). */
export const SUMMARY_FALLBACK_TEXT = "Review output could not be parsed.";

/**
 * Build the summary-mode ReviewOutput from the raw assistant text.
 * summary_md prefers the trimmed raw text; an empty raw text yields the
 * fixed fallback sentence.
 */
export function toSummaryFallback(raw: string): ReviewOutput {
  const trimmed = raw.trim();
  return {
    verdict: "comment",
    summary_md: trimmed.length > 0 ? trimmed : SUMMARY_FALLBACK_TEXT,
    findings: [],
  };
}
