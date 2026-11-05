/**
 * The one recheck wire fixture both wire suites assert against. The per-rule
 * contract is owned by tests/contracts/recheck.test.ts; the per-row
 * degradation suite (tests/shared/recheck-wire.test.ts) shares this slice so a
 * new `EvidenceSlice` member can never be added to one copy while the other
 * keeps type-checking.
 */
import {
  MODEL_ITEM_MAX_CHARS,
  MODEL_MAX_ITEMS,
  MODEL_TOTAL_MAX_CHARS,
  RECHECK_MAX_TARGETS,
  type EvidenceSlice,
  type RecheckInput,
} from "../../packages/shared/src/recheck-wire";

export const RECHECK_SHA = "0123456789abcdef0123456789abcdef01234567";

/** One complete hunk: 3 new lines at 8..10, quoted as "line 8-10". */
export const RECHECK_HUNK: EvidenceSlice = {
  id: "slice-1",
  headSha: RECHECK_SHA,
  baseSha: "b" + "0".repeat(39),
  path: "src/a.ts",
  oldPath: null,
  kind: "hunk",
  oldStart: 8,
  oldLines: ["const a = 1;", "const b = 2;", "const c = 3;"],
  newStart: 8,
  newLines: ["const a = 1;", "const b = null ?? 2;", "const c = 3;"],
  addedNewLines: [9],
  oldBlobOid: "oid-old",
  headBlobOid: "oid-head",
  absentAtHead: false,
  complete: true,
};

/** §7.3 catalog shape: at most 4 slices per target (src/pipeline/consumer.ts). */
export const RECHECK_SLICES_PER_TARGET = 4;

/**
 * The largest round the documented limits allow at the caps that bound a ROW:
 * `RECHECK_MAX_TARGETS` targets, `RECHECK_SLICES_PER_TARGET` slices each, and
 * a discussion at its per-item character cap within its total cap. The slice
 * bodies are short on purpose — a byte-saturated catalogue is the seat-fit
 * suite's input (`tests/review/recheck-seat-yield.test.ts`), not this one's.
 */
export function maxRecheckInput(): RecheckInput {
  const targets = Array.from({ length: RECHECK_MAX_TARGETS }, (_, row) => {
    const filePath = `src/file-${row}.ts`;
    return {
      rowId: `row-${row}`,
      findingId: `f-${row}`,
      original: {
        title: `Prior finding ${row}`,
        body: `The previously published concern ${row}.`,
        filePath,
        lineStart: 1,
        lineEnd: 3,
        mergeClass: "must-fix" as const,
        category: "logic",
        fingerprintHint: `fp-${row}`,
      },
      firstSeenSha: RECHECK_SHA,
      lastAssessment: null,
      associationIds: [`assoc-${row}`],
    };
  });
  const evidence = targets.flatMap((target, row) =>
    Array.from({ length: RECHECK_SLICES_PER_TARGET }, (_, slice) => {
      const line = (index: number): string => `const row${row}_${slice}_${index} = ${index};`;
      return {
        id: `slice-${row}-${slice}`,
        headSha: RECHECK_SHA,
        baseSha: "b" + "0".repeat(39),
        path: target.original.filePath,
        oldPath: null,
        kind: "hunk" as const,
        oldStart: 1,
        oldLines: [line(0), line(1), line(2)],
        newStart: 1,
        newLines: [line(0), `const row${row}_${slice}_1 = null ?? 1;`, line(2)],
        addedNewLines: [2],
        oldBlobOid: "oid-old",
        headBlobOid: "oid-head",
        absentAtHead: false,
        complete: true,
      };
    }),
  );
  // The declared pair cannot both be reached (50 × 1200 > 8000), so this is
  // the largest whole-item capture: every item AT its cap, the total inside.
  const itemsPerCapture = Math.min(MODEL_MAX_ITEMS, Math.floor(MODEL_TOTAL_MAX_CHARS / MODEL_ITEM_MAX_CHARS));
  return {
    schema: "mstar.recheck-input/v1",
    headSha: RECHECK_SHA,
    targets,
    evidence,
    discussion: {
      items: Array.from({ length: itemsPerCapture }, (_, index) => ({
        source: "issue" as const,
        associationId: null,
        id: `comment-${index}`,
        author: "maintainer",
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
        body: `discussion body ${index} `.padEnd(MODEL_ITEM_MAX_CHARS, "x"),
      })),
      issueCoverage: "truncated" as const,
      issueDigest: "digest-1",
      capturedMs: 1762000000000,
      threads: [],
    },
  };
}
