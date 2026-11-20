/**
 * Line-comments tests (architect AL-3, layered delivery):
 *   - parseDiffHunkRanges: multi-file diffs, renames (b-side path), binary /
 *     deleted files, omitted hunk counts, context ranges, and hunk-body
 *     content lines that masquerade as `+++ ` file headers
 *   - filterLineCommentFindings: base layer (file_path non-empty AND
 *     line_end ≥ 1), hunk layer (b-side exact path match + line_end inside
 *     a right-side hunk range), multi-line range demotion (both endpoints
 *     inside ONE hunk), prefetch-failed draft semantics (diff
 *     undefined → base layer alone)
 *   - buildLineCommentBody: title + merge-class tag + body, FINDING_BODY_MAX
 *     clamp on the assembled comment
 *   - postLineCommentsWithOctokit: createReview request-body pin (path /
 *     side / line / event + REQUIRED top-level marker body), the multi-line
 *     start_line + start_side shape, empty qualifying set → zero API calls,
 *     missing pulls surface → named error
 *   - fetchPrDiffWithOctokit: pulls.get diff-mediaType pin + response
 *     extraction (the consumer-level prefetch-failure → base-filter attempt
 *     and 422 → line_comments_fallback behaviors live in consumer.test.ts)
 */

import { describe, expect, mock, test } from "bun:test";
import { REVIEW_EMOJI } from "@mstar-harness/engine";
import {
  filterLineCommentFindings,
  parseDiffHunkRanges,
  postLineCommentsWithOctokit,
  renderLineCommentText,
  type PostOctokit,
} from "../../src/pipeline/comment";
import { buildLineCommentBody } from "../../src/pipeline/review-threads";
import { FINDING_BODY_MAX, type ReviewFinding } from "../../src/review/schema";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Two-hunk src/auth.ts diff: right ranges [10,13] and [33,37]. */
const AUTH_DIFF = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -10,3 +10,4 @@ function verify() {",
  " const a = 1;",
  "-old();",
  "+newOne();",
  "+newTwo();",
  " const b = 2;",
  "@@ -30,2 +33,5 @@ function audit() {",
  " const c = 3;",
  "+log(c);",
  "+log2(c);",
  "+log3(c);",
  " const d = 4;",
].join("\n");

/** Rename (b-side new path) + deleted + binary + a second text file. */
const MIXED_DIFF = [
  "diff --git a/src/old-name.ts b/src/new-name.ts",
  "similarity index 90%",
  "rename from src/old-name.ts",
  "rename to src/new-name.ts",
  "index 3333333..4444444 100644",
  "--- a/src/old-name.ts",
  "+++ b/src/new-name.ts",
  "@@ -1,2 +1,3 @@",
  " ctx",
  "-old",
  "+new1",
  "+new2",
  "diff --git a/src/dead.ts b/src/dead.ts",
  "deleted file mode 100644",
  "index 5555555..0000000",
  "--- a/src/dead.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-line1",
  "-line2",
  "diff --git a/assets/logo.png b/assets/logo.png",
  "index 6666666..7777777 100644",
  "Binary files a/assets/logo.png and b/assets/logo.png differ",
  "diff --git a/docs/guide.md b/docs/guide.md",
  "index 8888888..9999999 100644",
  "--- a/docs/guide.md",
  "+++ b/docs/guide.md",
  "@@ -5 +5,2 @@",
  " paragraph",
  "+added sentence",
].join("\n");

function findingAt(path: string | null, lineEnd: number | null, title = "F"): ReviewFinding {
  return {
    mergeClass: "must-fix",
    category: "logic",
    file_path: path,
    line_start: lineEnd,
    line_end: lineEnd,
    title,
    body: `${title} body.`,
  };
}

