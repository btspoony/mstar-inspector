
import { describe, expect, test } from "bun:test";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { DestroyOutcome, MarkedRun, ProvisionOutcome } from "../../src/pipeline/sandbox";
import type { D1Like } from "../../src/store/types";
import { secretTransforms } from "../../src/pipeline/redact";
import { TEST_KEY, failingDb } from "../helpers/consumer-fixtures";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

import "../helpers/cloudflare-workers-mock";

const {
  AttemptUnknownError,
  recordReviewFailure,
  ContainerNotRunningError,
  ContainerUnavailableError,
  attemptMarker,
  claimReviewAttempt,
  claimReviewLaunch,
  completeReviewLaunch,
  prepareReviewAttempt,
  launchVerdict,
  readReviewLaunch,
  runReviewAttempt,
} = await import("../../src/pipeline/review-attempt");
const { RUNNER_PATH } = await import("../../src/pipeline/gitops");
const { REPORT_OUTPUT_PATH } = await import("../../packages/shared/src/report-wire");

const ATTEMPT = "2b0c4f8e-7a11-4a4e-9b1f-2a5f4f2f1c01";
const SHA = "a".repeat(40);

const PAYLOAD = {
  installation_id: 123,
  owner: "acme",
  repo: "widgets",
  pr_number: 42,
  head_sha: SHA,
  botRef: { appId: "app-id" },
} as unknown as ReviewJobPayload;

const GRANT = {
  token: "ghs_sandbox_read",
  permissions: { contents: "read", metadata: "read", pull_requests: "read" },
  repositorySelection: "selected",
  repositoryNames: ["widgets"],
};

function log() {
  return { info: () => {}, warn: () => {} };
}

function progress() {
  return {
    failureStage: "pipeline" as const,
    secretValues: [] as string[],
    runnerStartedAt: undefined,
    runnerReturned: false,
  };
}

type SandboxDouble = {
  events: string[];
  counts: { paidCalls: number };
  provision(marker: string, opts: { deadlineEpochMs: number }): Promise<ProvisionOutcome>;
  runMarked(marker: string, command: string): Promise<MarkedRun>;
  runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  destroyMarked(): Promise<DestroyOutcome>;
  destroy(): Promise<void>;
};

function sandboxDouble(
  decision: {
    lostReply?: boolean;
    marker?: "present" | "absent" | "foreign";
    vanishAfterProof?: boolean;
    markerClaimThrows?: boolean;
    guardedThrows?: "proof" | "command";
    paidStdout?: string;
    paidExitCode?: number;
    reportDoc?: string;
  } = {},
): SandboxDouble {
  const events: string[] = [];
  const counts = { paidCalls: 0 };
  const container = { marked: decision.marker === "present", proofServed: false, guardedCalls: 0 };
  return {
    events,
    counts,
    async provision(marker: string) {
      events.push(`provision:${marker}`);
      if (decision.markerClaimThrows === true) return { kind: "unavailable" as const };
      if (decision.marker === "foreign") {
        container.marked = false;
        return { kind: "provisioned" as const };
      }
      container.marked = true;
      return { kind: "provisioned" as const };
    },
    async runMarked(_marker: string, command: string) {
      events.push(`marked:${command}`);
      container.guardedCalls += 1;
      if (command.includes(RUNNER_PATH)) {
        counts.paidCalls += 1;
        if (decision.lostReply === true) throw new Error("container exec reply lost");
      }
      if (
        decision.guardedThrows === "proof" ||
        (decision.guardedThrows === "command" && container.guardedCalls > 1)
      ) {
        throw new Error("guarded read reply lost");
      }
      if (!container.marked) return { kind: "not-running" as const };
      if (decision.vanishAfterProof === true) {
        if (container.proofServed) return { kind: "marker-mismatch" as const };
        container.proofServed = true;
      }
      return {
        kind: "ran" as const,
        stdout: command.includes("rev-parse")
          ? `${SHA}\n`
          : command.includes(RUNNER_PATH)
            ? (decision.paidStdout ?? "")
            :
              command.includes(REPORT_OUTPUT_PATH)
              ? `${decision.reportDoc ?? ""}\n0\n`
              : "",
        stderr: "",
        exitCode: command.includes(RUNNER_PATH) ? (decision.paidExitCode ?? 0) : 0,
      };
    },
    async runCommand(command: string) {
      events.push(`run:${command}`);
      if (command.includes(RUNNER_PATH)) {
        counts.paidCalls += 1;
        if (decision.lostReply === true) throw new Error("container exec reply lost");
      }
      return command.includes("rev-parse")
        ? { stdout: `${SHA}\n`, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 };
    },
    async destroyMarked() {
      events.push("destroyMarked");
      return "unknown" as const;
    },
    async destroy() {
      events.push("destroy");
    },
  };
}


