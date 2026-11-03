/**
 * The one recheck wire fixture both wire suites assert against. The per-rule
 * contract is owned by tests/contracts/recheck.test.ts; the per-row
 * degradation suite (tests/shared/recheck-wire.test.ts) shares this slice so a
 * new `EvidenceSlice` member can never be added to one copy while the other
 * keeps type-checking.
 */
import type { EvidenceSlice } from "../../packages/shared/src/recheck-wire";

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
