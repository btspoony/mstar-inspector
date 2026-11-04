/**
 * Review comment assembly tests (Phase 5 B1/B4 + postdeploy feedback T5) —
 * pure functions (the posting wiring is covered with a mock octokit; see
 * "postReview wiring" below).
 *
 * Acceptance points:
 *   - the body layout is the ENGINE's (`renderReviewMarkdown`): verdict head,
 *     tally table, `## 📋 Review` with the seat narrative, and one
 *     `#### <emoji> <title>` block per finding in envelope order. This module
 *     never re-renders it, so no verdict, score, tally or finding title
 *     appears twice;
 *   - the harness verdict is never mapped onto a GitHub review event
 *     (SEC-01, structural; mapping spec §2);
 *   - the Inspector-only tail survives: the omitted-findings footer and the
 *     assembled §7.10 closure section;
 *   - summary_md truncated at 8000 chars before the engine renders it, so a
 *     long narrative cannot push the findings and the closure off the end;
 *   - the assembled body carries NO line-comment fields (overall review only)
 *   - T5 upsert: marker parse, create-on-miss, patch-on-hit with round
 *     increment, malformed marker treated as a miss (same PR never gets a
 *     new comment per round)
 *   - postReview wiring (WF-001/WF-003/SG-001): paginated scan, create vs
 *     update dispatch, 404 soft-recovery fallback
 * - deep lock: a deep-path envelope (parent-session yield,
 *     same mstar.review/v1 shape) posts through the SAME COMMENT/upsert
 *     path — `pulls.createReview` is present on the client but never
 *     called, and no call carries `event` / APPROVE / REQUEST_CHANGES
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderReviewMarkdown } from "@mstar-harness/engine";
import type { ReportDoc } from "../../packages/shared/src/report-wire";
import {
  buildClosureSection,
  buildDegradedBody,
  buildPreparedDegradedBody,
  buildPreparedReviewBody,
  buildPublicationMarker,
  buildRevalidatedSection,
  buildReviewBody,
  insertReportSections,
  CLOSURE_MAX_ROWS,
  createReviewCommenter,
  DEGRADED_EXCERPT_LIMIT,
  findDegradedComment,
  findDegradedComments,
  findReviewComment,
  parseDegradedRound,
  parseReviewRound,
  planDegradedUpsert,
  planDegradedUpsertWithOctokit,
  planUpsert,
  planReviewUpsertWithOctokit,
  postPreparedDegradedWithOctokit,
  postPreparedReviewWithOctokit,
  deleteDegradedCommentWithOctokit,
  REVIEW_BODY_LIMIT,
  SUMMARY_MD_LIMIT,
  truncateSummary,
  type ClosureCoverage,
  type ClosureRow,
  type CommenterFetch,
  type PostOctokit,
} from "../../src/pipeline/comment";
import type { ReviewFinding, ReviewOutput } from "../../src/review/schema";
import { testAppPem } from "../helpers/rsa-key";

function finding(mergeClass: ReviewFinding["mergeClass"], title: string): ReviewFinding {
  return {
    mergeClass,
    category: "logic",
    file_path: "src/auth.ts",
    line_start: 21,
    line_end: 21,
    title,
    body: `\`${title}\` body.`,
  };
}

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

describe("buildReviewBody", () => {
  const output: ReviewOutput = {
    schema: "mstar.review/v1",
    verdict: "needs fixes",
    summary_md: "Two issues found in the diff.",
    findings: [finding("should-fix", "Fractional expiry comparison")],
  };

  test("the engine renders the verdict head, the narrative and one finding block", () => {
    const body = buildReviewBody(output);
    expect(body.startsWith("## ⚠️ Verdict: `needs fixes`")).toBe(true);
    expect(body).toContain("## 📋 Review\n\nTwo issues found in the diff.");
    expect(body).toContain("### Findings");
    expect(body).toContain("#### 🟠 Fractional expiry comparison");
    expect(body).toContain("- **Evidence**: `Fractional expiry comparison` body.");
    expect(body).toContain("- **Location**: `src/auth.ts:21`");
    expect(body).toContain("- **Category**: logic");
    expect(body).toContain("- **Merge class**: should-fix");
  });

  test("nothing is duplicated: verdict, score and each finding title appear exactly once", () => {
    const body = buildReviewBody({
      ...output,
      findings: [finding("must-fix", "Unbounded loop"), finding("nit", "Naming")],
      tally: {
        verdict: "needs fixes",
        scorePct: 45,
        tally: { mustFix: 1, shouldFix: 0, nit: 1, unverified: 0 },
        chatHeader: "unused here",
      },
    });
    expect(body.match(/Verdict:/g)).toHaveLength(1);
    expect(body.match(/Score 45%/g)).toHaveLength(1);
    expect(body.match(/^#### .*Unbounded loop$/gm)).toHaveLength(1);
    expect(body.match(/^#### .*Naming$/gm)).toHaveLength(1);
    expect(body).not.toContain("**Tally:**");
  });

  test("blocked and ship it verdicts never carry REQUEST_CHANGES/APPROVE mapping", () => {
    for (const verdict of ["blocked", "ship it"] as const) {
      const body = buildReviewBody({ ...output, verdict });
      expect(body).toContain(`Verdict: \`${verdict}\``);
      expect(body).not.toContain("REQUEST_CHANGES");
      expect(body).not.toContain("APPROVE");
    }
  });

  test("the tally table renders when the envelope carries one, and only then", () => {
    const withTally = buildReviewBody({
      ...output,
      tally: {
        verdict: "needs fixes",
        scorePct: 45,
        tally: { mustFix: 0, shouldFix: 2, nit: 1, unverified: 1 },
        chatHeader: "unused here",
      },
    });
    expect(withTally).toContain("## ⚠️ Verdict: `needs fixes` · Score 45% (fail)");
    expect(withTally).toContain("| Findings | Count |");
    expect(withTally).toContain("| 🟠 should-fix | 2 |");
    expect(withTally).toContain("| ❓ unverified | 1 |");
    expect(buildReviewBody(output)).not.toContain("| Findings | Count |");
  });

  test("finding blocks keep the envelope's order, never re-sorted by merge class", () => {
    // Seats rank by impact-if-shipped; a class re-sort would override that.
    const body = buildReviewBody({
      ...output,
      findings: [finding("nit", "First by impact"), finding("must-fix", "Second by impact")],
    });
    expect(body.indexOf("First by impact")).toBeGreaterThan(-1);
    expect(body.indexOf("Second by impact")).toBeGreaterThan(body.indexOf("First by impact"));
  });

  test("no summary_md → the bare `## 📋 Review` heading, never a fabricated summary", () => {
    const body = buildReviewBody({ ...output, summary_md: undefined });
    expect(body).toContain("## 📋 Review\n\n### Findings");
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

  test("empty findings → no findings section, the Review heading still present", () => {
    const body = buildReviewBody({ ...output, findings: [] });
    expect(body).toContain("## 📋 Review");
    expect(body).not.toContain("### Findings");
  });

  test("omitted-findings count renders as a footer after the engine body (B4)", () => {
    const body = buildReviewBody(output, 10);
    expect(body.endsWith("\n\n*(+10 more findings omitted)*")).toBe(true);
  });

  test("no footer when nothing was omitted (B4)", () => {
    const body = buildReviewBody(output, 0);
    expect(body).not.toContain("more findings omitted");
  });

  test("a summary that restates the fact pair is stripped, so the pair renders once", () => {
    const incomplete = { reason: "runner timed out", unscanned: ["tests/a.ts"] };
    const body = buildReviewBody({
      ...output,
      verdict: "incomplete",
      findings: [],
      incomplete,
      summary_md: "The runner died.\n\ncause: runner timed out\nunscanned: tests/a.ts",
    });
    expect(body.match(/^cause:/gm)).toHaveLength(1);
    expect(body.match(/^unscanned:/gm)).toHaveLength(1);
    expect(body).toContain("The runner died.");
  });

  test("an echo of the UNBOUNDED fact is stripped too, so a long reason cannot duplicate", () => {
    const longReason = "r".repeat(900);
    const body = buildReviewBody({
      ...output,
      verdict: "incomplete",
      findings: [],
      incomplete: { reason: longReason, unscanned: ["tests/a.ts"] },
      summary_md: `The run died.\n\ncause: ${longReason}\nunscanned: tests/a.ts`,
    });
    expect(body).toContain("The run died.");
    expect(body.match(/^cause: /gm)).toHaveLength(1);
    expect(body.match(/^unscanned: /gm)).toHaveLength(1);
  });

  test("an over-budget unchecked scope still names entries and counts the rest", () => {
    const scopes = Array.from({ length: 40 }, (_, index) => `src/very-long-directory-name/file-${index}.ts`);
    const body = buildReviewBody({
      ...output,
      verdict: "incomplete",
      findings: [],
      incomplete: { reason: "runner timed out", unscanned: scopes },
    });
    const line = body.split("\n").find((l) => l.startsWith("unscanned: "))!;
    expect(line.length).toBeLessThanOrEqual("unscanned: ".length + 500);
    expect(line).toMatch(/file-\d+\.ts/);
    expect(line).toContain("more)");
  });

  test("an empty unscanned scope stays empty through the bound", () => {
    const body = buildReviewBody({
      ...output,
      verdict: "incomplete",
      findings: [],
      incomplete: { reason: "runner timed out", unscanned: [] },
    });
    expect(body).toContain("unscanned: none");
    expect(body.match(/^unscanned: /gm)).toHaveLength(1);
  });

  test("a single scope too long to fit is still named, cut to the budget", () => {
    const one = `src/${"n".repeat(1200)}.ts`;
    const body = buildReviewBody({
      ...output,
      verdict: "incomplete",
      findings: [],
      incomplete: { reason: "runner timed out", unscanned: [one] },
    });
    const line = body.split("\n").find((l) => l.startsWith("unscanned: "))!;
    expect(line).toContain("src/");
    expect(line.endsWith("…")).toBe(true);
    expect((line.match(/<details>/g) ?? []).length).toBe(0);
  });

  test("the fact-line cut never leaves a lone surrogate", () => {
    // A run of astral-plane characters (each two UTF-16 units) sized so the
    // budget cut lands between a pair unless the slice backs off.
    const reason = "\u{1F600}".repeat(400);
    const body = buildReviewBody({
      ...output,
      verdict: "incomplete",
      findings: [],
      incomplete: { reason, unscanned: ["a.ts"] },
    });
    const line = body.split("\n").find((l) => l.startsWith("cause: "))!;
    // A lone surrogate is a high half with no low half after it, or a low half
    // with no high half before it. slice() produces one; the guard does not.
    expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(line).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(line.endsWith("…")).toBe(true);
  });

  test("bounding the fact keeps the envelope's tally mirror in step", () => {
    const raw = "r".repeat(900);
    const body = buildReviewBody({
      ...output,
      verdict: "incomplete",
      findings: [],
      incomplete: { reason: raw, unscanned: ["a.ts"] },
      tally: {
        verdict: "incomplete",
        scorePct: 50,
        band: "fail",
        tally: { mustFix: 0, shouldFix: 0, nit: 0, unverified: 1 },
        chatHeader: "incomplete · 50% (fail)",
        incomplete: { reason: raw, unscanned: ["a.ts"] },
      },
    });
    expect(body.match(/^cause: /gm)).toHaveLength(1);
    expect(body).not.toContain(raw.slice(0, 600));
  });
  test("a summary line that only opens with the label is the model's own content", () => {
    const incomplete = { reason: "runner timed out", unscanned: [] };
    const body = buildReviewBody({
      ...output,
      verdict: "incomplete",
      findings: [],
      incomplete,
      summary_md: "  cause: runner timed out (indented snippet)\nCause: capitalised prose",
    });
    expect(body).toContain("  cause: runner timed out (indented snippet)");
    expect(body).toContain("Cause: capitalised prose");
    expect(body.match(/^cause:/gm)).toHaveLength(1);
  });

  test("a narrative over the summary budget is cut, so the tail survives the body clamp", () => {
    // The runner fits its coverage notes to SUMMARY_MD_LIMIT and relies on this
    // publisher keeping the head from there; without the cut the body clamp —
    // which also keeps the head — would be what removes the closure.
    const closure = "## Prior findings recheck\n\nReassessed 1/1";
    const body = buildReviewBody(
      { ...output, summary_md: "x".repeat(REVIEW_BODY_LIMIT * 2) },
      3,
      closure,
    );
    expect(body).toContain("more findings omitted");
    expect(body).toContain(closure);
    expect(body.length).toBeLessThanOrEqual(REVIEW_BODY_LIMIT);
  });

  test("an over-long incomplete reason is bounded, so the tail survives the body clamp", () => {
    const closure = "## Prior findings recheck\n\nReassessed 1/1";
    const body = buildReviewBody(
      {
        ...output,
        verdict: "incomplete",
        findings: [],
        incomplete: { reason: "z".repeat(REVIEW_BODY_LIMIT * 2), unscanned: ["a.ts"] },
      },
      0,
      closure,
    );
    expect(body).toContain(closure);
    expect(body.length).toBeLessThanOrEqual(REVIEW_BODY_LIMIT);
    expect(body.match(/^cause: /gm)).toHaveLength(1);
  });

  test("a narrative carrying its own fold is closed when the body truncates it", () => {
    const narrative = `<details><summary>deep</summary>\n\n${"w".repeat(SUMMARY_MD_LIMIT * 2)}`;
    const body = buildReviewBody({ ...output, summary_md: narrative });
    expect((body.match(/<details>/g) ?? []).length).toBe((body.match(/<\/details>/g) ?? []).length);
  });

  test("bounding the fact never touches the stored document", () => {
    const raw = "r".repeat(900);
    const stored: ReviewOutput = {
      ...output,
      verdict: "incomplete",
      findings: [],
      incomplete: { reason: raw, unscanned: ["a.ts", "b.ts"] },
    };
    const snapshot = JSON.stringify(stored);
    buildReviewBody(stored);
    expect(JSON.stringify(stored)).toBe(snapshot);
    expect(stored.incomplete!.reason).toBe(raw);
  });

  test("the closure section is appended last", () => {
    const body = buildReviewBody(output, 10, "## Prior findings recheck\n\nReassessed 1/1");
    expect(body.endsWith("\n\n## Prior findings recheck\n\nReassessed 1/1")).toBe(true);
    expect(body.indexOf("more findings omitted")).toBeLessThan(body.indexOf("Prior findings recheck"));
  });

  test("incomplete verdict renders the engine's cause + unscanned pair exactly once", () => {
    const incomplete = { reason: "runner timed out", unscanned: ["tests/a.ts", "src/b.ts"] };
    const body = buildReviewBody({ ...output, verdict: "incomplete", findings: [], incomplete });
    expect(body).toContain("cause: runner timed out\nunscanned: tests/a.ts, src/b.ts");
    expect(body.match(/^cause:/gm)).toHaveLength(1);
    expect(body.match(/^unscanned:/gm)).toHaveLength(1);
    // Engine order: head, fact pair, review section.
    expect(body.indexOf("Verdict: `incomplete`")).toBeLessThan(body.indexOf("cause: runner timed out"));
    expect(body.indexOf("cause: runner timed out")).toBeLessThan(body.indexOf("## 📋 Review"));
  });

  test("other verdicts never gain the fact pair", () => {
    for (const verdict of ["ship it", "needs fixes", "blocked"] as const) {
      const body = buildReviewBody({ ...output, verdict });
      expect(body).not.toContain("cause:");
      expect(body).not.toContain("unscanned:");
    }
  });
});

describe("buildClosureSection", () => {
  const coverage: ClosureCoverage = {
    totalOpen: 3,
    selected: 2,
    assessed: 1,
    invalidOutput: 0,
    omitted: 1,
    capped: 0,
    contextCoverage: "complete",
  };
  const rows: ClosureRow[] = [
    {
      title: "Fractional expiry comparison",
      disposition: "addressed",
      reason: "verified-fix",
      evidenceKind: "diff",
      thread: "-",
    },
  ];

  test("folds into details, keeping the heading and the table inside the fold", () => {
    const md = buildClosureSection(coverage, rows);
    expect(
      md.startsWith("<details>\n<summary>Prior findings recheck — 1/2 reassessed, 3 open</summary>\n\n"),
    ).toBe(true);
    expect(md.endsWith("\n\n</details>")).toBe(true);
    expect(md).toContain("## Prior findings recheck");
    expect(md).toContain("Reassessed 1/2 open prior finding(s) this round");
    expect(md).toContain("| finding | disposition | evidence | thread |");
    expect(md).toContain("| Fractional expiry comparison | addressed (verified-fix) | diff | - |");
  });

  test("the coverage line publishes every selected row exactly once", () => {
    // The identity the line promises: assessed + invalid-output + omitted ===
    // selected. Here 1 assessed + 1 invalid-output + 0 omitted on 2 selected.
    const md = buildClosureSection({ ...coverage, invalidOutput: 1, omitted: 0 }, rows);
    expect(md).toContain("Reassessed 1/2 open prior finding(s) this round · 1 invalid-output · 0 omitted");
  });

  test("empty rows still carry the coverage line inside the fold", () => {
    const md = buildClosureSection({ ...coverage, selected: 0, assessed: 0 }, []);
    expect(md.startsWith("<details>")).toBe(true);
    expect(md).toContain("Reassessed 0/0 open prior finding(s) this round");
    expect(md).not.toContain("| finding |");
    expect(md.endsWith("</details>")).toBe(true);
  });

  test("the over-cap overflow line stays inside the fold, after the table", () => {
    const many: ClosureRow[] = Array.from({ length: CLOSURE_MAX_ROWS + 2 }, (_, index) => ({
      ...rows[0]!,
      title: `Finding ${index}`,
    }));
    const md = buildClosureSection({ ...coverage, totalOpen: many.length }, many);
    expect(md.indexOf("*(+2 more prior finding(s)")).toBeGreaterThan(md.indexOf("| Finding 0 |"));
    expect(md.indexOf("*(+2 more prior finding(s)")).toBeLessThan(md.lastIndexOf("</details>"));
  });
});

describe("review comment upsert (T5)", () => {
  const output: ReviewOutput = {
    schema: "mstar.review/v1",
    verdict: "blocked",
    summary_md: "One must-fix blocks the merge.",
    findings: [],
  };

  describe("parseReviewRound", () => {
    test("parses a well-formed marker", () => {
      expect(parseReviewRound("<!-- mstar-inspector:review:v1 round=3 -->\nReview 3 · commit abc1234")).toBe(3);
    });

    test("returns null for a body without the marker", () => {
      expect(parseReviewRound("## ⛔ Verdict: `blocked`")).toBeNull();
      expect(parseReviewRound("")).toBeNull();
    });

    test("returns null for a malformed marker (treated as a miss)", () => {
      expect(parseReviewRound("<!-- mstar-inspector:review:v1 round=abc -->")).toBeNull();
      expect(parseReviewRound("<!-- mstar-inspector:review:v1 -->")).toBeNull();
      expect(parseReviewRound("<!-- mstar-inspector:review:v1 round= -->")).toBeNull();
    });
  });

  // F-002: a marker comment is only PATCHable when a bot account (our
  // GitHub App user) authored it. Any PR participant can plant the marker
  // text on a human account — such comments are misses, never update
  // targets; excluded ids model the 403/404 recovery replan.
  const botMarker = (id: number, round: number) => ({
    id,
    body: `<!-- mstar-inspector:review:v1 round=${round} -->\nReview ${round}`,
    user: { type: "Bot" },
  });

  describe("findReviewComment", () => {
    test("finds the first bot-authored comment whose body starts with the marker prefix", () => {
      const comments = [
        { id: 1, body: "a human comment", user: { type: "User" } },
        botMarker(2, 2),
        botMarker(3, 1),
      ];
      expect(findReviewComment(comments)).toEqual({ id: 2, body: comments[1]!.body });
    });

    test("returns null when no comment carries the marker", () => {
      expect(findReviewComment([{ id: 1, body: "hello", user: { type: "User" } }, { id: 2, body: null }])).toBeNull();
      expect(findReviewComment([])).toBeNull();
    });

    test("a human-planted marker (user.type User) is NEVER a hit (qc2 F-002)", () => {
      const comments = [{ id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\nplanted", user: { type: "User" } }];
      expect(findReviewComment(comments)).toBeNull();
    });

    test("a comment with no user info is not provably app-authored → miss", () => {
      expect(findReviewComment([{ id: 7, body: "<!-- mstar-inspector:review:v1 round=1 -->" }])).toBeNull();
    });

    test("excluded ids are skipped (403/404 recovery replans past dead comments)", () => {
      const comments = [botMarker(2, 2), botMarker(3, 1)];
      expect(findReviewComment(comments, new Set([2]))).toEqual({ id: 3, body: comments[1]!.body });
      expect(findReviewComment(comments, new Set([2, 3]))).toBeNull();
    });
  });

  describe("planUpsert", () => {
    test("no marker comment → create with round=1", () => {
      expect(planUpsert([{ id: 1, body: "a human comment" }])).toEqual({ action: "create", round: 1 });
      expect(planUpsert([])).toEqual({ action: "create", round: 1 });
    });

    test("bot marker comment with round N → update that comment with round N+1", () => {
      expect(planUpsert([botMarker(7, 2)])).toEqual({ action: "update", commentId: 7, round: 3 });
    });

    test("malformed marker is treated as a miss → create with round=1", () => {
      expect(planUpsert([{ id: 7, body: "<!-- mstar-inspector:review:v1 round=abc -->", user: { type: "Bot" } }])).toEqual({
        action: "create",
        round: 1,
      });
      expect(planUpsert([{ id: 7, body: "<!-- mstar-inspector:review:v1 -->", user: { type: "Bot" } }])).toEqual({
        action: "create",
        round: 1,
      });
    });

    test("human-planted marker with the bot marker excluded → create with round=1 (qc2 F-002)", () => {
      const comments = [
        { id: 9, body: "<!-- mstar-inspector:review:v1 round=2 -->\nplanted", user: { type: "User" } },
        botMarker(7, 2),
      ];
      expect(planUpsert(comments, new Set([7]))).toEqual({ action: "create", round: 1 });
    });
  });

  describe("buildPreparedReviewBody", () => {
    const publicationMarker = buildPublicationMarker({
      publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      kind: "review",
    });

    test("round marker first, body, then the header as the trailer above the publication marker", () => {
      const body = buildPreparedReviewBody({
        output,
        omittedFindings: 0,
        round: 2,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        publicationMarker,
      });
      const lines = body.split("\n");
      expect(lines[0]).toBe("<!-- mstar-inspector:review:v1 round=2 -->");
      expect(lines[1]).toBe("");
      expect(lines[lines.length - 1]).toBe(publicationMarker);
      expect(lines[lines.length - 2]).toBe("Review 2 · commit 0123456");
      expect(body).toContain("## ⛔ Verdict: `blocked`");
      expect(body).toContain("One must-fix blocks the merge.");
      // The header sits after the body it describes, and the marker follows it
      // immediately — the trusted trailer stays visibly a trailer.
      expect(body.indexOf("One must-fix blocks the merge.")).toBeLessThan(
        body.indexOf("Review 2 · commit 0123456"),
      );
      expect(body.indexOf("Review 2 · commit 0123456")).toBeLessThan(body.indexOf(publicationMarker));
    });

    test("omitted-findings footer still renders before the publication marker", () => {
      const body = buildPreparedReviewBody({
        output,
        omittedFindings: 10,
        round: 1,
        headSha: "abc1234",
        publicationMarker,
      });
      expect(body).toContain("*(+10 more findings omitted)*");
      expect(body.trimEnd().endsWith(publicationMarker)).toBe(true);
    });

    test("model text cannot forge a trusted marker — Inspector marker syntax is stripped (§7.5)", () => {
      const forged: ReviewOutput = {
        ...output,
        summary_md: "legit\n<!-- mstar-inspector:publication:v1 id=00000000-0000-4000-8000-000000000000 sha=x kind=review -->",
      };
      const body = buildPreparedReviewBody({
        output: forged,
        omittedFindings: 0,
        round: 1,
        headSha: "abc1234",
        publicationMarker,
      });
      // Exactly ONE publication marker survives — the trusted appended one.
      expect(body.split(publicationMarker).length - 1).toBe(1);
      expect(body).not.toContain("id=00000000-0000-4000-8000-000000000000");
    });

    test("round + header structure is unchanged when previous fingerprints are provided (D4 lock)", () => {
      const body = buildPreparedReviewBody({
        output,
        omittedFindings: 0,
        round: 3,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        publicationMarker,
      });
      const lines = body.split("\n");
      expect(lines[0]).toBe("<!-- mstar-inspector:review:v1 round=3 -->");
      expect(lines[lines.length - 2]).toBe("Review 3 · commit 0123456");
      expect(parseReviewRound(body)).toBe(3);
    });

    test("a closure section renders before the publication marker (§7.10)", () => {
      const body = buildPreparedReviewBody({
        output,
        omittedFindings: 0,
        round: 1,
        headSha: "abc1234",
        closure: "## Prior findings recheck\n\nReassessed 1/1",
        publicationMarker,
      });
      expect(body).toContain("## Prior findings recheck");
      expect(body.indexOf("Prior findings recheck")).toBeLessThan(body.indexOf(publicationMarker));
    });
  });
});
describe("report sections (mstar.report/v1 side document)", () => {
  const report: ReportDoc = {
    schema: "mstar.report/v1",
    headSha: "abc1234",
    overview: "Adds an expiry guard to the auth path.",
    linkedIssueAc: "Expiry rejected: met.",
    verified: "- unit suite → green",
    rejected: "**Retry loop**: rejected — the diff never touches it.",
    planToFix: "1. Add the guard.\n2. Rerun the suite.",
  };

  const coverage: ClosureCoverage = {
    totalOpen: 3,
    selected: 2,
    assessed: 1,
    invalidOutput: 0,
    omitted: 1,
    capped: 1,
    contextCoverage: "complete",
  };

  test("buildRevalidatedSection carries the coverage line, the rows and their thread state", () => {
    const rows: ClosureRow[] = [
      {
        title: "A | b",
        disposition: "addressed",
        reason: "verified-fix",
        evidenceKind: "current-code",
        thread: "not yet resolved",
      },
      { title: "C", disposition: "dismissed", reason: "non-fix-dismissal", evidenceKind: null, thread: "-" },
      { title: "D", disposition: "unverifiable", reason: "no-evidence", evidenceKind: null, thread: "-" },
    ];
    const md = buildRevalidatedSection(coverage, rows);
    expect(md.startsWith("### Revalidated findings\n\nReassessed 1/2 open prior finding(s) this round")).toBe(true);
    expect(md).toContain("| finding | disposition | evidence | thread |");
    expect(md).toContain("| A \\| b | addressed (verified-fix) | current-code | not yet resolved |");
    expect(md).toContain("| C | dismissed (non-fix-dismissal) | - | - |");
    expect(md).toContain("| D | unverifiable (no-evidence) | - | - |");
  });

  test("a dismissed row reads the same in the revalidated and closure tables", () => {
    const rows: ClosureRow[] = [
      { title: "C", disposition: "dismissed", reason: "non-fix-dismissal", evidenceKind: null, thread: "-" },
    ];
    const revalidated = buildRevalidatedSection(coverage, rows);
    const closure = buildClosureSection(coverage, rows);
    // Both paths render THIS row's words: neither may claim the defect still
    // stands, because the store closed it as a non-fix dismissal.
    expect(revalidated).not.toContain("still present");
    expect(closure).toContain("| C | dismissed (non-fix-dismissal)");
    expect(revalidated).toContain("| C | dismissed (non-fix-dismissal) |");
  });

  test("buildRevalidatedSection marks rows past the display cap, like the closure table", () => {
    const rows: ClosureRow[] = Array.from({ length: CLOSURE_MAX_ROWS + 2 }, (_, i) => ({
      title: `finding ${i}`,
      disposition: "unverifiable" as const,
      reason: "no-evidence" as const,
      evidenceKind: null,
      thread: "-",
    }));
    const md = buildRevalidatedSection(coverage, rows);
    expect(md).toContain(`*(+2 more prior finding(s) over the ${CLOSURE_MAX_ROWS}-row display cap)*`);
    // The dropped rows are counted, never silently absent.
    expect(md).not.toContain(`| finding ${CLOSURE_MAX_ROWS} |`);
  });

  test("buildRevalidatedSection writes `none` when the round had no prior finding", () => {
    const firstRound: ClosureCoverage = {
      totalOpen: 0,
      selected: 0,
      assessed: 0,
      invalidOutput: 0,
      omitted: 0,
      capped: 0,
      contextCoverage: "complete",
    };
    expect(buildRevalidatedSection(firstRound, [])).toBe("### Revalidated findings\n\nnone");
  });

  test("rows all over the cap still state the coverage, table or not", () => {
    const overCap: ClosureCoverage = {
      totalOpen: 4,
      selected: 0,
      assessed: 0,
      invalidOutput: 0,
      omitted: 0,
      capped: 4,
      contextCoverage: "complete",
    };
    const md = buildRevalidatedSection(overCap, []);
    expect(md).toContain(
      "Reassessed 0/0 open prior finding(s) this round · 0 invalid-output · 0 omitted · 4 over cap · 4 open",
    );
    expect(md).not.toContain("| Prior finding |");
  });

  test("a body with report parts carries exactly ONE prior-findings table", () => {
    const rows: ClosureRow[] = [
      {
        title: "Fractional expiry comparison",
        disposition: "addressed",
        reason: "verified-fix",
        evidenceKind: "diff",
        thread: "-",
      },
    ];
    const body = buildReviewBody(
      { schema: "mstar.review/v1", verdict: "needs fixes", summary_md: "One issue.", findings: [] },
      0,
      buildClosureSection(coverage, rows),
      { report, revalidated: buildRevalidatedSection(coverage, rows) },
    );
    // The folded closure would be a second, disagreeable rendering of the same
    // rows: the report body never carries it.
    expect(body).not.toContain("## Prior findings recheck");
    expect(body.match(/\| finding \| disposition \| evidence \| thread \|/g)).toHaveLength(1);
    // …and the §7.10 facts survive the merge, once each.
    expect(body.match(/Reassessed /g)).toHaveLength(1);
    expect(body).toContain("| Fractional expiry comparison | addressed (verified-fix) | diff | - |");
  });

  test("insertReportSections places every section at its template anchor", () => {
    const rendered = renderReviewMarkdown({
      schema: "mstar.review/v1",
      verdict: "needs fixes",
      summary_md: "Two issues found.",
      findings: [
        {
          mergeClass: "should-fix",
          title: "Fractional expiry",
          body: "b",
          file_path: "src/auth.ts",
          line_start: 21,
          line_end: 21,
        },
      ],
    });
    const body = insertReportSections(rendered, report, "### Revalidated findings\n\nnone");
    const order = [
      "## 📋 Review",
      "**What this PR does**",
      "Two issues found.",
      "### Revalidated findings",
      "### Findings",
      "#### 🟠 Fractional expiry",
      "### Linked-issue AC",
      "### ✅ Verified",
      "### 🗑️ Considered & rejected",
      "## 🛠️ Plan to fix",
    ];
    const positions = order.map((needle) => body.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The plan is a collapsible, copyable block.
    expect(body).toContain(
      "<details><summary>Expand fix plan</summary>\n\n```md\n1. Add the guard.\n2. Rerun the suite.\n```\n\n</details>",
    );
  });

  test("the fix-plan fence outruns the longest backtick run inside the plan", () => {
    const plan = "Use `a` then ```` a four-backtick block";
    const body = insertReportSections(
      renderReviewMarkdown({ schema: "mstar.review/v1", verdict: "ship it", findings: [] }),
      { ...report, planToFix: plan },
      "none",
    );
    expect(body).toContain("`````md\n" + plan + "\n`````");
  });

  test("a zero-finding envelope: the revalidated table self-adds the empty `### Findings`", () => {
    const rendered = renderReviewMarkdown({
      schema: "mstar.review/v1",
      verdict: "ship it",
      findings: [],
    });
    expect(rendered).not.toContain("### Findings");
    const body = insertReportSections(rendered, report, "### Revalidated findings\n\nnone");
    expect(body).toContain("### Revalidated findings");
    // Revalidated FIRST, then the added heading — the fixed template order.
    expect(body.indexOf("### Revalidated findings")).toBeLessThan(body.indexOf("### Findings"));
    expect(body).toContain("### Linked-issue AC");
  });

  test("a null report keeps every heading and writes `none` under each", () => {
    const rendered = renderReviewMarkdown({
      schema: "mstar.review/v1",
      verdict: "ship it",
      findings: [],
    });
    const body = insertReportSections(rendered, null, "### Revalidated findings\n\nnone");
    expect(body).not.toContain("**What this PR does**");
    expect(body).toContain("### Linked-issue AC\n\nnone");
    expect(body).toContain("### ✅ Verified\n\nnone");
    expect(body).toContain("### 🗑️ Considered & rejected\n\nnone");
    expect(body).toContain("## 🛠️ Plan to fix\n\nnone");
    expect(body).not.toContain("<details><summary>Expand fix plan");
  });

  test("a report field cannot forge the findings anchor: `### Findings` stays text", () => {
    const rendered = renderReviewMarkdown({
      schema: "mstar.review/v1",
      verdict: "needs fixes",
      summary_md: "One issue.",
      findings: [
        { mergeClass: "should-fix", title: "Fractional expiry", body: "b", file_path: "src/auth.ts", line_start: 21, line_end: 21 },
      ],
    });
    const body = insertReportSections(
      rendered,
      { ...report, overview: "Adds a guard.\n### Findings\n#### 🟠 Injected" },
      "### Revalidated findings\n\nnone",
    );
    // Escaped in place, so the ONLY `### Findings` line is the engine's — the
    // revalidated table still lands directly above it.
    expect(body).toContain("\\### Findings");
    expect(body).toContain("\\#### 🟠 Injected");
    const headings = body.split("\n").filter((line) => /^#{2,4} /.test(line));
    expect(headings).toEqual([
      "## ⚠️ Verdict: `needs fixes`",
      "## 📋 Review",
      "### Revalidated findings",
      "### Findings",
      "#### 🟠 Fractional expiry",
      "### Linked-issue AC",
      "### ✅ Verified",
      "### 🗑️ Considered & rejected",
      "## 🛠️ Plan to fix",
    ]);
  });

  test("an indented ATX heading is neutralized too — markdown reads up to 3 spaces as the same heading", () => {
    const rendered = renderReviewMarkdown({ schema: "mstar.review/v1", verdict: "ship it", findings: [] });
    const body = insertReportSections(
      rendered,
      { ...report, overview: "Adds a guard.\n   ### Findings\n   #### 🟠 Injected" },
      "### Revalidated findings\n\nnone",
    );
    // The indent is kept and only the marker escaped, so the field stays text
    // and the engine's own headings keep their positions.
    expect(body).toContain("   \\### Findings");
    expect(body).toContain("   \\#### 🟠 Injected");
    const headings = body.split("\n").filter((line) => /^ {0,3}#{1,6} /.test(line));
    expect(headings).toEqual([
      "## ✅ Verdict: `ship it`",
      "## 📋 Review",
      "### Revalidated findings",
      "### Findings",
      "### Linked-issue AC",
      "### ✅ Verified",
      "### 🗑️ Considered & rejected",
      "## 🛠️ Plan to fix",
    ]);
  });

  test("a report field cannot fork the layout: `## 📋 Review` and a `---` fence stay text", () => {
    const rendered = renderReviewMarkdown({ schema: "mstar.review/v1", verdict: "ship it", findings: [] });
    const body = insertReportSections(
      rendered,
      { ...report, verified: "## 📋 Review\n---\nsuite green" },
      "### Revalidated findings\n\nnone",
    );
    expect(body).toContain("\\## 📋 Review");
    expect(body).toContain("\\---");
    // One review heading only, so the overview's anchor stayed unambiguous.
    expect(body.split("\n").filter((line) => line === "## 📋 Review")).toHaveLength(1);
    expect(body).toContain("**What this PR does**: Adds an expiry guard");
  });

  test("raw HTML in a report field cannot fold the sections after it", () => {
    const publicationMarker = buildPublicationMarker({
      publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      kind: "review",
    });
    // An unclosed `<details>` routes everything after it into a collapsed
    // block — plan and publication marker included — so the tag must stay text.
    for (const html of ["<details>fold the tail", "<details open>\nfold the tail"]) {
      const body = buildPreparedReviewBody({
        output: { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
        omittedFindings: 0,
        round: 1,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        publicationMarker,
        reportParts: {
          report: { ...report, verified: `- ${html}`, rejected: "R&D &lt;details&gt;" },
          revalidated: "### Revalidated findings\n\nnone",
        },
      });
      expect(body).toContain("&lt;details");
      // The plan block is the body's ONLY fold, and it is closed: nothing the
      // field said can swallow the sections below it.
      expect(body.match(/<details/g)).toHaveLength(1);
      expect(body.match(/<\/details>/g)).toHaveLength(1);
      expect(body.indexOf("### 🗑️ Considered & rejected")).toBeGreaterThan(body.indexOf("&lt;details"));
      expect(body.indexOf("## 🛠️ Plan to fix")).toBeGreaterThan(body.indexOf("### 🗑️ Considered & rejected"));
      expect(body.trimEnd().endsWith(publicationMarker)).toBe(true);
      // `&` is escaped too, so an entity the field already carried stays
      // visible text instead of being re-read as markup.
      expect(body).toContain("R&amp;D &amp;lt;details&amp;gt;");
    }
  });

  test("every thematic-break form is neutralized: `***`, `___` and spaced runs", () => {
    const rendered = renderReviewMarkdown({ schema: "mstar.review/v1", verdict: "ship it", findings: [] });
    for (const rule of ["***", "___", "- - -", "* * *", "_ _ _", "----", "==="]) {
      const body = insertReportSections(
        rendered,
        { ...report, verified: `suite green\n${rule}\ntail` },
        "### Revalidated findings\n\nnone",
      );
      expect(body).toContain(`\\${rule}`);
    }
    // A list item and a two-dash run are text, not breaks: they stay untouched.
    const safe = insertReportSections(
      rendered,
      { ...report, verified: "- item\n-- two dashes" },
      "### Revalidated findings\n\nnone",
    );
    expect(safe).toContain("\n- item");
    expect(safe).toContain("-- two dashes");
  });

  test("an anchor miss skips that section silently, leaving the layout intact", () => {
    // Not the engine's layout: no `## 📋 Review` line. The renderer is pure —
    // it returns the body unchanged for that section and logs nothing.
    const rendered = "## Verdict: something\n\nbody";
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warns.push(String(message));
    try {
      const body = insertReportSections(rendered, report, "### Revalidated findings\n\nnone");
      // Nothing was prepended, and the fixed tail still landed.
      expect(body.startsWith("## Verdict: something")).toBe(true);
      expect(body).not.toContain("**What this PR does**");
      expect(body).toContain("### Linked-issue AC");
      expect(warns).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a fix plan containing a fence gets a longer outer fence", () => {
    const rendered = renderReviewMarkdown({ schema: "mstar.review/v1", verdict: "ship it", findings: [] });
    const body = insertReportSections(rendered, { ...report, planToFix: "```ts\nx\n```" }, "none");
    expect(body).toContain("````md");
    expect(body).toContain("````");
  });

  test("buildPreparedReviewBody + reportParts: the sections land inside the trusted frame", () => {
    const publicationMarker = buildPublicationMarker({
      publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      kind: "review",
    });
    const body = buildPreparedReviewBody({
      output: { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
      omittedFindings: 0,
      round: 1,
      headSha: "0123456789abcdef0123456789abcdef01234567",
      publicationMarker,
      reportParts: { report, revalidated: "### Revalidated findings\n\nnone" },
    });
    expect(body.startsWith("<!-- mstar-inspector:review:v1 round=1 -->")).toBe(true);
    expect(body.trimEnd().endsWith(publicationMarker)).toBe(true);
    expect(body).toContain("**What this PR does**: Adds an expiry guard");
    expect(body).toContain("### Linked-issue AC");
  });

  test("buildPreparedReviewBody without reportParts is byte-identical to the pre-report body", () => {
    const publicationMarker = buildPublicationMarker({
      publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      kind: "review",
    });
    const input = {
      output: { schema: "mstar.review/v1", verdict: "ship it" as const, findings: [] },
      omittedFindings: 0,
      round: 1,
      headSha: "0123456789abcdef0123456789abcdef01234567",
      publicationMarker,
    } satisfies Parameters<typeof buildPreparedReviewBody>[0];
    const body = buildPreparedReviewBody(input);
    expect(body).not.toContain("### Linked-issue AC");
    expect(body).not.toContain("### Revalidated findings");
    // `since` absent too: a full round's header is unchanged.
    expect(body).toContain("Review 1 · commit 0123456\n");
  });

  test("sinceSha appends the 7-char marker on the header only", () => {
    const publicationMarker = buildPublicationMarker({
      publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      kind: "review",
    });
    const body = buildPreparedReviewBody({
      output: { schema: "mstar.review/v1", verdict: "ship it" as const, findings: [] },
      omittedFindings: 0,
      round: 4,
      headSha: "0123456789abcdef0123456789abcdef01234567",
      publicationMarker,
      sinceSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    expect(body).toContain("Review 4 · commit 0123456 · since bbbbbbb");
  });
});

describe("REVIEW_BODY_LIMIT clamp (qc2 F-003 / qc3 F-304)", () => {
  /** Lines that open or close a fenced block (the plan's renderer is the only source). */
  const fenceLines = (text: string): string[] => text.split("\n").filter((line) => /^ {0,3}`{3,}/.test(line));

  const output: ReviewOutput = {
    schema: "mstar.review/v1",
    verdict: "blocked",
    summary_md: "x".repeat(REVIEW_BODY_LIMIT + 5000),
    findings: [],
  };

  test("an over-limit assembled body is clamped under the GitHub 65536-char cap, marker/header/publication marker intact", () => {
    const publicationMarker = buildPublicationMarker({
      publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      kind: "review",
    });
    const body = buildPreparedReviewBody({
      output,
      omittedFindings: 0,
      round: 4,
      headSha: "0123456789abcdef0123456789abcdef01234567",
      publicationMarker,
    });
    expect(body.length).toBeLessThan(65536);
    expect(body.startsWith("<!-- mstar-inspector:review:v1 round=4 -->\n")).toBe(true);
    expect(body.trimEnd().endsWith(publicationMarker)).toBe(true);
    expect(body).toContain("…");
  });

  test("a cut that lands inside a fold closes it, so the collapse cannot swallow the trailer", () => {
    const coverage: ClosureCoverage = {
      totalOpen: 25,
      selected: 25,
      assessed: 25,
      invalidOutput: 0,
      omitted: 0,
      capped: 0,
      contextCoverage: "complete",
    };
    const rows: ClosureRow[] = Array.from({ length: 25 }, (_, index) => ({
      title: `prior finding ${index}`,
      disposition: "unverifiable",
      reason: "no-evidence",
      evidenceKind: null,
      thread: "-",
    }));
    // Sized so the closure fold opens before the cut and would end after it.
    const clogged: ReviewOutput = { ...output, summary_md: "x".repeat(REVIEW_BODY_LIMIT - 400) };
    const closure = buildClosureSection(coverage, rows);
    const body = buildReviewBody(clogged, 0, closure);
    expect(body.length).toBeLessThanOrEqual(REVIEW_BODY_LIMIT);
    expect(body).toContain("<details>");
    expect((body.match(/<details>/g) ?? []).length).toBe((body.match(/<\/details>/g) ?? []).length);
    // A cut outside every fence must not invent one: it closes only the details.
    expect(fenceLines(body)).toEqual([]);

    const publicationMarker = buildPublicationMarker({
      publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      kind: "review",
    });
    const prepared = buildPreparedReviewBody({
      output: clogged,
      omittedFindings: 0,
      round: 3,
      headSha: "0123456789abcdef0123456789abcdef01234567",
      publicationMarker,
      closure,
    });
    expect(fenceLines(prepared)).toEqual([]);
    expect((prepared.match(/<details>/g) ?? []).length).toBe((prepared.match(/<\/details>/g) ?? []).length);
    expect(prepared).toContain("Review 3 · commit 0123456");
    expect(prepared.trimEnd().endsWith(publicationMarker)).toBe(true);
  });

  test("a cut inside the fix plan closes its fence before the fold, header and marker intact", () => {
    // The plan renders last, so an over-budget body cuts INSIDE its fenced
    // block: closing only the fold would still let the fence swallow the
    // trailer. A validated document caps planToFix at 6000 chars, so the plan
    // has to be inflated directly to reach the cut this clamp must survive.
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const publicationMarker = buildPublicationMarker({
      publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      headSha,
      kind: "review",
    });
    const report: ReportDoc = {
      schema: "mstar.report/v1",
      headSha,
      overview: "Adds an expiry guard.",
      linkedIssueAc: "Expiry rejected: met.",
      verified: "- suite → green",
      rejected: "none",
      planToFix: "x".repeat(REVIEW_BODY_LIMIT + 5000),
    };
    const reportParts = { report, revalidated: "Reassessed 0/0 open prior finding(s) this round" };
    const small: ReviewOutput = { schema: "mstar.review/v1", verdict: "blocked", summary_md: "Clamped.", findings: [] };

    // Both clamp sites: the inner body clamp and the prepared-body clamp.
    const inner = buildReviewBody(small, 0, undefined, reportParts);
    const prepared = buildPreparedReviewBody({ output: small, omittedFindings: 0, round: 7, headSha, publicationMarker, reportParts });
    for (const clamped of [inner, prepared]) {
      expect(clamped.length).toBeLessThan(65536);
      expect(clamped).toContain("…");
      // Opening fence plus the closer the clamp appends — an odd count means
      // the rest of the comment renders as code, marker lines included.
      expect(fenceLines(clamped)).toHaveLength(2);
      expect((clamped.match(/<details>/g) ?? []).length).toBe(1);
      expect((clamped.match(/<\/details>/g) ?? []).length).toBe(1);
    }
    expect(prepared).toContain("Review 7 · commit 0123456");
    expect(prepared.trimEnd().endsWith(publicationMarker)).toBe(true);
  });

  test("within-limit bodies pass through verbatim", () => {
    const publicationMarker = buildPublicationMarker({
      publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      headSha: "abc1234",
      kind: "review",
    });
    const small: ReviewOutput = { ...output, summary_md: "small" };
    const body = buildPreparedReviewBody({
      output: small,
      omittedFindings: 0,
      round: 1,
      headSha: "abc1234",
      publicationMarker,
    });
    expect(body).not.toContain("…");
    expect(body).toContain("small");
  });
});

describe("prepared publication wiring (mock octokit, SG-001 — spec §7.7)", () => {
  const target = { installationId: 1, owner: "acme", repo: "widgets", prNumber: 42 };
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const publicationMarker = buildPublicationMarker({
    publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    headSha: sha,
    kind: "review",
  });
  const preparedBody = buildPreparedReviewBody({
    output: {
      schema: "mstar.review/v1",
      verdict: "blocked",
      summary_md: "One must-fix blocks the merge.",
      findings: [],
    },
    omittedFindings: 0,
    round: 3,
    headSha: sha,
    publicationMarker,
  });
  const sendInput = { ...target, headSha: sha, round: 3, targetCommentId: 7, body: preparedBody, publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };

  type Calls = {
    listRoute?: unknown;
    listParams?: Record<string, unknown>;
    updateParams?: Record<string, unknown>;
    createParams?: Record<string, unknown>;
  };

  type MockComment = { id: number; body?: string | null; user?: { type?: string } | null };

  function mockOctok(comments: MockComment[], updateError?: unknown) {
    const calls: Calls = {};
    const octokit: PostOctokit = {
      paginate: mock(
        async (route: unknown, params: Record<string, unknown>): Promise<MockComment[]> => {
          calls.listRoute = route;
          calls.listParams = params;
          return comments;
        },
      ),
      rest: {
        issues: {
          listComments: mock(async (_params: Record<string, unknown>) => {
            throw new Error("unexpected: listComments is driven through paginate");
          }),
          updateComment: mock(async (params: Record<string, unknown>) => {
            calls.updateParams = params;
            if (updateError) throw updateError;
            return {};
          }),
          createComment: mock(async (params: Record<string, unknown>) => {
            calls.createParams = params;
            // Real octokit returns the created comment — the publication
            // proof needs its id (§7.7).
            return { data: { id: 101 } };
          }),
        },
      },
    };
    return { calls, octokit };
  }

  test("plan: paginates the full comment list with the issues.listComments call shape (WF-001)", async () => {
    const { calls, octokit } = mockOctok([]);
    await planReviewUpsertWithOctokit(octokit, target);
    expect(calls.listRoute).toBe(octokit.rest.issues.listComments);
    expect(calls.listParams).toEqual({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      per_page: 100,
    });
  });

  test("plan: create on a miss; update (commentId, round=N+1) on a bot marker hit", async () => {
    const miss = await planReviewUpsertWithOctokit(mockOctok([{ id: 1, body: "a human comment" }]).octokit, target);
    expect(miss).toEqual({ action: "create", round: 1 });
    const hit = await planReviewUpsertWithOctokit(
      mockOctok([{ id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\nReview 2", user: { type: "Bot" } }]).octokit,
      target,
    );
    expect(hit).toEqual({ action: "update", commentId: 7, round: 3 });
  });

  test("send (create plan): publishes the EXACT prepared body and returns the response id", async () => {
    const { calls, octokit } = mockOctok([]);
    const result = await postPreparedReviewWithOctokit(octokit, { ...sendInput, targetCommentId: null });
    expect(result).toEqual({ commentId: 101 });
    expect(calls.updateParams).toBeUndefined();
    expect(calls.createParams).toMatchObject({ owner: "acme", repo: "widgets", issue_number: 42 });
    expect(calls.createParams!.body).toBe(preparedBody);
  });

  test("send (update plan): the target's expected previous version is verified, then patched with the exact body", async () => {
    const { calls, octokit } = mockOctok([
      { id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\nRound 2", user: { type: "Bot" } },
    ]);
    const result = await postPreparedReviewWithOctokit(octokit, sendInput);
    expect(result).toEqual({ commentId: 7 });
    expect(calls.createParams).toBeUndefined();
    expect(calls.updateParams).toMatchObject({ owner: "acme", repo: "widgets", comment_id: 7 });
    expect(calls.updateParams!.body).toBe(preparedBody);
  });

  test("send: an exact-body replay on the target is ADOPTED without mutation (response-lost recovery)", async () => {
    const { calls, octokit } = mockOctok([{ id: 7, body: preparedBody, user: { type: "Bot" } }]);
    const result = await postPreparedReviewWithOctokit(octokit, sendInput);
    expect(result).toEqual({ commentId: 7 });
    expect(calls.updateParams).toBeUndefined();
    expect(calls.createParams).toBeUndefined();
  });

  test("send: a changed target (newer round / replaced body) is a definitive rejection — never overwritten", async () => {
    const newer = mockOctok([{ id: 7, body: "<!-- mstar-inspector:review:v1 round=9 -->\nnewer", user: { type: "Bot" } }]);
    await expect(postPreparedReviewWithOctokit(newer.octokit, sendInput)).rejects.toThrow(/expected previous version/);
    const human = mockOctok([{ id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->", user: { type: "User" } }]);
    await expect(postPreparedReviewWithOctokit(human.octokit, sendInput)).rejects.toThrow(/expected previous version/);
  });

  test("send: a bot marker appearing after a create plan is adopted only on an exact-body match, else rejected", async () => {
    const foreign = mockOctok([{ id: 9, body: "<!-- mstar-inspector:review:v1 round=5 -->\nsomeone else", user: { type: "Bot" } }]);
    await expect(postPreparedReviewWithOctokit(foreign.octokit, { ...sendInput, targetCommentId: null })).rejects.toThrow(
      /refusing to create a second publication/,
    );
    const replay = mockOctok([{ id: 9, body: preparedBody, user: { type: "Bot" } }]);
    await expect(postPreparedReviewWithOctokit(replay.octokit, { ...sendInput, targetCommentId: null })).resolves.toEqual({
      commentId: 9,
    });
  });

  test("a create response WITHOUT a comment id is an unprovable publication → throws (§7.7 step 8)", async () => {
    const { octokit } = mockOctok([]);
    (octokit.rest.issues.createComment as ReturnType<typeof mock>).mockImplementation(async () => ({}));
    await expect(postPreparedReviewWithOctokit(octokit, { ...sendInput, targetCommentId: null })).rejects.toThrow(
      /unprovable publication/,
    );
  });

  test("updateComment 404 on the target → create fallback with the SAME prepared body (round preserved, WF-003)", async () => {
    const notFound = Object.assign(new Error("not found"), { status: 404 });
    const { calls, octokit } = mockOctok(
      [{ id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\nRound 2", user: { type: "Bot" } }],
      notFound,
    );
    await postPreparedReviewWithOctokit(octokit, sendInput);
    expect(calls.updateParams).toMatchObject({ comment_id: 7 });
    expect(calls.createParams!.body).toBe(preparedBody);
  });

  test("updateComment 403 (foreign App's bot marker) → create fallback with the SAME prepared body (qc2 F-002)", async () => {
    const forbidden = Object.assign(new Error("forbidden"), { status: 403 });
    const { calls, octokit } = mockOctok(
      [{ id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\nforeign bot", user: { type: "Bot" } }],
      forbidden,
    );
    await postPreparedReviewWithOctokit(octokit, sendInput);
    expect(calls.createParams!.body).toBe(preparedBody);
  });

  test("non-403/404 updateComment errors rethrow (no fallback)", async () => {
    const { octokit } = mockOctok(
      [{ id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\nReview 2", user: { type: "Bot" } }],
      new Error("rate limited"),
    );
    await expect(postPreparedReviewWithOctokit(octokit, sendInput)).rejects.toThrow("rate limited");
  });

  test("blocked and ship it both send with NO review event, never REQUEST_CHANGES/APPROVE (mapping spec §2)", async () => {
    for (const verdict of ["blocked", "ship it"] as const) {
      const marker = buildPublicationMarker({ publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", headSha: sha, kind: "review" });
      const body = buildPreparedReviewBody({
        output: { schema: "mstar.review/v1", verdict, summary_md: "x", findings: [] },
        omittedFindings: 0,
        round: 1,
        headSha: sha,
        publicationMarker: marker,
      });
      const { calls, octokit } = mockOctok([]);
      await postPreparedReviewWithOctokit(octokit, { ...sendInput, body, targetCommentId: null });
      for (const captured of [calls.listParams, calls.updateParams, calls.createParams]) {
        if (captured === undefined) continue;
        expect("event" in captured).toBe(false);
        expect(JSON.stringify(captured)).not.toContain("REQUEST_CHANGES");
        expect(JSON.stringify(captured)).not.toContain("APPROVE");
      }
      expect(calls.createParams).toBeDefined();
      expect(String(calls.createParams!.body)).toContain(`Verdict: \`${verdict}\``);
    }
  });

  test("deep envelope sends COMMENT-only via the Issues API: pulls.createReview never touched", async () => {
    const marker = buildPublicationMarker({ publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", headSha: sha, kind: "review" });
    const body = buildPreparedReviewBody({
      output: {
        schema: "mstar.review/v1",
        verdict: "needs fixes",
        summary_md: "Deep three-stage parent-session review.",
        findings: [],
      },
      omittedFindings: 0,
      round: 1,
      headSha: sha,
      publicationMarker: marker,
    });
    const { calls, octokit } = mockOctok([]);
    const createReview = mock(async () => {
      throw new Error("pulls.createReview must never be called (SEC-01: COMMENT-only posting)");
    });
    const withPulls = { ...octokit, rest: { ...octokit.rest, pulls: { createReview } } };
    await postPreparedReviewWithOctokit(withPulls, { ...sendInput, body, targetCommentId: null });
    expect(createReview).not.toHaveBeenCalled();
    expect(calls.createParams).toBeDefined();
    expect(String(calls.createParams!.body)).toContain("Deep three-stage parent-session review.");
  });
});

