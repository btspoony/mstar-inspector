/**
 * Review comment assembly tests (plan 06 Task 3 + Phase 5 B1/B4 +
 * postdeploy feedback T5) — pure functions only (the posting path needs a
 * live octokit; the consumer test covers the wiring).
 *
 * Acceptance points:
 *   - the model verdict is rendered as text in the body header (SEC-01 —
 *     the Issues comments API has no review event, so the prompt-injectable
 *     verdict can never map onto GitHub APPROVE/REQUEST_CHANGES)
 *   - summary_md truncated at 8000 chars
 *   - findings rendered with severity/category verbatim (enum SSOT)
 *   - omitted-findings footer when the severity cap dropped findings (B4)
 *   - the assembled body carries NO line-comment fields (overall review only)
 *   - T5 upsert: marker parse, create-on-miss, patch-on-hit with round
 *     increment, malformed marker treated as a miss
 */

import { describe, expect, test } from "bun:test";
import {
  buildReviewBody,
  buildUpsertBody,
  findReviewComment,
  parseReviewRound,
  planUpsert,
  renderFindings,
  SUMMARY_MD_LIMIT,
  truncateSummary,
} from "../../src/pipeline/comment";
import type { ReviewOutput } from "../../src/review/schema";

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
    // The posting path is the Issues comments API (T5) — a single overall
    // comment body, never line-comment structure.
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
describe("review comment upsert (T5)", () => {
  const output: ReviewOutput = {
    verdict: "request_changes",
    summary_md: "Two issues found in the diff.",
    findings: [],
  };

  describe("parseReviewRound", () => {
    test("parses a well-formed marker", () => {
      expect(parseReviewRound("<!-- mstar-inspector:review:v1 round=3 -->\n第 3 次 review · commit abc1234")).toBe(3);
    });

    test("returns null for a body without the marker", () => {
      expect(parseReviewRound("**Verdict: comment**")).toBeNull();
      expect(parseReviewRound("")).toBeNull();
    });

    test("returns null for a malformed marker (treated as a miss)", () => {
      expect(parseReviewRound("<!-- mstar-inspector:review:v1 round=abc -->")).toBeNull();
      expect(parseReviewRound("<!-- mstar-inspector:review:v1 -->")).toBeNull();
      expect(parseReviewRound("<!-- mstar-inspector:review:v1 round= -->")).toBeNull();
    });
  });

  describe("findReviewComment", () => {
    test("finds the first comment whose body starts with the marker prefix", () => {
      const comments = [
        { id: 1, body: "a human comment" },
        { id: 2, body: "<!-- mstar-inspector:review:v1 round=2 -->\n第 2 次 review" },
        { id: 3, body: "<!-- mstar-inspector:review:v1 round=1 -->\n第 1 次 review" },
      ];
      expect(findReviewComment(comments)).toEqual({ id: 2, body: comments[1]!.body });
    });

    test("returns null when no comment carries the marker", () => {
      expect(findReviewComment([{ id: 1, body: "hello" }, { id: 2, body: null }])).toBeNull();
      expect(findReviewComment([])).toBeNull();
    });
  });

  describe("planUpsert", () => {
    test("no marker comment → create with round=1", () => {
      expect(planUpsert([{ id: 1, body: "a human comment" }])).toEqual({ action: "create", round: 1 });
      expect(planUpsert([])).toEqual({ action: "create", round: 1 });
    });

    test("marker comment with round N → update that comment with round N+1", () => {
      expect(planUpsert([{ id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\n第 2 次 review" }])).toEqual({
        action: "update",
        commentId: 7,
        round: 3,
      });
    });

    test("malformed marker is treated as a miss → create with round=1", () => {
      expect(planUpsert([{ id: 7, body: "<!-- mstar-inspector:review:v1 round=abc -->" }])).toEqual({
        action: "create",
        round: 1,
      });
      expect(planUpsert([{ id: 7, body: "<!-- mstar-inspector:review:v1 -->" }])).toEqual({
        action: "create",
        round: 1,
      });
    });
  });

  describe("buildUpsertBody", () => {
    test("first line is the hidden marker, then the round header, then the review body", () => {
      const body = buildUpsertBody(output, 0, 2, "0123456789abcdef0123456789abcdef01234567");
      const lines = body.split("\n");
      expect(lines[0]).toBe("<!-- mstar-inspector:review:v1 round=2 -->");
      expect(lines[1]).toBe("第 2 次 review · commit 0123456");
      expect(body).toContain("**Verdict: request_changes**");
      expect(body).toContain("Two issues found in the diff.");
    });

    test("omitted-findings footer still renders after the review body", () => {
      const body = buildUpsertBody(output, 10, 1, "abc1234");
      expect(body.endsWith("\n\n*(+10 more findings omitted)*")).toBe(true);
    });
  });
});
