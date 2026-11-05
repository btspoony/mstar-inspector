/**
 * Consumer recheck CONSERVATIVE PRECEDENCE (spec §7.4): a same-round related
 * concern outranks closure, and the guard bites only an `addressed` claim —
 * `dismissed` / `unverifiable` keep their own verdict.
 *
 * Sibling files cover status/row accounting (`consumer-recheck-status`) and the
 * trusted evidence catalog (`consumer-recheck-catalog`); the doubles, D1
 * seeders and payload builders come from ../helpers/consumer-harness.
 */
import { describe, expect, test } from "bun:test";
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
  commenterCalls,
  coverageLine,
  coverageLineNumbers,
  createReviewConsumer,
  failureRows,
  makeBatch,
  makeEnv,
  makePayload,
  reset,
  sandbox,
  testLog,
  testOverrides,
} from "../helpers/consumer-harness";

describe("recheck conservative precedence (§7.4)", () => {
  test("a related index the final envelope cannot resolve is fabrication: unverifiable/conflict, no resolution", async () => {
    // The seat cites finding #1 while the round's final envelope carries one
    // finding (#0): the index names nothing the consumer can verify, so the
    // closure claim is never trusted (§7.4 conservative precedence).
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = recheckDocWith({ relatedCurrentFindingIndexes: [1] });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (conflict)");
    expect(prepared.body).not.toContain("addressed (verified-fix)");
    expect(commenterCalls.some((c) => c.op === "resolve")).toBe(false);
    const round = db.raw
      .query(`SELECT assessment_json FROM review_finding_rounds WHERE finding_row_id = ?`)
      .get(TARGET_ROW_ID) as { assessment_json: string } | null;
    expect(JSON.parse(round!.assessment_json)).toMatchObject({ disposition: "unverifiable", reason: "conflict" });
  });

  test("an addressed row that names any in-range related concern is still a conflict, never a closure", async () => {
    // The related concern exists in the final envelope, so it is unresolved
    // by definition: closure loses to the surviving concern.
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = recheckDocWith({ relatedCurrentFindingIndexes: [0] });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (conflict)");
    expect(prepared.body).not.toContain("addressed (verified-fix)");
    expect(commenterCalls.some((c) => c.op === "resolve")).toBe(false);
    const row = db.raw.query("SELECT state FROM review_findings").get() as { state: string };
    expect(row.state).toBe("open");
  });

  test("an in-range related index on a non-closure row is not a conflict: the guard only bites `addressed`", async () => {
    // Same in-range index, but the seat did not claim a fix: `dismissed` and
    // `unverifiable` keep their own verdict instead of being rewritten.
    for (const verdict of [
      { disposition: "dismissed", reason: "non-fix-dismissal", expected: "dismissed (non-fix-dismissal)" },
      { disposition: "unverifiable", reason: "no-evidence", expected: "unverifiable (no-evidence)" },
    ] as const) {
      reset();
      sandbox.diffStdout = VALID_DIFF;
      sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
      sandbox.recheckFileContent = recheckDocWith({
        disposition: verdict.disposition,
        reason: verdict.reason,
        evidence: null,
        relatedCurrentFindingIndexes: [0],
      });
      const db = await createSeededTestD1();
      await seedPriorPublication(db);
      await seedOpenTarget(db);
      await seedAssociation(db, "PRRT_thread1");
      const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

      await consumer(makeBatch(makePayload()));

      const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
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
    // The RCA's mode (I-000396) on the largest round: the seat's document never
    // arrives, so no row carries a claim the conservative guards must outvote.
    // The round must still be attributed per reason — and it must resolve
    // nothing, because there is no closure to verify.
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
      error: "structured output unavailable",
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    // The default target carries the thread below; the rest fill the round to
    // its full selection cap.
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    const expectedCoverage = { assessed: 0, selected: 25, invalidOutput: 25, omitted: 0 };
    expect(prepared.body).toContain(coverageLine(expectedCoverage));
    const coverage = coverageLineNumbers(prepared.body)!;
    expect(coverage).toEqual(expectedCoverage);
    expect(coverage.assessed + coverage.invalidOutput + coverage.omitted).toBe(coverage.selected);
    // No closure was claimed, so none is published and no thread resolves.
    expect(prepared.body).not.toContain("addressed (verified-fix)");
    expect(commenterCalls.some((c) => c.op === "resolve")).toBe(false);
    const thread = db.raw.query("SELECT resolution_state FROM review_threads").get() as {
      resolution_state: string;
    };
    expect(thread.resolution_state).toBe("pending");
    // ONE failure row names the lost round at the recheck stage.
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "recheck", head_sha: SHA });
    expect(String(rows[0]!.error)).toBe("failed: seat-failed: structured output unavailable");
  });
});
