/**
 * Consumer recheck-round STATUS and per-row accounting (spec §7.7/§7.10): the
 * seat's status document, the reasons each selected row ends the round with,
 * and the D1/log attribution that makes a lost round visible.
 *
 * Sibling files cover the trusted evidence catalog (`consumer-recheck-catalog`)
 * and the conservative precedence guards (`consumer-recheck-precedence`); the
 * doubles, D1 seeders and payload builders come from
 * ../helpers/consumer-harness, shared by all three.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  ASSESSMENT_TARGET_CAP,
  fitRecheckInput,
  RECHECK_ASSIGNMENT_MAX_BYTES,
  RECHECK_ASSIGNMENT_PROSE_BYTES,
  RECHECK_STATUS_ERROR_MAX_CHARS,
  type Discussion,
  type RecheckInput,
} from "../../packages/shared/src/recheck-wire";
import { RECHECK_ASSIGNMENT_KEY, RECHECK_ASSIGNMENT_MIN } from "../../src/dashboard/runtime-config-store";
import { REDACTED } from "../../src/pipeline/redact";
import {
  ASSOC_ID,
  SHA,
  TARGET_ORIGINAL,
  TARGET_ROW_ID,
  VALID_DIFF,
  VALID_OUTPUT,
  createSeededTestD1,
  recheckDocWith,
  seedAssociation,
  seedOpenTarget,
  seedPriorPublication,
} from "../helpers/consumer-fixtures";
import {
  coverageLine,
  coverageLineNumbers,
  createConsumerHarness,
  failureRows,
  loadConsumer,
  makePayload,
} from "../helpers/consumer-harness";

const { createReviewConsumer } = await loadConsumer();

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

// --- the assignment budget's fitting (spec §7.3/§7.8) -----------------------
// The seat's ask is FITTED to `review.recheck.assignment_max_bytes`, not
// measured against it: targets ride in rotation order up to the budget, a row
// that does not fit is never sent (and never advances the rotation), and one
// oversized target ships with a bounded body instead of losing the round.

/** A harness slice the wire helpers read (the sandbox double records the runner input). */
type WireHarness = { sandbox: { writtenInputJson: string | undefined } };
type SeededDb = Awaited<ReturnType<typeof createSeededTestD1>>;

/** UTF-8 byte length of one JSON value — the accounting every cap uses. */
function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** The recheck document + budget this round actually put on the wire. */
function wireRecheck(harness: WireHarness): { recheck: RecheckInput | undefined; budget: number | undefined } {
  const written = harness.sandbox.writtenInputJson;
  if (written === undefined) throw new Error("the round wrote no runner input");
  const input = JSON.parse(written) as { recheck?: RecheckInput; recheckAssignmentMaxBytes?: number };
  return { recheck: input.recheck, budget: input.recheckAssignmentMaxBytes };
}

/** Store the operator's ask budget — the one adjustable cap of this fit. */
async function setAssignmentBudget(db: SeededDb, maxBytes: number): Promise<void> {
  db.raw
    .prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run(RECHECK_ASSIGNMENT_KEY, String(maxBytes), new Date().toISOString());
}

/**
 * A discussion as large as the §7.8 model caps allow: seven ~1,120-char issue
 * items stay inside the 50-item / 1,200-char / 8,000-char caps (so its coverage
 * stays `complete`) and serialize to roughly 9.5 KiB — the discussion half of
 * the staging-shaped ask.
 */
function bigDiscussion(): Discussion {
  return {
    items: Array.from({ length: 7 }, (_, index) => ({
      source: "issue" as const,
      associationId: null,
      id: `issue-comment-${index}`,
      author: `reviewer-${index}`,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      body: "detail ".repeat(160),
      ownAuthor: false,
    })),
    issueCoverage: "complete",
    issueModelCoverage: "complete",
    issueDigest: "issue-digest",
    capturedMs: 0,
    threads: [],
  };
}

/**
 * `count` open rows in rotation order (`created_ms` and id both ascending), all
 * on the seeded diff's own file so every one is catalog-provable. Returns the
 * row ids in that order.
 */
async function seedRotation(db: SeededDb, count: number, bodyChars: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const rowId = `rotation-row-${String(index).padStart(2, "0")}`;
    ids.push(rowId);
    await seedOpenTarget(db, {
      rowId,
      findingId: `rotation-finding-${index}`,
      original: {
        body: "y".repeat(bodyChars),
        filePath: "src/auth.ts",
        lineStart: 21,
        lineEnd: 21,
        fingerprintHint: `rotation-fp-${index}`,
      },
      nowMs: 2_000 + index,
    });
  }
  return ids;
}

