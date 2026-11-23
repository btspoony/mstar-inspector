
import { describe, expect, mock, test } from "bun:test";
import type { ExecOutput } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { ReviewSandbox } from "../../src/pipeline/sandbox";
import { TEST_KEY } from "../helpers/consumer-fixtures";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

import "../helpers/cloudflare-workers-mock";

const { SandboxV1, shellCommand } = await import("../../src/pipeline/sandbox");
const {
  AttemptUnknownError,
  attemptMarker,
  attemptSandboxId,
  claimReviewAttempt,
  discardReviewAttempt,
  prepareReviewAttempt,
  runReviewAttempt,
} = await import("../../src/pipeline/review-attempt");

const ATTEMPT_A = "2b0c4f8e-7a11-4a4e-9b1f-2a5f4f2f1c01";
const ATTEMPT_B = "9d7e1a20-33c4-4f0b-8a6d-51c9d2e7b902";
const SHA = "a".repeat(40);
const RETAINED = { kind: "retained" } as const;

const encoder = new TextEncoder();

function bytes(text: string): ArrayBuffer {
  return encoder.encode(text).buffer as ArrayBuffer;
}


type MarkerContainer = {
  running: boolean;
  marker: string | null;
  images: Record<string, string>;
  startCalls: number;
  ran: string[];
  markerReads: number;
  execRejects: boolean;
  slow: Promise<void> | undefined;
  onMarkerRead: (() => void) | undefined;
  destroyed: boolean;
  start(opts: unknown): void;
  setInactivityTimeout(ms: number): Promise<void>;
  exec(cmd: string[], opts?: unknown): Promise<{ output: () => Promise<ExecOutput>; stdin: null }>;
  destroy(): Promise<void>;
};

function makeContainer(running = false): MarkerContainer {
  const container: MarkerContainer = {
    running,
    marker: null,
    images: { sandbox: "registry.example/review-sandbox@sha256:abc" },
    startCalls: 0,
    ran: [],
    markerReads: 0,
    execRejects: false,
    slow: undefined,
    onMarkerRead: undefined,
    destroyed: false,
    start() {
      container.startCalls += 1;
      container.running = true;
    },
    async setInactivityTimeout() {},
    async exec(cmd, opts) {
      const command = cmd[cmd.length - 1] ?? "";
      const env = (opts as { env?: Record<string, string> } | undefined)?.env ?? {};
      const answer = (stdout: string, exitCode: number) => ({
        output: async () =>
          ({ stdout: bytes(stdout), stderr: new ArrayBuffer(0), exitCode }) as unknown as ExecOutput,
        stdin: null,
      });
      if (command.includes("mstar-review-attempt")) {
        if (command.includes("printf")) {
          if (container.marker !== null) return answer("", 1);
          container.marker = env["MSTAR_ATTEMPT_MARKER"] ?? "";
          return answer("", 0);
        }
        container.markerReads += 1;
        const served = container.marker === null ? answer("", 3) : answer(container.marker, 0);
        container.onMarkerRead?.();
        return served;
      }
      if (container.slow !== undefined && command.includes("slow")) await container.slow;
      if (container.execRejects) throw new Error("container exec reply lost");
      container.ran.push(command);
      return answer("ran", 0);
    },
    async destroy() {
      container.destroyed = true;
      container.running = false;
    },
  };
  return container;
}

function storageDouble() {
  const durable = new Map<string, unknown>();
  return { get: async (key: string) => durable.get(key), put: async (key: string, value: unknown) => void durable.set(key, value) };
}

function makeDo(container: MarkerContainer) {
  const ctx = {
    container,
    storage: storageDouble(),
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  };
  return new SandboxV1(ctx as never, {}) as unknown as ReviewSandbox;
}

function makeSwappableDo(container: MarkerContainer) {
  const ctx: { container: MarkerContainer; blockConcurrencyWhile: (fn: () => Promise<unknown>) => Promise<unknown> } = {
    container,
    blockConcurrencyWhile: (fn) => fn(),
  };
  const sandbox = new SandboxV1(
    {
      get container() {
        return ctx.container;
      },
      storage: storageDouble(),
      blockConcurrencyWhile: ctx.blockConcurrencyWhile,
    } as never,
    {},
  ) as unknown as ReviewSandbox;
  return { sandbox, ctx };
}


