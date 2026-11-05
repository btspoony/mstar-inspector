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
 * target core cannot fit is `skipped`/`budget` with no seat started. The
 * yield is validated against the catalog the seat RECEIVED, so a citation of
 * a slice the fit omitted drops that row instead of counting it `addressed`.
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

import * as realStructuredSubagent from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import {
  MODEL_ITEM_MAX_CHARS,
  MODEL_MAX_ITEMS,
  MODEL_TOTAL_MAX_CHARS,
  RECHECK_MAX_TARGETS,
  validateRecheckDoc,
  type EvidenceSlice,
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
/** Set when the answer depends on the assignment the seat was actually handed. */
let seatAnswer: ((asked: RecheckInput) => FakeSeatResult) | null = null;
/** Set to model a seat the caller's abort signal rejects before it settles. */
let seatReject: Error | null = null;
const seatCalls: { assignment: string }[] = [];

// The real namespace is spread into the stub: Bun's module-mock registry is
// process-global, so a replacement that dropped the SDK's other exports made
// every sibling importing them (the SDK barrel's
// `buildStructuredSubagentRecoveryHint`) fail to link.
mock.module("@oh-my-pi/pi-coding-agent/task/structured-subagent", () => ({
  ...realStructuredSubagent,
  runStructuredSubagent: mock(async (request: { assignment: string }) => {
    seatCalls.push(request);
    if (seatReject !== null) throw seatReject;
    const reply = seatAnswer === null ? seatResult : seatAnswer(askedDocument(request.assignment));
    return {
      result: {
        index: 0,
        id: `seat-${seatCalls.length}`,
        agent: "mstar-review-seat",
        exitCode: reply.error !== undefined ? 1 : 0,
        output: "",
        stderr: reply.stderr,
        error: reply.error,
        structuredOutput: reply.structuredOutput,
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
    assignmentMaxBytes?: number;
  }) => Promise<{ doc: { results: { rowId: string; disposition: string; reason: string; evidence: { sliceId: string } | null }[] } | null; status: { outcome: string; reason: RecheckStatusReason | null; error: string | null; rejected: number; rejected_row_ids: string[]; rejected_unnamed: number } }>;
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
  seatAnswer = null;
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

/** An `addressed`/`verified-fix` row citing the first added line of `slice`. */
function addressedRow(rowId: string, slice: EvidenceSlice): Record<string, unknown> {
  const line = slice.newStart;
  return {
    rowId,
    disposition: "addressed",
    reason: "verified-fix",
    evidence: {
      kind: "current-code",
      sliceId: slice.id,
      startLine: line,
      endLine: line,
      quote: slice.newLines[0]!,
      explanation: "the added line bounds the recursion depth",
    },
    relatedCurrentFindingIndexes: [],
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

  test("a citation of a slice the fit omitted drops that row instead of publishing it addressed", async () => {
    // The fit drops whole slices, so some row's file retains none: the ask
    // gives that row no provable context at all.
    let starvedRowId = "";
    seatAnswer = (asked) => {
      const starved = asked.targets.find(
        (target) => !asked.evidence.some((slice) => slice.path === target.original.filePath),
      );
      if (starved === undefined) throw new Error("the fit starved no row");
      const omitted = INPUT.evidence.find(
        (slice) => slice.path === starved.original.filePath && slice.addedNewLines.includes(slice.newStart),
      )!;
      starvedRowId = starved.rowId;
      const claimed = asked.targets.map((target) =>
        target.rowId === starved.rowId ? addressedRow(target.rowId, omitted) : row(target.rowId),
      );
      // The citation is well-formed proof against the round's FULL catalog,
      // so only the catalog the seat actually received can reject it.
      const full = validateRecheckDoc(doc(claimed), INPUT);
      if (!full.ok) throw new Error(full.error);
      if (full.rejected.length > 0) throw new Error(full.rejected[0]!.error);
      return {
        stderr: "",
        structuredOutput: { source: "caller", mode: "strict", status: "valid", data: doc(claimed) },
      };
    };

    const { doc: seatDoc, status } = await run();
    expect(seatCalls).toHaveLength(1);
    // A row the fit starved cannot be closed by evidence it never received:
    // the row is dropped, and nothing survives as `addressed`.
    expect(seatDoc!.results.map((result) => result.rowId)).not.toContain(starvedRowId);
    expect(seatDoc!.results.some((result) => result.disposition === "addressed")).toBe(false);
    expect(seatDoc!.results).toHaveLength(RECHECK_MAX_TARGETS - 1);
    // The rest of the round is served; the drop is attributed to that row.
    expect(status).toMatchObject({
      outcome: "ok",
      reason: null,
      rejected: 1,
      rejected_row_ids: [starvedRowId],
      rejected_unnamed: 0,
    });
  });

  test("a citation of a slice the seat received publishes the row as addressed", async () => {
    let servedRowId = "";
    let retainedSliceId = "";
    seatAnswer = (asked) => {
      const served = asked.targets.find((target) =>
        asked.evidence.some((slice) => slice.path === target.original.filePath),
      );
      if (served === undefined) throw new Error("the fit served no row");
      const retained = asked.evidence.find(
        (slice) => slice.path === served.original.filePath && slice.addedNewLines.includes(slice.newStart),
      )!;
      servedRowId = served.rowId;
      retainedSliceId = retained.id;
      const claimed = asked.targets.map((target) =>
        target.rowId === served.rowId ? addressedRow(target.rowId, retained) : row(target.rowId),
      );
      return {
        stderr: "",
        structuredOutput: { source: "caller", mode: "strict", status: "valid", data: doc(claimed) },
      };
    };

    const { doc: seatDoc, status } = await run();
    const published = seatDoc!.results.find((result) => result.rowId === servedRowId);
    expect(published?.disposition).toBe("addressed");
    expect(published?.reason).toBe("verified-fix");
    expect(published?.evidence?.sliceId).toBe(retainedSliceId);
    expect(seatDoc!.results).toHaveLength(RECHECK_MAX_TARGETS);
    expect(status).toMatchObject({
      outcome: "ok",
      reason: null,
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 0,
    });
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

describe("the ask budget is the operator's setting, not a runner constant", () => {
  test("a larger budget retains more slices than the documented default", async () => {
    // The documented default (65,536 B) fits a fraction of the catalog.
    seatResult = answerAll(INPUT);
    await run();
    const defaultRetained = askedDocument(seatCalls[0]!.assignment).evidence.length;
    seatCalls.length = 0;

    // At the setting's ceiling the same round nearly fits whole.
    seatResult = answerAll(INPUT);
    const { status } = await runRecheckSeat({
      session: {} as never,
      input: INPUT,
      model: ["test-model"],
      signal: new AbortController().signal,
      assignmentMaxBytes: 262_144,
    });
    expect(seatCalls).toHaveLength(1);
    const assignment = seatCalls[0]!.assignment;
    expect(Buffer.byteLength(assignment)).toBeLessThanOrEqual(262_144);
    expect(askedDocument(assignment).evidence.length).toBeGreaterThan(defaultRetained);
    expect(status).toMatchObject({ outcome: "ok", reason: null });
  });

  test("a smaller budget trips the skipped/budget path before any seat starts", async () => {
    // 8,192 B cannot hold this round's target core plus discussion, so the
    // round is skipped instead of dispatching a seat that cannot hold the ask.
    seatResult = {
      stderr: "",
      structuredOutput: { source: "caller", mode: "strict", status: "unavailable" },
    };
    const { doc: seatDoc, status } = await runRecheckSeat({
      session: {} as never,
      input: INPUT,
      model: ["test-model"],
      signal: new AbortController().signal,
      assignmentMaxBytes: 8_192,
    });
    expect(seatCalls).toHaveLength(0);
    expect(seatDoc).toBeNull();
    expect(status).toMatchObject({ outcome: "skipped", reason: "budget" });
    expect(status.error).toContain("at least");
    expect(status.error).toContain("the budget is 8192");
  });
});
