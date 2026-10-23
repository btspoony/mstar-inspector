/**
 * Review envelope schema — the inspector-side zod mirror of
 * the harness `mstar.review/v1` envelope. SSOT for the vocabulary is the
 * pinned engine (`@mstar-harness/engine` `validateMstarReviewV1` /
 * `synthesizeReview`); the publishing contract is
 * `.mstar/specs/github-review-comment-mapping.md`. The M1
 * findings-schema.md contract is write-retired — it is never the write
 * authority again.
 *
 * Vocab is imported from the engine — never re-declared:
 *   - verdict:              PR_VERDICTS   = "ship it" | "needs fixes" | "blocked" | "incomplete"
 *   - incomplete fact:      reason + unscanned (single-line, non-blank; an empty
 *     unscanned list is legal) — required exactly by the `incomplete` verdict,
 *     rejected for every other verdict, and echoed by a provided tally
 *   - findings[].mergeClass: MERGE_CLASSES = "must-fix" | "should-fix" | "nit"
 * The M1 inspector vocab (verdict comment|request_changes|approve, severity
 * critical|warning|suggestion|info) is rejected on the write path: an M1
 * document fails the required `schema: "mstar.review/v1"` literal and the
 * verdict/mergeClass enums. A stray M1 `severity` KEY is REJECTED (never
 * silently stripped) before zod. The two inspector checks straddle the engine
 * gate: the top-level `severity` ban runs BEFORE `validateMstarReviewV1`, so
 * it keeps `review.inspector-vocab` instead of the engine's generic
 * unknown-key report; the engine gate itself fails findings[].severity with
 * `review.inspector-vocab`; and the unknown finding-key check
 * (`findUnknownFindingKey`) runs AFTER the gate, so it cannot mask that code
 * (mapping spec §4.2: parse/validate failure → no post, no insert).
 *
 * The engine 4.0.7 envelope is CLOSED: `validateMstarReviewV1` refuses every
 * top-level key outside the envelope with `review.unknown-key`. Its findings
 * are not key-checked by the engine, so unknown finding keys are refused here
 * with the same code (`findUnknownFindingKey`) instead of being dropped
 * silently. Required keys stay required, and file_path / line_start /
 * line_end are OPTIONAL and nullable (envelope contract: a finding's location
 * is optional). title and body are required non-empty strings.
 */

import {
  MERGE_CLASSES,
  PR_VERDICTS,
  validateMstarReviewV1,
  type MergeClass,
  type MstarReviewFinding,
  type MstarReviewV1,
  type PrIncomplete,
} from "@mstar-harness/engine";
import { z } from "zod";

export type ReviewFinding = MstarReviewFinding;
export type ReviewOutput = MstarReviewV1;

const verdictSchema = z.enum(PR_VERDICTS);

/** Engine `isSingleLineFact` mirror: non-blank and free of CR/LF. */
const isSingleLineFact = (value: string): boolean => value.trim() !== "" && !/[\r\n]/.test(value);

/**
 * Mirror of the engine `PrIncomplete` shape — the fact that makes the
 * `incomplete` verdict meaningful: `reason` is the declared cause, `unscanned`
 * the scope the run never reached (empty = nothing left unscanned). The
 * `PrIncomplete` annotation keeps this runtime schema bound to the engine
 * contract instead of inferring a private shape.
 */
const incompleteSchema: z.ZodType<PrIncomplete> = z.object({
  reason: z.string().refine(isSingleLineFact, "reason must be a single-line non-blank string"),
  unscanned: z.array(
    z.string().refine(isSingleLineFact, "each unscanned entry must be a single-line non-blank string"),
  ),
});