// ---------------------------------------------------------------------------
// Degraded chain (architect AL-1)
// ---------------------------------------------------------------------------

const botReviewMarker = (id: number, round: number) => ({
  id,
  body: `<!-- mstar-inspector:review:v1 round=${round} -->\nReview ${round}`,
  user: { type: "Bot" },
});

type Calls = {
  listRoute?: unknown;
  listParams?: Record<string, unknown>;
  updateParams?: Record<string, unknown>;
  createParams?: Record<string, unknown>;
};

type MockComment = { id: number; body?: string | null; user?: { type?: string } | null };

const degradedBotMarker = (id: number, round: number) => ({
  id,
  body: `<!-- mstar-inspector:review-degraded:v1 round=${round} -->\n**Review degraded: output failed schema validation**`,
  user: { type: "Bot" },
});

describe("parseDegradedRound / findDegradedComment / planDegradedUpsert", () => {
  test("parses a well-formed degraded marker; null on malformed / absent", () => {
    expect(parseDegradedRound("<!-- mstar-inspector:review-degraded:v1 round=2 -->\nbody")).toBe(2);
    expect(parseDegradedRound("<!-- mstar-inspector:review-degraded:v1 round=abc -->")).toBeNull();
    expect(parseDegradedRound("no marker")).toBeNull();
  });

  test("chain separation: a real review marker is a MISS for the degraded scan and vice versa", () => {
    // The degraded prefix never starts with `review:v1` and the review scan
    // never matches `review-degraded:v1` — the chains cannot cross.
    expect(findDegradedComment([botReviewMarker(7, 2)])).toBeNull();
    expect(findReviewComment([degradedBotMarker(7, 2)])).toBeNull();
    expect(planDegradedUpsert([botReviewMarker(7, 2)])).toEqual({ action: "create", round: 1 });
    expect(planUpsert([degradedBotMarker(7, 2)])).toEqual({ action: "create", round: 1 });
  });

  test("bot-authorship gate + prefix restriction + create/update plan mirror the review chain", () => {
    // Human-planted degraded marker → miss; bot marker → update round=N+1.
    expect(findDegradedComment([{ id: 9, body: "<!-- mstar-inspector:review-degraded:v1 round=5 -->\nplanted", user: { type: "User" } }])).toBeNull();
    expect(planDegradedUpsert([degradedBotMarker(7, 5)])).toEqual({ action: "update", commentId: 7, round: 6 });
    expect(planDegradedUpsert([{ id: 8, body: "a human comment", user: { type: "User" } }])).toEqual({
      action: "create",
      round: 1,
    });
    // Excluded ids (403/404 recovery) are skipped.
    expect(planDegradedUpsert([degradedBotMarker(7, 2), degradedBotMarker(8, 1)], new Set([7]))).toEqual({
      action: "update",
      commentId: 8,
      round: 2,
    });
  });

  test("findDegradedComments collects ALL bot-authored degraded markers (Bugbot round-2 fix)", () => {
    // The delete path must clean every stale marker, not just the first —
    // after a 403/404 miss-and-replan recovery the PR can carry TWO.
    expect(findDegradedComments([degradedBotMarker(7, 2), degradedBotMarker(8, 1)])).toEqual([
      { id: 7, body: degradedBotMarker(7, 2).body },
      { id: 8, body: degradedBotMarker(8, 1).body },
    ]);
    // Bot-authorship gate + prefix restriction hold per match.
    expect(
      findDegradedComments([
        { id: 1, body: "a human comment", user: { type: "User" } },
        botReviewMarker(9, 3),
        degradedBotMarker(7, 2),
      ]),
    ).toEqual([{ id: 7, body: degradedBotMarker(7, 2).body }]);
    expect(findDegradedComments([])).toEqual([]);
  });
});