describe("parseDiffHunkRanges", () => {
  test("multi-hunk file: right-side ranges per hunk, context counted", () => {
    expect(parseDiffHunkRanges(AUTH_DIFF)).toEqual(
      new Map([["src/auth.ts", [[10, 13], [33, 37]]]]),
    );
  });

  test("rename binds the b-side (new) path; deleted and binary files carry no right ranges", () => {
    const ranges = parseDiffHunkRanges(MIXED_DIFF);
    expect(ranges.get("src/new-name.ts")).toEqual([[1, 3]]);
    expect(ranges.has("src/old-name.ts")).toBe(false); // a-side path never binds
    expect(ranges.has("src/dead.ts")).toBe(false); // +++ /dev/null → no right side
    expect(ranges.has("assets/logo.png")).toBe(false); // binary: no hunks
    // Omitted old-side count (`@@ -5 +5,2 @@`) defaults to 1.
    expect(ranges.get("docs/guide.md")).toEqual([[5, 6]]);
  });

  test("hunk-body content lines starting with '++' never masquerade as +++ file headers", () => {
    const tricky = [
      "diff --git a/src/tricky.ts b/src/tricky.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tricky.ts",
      "+++ b/src/tricky.ts",
      "@@ -1,1 +1,2 @@",
      " const x = 1;",
      "+++ this is an ADDED content line (prefix + plus content '++ …')",
    ].join("\n");
    expect(parseDiffHunkRanges(tricky)).toEqual(new Map([["src/tricky.ts", [[1, 2]]]]));
  });

  test("new-file hunk (`@@ -0,0 +1,2 @@`) produces the [1,2] right range", () => {
    const empty = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
    ].join("\n");
    expect(parseDiffHunkRanges(empty)).toEqual(new Map([["src/new.ts", [[1, 2]]]]));
  });

  test("space-bearing b-side paths ride the UNQUOTED b/ strip and bind (git does not quote plain spaces) (T3-M2 / qc3 F-103)", () => {
    // Real git output for a path with spaces is UNQUOTED
    // (`+++ b/space dir/has spaces.ts`) — the b/ strip binds the raw path
    // and a finding whose file_path carries the space matches.
    const spaces = [
      "diff --git a/src/space dir/has spaces.ts b/src/space dir/has spaces.ts",
      "index 1111111..2222222 100644",
      "--- a/src/space dir/has spaces.ts",
      "+++ b/src/space dir/has spaces.ts",
      "@@ -1,1 +1,2 @@",
      " const x = 1;",
      "+fixed",
    ].join("\n");
    expect(parseDiffHunkRanges(spaces)).toEqual(
      new Map([["src/space dir/has spaces.ts", [[1, 2]]]]),
    );
  });

  test("C-quoted b-side path whose JSON.parse succeeds unquotes via the best-effort branch (T3-M2 / qc3 F-103)", () => {
    // Real git quotes only escape-requiring paths (`+++ "b/with\"quote.ts"`).
    // The b/ strip runs BEFORE the unquote, so the JSON-parsed value keeps
    // the prefix and exact-matches no finding's file_path — the safe
    // direction (excluded). Pin the branch's parse result verbatim against
    // a refactor silently changing it.
    const quoted = [
      'diff --git "a/with\\"quote.ts" "b/with\\"quote.ts"',
      "index 1111111..2222222 100644",
      '--- "a/with\\"quote.ts"',
      '+++ "b/with\\"quote.ts"',
      "@@ -1,1 +1,2 @@",
      " const x = 1;",
      "+fixed",
    ].join("\n");
    expect(parseDiffHunkRanges(quoted).has('b/with"quote.ts')).toBe(true);
  });

  test("unquotable quoted b-side path (octal escapes) keeps the raw quoted path → matches nothing (excluded)", () => {
    // Real git form for non-ASCII paths (`+++ "b/h\303\251.go"`): JSON.parse
    // throws on the octal escapes, the raw quoted target stays as the key,
    // and the exact-match layer excludes the finding — no 422.
    const unquotable = [
      "diff --git \"a/h\\303\\251.go\" \"b/h\\303\\251.go\"",
      "index 1111111..2222222 100644",
      "--- \"a/h\\303\\251.go\"",
      "+++ \"b/h\\303\\251.go\"",
      "@@ -1,1 +1,2 @@",
      " const x = 1;",
      "+fixed",
    ].join("\n");
    expect(parseDiffHunkRanges(unquotable).has('"b/h\\303\\251.go"')).toBe(true);
    expect(parseDiffHunkRanges(unquotable).has("h é.go")).toBe(false);
  });
});

