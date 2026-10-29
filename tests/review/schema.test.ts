/**
 * Unit tests for the mstar.review/v1 envelope schema.
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
 * - the envelope is CLOSED (engine 4.1.2): an unknown top-level key or an
 *   unknown finding key is REJECTED with `review.unknown-key` — EXCEPT a
 *   residual M1 `severity` key (top-level or per-finding), which keeps its
 *   `review.inspector-vocab` refusal ahead of the generic unknown-key code
 * - fenced ```json / bare ``` blocks and first-{..last-} extraction both parse
 * - any failure returns { ok: false } and never throws
 */

import { describe, expect, test } from "bun:test";
import {
  clampFindingSizes,
  FINDING_BODY_MAX,
  FINDING_TITLE_MAX,
  capFindings,
  parseReviewOutput,
  type ReviewOutput,
} from "../../src/review/schema";
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
  test("rejects a stray M1 severity key on the review document (never stripped)", () => {
    const hybrid = { ...VALID, severity: "critical" };
    const r = parseReviewOutput(JSON.stringify(hybrid));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("review.inspector-vocab");
    }
  });

  test("rejects a stray M1 severity key on a finding (never stripped)", () => {
    const hybrid = {
      ...VALID,
      findings: [{ ...VALID.findings[0]!, severity: "warning" }],
    };
    const r = parseReviewOutput(JSON.stringify(hybrid));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("review.inspector-vocab");
    }
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

  test("rejects an unknown top-level key with review.unknown-key", () => {
    const r = parseReviewOutput(JSON.stringify({ ...VALID, extra_root: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("review.unknown-key");
      expect(r.error).toContain("extra_root");
    }
  });

  test("rejects an unknown finding key with review.unknown-key", () => {
    const r = parseReviewOutput(
      JSON.stringify({ ...VALID, findings: [{ ...VALID.findings[0]!, extra: "x" }] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("review.unknown-key");
      expect(r.error).toContain("findings[0].extra");
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
      // Required since engine 4.0.0; scoreBand(45) === "fail" (< 60 floor).
      band: "fail",
      tally: { mustFix: 0, shouldFix: 2, nit: 1, unverified: 1 },
      chatHeader: "**needs fixes** · 45%\n🔴 0 🟠 2 🔵 1 ❓ 1",
    };

    test("accepts an envelope with a well-formed tally", () => {
      const r = parseReviewOutput(JSON.stringify({ ...VALID, tally: TALLY }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        // The local zod mirror (src/review/schema.ts) does not declare the
        // engine's optional `band`, so it is stripped on parse; compare the
        // fields the mirror round-trips.
        const { band: _band, ...roundTripped } = TALLY;
        expect(r.output.tally).toEqual(roundTripped);
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

  describe("incomplete verdict (four-token vocabulary)", () => {
    const FACT = { reason: "budget exhausted after 3 of 9 files", unscanned: ["src/b.ts", "src/c.ts"] };
    const INCOMPLETE: ReviewOutput = { ...VALID, verdict: "incomplete", incomplete: FACT };
    /** Tally mirror of the incomplete envelope: the fact echoed verbatim. */
    const TALLY = {
      verdict: "incomplete",
      scorePct: 45,
      band: "fail",
      tally: { mustFix: 0, shouldFix: 2, nit: 1, unverified: 1 },
      chatHeader: "**incomplete** · 45%\n🔴 0 🟠 2 🔵 1 ❓ 1",
      incomplete: FACT,
    };

    test("accepts every harness verdict token, including incomplete", () => {
      for (const verdict of ["ship it", "needs fixes", "blocked"] as const) {
        expect(parseReviewOutput(JSON.stringify({ ...VALID, verdict })).ok).toBe(true);
      }
      const r = parseReviewOutput(JSON.stringify(INCOMPLETE));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.output.verdict).toBe("incomplete");
      }
    });

    test("round-trips the incomplete fact (an empty unscanned list is legal)", () => {
      const r = parseReviewOutput(JSON.stringify(INCOMPLETE));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.output).toEqual(INCOMPLETE);
        expect(r.output.incomplete).toEqual(FACT);
      }
      const nothingLeft = { ...INCOMPLETE, incomplete: { reason: FACT.reason, unscanned: [] } };
      const r2 = parseReviewOutput(JSON.stringify(nothingLeft));
      expect(r2.ok).toBe(true);
      if (r2.ok) {
        expect(r2.output.incomplete).toEqual({ reason: FACT.reason, unscanned: [] });
      }
    });

    test("rejects the incomplete verdict without the fact", () => {
      const { incomplete: _i, ...bare } = INCOMPLETE;
      const r = parseReviewOutput(JSON.stringify(bare));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("incomplete");
      }
    });

    test("rejects the fact on a settled verdict", () => {
      for (const verdict of ["ship it", "needs fixes", "blocked"] as const) {
        const r = parseReviewOutput(JSON.stringify({ ...VALID, verdict, incomplete: FACT }));
        expect(r.ok).toBe(false);
      }
    });

    test("rejects a malformed reason or unscanned scope", () => {
      const malformed: unknown[] = [
        { reason: "   ", unscanned: [] },
        { reason: "stopped\nafter one file", unscanned: [] },
        { unscanned: [] },
        { reason: FACT.reason, unscanned: ["ok", ""] },
        { reason: FACT.reason, unscanned: ["a\r\nb"] },
        { reason: FACT.reason, unscanned: "src/a.ts" },
        { reason: FACT.reason, unscanned: [1, 2] },
      ];
      for (const incomplete of malformed) {
        const r = parseReviewOutput(JSON.stringify({ ...INCOMPLETE, incomplete }));
        expect(r.ok).toBe(false);
      }
    });

    test("accepts an agreeing tally echo and rejects a disagreeing one", () => {
      const agreeing = parseReviewOutput(JSON.stringify({ ...INCOMPLETE, tally: TALLY }));
      expect(agreeing.ok).toBe(true);
      if (agreeing.ok) {
        expect(agreeing.output.incomplete).toEqual(FACT);
        expect(agreeing.output.tally!.incomplete).toEqual(FACT);
      }
      const disagreeing = parseReviewOutput(
        JSON.stringify({
          ...INCOMPLETE,
          tally: { ...TALLY, incomplete: { reason: FACT.reason, unscanned: ["src/z.ts"] } },
        }),
      );
      expect(disagreeing.ok).toBe(false);
      if (!disagreeing.ok) {
        expect(disagreeing.error).toContain("incomplete-tally-mismatch");
      }
    });

    test("rejects an incomplete tally that omits its fact", () => {
      const { incomplete: _f, ...noFact } = TALLY;
      const r = parseReviewOutput(JSON.stringify({ ...INCOMPLETE, tally: noFact }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("missing-incomplete");
      }
    });

    test("rejects a settled tally that carries a fact", () => {
      const r = parseReviewOutput(
        JSON.stringify({ ...VALID, tally: { ...TALLY, verdict: "needs fixes" } }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("incomplete-unexpected");
      }
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

describe("clampFindingSizes (qc2 F-003, per-finding byte budgets)", () => {
  const base: ReviewOutput = {
    schema: "mstar.review/v1",
    verdict: "blocked",
    summary_md: "s",
    findings: [],
  };
  const finding = (title: string, body: string): ReviewOutput["findings"][number] => ({
    mergeClass: "nit",
    title,
    body,
  });

  test("within-budget findings pass through unchanged (same reference)", () => {
    const output = { ...base, findings: [finding("t", "b")] };
    expect(clampFindingSizes(output)).toBe(output);
  });

  test("oversized title/body are truncated to the budgets with an ellipsis", () => {
    const output = {
      ...base,
      findings: [finding("T".repeat(FINDING_TITLE_MAX + 50), "B".repeat(FINDING_BODY_MAX + 99))],
    };
    const clamped = clampFindingSizes(output);
    expect(clamped.findings[0]!.title).toHaveLength(FINDING_TITLE_MAX);
    expect(clamped.findings[0]!.title!.endsWith("…")).toBe(true);
    expect(clamped.findings[0]!.body).toHaveLength(FINDING_BODY_MAX);
    expect(clamped.findings[0]!.body.endsWith("…")).toBe(true);
  });

  test("boundary-length values are kept verbatim", () => {
    const output = { ...base, findings: [finding("T".repeat(FINDING_TITLE_MAX), "B".repeat(FINDING_BODY_MAX))] };
    const clamped = clampFindingSizes(output);
    expect(clamped.findings[0]!.title).toBe("T".repeat(FINDING_TITLE_MAX));
    expect(clamped.findings[0]!.body).toBe("B".repeat(FINDING_BODY_MAX));
  });

  test("mixed sets clamp only the oversized findings", () => {
    const output = { ...base, findings: [finding("ok", "ok"), finding("X".repeat(FINDING_BODY_MAX + 1), "b")] };
    const clamped = clampFindingSizes(output);
    expect(clamped.findings[0]!.title).toBe("ok");
    expect(clamped.findings[1]!.title).toHaveLength(FINDING_TITLE_MAX);
  });

  test("oversized fingerprint_hint is clamped to the title budget (S-1)", () => {
    const output = {
      ...base,
      findings: [{ ...finding("t", "b"), fingerprint_hint: "H".repeat(FINDING_TITLE_MAX + 50) }],
    };
    const clamped = clampFindingSizes(output);
    expect(clamped.findings[0]!.fingerprint_hint).toHaveLength(FINDING_TITLE_MAX);
    expect(clamped.findings[0]!.fingerprint_hint!.endsWith("…")).toBe(true);
  });

  test("boundary-length fingerprint_hint is kept verbatim (S-1)", () => {
    const hint = "H".repeat(FINDING_TITLE_MAX);
    const output = { ...base, findings: [{ ...finding("t", "b"), fingerprint_hint: hint }] };
    const clamped = clampFindingSizes(output);
    expect(clamped.findings[0]!.fingerprint_hint).toBe(hint);
  });
});
