/**
 * Recheck wire contract tests (plan 67 Task 1, spec review-lifecycle §7.3) —
 * `src/contracts/recheck.ts` `validateRecheckDoc` against a trusted input.
 *
 * Every rejection rule is exercised as fail-closed behavior:
 *   - valid doc round-trips (typed, results preserved)
 *   - exact schema + HEAD equality (stale/foreign documents rejected)
 *   - at most 25 results; unique row IDs contained in the input
 *     (duplicate/foreign rejected)
 *   - addressed requires verified-fix + eligible complete catalog slice:
 *     integer ordered range inside the appropriate old/new hunk, exact
 *     (byte-equal) quote match 1–4096 chars, nonblank explanation ≤1200
 *   - removed/replaced proof must intersect the original concern's old
 *     range and demonstrate the structural change (deleted-file absence,
 *     or old lines no longer on the hunk's new side; a current hunk must
 *     exist for replaced-code)
 *   - dismissed requires non-fix-dismissal and never resolves; unverifiable
 *     may have no evidence
 *   - strict shapes (exact key sets — no remote IDs in output), closed
 *     enums, integer relatedCurrentFindingIndexes
 */
import { describe, expect, test } from "bun:test";
import {
  ASSESSMENT_TARGET_CAP,
  RECHECK_FILE_MAX_BYTES,
  RECHECK_MAX_RUNTIME_MS,
  RECHECK_MAX_TARGETS,
  RECHECK_MIN_REMAINING_MS,
  RECHECK_OUTPUT_PATH,
  validateRecheckDoc,
  type Assessment,
  type EvidenceSlice,
  type RecheckInput,
  type RecheckTarget,
} from "../../src/contracts/recheck";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const ORIGINAL = {
  title: "Null deref risk",
  body: "Dereferencing possibly-null value.",
  filePath: "src/a.ts",
  lineStart: 8,
  lineEnd: 10,
  mergeClass: "should-fix" as const,
  category: "logic",
  fingerprintHint: "fp-1",
};

const HUNK: EvidenceSlice = {
  id: "slice-1", headSha: SHA, baseSha: "b" + "0".repeat(39), path: "src/a.ts", oldPath: null,
  kind: "hunk",
  oldStart: 8, oldLines: ["const a = 1;", "const b = 2;", "const c = 3;"],
  newStart: 8, newLines: ["const a = 1;", "const b = null ?? 2;", "const c = 3;"],
  oldBlobOid: "oid-old", headBlobOid: "oid-head",
  absentAtHead: false, complete: true,
};

const DELETED_FILE: EvidenceSlice = {
  id: "slice-del", headSha: SHA, baseSha: "b" + "0".repeat(39), path: "src/old.ts", oldPath: null,
  kind: "deleted-file",
  oldStart: 5, oldLines: ["old line 5", "old line 6"], newStart: 0, newLines: [],
  oldBlobOid: "oid-old", headBlobOid: null,
  absentAtHead: true, complete: true,
};

const REPLACED_HUNK: EvidenceSlice = {
  id: "slice-rep", headSha: SHA, baseSha: "b" + "0".repeat(39), path: "src/old.ts", oldPath: "src/old.ts",
  kind: "hunk",
  oldStart: 5, oldLines: ["count = a + b;", "render();"], newStart: 5, newLines: ["total = a + b;", "render();"],
  oldBlobOid: "oid-old", headBlobOid: "oid-head",
  absentAtHead: false, complete: true,
};

const REMOVED_STILL_PRESENT: EvidenceSlice = {
  id: "slice-still", headSha: SHA, baseSha: "b" + "0".repeat(39), path: "src/a.ts", oldPath: null,
  kind: "hunk",
  oldStart: 8, oldLines: ["const a = 1;", "const b = 2;"], newStart: 8, newLines: ["const a = 0;", "const b = 2;"],
  oldBlobOid: "oid-old", headBlobOid: "oid-head",
  absentAtHead: false, complete: true,
};

const TARGET: RecheckTarget = {
  rowId: "row-1",
  findingId: "f-1",
  original: ORIGINAL,
  firstSeenSha: SHA,
  lastAssessment: null,
  associationIds: ["assoc-1"],
};

