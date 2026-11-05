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
 *     three-valued coverage and its model-context caps (quoted from the
 *     shared constants, never retyped), output contract = one yield of the
 *     recheck doc; deterministic;
 *   - recheckBudget: min(the caller's cap — `RECHECK_MAX_RUNTIME_MS` by
 *     default, the tier's clock in production, deadline - now - 5s), 0 = skip
 *     below the contract's minimum remaining (boundary: exactly the floor
 *     stays);
 *   - anchorRecheckDeadline/currentRecheckBudget/resetRecheckAnchor: the
 *     budget is the anchored TIER's own clock (pinned here as literal
 *     effective caps, never recomputed from the implementation's formula)
 *     bounded by the outer guard less the publication tail; unset anchor
 *     degrades to the default tier's cap from "now"; re-anchoring overrides;
 *     the reset returns the process to that unanchored state;
 *   - remainingSoftMinutes / remainingOuterMs: the tier's SOFT wall-clock
 *     clock (negative past the cap, never clamped) versus the outer exec
 *     guard, both pure views over the same anchor;
 *   - recheckRoundStatus: an empty round over a non-empty target list is
 *     failed (all-rows-rejected / empty-result), never clean.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { PR_REVIEW_TIER_BUDGETS } from "@mstar-harness/engine";

import { anchorRecheckDeadline, currentRecheckBudget, OUTER_RUNNER_CAP_MS, PUBLICATION_TAIL_MS, RECHECK_OUTPUT_SCHEMA, recheckAssignment, recheckBudget, recheckRoundStatus, remainingOuterMs, remainingSoftMinutes, resetRecheckAnchor } from "../../packages/runner/src/recheck";
import { MODEL_ITEM_MAX_CHARS, MODEL_MAX_ITEMS, MODEL_TOTAL_MAX_CHARS, RECHECK_MAX_RUNTIME_MS, RECHECK_MIN_REMAINING_MS, type Assessment, type RecheckGateResult, type RecheckInput, type RecheckRowRejection } from "../../packages/shared/src/recheck-wire";

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
        addedNewLines: [9],
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
          ownAuthor: false,
        },
      ],
      issueCoverage: "truncated",
      issueModelCoverage: "complete",
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

    // The figures are read off the shared constants, so a moved cap can never
    // leave this assertion pinning a stale number.
    expect(assignment).toContain(
      `${MODEL_MAX_ITEMS} items / ${MODEL_ITEM_MAX_CHARS} chars per item / ${MODEL_TOTAL_MAX_CHARS} total`,
    );
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
    // The seat must copy the cited catalog lines, not retype them.
    expect(assignment).toContain("Copy `quote` verbatim");
    // The seat never sees the current findings — it must not invent indexes.
    expect(assignment).toContain("emit []");
  });

  test("is deterministic", () => {
    expect(recheckAssignment(recheckInput())).toBe(recheckAssignment(recheckInput()));
  });
});

describe("recheckBudget (spec §7.8: min(cap, deadline-now-5000); 0 = skip)", () => {
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
    expect(recheckBudget(600_000 + 600_000, 600_000, Number.NaN)).toBe(0);
    expect(recheckBudget(1_200_000, 600_000, -1)).toBe(0);
  });

  test("a caller-supplied cap replaces the default — and the floor still decides", () => {
    // The tier's clock (540,000ms for default) is wider than the old 180s cap
    // and narrower than the deadline: the caller's figure is the cap.
    expect(recheckBudget(600_000 + 600_000, 600_000, 540_000)).toBe(540_000);
    // A cap below the contract's minimum is a skip, never a short seat.
    expect(recheckBudget(600_000 + 600_000, 600_000, RECHECK_MIN_REMAINING_MS - 1)).toBe(0);
  });
});

/**
 * The cap each tier actually gets, as a literal table — NOT a copy of the
 * implementation's `min` formula, so the expectation cannot move with the
 * implementation. Quick's 5-minute clock fits inside its 9-minute outer
 * window (300,000); default's 10-minute clock is bounded by the outer guard's
 * 60s tail (600,000 - 60,000 = 540,000); deep's 15-minute clock is bounded by
 * its 14-minute outer guard (840,000 - 60,000 = 780,000).
 */
const TIER_CAP_MS: Record<keyof typeof OUTER_RUNNER_CAP_MS, number> = {
  quick: 300_000,
  default: 540_000,
  deep: 780_000,
};

