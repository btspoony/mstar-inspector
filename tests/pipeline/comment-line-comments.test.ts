/**
 * Line-comments tests (plan 18 Task 3 / architect AL-3, layered delivery):
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
  buildLineCommentBody,
  fetchPrDiffWithOctokit,
  filterLineCommentFindings,
  parseDiffHunkRanges,
  postLineCommentsWithOctokit,
  type PostOctokit,
} from "../../src/pipeline/comment";
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

describe("buildLineCommentBody", () => {
  test("title + merge-class tag + body", () => {
    const body = buildLineCommentBody(findingAt("src/auth.ts", 21, "Fractional expiry"));
    expect(body).toBe(
      `**Fractional expiry** · ${REVIEW_EMOJI["must-fix"]} must-fix\n\nFractional expiry body.`,
    );
  });

  test("assembled body clamps to FINDING_BODY_MAX (title+tag+body can exceed the per-field clamps)", () => {
    const oversized = findingAt("src/auth.ts", 21, "big");
    oversized.body = "x".repeat(FINDING_BODY_MAX);
    const body = buildLineCommentBody(oversized);
    expect(body).toHaveLength(FINDING_BODY_MAX);
    expect(body.endsWith("…")).toBe(true);
  });
});

// --- mock octokit (pulls surface only — the line-comments path must never
// touch the Issues comments surface) ----------------------------------------

type PullsCalls = {
  getParams?: Record<string, unknown>;
  createReviewParams?: Record<string, unknown>;
};

function mockPullsOctok(options: {
  diffData?: unknown;
  getError?: unknown;
  createReviewError?: unknown;
  omitGet?: boolean;
  omitCreateReview?: boolean;
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
        ...(options.omitGet
          ? {}
          : {
              get: mock(async (params: Record<string, unknown>) => {
                calls.getParams = params;
                if (options.getError) throw options.getError;
                return { data: options.diffData };
              }),
            }),
        ...(options.omitCreateReview
          ? {}
          : {
              createReview: mock(async (params: Record<string, unknown>) => {
                calls.createReviewParams = params;
                if (options.createReviewError) throw options.createReviewError;
                return {};
              }),
            }),
      },
    },
  };
  return { calls, octokit };
}

describe("postLineCommentsWithOctokit (request-body pin)", () => {
  const input = {
    installationId: 1,
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    headSha: SHA,
    round: 2,
    findings: [
      findingAt("src/auth.ts", 21, "First"),
      { ...findingAt("src/auth.ts", 33, "Second"), mergeClass: "nit" as const },
    ],
  };

  test("ONE createReview: commit_id pinned, event COMMENT, required marker body, per-comment path/side/line/body", async () => {
    const { calls, octokit } = mockPullsOctok({});
    await postLineCommentsWithOctokit(octokit, input);

    expect(calls.getParams).toBeUndefined(); // the poster never prefetches
    expect(calls.createReviewParams).toEqual({
      owner: "acme",
      repo: "widgets",
      pull_number: 42,
      commit_id: SHA,
      event: "COMMENT",
      // REQUIRED top-level body for COMMENT events — a marker short line,
      // never a copy of the overall review body (D4 §2 no-duplicate).
      body: "mstar-inspector line comments · round 2 · 0123456",
      comments: [
        {
          path: "src/auth.ts",
          side: "RIGHT",
          line: 21,
          body: `**First** · ${REVIEW_EMOJI["must-fix"]} must-fix\n\nFirst body.`,
        },
        {
          path: "src/auth.ts",
          side: "RIGHT",
          line: 33,
          body: `**Second** · ${REVIEW_EMOJI.nit} nit\n\nSecond body.`,
        },
      ],
    });
  });

  test("empty qualifying set → zero API calls (byte-compat)", async () => {
    const { calls, octokit } = mockPullsOctok({});
    await postLineCommentsWithOctokit(octokit, { ...input, findings: [] });
    expect(calls.createReviewParams).toBeUndefined();
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

describe("fetchPrDiffWithOctokit", () => {
  const input = { installationId: 1, owner: "acme", repo: "widgets", prNumber: 42 };

  test("pulls.get with the diff media type (GitHub-documented position-validation pattern)", async () => {
    const { calls, octokit } = mockPullsOctok({ diffData: AUTH_DIFF });
    const diff = await fetchPrDiffWithOctokit(octokit, input);
    expect(calls.getParams).toEqual({
      owner: "acme",
      repo: "widgets",
      pull_number: 42,
      mediaType: { format: "diff" },
    });
    expect(diff).toBe(AUTH_DIFF);
  });

  test("accepts the diff as `data` (string) or nested `data.data`", async () => {
    const flat = mockPullsOctok({ diffData: AUTH_DIFF });
    expect(await fetchPrDiffWithOctokit(flat.octokit, input)).toBe(AUTH_DIFF);
    const nested = mockPullsOctok({ diffData: { data: AUTH_DIFF } });
    expect(await fetchPrDiffWithOctokit(nested.octokit, input)).toBe(AUTH_DIFF);
  });

  test("a non-diff response is a prefetch failure (→ consumer base-filter attempt)", async () => {
    const { octokit } = mockPullsOctok({ diffData: { id: 123 } });
    await expect(fetchPrDiffWithOctokit(octokit, input)).rejects.toThrow(/did not return a unified diff/);
  });

  test("missing pulls.get surface → named error", async () => {
    const { octokit } = mockPullsOctok({ omitGet: true });
    await expect(fetchPrDiffWithOctokit(octokit, input)).rejects.toThrow(/missing rest\.pulls\.get/);
  });
});
