/**
 * reviewDiff — the single entry point for M1 (plan 02 Task 3).
 *
 * Runs one omp review session against a unified diff, parses the raw model
 * output into a validated ReviewOutput, and degrades to summary mode when
 * parsing fails (plan Clarify #4). Structured mode requires parseReviewOutput
 * to succeed; any parse/validation failure yields summary mode with the raw
 * text as the summary — never a crash, never an empty output.
 */

import { toSummaryFallback } from "./degrade";
import { parseReviewOutput, type ReviewOutput } from "./schema";
import { runReviewSession } from "./session";

export type ReviewMode = "structured" | "summary";

export type ReviewDiffResult = {
  mode: ReviewMode;
  result: ReviewOutput;
};

/**
 * Review a unified diff and return either a schema-validated ReviewOutput
 * (structured) or a summary-only fallback (summary). Never throws for
 * unparseable model output.
 */
export async function reviewDiff(diffText: string): Promise<ReviewDiffResult> {
  const raw = await runReviewSession(diffText);
  const parsed = parseReviewOutput(raw);
  if (parsed.ok) {
    return { mode: "structured", result: parsed.output };
  }
  return { mode: "summary", result: toSummaryFallback(raw) };
}
