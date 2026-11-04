/**
 * Recheck wire contract tests (spec review-lifecycle §7.3) —
 * `packages/shared/src/recheck-wire.ts` `validateRecheckDoc` against a trusted input.
 *
 * Document-level distrust fails the whole document closed; a row-level content
 * error only drops that row into `rejected`, so the rest of the report stands:
 *   - valid doc round-trips (typed, results preserved)
 *   - exact schema + HEAD equality (stale/foreign documents rejected)
 *   - at most 25 results; unique row IDs contained in the input
 *     (duplicate/foreign rejected)
 *   - every other rule degrades one row: it lands in `rejected` with its index
 *     and row ID and the surviving rows form `doc.results`
 *   - addressed requires verified-fix + eligible complete catalog slice:
 *     integer ordered range inside the appropriate old/new hunk, quote match
 *     after `normalizeQuoteText` 1–4096 chars, nonblank explanation ≤1200
 *   - removed/replaced proof must intersect the original concern's old
 *     range and demonstrate the structural change (deleted-file absence,
 *     or old lines no longer standing in the cited range's own new-side
 *     counterpart; a current hunk must exist for replaced-code)
 *   - dismissed requires non-fix-dismissal and never resolves; unverifiable
 *     may have no evidence
 *   - strict shapes (exact key sets — no remote IDs in output), closed
 *     enums, integer relatedCurrentFindingIndexes
 */
import { describe, expect, test } from "bun:test";
import {
  RECHECK_MAX_TARGETS,
  validateRecheckDoc,
  type Assessment,
  type EvidenceSlice,
  type RecheckInput,
  type RecheckTarget,
} from "../../packages/shared/src/recheck-wire";
import { RECHECK_HUNK, RECHECK_SHA } from "../helpers/recheck-wire-fixtures";

const SHA = RECHECK_SHA;
const HUNK: EvidenceSlice = RECHECK_HUNK;

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

const DELETED_FILE: EvidenceSlice = {
  id: "slice-del", headSha: SHA, baseSha: "b" + "0".repeat(39), path: "src/old.ts", oldPath: null,
  kind: "deleted-file",
  oldStart: 5, oldLines: ["old line 5", "old line 6"], newStart: 0, newLines: [], addedNewLines: [],
  oldBlobOid: "oid-old", headBlobOid: null,
  absentAtHead: true, complete: true,
};

const REPLACED_HUNK: EvidenceSlice = {
  id: "slice-rep", headSha: SHA, baseSha: "b" + "0".repeat(39), path: "src/old.ts", oldPath: "src/old.ts",
  kind: "hunk",
  oldStart: 5, oldLines: ["count = a + b;", "render();"], newStart: 5, newLines: ["total = a + b;", "render();"],
  addedNewLines: [5],
  oldBlobOid: "oid-old", headBlobOid: "oid-head",
  absentAtHead: false, complete: true,
};

const REMOVED_STILL_PRESENT: EvidenceSlice = {
  id: "slice-still", headSha: SHA, baseSha: "b" + "0".repeat(39), path: "src/a.ts", oldPath: null,
  kind: "hunk",
  oldStart: 8, oldLines: ["const a = 1;", "const b = 2;"], newStart: 8, newLines: ["const a = 0;", "const b = 2;"],
  addedNewLines: [8],
  oldBlobOid: "oid-old", headBlobOid: "oid-head",
  absentAtHead: false, complete: true,
};

/**
 * The still-present block with one line INSERTED inside it: every cited old
 * line is still on the new side, but no longer contiguous, so a joined-block
 * test would read the interruption as a removal.
 */