describe("buildDegradedBody", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const input = { error: "not valid ReviewOutput JSON", rawOutput: "not json at all", round: 2 };

  test("marker line, headline, error line, and the raw excerpt behind a details collapse", () => {
    const body = buildDegradedBody(input);
    const lines = body.split("\n");
    expect(lines[0]).toBe("<!-- mstar-inspector:review-degraded:v1 round=2 -->");
    expect(lines[1]).toBe("**Review degraded: output failed schema validation**");
    expect(body).toContain("not valid ReviewOutput JSON");
    expect(body).toContain("<details>");
    expect(body).toContain("not json at all");
  });

  test("excerpt is REDACTED BEFORE truncation — a secret never survives, whole or partial (AL-1)", () => {
    const secret = "ghp_" + "a".repeat(36);
    // Secret INSIDE the excerpt window → redaction marker, never the token.
    const inside = buildDegradedBody({ ...input, rawOutput: `${"x".repeat(500)} ${secret} ${"y".repeat(2000)}` });
    expect(inside).not.toContain(secret);
    expect(inside).toContain("[REDACTED]");
    // Secret STRADDLING the 1000-char cut → redact-first leaves no partial
    // token (a truncate-first order would leak the token's first chars).
    const straddling = buildDegradedBody({ ...input, rawOutput: `${"x".repeat(980)} ${secret}` });
    expect(straddling).not.toContain(secret);
    expect(straddling).not.toContain("ghp_");
  });

  test("the ERROR line is redacted too — a zod `received` token never reaches the body (AL-1)", () => {
    // parseReviewOutput zod errors can echo the offending value, e.g. an
    // enum failure on verdict — the received span rides the error line
    // ABOVE the details fold, so it must be redactSecrets'd like the
    // excerpt (redact-then-truncate keeps the order safe).
    const token = "ghp_" + "b".repeat(36);
    const body = buildDegradedBody({
      ...input,
      error: `schema validation failed at verdict: Invalid enum value. Expected 'ship it' | 'needs fixes' | 'blocked', received '${token}'`,
    });
    expect(body).not.toContain(token);
    expect(body).not.toContain("ghp_");
    expect(body).toContain("[REDACTED]");
  });

  test("excerpt ≤ 1000 chars; over-budget output is truncated with an ellipsis", () => {
    const body = buildDegradedBody({ ...input, rawOutput: "y".repeat(5000) });
    const excerpt = body.slice(body.indexOf("```\n") + 4, body.lastIndexOf("\n```"));
    expect(excerpt.length).toBe(DEGRADED_EXCERPT_LIMIT); // budget incl. ellipsis
    expect(excerpt.endsWith("…")).toBe(true);
  });

  test("the code fence sizes past the excerpt's longest backtick run (runner prints fenced JSON)", () => {
    const body = buildDegradedBody({ ...input, rawOutput: "```json\n{\"broken\": true}\n```" });
    // The excerpt contains ``` runs — the surrounding fence must be longer.
    expect(body).toContain("````");
    const excerpt = body.slice(body.indexOf("````\n") + 5, body.lastIndexOf("\n````"));
    expect(excerpt).toContain('```json');
  });

  test("an absurdly long parse error still keeps the body under REVIEW_BODY_LIMIT", () => {
    const body = buildDegradedBody({ ...input, error: "z".repeat(REVIEW_BODY_LIMIT), round: 1 });
    expect(body.length).toBeLessThan(REVIEW_BODY_LIMIT);
  });
});

