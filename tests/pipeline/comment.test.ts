/**
 * Review comment assembly tests (plan 07 Task 3 + Phase 5 B1/B4 +
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
 *   - plan 09 T4 deep lock: a deep-path envelope (parent-session yield,
 *     same mstar.review/v1 shape) posts through the SAME COMMENT/upsert
 *     path — `pulls.createReview` is present on the client but never
 *     called, and no call carries `event` / APPROVE / REQUEST_CHANGES
 */

import { describe, expect, mock, test } from "bun:test";
import {
  buildDegradedBody,
  buildReviewBody,
  buildUpsertBody,
  DEGRADED_EXCERPT_LIMIT,
  findDegradedComment,
  findReviewComment,
  parseDegradedRound,
  parseReviewRound,
  planDegradedUpsert,
  planUpsert,
  postDegradedWithOctokit,
  postReviewWithOctokit,
  renderFindings,
  REVIEW_BODY_LIMIT,
  SUMMARY_MD_LIMIT,
  truncateSummary,
  type PostOctokit,
} from "../../src/pipeline/comment";
import type { ReviewFinding, ReviewOutput } from "../../src/review/schema";

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

  describe("buildUpsertBody", () => {
    test("first line is the hidden marker, then the round header, then the review body", () => {
      const body = buildUpsertBody(output, 0, 2, "0123456789abcdef0123456789abcdef01234567");
      const lines = body.split("\n");
      expect(lines[0]).toBe("<!-- mstar-inspector:review:v1 round=2 -->");
      expect(lines[1]).toBe("第 2 次 review · commit 0123456");
      expect(body).toContain("**Verdict: blocked**");
      expect(body).toContain("One must-fix blocks the merge.");
    });

    test("omitted-findings footer still renders after the review body", () => {
      const body = buildUpsertBody(output, 10, 1, "abc1234");
      expect(body.endsWith("\n\n*(+10 more findings omitted)*")).toBe(true);
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

  test("an over-limit assembled body is clamped under the GitHub 65536-char cap, marker/header intact", () => {
    const body = buildUpsertBody(output, 0, 4, "0123456789abcdef0123456789abcdef01234567");
    expect(body.length).toBeLessThan(65536);
    expect(body.startsWith("<!-- mstar-inspector:review:v1 round=4 -->\n")).toBe(true);
    expect(body.endsWith("…")).toBe(true);
  });

  test("within-limit bodies pass through verbatim", () => {
    const small: ReviewOutput = { ...output, summary_md: "small" };
    const body = buildUpsertBody(small, 0, 1, "abc1234");
    expect(body.endsWith("…")).toBe(false);
    expect(body).toContain("small");
  });
});

describe("postReview wiring (mock octokit, SG-001)", () => {
  const output: ReviewOutput = {
    schema: "mstar.review/v1",
    verdict: "blocked",
    summary_md: "One must-fix blocks the merge.",
    findings: [],
  };
  const input = {
    installationId: 1,
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    output,
  };

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
            return {};
          }),
        },
      },
    };
    return { calls, octokit };
  }

  test("paginates the full comment list with the issues.listComments call shape (WF-001)", async () => {
    const { calls, octokit } = mockOctok([]);
    await postReviewWithOctokit(octokit, input);
    expect(calls.listRoute).toBe(octokit.rest.issues.listComments);
    expect(calls.listParams).toEqual({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      per_page: 100,
    });
  });

  test("no marker comment → createComment with a round=1 body+marker", async () => {
    const { calls, octokit } = mockOctok([{ id: 1, body: "a human comment" }]);
    await postReviewWithOctokit(octokit, input);
    expect(calls.updateParams).toBeUndefined();
    expect(calls.createParams).toMatchObject({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
    });
    expect(String(calls.createParams!.body)).toMatch(/^<!-- mstar-inspector:review:v1 round=1 -->/);
  });

  test("marker hit → updateComment with round+1 (same PR never gets a new comment per round)", async () => {
    const { calls, octokit } = mockOctok([
      { id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\n第 2 次 review", user: { type: "Bot" } },
    ]);
    await postReviewWithOctokit(octokit, input);
    expect(calls.createParams).toBeUndefined();
    expect(calls.updateParams).toMatchObject({ owner: "acme", repo: "widgets", comment_id: 7 });
    expect(String(calls.updateParams!.body)).toMatch(/^<!-- mstar-inspector:review:v1 round=3 -->/);
  });

  test("returns the round just posted: create → 1, marker hit → next round (T3-M4 / qc3 F-104)", async () => {
    // The consumer pins the line-comments marker body to postReview's
    // RETURN (single-sourced from the upsert scan) — the contract is pinned
    // at the real postReviewWithOctokit, not only the consumer fake seam.
    const create = mockOctok([]);
    await expect(postReviewWithOctokit(create.octokit, input)).resolves.toBe(1);
    const update = mockOctok([
      { id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\nRound 2", user: { type: "Bot" } },
    ]);
    await expect(postReviewWithOctokit(update.octokit, input)).resolves.toBe(3);
  });

  test("blocked and ship it both post with NO review event, never REQUEST_CHANGES/APPROVE (mapping spec §2)", async () => {
    for (const verdict of ["blocked", "ship it"] as const) {
      const { calls, octokit } = mockOctok([]);
      await postReviewWithOctokit(octokit, { ...input, output: { ...output, verdict } });

      // Every captured octokit call: Issues comments API only — no `event`
      // parameter, no APPROVE/REQUEST_CHANGES anywhere.
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

  test("deep envelope posts COMMENT-only: pulls.createReview never called, no event/APPROVE/REQUEST_CHANGES (plan 09 T4)", async () => {
    // Representative deep-path envelope: the plan 09 T2 parent session
    // yields exactly this mstar.review/v1 shape and the consumer forwards
    // it here unchanged — the poster must stay on the Issues comments API.
    const deepOutput: ReviewOutput = {
      schema: "mstar.review/v1",
      verdict: "needs fixes",
      summary_md: "Deep three-stage parent-session review.",
      findings: [finding("must-fix", "Deep seat must-fix"), finding("nit", "Deep seat nit")],
    };

    // Both write branches: create on a marker miss, update on a hit.
    for (const comments of [
      [],
      [{ id: 7, body: "<!-- mstar-inspector:review:v1 round=1 -->\n第 1 次 review", user: { type: "Bot" } }],
    ]) {
      const { calls, octokit } = mockOctok(comments);
      const createReview = mock(async () => {
        throw new Error("pulls.createReview must never be called (SEC-01: COMMENT-only posting)");
      });
      // `pulls` sits on PostOctokit for plan 18 T3 line comments, but the
      // OVERALL poster must never touch it — a variable (not a fresh
      // literal) keeps the extra trap assignable while proving postReview
      // stays on the Issues comments API.
      const withPulls = { ...octokit, rest: { ...octokit.rest, pulls: { createReview } } };
      await postReviewWithOctokit(withPulls, { ...input, output: deepOutput });

      expect(createReview).not.toHaveBeenCalled();
      for (const captured of [calls.listParams, calls.updateParams, calls.createParams]) {
        if (captured === undefined) continue;
        expect("event" in captured).toBe(false);
        expect(JSON.stringify(captured)).not.toContain("REQUEST_CHANGES");
        expect(JSON.stringify(captured)).not.toContain("APPROVE");
      }
      const posted = calls.createParams ?? calls.updateParams;
      expect(posted).toBeDefined();
      expect(String(posted!.body)).toContain("**Verdict: needs fixes**");
      expect(String(posted!.body)).toContain("Deep seat must-fix");
    }
  });

  test("updateComment 404 → soft-recovery fallback to createComment round=1 (WF-003)", async () => {
    const notFound = Object.assign(new Error("not found"), { status: 404 });
    const { calls, octokit } = mockOctok(
      [{ id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\n第 2 次 review", user: { type: "Bot" } }],
      notFound,
    );
    await postReviewWithOctokit(octokit, input);
    expect(calls.updateParams).toMatchObject({ comment_id: 7 });
    expect(String(calls.createParams!.body)).toMatch(/^<!-- mstar-inspector:review:v1 round=1 -->/);
  });


  test("updateComment 403 on a foreign bot's marker → treat as a miss, create round=1 (qc2 F-002)", async () => {
    const forbidden = Object.assign(new Error("forbidden"), { status: 403 });
    const { calls, octokit } = mockOctok(
      [{ id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\nforeign bot", user: { type: "Bot" } }],
      forbidden,
    );
    await postReviewWithOctokit(octokit, input);
    expect(calls.updateParams).toMatchObject({ comment_id: 7 });
    expect(String(calls.createParams!.body)).toMatch(/^<!-- mstar-inspector:review:v1 round=1 -->/);
  });

  test("updateComment 403 on the oldest marker → replan updates the NEXT bot marker (qc2 F-002)", async () => {
    const comments = [
      { id: 7, body: "<!-- mstar-inspector:review:v1 round=1 -->\nforeign bot", user: { type: "Bot" } },
      { id: 8, body: "<!-- mstar-inspector:review:v1 round=2 -->\nours", user: { type: "Bot" } },
    ];
    const updatedIds: number[] = [];
    const created: string[] = [];
    const octokit: PostOctokit = {
      paginate: mock(async () => comments),
      rest: {
        issues: {
          listComments: mock(async () => {
            throw new Error("unexpected: listComments is driven through paginate");
          }),
          updateComment: mock(async (params: Record<string, unknown>) => {
            updatedIds.push(params.comment_id as number);
            if (params.comment_id === 7) throw Object.assign(new Error("forbidden"), { status: 403 });
            return {};
          }),
          createComment: mock(async (params: Record<string, unknown>) => {
            created.push(String(params.body));
            return {};
          }),
        },
      },
    };
    await postReviewWithOctokit(octokit, input);
    expect(updatedIds).toEqual([7, 8]);
    expect(created).toHaveLength(0);
  });
  test("non-404 updateComment errors rethrow (no fallback)", async () => {
    const { octokit } = mockOctok(
      [{ id: 7, body: "<!-- mstar-inspector:review:v1 round=2 -->\n第 2 次 review", user: { type: "Bot" } }],
      new Error("rate limited"),
    );
    await expect(postReviewWithOctokit(octokit, input)).rejects.toThrow("rate limited");
  });
});

// ---------------------------------------------------------------------------
// Degraded chain (plan 18 Task 2 / architect AL-1)
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

describe("postDegraded wiring (mock octokit)", () => {
  const degradeInput = {
    installationId: 1,
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    error: "not valid ReviewOutput JSON",
    rawOutput: "not json at all",
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
            return {};
          }),
        },
      },
    };
    return { calls, octokit };
  }

  test("no degraded marker → createComment with a round=1 degraded body", async () => {
    const { calls, octokit } = mockOctok([{ id: 1, body: "a human comment" }]);
    await postDegradedWithOctokit(octokit, degradeInput);
    expect(calls.createParams).toMatchObject({ owner: "acme", repo: "widgets", issue_number: 42 });
    const body = String(calls.createParams!.body);
    expect(body).toMatch(/^<!-- mstar-inspector:review-degraded:v1 round=1 -->/);
    expect(body).toContain("**Review degraded: output failed schema validation**");
  });

  test("a REAL review marker does not satisfy the degraded scan — still creates round=1", async () => {
    const { calls, octokit } = mockOctok([botReviewMarker(7, 3)]);
    await postDegradedWithOctokit(octokit, degradeInput);
    expect(calls.updateParams).toBeUndefined();
    expect(String(calls.createParams!.body)).toMatch(/^<!-- mstar-inspector:review-degraded:v1 round=1 -->/);
  });

  test("degraded marker hit → updateComment with round=N+1; 404 → replan to create round=1 (WF-003 parity)", async () => {
    const { calls, octokit } = mockOctok([degradedBotMarker(7, 2)]);
    await postDegradedWithOctokit(octokit, degradeInput);
    expect(String(calls.updateParams!.body)).toMatch(/^<!-- mstar-inspector:review-degraded:v1 round=3 -->/);

    const notFound = Object.assign(new Error("not found"), { status: 404 });
    const recovery = mockOctok([degradedBotMarker(7, 2)], notFound);
    await postDegradedWithOctokit(recovery.octokit, degradeInput);
    expect(String(recovery.calls.createParams!.body)).toMatch(/^<!-- mstar-inspector:review-degraded:v1 round=1 -->/);
  });
});

describe("missing octokit surface → per-chain error noun (review feedback fix)", () => {
  test("the review chain names the review comment; the degraded chain names the degraded comment", async () => {
    const bare = {} as PostOctokit;
    await expect(
      postReviewWithOctokit(bare, {
        installationId: 1,
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        output: { schema: "mstar.review/v1", verdict: "blocked", summary_md: "s", findings: [] },
      }),
    ).rejects.toThrow(/cannot upsert the review comment/);
    await expect(
      postDegradedWithOctokit(bare, {
        installationId: 1,
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
        error: "not valid ReviewOutput JSON",
        rawOutput: "not json at all",
      }),
    ).rejects.toThrow(/cannot upsert the degraded comment/);
  });
});