const INSERTED_INSIDE: EvidenceSlice = {
  id: "slice-ins", headSha: SHA, baseSha: "b" + "0".repeat(39), path: "src/a.ts", oldPath: null,
  kind: "hunk",
  oldStart: 8, oldLines: ["const a = 1;", "const b = 2;", "const c = 3;"],
  newStart: 8, newLines: ["const a = 1;", "const inserted = 0;", "const b = 2;", "const c = 3;"],
  addedNewLines: [9],
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

/** A hunk in an unrelated file whose lines happen to byte-match the concern. */
const FOREIGN_HUNK: EvidenceSlice = {
  id: "slice-foreign", headSha: SHA, baseSha: "b" + "0".repeat(39), path: "src/other.ts", oldPath: null,
  kind: "hunk",
  oldStart: 8, oldLines: ["const a = 1;", "const b = 2;", "const c = 3;"],
  newStart: 8, newLines: ["const a = 1;", "const b = null ?? 2;", "const c = 3;"],
  addedNewLines: [9],
  oldBlobOid: "oid-old", headBlobOid: "oid-head",
  absentAtHead: false, complete: true,
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
    evidence: [HUNK, DELETED_FILE, REPLACED_HUNK, REMOVED_STILL_PRESENT, INSERTED_INSIDE],
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

const TARGET_2: RecheckTarget = { ...TARGET, rowId: "row-2", findingId: "f-2", associationIds: ["assoc-2"] };

/** The row that must survive whatever the offending row did. */
const SURVIVOR: Assessment = {
  rowId: "row-2",
  disposition: "unverifiable",
  reason: "no-evidence",
  evidence: null,
  relatedCurrentFindingIndexes: [],
};

/** Input carrying a second target, so a degraded row leaves a visible survivor. */
function pairedInput(overrides: Partial<RecheckInput> = {}): RecheckInput {
  return input({ targets: [TARGET, TARGET_2], ...overrides });
}

/** A row-level fault drops only that row; the document and the rest stand. */
function expectDroppedRow(
  outcome: ReturnType<typeof validateRecheckDoc>,
  expected: { index: number; rowId: string | null; error: string },
): void {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.rejected).toHaveLength(1);
  expect(outcome.rejected[0]!.index).toBe(expected.index);
  expect(outcome.rejected[0]!.rowId).toBe(expected.rowId);
  expect(outcome.rejected[0]!.error).toContain(expected.error);
  expect(outcome.doc.results.map((row) => row.rowId)).toEqual([SURVIVOR.rowId]);
}

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

  test("a duplicate row ID carrying an extra key still fails the whole document — identity is decided before row shape", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [addressedResult(), { rowId: "row-1", extra: 1 }],
      },
      pairedInput(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("duplicate row ID");
  });

  test("a foreign row ID carrying an extra key still fails the whole document — identity is decided before row shape", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [addressedResult(), { rowId: "row-999", extra: 1 }],
      },
      pairedInput(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("foreign row");
  });
});

