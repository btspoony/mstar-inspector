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
import { syncReviewBotColumn } from "../store/helpers";

const { createReviewConsumer } = await loadConsumer();

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

const PREVIOUS_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const issueView = (issueNumber: number) => issueViewCommand(TEST_OWNER, TEST_REPO, issueNumber);

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
       VALUES (?, ?, ?, ?, ?, ?, ?,?, ?, ?)`,
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
  syncReviewBotColumn(db);
}

function runnerInput(): Record<string, unknown> {
  return JSON.parse(h.sandbox.writtenInputJson!) as Record<string, unknown>;
}

function preparedBody(): string {
  const prepared = h.commenterCalls.filter((call) => call.op === "post-prepared");
  expect(prepared).toHaveLength(1);
  const call = prepared[0]!.args as { body: string };
  return call.body;
}

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
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const body = preparedBody();
    expect(h.sandbox.calls.some((c) => c.cmd === issueView(7))).toBe(true);
    expect(body).toContain("**What this PR does**: Adds an expiry guard to the auth path.");
    expect(body).toContain("<summary>Revalidated findings</summary>");
    expect(body.match(/\| finding \| disposition \| evidence \| thread \|/g)).toHaveLength(1);
    expect(body.match(/Reassessed /g)).toHaveLength(1);
    expect(body).toContain(`| ${TARGET_ORIGINAL.title} | addressed (verified-fix) | current-code |`);
    expect(body).toContain("### Linked-issue AC");
    expect(body).toContain("Expiry rejected: met.");
    expect(body).toContain("<details><summary>Expand fix plan</summary>");
    expect(body.indexOf("## 📋 Review")).toBeLessThan(body.indexOf("**What this PR does**"));
    expect(body.indexOf("**What this PR does**")).toBeLessThan(
      body.indexOf("<summary>Revalidated findings</summary>"),
    );
    expect(body.indexOf("## 🛠️ Plan to fix")).toBeGreaterThan(body.indexOf("### ✅ Verified"));
  });
});
