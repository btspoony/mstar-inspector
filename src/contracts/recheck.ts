/**
 * Typed recheck wire format + fail-closed validator (plan 67 Task 1, spec
 * review-lifecycle §7.3). ZERO-RUNTIME-DEPENDENCY shared wire module —
 * type-only imports permitted, no value imports, no IO, no clock: the same
 * module is safe on the worker, in the sandbox runner, and in bun tests.
 *
 * This is the single normative CODE copy of the §7.3 wire shapes. The
 * finding-lifecycle store (src/store/finding-lifecycle.ts) re-exports
 * `Scope` and imports the target/assessment types from here instead of
 * restating them; `ReviewFinding` / `MstarReviewV1` in the spec are aliases
 * to the engine's existing envelope/finding types (never replacement
 * schemas) and do not appear on this wire.
 *
 * Validation contract (spec §7.3 "Validation"): exact schema/HEAD, strict
 * object shape and closed enums; at most 25 results; unique row IDs
 * contained in the input; no remote IDs in output. Addressed requires
 * `verified-fix` plus an eligible complete catalog slice with an integer
 * ordered range inside the appropriate old/new hunk, exact quote match
 * (1–4096 chars) and a nonblank explanation ≤1200 chars. Dismissed requires
 * the `non-fix-dismissal` reason and never resolves; its rationale basis is
 * the carried `evidence.explanation` when the output cites evidence (that
 * explanation is shape-validated) or, with no evidence cited, the original
 * discussion in the input — so an evidence-free dismissal is legal here and
 * still evidence-grounded by construction. Unverifiable may have no
 * evidence. Duplicate/foreign/stale/malformed documents fail closed as a
 * whole. The validator proves location/content only — the semantic
 * correctness of the explanation and the trusted capture itself belong to
 * the evidence catalog (spec §7.3 "Trusted evidence catalog") and the
 * consumer.
 */

/** Authenticated routing scope (spec §7.0): appId is github_apps.id. */
export type Scope = { appId: string; installationId: number; owner: string; repo: string; prNumber: number };

export type Coverage = 'complete' | 'truncated' | 'unavailable';

/** The original published finding (never reduced to a title). */
export type OriginalFinding = {
  title: string; body: string; filePath: string | null;
  lineStart: number | null; lineEnd: number | null;
  mergeClass: 'must-fix' | 'should-fix' | 'nit'; category: string | null;
  fingerprintHint: string | null;
};

/** One open lifecycle row offered to the recheck seat. */
export type RecheckTarget = {
  rowId: string; findingId: string; original: OriginalFinding;
  firstSeenSha: string; lastAssessment: Assessment | null;
  associationIds: string[];
};

/** Worker-captured, trusted diff slice for the reviewed head/base. */
export type EvidenceSlice = {
  id: string; headSha: string; baseSha: string; path: string;
  oldPath: string | null; kind: 'hunk' | 'deleted-file';
  oldStart: number; oldLines: string[]; newStart: number; newLines: string[];
  oldBlobOid: string | null; headBlobOid: string | null;
  absentAtHead: boolean; complete: boolean;
};

/** The model's per-row evidence citation (validated against the catalog). */
export type Evidence = {
  kind: 'current-code' | 'removed-code' | 'replaced-code';
  sliceId: string; startLine: number; endLine: number; quote: string;
  explanation: string;
};

export type Assessment = {
  rowId: string;
  disposition: 'addressed' | 'dismissed' | 'unverifiable';
  reason: 'verified-fix' | 'non-fix-dismissal' | 'conflict' | 'identity-drift' |
    'no-evidence' | 'omitted' | 'invalid-output' | 'budget' | 'context-incomplete' | 'stale-head';
  evidence: Evidence | null;
  relatedCurrentFindingIndexes: number[];
};

export type ThreadSnapshot = {
  associationId: string; threadId: string; commentId: number;
  headSha: string; digest: string; commentCount: number;
  capturedMs: number; coverage: Coverage; modelCoverage: Coverage;
};

export type Discussion = {
  items: { source: 'issue' | 'thread'; associationId: string | null;
    id: string; author: string; createdAt: string; updatedAt: string; body: string }[];
  issueCoverage: Coverage; issueDigest: string; capturedMs: number;
  threads: ThreadSnapshot[];
};

