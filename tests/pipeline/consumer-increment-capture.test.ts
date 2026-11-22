import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  SHA,
  TEST_APP_ID,
  TEST_INSTALLATION_ID,
  TEST_OWNER,
  TEST_PR_NUMBER,
  TEST_REPO,
  VALID_DIFF,
  VALID_OUTPUT,
  createSeededTestD1,
} from "../helpers/consumer-fixtures";
import { compareGateCommand } from "../../src/pipeline/gitops";
import {
  createConsumerHarness,
  DIFF_PREFETCH_MAX_BYTES,
  failureRows,
  loadConsumer,
  makePayload,
} from "../helpers/consumer-harness";
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

function storedContextIncomplete(db: TestD1, headSha: string = SHA): number {
  const row = db.raw.query("SELECT context_incomplete FROM reviews WHERE head_sha = ?").get(headSha) as {
    context_incomplete: number;
  };
  return row.context_incomplete;
}

function runnerInput(): Record<string, unknown> {
  return JSON.parse(h.sandbox.writtenInputJson!) as Record<string, unknown>;
}

const INCREMENT_TOO_LARGE =
  "HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000) " +
  "(https://api.github.com/repos/acme/widgets/compare/bbbbbbb...aaaaaaa)";

const oversizedIncrementSandbox = () => ({
  ...h.fakeSandbox,
  runCommand: mock(async (cmd: string, opts?: unknown) => {
    const answer = await h.fakeSandbox.runCommand(cmd, opts);
    return cmd.includes("application/vnd.github.v3.diff")
      ? { ...answer, stderr: INCREMENT_TOO_LARGE, exitCode: 1 }
      : answer;
  }),
});

