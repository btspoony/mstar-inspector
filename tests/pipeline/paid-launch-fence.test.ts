/**
 * The paid-launch fence: one row per attempt decides who may provision, who
 * may pay, and whether a result is already durable.
 *
 * Proven here, in both directions: a lost reply, a retried entry and a restart
 * each leave the attempt `launched` and refuse a second launch (no exec, no
 * model); a persisted result is read back without touching the container; the
 * state machine cannot be walked twice because the statements are conditional
 * and the schema couples `persisted` to a stored result; and a replayed prepare
 * never provisions a second container for an attempt that already has one.
 */

import { describe, expect, test } from "bun:test";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { MarkedRun } from "../../src/pipeline/sandbox";
import { failingDb } from "../helpers/consumer-fixtures";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

// The shared mock must register the workerd builtin BEFORE the sandbox adapter
// loads, so those modules cannot be static imports here.
import "../helpers/cloudflare-workers-mock";

const {
  AttemptUnknownError,
  attemptMarker,
  claimReviewAttempt,
  claimReviewLaunch,
  completeReviewLaunch,
  prepareReviewAttempt,
  readReviewLaunch,
  runReviewAttempt,
} = await import("../../src/pipeline/review-attempt");
const { RUNNER_PATH } = await import("../../src/pipeline/gitops");

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

/**
 * The attempt module's view of a sandbox, with the test deciding the facts that
 * matter here: whether the paid exec's reply is lost, whether the container
 * already carries the attempt's marker, and whether that container is replaced
 * right after the replay proves it.
 */
type SandboxDouble = {
  events: string[];
  counts: { paidCalls: number };
  claimMarker(marker: string): Promise<"written" | "matched" | "unknown">;
  runMarked(marker: string, command: string): Promise<MarkedRun>;
  runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  destroyMarked(): Promise<"destroyed" | "unknown">;
  destroy(): Promise<void>;
};

function sandboxDouble(
  decision: { lostReply?: boolean; marker?: "present" | "absent" | "foreign"; vanishAfterProof?: boolean } = {},
): SandboxDouble {
  const events: string[] = [];
  const counts = { paidCalls: 0 };
  // The container's own filesystem: the claim writes these bytes, so a later
  // guarded read answers `ran` only on the incarnation the claim stamped.
  const container = { marked: decision.marker === "present", proofServed: false };
  return {
    events,
    counts,
    async claimMarker(marker: string) {
      events.push(`claim:${marker}`);
      if (decision.marker === "foreign") return "unknown" as const;
      container.marked = true;
      return "written" as const;
    },
    async runMarked(_marker: string, command: string) {
      events.push(`marked:${command}`);
      if (!container.marked) return { kind: "unknown" as const };
      // The proof lands on the incarnation that exists; a container replaced
      // immediately afterwards answers `unknown` to every later guarded
      // command, so the caller must not act on a replacement.
      if (decision.vanishAfterProof === true) {
        if (container.proofServed) return { kind: "unknown" as const };
        container.proofServed = true;
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
    deps: { log: log(), env: { DB: db } },
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
  };
}

/** The row an attempt that prepared successfully would already carry. */
async function claimedAttempt(db: TestD1): Promise<void> {
  expect(await claimReviewAttempt(db, ATTEMPT, Date.now())).toBe("claimed");
}

function prepareInput(db: TestD1, sandbox: SandboxDouble | null) {
  return {
    payload: PAYLOAD,
    deps: {
      env: { SANDBOX: {}, DB: db },
      getSandbox: async () => (sandbox ?? sandboxDouble()) as never,
    },
    commenter: { getInstallationToken: async () => GRANT as never },
    attemptId: ATTEMPT,
    sandbox: sandbox as never,
    onSandbox: () => {},
    progress: progress(),
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

    await expect(runReviewAttempt(executionInput(sandboxDouble({ lostReply: true }), db))).rejects.toThrow(
      "container exec reply lost",
    );
    // The ambiguity is RECORDED, not resolved by retrying: the row says the
    // paid step was taken and no result is durable.
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("launched");

    const retry = sandboxDouble();
    await expect(runReviewAttempt(executionInput(retry, db))).rejects.toBeInstanceOf(AttemptUnknownError);
    expect(retry.counts.paidCalls).toBe(0);
    expect(retry.events).toEqual([]);
  });

  test("a restart refuses a second launch for an attempt the row already launched", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    expect(await claimReviewLaunch(db, ATTEMPT, Date.now())).toEqual({ ok: true });

    // A fresh entry after a process restart holds no in-memory state; the row
    // is the only witness, and it refuses.
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

    await expect(runReviewAttempt(executionInput(sandbox, db))).rejects.toBeInstanceOf(AttemptUnknownError);
    expect(sandbox.events).toEqual([]);
    expect(await readReviewLaunch(db, ATTEMPT)).toBeNull();
  });

  test("a rejected launch claim is unknown: the paid step is not taken", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const sandbox = sandboxDouble({ marker: "present" });

    // The claim's reply is lost. It may have landed, so the attempt may already
    // own its one paid step — that is `unknown`, never a settleable failure and
    // never a second launch.
    await expect(
      runReviewAttempt({
        ...executionInput(sandbox, db),
        deps: { log: log(), env: { DB: failingDb(db, "SET state = 'launched'") } },
      }),
    ).rejects.toBeInstanceOf(AttemptUnknownError);

    expect(sandbox.events).toEqual([]);
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("pending");
  });

  test("a rejected completion write after a returned paid call is unknown, and the row stays launched", async () => {
    const db = createMigratedTestD1();
    await claimedAttempt(db);
    const sandbox = sandboxDouble({ marker: "present" });

    await expect(
      runReviewAttempt({
        ...executionInput(sandbox, db),
        deps: { log: log(), env: { DB: failingDb(db, "SET state = 'persisted'") } },
      }),
    ).rejects.toBeInstanceOf(AttemptUnknownError);

    // The paid call did run; only its durability is unconfirmed.
    expect(sandbox.counts.paidCalls).toBe(1);
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("launched");
  });
});