const OLD_CONCERN_IN_OLD_TS = {
  ...ORIGINAL,
  title: "Removed helper",
  filePath: "src/old.ts",
  lineStart: 5,
  lineEnd: 6,
};

function input(overrides: Partial<RecheckInput> = {}): RecheckInput {
  return {
    schema: "mstar.recheck-input/v1",
    headSha: SHA,
    targets: [TARGET],
    evidence: [HUNK, DELETED_FILE, REPLACED_HUNK, REMOVED_STILL_PRESENT],
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

function evidence(overrides: Partial<Assessment["evidence"]> = {}): NonNullable<Assessment["evidence"]> {
  return {
    kind: "current-code",
    sliceId: "slice-1",
    startLine: 9,
    endLine: 9,
    quote: "const b = null ?? 2;",
    explanation: "The null check now guards the dereference.",
    ...overrides,
  } as NonNullable<Assessment["evidence"]>;
}

/** A single addressed result that passes every addressed-grade check. */
function addressedResult(overrides: Partial<Assessment> = {}): Assessment {
  return {
    rowId: "row-1",
    disposition: "addressed",
    reason: "verified-fix",
    evidence: evidence(),
    relatedCurrentFindingIndexes: [],
    ...overrides,
  };
}

describe("recheck constants (spec §7.3 verbatim)", () => {
  test("carries the frozen limits and output path", () => {
    expect(RECHECK_OUTPUT_PATH).toBe("/tmp/mstar-recheck.json");
    expect(RECHECK_MAX_TARGETS).toBe(25);
    expect(ASSESSMENT_TARGET_CAP).toBe(25);
    expect(RECHECK_MAX_RUNTIME_MS).toBe(180_000);
    expect(RECHECK_MIN_REMAINING_MS).toBe(30_000);
    expect(RECHECK_FILE_MAX_BYTES).toBe(262_144);
  });
});

describe("validateRecheckDoc — acceptance", () => {
  test("a valid addressed doc round-trips typed with results preserved", () => {
    const doc = { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult()] };
    const result = validateRecheckDoc(doc, input());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.schema).toBe("mstar.recheck/v1");
      expect(result.doc.headSha).toBe(SHA);
      expect(result.doc.results).toHaveLength(1);
      expect(result.doc.results[0]!.evidence!.sliceId).toBe("slice-1");
    }
  });

  test("unverifiable with no evidence and dismissed with no evidence are valid", () => {
    const doc = {
      schema: "mstar.recheck/v1",
      headSha: SHA,
      results: [
        { rowId: "row-1", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
        { rowId: "row-1", disposition: "dismissed", reason: "non-fix-dismissal", evidence: null, relatedCurrentFindingIndexes: [] },
      ],
    };
    // One at a time — the two results above share a rowId only to show each
    // shape validates standalone.
    for (const single of doc.results) {
      const result = validateRecheckDoc({ schema: "mstar.recheck/v1", headSha: SHA, results: [single] }, input());
      expect(result.ok).toBe(true);
    }
  });

  test("empty results are valid (nothing to report)", () => {
    const result = validateRecheckDoc({ schema: "mstar.recheck/v1", headSha: SHA, results: [] }, input());
    expect(result.ok).toBe(true);
  });

  test("removed-code with a complete deleted-file slice proving absence is eligible", () => {
    const result = addressedResult({
      evidence: evidence({
        kind: "removed-code",
        sliceId: "slice-del",
        startLine: 5,
        endLine: 6,
        quote: "old line 5\nold line 6",
      }),
    });
    const outcome = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [result] },
      input({ targets: [{ ...TARGET, original: OLD_CONCERN_IN_OLD_TS }] }),
    );
    expect(outcome.ok).toBe(true);
  });

  test("replaced-code citing the replaced old range plus its current hunk is eligible", () => {
    const result = addressedResult({
      evidence: evidence({
        kind: "replaced-code",
        sliceId: "slice-rep",
        startLine: 5,
        endLine: 5,
        quote: "count = a + b;",
      }),
    });
    const outcome = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [result] },
      input({ targets: [{ ...TARGET, original: OLD_CONCERN_IN_OLD_TS }] }),
    );
    expect(outcome.ok).toBe(true);
  });
});