type SandboxDouble = {
  events: string[];
  claimMarker: (marker: string) => Promise<"written" | "matched" | "unknown">;
  runMarked: (
    marker: string,
    command: string,
  ) => Promise<{ kind: "ran"; stdout: string; stderr: string; exitCode: number } | { kind: "unknown" }>;
  destroyMarked: (marker: string) => Promise<"destroyed" | "unknown">;
  runCommand: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  destroy: () => Promise<void>;
};

function attemptSandboxDouble(decision: {
  claim?: "written" | "matched" | "unknown";
  marked?: "ran" | "unknown";
  markedRejected?: boolean;
}): SandboxDouble {
  const events: string[] = [];
  const sandbox = {
    events,
    claimMarker: mock(async (marker: string) => {
      events.push(`claim:${marker}`);
      return decision.claim ?? "written";
    }),
    runMarked: mock(async (_marker: string, command: string) => {
      events.push(`marked:${command}`);
      if (decision.markedRejected === true) throw new Error("rpc lost");
      return decision.marked === "unknown"
        ? ({ kind: "unknown" as const } as const)
        : { kind: "ran" as const, stdout: "", stderr: "", exitCode: 0 };
    }),
    destroyMarked: mock(async () => {
      events.push("destroyMarked");
      return decision.marked === "unknown" ? ("unknown" as const) : ("destroyed" as const);
    }),
    runCommand: mock(async (command: string) => {
      events.push(`run:${command}`);
      return command.includes("rev-parse")
        ? { stdout: `${SHA}\n`, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 };
    }),
    destroy: mock(async () => {
      events.push("destroy");
    }),
  };
  return sandbox;
}

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

function progress() {
  return {
    failureStage: "pipeline" as const,
    secretValues: [] as string[],
    runnerStartedAt: undefined,
    runnerReturned: false,
  };
}

describe("attempt identity", () => {
  test("the container name and the marker derive from the attempt id alone", () => {
    expect(attemptSandboxId(ATTEMPT_A)).toBe(`review-${ATTEMPT_A}`);
    expect(attemptSandboxId(ATTEMPT_A)).not.toBe(attemptSandboxId(ATTEMPT_B));

    expect(attemptMarker(ATTEMPT_A)).toBe(`mstar.review-attempt/v1:${ATTEMPT_A}\n`);
    expect(attemptMarker(ATTEMPT_A)).toMatch(/^mstar\.review-attempt\/v1:[0-9a-f-]+\n$/);
    expect(attemptMarker(ATTEMPT_A.toUpperCase())).toBe(attemptMarker(ATTEMPT_A));
  });
});

describe("prepare writes the marker before any checkout work", () => {
  test("the container is resolved by attempt id and claimed before the clone", async () => {
    const db = createMigratedTestD1();
    const sandbox = attemptSandboxDouble({});
    const acquired: string[] = [];
    const prepared = await prepareReviewAttempt({
      payload: PAYLOAD,
      deps: {
        env: { SANDBOX: {}, DB: db },
        getSandbox: async (_binding: unknown, id: string) => {
          acquired.push(id);
          return sandbox as never;
        },
      },
      commenter: { getInstallationToken: async () => GRANT as never },
      attemptId: ATTEMPT_A,
      identity: null,
      sandbox: null,
      onSandbox: () => {},
      progress: progress(),
    });

    expect(acquired).toEqual([`review-${ATTEMPT_A}`]);
    expect(prepared.headSha).toBe(SHA);
    expect(sandbox.events[0]).toBe(`claim:${attemptMarker(ATTEMPT_A)}`);
  });

  test("a container carrying other bytes is refused, and no checkout runs on it", async () => {
    const db = createMigratedTestD1();
    const sandbox = attemptSandboxDouble({ claim: "unknown" });
    await expect(
      prepareReviewAttempt({
        payload: PAYLOAD,
        deps: { env: { SANDBOX: {}, DB: db }, getSandbox: async () => sandbox as never },
        commenter: { getInstallationToken: async () => GRANT as never },
        attemptId: ATTEMPT_A,
      identity: null,
        sandbox: null,
        onSandbox: () => {},
        progress: progress(),
      }),
    ).rejects.toBeInstanceOf(AttemptUnknownError);

    expect(sandbox.events.some((event) => event.startsWith("run:"))).toBe(false);
  });
});