function executionInput(sandbox: SandboxDouble, db: TestD1) {
  return {
    deps: { log: log(), env: { DB: db, DASHBOARD_ENCRYPTION_KEY: TEST_KEY } },
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
    progress: progress(),
    attemptId: ATTEMPT,
    identity: null,
  };
}

async function claimedAttempt(db: TestD1): Promise<void> {
  expect(await claimReviewAttempt(db, ATTEMPT, Date.now(), null)).toBe("claimed");
}

function prepareInput(db: TestD1, sandbox: SandboxDouble | null, envDb: D1Like = db) {
  return {
    payload: PAYLOAD,
    deps: {
      env: { SANDBOX: {}, DB: envDb },
      getSandbox: async () => (sandbox ?? sandboxDouble()) as never,
    },
    commenter: { getInstallationToken: async () => GRANT as never },
    attemptId: ATTEMPT,
    identity: null,
    sandbox: sandbox as never,
    onSandbox: () => {},
    progress: progress(),
    runnerCutoffMs: Date.now() + 120_000,
  };
}

describe("the paid step is taken at most once per attempt", () => {
  test("the first entry claims the launch, pays once and leaves a durable result", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const sandbox = sandboxDouble({ marker: "present" });

    const execution = await runReviewAttempt(executionInput(sandbox, db));

    expect(sandbox.counts.paidCalls).toBe(1);
    expect(execution.run.exitCode).toBe(0);
    const row = await readReviewLaunch(db, ATTEMPT);
    expect(row?.state).toBe("persisted");
    expect(row).toMatchObject({ execution: { run: { exitCode: 0 } } });
  });

  test("a lost reply leaves the attempt launched, and a retried entry refuses a second launch", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);

    await expect(
      runReviewAttempt(executionInput(sandboxDouble({ marker: "present", lostReply: true }), db)),
    ).rejects.toThrow(/reply was lost/);
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("launched");

    const retry = sandboxDouble();
    await expect(runReviewAttempt(executionInput(retry, db))).rejects.toMatchObject({
      name: "AttemptUnknownError",
      code: "review.paid.reply_lost",
    });
    expect(retry.counts.paidCalls).toBe(0);
    expect(retry.events).toEqual([]);
  });

  test("a restart refuses a second launch for an attempt the row already launched", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    expect(await claimReviewLaunch(db, ATTEMPT, Date.now())).toEqual({ ok: true });

    const sandbox = sandboxDouble();
    await expect(runReviewAttempt(executionInput(sandbox, db))).rejects.toBeInstanceOf(AttemptUnknownError);
    expect(sandbox.events).toEqual([]);
  });

  test("a persisted result is read back without calling the model again", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const first = await runReviewAttempt(executionInput(sandboxDouble({ marker: "present" }), db));

    const replay = sandboxDouble();
    const again = await runReviewAttempt(executionInput(replay, db));

    expect(again).toEqual(first);
    expect(replay.events).toEqual([]);
    expect(replay.counts.paidCalls).toBe(0);
  });

  test("an attempt that never prepared holds no claim and nothing is launched", async () => {
    const db = createMigratedTestD1();
    const sandbox = sandboxDouble();

    await expect(runReviewAttempt(executionInput(sandbox, db))).rejects.toMatchObject({
      name: "AttemptUnknownError",
      code: "review.container.lost_before_paid",
    });
    expect(sandbox.events).toEqual([]);
    expect(await readReviewLaunch(db, ATTEMPT)).toBeNull();
  });

  test("a rejected launch claim is unknown: the paid step is not taken", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const sandbox = sandboxDouble({ marker: "present" });

    await expect(
      runReviewAttempt({
        ...executionInput(sandbox, db),
        deps: {
          log: log(),
          env: { DB: failingDb(db, "SET state = 'launched'"), DASHBOARD_ENCRYPTION_KEY: TEST_KEY },
        },
      }),
    ).rejects.toBeInstanceOf(AttemptUnknownError);

    expect(sandbox.events.filter((event) => event.includes(RUNNER_PATH))).toEqual([]);
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("provisioned");
  });

  test("a rejected completion write after a returned paid call is unknown, and the row stays launched", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const sandbox = sandboxDouble({ marker: "present" });

    await expect(
      runReviewAttempt({
        ...executionInput(sandbox, db),
        deps: {
          log: log(),
          env: { DB: failingDb(db, "SET state = 'persisted'"), DASHBOARD_ENCRYPTION_KEY: TEST_KEY },
        },
      }),
    ).rejects.toBeInstanceOf(AttemptUnknownError);

    expect(sandbox.counts.paidCalls).toBe(1);
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("launched");
  });
});

