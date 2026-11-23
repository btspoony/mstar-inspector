
import { describe, expect, test } from "bun:test";
import type { ExecOutput } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { DestroyOutcome, MarkedRun, ProvisionOutcome, ReviewSandbox } from "../../src/pipeline/sandbox";
import { TEST_KEY } from "../helpers/consumer-fixtures";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

import "../helpers/cloudflare-workers-mock";

const { SandboxV1, shellCommand } = await import("../../src/pipeline/sandbox");
const {
  AttemptUnknownError,
  ContainerLostBeforePaidError,
  ContainerUnavailableError,
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
  /** The incarnation's disk. Cleared whenever the container stops. */
  marker: string | null;
  images: Record<string, string>;
  startCalls: number;
  ran: string[];
  markerWrites: number;
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
    markerWrites: 0,
    markerReads: 0,
    execRejects: false,
    slow: undefined,
    onMarkerRead: undefined,
    destroyed: false,
    start() {
      container.startCalls += 1;
      container.running = true;
      // A start is a NEW incarnation on a fresh disk.
      container.marker = null;
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
          container.markerWrites += 1;
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
      container.marker = null;
    },
  };
  return container;
}

/** One incarnation's durable DO storage, shareable across rebuilt instances. */
type StorageDouble = Map<string, unknown>;

function storageDouble(): StorageDouble {
  return new Map<string, unknown>();
}

function makeDo(container: MarkerContainer, storage: StorageDouble = storageDouble()) {
  const ctx = {
    container,
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => void storage.set(key, value),
    },
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
      storage: {
        get: async () => undefined,
        put: async () => {},
      },
      blockConcurrencyWhile: ctx.blockConcurrencyWhile,
    } as never,
    {},
  ) as unknown as ReviewSandbox;
  return { sandbox, ctx };
}

type SandboxDouble = {
  events: string[];
  provision: (marker: string, opts: { deadlineEpochMs: number }) => Promise<ProvisionOutcome>;
  runMarked: (marker: string, command: string) => Promise<MarkedRun>;
  destroyMarked: (marker: string) => Promise<DestroyOutcome>;
  runCommand: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  destroy: () => Promise<void>;
};

