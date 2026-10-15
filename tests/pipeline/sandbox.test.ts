/**
 * Sandbox adapter unit tests — mock the workerd builtin `cloudflare:workers`
 * boundary (Bun's test runner cannot resolve it; same technique the tests
 * used for the @cloudflare/sandbox SDK dist) so they stay deterministic.
 * Contract under test (plan interface section):
 *   - the in-repo `SandboxV1` Durable Object starts its own container (image
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
  exec: Mock<
    (
      cmd: string[],
      opts?: unknown,
    ) => Promise<{ output: () => Promise<ExecOutput>; stdin?: WritableStream | null }>
  >;
  destroy: Mock<() => Promise<void>>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
/**
 * The fake child's stdin surface: `undefined` = no stream (a command that
 * passes no `stdin` option), `"reader"` = a `cat`-like reader whose output
 * exists only once stdin reached EOF, `"error-on-write"` = a child that died
 * before reading (the sink rejects), `"gated-write"` = a child that fills its
 * output pipe, so the stdin pipe accepts the payload ONLY once output
 * collection started (the drain-order deadlock), `"delayed-write"` = a pipe
 * whose write settles only when the test opens the gate (the backpressure the
 * adapter must await before the stream can close).
 */
let execStdin: "reader" | "error-on-write" | "gated-write" | "delayed-write" | undefined;
/** Bytes the fake child read from stdin (decoded). */
let execStdinBytes = "";
/** Whether the fake child saw EOF (the writer closed the stream). */
let execStdinEof = false;
/** Order of the fake sink's own observations: `write` / `write-settled` / `close`. */
let stdinEvents: string[] = [];
/** Whether output collection had already started when `write()` was called. */
let stdinWriteSawDrain = false;
/** Whether the adapter has started collecting the child's output. */
let drainStarted = false;
/** Opens the `"delayed-write"` gate (the test, not the adapter, holds it). */
let openWriteGate: () => void = () => {};

/** Concatenate the chunks a fake child read from stdin. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

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
      if (execStdin === undefined) return { output: async () => execResult, stdin: null };
      const chunks: Uint8Array[] = [];
      let eof = false;
      const { promise: closed, resolve: onClose } = Promise.withResolvers<void>();
      // The child's stdout pipe is FULL until someone drains it: with
      // `gated-write` the stdin pipe therefore accepts the payload only once
      // output collection started (writing first is a real deadlock), and with
      // `delayed-write` the pipe accepts it only once the test opens the gate
      // (the parent's buffer is slow — the adapter must await that write).
      const { promise: drained, resolve: onDrain } = Promise.withResolvers<void>();
      const { promise: writeGate, resolve: onWriteGate } = Promise.withResolvers<void>();
      openWriteGate = () => onWriteGate();
      drainStarted = false;
      // The child's read is complete only when the stream ended (close/abort):
      // recording there keeps `execStdinBytes`/`execStdinEof` truthful for the
      // modes whose `output()` resolves before the write settles.
      const record = () => {
        execStdinBytes = decoder.decode(concatChunks(chunks));
        execStdinEof = eof;
      };
      const stream = new WritableStream<Uint8Array>({
        write(chunk) {
          if (execStdin === "error-on-write") {
            // A child that exited before reading: the platform errors the pipe.
            onClose();
            throw new Error("EPIPE");
          }
          stdinWriteSawDrain = drainStarted;
          stdinEvents.push("write");
          chunks.push(chunk);
          if (execStdin === "delayed-write") {
            return writeGate.then(() => {
              stdinEvents.push("write-settled");
            });
          }
          if (execStdin === "gated-write") {
            // A real full output pipe blocks here forever; bounded so a
            // reordered adapter fails the drain-order assertion instead of
            // hanging the suite.
            return Promise.race([drained, Bun.sleep(150)]).then(() => {
              stdinEvents.push("write-settled");
            });
          }
        },
        close() {
          eof = true;
          stdinEvents.push("close");
          record();
          onClose();
        },
        abort() {
          eof = true;
          stdinEvents.push("close");
          record();
          onClose();
        },
      });
      return {
        stdin: stream,
        // A reader that consumes stdin to the END before producing output: the
        // adapter must close the stream (EOF) AND drain output concurrently, or
        // this promise never settles. The gated/delayed modes resolve as soon
        // as collection started — they model a child whose output pipe blocks
        // the payload, not a child that reads stdin to EOF.
        output: async () => {
          drainStarted = true;
          onDrain();
          if (execStdin === "reader") await closed;
          return execResult;
        },
      };
    }),
    destroy: mock(async () => {
      destroyCalls.push("container");
      if (destroyError) throw destroyError;
      running = false;
    }),
  };
}


// The ONE builtin registration lives in the shared helper — importing it here
// (before the adapter loads) keeps the `cloudflare:workers` mock deterministic
// no matter which test file's registration a shared process saw first.
import "../helpers/cloudflare-workers-mock";

const { SandboxV1, getSandbox, DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_STDIN_BYTES, shellCommand } =
  await import("../../src/pipeline/sandbox");
import type { ReviewSandbox } from "../../src/pipeline/sandbox";

/** The adapter's idle bound — pinned here so a silent shrink below the deep-review envelope fails. */
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

