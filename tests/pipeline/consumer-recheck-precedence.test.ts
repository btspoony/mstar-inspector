import { beforeEach, describe, expect, test } from "bun:test";
import { ASSESSMENT_TARGET_CAP } from "../../packages/shared/src/recheck-wire";
import {
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

describe("recheck conservative precedence (§7.4)", () => {
  test("a related index the final envelope cannot resolve is fabrication: unverifiable/conflict, no resolution", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = recheckDocWith({ relatedCurrentFindingIndexes: [1] });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (conflict)");
    expect(prepared.body).not.toContain("addressed (verified-fix)");
    expect(h.commenterCalls.some((c) => c.op === "resolve")).toBe(false);
    const round = db.raw
      .query(`SELECT assessment_json FROM review_finding_rounds WHERE finding_row_id = ?`)
      .get(TARGET_ROW_ID) as { assessment_json: string } | null;
    expect(JSON.parse(round!.assessment_json)).toMatchObject({ disposition: "unverifiable", reason: "conflict" });
  });

  test("an addressed row that names any in-range related concern is still a conflict, never a closure", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = recheckDocWith({ relatedCurrentFindingIndexes: [0] });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (conflict)");
    expect(prepared.body).not.toContain("addressed (verified-fix)");
    expect(h.commenterCalls.some((c) => c.op === "resolve")).toBe(false);
    const row = db.raw.query("SELECT state FROM review_findings").get() as { state: string };
    expect(row.state).toBe("open");
  });

  test("an in-range related index on a non-closure row is not a conflict: the guard only bites `addressed`", async () => {
    for (const verdict of [
      { disposition: "dismissed", reason: "non-fix-dismissal", expected: "dismissed (non-fix-dismissal)" },
      { disposition: "unverifiable", reason: "no-evidence", expected: "unverifiable (no-evidence)" },
    ] as const) {
      h = createConsumerHarness();
      h.sandbox.diffStdout = VALID_DIFF;
      h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
      h.sandbox.recheckFileContent = recheckDocWith({
        disposition: verdict.disposition,
        reason: verdict.reason,
        evidence: null,
        relatedCurrentFindingIndexes: [0],
      });
      const db = await createSeededTestD1();
      await seedPriorPublication(db);
      await seedOpenTarget(db);
      await seedAssociation(db, "PRRT_thread1");
      const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

      await consumer(h.makeBatch(makePayload()));

      const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
      expect(prepared.body).toContain(verdict.expected);
      expect(prepared.body).not.toContain("unverifiable (conflict)");
      const round = db.raw
        .query(`SELECT assessment_json FROM review_finding_rounds WHERE finding_row_id = ?`)
        .get(TARGET_ROW_ID) as { assessment_json: string } | null;
      expect(JSON.parse(round!.assessment_json)).toMatchObject({
        disposition: verdict.disposition,
        reason: verdict.reason,
      });
    }
  });

  test("a lost large round claims no closure: every row is invalid-output, so precedence has nothing to resolve", async () => {
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
    await seedOpenTarget(db);
    for (let i = 1; i < ASSESSMENT_TARGET_CAP; i += 1) {
      await seedOpenTarget(db, {
        rowId: `lost-precedence-row-${i}`,
        findingId: `lost-precedence-finding-${i}`,
        original: { fingerprintHint: `lost-precedence-fp-${i}` },
        nowMs: 2_000 + i,
      });
    }
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    const expectedCoverage = { assessed: 0, selected: 25, invalidOutput: 25, omitted: 0 };
    expect(prepared.body).toContain(coverageLine(expectedCoverage));
    const coverage = coverageLineNumbers(prepared.body)!;
    expect(coverage).toEqual(expectedCoverage);
    expect(coverage.assessed + coverage.invalidOutput + coverage.omitted).toBe(coverage.selected);
    expect(prepared.body).not.toContain("addressed (verified-fix)");
    expect(h.commenterCalls.some((c) => c.op === "resolve")).toBe(false);
    const thread = db.raw.query("SELECT resolution_state FROM review_threads").get() as {
      resolution_state: string;
    };
    expect(thread.resolution_state).toBe("pending");
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    expect(String(rows[0]!.error)).toBe("failed: seat-failed: structured output unavailable");
  });
});