function attemptSandboxDouble(decision: {
  provision?: "provisioned" | "unavailable" | "retired";
  marked?: "ran" | "reply-lost" | "not-running" | "marker-mismatch" | "marker-unreadable" | "retired";
  markedRejected?: boolean;
  destroy?: "destroyed" | "stopped" | "unknown";
}): SandboxDouble {
  const events: string[] = [];
  const sandbox = {
    events,
    provision: async (marker: string) => {
      events.push(`provision:${marker}`);
      return { kind: decision.provision ?? "provisioned" } as ProvisionOutcome;
    },
    runMarked: async (_marker: string, command: string) => {
      events.push(`marked:${command}`);
      if (decision.markedRejected === true) throw new Error("rpc lost");
      const kind = decision.marked ?? "ran";
      if (kind !== "ran") return { kind } as MarkedRun;
      const stdout = command.includes("rev-parse") ? `${SHA}\n` : "";
      return { kind: "ran" as const, stdout, stderr: "", exitCode: 0 };
    },
    destroyMarked: async () => {
      events.push("destroyMarked");
      return decision.destroy ?? "destroyed";
    },
    runCommand: async (command: string) => {
      events.push(`run:${command}`);
      return command.includes("rev-parse")
        ? { stdout: `${SHA}\n`, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 };
    },
    destroy: async () => {
      events.push("destroy");
    },
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

function prepareInput(
  db: TestD1,
  sandbox: SandboxDouble,
  acquired: string[] = [],
  runnerCutoffMs: number = Date.now() + 120_000,
) {
  return {
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
    runnerCutoffMs,
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

describe("provision is the only way a slot starts", () => {
  const MARKER = attemptMarker(ATTEMPT_A);

  test("a stopped slot is started, marked and reported provisioned", async () => {
    const container = makeContainer(false);
    const sandbox = makeDo(container);

    expect(await sandbox.provision(MARKER, { deadlineEpochMs: Date.now() + 60_000 })).toEqual({
      kind: "provisioned",
    });

    expect(container.startCalls).toBe(1);
    expect(container.marker).toBe(MARKER);
    expect(container.markerWrites).toBe(1);
  });

  test("a second provision on a running matching slot writes nothing", async () => {
    const container = makeContainer(false);
    const sandbox = makeDo(container);
    const deadlineEpochMs = Date.now() + 60_000;

    await sandbox.provision(MARKER, { deadlineEpochMs });
    expect(await sandbox.provision(MARKER, { deadlineEpochMs })).toEqual({ kind: "provisioned" });

    expect(container.startCalls).toBe(1);
    expect(container.markerWrites).toBe(1);
    // per entry: one read to decide, one read-back to prove what it carries
    expect(container.markerReads).toBe(4);
  });

  test("runMarked on a stopped slot answers not-running and calls start ZERO times", async () => {
    const container = makeContainer(false);
    const sandbox = makeDo(container);

    expect(await sandbox.runMarked(MARKER, shellCommand("cat result.json"))).toEqual({ kind: "not-running" });
    expect(container.startCalls).toBe(0);
    expect(container.ran).toEqual([]);
  });

  test("a fenced slot refuses provisioning: a rebuilt DO on the same storage answers retired and never starts", async () => {
    const storage = storageDouble();
    const first = makeContainer(false);
    const sandbox = makeDo(first, storage);
    const deadlineEpochMs = Date.now() + 60_000;
    await sandbox.provision(MARKER, { deadlineEpochMs });
    expect(await sandbox.destroyMarked(MARKER, RETAINED)).toBe("destroyed");

    const rebuiltOn = makeContainer(false);
    const rebuilt = makeDo(rebuiltOn, storage);

    expect(await rebuilt.provision(MARKER, { deadlineEpochMs })).toEqual({ kind: "retired" });
    expect(await rebuilt.runMarked(MARKER, shellCommand("cat result.json"))).toEqual({ kind: "retired" });
    expect(rebuiltOn.startCalls).toBe(0);
  });

  test("a stopped slot with a retention proof is 'stopped' and fences the slot", async () => {
    const storage = storageDouble();
    const container = makeContainer(false);
    const sandbox = makeDo(container, storage);

    expect(await sandbox.destroyMarked(MARKER, RETAINED)).toBe("stopped");
    expect(container.destroyed).toBe(false);

    const rebuiltOn = makeContainer(false);
    const rebuilt = makeDo(rebuiltOn, storage);
    expect(await rebuilt.provision(MARKER, { deadlineEpochMs: Date.now() + 60_000 })).toEqual({
      kind: "retired",
    });
    expect(rebuiltOn.startCalls).toBe(0);
  });
});

describe("prepare provisions on every entry", () => {
  test("the container is resolved by attempt id and provisioned before the clone", async () => {
    const db = createMigratedTestD1();
    const sandbox = attemptSandboxDouble({});
    const acquired: string[] = [];

    const prepared = await prepareReviewAttempt(prepareInput(db, sandbox, acquired));

    expect(acquired).toEqual([`review-${ATTEMPT_A}`]);
    expect(prepared.headSha).toBe(SHA);
    expect(sandbox.events[0]).toBe(`provision:${attemptMarker(ATTEMPT_A)}`);
  });

  test("a second entry provisions the slot again instead of proving the old incarnation", async () => {
    const db = createMigratedTestD1();
    const sandbox = attemptSandboxDouble({});

    await prepareReviewAttempt(prepareInput(db, sandbox));
    await prepareReviewAttempt(prepareInput(db, sandbox));

    expect(sandbox.events.filter((event) => event.startsWith("provision:"))).toHaveLength(2);
    expect(sandbox.events.some((event) => event.startsWith("run:true"))).toBe(false);
  });

  test("provisioning inside the derived cutoff caps the deadline it grants", async () => {
    const db = createMigratedTestD1();
    const seen: number[] = [];
    const sandbox = attemptSandboxDouble({});
    sandbox.provision = async (_marker: string, opts: { deadlineEpochMs: number }) => {
      seen.push(opts.deadlineEpochMs - Date.now());
      return { kind: "provisioned" };
    };

    await prepareReviewAttempt(prepareInput(db, sandbox, [], Date.now() + 7_000));

    expect(seen).toHaveLength(1);
    expect(seen[0]!).toBeLessThanOrEqual(7_000);
    expect(seen[0]!).toBeGreaterThan(0);
  });

  test("an unavailable slot is transient (retryable), never an unknown", async () => {
    const db = createMigratedTestD1();
    const sandbox = attemptSandboxDouble({ provision: "unavailable" });

    await expect(prepareReviewAttempt(prepareInput(db, sandbox))).rejects.toBeInstanceOf(
      ContainerUnavailableError,
    );
    expect(sandbox.events.some((event) => event.startsWith("run:"))).toBe(false);
  });

  test("a retired slot is terminal: nothing is cloned on it", async () => {
    const db = createMigratedTestD1();
    const sandbox = attemptSandboxDouble({ provision: "retired" });

    await expect(prepareReviewAttempt(prepareInput(db, sandbox))).rejects.toThrow(/retired/);
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

  test("a replaced marker at the pre-paid entry is lost-before-paid: nothing was charged", async () => {
    const db = createMigratedTestD1();
    await claimReviewAttempt(db, ATTEMPT_A, Date.now(), null);
    const sandbox = attemptSandboxDouble({ marked: "marker-mismatch" });
    await expect(runReviewAttempt(executionInput(sandbox, db))).rejects.toBeInstanceOf(
      ContainerLostBeforePaidError,
    );

    expect(sandbox.events.filter((event) => event.startsWith("marked:"))).toHaveLength(1);
    expect(sandbox.events.filter((event) => event.includes("bun run"))).toEqual([]);
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

  test("boundedRead's refusal message names the outcome it observed", async () => {
    const db = createMigratedTestD1();
    await claimReviewAttempt(db, ATTEMPT_A, Date.now(), null);
    const sandbox = attemptSandboxDouble({});
    // The pre-paid entry passes; every post-paid read then sees a dead slot.
    let marked = 0;
    sandbox.runMarked = async (_marker: string, command: string) => {
      marked += 1;
      // call 1 = runner input write, call 2 = the paid exec; the document reads follow.
      if (marked > 2) return { kind: "not-running" };
      const stdout = command.includes("rev-parse") ? `${SHA}\n` : "";
      return { kind: "ran", stdout, stderr: "", exitCode: 0 };
    };

    let message = "";
    try {
      await runReviewAttempt(executionInput(sandbox, db));
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("not-running");
    expect(message).toContain("not collected");
    expect(sandbox.events).not.toContain("destroy");
  });
});

describe("destroy reports the slot's terminal state", () => {
  test("a replaced marker destroys nothing and reports unknown", async () => {
    const sandbox = attemptSandboxDouble({ marked: "marker-mismatch", destroy: "unknown" });
    expect(await discardReviewAttempt(sandbox as never, ATTEMPT_A, RETAINED)).toBe("unknown");
    expect(sandbox.events).not.toContain("destroy");
  });

  test("a matching live incarnation is destroyed", async () => {
    const sandbox = attemptSandboxDouble({});
    expect(await discardReviewAttempt(sandbox as never, ATTEMPT_A, RETAINED)).toBe("destroyed");
    expect(sandbox.events).toContain("destroyMarked");
  });

  test("a slot the platform already stopped reports stopped, which still releases capacity", async () => {
    const sandbox = attemptSandboxDouble({ destroy: "stopped" });
    expect(await discardReviewAttempt(sandbox as never, ATTEMPT_A, RETAINED)).toBe("stopped");
  });
});

describe("SandboxV1 marker gate", () => {
  const MARKER_A = attemptMarker(ATTEMPT_A);

  test("a probe never starts a container and never runs a command on a dead one", async () => {
    const container = makeContainer(false);
    const sandbox = makeDo(container);

    expect(await sandbox.runMarked(MARKER_A, shellCommand("cat result.json"))).toEqual({ kind: "not-running" });
    expect(await sandbox.destroyMarked(MARKER_A, RETAINED)).toBe("stopped");

    expect(container.startCalls).toBe(0);
    expect(container.ran).toEqual([]);
    expect(container.destroyed).toBe(false);
  });

  test("a live container without this attempt's marker runs and destroys nothing", async () => {
    const container = makeContainer(true);
    const sandbox = makeDo(container);
    container.marker = attemptMarker(ATTEMPT_B);

    expect(await sandbox.runMarked(MARKER_A, shellCommand("cat result.json"))).toEqual({
      kind: "marker-mismatch",
    });
    expect(await sandbox.destroyMarked(MARKER_A, RETAINED)).toBe("unknown");

    expect(container.ran).toEqual([]);
    expect(container.destroyed).toBe(false);
  });

  test("a replacement between preparation and the gated operation refuses both", async () => {
    const container = makeContainer(false);
    const sandbox = makeDo(container);
    await sandbox.provision(MARKER_A, { deadlineEpochMs: Date.now() + 60_000 });

    container.marker = null;

    expect(await sandbox.runMarked(MARKER_A, shellCommand("cat result.json"))).toEqual({
      kind: "marker-mismatch",
    });
    expect(await sandbox.destroyMarked(MARKER_A, RETAINED)).toBe("unknown");
    expect(container.ran).toEqual([]);
    expect(container.destroyed).toBe(false);
  });

  test("a guarded command whose reply is lost reports reply-lost, not nothing-ran", async () => {
    const container = makeContainer(true);
    const sandbox = makeDo(container);
    container.marker = MARKER_A;
    container.execRejects = true;

    expect(await sandbox.runMarked(MARKER_A, shellCommand("cat result.json"))).toEqual({ kind: "reply-lost" });
    expect(container.markerReads).toBe(1);
  });

  test("the proof and the action stay on the handle the probe read", async () => {
    const original = makeContainer(true);
    const replacement = makeContainer(true);
    original.marker = MARKER_A;
    const { sandbox, ctx } = makeSwappableDo(original);
    original.onMarkerRead = () => {
      ctx.container = replacement;
    };

    expect(await sandbox.runMarked(MARKER_A, shellCommand("cat result.json"))).toEqual({
      kind: "ran",
      stdout: "ran",
      stderr: "",
      exitCode: 0,
    });
    expect(original.ran).toEqual(["cat result.json"]);
    expect(replacement.ran).toEqual([]);

    ctx.container = original;
    expect(await sandbox.destroyMarked(MARKER_A, RETAINED)).toBe("destroyed");
    expect(original.destroyed).toBe(true);
    expect(replacement.destroyed).toBe(false);
  });

  test("the exclusive gate keeps a later command from slipping between proof and action", async () => {
    const container = makeContainer(true);
    const sandbox = makeDo(container);
    container.marker = MARKER_A;
    const { promise, resolve } = Promise.withResolvers<void>();
    container.slow = promise;

    const guardedRead = sandbox.runMarked(MARKER_A, shellCommand("slow-read"));
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
    container.marker = MARKER_A;

    expect(await sandbox.destroyMarked(MARKER_A, undefined as never)).toBe("unknown");
    expect(await sandbox.destroyMarked(MARKER_A, { kind: "failure" } as never)).toBe("unknown");
    expect(await sandbox.destroyMarked(MARKER_A, { kind: "budget" } as never)).toBe("unknown");
    expect(container.destroyed).toBe(false);
    expect(container.markerReads).toBe(0);
  });

  test("no-paid-work still requires the marker to match", async () => {
    const container = makeContainer(true);
    const sandbox = makeDo(container);
    container.marker = attemptMarker(ATTEMPT_B);

    expect(await sandbox.destroyMarked(MARKER_A, { kind: "no-paid-work" })).toBe("unknown");
    expect(container.markerReads).toBe(1);
    expect(container.destroyed).toBe(false);

    expect(await sandbox.destroyMarked(attemptMarker(ATTEMPT_B), { kind: "no-paid-work" })).toBe("destroyed");
    expect(container.destroyed).toBe(true);
  });

  test("a matching marker with a retained proof allows collect-then-destroy", async () => {
    const container = makeContainer(false);
    const sandbox = makeDo(container);
    await sandbox.provision(MARKER_A, { deadlineEpochMs: Date.now() + 60_000 });

    expect(await sandbox.runMarked(MARKER_A, shellCommand("cat result.json"))).toEqual({
      kind: "ran",
      stdout: "ran",
      stderr: "",
      exitCode: 0,
    });
    expect(container.ran).toEqual(["cat result.json"]);

    expect(await sandbox.destroyMarked(MARKER_A, RETAINED)).toBe("destroyed");
    expect(container.destroyed).toBe(true);
  });
});