describe("validateRecheckDoc — schema/HEAD/duplicate/foreign rejection", () => {
  test("wrong schema is rejected", () => {
    const result = validateRecheckDoc({ schema: "mstar.recheck/v2", headSha: SHA, results: [] }, input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("schema");
  });

  test("a stale document (HEAD mismatch) fails closed", () => {
    const doc = { schema: "mstar.recheck/v1", headSha: "f".repeat(40), results: [] };
    const result = validateRecheckDoc(doc, input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not equal the input HEAD");
  });

  test("more than 25 results are rejected", () => {
    const results = Array.from({ length: RECHECK_MAX_TARGETS + 1 }, (_, i) => ({
      rowId: `row-${i}`,
      disposition: "unverifiable",
      reason: "no-evidence",
      evidence: null,
      relatedCurrentFindingIndexes: [],
    }));
    const result = validateRecheckDoc({ schema: "mstar.recheck/v1", headSha: SHA, results }, input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("at most 25");
  });

  test("a duplicate row ID is rejected", () => {
    const doc = {
      schema: "mstar.recheck/v1",
      headSha: SHA,
      results: [
        { rowId: "row-1", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
        { rowId: "row-1", disposition: "unverifiable", reason: "budget", evidence: null, relatedCurrentFindingIndexes: [] },
      ],
    };
    const result = validateRecheckDoc(doc, input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("duplicate row ID");
  });

  test("a foreign row ID (not in the input targets) is rejected", () => {
    const doc = {
      schema: "mstar.recheck/v1",
      headSha: SHA,
      results: [{ rowId: "row-999", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] }],
    };
    const result = validateRecheckDoc(doc, input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("foreign row");
  });
});

describe("validateRecheckDoc — addressed eligibility", () => {
  test("addressed without verified-fix is rejected", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ reason: "no-evidence" })] },
      input(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('addressed requires reason "verified-fix"');
  });

  test("addressed with null evidence is rejected", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: null })] },
      input(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("requires eligible evidence");
  });

  test("addressed citing a foreign slice is rejected", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ sliceId: "slice-nope" }) })] },
      input(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("foreign slice");
  });

  test("addressed citing an incomplete slice is rejected", () => {
    const incomplete = { ...HUNK, complete: false };
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult()] },
      input({ evidence: [incomplete] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("incomplete");
  });

  test("a range outside the hunk new side is rejected", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ startLine: 20, endLine: 21 }) })] },
      input(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not inside the hunk new side");
  });

  test("an inverted range is rejected", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ startLine: 9, endLine: 8 }) })] },
      input(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not ordered");
  });

  test("a non-byte-equal quote is rejected", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ quote: "const b = 2;" }) })] },
      input(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not byte-equal");
  });

  test("a multi-line quote must byte-equal the contiguous cited lines", () => {
    const ok = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [addressedResult({ evidence: evidence({ startLine: 8, endLine: 9, quote: "const a = 1;\nconst b = null ?? 2;" }) })],
      },
      input(),
    );
    expect(ok.ok).toBe(true);

    const bad = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [addressedResult({ evidence: evidence({ startLine: 8, endLine: 9, quote: "const b = null ?? 2;\nconst a = 1;" }) })],
      },
      input(),
    );
    expect(bad.ok).toBe(false);
  });

  test("current-code on a deleted-file slice is rejected", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [addressedResult({ evidence: evidence({ sliceId: "slice-del", startLine: 5, endLine: 5, quote: "old line 5" }) })],
      },
      input({ targets: [{ ...TARGET, original: OLD_CONCERN_IN_OLD_TS }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("current-code must cite a hunk slice");
  });

  test("quote bounds (1–4096 chars) are enforced", () => {
    const empty = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ quote: "" }) })] },
      input(),
    );
    expect(empty.ok).toBe(false);

    const oversized = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ quote: "x".repeat(4097) }) })] },
      input(),
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.error).toContain("4096");
  });

  test("a blank or over-long explanation is rejected", () => {
    const blank = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ explanation: "   " }) })] },
      input(),
    );
    expect(blank.ok).toBe(false);

    const long = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ explanation: "x".repeat(1201) }) })] },
      input(),
    );
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toContain("1200");
  });

  test("removed-code deleted-file slice without proven absence is rejected", () => {
    const present = { ...DELETED_FILE, absentAtHead: false };
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({
            evidence: evidence({ kind: "removed-code", sliceId: "slice-del", startLine: 5, endLine: 6, quote: "old line 5\nold line 6" }),
          }),
        ],
      },
      input({ evidence: [present], targets: [{ ...TARGET, original: OLD_CONCERN_IN_OLD_TS }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must prove absence");
  });

  test("removed-code citing old lines still present on the hunk new side is rejected", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({
            evidence: evidence({ kind: "removed-code", sliceId: "slice-still", startLine: 9, endLine: 9, quote: "const b = 2;" }),
          }),
        ],
      },
      input({ targets: [{ ...TARGET, original: { ...ORIGINAL, lineStart: 9, lineEnd: 9 } }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("still present");
  });

  test("removed-code on a path unrelated to the original concern is rejected", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({
            evidence: evidence({ kind: "removed-code", sliceId: "slice-del", startLine: 5, endLine: 6, quote: "old line 5\nold line 6" }),
          }),
        ],
      },
      input(), // original concern lives in src/a.ts, slice cites src/old.ts
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not match the original concern file");
  });

  test("removed/replaced proof must intersect the original concern's old range", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({
            evidence: evidence({ kind: "replaced-code", sliceId: "slice-rep", startLine: 5, endLine: 5, quote: "count = a + b;" }),
          }),
        ],
      },
      input({ targets: [{ ...TARGET, original: { ...OLD_CONCERN_IN_OLD_TS, lineStart: 50, lineEnd: 60 } }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not intersect");
  });

  test("replaced-code with no current hunk is rejected (use removed-code)", () => {
    const pureDeletion = { ...REPLACED_HUNK, newLines: [] };
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({
            evidence: evidence({ kind: "replaced-code", sliceId: "slice-rep", startLine: 5, endLine: 5, quote: "count = a + b;" }),
          }),
        ],
      },
      input({ evidence: [pureDeletion], targets: [{ ...TARGET, original: OLD_CONCERN_IN_OLD_TS }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no current hunk");
  });
});