describe("filterLineCommentFindings", () => {
  test("base layer: no file_path / no line_end / line_end < 1 → excluded, even without a diff", () => {
    const findings = [
      findingAt(null, 5, "no-path"),
      findingAt("", 5, "empty-path"),
      findingAt("src/auth.ts", null, "no-line"),
      findingAt("src/auth.ts", 0, "zero-line"),
      findingAt("src/auth.ts", 11, "ok"),
    ];
    expect(filterLineCommentFindings(findings).map(({ finding }) => finding.title)).toEqual(["ok"]);
    // diff undefined (prefetch failed) → base layer alone, no hunk check.
    expect(filterLineCommentFindings(findings, undefined).map(({ finding }) => finding.title)).toEqual(["ok"]);
  });

  test("hunk layer: b-side exact path match + line_end inside a right-side hunk range (boundaries inclusive)", () => {
    const findings = [
      findingAt("src/auth.ts", 10, "hunk-start"), // boundary
      findingAt("src/auth.ts", 13, "hunk-end"), // boundary
      findingAt("src/auth.ts", 14, "between-hunks"),
      findingAt("src/auth.ts", 35, "second-hunk"),
      findingAt("src/auth.ts", 100, "outside"),
      findingAt("src/other.ts", 11, "absent-path"),
      findingAt("src/old-name.ts", 2, "a-side-only"),
      findingAt("src/new-name.ts", 2, "renamed-hit"),
    ];
    expect(filterLineCommentFindings(findings, `${AUTH_DIFF}\n${MIXED_DIFF}`).map(({ finding }) => finding.title)).toEqual([
      "hunk-start",
      "hunk-end",
      "second-hunk",
      "renamed-hit",
    ]);
  });

  test("deleted and binary files have no right hunks → excluded", () => {
    const findings = [findingAt("src/dead.ts", 1, "deleted"), findingAt("assets/logo.png", 1, "binary")];
    expect(filterLineCommentFindings(findings, MIXED_DIFF)).toEqual([]);
  });

  test("prefetch-failed draft semantics: hunk-external findings survive on the base layer alone", () => {
    const findings = [findingAt("src/auth.ts", 100, "would-be-excluded")];
    expect(filterLineCommentFindings(findings)).toHaveLength(1);
    expect(filterLineCommentFindings(findings, AUTH_DIFF)).toHaveLength(0);
  });

  test("multi-line range: both endpoints inside ONE right hunk survive; cross-hunk or non-ascending ranges fall back to the single-line anchor", () => {
    const ranged = (start: number | null, end: number): ReviewFinding => ({
      ...findingAt("src/auth.ts", end, "range-" + String(start) + "-" + String(end)),
      line_start: start,
      line_end: end,
    });
    const findings = [
      ranged(11, 13), // inside hunk [10,13]
      ranged(10, 13), // hunk-start boundary is a valid start
      ranged(13, 13), // start == end: no range (end inside the hunk)
      ranged(9, 13), // start outside the hunk
      ranged(12, 35), // spans hunks: end in [33,37], start not
      ranged(null, 13), // absent range stays absent
    ];
    expect(filterLineCommentFindings(findings, AUTH_DIFF).map(({ finding, lineStart }) => [finding.title, lineStart])).toEqual([
      ["range-11-13", 11],
      ["range-10-13", 10],
      ["range-13-13", null],
      ["range-9-13", null],
      ["range-12-35", null],
      ["range-null-13", null],
    ]);
  });

  test("deleted and binary files stay excluded even when the finding carries a range", () => {
    const findings = [
      { ...findingAt("src/dead.ts", 2, "deleted"), line_start: 1, line_end: 2 },
      { ...findingAt("assets/logo.png", 2, "binary"), line_start: 1, line_end: 2 },
    ];
    expect(filterLineCommentFindings(findings, MIXED_DIFF)).toEqual([]);
  });
});

