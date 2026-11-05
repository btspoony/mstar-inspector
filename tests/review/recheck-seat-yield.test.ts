/**
 * Plan 036b Task 1 (RCA) — the recheck seat's yield boundary at the documented
 * input limits.
 *
 * One fake structured-subagent result per case, driven through the REAL
 * `runRecheckSeat` (`packages/runner/src/recheck.ts`), so each candidate mode
 * is pinned to the status the shipped code actually reports:
 *
 *   (a) a valid document over a max-size input survives whole (25/25);
 *   (b) one malformed row among 25 keeps the other 24 (row-level degradation);
 *   (c) an absent yield — the SDK's `unavailable` status with no error text —
 *       loses the whole round as `seat-failed` with the EXACT message recorded
 *       in I-000396 ("recheck seat produced no valid structured output
 *       (status unavailable)");
 *   (d) a strict-schema rejection ALSO reports `seat-failed`, but carries the
 *       validator text — which is what separates it from (c) in the record;
 *   (e) a document-level distrust (stale HEAD) is `invalid-document`, a
 *       different reason, never `seat-failed`;
 *   (f) a round with no budget is `skipped`/`budget` and starts no seat;
 *   (g) a caller abort is `skipped`/`aborted`, not a blamed round.
 *
 * Plan 036b Task 2 adds the budget cases: the ask fits
 * `RECHECK_ASSIGNMENT_MAX_BYTES` at these documented limits with every row still
 * reachable, the fit covers rows before it deepens any row, and a round whose
 * target core cannot fit is `skipped`/`budget` with no seat started.
 *
 * No case returns `doc: null` with `outcome: "ok"`/`reason: null` — a lost
 * round is always attributable. The consumer's row accounting for (c)/(e) is
 * pinned by tests/pipeline/consumer-recheck-status.test.ts ("a failed seat
 * status with no document makes the round attributable").
 *
 * The `?test=` query keeps this file's `recheck.ts` instance off any sibling's
 * mock registry key (bun's mock.module registry is process-global).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  MODEL_ITEM_MAX_CHARS,
  MODEL_MAX_ITEMS,
  MODEL_TOTAL_MAX_CHARS,
  RECHECK_MAX_TARGETS,
  validateRecheckDoc,
  type RecheckInput,
  type RecheckStatusReason,
} from "../../packages/shared/src/recheck-wire";

/** The SDK's settled `SingleResult` slice `runRecheckSeat` reads. */
type FakeSeatResult = {
  error?: string;
  stderr: string;
  structuredOutput?:
    | { source: "caller"; mode: "strict"; status: "valid"; data: unknown }
    | { source: "caller"; mode: "strict"; status: "invalid"; data: unknown; error: string }
    | { source: "caller"; mode: "strict"; status: "unavailable"; error?: string };
};

let seatResult: FakeSeatResult;
/** Set to model a seat the caller's abort signal rejects before it settles. */
let seatReject: Error | null = null;
const seatCalls: { assignment: string }[] = [];

mock.module("@oh-my-pi/pi-coding-agent/task/structured-subagent", () => ({
  runStructuredSubagent: mock(async (request: { assignment: string }) => {
    seatCalls.push(request);
    if (seatReject !== null) throw seatReject;
    return {
      result: {
        index: 0,
        id: `seat-${seatCalls.length}`,
        agent: "mstar-review-seat",
        exitCode: seatResult.error !== undefined ? 1 : 0,
        output: "",
        stderr: seatResult.stderr,
        error: seatResult.error,
        structuredOutput: seatResult.structuredOutput,
      },
      policy: {},
      mergeSummary: "",
      changesApplied: null,
      artifactsDir: "/tmp/fake-artifacts",
      temporaryArtifacts: true,
    };
  }),
}));