describe("validateRecheckDoc — disposition/reason pairing and shapes", () => {
  test("dismissed requires the non-fix rationale", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [{ rowId: "row-1", disposition: "dismissed", reason: "verified-fix", evidence: null, relatedCurrentFindingIndexes: [] }],
      },
      input(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('dismissed requires reason "non-fix-dismissal"');
  });

  test("unverifiable with a closure rationale is rejected", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [{ rowId: "row-1", disposition: "unverifiable", reason: "verified-fix", evidence: null, relatedCurrentFindingIndexes: [] }],
      },
      input(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unverifiable requires");
  });

  test("evidence citing a nonexistent slice is rejected even for unverifiable/dismissed", () => {
    for (const disposition of ["unverifiable", "dismissed"] as const) {
      const reason = disposition === "unverifiable" ? "no-evidence" : "non-fix-dismissal";
      const result = validateRecheckDoc(
        {
          schema: "mstar.recheck/v1",
          headSha: SHA,
          results: [{
            rowId: "row-1", disposition, reason,
            evidence: { kind: "current-code", sliceId: "slice-nope", startLine: 1, endLine: 1, quote: "x", explanation: "e" },
            relatedCurrentFindingIndexes: [],
          }],
        },
        input(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("foreign slice");
    }
  });

  test("relatedCurrentFindingIndexes must be non-negative integers", () => {
    for (const indexes of [[-1], [1.5], ["0"]]) {
      const result = validateRecheckDoc(
        {
          schema: "mstar.recheck/v1",
          headSha: SHA,
          results: [addressedResult({ relatedCurrentFindingIndexes: indexes as number[] })],
        },
        input(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("non-negative integers");
    }
  });

  test("a remote ID smuggled into a result (extra key) is rejected by the strict shape", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          { ...addressedResult(), threadId: "PRRT_123" },
        ],
      },
      input(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("exactly");
  });

  test("non-object documents fail closed", () => {
    for (const value of [null, "doc", 42, [], { schema: "mstar.recheck/v1", headSha: SHA }]) {
      const result = validateRecheckDoc(value, input());
      expect(result.ok).toBe(false);
    }
  });
});
