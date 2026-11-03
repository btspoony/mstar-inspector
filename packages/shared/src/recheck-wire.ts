/**
 * Typed recheck wire format + fail-closed validator (spec
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
 * ordered range inside the appropriate old/new hunk, quote equality after
 * whitespace normalization (CRLF/CR→LF, per-line trailing blanks stripped,
 * one trailing newline dropped; 1–4096 chars) and a nonblank explanation
 * ≤1200 chars. Dismissed requires the `non-fix-dismissal` reason and never
 * resolves; its rationale basis is the carried `evidence.explanation` when
 * the output cites evidence (that explanation is shape-validated) or, with
 * no evidence cited, the original discussion in the input — so an
 * evidence-free dismissal is legal here and still evidence-grounded by
 * construction. Unverifiable may have no evidence. Document-level distrust
 * (wrong schema, stale HEAD, non-array/oversized results, duplicate or
 * foreign row IDs) fails closed as a whole; a row-level content error
 * instead drops that row into `rejected` and the rest of the document
 * stands. The validator proves location/content only — the semantic
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

/**
 * Why a recheck round ended — written by the runner beside the document so a
 * round that produced no document is still attributable in D1.
 * `rejected_row_ids` names the rows validateRecheckDoc dropped (sorted) and
 * `rejected` is its length, so both faces of the count agree; a row with no
 * readable rowId cannot be named and is not counted. `reason`/`error` are null
 * unless the round degraded.
 */
export const RECHECK_STATUS_PATH = '/tmp/mstar-recheck-status.json';
export type RecheckStatus = {
  schema: 'mstar.recheck-status/v1'; headSha: string;
  outcome: 'ok' | 'skipped' | 'failed';
  rejected: number; rejected_row_ids: string[];
  reason: string | null; error: string | null;
};

/** Status `error` bound — the seat redacts then truncates here, the consumer's failure row too. */
export const RECHECK_STATUS_ERROR_MAX_CHARS = 500;

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

/**
 * The rowId a raw result claims, read WITHOUT trusting its shape: identity
 * must be settled before any other row-level check, or a malformed row could
 * degrade per-row when the real fault is a duplicate/foreign ID. Null when
 * the value is not an object, or carries no nonempty string rowId.
 */
function rawResultRowId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const rowId = (value as Record<string, unknown>).rowId;
  return isNonemptyString(rowId) ? rowId : null;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Normalize a quoted multi-line block for comparison: CRLF/CR→LF, per-line
 * trailing whitespace stripped, one trailing newline dropped. Indentation and
 * interior blanks are significant; only formatting noise is forgiven.
 */
export function normalizeQuoteText(text: string): string {
  const unified = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n');
  return unified.endsWith('\n') ? unified.slice(0, -1) : unified;
}

