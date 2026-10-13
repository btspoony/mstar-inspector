/**
 * Sandbox adapter unit tests — mock the workerd builtin `cloudflare:workers`
 * boundary (Bun's test runner cannot resolve it; same technique the tests
 * used for the @cloudflare/sandbox SDK dist) so they stay deterministic.
 * Contract under test (plan interface section):
 *   - the in-repo `Sandbox` Durable Object starts its own container (image
 *     from `container.images.sandbox`, lite instance, internet on), (re)sets
 *     the inactivity timeout on every guard, and never restarts a running
 *     container;
 *   - runCommand wraps the branded command ONCE: GNU `timeout` bound +
 *     `/bin/sh -lc` sink, per-call env/cwd, buffered output mapped to
 *     { stdout, stderr, exitCode };
 *   - every run is time-bounded: an explicit opts.timeout wins, otherwise
 *     DEFAULT_EXEC_TIMEOUT_MS is applied (plan QC 06 fix round 1 / qc3 F-001);
 *   - destroy() delegates to the container destroy;
 *   - getSandbox(binding, id) lowercases the id (0.12's normalizeId is gone)
 *     and hands back the DO stub as the ReviewSandbox contract;
 *   - the adapter import point is this module only (compass contracts A).
 *
 * The adapter is imported dynamically: its static `cloudflare:workers` import
 * is hoisted above `mock.module` in ESM, and the builtin is unresolvable in
 * Bun's test runner. Dynamic import resolves after the mock is registered.
 */

import { describe, expect, mock, test, type Mock } from "bun:test";
import type { ExecOutput } from "@cloudflare/workers-types";

/** The fake container the DO drives (the `this.ctx.container` surface). */
type FakeContainer = {
  readonly running: boolean;
  images: Record<string, string>;
  start: Mock<(opts: Record<string, unknown>) => void>;
  setInactivityTimeout: Mock<(ms: number) => Promise<void>>;
  exec: Mock<(cmd: string[], opts?: unknown) => Promise<{ output: () => Promise<ExecOutput> }>>;
  destroy: Mock<() => Promise<void>>;
};

const encoder = new TextEncoder();

/** Test bytes as the ArrayBuffer the real `ExecOutput.stdout` carries. */
function bytes(text: string): ArrayBuffer {
  return encoder.encode(text).buffer as ArrayBuffer;
}

const startCalls: Array<Record<string, unknown>> = [];
const inactivityCalls: number[] = [];
const execCalls: Array<{ cmd: string[]; opts?: unknown }> = [];
const destroyCalls: string[] = [];
let execResult: { stdout: ArrayBuffer; stderr: ArrayBuffer; exitCode: number } = {
  stdout: new ArrayBuffer(0),
  stderr: new ArrayBuffer(0),
  exitCode: 0,
};
let running = false;
let execError: Error | undefined;
let destroyError: Error | undefined;

/** The fake container the DO drives (the `this.ctx.container` surface). */
function makeContainer(): FakeContainer {
  return {
    get running() {
      return running;
    },
    images: { sandbox: "registry.example/review-sandbox@sha256:abc" },
    start: mock((opts: Record<string, unknown>) => {
      startCalls.push(opts);
      running = true;
    }),
    setInactivityTimeout: mock(async (ms: number) => {
      inactivityCalls.push(ms);
    }),
    exec: mock(async (cmd: string[], opts?: unknown) => {
      execCalls.push({ cmd, opts });
      if (execError) throw execError;
      return { output: async () => execResult };
    }),
    destroy: mock(async () => {
      destroyCalls.push("container");
      if (destroyError) throw destroyError;
      running = false;
    }),
  };
}


