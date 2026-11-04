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
import { describe, expect, test } from "bun:test";
import { RECHECK_STATUS_ERROR_MAX_CHARS } from "../../packages/shared/src/recheck-wire";
import { REDACTED } from "../../src/pipeline/redact";
import {
  ASSOC_ID,
  SHA,
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
  commenterCalls,
  commenterState,
  createReviewConsumer,
  failureRows,
  logLines,
  makeBatch,
  makeEnv,
  makePayload,
  reset,
  sandbox,
  testLog,
  testOverrides,
} from "../helpers/consumer-harness";

describe("recheck round attribution — status and row accounting (§7.7/§7.4/§7.10)", () => {
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
    expect(String(rows[0]!.error)).toBe("failed: seat-failed: session aborted");
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
    // never inflates the reassessed tally; it is published as its own
    // `invalid-output` term instead of vanishing, and nothing was omitted.
    expect(prepared.body).toContain("Reassessed 23/25 open prior finding(s)");
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
    expect(String(rows[0]!.error)).toBe("skipped: budget: null");
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
    // The one selected row is accounted by the SAME term the table renders.
    expect(prepared.body).toContain("Reassessed 0/1 open prior finding(s)");
    expect(prepared.body).toContain("1 invalid-output · 0 omitted");
    // The round delivered nothing usable, so it is recorded once, named.
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    expect(String(rows[0]!.error)).toBe("failed: empty-result: null");
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

  test("an empty-result round blames only the rows it sent: a size-budget row keeps its own never-sent reason", async () => {
    reset();
    // Two catalog-provable rows, one per file; the oversized one loses the
    // §7.3 size budget and never rides the wire, so the empty result says
    // nothing about it.
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("| Old null deref on the config path | unverifiable (invalid-output) ");
    expect(prepared.body).toContain("| Oversized concern | unverifiable (budget) ");
    // Never sent, so the excluded row's rotation clock stays untouched.
    const excluded = db.raw
      .prepare("SELECT last_assessed_ms FROM review_findings WHERE id = ?")
      .get(oversizedRowId) as { last_assessed_ms: number | null };
    expect(excluded.last_assessed_ms).toBeNull();
  });

  test("an empty-result round keeps a catalog-excluded row on its own reason and clock: only sent rows are blamed", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // Two selected rows: the seeded target is provable from the captured diff,
    // the second row's file never appears there, so only the target rode the
    // wire. The empty result says nothing about the unprovable row.
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
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
    const line = logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "failed", recheck_reason: "empty-result", assessed: 0 });
  });

  test("a captured-but-unprovable round blames the capture, not the catalog budget", async () => {
    // The discussion capture failed, so the input is suppressed before the
    // catalog can: the accounting line must name THAT cause, never the §7.3
    // catalog/size-budget exclusion the round never reached.
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    commenterState.discussionError = new Error("discussion API down");
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    const line = logLines.find((l) => l.msg.startsWith("recheck round accounted — no input sent"))!;
    expect(line.msg).toContain("lifecycle context capture failed");
    expect(line.msg).not.toContain("§7.3 size budget");
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (context-incomplete)");
    expect(failureRows(db)).toHaveLength(0);
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
      expect(String(rows[0]!.error)).toBe("absent: null: null");
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
    expect(String(failureRows(db)[0]!.error)).toBe("absent: null: null");
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

  test("a `rejected_unnamed` larger than the sent-and-unanswered pool attributes only the pool, and logs the excess", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
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
    sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
    // A seat-authored count with no ceiling: 5 unnamed drops for 2 rows. The
    // excess can claim no row, so it is clamped away — never invented onto a
    // third row (there is none) and never used to inflate the tally.
    sandbox.recheckStatusContent = JSON.stringify({
      schema: "mstar.recheck-status/v1",
      headSha: SHA,
      outcome: "ok",
      reason: null,
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 5,
      error: null,
    });
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // Both rows are attempted-and-bad; no row is claimed twice, none omitted.
    expect(prepared.body).toContain("Reassessed 0/2 open prior finding(s)");
    expect(prepared.body).toContain("2 invalid-output · 0 omitted");
    const tableRows = prepared.body.split("\n").filter((l) => l.startsWith("| Old null deref"));
    expect(tableRows).toHaveLength(2);
    expect(tableRows.every((l) => l.includes("| unverifiable (invalid-output) "))).toBe(true);
    // `rejected` reports what was attributed (2), not what was claimed (5).
    const line = logLines.find((l) => l.msg.includes("recheck round accounted"))!;
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
    expect(logged).toContain(REDACTED);
    // The composed D1 text is capped again, so the marker can be cut mid-way:
    // what survives must still be a PREFIX of the production marker, never an
    // arbitrary fragment.
    const markerTail = persisted.slice(persisted.lastIndexOf("["));
    expect(markerTail.length).toBeGreaterThan(1);
    expect(REDACTED.startsWith(markerTail)).toBe(true);
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
      expect(String(failureRows(db)[0]!.error)).toBe("absent: null: null");
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

  test("a zero-byte document is absent, not a malformed-JSON fault", async () => {
    // The seat opened the file and wrote nothing — an empty file, not a
    // malformed payload. Parsing it would throw and report a JSON fault the
    // seat never committed.
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = "";
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
    expect(String(rows[0]!.error)).toBe("document absent: ok: null: null");
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
  });
});
