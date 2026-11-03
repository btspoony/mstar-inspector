/**
 * Consumer recheck-round attribution (spec §7.7/§7.4/§7.10) — the status
 * document's parse bounds and the round's accounting in D1 and the published
 * body. Moved out of tests/pipeline/consumer.test.ts; the sandbox/log doubles,
 * the App-seeded D1 and the finding-lifecycle seeds all come from
 * ../helpers/consumer-fixtures (one copy, both suites).
 *
 * Same DI technique as the parent suite: sandbox + commenter injected through
 * createReviewConsumer's overrides (no process-wide mock.module on relative
 * module paths, which leaks across test files sharing a worker).
 */
import { describe, expect, mock, test } from "bun:test";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { PipelineEnv } from "../../src/pipeline/consumer";
import type { CommenterCall } from "../helpers/review-commenter";
import type { TestD1 } from "../store/helpers";
import { createFakeCommenter, initialFakeCommenterState } from "../helpers/review-commenter";
import { RECHECK_STATUS_ERROR_MAX_CHARS } from "../../packages/shared/src/recheck-wire";
import {
  SHA,
  VALID_OUTPUT,
  VALID_DIFF,
  TEST_KEY,
  TEST_APP_ID,
  ASSOC_ID,
  TARGET_ROW_ID,
  TARGET_ORIGINAL,
  PRIOR_PUB_ID,
  PRIOR_SHA,
  createSeededTestD1,
  seedPriorPublication,
  seedOpenTarget,
  seedAssociation,
  recheckDocWith,
  createFakeSandbox,
  createTestLog,
  resetFakeSandboxState,
} from "../helpers/consumer-fixtures";

// --- sandbox fake (injected via createReviewConsumer overrides) -------------
// The double and its per-test knobs live in tests/helpers/consumer-fixtures:
// it answers ONLY the commands consumer.ts issues and throws on anything else.
const fakeSandbox = createFakeSandbox();
const sandbox = fakeSandbox.state;

// Load-shim only: consumer.ts statically imports ./sandbox → the workerd
// builtin `cloudflare:workers` (unresolvable in Bun's test runner).
import "../helpers/cloudflare-workers-mock";

// --- commenter fake (injected via createReviewConsumer overrides) -----------
const commenterCalls: CommenterCall[] = [];
const commenterState = initialFakeCommenterState();
const fakeCommenter = createFakeCommenter(commenterState, commenterCalls);

// Injected into every consumer under test (DI replaces the old mock.module).
const testOverrides = {
  createAppCommenter: () => fakeCommenter,
  getSandbox: async () => fakeSandbox,
};

// --- consumer under test (dynamic import: mocks must be registered first) ---
const { createReviewConsumer } = await import("../../src/pipeline/consumer");

// --- test log sink (injected via the consumer's optional log param) --------
const { lines: logLines, log: testLog } = createTestLog();

// --- helpers ----------------------------------------------------------------
const kv = {
  get: mock(async () => null),
  put: mock(async () => {}),
  delete: mock(async () => {}),
};

async function makeEnv(overrides: Partial<PipelineEnv> = {}): Promise<PipelineEnv> {
  return {
    DB: (await createSeededTestD1()) as never,
    IDEMPOTENCY_KV: kv as never,
    SANDBOX: {} as never,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    ...overrides,
  };
}

function makePayload(overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installation_id: 123,
    owner: "acme",
    repo: "widgets",
    pr_number: 42,
    head_sha: SHA,
    action: "opened",
    triggered_by: "pull_request",
    appRef: { appId: TEST_APP_ID },
    ...overrides,
  };
}

function makeBatch(payload: ReviewJobPayload): MessageBatch<ReviewJobPayload> {
  return {
    queue: "review-queue",
    messages: [
      {
        id: "m1",
        timestamp: new Date(),
        attempts: 1,
        body: payload,
        retry: () => {},
        ack: () => {},
      },
    ],
  } as unknown as MessageBatch<ReviewJobPayload>;
}

