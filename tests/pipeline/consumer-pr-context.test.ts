/**
 * The PR-context capture is best-effort, but its failures are named: an
 * unattributed `none` section is indistinguishable from a PR with nothing to
 * say, and the report seat simply never runs.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  SHA,
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
import {
  issueViewCommand,
  prBodyCommand,
  readRecheckCommand,
  readRecheckStatusCommand,
  readReportCommand,
} from "../../src/pipeline/gitops";
import { createConsumerHarness, loadConsumer, makePayload } from "../helpers/consumer-harness";
import { withFrozenClock } from "../helpers/clock";
import { CHECK_TERMINALIZE_DEFAULT } from "../../src/dashboard/runtime-config-store";
import {
  PR_CONTEXT_MAX_CHARS,
  PR_CONTEXT_MAX_ISSUES,
  REPORT_OUTPUT_PATH,
} from "../../packages/shared/src/report-wire";
import { RECHECK_OUTPUT_PATH, RECHECK_STATUS_PATH } from "../../packages/shared/src/recheck-wire";

const {
  createReviewConsumer,
  postRunnerReserveMs,
  PR_CONTEXT_EXEC_TIMEOUT_MS,
  PR_CONTEXT_WORST_CASE_MS,
  POST_RUNNER_READ_TIMEOUT_MS,
  POST_RUNNER_READ_BUDGET_MS,
} = await loadConsumer();

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

const issueView = (issueNumber: number) => issueViewCommand(TEST_OWNER, TEST_REPO, issueNumber);

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

describe("PR-context capture", () => {
  test("near the derived-deadline boundary (capture + post-runner reads) the capture is skipped", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    // gh WOULD answer; the round's clock is what forbids the read.
    h.sandbox.prBodyExitCode = 0;
    h.sandbox.prBodyContent = "Closes #7";
    const db = await createSeededTestD1();
    const reserveMs = postRunnerReserveMs(CHECK_TERMINALIZE_DEFAULT);
    // The gate bills the DERIVED deadline (round − the post-runner reserve)
    // and needs the capture plus the post-runner reads: 234s + 120s + 90s.
    // 60s BELOW that boundary leaves 150s before the derived deadline — above
    // the capture's own 120s worst case, so the capture alone would fit and
    // the post-runner reads are what the round refuses.
    const roundBudgetMs = reserveMs + PR_CONTEXT_WORST_CASE_MS + POST_RUNNER_READ_BUDGET_MS - 60_000;
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      roundBudgetMs,
    });

    // Frozen clock: the round spends no wall time, so the remainder the gate
    // reports is an exact quantity rather than `round remainder − real elapsed`.
    await withFrozenClock(async () => {
      await consumer(h.makeBatch(makePayload()));
    });

    // Not one gh read started: the skip precedes the first exec, so a slow
    // sandbox cannot spend the window the paid run and its post need.
    expect(h.sandbox.calls.some((c) => c.cmd === prBodyCommand(TEST_OWNER, TEST_REPO, TEST_PR_NUMBER))).toBe(false);
    const warns = h.logLines.filter((l) => l.level === "warn" && l.fields.report_context !== undefined);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields.report_context).toBe("budget");
    // The line names the DERIVED deadline it refused on, not the level's tier
    // nor the round's own remainder: it sits exactly one post-runner reserve
    // below the round budget, which is what puts it under the capture-plus-
    // post-reads cost the gate bills.
    const leftMs = Number(/(\d+)ms left before the derived runner deadline/.exec(warns[0]!.msg)?.[1]);
    expect(leftMs).toBeLessThan(PR_CONTEXT_WORST_CASE_MS + POST_RUNNER_READ_BUDGET_MS);
    expect(roundBudgetMs - leftMs).toBe(reserveMs);
    // And it names both costs the gate compared, not just its verdict.
    expect(warns[0]!.msg).toContain(`the capture costs up to ${PR_CONTEXT_WORST_CASE_MS}ms`);
    expect(warns[0]!.msg).toContain(`the post-runner reads ${POST_RUNNER_READ_BUDGET_MS}ms`);
    // Never a failed review: the report degrades to `none` and the body lands.
    expect(preparedBody()).toContain("### Linked-issue AC\n\nnone");
    expect(h.sandbox.calls.some((c) => c.cmd.includes("--report-out"))).toBe(false);
  });

  test("at round start the production window funds the capture, and the issue cap still bounds its lookups", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.prBodyExitCode = 0;
    // Four distinct refs; only the bounded number may be read.
    h.sandbox.prBodyContent = "Closes #1, fixes #2, resolves #3, references #4";
    for (const number of [1, 2, 3, 4]) {
      h.sandbox.issueBodies.set(number, { title: `issue ${number}`, body: "none" });
    }
    const db = await createSeededTestD1();
    // The gate bills the DERIVED deadline, and the LEVEL never enters that
    // bound — each capture exec is capped at min(deadline, tier), so any level
    // with the capture's 210s left admits it. The per-level table itself is
    // pinned in consumer.test.ts (runnerTimeoutMs quick/default/deep).
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(
      h.sandbox.calls.some((c) => c.cmd === prBodyCommand(TEST_OWNER, TEST_REPO, TEST_PR_NUMBER)),
    ).toBe(true);
    // The capture runs under its own tighter bound, not the git steps' 120s.
    // Scoped to the capture's own commands: the post-runner reads share the
    // same 30s value, so timing alone cannot tell them apart.
    const captureCalls = h.sandbox.calls.filter(
      (call) =>
        (call.opts as { timeout?: number } | undefined)?.timeout === PR_CONTEXT_EXEC_TIMEOUT_MS &&
        (call.cmd === prBodyCommand(TEST_OWNER, TEST_REPO, TEST_PR_NUMBER) ||
          [1, 2, 3, 4].some((number) => call.cmd === issueView(number))),
    );
    expect(captureCalls).toHaveLength(1 + PR_CONTEXT_MAX_ISSUES);
    const issueReads = h.sandbox.calls.filter((call) =>
      [1, 2, 3, 4].some((number) => call.cmd === issueView(number)),
    );
    expect(issueReads).toHaveLength(PR_CONTEXT_MAX_ISSUES);
    const context = runnerInput().prContext as { issues: Array<{ number: number }> };
    expect(context.issues.map((issue) => issue.number)).toEqual([1, 2, 3]);
  });

  test("the post-runner bounded reads carry their own 30s timeout, not the git window", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    // Every post-runner read has something to answer: one open row to recheck
    // (document + status) and a report document behind a captured PR context.
    h.sandbox.prBodyExitCode = 0;
    h.sandbox.prBodyContent = "Closes #7";
    h.sandbox.recheckFileContent = recheckDocWith({});
    h.sandbox.reportFileContent = JSON.stringify({
      schema: "mstar.report/v1",
      headSha: SHA,
      overview: "overview",
      linkedIssueAc: "none",
      verified: "none",
      rejected: "none",
      planToFix: "none",
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const postRunnerCmds = new Set<string>([
      readRecheckCommand(RECHECK_OUTPUT_PATH),
      readRecheckStatusCommand(RECHECK_STATUS_PATH),
      readReportCommand(REPORT_OUTPUT_PATH),
    ]);
    const reads = h.sandbox.calls.filter((call) => postRunnerCmds.has(call.cmd));
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      expect((read.opts as { timeout?: number } | undefined)?.timeout).toBe(POST_RUNNER_READ_TIMEOUT_MS);
    }
  });

  test("a `gh pr view` failure warns once with its cause, then renders `none`", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    // The default state: `gh pr view` exits 1, so no PR context is captured.
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const warns = h.logLines.filter((l) => l.level === "warn" && l.fields.report_context !== undefined);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields.report_context).toBe("pr-view");
    expect(warns[0]!.fields.report_context_issue).toBeUndefined();
    expect(preparedBody()).toContain("### Linked-issue AC\n\nnone");
  });

  test("a non-JSON `gh pr view` reply carries its own cause", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.prBodyExitCode = 0;
    h.sandbox.prBodyRaw = "<html>502 Bad Gateway</html>";
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const warns = h.logLines.filter((l) => l.level === "warn" && l.fields.report_context !== undefined);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields.report_context).toBe("pr-view-json");
    expect(preparedBody()).toContain("### Linked-issue AC\n\nnone");
  });

  test("an unreadable linked issue warns with its number", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.prBodyExitCode = 0;
    h.sandbox.prBodyContent = "Closes #7";
    h.sandbox.issueBodies.set(7, { title: "Guard", body: "- reject expired tokens" });
    h.sandbox.issueViewExitCode = 1;
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const warns = h.logLines.filter((l) => l.level === "warn" && l.fields.report_context !== undefined);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields.report_context).toBe("issue-view");
    expect(warns[0]!.fields.report_context_issue).toBe(7);
  });

  test("an over-long PR body and issue text are clamped with the truncation marker", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.prBodyExitCode = 0;
    h.sandbox.prBodyContent = `Closes #7\n\n${"p".repeat(PR_CONTEXT_MAX_CHARS)}`;
    h.sandbox.issueBodies.set(7, {
      title: "t".repeat(PR_CONTEXT_MAX_CHARS + 10),
      body: "b".repeat(PR_CONTEXT_MAX_CHARS + 10),
    });
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const context = runnerInput().prContext as {
      prBody: string;
      issues: Array<{ title: string; body: string }>;
    };
    const marker = "\n[... truncated ...]";
    expect(context.prBody.endsWith(marker)).toBe(true);
    expect(context.prBody.length).toBe(PR_CONTEXT_MAX_CHARS + marker.length);
    expect(context.issues[0]?.title.endsWith(marker)).toBe(true);
    expect(context.issues[0]?.body.endsWith(marker)).toBe(true);
  });

  test("referenced issues are capped and duplicates collapse before any `gh issue view`", async () => {
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.prBodyExitCode = 0;
    // Four distinct refs plus a repeat of the first: only the first three
    // distinct numbers are read, exactly PR_CONTEXT_MAX_ISSUES times.
    h.sandbox.prBodyContent = "Closes #1, fixes #2, resolves #3, references #4, refs #1";
    for (const number of [1, 2, 3, 4]) {
      h.sandbox.issueBodies.set(number, { title: `issue ${number}`, body: "none" });
    }
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), undefined, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const context = runnerInput().prContext as { issues: Array<{ number: number }> };
    expect(context.issues.map((issue) => issue.number)).toEqual([1, 2, 3]);
    expect(context.issues).toHaveLength(PR_CONTEXT_MAX_ISSUES);
    const issueReads = h.sandbox.calls.filter((call) =>
      [1, 2, 3, 4].some((number) => call.cmd === issueView(number)),
    );
    expect(issueReads).toHaveLength(PR_CONTEXT_MAX_ISSUES);
    expect(h.sandbox.calls.some((call) => call.cmd === issueView(4))).toBe(false);
  });
});
