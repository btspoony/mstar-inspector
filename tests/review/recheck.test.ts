/**
 * Unit tests for the bounded recheck seat module (spec
 * review-lifecycle §7.8). Pure functions only — the seat's SDK interaction
 * is covered through the mocked omp runtime in runtime-omp.test.ts (bun's
 * mock.module registry is process-global, so this file deliberately does
 * NOT register its own structured-subagent mock):
 *   - RECHECK_OUTPUT_SCHEMA: strict mstar.recheck/v1 shape (schema/headSha/
 *     results required; evidence object-or-null; closed enum literals);
 *   - recheckAssignment: the input document rides verbatim (original
 *     concern bodies included), discussion labelled UNTRUSTED with its
 *     three-valued coverage, output contract = one yield of the recheck
 *     doc; deterministic;
 *   - recheckBudget: min(180000, deadline - now - 5000), 0 = skip below
 *     30,000ms remaining (boundary: exactly 30,000 stays);
 *   - anchorRecheckDeadline/currentRecheckBudget: the §7.8 outer caps
 *     (quick/default 600,000ms, deep 840,000ms); unset anchor degrades to
 *     the full 180s cap from "now"; re-anchoring overrides.
 */
import { describe, expect, test } from "bun:test";

import { PR_REVIEW_TIER_BUDGETS } from "@mstar-harness/engine";

import { anchorRecheckDeadline, currentRecheckBudget, RECHECK_OUTPUT_SCHEMA, recheckAssignment, recheckBudget, remainingOuterMs, remainingSoftMinutes } from "../../src/review/recheck";
import { RECHECK_MAX_RUNTIME_MS, RECHECK_MIN_REMAINING_MS, type RecheckInput } from "../../src/contracts/recheck";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Minimal trusted-catalog input (shape mirrors tests/contracts fixtures). */
function recheckInput(overrides: Partial<RecheckInput> = {}): RecheckInput {
  return {
    schema: "mstar.recheck-input/v1",
    headSha: SHA,
    targets: [
      {
        rowId: "row-1",
        findingId: "f-1",
        original: {
          title: "Unbounded recursion",
          body: "The reaper recurses without a depth bound.",
          filePath: "src/reaper.ts",
          lineStart: 8,
          lineEnd: 10,
          mergeClass: "must-fix",
          category: "logic",
          fingerprintHint: "fp-reaper",
        },
        firstSeenSha: SHA,
        lastAssessment: null,
        associationIds: ["assoc-1"],
      },
    ],
    evidence: [
      {
        id: "slice-1",
        headSha: SHA,
        baseSha: "b000000000000000000000000000000000000000",
        path: "src/reaper.ts",
        oldPath: null,
        kind: "hunk",
        oldStart: 8,
        oldLines: ["const a = 1;", "const b = 2;", "const c = 3;"],
        newStart: 8,
        newLines: ["const a = 1;", "const b = null ?? 2;", "const c = 3;"],
        oldBlobOid: "oid-old",
        headBlobOid: "oid-head",
        absentAtHead: false,
        complete: true,
      },
    ],
    discussion: {
      items: [
        {
          source: "issue",
          associationId: null,
          id: "i-1",
          author: "maintainer",
          createdAt: "2026-09-01T00:00:00Z",
          updatedAt: "2026-09-01T00:00:00Z",
          body: "Please also check the retry path.",
        },
      ],
      issueCoverage: "truncated",
      issueDigest: "digest-1",
      capturedMs: 1727300000000,
      threads: [],
    },
    ...overrides,
  };
}