describe("anchorRecheckDeadline / currentRecheckBudget (§7.8 tier budgets)", () => {
  // bun's module registry is process-global, so the anchor is shared across
  // test files. Every case starts from the UNSET state instead of depending on
  // another case's leftover anchor or on declaration order.
  beforeEach(() => {
    resetRecheckAnchor();
  });

  test("no anchor yields the default tier's cap from now — never a fixed 180s", () => {
    expect(currentRecheckBudget(Date.now())).toBe(TIER_CAP_MS.default);
    // I-000431: the round reads up to 25 published findings, so the tier's
    // clock is the budget; 180s survives only as the pure function's default.
    expect(TIER_CAP_MS.default).toBeGreaterThan(RECHECK_MAX_RUNTIME_MS);
  });

  test("quick/default: the tier's own clock — the seat shares the review deadline", () => {
    const start = Date.now();
    const cap = OUTER_RUNNER_CAP_MS.quick;
    anchorRecheckDeadline(start, "quick");
    // Immediately after start the tier's clock dominates.
    expect(currentRecheckBudget(start)).toBe(TIER_CAP_MS.quick);
    // Near the outer deadline: whatever remains less the publication tail, down
    // to the contract's floor.
    expect(currentRecheckBudget(start + cap - RECHECK_MIN_REMAINING_MS - PUBLICATION_TAIL_MS)).toBe(
      RECHECK_MIN_REMAINING_MS,
    );
    // 1ms less: below the floor → skip.
    expect(currentRecheckBudget(start + cap - RECHECK_MIN_REMAINING_MS - PUBLICATION_TAIL_MS + 1)).toBe(0);
    // At/past the outer deadline there is nothing left — never a fresh cap.
    expect(currentRecheckBudget(start + cap)).toBe(0);
    expect(currentRecheckBudget(start + cap + 100_000)).toBe(0);
  });

  test("deep: the taller tier clock, bounded by the outer guard's tail", () => {
    const start = Date.now();
    const cap = OUTER_RUNNER_CAP_MS.deep;
    anchorRecheckDeadline(start, "deep");
    // Deep's 15-minute tier clock is wider than its 14-minute outer guard, so
    // the guard minus the publication tail is what decides.
    expect(currentRecheckBudget(start)).toBe(TIER_CAP_MS.deep);
    expect(currentRecheckBudget(start + cap - RECHECK_MIN_REMAINING_MS - PUBLICATION_TAIL_MS)).toBe(
      RECHECK_MIN_REMAINING_MS,
    );
    // Late but inside deep's cap the tail-bounded budget still runs; the SAME
    // instant under quick's shorter cap has nothing left.
    const late = start + OUTER_RUNNER_CAP_MS.quick + 1_000;
    expect(currentRecheckBudget(late)).toBe(cap - (late - start) - PUBLICATION_TAIL_MS);
    anchorRecheckDeadline(start, "quick");
    expect(currentRecheckBudget(late)).toBe(0);
  });

  test("re-anchoring overrides the previous deadline", () => {
    anchorRecheckDeadline(Date.now(), "quick");
    const start = Date.now();
    anchorRecheckDeadline(start, "default");
    // Under the OLD quick deadline (start_of_test + cap) this instant would
    // already be past — only the override makes a budget available: 100,000ms
    // of outer guard left less the 60s publication tail.
    expect(currentRecheckBudget(start + 500_000)).toBe(40_000);
  });

  test("resetRecheckAnchor returns the process to the unset state", () => {
    anchorRecheckDeadline(Date.now() - 10 * 60_000, "quick");
    expect(currentRecheckBudget(Date.now())).toBe(0);
    resetRecheckAnchor();
    expect(currentRecheckBudget(Date.now())).toBe(TIER_CAP_MS.default);
    expect(remainingSoftMinutes(Date.now())).toBe(PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes);
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

  beforeEach(() => {
    resetRecheckAnchor();
  });

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
    // ONE captured `now` feeds both the anchor and the read — the derivation is
    // exact, so two ambient reads could straddle a millisecond and fail a
    // correct clock.
    const now = Date.now();
    anchorRecheckDeadline(now, "default");
    expect(remainingSoftMinutes(now)).toBe(PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes);
  });
});

describe("remainingOuterMs (the outer exec guard, as opposed to the soft clock)", () => {
  beforeEach(() => {
    resetRecheckAnchor();
  });

  test("counts down to the anchored outer deadline — and is never the soft remainder", () => {
    // quick's outer guard is the same frozen §7.8 table entry the recheck
    // budget reads.
    const start = 5_000_000;
    const cap = OUTER_RUNNER_CAP_MS.quick;
    anchorRecheckDeadline(start, "quick");

    expect(remainingOuterMs(start, "quick")).toBe(cap);
    expect(remainingOuterMs(start + 120_000, "quick")).toBe(cap - 120_000);
    // Past the outer deadline the remainder goes negative — never a fresh cap.
    expect(remainingOuterMs(start + cap + 100_000, "quick")).toBeLessThan(0);
    // One anchor, two clocks: the soft figure is the tier's convergence target,
    // this one the outer exec guard a hard cap derives from.
    expect(remainingSoftMinutes(start, "quick") * 60_000).not.toBe(remainingOuterMs(start, "quick"));
  });
});

describe("recheckRoundStatus (a round that delivered nothing is failed, never clean)", () => {
  const gateOf = (results: Assessment[], rejected: RecheckRowRejection[]): RecheckGateResult & { ok: true } => ({
    ok: true,
    doc: { schema: "mstar.recheck/v1", headSha: SHA, results },
    rejected,
  });

  test("a valid document with zero results over a non-empty target list → failed/empty-result", () => {
    expect(recheckRoundStatus(gateOf([], []), 1, SHA)).toEqual({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "failed",
      reason: "empty-result",
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 0,
      error: null,
    });
  });

  test("every submitted row gate-dropped → failed/all-rows-rejected with the named and nameless drops", () => {
    const status = recheckRoundStatus(
      gateOf(
        [],
        [
          { rowId: "row-1", index: 0, error: "results[0].disposition is outside the closed enum" },
          { rowId: null, index: 1, error: "results[1].rowId must be a nonempty string" },
        ],
      ),
      2,
      SHA,
    );
    expect(status).toMatchObject({
      outcome: "failed",
      reason: "all-rows-rejected",
      rejected: 1,
      rejected_row_ids: ["row-1"],
      rejected_unnamed: 1,
    });
  });

  test("a surviving row keeps the round ok, and an empty target list is not a failure", () => {
    const survived: Assessment[] = [
      { rowId: "row-1", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
    ];
    expect(recheckRoundStatus(gateOf(survived, []), 1, SHA)).toMatchObject({ outcome: "ok", reason: null });
    // Nothing was sent, so there is no round to blame.
    expect(recheckRoundStatus(gateOf([], []), 0, SHA)).toMatchObject({ outcome: "ok", reason: null });
  });
});
