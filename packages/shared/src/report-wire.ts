
/** The PR facts the report seat may read (worker-captured, untrusted text). */
export type PrContext = {
  prBody: string;
  issues: { number: number; title: string; body: string }[];
};

/** The narrative sections, in template order. */
export type ReportDoc = {
  schema: "mstar.report/v1";
  headSha: string;
  overview: string;
  linkedIssueAc: string;
  verified: string;
  rejected: string;
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

const REPORT_TOTAL_FIELD_CHARS = Object.values(REPORT_FIELD_MAX_CHARS).reduce(
  (total, chars) => total + chars,
  0,
);

const REPORT_MAX_BYTES_PER_CHAR = 6;

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

const HEAD_SHA_RE = /^[0-9a-f]{7,64}$/;

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
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return { ok: false, error: `keys must be exactly {${expected.join(", ")}}` };
  }
  if (record["schema"] !== "mstar.report/v1") {
    return { ok: false, error: `schema must be "mstar.report/v1"` };
  }
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
  const bytes = UTF8.encode(JSON.stringify(doc)).byteLength;
  if (bytes > REPORT_FILE_MAX_BYTES) {
    return {
      ok: false,
      error: `document is ${bytes} bytes, over the ${REPORT_FILE_MAX_BYTES}-byte file bound`,
    };
  }
  return { ok: true, doc };
}