mock.module("cloudflare:workers", () => ({
  // The real base only stores (ctx, env) — the adapter reads this.ctx.
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { Sandbox, getSandbox, DEFAULT_EXEC_TIMEOUT_MS, shellCommand } =
  await import("../../src/pipeline/sandbox");
import type { ReviewSandbox } from "../../src/pipeline/sandbox";

/** The adapter's idle bound — pinned here so a silent shrink below the deep-review envelope fails. */
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

function makeDo(): { sandbox: ReviewSandbox; container: FakeContainer } {
  const container = makeContainer();
  const sandbox = new Sandbox({ container } as never, {}) as unknown as ReviewSandbox;
  return { sandbox, container };
}

function reset() {
  startCalls.length = 0;
  inactivityCalls.length = 0;
  execCalls.length = 0;
  destroyCalls.length = 0;
  running = false;
  execError = undefined;
  destroyError = undefined;
}

describe("Sandbox Durable Object", () => {
  test("runCommand starts the container once, keeps the lite instance, internet on, and bounds the idle lifetime", async () => {
    reset();
    const { sandbox, container } = makeDo();

    await sandbox.runCommand(shellCommand("echo hi"));
    await sandbox.runCommand(shellCommand("echo hi again"));

    expect(startCalls).toEqual([
      {
        image: "registry.example/review-sandbox@sha256:abc",
        instance: "lite",
        enableInternet: true,
      },
    ]);
    // safe to repeat: a running container is never restarted, but the
    // inactivity timeout is (re)set on every guard (a deploy restarts the DO).
    expect(inactivityCalls).toEqual([
      INACTIVITY_TIMEOUT_MS,
      INACTIVITY_TIMEOUT_MS,
    ]);
    expect(container.start).toHaveBeenCalledTimes(1);
    expect(INACTIVITY_TIMEOUT_MS).toBeGreaterThan(14 * 60 * 1000);
  });

  test("runCommand wraps the command string into the single /bin/sh sink under the default 600s bound", async () => {
    reset();
    running = true; // start() already returned (deploy restart mid-flight)
    const { sandbox } = makeDo();

    const result = await sandbox.runCommand(shellCommand("gh pr diff 1 --repo btspoony/todo-bots"), {
      env: { GH_TOKEN: "tok" },
      cwd: "/workspace/repo",
    });

    expect(execCalls).toEqual([
      {
        cmd: ["timeout", "--kill-after=5", "600", "/bin/sh", "-lc", "gh pr diff 1 --repo btspoony/todo-bots"],
        opts: { cwd: "/workspace/repo", env: { GH_TOKEN: "tok" } },
      },
    ]);
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(600_000);
  });

  test("runCommand maps buffered byte output to strings and an explicit timeout wins (per-call override)", async () => {
    reset();
    execResult = {
      stdout: bytes("diff --git a/x b/x\n"),
      stderr: bytes("review mode: structured\n"),
      exitCode: 0,
    };
    const { sandbox } = makeDo();

    const result = await sandbox.runCommand(shellCommand("git status"), { timeout: 120_000 });

    expect(execCalls[0]!.cmd).toEqual(["timeout", "--kill-after=5", "120", "/bin/sh", "-lc", "git status"]);
    expect(result).toEqual({
      stdout: "diff --git a/x b/x\n",
      stderr: "review mode: structured\n",
      exitCode: 0,
    });
  });

  test("a non-zero exit (timeout bound = 124) resolves normally — the caller decides retry/DLQ", async () => {
    reset();
    execResult = { stdout: new ArrayBuffer(0), stderr: bytes("Terminated\n"), exitCode: 124 };
    const { sandbox } = makeDo();

    const result = await sandbox.runCommand(shellCommand("sleep 9999"), { timeout: 5_000 });

    expect(execCalls[0]!.cmd).toEqual(["timeout", "--kill-after=5", "5", "/bin/sh", "-lc", "sleep 9999"]);
    expect(result).toEqual({ stdout: "", stderr: "Terminated\n", exitCode: 124 });
  });

  test("runCommand propagates container errors (caller decides retry/DLQ)", async () => {
    reset();
    execError = new Error("container unavailable");
    const { sandbox } = makeDo();

    await expect(sandbox.runCommand(shellCommand("gh pr diff 1"))).rejects.toThrow("container unavailable");
  });

  test("destroy delegates to the container destroy", async () => {
    reset();
    const { sandbox, container } = makeDo();

    await sandbox.destroy();

    expect(destroyCalls).toEqual(["container"]);
    expect(container.destroy).toHaveBeenCalledTimes(1);
  });

  test("destroy propagates container errors (evidence for the Verdict, not silent)", async () => {
    reset();
    destroyError = new Error("teardown hung");
    const { sandbox } = makeDo();

    await expect(sandbox.destroy()).rejects.toThrow("teardown hung");
  });

  test("a missing container binding fails loud (misconfigured wrangler, not a silent no-op)", async () => {
    reset();
    const sandbox = new Sandbox({} as never, {}) as unknown as ReviewSandbox;

    await expect(sandbox.runCommand(shellCommand("echo hi"))).rejects.toThrow(
      "container binding is not configured",
    );
  });
});

describe("getSandbox", () => {
  test("lowercases the id (DO names are case-sensitive; 0.12 normalizeId is gone) and returns the stub contract", async () => {
    reset();
    const names: string[] = [];
    const stub: ReviewSandbox = {
      runCommand: async () => ({ stdout: "out", stderr: "", exitCode: 0 }),
      destroy: async () => {},
    };
    const binding = { getByName(name: string): ReviewSandbox { names.push(name); return stub; } };

    const sandbox = await getSandbox(binding, "Smoke-ABC-123");

    expect(names).toEqual(["smoke-abc-123"]);
    expect(await sandbox.runCommand(shellCommand("echo hi"))).toEqual({ stdout: "out", stderr: "", exitCode: 0 });
    await sandbox.destroy();
    expect(destroyCalls).toEqual([]); // stub-level: destroy runs in the DO, not the fake namespace
  });
});