describe("the state machine cannot be walked twice", () => {
  test("claiming, launching and completing each succeed once and refuse the second call", async () => {
    const db = createMigratedTestD1();

    expect(await claimReviewAttempt(db, ATTEMPT, Date.now(), null)).toBe("claimed");
    expect(await claimReviewAttempt(db, ATTEMPT, Date.now(), null)).toBe("already-claimed");

    expect(await claimReviewLaunch(db, ATTEMPT, Date.now())).toEqual({ ok: true });
    expect(await claimReviewLaunch(db, ATTEMPT, Date.now())).toEqual({
      ok: false,
      reason: "already-launched",
    });

    const execution = { run: { stdout: "{}", stderr: "", exitCode: 0 }, recheck: null, report: null, appliedProvider: null };
    expect(await completeReviewLaunch(db, ATTEMPT, execution, Date.now())).toBe(true);
    expect(await completeReviewLaunch(db, ATTEMPT, execution, Date.now())).toBe(false);

    const refused = await claimReviewLaunch(db, ATTEMPT, Date.now());
    expect(refused.ok).toBe(false);
    expect(await readReviewLaunch(db, ATTEMPT)).toMatchObject({ state: "persisted" });
  });

  test("the schema refuses a completion that does not carry the result", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    expect(await claimReviewLaunch(db, ATTEMPT, Date.now())).toEqual({ ok: true });

    expect(() =>
      db
        .prepare("UPDATE review_launches SET state = 'persisted', persisted_at_ms = ? WHERE attempt_id = ?")
        .bind(Date.now(), ATTEMPT)
        .run(),
    ).toThrow();
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("launched");
  });
});

describe("a terminal row cannot authorise anything without its coupled outcome", () => {
  test("the schema refuses a failed row with no result_outcome", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    expect(await claimReviewLaunch(db, ATTEMPT, Date.now())).toEqual({ ok: true });

    expect(() =>
      db
        .prepare("UPDATE review_launches SET state = 'failed', failed_at_ms = ? WHERE attempt_id = ?")
        .bind(Date.now(), ATTEMPT)
        .run(),
    ).toThrow();
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("launched");
  });

  test("a stored terminal row whose outcome cannot be read decodes as unreadable, not as permission", async () => {
    const row = {
      state: "failed",
      claimed_at_ms: 1,
      launched_at_ms: 2,
      persisted_at_ms: null,
      failed_at_ms: 3,
      abandoned_at_ms: null,
      result_json: null,
      result_outcome: null,
      check_owed_ms: null,
    };
    const stub = {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    } as unknown as D1Like;

    const decoded = await readReviewLaunch(stub, ATTEMPT);
    expect(decoded?.state).toBe("unknown");
    expect(launchVerdict(decoded)).toEqual({ kind: "unrecognised" });
  });

  test("a returned status leaves the row launched: the transition waits for the durable failure row", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);

    await expect(
      runReviewAttempt(executionInput(sandboxDouble({ marker: "present", paidExitCode: 1 }), db)),
    ).rejects.toThrow();

    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("launched");
  });
});

describe("an unpayable row's code names the history that made it unpayable", () => {
  test("a paid call that returned a failure says a paid step ran, not that a reply was lost", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    expect(await claimReviewLaunch(db, ATTEMPT, Date.now())).toEqual({ ok: true });
    expect(await recordReviewFailure(db, ATTEMPT, Date.now())).toBe(true);

    await expect(runReviewAttempt(executionInput(sandboxDouble(), db))).rejects.toMatchObject({
      name: "AttemptUnknownError",
      code: "review.container.lost_after_claim",
    });
  });

  test("a persisted result that cannot be decoded never claims that nothing ran", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    expect(await claimReviewLaunch(db, ATTEMPT, Date.now())).toEqual({ ok: true });
    expect(
      await completeReviewLaunch(
        db,
        ATTEMPT,
        { run: { stdout: "", stderr: "", exitCode: 0 }, recheck: null, report: null, appliedProvider: null },
        Date.now(),
      ),
    ).toBe(true);
    db.prepare("UPDATE review_launches SET result_json = ? WHERE attempt_id = ?").bind("not json", ATTEMPT).run();

    await expect(runReviewAttempt(executionInput(sandboxDouble(), db))).rejects.toMatchObject({
      name: "AttemptUnknownError",
      code: "review.internal.unclassified",
    });
  });

  test("a cleanup-owned or unrecognised row stays before-paid: nothing was charged", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    db.prepare("UPDATE review_launches SET state = 'abandoned', abandoned_at_ms = ? WHERE attempt_id = ?")
      .bind(Date.now(), ATTEMPT)
      .run();

    await expect(runReviewAttempt(executionInput(sandboxDouble(), db))).rejects.toMatchObject({
      name: "AttemptUnknownError",
      code: "review.container.lost_before_paid",
    });
  });
});

