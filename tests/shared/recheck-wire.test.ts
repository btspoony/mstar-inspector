/**
 * Per-row recheck convergence (spec review-lifecycle §7.3) —
 * `validateRecheckDoc` drops a bad row instead of failing the document,
 * while document-level distrust (duplicate/foreign row IDs) still fails closed.
 */
import { describe, expect, test } from "bun:test";
import {
  normalizeQuoteText,
  validateRecheckDoc,
  type Assessment,
  type EvidenceSlice,
  type RecheckInput,
  type RecheckTarget,
} from "../../packages/shared/src/recheck-wire";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** One complete hunk: 3 new lines at 8..10, quoted as "line 8-10". */
const HUNK: EvidenceSlice = {
  id: "slice-1",
  headSha: SHA,
  baseSha: "b" + "0".repeat(39),
  path: "src/a.ts",
  oldPath: null,
  kind: "hunk",
  oldStart: 8,
  oldLines: ["const a = 1;", "const b = 2;", "const c = 3;"],
  newStart: 8,
  newLines: ["const a = 1;", "const b = null ?? 2;", "const c = 3;"],
  oldBlobOid: "oid-old",
  headBlobOid: "oid-head",
  absentAtHead: false,
  complete: true,
};

const QUOTE = HUNK.newLines.join("\n");

function target(n: number): RecheckTarget {
  return {
    rowId: `row-${n}`,
    findingId: `f-${n}`,
    original: {
      title: `Concern ${n}`,
      body: "Dereferencing possibly-null value.",
      filePath: "src/a.ts",
      lineStart: 8,
      lineEnd: 10,
      mergeClass: "should-fix",
      category: "logic",
      fingerprintHint: `fp-${n}`,
    },
    firstSeenSha: SHA,
    lastAssessment: null,
    associationIds: [],
  };
}

function addressed(rowId: string, quote: string = QUOTE): Assessment {
  return {
    rowId,
    disposition: "addressed",
    reason: "verified-fix",
    evidence: {
      kind: "current-code",
      sliceId: "slice-1",
      startLine: 8,
      endLine: 10,
      quote,
      explanation: "The null check now guards the dereference.",
    },
    relatedCurrentFindingIndexes: [],
  };
}

function input(overrides: Partial<RecheckInput> = {}): RecheckInput {
  return {
    schema: "mstar.recheck-input/v1",
    headSha: SHA,
    targets: [target(1)],
    evidence: [HUNK],
    discussion: {
      items: [],
      issueCoverage: "complete",
      issueDigest: "digest",
      capturedMs: 1,
      threads: [],
    },
    ...overrides,
  };
}

describe("validateRecheckDoc — per-row degradation", () => {
  test("one imprecise quote drops only that row", () => {
    const targets = Array.from({ length: 25 }, (_, n) => target(n + 1));
    const badQuote = QUOTE.replace("null ??", "null ?");
    const results = targets.map((t, i) => addressed(t.rowId, i === 3 ? badQuote : QUOTE));

    const outcome = validateRecheckDoc({ schema: "mstar.recheck/v1", headSha: SHA, results }, input({ targets }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.doc.results).toHaveLength(24);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]!.index).toBe(3);
    expect(outcome.rejected[0]!.rowId).toBe("row-4");
    expect(outcome.doc.results.some((row) => row.rowId === "row-4")).toBe(false);
  });

  test("CRLF line endings and trailing blanks still prove addressed", () => {
    const noisy = "const a = 1;   \r\nconst b = null ?? 2;\t\r\nconst c = 3;\r\n";
    const outcome = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressed("row-1", noisy)] },
      input(),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.doc.results).toHaveLength(1);
    expect(outcome.doc.results[0]!.disposition).toBe("addressed");
    expect(outcome.rejected).toHaveLength(0);
  });

  test("a malformed row is rejected without failing the document", () => {
    const outcome = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          { rowId: "row-1", disposition: "nonsense", reason: "verified-fix", evidence: null, relatedCurrentFindingIndexes: [] },
        ],
      },
      input(),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.doc.results).toHaveLength(0);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]!.rowId).toBe("row-1");
  });
});

describe("validateRecheckDoc — document-level distrust still fails closed", () => {
  test("duplicate row ID fails the whole document", () => {
    const outcome = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [addressed("row-1"), addressed("row-1")],
      },
      input(),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("duplicate row ID");
  });

  test("foreign row ID fails the whole document", () => {
    const outcome = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressed("row-999")] },
      input(),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("foreign row");
  });
});

describe("normalizeQuoteText", () => {
  test("unifies newlines, strips line-trailing blanks and one final newline", () => {
    expect(normalizeQuoteText("a  \r\nb\t\nc\r\n")).toBe("a\nb\nc");
    expect(normalizeQuoteText("  indented")).toBe("  indented");
  });
});
