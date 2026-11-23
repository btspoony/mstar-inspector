
import { describe, expect, mock, test, type Mock } from "bun:test";
import { withFrozenClock } from "../helpers/clock";
import type { ExecOutput } from "@cloudflare/workers-types";

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
let containerRunning = false;
/** The fake incarnation disk: gone whenever the container stops. */
let markerBytes: string | null = null;
let execError: Error | undefined;
let destroyError: Error | undefined;
let execStdin: "reader" | "error-on-write" | "gated-write" | "delayed-write" | undefined;
let execStdinBytes = "";
let execStdinEof = false;
let stdinEvents: string[] = [];
let stdinWriteSawDrain = false;
let drainStarted = false;
let openWriteGate: () => void = () => {};

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

function makeContainer(): FakeContainer {
  return {
    get running() {
      return containerRunning;
    },
    images: { sandbox: "registry.example/review-sandbox@sha256:abc" },
    start: mock((opts: Record<string, unknown>) => {
      startCalls.push(opts);
      containerRunning = true;
    }),
    setInactivityTimeout: mock(async (ms: number) => {
      inactivityCalls.push(ms);
    }),
    exec: mock(async (cmd: string[], opts?: unknown) => {
      execCalls.push({ cmd, opts });
      if (execError) throw execError;
      const line = cmd[cmd.length - 1] ?? "";
      if (line.includes("/tmp/mstar-review-attempt")) {
        if (line.includes("printf")) {
          markerBytes = (opts as { env?: Record<string, string> } | undefined)?.env?.["MSTAR_ATTEMPT_MARKER"] ?? "";
          return { output: async () => ({ stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode: 0 }), stdin: null };
        }
        return markerBytes === null
          ? { output: async () => ({ stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode: 3 }), stdin: null }
          : { output: async () => ({ stdout: bytes(markerBytes!), stderr: new ArrayBuffer(0), exitCode: 0 }), stdin: null };
      }
      if (execStdin === undefined) return { output: async () => execResult, stdin: null };
      const chunks: Uint8Array[] = [];
      let eof = false;
      const { promise: closed, resolve: onClose } = Promise.withResolvers<void>();
      const { promise: drained, resolve: onDrain } = Promise.withResolvers<void>();
      const { promise: writeGate, resolve: onWriteGate } = Promise.withResolvers<void>();
      openWriteGate = () => onWriteGate();
      drainStarted = false;
      const record = () => {
        execStdinBytes = decoder.decode(concatChunks(chunks));
        execStdinEof = eof;
      };
      const stream = new WritableStream<Uint8Array>({
        write(chunk) {
          if (execStdin === "error-on-write") {
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
      containerRunning = false;
      markerBytes = null;
    }),
  };
}


import "../helpers/cloudflare-workers-mock";

const {
  SandboxV1,
  getSandbox,
  EXEC_DEADLINE_WRAPPER,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_COMMAND_BYTES,
  MAX_EXEC_ENV_VALUE_BYTES,
  MAX_EXEC_STDIN_BYTES,
  shellCommand,
  ContainerNotRunningError,
} = await import("../../src/pipeline/sandbox");
import type { ReviewSandbox } from "../../src/pipeline/sandbox";

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const MARKER = "mstar.review-attempt/v1:abc\n";

/** Default: a slot that is already running — `runCommand` never starts one. */
function makeDo(running = true): { sandbox: ReviewSandbox; container: FakeContainer } {
  containerRunning = running;
  const container = makeContainer();
  const ctx = {
    container,
    storage: { get: async () => undefined, put: async () => {} },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  };
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
  markerBytes = null;
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
  test("provision starts a stopped slot once, keeps the basic instance, internet on, and bounds the idle lifetime", async () => {
    reset();
    const { sandbox } = makeDo(false);
    const deadlineEpochMs = Date.now() + 120_000;

    expect(await sandbox.provision(MARKER, { deadlineEpochMs })).toEqual({ kind: "provisioned" });

    expect(startCalls).toEqual([
      {
        image: "registry.example/review-sandbox@sha256:abc",
        instance: "basic",
        enableInternet: true,
      },
    ]);
    expect(inactivityCalls).toEqual([INACTIVITY_TIMEOUT_MS]);
    expect(INACTIVITY_TIMEOUT_MS).toBeGreaterThan(14 * 60 * 1000);
    // the marker write happened, and the read-back proves the slot carries it
    expect(execCalls.some((call) => (call.cmd[call.cmd.length - 1] ?? "").includes("printf"))).toBe(true);
    expect(execCalls[execCalls.length - 1]!.cmd.join(" ")).toContain("cat --");
    expect(markerBytes).toBe(MARKER);
  });

  test("provision on a running slot with the matching marker writes nothing", async () => {
    reset();
    markerBytes = MARKER;
    const { sandbox } = makeDo(true);

    expect(await sandbox.provision(MARKER, { deadlineEpochMs: Date.now() + 120_000 })).toEqual({
      kind: "provisioned",
    });

    // One read to decide, one read to prove what the slot now carries.
    expect(execCalls.map((call) => call.cmd[call.cmd.length - 1])).toEqual([
      `[ -f '/tmp/mstar-review-attempt' ] || exit 3; cat -- '/tmp/mstar-review-attempt'`,
      `[ -f '/tmp/mstar-review-attempt' ] || exit 3; cat -- '/tmp/mstar-review-attempt'`,
    ]);
    expect(startCalls).toEqual([]);
  });

  test("provision on a running slot with a foreign marker rewrites it (never repairs by leaving it)", async () => {
    reset();
    markerBytes = "mstar.review-attempt/v1:someone-else\n";
    const { sandbox } = makeDo(true);

    expect(await sandbox.provision(MARKER, { deadlineEpochMs: Date.now() + 120_000 })).toEqual({
      kind: "provisioned",
    });

    expect(markerBytes).toBe(MARKER);
    expect(startCalls).toEqual([]);
  });

  test("runMarked on a stopped slot answers not-running and starts NOTHING", async () => {
    reset();
    const { sandbox } = makeDo(false);

    expect(await sandbox.runMarked(MARKER, shellCommand("cat result.json"))).toEqual({ kind: "not-running" });
    expect(startCalls).toEqual([]);
    expect(execCalls).toEqual([]);
  });

  test("an exec whose dispatch never answers is a LOST REPLY, never 'nothing ran'", async () => {
    // A dispatched exec may have run even when its answer never arrives. The
    // pre-exec refusal guard needs a deadline past KILL_GRACE_MS, so this case
    // costs that grace and no more.
    reset();
    const { sandbox, container } = makeDo(true);
    markerBytes = MARKER;
    let dispatched = 0;
    container.exec = mock(async (cmd: string[]) => {
      execCalls.push({ cmd });
      const line = cmd[cmd.length - 1] ?? "";
      if (line.includes("/tmp/mstar-review-attempt")) {
        return { stdin: null, output: async () => ({ stdout: bytes(MARKER), stderr: new ArrayBuffer(0), exitCode: 0 }) };
      }
      dispatched += 1;
      return Promise.withResolvers<{ output: () => Promise<ExecOutput>; stdin: null }>().promise;
    });

    const started = Date.now();
    const read = await sandbox.runMarked(MARKER, shellCommand("true"), {
      // KILL_GRACE_MS is 5 s; the pre-exec guard refuses anything closer.
      deadlineEpochMs: started + 5_000 + 60,
    });

    expect(dispatched).toBe(1);
    expect(read).toEqual({ kind: "reply-lost" });
  }, 15_000);

  test("a marker write that never resolves answers unavailable AT the caller's deadline, not after a fixed wait", async () => {
    reset();
    const { sandbox, container } = makeDo(false);
    container.exec = mock(async (cmd: string[]) => {
      execCalls.push({ cmd });
      return { stdin: null, output: () => Promise.withResolvers<ExecOutput>().promise };
    });

    const started = Date.now();
    const result = await sandbox.provision(MARKER, { deadlineEpochMs: started + 50 });

    expect(result).toEqual({ kind: "unavailable" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("runCommand never starts a container: a stopped slot is a transient ContainerNotRunningError", async () => {
    reset();
    const { sandbox } = makeDo(false);

    await expect(sandbox.runCommand(shellCommand("echo hi"))).rejects.toBeInstanceOf(ContainerNotRunningError);
    expect(startCalls).toEqual([]);
    expect(execCalls).toEqual([]);
  });

  test("runCommand wraps the command string into the single /bin/sh sink under the default 600s bound", async () => {
    reset();
    running = true;
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
    const { container } = makeDo(true);

    expect(inactivityCalls).toEqual([INACTIVITY_TIMEOUT_MS]);
    expect(startCalls).toEqual([]);
    expect(container.setInactivityTimeout).toHaveBeenCalledTimes(1);
  });

  test("constructor leaves a stopped container alone (provision starts it)", () => {
    reset();
    const { container } = makeDo(false);

    expect(inactivityCalls).toEqual([]);
    expect(container.setInactivityTimeout).toHaveBeenCalledTimes(0);
  });

  test("a missing container image key fails loud at provisioning (wrangler/DO drift, not a silent no-op)", async () => {
    reset();
    const container = { ...makeContainer(), images: {} };
    const ctx = {
    container,
    storage: { get: async () => undefined, put: async () => {} },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  };
    containerRunning = false;
    const sandbox = new SandboxV1(ctx as never, {}) as unknown as ReviewSandbox;

    expect(await sandbox.provision(MARKER, { deadlineEpochMs: Date.now() + 120_000 })).toEqual({
      kind: "unavailable",
    });
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
    const sandbox = new SandboxV1(
      {
        storage: { get: async () => undefined, put: async () => {} },
        blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
      } as never,
      {},
    ) as unknown as ReviewSandbox;

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
      provision: async () => ({ kind: "provisioned" }),
      runCommand: async () => ({ stdout: "out", stderr: "", exitCode: 0 }),
      runMarked: async () => ({ kind: "ran", stdout: "out", stderr: "", exitCode: 0 }),
      destroyMarked: async () => "destroyed",
      destroy: async () => {},
    };
    const binding = { getByName(name: string): ReviewSandbox { names.push(name); return stub; } };

    const sandbox = await getSandbox(binding, "Smoke-ABC-123");

    expect(names).toEqual(["smoke-abc-123"]);
    expect(await sandbox.runCommand(shellCommand("echo hi"))).toEqual({ stdout: "out", stderr: "", exitCode: 0 });
    await sandbox.destroy();
    expect(destroyCalls).toEqual([]);
  });
});

describe("SandboxV1 stdin transport (the credential channel)", () => {
  const PAYLOAD = '{"version":1,"pools":{"ark":["secret-key"]}}';

  test("a stdin payload is written through the exec pipe and the stream is CLOSED (a reader waiting for EOF completes)", async () => {
    reset();
    execStdin = "reader";
    execResult = { stdout: bytes("envelope\n"), stderr: new ArrayBuffer(0), exitCode: 0 };
    const { sandbox } = makeDo();

    const result = await sandbox.runCommand(shellCommand("bun run runner.ts"), {
      cwd: "/workspace/repo",
      env: { OMP_REVIEW_MODEL: "ark/deepseek-v4-flash" },
      stdin: PAYLOAD,
    });

    expect(execCalls).toEqual([
      {
        cmd: ["timeout", "--kill-after=5", "600", "/bin/sh", "-lc", "bun run runner.ts"],
        opts: { cwd: "/workspace/repo", env: { OMP_REVIEW_MODEL: "ark/deepseek-v4-flash" }, stdin: "pipe" },
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

  test("an oversized payload fails closed BEFORE the container starts — and the error carries the size, never the payload", async () => {
    reset();
    const { sandbox } = makeDo();
    const payload = `s${"e".repeat(MAX_EXEC_STDIN_BYTES)}`;

    let message = "";
    try {
      await sandbox.runCommand(shellCommand("bun run runner.ts"), { stdin: payload });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe(
      `the exec stdin payload is ${MAX_EXEC_STDIN_BYTES + 1} bytes, above the ${MAX_EXEC_STDIN_BYTES}-byte bound`,
    );
    expect(message).not.toContain("seee");
    expect(startCalls).toEqual([]);
    expect(execCalls).toEqual([]);
  });

  test("the documented worst-case runner input (4 × ceil(512 KiB / 3) = 699,052 bytes) fits the cap and reaches the child", async () => {
    reset();
    execStdin = "reader";
    const { sandbox } = makeDo();
    const payload = "x".repeat(4 * Math.ceil((512 * 1024) / 3));

    await sandbox.runCommand(shellCommand("bun run runner.ts"), { stdin: payload });

    expect(payload.length).toBe(699_052);
    expect(execCalls).toHaveLength(1);
    expect(execStdinBytes).toBe(payload);
    expect(execStdinEof).toBe(true);
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

  test("a stdin write failure keeps the child's own non-zero exit code AND its own evidence", async () => {
    reset();
    execStdin = "error-on-write";
    execResult = { stdout: new ArrayBuffer(0), stderr: bytes("review: cannot read runner input\n"), exitCode: 1 };
    const { sandbox } = makeDo();

    const result = await sandbox.runCommand(shellCommand("bun run runner.ts"), { stdin: PAYLOAD });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "review: cannot read runner input\nexec stdin: exec stdin closed before the payload was delivered",
    );
  });

  test("output collection starts BEFORE the payload write (a child whose full output pipe blocks the stdin write cannot deadlock the run)", async () => {
    reset();
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
    execStdin = "delayed-write";
    const { sandbox } = makeDo();

    let settled = false;
    const run = sandbox
      .runCommand(shellCommand("bun run runner.ts"), { stdin: PAYLOAD })
      .then((value) => {
        settled = true;
        return value;
      });

    await Bun.sleep(10);
    expect(settled).toBe(false);
    expect(stdinEvents).toEqual(["write"]);
    expect(execStdinEof).toBe(false);

    openWriteGate();
    await run;

    expect(settled).toBe(true);
    expect(stdinEvents).toEqual(["write", "write-settled", "close"]);
    expect(execStdinBytes).toBe(PAYLOAD);
    expect(execStdinEof).toBe(true);
  });
});

describe("SandboxV1 exec argv/env bounds", () => {
  test("a command or env value past the per-argument bound fails closed BEFORE any process starts — and the error carries no text", async () => {
    reset();
    const { sandbox } = makeDo();
    const command = "z".repeat(MAX_EXEC_COMMAND_BYTES + 1);

    let message = "";
    try {
      await sandbox.runCommand(shellCommand(command));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe(
      `exec command is ${MAX_EXEC_COMMAND_BYTES + 1} bytes, above the ${MAX_EXEC_COMMAND_BYTES}-byte bound`,
    );
    expect(message).not.toContain("zzz");
    expect(execCalls).toEqual([]);
    expect(startCalls).toEqual([]);

    reset();
    try {
      await sandbox.runCommand(shellCommand("echo hi"), { env: { BIG: "e".repeat(MAX_EXEC_ENV_VALUE_BYTES + 1) } });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe(
      `exec env BIG is ${MAX_EXEC_ENV_VALUE_BYTES + 1} bytes, above the ${MAX_EXEC_ENV_VALUE_BYTES}-byte bound`,
    );
    expect(message).not.toContain("eee");
    expect(execCalls).toEqual([]);
    expect(startCalls).toEqual([]);
  });

  test("the bound counts UTF-8 bytes, not string length (a multibyte command past the cap is refused)", async () => {
    reset();
    const { sandbox } = makeDo();
    const command = "字".repeat(MAX_EXEC_COMMAND_BYTES / 3 + 1);
    const bytes = new TextEncoder().encode(command).byteLength;

    let message = "";
    try {
      await sandbox.runCommand(shellCommand(command));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(String(bytes));
    expect(execCalls).toEqual([]);
    expect(startCalls).toEqual([]);
  });

  test("a command and an env value exactly AT the bound are accepted (the cap is a strict >)", async () => {
    reset();
    const { sandbox } = makeDo();

    await sandbox.runCommand(shellCommand("c".repeat(MAX_EXEC_COMMAND_BYTES)));
    expect(execCalls).toHaveLength(1);

    reset();
    await sandbox.runCommand(shellCommand("echo hi"), { env: { BIG: "e".repeat(MAX_EXEC_ENV_VALUE_BYTES) } });
    expect(execCalls).toHaveLength(1);
  });
});

describe("SandboxV1 absolute exec deadline", () => {
  function proofSpendingContainer(proofSpentMs: number, clock: { now: number }) {
    const { sandbox, container } = makeDo(true);
    container.exec = mock(async (cmd: string[], opts?: unknown) => {
      if (cmd[cmd.length - 1]?.includes("cat --")) {
        clock.now += proofSpentMs;
        execCalls.push({ cmd, opts });
        return {
          stdin: null,
          output: async () => ({ stdout: bytes(MARKER), stderr: new ArrayBuffer(0), exitCode: 0 }),
        };
      }
      execCalls.push({ cmd, opts });
      return {
        stdin: null,
        output: async () => ({ stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode: 0 }),
      };
    });
    return { sandbox, container };
  }

  test("a proof that consumed the window starts nothing", async () => {
    reset();
    running = true;
    await withFrozenClock(async (clock) => {
      const { sandbox } = proofSpendingContainer(10_000, clock);
      const result = await sandbox.runMarked(MARKER, shellCommand("bun run x"), {
        deadlineEpochMs: clock.now + 10_000,
      });
      expect(result).toEqual({ kind: "deadline-spent", remainingMs: 0 });
    });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.cmd[execCalls[0]!.cmd.length - 1]).toContain("cat --");
  });

  test("the argv carries the container-side computation, not a frozen duration", async () => {
    reset();
    running = true;
    let deadline = 0;
    await withFrozenClock(async (clock) => {
      const { sandbox } = proofSpendingContainer(4_000, clock);
      deadline = clock.now + 10_000;
      const result = await sandbox.runMarked(MARKER, shellCommand("bun run x"), {
        deadlineEpochMs: deadline,
      });
      expect(result.kind).toBe("ran");
    });
    const child = execCalls.find((call) => call.cmd[call.cmd.length - 1] === "bun run x")!;
    expect(child.cmd.slice(0, 3)).toEqual(["/bin/sh", "-c", EXEC_DEADLINE_WRAPPER]);
    expect(child.cmd[2]).toContain("$(date +%s)");
    expect(child.cmd[2]).toContain("exec timeout --kill-after=$grace_s");
    expect(child.cmd[4]).toBe(String(Math.floor(deadline / 1000)));
    expect(child.cmd[6]).toBe("bun run x");
    expect(child.cmd).not.toContain("timeout");
  });

  test("a container clock past the deadline REFUSES with 125 and does not run the runner", () => {
    // 125 is the wrapper's own refusal (nothing started). 124 stays the
    // platform timeout kill, which is a different fact about a running command.
    const past = Math.floor(Date.now() / 1000) - 60;
    const result = Bun.spawnSync(["/bin/sh", "-c", EXEC_DEADLINE_WRAPPER, "mstar-deadline", String(past), "5000", "echo ran"]);
    expect(result.exitCode).toBe(125);
    expect(result.stdout.toString()).toBe("");
  });
});
