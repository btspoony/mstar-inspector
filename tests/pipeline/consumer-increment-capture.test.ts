/**
 * Incremental review rounds: the increment capture and the context-incomplete
 * bookkeeping that follows it.
 *
 * An incremental round keeps the FULL diff for the prior-finding evidence
 * catalog while the numstat partition — and the seats' universe — becomes the
 * delta. A lost capture is a round failure, never a silent full-diff fallback,
 * and the head it produced is never the next round's base.
 */
import { describe, expect, mock, test } from "bun:test";

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
import { compareStatusCommand } from "../../src/pipeline/gitops";
import {
  commenterCalls,
  commenterState,
  createReviewConsumer,
  DIFF_PREFETCH_MAX_BYTES,
  failureRows,
  fakeSandbox,
  logLines,
  makeBatch,
  makeEnv,
  makePayload,
  messageRetryCalls,
  reset,
  sandbox,
  testLog,
  testOverrides,
} from "../helpers/consumer-harness";
import type { TestD1 } from "../store/helpers";

const PREVIOUS_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/**
 * The round's command shapes, built by the production builders: a change to a
 * command must edit the product, not this suite. The compare read carries
 * per-round shas, so its fixed compare PATH answers "was a compare issued at
 * all" without counting the round's other repo-root `gh api` reads.
 */
const compareCommand = (baseSha: string) => compareStatusCommand(TEST_OWNER, TEST_REPO, baseSha, SHA);
const COMPARE_PATH = `${compareCommand(SHA).split("/compare/")[0]!}/compare/`;
const compareIssued = (): boolean => sandbox.calls.some((call) => call.cmd.startsWith(COMPARE_PATH));

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

/** The stored `context_incomplete` flag for `headSha` (default: this round's head). */
function storedContextIncomplete(db: TestD1, headSha: string = SHA): number {
  const row = db.raw.query("SELECT context_incomplete FROM reviews WHERE head_sha = ?").get(headSha) as {
    context_incomplete: number;
  };
  return row.context_incomplete;
}

/** The written runner input JSON (the one `base64 -d >` write of the round). */
function runnerInput(): Record<string, unknown> {
  return JSON.parse(sandbox.writtenInputJson!) as Record<string, unknown>;
}

/** GitHub's answer when it refuses a diff over its 20,000-line API ceiling. */
const INCREMENT_TOO_LARGE =
  "HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000) " +
  "(https://api.github.com/repos/acme/widgets/compare/bbbbbbb...aaaaaaa)";

/**
 * The double answers the increment exec with an exit code but no stderr, so
 * this case injects the stderr the compare API really writes when it refuses
 * an oversized increment — the token the consumer classifies by. Everything
 * else (call recording, the other commands) stays the shared double's.
 */
const oversizedIncrementSandbox = {
  ...fakeSandbox,
  runCommand: mock(async (cmd: string, opts?: unknown) => {
    const answer = await fakeSandbox.runCommand(cmd, opts);
    return cmd.includes("application/vnd.github.v3.diff")
      ? { ...answer, stderr: INCREMENT_TOO_LARGE, exitCode: 1 }
      : answer;
  }),
};

