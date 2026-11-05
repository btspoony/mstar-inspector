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
  buildDegradedBody,
  buildPreparedDegradedBody,
  buildPreparedReviewBody,
  buildPublicationMarker,
  buildRevalidatedSection,
  buildReviewBody,
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
  TRUNCATION_MARKER,
  truncateSummary,
  type ClosureCoverage,
  type ClosureRow,
  type CommenterFetch,
  type PostOctokit,
} from "../../src/pipeline/comment";
import { FINDING_BODY_MAX, type ReviewFinding, type ReviewOutput } from "../../src/review/schema";
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

  test("a cut between the halves of an emoji at the budget edge posts readable text", () => {
    // The pair straddles the 8000-char cut: a raw slice keeps its high half and
    // the posted body carries a replacement character.
    const narrative = `${"x".repeat(SUMMARY_MD_LIMIT - 2)}😀${"y".repeat(200)}`;
    const truncated = truncateSummary(narrative);
    expect(truncated.length).toBeLessThanOrEqual(SUMMARY_MD_LIMIT);
    expect(truncated.endsWith("…")).toBe(true);
    // Well-formed text survives an encode/decode round trip; a lone surrogate does not.
    expect(new TextDecoder().decode(new TextEncoder().encode(truncated))).toBe(truncated);
  });

  test("a cut between the halves of an emoji behind a fence closer posts readable text", () => {
    // The second cut moves back by the closer's length and lands mid-pair.
    const narrative = `\`\`\`\n${"x".repeat(SUMMARY_MD_LIMIT - 10)}😀${"y".repeat(200)}`;
    const truncated = truncateSummary(narrative);
    expect(truncated.length).toBeLessThanOrEqual(SUMMARY_MD_LIMIT);
    expect(truncated.endsWith("\n```…")).toBe(true);
    expect(new TextDecoder().decode(new TextEncoder().encode(truncated))).toBe(truncated);
  });

  test("a cut inside an unclosed fence closes it, so the rest of the body is not code", () => {
    const narrative = `Intro.\n\n\`\`\`ts\n${"const x = 1;\n".repeat(900)}\`\`\`\n\nTail.`;
    const truncated = truncateSummary(narrative);
    const fenceLines = truncated.split("\n").filter((line) => /^ {0,3}`{3,}/.test(line));
    expect(truncated.length).toBe(SUMMARY_MD_LIMIT);
    expect(truncated.endsWith("…")).toBe(true);
    // Opening fence plus the closer the cut appends — an odd count would render
    // everything after the summary as code.
    expect(fenceLines).toHaveLength(2);
  });

  test("a cut inside a fence inside a fold closes the fence before the fold", () => {
    const narrative = `<details>\n<summary>Plan</summary>\n\n\`\`\`md\n${"step\n".repeat(3000)}\`\`\`\n</details>`;
    const truncated = truncateSummary(narrative);
    expect(truncated.length).toBeLessThanOrEqual(SUMMARY_MD_LIMIT);
    // The fence opened inside the fold, so it has to close first.
    expect(truncated.endsWith("```\n\n</details>…")).toBe(true);
    expect((truncated.match(/<details>/g) ?? []).length).toBe((truncated.match(/<\/details>/g) ?? []).length);
  });

  test("a cut inside a tilde fence inside a fold closes the fence before the fold", () => {
    const narrative = `<details>\n<summary>Plan</summary>\n\n~~~md\n${"step\n".repeat(3000)}~~~\n</details>`;
    const truncated = truncateSummary(narrative);
    expect(truncated.length).toBeLessThanOrEqual(SUMMARY_MD_LIMIT);
    // A tilde fence closes with tildes: a backticked closer would leave the
    // block open and hide the fold that answers it.
    expect(truncated.endsWith("~~~\n\n</details>…")).toBe(true);
    expect((truncated.match(/<details>/g) ?? []).length).toBe((truncated.match(/<\/details>/g) ?? []).length);
  });

  test("a narrative without a fence or fold is byte-identical", () => {
    const narrative = "Two issues found.\n\n- **auth**: expiry\n- 100% covered\n";
    expect(truncateSummary(narrative)).toBe(narrative);
  });

  test("an unclosed fence under the budget is closed too", () => {
    // No cut means no ellipsis, but the fence still has to end before the body continues.
    expect(truncateSummary("Intro\n```\ncmd")).toBe("Intro\n```\ncmd\n```");
  });

  test("the closer counts against the budget even when the narrative alone fits", () => {
    // At the limit with an open fence: the passthrough would overshoot by the
    // closer's own length, so the head has to give up that much.
    const narrative = `\`\`\`\n${"x".repeat(SUMMARY_MD_LIMIT - 4)}`;
    expect(narrative).toHaveLength(SUMMARY_MD_LIMIT);
    const truncated = truncateSummary(narrative);
    expect(truncated.length).toBeLessThanOrEqual(SUMMARY_MD_LIMIT);
    expect(truncated).toContain("\n```");
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

  test("a summary cut inside a fence keeps the findings outside the code block", () => {
    const body = buildReviewBody({
      ...output,
      summary_md: `Intro.\n\n\`\`\`ts\n${"const x = 1;\n".repeat(900)}`,
    });
    const findingsAt = body.indexOf("### Findings");
    expect(findingsAt).toBeGreaterThan(-1);
    // The fence has to be balanced before the findings: an open one would
    // render them, and the rest of the review, as code.
    const fenceLines = body.slice(0, findingsAt).split("\n").filter((line) => /^ {0,3}`{3,}/.test(line));
    expect(fenceLines).toHaveLength(2);
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
    // which also keeps the head — would be what removes the footer.
    const body = buildReviewBody({ ...output, summary_md: "x".repeat(REVIEW_BODY_LIMIT * 2) }, 3);
    expect(body).toContain("more findings omitted");
    expect(body.length).toBeLessThanOrEqual(REVIEW_BODY_LIMIT);
  });

  test("an over-long incomplete reason is bounded, so the tail survives the body clamp", () => {
    const body = buildReviewBody(
      {
        ...output,
        verdict: "incomplete",
        findings: [],
        incomplete: { reason: "z".repeat(REVIEW_BODY_LIMIT * 2), unscanned: ["a.ts"] },
      },
      1,
    );
    expect(body).toContain("more findings omitted");
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

  test("a settled verdict publishes a narrative that looks like a fact pair verbatim", () => {
    // The echo strip is scoped to an envelope that CARRIES `incomplete`. A
    // settled verdict's seat narrative is model text, not a restatement of a
    // rendered pair, so those lines stay exactly as the model wrote them.
    const narrative = "Runner recovered.\n\ncause: runner timed out\nunscanned: tests/a.ts";
    const body = buildReviewBody({ ...output, verdict: "needs fixes", findings: [], summary_md: narrative });
    expect(body).toContain(narrative);
    // No pair is rendered above the review section: one line each, and both
    // come from the narrative.
    expect(body.match(/^cause: /gm)).toHaveLength(1);
    expect(body.match(/^unscanned: /gm)).toHaveLength(1);
    expect(body.indexOf("cause: runner timed out")).toBeGreaterThan(body.indexOf("## 📋 Review"));
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
    expect(md.startsWith("<details><summary>Revalidated findings</summary>\n\nReassessed 1/2 prior finding(s) this round")).toBe(true);
    expect(md).toContain("| finding | disposition | evidence | thread |");
    expect(md).toContain("| A \\| b | addressed (verified-fix) | current-code | not yet resolved |");
    expect(md).toContain("| C | dismissed (non-fix-dismissal) | - | - |");
    expect(md).toContain("| D | unverifiable (no-evidence) | - | - |");
    // The line's identity: assessed + invalid-output + omitted === selected.
    expect(buildRevalidatedSection({ ...coverage, invalidOutput: 1, omitted: 0 }, rows)).toContain(
      "Reassessed 1/2 prior finding(s) this round · 1 invalid-output · 0 omitted",
    );
  });

  test("a prior-finding title cannot open an HTML fold around the later sections", () => {
    const rows: ClosureRow[] = [
      {
        title: "<details><summary>prior</summary>",
        disposition: "unverifiable",
        reason: "no-evidence",
        evidenceKind: null,
        thread: "-",
      },
    ];
    const revalidated = buildRevalidatedSection(coverage, rows);
    // The row text is escaped like a report field, so the cell stays text and
    // no tag can fold the rest of the comment.
    expect(revalidated).toContain("&lt;details>&lt;summary>prior&lt;/summary>");
    expect(revalidated.match(/<details>/g)).toHaveLength(1);
    expect(revalidated).not.toContain("<details><summary>prior");

    // `planToFix: "none"` keeps the fix-plan fold out, so any raw `<details>`
    // left in the body would be the injected one.
    const body = buildReviewBody(
      {
        schema: "mstar.review/v1",
        verdict: "needs fixes",
        summary_md: "One issue.",
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
      },
      0,
      { report: { ...report, planToFix: "none" }, revalidated },
    );
    expect(body.match(/<details/g)).toHaveLength(1);
    expect(body.match(/<\/details>/g)).toHaveLength(1);
    const injected = body.indexOf("&lt;details>");
    expect(injected).toBeGreaterThan(-1);
    // Every section that follows the table is still outside the (escaped)
    // fold text — the escape is in place, not just somewhere in the body.
    expect(body.indexOf("### Findings")).toBeLessThan(
      body.indexOf("<summary>Revalidated findings</summary>"),
    );
    for (const section of [
      "### Linked-issue AC",
      "### ✅ Verified",
      "### 🗑️ Considered & rejected",
      "## 🛠️ Plan to fix",
    ]) {
      expect(body.indexOf(section)).toBeGreaterThan(injected);
    }
  });

  test("a dismissed row never claims the defect still stands", () => {
    const rows: ClosureRow[] = [
      { title: "C", disposition: "dismissed", reason: "non-fix-dismissal", evidenceKind: null, thread: "-" },
    ];
    const revalidated = buildRevalidatedSection(coverage, rows);
    // The table renders THIS row's words: it may not claim the defect still
    // stands, because the store closed it as a non-fix dismissal.
    expect(revalidated).not.toContain("still present");
    expect(revalidated).toContain("| C | dismissed (non-fix-dismissal) |");
  });

  test("buildRevalidatedSection marks rows past the display cap", () => {
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
    expect(buildRevalidatedSection(firstRound, [])).toBe("<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>");
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
      "Reassessed 0/0 prior finding(s) this round · 0 invalid-output · 0 omitted · 4 over cap · 4 recheckable",
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
      { report, revalidated: buildRevalidatedSection(coverage, rows) },
    );
    // ONE rendering of the rows, the coverage line and the thread state.
    expect(body.match(/\| finding \| disposition \| evidence \| thread \|/g)).toHaveLength(1);
    expect(body.match(/Reassessed /g)).toHaveLength(1);
    expect(body).toContain("| Fractional expiry comparison | addressed (verified-fix) | diff | - |");
  });

  test("buildReviewBody places every section at its template anchor", () => {
    const body = buildReviewBody(
      {
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
      },
      0,
      { report, revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>" },
    );
    const order = [
      "## 📋 Review",
      "**What this PR does**",
      "Two issues found.",
      "### Findings",
      "#### 🟠 Fractional expiry",
      "<summary>Revalidated findings</summary>",
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
    const body = buildReviewBody(
      { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
      0,
      { report: { ...report, planToFix: plan }, revalidated: "none" },
    );
    expect(body).toContain("`````md\n" + plan + "\n`````");
  });

  test("a zero-finding envelope: the revalidated table self-adds the empty `### Findings`", () => {
    const output: ReviewOutput = { schema: "mstar.review/v1", verdict: "ship it", findings: [] };
    expect(renderReviewMarkdown(output)).not.toContain("### Findings");
    const body = buildReviewBody(output, 0, { report, revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>" });
    expect(body).toContain("<summary>Revalidated findings</summary>");
    // Revalidated FIRST, then the added heading — the fixed template order.
    expect(body.indexOf("### Findings")).toBeLessThan(body.indexOf("<summary>Revalidated findings</summary>"));
    expect(body).toContain("### Linked-issue AC");
  });

  test("a null report keeps every heading and writes `none` under each", () => {
    const body = buildReviewBody(
      { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
      0,
      { report: null, revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>" },
    );
    expect(body).not.toContain("**What this PR does**");
    expect(body).toContain("### Linked-issue AC\n\nnone");
    expect(body).toContain("### ✅ Verified\n\nnone");
    expect(body).toContain("### 🗑️ Considered & rejected\n\nnone");
    expect(body).toContain("## 🛠️ Plan to fix\n\nnone");
    expect(body).not.toContain("<details><summary>Expand fix plan");
  });

  test("a report field cannot forge the findings anchor: `### Findings` stays text", () => {
    const body = buildReviewBody(
      {
        schema: "mstar.review/v1",
        verdict: "needs fixes",
        summary_md: "One issue.",
        findings: [
          { mergeClass: "should-fix", title: "Fractional expiry", body: "b", file_path: "src/auth.ts", line_start: 21, line_end: 21 },
        ],
      },
      0,
      {
        report: { ...report, overview: "Adds a guard.\n### Findings\n#### 🟠 Injected" },
        revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
      },
    );
    // Escaped in place, so the ONLY `### Findings` line is the engine's — the
    // revalidated table still lands directly above it.
    expect(body).toContain("\\### Findings");
    expect(body).toContain("\\#### 🟠 Injected");
    const headings = body.split("\n").filter((line) => /^#{2,4} /.test(line));
    expect(headings).toEqual([
      "## ⚠️ Verdict: `needs fixes`",
      "## 📋 Review",
      "### Findings",
      "#### 🟠 Fractional expiry",
      "### Linked-issue AC",
      "### ✅ Verified",
      "### 🗑️ Considered & rejected",
      "## 🛠️ Plan to fix",
    ]);
  });

  test("an indented ATX heading is neutralized too — markdown reads up to 3 spaces as the same heading", () => {
    const body = buildReviewBody(
      { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
      0,
      {
        report: { ...report, overview: "Adds a guard.\n   ### Findings\n   #### 🟠 Injected" },
        revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
      },
    );
    // The indent is kept and only the marker escaped, so the field stays text
    // and the engine's own headings keep their positions.
    expect(body).toContain("   \\### Findings");
    expect(body).toContain("   \\#### 🟠 Injected");
    const headings = body.split("\n").filter((line) => /^ {0,3}#{1,6} /.test(line));
    expect(headings).toEqual([
      "## ✅ Verdict: `ship it`",
      "## 📋 Review",
      "### Findings",
      "### Linked-issue AC",
      "### ✅ Verified",
      "### 🗑️ Considered & rejected",
      "## 🛠️ Plan to fix",
    ]);
  });

  test("a report field cannot fork the layout: `## 📋 Review` and a `---` fence stay text", () => {
    const body = buildReviewBody(
      { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
      0,
      {
        report: { ...report, verified: "## 📋 Review\n---\nsuite green" },
        revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
      },
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
          revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
        },
      });
      expect(body).toContain("&lt;details");
      // Two folds (revalidated + plan), both closed: nothing the field said
      // can swallow the sections below it.
      expect(body.match(/<details/g)).toHaveLength(2);
      expect(body.match(/<\/details>/g)).toHaveLength(2);
      expect(body.indexOf("### 🗑️ Considered & rejected")).toBeGreaterThan(body.indexOf("&lt;details"));
      expect(body.indexOf("## 🛠️ Plan to fix")).toBeGreaterThan(body.indexOf("### 🗑️ Considered & rejected"));
      expect(body.trimEnd().endsWith(publicationMarker)).toBe(true);
      // `&` is escaped too, so an entity the field already carried stays
      // visible text instead of being re-read as markup.
      expect(body).toContain("R&amp;D &amp;lt;details&amp;gt;");
    }
  });

  test("an unclosed code fence in a report field cannot swallow the sections after it", () => {
    // `~~~` opens a block exactly like backticks: left unclosed it runs to the
    // end of the comment, the sections and the marker lines after it included.
    for (const fence of ["~~~", "```"]) {
      const body = buildReviewBody(
        { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
        0,
        {
          report: { ...report, verified: `- suite green\n${fence}\ntail`, planToFix: "none" },
          revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
        },
      );
      // Escaped in place: the opener stays text and the field is still readable.
      expect(body).toContain(`\n\\${fence}\ntail\n`);
      // No line of the body can open a block at all.
      expect(body.split("\n").filter((line) => /^ {0,3}(`{3,}|~{3,})/.test(line))).toHaveLength(0);
      const escaped = body.indexOf(`\\${fence}`);
      for (const section of ["### 🗑️ Considered & rejected", "## 🛠️ Plan to fix"]) {
        expect(body.indexOf(section)).toBeGreaterThan(escaped);
      }
    }
  });

  test("a GFM delimiter row and a bare ATX heading are neutralized as structure", () => {
    // One dash already delimits a cell; pipes are optional at either end. The
    // escape must land on the marker so no header row can pair with it.
    const cases: Array<[string, string]> = [
      ["Name | Value\n-|-", "\\-|-"],
      ["Name | Value\n--|--", "\\--|--"],
      ["Name | Value\n:---|---:", "\\:---|---:"],
      ["Name | Value\n--- | ---", "\\--- | ---"],
      ["Name | Value\n| --- | --- |", "\\| --- | --- |"],
      ["a | b\n---|---", "\\---|---"],
      ["###", "\\###"],
    ];
    for (const [field, escaped] of cases) {
      const body = buildReviewBody(
        { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
        0,
        {
          report: { ...report, verified: field },
          revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
        },
      );
      expect({ field, escaped: body.includes(escaped) }).toEqual({ field, escaped: true });
    }
  });

  test("every thematic-break form is neutralized: `***`, `___` and spaced runs", () => {
    for (const rule of ["***", "___", "- - -", "* * *", "_ _ _", "----", "==="]) {
      const body = buildReviewBody(
        { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
        0,
        {
          report: { ...report, verified: `suite green\n${rule}\ntail` },
          revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
        },
      );
      expect(body).toContain(`\\${rule}`);
    }
    // A two-dash run is text, not a break: it stays untouched.
    const safe = buildReviewBody(
      { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
      0,
      {
        report: { ...report, verified: "suite green\n-- two dashes" },
        revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
      },
    );
    expect(safe).toContain("\n-- two dashes\n");
  });

  test("CRLF and lone-CR line endings are normalized before neutralization", () => {
    // A CR is a line break to markdown too. Left in place it is the line's last
    // character, so every end-anchored form misses it and `---`, `===` or `-`
    // still renders as a break, a setext underline or a list item.
    const cases: Array<[string, string]> = [
      ["suite green\r\n---\r\ntail", "\\---"],
      ["suite green\r\n===\r\ntail", "\\==="],
      ["suite green\r\n-\r\ntail", "\\-"],
      // Every break in the field is a bare CR.
      ["suite green\r---\rtail", "\\---"],
    ];
    for (const [field, escaped] of cases) {
      const body = buildReviewBody(
        { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
        0,
        // `planToFix: "none"` keeps the fenced plan (whose own `1.` lines are
        // code, not markdown) out of the structural scan below.
        { report: { ...report, verified: field, planToFix: "none" }, revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>" },
      );
      // Escaped in place: the field's text survives and opens no structure.
      expect(body).toContain(`\n${escaped}\ntail\n`);
      expect(body.split("\n").filter((line) => /^ {0,3}([-=]+[ \t]*$|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))/.test(line))).toHaveLength(0);
      // The engine's headings keep their structure and order.
      expect(body.split("\n").filter((line) => /^ {0,3}#{1,6} /.test(line))).toEqual([
        "## ✅ Verdict: `ship it`",
        "## 📋 Review",
        "### Findings",
        "### Linked-issue AC",
        "### ✅ Verified",
        "### 🗑️ Considered & rejected",
        "## 🛠️ Plan to fix",
      ]);
    }
  });

  test("a block marker in a report field is text: a table row, quote or list item cannot absorb the lines under it", () => {
    // The field STARTS with the marker, so the lines a block would absorb are
    // the ones right below it: the field's own tail, then the engine's
    // sections. `planToFix` stays out of the field so the body carries no
    // other list line and the scan below is about the field alone.
    const cases: Array<[string, string[]]> = [
      ["| a | b |\n|---||---|\ntail", ["\\| a | b |", "\\|---||---|"]],
      ["> quoted\nabsorbed", ["\\> quoted"]],
      ["- bullet\nabsorbed", ["\\- bullet"]],
      ["* bullet\nabsorbed", ["\\* bullet"]],
      ["+ bullet\nabsorbed", ["\\+ bullet"]],
      ["1. step\nabsorbed", ["1\\. step"]],
      ["1) step\nabsorbed", ["1\\) step"]],
      // A marker alone on its line opens a block too; the shipped rule accepts
      // line end, so the scan below must as well.
      ["-\nabsorbed", ["\\-"]],
      ["*\nabsorbed", ["\\*"]],
      ["+\nabsorbed", ["\\+"]],
      ["1.\nabsorbed", ["1\\."]],
      ["1)\nabsorbed", ["1\\)"]],
    ];
    for (const [field, escaped] of cases) {
      const body = buildReviewBody(
        { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
        0,
        {
          report: { ...report, verified: field, planToFix: "none" },
          revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
        },
      );
      // Escaped in place: the field's text survives and opens no block.
      for (const line of escaped) expect(body).toContain(`\n${line}\n`);
      // No line of the body still starts a table row, quote or list item.
      expect(body.split("\n").filter((line) => /^ {0,3}([|>]|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))/.test(line))).toHaveLength(0);
      // The engine's sections keep their structure: nothing was absorbed.
      expect(body.split("\n").filter((line) => /^ {0,3}#{1,6} /.test(line))).toEqual([
        "## ✅ Verdict: `ship it`",
        "## 📋 Review",
        "### Findings",
        "### Linked-issue AC",
        "### ✅ Verified",
        "### 🗑️ Considered & rejected",
        "## 🛠️ Plan to fix",
      ]);
    }
  });

  test("every setext-underline form is neutralized — a lone `=` or `-` shapes the line above too", () => {
    for (const underline of ["===", "=", "-------", "-", "  ==="]) {
      const indent = underline.slice(0, underline.length - underline.trimStart().length);
      const marker = underline.slice(indent.length);
      const body = buildReviewBody(
        { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
        0,
        {
          report: { ...report, verified: `suite green\n${underline}\ntail` },
          revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
        },
      );
      // Escaped in place, indent kept: the divider stays text, never a heading.
      expect(body).toContain(`\n${indent}\\${marker}\ntail\n`);
      expect(body.split("\n").filter((line) => /^ {0,3}[-=]+\s*$/.test(line))).toHaveLength(0);
      // The sections after the field keep their levels: no line became setext.
      expect(body.split("\n").filter((line) => /^#{2,4} /.test(line))).toEqual([
        "## ✅ Verdict: `ship it`",
        "## 📋 Review",
        "### Findings",
        "### Linked-issue AC",
        "### ✅ Verified",
        "### 🗑️ Considered & rejected",
        "## 🛠️ Plan to fix",
      ]);
    }
  });

  test("a report section is never prepended above the engine's layout, and composition logs nothing", () => {
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warns.push(String(message));
    try {
      // The overview is anchored under `## 📋 Review`, so it lands inside the
      // engine's layout and never above it — that is what the anchor-miss guard
      // protects. The shipped composer reaches the guard only if the engine
      // drops its heading, so the reachable half is pinned here: nothing is
      // prepended to the renderer's own head, and the composer stays silent.
      const body = buildReviewBody(
        { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
        0,
        { report, revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>" },
      );
      expect(body.startsWith("## ✅ Verdict: `ship it`")).toBe(true);
      expect(body.indexOf("**What this PR does**")).toBeGreaterThan(body.indexOf("## 📋 Review"));
      expect(body).toContain("### Linked-issue AC");
      expect(warns).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a fix plan containing a fence gets a longer outer fence", () => {
    const body = buildReviewBody(
      { schema: "mstar.review/v1", verdict: "ship it", findings: [] },
      0,
      { report: { ...report, planToFix: "```ts\nx\n```" }, revalidated: "none" },
    );
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
      reportParts: { report, revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>" },
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
    expect(body).not.toContain("<summary>Revalidated findings</summary>");
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
    const reportParts = { report, revalidated: "Reassessed 0/0 prior finding(s) this round" };
    const small: ReviewOutput = { schema: "mstar.review/v1", verdict: "blocked", summary_md: "Clamped.", findings: [] };

    // Both clamp sites: the inner body clamp and the prepared-body clamp.
    const inner = buildReviewBody(small, 0, reportParts);
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

  test("a clamp cut inside a tilde fence closes it", () => {
    // A finding body renders verbatim, so its tilde fence reaches the clamp
    // exactly like the fix plan's backticked one.
    const body = buildReviewBody({
      schema: "mstar.review/v1",
      verdict: "needs fixes",
      findings: [
        {
          mergeClass: "must-fix",
          title: "Tilde fence",
          file_path: "src/auth.ts",
          line_start: 1,
          line_end: 1,
          body: `~~~\n${"x".repeat(REVIEW_BODY_LIMIT)}`,
        },
      ],
    });
    expect(body.length).toBeLessThanOrEqual(REVIEW_BODY_LIMIT);
    expect(body).toContain("…");
    // Opener plus the closer the cut appends: an odd count means the trailer
    // and the publication marker render inside the block.
    expect(body.split("\n").filter((line) => /^ {0,3}~{3,}/.test(line))).toHaveLength(2);
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

  const reportDoc: ReportDoc = {
    schema: "mstar.report/v1",
    headSha: "abc1234",
    overview: "Adds an expiry guard to the auth path.",
    linkedIssueAc: "Expiry rejected: met.",
    verified: "- unit suite → green",
    rejected: "**Retry loop**: rejected — the diff never touches it.",
    planToFix: "1. Add the guard.\n2. Rerun the suite.",
  };
  const reportTailHeadings = [
    "### Linked-issue AC",
    "### ✅ Verified",
    "### 🗑️ Considered & rejected",
    "## 🛠️ Plan to fix",
  ];

  test("a body over the limit shortens the core, never the report tail", () => {
    const long: ReviewOutput = {
      schema: "mstar.review/v1",
      verdict: "needs fixes",
      findings: [
        {
          mergeClass: "must-fix",
          title: "Long finding",
          file_path: "src/auth.ts",
          line_start: 1,
          line_end: 1,
          body: "x".repeat(REVIEW_BODY_LIMIT),
        },
      ],
    };
    const body = buildReviewBody(long, 0, {
      report: reportDoc,
      revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
    });
    expect(body.length).toBeLessThanOrEqual(REVIEW_BODY_LIMIT);
    expect(body).toContain("…");
    for (const heading of reportTailHeadings) expect(body).toContain(heading);
    // The plan is the LAST section, so its closed fold proves the tail survived.
    expect(body.endsWith("</details>")).toBe(true);
  });

  test("an over-budget body keeps the omitted-findings footer and the sections that disclose what was cut", () => {
    // The fixture uses the product's own maxima: a narrative at
    // SUMMARY_MD_LIMIT and finding bodies at FINDING_BODY_MAX (the consumer
    // clamps each body to that; it never rejects the review). 27 findings at
    // those sizes is the smallest set that fills the 65000-char body.
    const findings: ReviewFinding[] = Array.from({ length: 27 }, (_, index) => ({
      mergeClass: "should-fix",
      category: "logic",
      file_path: `src/module-${index}.ts`,
      line_start: 1,
      line_end: 2,
      title: `Finding ${index}`,
      body: "x".repeat(FINDING_BODY_MAX),
    }));
    const output: ReviewOutput = {
      schema: "mstar.review/v1",
      verdict: "needs fixes",
      summary_md: "n".repeat(SUMMARY_MD_LIMIT),
      findings,
    };
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const body = buildPreparedReviewBody({
      output,
      omittedFindings: 3,
      round: 9,
      headSha,
      publicationMarker: buildPublicationMarker({
        publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        headSha,
        kind: "review",
      }),
      reportParts: {
        report: reportDoc,
        revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
      },
    });
    expect(body.length).toBeLessThanOrEqual(REVIEW_BODY_LIMIT);
    // The cut happened, so the fixture really is over budget.
    expect(body).toContain("…");
    // The finding tail is what the head clamp drops; the footer is the only
    // line that says the review is a Top-N subset, so it must survive.
    expect(body).toContain("*(+3 more findings omitted)*");
    // The closure is reserved with the other preserved parts, so the cut
    // cannot take it.
    expect(body).toContain("<summary>Revalidated findings</summary>");
    for (const heading of reportTailHeadings) expect(body).toContain(heading);
  });

  test("an oversized plan is truncated before any report section is dropped", () => {
    const small: ReviewOutput = { schema: "mstar.review/v1", verdict: "blocked", summary_md: "Clamped.", findings: [] };
    const body = buildReviewBody(small, 0, {
      report: { ...reportDoc, planToFix: "x".repeat(REVIEW_BODY_LIMIT * 2) },
      revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
    });
    expect(body.length).toBeLessThanOrEqual(REVIEW_BODY_LIMIT);
    for (const heading of reportTailHeadings) expect(body).toContain(heading);
    expect(body).toContain("…");
    // Fence and fold stay balanced: opener plus closer each, nothing swallowed.
    expect(fenceLines(body)).toHaveLength(2);
    expect((body.match(/<details>/g) ?? []).length).toBe(
      (body.match(/<\/details>/g) ?? []).length,
    );
    // The closure and the plan fold both survive the oversized plan.
    expect(body).toContain("<summary>Revalidated findings</summary>");
    expect(body).toContain("<summary>Expand fix plan</summary>");
  });

  test("a limit that forces degradation keeps every heading, marks each dropped body, and stays inside it", () => {
    const small: ReviewOutput = { schema: "mstar.review/v1", verdict: "blocked", summary_md: "Clamped.", findings: [] };
    const limit = 500;
    const body = buildReviewBody(
      small,
      0,
      {
        report: {
          ...reportDoc,
          linkedIssueAc: "a".repeat(400),
          verified: "b".repeat(400),
          rejected: "c".repeat(400),
          planToFix: "x".repeat(REVIEW_BODY_LIMIT),
        },
        revalidated: "<details><summary>Revalidated findings</summary>\n\nnone\n\n</details>",
      },
      limit,
    );
    expect(body.length).toBeLessThanOrEqual(limit);
    const positions = reportTailHeadings.map((heading) => body.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    // No body quietly vanished: the three section bodies this limit cannot
    // afford render the marker under their headings, and the plan block has no
    // room left for a balanced fence and fold.
    expect(body.split(TRUNCATION_MARKER)).toHaveLength(4);
    expect(body).toContain(`${reportTailHeadings[3]}\n\nnone`);
  });

  test("without report parts the body is the pre-report shape, unchanged", () => {
    const small: ReviewOutput = { schema: "mstar.review/v1", verdict: "ship it", summary_md: "Fine.", findings: [] };
    expect(buildReviewBody(small, 2)).toBe(
      `${renderReviewMarkdown(small)}\n\n*(+2 more findings omitted)*`,
    );
    expect(buildReviewBody(small)).not.toContain("### Linked-issue AC");
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
