/**
 * Typed report wire format + fail-closed validator (mstar.report/v1).
 *
 * The envelope (`mstar.review/v1`) is engine-owned and rejects unknown keys, so
 * the narrative sections a human report needs — overview, linked-issue
 * acceptance criteria, verified checks, considered-and-rejected leads, fix plan
 * — cannot ride it. They ride this SIDE document instead: the runner writes it
 * to a fixed in-image path, the Worker reads it back through the audited
 * bounded read (`src/pipeline/gitops.ts` `readReportCommand`) and validates it
 * against THIS module before any of it reaches a public body.
 *
 * Contract shape (both directions):
 *   - The FILE carries exactly `{schema, headSha, overview, linkedIssueAc,
 *     verified, rejected, planToFix}` — no extra keys, every value a string.
 *     The seat yields the six narrative keys only: `headSha` is bound by the
 *     runner from the engine-owned envelope (`target.head_sha`), never from a
 *     model field, so a document left in the container by an earlier run can
 *     never speak for the current review.
 *   - Every field is REQUIRED and must be non-blank; the template's "write
 *     `none`, never delete the heading" rule is the seat's, not the
 *     validator's: an empty field is a lost document, never an empty section.
 *   - Each field carries its own character budget; an over-budget field fails
 *     the whole document instead of being silently truncated mid-sentence.
 *   - The serialized document must also fit `REPORT_FILE_MAX_BYTES`, which is
 *     DERIVED from those character budgets at JSON's worst-case escape cost, so
 *     the two bounds agree by construction: every document the validator
 *     accepts also fits the file the reader bounds. The check still runs so an
 *     over-bound document fails with its reason instead of being lost to an
 *     opaque read overflow.
 *
 * Dependency-free (like `recheck-wire.ts`): the Worker, the runner and the
 * tests all import this module.
 */

/** The PR facts the report seat may read (worker-captured, untrusted text). */
export type PrContext = {
  /** The pull request description as GitHub returns it (may be empty). */
  prBody: string;
  /** Closing/mentioned issues, already bounded and capped by the consumer. */
  issues: { number: number; title: string; body: string }[];
};

/** The narrative sections, in template order. */
export type ReportDoc = {
  schema: "mstar.report/v1";
  /**
   * The reviewed head, written by the runner from the envelope's
   * `target.head_sha`. The consumer rejects a document bound to another head:
   * the path is fixed, so a skipped seat leaves the PREVIOUS run's file there.
   */
  headSha: string;
  /** 2–3 sentences on what the PR does. */
  overview: string;
  /** Per-criterion met/unmet/cut notes for the linked issues. */
  linkedIssueAc: string;
  /** The checks actually run and what they showed. */
  verified: string;
  /** Leads investigated and rejected, one bullet each. */
  rejected: string;
  /** Ordered fix plan (markdown), rendered in a collapsible block. */
  planToFix: string;
};

/** Fixed in-image path the runner writes the report to (`--report-out`). */
export const REPORT_OUTPUT_PATH = "/tmp/mstar-report.json";

/** Per-field character budgets — a document over any of them is rejected. */
export const REPORT_FIELD_MAX_CHARS = {
  overview: 1_500,
  linkedIssueAc: 3_000,
  verified: 3_000,
  rejected: 3_000,
  planToFix: 6_000,
} as const;

/** Every field's budget summed: 16,500 characters for a fully budgeted document. */
const REPORT_TOTAL_FIELD_CHARS = Object.values(REPORT_FIELD_MAX_CHARS).reduce(
  (total, chars) => total + chars,
  0,
);

/**
 * Worst-case serialized cost of ONE character: every field is a JSON string,
 * and JSON escapes a control character (or a lone surrogate) to `\uXXXX` —
 * six ASCII bytes per UTF-16 unit. No in-budget document can cost more.
 */
const REPORT_MAX_BYTES_PER_CHAR = 6;

/**
 * Keys, quotes, separators, the schema tag and a 64-character `headSha` —
 * ~180 bytes for the exact key set, so this is provable slack.
 */
const REPORT_JSON_HEADROOM_BYTES = 256;