describe("prepared degraded publication wiring (mock octokit, spec §7.7)", () => {
  const degradeTarget = { installationId: 1, owner: "acme", repo: "widgets", prNumber: 42 };
  const preparedDegradedBody = buildPreparedDegradedBody({
    error: "not valid ReviewOutput JSON",
    rawOutput: "not json at all",
    round: 3,
    publicationMarker: buildPublicationMarker({
      publicationId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      kind: "degraded",
    }),
  });
  const sendInput = {
    ...degradeTarget,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    round: 3,
    targetCommentId: 7 as number | null,
    body: preparedDegradedBody,
    publicationId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
  };

  function mockOctok(comments: MockComment[], updateError?: unknown) {
    const calls: Calls = {};
    const octokit: PostOctokit = {
      paginate: mock(
        async (route: unknown, params: Record<string, unknown>): Promise<MockComment[]> => {
          calls.listRoute = route;
          calls.listParams = params;
          return comments;
        },
      ),
      rest: {
        issues: {
          listComments: mock(async (_params: Record<string, unknown>) => {
            throw new Error("unexpected: listComments is driven through paginate");
          }),
          updateComment: mock(async (params: Record<string, unknown>) => {
            calls.updateParams = params;
            if (updateError) throw updateError;
            return {};
          }),
          createComment: mock(async (params: Record<string, unknown>) => {
            calls.createParams = params;
            return { data: { id: 202 } };
          }),
        },
      },
    };
    return { calls, octokit };
  }

  test("no degraded marker → createComment with the EXACT prepared degraded body", async () => {
    const { calls, octokit } = mockOctok([{ id: 1, body: "a human comment" }]);
    const result = await postPreparedDegradedWithOctokit(octokit, { ...sendInput, targetCommentId: null });
    expect(result).toEqual({ posted: true, commentId: 202 });
    expect(calls.createParams).toMatchObject({ owner: "acme", repo: "widgets", issue_number: 42 });
    expect(calls.createParams!.body).toBe(preparedDegradedBody);
  });

  test("a REAL review marker does not satisfy the degraded scan — still creates", async () => {
    const { calls, octokit } = mockOctok([botReviewMarker(7, 3)]);
    await postPreparedDegradedWithOctokit(octokit, { ...sendInput, targetCommentId: null });
    expect(calls.updateParams).toBeUndefined();
    expect(calls.createParams!.body).toBe(preparedDegradedBody);
  });

  test("degraded marker hit → the expected previous version is verified then patched with the exact body", async () => {
    const { calls, octokit } = mockOctok([degradedBotMarker(7, 2)]);
    const result = await postPreparedDegradedWithOctokit(octokit, sendInput);
    expect(result).toEqual({ posted: true, commentId: 7 });
    expect(calls.updateParams).toMatchObject({ comment_id: 7 });
    expect(calls.updateParams!.body).toBe(preparedDegradedBody);
  });

  test("404 on the planned target → create fallback with the SAME prepared body (round preserved)", async () => {
    const notFound = Object.assign(new Error("not found"), { status: 404 });
    const recovery = mockOctok([degradedBotMarker(7, 2)], notFound);
    const result = await postPreparedDegradedWithOctokit(recovery.octokit, sendInput);
    expect(result).toEqual({ posted: true, commentId: 202 });
    expect(recovery.calls.createParams!.body).toBe(preparedDegradedBody);
  });

  test("a changed target (non-degraded body / wrong round) is a definitive rejection", async () => {
    const newer = mockOctok([{ id: 7, body: "<!-- mstar-inspector:review-degraded:v1 round=9 -->\nnewer", user: { type: "Bot" } }]);
    await expect(postPreparedDegradedWithOctokit(newer.octokit, sendInput)).rejects.toThrow(/expected previous version/);
  });
});

