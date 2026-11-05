/**
 * Incremental review rounds: the compare gate, the `since` reconFact and the
 * header marker.
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
  compareStatusCommand,
  diffCommand,
  incrementDiffCommand,
  numstatCommand,
  DIFF_PATH,
} from "../../src/pipeline/gitops";
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
import { createArtifactStore } from "../../src/store/artifact-store";
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

/** The identity every message under test reviews for — what `seedReview` defaults to. */
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

/** The written runner input JSON (the one `base64 -d >` write of the round). */
function runnerInput(): Record<string, unknown> {
  return JSON.parse(sandbox.writtenInputJson!) as Record<string, unknown>;
}

/**
 * The prepared review body the round sent — and the round sent exactly ONE.
 * Taking the first call would let a duplicate-publication regression pass every
 * body assertion in this suite.
 */
function preparedBody(): string {
  const prepared = commenterCalls.filter((call) => call.op === "post-prepared");
  expect(prepared).toHaveLength(1);
  // The harness records `args` as `unknown`; this double is its only writer.
  const call = prepared[0]!.args as { body: string };
  return call.body;
}

describe("incremental review rounds: the compare gate", () => {
  test("ahead: numstat reads the increment, a `since` fact rides the input, the header marks the round", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.compareStatus = "ahead";
    sandbox.diffStdout = VALID_DIFF;
    sandbox.incrementDiffStdout = VALID_DIFF;
    sandbox.numstatStdout = "3\t1\tsrc/auth.ts\n";
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    // The compare ran against the reviewed head, and the full diff STILL ran:
    // the prior findings' evidence catalog needs the whole PR diff.
    expect(sandbox.calls.some((c) => c.cmd === compareCommand(PREVIOUS_SHA))).toBe(true);
    expect(
      sandbox.calls.some((c) => c.cmd === diffCommand(TEST_OWNER, TEST_REPO, TEST_PR_NUMBER, DIFF_PATH)),
    ).toBe(true);
    // …and the increment capture replaced the file before numstat.
    const incrementIndex = sandbox.calls.findIndex(
      (c) => c.cmd === incrementDiffCommand(TEST_OWNER, TEST_REPO, PREVIOUS_SHA, SHA, DIFF_PATH),
    );
    const numstatIndex = sandbox.calls.findIndex((c) => c.cmd === numstatCommand(DIFF_PATH));
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
      expect(
        sandbox.calls.some(
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
      // The choice is logged with the verdict, never silently — and the value
      // IS the verdict, not merely some status.
      expect(logLines.filter((l) => l.fields.increment_status === (exitCode === 0 ? status : `exit ${exitCode}`))).toHaveLength(1);
    });
  }

  test("the last reviewed head must not be an incomplete round", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    // A stopped round reviewed PREVIOUS_SHA; diffing against it would inherit
    // the scope it never scanned, so it is not a base at all.
    seedReview(db, PREVIOUS_SHA, { verdict: "incomplete" });
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(compareIssued()).toBe(false);
    expect(runnerInput().reconFacts).not.toContain(`since ${PREVIOUS_SHA}`);
  });

  test("the newest ELIGIBLE reviewed head is the base, never an older or ineligible row", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.compareStatus = "ahead";
    sandbox.diffStdout = VALID_DIFF;
    sandbox.incrementDiffStdout = VALID_DIFF;
    const older = "c".repeat(40);
    const newestEligible = "d".repeat(40);
    const stopped = "e".repeat(40);
    const captureFailed = "f".repeat(40);
    const db = await createSeededTestD1();
    seedReview(db, older, { reviewedAt: "2026-01-01 00:00:00" });
    seedReview(db, newestEligible, { reviewedAt: "2026-01-02 00:00:00" });
    // Newer still, but neither scanned its scope: never a base.
    seedReview(db, stopped, { reviewedAt: "2026-01-03 00:00:00", verdict: "incomplete" });
    seedReview(db, captureFailed, { reviewedAt: "2026-01-04 00:00:00", contextIncomplete: true });
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(sandbox.calls.some((c) => c.cmd === compareCommand(newestEligible))).toBe(true);
    for (const sha of [older, stopped, captureFailed]) {
      expect(sandbox.calls.some((c) => c.cmd === compareCommand(sha))).toBe(false);
    }
    expect(runnerInput().reconFacts).toContain(`since ${newestEligible}`);
  });

  test("another App's newer head is never this App's base, even on one installation", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.compareStatus = "ahead";
    sandbox.diffStdout = VALID_DIFF;
    sandbox.incrementDiffStdout = VALID_DIFF;
    const otherAppHead = "a".repeat(40);
    const db = await createSeededTestD1();
    seedOtherApp(db);
    // Same installation, owner, repo and PR — only the App differs, and the
    // foreign row is NEWER, so an unfiltered base read would hand this round
    // that App's head and skip the commits THIS App never reviewed.
    seedReview(db, PREVIOUS_SHA, { reviewedAt: "2026-01-01 00:00:00" });
    seedReview(db, otherAppHead, { appId: TEST_OTHER_APP_ID, reviewedAt: "2026-01-02 00:00:00" });
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    // Non-vacuity: both rows carry the identity this round reviews for, so
    // `app_id` is the only field that can explain the exclusion.
    const rows = db.raw
      .query(
        "SELECT app_id, installation_id, owner, repo, pr_number FROM reviews WHERE head_sha IN (?, ?) ORDER BY reviewed_at",
      )
      .all(PREVIOUS_SHA, otherAppHead) as Array<Record<string, string | number>>;
    expect(rows).toEqual([
      {
        app_id: ROUND_IDENTITY.appId,
        installation_id: ROUND_IDENTITY.installationId,
        owner: ROUND_IDENTITY.owner,
        repo: ROUND_IDENTITY.repo,
        pr_number: ROUND_IDENTITY.prNumber,
      },
      {
        app_id: TEST_OTHER_APP_ID,
        installation_id: ROUND_IDENTITY.installationId,
        owner: ROUND_IDENTITY.owner,
        repo: ROUND_IDENTITY.repo,
        pr_number: ROUND_IDENTITY.prNumber,
      },
    ]);
    expect(sandbox.calls.some((c) => c.cmd === compareCommand(PREVIOUS_SHA))).toBe(true);
    expect(sandbox.calls.some((c) => c.cmd === compareCommand(otherAppHead))).toBe(false);
    expect(runnerInput().reconFacts).toContain(`since ${PREVIOUS_SHA}`);
  });

  test("the seeded identity IS the payload's identity (no negative case can pass vacuously)", () => {
    const payload = makePayload();
    expect(ROUND_IDENTITY).toEqual({
      appId: payload.appRef.appId,
      installationId: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
    });
  });

  test("no previous review (first round): no compare at all", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(compareIssued()).toBe(false);
  });

  test("a previous row at THIS head short-circuits before the compare", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    // The base read answers with the head being reviewed, so `base...head`
    // would be empty and the compare must not run. The same row would hit the
    // dedup read first, so that read is stubbed to miss — the guard is what
    // this case is about.
    seedReview(db, SHA);
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, {
      ...testOverrides,
      store: { ...createArtifactStore(db), findByIdempotencyKey: async () => null },
    });

    await consumer(makeBatch(makePayload()));

    expect(compareIssued()).toBe(false);
    expect(runnerInput().reconFacts).not.toContain(`since ${SHA}`);
  });

  test("an unreadable base read keeps the full-diff round and says why", async () => {
    reset();
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.diffStdout = VALID_DIFF;
    const db = await createSeededTestD1();
    seedReview(db, PREVIOUS_SHA);
    // The lookup itself rejects — a D1 hiccup or a missing column. Injected
    // through its seam, so this never depends on the query text: a D1 hiccup
    // must degrade to "no increment", never fail a review over its bookkeeping.
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, {
      ...testOverrides,
      findIncrementBase: async () => {
        throw new Error("base read boom");
      },
    });

    await consumer(makeBatch(makePayload()));

    // The full-diff fallback: no compare, no `since` fact, the review published.
    expect(compareIssued()).toBe(false);
    expect(runnerInput().reconFacts).not.toContain(`since ${PREVIOUS_SHA}`);
    expect(commenterCalls.filter((c) => c.op === "post-prepared")).toHaveLength(1);
    // …and the failure is not silent: one named warning carries the cause.
    const warn = logLines.filter((line) => line.level === "warn" && line.fields.increment_base === "lookup-failed");
    expect(warn).toHaveLength(1);
    expect(warn[0]!.msg).toContain("full diff");
    expect(warn[0]!.msg).toContain("base read boom");
  });
});