/**
 * Byte bound of the report file read (and of the runner's write, enforced by
 * the same bounded-read protocol the recheck documents use).
 *
 * DERIVED from the field budgets, never a round number: a document that
 * honours every per-field character budget serializes to at most
 * `6 × 16,500 + 256` = 99,256 bytes, so this bound PROVABLY accepts every
 * document `validateReportDoc` accepts, while still stopping a runaway seat
 * from streaming unbounded text into the Worker. `readReportCommand` and the
 * gate below take THIS constant, so the reader and the gate cannot drift.
 */
export const REPORT_FILE_MAX_BYTES =
  REPORT_MAX_BYTES_PER_CHAR * REPORT_TOTAL_FIELD_CHARS + REPORT_JSON_HEADROOM_BYTES;

/** The consumer's prContext bounds (see `capturePrContext`). */
export const PR_CONTEXT_MAX_ISSUES = 3;
export const PR_CONTEXT_MAX_CHARS = 4_000;

const FIELDS = ["overview", "linkedIssueAc", "verified", "rejected", "planToFix"] as const;

/**
 * A git object name, the same shape the runner's `head <sha>` recon fact
 * accepts (`runtime-omp.ts` `HEAD_FACT_RE`). Short shas are legitimate
 * (`7`), full ones are `40`/`64`.
 */
const HEAD_SHA_RE = /^[0-9a-f]{7,64}$/;

/** No Node Buffer in this module — it is imported by the Worker. */
const UTF8 = new TextEncoder();

export type ReportGateResult = { ok: true; doc: ReportDoc } | { ok: false; error: string };

/**
 * Validate one seat-written report document. Document-level distrust: a
 * non-object, a foreign schema tag, an unknown/missing key, a non-string value,
 * a blank value or a value over its field budget rejects the WHOLE document —
 * the caller then renders `none` under every heading rather than a half-filled
 * report that silently drops what the seat actually said.
 */
export function validateReportDoc(value: unknown): ReportGateResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "document is not an object" };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...FIELDS, "headSha", "schema"].sort();
  // Every reason below names only the shape this module REQUIRES. The received
  // keys and values are seat-authored text (a model echoing a PR body), and the
  // callers log these reasons, so echoing them would put attacker-controlled
  // text into a structured-log field.
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return { ok: false, error: `keys must be exactly {${expected.join(", ")}}` };
  }
  if (record["schema"] !== "mstar.report/v1") {
    return { ok: false, error: `schema must be "mstar.report/v1"` };
  }
  // Shape only — WHETHER this is the reviewed head is the consumer's check
  // (it holds the authoritative checked-out sha). A value that is not a git
  // object name can never match one, so it fails here with its own reason.
  const headSha = record["headSha"];
  if (typeof headSha !== "string" || !HEAD_SHA_RE.test(headSha)) {
    return { ok: false, error: "headSha must be 7-64 lowercase hex characters" };
  }
  const doc = { schema: "mstar.report/v1", headSha } as ReportDoc;
  for (const field of FIELDS) {
    const raw = record[field];
    if (typeof raw !== "string") {
      return { ok: false, error: `${field} must be a string` };
    }
    if (raw.trim() === "") {
      return { ok: false, error: `${field} must not be blank (write "none" instead)` };
    }
    if (raw.length > REPORT_FIELD_MAX_CHARS[field]) {
      return {
        ok: false,
        error: `${field} is ${raw.length} chars, over its ${REPORT_FIELD_MAX_CHARS[field]}-char budget`,
      };
    }
    doc[field] = raw;
  }
  // The read bounds the FILE in bytes; the budgets above bound CHARACTERS, and
  // `REPORT_FILE_MAX_BYTES` is derived from them at JSON's worst-case escape
  // cost, so an in-budget document can never outgrow the read. The check stays
  // as the gate's half of that contract: if the two constants ever drift, the
  // document fails HERE with a reportable reason instead of disappearing into
  // an opaque read overflow.
  const bytes = UTF8.encode(JSON.stringify(doc)).byteLength;
  if (bytes > REPORT_FILE_MAX_BYTES) {
    return {
      ok: false,
      error: `document is ${bytes} bytes, over the ${REPORT_FILE_MAX_BYTES}-byte file bound`,
    };
  }
  return { ok: true, doc };
}
