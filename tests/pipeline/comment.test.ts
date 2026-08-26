/**
 * Review comment assembly tests (plan 06 Task 3 + Phase 5 B1/B4) — pure
 * functions only (the posting path needs a live octokit; the consumer test
 * covers the wiring).
 *
 * Acceptance points:
 *   - every review is posted with event COMMENT (SEC-01 fix — the model
 *     verdict must never map onto GitHub APPROVE/REQUEST_CHANGES)
 *   - the model verdict is rendered as text in the body header
 *   - summary_md truncated at 8000 chars
 *   - findings rendered with severity/category verbatim (enum SSOT)
 *   - omitted-findings footer when the severity cap dropped findings (B4)
 *   - the assembled body carries NO line-comment fields (overall review only)
 */

import { describe, expect, test } from "bun:test";
import {
  buildReviewBody,
  renderFindings,
  REVIEW_EVENT,
  SUMMARY_MD_LIMIT,
  truncateSummary,
} from "../../src/pipeline/comment";
import type { ReviewOutput } from "../../src/review/schema";

describe("review event (SEC-01)", () => {
  test("every posting uses COMMENT — the model verdict is never mapped onto APPROVE/REQUEST_CHANGES", () => {
    expect(REVIEW_EVENT).toBe("COMMENT");
  });
});

describe("truncateSummary", () => {
  test("keeps summaries at or under the 8000-char budget verbatim", () => {
    expect(truncateSummary("short")).toBe("short");
    expect(truncateSummary("x".repeat(SUMMARY_MD_LIMIT))).toHaveLength(SUMMARY_MD_LIMIT);
  });

  test("truncates over-budget summaries to the 8000-char budget", () => {
    const long = "x".repeat(SUMMARY_MD_LIMIT + 100);
    const truncated = truncateSummary(long);
    expect(truncated.length).toBe(SUMMARY_MD_LIMIT); // budget incl. ellipsis
    expect(truncated.startsWith("x".repeat(SUMMARY_MD_LIMIT - 1))).toBe(true);
    expect(truncated.endsWith("…")).toBe(true);
  });
});

describe("renderFindings", () => {
  test("renders severity/category verbatim with location and body", () => {
    const md = renderFindings([
      {
        severity: "critical",
        category: "security",
        file_path: "src/auth.ts",
        line_start: 21,
        line_end: 21,
        title: "Secrets in code",
        body: "A token is hardcoded.",
      },
    ]);
    expect(md).toContain("**[critical] Secrets in code**");
    expect(md).toContain("(security)");
    expect(md).toContain("src/auth.ts:21");
    expect(md).toContain("A token is hardcoded.");
  });

  test("renders repo-wide when the finding has no file scope", () => {
    const md = renderFindings([
      {
        severity: "info",
        category: "style",
        file_path: null,
        line_start: null,
        line_end: null,
        title: "Nit",
        body: "",
      },
    ]);
    expect(md).toContain("repo-wide");
    expect(md).toContain("**[info] Nit**");
  });

  test("returns an empty string for no findings", () => {
    expect(renderFindings([])).toBe("");
  });
});

describe("buildReviewBody", () => {
  const output: ReviewOutput = {
    verdict: "request_changes",
    summary_md: "Two issues found in the diff.",
    findings: [
      {
        severity: "warning",
        category: "logic",
        file_path: "src/auth.ts",
        line_start: 21,
        line_end: 21,
        title: "Fractional expiry comparison",
        body: "`claims.exp < Date.now() / 1000` compares against a fractional value.",
      },
    ],
  };

  test("renders the verdict as text in the body header (SEC-01)", () => {
    const body = buildReviewBody(output);
    expect(body.startsWith("**Verdict: request_changes**")).toBe(true);
    expect(body).toContain("Two issues found in the diff.");
    expect(body).toContain("## Findings");
    expect(body).toContain("**[warning] Fractional expiry comparison**");
  });

  test("carries NO line-comment fields (overall review body only)", () => {
    const body = buildReviewBody(output);
    // The posting path is the Reviews API (pulls.createReview), not the
    // line-comments API — the body must not smuggle line-comment structure.
    expect(body).not.toContain("line_comment");
    expect(body).not.toContain('"position"');
    expect(body).not.toContain('"side"');
    expect(body).not.toContain('"line"');
  });

  test("empty findings → verdict header + summary only, no findings section", () => {
    const body = buildReviewBody({ ...output, findings: [] });
    expect(body).toBe("**Verdict: request_changes**\n\nTwo issues found in the diff.");
    expect(body).not.toContain("## Findings");
  });

  test("over-budget summary is truncated inside the body", () => {
    const body = buildReviewBody({ ...output, summary_md: "x".repeat(SUMMARY_MD_LIMIT + 50) });
    expect(body.length).toBeLessThan(SUMMARY_MD_LIMIT + 200);
    expect(body).toContain("…\n\n## Findings");
  });

  test("omitted-findings count renders as a body footer (B4)", () => {
    const body = buildReviewBody(output, 10);
    expect(body.endsWith("\n\n*(+10 more findings omitted)*")).toBe(true);
  });

  test("no footer when nothing was omitted (B4)", () => {
    const body = buildReviewBody(output, 0);
    expect(body).not.toContain("more findings omitted");
  });
});