describe("the state machine cannot be walked twice", () => {
  test("claiming, launching and completing each succeed once and refuse the second call", async () => {
    const db = createMigratedTestD1();

    expect(await claimReviewAttempt(db, ATTEMPT, Date.now())).toBe("claimed");
    expect(await claimReviewAttempt(db, ATTEMPT, Date.now())).toBe("already-claimed");

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

    // Bypassing the module: the state may not reach `persisted` without the
    // result in the same row, so completion cannot outrun durability.
    expect(() =>
      db
        .prepare("UPDATE review_launches SET state = 'persisted', persisted_at_ms = ? WHERE attempt_id = ?")
        .bind(Date.now(), ATTEMPT)
        .run(),
    ).toThrow();
    expect((await readReviewLaunch(db, ATTEMPT))?.state).toBe("launched");
  });
});

describe("a replayed prepare never provisions a second container", () => {
  test("the first entry writes the marker and every later entry only proves it", async () => {
    const db = createMigratedTestD1();
    const first = sandboxDouble();
    await prepareReviewAttempt(prepareInput(db, first));
    expect(first.events.filter((event) => event.startsWith("claim:"))).toHaveLength(1);
    expect(await readReviewLaunch(db, ATTEMPT)).toMatchObject({ state: "pending" });

    // A replaced container (empty filesystem) is refused WITHOUT writing a
    // marker on it: the row already says this attempt provisioned.
    const replacement = sandboxDouble({ marker: "absent" });
    await expect(prepareReviewAttempt(prepareInput(db, replacement))).rejects.toBeInstanceOf(
      AttemptUnknownError,
    );
    expect(replacement.events.filter((event) => event.startsWith("claim:"))).toEqual([]);
    expect(replacement.events).toEqual([`marked:true`]);

    // The same live incarnation still proceeds: a replay is refused a second
    // container, not a second look at the first one.
    const same = sandboxDouble({ marker: "present" });
    await expect(prepareReviewAttempt(prepareInput(db, same))).resolves.toMatchObject({ headSha: SHA });
    expect(same.events.filter((event) => event.startsWith("claim:"))).toEqual([]);
  });

  test("the marker is written by the entry that claimed the row, before any checkout", async () => {
    const db = createMigratedTestD1();
    const sandbox = sandboxDouble();

    await prepareReviewAttempt(prepareInput(db, sandbox));

    expect(sandbox.events[0]).toBe(`claim:${attemptMarker(ATTEMPT)}`);
    // Provisioning is granted by the row, so the claim exists before anything
    // touched the container.
    expect(await readReviewLaunch(db, ATTEMPT)).not.toBeNull();
  });

  test("a container replaced between the replay's proof and its commands runs nothing", async () => {
    const db = createMigratedTestD1();
    await prepareReviewAttempt(prepareInput(db, sandboxDouble()));

    // The proof lands on the incarnation that exists; the container is gone
    // before the clone, so every later command must stay guarded and refuse.
    const replaced = sandboxDouble({ marker: "present", vanishAfterProof: true });
    await expect(prepareReviewAttempt(prepareInput(db, replaced))).rejects.toBeInstanceOf(
      AttemptUnknownError,
    );

    // Nothing was run through the start-permitted path: an unguarded clone here
    // would have started (and used) a replacement the proof never covered.
    expect(replaced.events.some((event) => event.startsWith("run:"))).toBe(false);
    expect(replaced.events.filter((event) => event.startsWith("marked:"))).toHaveLength(2);
  });
});
