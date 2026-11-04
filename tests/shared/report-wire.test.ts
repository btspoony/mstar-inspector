/**
 * mstar.report/v1 wire validation — the fail-closed gate between the report
 * seat's model output and a public review body.
 *
 * The contract under test: exactly the six document keys, every value a
 * non-blank string, each value inside its own character budget. Anything else
 * rejects the WHOLE document, so the caller renders `none` headings instead of
 * publishing a half-filled report.
 */
import { describe, expect, test } from "bun:test";

import {
  REPORT_FIELD_MAX_CHARS,
  REPORT_FILE_MAX_BYTES,
  REPORT_OUTPUT_PATH,
  validateReportDoc,
  type ReportDoc,
} from "../../packages/shared/src/report-wire";

const DOC: ReportDoc = {
  schema: "mstar.report/v1",
  overview: "Adds an expiry guard.",
  linkedIssueAc: "Expiry rejected: met.",
  verified: "- suite → green",
  rejected: "none",
  planToFix: "none",
};

describe("validateReportDoc", () => {
  test("accepts a complete document and returns it verbatim", () => {
    const gate = validateReportDoc(DOC);
    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error(gate.error);
    expect(gate.doc).toEqual(DOC);
  });

  const nonDocuments: Array<[string, unknown]> = [
    ["null", null],
    ["an array", []],
    ["a string", "not a document"],
    ["a number", 7],
  ];
  for (const [name, value] of nonDocuments) {
    test(`rejects ${name} at the document level`, () => {
      const gate = validateReportDoc(value);
      expect(gate.ok).toBe(false);
      if (gate.ok) throw new Error("expected failure");
      expect(gate.error).toContain("not an object");
    });
  }

  test("rejects a foreign schema tag", () => {
    const gate = validateReportDoc({ ...DOC, schema: "mstar.review/v1" });
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("expected failure");
    expect(gate.error).toContain("schema must be");
  });

  test("rejects a missing key and an unknown key (exactly six keys)", () => {
    const { rejected: _omit, ...missing } = DOC;
    const missingGate = validateReportDoc(missing);
    expect(missingGate.ok).toBe(false);
    if (missingGate.ok) throw new Error("expected failure");
    expect(missingGate.error).toContain("keys must be exactly");

    const extraGate = validateReportDoc({ ...DOC, extra: "x", note: "y" });
    expect(extraGate.ok).toBe(false);
  });

  for (const field of ["overview", "linkedIssueAc", "verified", "rejected", "planToFix"] as const) {
    test(`rejects a non-string, blank and over-budget \`${field}\``, () => {
      expect(validateReportDoc({ ...DOC, [field]: 7 }).ok).toBe(false);
      expect(validateReportDoc({ ...DOC, [field]: "" }).ok).toBe(false);
      // Whitespace-only is blank: the template's rule is "write none", so an
      // empty section is a lost document, not an empty heading.
      expect(validateReportDoc({ ...DOC, [field]: "   \n " }).ok).toBe(false);
      expect(
        validateReportDoc({ ...DOC, [field]: "x".repeat(REPORT_FIELD_MAX_CHARS[field] + 1) }).ok,
      ).toBe(false);
      // Exactly at the budget is accepted (boundary, not off-by-one).
      expect(validateReportDoc({ ...DOC, [field]: "x".repeat(REPORT_FIELD_MAX_CHARS[field]) }).ok).toBe(true);
    });
  }

  test("the fixed path and the read bound stay in sync with a valid document", () => {
    // A maximal valid document must fit the byte bound the read enforces.
    const maximal = {
      ...DOC,
      ...Object.fromEntries(
        (Object.keys(REPORT_FIELD_MAX_CHARS) as Array<keyof typeof REPORT_FIELD_MAX_CHARS>).map((field) => [
          field,
          "x".repeat(REPORT_FIELD_MAX_CHARS[field]),
        ]),
      ),
    };
    expect(Buffer.byteLength(JSON.stringify(maximal))).toBeLessThan(REPORT_FILE_MAX_BYTES);
    expect(REPORT_OUTPUT_PATH.startsWith("/tmp/")).toBe(true);
  });
});
