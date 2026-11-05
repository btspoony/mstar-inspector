/**
 * The recheck seat's yield boundary at the documented input limits.
 *
 * One fake structured-subagent result per case, driven through the REAL
 * `runRecheckSeat` (`packages/runner/src/recheck.ts`), so each candidate mode
 * is pinned to the status the shipped code actually reports:
 *
 *   (a) a valid document over a max-size input survives whole (25/25);
 *   (b) one malformed row among 25 keeps the other 24 (row-level degradation);
 *   (c) an absent yield — the SDK's `unavailable` status with no error text and
 *       the child capped by its own wall clock — loses the whole round as
 *       `seat-failed`, whose message names that cap (I-000431);
 *   (d) a strict-schema rejection ALSO reports `seat-failed`, but carries the
 *       validator text — which is what separates it from (c) in the record;
 *   (e) a document-level distrust (stale HEAD) is `invalid-document`, a
 *       different reason, never `seat-failed`;
 *   (f) a round with no budget is `skipped`/`budget` and starts no seat;
 *   (g) a caller abort is `skipped`/`aborted`, not a blamed round;
 *   (h) with no cap reason and no stderr the message still names the child's
 *       exit code, so no lost round is attributed to nothing at all;
 *   (i) the dispatched cap is the anchored TIER's clock, not the retired fixed
 *       180s — the seat's own timeout was what killed it mid-read;
 *   (j) a late dispatch still clears the contract floor instead of skipping.
 *
 * The budget cases ask the same seat within `RECHECK_ASSIGNMENT_MAX_BYTES`: the
 * documented limits still reach every row, the fit covers rows before it
 * deepens any row, and a round whose target core cannot fit is
 * `skipped`/`budget` with no seat started. The yield is validated against the
 * catalog the seat RECEIVED, so a citation of a slice the fit omitted drops
 * that row instead of counting it `addressed`.
 *
 * No case returns `doc: null` with `outcome: "ok"`/`reason: null` — a lost
 * round is always attributable. The consumer's row accounting for (c)/(e) is
 * pinned by tests/pipeline/consumer-recheck-status.test.ts ("a failed seat
 * status with no document makes the round attributable").
 *
 * The fake seat rides the `runSeat` seam `runRecheckSeat` takes: this file
 * installs no `mock.module`, so it cannot leak a stub into a sibling file
 * whose imports resolve the same SDK specifier.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PR_REVIEW_TIER_BUDGETS } from "@mstar-harness/engine";
import type { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import {
  MODEL_ITEM_MAX_CHARS,
  MODEL_MAX_ITEMS,
  MODEL_TOTAL_MAX_CHARS,
  RECHECK_MAX_RUNTIME_MS,
  RECHECK_MAX_TARGETS,
  RECHECK_MIN_REMAINING_MS,
  RECHECK_STATUS_ERROR_MAX_CHARS,
  validateRecheckDoc,
  type EvidenceSlice,
  type RecheckInput,
} from "../../packages/shared/src/recheck-wire";
import {
  anchorRecheckDeadline,
  fitRecheckInput,
  OUTER_RUNNER_CAP_MS,
  RECHECK_ASSIGNMENT_MAX_BYTES,
  RECHECK_PUBLICATION_TAIL_MS,
  resetRecheckAnchor,
  runRecheckSeat,
} from "../../packages/runner/src/recheck";

/** The SDK's settled `SingleResult` slice `runRecheckSeat` reads. */
type FakeSeatResult = {
  error?: string;
  /** The child's own exit code; defaulted from `error` when unset. */
  exitCode?: number;
  /** The SDK's cap reason, set when the child's wall clock stopped it. */
  abortReason?: string;
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
const seatCalls: { assignment: string; maxRuntimeMs?: number }[] = [];

/**
 * The injected seat seam: it records the ask and answers from the per-case
 * state above, returning the settled `SingleResult` shape `runRecheckSeat`
 * reads. `runRecheckSeat` defaults to the real SDK call, so production is
 * unaffected by this file. The cast keeps the SDK's full result shape out of
 * this file — the fake answers only the slice the seat reads.
 */
const fakeRunSeat = (async (request: { assignment: string; maxRuntimeMs?: number }) => {
  seatCalls.push(request);
  if (seatReject !== null) throw seatReject;
  const reply = seatAnswer === null ? seatResult : seatAnswer(askedDocument(request.assignment));
  return {
    result: {
      index: 0,
      id: `seat-${seatCalls.length}`,
      agent: "mstar-review-seat",
      exitCode: reply.exitCode ?? (reply.error !== undefined ? 1 : 0),
      output: "",
      stderr: reply.stderr,
      error: reply.error,
      abortReason: reply.abortReason,
      structuredOutput: reply.structuredOutput,
    },
    policy: {},
    mergeSummary: "",
    changesApplied: null,
    artifactsDir: "/tmp/fake-artifacts",
    temporaryArtifacts: true,
  };
}) as unknown as typeof runStructuredSubagent;

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
        ownAuthor: false,
      })),
      issueCoverage: "truncated" as const,
      issueModelCoverage: "complete" as const,
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