describe("validateRecheckDoc — addressed eligibility", () => {
  test("addressed without verified-fix drops that row", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ reason: "no-evidence" }), SURVIVOR] },
      pairedInput(),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: 'addressed requires reason "verified-fix"' });
  });

  test("addressed with null evidence drops that row", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: null }), SURVIVOR] },
      pairedInput(),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "requires eligible evidence" });
  });

  test("addressed citing a foreign slice drops that row", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ sliceId: "slice-nope" }) }), SURVIVOR] },
      pairedInput(),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "foreign slice" });
  });

  test("addressed citing an incomplete slice drops that row", () => {
    const incomplete = { ...HUNK, complete: false };
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult(), SURVIVOR] },
      pairedInput({ evidence: [incomplete] }),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "incomplete" });
  });

  test("a range outside the hunk new side drops that row", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ startLine: 20, endLine: 21 }) }), SURVIVOR] },
      pairedInput(),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "not inside the hunk new side" });
  });

  test("an inverted range drops that row", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ startLine: 9, endLine: 8 }) }), SURVIVOR] },
      pairedInput(),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "not ordered" });
  });

  test("a quote that does not match the cited lines drops that row", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ quote: "const b = 2;" }) }), SURVIVOR] },
      pairedInput(),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "does not match the cited new-side lines" });
  });

  test("a multi-line quote must match the contiguous cited lines", () => {
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
        results: [
          addressedResult({ evidence: evidence({ startLine: 8, endLine: 9, quote: "const b = null ?? 2;\nconst a = 1;" }) }),
          SURVIVOR,
        ],
      },
      pairedInput(),
    );
    expectDroppedRow(bad, { index: 0, rowId: "row-1", error: "does not match the cited new-side lines" });
  });

  test("current-code on a deleted-file slice drops that row", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({ evidence: evidence({ sliceId: "slice-del", startLine: 5, endLine: 5, quote: "old line 5" }) }),
          SURVIVOR,
        ],
      },
      pairedInput({ targets: [{ ...TARGET, original: OLD_CONCERN_IN_OLD_TS }, TARGET_2] }),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "current-code must cite a hunk slice" });
  });

  test("quote bounds (1–4096 chars) drop the offending row", () => {
    const empty = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ quote: "" }) }), SURVIVOR] },
      pairedInput(),
    );
    expectDroppedRow(empty, { index: 0, rowId: "row-1", error: "quote must be" });

    const oversized = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ quote: "x".repeat(4097) }) }), SURVIVOR] },
      pairedInput(),
    );
    expectDroppedRow(oversized, { index: 0, rowId: "row-1", error: "4096" });
  });

  test("a non-closure row may carry a whitespace-only or empty quote", () => {
    // The visible-quote requirement belongs to the Addressed proof path: a
    // dismissal or an unverifiable note cites evidence without claiming a code
    // match, so a blank quote is not a row fault there.
    for (const [disposition, reason] of [
      ["dismissed", "non-fix-dismissal"],
      ["unverifiable", "no-evidence"],
    ] as const) {
      for (const quote of ["", "   ", "\t"]) {
        const result = validateRecheckDoc(
          {
            schema: "mstar.recheck/v1",
            headSha: SHA,
            results: [
              { rowId: "row-1", disposition, reason, evidence: evidence({ quote }), relatedCurrentFindingIndexes: [] },
              SURVIVOR,
            ],
          },
          pairedInput(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.rejected).toHaveLength(0);
        expect(result.doc.results.map((row) => row.rowId)).toEqual(["row-1", "row-2"]);
      }
    }
  });

  test("a blank or over-long explanation drops that row", () => {
    const blank = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ explanation: "   " }) }), SURVIVOR] },
      pairedInput(),
    );
    expectDroppedRow(blank, { index: 0, rowId: "row-1", error: "nonblank" });

    const long = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({ evidence: evidence({ explanation: "x".repeat(1201) }) }), SURVIVOR] },
      pairedInput(),
    );
    expectDroppedRow(long, { index: 0, rowId: "row-1", error: "1200" });
  });

  test("removed-code deleted-file slice without proven absence drops that row", () => {
    const present = { ...DELETED_FILE, absentAtHead: false };
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({
            evidence: evidence({ kind: "removed-code", sliceId: "slice-del", startLine: 5, endLine: 6, quote: "old line 5\nold line 6" }),
          }),
          SURVIVOR,
        ],
      },
      pairedInput({ evidence: [present], targets: [{ ...TARGET, original: OLD_CONCERN_IN_OLD_TS }, TARGET_2] }),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "must prove absence" });
  });

  test("removed-code citing old lines still present on the hunk new side drops that row", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({
            evidence: evidence({ kind: "removed-code", sliceId: "slice-still", startLine: 9, endLine: 9, quote: "const b = 2;" }),
          }),
          SURVIVOR,
        ],
      },
      pairedInput({ targets: [{ ...TARGET, original: { ...ORIGINAL, lineStart: 9, lineEnd: 9 } }, TARGET_2] }),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "still present" });
  });

  test("a trailing blank on a still-present removed-code quote cannot forge closure", () => {
    // The quote still matches the cited OLD lines after normalization, so the
    // presence check is the only thing standing between present code and a
    // false closure — it must normalize too, or one trailing space passes.
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({
            evidence: evidence({ kind: "removed-code", sliceId: "slice-still", startLine: 9, endLine: 9, quote: "const b = 2; " }),
          }),
          SURVIVOR,
        ],
      },
      pairedInput({ targets: [{ ...TARGET, original: { ...ORIGINAL, lineStart: 9, lineEnd: 9 } }, TARGET_2] }),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "still present" });
  });

  test("replaced-code citing old lines still present on the hunk new side drops that row", () => {
    // An unchanged context line inside the hunk proves nothing was replaced:
    // replaced-code carries the same still-present guard as removed-code, and
    // it normalizes too, so a trailing blank cannot disguise present code.
    for (const quote of ["const b = 2;", "const b = 2; "]) {
      const result = validateRecheckDoc(
        {
          schema: "mstar.recheck/v1",
          headSha: SHA,
          results: [
            addressedResult({
              evidence: evidence({ kind: "replaced-code", sliceId: "slice-still", startLine: 9, endLine: 9, quote }),
            }),
            SURVIVOR,
          ],
        },
        pairedInput({ targets: [{ ...TARGET, original: { ...ORIGINAL, lineStart: 9, lineEnd: 9 } }, TARGET_2] }),
      );
      expectDroppedRow(result, { index: 0, rowId: "row-1", error: "still present" });
    }
  });

  test("an insertion INSIDE the cited block cannot forge a removal: every cited line must be gone", () => {
    // The block is no longer contiguous, but every cited old line survives, so
    // nothing was removed. A joined-block `includes` would pass this row.
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({
            evidence: evidence({
              kind: "removed-code",
              sliceId: "slice-ins",
              startLine: 8,
              endLine: 10,
              quote: "const a = 1;\nconst b = 2;\nconst c = 3;",
            }),
          }),
          SURVIVOR,
        ],
      },
      pairedInput({
        targets: [{ ...TARGET, original: { ...ORIGINAL, lineStart: 8, lineEnd: 10 } }, TARGET_2],
      }),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "still present" });
  });

  test("a replaced range that keeps an identical context line still proves the replacement", () => {
    // Real replacements keep some context: only the lines the change actually
    // removed are gone, so the block is NOT wholly present and the row stands.
    const replaced = {
      ...REPLACED_HUNK,
      id: "slice-rep-context",
      oldLines: ["count = a + b;", "render();"],
      newLines: ["total = a + b;", "render();", "audit();"],
      addedNewLines: [5, 7],
    };
    const outcome = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({
        evidence: evidence({ kind: "replaced-code", sliceId: "slice-rep-context", startLine: 5, endLine: 6, quote: "count = a + b;\nrender();" }),
      })] },
      input({ evidence: [replaced], targets: [{ ...TARGET, original: OLD_CONCERN_IN_OLD_TS }] }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejected).toEqual([]);
  });

  test("a replaced range whose cited text recurs elsewhere in the hunk still proves the replacement", () => {
    // The cited line was replaced in place and the same text is added again at
    // the end of the hunk. Reading the WHOLE new side finds that recurrence and
    // false-rejects a genuine replacement; only the cited range's own
    // counterpart (new lines 5-6) says anything about this range.
    const recurring = {
      ...REPLACED_HUNK,
      id: "slice-rep-recur",
      oldLines: ["count = a + b;", "render();"],
      newLines: ["total = a + b;", "render();", "count = a + b;"],
      addedNewLines: [5, 7],
    };
    const outcome = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult({
        evidence: evidence({ kind: "replaced-code", sliceId: "slice-rep-recur", startLine: 5, endLine: 6, quote: "count = a + b;\nrender();" }),
      })] },
      input({ evidence: [recurring], targets: [{ ...TARGET, original: OLD_CONCERN_IN_OLD_TS }] }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejected).toEqual([]);
  });

  test("current-code on a renamed file is eligible (the concern's old path identifies it)", () => {
    // removed-code/replaced-code already accept `oldPath`; a rename must not
    // strand a current-code fix in the file the concern used to live in.
    const renamed = { ...HUNK, path: "src/b.ts", oldPath: "src/a.ts" };
    const outcome = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [addressedResult()] },
      input({ evidence: [renamed] }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejected).toEqual([]);
    expect(outcome.doc.results).toHaveLength(1);
  });

  test("removed-code on a path unrelated to the original concern drops that row", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({
            evidence: evidence({ kind: "removed-code", sliceId: "slice-del", startLine: 5, endLine: 6, quote: "old line 5\nold line 6" }),
          }),
          SURVIVOR,
        ],
      },
      // original concern lives in src/a.ts, slice cites src/old.ts
      pairedInput(),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "does not match the original concern file" });
  });

  test("current-code citing an unrelated file drops that row (lines may move, files may not)", () => {
    // The quote byte-matches the concern's own lines, but they are cited from
    // another file: a fix in src/other.ts proves nothing about src/a.ts.
    const foreign = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [addressedResult({ evidence: evidence({ sliceId: "slice-foreign" }) }), SURVIVOR],
      },
      pairedInput({ evidence: [FOREIGN_HUNK] }),
    );
    expectDroppedRow(foreign, { index: 0, rowId: "row-1", error: "does not match the original concern file" });

    // The same file cited OUTSIDE the original line range stays eligible: a fix
    // may move the code, so current-code is not range-bound. It still has to
    // cite an ADDED line — moving the proof to the context line at 8 would
    // prove presence only.
    const moved = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({ evidence: evidence({ startLine: 9, endLine: 9, quote: "const b = null ?? 2;" }) }),
        ],
      },
      input({ targets: [{ ...TARGET, original: { ...ORIGINAL, lineStart: 10, lineEnd: 10 } }] }),
    );
    expect(moved.ok).toBe(true);
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
          SURVIVOR,
        ],
      },
      pairedInput({ targets: [{ ...TARGET, original: { ...OLD_CONCERN_IN_OLD_TS, lineStart: 50, lineEnd: 60 } }, TARGET_2] }),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "does not intersect" });
  });

  test("replaced-code with no current hunk drops that row (use removed-code)", () => {
    const pureDeletion = { ...REPLACED_HUNK, newLines: [] };
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          addressedResult({
            evidence: evidence({ kind: "replaced-code", sliceId: "slice-rep", startLine: 5, endLine: 5, quote: "count = a + b;" }),
          }),
          SURVIVOR,
        ],
      },
      pairedInput({ evidence: [pureDeletion], targets: [{ ...TARGET, original: OLD_CONCERN_IN_OLD_TS }, TARGET_2] }),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "no current hunk" });
  });
});