describe("collection refuses an unproven container", () => {
  const executionInput = (sandbox: SandboxDouble, db: TestD1) => ({
    // note: The paid step seals the session's gate credential set, so the host
    // channel carries the deployment's envelope key.
    deps: {
      log: { info: () => {}, warn: () => {} },
      env: { DB: db, DASHBOARD_ENCRYPTION_KEY: TEST_KEY },
    },
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
    attemptId: ATTEMPT_A,
    identity: null,
  });

  test("a missing/different marker yields unknown, never a collected result", async () => {
    const db = createMigratedTestD1();
    await claimReviewAttempt(db, ATTEMPT_A, Date.now(), null);
    const sandbox = attemptSandboxDouble({ marked: "unknown" });
    await expect(runReviewAttempt(executionInput(sandbox, db))).rejects.toBeInstanceOf(AttemptUnknownError);

    expect(sandbox.events.filter((event) => event.startsWith("marked:"))).toHaveLength(1);
  });

  test("a rejected guarded read is unknown, not an unreadable document", async () => {
    const db = createMigratedTestD1();
    await claimReviewAttempt(db, ATTEMPT_A, Date.now(), null);
    const sandbox = attemptSandboxDouble({ markedRejected: true });
    await expect(runReviewAttempt(executionInput(sandbox, db))).rejects.toBeInstanceOf(AttemptUnknownError);
  });

  test("a matching live incarnation collects the result documents", async () => {
    const db = createMigratedTestD1();
    await claimReviewAttempt(db, ATTEMPT_A, Date.now(), null);
    const sandbox = attemptSandboxDouble({ marked: "ran" });
    const execution = await runReviewAttempt(executionInput(sandbox, db));

    expect(execution.run.exitCode).toBe(0);
    expect(execution.appliedProvider).toBeNull();
    expect(sandbox.events.filter((event) => event.startsWith("marked:"))).toHaveLength(3);
  });
});

describe("destroy refuses an unproven container", () => {
  test("no marker match: nothing is destroyed and the outcome is unknown", async () => {
    const sandbox = attemptSandboxDouble({ marked: "unknown" });
    expect(await discardReviewAttempt(sandbox as never, ATTEMPT_A, RETAINED)).toBe("unknown");
    expect(sandbox.events).not.toContain("destroy");
  });

  test("a matching live incarnation is destroyed", async () => {
    const sandbox = attemptSandboxDouble({});
    expect(await discardReviewAttempt(sandbox as never, ATTEMPT_A, RETAINED)).toBe("destroyed");
    expect(sandbox.events).toContain("destroyMarked");
  });
});