describe("deleteDegradedComment wiring (mock octokit, Bugbot lifecycle)", () => {
  const degradeInput = {
    installationId: 1,
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    error: "",
    rawOutput: "",
  };

  type DeleteCalls = {
    listParams?: Record<string, unknown>;
    deleteParams: Array<Record<string, unknown>>;
  };

  function mockOctok(comments: MockComment[], deleteError?: unknown) {
    const calls: DeleteCalls = { deleteParams: [] };
    const octokit: PostOctokit = {
      paginate: mock(
        async (route: unknown, params: Record<string, unknown>): Promise<MockComment[]> => {
          calls.listParams = params;
          return comments;
        },
      ),
      rest: {
        issues: {
          listComments: mock(async () => {
            throw new Error("unexpected: listComments is driven through paginate");
          }),
          updateComment: mock(async () => {
            throw new Error("unexpected: no update on the delete path");
          }),
          createComment: mock(async () => {
            throw new Error("unexpected: no create on the delete path");
          }),
          deleteComment: mock(async (params: Record<string, unknown>) => {
            calls.deleteParams.push(params);
            // A per-match failure: throw on the FIRST delete only, so the
            // remaining matches are still attempted (skip-and-continue).
            if (deleteError && calls.deleteParams.length === 1) throw deleteError;
            return {};
          }),
        },
      },
    };
    return { calls, octokit };
  }

  test("a bot-authored degraded comment is deleted via the Issues comments API", async () => {
    const { calls, octokit } = mockOctok([degradedBotMarker(7, 2)]);
    const outcome = await deleteDegradedCommentWithOctokit(octokit, degradeInput);
    expect(calls.listParams).toEqual({ owner: "acme", repo: "widgets", issue_number: 42, per_page: 100 });
    expect(calls.deleteParams).toEqual([{ owner: "acme", repo: "widgets", comment_id: 7 }]);
    expect(outcome).toEqual({ deleted: 1, skipped: 0, errors: [] });
  });

  test("no degraded comment → no delete call, zero outcome", async () => {
    const { calls, octokit } = mockOctok([{ id: 1, body: "a human comment", user: { type: "User" } }]);
    const outcome = await deleteDegradedCommentWithOctokit(octokit, degradeInput);
    expect(calls.deleteParams).toEqual([]);
    expect(outcome).toEqual({ deleted: 0, skipped: 0, errors: [] });
  });

  test("a human-planted degraded marker is never deleted (bot-authorship gate)", async () => {
    const { calls, octokit } = mockOctok([
      { id: 9, body: "<!-- mstar-inspector:review-degraded:v1 round=5 -->\nplanted", user: { type: "User" } },
    ]);
    const outcome = await deleteDegradedCommentWithOctokit(octokit, degradeInput);
    expect(calls.deleteParams).toEqual([]);
    expect(outcome).toEqual({ deleted: 0, skipped: 0, errors: [] });
  });

  test("foreign-first ordering: first match 403, second ours → ours deleted, no throw", async () => {
    const { calls, octokit } = mockOctok(
      [degradedBotMarker(7, 2), degradedBotMarker(8, 1)],
      Object.assign(new Error("forbidden"), { status: 403 }),
    );
    const outcome = await deleteDegradedCommentWithOctokit(octokit, degradeInput);
    // Both matches are attempted; the 403 is skipped, the second is deleted.
    expect(calls.deleteParams).toEqual([
      { owner: "acme", repo: "widgets", comment_id: 7 },
      { owner: "acme", repo: "widgets", comment_id: 8 },
    ]);
    expect(outcome).toEqual({ deleted: 1, skipped: 1, errors: [] });
  });

  test("multiple own markers → all deleted", async () => {
    const { calls, octokit } = mockOctok([degradedBotMarker(7, 2), degradedBotMarker(8, 1)]);
    const outcome = await deleteDegradedCommentWithOctokit(octokit, degradeInput);
    expect(calls.deleteParams).toEqual([
      { owner: "acme", repo: "widgets", comment_id: 7 },
      { owner: "acme", repo: "widgets", comment_id: 8 },
    ]);
    expect(outcome).toEqual({ deleted: 2, skipped: 0, errors: [] });
  });

  test("non-403 error on one match → others still attempted, error surfaced in the outcome", async () => {
    const { calls, octokit } = mockOctok(
      [degradedBotMarker(7, 2), degradedBotMarker(8, 1)],
      new Error("rate limited"),
    );
    const outcome = await deleteDegradedCommentWithOctokit(octokit, degradeInput);
    expect(calls.deleteParams).toEqual([
      { owner: "acme", repo: "widgets", comment_id: 7 },
      { owner: "acme", repo: "widgets", comment_id: 8 },
    ]);
    expect(outcome).toEqual({ deleted: 1, skipped: 1, errors: ["rate limited"] });
  });

  test("missing octokit surface → outcome error, never throws", async () => {
    const bare = {} as PostOctokit;
    const outcome = await deleteDegradedCommentWithOctokit(bare, degradeInput);
    expect(outcome).toEqual({ deleted: 0, skipped: 0, errors: [expect.stringContaining("missing rest.issues")] });
  });
});

