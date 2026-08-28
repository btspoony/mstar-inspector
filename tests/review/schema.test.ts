/**
 * Unit tests for the mstar.review/v1 envelope schema (plan 07 Task 3).
 *
 * Contract under test (specs/github-review-comment-mapping.md §1 + the
 * engine `validateMstarReviewV1` mirror in src/review/schema.ts):
 *   parseReviewOutput(raw) → { ok: true, output: ReviewOutput } | { ok: false, error: string }
 * - verdict vocab is ship it | needs fixes | blocked; M1 verdicts
 *   (comment | request_changes | approve) are REJECTED on the write path
 * - findings[].mergeClass is must-fix | should-fix | nit; M1 severities
 *   (critical | warning | suggestion | info) are rejected as mergeClass
 * - the `schema: "mstar.review/v1"` literal is required (M1 documents,
 *   which lack it, are rejected wholesale)
 * - a provided tally must be a PrTallyResult-shaped object and its verdict
 *   must agree with the top-level verdict (consistency rule)
 * - title/body are required non-empty; category is a free string;
 *   file_path / line_start / line_end are optional and nullable
 * - unknown keys are stripped, not rejected
 * - fenced ```json / bare ``` blocks and first-{..last-} extraction both parse
 * - any failure returns { ok: false } and never throws
 */

import { describe, expect, test } from "bun:test";
import { capFindings, parseReviewOutput, type ReviewOutput } from "../../src/review/schema";
import type { PrTallyResult } from "@mstar-harness/engine";

