/**
 * Line-comments tests (architect AL-3, layered delivery):
 *   - parseDiffHunkRanges: multi-file diffs, renames (b-side path), binary /
 *     deleted files, omitted hunk counts, context ranges, and hunk-body
 *     content lines that masquerade as `+++ ` file headers
 *   - filterLineCommentFindings: base layer (file_path non-empty AND
 *     line_end ≥ 1), hunk layer (b-side exact path match + line_end inside
 *     a right-side hunk range), prefetch-failed draft semantics (diff
 *     undefined → base layer alone)
 *   - buildLineCommentBody: title + merge-class tag + body, FINDING_BODY_MAX
 *     clamp on the assembled comment
 *   - postLineCommentsWithOctokit: createReview request-body pin (path /
 *     side / line / event + REQUIRED top-level marker body), empty
 *     qualifying set → zero API calls, missing pulls surface → named error
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
    expect(filterLineCommentFindings(findings).map((f) => f.title)).toEqual(["ok"]);
    // diff undefined (prefetch failed) → base layer alone, no hunk check.
    expect(filterLineCommentFindings(findings, undefined).map((f) => f.title)).toEqual(["ok"]);
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
    expect(filterLineCommentFindings(findings, `${AUTH_DIFF}\n${MIXED_DIFF}`).map((f) => f.title)).toEqual([
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
    const oversized = findingAt("src/auth.ts", 21, "big");
    oversized.body = "x".repeat(FINDING_BODY_MAX);
    const body = renderLineCommentText(oversized);
    expect(body).toHaveLength(FINDING_BODY_MAX);
    expect(body.endsWith("…")).toBe(true);
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
};

function mockPullsOctok(options: {
  createReviewError?: unknown;
  omitCreateReview?: boolean;
  createReviewResponse?: unknown;
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
});
