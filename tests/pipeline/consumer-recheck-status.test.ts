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


type WireHarness = { sandbox: { writtenInputJson: string | undefined } };
type SeededDb = Awaited<ReturnType<typeof createSeededTestD1>>;

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function wireRecheck(harness: WireHarness): { recheck: RecheckInput | undefined; budget: number | undefined } {
  const written = harness.sandbox.writtenInputJson;
  if (written === undefined) throw new Error("the round wrote no runner input");
  const input = JSON.parse(written) as { recheck?: RecheckInput; recheckAssignmentMaxBytes?: number };
  return { recheck: input.recheck, budget: input.recheckAssignmentMaxBytes };
}

async function setAssignmentBudget(db: SeededDb, maxBytes: number): Promise<void> {
  db.raw
    .prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run(RECHECK_ASSIGNMENT_KEY, String(maxBytes), new Date().toISOString());
}

function bigDiscussion(items = 7): Discussion {
  return {
    items: Array.from({ length: items }, (_, index) => ({
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
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    expect(String(rows[0]!.error)).toBe("failed: seat-failed: session aborted");
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
    const expectedCoverage = { assessed: 0, selected: 25, invalidOutput: 25, omitted: 0 };
    expect(prepared.body).toContain(coverageLine(expectedCoverage));
    const coverage = coverageLineNumbers(prepared.body)!;
    expect(coverage).toEqual(expectedCoverage);
    expect(coverage.assessed + coverage.invalidOutput + coverage.omitted).toBe(coverage.selected);
    const priorSection = prepared.body.slice(prepared.body.indexOf("<summary>Revalidated findings</summary>"));
    expect(priorSection.split("\n").filter((line) => line.includes("| unverifiable (invalid-output) "))).toHaveLength(25);
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
      rejected: 99,
      rejected_row_ids: rejectedRowIds,
      error: null,
    });
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("Reassessed 23/25 prior finding(s)");
    expect(prepared.body).toContain("2 invalid-output · 0 omitted");
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("unverifiable (omitted)");
    const roundRows = db.raw.query("SELECT finding_row_id FROM review_finding_rounds").all() as Array<{
      finding_row_id: string;
    }>;
    expect(roundRows).toHaveLength(25);
    const persisted = new Set(roundRows.map((r) => r.finding_row_id));
    for (const rowId of assessableRowIds) expect(persisted.has(rowId)).toBe(true);
    for (const rowId of rejectedRowIds) expect(persisted.has(rowId)).toBe(true);
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
    expect(clocks.map((row) => row.id).sort()).toEqual([...rejectedRowIds].sort());
    expect(clocks.map((row) => row.last_assessed_ms).every((ms) => ms !== null)).toBe(true);
    expect(failureRows(db)).toHaveLength(0);
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 2, assessed: 23 });
  });

  test("a budget-skipped round accounts every row as budget, never invalid-output", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
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
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
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
    const priorSection = prepared.body.slice(prepared.body.indexOf("<summary>Revalidated findings</summary>"));
    expect(priorSection.split("\n").filter((line) => line.includes("| unverifiable (budget) "))).toHaveLength(3);
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    const coverage = coverageLineNumbers(prepared.body)!;
    expect(coverage).toEqual({ assessed: 0, selected: 3, invalidOutput: 0, omitted: 3 });
    expect(coverage.assessed + coverage.invalidOutput + coverage.omitted).toBe(coverage.selected);
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
    expect(prepared.body).toContain("Reassessed 0/1 prior finding(s)");
    expect(prepared.body).toContain("1 invalid-output · 0 omitted");
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    expect(String(rows[0]!.error)).toBe("failed: empty-result: null");
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "failed", recheck_reason: "empty-result", assessed: 0 });
    const findingRow = db.raw.query("SELECT state, last_assessed_ms FROM review_findings").get() as {
      state: string;
      last_assessed_ms: number | null;
    };
    expect(findingRow.state).toBe("open");
    expect(findingRow.last_assessed_ms).not.toBeNull();
  });

  test("an empty-result round blames only the rows it sent: a size-budget row keeps its own never-sent reason", async () => {
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
    const excluded = db.raw
      .prepare("SELECT last_assessed_ms FROM review_findings WHERE id = ?")
      .get(oversizedRowId) as { last_assessed_ms: number | null };
    expect(excluded.last_assessed_ms).toBeNull();
  });

  test("an empty-result round keeps a catalog-excluded row on its own reason and clock: only sent rows are blamed", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
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
    expect(prepared.body).toContain("| Old null deref on the config path | unverifiable (invalid-output) ");
    expect(prepared.body).toContain("| Unprovable concern | unverifiable (no-evidence) ");
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
    h.commenterState.discussion = bigDiscussion();
    const db = await createSeededTestD1();
    await setAssignmentBudget(db, RECHECK_ASSIGNMENT_MIN);
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (budget)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    expect(failureRows(db)).toHaveLength(0);
    const line = h.logLines.find((l) => l.msg.startsWith("recheck round accounted — no input sent"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "absent", assessed: 0 });
    const noFit = h.logLines.find((l) => l.fields.event === "review_recheck_no_fit")!;
    expect(noFit.level).toBe("warn");
    expect(noFit.fields).toMatchObject({ assignment_max_bytes: RECHECK_ASSIGNMENT_MIN, selected: 1 });
    expect(Number(noFit.fields.required_bytes)).toBeGreaterThan(RECHECK_ASSIGNMENT_MIN);
    expect(noFit.msg).toContain("keeps its budget reason and its rotation clock");
    const findingRow = db.raw.query("SELECT state, last_assessed_ms, last_scheduled_ms FROM review_findings").get() as {
      state: string;
      last_assessed_ms: number | null;
      last_scheduled_ms: number | null;
    };
    expect(findingRow.state).toBe("open");
    expect(findingRow.last_assessed_ms).toBeNull();
    expect(findingRow.last_scheduled_ms).toBeNull();
    const runnerInput = JSON.parse(h.sandbox.writtenInputJson!) as Record<string, unknown>;
    expect(runnerInput.recheck).toBeUndefined();
    expect(runnerInput.recheckAssignmentMaxBytes).toBeUndefined();
  });

  test("a status from another HEAD attributes nothing: the row stays omitted, never invalid-output", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
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
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "absent", rejected: 0 });
    expect(failureRows(db)).toHaveLength(0);
  });

  test("a readable status body with a wrong or absent schema is no attribution: the row stays invalid-output, outcome absent", async () => {
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
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 0, assessed: 1 });
  });

  test("a status naming a row this round never sent cannot attribute it: that id is ignored", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
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
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 1, assessed: 0 });
  });

  test("a gate-rejected row with no usable rowId is still attributed: invalid-output, never omitted", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
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
    expect(prepared.body).toContain("Reassessed 0/1 prior finding(s)");
    const findingRow = db.raw.query("SELECT last_assessed_ms FROM review_findings").get() as {
      last_assessed_ms: number | null;
    };
    expect(findingRow.last_assessed_ms).not.toBeNull();
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 1, assessed: 0 });
  });

  test("the status's `rejected_unnamed` attributes a runner-written nameless drop by position", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    for (let i = 0; i < 2; i += 1) {
      await seedOpenTarget(db, {
        rowId: `anonymous-${i}`,
        findingId: `finding-anon-${i}`,
        original: { fingerprintHint: `anon-fp-${i}` },
        nowMs: 2_000 + i,
      });
    }
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
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).toContain("unverifiable (omitted)");
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({ recheck_outcome: "ok", rejected: 1, assessed: 0 });
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
    for (let i = 0; i < 2; i += 1) {
      await seedOpenTarget(db, {
        rowId: `clamp-${i}`,
        findingId: `finding-clamp-${i}`,
        original: { fingerprintHint: `clamp-fp-${i}` },
        nowMs: 2_000 + i,
      });
    }
    h.sandbox.recheckFileContent = JSON.stringify({ schema: "mstar.recheck/v1", headSha: SHA, results: [] });
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
    expect(prepared.body).toContain("Reassessed 0/2 prior finding(s)");
    expect(prepared.body).toContain("2 invalid-output · 0 omitted");
    const priorSection = prepared.body.slice(prepared.body.indexOf("<summary>Revalidated findings</summary>"));
    const tableRows = priorSection.split("\n").filter((l) => l.startsWith("| Old null deref"));
    expect(tableRows).toHaveLength(2);
    expect(tableRows.every((l) => l.includes("| unverifiable (invalid-output) "))).toBe(true);
    const line = h.logLines.find((l) => l.msg.includes("recheck round accounted"))!;
    expect(line.fields).toMatchObject({
      recheck_outcome: "ok",
      rejected: 2,
      rejected_unnamed_ignored: 3,
      assessed: 0,
    });
  });

  test("an oversized status error is bounded at parse time, on both the log field and the D1 text", async () => {
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
    const persisted = String(rows[0]!.error);
    expect(persisted).toContain(capped.slice(0, RECHECK_STATUS_ERROR_MAX_CHARS - 100));
    expect(persisted.length).toBeLessThanOrEqual(RECHECK_STATUS_ERROR_MAX_CHARS);
  });

  test("a status reason outside the closed vocabulary is no attribution: null, never a guessed verdict", async () => {
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
    expect(String(failureRows(db)[0]!.error)).toBe("failed: null: seat crashed");
  });

  test("a secret straddling the status cap is redacted at parse time, so no fragment reaches D1 or the log", async () => {
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
    expect(persisted).not.toContain("AIza");
    expect(persisted.length).toBeLessThanOrEqual(RECHECK_STATUS_ERROR_MAX_CHARS);
    const line = h.logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
    const logged = String(line.fields.recheck_error);
    expect(logged).not.toContain("AIza");
    expect(logged).toContain(REDACTED);
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
    for (const [why, arm] of [
      ["missing", () => {}],
      ["overflow", () => { h.sandbox.recheckStatusOverflow = "1"; }],
      ["exit", () => { h.sandbox.recheckStatusExitCode = 1; }],
      ["doc-exit", () => { h.sandbox.recheckFileExitCode = 1; }],
    ] as const) {
      h = createConsumerHarness();
      h.sandbox.diffStdout = VALID_DIFF;
      h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
      h.sandbox.recheckFileContent = "";
      h.sandbox.recheckFileOverflow = "0";
      if (why !== "missing") h.sandbox.recheckStatusContent = "{}";
      arm();
      const db = await createSeededTestD1();
      await seedPriorPublication(db);
      await seedOpenTarget(db);
      await seedAssociation(db, "PRRT_thread1");
      const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

      await consumer(h.makeBatch(makePayload()));

      const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
      expect(prepared.body).toContain("unverifiable (invalid-output)");
      expect(failureRows(db)).toHaveLength(1);
      expect(failureRows(db)[0]).toMatchObject({ stage: "recheck" });
      expect(String(failureRows(db)[0]!.error)).toBe("absent: null: null");
      const line = h.logLines.find((l) => l.msg.includes("recheck output absent or failed validation"))!;
      expect(line.fields).toMatchObject({ recheck_outcome: "absent", assessed: 0 });
    }
  });

  test("a lost document under an `ok` status names the read failure instead of writing `ok: null: null`", async () => {
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
    expect(persisted).toMatch(/^document overflow: ok: null: null$/);
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
  });

  test("a zero-byte document is absent, not a malformed-JSON fault", async () => {
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
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.commenterState.discussion = bigDiscussion();
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    const rotation = await seedRotation(db, 20, 3_000);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(true);
    const { recheck, budget } = wireRecheck(h);
    expect(budget).toBe(RECHECK_ASSIGNMENT_MAX_BYTES);
    expect(recheck).toBeDefined();

    const sent = recheck!.targets.map((target) => target.rowId);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(rotation.length);
    expect(sent).toEqual(rotation.slice(0, sent.length));

    expect(jsonBytes(recheck) + RECHECK_ASSIGNMENT_PROSE_BYTES).toBeLessThanOrEqual(RECHECK_ASSIGNMENT_MAX_BYTES);
    expect(fitRecheckInput(recheck!, RECHECK_ASSIGNMENT_MAX_BYTES).ok).toBe(true);

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    const budgetRows = prepared.body.split("\n").filter((line) => line.includes("| unverifiable (budget) "));
    expect(budgetRows).toHaveLength(rotation.length - sent.length);
    const clocks = db.raw.query("SELECT id, last_scheduled_ms FROM review_findings").all() as {
      id: string;
      last_scheduled_ms: number | null;
    }[];
    for (const row of clocks) expect(row.last_scheduled_ms !== null).toBe(sent.includes(row.id));
  });

  test("one target larger than the whole budget still ships, with a bounded body", async () => {
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
    expect(sent!.rowId).toBe(TARGET_ROW_ID);
    expect(sent!.original.title).toBe(TARGET_ORIGINAL.title);
    expect(sent!.original.filePath).toBe(TARGET_ORIGINAL.filePath);
    expect(sent!.original.lineStart).toBe(TARGET_ORIGINAL.lineStart);
    expect(sent!.original.lineEnd).toBe(TARGET_ORIGINAL.lineEnd);
    expect(sent!.original.body.length).toBeLessThan(body.length);
    expect(sent!.original.body).toContain("[... body truncated ...]");
    expect(jsonBytes(recheck) + RECHECK_ASSIGNMENT_PROSE_BYTES).toBeLessThanOrEqual(RECHECK_ASSIGNMENT_MAX_BYTES);
    expect(fitRecheckInput(recheck!, RECHECK_ASSIGNMENT_MAX_BYTES).ok).toBe(true);
    expect(recheck!.evidence).toHaveLength(1);
    expect(recheck!.evidence[0]!.path).toBe("src/auth.ts");
    const clock = db.raw.query("SELECT last_scheduled_ms FROM review_findings WHERE id = ?").get(TARGET_ROW_ID) as {
      last_scheduled_ms: number | null;
    };
    expect(clock.last_scheduled_ms).not.toBeNull();
  });

  test("an oversized rotation HEAD rides bounded while the rows after it keep their place", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.commenterState.discussion = bigDiscussion();
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    const headBody = "z".repeat(120 * 1024);
    const headRowId = "oversized-head-row";
    await seedOpenTarget(db, {
      rowId: headRowId,
      findingId: "oversized-head-finding",
      original: { body: headBody, filePath: "src/auth.ts", lineStart: 21, lineEnd: 21, fingerprintHint: "head-fp" },
      nowMs: 1_500,
    });
    const later = await seedRotation(db, 5, 3_000);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const { recheck } = wireRecheck(h);
    expect(recheck).toBeDefined();
    const sent = recheck!.targets.map((target) => target.rowId);
    expect(sent[0]).toBe(headRowId);
    const rescued = recheck!.targets[0]!;
    expect(rescued.original.title).toBe(TARGET_ORIGINAL.title);
    expect(rescued.original.filePath).toBe(TARGET_ORIGINAL.filePath);
    expect(rescued.original.lineStart).toBe(TARGET_ORIGINAL.lineStart);
    expect(rescued.original.body.length).toBeLessThan(headBody.length);
    expect(rescued.original.body).toContain("[... body truncated ...]");
    expect(recheck!.evidence.some((slice) => slice.path === "src/auth.ts")).toBe(true);
    expect(sent.slice(1)).toEqual(later);
    expect(jsonBytes(recheck) + RECHECK_ASSIGNMENT_PROSE_BYTES).toBeLessThanOrEqual(RECHECK_ASSIGNMENT_MAX_BYTES);
    expect(fitRecheckInput(recheck!, RECHECK_ASSIGNMENT_MAX_BYTES).ok).toBe(true);
    const clock = db.raw.query("SELECT last_scheduled_ms FROM review_findings WHERE id = ?").get(headRowId) as {
      last_scheduled_ms: number | null;
    };
    expect(clock.last_scheduled_ms).not.toBeNull();
  });

  test("a head no room can share still rides ALONE, so its clock moves and it rotates behind the rest", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.commenterState.discussion = bigDiscussion(2);
    const db = await createSeededTestD1();
    await setAssignmentBudget(db, RECHECK_ASSIGNMENT_MIN);
    await seedPriorPublication(db);
    const headBody = "z".repeat(5_000);
    const headRowId = "alone-head-row";
    await seedOpenTarget(db, {
      rowId: headRowId,
      findingId: "alone-head-finding",
      original: { body: headBody, filePath: "src/auth.ts", lineStart: 21, lineEnd: 21, fingerprintHint: "alone-fp" },
      nowMs: 1_500,
    });
    const [filler] = await seedRotation(db, 1, 300);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const { recheck } = wireRecheck(h);
    expect(recheck).toBeDefined();
    expect(recheck!.targets.map((target) => target.rowId)).toEqual([headRowId]);
    expect(recheck!.targets[0]!.original.body).toContain("[... body truncated ...]");
    expect(jsonBytes(recheck) + RECHECK_ASSIGNMENT_PROSE_BYTES).toBeLessThanOrEqual(RECHECK_ASSIGNMENT_MIN);
    const clocks = db.raw.query("SELECT id, last_scheduled_ms FROM review_findings").all() as {
      id: string;
      last_scheduled_ms: number | null;
    }[];
    const clockById = new Map(clocks.map((row) => [row.id, row.last_scheduled_ms]));
    for (const rowId of [headRowId, filler!]) expect(clockById.has(rowId)).toBe(true);
    expect(clockById.get(headRowId)).not.toBeNull();
    expect(clockById.get(filler!)).toBeNull();
  });

  test("the rotation clock moves for every selected row except the fit-omitted ones", async () => {
    const clockOf = (db: SeededDb) => {
      const rows = db.raw.query("SELECT id, last_scheduled_ms FROM review_findings").all() as {
        id: string;
        last_scheduled_ms: number | null;
      }[];
      return new Map(rows.map((row) => [row.id, row.last_scheduled_ms]));
    };

    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = "";
    const catalogDb = await createSeededTestD1();
    await seedPriorPublication(catalogDb);
    const unprovableRowId = "catalog-excluded-row";
    await seedOpenTarget(catalogDb, {
      rowId: unprovableRowId,
      findingId: "catalog-excluded-finding",
      original: { filePath: "src/not-in-diff.ts", lineStart: 4, lineEnd: 4, fingerprintHint: "unprovable-fp" },
      nowMs: 1_500,
    });
    const [provableRowId] = await seedRotation(catalogDb, 1, 200);
    const catalogConsumer = createReviewConsumer(
      await h.makeEnv({ DB: catalogDb as never }),
      h.testLog,
      h.overrides,
    );

    await catalogConsumer(h.makeBatch(makePayload()));

    expect(wireRecheck(h).recheck!.targets.map((target) => target.rowId)).not.toContain(unprovableRowId);
    const catalogClocks = clockOf(catalogDb);
    for (const rowId of [unprovableRowId, provableRowId!]) expect(catalogClocks.has(rowId)).toBe(true);
    expect(catalogClocks.get(unprovableRowId)).not.toBeNull();
    expect(catalogClocks.get(provableRowId!)).not.toBeNull();

    const h2 = createConsumerHarness();
    h2.sandbox.diffStdout = VALID_DIFF;
    h2.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h2.commenterState.discussionError = new Error("discussion capture unavailable");
    const captureDb = await createSeededTestD1();
    await seedPriorPublication(captureDb);
    const capturedRows = await seedRotation(captureDb, 2, 200);
    const captureConsumer = createReviewConsumer(
      await h2.makeEnv({ DB: captureDb as never }),
      h2.testLog,
      h2.overrides,
    );

    await captureConsumer(h2.makeBatch(makePayload()));

    expect(JSON.parse(h2.sandbox.writtenInputJson!).recheck).toBeUndefined();
    const captureClocks = clockOf(captureDb);
    for (const rowId of capturedRows) expect(captureClocks.has(rowId)).toBe(true);
    for (const rowId of capturedRows) expect(captureClocks.get(rowId)).not.toBeNull();
  });

  test("two rounds over the same rotation send DISJOINT prefixes — the omitted rows go first", async () => {
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
    expect(second.filter((rowId) => first.includes(rowId))).toEqual([]);
    const omitted = rotation.filter((rowId) => !first.includes(rowId));
    expect(second).toEqual(omitted.slice(0, second.length));
  });
});
