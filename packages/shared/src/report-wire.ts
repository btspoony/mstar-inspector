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
 *   - The seat yields exactly `{schema, overview, linkedIssueAc, verified,
 *     rejected, planToFix}` — no extra keys, every value a string.
 *   - Every field is REQUIRED and must be non-blank; the template's "write
 *     `none`, never delete the heading" rule is the seat's, not the
 *     validator's: an empty field is a lost document, never an empty section.
 *   - Each field carries its own character budget; an over-budget field fails
 *     the whole document instead of being silently truncated mid-sentence.
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

/**
 * Byte bound of the report file read (and of the runner's write, enforced by
 * the same bounded-read protocol the recheck documents use). The per-field
 * budgets below keep a valid document far under it; the bound exists so a
 * runaway seat cannot stream unbounded text into the Worker.
 */
export const REPORT_FILE_MAX_BYTES = 65_536;

/** Per-field character budgets — a document over any of them is rejected. */
export const REPORT_FIELD_MAX_CHARS = {
  overview: 1_500,
  linkedIssueAc: 3_000,
  verified: 3_000,
  rejected: 3_000,
  planToFix: 6_000,
} as const;

/** The consumer's prContext bounds (see `capturePrContext`). */
export const PR_CONTEXT_MAX_ISSUES = 3;
export const PR_CONTEXT_MAX_CHARS = 4_000;

const FIELDS = ["overview", "linkedIssueAc", "verified", "rejected", "planToFix"] as const;

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
  const expected = [...FIELDS, "schema"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return { ok: false, error: `keys must be exactly {${expected.join(", ")}}, got {${keys.join(", ")}}` };
  }
  if (record["schema"] !== "mstar.report/v1") {
    return { ok: false, error: `schema must be "mstar.report/v1", got ${JSON.stringify(record["schema"])}` };
  }
  const doc = { schema: "mstar.report/v1" } as ReportDoc;
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
  return { ok: true, doc };
}
