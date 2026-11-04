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
import {
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
  createReviewConsumer,
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
});