describe("renderLineCommentText (the LineIntent.body payload — marker appended at send)", () => {
  test("title + merge-class tag + body, marker-LESS (the trusted thread marker rides §7.5 buildLineCommentBody)", () => {
    const body = renderLineCommentText(findingAt("src/auth.ts", 21, "Fractional expiry"));
    expect(body).toBe(
      `**Fractional expiry** · ${REVIEW_EMOJI["must-fix"]} must-fix\n\nFractional expiry body.`,
    );
    expect(body).not.toContain("mstar-inspector:");
  });

  test("assembled text clamps to FINDING_BODY_MAX (title+tag+body can exceed the per-field clamps)", () => {
    const head = `**big** · ${REVIEW_EMOJI["must-fix"]} must-fix\n\n`;
    const oversized = findingAt("src/auth.ts", 21, "big");
    oversized.body = "x".repeat(FINDING_BODY_MAX);
    const body = renderLineCommentText(oversized);
    expect(body).toBe(`${head}${"x".repeat(FINDING_BODY_MAX - head.length - 1)}…`);
    expect(body).toHaveLength(FINDING_BODY_MAX);
  });

  test("a suggestion fence wholly inside the budget is kept verbatim", () => {
    const body = "Prose before.\n\n  ```suggestion\nconst x = 1;\n  ```\n\nProse after.";
    const finding = findingAt("src/auth.ts", 21, "Fence inside");
    finding.body = body;
    expect(renderLineCommentText(finding)).toBe(
      `**Fence inside** · ${REVIEW_EMOJI["must-fix"]} must-fix\n\n${body}`,
    );
  });

  test("a fence straddling FINDING_BODY_MAX is dropped whole and the prose kept", () => {
    const head = `**Straddle** · ${REVIEW_EMOJI["must-fix"]} must-fix\n\n`;
    const fence = "```suggestion\nconst x = 1;\n```";
    // The fence opens at budget-25 and closes past the budget.
    const pad = FINDING_BODY_MAX - 25 - head.length - 2;
    const finding = findingAt("src/auth.ts", 21, "Straddle");
    finding.body = `${"A".repeat(pad)}\n\n${fence}\n\nafter`;
    const result = renderLineCommentText(finding);
    expect(result).toBe(`${head}${"A".repeat(pad)}\n\n\nafter`);
    expect(result).not.toContain("```");
    expect(result.length).toBeLessThanOrEqual(FINDING_BODY_MAX);
  });

  test("a fence-only body falls back to the title/tag line — no fence, no ellipsis", () => {
    const finding = findingAt("src/auth.ts", 21, "Fence only");
    finding.body = `\`\`\`suggestion\n${"const x = 1;\n".repeat(400)}\`\`\``;
    const result = renderLineCommentText(finding);
    expect(result).toBe(`**Fence only** · ${REVIEW_EMOJI["must-fix"]} must-fix`);
    expect(result).not.toContain("```");
    expect(result).not.toContain("…");
  });

  test("only the fence straddling the budget is dropped; a wholly-inside fence and the prose survive", () => {
    const head = `**Many** · ${REVIEW_EMOJI["must-fix"]} must-fix\n\n`;
    const kept = "```suggestion\nconst keep = true;\n```";
    const big = `\`\`\`suggestion\n${"const y = 2;\n".repeat(300)}\`\`\``;
    const finding = findingAt("src/auth.ts", 21, "Many");
    finding.body = `${kept}\n\n${"A".repeat(100)}\n\n${big}\n\ntail`;
    const result = renderLineCommentText(finding);
    expect(result).toBe(`${head}${kept}\n\n${"A".repeat(100)}\n\n\ntail`);
    expect(result.split("```suggestion").length - 1).toBe(1);
    expect(result).not.toContain("const y = 2;");
  });

  test("an unclosed suggestion fence under the budget is dropped before the marker is appended (QC R1)", () => {
    const finding = findingAt("src/auth.ts", 21, "Unclosed");
    finding.body = "Move this before the check.\n\n```suggestion\nconst x = 1;";
    const text = renderLineCommentText(finding);
    expect(text).toBe(`**Unclosed** · ${REVIEW_EMOJI["must-fix"]} must-fix\n\nMove this before the check.\n\n`);
    const sent = buildLineCommentBody({
      body: text,
      publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      associationId: "11111111-2222-4333-8444-555555555555",
    });
    expect(sent).not.toContain("```");
    expect(sent.trimEnd().endsWith(
      "<!-- mstar-inspector:thread:v1 publication=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee association=11111111-2222-4333-8444-555555555555 -->",
    )).toBe(true);
  });

  test("the §7.5 intent body builder strips forged markers and appends the trusted thread marker", async () => {
    const forged = `model text\n<!-- mstar-inspector:thread:v1 publication=00000000-0000-4000-8000-000000000000 association=00000000-0000-4000-8000-000000000001 -->`;
    const body = buildLineCommentBody({
      body: forged,
      publicationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      associationId: "11111111-2222-4333-8444-555555555555",
    });
    expect(body.split("mstar-inspector:thread:v1").length - 1).toBe(1); // only the trusted marker survives
    expect(body.trimEnd().endsWith(
      "<!-- mstar-inspector:thread:v1 publication=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee association=11111111-2222-4333-8444-555555555555 -->",
    )).toBe(true);
  });
});

