/**
 * Unit tests for the review output schema (plan 02 Task 1).
 *
 * Contract under test (plan Module contracts + iteration spec findings-schema.md):
 *   parseReviewOutput(raw) → { ok: true, output: ReviewOutput } | { ok: false, error: string }
 * - severity enum is critical | warning | suggestion | info (NOT the residual enum)
 * - unknown keys are stripped, not rejected
 * - file_path / line_start / line_end keys are REQUIRED but nullable
 * - fenced ```json blocks and first-{..last-} extraction both parse
 * - any failure returns { ok: false } and never throws
 */

import { describe, expect, test } from "bun:test";
import { parseReviewOutput } from "../../src/review/schema";

const VALID = {
  verdict: "comment",
  summary_md: "No blocking issues.",
  findings: [
    {
      severity: "warning",
      category: "logic",
      file_path: "src/server.ts",
      line_start: 12,
      line_end: 14,
      title: "Null deref risk",
      body: "`user` may be null here.",
    },
  ],
};

describe("parseReviewOutput", () => {
  test("parses a valid ReviewOutput with findings", () => {
    const r = parseReviewOutput(JSON.stringify(VALID));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.verdict).toBe("comment");
      expect(r.output.findings).toHaveLength(1);
      expect(r.output.findings[0]!.severity).toBe("warning");
    }
  });

  test("parses an empty findings array", () => {
    const r = parseReviewOutput(
      JSON.stringify({ verdict: "approve", summary_md: "LGTM", findings: [] }),
    );
    expect(r.ok).toBe(true);
  });

  test("parses JSON inside a ```json fenced block", () => {
    const raw = "Here is the review:\n```json\n" + JSON.stringify(VALID) + "\n```\n";
    const r = parseReviewOutput(raw);
    expect(r.ok).toBe(true);
  });

  test("parses JSON inside a plain ``` fenced block", () => {
    const raw = "```\n" + JSON.stringify(VALID) + "\n```";
    const r = parseReviewOutput(raw);
    expect(r.ok).toBe(true);
  });

  test("parses JSON extracted from first { to last }", () => {
    const raw = "prefix text " + JSON.stringify(VALID) + " suffix text";
    const r = parseReviewOutput(raw);
    expect(r.ok).toBe(true);
  });

  test("strips unknown keys instead of failing", () => {
    const withExtra = {
      ...VALID,
      extra_root: 1,
      findings: [{ ...VALID.findings[0]!, extra: "x" }],
    };
    const r = parseReviewOutput(JSON.stringify(withExtra));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect("extra_root" in r.output).toBe(false);
      expect("extra" in r.output.findings[0]!).toBe(false);
    }
  });

  test("accepts null file_path and line numbers", () => {
    const r = parseReviewOutput(
      JSON.stringify({
        verdict: "comment",
        summary_md: "ok",
        findings: [
          {
            severity: "info",
            category: "other",
            file_path: null,
            line_start: null,
            line_end: null,
            title: "note",
            body: "no location",
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  test("rejects a finding missing the required file_path key", () => {
    const { file_path: _fp, ...rest } = VALID.findings[0]!;
    const r = parseReviewOutput(
      JSON.stringify({ verdict: "comment", summary_md: "ok", findings: [rest] }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects a non-integer line number", () => {
    const bad = { ...VALID, findings: [{ ...VALID.findings[0]!, line_start: 1.5 }] };
    const r = parseReviewOutput(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  test("rejects missing verdict", () => {
    const { verdict: _v, ...rest } = VALID;
    const r = parseReviewOutput(JSON.stringify(rest));
    expect(r.ok).toBe(false);
  });

  test("rejects an invalid verdict", () => {
    const r = parseReviewOutput(JSON.stringify({ ...VALID, verdict: "merge" }));
    expect(r.ok).toBe(false);
  });

  test("rejects residual severities high and nit", () => {
    for (const severity of ["high", "nit"]) {
      const r = parseReviewOutput(
        JSON.stringify({ ...VALID, findings: [{ ...VALID.findings[0]!, severity }] }),
      );
      expect(r.ok).toBe(false);
    }
  });

  test("rejects residual severities medium and low", () => {
    for (const severity of ["medium", "low"]) {
      const r = parseReviewOutput(
        JSON.stringify({ ...VALID, findings: [{ ...VALID.findings[0]!, severity }] }),
      );
      expect(r.ok).toBe(false);
    }
  });

  test("rejects an invalid category", () => {
    const r = parseReviewOutput(
      JSON.stringify({ ...VALID, findings: [{ ...VALID.findings[0]!, category: "docs" }] }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects non-JSON input", () => {
    const r = parseReviewOutput("this is not json at all");
    expect(r.ok).toBe(false);
  });

  test("rejects a JSON array at the root", () => {
    const r = parseReviewOutput("[1, 2, 3]");
    expect(r.ok).toBe(false);
  });

  test("rejects an empty summary_md in structured mode", () => {
    const r = parseReviewOutput(JSON.stringify({ ...VALID, summary_md: "" }));
    expect(r.ok).toBe(false);
  });

  test("accepts empty title and body (model variance tolerated)", () => {
    const r = parseReviewOutput(
      JSON.stringify({
        verdict: "comment",
        summary_md: "ok",
        findings: [{ ...VALID.findings[0]!, title: "", body: "" }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  test("accepts fingerprint_hint and strips an empty one", () => {
    const withHint = {
      ...VALID,
      findings: [{ ...VALID.findings[0]!, fingerprint_hint: "abc-123" }],
    };
    const r = parseReviewOutput(JSON.stringify(withHint));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.findings[0]!.fingerprint_hint).toBe("abc-123");
    }

    const withEmptyHint = {
      ...VALID,
      findings: [{ ...VALID.findings[0]!, fingerprint_hint: "" }],
    };
    const r2 = parseReviewOutput(JSON.stringify(withEmptyHint));
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect("fingerprint_hint" in r2.output.findings[0]!).toBe(false);
    }
  });

  test("never throws on malformed input", () => {
    const inputs = [
      "",
      "   ",
      "{",
      "}{",
      '{"verdict": 1}',
      "null",
      "undefined",
      "```json\n{broken\n```",
    ];
    for (const raw of inputs) {
      expect(() => parseReviewOutput(raw)).not.toThrow();
    }
  });
});