describe("incremental review rounds: the increment capture", () => {
  test("an increment capture failure is a round failure, never a silent full-diff fallback", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.compareStatus = "ahead";
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.incrementDiffExitCode = 128;
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await expect(consumer(h.makeBatch(makePayload()))).rejects.toThrow(/increment diff failed/);
    expect(h.commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(0);
    expect(h.sandbox.writtenInputJson).toBeUndefined();
  });

  test("an increment capture failure does not carry an exact secret", async () => {
    const secretToken = ["6b2d90f4", "a83c", "4e17", "8d05", "1f7a3c6be942"].join("-");
    h.commenterState.token = secretToken;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.compareStatus = "ahead";
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.incrementDiffExitCode = 128;
    h.sandbox.incrementDiffStderr = `fatal: could not read Username (challenge ${secretToken})`;
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    const message = await h.expectFailureRedacted(consumer, db, { secret: secretToken, tail: "challenge" });
    expect(message).toContain("increment diff failed");
  });

  test("an oversized increment falls back or degrades with a reason", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.compareStatus = "ahead";
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      getSandbox: async () => oversizedIncrementSandbox(),
    });

    await consumer(h.makeBatch(makePayload()));

    expect(h.messageRetryCalls).toHaveLength(0);
    expect(failureRows(db)).toHaveLength(0);
    const degrade = h.logLines.filter((l) => l.fields.increment_capture !== undefined);
    expect(degrade).toHaveLength(1);
    expect(degrade[0]!.level).toBe("warn");
    expect(degrade[0]!.fields).toMatchObject({ increment_capture: "too_large", increment_since: PREVIOUS_SHA });
    expect(degrade[0]!.msg).toContain("increment diff capture too large");
    expect(degrade[0]!.msg).toContain("406");
    expect(runnerInput().reconFacts).toEqual([
      "acme/widgets#42",
      `head ${SHA}`,
      "10\t2\tsrc/auth.ts",
      "5\t0\tdocs/readme.md",
    ]);
    expect(h.commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(1);
  });

  test("a capture-failed round still publishes, and its row is never an incremental base", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = "";
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(1);
    expect(storedContextIncomplete(db)).toBe(1);
  });

  test("a pending journal apply failure also stores context_incomplete = 1, and that head is never the next base", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, created_ms, updated_ms, recovery_state)
         VALUES ('aaaaaaaa-0000-4000-8000-000000000046', ?, ?, ?, ?, ?, ?, 'review', 'confirmed', '{}', 1, 1, 'pending')`,
      )
      .run(TEST_APP_ID, TEST_INSTALLATION_ID, TEST_OWNER, TEST_REPO, TEST_PR_NUMBER, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(1);
    expect(storedContextIncomplete(db)).toBe(1);

    db.raw.prepare("UPDATE review_publications SET recovery_state = 'done' WHERE head_sha = ?").run(PREVIOUS_SHA);
    h = createConsumerHarness();
    const nextConsumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.compareStatus = "ahead";
    h.sandbox.diffStdout = VALID_DIFF;
    const nextSha = "d".repeat(40);
    h.sandbox.resolvedSha = nextSha;
    await nextConsumer(h.makeBatch(makePayload({ head_sha: nextSha })));

    expect(compareIssued()).toBe(false);
    expect(runnerInput().reconFacts).not.toContain(`since ${SHA}`);
    expect(storedContextIncomplete(db, nextSha)).toBe(0);
  });

  test("a healthy round stores context_incomplete = 0", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(storedContextIncomplete(db)).toBe(0);
  });

  test("an empty increment capture with a NON-empty numstat is a round failure, never a silent full diff", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.compareStatus = "ahead";
    h.sandbox.incrementDiffStdout = "";
    h.sandbox.numstatStdout = "3\t1\tsrc/auth.ts\n";
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.logLines.some((l) => l.fields.increment_since === PREVIOUS_SHA)).toBe(true);
    const capture = h.logLines.filter((l) => l.fields.increment_since === PREVIOUS_SHA);
    expect(capture).toHaveLength(1);
    expect(capture[0]!.fields.increment_capture).toBe("empty");
    expect(capture[0]!.fields.diff_capture).toBeUndefined();
    expect(storedContextIncomplete(db)).toBe(1);
  });

  test("an empty increment FILE (empty capture and empty numstat) is nothing to review: ack, no publication, no context-incomplete, Check inherits the reviewed head", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.compareStatus = "ahead";
    h.sandbox.incrementDiffStdout = "";
    h.sandbox.numstatStdout = "";
    h.sandbox.numstatExitCode = 128;
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const terminalized: Array<{ publicationId: string | null; outcome: string; inheritedHeadSha?: string }> = [];
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      checks: {
        begin: mock(async () => ({
          attemptId: "attempt-1",
          scope: {
            appId: TEST_APP_ID,
            installationId: TEST_INSTALLATION_ID,
            owner: TEST_OWNER,
            repo: TEST_REPO,
            prNumber: TEST_PR_NUMBER,
          },
          githubAppId: 424242,
          headSha: SHA,
          lease: { holder: "h", epoch: 1, untilMs: 1 },
        })),
        terminalize: mock(async (input: { publicationId: string | null; outcome: string; inheritedHeadSha?: string }) => {
          terminalized.push({
            publicationId: input.publicationId,
            outcome: input.outcome,
            inheritedHeadSha: input.inheritedHeadSha,
          });
        }),
      },
    });

    await consumer(h.makeBatch(makePayload()));

    expect(h.commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(0);
    expect(h.sandbox.writtenInputJson).toBeUndefined();
    expect(h.sandbox.calls.some((c) => c.cmd.includes("--input"))).toBe(false);
    const rows = db.raw.query("SELECT count(*) AS c FROM reviews WHERE head_sha = ?").get(SHA) as { c: number };
    expect(rows.c).toBe(0);
    expect(h.logLines.some((l) => l.fields.increment_capture !== undefined)).toBe(false);
    expect(h.logLines.some((l) => l.fields.diff_capture !== undefined)).toBe(false);
    const noIncrement = h.logLines.filter((l) => l.fields.event === "review_no_increment");
    expect(noIncrement).toHaveLength(1);
    expect(noIncrement[0]!.fields.increment_since).toBe(PREVIOUS_SHA);
    expect(terminalized).toEqual([{ publicationId: null, outcome: "skipped", inheritedHeadSha: PREVIOUS_SHA }]);
  });

  test("an empty diff file acks instead of failing the sandbox stage", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = "";
    h.sandbox.numstatStdout = "";
    h.sandbox.numstatExitCode = 128;
    const db = await createSeededTestD1();
    const terminalized: Array<{ publicationId: string | null; outcome: string; inheritedHeadSha?: string }> = [];
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      checks: {
        begin: mock(async () => ({
          attemptId: "attempt-1",
          scope: {
            appId: TEST_APP_ID,
            installationId: TEST_INSTALLATION_ID,
            owner: TEST_OWNER,
            repo: TEST_REPO,
            prNumber: TEST_PR_NUMBER,
          },
          githubAppId: 424242,
          headSha: SHA,
          lease: { holder: "h", epoch: 1, untilMs: 1 },
        })),
        terminalize: mock(async (input: { publicationId: string | null; outcome: string; inheritedHeadSha?: string }) => {
          terminalized.push({
            publicationId: input.publicationId,
            outcome: input.outcome,
            inheritedHeadSha: input.inheritedHeadSha,
          });
        }),
      },
    });

    await consumer(h.makeBatch(makePayload()));

    expect(h.commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(0);
    expect(h.sandbox.writtenInputJson).toBeUndefined();
    expect(h.sandbox.calls.some((c) => c.cmd.includes("--input"))).toBe(false);
    const rows = db.raw.query("SELECT count(*) AS c FROM reviews WHERE head_sha = ?").get(SHA) as { c: number };
    expect(rows.c).toBe(0);
    expect(db.raw.query("SELECT * FROM review_failures").all()).toHaveLength(0);
    expect(h.logLines.some((l) => l.fields.diff_capture !== undefined)).toBe(false);
    expect(h.logLines.some((l) => l.fields.increment_capture !== undefined)).toBe(false);
    const ack = h.logLines.filter((l) => l.fields.event === "review_no_diff");
    expect(ack).toHaveLength(1);
    expect(terminalized).toEqual([{ publicationId: null, outcome: "skipped", inheritedHeadSha: undefined }]);
  });

  test("an over-size increment stdout copy is not a capture failure — numstat still reads the file", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.compareStatus = "ahead";
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.incrementDiffStdout = "x".repeat(DIFF_PREFETCH_MAX_BYTES + 1);
    h.sandbox.numstatStdout = "3\t1\tsrc/auth.ts\n";
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(runnerInput().reconFacts).toEqual([
      "acme/widgets#42",
      `head ${SHA}`,
      `since ${PREVIOUS_SHA}`,
      "3\t1\tsrc/auth.ts",
    ]);
    expect(h.logLines.some((l) => l.fields.diff_capture !== undefined)).toBe(false);
    expect(storedContextIncomplete(db)).toBe(0);
  });

  test("a round whose capture failed is not an increment base either", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA, { contextIncomplete: true });
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(compareIssued()).toBe(false);
    expect(runnerInput().reconFacts).not.toContain(`since ${PREVIOUS_SHA}`);
  });
});