export type RecheckInput = {
  schema: 'mstar.recheck-input/v1'; headSha: string;
  targets: RecheckTarget[]; evidence: EvidenceSlice[]; discussion: Discussion;
};

export type RecheckDoc = { schema: 'mstar.recheck/v1'; headSha: string; results: Assessment[] };

export const RECHECK_OUTPUT_PATH = '/tmp/mstar-recheck.json';
export const RECHECK_MAX_TARGETS = 25;
export const ASSESSMENT_TARGET_CAP = 25;
export const RECHECK_MAX_RUNTIME_MS = 180_000;
export const RECHECK_MIN_REMAINING_MS = 30_000;
export const RECHECK_FILE_MAX_BYTES = 262_144;

/** Addressed requires the verified-fix rationale — nothing else closes a row. */
const ADDRESSED_REASON = 'verified-fix';
const DISMISSED_REASON = 'non-fix-dismissal';
/** Unverifiable reasons: everything except the two closure rationales. */
const UNVERIFIABLE_REASONS: ReadonlySet<string> = new Set([
  'conflict', 'identity-drift', 'no-evidence', 'omitted',
  'invalid-output', 'budget', 'context-incomplete', 'stale-head',
]);
const DISPOSITIONS: ReadonlySet<string> = new Set(['addressed', 'dismissed', 'unverifiable']);
const REASONS: ReadonlySet<string> = new Set([ADDRESSED_REASON, DISMISSED_REASON, ...UNVERIFIABLE_REASONS]);
const EVIDENCE_KINDS: ReadonlySet<string> = new Set(['current-code', 'removed-code', 'replaced-code']);

const QUOTE_MIN_CHARS = 1;
const QUOTE_MAX_CHARS = 4096;
const EXPLANATION_MAX_CHARS = 1200;

type Err = { ok: false; error: string };
const fail = (error: string): Err => ({ ok: false, error });

/** Strict object shape: a real object (not array/null) with EXACTLY `keys`. */
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) return null;
  return obj;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Byte-equal line-segment quote: `lines[start..end]` joined with '\n'. */
function segmentQuote(lines: string[], startLine: number, start: number, endLine: number): string | null {
  const from = startLine - start;
  const to = endLine - start;
  if (from < 0 || to >= lines.length) return null;
  return lines.slice(from, to + 1).join('\n');
}

/**
 * Structural eligibility of an Addressed evidence citation against the
 * trusted catalog slice (spec §7.3 "Validation"): the slice must exist and
 * be complete; the cited range must be integer/ordered and fall entirely
 * inside the appropriate old/new side; the quote must byte-equal those
 * lines; removed/replaced proof must intersect the original concern's old
 * range and demonstrate the relevant structural change. Returns null when
 * eligible, else the failure reason.
 */
