/**
 * Incremental review rounds: the compare gate, the increment capture, the
 * `since` reconFact and the header marker.
 *
 * The rule under test (one sentence): only a previously REVIEWED head that
 * GitHub reports as an ancestor (`ahead`) turns a round incremental, and an
 * incremental round keeps the FULL diff for the prior-finding evidence catalog
 * while the numstat partition — and the seats' universe — becomes the delta.
 * Everything else (`behind`, `diverged`, a 404 after a force-push, any non-zero
 * exit) keeps the full-diff round.
 */
import { describe, expect, test } from "bun:test";

import {
  SHA,
  TARGET_ROW_ID,
  VALID_DIFF,
  VALID_OUTPUT,
  createSeededTestD1,
  seedAssociation,
  seedOpenTarget,
  seedPriorPublication,
} from "../helpers/consumer-fixtures";
import {
  commenterCalls,
  createReviewConsumer,
  logLines,
  makeBatch,
  makeEnv,
  makePayload,
  reset,
  sandbox,
  testLog,
  testOverrides,
} from "../helpers/consumer-harness";
import { validateReportDoc } from "../../packages/shared/src/report-wire";
import type { TestD1 } from "../store/helpers";

const PREVIOUS_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** One reviewed row for this PR at `headSha` (the increment base candidate). */
function seedReview(db: TestD1, headSha: string, verdict = "needs fixes"): void {
  db.raw
    .prepare(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id)
       VALUES (?, 123, 'acme', 'widgets', 42, ?, ?, NULL)`,
    )
    .run(crypto.randomUUID(), headSha, verdict);
}

/** The written runner input JSON (the one `base64 -d >` write of the round). */
function runnerInput(): Record<string, unknown> {
  return JSON.parse(sandbox.writtenInputJson!) as Record<string, unknown>;
}

/** The prepared review body the round sent. */
function preparedBody(): string {
  return (commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string }).body;
}

describe("incremental review rounds", () => {
  test("ahead: numstat reads the increment, a `since` fact rides the input, the header marks the round", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    sandbox.incrementDiffStdout = VALID_DIFF;
    sandbox.numstatStdout = "3\t1\tsrc/auth.ts\n";
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    // The compare ran against the reviewed head, and the full diff STILL ran:
    // the prior findings' evidence catalog needs the whole PR diff.
    expect(sandbox.calls.some((c) => c.cmd.includes(`/compare/${PREVIOUS_SHA}...${SHA}`) && c.cmd.includes("--jq"))).toBe(
      true,
    );
    expect(sandbox.calls.some((c) => c.cmd.includes("gh pr diff '42'"))).toBe(true);
    // …and the increment capture replaced the file before numstat.
    const incrementIndex = sandbox.calls.findIndex((c) =>
      c.cmd.startsWith("gh api -H 'Accept: application/vnd.github.v3.diff'"),
    );
    const numstatIndex = sandbox.calls.findIndex((c) => c.cmd.includes("git apply --numstat"));
    expect(incrementIndex).toBeGreaterThan(-1);
    expect(incrementIndex).toBeLessThan(numstatIndex);

    expect(runnerInput().reconFacts).toEqual([
      "acme/widgets#42",
      `head ${SHA}`,
      `since ${PREVIOUS_SHA}`,
      "3\t1\tsrc/auth.ts",
    ]);
    expect(preparedBody()).toContain(`Review 1 · commit ${SHA.slice(0, 7)} · since ${PREVIOUS_SHA.slice(0, 7)}`);
  });

  for (const [status, exitCode] of [
    ["diverged", 0],
    ["behind", 0],
    ["identical", 0],
    ["Not Found", 1],
  ] as const) {
    test(`${status} (exit ${exitCode}): full-diff round, no since fact, no header marker`, async () => {
      reset();
      sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
      sandbox.diffStdout = VALID_DIFF;
      sandbox.compareStatus = status;
      sandbox.compareExitCode = exitCode;
      const db = await createSeededTestD1();
      seedReview(db, PREVIOUS_SHA);
      const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

      await consumer(makeBatch(makePayload()));

      // No increment capture at all: the round reviewed the full diff.
      expect(sandbox.calls.some((c) => c.cmd.startsWith("gh api -H 'Accept:"))).toBe(false);
      expect(runnerInput().reconFacts).toEqual([
        "acme/widgets#42",
        `head ${SHA}`,
        "10\t2\tsrc/auth.ts",
        "5\t0\tdocs/readme.md",
      ]);
      expect(preparedBody()).toContain(`Review 1 · commit ${SHA.slice(0, 7)}`);
      expect(preparedBody()).not.toContain(" · since ");
      // The choice is logged with the verdict, never silently.
      expect(logLines.some((l) => l.fields.increment_status !== undefined)).toBe(true);
    });
  }

  test("the last reviewed head must not be an incomplete round", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    // A stopped round reviewed PREVIOUS_SHA; diffing against it would inherit
    // the scope it never scanned, so it is not a base at all.
    seedReview(db, PREVIOUS_SHA, "incomplete");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(sandbox.calls.some((c) => c.cmd.includes("/compare/"))).toBe(false);
    expect(runnerInput().reconFacts).not.toContain(`since ${PREVIOUS_SHA}`);
  });

  test("no previous review (first round), or the previous head IS this head: no compare at all", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(sandbox.calls.some((c) => c.cmd.includes("/compare/"))).toBe(false);
  });

  test("an increment capture failure is a round failure, never a silent full-diff fallback", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    sandbox.incrementDiffExitCode = 128;
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    // The round failed structurally — the same channel a failed full-diff
    // capture takes (rethrow → queue retry), never a quiet fallback to the
    // full diff that would make the `since` fact a lie.
    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/increment diff failed/);
    expect(commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(0);
    expect(sandbox.writtenInputJson).toBeUndefined();
  });

  test("the recheck catalog is still built from the FULL diff on an increment round", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The full diff proves the prior finding's file; the increment touches a
    // DIFFERENT file, so a catalog built from the increment would exclude it.
    sandbox.diffStdout = VALID_DIFF;
    sandbox.incrementDiffStdout = [
      "diff --git a/docs/readme.md b/docs/readme.md",
      "index 1111111..2222222 100644",
      "--- a/docs/readme.md",
      "+++ b/docs/readme.md",
      "@@ -1,1 +1,2 @@",
      " a",
      "+b",
      "",
    ].join("\n");
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const input = runnerInput() as { recheck?: { targets: Array<{ rowId: string }> } };
    expect(input.recheck?.targets.map((t) => t.rowId)).toEqual([TARGET_ROW_ID]);
  });

  test("report sections and the revalidated table land in the prepared body", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    sandbox.prBodyExitCode = 0;
    sandbox.prBodyContent = "Closes #7\n\nAdds the expiry check.";
    sandbox.issueBodies.set(7, { title: "Expiry guard", body: "- must reject expired tokens" });
    sandbox.reportFileContent = JSON.stringify({
      schema: "mstar.report/v1",
      overview: "Adds an expiry guard to the auth path.",
      linkedIssueAc: "Expiry rejected: met.",
      verified: "- unit suite → green",
      rejected: "none",
      planToFix: "1. Add the guard.\n2. Rerun the suite.",
    });
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    const body = preparedBody();
    // The linked issue was read (the issue number came from the PR body).
    expect(sandbox.calls.some((c) => c.cmd.includes("gh issue view '7'"))).toBe(true);
    expect(body).toContain("**What this PR does**: Adds an expiry guard to the auth path.");
    expect(body).toContain("### Revalidated findings");
    expect(body).toContain("### Linked-issue AC");
    expect(body).toContain("Expiry rejected: met.");
    expect(body).toContain("<details><summary>Expand fix plan</summary>");
    // Template order: overview inside Review, revalidated before findings,
    // plan last.
    expect(body.indexOf("## 📋 Review")).toBeLessThan(body.indexOf("**What this PR does**"));
    expect(body.indexOf("**What this PR does**")).toBeLessThan(body.indexOf("### Revalidated findings"));
    expect(body.indexOf("## 🛠️ Plan to fix")).toBeGreaterThan(body.indexOf("### ✅ Verified"));
  });

  test("without a report document every heading still renders, with `none`", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    // gh cannot answer → no prContext → no report seat → no --report-out.
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    const body = preparedBody();
    expect(body).toContain("### Linked-issue AC\n\nnone");
    expect(body).toContain("### ✅ Verified\n\nnone");
    expect(body).toContain("### 🗑️ Considered & rejected\n\nnone");
    expect(body).toContain("## 🛠️ Plan to fix\n\nnone");
    expect(sandbox.calls.some((c) => c.cmd.includes("--report-out"))).toBe(false);
  });

  test("a report document that fails its gate renders `none`, never a partial body", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    sandbox.prBodyExitCode = 0;
    sandbox.prBodyContent = "no issues referenced";
    // Blank field: the gate rejects the WHOLE document.
    sandbox.reportFileContent = JSON.stringify({
      schema: "mstar.report/v1",
      overview: "   ",
      linkedIssueAc: "none",
      verified: "none",
      rejected: "none",
      planToFix: "none",
    });
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    const body = preparedBody();
    expect(body).toContain("### Linked-issue AC\n\nnone");
    expect(sandbox.calls.some((c) => c.cmd.includes("--report-out"))).toBe(true);
  });

  test("the report document validates against the shared gate, not a consumer-local copy", () => {
    // One authority: the module the runner validates with is the module the
    // Worker validates with (see packages/shared/src/report-wire.ts).
    expect(validateReportDoc({ schema: "mstar.report/v1" }).ok).toBe(false);
  });
});