describe("validateRecheckDoc — disposition/reason pairing and shapes", () => {
  test("dismissed requires the non-fix rationale", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          { rowId: "row-1", disposition: "dismissed", reason: "verified-fix", evidence: null, relatedCurrentFindingIndexes: [] },
          SURVIVOR,
        ],
      },
      pairedInput(),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: 'dismissed requires reason "non-fix-dismissal"' });
  });

  test("unverifiable with a closure rationale drops that row", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          { rowId: "row-1", disposition: "unverifiable", reason: "verified-fix", evidence: null, relatedCurrentFindingIndexes: [] },
          SURVIVOR,
        ],
      },
      pairedInput(),
    );
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "unverifiable requires" });
  });

  test("evidence citing a nonexistent slice drops the row even for unverifiable/dismissed", () => {
    for (const disposition of ["unverifiable", "dismissed"] as const) {
      const reason = disposition === "unverifiable" ? "no-evidence" : "non-fix-dismissal";
      const result = validateRecheckDoc(
        {
          schema: "mstar.recheck/v1",
          headSha: SHA,
          results: [
            {
              rowId: "row-1", disposition, reason,
              evidence: { kind: "current-code", sliceId: "slice-nope", startLine: 1, endLine: 1, quote: "x", explanation: "e" },
              relatedCurrentFindingIndexes: [],
            },
            SURVIVOR,
          ],
        },
        pairedInput(),
      );
      expectDroppedRow(result, { index: 0, rowId: "row-1", error: "foreign slice" });
    }
  });

  test("relatedCurrentFindingIndexes must be non-negative integers", () => {
    for (const indexes of [[-1], [1.5], ["0"]]) {
      const result = validateRecheckDoc(
        {
          schema: "mstar.recheck/v1",
          headSha: SHA,
          results: [addressedResult({ relatedCurrentFindingIndexes: indexes as number[] }), SURVIVOR],
        },
        pairedInput(),
      );
      expectDroppedRow(result, { index: 0, rowId: "row-1", error: "non-negative integers" });
    }
  });

  test("a remote ID smuggled into a result (extra key) drops that row", () => {
    const result = validateRecheckDoc(
      {
        schema: "mstar.recheck/v1",
        headSha: SHA,
        results: [
          { ...addressedResult(), threadId: "PRRT_123" },
          SURVIVOR,
        ],
      },
      pairedInput(),
    );
    // The strict shape fails, but the row already proved its rowId, so the
    // rejection stays attributable to row-1 instead of going unidentified.
    expectDroppedRow(result, { index: 0, rowId: "row-1", error: "exactly" });
  });

  test("a non-object row has no identity and only lands in rejected", () => {
    const result = validateRecheckDoc(
      { schema: "mstar.recheck/v1", headSha: SHA, results: [SURVIVOR, "nope"] },
      pairedInput(),
    );
    expectDroppedRow(result, { index: 1, rowId: null, error: "must be an object with exactly" });
  });

  test("non-object documents fail closed", () => {
    for (const value of [null, "doc", 42, [], { schema: "mstar.recheck/v1", headSha: SHA }]) {
      const result = validateRecheckDoc(value, input());
      expect(result.ok).toBe(false);
    }
  });
});