const VALID: ReviewOutput = {
  schema: "mstar.review/v1",
  verdict: "needs fixes",
  summary_md: "Two issues found in the diff.",
  findings: [
    {
      mergeClass: "should-fix",
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
  test("parses a valid envelope with findings", () => {
    const r = parseReviewOutput(JSON.stringify(VALID));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toEqual(VALID);
    }
  });

  test("parses an empty findings array", () => {
    const r = parseReviewOutput(
      JSON.stringify({
        schema: "mstar.review/v1",
        verdict: "ship it",
        summary_md: "LGTM",
        findings: [],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.verdict).toBe("ship it");
      expect(r.output.findings).toEqual([]);
    }
  });

  test("rejects every M1 verdict on the write path", () => {
    for (const verdict of ["comment", "request_changes", "approve"]) {
      const r = parseReviewOutput(JSON.stringify({ ...VALID, verdict }));
      expect(r.ok).toBe(false);
    }
  });

  test("accepts every harness verdict verbatim", () => {
    for (const verdict of ["ship it", "needs fixes", "blocked"] as const) {
      const r = parseReviewOutput(JSON.stringify({ ...VALID, verdict }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.output.verdict).toBe(verdict);
      }
    }
  });

  test("rejects M1 severities as mergeClass values", () => {
    for (const mergeClass of ["critical", "warning", "suggestion", "info"]) {
      const r = parseReviewOutput(
        JSON.stringify({ ...VALID, findings: [{ ...VALID.findings[0]!, mergeClass }] }),
      );
      expect(r.ok).toBe(false);
    }
  });

  test("accepts every merge class verbatim", () => {
    for (const mergeClass of ["must-fix", "should-fix", "nit"] as const) {
      const r = parseReviewOutput(
        JSON.stringify({ ...VALID, findings: [{ ...VALID.findings[0]!, mergeClass }] }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.output.findings[0]!.mergeClass).toBe(mergeClass);
      }
    }
  });

  test("rejects an M1-shaped document missing the schema literal", () => {
    const { schema: _s, ...m1 } = VALID;
    const r = parseReviewOutput(JSON.stringify(m1));
    expect(r.ok).toBe(false);
  });

  test("rejects a wrong schema literal", () => {
    const r = parseReviewOutput(JSON.stringify({ ...VALID, schema: "mstar.review/v2" }));
    expect(r.ok).toBe(false);
  });

  test("parses JSON inside a ```json fenced block", () => {
    const raw = "Here is the review:\n```json\n" + JSON.stringify(VALID) + "\n```\n";
    const r = parseReviewOutput(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toEqual(VALID);
    }
  });

  test("parses JSON inside a plain ``` fenced block", () => {
    const raw = "```\n" + JSON.stringify(VALID) + "\n```";
    const r = parseReviewOutput(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toEqual(VALID);
    }
  });

  test("parses JSON extracted from first { to last }", () => {
    const raw = "prefix text " + JSON.stringify(VALID) + " suffix text";
    const r = parseReviewOutput(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toEqual(VALID);
    }
  });

  test("does not treat a ```ts fence as a fenced block", () => {
    const other = { ...VALID, verdict: "ship it", summary_md: "x" };
    const raw = "```ts\n" + JSON.stringify(VALID) + "\n```\n" + JSON.stringify(other);
    const r = parseReviewOutput(raw);
    expect(r.ok).toBe(false);
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

  test("accepts findings without the optional location keys", () => {
    const r = parseReviewOutput(
      JSON.stringify({
        schema: "mstar.review/v1",
        verdict: "blocked",
        summary_md: "ok",
        findings: [{ mergeClass: "must-fix", title: "note", body: "no location" }],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.findings[0]!.file_path).toBeUndefined();
    }
  });

  test("accepts explicit null file_path and line numbers", () => {
    const r = parseReviewOutput(
      JSON.stringify({
        schema: "mstar.review/v1",
        verdict: "needs fixes",
        summary_md: "ok",
        findings: [
          {
            mergeClass: "nit",
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

  test("rejects a non-integer line number", () => {
    const bad = { ...VALID, findings: [{ ...VALID.findings[0]!, line_start: 1.5 }] };
    const r = parseReviewOutput(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  test("rejects a whitespace-only summary_md", () => {
    const r = parseReviewOutput(JSON.stringify({ ...VALID, summary_md: "   " }));
    expect(r.ok).toBe(false);
  });

  test("rejects a finding with an empty title or empty body", () => {
    const emptyTitle = parseReviewOutput(
      JSON.stringify({ ...VALID, findings: [{ ...VALID.findings[0]!, title: "" }] }),
    );
    expect(emptyTitle.ok).toBe(false);
    const emptyBody = parseReviewOutput(
      JSON.stringify({ ...VALID, findings: [{ ...VALID.findings[0]!, body: "  " }] }),
    );
    expect(emptyBody.ok).toBe(false);
  });

  test("rejects missing verdict", () => {
    const { verdict: _v, ...rest } = VALID;
    const r = parseReviewOutput(JSON.stringify(rest));
    expect(r.ok).toBe(false);
  });

  test("category is a free string (engine contract), not the M1 enum", () => {
    for (const category of ["security", "docs", "anything-goes"]) {
      const r = parseReviewOutput(
        JSON.stringify({ ...VALID, findings: [{ ...VALID.findings[0]!, category }] }),
      );
      expect(r.ok).toBe(true);
    }
  });

  test("rejects a non-string category", () => {
    const r = parseReviewOutput(
      JSON.stringify({ ...VALID, findings: [{ ...VALID.findings[0]!, category: 3 }] }),
    );
    expect(r.ok).toBe(false);
  });

  test("accepts fingerprint_hint as any string (engine tolerates empty)", () => {
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
      expect(r2.output.findings[0]!.fingerprint_hint).toBe("");
    }
  });

  describe("tally", () => {
    const TALLY: PrTallyResult = {
      verdict: "needs fixes",
      scorePct: 45,
      tally: { mustFix: 0, shouldFix: 2, nit: 1, unverified: 1 },
      chatHeader: "**needs fixes** · 45%\n🔴 0 🟠 2 🔵 1 ❓ 1",
    };

    test("accepts an envelope with a well-formed tally", () => {
      const r = parseReviewOutput(JSON.stringify({ ...VALID, tally: TALLY }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.output.tally).toEqual(TALLY);
      }
    });

    test("accepts an envelope without a tally (optional)", () => {
      const r = parseReviewOutput(JSON.stringify(VALID));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.output.tally).toBeUndefined();
      }
    });

    test("rejects a tally whose verdict disagrees with the top-level verdict", () => {
      const r = parseReviewOutput(JSON.stringify({ ...VALID, tally: { ...TALLY, verdict: "ship it" } }));
      expect(r.ok).toBe(false);
    });

    test("rejects a malformed tally (scorePct out of range, missing chatHeader)", () => {
      const badScore = parseReviewOutput(
        JSON.stringify({ ...VALID, tally: { ...TALLY, scorePct: 101 } }),
      );
      expect(badScore.ok).toBe(false);
      const { chatHeader: _c, ...noHeader } = TALLY;
      const badShape = parseReviewOutput(JSON.stringify({ ...VALID, tally: noHeader }));
      expect(badShape.ok).toBe(false);
    });
  });

  test("rejects non-JSON input", () => {
    const r = parseReviewOutput("this is not json at all");
    expect(r.ok).toBe(false);
  });

  test("rejects a JSON array at the root", () => {
    const r = parseReviewOutput("[1, 2, 3]");
    expect(r.ok).toBe(false);
  });

  test("rejects a JSON array wrapping a valid envelope", () => {
    const r = parseReviewOutput(JSON.stringify([VALID]));
    expect(r.ok).toBe(false);
  });

  test("never throws and returns ok:false on malformed input", () => {
    const inputs = [
      "",
      "   ",
      "{",
      "}{",
      '{"verdict": 1}',
      '{"schema": "mstar.review/v1"}',
      "null",
      "undefined",
      "```json\n{broken\n```",
    ];
    for (const raw of inputs) {
      const r = parseReviewOutput(raw);
      expect(r.ok).toBe(false);
    }
  });
});

describe("capFindings (Phase 5 B4, merge-class priority)", () => {
  const base: ReviewOutput = {
    schema: "mstar.review/v1",
    verdict: "needs fixes",
    summary_md: "x",
    findings: [],
  };

  function finding(mergeClass: "must-fix" | "should-fix" | "nit", title: string) {
    return {
      mergeClass,
      file_path: "f.ts",
      line_start: 1,
      line_end: 1,
      title,
      body: "b",
    };
  }

  test("returns the input unchanged with omitted=0 when within the cap", () => {
    const output = { ...base, findings: [finding("nit", "a"), finding("should-fix", "b")] };
    const { output: out, omitted } = capFindings(output);
    expect(out).toBe(output); // same reference, no copy
    expect(omitted).toBe(0);
  });

  test("caps to FINDINGS_MAX and reports the omitted count", () => {
    const findings = Array.from({ length: 60 }, (_, i) => finding("nit", `F${i}`));
    const { output, omitted } = capFindings({ ...base, findings });
    expect(output.findings).toHaveLength(50);
    expect(omitted).toBe(10);
  });

  test("keeps the highest-priority findings first, ties in original order (stable)", () => {
    const findings = Array.from({ length: 60 }, (_, i) => finding("nit", `F${i}`));
    findings[0]!.mergeClass = "must-fix";
    findings[59]!.mergeClass = "must-fix";
    findings[58]!.mergeClass = "should-fix";
    const { output } = capFindings({ ...base, findings });
    expect(output.findings[0]!.title).toBe("F0");
    expect(output.findings[1]!.title).toBe("F59");
    expect(output.findings[2]!.title).toBe("F58");
    expect(output.findings[2]!.mergeClass).toBe("should-fix");
    expect(output.findings.slice(3).every((f) => f.mergeClass === "nit")).toBe(true);
  });

  test("never returns more than the limit even with all must-fix findings", () => {
    const findings = Array.from({ length: 60 }, (_, i) => finding("must-fix", `C${i}`));
    const { output, omitted } = capFindings({ ...base, findings });
    expect(output.findings).toHaveLength(50);
    expect(omitted).toBe(10);
  });
});