/** Line-segment quote: `lines[start..end]` joined with '\n'. */
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
 * inside the appropriate old/new side; the quote must equal those lines
 * after `normalizeQuoteText`; removed/replaced proof must intersect the
 * original concern's old range and demonstrate the relevant structural
 * change. Returns null when eligible, else the failure reason.
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
    if (normalizeQuoteText(expected) !== normalizeQuoteText(evidence.quote)) {
      return 'current-code quote does not match the cited new-side lines';
    }
    return null;
  }

  // removed-code / replaced-code cite the OLD side and must intersect the
  // original concern's old range (renamed code alone is not removal proof).
  const expected = segmentQuote(slice.oldLines, evidence.startLine, slice.oldStart, evidence.endLine);
  if (expected === null) {
    return `${evidence.kind} range ${evidence.startLine}-${evidence.endLine} is not inside the slice old side (${slice.oldStart}-${oldEnd})`;
  }
  if (normalizeQuoteText(expected) !== normalizeQuoteText(evidence.quote)) {
    return `${evidence.kind} quote does not match the cited old-side lines`;
  }

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
    // new side — otherwise the code was not removed by this change. Both
    // sides are normalized, so a trailing blank cannot disguise present code.
    const newSide = normalizeQuoteText(slice.newLines.join('\n'));
    if (slice.newLines.length > 0 && newSide.includes(normalizeQuoteText(evidence.quote))) {
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

/** A row dropped for its own content: the document stands without it. */
export type RecheckRowRejection = { rowId: string | null; index: number; error: string };

/** validateRecheckDoc's verdict: the surviving document plus the dropped rows, or the document-level error. */
export type RecheckGateResult =
  | { ok: true; doc: RecheckDoc; rejected: RecheckRowRejection[] }
  | { ok: false; error: string };

/**
 * Row-level content rules (shape, closed enums, disposition/reason pairing,
 * evidence, index list, addressed proof). Returns the failure reason, or null
 * when the row is assessable. Row identity (duplicate/foreign) is NOT here —
 * that distrust is document-level.
 */
function rowContentError(
  result: Record<string, unknown>,
  rowId: string,
  where: string,
  slices: ReadonlyMap<string, EvidenceSlice>,
  targets: RecheckTarget[],
): string | null {
  if (typeof result.disposition !== 'string' || !DISPOSITIONS.has(result.disposition)) {
    return `${where}.disposition is outside the closed enum`;
  }
  if (typeof result.reason !== 'string' || !REASONS.has(result.reason)) {
    return `${where}.reason is outside the closed enum`;
  }

  if (result.disposition === 'addressed') {
    if (result.reason !== ADDRESSED_REASON) {
      return `${where}: addressed requires reason "${ADDRESSED_REASON}"`;
    }
  } else if (result.disposition === 'dismissed') {
    if (result.reason !== DISMISSED_REASON) {
      return `${where}: dismissed requires reason "${DISMISSED_REASON}"`;
    }
  } else if (!UNVERIFIABLE_REASONS.has(result.reason as string)) {
    return `${where}: unverifiable requires an unverifiable reason, got ${JSON.stringify(result.reason)}`;
  }

  let evidence: Record<string, unknown> | null = null;
  if (result.evidence !== null) {
    evidence = exactObject(result.evidence, ['kind', 'sliceId', 'startLine', 'endLine', 'quote', 'explanation']);
    if (evidence === null) {
      return `${where}.evidence must be an object with exactly {kind, sliceId, startLine, endLine, quote, explanation} or null`;
    }
    const shapeError = evidenceShapeError(evidence, slices, where);
    if (shapeError !== null) return shapeError;
  } else if (result.disposition === 'addressed') {
    return `${where}: addressed requires eligible evidence (got null)`;
  }

  if (!Array.isArray(result.relatedCurrentFindingIndexes)) {
    return `${where}.relatedCurrentFindingIndexes must be an array`;
  }
  for (const index of result.relatedCurrentFindingIndexes) {
    if (!isInt(index) || index < 0) {
      return `${where}.relatedCurrentFindingIndexes must contain non-negative integers`;
    }
  }

  if (result.disposition === 'addressed' && evidence !== null) {
    const target = targets.find((t) => t.rowId === rowId);
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
    if (proofError !== null) return `${where}: ${proofError}`;
  }
  return null;
}

/**
 * Recheck document validation (spec §7.3). Document-level distrust — wrong
 * schema, stale HEAD, non-array or oversized results, a duplicate or foreign
 * row ID — fails closed as a whole. A row-level content error instead drops
 * that one row into `rejected` and the surviving rows form `doc.results`, so
 * one imprecise citation cannot discard the rest of the report. Row identity
 * is decided before any other row-level check: a malformed row carrying a
 * duplicate or foreign rowId still fails the whole document.
 * Omitted selected rows becoming unverifiable is the consumer's
 * reconciliation job, not this validator's.
 */
export function validateRecheckDoc(
  value: unknown,
  input: RecheckInput,
): RecheckGateResult {
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
  const results: Assessment[] = [];
  const rejected: RecheckRowRejection[] = [];

  for (let i = 0; i < doc.results.length; i++) {
    const where = `results[${i}]`;
    const raw = doc.results[i];
    // Identity FIRST: a row that carries a rowId has its duplicate/foreign
    // verdict decided before any shape check, so a malformed row can never
    // degrade into a per-row drop when the real fault is document-level.
    const rawRowId = rawResultRowId(raw);
    if (rawRowId !== null) {
      if (seenRowIds.has(rawRowId)) return fail(`${where}.rowId ${JSON.stringify(rawRowId)} is a duplicate row ID`);
      seenRowIds.add(rawRowId);
      if (!inputRowIds.has(rawRowId)) {
        return fail(`${where}.rowId ${JSON.stringify(rawRowId)} is not in the input targets (foreign row)`);
      }
    }
    const result = exactObject(raw, ['rowId', 'disposition', 'reason', 'evidence', 'relatedCurrentFindingIndexes']);
    if (result === null) {
      rejected.push({ rowId: null, index: i, error: `${where} must be an object with exactly {rowId, disposition, reason, evidence, relatedCurrentFindingIndexes}` });
      continue;
    }
    if (!isNonemptyString(result.rowId)) {
      rejected.push({ rowId: null, index: i, error: `${where}.rowId must be a nonempty string` });
      continue;
    }

    const contentError = rowContentError(result, result.rowId, where, slices, input.targets);
    if (contentError !== null) {
      rejected.push({ rowId: result.rowId, index: i, error: contentError });
      continue;
    }
    results.push(result as unknown as Assessment);
  }

  return { ok: true, doc: { schema: 'mstar.recheck/v1', headSha: doc.headSha, results }, rejected };
}
