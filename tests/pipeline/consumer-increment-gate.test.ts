import { beforeEach, describe, expect, test } from "bun:test";

import {
  SHA,
  TEST_APP_ID,
  TEST_INSTALLATION_ID,
  TEST_OTHER_APP_ID,
  TEST_OWNER,
  TEST_PR_NUMBER,
  TEST_REPO,
  VALID_DIFF,
  VALID_OUTPUT,
  createSeededTestD1,
  seedOtherApp,
} from "../helpers/consumer-fixtures";
import {
  compareGateCommand,
  diffCommand,
  incrementDiffCommand,
  numstatCommand,
  DIFF_PATH,
} from "../../src/pipeline/gitops";
import { createConsumerHarness, loadConsumer, makePayload } from "../helpers/consumer-harness";
import { createArtifactStore } from "../../src/store/artifact-store";
import type { TestD1 } from "../store/helpers";

const { createReviewConsumer } = await loadConsumer();

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

const PREVIOUS_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const compareCommand = (baseSha: string) => compareGateCommand(TEST_OWNER, TEST_REPO, baseSha, SHA);
const COMPARE_PATH = `${compareCommand(SHA).split("/compare/")[0]!}/compare/`;
const compareIssued = (): boolean => h.sandbox.calls.some((call) => call.cmd.startsWith(COMPARE_PATH));

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
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, bot_id, context_incomplete, reviewed_at)
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

const ROUND_IDENTITY: {
  appId: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
} = {
  appId: TEST_APP_ID,
  installationId: TEST_INSTALLATION_ID,
  owner: TEST_OWNER,
  repo: TEST_REPO,
  prNumber: TEST_PR_NUMBER,
};

function runnerInput(): Record<string, unknown> {
  return JSON.parse(h.sandbox.writtenInputJson!) as Record<string, unknown>;
}

function preparedBody(): string {
  const prepared = h.commenterCalls.filter((call) => call.op === "post-prepared");
  expect(prepared).toHaveLength(1);
  const call = prepared[0]!.args as { body: string };
  return call.body;
}