function addressedProofError(
  evidence: { kind: string; sliceId: string; startLine: number; endLine: number; quote: string },
  slices: ReadonlyMap<string, EvidenceSlice>,
  original: OriginalFinding,
): string | null {
  const slice = slices.get(evidence.sliceId);
  if (slice === undefined) return `evidence.sliceId ${JSON.stringify(evidence.sliceId)} is not in the input catalog (foreign slice)`;
  if (slice.complete !== true) return 'evidence cites an incomplete catalog slice';

  if (evidence.endLine < evidence.startLine) return 'evidence range is not ordered (endLine < startLine)';
  if (evidence.startLine < 1) return 'evidence range is not positive';

  const quoteLen = evidence.quote.length;
  if (quoteLen < QUOTE_MIN_CHARS || quoteLen > QUOTE_MAX_CHARS) {
    return `evidence.quote must be ${QUOTE_MIN_CHARS}–${QUOTE_MAX_CHARS} chars, got ${quoteLen}`;
  }

  const oldEnd = slice.oldStart + slice.oldLines.length - 1;
  const newEnd = slice.newStart + slice.newLines.length - 1;

  if (evidence.kind === 'current-code') {
    if (slice.kind !== 'hunk') return 'current-code must cite a hunk slice';
    if (slice.absentAtHead) return 'current-code cites a slice absent at HEAD';
    if (slice.newLines.length === 0) return 'current-code cites a hunk with no new-side lines';
    const expected = segmentQuote(slice.newLines, evidence.startLine, slice.newStart, evidence.endLine);
    if (expected === null) {
      return `current-code range ${evidence.startLine}-${evidence.endLine} is not inside the hunk new side (${slice.newStart}-${newEnd})`;
    }
    if (expected !== evidence.quote) return 'current-code quote does not byte-equal the cited new-side lines';
    return null;
  }

  // removed-code / replaced-code cite the OLD side and must intersect the
  // original concern's old range (renamed code alone is not removal proof).
  const expected = segmentQuote(slice.oldLines, evidence.startLine, slice.oldStart, evidence.endLine);
  if (expected === null) {
    return `${evidence.kind} range ${evidence.startLine}-${evidence.endLine} is not inside the slice old side (${slice.oldStart}-${oldEnd})`;
  }
  if (expected !== evidence.quote) return `${evidence.kind} quote does not byte-equal the cited old-side lines`;

  if (original.filePath !== null && slice.path !== original.filePath && slice.oldPath !== original.filePath) {
    return `${evidence.kind} slice path ${JSON.stringify(slice.path)} does not match the original concern file ${JSON.stringify(original.filePath)}`;
  }
  if (original.lineStart !== null && original.lineEnd !== null) {
    const overlaps = evidence.startLine <= original.lineEnd && evidence.endLine >= original.lineStart;
    if (!overlaps) {
      return `${evidence.kind} range ${evidence.startLine}-${evidence.endLine} does not intersect the original concern range ${original.lineStart}-${original.lineEnd}`;
    }
  }

  if (evidence.kind === 'removed-code') {
    if (slice.kind === 'deleted-file') {
      if (!slice.absentAtHead) return 'removed-code deleted-file slice must prove absence at HEAD';
      return null;
    }
    // Hunk slice: the cited old lines must no longer exist verbatim on the
    // new side — otherwise the code was not removed by this change.
    if (slice.newLines.length > 0 && slice.newLines.join('\n').includes(evidence.quote)) {
      return 'removed-code cites old lines still present on the hunk new side';
    }
    return null;
  }

  // replaced-code: the old range plus its current hunk — a current side
  // must exist, otherwise the change is a removal, not a replacement.
  if (slice.kind !== 'hunk') return 'replaced-code must cite a hunk slice';
  if (slice.newLines.length === 0) return 'replaced-code slice has no current hunk (use removed-code)';
  return null;
}

/** Validate one result's evidence structurally (slice membership + bounds). */
function evidenceShapeError(
  evidence: Record<string, unknown>,
  slices: ReadonlyMap<string, EvidenceSlice>,
  where: string,
): string | null {
  if (!EVIDENCE_KINDS.has(String(evidence.kind))) {
    return `${where}.evidence.kind is outside the closed enum`;
  }
  if (!isNonemptyString(evidence.sliceId)) return `${where}.evidence.sliceId must be a nonempty string`;
  if (!isInt(evidence.startLine) || !isInt(evidence.endLine)) {
    return `${where}.evidence range must be integers`;
  }
  if (typeof evidence.quote !== 'string') return `${where}.evidence.quote must be a string`;
  if (evidence.quote.length < QUOTE_MIN_CHARS || evidence.quote.length > QUOTE_MAX_CHARS) {
    return `${where}.evidence.quote must be ${QUOTE_MIN_CHARS}–${QUOTE_MAX_CHARS} chars`;
  }
  if (
    typeof evidence.explanation !== 'string' || evidence.explanation.trim().length === 0 ||
    evidence.explanation.length > EXPLANATION_MAX_CHARS
  ) {
    return `${where}.evidence.explanation must be a nonblank string ≤${EXPLANATION_MAX_CHARS} chars`;
  }
  if (!slices.has(evidence.sliceId as string)) {
    return `${where}.evidence.sliceId ${JSON.stringify(evidence.sliceId)} is not in the input catalog (foreign slice)`;
  }
  return null;
}

/**
 * Fail-closed recheck document validation (spec §7.3): returns the typed
 * doc on success, or a specific error string. Duplicate/foreign/stale/
 * malformed documents fail closed as a whole — no partial acceptance.
 * Omitted selected rows becoming unverifiable is the consumer's
 * reconciliation job, not this validator's.
 */