describe("recheck round attribution — status and row accounting (§7.7/§7.4/§7.10)", () => {
  test("a failed seat status with no document makes the round attributable: every row invalid-output, one recheck failure row", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The seat never wrote a document and said why.
    h.sandbox.recheckFileContent = "";
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "failed",
      reason: "seat-failed",
      rejected: 0,
      rejected_row_ids: [],
      error: "session aborted",
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    // ONE failure row, naming the round and carrying the status triple.
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    expect(String(rows[0]!.error)).toBe("failed: seat-failed: session aborted");
    // The single accounting line carries the structured attribution.
    const line = h.logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    expect(line.level).toBe("warn");
    expect(line.fields).toMatchObject({
      recheck_outcome: "failed",
      recheck_reason: "seat-failed",
      recheck_error: "session aborted",
      rejected: 0,
      assessed: 0,
    });
  });

  test("a large round whose document is lost reports the per-reason split, never a bare `Reassessed 0/25`", async () => {
    // The RCA's mode (I-000396): on a large round the seat's structured yield
    // never arrives. Every selected row WAS sent into the round, so the
    // published line must name the loss per reason rather than print a bare
    // `Reassessed 0/25` that leaves the operator unable to tell a lost seat
    // from a round that never ran.
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = "";
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "failed",
      reason: "seat-failed",
      rejected: 0,
      rejected_row_ids: [],
      error: "structured output unavailable",
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    // The full selection cap: the largest round the wire and the table carry.
    for (let i = 0; i < ASSESSMENT_TARGET_CAP; i += 1) {
      await seedOpenTarget(db, {
        rowId: `lost-round-row-${i}`,
        findingId: `lost-finding-${i}`,
        original: { fingerprintHint: `lost-fp-${i}` },
        nowMs: 2_000 + i,
      });
    }
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // Every sent row is answered-nothing, so all 25 land in `invalid-output`
    // and none is mistaken for a row the round never attempted.
    const expectedCoverage = { assessed: 0, selected: 25, invalidOutput: 25, omitted: 0 };
    expect(prepared.body).toContain(coverageLine(expectedCoverage));
    // The line's identity, read back from the published text: every selected
    // row is accounted exactly once.
    const coverage = coverageLineNumbers(prepared.body)!;
    expect(coverage).toEqual(expectedCoverage);
    expect(coverage.assessed + coverage.invalidOutput + coverage.omitted).toBe(coverage.selected);
    // …and no row vanished from the table that renders the same verdicts.
    const priorSection = prepared.body.slice(prepared.body.indexOf("<summary>Revalidated findings</summary>"));
    expect(priorSection.split("\n").filter((line) => line.includes("| unverifiable (invalid-output) "))).toHaveLength(25);
    // ONE failure row names the lost round, whatever the round's size.
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    expect(String(rows[0]!.error)).toBe("failed: seat-failed: structured output unavailable");
    const line = h.logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    expect(line.fields).toMatchObject({
      recheck_outcome: "failed",
      recheck_reason: "seat-failed",
      rejected: 0,
      assessed: 0,
    });
  });

  test("rejected rows of an accepted document are invalid-output, never omitted; the rest still assess", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    // 25 selected rows: 23 the seat answers assessably, 2 it answers badly.
    const seeded: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const rowId = `rejected-case-row-${i}`;
      seeded.push(rowId);
      await seedOpenTarget(db, {
        rowId,
        findingId: `finding-${i}`,
        original: { fingerprintHint: `old-fp-${i}` },
        nowMs: 2_000 + i,
      });
    }
    const rejectedRowIds = [seeded[0]!, seeded[1]!];
    const assessableRowIds = seeded.slice(2);
    // The seat writes the ALREADY-FILTERED document: the rows its gate dropped
    // are gone from `results`, so a second validation pass cannot recover them.
    // The status's `rejected_row_ids` is the only record, and the reconciliation
    // must still name them `invalid-output`.
    h.sandbox.recheckFileContent = JSON.stringify({
      schema: "mstar.recheck/v1",
      headSha: SHA,
      results: assessableRowIds.map((rowId) => ({
        rowId,
        disposition: "unverifiable",
        reason: "no-evidence",
        evidence: null,
        relatedCurrentFindingIndexes: [],
      })),
    });
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "ok",
      reason: null,
      // The seat's own count is untrustworthy (and here simply wrong): the
      // logged `rejected` must come from the sent-row union, not this number.
      rejected: 99,
      rejected_row_ids: rejectedRowIds,
      error: null,
    });
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // All 25 rows were ATTEMPTED — 23 answered assessably, 2 answered badly and
    // gate-dropped — so every one advances its rotation clock. The published
    // coverage counts the REAL seat answers only (23), so a gate-rejected row
    // never inflates the reassessed tally; it is published as its own
    // `invalid-output` term instead of vanishing, and nothing was omitted.
    expect(prepared.body).toContain("Reassessed 23/25 prior finding(s)");
    expect(prepared.body).toContain("2 invalid-output · 0 omitted");
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("unverifiable (omitted)");
    // Every attempted row persisted a round row, gate-dropped ones included.
    const roundRows = db.raw.query("SELECT finding_row_id FROM review_finding_rounds").all() as Array<{
      finding_row_id: string;
    }>;
    expect(roundRows).toHaveLength(25);
    const persisted = new Set(roundRows.map((r) => r.finding_row_id));
    for (const rowId of assessableRowIds) expect(persisted.has(rowId)).toBe(true);
    for (const rowId of rejectedRowIds) expect(persisted.has(rowId)).toBe(true);
    // …and the dropped pair carries the real cause, never a fabricated closure,
    // with its rotation clock advanced (it WAS attempted).
    const rejectedRounds = db.raw
      .query(`SELECT assessment_json FROM review_finding_rounds WHERE finding_row_id IN (?, ?)`)
      .all(rejectedRowIds[0]!, rejectedRowIds[1]!) as Array<{ assessment_json: string }>;
    expect(rejectedRounds).toHaveLength(2);
    for (const row of rejectedRounds) {
      expect(JSON.parse(row.assessment_json)).toMatchObject({
        disposition: "unverifiable",
        reason: "invalid-output",
      });
    }
    const clocks = db.raw
      .query(`SELECT id, last_assessed_ms FROM review_findings WHERE id IN (?, ?)`)
      .all(rejectedRowIds[0]!, rejectedRowIds[1]!) as Array<{ id: string; last_assessed_ms: number | null }>;
    // Count first: `.every()` over an empty result would pass vacuously and
    // prove nothing about either clock.
    expect(clocks.map((row) => row.id).sort()).toEqual([...rejectedRowIds].sort());
    expect(clocks.map((row) => row.last_assessed_ms).every((ms) => ms !== null)).toBe(true);
    // A usable document means no failure row.
    expect(failureRows(db)).toHaveLength(0);
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    // `assessed` is the published coverage count (real answers), not the
    // lifecycle clock — the two gate-dropped rows do not count as reassessed.
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 2, assessed: 23 });
  });

  test("a budget-skipped round accounts every row as budget, never invalid-output", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The budget left no room, so the seat never ran: it wrote a status and
    // no document. The row was not answered badly — nobody asked — so the
    // reason is `budget`, not `invalid-output`.
    h.sandbox.recheckFileContent = "";
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "skipped",
      reason: "budget",
      rejected: 0,
      rejected_row_ids: [],
      error: null,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (budget)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    // Still attributable, and still open: nothing was assessed.
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    // Attributable to the budget skip: the row is skipped for `budget`, and the
    // third segment (the seat's own error) is the producer's to format.
    expect(String(rows[0]!.error)).toMatch(/^skipped: budget:/);
    const line = h.logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "skipped", recheck_reason: "budget", assessed: 0 });
    const findingRow = db.raw.query("SELECT state, last_assessed_ms FROM review_findings").get() as {
      state: string;
      last_assessed_ms: number | null;
    };
    expect(findingRow.state).toBe("open");
    expect(findingRow.last_assessed_ms).toBeNull();
  });

  test("an ask that cannot fit the seat's context budget accounts every sent row as budget, none dropped", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The runner built the input, then refused to dispatch: targets + discussion
    // alone overrun the seat's context budget. Every selected row WAS sent into
    // the round and answered by nobody, so each lands on `budget` — never
    // `invalid-output` (no one asked) and never a silent drop.
    const askFitError =
      "recheck assignment exceeds the seat's context budget: targets + discussion need at least 90000 bytes, the budget is 65536";
    h.sandbox.recheckFileContent = "";
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "skipped",
      reason: "budget",
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 0,
      error: askFitError,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    const rowIds = ["ask-fit-row-0", "ask-fit-row-1", "ask-fit-row-2"];
    for (const [i, rowId] of rowIds.entries()) {
      await seedOpenTarget(db, {
        rowId,
        findingId: `ask-fit-finding-${i}`,
        original: { fingerprintHint: `ask-fit-fp-${i}` },
        nowMs: 2_000 + i,
      });
    }
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // Every sent row is accounted in the table; none is blamed on the seat.
    const priorSection = prepared.body.slice(prepared.body.indexOf("<summary>Revalidated findings</summary>"));
    expect(priorSection.split("\n").filter((line) => line.includes("| unverifiable (budget) "))).toHaveLength(3);
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    const coverage = coverageLineNumbers(prepared.body)!;
    expect(coverage).toEqual({ assessed: 0, selected: 3, invalidOutput: 0, omitted: 3 });
    expect(coverage.assessed + coverage.invalidOutput + coverage.omitted).toBe(coverage.selected);
    // The skip is attributable once, and the rows stay open and unassessed.
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    expect(String(rows[0]!.error)).toBe(`skipped: budget: ${askFitError}`);
    const clocks = (
      db.raw
        .query("SELECT id, state, last_assessed_ms FROM review_findings ORDER BY id")
        .all() as Array<{ id: string; state: string; last_assessed_ms: number | null }>
    ).filter((row) => rowIds.includes(row.id));
    expect(clocks.map((row) => row.id)).toEqual([...rowIds].sort());
    expect(clocks.every((row) => row.state === "open" && row.last_assessed_ms === null)).toBe(true);
    const line = h.logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    expect(line.fields).toMatchObject({
      recheck_outcome: "skipped",
      recheck_reason: "budget",
      recheck_error: askFitError,
      assessed: 0,
    });
  });

  test("a round the runner cancelled by design is not a failure: rows stay omitted, the clock untouched, no D1 row", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The runner aborts an unfinished seat when the main review settles
    // (spec §7.8). The seat answered nothing because it was STOPPED — not
    // because it ran and lost, so this is neither a failure row nor
    // `invalid-output` for rows nobody asked about.
    h.sandbox.recheckFileContent = "";
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "skipped",
      reason: "aborted",
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 0,
      error: null,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (omitted)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("unverifiable (budget)");
    // A cancellation is not a lost round: no failure row, nothing assessed.
    expect(failureRows(db)).toHaveLength(0);
    const line = h.logLines.find((l) => l.msg.includes("recheck round cancelled by the runner"))!;
    expect(line.fields).toMatchObject({
      recheck_outcome: "skipped",
      recheck_reason: "aborted",
      assessed: 0,
      rejected: 0,
    });
    const findingRow = db.raw.query("SELECT state, last_assessed_ms FROM review_findings").get() as {
      state: string;
      last_assessed_ms: number | null;
    };
    expect(findingRow.state).toBe("open");
    expect(findingRow.last_assessed_ms).toBeNull();
  });

  test("an empty-result round is attributable: every sent row invalid-output, one recheck failure row, rotation clock advanced", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The seat returned a VALID document with zero results while one target was
    // sent: it answered, badly. `omitted` ("never ran") would hide the round.
    h.sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "failed",
      reason: "empty-result",
      rejected: 0,
      rejected_row_ids: [],
      error: null,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("unverifiable (omitted)");
    // The one selected row is accounted by the SAME term the table renders.
    expect(prepared.body).toContain("Reassessed 0/1 prior finding(s)");
    expect(prepared.body).toContain("1 invalid-output · 0 omitted");
    // The round delivered nothing usable, so it is recorded once, named.
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    expect(String(rows[0]!.error)).toBe("failed: empty-result: null");
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "failed", recheck_reason: "empty-result", assessed: 0 });
    // The row WAS sent, so its rotation clock advanced — it is attempted-bad,
    // not never-sent.
    const findingRow = db.raw.query("SELECT state, last_assessed_ms FROM review_findings").get() as {
      state: string;
      last_assessed_ms: number | null;
    };
    expect(findingRow.state).toBe("open");
    expect(findingRow.last_assessed_ms).not.toBeNull();
  });

  test("an empty-result round blames only the rows it sent: a size-budget row keeps its own never-sent reason", async () => {
    // Two catalog-provable rows, one per file; the oversized one loses the
    // §7.3 size budget and never rides the wire, so the empty result says
    // nothing about it.
    h.sandbox.diffStdout = [
      VALID_DIFF,
      "diff --git a/src/other.ts b/src/other.ts",
      "index 3333333..4444444 100644",
      "--- a/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -1,2 +1,3 @@",
      " export const a = 1;",
      "+export const b = 2;",
      " export const c = 3;",
      "",
    ].join("\n");
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "failed",
      reason: "empty-result",
      rejected: 0,
      rejected_row_ids: [],
      error: null,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    const oversizedRowId = "eeeeeeee-0000-4000-8000-000000000006";
    await seedOpenTarget(db, {
      rowId: oversizedRowId,
      findingId: "finding-oversized",
      original: {
        title: "Oversized concern",
        filePath: "src/other.ts",
        lineStart: 1,
        body: "y".repeat(600 * 1024),
      },
      nowMs: 2_100,
    });
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("| Old null deref on the config path | unverifiable (invalid-output) ");
    expect(prepared.body).toContain("| Oversized concern | unverifiable (budget) ");
    // Never sent, so the excluded row's rotation clock stays untouched.
    const excluded = db.raw
      .prepare("SELECT last_assessed_ms FROM review_findings WHERE id = ?")
      .get(oversizedRowId) as { last_assessed_ms: number | null };
    expect(excluded.last_assessed_ms).toBeNull();
  });

  test("an empty-result round keeps a catalog-excluded row on its own reason and clock: only sent rows are blamed", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // Two selected rows: the seeded target is provable from the captured diff,
    // the second row's file never appears there, so only the target rode the
    // wire. The empty result says nothing about the unprovable row.
    h.sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "failed",
      reason: "empty-result",
      rejected: 0,
      rejected_row_ids: [],
      error: null,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    const excludedRowId = "eeeeeeee-0000-4000-8000-000000000007";
    await seedOpenTarget(db, {
      rowId: excludedRowId,
      findingId: "finding-unprovable",
      original: {
        title: "Unprovable concern",
        filePath: "src/elsewhere.ts",
        lineStart: 1,
      },
      nowMs: 2_100,
    });
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // The sent row was attempted and answered badly; the catalog-excluded row
    // keeps `no-evidence` — it was never sent, so the round cannot blame it.
    expect(prepared.body).toContain("| Old null deref on the config path | unverifiable (invalid-output) ");
    expect(prepared.body).toContain("| Unprovable concern | unverifiable (no-evidence) ");
    // The rotation clock follows the same split: the sent row advanced, the
    // never-sent row did not.
    const clocks = db.raw
      .query("SELECT id, last_assessed_ms FROM review_findings ORDER BY id")
      .all() as Array<{ id: string; last_assessed_ms: number | null }>;
    const clockById = new Map(clocks.map((row) => [row.id, row.last_assessed_ms]));
    expect(clockById.get(TARGET_ROW_ID)).not.toBeNull();
    expect(clockById.get(excludedRowId)).toBeNull();
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "failed", recheck_reason: "empty-result", assessed: 0 });
  });

  test("a captured-but-unprovable round blames the capture, not the catalog budget", async () => {
    // The discussion capture failed, so the input is suppressed before the
    // catalog can: the accounting line must name THAT cause, never the §7.3
    // catalog/size-budget exclusion the round never reached.
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.commenterState.discussionError = new Error("discussion API down");
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    const line = h.logLines.find((l) => l.msg.startsWith("recheck round accounted — no input sent"))!;
    expect(line.msg).toContain("lifecycle context capture failed");
    expect(line.msg).not.toContain("§7.3 size budget");
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (context-incomplete)");
    expect(failureRows(db)).toHaveLength(0);
  });

  test("a round no fit can reach sends nothing: rows are budget, and the round is still attributed", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The operator floor (8,192 B) minus the ask's own prose leaves ~4.5 KiB,
    // less than this round's discussion alone — so even one target with an
    // empty body cannot fit, and no recheck input exists at all. The row was
    // never sent — `invalid-output` would blame a seat that never ran.
    h.commenterState.discussion = bigDiscussion();
    const db = await createSeededTestD1();
    await setAssignmentBudget(db, RECHECK_ASSIGNMENT_MIN);
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    // No seat ran: the runner exec must not carry --recheck-out.
    expect(h.sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (budget)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    // Nothing was attempted, so there is no failure to record.
    expect(failureRows(db)).toHaveLength(0);
    // …but the silence is attributable: the round still logs its accounting.
    const line = h.logLines.find((l) => l.msg.startsWith("recheck round accounted — no input sent"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "absent", assessed: 0 });
    const findingRow = db.raw.query("SELECT state, last_assessed_ms, last_scheduled_ms FROM review_findings").get() as {
      state: string;
      last_assessed_ms: number | null;
      last_scheduled_ms: number | null;
    };
    expect(findingRow.state).toBe("open");
    expect(findingRow.last_assessed_ms).toBeNull();
    // Never sent, so the rotation clock stayed put: this row is preferred
    // again on the next round instead of starving behind the rows that fit.
    expect(findingRow.last_scheduled_ms).toBeNull();
    // The runner input carries neither a document nor a budget field.
    const runnerInput = JSON.parse(h.sandbox.writtenInputJson!) as Record<string, unknown>;
    expect(runnerInput.recheck).toBeUndefined();
    expect(runnerInput.recheckAssignmentMaxBytes).toBeUndefined();
  });

  test("a status from another HEAD attributes nothing: the row stays omitted, never invalid-output", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // A usable document that answers nothing, beside a status that DOES claim
    // the sent row as rejected — but for a different HEAD. Trusting it would
    // name a reason this round never established.
    h.sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: "f".repeat(40),
      outcome: "ok",
      reason: null,
      rejected: 1,
      rejected_row_ids: [TARGET_ROW_ID],
      error: null,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (omitted)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    // The foreign status is no attribution at all: `absent`, no rejected ids,
    // and a usable document means no failure row.
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "absent", rejected: 0 });
    expect(failureRows(db)).toHaveLength(0);
  });

  test("a readable status body with a wrong or absent schema is no attribution: the row stays invalid-output, outcome absent", async () => {
    // The gate's other halves: the body READ fine and is not a status this
    // round can attribute. Anything but this round's own
    // `mstar.recheck-status/v1` is `absent` — never a fabricated outcome.
    for (const statusBody of [
      JSON.stringify({ headSha: SHA, outcome: "failed", reason: "seat-failed" }),
      JSON.stringify({ schema: "mstar.recheck-status/v2", headSha: SHA, outcome: "failed", reason: "seat-failed" }),
    ]) {
      h = createConsumerHarness();
      h.sandbox.diffStdout = VALID_DIFF;
      h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
      h.sandbox.recheckFileContent = "";
      h.sandbox.recheckStatusContent = statusBody;
      const db = await createSeededTestD1();
      await seedPriorPublication(db);
      await seedOpenTarget(db);
      await seedAssociation(db, "PRRT_thread1");
      const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

      await consumer(h.makeBatch(makePayload()));

      const line = h.logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
      expect(line.fields).toMatchObject({
        recheck_outcome: "absent",
        recheck_reason: null,
        recheck_error: null,
      });
      // No status → the document is the only evidence, and it is absent: the
      // row is invalid-output and exactly one failure row carries `absent`.
      const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
      expect(prepared.body).toContain("unverifiable (invalid-output)");
      const rows = failureRows(db);
      expect(rows).toHaveLength(1);
      expect(String(rows[0]!.error)).toBe("absent: null: null");
    }
  });

  test("a readable status body that is not JSON at all is no attribution either", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = "";
    // The transport succeeded and handed back bytes that are not a status.
    h.sandbox.recheckStatusContent = "mstar.recheck-status/v1 { truncated";
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const line = h.logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "absent", assessed: 0 });
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(String(failureRows(db)[0]!.error)).toBe("absent: null: null");
  });

  test("a row the document answers AND the status names keeps its real assessment, never invalid-output", async () => {
    // The seat dropped then re-emitted a row: it names the id in its status
    // while the surviving document carries the verdict. The answer wins — the
    // `rejected` branch runs first in the reconciliation, so an unfiltered
    // union would overwrite the assessment and lose the seat's real work.
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = recheckDocWith({});
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "ok",
      reason: null,
      rejected: 1,
      rejected_row_ids: [TARGET_ROW_ID],
      error: null,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("addressed (verified-fix)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    const round = db.raw
      .query(`SELECT assessment_json FROM review_finding_rounds WHERE finding_row_id = ?`)
      .get(TARGET_ROW_ID) as { assessment_json: string } | null;
    expect(JSON.parse(round!.assessment_json)).toMatchObject({ disposition: "addressed", reason: "verified-fix" });
    // Nothing was lost to a drop, so the round reports no rejected row.
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 0, assessed: 1 });
  });

  test("a status naming a row this round never sent cannot attribute it: that id is ignored", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The seat dropped the SENT row from its own document and also named a row
    // from another round. Only the sent-row membership makes a name credible.
    h.sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "ok",
      reason: null,
      rejected: 2,
      rejected_row_ids: [TARGET_ROW_ID, "row-from-another-round"],
      error: null,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("unverifiable (omitted)");
    // The count is the sent-row union: the foreign id never entered it. The
    // SENT row was attempted (the seat answered and the gate dropped it), so
    // it advances its rotation clock — but the document carries no answer for
    // it, so the published coverage counts nothing.
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 1, assessed: 0 });
  });

  test("a gate-rejected row with no usable rowId is still attributed: invalid-output, never omitted", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The seat answered, but its row carries an empty rowId, so the gate drops
    // it without a name. The row is still ATTEMPTED: the reconciliation
    // attributes the drop by position among the SENT-and-unanswered rows, so it
    // is never mistaken for a row that never rode the wire.
    h.sandbox.recheckFileContent = JSON.stringify({
      schema: "mstar.recheck/v1",
      headSha: SHA,
      results: [
        {
          rowId: "",
          disposition: "unverifiable",
          reason: "no-evidence",
          evidence: null,
          relatedCurrentFindingIndexes: [],
        },
      ],
    });
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "ok",
      reason: null,
      rejected: 0,
      rejected_row_ids: [],
      error: null,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("unverifiable (omitted)");
    // No real seat answer survived the gate, so the coverage counts nothing —
    // while the row's rotation clock advanced (it WAS sent).
    expect(prepared.body).toContain("Reassessed 0/1 prior finding(s)");
    const findingRow = db.raw.query("SELECT last_assessed_ms FROM review_findings").get() as {
      last_assessed_ms: number | null;
    };
    expect(findingRow.last_assessed_ms).not.toBeNull();
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    // `rejected` counts the drop the gate could not name; `assessed` counts
    // answers that survived it.
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 1, assessed: 0 });
  });

  test("the status's `rejected_unnamed` attributes a runner-written nameless drop by position", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    // Two sent rows, ordered by their rotation clock: `anonymous-0` first.
    for (let i = 0; i < 2; i += 1) {
      await seedOpenTarget(db, {
        rowId: `anonymous-${i}`,
        findingId: `finding-anon-${i}`,
        original: { fingerprintHint: `anon-fp-${i}` },
        nowMs: 2_000 + i,
      });
    }
    // The seat wrote its ALREADY-FILTERED document, so the second validation
    // pass sees no drops at all: the status is the only record. Its unnamed
    // count is what tells the round that ONE sent row was answered badly.
    h.sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "ok",
      reason: null,
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 1,
      error: null,
    });
    // No association rows: this test is about attribution, not resolution.
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // Exactly ONE row is the attempted-and-bad one — the first among the
    // sent-and-unanswered — and the other is honestly never-answered.
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).toContain("unverifiable (omitted)");
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 1, assessed: 0 });
    // The blamed row advanced its rotation clock; the omitted one did not.
    const clocks = db.raw
      .query(`SELECT id, last_assessed_ms FROM review_findings WHERE id IN ('anonymous-0', 'anonymous-1') ORDER BY id`)
      .all() as Array<{ id: string; last_assessed_ms: number | null }>;
    expect(clocks.map((row) => [row.id, row.last_assessed_ms !== null])).toEqual([
      ["anonymous-0", true],
      ["anonymous-1", false],
    ]);
  });

  test("a `rejected_unnamed` larger than the sent-and-unanswered pool attributes only the pool, and logs the excess", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    // TWO sent rows, both unanswered — the only rows an unnamed drop could
    // legitimately claim.
    for (let i = 0; i < 2; i += 1) {
      await seedOpenTarget(db, {
        rowId: `clamp-${i}`,
        findingId: `finding-clamp-${i}`,
        original: { fingerprintHint: `clamp-fp-${i}` },
        nowMs: 2_000 + i,
      });
    }
    h.sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
    // A seat-authored count with no ceiling: 5 unnamed drops for 2 rows. The
    // excess can claim no row, so it is clamped away — never invented onto a
    // third row (there is none) and never used to inflate the tally.
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "ok",
      reason: null,
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 5,
      error: null,
    });
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // Both rows are attempted-and-bad; no row is claimed twice, none omitted.
    expect(prepared.body).toContain("Reassessed 0/2 prior finding(s)");
    expect(prepared.body).toContain("2 invalid-output · 0 omitted");
    // Count inside the prior-findings section only: it is the body's ONE table
    // of those rows, and this case is about its per-row attribution.
    const priorSection = prepared.body.slice(prepared.body.indexOf("<summary>Revalidated findings</summary>"));
    const tableRows = priorSection.split("\n").filter((l) => l.startsWith("| Old null deref"));
    expect(tableRows).toHaveLength(2);
    expect(tableRows.every((l) => l.includes("| unverifiable (invalid-output) "))).toBe(true);
    // `rejected` reports what was attributed (2), not what was claimed (5).
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({
      recheck_outcome: "ok",
      rejected: 2,
      rejected_unnamed_ignored: 3,
      assessed: 0,
    });
  });

  test("an oversized status error is bounded at parse time, on both the log field and the D1 text", async () => {
    // `z` matches no secret shape, so what comes back is the bound alone.
    const oversized = "z".repeat(RECHECK_STATUS_ERROR_MAX_CHARS + 200);
    const capped = "z".repeat(RECHECK_STATUS_ERROR_MAX_CHARS);
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = "";
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "failed",
      reason: "seat-failed",
      rejected: 0,
      rejected_row_ids: [],
      error: oversized,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const line = h.logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    expect(String(line.fields.recheck_error)).toBe(capped);
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    // The composed D1 text carries the same capped value, and is itself
    // bounded — the exact length depends on the separator and the re-cap, so
    // the bound is what is asserted, not the formatting.
    const persisted = String(rows[0]!.error);
    expect(persisted).toContain(capped.slice(0, RECHECK_STATUS_ERROR_MAX_CHARS - 100));
    expect(persisted.length).toBeLessThanOrEqual(RECHECK_STATUS_ERROR_MAX_CHARS);
  });

  test("a status reason outside the closed vocabulary is no attribution: null, never a guessed verdict", async () => {
    // The per-row accounting branches on these exact literals, so an invented
    // reason would silently pick the wrong branch. It is dropped instead.
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = "";
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "failed",
      reason: "seats-unavailable",
      rejected: 0,
      rejected_row_ids: [],
      error: "seat crashed",
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const line = h.logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "failed", recheck_reason: null, recheck_error: "seat crashed" });
    // The status itself is still attributable (its outcome and error survive);
    // only the unrecognized reason is dropped.
    expect(String(failureRows(db)[0]!.error)).toBe("failed: null: seat crashed");
  });

  test("a secret straddling the status cap is redacted at parse time, so no fragment reaches D1 or the log", async () => {
    // `AIza` needs 30 trailing chars to match, so a slice-first parser would cut
    // this token at the cap and persist the leading fragment that no longer
    // matches any shape. Redaction at parse time removes the whole token first.
    // Sized so exactly 30 chars of the token land inside the parse-time cap:
    // `AIza` needs 30 trailing chars, so the fragment no longer matches and
    // would survive a slice-first parser as a bare, unrecognizable prefix.
    const head = "y".repeat(RECHECK_STATUS_ERROR_MAX_CHARS - 30);
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = "";
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "failed",
      reason: "seat-failed",
      rejected: 0,
      rejected_row_ids: [],
      error: `${head} AIza${"C".repeat(40)} tail`,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    const persisted = String(rows[0]!.error);
    // The raw token crossed the cap; no recognizable fragment of it survives.
    expect(persisted).not.toContain("AIza");
    expect(persisted.length).toBeLessThanOrEqual(RECHECK_STATUS_ERROR_MAX_CHARS);
    const line = h.logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    const logged = String(line.fields.recheck_error);
    expect(logged).not.toContain("AIza");
    expect(logged).toContain(REDACTED);
    // The composed D1 text is capped again, so the marker can be cut mid-way:
    // what survives must still be a PREFIX of the production marker, never an
    // arbitrary fragment.
    const markerTail = persisted.slice(persisted.lastIndexOf("["));
    expect(markerTail.length).toBeGreaterThan(1);
    expect(REDACTED.startsWith(markerTail)).toBe(true);
  });

  test("an ok seat status with a valid document records no failure and keeps the accounting unchanged", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = recheckDocWith({});
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "ok",
      reason: null,
      rejected: 0,
      rejected_row_ids: [],
      error: null,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    h.commenterState.discussion = {
      items: [],
      issueCoverage: "complete",
      issueModelCoverage: "complete",
      issueDigest: "issue-digest",
      capturedMs: 0,
      threads: [
        {
          associationId: ASSOC_ID,
          threadId: "PRRT_thread1",
          commentId: 8,
          headSha: SHA,
          digest: "thread-digest-1",
          commentCount: 2,
          capturedMs: 0,
          coverage: "complete",
          modelCoverage: "complete",
        },
      ],
    };
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(failureRows(db)).toHaveLength(0);
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("Reassessed 1/1 prior finding(s)");
    expect(prepared.body).toContain("addressed (verified-fix)");
    expect(h.commenterCalls.some((c) => c.op === "resolve")).toBe(true);
  });

  test("an unreadable document or status read keeps the conservative path: invalid-output, no throw, exactly one `recheck` attribution row", async () => {
    // Three ways a read can yield nothing: no file, a stream past the byte
    // bound (flag 1), and a failed shell chain — each on the status side, plus
    // the document read's own non-zero exit, which has no status analogue to
    // hide behind.
    for (const [why, arm] of [
      ["missing", () => {}],
      ["overflow", () => { h.sandbox.recheckStatusOverflow = "1"; }],
      ["exit", () => { h.sandbox.recheckStatusExitCode = 1; }],
      ["doc-exit", () => { h.sandbox.recheckFileExitCode = 1; }],
    ] as const) {
      h = createConsumerHarness();
      h.sandbox.diffStdout = VALID_DIFF;
      h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
      // The document is absent in every case; only the transport varies.
      h.sandbox.recheckFileContent = "";
      h.sandbox.recheckFileOverflow = "0";
      if (why !== "missing") h.sandbox.recheckStatusContent = "{}";
      arm();
      const db = await createSeededTestD1();
      await seedPriorPublication(db);
      await seedOpenTarget(db);
      await seedAssociation(db, "PRRT_thread1");
      const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

      await consumer(h.makeBatch(makePayload())); // resolves — never throws

      const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
      expect(prepared.body).toContain("unverifiable (invalid-output)");
      expect(failureRows(db)).toHaveLength(1);
      expect(failureRows(db)[0]).toMatchObject({ stage: "recheck" });
      // No attributable status in any arm, so the triple stays `absent`.
      expect(String(failureRows(db)[0]!.error)).toBe("absent: null: null");
      const line = h.logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
      expect(line.fields).toMatchObject({ recheck_outcome: "absent", assessed: 0 });
    }
  });

  test("a lost document under an `ok` status names the read failure instead of writing `ok: null: null`", async () => {
    // The seat reported success; the document then failed on the READ side
    // (overflow here). `ok: null: null` would blame nobody and say nothing, so
    // the real cause leads the D1 text.
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = recheckDocWith({});
    h.sandbox.recheckFileOverflow = "1";
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "ok",
      reason: null,
      rejected: 0,
      rejected_row_ids: [],
      error: null,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    const persisted = String(rows[0]!.error);
    // The read cause leads; the seat's own (empty) triple still rides after it
    // so the row remains attributable to that status.
    expect(persisted).toMatch(/^document overflow: ok: null: null$/);
    // The row still reads as an attempted-but-unusable answer.
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
  });

  test("a zero-byte document is absent, not a malformed-JSON fault", async () => {
    // The seat opened the file and wrote nothing — an empty file, not a
    // malformed payload. Parsing it would throw and report a JSON fault the
    // seat never committed.
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = "";
    h.sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "ok",
      reason: null,
      rejected: 0,
      rejected_row_ids: [],
      error: null,
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.error)).toBe("document absent: ok: null: null");
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
  });
});
describe("the recheck ask is FITTED to the operator's assignment budget (§7.3/§7.8)", () => {
  test("a staging-shaped ask rides as a rotation prefix; every other row is budget, never sent", async () => {
    // The staging shape: ~20 open findings × ~3 KiB of original body plus a
    // discussion at the §7.8 model caps = a ~75 KiB serialized ask against the
    // documented 65,536 B budget. The round used to be skipped whole (no seat,
    // no finding re-assessed, so no resolution could ever reconcile); it now
    // sends the rotation's prefix and accounts the rest.
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.commenterState.discussion = bigDiscussion();
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    const rotation = await seedRotation(db, 20, 3_000);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    // A seat ran with the document and the operator's own budget beside it.
    expect(h.sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(true);
    const { recheck, budget } = wireRecheck(h);
    expect(budget).toBe(RECHECK_ASSIGNMENT_MAX_BYTES);
    expect(recheck).toBeDefined();

    // The ask is a strict PREFIX of the rotation: the rows that fit ride, the
    // rest wait their turn instead of starving behind them.
    const sent = recheck!.targets.map((target) => target.rowId);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(rotation.length);
    expect(sent).toEqual(rotation.slice(0, sent.length));

    // The document plus the assignment's own prose stays inside the budget…
    expect(jsonBytes(recheck) + RECHECK_ASSIGNMENT_PROSE_BYTES).toBeLessThanOrEqual(RECHECK_ASSIGNMENT_MAX_BYTES);
    // …and the runner's own fit accepts it, so no `skipped: budget` can follow.
    expect(fitRecheckInput(recheck!, RECHECK_ASSIGNMENT_MAX_BYTES).ok).toBe(true);

    // Every row that did not ride is accounted `budget` (never-sent)…
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    const budgetRows = prepared.body.split("\n").filter((line) => line.includes("| unverifiable (budget) "));
    expect(budgetRows).toHaveLength(rotation.length - sent.length);
    // …and only the sent rows advanced the rotation clock.
    const clocks = db.raw.query("SELECT id, last_scheduled_ms FROM review_findings").all() as {
      id: string;
      last_scheduled_ms: number | null;
    }[];
    for (const row of clocks) expect(row.last_scheduled_ms !== null).toBe(sent.includes(row.id));
  });

  test("one target larger than the whole budget still ships, with a bounded body", async () => {
    // The single-row case that used to be a permanent skip: a 200 KiB original
    // body cannot fit any budget below it, but the finding itself can. The row
    // rides with its body cut short — same row id, title and anchors — so the
    // seat still assesses THAT concern instead of the round dying.
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const body = "z".repeat(200 * 1024);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db, { original: { body } });
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const { recheck, budget } = wireRecheck(h);
    expect(budget).toBe(RECHECK_ASSIGNMENT_MAX_BYTES);
    expect(recheck?.targets).toHaveLength(1);
    const [sent] = recheck!.targets;
    // The SAME finding row: nothing fabricated, nothing reordered.
    expect(sent!.rowId).toBe(TARGET_ROW_ID);
    expect(sent!.original.title).toBe(TARGET_ORIGINAL.title);
    expect(sent!.original.filePath).toBe(TARGET_ORIGINAL.filePath);
    expect(sent!.original.lineStart).toBe(TARGET_ORIGINAL.lineStart);
    expect(sent!.original.lineEnd).toBe(TARGET_ORIGINAL.lineEnd);
    // …with a body bounded to the room the budget leaves, and said so.
    expect(sent!.original.body.length).toBeLessThan(body.length);
    expect(sent!.original.body).toContain("[... body truncated ...]");
    expect(jsonBytes(recheck) + RECHECK_ASSIGNMENT_PROSE_BYTES).toBeLessThanOrEqual(RECHECK_ASSIGNMENT_MAX_BYTES);
    expect(fitRecheckInput(recheck!, RECHECK_ASSIGNMENT_MAX_BYTES).ok).toBe(true);
    // It rode the wire, so its clock advanced like any other sent row.
    const clock = db.raw.query("SELECT last_scheduled_ms FROM review_findings WHERE id = ?").get(TARGET_ROW_ID) as {
      last_scheduled_ms: number | null;
    };
    expect(clock.last_scheduled_ms).not.toBeNull();
  });

  test("two rounds over the same rotation send DISJOINT prefixes — the omitted rows go first", async () => {
    // ~6 KiB rows against a ~52 KiB document budget fit roughly a third of the
    // rotation, so the first round omits more rows than the second can send:
    // the two prefixes cannot overlap, and no row can starve.
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.commenterState.discussion = bigDiscussion();
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    const rotation = await seedRotation(db, 20, 6_000);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const first = wireRecheck(h).recheck!.targets.map((target) => target.rowId);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(rotation.length);
    expect(first).toEqual(rotation.slice(0, first.length));

    // The next round reads exactly the state this one left behind: the sent
    // rows' clock moved, the omitted rows' did not. That state is rebuilt on a
    // fresh head so no same-head dedup can mask which rows the rotation offers.
    const clocks = db.raw.query("SELECT id, last_scheduled_ms FROM review_findings").all() as {
      id: string;
      last_scheduled_ms: number | null;
    }[];
    const next = await createSeededTestD1();
    await seedPriorPublication(next);
    await seedRotation(next, 20, 6_000);
    for (const row of clocks) {
      if (row.last_scheduled_ms !== null) {
        next.raw.prepare("UPDATE review_findings SET last_scheduled_ms = ? WHERE id = ?").run(row.last_scheduled_ms, row.id);
      }
    }
    const h2 = createConsumerHarness();
    h2.sandbox.diffStdout = VALID_DIFF;
    h2.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h2.commenterState.discussion = bigDiscussion();
    const consumer2 = createReviewConsumer(await h2.makeEnv({ DB: next as never }), h2.testLog, h2.overrides);

    await consumer2(h2.makeBatch(makePayload()));

    const second = wireRecheck(h2).recheck!.targets.map((target) => target.rowId);
    expect(second.length).toBeGreaterThan(0);
    // Disjoint from the first round…
    expect(second.filter((rowId) => first.includes(rowId))).toEqual([]);
    // …and the prefix of exactly the rows the first round left behind.
    const omitted = rotation.filter((rowId) => !first.includes(rowId));
    expect(second).toEqual(omitted.slice(0, second.length));
  });
});