describe("missing octokit surface → per-chain error noun (review feedback fix)", () => {
  test("the review chain names the review comment; the degraded chain names the degraded comment", async () => {
    const bare = {} as PostOctokit;
    await expect(
      postPreparedReviewWithOctokit(bare, {
        installationId: 1,
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        round: 1,
        targetCommentId: null,
        body: "prepared",
        publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      }),
    ).rejects.toThrow(/cannot publish the prepared review/);
    await expect(
      postPreparedDegradedWithOctokit(bare, {
        installationId: 1,
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        round: 1,
        targetCommentId: null,
        body: "prepared degraded",
        publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      }),
    ).rejects.toThrow(/cannot publish the prepared degraded comment/);
  });
});

describe("createReviewCommenter — bounded transport seam + live App identity (§7.11.1/§7.5)", () => {
  // A real PKCS#8 key: auth-app must be able to SIGN the App JWT, otherwise
  // the request never reaches the seam and the seam stays unobservable.
  const ENV = { APP_ID: "1001", PRIVATE_KEY: "" };
  const SCOPE = { appId: "app-1", installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };

  type SeamCall = { url: string; method: string; signal: AbortSignal | null };
  /** Records every request and answers the two upstream shapes involved. */
  function recordingFetch(): { calls: SeamCall[]; impl: CommenterFetch } {
    const calls: SeamCall[] = [];
    const impl: CommenterFetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", signal: init?.signal ?? null });
      if (url.endsWith("/app")) {
        return new Response(JSON.stringify({ id: 1001, slug: "acme-inspector" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          token: "ghs_test",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          repositories: [{ id: 1, name: "widgets" }],
          permissions: { contents: "write", metadata: "read", pull_requests: "write", issues: "write" },
          repository_selection: "selected",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    return { calls, impl };
  }

  /** Global fetch is severed: anything bypassing the seam throws loudly. */
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  function severGlobalFetch(): void {
    globalThis.fetch = (async (_input: unknown, _init?: RequestInit): Promise<Response> => {
      throw new Error("global fetch must not be used — the request escaped the bounded seam");
    }) as typeof fetch;
  }

  test("the identity probe uses GET /app and returns the LIVE App id + slug", async () => {
    const { calls, impl } = recordingFetch();
    severGlobalFetch();
    const commenter = createReviewCommenter({ ...ENV, PRIVATE_KEY: await testAppPem() }, { fetchImpl: impl });

    expect(await commenter.getAppIdentity!()).toEqual({ githubAppId: 1001, slug: "acme-inspector" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/app");
    expect(calls[0]!.method).toBe("GET");
    // Memoized: a second probe issues no further request.
    expect(await commenter.getAppIdentity!()).toEqual({ githubAppId: 1001, slug: "acme-inspector" });
    expect(calls).toHaveLength(1);
  });

  test("the token mint and every token-authenticated call travel through the seam, never the global fetch", async () => {
    const { calls, impl } = recordingFetch();
    severGlobalFetch();
    const commenter = createReviewCommenter({ ...ENV, PRIVATE_KEY: await testAppPem() }, { fetchImpl: impl });

    const grant = await commenter.getInstallationToken({ scope: SCOPE, purpose: "review-write" });
    expect(grant.token).toBe("ghs_test");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.github.com/app/installations/123/access_tokens",
    ]);
  });

  test("a non-blank answer that is not the expected shape fails closed to null (identity unavailable)", async () => {
    severGlobalFetch();
    const commenter = createReviewCommenter(
      { ...ENV, PRIVATE_KEY: await testAppPem() },
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ id: 1001, slug: "" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(await commenter.getAppIdentity!()).toBeNull();
  });

  test("without the seam the instance still uses the runtime global fetch (consumer default unchanged)", async () => {
    // The seam is OPT-IN: an instance built by the consumer (no `fetchImpl`)
    // must keep issuing through the global fetch. Stubbing the global proves
    // the default route without touching the network.
    const globalCalls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      globalCalls.push(String(input));
      return new Response(JSON.stringify({ id: 1001, slug: "acme-inspector" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const commenter = createReviewCommenter({ ...ENV, PRIVATE_KEY: await testAppPem() });
    expect(await commenter.getAppIdentity!()).toEqual({ githubAppId: 1001, slug: "acme-inspector" });
    expect(globalCalls).toEqual(["https://api.github.com/app"]);
  });
});