const findingSchema = z.object({
  mergeClass: z.enum(MERGE_CLASSES),
  category: z.string().optional(),
  file_path: z.string().nullable().optional(),
  line_start: z.number().int().nullable().optional(),
  line_end: z.number().int().nullable().optional(),
  title: z.string().refine((title) => title.trim() !== "", "title must be a non-empty string"),
  body: z.string().refine((body) => body.trim() !== "", "body must be a non-empty string"),
  fingerprint_hint: z.string().optional(),
});

const FINDING_KEYS = new Set(Object.keys(findingSchema.shape));

/**
 * First `findings[i].<key>` outside the finding schema, or null. The engine
 * 4.0.7 unknown-key gate covers the envelope and the tally but not findings;
 * this keeps an unknown finding key from being dropped silently.
 */
function findUnknownFindingKey(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const findings = (doc as Record<string, unknown>).findings;
  if (!Array.isArray(findings)) return null;
  for (const [index, finding] of findings.entries()) {
    if (typeof finding !== "object" || finding === null || Array.isArray(finding)) continue;
    const key = Object.keys(finding).find((candidate) => !FINDING_KEYS.has(candidate));
    if (key !== undefined) return `findings[${index}].${key}`;
  }
  return null;
}

/** Mirror of the engine `PrTallyResult` shape (what `computePrTally` produces). */
const tallySchema = z.object({
  verdict: verdictSchema,
  scorePct: z.number().int().min(0).max(100),
  tally: z.object({
    mustFix: z.number().int().min(0),
    shouldFix: z.number().int().min(0),
    nit: z.number().int().min(0),
    unverified: z.number().int().min(0),
  }),
  chatHeader: z.string(),
  /** Echo of the envelope's incomplete fact (engine `PrTallyResult.incomplete`). */
  incomplete: incompleteSchema.optional(),
});

const targetSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  pr: z.number().optional(),
  head_sha: z.string().optional(),
});

const outputSchema: z.ZodType<ReviewOutput> = z
  .object({
    schema: z.literal("mstar.review/v1"),
    verdict: verdictSchema,
    summary_md: z.string().refine((s) => s.trim() !== "", "summary_md must be a non-empty string"),
    tally: tallySchema.optional(),
    findings: z.array(findingSchema),
    target: targetSchema.optional(),
    incomplete: incompleteSchema.optional(),
  })
  .superRefine((output, ctx) => {
    // Consistency rule (engine-locked): a provided tally must agree with the
    // top-level verdict (validateMstarReviewV1 review.verdict-tally-mismatch).
    if (output.tally !== undefined && output.tally.verdict !== output.verdict) {
      ctx.addIssue({ code: "custom", message: "tally.verdict must equal the top-level verdict" });
    }
    const top = output.incomplete;
    const echo = output.tally?.incomplete;
    // Tally-level presence rule (engine-locked, checkProvidedTallyShape): a
    // provided tally's echo is required exactly by the `incomplete` tally
    // verdict (review.missing-incomplete / review.incomplete-unexpected).
    if (output.tally !== undefined) {
      if (output.tally.verdict === "incomplete") {
        if (echo === undefined) {
          ctx.addIssue({
            code: "custom",
            message: 'tally.verdict "incomplete" requires the matching tally.incomplete fact (reason + unscanned)',
          });
        }
      } else if (echo !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `tally.incomplete is carried only by the "incomplete" tally verdict - tally.verdict is "${output.tally.verdict}"`,
        });
      }
    }
    // Envelope-level presence rule (engine-locked): the incomplete fact is
    // required exactly by the `incomplete` verdict and rejected for every other
    // verdict (review.missing-incomplete / review.incomplete-unexpected).
    if (output.verdict === "incomplete") {
      if (top === undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'verdict "incomplete" requires an incomplete fact (reason + unscanned)',
        });
      }
    } else if (top !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `incomplete is carried only by the "incomplete" verdict - verdict is "${output.verdict}"`,
      });
    }
    // The tally echoes the envelope fact when both carry it; the two must agree
    // (review.incomplete-tally-mismatch).
    if (
      top !== undefined &&
      echo !== undefined &&
      (top.reason !== echo.reason ||
        top.unscanned.length !== echo.unscanned.length ||
        top.unscanned.some((entry, index) => entry !== echo.unscanned[index]))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "tally.incomplete must match the top-level incomplete fact",
      });
    }
  });