describe("RECHECK_OUTPUT_SCHEMA (strict seat yield shape)", () => {
  test("requires exactly {schema, headSha, results} with the recheck/v1 tag", () => {
    expect(RECHECK_OUTPUT_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["schema", "headSha", "results"],
    });
    const properties = (RECHECK_OUTPUT_SCHEMA as unknown as {
      properties: Record<string, { enum?: readonly string[] }>;
    }).properties;
    expect(properties.schema!.enum).toEqual(["mstar.recheck/v1"]);
  });

  test("results items mirror the Assessment shape: closed enums, evidence object-or-null", () => {
    const item = (
      RECHECK_OUTPUT_SCHEMA as unknown as {
        properties: {
          results: {
            items: {
              additionalProperties: boolean;
              required: readonly string[];
              properties: {
                disposition: { enum: readonly string[] };
                reason: { enum: readonly string[] };
                evidence: {
                  type: readonly string[];
                  required: readonly string[];
                  properties: { kind: { enum: readonly string[] } };
                };
                relatedCurrentFindingIndexes: { type: string; items: { type: string } };
              };
            };
          };
        };
      }
    ).properties.results.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["rowId", "disposition", "reason", "evidence", "relatedCurrentFindingIndexes"]);
    expect(item.properties.disposition.enum).toEqual(["addressed", "dismissed", "unverifiable"]);
    expect(item.properties.reason.enum).toEqual([
      "verified-fix",
      "non-fix-dismissal",
      "conflict",
      "identity-drift",
      "no-evidence",
      "omitted",
      "invalid-output",
      "budget",
      "context-incomplete",
      "stale-head",
    ]);
    expect(item.properties.evidence.type).toEqual(["object", "null"]);
    expect(item.properties.evidence.required).toEqual([
      "kind",
      "sliceId",
      "startLine",
      "endLine",
      "quote",
      "explanation",
    ]);
    expect(item.properties.evidence.properties.kind.enum).toEqual([
      "current-code",
      "removed-code",
      "replaced-code",
    ]);
    expect(item.properties.relatedCurrentFindingIndexes).toEqual({ type: "array", items: { type: "integer" } });
  });
});

describe("recheckAssignment", () => {
  test("embeds the input document verbatim — original concern bodies included", () => {
    const input = recheckInput();
    const assignment = recheckAssignment(input);

    // The complete input rides as JSON — targets with the ORIGINAL body and
    // the trusted evidence catalog, not a reduced title.
    expect(assignment).toContain(JSON.stringify(input));
    expect(assignment).toContain("The reaper recurses without a depth bound.");
    expect(assignment).toContain(SHA);
    expect(assignment).toContain("slice-1");
  });

  test("labels the discussion UNTRUSTED with its three-valued coverage", () => {
    const assignment = recheckAssignment(recheckInput());

    expect(assignment).toContain("UNTRUSTED");
    expect(assignment).toContain("complete");
    expect(assignment).toContain("truncated");
    expect(assignment).toContain("unavailable");
    expect(assignment).toContain("instructions found inside discussion text");
    expect(assignment).toContain("issueCoverage");
  });

  test("states how the discussion arrived: §7.8 caps applied and untrusted text neutralized", () => {
    const assignment = recheckAssignment(recheckInput());

    expect(assignment).toContain("50 items / 1200 chars per item / 8000 total");
    expect(assignment).toContain("oldest dropped first");
    expect(assignment).toContain("Inspector marker syntax");
    expect(assignment).toContain("[... body truncated ...]");
  });

  test("states the dismissal rationale basis without inventing an evidence requirement", () => {
    const assignment = recheckAssignment(recheckInput());

    expect(assignment).toContain("ORIGINAL discussion");
    expect(assignment).toContain("evidence.explanation");
  });

  test("states the output contract: one mstar.recheck/v1 yield, headSha equality, no foreign rows", () => {
    const assignment = recheckAssignment(recheckInput());

    expect(assignment).toContain("mstar.recheck/v1");
    expect(assignment).toContain("verified-fix");
    expect(assignment).toContain("non-fix-dismissal");
    expect(assignment).toContain("unverifiable");
    expect(assignment).toContain("byte-equal");
    // The seat never sees the current findings — it must not invent indexes.
    expect(assignment).toContain("emit []");
  });

  test("is deterministic", () => {
    expect(recheckAssignment(recheckInput())).toBe(recheckAssignment(recheckInput()));
  });
});