describe("no runner output reaches durable storage before redaction", () => {
  test("every string the paid run produced is exact-redacted on the host that holds the key", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const secret = "sk-live-9f2a44c1d3";
    const sandbox = sandboxDouble({
      marker: "present",
      paidStdout: `{"note":"${secret}"}`,
      reportDoc: JSON.stringify({
        schema: "mstar.report/v1",
        headSha: SHA,
        overview: `overview mentioning ${secret}`,
        linkedIssueAc: "none",
        verified: "none",
        rejected: "none",
        planToFix: "none",
      }),
    });

    const execution = await runReviewAttempt({
      ...executionInput(sandbox, db),
      appCfg: { keys: { ark: [secret] }, modelChain: "ark/deepseek-v4-flash" },
      prContext: { prBody: "", issues: [] },
    });

    expect(execution.run.stdout).not.toContain(secret);
    expect(execution.run.stdout).toContain("[REDACTED]");
    expect(execution.report?.overview).not.toContain(secret);
    expect(execution.report?.overview).toContain("[REDACTED]");
    const stored = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT) as { result_json: string };
    expect(stored.result_json).not.toContain(secret);
    const row = JSON.parse(stored.result_json) as {
      run: { stdout: string };
      report: { overview: string } | null;
    };
    expect(row.run.stdout).toBe(execution.run.stdout);
    expect(row.report?.overview).toBe(execution.report?.overview);
  });

  test("every transformed echo of the key is gone from the stored payload", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const secret = "sk-live/9f2a44c1d3";
    const forms = secretTransforms(secret);
    const echoes = [forms.raw, forms.urlEncoded, forms.base64, forms.base64url, forms.hex];
    const stdout =
      `{"schema":"mstar.review/v1","target":{"head_sha":"${SHA}"},"attempt_id":"${ATTEMPT}",` +
      `"score":0.5,"blocked":false,"echoes":${JSON.stringify(echoes)},` +
      `"escaped":"sk-live\\u002f9f2a44c1d3"}`;

    const execution = await runReviewAttempt({
      ...executionInput(sandboxDouble({ marker: "present", paidStdout: stdout }), db),
      appCfg: { keys: { ark: [secret] }, modelChain: "ark/deepseek-v4-flash" },
    });

    const stored = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT) as { result_json: string };
    const row = JSON.parse(stored.result_json) as { run: { stdout: string; exitCode: number } };
    const envelope = JSON.parse(row.run.stdout) as {
      target: { head_sha: string };
      attempt_id: string;
      score: number;
      blocked: boolean;
      echoes: string[];
      escaped: string;
    };
    expect(envelope.echoes).toEqual(Array(5).fill("[REDACTED]"));
    expect(envelope.escaped).toBe("[REDACTED]");
    expect(envelope.target.head_sha).toBe(SHA);
    expect(envelope.attempt_id).toBe(ATTEMPT);
    expect(envelope.score).toBe(0.5);
    expect(envelope.blocked).toBe(false);
    expect(row.run.exitCode).toBe(0);
    expect(execution.run.stdout).toBe(row.run.stdout);
    expect(row.run.stdout).not.toBe(stdout);
  });

  test("a short provider key is removed only as a whole value in the stored payload", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const key = "mstar";
    const stdout = JSON.stringify({
      schema: "mstar.review/v1",
      target: { head_sha: SHA },
      attempt_id: ATTEMPT,
      summary_md: key,
    });

    await runReviewAttempt({
      ...executionInput(sandboxDouble({ marker: "present", paidStdout: stdout }), db),
      appCfg: { keys: { ark: [key] }, modelChain: "ark/deepseek-v4-flash" },
    });

    const stored = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT) as { result_json: string };
    const row = JSON.parse(stored.result_json) as { run: { stdout: string } };
    const envelope = JSON.parse(row.run.stdout) as {
      schema: string;
      summary_md: string;
      target: { head_sha: string };
    };
    expect(envelope.summary_md).toBe("[REDACTED]");
    expect(envelope.schema).toBe("mstar.review/v1");
    expect(envelope.target.head_sha).toBe(SHA);
  });

  test("a payload carrying no secret serializes byte-identically", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const stdout = JSON.stringify({
      schema: "mstar.review/v1",
      target: { head_sha: SHA },
      attempt_id: ATTEMPT,
      score: 1,
      blocked: false,
    });

    expect(JSON.stringify(JSON.parse(stdout))).toBe(stdout);

    await runReviewAttempt(executionInput(sandboxDouble({ marker: "present", paidStdout: stdout }), db));

    const stored = db.raw
      .prepare("SELECT result_json FROM review_launches WHERE attempt_id = ?")
      .get(ATTEMPT) as { result_json: string };
    expect(stored.result_json).toBe(
      JSON.stringify({
        run: { stdout, exitCode: 0 },
        recheck: null,
        report: null,
        appliedProvider: null,
      }),
    );
  });
});