// --- mock octokit (pulls surface only — the line-comments path must never
// touch the Issues comments surface) ----------------------------------------

type PullsCalls = {
  createReviewParams?: Record<string, unknown>;
  listCommentsForReviewParams?: Record<string, unknown>;
};

function mockPullsOctok(options: {
  createReviewError?: unknown;
  omitCreateReview?: boolean;
  createReviewResponse?: unknown;
  listCommentsForReviewError?: unknown;
  listCommentsForReviewResponse?: unknown;
}): { calls: PullsCalls; octokit: PostOctokit } {
  const calls: PullsCalls = {};
  const octokit: PostOctokit = {
    paginate: mock(async (): Promise<never> => {
      throw new Error("unexpected: the line-comments path never paginates issue comments");
    }),
    rest: {
      issues: {
        listComments: mock(async () => {
          throw new Error("unexpected: issues surface unused");
        }),
        updateComment: mock(async () => {
          throw new Error("unexpected: issues surface unused");
        }),
        createComment: mock(async () => {
          throw new Error("unexpected: issues surface unused");
        }),
      },
      pulls: {
        ...(options.omitCreateReview
          ? {}
          : {
              createReview: mock(async (params: Record<string, unknown>) => {
                calls.createReviewParams = params;
                if (options.createReviewError) throw options.createReviewError;
                return options.createReviewResponse ?? {};
              }),
            }),
        listCommentsForReview: mock(
          async (params: Record<string, unknown>): Promise<{
            data: Array<{ id?: unknown; path?: unknown; line?: unknown; original_line?: unknown; body?: unknown }>;
          }> => {
            calls.listCommentsForReviewParams = params;
            if (options.listCommentsForReviewError) throw options.listCommentsForReviewError;
            return (options.listCommentsForReviewResponse ?? { data: [] }) as {
              data: Array<{ id?: unknown; path?: unknown; line?: unknown; original_line?: unknown; body?: unknown }>;
            };
          },
        ),
      },
    },
  };
  return { calls, octokit };
}