function reset(): void {
  resetFakeSandboxState(sandbox);
  commenterCalls.length = 0;
  Object.assign(commenterState, initialFakeCommenterState());
  logLines.length = 0;
}

/** All rows of the review_failures table in the real D1 double. */
function failureRows(db: TestD1): Array<Record<string, unknown>> {
  return db.raw.query("SELECT * FROM review_failures ORDER BY rowid").all() as Array<Record<string, unknown>>;
}

/**
 * The attribution triple a recheck failure row carries — `outcome: reason:
 * error`, as the round composed it. Parsed rather than string-matched so an
 * assertion pins the attribution, not the `null`-interpolation spacing; an
 * absent field comes back as `null`, not the literal text "null".
 */
function failureTriple(row: Record<string, unknown>): {
  outcome: string | null;
  reason: string | null;
  error: string | null;
} {
  const field = (text: string): string | null => (text === "null" ? null : text);
  const [outcome = "", reason = "", ...rest] = String(row.error).split(": ");
  return { outcome: field(outcome), reason: field(reason), error: field(rest.join(": ")) };
}

describe("recheck round attribution (§7.7/§7.4/§7.10)", () => {
  test("a failed seat status with no document makes the round attributable: every row invalid-output, one recheck failure row", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The seat never wrote a document and said why.
    sandbox.recheckFileContent = "";
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    // ONE failure row, naming the round and carrying the status triple.
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    expect(failureTriple(rows[0]!)).toEqual({
      outcome: "failed",
      reason: "seat-failed",
      error: "session aborted",
    });
    // The single accounting line carries the structured attribution.
    const line = logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    expect(line.level).toBe("warn");
    expect(line.fields).toMatchObject({
      recheck_outcome: "failed",
      recheck_reason: "seat-failed",
      recheck_error: "session aborted",
      rejected: 0,
      assessed: 0,
    });
  });

  test("rejected rows of an accepted document are invalid-output, never omitted; the rest still assess", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
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
    sandbox.recheckFileContent = JSON.stringify({
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
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // All 25 rows were ATTEMPTED — 23 answered assessably, 2 answered badly and
    // gate-dropped — so every one advances its rotation clock. The published
    // coverage counts the REAL seat answers only (23), so a gate-rejected row
    // never inflates the reassessed tally; nothing was omitted.
    expect(prepared.body).toContain("Reassessed 23/25 open prior finding(s)");
    expect(prepared.body).toContain("0 omitted");
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
    const line = logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    // `assessed` is the published coverage count (real answers), not the
    // lifecycle clock — the two gate-dropped rows do not count as reassessed.
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 2, assessed: 23 });
  });

  test("a budget-skipped round accounts every row as budget, never invalid-output", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The budget left no room, so the seat never ran: it wrote a status and
    // no document. The row was not answered badly — nobody asked — so the
    // reason is `budget`, not `invalid-output`.
    sandbox.recheckFileContent = "";
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (budget)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    // Still attributable, and still open: nothing was assessed.
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    expect(failureTriple(rows[0]!)).toEqual({ outcome: "skipped", reason: "budget", error: null });
    const line = logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "skipped", recheck_reason: "budget", assessed: 0 });
    const findingRow = db.raw.query("SELECT state, last_assessed_ms FROM review_findings").get() as {
      state: string;
      last_assessed_ms: number | null;
    };
    expect(findingRow.state).toBe("open");
    expect(findingRow.last_assessed_ms).toBeNull();
  });

  test("a round the runner cancelled by design is not a failure: rows stay omitted, the clock untouched, no D1 row", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The runner aborts an unfinished seat when the main review settles
    // (spec §7.8). The seat answered nothing because it was STOPPED — not
    // because it ran and lost, so this is neither a failure row nor
    // `invalid-output` for rows nobody asked about.
    sandbox.recheckFileContent = "";
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (omitted)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("unverifiable (budget)");
    // A cancellation is not a lost round: no failure row, nothing assessed.
    expect(failureRows(db)).toHaveLength(0);
    const line = logLines.find((l) => l.msg.includes("recheck round cancelled by the runner"))!;
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
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The seat returned a VALID document with zero results while one target was
    // sent: it answered, badly. `omitted` ("never ran") would hide the round.
    sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("unverifiable (omitted)");
    expect(prepared.body).toContain("0 omitted");
    // The round delivered nothing usable, so it is recorded once, named.
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    expect(failureTriple(rows[0]!)).toEqual({ outcome: "failed", reason: "empty-result", error: null });
    const line = logLines.find((l) => l.msg.includes("recheck round accounted"))!;
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

  test("a size-budget-excluded round sends nothing: rows are budget, and the round is still attributed", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // One open row whose own JSON exceeds the whole §7.3 input budget, so the
    // builder excludes every target and no recheck input exists at all. The
    // row was never sent — `invalid-output` would blame a seat that never ran.
    const oversizedBody = "x".repeat(600 * 1024);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db, { original: { body: oversizedBody } });
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // No seat ran: the runner exec must not carry --recheck-out.
    expect(sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (budget)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    // Nothing was attempted, so there is no failure to record.
    expect(failureRows(db)).toHaveLength(0);
    // …but the silence is attributable: the round still logs its accounting.
    const line = logLines.find((l) => l.msg.startsWith("recheck round accounted — no input sent"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "absent", assessed: 0 });
    const findingRow = db.raw.query("SELECT state, last_assessed_ms FROM review_findings").get() as {
      state: string;
      last_assessed_ms: number | null;
    };
    expect(findingRow.state).toBe("open");
    expect(findingRow.last_assessed_ms).toBeNull();
  });

  test("a status from another HEAD attributes nothing: the row stays omitted, never invalid-output", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // A usable document that answers nothing, beside a status that DOES claim
    // the sent row as rejected — but for a different HEAD. Trusting it would
    // name a reason this round never established.
    sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (omitted)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    // The foreign status is no attribution at all: `absent`, no rejected ids,
    // and a usable document means no failure row.
    const line = logLines.find((l) => l.msg.includes("recheck round accounted"))!;
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
      reset();
      sandbox.diffStdout = VALID_DIFF;
      sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
      sandbox.recheckFileContent = "";
      sandbox.recheckStatusContent = statusBody;
      const db = await createSeededTestD1();
      await seedPriorPublication(db);
      await seedOpenTarget(db);
      await seedAssociation(db, "PRRT_thread1");
      const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

      await consumer(makeBatch(makePayload()));

      const line = logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
      expect(line.fields).toMatchObject({
        recheck_outcome: "absent",
        recheck_reason: null,
        recheck_error: null,
      });
      // No status → the document is the only evidence, and it is absent: the
      // row is invalid-output and exactly one failure row carries `absent`.
      const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
      expect(prepared.body).toContain("unverifiable (invalid-output)");
      const rows = failureRows(db);
      expect(rows).toHaveLength(1);
      expect(failureTriple(rows[0]!)).toEqual({ outcome: "absent", reason: null, error: null });
    }
  });

  test("a readable status body that is not JSON at all is no attribution either", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = "";
    // The transport succeeded and handed back bytes that are not a status.
    sandbox.recheckStatusContent = "mstar.recheck-status/v1 { truncated";
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const line = logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "absent", assessed: 0 });
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(failureTriple(failureRows(db)[0]!)).toEqual({ outcome: "absent", reason: null, error: null });
  });

  test("a row the trusted catalog cannot prove never rides the wire: no-evidence, never budget, never assessed", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    // The concern's file is absent from the captured diff, so no slice can
    // prove it and no honest verdict is possible.
    db.raw.prepare(`UPDATE review_findings SET original_json = ? WHERE id = ?`).run(
      JSON.stringify({ ...TARGET_ORIGINAL, filePath: "src/elsewhere.ts" }),
      TARGET_ROW_ID,
    );
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // Not sent: the runner gains no --recheck-out and the input has no recheck.
    expect(sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    expect((JSON.parse(sandbox.writtenInputJson!) as { recheck?: unknown }).recheck).toBeUndefined();
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("Reassessed 0/1 open prior finding(s)");
    // The reason names the real cause — an unprovable row is not oversized.
    expect(prepared.body).toContain("unverifiable (no-evidence)");
    expect(prepared.body).not.toContain("unverifiable (budget)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    // Nothing was attempted, so nothing is assessed and no failure is recorded.
    const findingRow = db.raw.query("SELECT last_assessed_ms FROM review_findings").get() as {
      last_assessed_ms: number | null;
    };
    expect(findingRow.last_assessed_ms).toBeNull();
    expect(failureRows(db)).toHaveLength(0);
  });

  test("slices belonging to a budget-excluded row do not ride the recheck input, and the budget is measured without them", async () => {
    reset();
    // Two files in the captured diff, one selected row per file.
    sandbox.diffStdout = [
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
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    // The second row is oversized, so the §7.3 budget drops it AFTER the
    // catalog already holds its slice.
    await seedOpenTarget(db, {
      rowId: "eeeeeeee-0000-4000-8000-000000000005",
      findingId: "finding-oversized",
      original: {
        title: "Oversized concern",
        filePath: "src/other.ts",
        lineStart: 1,
        body: "y".repeat(600 * 1024),
      },
      nowMs: 2_100,
    });
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerInput = JSON.parse(sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string }>; evidence: Array<{ id: string; path: string }> };
    };
    expect(runnerInput.recheck.targets.map((t) => t.rowId)).toEqual([TARGET_ROW_ID]);
    // Only the surviving row's slice rides — the dropped row's file is gone.
    expect(runnerInput.recheck.evidence.length).toBeGreaterThan(0);
    expect(runnerInput.recheck.evidence.every((slice) => slice.path === "src/auth.ts")).toBe(true);
    // Slice ids stay stable (the shared catalog numbering, not a rebuilt one).
    expect(runnerInput.recheck.evidence[0]!.id).toBe("ev-1");
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (budget)");
  });

  /**
   * A src/auth.ts diff whose ONE hunk is `lineCount` lines (1-based numbering).
   * One ADDED line closes the first 80-line window, so the old and new sides
   * genuinely differ: the added text exists on the new side only, and every
   * later window starts one line further into the file on the new side
   * (`oldStart !== newStart`). A context-only hunk carries the same strings on
   * both sides, so a side swap or an offset error would pass every window
   * assertion below unchanged.
   */
  function oversizedAuthDiff(lineCount: number): string {
    return [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "index 1111111..2222222 100644",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      `@@ -1,${lineCount - 1} +1,${lineCount} @@`,
      ...Array.from({ length: lineCount }, (_, i) =>
        i === 79
          ? "+const added = 1;"
          : ` const v${String(i + 1).padStart(3, "0")} = 1;`,
      ),
      "",
    ].join("\n");
  }

  /**
   * One file per row, each a 320-line hunk (four 80-line windows of ~7.8 KiB
   * slices), so the 256 KiB catalog budget runs out before the last rows. Each
   * file carries one ADDED line in its first window, so every later window's
   * `newStart` is one line ahead of its `oldStart` — the fixture can tell the
   * two sides apart.
   */
  function catalogBudgetDiff(files: number): string {
    const body = Array.from({ length: 320 }, (_, i) =>
      (i === 10 ? `+const added${String(i + 1).padStart(3, "0")} = 1;` : ` const v${String(i + 1).padStart(3, "0")} = 1;`).padEnd(
        45,
        " ",
      ),
    );
    return Array.from({ length: files }, (_, i) => {
      const path = `src/b${String(i + 1).padStart(2, "0")}.ts`;
      return [
        `diff --git a/${path} b/${path}`,
        "index 1111111..2222222 100644",
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -1,319 +1,320 @@",
        ...body,
      ].join("\n");
    }).join("\n") + "\n";
  }

  test("a row the catalog byte budget drops is a budget exclusion, never no-evidence", async () => {
    reset();
    // Twelve provable rows whose slices all fit individually, but not together:
    // the catalog budget stops adding slices partway through the target list.
    const rowCount = 12;
    sandbox.diffStdout = catalogBudgetDiff(rowCount);
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = ""; // no document: every row is accounted by WHY it has no verdict
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    for (let i = 0; i < rowCount; i++) {
      await seedOpenTarget(db, {
        rowId: `eeeeeeee-0000-4000-8000-000000000${String(i + 10).padStart(3, "0")}`,
        findingId: `finding-budget-${i + 1}`,
        original: {
          title: `Budget row ${i + 1}`,
          filePath: `src/b${String(i + 1).padStart(2, "0")}.ts`,
          lineStart: 1,
          lineEnd: 1,
        },
        nowMs: 1_000 + i,
      });
    }
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerInput = JSON.parse(sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string }>; evidence: Array<{ path: string }> };
    };
    // The budget really bit: not every provable row could ride.
    expect(runnerInput.recheck.targets.length).toBeLessThan(rowCount);
    expect(new Set(runnerInput.recheck.evidence.map((slice) => slice.path)).size).toBeLessThan(rowCount);
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // The dropped rows were never sent because their slices lost a BYTE budget
    // — the same cause as the size budget. `no-evidence` would claim their
    // files cannot prove them at all.
    expect(prepared.body).toMatch(/Budget row 12 \| unverifiable \(budget\)/);
    expect(prepared.body).not.toContain("unverifiable (no-evidence)");
  });

  test("an oversized hunk is sliced into windows that still contain the target line", async () => {
    reset();
    sandbox.diffStdout = oversizedAuthDiff(200);
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The concern sits at line 21 — inside the FIRST window, so its local
    // evidence exists even though the whole hunk (200 lines) exceeds the bound.
    sandbox.recheckFileContent = JSON.stringify({
      schema: "mstar.recheck/v1",
      headSha: SHA,
      results: [
        {
          rowId: TARGET_ROW_ID,
          disposition: "addressed",
          reason: "verified-fix",
          evidence: {
            kind: "current-code",
            sliceId: "ev-1",
            startLine: 21,
            endLine: 22,
            quote: "const v021 = 1;\nconst v022 = 1;",
            explanation: "The guard now bounds the value.",
          },
          relatedCurrentFindingIndexes: [],
        },
      ],
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerInput = JSON.parse(sandbox.writtenInputJson!) as {
      recheck: {
        evidence: Array<{ id: string; oldStart: number; newStart: number; oldLines: string[]; newLines: string[] }>;
      };
    };
    const window = runnerInput.recheck.evidence.find((slice) => slice.id === "ev-1")!;
    // Header arithmetic stays exact: window one starts at file line 1 and its
    // 80 NEW-side lines really do cover the target line 21.
    expect(window.oldStart).toBe(1);
    expect(window.newStart).toBe(1);
    expect(window.newLines).toHaveLength(80);
    expect(window.newLines[20]).toBe("const v021 = 1;");
    // The sides are genuinely different: the added line exists on the new side
    // only, so this window reads 79 old lines against 80 new ones.
    expect(window.oldLines).toHaveLength(79);
    expect(window.newLines[79]).toBe("const added = 1;");
    expect(window.oldLines).not.toContain("const added = 1;");
    // Slice ids stay the shared catalog's stable numbering.
    expect(runnerInput.recheck.evidence.map((slice) => slice.id)).toEqual(["ev-1", "ev-2", "ev-3"]);
    // The in-window quote validates: the row closes as a verified fix.
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("addressed (verified-fix)");
  });

  test("windows are ordered nearest the concern first, so the third one is ev-1 with its own starts", async () => {
    reset();
    sandbox.diffStdout = oversizedAuthDiff(200);
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The concern sits at line 180 — window THREE in file order (lines 161-200)
    // and the NEAREST window to the cited line. Nearest-first ordering must put
    // it first and number it ev-1, with the partition's own exact starts.
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    db.raw.prepare(`UPDATE review_findings SET original_json = ? WHERE id = ?`).run(
      JSON.stringify({ ...TARGET_ORIGINAL, lineStart: 180, lineEnd: 180 }),
      TARGET_ROW_ID,
    );
    sandbox.recheckFileContent = JSON.stringify({
      schema: "mstar.recheck/v1",
      headSha: SHA,
      results: [
        {
          rowId: TARGET_ROW_ID,
          disposition: "addressed",
          reason: "verified-fix",
          evidence: {
            kind: "current-code",
            sliceId: "ev-1",
            startLine: 180,
            endLine: 180,
            quote: "const v180 = 1;",
            explanation: "The guard now bounds the value.",
          },
          relatedCurrentFindingIndexes: [],
        },
      ],
    });
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerInput = JSON.parse(sandbox.writtenInputJson!) as {
      recheck: {
        evidence: Array<{ id: string; oldStart: number; newStart: number; newLines: string[] }>;
      };
    };
    // Nearest first, then by distance: 160 (distance 20), 80 (100), 1 (179).
    expect(runnerInput.recheck.evidence.map((slice) => [slice.id, slice.oldStart])).toEqual([
      ["ev-1", 160],
      ["ev-2", 80],
      ["ev-3", 1],
    ]);
    const nearest = runnerInput.recheck.evidence[0]!;
    // The window's two sides are genuinely offset: the added line makes every
    // window past it start one line later on the new side.
    expect(nearest.oldStart).toBe(160);
    expect(nearest.newStart).toBe(161);
    expect(nearest.newLines).toHaveLength(40); // 161-200: the tail window
    expect(nearest.newLines[19]).toBe("const v180 = 1;");
    // The line-180 quote validates against THAT window, so the nearest slice is
    // the one the seat can actually cite.
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("addressed (verified-fix)");
  });

  test("a quote outside the cited window still fails validation", async () => {
    reset();
    sandbox.diffStdout = oversizedAuthDiff(200);
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // Line 190 lives in window THREE (ev-3). Citing ev-1 (lines 1-80) with that
    // quote is out of range, so the row is dropped and cannot close anything.
    sandbox.recheckFileContent = JSON.stringify({
      schema: "mstar.recheck/v1",
      headSha: SHA,
      results: [
        {
          rowId: TARGET_ROW_ID,
          disposition: "addressed",
          reason: "verified-fix",
          evidence: {
            kind: "current-code",
            sliceId: "ev-1",
            startLine: 190,
            endLine: 190,
            quote: "const v190 = 1;",
            explanation: "Cited far outside the slice it names.",
          },
          relatedCurrentFindingIndexes: [],
        },
      ],
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("addressed (verified-fix)");
  });

  test("a row the document answers AND the status names keeps its real assessment, never invalid-output", async () => {
    // The seat dropped then re-emitted a row: it names the id in its status
    // while the surviving document carries the verdict. The answer wins — the
    // `rejected` branch runs first in the reconciliation, so an unfiltered
    // union would overwrite the assessment and lose the seat's real work.
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = recheckDocWith({});
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("addressed (verified-fix)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    const round = db.raw
      .query(`SELECT assessment_json FROM review_finding_rounds WHERE finding_row_id = ?`)
      .get(TARGET_ROW_ID) as { assessment_json: string } | null;
    expect(JSON.parse(round!.assessment_json)).toMatchObject({ disposition: "addressed", reason: "verified-fix" });
    // Nothing was lost to a drop, so the round reports no rejected row.
    const line = logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 0, assessed: 1 });
  });

  test("a status naming a row this round never sent cannot attribute it: that id is ignored", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The seat dropped the SENT row from its own document and also named a row
    // from another round. Only the sent-row membership makes a name credible.
    sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("unverifiable (omitted)");
    // The count is the sent-row union: the foreign id never entered it. The
    // SENT row was attempted (the seat answered and the gate dropped it), so
    // it advances its rotation clock — but the document carries no answer for
    // it, so the published coverage counts nothing.
    const line = logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 1, assessed: 0 });
  });

  test("a gate-rejected row with no usable rowId is still attributed: invalid-output, never omitted", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The seat answered, but its row carries an empty rowId, so the gate drops
    // it without a name. The row is still ATTEMPTED: the reconciliation
    // attributes the drop by position among the SENT-and-unanswered rows, so it
    // is never mistaken for a row that never rode the wire.
    sandbox.recheckFileContent = JSON.stringify({
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
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("unverifiable (omitted)");
    // No real seat answer survived the gate, so the coverage counts nothing —
    // while the row's rotation clock advanced (it WAS sent).
    expect(prepared.body).toContain("Reassessed 0/1 open prior finding(s)");
    const findingRow = db.raw.query("SELECT last_assessed_ms FROM review_findings").get() as {
      last_assessed_ms: number | null;
    };
    expect(findingRow.last_assessed_ms).not.toBeNull();
    const line = logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    // `rejected` counts the drop the gate could not name; `assessed` counts
    // answers that survived it.
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 1, assessed: 0 });
  });

  test("the status's `rejected_unnamed` attributes a runner-written nameless drop by position", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
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
    sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // Exactly ONE row is the attempted-and-bad one — the first among the
    // sent-and-unanswered — and the other is honestly never-answered.
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).toContain("unverifiable (omitted)");
    const line = logLines.find((l) => l.msg.includes("recheck round accounted"))!;
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

  test("an oversized status error is bounded at parse time, on both the log field and the D1 text", async () => {
    // `z` matches no secret shape, so what comes back is the bound alone.
    const oversized = "z".repeat(RECHECK_STATUS_ERROR_MAX_CHARS + 200);
    const capped = "z".repeat(RECHECK_STATUS_ERROR_MAX_CHARS);
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = "";
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const line = logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
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
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = "";
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const line = logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "failed", recheck_reason: null, recheck_error: "seat crashed" });
    // The status itself is still attributable (its outcome and error survive);
    // only the unrecognized reason is dropped.
    expect(failureTriple(failureRows(db)[0]!)).toEqual({ outcome: "failed", reason: null, error: "seat crashed" });
  });

  test("a secret straddling the status cap is redacted at parse time, so no fragment reaches D1 or the log", async () => {
    // `AIza` needs 30 trailing chars to match, so a slice-first parser would cut
    // this token at the cap and persist the leading fragment that no longer
    // matches any shape. Redaction at parse time removes the whole token first.
    // Sized so exactly 30 chars of the token land inside the parse-time cap:
    // `AIza` needs 30 trailing chars, so the fragment no longer matches and
    // would survive a slice-first parser as a bare, unrecognizable prefix.
    const head = "y".repeat(RECHECK_STATUS_ERROR_MAX_CHARS - 30);
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = "";
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    const persisted = String(rows[0]!.error);
    // The raw token crossed the cap; no recognizable fragment of it survives.
    expect(persisted).not.toContain("AIza");
    expect(persisted.length).toBeLessThanOrEqual(RECHECK_STATUS_ERROR_MAX_CHARS);
    const line = logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    const logged = String(line.fields.recheck_error);
    expect(logged).not.toContain("AIza");
    expect(logged).toContain("[REDACTED]");
    // The composed D1 text is capped again, so only the marker's prefix survives
    // there — enough to prove the redaction replaced the token.
    expect(persisted).toContain("[REDACT");
  });

  test("an ok seat status with a valid document records no failure and keeps the accounting unchanged", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = recheckDocWith({});
    sandbox.recheckStatusContent = JSON.stringify({
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
    commenterState.discussion = {
      items: [],
      issueCoverage: "complete",
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(failureRows(db)).toHaveLength(0);
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("Reassessed 1/1 open prior finding(s)");
    expect(prepared.body).toContain("addressed (verified-fix)");
    expect(commenterCalls.some((c) => c.op === "resolve")).toBe(true);
  });

  test("the per-slice byte bound measures the slice AS SERIALIZED, id included", async () => {
    reset();
    // One 3-line hunk whose middle context line is padded so the slice lands in
    // the window between the two measurement points: the id-less object is
    // within 8 KiB (8190 bytes) while the slice as serialized — with its
    // `ev-N` id — is 8194, over the bound. Measuring before the id is assigned
    // let this slice ride the wire over the bound it claims to enforce.
    sandbox.diffStdout = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "index 1111111..2222222 100644",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -19,3 +19,3 @@",
      " const header = req.headers;",
      ` const filler = "${"x".repeat(3854)}";`,
      " const claims = decode(token);",
      "",
    ].join("\n");
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // The oversized slice is dropped, so nothing proves the row and no recheck
    // input is sent at all — the row is `no-evidence`, never an invalid answer.
    expect(sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (no-evidence)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
  });

  test("an unreadable document or status read keeps the conservative path: invalid-output, no throw, exactly one `recheck` attribution row", async () => {
    // Three ways a read can yield nothing: no file, a stream past the byte
    // bound (flag 1), and a failed shell chain — each on the status side, plus
    // the document read's own non-zero exit, which has no status analogue to
    // hide behind.
    for (const [why, arm] of [
      ["missing", () => {}],
      ["overflow", () => { sandbox.recheckStatusOverflow = "1"; }],
      ["exit", () => { sandbox.recheckStatusExitCode = 1; }],
      ["doc-exit", () => { sandbox.recheckFileExitCode = 1; }],
    ] as const) {
      reset();
      sandbox.diffStdout = VALID_DIFF;
      sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
      // The document is absent in every case; only the transport varies.
      sandbox.recheckFileContent = "";
      sandbox.recheckFileOverflow = "0";
      if (why !== "missing") sandbox.recheckStatusContent = "{}";
      arm();
      const db = await createSeededTestD1();
      await seedPriorPublication(db);
      await seedOpenTarget(db);
      await seedAssociation(db, "PRRT_thread1");
      const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

      await consumer(makeBatch(makePayload())); // resolves — never throws

      const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
      expect(prepared.body).toContain("unverifiable (invalid-output)");
      expect(failureRows(db)).toHaveLength(1);
      expect(failureRows(db)[0]).toMatchObject({ stage: "recheck" });
      // No attributable status in any arm, so the triple stays `absent`.
      expect(failureTriple(failureRows(db)[0]!)).toEqual({ outcome: "absent", reason: null, error: null });
      const line = logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
      expect(line.fields).toMatchObject({ recheck_outcome: "absent", assessed: 0 });
    }
  });

  test("a lost document under an `ok` status names the read failure instead of writing `ok: null: null`", async () => {
    // The seat reported success; the document then failed on the READ side
    // (overflow here). `ok: null: null` would blame nobody and say nothing, so
    // the real cause leads the D1 text.
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = recheckDocWith({});
    sandbox.recheckFileOverflow = "1";
    sandbox.recheckStatusContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    const persisted = String(rows[0]!.error);
    // The read cause leads; the seat's own (empty) triple still rides after it
    // so the row remains attributable to that status.
    expect(persisted).toMatch(/^document overflow: ok: null: null$/);
    // The row still reads as an attempted-but-unusable answer.
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
  });
});
