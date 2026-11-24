import { describe, expect, test } from "bun:test";
import "../helpers/cloudflare-workers-mock";
import { TEST_KEY, failingDb } from "../helpers/consumer-fixtures";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

// `await import` keeps module evaluation AFTER the cloudflare-workers mock
// registers — the same loading-boundary idiom as paid-launch-fence.test.ts.
const {
  AttemptUnknownError,
  claimReviewAttempt,
  readReviewLaunch,
  runReviewAttempt,
} = await import("../../src/pipeline/review-attempt");
const { RUNNER_PATH } = await import("../../src/pipeline/gitops");
const { TOKEN_USAGE_PATH } = await import("../../packages/shared/src/token-usage-wire");

const ATTEMPT = "2b0c4f8e-7a11-4a4e-9b1f-2a5f4f2f1c01";
const SHA = "a".repeat(40);
const TARGET = "target-id-1";
const WORKSPACE = "workspace-id-1";

const VALID_DOC = JSON.stringify({
  version: 1,
  buckets: [
    { provider: "ark", model: "deepseek-v4-flash", input: 100, output: 40, cacheRead: 10, cacheWrite: 5, total: 155, requests: 3, costUsd: 0.0123 },
    { provider: "openai", model: "gpt-5.2", input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10, requests: 1, costUsd: 0.0004 },
  ],
});

const INVALID_DOC = JSON.stringify({ version: 2, buckets: [] });

type Warn = { fields: Record<string, unknown>; msg?: string };

type SandboxDouble = {
  events: string[];
  runMarked(marker: string, command: string): Promise<{ kind: "ran"; stdout: string; stderr: string; exitCode: number }>;
  runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
};

/**
 * `usageDoc`: the bytes the container's side document carries — `null` emits
 * the transport's absent proof (`\n2\n`), a string the document itself. Every
 * other read answers like `paid-launch-fence`'s double: the runner exec exits
 * 0 with empty stdout, the applied-model path parses as unreadable (harmless:
 * it only warns), and `rev-parse` answers the fixture head.
 */
function sandboxDouble(usageDoc: string | null): SandboxDouble {
  const events: string[] = [];
  return {
    events,
    async runMarked(_marker: string, command: string) {
      events.push(`marked:${command}`);
      if (command.includes(TOKEN_USAGE_PATH)) {
        return {
          kind: "ran" as const,
          stdout: usageDoc === null ? "\n2\n" : `${usageDoc}\n0\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        kind: "ran" as const,
        stdout: command.includes("rev-parse") ? `${SHA}\n` : "",
        stderr: "",
        exitCode: 0,
      };
    },
    async runCommand(command: string) {
      events.push(`run:${command}`);
      return command.includes("rev-parse")
        ? { stdout: `${SHA}\n`, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

function logCapture() {
  const warnings: Warn[] = [];
  return {
    warnings,
    info: () => {},
    warn: (fields: Record<string, unknown>, msg?: string) => {
      warnings.push({ fields, msg });
    },
  };
}

function executionInput(
  sandbox: SandboxDouble,
  db: TestD1,
  log: { info(f?: Record<string, unknown>, m?: string): void; warn(f?: Record<string, unknown>, m?: string): void } = {
    info: () => {},
    warn: () => {},
  },
) {
  return {
    deps: { log, env: { DB: db, DASHBOARD_ENCRYPTION_KEY: TEST_KEY } },
    deadlineMs: Date.now() + 600_000,
    sandbox: sandbox as never,
    headSha: SHA,
    token: "ghs_sandbox_read",
    level: "default" as const,
    appCfg: { keys: {}, modelChain: "ark/deepseek-v4-flash" },
    fields: {},
    reconFacts: [],
    modelOverrides: undefined,
    customProviders: undefined,
    recheckInput: undefined,
    recheckAssignmentMaxBytes: undefined,
    prContext: undefined,
    runnerAnchor: {
      kind: "allocated" as const,
      requestedBudgetMs: 600_000,
      effectiveBudgetMs: 600_000,
      execDeadlineMs: Date.now() + 600_000,
    },
    observedChangedLines: null,
    progress: {
      failureStage: "pipeline" as const,
      secretValues: [] as string[],
      runnerStartedAt: undefined,
      runnerReturned: false,
    },
    attemptId: ATTEMPT,
    targetId: TARGET,
    usageWorkspaceId: WORKSPACE,
  };
}

function usageRows(db: TestD1) {
  return db.raw
    .query("SELECT * FROM review_token_usage WHERE attempt_id = ? ORDER BY provider, model")
    .all(ATTEMPT) as Array<Record<string, unknown>>;
}

async function claimedAttempt(db: TestD1): Promise<void> {
  expect(await claimReviewAttempt(db, ATTEMPT, Date.now(), null)).toBe("claimed");
}

describe("the runner's token-usage side document", () => {
  test("a valid document lands one row per (provider, model) in the SAME write that settles the review", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const sandbox = sandboxDouble(VALID_DOC);

    const execution = await runReviewAttempt(executionInput(sandbox, db));

    expect(execution.run.exitCode).toBe(0);
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("persisted");
    const rows = usageRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      provider: "ark",
      model: "deepseek-v4-flash",
      target_id: TARGET,
      workspace_id: WORKSPACE,
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      total_tokens: 155,
      requests: 3,
      cost_usd: 0.0123,
    });
    expect(rows[1]).toMatchObject({ provider: "openai", model: "gpt-5.2", total_tokens: 10, requests: 1 });
    expect(typeof rows[0]!["occurred_at"]).toBe("string");
    // One bounded read of the side document — the same transport as the applied-model read.
    expect(sandbox.events.filter((event) => event.includes(TOKEN_USAGE_PATH))).toHaveLength(1);
  });

  test("an absent document writes nothing and still settles the review", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const log = logCapture();

    const execution = await runReviewAttempt(executionInput(sandboxDouble(null), db, log));

    expect(execution.run.exitCode).toBe(0);
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("persisted");
    expect(usageRows(db)).toEqual([]);
    expect(log.warnings.filter((warning) => "token_usage" in warning.fields)).toEqual([]);
  });

  test("an invalid document writes nothing, logs once, and the review still settles", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const log = logCapture();

    const execution = await runReviewAttempt(executionInput(sandboxDouble(INVALID_DOC), db, log));

    expect(execution.run.exitCode).toBe(0);
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("persisted");
    expect(usageRows(db)).toEqual([]);
    const warnings = log.warnings.filter((warning) => warning.fields["token_usage"] === "invalid-document");
    expect(warnings).toHaveLength(1);
  });

  test("a usage write that cannot land is not recorded as finished — the completion batch rolls back", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const broken = failingDb(db, "INSERT INTO review_token_usage");
    const sandbox = sandboxDouble(VALID_DOC);

    await expect(
      runReviewAttempt({ ...executionInput(sandbox, db), deps: { log: logCapture(), env: { DB: broken, DASHBOARD_ENCRYPTION_KEY: TEST_KEY } } }),
    ).rejects.toBeInstanceOf(AttemptUnknownError);

    // Neither side landed: the row stays `launched` (the existing unknown-outcome
    // semantics decide the attempt, unchanged) and no usage rows survive.
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("launched");
    expect(usageRows(db)).toEqual([]);
  });
});