describe("postLineCommentsWithOctokit (intent-prepared request-body pin, §7.7 step 10)", () => {
  const PUBLICATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const intents = [
    {
      associationId: "11111111-2222-4333-8444-555555555555",
      findingRowId: "22222222-3333-4444-8555-666666666666",
      publicationId: PUBLICATION,
      scope: { appId: "app", installationId: 1, owner: "acme", repo: "widgets", prNumber: 42 },
      originalSha: SHA,
      round: 2,
      path: "src/auth.ts",
      line: 21,
      body: `**First** · ${REVIEW_EMOJI["must-fix"]} must-fix\n\nFirst body.`,
      bodySha256: "digest-1",
    },
    {
      associationId: "33333333-4444-4555-8666-777777777777",
      findingRowId: "44444444-5555-4666-8777-888888888888",
      publicationId: PUBLICATION,
      scope: { appId: "app", installationId: 1, owner: "acme", repo: "widgets", prNumber: 42 },
      originalSha: SHA,
      round: 2,
      path: "src/auth.ts",
      line: 33,
      body: `**Second** · ${REVIEW_EMOJI.nit} nit\n\nSecond body.`,
      bodySha256: "digest-2",
    },
  ];
  const input = {
    installationId: 1,
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    headSha: SHA,
    round: 2,
    publicationId: PUBLICATION,
    intents,
  };
  // Real createReview echoes the created comments back — the §7.7 capture
  // maps them onto the intents.
  const echoResponse = {
    data: {
      id: 55,
      comments: [
        { id: 301, path: "src/auth.ts", line: 21 },
        { id: 302, path: "src/auth.ts", line: 33 },
      ],
    },
  };

  test("ONE createReview: commit_id pinned, event COMMENT, line-batch marker body, per-intent path/side/line/marker body", async () => {
    const { calls, octokit } = mockPullsOctok({ createReviewResponse: echoResponse });
    const result = await postLineCommentsWithOctokit(octokit, input);

    expect(calls.createReviewParams).toEqual({
      owner: "acme",
      repo: "widgets",
      pull_number: 42,
      commit_id: SHA,
      event: "COMMENT",
      // REQUIRED top-level body for COMMENT events — a marker short line
      // CARRYING the trusted line-batch marker (§7.5), never a copy of the
      // overall review body.
      body: "mstar-inspector line comments · round 2 · 0123456\n<!-- mstar-inspector:line-batch:v1 publication=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee -->",
      comments: [
        {
          path: "src/auth.ts",
          side: "RIGHT",
          line: 21,
          body: `**First** · ${REVIEW_EMOJI["must-fix"]} must-fix\n\nFirst body.\n\n<!-- mstar-inspector:thread:v1 publication=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee association=11111111-2222-4333-8444-555555555555 -->`,
        },
        {
          path: "src/auth.ts",
          side: "RIGHT",
          line: 33,
          body: `**Second** · ${REVIEW_EMOJI.nit} nit\n\nSecond body.\n\n<!-- mstar-inspector:thread:v1 publication=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee association=33333333-4444-4555-8666-777777777777 -->`,
        },
      ],
    });
    // Capture: returned comment ids mapped back to the association ids.
    expect(result).toEqual({
      posted: [
        { associationId: "11111111-2222-4333-8444-555555555555", commentId: 301, path: "src/auth.ts", line: 21 },
        { associationId: "33333333-4444-4555-8666-777777777777", commentId: 302, path: "src/auth.ts", line: 33 },
      ],
      ambiguous: [],
      captured: true,
      reviewId: 55,
    });
    // An echoed comments array is the whole answer — no second request.
    expect(calls.listCommentsForReviewParams).toBeUndefined();
  });

  test("comments-less create response: the review's comments connection is read once and maps both ids", async () => {
    const { calls, octokit } = mockPullsOctok({
      createReviewResponse: { data: { id: 55 } },
      listCommentsForReviewResponse: {
        data: [
          { id: 301, path: "src/auth.ts", line: 21 },
          { id: 302, path: "src/auth.ts", line: 33 },
        ],
      },
    });
    const result = await postLineCommentsWithOctokit(octokit, input);

    expect(calls.listCommentsForReviewParams).toEqual({
      owner: "acme",
      repo: "widgets",
      pull_number: 42,
      review_id: 55,
      per_page: 100,
    });
    expect(result).toEqual({
      posted: [
        { associationId: "11111111-2222-4333-8444-555555555555", commentId: 301, path: "src/auth.ts", line: 21 },
        { associationId: "33333333-4444-4555-8666-777777777777", commentId: 302, path: "src/auth.ts", line: 33 },
      ],
      ambiguous: [],
      captured: true,
      reviewId: 55,
    });
  });

  test("the review's comments connection reports null line/original_line — the marker maps every intent", async () => {
    // Real shape: \`GET /pulls/{n}/reviews/{id}/comments\` answers with
    // \`line: null, original_line: null, side: null\` for comments the PR-wide
    // list anchors, so only the trusted thread marker identifies them.
    const marked = (intent: (typeof intents)[number], id: number) => ({
      id,
      path: intent.path,
      line: null,
      original_line: null,
      side: null,
      body: buildLineCommentBody({
        body: intent.body,
        publicationId: PUBLICATION,
        associationId: intent.associationId,
      }),
    });
    const { octokit } = mockPullsOctok({
      createReviewResponse: { data: { id: 55 } },
      listCommentsForReviewResponse: { data: [marked(intents[0]!, 301), marked(intents[1]!, 302)] },
    });
    expect(await postLineCommentsWithOctokit(octokit, input)).toEqual({
      posted: [
        { associationId: "11111111-2222-4333-8444-555555555555", commentId: 301, path: "src/auth.ts", line: 21 },
        { associationId: "33333333-4444-4555-8666-777777777777", commentId: 302, path: "src/auth.ts", line: 33 },
      ],
      ambiguous: [],
      captured: true,
      reviewId: 55,
    });
  });

  test("an unmarked comment still maps through the row anchor (line or original_line)", async () => {
    const { octokit } = mockPullsOctok({
      createReviewResponse: { data: { id: 55 } },
      listCommentsForReviewResponse: {
        data: [
          { id: 301, path: "src/auth.ts", line: null, original_line: 21, body: "**First** · must-fix" },
          { id: 302, path: "src/auth.ts", line: 33, body: "**Second** · nit" },
        ],
      },
    });
    const result = await postLineCommentsWithOctokit(octokit, input);
    expect(result.posted.map((p) => [p.associationId, p.commentId])).toEqual([
      ["11111111-2222-4333-8444-555555555555", 301],
      ["33333333-4444-4555-8666-777777777777", 302],
    ]);
    expect(result.captured).toBe(true);
  });

  test("an unknown marker never fabricates a mapping and never falls back to the anchor", async () => {
    const stranger = buildLineCommentBody({
      body: "somebody else's comment",
      publicationId: PUBLICATION,
      associationId: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
    });
    const { octokit } = mockPullsOctok({
      createReviewResponse: { data: { id: 55 } },
      listCommentsForReviewResponse: {
        data: [{ id: 301, path: "src/auth.ts", line: 21, original_line: 21, body: stranger }],
      },
    });
    const result = await postLineCommentsWithOctokit(octokit, input);
    expect(result.posted).toEqual([]);
    expect(result.ambiguous).toEqual(["src/auth.ts:21", "src/auth.ts:33"]);
    expect(result.captured).toBe(false);
  });

  test("a duplicated marker is ambiguous, never two ids for one association", async () => {
    const duplicated = buildLineCommentBody({
      body: intents[0]!.body,
      publicationId: PUBLICATION,
      associationId: intents[0]!.associationId,
    });
    const { octokit } = mockPullsOctok({
      createReviewResponse: { data: { id: 55 } },
      listCommentsForReviewResponse: {
        data: [
          { id: 301, path: "src/auth.ts", line: null, original_line: null, body: duplicated },
          { id: 302, path: "src/auth.ts", line: null, original_line: null, body: duplicated },
        ],
      },
    });
    const result = await postLineCommentsWithOctokit(octokit, input);
    expect(result.posted).toEqual([]);
    expect(result.ambiguous).toEqual(["src/auth.ts:21", "src/auth.ts:33"]);
    expect(result.captured).toBe(false);
  });

  test("an unreadable comments connection is never fatal: capture stays false and the review id is still reported", async () => {
    const { calls, octokit } = mockPullsOctok({
      createReviewResponse: { data: { id: 55 } },
      listCommentsForReviewError: Object.assign(new Error("Not Found"), { status: 404 }),
    });
    const result = await postLineCommentsWithOctokit(octokit, input);

    expect(calls.listCommentsForReviewParams).toBeDefined();
    expect(result).toEqual({ posted: [], ambiguous: [], captured: false, reviewId: 55 });
  });

  test("a malformed comments connection (non-array data) is a failed capture, not a crash", async () => {
    const { octokit } = mockPullsOctok({
      createReviewResponse: { data: { id: 55 } },
      listCommentsForReviewResponse: { data: null },
    });
    expect(await postLineCommentsWithOctokit(octokit, input)).toEqual({
      posted: [],
      ambiguous: [],
      captured: false,
      reviewId: 55,
    });
  });

  test("empty intent set → zero API calls", async () => {
    const { calls, octokit } = mockPullsOctok({});
    await postLineCommentsWithOctokit(octokit, { ...input, intents: [] });
    expect(calls.createReviewParams).toBeUndefined();
  });

  test("a non-unique path+line echo is ambiguous — never fabricated (§7.7 capture)", async () => {
    const duplicated = {
      data: {
        id: 55,
        comments: [
          { id: 301, path: "src/auth.ts", line: 21 },
          { id: 302, path: "src/auth.ts", line: 21 },
        ],
      },
    };
    const { octokit } = mockPullsOctok({ createReviewResponse: duplicated });
    const result = await postLineCommentsWithOctokit(octokit, input);
    expect(result.posted).toHaveLength(0);
    expect(result.ambiguous).toEqual(["src/auth.ts:21", "src/auth.ts:33"]);
    expect(result.captured).toBe(false);
  });

  test("missing pulls.createReview surface → named error (the consumer catch logs fallback)", async () => {
    const { octokit } = mockPullsOctok({ omitCreateReview: true });
    await expect(postLineCommentsWithOctokit(octokit, input)).rejects.toThrow(/missing rest\.pulls\.createReview/);
  });

  test("createReview rejection propagates (422 position validation / network — the consumer owns fallback)", async () => {
    const unprocessable = Object.assign(new Error("Validation Failed"), { status: 422 });
    const { octokit } = mockPullsOctok({ createReviewError: unprocessable });
    await expect(postLineCommentsWithOctokit(octokit, input)).rejects.toThrow("Validation Failed");
  });

  test("single-line intent: the comment object carries exactly path/side/line/body — no start_line key", async () => {
    const { calls, octokit } = mockPullsOctok({ createReviewResponse: echoResponse });
    await postLineCommentsWithOctokit(octokit, input);
    const comments = calls.createReviewParams!.comments as Record<string, unknown>[];
    expect(comments.map((comment) => Object.keys(comment))).toEqual([
      ["path", "side", "line", "body"],
      ["path", "side", "line", "body"],
    ]);
  });

  test("a real range rides as start_line + start_side RIGHT alongside the anchored line", async () => {
    const { calls, octokit } = mockPullsOctok({ createReviewResponse: echoResponse });
    await postLineCommentsWithOctokit(octokit, {
      ...input,
      intents: [
        { ...intents[0]!, lineStart: 19, line: 21 },
        { ...intents[1]!, lineStart: 33, line: 37 },
      ],
    });
    const comments = calls.createReviewParams!.comments as Record<string, unknown>[];
    expect(
      comments.map(({ path, side, line, start_line, start_side }) => ({ path, side, line, start_line, start_side })),
    ).toEqual([
      { path: "src/auth.ts", side: "RIGHT", line: 21, start_line: 19, start_side: "RIGHT" },
      { path: "src/auth.ts", side: "RIGHT", line: 37, start_line: 33, start_side: "RIGHT" },
    ]);
  });

  test("a non-ascending range never rides the wire (GitHub range shape is start < line)", async () => {
    const { calls, octokit } = mockPullsOctok({ createReviewResponse: echoResponse });
    await postLineCommentsWithOctokit(octokit, { ...input, intents: [{ ...intents[0]!, lineStart: 21, line: 21 }] });
    const [comment] = calls.createReviewParams!.comments as Record<string, unknown>[];
    expect(comment === undefined ? null : "start_line" in comment).toBe(false);
  });
});