/**
 * Cap on findings per review (Phase 5 B4): 50. The GitHub review body and
 * the D1 findings write both have practical limits; beyond that the
 * highest-priority findings are kept and the rest are omitted (body footer
 * notes the count). Priority: must-fix > should-fix > nit; ties keep their
 * original order (stable sort).
 */
export const FINDINGS_MAX = 50;

const MERGE_CLASS_RANK: Record<MergeClass, number> = {
  "must-fix": 0,
  "should-fix": 1,
  nit: 2,
};

/**
 * Merge-class-priority cap on a ReviewOutput's findings (stable within a
 * class). Returns the capped output plus the number of omitted findings; a
 * within-limit input is returned unchanged with omitted = 0.
 */
export function capFindings(
  output: ReviewOutput,
  limit: number = FINDINGS_MAX,
): { output: ReviewOutput; omitted: number } {
  if (output.findings.length <= limit) {
    return { output, omitted: 0 };
  }
  const findings = [...output.findings]
    .sort((a, b) => MERGE_CLASS_RANK[a.mergeClass] - MERGE_CLASS_RANK[b.mergeClass])
    .slice(0, limit);
  return { output: { ...output, findings }, omitted: output.findings.length - limit };
}

/**
 * Per-finding size budgets (qc2 F-003): title/body are non-empty only in
 * the schema — a single multi-megabyte body would blow the GitHub comment
 * limit (65536 chars) and the D1 findings write AFTER the container model
 * work is already paid. Char-based, mirroring truncateSummary: over-budget
 * text is truncated with an ellipsis at the choke point (consumer step 10,
 * before postReview/put), never rejected — a degraded finding beats a lost
 * review. The assembled comment carries its own final ceiling
 * (REVIEW_BODY_LIMIT, comment.ts).
 */
export const FINDING_TITLE_MAX = 200;
export const FINDING_BODY_MAX = 2000;
/**
 * S-1 / qc2 F-002: `fingerprint_hint` is clamped at the SAME choke
 * point with FINDING_TITLE_MAX semantics — the hint feeds the D1
 * `findings.fingerprint` index column verbatim, so an unbounded hint would
 * blow the column budget. Over-budget hints are truncated like titles; a
 * clamped hint that still equals the redaction marker is then normalized
  * away by computeFindingFingerprint (W-1).
 */
 /**
 * Clamp every finding's title/body/fingerprint_hint to the budgets above; a
 * fully within-budget output is returned unchanged (same reference).
 */
export function clampFindingSizes(output: ReviewOutput): ReviewOutput {
  const oversized = output.findings.some(
    (finding) =>
      finding.title.length > FINDING_TITLE_MAX ||
      finding.body.length > FINDING_BODY_MAX ||
      (finding.fingerprint_hint?.length ?? 0) > FINDING_TITLE_MAX,
  );
  if (!oversized) {
    return output;
  }
  return {
    ...output,
    findings: output.findings.map((finding) => ({
      ...finding,
      title:
        finding.title.length <= FINDING_TITLE_MAX
          ? finding.title
          : `${finding.title.slice(0, FINDING_TITLE_MAX - 1)}…`,
      body:
        finding.body.length <= FINDING_BODY_MAX
          ? finding.body
          : `${finding.body.slice(0, FINDING_BODY_MAX - 1)}…`,
      fingerprint_hint:
        finding.fingerprint_hint !== undefined && finding.fingerprint_hint.length > FINDING_TITLE_MAX
          ? `${finding.fingerprint_hint.slice(0, FINDING_TITLE_MAX - 1)}…`
          : finding.fingerprint_hint,
    })),
  };
}