function makeDo(): { sandbox: ReviewSandbox; container: FakeContainer } {
  const container = makeContainer();
  // ctx double: the real DurableObjectState's blockConcurrencyWhile runs the
  // callback behind the concurrency gate and resolves with its result.
  const ctx = { container, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn() };
  const sandbox = new SandboxV1(ctx as never, {}) as unknown as ReviewSandbox;
  return { sandbox, container };
}

function reset() {
  startCalls.length = 0;
  inactivityCalls.length = 0;
  execCalls.length = 0;
  destroyCalls.length = 0;
  execResult = { stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode: 0 };
  running = false;
  execError = undefined;
  destroyError = undefined;
  execStdin = undefined;
  execStdinBytes = "";
  execStdinEof = false;
  stdinEvents = [];
  stdinWriteSawDrain = false;
  drainStarted = false;
  openWriteGate = () => {};
}

describe("SandboxV1 Durable Object", () => {
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

    const result = await sandbox.runCommand(shellCommand("gh pr diff 1 --repo acme/widgets"), {
      env: { GH_TOKEN: "tok" },
      cwd: "/workspace/repo",
    });

    expect(execCalls).toEqual([
      {
        cmd: ["timeout", "--kill-after=5", "600", "/bin/sh", "-lc", "gh pr diff 1 --repo acme/widgets"],
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

  test("a restarted DO re-arms the inactivity timeout in its constructor when the container is already running", () => {
    reset();
    running = true; // the container outlived the DO instance (deploy / eviction)
    const { container } = makeDo();

    expect(inactivityCalls).toEqual([INACTIVITY_TIMEOUT_MS]);
    expect(startCalls).toEqual([]); // a running container is never restarted
    expect(container.setInactivityTimeout).toHaveBeenCalledTimes(1);
  });

  test("constructor leaves a stopped container alone (the request path starts it)", () => {
    reset();
    const { container } = makeDo();

    expect(inactivityCalls).toEqual([]);
    expect(container.setInactivityTimeout).toHaveBeenCalledTimes(0);
  });

  test("a missing container image key fails loud (wrangler/DO drift, not a silent no-op)", async () => {
    reset();
    const container = { ...makeContainer(), images: {} };
    const ctx = { container, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn() };
    const sandbox = new SandboxV1(ctx as never, {}) as unknown as ReviewSandbox;

    await expect(sandbox.runCommand(shellCommand("echo hi"))).rejects.toThrow(
      'container image "sandbox" is not configured',
    );
    expect(execCalls).toEqual([]);
  });

  test("a zero or negative explicit timeout is clamped to the 1 ms floor (never a disarming zero duration)", async () => {
    reset();
    const { sandbox } = makeDo();

    await sandbox.runCommand(shellCommand("gh pr view 1"), { timeout: 0 });
    await sandbox.runCommand(shellCommand("gh pr view 2"), { timeout: -5_000 });

    expect(execCalls.map((call) => call.cmd)).toEqual([
      ["timeout", "--kill-after=5", "0.001", "/bin/sh", "-lc", "gh pr view 1"],
      ["timeout", "--kill-after=5", "0.001", "/bin/sh", "-lc", "gh pr view 2"],
    ]);
  });

  test("a sub-second explicit timeout is forwarded exactly (fractional seconds, never rounded up)", async () => {
    reset();
    const { sandbox } = makeDo();

    await sandbox.runCommand(shellCommand("gh pr view 1"), { timeout: 250 });

    expect(execCalls[0]!.cmd).toEqual(["timeout", "--kill-after=5", "0.25", "/bin/sh", "-lc", "gh pr view 1"]);
  });

  test("a non-finite explicit timeout (NaN / Infinity) falls back to the default bound", async () => {
    reset();
    const { sandbox } = makeDo();

    await sandbox.runCommand(shellCommand("gh pr view 1"), { timeout: Number.NaN });
    await sandbox.runCommand(shellCommand("gh pr view 2"), { timeout: Number.POSITIVE_INFINITY });

    expect(execCalls.map((call) => call.cmd)).toEqual([
      ["timeout", "--kill-after=5", "600", "/bin/sh", "-lc", "gh pr view 1"],
      ["timeout", "--kill-after=5", "600", "/bin/sh", "-lc", "gh pr view 2"],
    ]);
    expect(DEFAULT_EXEC_TIMEOUT_MS / 1000).toBe(600);
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
    const sandbox = new SandboxV1({} as never, {}) as unknown as ReviewSandbox;

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

/**
 * The credential channel: `stdin` on the exec path. The payload is the ONLY
 * way a key reaches the container, so the lifecycle matters as much as the
 * bytes — a run that waits for EOF must see the stream closed, output must be
 * drained concurrently with the write (a child whose full output pipe blocks
 * the stdin write deadlocks otherwise), the write must be AWAITED (the sink
 * closes only after it settles), and an oversized or undelivered payload must
 * fail closed with a REDACTED error (never the payload itself). The
 * drain-order and backpressure guarantees are pinned by their own two cases
 * below — both fail against an adapter that writes first / does not await the
 * write.
 */
describe("SandboxV1 stdin transport (the credential channel)", () => {
  const PAYLOAD = '{"version":1,"pools":{"ark":["secret-key"]}}';

  test("a stdin payload is written through the exec pipe and the stream is CLOSED (a reader waiting for EOF completes)", async () => {
    reset();
    execStdin = "reader";
    execResult = { stdout: bytes("envelope\n"), stderr: new ArrayBuffer(0), exitCode: 0 };
    const { sandbox } = makeDo();

    const result = await sandbox.runCommand(shellCommand("bun run runner.ts"), {
      cwd: "/workspace/repo",
      env: { OMP_REVIEW_MODEL: "ark-plan/deepseek-v4-flash" },
      stdin: PAYLOAD,
    });

    // The per-call {cwd, env} contract is untouched; the payload rides the pipe.
    expect(execCalls).toEqual([
      {
        cmd: ["timeout", "--kill-after=5", "600", "/bin/sh", "-lc", "bun run runner.ts"],
        opts: { cwd: "/workspace/repo", env: { OMP_REVIEW_MODEL: "ark-plan/deepseek-v4-flash" }, stdin: "pipe" },
      },
    ]);
    expect(execStdinBytes).toBe(PAYLOAD);
    expect(execStdinEof).toBe(true);
    expect(result).toEqual({ stdout: "envelope\n", stderr: "", exitCode: 0 });
  });

  test("no stdin option → the exec starts with no stdin pipe (the platform sends EOF)", async () => {
    reset();
    const { sandbox } = makeDo();

    await sandbox.runCommand(shellCommand("git status"), { timeout: 120_000 });

    expect(Object.hasOwn(execCalls[0]!.opts as object, "stdin")).toBe(false);
  });

  test("an oversized payload fails closed BEFORE any process starts — and the error carries no payload", async () => {
    reset();
    const { sandbox } = makeDo();
    const payload = `s${"e".repeat(MAX_EXEC_STDIN_BYTES)}`; // one byte past the cap

    let message = "";
    try {
      await sandbox.runCommand(shellCommand("bun run runner.ts"), { stdin: payload });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(`exceeds the ${MAX_EXEC_STDIN_BYTES}-byte`);
    expect(message).not.toContain("seee");
    expect(execCalls).toEqual([]);
  });

  test("a stdin write failure on a child that claims success is refused (never a keyless run reported as ok)", async () => {
    reset();
    execStdin = "error-on-write";
    execResult = { stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode: 0 };
    const { sandbox } = makeDo();

    let message = "";
    try {
      await sandbox.runCommand(shellCommand("bun run runner.ts"), { stdin: PAYLOAD });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe("exec stdin closed before the payload was delivered");
    expect(message).not.toContain("secret-key");
  });

  test("a stdin write failure keeps the child's own non-zero exit code (its stderr is the diagnosis)", async () => {
    reset();
    execStdin = "error-on-write";
    execResult = { stdout: new ArrayBuffer(0), stderr: bytes("review: cannot read runner input\n"), exitCode: 1 };
    const { sandbox } = makeDo();

    const result = await sandbox.runCommand(shellCommand("bun run runner.ts"), { stdin: PAYLOAD });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("review: cannot read runner input\n");
  });

  test("output collection starts BEFORE the payload write (a child whose full output pipe blocks the stdin write cannot deadlock the run)", async () => {
    reset();
    // The child's stdout pipe is full until someone drains it, so the stdin
    // pipe accepts the payload only once output collection started: an adapter
    // that writes and only then calls output() never delivers the payload.
    execStdin = "gated-write";
    execResult = { stdout: bytes("envelope\n"), stderr: new ArrayBuffer(0), exitCode: 0 };
    const { sandbox } = makeDo();

    const result = await sandbox.runCommand(shellCommand("bun run runner.ts"), { stdin: PAYLOAD });

    expect(stdinWriteSawDrain).toBe(true);
    expect(stdinEvents).toEqual(["write", "write-settled", "close"]);
    expect(execStdinEof).toBe(true);
    expect(result).toEqual({ stdout: "envelope\n", stderr: "", exitCode: 0 });
  });

  test("runCommand does not settle until the delayed write does, and the sink closes only after it (awaited backpressure)", async () => {
    reset();
    // The pipe accepts the payload only once the test opens the gate: the
    // adapter must await the write (and only then let the stream close), or a
    // caller may tear the container down with the payload still in flight.
    execStdin = "delayed-write";
    const { sandbox } = makeDo();

    let settled = false;
    const run = sandbox
      .runCommand(shellCommand("bun run runner.ts"), { stdin: PAYLOAD })
      .then((value) => {
        settled = true;
        return value;
      });

    await Bun.sleep(10); // several turns with the write still gated
    expect(settled).toBe(false);
    expect(stdinEvents).toEqual(["write"]); // no close before the write settles
    expect(execStdinEof).toBe(false);

    openWriteGate();
    await run;

    expect(settled).toBe(true);
    expect(stdinEvents).toEqual(["write", "write-settled", "close"]);
    expect(execStdinBytes).toBe(PAYLOAD);
    expect(execStdinEof).toBe(true);
  });
});