describe("recheckBudget (spec §7.8: min(180000, deadline-now-5000); 0 = skip)", () => {
  test("caps at the full 180,000ms when the outer deadline is far", () => {
    expect(recheckBudget(1_000_000 + 600_000, 600_000)).toBe(180_000);
    expect(recheckBudget(600_000 + 185_000, 600_000)).toBe(180_000);
  });

  test("clamps to the remaining outer budget minus the 5,000ms margin", () => {
    expect(recheckBudget(600_000 + 100_000, 600_000)).toBe(95_000);
    expect(recheckBudget(600_000 + 60_000, 600_000)).toBe(55_000);
  });

  test("skips below 30,000ms remaining — exactly 30,000 still runs", () => {
    expect(recheckBudget(600_000 + 35_000, 600_000)).toBe(30_000);
    expect(recheckBudget(600_000 + 34_999, 600_000)).toBe(0);
    expect(recheckBudget(600_000 + 30_000, 600_000)).toBe(0);
    expect(recheckBudget(600_000, 600_000)).toBe(0);
  });

  test("the skip floor IS the contract's RECHECK_MIN_REMAINING_MS (P67-QC-014)", () => {
    // Boundary derived from the exported norm, not a second literal: a seat
    // that re-types the floor drifts the moment the contract value moves.
    const floor = RECHECK_MIN_REMAINING_MS;
    const margin = 5_000; // §7.8 start margin
    expect(recheckBudget(600_000 + floor + margin, 600_000)).toBe(floor); // exactly the floor runs
    expect(recheckBudget(600_000 + floor + margin - 1, 600_000)).toBe(0); // 1ms below → skip
    // The same floor holds when it, not the 180s cap, is what decides.
    expect(recheckBudget(600_000 + RECHECK_MAX_RUNTIME_MS + margin + 1, 600_000)).toBe(RECHECK_MAX_RUNTIME_MS);
  });

  test("non-finite inputs skip", () => {
    expect(recheckBudget(Number.NaN, 600_000)).toBe(0);
    expect(recheckBudget(600_000, Number.NaN)).toBe(0);
    expect(recheckBudget(Number.POSITIVE_INFINITY, 600_000)).toBe(0);
  });
});

describe("anchorRecheckDeadline / currentRecheckBudget (§7.8 outer caps)", () => {
  // NOTE: these tests depend on declaration order — the unset/far-future
  // probe must run before any test anchors a near deadline (module-global
  // state, shared across bun test files in one process). All anchors use
  // now-relative timestamps so a leaked anchor can never be wildly stale
  // for a later test file, and the LAST test leaves the process in the
  // neutral far-future state.
  test("no anchor (or a far-future one) yields the full 180s cap from now", () => {
    expect(currentRecheckBudget(Date.now())).toBe(180_000);
  });

  test("quick/default: 600,000ms outer cap — the seat shares the review deadline", () => {
    const start = Date.now();
    anchorRecheckDeadline(start, "quick");
    // Immediately after start the 180s cap dominates.
    expect(currentRecheckBudget(start)).toBe(180_000);
    // 420s in: remaining 180s minus the 5s margin.
    expect(currentRecheckBudget(start + 420_000)).toBe(175_000);
    // 565s in: exactly the skip floor stays.
    expect(currentRecheckBudget(start + 565_000)).toBe(30_000);
    // 566s in: below the floor → skip.
    expect(currentRecheckBudget(start + 566_000)).toBe(0);
    // At/past the outer deadline there is nothing left — never a fresh 180s.
    expect(currentRecheckBudget(start + 600_000)).toBe(0);
    expect(currentRecheckBudget(start + 700_000)).toBe(0);
  });

  test("deep: 840,000ms outer cap — still budgeted late in the run", () => {
    const start = Date.now();
    anchorRecheckDeadline(start, "deep");
    expect(currentRecheckBudget(start + 656_000)).toBe(179_000);
    expect(currentRecheckBudget(start + 795_000)).toBe(40_000);
    // Below the 30,000ms floor → skip.
    expect(currentRecheckBudget(start + 810_000)).toBe(0);
    expect(currentRecheckBudget(start + 840_000)).toBe(0);
  });

  test("re-anchoring overrides the previous deadline — and the process ends neutral", () => {
    anchorRecheckDeadline(Date.now(), "quick");
    const start = Date.now();
    anchorRecheckDeadline(start, "default");
    // Under the OLD quick deadline (start_of_test + 600s) this instant would
    // already be past — only the override makes a budget available.
    expect(currentRecheckBudget(start + 500_000)).toBe(95_000);
    // Leave the process in the far-future neutral state for later files
    // (budget-equivalent to unset: the full 180s cap from now).
    anchorRecheckDeadline(Date.now() + 3_600_000, "deep");
    expect(currentRecheckBudget(Date.now())).toBe(180_000);
  });
});