describe("incremental review rounds: the compare gate", () => {
  test("ahead: numstat reads the increment, a `since` fact rides the input, the header marks the round", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.compareStatus = "ahead";
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.incrementDiffStdout = VALID_DIFF;
    h.sandbox.numstatStdout = "3\t1\tsrc/auth.ts\n";
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.sandbox.calls.some((c) => c.cmd === compareCommand(PREVIOUS_SHA))).toBe(true);
    expect(
      h.sandbox.calls.some((c) => c.cmd === diffCommand(TEST_OWNER, TEST_REPO, TEST_PR_NUMBER, DIFF_PATH)),
    ).toBe(true);
    const incrementIndex = h.sandbox.calls.findIndex(
      (c) => c.cmd === incrementDiffCommand(TEST_OWNER, TEST_REPO, PREVIOUS_SHA, SHA, DIFF_PATH),
    );
    const numstatIndex = h.sandbox.calls.findIndex((c) => c.cmd === numstatCommand(DIFF_PATH));
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
      h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
      h.sandbox.diffStdout = VALID_DIFF;
      h.sandbox.compareStatus = status;
      h.sandbox.compareExitCode = exitCode;
      const db = await createSeededTestD1();
      seedReview(db, PREVIOUS_SHA);
      const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

      await consumer(h.makeBatch(makePayload()));

      expect(
        h.sandbox.calls.some(
          (c) => c.cmd === incrementDiffCommand(TEST_OWNER, TEST_REPO, PREVIOUS_SHA, SHA, DIFF_PATH),
        ),
      ).toBe(false);
      expect(runnerInput().reconFacts).toEqual([
        "acme/widgets#42",
        `head ${SHA}`,
        "10\t2\tsrc/auth.ts",
        "5\t0\tdocs/readme.md",
      ]);
      expect(preparedBody()).toContain(`Review 1 · commit ${SHA.slice(0, 7)}`);
      expect(preparedBody()).not.toContain(" · since ");
      expect(h.logLines.filter((l) => l.fields.increment_status === (exitCode === 0 ? status : `exit ${exitCode}`))).toHaveLength(1);
    });
  }

  test("ahead, but the increment carries a merge commit — full-diff round", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.compareStatus = "ahead";
    h.sandbox.compareMerges = 1;
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.sandbox.calls.some((c) => c.cmd === compareCommand(PREVIOUS_SHA))).toBe(true);
    expect(
      h.sandbox.calls.some(
        (c) => c.cmd === incrementDiffCommand(TEST_OWNER, TEST_REPO, PREVIOUS_SHA, SHA, DIFF_PATH),
      ),
    ).toBe(false);
    const facts = runnerInput().reconFacts as string[];
    expect(facts).toEqual(["acme/widgets#42", `head ${SHA}`, "10\t2\tsrc/auth.ts", "5\t0\tdocs/readme.md"]);
    expect(facts).not.toContain(`since ${PREVIOUS_SHA}`);
    expect(preparedBody()).not.toContain(" · since ");
    expect(h.logLines.filter((line) => line.level === "info" && line.fields.increment_status === "ahead-merge")).toHaveLength(1);
  });

  test("the last reviewed head must not be an incomplete round", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA, { verdict: "incomplete" });
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(compareIssued()).toBe(false);
    expect(runnerInput().reconFacts).not.toContain(`since ${PREVIOUS_SHA}`);
  });

  test("the newest ELIGIBLE reviewed head is the base, never an older or ineligible row", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.compareStatus = "ahead";
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.incrementDiffStdout = VALID_DIFF;
    const older = "c".repeat(40);
    const newestEligible = "d".repeat(40);
    const stopped = "e".repeat(40);
    const captureFailed = "f".repeat(40);
    const db = await createSeededTestD1();
    seedReview(db, older, { reviewedAt: "2026-01-01 00:00:00" });
    seedReview(db, newestEligible, { reviewedAt: "2026-01-02 00:00:00" });
    seedReview(db, stopped, { reviewedAt: "2026-01-03 00:00:00", verdict: "incomplete" });
    seedReview(db, captureFailed, { reviewedAt: "2026-01-04 00:00:00", contextIncomplete: true });
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.sandbox.calls.some((c) => c.cmd === compareCommand(newestEligible))).toBe(true);
    for (const sha of [older, stopped, captureFailed]) {
      expect(h.sandbox.calls.some((c) => c.cmd === compareCommand(sha))).toBe(false);
    }
    expect(runnerInput().reconFacts).toContain(`since ${newestEligible}`);
  });

  test("another App's newer head is never this App's base, even on one installation", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.compareStatus = "ahead";
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.incrementDiffStdout = VALID_DIFF;
    const otherAppHead = "a".repeat(40);
    const db = await createSeededTestD1();
    seedOtherApp(db);
    seedReview(db, PREVIOUS_SHA, { reviewedAt: "2026-01-01 00:00:00" });
    seedReview(db, otherAppHead, { appId: TEST_OTHER_APP_ID, reviewedAt: "2026-01-02 00:00:00" });
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const rows = db.raw
      .query(
        "SELECT bot_id, installation_id, owner, repo, pr_number FROM reviews WHERE head_sha IN (?, ?) ORDER BY reviewed_at",
      )
      .all(PREVIOUS_SHA, otherAppHead) as Array<Record<string, string | number>>;
    expect(rows).toEqual([
      {
        bot_id: ROUND_IDENTITY.appId,
        installation_id: ROUND_IDENTITY.installationId,
        owner: ROUND_IDENTITY.owner,
        repo: ROUND_IDENTITY.repo,
        pr_number: ROUND_IDENTITY.prNumber,
      },
      {
        bot_id: TEST_OTHER_APP_ID,
        installation_id: ROUND_IDENTITY.installationId,
        owner: ROUND_IDENTITY.owner,
        repo: ROUND_IDENTITY.repo,
        pr_number: ROUND_IDENTITY.prNumber,
      },
    ]);
    expect(h.sandbox.calls.some((c) => c.cmd === compareCommand(PREVIOUS_SHA))).toBe(true);
    expect(h.sandbox.calls.some((c) => c.cmd === compareCommand(otherAppHead))).toBe(false);
    expect(runnerInput().reconFacts).toContain(`since ${PREVIOUS_SHA}`);
  });

  test("the seeded identity IS the payload's identity (no negative case can pass vacuously)", () => {
    const payload = makePayload();
    expect(ROUND_IDENTITY).toEqual({
      appId: payload.botRef.appId,
      installationId: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
    });
  });

  test("no previous review (first round): no compare at all", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(compareIssued()).toBe(false);
  });

  test("a previous row at THIS head short-circuits before the compare", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    seedReview(db, SHA);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      store: { ...createArtifactStore(db), findByIdempotencyKey: async () => null },
    });

    await consumer(h.makeBatch(makePayload()));

    expect(compareIssued()).toBe(false);
    expect(runnerInput().reconFacts).not.toContain(`since ${SHA}`);
  });

  test("an unreadable base read keeps the full-diff round and says why", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      findIncrementBase: async () => {
        throw new Error("base read boom");
      },
    });

    await consumer(h.makeBatch(makePayload()));

    expect(compareIssued()).toBe(false);
    expect(runnerInput().reconFacts).not.toContain(`since ${PREVIOUS_SHA}`);
    expect(h.commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(1);
    const warn = h.logLines.filter((line) => line.level === "warn" && line.fields.increment_base === "lookup-failed");
    expect(warn).toHaveLength(1);
    expect(warn[0]!.msg).toContain("full diff");
    expect(warn[0]!.msg).toContain("base read boom");
  });
});