export function validateRecheckDoc(value: unknown, input: RecheckInput): { ok: true; doc: RecheckDoc } | Err {
  const doc = exactObject(value, ['schema', 'headSha', 'results']);
  if (doc === null) return fail('document must be an object with exactly {schema, headSha, results}');
  if (doc.schema !== 'mstar.recheck/v1') {
    return fail(`schema must be "mstar.recheck/v1", got ${JSON.stringify(doc.schema)}`);
  }
  if (!isNonemptyString(doc.headSha)) return fail('headSha must be a nonempty string');
  if (doc.headSha !== input.headSha) {
    return fail(`headSha ${JSON.stringify(doc.headSha)} does not equal the input HEAD ${JSON.stringify(input.headSha)} (stale document)`);
  }
  if (!Array.isArray(doc.results)) return fail('results must be an array');
  if (doc.results.length > RECHECK_MAX_TARGETS) {
    return fail(`at most ${RECHECK_MAX_TARGETS} results allowed, got ${doc.results.length}`);
  }

  const slices = new Map(input.evidence.map((slice) => [slice.id, slice]));
  const inputRowIds = new Set(input.targets.map((target) => target.rowId));
  const seenRowIds = new Set<string>();

  for (let i = 0; i < doc.results.length; i++) {
    const where = `results[${i}]`;
    const raw = doc.results[i];
    const result = exactObject(raw, ['rowId', 'disposition', 'reason', 'evidence', 'relatedCurrentFindingIndexes']);
    if (result === null) {
      return fail(`${where} must be an object with exactly {rowId, disposition, reason, evidence, relatedCurrentFindingIndexes}`);
    }
    if (!isNonemptyString(result.rowId)) return fail(`${where}.rowId must be a nonempty string`);
    if (seenRowIds.has(result.rowId)) return fail(`${where}.rowId ${JSON.stringify(result.rowId)} is a duplicate row ID`);
    seenRowIds.add(result.rowId);
    if (!inputRowIds.has(result.rowId)) {
      return fail(`${where}.rowId ${JSON.stringify(result.rowId)} is not in the input targets (foreign row)`);
    }
    if (typeof result.disposition !== 'string' || !DISPOSITIONS.has(result.disposition)) {
      return fail(`${where}.disposition is outside the closed enum`);
    }
    if (typeof result.reason !== 'string' || !REASONS.has(result.reason)) {
      return fail(`${where}.reason is outside the closed enum`);
    }

    if (result.disposition === 'addressed') {
      if (result.reason !== ADDRESSED_REASON) {
        return fail(`${where}: addressed requires reason "${ADDRESSED_REASON}"`);
      }
    } else if (result.disposition === 'dismissed') {
      if (result.reason !== DISMISSED_REASON) {
        return fail(`${where}: dismissed requires reason "${DISMISSED_REASON}"`);
      }
    } else if (!UNVERIFIABLE_REASONS.has(result.reason as string)) {
      return fail(`${where}: unverifiable requires an unverifiable reason, got ${JSON.stringify(result.reason)}`);
    }

    let evidence: Record<string, unknown> | null = null;
    if (result.evidence !== null) {
      evidence = exactObject(result.evidence, ['kind', 'sliceId', 'startLine', 'endLine', 'quote', 'explanation']);
      if (evidence === null) {
        return fail(`${where}.evidence must be an object with exactly {kind, sliceId, startLine, endLine, quote, explanation} or null`);
      }
      const shapeError = evidenceShapeError(evidence, slices, where);
      if (shapeError !== null) return fail(shapeError);
    } else if (result.disposition === 'addressed') {
      return fail(`${where}: addressed requires eligible evidence (got null)`);
    }

    if (!Array.isArray(result.relatedCurrentFindingIndexes)) {
      return fail(`${where}.relatedCurrentFindingIndexes must be an array`);
    }
    for (const index of result.relatedCurrentFindingIndexes) {
      if (!isInt(index) || index < 0) {
        return fail(`${where}.relatedCurrentFindingIndexes must contain non-negative integers`);
      }
    }

    if (result.disposition === 'addressed' && evidence !== null) {
      const target = input.targets.find((t) => t.rowId === result.rowId);
      const proofError = addressedProofError(
        {
          kind: evidence.kind as string,
          sliceId: evidence.sliceId as string,
          startLine: evidence.startLine as number,
          endLine: evidence.endLine as number,
          quote: evidence.quote as string,
        },
        slices,
        target!.original,
      );
      if (proofError !== null) return fail(`${where}: ${proofError}`);
    }
  }

  return { ok: true, doc: value as RecheckDoc };
}
