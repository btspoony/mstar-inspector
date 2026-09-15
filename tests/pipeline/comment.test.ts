/**
 * Review comment assembly tests (Phase 5 B1/B4 +
 * postdeploy feedback T5) — pure functions (the posting wiring is covered
 * with a mock octokit; see "postReview wiring" below).
 *
 * Acceptance points:
 *   - the harness verdict (ship it | needs fixes | blocked) is rendered
 *     VERBATIM as text in the body header; `blocked` and `ship it` bodies
 *     carry NO REQUEST_CHANGES / APPROVE mapping — the Issues comments API
 *     has no review event at all, and the octokit calls carry no `event`
 *     (SEC-01, structural; mapping spec §2)
 *   - findings are grouped and listed BY merge class (must-fix / should-fix
 *     / nit verbatim; mapping spec §3), category rendered verbatim
 *   - summary_md truncated at 8000 chars
 *   - tally line rendered when the envelope carries a PrTallyResult
 *   - omitted-findings footer when the merge-class cap dropped findings (B4)
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
import {
  buildDegradedBody,
  buildPreparedDegradedBody,
  buildPreparedReviewBody,
  buildPublicationMarker,
  buildReviewBody,
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
  renderFindings,
  REVIEW_BODY_LIMIT,
  SUMMARY_MD_LIMIT,
  truncateSummary,
  type CommenterFetch,
  type PostOctokit,
} from "../../src/pipeline/comment";
import type { ReviewFinding, ReviewOutput } from "../../src/review/schema";
import { computeFindingFingerprint } from "../../src/store/fingerprint";
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

describe("renderFindings", () => {
  test("groups findings BY merge class in engine order, class verbatim", () => {
    const md = renderFindings([
      finding("should-fix", "Should fix"),
      finding("must-fix", "Must fix"),
      finding("nit", "Nit"),
    ]);
    const mustFix = md.indexOf("### 🔴 must-fix");
    const shouldFix = md.indexOf("### 🟠 should-fix");
    const nit = md.indexOf("### 🔵 nit");
    expect(mustFix).toBeGreaterThan(-1);
    expect(shouldFix).toBeGreaterThan(mustFix);
    expect(nit).toBeGreaterThan(shouldFix);
    expect(md).toContain("**Must fix**");
    expect(md).toContain("**Nit**");
  });

  test("omits merge classes with no findings", () => {
    const md = renderFindings([finding("nit", "Only a nit")]);
    expect(md).not.toContain("must-fix");
    expect(md).not.toContain("should-fix");
    expect(md).toContain("### 🔵 nit");
  });

  test("renders category and location verbatim", () => {
    const md = renderFindings([finding("must-fix", "Fractional expiry comparison")]);
    expect(md).toContain("(logic)");
    expect(md).toContain("src/auth.ts:21");
    expect(md).toContain("`Fractional expiry comparison` body.");
  });

  test("renders repo-wide when the finding has no file scope", () => {
    const md = renderFindings([
      { mergeClass: "nit", file_path: null, line_start: null, line_end: null, title: "Note", body: "" },
    ]);
    expect(md).toContain("repo-wide");
    expect(md).toContain("**Note**");
  });

  test("returns an empty string for no findings", () => {
    expect(renderFindings([])).toBe("");
  });
  test("marks a finding whose fingerprint appeared in the previous round as repeat, still listed", () => {
    const f = finding("should-fix", "Fractional expiry comparison");
    const md = renderFindings([f], new Set([computeFindingFingerprint(f)]));
    expect(md).toContain("**Fractional expiry comparison**");
    expect(md).toContain("*(repeat)*");
  });

  test("does not mark findings whose fingerprint differs from the previous round", () => {
    const f = finding("should-fix", "Fractional expiry comparison");
    const other = finding("should-fix", "A different issue");
    const md = renderFindings([f], new Set([computeFindingFingerprint(other)]));
    expect(md).not.toContain("*(repeat)*");
  });
});

describe("buildReviewBody", () => {
  const output: ReviewOutput = {
    schema: "mstar.review/v1",
    verdict: "needs fixes",
    summary_md: "Two issues found in the diff.",
    findings: [finding("should-fix", "Fractional expiry comparison")],
  };

  test("renders the harness verdict verbatim as text (mapping spec §3)", () => {
    const body = buildReviewBody(output);
    expect(body.startsWith("**Verdict: needs fixes**")).toBe(true);
    expect(body).toContain("Two issues found in the diff.");
    expect(body).toContain("## Findings");
    expect(body).toContain("### 🟠 should-fix");
    expect(body).toContain("**Fractional expiry comparison**");
  });

  test("blocked and ship it verdicts never carry REQUEST_CHANGES/APPROVE mapping", () => {
    for (const verdict of ["blocked", "ship it"] as const) {
      const body = buildReviewBody({ ...output, verdict });
      expect(body).toContain(`**Verdict: ${verdict}**`);
      expect(body).not.toContain("REQUEST_CHANGES");
      expect(body).not.toContain("APPROVE");
    }
  });

  test("renders the tally line when the envelope carries a PrTallyResult (§3)", () => {
    const body = buildReviewBody({
      ...output,
      tally: {
        verdict: "needs fixes",
        scorePct: 45,
        tally: { mustFix: 0, shouldFix: 2, nit: 1, unverified: 1 },
        chatHeader: "unused here",
      },
    });
    expect(body).toContain("**Tally:** 🔴 must-fix 0 · 🟠 should-fix 2 · 🔵 nit 1 · ❓ unverified 1");
  });

  test("no tally line when the envelope has no tally", () => {
    expect(buildReviewBody(output)).not.toContain("Tally:");
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
    expect(body).toBe("**Verdict: needs fixes**\n\nTwo issues found in the diff.");
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
  test("tally counts exclude repeats when a previous-round fingerprint set is provided (AL-21-2)", () => {
    const repeat = finding("should-fix", "Fractional expiry comparison");
    const fresh = finding("should-fix", "Fresh issue");
    const body = buildReviewBody(
      {
        ...output,
        findings: [repeat, fresh],
        tally: {
          verdict: "needs fixes",
          scorePct: 45,
          tally: { mustFix: 0, shouldFix: 2, nit: 0, unverified: 1 },
          chatHeader: "unused here",
        },
      },
      0,
      new Set([computeFindingFingerprint(repeat)]),
    );
    // should-fix 2 → 1 (the repeat is still listed but no longer re-voted);
    // unverified keeps the envelope value (fingerprint-less list).
    expect(body).toContain("**Tally:** 🔴 must-fix 0 · 🟠 should-fix 1 · 🔵 nit 0 · ❓ unverified 1");
    expect(body).toContain("*(repeat)*");
  });

  test("first round (no previous fingerprints) keeps the envelope tally verbatim, no repeat markers", () => {
    const body = buildReviewBody({
      ...output,
      findings: [finding("should-fix", "Fractional expiry comparison")],
      tally: {
        verdict: "needs fixes",
        scorePct: 45,
        tally: { mustFix: 0, shouldFix: 2, nit: 1, unverified: 1 },
        chatHeader: "unused here",
      },
    });
    expect(body).toContain("**Tally:** 🔴 must-fix 0 · 🟠 should-fix 2 · 🔵 nit 1 · ❓ unverified 1");
    expect(body).not.toContain("*(repeat)*");
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
      expect(parseReviewRound("<!-- mstar-inspector:review:v1 round=3 -->\n第 3 次 review · commit abc1234")).toBe(3);
    });

    test("returns null for a body without the marker", () => {
      expect(parseReviewRound("**Verdict: blocked**")).toBeNull();
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
    body: `<!-- mstar-inspector:review:v1 round=${round} -->\n第 ${round} 次 review`,
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

    test("first line is the hidden round marker, then the round header, last line the publication marker", () => {
      const body = buildPreparedReviewBody({
        output,
        omittedFindings: 0,
        round: 2,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        publicationMarker,
      });
      const lines = body.split("\n");
      expect(lines[0]).toBe("<!-- mstar-inspector:review:v1 round=2 -->");
      expect(lines[1]).toBe("第 2 次 review · commit 0123456");
      expect(lines[lines.length - 1]).toBe(publicationMarker);
      expect(body).toContain("**Verdict: blocked**");
      expect(body).toContain("One must-fix blocks the merge.");
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
        previousFingerprints: new Set(["deadbeefdeadbeef"]),
        publicationMarker,
      });
      const lines = body.split("\n");
      expect(lines[0]).toBe("<!-- mstar-inspector:review:v1 round=3 -->");
      expect(lines[1]).toBe("第 3 次 review · commit 0123456");
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
describe("REVIEW_BODY_LIMIT clamp (qc2 F-003 / qc3 F-304)", () => {
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
      mockOctok([{ id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\n第 2 次 review", user: { type: "Bot" } }]).octokit,
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
      [{ id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\n第 2 次 review", user: { type: "Bot" } }],
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
      expect(String(calls.createParams!.body)).toContain(`**Verdict: ${verdict}**`);
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
  body: `<!-- mstar-inspector:review:v1 round=${round} -->\n第 ${round} 次 review`,
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