describe("incremental review rounds: the increment capture", () => {
  test("an increment capture failure is a round failure, never a silent full-diff fallback", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.compareStatus = "ahead";
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

  test("an increment capture failure does not carry an exact secret", async () => {
    // A credential every shape pattern misses (no token prefix, no 40-char hex
    // run), assembled at runtime so no contiguous credential literal exists.
    // Only the exact-value pass can remove it from the increment stage's
    // message and its failure row.
    const secretToken = ["6b2d90f4", "a83c", "4e17", "8d05", "1f7a3c6be942"].join("-");
    reset();
    commenterState.token = secretToken;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.compareStatus = "ahead";
    sandbox.diffStdout = VALID_DIFF;
    sandbox.incrementDiffExitCode = 128;
    sandbox.incrementDiffStderr = `fatal: could not read Username (challenge ${secretToken})`;
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    const thrown = await consumer(makeBatch(makePayload())).then(
      () => {
        throw new Error("the increment capture was expected to fail");
      },
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    // The stderr tail really reached the message (it is not empty) and the
    // value itself is gone from it.
    expect(thrown).toContain("increment diff failed");
    expect(thrown).toContain("challenge");
    expect(thrown).not.toContain(secretToken);
    expect(failureRows(db)).toHaveLength(1);
    expect(String(failureRows(db)[0]!.error)).not.toContain(secretToken);
  });

  test("an oversized increment falls back or degrades with a reason", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    // `ahead` starts an increment round, then the compare API refuses the
    // base...head diff exactly as `gh pr diff` refuses an oversized PR.
    sandbox.compareStatus = "ahead";
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, {
      ...testOverrides,
      getSandbox: async () => oversizedIncrementSandbox,
    });

    // A refusal is not a round failure: nothing is retried and no failure row
    // is left, so the delivery never repeats the four-attempt exhaustion.
    await consumer(makeBatch(makePayload()));

    expect(messageRetryCalls).toHaveLength(0);
    expect(failureRows(db)).toHaveLength(0);
    // ONE structured warn names the reason and the step it stopped at.
    const degrade = logLines.filter((l) => l.fields.increment_capture !== undefined);
    expect(degrade).toHaveLength(1);
    expect(degrade[0]!.level).toBe("warn");
    expect(degrade[0]!.fields).toMatchObject({ increment_capture: "too_large", increment_since: PREVIOUS_SHA });
    expect(degrade[0]!.msg).toContain("increment diff capture too large");
    expect(degrade[0]!.msg).toContain("406");
    // …and the `since` fact is dropped rather than faked: the round reviews the
    // full diff its own capture already holds.
    expect(runnerInput().reconFacts).toEqual([
      "acme/widgets#42",
      `head ${SHA}`,
      "10\t2\tsrc/auth.ts",
      "5\t0\tdocs/readme.md",
    ]);
    expect(commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(1);
  });

  test("a capture-failed round still publishes, and its row is never an incremental base", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // Exit 0 with nothing to read: `gh pr diff` always emits a header for a
    // real PR, so this is a capture FAILURE — the round publishes anyway.
    sandbox.diffStdout = "";
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(1);
    expect(storedContextIncomplete(db)).toBe(1);
  });

  test("a pending journal apply failure also stores context_incomplete = 1, and that head is never the next base", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    // A CONFIRMED publication of an earlier head whose payload cannot apply:
    // the round runs with stale lifecycle context (closure/anchor state never
    // applied), which is a SECOND way to be incomplete — not a capture failure.
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, created_ms, updated_ms, recovery_state)
         VALUES ('aaaaaaaa-0000-4000-8000-000000000046', ?, ?, ?, ?, ?, ?, 'review', 'confirmed', '{}', 1, 1, 'pending')`,
      )
      .run(TEST_APP_ID, TEST_INSTALLATION_ID, TEST_OWNER, TEST_REPO, TEST_PR_NUMBER, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(1);
    expect(storedContextIncomplete(db)).toBe(1);

    // The next round at a newer head: the row above is the newest REVIEWED head
    // of this PR, and the flag keeps it out of the base read. The stale journal
    // is settled first so this round is otherwise clean.
    db.raw.prepare("UPDATE review_publications SET recovery_state = 'done' WHERE head_sha = ?").run(PREVIOUS_SHA);
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.compareStatus = "ahead";
    sandbox.diffStdout = VALID_DIFF;
    const nextSha = "d".repeat(40);
    // The round keys off the CHECKOUT sha, not the payload's: without this the
    // second delivery would dedup on the first round's head.
    sandbox.resolvedSha = nextSha;
    await consumer(makeBatch(makePayload({ head_sha: nextSha })));

    expect(compareIssued()).toBe(false);
    expect(runnerInput().reconFacts).not.toContain(`since ${SHA}`);
    // …and the clean round writes 0 of its own.
    expect(storedContextIncomplete(db, nextSha)).toBe(0);
  });

  test("a healthy round stores context_incomplete = 0", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(storedContextIncomplete(db)).toBe(0);
  });

  test("an empty increment capture with a NON-empty numstat is a round failure, never a silent full diff", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    // `ahead` turns the round incremental, but the base...head capture comes
    // back empty at exit 0 while the same round's numstat reads the increment
    // FILE and finds a diff: the transport lost the capture, so the round is
    // context-incomplete (an empty FILE would be nothing to review instead).
    sandbox.compareStatus = "ahead";
    sandbox.incrementDiffStdout = "";
    sandbox.numstatStdout = "3\t1\tsrc/auth.ts\n";
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(logLines.some((l) => l.fields.increment_since === PREVIOUS_SHA)).toBe(true);
    // Its own field, so an increment capture failure never reads as a full-diff
    // one — and the cause is the actual outcome, not a fixed word.
    const capture = logLines.filter((l) => l.fields.increment_since === PREVIOUS_SHA);
    expect(capture).toHaveLength(1);
    expect(capture[0]!.fields.increment_capture).toBe("empty");
    expect(capture[0]!.fields.diff_capture).toBeUndefined();
    expect(storedContextIncomplete(db)).toBe(1);
  });

  test("an empty increment FILE (empty capture and empty numstat) is nothing to review: ack, no publication, no context-incomplete, Check inherits the reviewed head", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    // The eligible base is an ancestor and `base...head` truly has no changes:
    // both reads of the increment — the bounded stdout copy and the numstat of
    // the file it wrote — are empty. `git apply --numstat` rejects an EMPTY
    // file with the exit git really answers (128), so the ack must survive
    // that exit rather than only an empty stdout. The prior round already
    // covers this head's content, so a verdict here would be computed from
    // nothing.
    sandbox.compareStatus = "ahead";
    sandbox.incrementDiffStdout = "";
    sandbox.numstatStdout = "";
    sandbox.numstatExitCode = 128;
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const terminalized: Array<{ publicationId: string | null; outcome: string; inheritedHeadSha?: string }> = [];
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, {
      ...testOverrides,
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

    await consumer(makeBatch(makePayload()));

    // Acked with no review: no body, no paid run, no review row.
    expect(commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(0);
    expect(sandbox.writtenInputJson).toBeUndefined();
    expect(sandbox.calls.some((c) => c.cmd.includes("--input"))).toBe(false);
    const rows = db.raw.query("SELECT count(*) AS c FROM reviews WHERE head_sha = ?").get(SHA) as { c: number };
    expect(rows.c).toBe(0);
    // …and it is NOT the capture-failure path.
    expect(logLines.some((l) => l.fields.increment_capture !== undefined)).toBe(false);
    expect(logLines.some((l) => l.fields.diff_capture !== undefined)).toBe(false);
    // ONE structured line names the outcome.
    const noIncrement = logLines.filter((l) => l.fields.event === "review_no_increment");
    expect(noIncrement).toHaveLength(1);
    expect(noIncrement[0]!.fields.increment_since).toBe(PREVIOUS_SHA);
    // The Check is told WHICH reviewed head it inherits — the conclusion then
    // comes from that head's row, never from a free-standing skip.
    expect(terminalized).toEqual([{ publicationId: null, outcome: "skipped", inheritedHeadSha: PREVIOUS_SHA }]);
  });

  test("an empty diff file acks instead of failing the sandbox stage", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // A first round whose PR adds no diff: `gh pr diff` writes an EMPTY file,
    // and `git apply --numstat` rejects it with the exit git really answers
    // for unusable input (128). Nothing to review, so the delivery acks — no
    // publication, no review row — instead of failing the sandbox stage.
    sandbox.diffStdout = "";
    sandbox.numstatStdout = "";
    sandbox.numstatExitCode = 128;
    const db = await createSeededTestD1();
    const terminalized: Array<{ publicationId: string | null; outcome: string; inheritedHeadSha?: string }> = [];
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, {
      ...testOverrides,
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

    await consumer(makeBatch(makePayload()));

    // Acked with no review: no body, no paid run, no review row, and no
    // failure row — the round did not fail, there was just nothing to review.
    expect(commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(0);
    expect(sandbox.writtenInputJson).toBeUndefined();
    expect(sandbox.calls.some((c) => c.cmd.includes("--input"))).toBe(false);
    const rows = db.raw.query("SELECT count(*) AS c FROM reviews WHERE head_sha = ?").get(SHA) as { c: number };
    expect(rows.c).toBe(0);
    expect(db.raw.query("SELECT * FROM review_failures").all()).toHaveLength(0);
    // …and it is NOT the capture-failure path.
    expect(logLines.some((l) => l.fields.diff_capture !== undefined)).toBe(false);
    expect(logLines.some((l) => l.fields.increment_capture !== undefined)).toBe(false);
    // ONE structured line names the outcome; there is no reviewed head to
    // inherit, so the Check keeps the skipped outcome's neutral conclusion.
    const ack = logLines.filter((l) => l.fields.event === "review_no_diff");
    expect(ack).toHaveLength(1);
    expect(terminalized).toEqual([{ publicationId: null, outcome: "skipped", inheritedHeadSha: undefined }]);
  });

  test("an over-size increment stdout copy is not a capture failure — numstat still reads the file", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.compareStatus = "ahead";
    sandbox.diffStdout = VALID_DIFF;
    // Only the stdout COPY is byte-bounded; the increment command redirects the
    // whole base...head diff into the file, and numstat reads THAT. Overflow is
    // therefore the documented over-size path, not an empty capture: the round
    // stays complete and the `since` fact keeps riding the input.
    sandbox.incrementDiffStdout = "x".repeat(DIFF_PREFETCH_MAX_BYTES + 1);
    sandbox.numstatStdout = "3\t1\tsrc/auth.ts\n";
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(runnerInput().reconFacts).toEqual([
      "acme/widgets#42",
      `head ${SHA}`,
      `since ${PREVIOUS_SHA}`,
      "3\t1\tsrc/auth.ts",
    ]);
    expect(logLines.some((l) => l.fields.diff_capture !== undefined)).toBe(false);
    expect(storedContextIncomplete(db)).toBe(0);
  });

  test("a round whose capture failed is not an increment base either", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    // This row published a verdict, but its own diff capture failed — diffing
    // against it would inherit scope that was never scanned.
    seedReview(db, PREVIOUS_SHA, { contextIncomplete: true });
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(compareIssued()).toBe(false);
    expect(runnerInput().reconFacts).not.toContain(`since ${PREVIOUS_SHA}`);
  });
});