async function run(signal = new AbortController().signal) {
  return runRecheckSeat({ session: {} as never, input: INPUT, model: ["test-model"], signal, runSeat: fakeRunSeat });
}

describe("recheck seat yield at the documented input limits", () => {
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

  test("(c) an absent yield loses the whole round: seat-failed naming the child's cap", async () => {
    // The recorded production signature (I-000431): no payload, non-zero child
    // exit, no stderr — the SDK reports `unavailable` with no error text, so
    // the child's own `abortReason` is the only attribution there is.
    seatResult = {
      stderr: "",
      exitCode: 1,
      abortReason: "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)",
      structuredOutput: { source: "caller", mode: "strict", status: "unavailable" },
    };
    const { doc: seatDoc, status } = await run();
    expect(seatDoc).toBeNull();
    expect(status.outcome).toBe("failed");
    expect(status.reason).toBe("seat-failed");
    expect(status.error).toBe(
      "recheck seat produced no valid structured output (status unavailable): " +
        "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)",
    );
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
    // The durable status names the cause, so a tail skip is never confused
    // with a round that could not fit its own ask.
    expect(status.error).toContain("(tail)");
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

  test("(h) no cap reason and no stderr still names the child's exit code", async () => {
    // Fails-first for I-000431's attribution: with neither a cap reason nor
    // stderr, the old chain recorded a bare "(status unavailable)" and D1 could
    // not tell a capped seat from an empty one.
    seatResult = {
      stderr: "",
      exitCode: 1,
      structuredOutput: { source: "caller", mode: "strict", status: "unavailable" },
    };
    const { status } = await run();
    expect(status.reason).toBe("seat-failed");
    expect(status.error).toBe("recheck seat produced no valid structured output (status unavailable): exit 1");
  });
});

describe("the recheck seat's wall clock comes from the anchored tier", () => {
  beforeEach(() => {
    resetRecheckAnchor();
    seatCalls.length = 0;
  });

  afterEach(() => {
    resetRecheckAnchor();
  });

  test("(i) the dispatched cap is the tier's clock, not the retired fixed 180s", async () => {
    anchorRecheckDeadline(Date.now(), "default");
    seatResult = { stderr: "", structuredOutput: { source: "caller", mode: "strict", status: "valid", data: doc([]) } };
    await run();
    expect(seatCalls).toHaveLength(1);
    const cap = seatCalls[0]!.maxRuntimeMs!;
    // A round re-reads up to 25 published findings, so it gets the review
    // seats' own allowance — bounded by the outer guard's publication tail.
    expect(cap).toBeGreaterThan(RECHECK_MAX_RUNTIME_MS);
    expect(cap).toBeLessThanOrEqual(
      Math.min(
        PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes * 60_000,
        OUTER_RUNNER_CAP_MS.default - RECHECK_PUBLICATION_TAIL_MS,
      ),
    );
  });

  test("(j) a late dispatch keeps the contract floor instead of skipping", async () => {
    // 100s of the outer guard left: the publication tail takes 60s, leaving 40s
    // — above the 30s floor, so the seat is dispatched rather than skipped.
    anchorRecheckDeadline(Date.now() - OUTER_RUNNER_CAP_MS.default + 100_000, "default");
    seatResult = { stderr: "", structuredOutput: { source: "caller", mode: "strict", status: "valid", data: doc([]) } };
    const { status } = await run();
    expect(status.outcome).not.toBe("skipped");
    expect(seatCalls).toHaveLength(1);
    const cap = seatCalls[0]!.maxRuntimeMs!;
    expect(cap).toBeGreaterThanOrEqual(RECHECK_MIN_REMAINING_MS);
    expect(cap).toBeLessThan(60_000);
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

describe("the ask fits the seat's context budget", () => {
  test("a max-size round is asked inside the budget, every row still reachable", async () => {
    // The observed failure mode: the max-size fixture is a multi-hundred-KB
    // JSON ask, ~4x the 64 KiB budget, so the seat used to be handed far more
    // prompt than it could hold. The RCA could not separate that from the
    // seat's own time cap, so this test does not claim a proven cause — it
    // pins the mitigation: the ask is FITTED, and whatever the cause, no row
    // is sent an unbounded document.
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

    // Rebuild the documented order from THIS fixture: one slice per row first —
    // every slice in a row's file starts at the same line here, so the nearest
    // one is that file's first catalog entry — then every remaining slice in
    // catalog order. The fit `continue`s past a slice that does not fit, so the
    // ask is an ordered SUBSEQUENCE of that order: the budget can drop a slice
    // but never reorder the ones it keeps, and a slice that fits is kept even
    // when an earlier, larger one was dropped.
    const firstPerRow = INPUT.targets.map(
      (target) => INPUT.evidence.find((slice) => slice.path === target.original.filePath)!,
    );
    const expected = [...firstPerRow, ...INPUT.evidence.filter((slice) => !firstPerRow.includes(slice))];
    // The budget actually BIT here: without this the subsequence check below
    // would pass on an untruncated ask and stop pinning the fit at all.
    expect(asked.evidence.length).toBeLessThan(INPUT.evidence.length);
    // Slices arrive parsed, so match by id rather than by reference.
    const position = new Map(expected.map((slice, index) => [slice.id, index]));
    let at = -1;
    for (const slice of asked.evidence) {
      const next = position.get(slice.id)!;
      expect(next).toBeGreaterThan(at);
      expect(expected[next]).toEqual(slice);
      at = next;
    }
    // No row vanished from the ask either: fitting drops evidence, never a target.
    expect(asked.targets.map((target) => target.rowId)).toEqual(INPUT.targets.map((target) => target.rowId));
    // Every retained slice still covers a distinct row, so the ask reaches rows
    // once each before deepening any of them.
    expect(new Set(asked.evidence.map((slice) => slice.path)).size).toBe(asked.evidence.length);
  });

  test("an oversized slice is skipped past, not stopped at: a later row's smaller slice still fits", () => {
    // `evidenceOrder` takes each row's own-file slice in row order, so the
    // LARGE slice (first row) sorts before the SMALL one (second row). The
    // budget below admits the core plus ONLY the small slice: a fit that
    // `continue`s past the large slice keeps the small one, a fit that
    // `break`s loses it. The max-size fixture cannot show this — its slices
    // are all the same size, so both loop exits produce the same ask.
    const sliceAt = (id: string, path: string, lines: number): EvidenceSlice => ({
      id,
      headSha: SHA,
      baseSha: "b" + "0".repeat(39),
      path,
      oldPath: null,
      kind: "hunk",
      oldStart: 1,
      oldLines: Array.from(
        { length: lines },
        (_, index) => `const oldValue_${id}_${index} = computeSomething("srcreaper.ts", ${index}); // srcreaper-core-module`,
      ),
      newStart: 1,
      newLines: Array.from(
        { length: lines },
        (_, index) => `const newValue_${id}_${index} = computeSomething("srcreaper.ts", ${index}); // srcreaper-core-module`,
      ),
      addedNewLines: [1],
      oldBlobOid: "oid-old",
      headBlobOid: "oid-head",
      absentAtHead: false,
      complete: true,
    });
    const largeSlice = sliceAt("slice-large", "src/large.ts", 80);
    const smallSlice = sliceAt("slice-small", "src/small.ts", 1);
    const target = (rowId: string, filePath: string) => ({
      rowId,
      findingId: `f-${rowId}`,
      original: {
        title: `Prior finding ${rowId}`,
        body: `The previously published concern ${rowId}.`,
        filePath,
        lineStart: 1,
        lineEnd: 1,
        mergeClass: "must-fix" as const,
        category: "logic",
        fingerprintHint: `fp-${rowId}`,
      },
      firstSeenSha: SHA,
      lastAssessment: null,
      associationIds: [`assoc-${rowId}`],
    });
    const input: RecheckInput = {
      schema: "mstar.recheck-input/v1",
      headSha: SHA,
      targets: [target("row-large", "src/large.ts"), target("row-small", "src/small.ts")],
      evidence: [largeSlice, smallSlice],
      discussion: { items: [], issueCoverage: "complete", issueModelCoverage: "complete", issueDigest: "digest-1", capturedMs: 0, threads: [] },
    };
    // At a zero budget the core (targets + discussion) overruns, and the
    // refusal names the smallest budget that holds it. One small slice's
    // bytes above that admits the small slice and not the 80-line one.
    const probe = fitRecheckInput(input, 0);
    if (probe.ok) throw new Error("the fixture's core fits a zero budget");
    const smallBytes = Buffer.byteLength(JSON.stringify(smallSlice));
    const fit = fitRecheckInput(input, probe.requiredBytes + smallBytes);
    if (!fit.ok) throw new Error("the fixture's core does not fit its own required budget");
    expect(fit.input.evidence.map((slice) => slice.id)).toEqual([smallSlice.id]);
    expect(fit.omittedSlices).toBe(1);
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
      runSeat: fakeRunSeat,
    });
    expect(seatCalls).toHaveLength(0);
    expect(seatDoc).toBeNull();
    // `budget` = the seat never got room (the same reason the outer deadline
    // uses); the consumer accounts every sent row `unverifiable`/`budget`.
    expect(status).toMatchObject({ outcome: "skipped", reason: "budget" });
    expect(status.error).toContain("context budget");
    expect(status.error!.length).toBeLessThanOrEqual(RECHECK_STATUS_ERROR_MAX_CHARS);
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
      runSeat: fakeRunSeat,
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
      runSeat: fakeRunSeat,
    });
    expect(seatCalls).toHaveLength(0);
    expect(seatDoc).toBeNull();
    expect(status).toMatchObject({ outcome: "skipped", reason: "budget" });
    expect(status.error).toContain("(config)");
    expect(status.error).toContain("at least");
    expect(status.error).toContain("the budget is 8192");
  });

  test("a fitted ask and both budget skips leave an attributable record", async () => {
    /** The structured JSON lines the seat writes to stderr during `body`. */
    const errorsOf = async (body: () => Promise<unknown>) => {
      const written: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        written.push(args.map(String).join(" "));
      };
      try {
        await body();
      } finally {
        console.error = original;
      }
      return written.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
    };

    // A fitted ask still runs, so it must say what the budget starved.
    seatResult = answerAll(INPUT);
    const fitted = await errorsOf(() => run());
    const asked = askedDocument(seatCalls[0]!.assignment);
    expect(fitted).toContainEqual({
      event: "recheck_fitted",
      omitted: INPUT.evidence.length - asked.evidence.length,
      budget: RECHECK_ASSIGNMENT_MAX_BYTES,
    });

    // Permanent: no tail state can fit this ask — the operator's budget is
    // too small, so the skip names itself instead of looking transient.
    const starved = await errorsOf(() =>
      runRecheckSeat({
        session: {} as never,
        input: INPUT,
        model: ["test-model"],
        signal: new AbortController().signal,
        assignmentMaxBytes: 8_192,
        runSeat: fakeRunSeat,
      }),
    );
    expect(starved.find((line) => line.event === "recheck_skipped")).toMatchObject({
      reason: "budget",
      cause: "config",
    });

    // Transient: the outer deadline is already spent — re-evaluated next round.
    anchorRecheckDeadline(Date.now() - OUTER_RUNNER_CAP_MS.default + 10_000, "default");
    const tail = await errorsOf(() => run());
    expect(tail.find((line) => line.event === "recheck_skipped")).toMatchObject({
      reason: "budget",
      cause: "tail",
    });
  });
});