// Dynamic import: the mock must be registered before recheck.ts evaluates its
// structured-subagent import. The query suffix gives this file its own module
// registry key, so a sibling that mocks the same runner path cannot bind here.
const RECHECK_SPEC = "../../packages/runner/src/recheck.ts?test=recheck-seat-yield";
const { anchorRecheckDeadline, OUTER_RUNNER_CAP_MS, RECHECK_ASSIGNMENT_MAX_BYTES, resetRecheckAnchor, runRecheckSeat } = (await import(
  RECHECK_SPEC
)) as {
  anchorRecheckDeadline: (startMs: number, level: "quick" | "default" | "deep") => void;
  OUTER_RUNNER_CAP_MS: Record<"quick" | "default" | "deep", number>;
  /** The seat's assignment budget (plan 036b Task 2). */
  RECHECK_ASSIGNMENT_MAX_BYTES: number;
  resetRecheckAnchor: () => void;
  runRecheckSeat: (input: {
    session: unknown;
    input: RecheckInput;
    model: string[];
    signal: AbortSignal;
  }) => Promise<{ doc: { results: { rowId: string }[] } | null; status: { outcome: string; reason: RecheckStatusReason | null; error: string | null; rejected: number; rejected_row_ids: string[]; rejected_unnamed: number } }>;
};

const SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * The largest round the wire format documents: `RECHECK_MAX_TARGETS` rows,
 * four slices per row (the consumer's `RECHECK_SLICES_PER_TARGET`), each side
 * inside the 80-line / 8 KiB window, the whole catalog near its 256 KiB byte
 * budget, and the discussion at its per-item character cap within its total
 * cap. Nothing here is truncated by a test-only helper — the values ARE the
 * documented input limits.
 */
function maxSizeInput(): RecheckInput {
  const linesPerSide = 12;
  // Line text is deliberately wide: the per-side window is 80 lines / 8 KiB,
  // and a large round's catalog runs to its own 256 KiB budget.
  const lineOf = (row: number, slice: number, side: "old" | "new", index: number): string =>
    `const ${side}Value_${row}_${slice}_${index} = computeSomething("srcreaper.ts", ${index}); // srcreaper-core-module`;
  const targets = Array.from({ length: RECHECK_MAX_TARGETS }, (_, row) => ({
    rowId: `row-${row}`,
    findingId: `f-${row}`,
    original: {
      title: `Prior finding ${row}`,
      body: `The previously published concern ${row}: the reaper recurses without a depth bound and the retry path is unbounded. `.repeat(4),
      filePath: `src/file-${row}.ts`,
      lineStart: 1,
      lineEnd: linesPerSide,
      mergeClass: "must-fix" as const,
      category: "logic",
      fingerprintHint: `fp-${row}`,
    },
    firstSeenSha: SHA,
    lastAssessment: null,
    associationIds: [`assoc-${row}`],
  }));
  const evidence = targets.flatMap((target, row) =>
    Array.from({ length: 4 }, (_, slice) => ({
      id: `slice-${row}-${slice}`,
      headSha: SHA,
      baseSha: "b" + "0".repeat(39),
      path: target.original.filePath,
      oldPath: null,
      kind: "hunk" as const,
      oldStart: 1,
      oldLines: Array.from({ length: linesPerSide }, (_, index) => lineOf(row, slice, "old", index)),
      newStart: 1,
      newLines: Array.from({ length: linesPerSide }, (_, index) => lineOf(row, slice, "new", index)),
      addedNewLines: [1],
      oldBlobOid: "oid-old",
      headBlobOid: "oid-head",
      absentAtHead: false,
      complete: true,
    })),
  );
  // At the ITEM cap but inside the TOTAL cap: 6 items of MODEL_ITEM_MAX_CHARS
  // = 7200 of the 8000 total (a 50-item capture would be total-truncated).
  const itemsPerCapture = Math.min(MODEL_MAX_ITEMS, Math.floor(MODEL_TOTAL_MAX_CHARS / MODEL_ITEM_MAX_CHARS));
  return {
    schema: "mstar.recheck-input/v1",
    headSha: SHA,
    targets,
    evidence,
    discussion: {
      items: Array.from({ length: itemsPerCapture }, (_, index) => ({
        source: "issue" as const,
        associationId: null,
        id: `comment-${index}`,
        author: "maintainer",
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
        body: `discussion body ${index} `.padEnd(MODEL_ITEM_MAX_CHARS, "x"),
      })),
      issueCoverage: "truncated" as const,
      issueDigest: "digest-1",
      capturedMs: 1762000000000,
      threads: [],
    },
  };
}

/** A valid seat row for `rowId`: no proof is required for `unverifiable`. */
function row(rowId: string): Record<string, unknown> {
  return {
    rowId,
    disposition: "unverifiable",
    reason: "no-evidence",
    evidence: null,
    relatedCurrentFindingIndexes: [],
  };
}

function doc(results: unknown[], headSha = SHA): Record<string, unknown> {
  return { schema: "mstar.recheck/v1", headSha, results };
}

const INPUT = maxSizeInput();

beforeEach(() => {
  resetRecheckAnchor();
  seatCalls.length = 0;
  seatReject = null;
  seatResult = { stderr: "", structuredOutput: { source: "caller", mode: "strict", status: "unavailable" } };
});

afterEach(() => {
  resetRecheckAnchor();
});

afterAll(() => {
  // Registry hygiene: a sibling file must not inherit this file's seat stub.
  mock.restore();
});

async function run(signal = new AbortController().signal) {
  return runRecheckSeat({ session: {} as never, input: INPUT, model: ["test-model"], signal });
}

describe("036b RCA — recheck seat yield at the documented input limits", () => {
  test("the fixture is a max-size round: 25 rows, 100 slices, near the input byte cap", () => {
    expect(INPUT.targets).toHaveLength(RECHECK_MAX_TARGETS);
    expect(INPUT.evidence).toHaveLength(RECHECK_MAX_TARGETS * 4);
    const bytes = Buffer.byteLength(JSON.stringify(INPUT));
    // The §7.3 input cap is 512 KiB; the catalog cap is 256 KiB. A large round
    // therefore carries a quarter of a megabyte of trusted evidence as PROMPT
    // text — this is the size the seat's one-shot context must hold.
    expect(bytes).toBeGreaterThan(256 * 1024);
    expect(bytes).toBeLessThan(512 * 1024);
  });

  test("(a) a valid document over the max-size input survives whole — 25/25 assessed", async () => {
    const results = INPUT.targets.map((target) => row(target.rowId));
    seatResult = {
      stderr: "",
      structuredOutput: { source: "caller", mode: "strict", status: "valid", data: doc(results) },
    };
    const { doc: seatDoc, status } = await run();
    expect(seatDoc?.results).toHaveLength(RECHECK_MAX_TARGETS);
    expect(status).toMatchObject({ outcome: "ok", reason: null, rejected: 0, rejected_row_ids: [], rejected_unnamed: 0 });
  });

  test("(b) one malformed row among 25 keeps the other 24 — the bad row is named, not the round", async () => {
    const results = INPUT.targets.map((target) => row(target.rowId));
    // A remote thread id smuggled into a row: the strict shape forbids extra keys.
    results[7] = { ...row("row-7"), threadId: 1234 };
    seatResult = {
      stderr: "",
      structuredOutput: { source: "caller", mode: "strict", status: "valid", data: doc(results) },
    };
    const { doc: seatDoc, status } = await run();
    expect(seatDoc?.results).toHaveLength(RECHECK_MAX_TARGETS - 1);
    expect(seatDoc?.results.some((entry) => entry.rowId === "row-7")).toBe(false);
    expect(status).toMatchObject({ outcome: "ok", reason: null, rejected: 1, rejected_row_ids: ["row-7"] });
  });

  test("(c) an absent yield loses the whole round: seat-failed with the I-000396 message", async () => {
    // The recorded production signature: no payload, non-zero child exit, no
    // stderr → the SDK reports `unavailable` with no error text.
    seatResult = { stderr: "", structuredOutput: { source: "caller", mode: "strict", status: "unavailable" } };
    const { doc: seatDoc, status } = await run();
    expect(seatDoc).toBeNull();
    expect(status.outcome).toBe("failed");
    expect(status.reason).toBe("seat-failed");
    expect(status.error).toBe("recheck seat produced no valid structured output (status unavailable)");
    expect(status.rejected + status.rejected_unnamed).toBe(0);
  });

  test("(d) a strict-schema rejection is ALSO seat-failed, but carries the validator text", async () => {
    const failure = "results[0].rowId is a duplicate row ID";
    seatResult = {
      stderr: failure,
      error: failure,
      structuredOutput: { source: "caller", mode: "strict", status: "invalid", data: {}, error: failure },
    };
    const { doc: seatDoc, status } = await run();
    expect(seatDoc).toBeNull();
    expect(status.reason).toBe("seat-failed");
    // The discriminator: the schema fault names itself, so the recorded
    // no-detail `unavailable` message cannot have come from this path.
    expect(status.error).toBe(`recheck seat failed: ${failure}`);
    expect(status.error).not.toBe("recheck seat produced no valid structured output (status unavailable)");
  });

  test("(e) a document-level distrust is invalid-document, a different reason", async () => {
    const results = INPUT.targets.map((target) => row(target.rowId));
    seatResult = {
      stderr: "",
      structuredOutput: {
        source: "caller",
        mode: "strict",
        status: "valid",
        data: doc(results, "f".repeat(40)),
      },
    };
    const { doc: seatDoc, status } = await run();
    expect(seatDoc).toBeNull();
    expect(status.reason).toBe("invalid-document");
    expect(status.error).toContain("stale document");
  });

  test("(f) a round with no budget is skipped/budget and starts no seat", async () => {
    anchorRecheckDeadline(Date.now() - OUTER_RUNNER_CAP_MS.default + 10_000, "default");
    const { doc: seatDoc, status } = await run();
    expect(seatDoc).toBeNull();
    expect(status).toMatchObject({ outcome: "skipped", reason: "budget" });
    expect(seatCalls).toHaveLength(0);
  });

  test("(g) a caller abort is skipped/aborted — the rows are not blamed", async () => {
    const controller = new AbortController();
    controller.abort();
    // The SDK rejects the pending child when the review settles.
    seatReject = new DOMException("The operation was aborted.", "AbortError");
    const { doc: seatDoc, status } = await run(controller.signal);
    expect(seatDoc).toBeNull();
    expect(status).toMatchObject({ outcome: "skipped", reason: "aborted" });
  });

  test("every lost round is attributable: doc null never pairs with outcome ok", async () => {
    for (const structuredOutput of [
      { source: "caller", mode: "strict", status: "unavailable" } as const,
      { source: "caller", mode: "strict", status: "invalid", data: {}, error: "schema" } as const,
    ]) {
      seatResult = { stderr: "", structuredOutput };
      const { doc: seatDoc, status } = await run();
      expect(seatDoc).toBeNull();
      expect(status.outcome).toBe("failed");
      expect(status.reason).not.toBeNull();
    }
  });
});

/** The input document the seat was actually asked with (between its prose markers). */
function askedDocument(assignment: string): RecheckInput {
  const header = "Input document (mstar.recheck-input/v1):\n\n";
  const start = assignment.indexOf(header);
  const end = assignment.indexOf("\n\nDocument sections:", start);
  if (start < 0 || end < 0) throw new Error("the assignment embeds no recheck input document");
  return JSON.parse(assignment.slice(start + header.length, end)) as RecheckInput;
}

/** An answer for every row the ask carries (no proof needed for `unverifiable`). */
function answerAll(asked: RecheckInput): FakeSeatResult {
  return {
    stderr: "",
    structuredOutput: {
      source: "caller",
      mode: "strict",
      status: "valid",
      data: doc(asked.targets.map((target) => row(target.rowId))),
    },
  };
}

describe("036b Task 2 — the ask fits the seat's context budget", () => {
  test("a max-size round is asked inside the budget, every row still reachable", async () => {
    // The RCA's cause: the max-size input is ~270 KB of JSON — a whole 128k
    // window of prompt before the seat's own tools or its yield, so the
    // one-shot yield never arrives. The ask must be FITTED instead.
    seatResult = answerAll(INPUT);
    const { doc: seatDoc, status } = await run();
    expect(seatCalls).toHaveLength(1);
    const assignment = seatCalls[0]!.assignment;

    expect(Buffer.byteLength(assignment)).toBeLessThanOrEqual(RECHECK_ASSIGNMENT_MAX_BYTES);
    const asked = askedDocument(assignment);
    // No prior finding may vanish from the ask: every row is still named.
    expect(asked.targets.map((target) => target.rowId)).toEqual(INPUT.targets.map((target) => target.rowId));
    expect(asked.evidence.length).toBeGreaterThan(0);
    expect(asked.evidence.length).toBeLessThan(INPUT.evidence.length);
    // Retained slices ride UNMODIFIED (line numbers stay exact); dropped ones
    // are omitted whole, never truncated.
    for (const slice of asked.evidence) expect(INPUT.evidence).toContainEqual(slice);
    // The seat answers every row it was asked: a fitted ask is a served round.
    expect(seatDoc?.results).toHaveLength(RECHECK_MAX_TARGETS);
    expect(status).toMatchObject({ outcome: "ok", reason: null });
  });

  test("the fit covers rows before it deepens any row — no row starves in row order", async () => {
    seatResult = answerAll(INPUT);
    await run();
    const asked = askedDocument(seatCalls[0]!.assignment);
    const coveredPaths = new Set(asked.evidence.map((slice) => slice.path)).size;
    // One slice per row comes first, so distinct rows covered EQUAL the slice
    // count until every row has one (25 rows, 4 slices each in this fixture).
    expect(asked.evidence.length).toBeLessThan(RECHECK_MAX_TARGETS);
    expect(coveredPaths).toBe(asked.evidence.length);
  });

  test("a row the fit starved cannot be answered `addressed` from the catalog it received", async () => {
    seatResult = answerAll(INPUT);
    await run();
    const asked = askedDocument(seatCalls[0]!.assignment);
    // The fit drops whole slices, so some row's file retains none: the ask
    // gives that row no provable context at all.
    const starved = asked.targets.find(
      (target) => !asked.evidence.some((slice) => slice.path === target.original.filePath),
    );
    expect(starved).toBeDefined();
    // The round's catalog DOES hold such a slice — the seat was just never
    // given it — so the same citation is a real proof only against the ask.
    const omitted = INPUT.evidence.find(
      (slice) => slice.path === starved!.original.filePath && slice.addedNewLines.includes(slice.newStart),
    )!;
    const claimed = doc([
      {
        rowId: starved!.rowId,
        disposition: "addressed",
        reason: "verified-fix",
        evidence: {
          kind: "current-code",
          sliceId: omitted.id,
          startLine: omitted.newStart,
          endLine: omitted.newStart,
          quote: omitted.newLines[0]!,
          explanation: "the added line removes the unbounded recursion",
        },
        relatedCurrentFindingIndexes: [],
      },
    ]);
    const full = validateRecheckDoc(claimed, INPUT);
    if (!full.ok) throw new Error(full.error);
    expect(full.rejected).toHaveLength(0);
    // A row the fit starved cannot be closed by evidence it never received:
    // the citation is not in the retained catalog, so that row is dropped —
    // it can only be yielded `unverifiable`/`context-incomplete`.
    const fitted = validateRecheckDoc(claimed, asked);
    if (!fitted.ok) throw new Error(fitted.error);
    expect(fitted.rejected).toHaveLength(1);
    expect(fitted.rejected[0]!.rowId).toBe(starved!.rowId);
    expect(fitted.rejected[0]!.error).toContain("not in the input catalog");
    expect(fitted.doc.results).toHaveLength(0);
  });

  test("a round whose targets alone overrun the budget is skipped, never a lost 180s seat", async () => {
    const oversized = maxSizeInput();
    oversized.targets[0]!.original.body = "x".repeat(RECHECK_ASSIGNMENT_MAX_BYTES);
    seatResult = { stderr: "", structuredOutput: { source: "caller", mode: "strict", status: "unavailable" } };
    const { doc: seatDoc, status } = await runRecheckSeat({
      session: {} as never,
      input: oversized,
      model: ["test-model"],
      signal: new AbortController().signal,
    });
    expect(seatCalls).toHaveLength(0);
    expect(seatDoc).toBeNull();
    // `budget` = the seat never got room (the same reason the outer deadline
    // uses); the consumer accounts every sent row `unverifiable`/`budget`.
    expect(status).toMatchObject({ outcome: "skipped", reason: "budget" });
    expect(status.error).toContain("context budget");
    expect(status.error!.length).toBeLessThanOrEqual(500);
  });
});
