/**
 * Prior-findings recheck on an increment round: which rows are targeted, and
 * how their revalidated disposition is rendered once in the prepared body.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  SHA,
  TARGET_ORIGINAL,
  TARGET_ROW_ID,
  TEST_APP_ID,
  TEST_INSTALLATION_ID,
  TEST_OWNER,
  TEST_PR_NUMBER,
  TEST_REPO,
  VALID_DIFF,
  VALID_OUTPUT,
  createSeededTestD1,
  recheckDocWith,
  seedAssociation,
  seedOpenTarget,
  seedPriorPublication,
} from "../helpers/consumer-fixtures";
import { issueViewCommand } from "../../src/pipeline/gitops";
import { createConsumerHarness, loadConsumer, makePayload } from "../helpers/consumer-harness";
import type { TestD1 } from "../store/helpers";

const { createReviewConsumer } = await loadConsumer();

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

const PREVIOUS_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const issueView = (issueNumber: number) => issueViewCommand(TEST_OWNER, TEST_REPO, issueNumber);

/**
 * One reviewed row for this PR at `headSha` (the increment base candidate).
 * The identity DEFAULTS to the canonical one `makePayload()` reviews with, so a
 * negative case can differ in exactly one field and still prove the read's
 * filter (not an identity mismatch) is what excluded the row.
 * `reviewedAt` is the ONE format the column carries in production — SQLite's
 * `datetime('now')`, i.e. `YYYY-MM-DD HH:MM:SS` — because base selection
 * ORDERS BY this text.
 */
function seedReview(
  db: TestD1,
  headSha: string,
  {
    verdict = "needs fixes",
    contextIncomplete = false,
    reviewedAt = "2026-01-01 00:00:00",
    appId = TEST_APP_ID,
    installationId = TEST_INSTALLATION_ID,
    owner = TEST_OWNER,
    repo = TEST_REPO,
    prNumber = TEST_PR_NUMBER,
  }: {
    verdict?: string;
    contextIncomplete?: boolean;
    reviewedAt?: string;
    appId?: string;
    installationId?: number;
    owner?: string;
    repo?: string;
    prNumber?: number;
  } = {},
): void {
  db.raw
    .prepare(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id, context_incomplete, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      installationId,
      owner,
      repo,
      prNumber,
      headSha,
      verdict,
      appId,
      contextIncomplete ? 1 : 0,
      reviewedAt,
    );
}

/** The written runner input JSON (the one `base64 -d >` write of the round). */
function runnerInput(): Record<string, unknown> {
  return JSON.parse(h.sandbox.writtenInputJson!) as Record<string, unknown>;
}

/**
 * The prepared review body the round sent — and the round sent exactly ONE.
 * Taking the first call would let a duplicate-publication regression pass every
 * body assertion in this suite.
 */
function preparedBody(): string {
  const prepared = h.commenterCalls.filter((call) => call.op === "post-prepared");
  expect(prepared).toHaveLength(1);
  // The harness records `args` as `unknown`; this double is its only writer.
  const call = prepared[0]!.args as { body: string };
  return call.body;
}

/**
 * The harness contract this suite is the reference consumer of: every recorder
 * belongs to ONE instance. Covered set — the ack record and the commenter op
 * log, i.e. the two recorders a second suite previously cleared under the
 * shared singletons.
 */
describe("consumer harness isolation", () => {
  test("a call recorded on one instance is invisible to another", async () => {
    const first = createConsumerHarness();
    const second = createConsumerHarness();

    first.makeBatch(makePayload()).messages[0]!.ack();
    await first.fakeCommenter.getInstallationToken({
      scope: {
        appId: TEST_APP_ID,
        installationId: TEST_INSTALLATION_ID,
        owner: TEST_OWNER,
        repo: TEST_REPO,
        prNumber: TEST_PR_NUMBER,
      },
      purpose: "sandbox-read",
    });

    expect(second.messageAckCalls).toHaveLength(0);
    expect(second.commenterCalls).toHaveLength(0);
    expect(first.messageAckCalls).toHaveLength(1);
    expect(first.commenterCalls).toHaveLength(1);
  });
});

describe("prior-findings recheck", () => {
  test("the recheck catalog is still built from the FULL diff on an increment round", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.compareStatus = "ahead";
    // The full diff proves the prior finding's file; the increment touches a
    // DIFFERENT file, so a catalog built from the increment would exclude it.
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.incrementDiffStdout = [
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
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const input = runnerInput() as { recheck?: { targets: Array<{ rowId: string }> } };
    expect(input.recheck?.targets.map((t) => t.rowId)).toEqual([TARGET_ROW_ID]);
  });

  test("report sections and the revalidated table land in the prepared body", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.prBodyExitCode = 0;
    h.sandbox.prBodyContent = "Closes #7\n\nAdds the expiry check.";
    h.sandbox.issueBodies.set(7, { title: "Expiry guard", body: "- must reject expired tokens" });
    h.sandbox.recheckFileContent = recheckDocWith({});
    h.sandbox.reportFileContent = JSON.stringify({
      schema: "mstar.report/v1",
      headSha: SHA,
      overview: "Adds an expiry guard to the auth path.",
      linkedIssueAc: "Expiry rejected: met.",
      verified: "- unit suite → green",
      rejected: "none",
      planToFix: "1. Add the guard.\n2. Rerun the suite.",
    });
    const db = await createSeededTestD1();
    // One open prior finding, rechecked this round: the body's ONE
    // prior-findings rendering carries it.
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const body = preparedBody();
    // The linked issue was read (the issue number came from the PR body).
    expect(h.sandbox.calls.some((c) => c.cmd === issueView(7))).toBe(true);
    expect(body).toContain("**What this PR does**: Adds an expiry guard to the auth path.");
    expect(body).toContain("<summary>Revalidated findings</summary>");
    // ONE prior-findings rendering: the §7.10 coverage line + the row land
    // exactly once.
    expect(body.match(/\| finding \| disposition \| evidence \| thread \|/g)).toHaveLength(1);
    expect(body.match(/Reassessed /g)).toHaveLength(1);
    expect(body).toContain(`| ${TARGET_ORIGINAL.title} | addressed (verified-fix) | current-code |`);
    expect(body).toContain("### Linked-issue AC");
    expect(body).toContain("Expiry rejected: met.");
    expect(body).toContain("<details><summary>Expand fix plan</summary>");
    // Template order: overview inside Review, the collapsed revalidated block
    // after findings, plan last.
    expect(body.indexOf("## 📋 Review")).toBeLessThan(body.indexOf("**What this PR does**"));
    expect(body.indexOf("**What this PR does**")).toBeLessThan(
      body.indexOf("<summary>Revalidated findings</summary>"),
    );
    expect(body.indexOf("## 🛠️ Plan to fix")).toBeGreaterThan(body.indexOf("### ✅ Verified"));
  });
});
