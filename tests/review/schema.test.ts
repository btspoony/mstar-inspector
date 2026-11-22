/**
 * Unit tests for the mstar.review/v1 envelope schema.
 *
 * Contract under test (docs/specs/architecture/github-review-comment-mapping.md §1 + the
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
  dropAllSuggestionFences,
  dropRedactedSuggestions,
  dropUnsafeFences,
  FINDING_BODY_MAX,
  FINDING_TITLE_MAX,
  capFindings,
  parseReviewOutput,
  suggestionFenceSpans,
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
    for (const mergeClass of ["must-fix", "should-fix", "may-fix", "nit"] as const) {
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
      // note: Required since engine 4.0.0; scoreBand(45) === "fail" (< 60 floor).
      band: "fail",
      tally: { mustFix: 0, shouldFix: 2, mayFix: 0, nit: 1 },
      chatHeader: "**needs fixes** · 45%\n🔴 0 🟠 2 🔵 1",
    };

    test("accepts an envelope with a well-formed tally", () => {
      const r = parseReviewOutput(JSON.stringify({ ...VALID, tally: TALLY }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        // note: The local zod mirror (src/review/schema.ts) does not declare the
        // engine's optional `band`, so it is stripped on parse; compare the
        // fields the mirror round-trips.
        const { band: _band, ...roundTripped } = TALLY;
        expect(r.output.tally).toEqual(roundTripped);
      }
    });

    test("accepts a tally with and without mayFix (the engine field is optional)", () => {
      // why: Pre-4.2 envelopes omit mayFix; readers treat absent as 0, so both
      // shapes parse and a present one round-trips.
      const { mayFix: _absent, ...withoutMayFix } = TALLY.tally;
      const absent = parseReviewOutput(JSON.stringify({ ...VALID, tally: { ...TALLY, tally: withoutMayFix } }));
      expect(absent.ok).toBe(true);
      if (absent.ok) expect(absent.output.tally?.tally.mayFix).toBeUndefined();

      const present = parseReviewOutput(
        JSON.stringify({ ...VALID, tally: { ...TALLY, tally: { ...TALLY.tally, mayFix: 3 } } }),
      );
      expect(present.ok).toBe(true);
      if (present.ok) expect(present.output.tally?.tally.mayFix).toBe(3);
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
    /** note: Tally mirror of the incomplete envelope: the fact echoed verbatim. */
    const TALLY = {
      verdict: "incomplete",
      scorePct: 45,
      band: "fail",
      tally: { mustFix: 0, shouldFix: 2, nit: 1 },
      chatHeader: "**incomplete** · 45%\n🔴 0 🟠 2 🔵 1",
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

  function finding(mergeClass: "must-fix" | "should-fix" | "may-fix" | "nit", title: string) {
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
    expect(out).toBe(output); // note: same reference, no copy
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

  test("ranks may-fix behind should-fix and ahead of nit when the cap forces a drop", () => {
    const findings = [finding("nit", "N"), finding("may-fix", "M"), finding("should-fix", "S")];
    const { output, omitted } = capFindings({ ...base, findings }, 2);
    expect(omitted).toBe(1);
    expect(output.findings.map((f) => f.mergeClass)).toEqual(["should-fix", "may-fix"]);
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

  test("a suggestion fence crossing the body budget is dropped whole, prose survives", () => {
    const prose = "P".repeat(1500);
    const fence = ["```suggestion", "C".repeat(800), "```"].join("\n");
    const body = prose + "\n\n" + fence; // note: fence starts before FINDING_BODY_MAX and ends after it // 2502 chars, fence straddles FINDING_BODY_MAX
    const clamped = clampFindingSizes({ ...base, findings: [finding("t", body)] });
    const clampedBody = clamped.findings[0]!.body;
    expect(clampedBody.length).toBeLessThanOrEqual(FINDING_BODY_MAX);
    expect(clampedBody).not.toContain("```");
    expect(clampedBody).not.toContain("…");
    expect(clampedBody.startsWith(prose)).toBe(true);
  });

  test("a fence whose closing fence ends exactly at FINDING_BODY_MAX is dropped whole, prose kept", () => {
    // why: Span end (just past the closing fence line) lands exactly on the budget, so
    // the final truncation would otherwise cut into that closing fence.
    const code = "const x = 1;";
    const pad = FINDING_BODY_MAX - 21 - code.length;
    const body = `${"P".repeat(pad)}\n\n\`\`\`suggestion\n${code}\n\`\`\`\n\ntail`;
    const clampedBody = clampFindingSizes({ ...base, findings: [finding("t", body)] }).findings[0]!.body;
    expect(clampedBody).toBe(`${"P".repeat(pad)}\n\n\ntail`);
    expect(clampedBody).not.toContain("```");
    expect(clampedBody).not.toContain("…");
    // invariant: Clamping the already-clamped body is a no-op, so the boundary case stays idempotent.
    expect(clampFindingSizes({ ...base, findings: [finding("t", clampedBody)] }).findings[0]!.body).toBe(clampedBody);
  });

  test("a fence opening exactly at FINDING_BODY_MAX leaves no partial fence", () => {
    const prose = "P".repeat(FINDING_BODY_MAX - 1);
    const body = `${prose}\n\`\`\`suggestion\nconst x = 1;\n\`\`\``;
    const clampedBody = clampFindingSizes({ ...base, findings: [finding("t", body)] }).findings[0]!.body;
    expect(clampedBody).toBe(`${prose}…`);
    expect(clampedBody).not.toContain("```");
  });

  test("fence-free over-budget bodies clamp byte-identically to the legacy rule", () => {
    const body = "B".repeat(FINDING_BODY_MAX + 500);
    const clamped = clampFindingSizes({ ...base, findings: [finding("t", body)] });
    expect(clamped.findings[0]!.body).toBe(body.slice(0, FINDING_BODY_MAX - 1) + "…");
  });

  test("an unclosed suggestion fence under the budget is dropped whole, prose kept (QC R1)", () => {
    const body = "Move this.\n\n```suggestion\nconst x = 1;";
    const clampedBody = clampFindingSizes({ ...base, findings: [finding("t", body)] }).findings[0]!.body;
    expect(clampedBody).toBe("Move this.\n\n");
    expect(clampedBody).not.toContain("```");
  });

  test("a 4-backtick suggestion fence crossing the budget is dropped whole (QC R2)", () => {
    const prose = "P".repeat(1500);
    const fence = ["````suggestion", "C".repeat(800), "````"].join("\n");
    const clampedBody = clampFindingSizes({ ...base, findings: [finding("t", prose + "\n\n" + fence)] })
      .findings[0]!.body;
    expect(clampedBody).toBe(prose + "\n\n");
    expect(clampedBody).not.toContain("`");
  });

  test("an inner ```js line does not close the fence, so the whole crossing block is dropped (QC R2)", () => {
    const prose = "P".repeat(1500);
    const fence = ["```suggestion", "C".repeat(600), "```js", "C".repeat(20), "```"].join("\n");
    const clampedBody = clampFindingSizes({ ...base, findings: [finding("t", prose + "\n\n" + fence)] })
      .findings[0]!.body;
    expect(clampedBody).toBe(prose + "\n\n");
    expect(clampedBody).not.toContain("```");
  });

  test("clamping is idempotent on a real overflow (drop + truncate both run)", () => {
    const prose = "P".repeat(2500);
    const fence = ["```suggestion", "C".repeat(800), "```"].join("\n");
    const output = { ...base, findings: [finding("t", prose + "\n\n" + fence)] };
    const once = clampFindingSizes(output);
    expect(once.findings[0]!.body).not.toBe(output.findings[0]!.body);
    expect(once.findings[0]!.body.length).toBeLessThanOrEqual(FINDING_BODY_MAX);
    const twice = clampFindingSizes(once);
    expect(twice.findings[0]!.body).toBe(once.findings[0]!.body);
  });

  test("a suggestion-only body clamps to the non-empty fallback and still parses (persistable)", () => {
    // note: Long enough that the closed fence crosses FINDING_BODY_MAX and must be dropped.
    const body = "```suggestion\n" + "C".repeat(2000) + "\n```";
    const raw = { ...base, findings: [finding("t", body)] };
    expect(parseReviewOutput(JSON.stringify(raw)).ok).toBe(true);
    const clamped = clampFindingSizes(raw);
    expect(clamped.findings[0]!.body).toBe("(suggestion omitted)");
    // why: The clamped envelope re-parses: persistence and line comments still happen.
    expect(parseReviewOutput(JSON.stringify(clamped)).ok).toBe(true);
  });

  test("a closed fence ending exactly at the budget with no truncation is kept verbatim", () => {
    const fence = "```suggestion\nconst x = 1;\n```";
    const text = "P".repeat(FINDING_BODY_MAX - fence.length - 1) + "\n" + fence;
    expect(text.length).toBe(FINDING_BODY_MAX);
    expect(dropUnsafeFences(text, FINDING_BODY_MAX)).toEqual({ text, dropped: false });
  });
});

describe("suggestionFenceSpans (CommonMark fence grammar, QC R2)", () => {
  const blocks = (text: string) =>
    suggestionFenceSpans(text).map(({ start, end, closed }) => ({ block: text.slice(start, end), closed }));

  test("a 4-backtick opening is closed only by a run of at least four backticks", () => {
    const text = "````suggestion\nconst md = \"```\";\n```\n````\nafter";
    expect(blocks(text)).toEqual([
      { block: "````suggestion\nconst md = \"```\";\n```\n````\n", closed: true },
    ]);
  });

  test("only an info string whose first token is exactly suggestion opens a block", () => {
    expect(blocks("```suggestions\nx\n```")).toEqual([]);
    expect(blocks("```suggestion-example\nx\n```")).toEqual([]);
    expect(blocks("```suggestion js\nx\n```")).toEqual([
      { block: "```suggestion js\nx\n```", closed: true },
    ]);
  });

  test("an inner ```js line is not a closing fence", () => {
    const text = "```suggestion\nconst md = \"```js\";\n```js\nconst y = 2;\n```\nafter";
    expect(blocks(text)).toEqual([
      { block: "```suggestion\nconst md = \"```js\";\n```js\nconst y = 2;\n```\n", closed: true },
    ]);
  });

  test("a block without its closing fence is reported unclosed and runs to the end", () => {
    const text = "prose\n\n```suggestion\nconst x = 1;";
    expect(blocks(text)).toEqual([{ block: "```suggestion\nconst x = 1;", closed: false }]);
  });

  test("a literal ```suggestion line inside an ordinary backtick fence is content, not a suggestion", () => {
    for (const lang of ["js", "markdown"]) {
      const text = ["```" + lang, "prose", "```suggestion", "this is prose, not code", "```", "after"].join("\n");
      expect(blocks(text)).toEqual([]);
    }
  });

  test("a literal ```suggestion line inside a tilde fence is content, not a suggestion", () => {
    const text = "~~~markdown\nprose\n```suggestion\nthis is prose, not code\n~~~\nafter";
    expect(blocks(text)).toEqual([]);
  });

  test("a tilde suggestion fence still counts as a suggestion", () => {
    const text = "~~~suggestion\nconst x = 1;\n~~~\nafter";
    expect(blocks(text)).toEqual([{ block: "~~~suggestion\nconst x = 1;\n~~~\n", closed: true }]);
  });

  test("an inline-code line on the first line is not a fence opener", () => {
    const text = "```oldCall()```\n\n```suggestion\nconst x = 1;\n```\nafter";
    expect(blocks(text)).toEqual([
      { block: "```suggestion\nconst x = 1;\n```\n", closed: true },
    ]);
  });

  test("the suggestion after such a line is still dropped from the body", () => {
    const text = "```oldCall()```\n\n```suggestion\nconst x = 1;\n```\nafter";
    expect(dropAllSuggestionFences(text)).toBe("```oldCall()```\n\nafter");
  });

  test("inline code whose info string holds inner backticks is not a fence either", () => {
    for (const line of ["```use `code` here```", "````a`b```"]) {
      const text = line + "\n```suggestion\nconst x = 1;\n```";
      expect(blocks(text)).toEqual([{ block: "```suggestion\nconst x = 1;\n```", closed: true }]);
    }
  });

  test("an ordinary ```js fence still opens a block", () => {
    const text = "```js\nconst a = 1;\n```\n```suggestion\nconst x = 1;\n```";
    expect(blocks(text)).toEqual([{ block: "```suggestion\nconst x = 1;\n```", closed: true }]);
  });
});

describe("dropRedactedSuggestions", () => {
  test("a suggestion whose patch carries the marker is removed with its prose kept", () => {
    const text = "before\n```suggestion\nconst x = \"[REDACTED]\";\n```\nafter";
    expect(dropRedactedSuggestions(text)).toBe("before\nafter");
  });

  test("a clean suggestion is untouched", () => {
    const clean = "```suggestion\nconst x = 1;\n```";
    expect(dropRedactedSuggestions(clean)).toBe(clean);
  });

  test("a CRLF suggestion carrying the marker is removed too", () => {
    const text = "before\r\n```suggestion\r\nconst x = \"[REDACTED]\";\r\n```\r\nafter";
    expect(dropRedactedSuggestions(text)).toBe("before\r\nafter");
  });

  test("a body that was only the redacted suggestion keeps a safe omission notice", () => {
    const text = "```suggestion\nconst x = \"[REDACTED]\";\n```";
    expect(dropRedactedSuggestions(text)).toBe("(suggestion omitted)");
  });
});

describe("dropUnsafeFences (any fence, not only suggestions)", () => {
  test("a list fence with a 3-space opener and 4-space closer stays closed", () => {
    const body = "1. step\n   ```\n   const x = 1;\n    ```\n2. keep this instruction";
    // A list's indentation is not part of the fence kind: the block is closed,
    // so the instruction after it survives.
    expect(dropUnsafeFences(body, 10_000)).toEqual({ text: body, dropped: false });
  });

  test("a plain fence crossing the budget is dropped whole; the prose after it survives", () => {
    const pad = "P".repeat(20) + "\n";
    const fence = "```\nconst x = 1;\n```";
    const tail = "\nkeep";
    const body = `${pad}${fence}${tail}`;
    const max = pad.length + 5; // lands inside the plain fence

    const { text, dropped } = dropUnsafeFences(body, max);
    expect(dropped).toBe(true);
    expect(text).toBe(`${pad}keep`);
    // The explanation below the block is preserved, and no truncated fence rides out.
    expect(text).toContain("keep");
    expect(text).not.toContain("```");
    expect(text.length).toBeLessThanOrEqual(max);
  });
});