describe("every prepare entry re-provisions the slot from scratch", () => {
  test("the first entry provisions and clones; a later entry provisions again instead of proving", async () => {
    const db = createMigratedTestD1();
    const first = sandboxDouble();
    await prepareReviewAttempt(prepareInput(db, first));
    expect(first.events.filter((event) => event.startsWith("provision:"))).toHaveLength(1);
    expect(await readReviewLaunch(db, ATTEMPT)).toMatchObject({ state: "provisioned" });

    const second = sandboxDouble({ marker: "present" });
    await expect(prepareReviewAttempt(prepareInput(db, second))).resolves.toMatchObject({ headSha: SHA });
    expect(second.events.filter((event) => event.startsWith("provision:"))).toHaveLength(1);
    // prepare's own steps are unguarded execs on the slot provision just declared
    expect(second.events.filter((event) => event.startsWith("marked:"))).toEqual([]);
    expect(second.events.filter((event) => event.startsWith("run:"))).toHaveLength(2);
  });

  test("the marker is written by provision, before any checkout command", async () => {
    const db = createMigratedTestD1();
    const sandbox = sandboxDouble();

    await prepareReviewAttempt(prepareInput(db, sandbox));

    expect(sandbox.events[0]).toBe(`provision:${attemptMarker(ATTEMPT)}`);
    expect(await readReviewLaunch(db, ATTEMPT)).not.toBeNull();
  });

  test("a slot that stops mid-prepare is a transient failure, not an unknown", async () => {
    const db = createMigratedTestD1();
    const sandbox = sandboxDouble({ marker: "present" });
    const stopped = new ContainerNotRunningError("the attempt container is not running");
    sandbox.runCommand = async (command: string) => {
      sandbox.events.push(`run:${command}`);
      throw stopped;
    };

    await expect(prepareReviewAttempt(prepareInput(db, sandbox))).rejects.toBeInstanceOf(
      ContainerNotRunningError,
    );
    // nothing was charged, and the row still authorises the next entry to start
    expect(await readReviewLaunch(db, ATTEMPT)).toMatchObject({ state: "provisioned" });
  });

  test("a rejected provisioning claim is unknown and provisions nothing", async () => {
    const db = createMigratedTestD1();
    const sandbox = sandboxDouble();

    await expect(
      prepareReviewAttempt(prepareInput(db, sandbox, failingDb(db, "INSERT INTO review_launches"))),
    ).rejects.toBeInstanceOf(AttemptUnknownError);

    expect(sandbox.events).toEqual([]);
    expect(await readReviewLaunch(db, ATTEMPT)).toBeNull();
  });
});

describe("a provisioning that cannot answer is transient", () => {
  test("an unavailable provision runs nothing and leaves the row provisioned for the retry", async () => {
    const db = createMigratedTestD1();
    const sandbox = sandboxDouble({ markerClaimThrows: true });

    await expect(prepareReviewAttempt(prepareInput(db, sandbox))).rejects.toBeInstanceOf(
      ContainerUnavailableError,
    );

    expect(sandbox.events.some((event) => event.startsWith("run:"))).toBe(false);
    expect(await readReviewLaunch(db, ATTEMPT)).toMatchObject({ state: "provisioned" });
  });
});