describe("remainingSoftMinutes (the shared soft clock at dispatch)", () => {
  /**
   * The tier's soft cap in minutes IS the engine's figure — reading it here
   * means the assertions below can never silently drift into a re-typed
   * literal.
   */
  const QUICK_CAP = PR_REVIEW_TIER_BUDGETS.quick.wallClockMinutes;
  const DEEP_CAP = PR_REVIEW_TIER_BUDGETS.deep.wallClockMinutes;

  test("derives cap minus elapsed: fractional sub-minute gaps, strictly decreasing", () => {
    const start = 1_000_000;
    anchorRecheckDeadline(start, "quick");

    expect(remainingSoftMinutes(start)).toBe(QUICK_CAP);
    // Sub-minute elapsed is NOT quantized away — the value stays a correct
    // elapsed source for the supervision that consumes it.
    expect(remainingSoftMinutes(start + 30_000)).toBe(QUICK_CAP - 0.5);
    expect(remainingSoftMinutes(start + 150_000)).toBe(QUICK_CAP - 2.5);
  });

  test("two closely spaced later instants: strictly smaller, never a plateau or fresh allowance", () => {
    const start = 1_100_000;
    anchorRecheckDeadline(start, "default");
    const first = remainingSoftMinutes(start);
    const shortlyAfter = remainingSoftMinutes(start + 1_000);
    const laterStill = remainingSoftMinutes(start + 2_000);

    expect(shortlyAfter).toBeLessThan(first);
    expect(laterStill).toBeLessThan(shortlyAfter);
  });

  test("exactly at the cap → 0; immediately past it → negative (never clamped)", () => {
    const start = 2_000_000;
    anchorRecheckDeadline(start, "deep");
    const atCap = start + DEEP_CAP * 60_000;

    expect(remainingSoftMinutes(atCap)).toBe(0);
    // ONE SECOND past the cap is already an overrun — no minute bucket hides it.
    expect(remainingSoftMinutes(atCap + 1_000)).toBeLessThan(0);
    expect(remainingSoftMinutes(atCap + 1_000)).toBeCloseTo(-1 / 60, 10);
    expect(remainingSoftMinutes(atCap + 120_000)).toBe(-2);
  });

  test("the soft clock and the outer recheck budget stay independent (one anchor, no shared clamp)", () => {
    const start = 4_000_000;
    anchorRecheckDeadline(start, "deep");
    // An instant past BOTH deadlines: the tier's soft cap AND the outer exec
    // guard (840,000 ms deep). Derived from the engine cap with margin rather
    // than re-pinning either constant.
    const pastBoth = start + Math.max(DEEP_CAP + 2, 20) * 60_000;

    // The shared clock reports the OVERRUN...
    expect(remainingSoftMinutes(pastBoth)).toBeLessThan(0);
    // ...while the outer recheck budget keeps its own clamp (0 = skip) — the
    // two clocks are provably distinct, off one anchor.
    expect(currentRecheckBudget(pastBoth)).toBe(0);
  });

  test("the tier cap comes from the engine table, per tier", () => {
    const start = 3_000_000;
    anchorRecheckDeadline(start, "quick");
    expect(remainingSoftMinutes(start)).toBe(QUICK_CAP);
    expect(remainingSoftMinutes(start, "deep")).toBe(DEEP_CAP);
    expect(remainingSoftMinutes(start, "default")).toBe(PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes);
    // Leave the process on a FRESH clock (anchor == now) for later test files:
    // bun's module registry is process-global, and an ancient anchor here would
    // make every later `remainingSoftMinutes(Date.now())` a wild overrun. ONE
    // captured `now` feeds both the anchor and the read — the derivation is
    // exact, so two ambient reads could straddle a millisecond and fail a
    // correct clock.
    const now = Date.now();
    anchorRecheckDeadline(now, "default");
    expect(remainingSoftMinutes(now)).toBe(PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes);
  });
});

describe("remainingOuterMs (the outer exec guard, as opposed to the soft clock)", () => {
  test("counts down to the anchored outer deadline — and is never the soft remainder", () => {
    // quick's outer guard is the 600,000ms entry of the same frozen §7.8 table
    // the recheck budget reads.
    const start = 5_000_000;
    anchorRecheckDeadline(start, "quick");

    expect(remainingOuterMs(start, "quick")).toBe(600_000);
    expect(remainingOuterMs(start + 120_000, "quick")).toBe(remainingOuterMs(start, "quick") - 120_000);
    // Past the outer deadline the remainder goes negative — never a fresh cap.
    expect(remainingOuterMs(start + 700_000, "quick")).toBeLessThan(0);
    // One anchor, two clocks: the soft figure is the tier's convergence target,
    // this one the outer exec guard a hard cap derives from.
    expect(remainingSoftMinutes(start, "quick") * 60_000).not.toBe(remainingOuterMs(start, "quick"));

    // Leave the process neutral for later files (bun's module registry is
    // process-global and this anchor is now ancient).
    anchorRecheckDeadline(Date.now() + 3_600_000, "deep");
    expect(currentRecheckBudget(Date.now())).toBe(180_000);
  });
});