/** Extract the first ```json fenced block, or null. */
function extractJsonFence(text: string): string | null {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  return match ? match[1]!.trim() : null;
}

/** Extract the first bare ``` fenced block (no language tag), or null. */
function extractBareFence(text: string): string | null {
  const match = text.match(/```(?![A-Za-z0-9])\s*([\s\S]*?)```/);
  return match ? match[1]!.trim() : null;
}

/** Extract the first ```json / bare ``` fenced block, or null. */
function extractFenced(text: string): string | null {
  const json = extractJsonFence(text);
  if (json !== null) return json;
  return extractBareFence(text);
}

/** Extract the first `{` … last `}` span, or null. */
function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Parse raw runner stdout into a validated `mstar.review/v1` envelope.
 *
 * Algorithm (unchanged transport decoding): trim → JSON.parse whole → fall
 * back to the fenced ```json / ``` block → fall back to first `{` … last `}`
 * → validate. Fallback extraction only runs when JSON.parse throws; the
 * FIRST successful parse is validated once and that result is returned — a
 * parsed non-object root (e.g. an array) is rejected without inner-object
 * recovery. Checks run in this order, and the first failure wins: the
 * top-level M1 `severity` ban → the engine `validateMstarReviewV1` gate →
 * `findUnknownFindingKey` → zod (int line numbers, tally consistency,
 * incomplete presence/agreement). The severity ban runs BEFORE the gate so a
 * top-level M1 key keeps `review.inspector-vocab` instead of the engine's
 * generic unknown-key report; the gate itself fails findings[].severity with
 * that same vocab code and refuses unknown envelope/tally keys with
 * `review.unknown-key`; the finding-key check runs AFTER the gate so it
 * cannot mask that code, and refuses unknown finding keys with the same code
 * instead of dropping them silently.
 * Any failure returns `{ ok: false, error }` and never throws. An
 * M1-shaped document (no `schema` literal, M1 verdict/severity vocab) fails
 * here — it is never posted or persisted.
 */
export function parseReviewOutput(
  raw: string,
): { ok: true; output: ReviewOutput } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "empty input" };

  const candidates: string[] = [text];
  const fenced = extractFenced(text);
  if (fenced !== null) candidates.push(fenced);
  const braces = extractBraces(text);
  if (braces !== null) candidates.push(braces);

  let lastError = "not valid ReviewOutput JSON";
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    // A stray M1 `severity` key must fail with its specific vocab code, never
    // fall through to zod or the engine's generic unknown-key report. The
    // engine gate fails findings[].severity itself; the top-level key is
    // checked here first so it keeps `review.inspector-vocab` too.
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      if ((parsed as Record<string, unknown>).severity !== undefined) {
        return {
          ok: false,
          error:
            'review.inspector-vocab: review document carries inspector M1 field "severity" - ' +
            `harness merge classes are ${JSON.stringify(MERGE_CLASSES)}; use verdict + findings[].mergeClass`,
        };
      }
    }
    const gate = validateMstarReviewV1(parsed);
    if (!gate.ok) {
      return {
        ok: false,
        error: gate.violations.map((v) => `${v.code}: ${v.message}`).join("; "),
      };
    }
    // Runs after the engine gate so findings[].severity keeps its specific
    // `review.inspector-vocab` code rather than the generic unknown-key one.
    const unknownFindingKey = findUnknownFindingKey(parsed);
    if (unknownFindingKey !== null) {
      return {
        ok: false,
        error:
          `review.unknown-key: unknown key "${unknownFindingKey}" is not part of a review finding - ` +
          `accepted keys: ${[...FINDING_KEYS].join(", ")}`,
      };
    }
    const result = outputSchema.safeParse(parsed);
    return result.success
      ? { ok: true, output: result.data }
      : { ok: false, error: result.error.message };
  }
  return { ok: false, error: lastError };
}