describe("SandboxV1 marker gate", () => {
  test("the marker is written exactly once, and an occupied marker is never repaired", async () => {
    const container = makeContainer();
    const sandbox = makeDo(container);
    const marker = attemptMarker(ATTEMPT_A);

    expect(await sandbox.claimMarker(marker)).toBe("written");
    expect(container.marker).toBe(marker);

    expect(await sandbox.claimMarker(marker)).toBe("matched");
    expect(await sandbox.claimMarker(attemptMarker(ATTEMPT_B))).toBe("unknown");
    expect(container.marker).toBe(marker);
  });

  test("a probe never starts a container and never runs a command on a dead one", async () => {
    const container = makeContainer(false);
    const sandbox = makeDo(container);

    expect(await sandbox.runMarked(attemptMarker(ATTEMPT_A), shellCommand("cat result.json"))).toEqual({
      kind: "unknown",
    });
    expect(await sandbox.destroyMarked(attemptMarker(ATTEMPT_A), RETAINED)).toBe("unknown");

    expect(container.startCalls).toBe(0);
    expect(container.ran).toEqual([]);
    expect(container.destroyed).toBe(false);
  });

  test("a live container without this attempt's marker runs and destroys nothing", async () => {
    const container = makeContainer(true);
    const sandbox = makeDo(container);
    container.marker = attemptMarker(ATTEMPT_B);

    expect(await sandbox.runMarked(attemptMarker(ATTEMPT_A), shellCommand("cat result.json"))).toEqual({
      kind: "unknown",
    });
    expect(await sandbox.destroyMarked(attemptMarker(ATTEMPT_A), RETAINED)).toBe("unknown");

    expect(container.ran).toEqual([]);
    expect(container.destroyed).toBe(false);
  });

  test("a replacement between preparation and the gated operation refuses both", async () => {
    const container = makeContainer();
    const sandbox = makeDo(container);
    const marker = attemptMarker(ATTEMPT_A);
    expect(await sandbox.claimMarker(marker)).toBe("written");

    container.marker = null;

    expect(await sandbox.runMarked(marker, shellCommand("cat result.json"))).toEqual({ kind: "unknown" });
    expect(await sandbox.destroyMarked(marker, RETAINED)).toBe("unknown");
    expect(container.ran).toEqual([]);
    expect(container.destroyed).toBe(false);
  });

  test("a guarded command whose reply is lost reports unknown", async () => {
    const container = makeContainer(true);
    const sandbox = makeDo(container);
    const marker = attemptMarker(ATTEMPT_A);
    container.marker = marker;
    container.execRejects = true;

    expect(await sandbox.runMarked(marker, shellCommand("cat result.json"))).toEqual({ kind: "unknown" });
    expect(container.markerReads).toBe(1);
  });

  test("the proof and the action stay on the handle the probe read", async () => {
    const original = makeContainer(true);
    const replacement = makeContainer(true);
    original.marker = attemptMarker(ATTEMPT_A);
    const { sandbox, ctx } = makeSwappableDo(original);
    original.onMarkerRead = () => {
      ctx.container = replacement;
    };

    expect(await sandbox.runMarked(attemptMarker(ATTEMPT_A), shellCommand("cat result.json"))).toEqual({
      kind: "ran",
      stdout: "ran",
      stderr: "",
      exitCode: 0,
    });
    expect(original.ran).toEqual(["cat result.json"]);
    expect(replacement.ran).toEqual([]);

    ctx.container = original;
    expect(await sandbox.destroyMarked(attemptMarker(ATTEMPT_A), RETAINED)).toBe("destroyed");
    expect(original.destroyed).toBe(true);
    expect(replacement.destroyed).toBe(false);
  });

  test("a start-permitted run cannot slip between the proof and the action", async () => {
    const container = makeContainer(true);
    const sandbox = makeDo(container);
    const marker = attemptMarker(ATTEMPT_A);
    container.marker = marker;
    const { promise, resolve } = Promise.withResolvers<void>();
    container.slow = promise;

    const guardedRead = sandbox.runMarked(marker, shellCommand("slow-read"));
    const laterRun = sandbox.runCommand(shellCommand("later"));
    await Bun.sleep(0);

    expect(container.markerReads).toBe(1);
    expect(container.ran).toEqual([]);

    resolve();
    expect(await guardedRead).toEqual({ kind: "ran", stdout: "ran", stderr: "", exitCode: 0 });
    expect(await laterRun).toEqual({ stdout: "ran", stderr: "", exitCode: 0 });
    expect(container.ran).toEqual(["slow-read", "later"]);
  });

  test("a matching marker alone destroys nothing: only the two facts authorise it", async () => {
    const container = makeContainer(true);
    const sandbox = makeDo(container);
    const marker = attemptMarker(ATTEMPT_A);
    container.marker = marker;

    expect(await sandbox.destroyMarked(marker, undefined as never)).toBe("unknown");
    expect(await sandbox.destroyMarked(marker, { kind: "failure" } as never)).toBe("unknown");
    expect(await sandbox.destroyMarked(marker, { kind: "budget" } as never)).toBe("unknown");
    expect(container.destroyed).toBe(false);
    expect(container.markerReads).toBe(0);
  });

  test("no-paid-work still requires the marker to match", async () => {
    const container = makeContainer(true);
    const sandbox = makeDo(container);
    container.marker = attemptMarker(ATTEMPT_B);

    expect(await sandbox.destroyMarked(attemptMarker(ATTEMPT_A), { kind: "no-paid-work" })).toBe("unknown");
    expect(container.markerReads).toBe(1);
    expect(container.destroyed).toBe(false);

    expect(await sandbox.destroyMarked(attemptMarker(ATTEMPT_B), { kind: "no-paid-work" })).toBe("destroyed");
    expect(container.destroyed).toBe(true);
  });

  test("a matching marker with a retained proof allows collect-then-destroy", async () => {
    const container = makeContainer();
    const sandbox = makeDo(container);
    const marker = attemptMarker(ATTEMPT_A);
    expect(await sandbox.claimMarker(marker)).toBe("written");

    expect(await sandbox.runMarked(marker, shellCommand("cat result.json"))).toEqual({
      kind: "ran",
      stdout: "ran",
      stderr: "",
      exitCode: 0,
    });
    expect(container.ran).toEqual(["cat result.json"]);

    expect(await sandbox.destroyMarked(marker, RETAINED)).toBe("destroyed");
    expect(container.destroyed).toBe(true);
  });
});
