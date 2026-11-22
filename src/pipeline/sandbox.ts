
import { DurableObject } from "cloudflare:workers";
import type { Container, DurableObjectState } from "@cloudflare/workers-types";
import { shellCommand, type ShellCommand } from "./shell-command";

/** The Worker binding shape (pinned; `PipelineEnv.SANDBOX`). */
export type SandboxBinding = unknown;

/** Default run bound (ms) when a caller passes no explicit timeout. */
export const DEFAULT_EXEC_TIMEOUT_MS = 600_000;

/**
 * Upper bound on a `runCommand` `stdin` payload. The pipe carries two payload
 * classes: the credential transport — at most MAX_KEYS_PER_PROVIDER keys of
 * MAX_PROVIDER_KEY_LENGTH per provider, over the BYOK allowlist plus
 * MAX_CUSTOM_PROVIDER_COUNT custom declarations (~1 MB worst case) — and the
 * runner-input document (the recheck input is capped at 512 KiB, ~683 KiB once
 * base64-encoded). This cap sits above both and fails closed BEFORE a process
 * starts, so a runaway payload can never reach the pipe.
 */
export const MAX_EXEC_STDIN_BYTES = 2 * 1024 * 1024;

/**
 * Upper bound on the ONE `exec` argument that carries the shell command.
 * Linux caps a single argument at `MAX_ARG_STRLEN` = 128 KiB; this leaves
 * headroom and fails where the diagnosis is readable, before `execve` returns
 * E2BIG.
 */
export const MAX_EXEC_COMMAND_BYTES = 96 * 1024;

/** Per-variable env bound, well below the same per-argument limit. */
export const MAX_EXEC_ENV_VALUE_BYTES = 8 * 1024;

/**
 * A shell command cleared for the sandbox sink (CWE-78 boundary). Branded so
 * a raw `string` is a type error at `ReviewSandbox.runCommand`: only the
 * pipeline/gitops.ts builders (allowlist + fail-closed before any shell
 * string exists) and audited in-repo constants mint it via `shellCommand()`.
 * The brand lives in ./shell-command (dependency-free) and is re-exported
 * here as part of the sandbox boundary surface.
 */
export { shellCommand, type ShellCommand };

type CommandOpts = {
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  deadlineEpochMs?: number;
  stdin?: string;
};

type ExecDeadlineSpent = { kind: "deadline-spent"; remainingMs: number };

/**
 * The result of a marker-guarded operation: either it ran on a container that
 * still carries the attempt's exact marker bytes, or the container could not
 * be proven to be that one and NOTHING ran.
 */
export type MarkedRun =
  | { kind: "ran"; stdout: string; stderr: string; exitCode: number }
  | { kind: "unknown" }
  | { kind: "deadline-spent"; remainingMs: number };

/** Locked contract (compass contracts B). */
export type ReviewSandbox = {
  runCommand(
    command: ShellCommand,
    opts?: CommandOpts,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  claimMarker(marker: string): Promise<"written" | "matched" | "unknown">;
  runMarked(marker: string, command: ShellCommand, opts?: CommandOpts): Promise<MarkedRun>;
  destroyMarked(marker: string, retention: RetentionProof): Promise<"destroyed" | "unknown">;
  destroy(): Promise<void>;
  revoke?(): Promise<{ revoked: boolean; running: boolean }>;
};

/**
 * Why destroying this container cannot lose a result. A matching marker proves
 * WHICH container it is, never that anything in it is safe to discard, so the
 * caller must name a fact — and only two facts authorise destruction:
 *
 * - `retained`: the paid call RETURNED and its result is durably persisted.
 * - `no-paid-work`: the attempt never reached the paid call.
 *
 * Nothing else qualifies. A rejected exec, a lost reply, an output-stream
 * error, a timeout or a DO restart is not evidence that a child stopped, so
 * none of them authorises destruction — an unproven container is left to the
 * platform's inactivity reclamation instead.
 */
export type RetentionProof = { readonly kind: "retained" } | { readonly kind: "no-paid-work" };

function isRetentionProof(proof: RetentionProof | undefined): proof is RetentionProof {
  return proof?.kind === "retained" || proof?.kind === "no-paid-work";
}

const LOCKED_AWAIT_MARGIN_MS = 15_000;

const LOCKED_AWAIT_TIMEOUT = Symbol("locked-await-timeout");

const KILL_GRACE_MS = 5_000;

/**
 * The in-container deadline evaluation, run by the container's own shell:
 * `$1` = the absolute deadline in Unix SECONDS, `$2` = the SIGKILL grace in ms,
 * `$3` = the command. `container.exec`'s relative timeout restarts when the
 * process actually starts, so a host-side number can never be absolute; the
 * wrapper reads `date +%s` inside the container and a window at or below the
 * grace exits 124 WITHOUT starting anything.
 *
 * The clock is sampled TWICE, the second time immediately before the exec: a
 * single early sample can be stale by a container suspension, and a duration
 * derived from it would let the child outlive the instant on resume. The first
 * sample still answers the cheap case (a window already spent when the shell
 * started) without paying the rest of the wrapper.
 *
 * Residual (documented in the review-budget deployment gate): a suspension
 * strictly between the FINAL sample and `exec timeout` still hands the child a
 * duration computed before the freeze. No shell can close that — it needs a
 * kernel-side watchdog the platform does not expose — and it is now a window of
 * a few syscalls rather than the whole request.
 *
 * Exported so the suite can execute the exact wrapper the container runs.
 */
export const EXEC_DEADLINE_WRAPPER = [
  "deadline_s=$1; grace_ms=$2; shift 2",
  "grace_s=$((grace_ms / 1000))",
  "remaining=$((deadline_s - $(date +%s) - 1))",
  'if [ "$remaining" -le "$grace_s" ]; then exit 124; fi',
  "remaining=$((deadline_s - $(date +%s) - 1))",
  'if [ "$remaining" -le "$grace_s" ]; then exit 124; fi',
  'exec timeout --kill-after=$grace_s "$((remaining - grace_s))" /bin/sh -lc "$1"',
].join("; ");

function normalizedTimeoutMs(requested: number | undefined): number {
  const ms = requested ?? DEFAULT_EXEC_TIMEOUT_MS;
  return Number.isFinite(ms) ? Math.max(1, ms) : DEFAULT_EXEC_TIMEOUT_MS;
}

async function boundedAwait<T>(work: Promise<T>, ms: number): Promise<T | typeof LOCKED_AWAIT_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof LOCKED_AWAIT_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(LOCKED_AWAIT_TIMEOUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const MARKER_PATH = "/tmp/mstar-review-attempt";
const MARKER_READ_COMMAND = shellCommand(`[ -f '${MARKER_PATH}' ] || exit 3; cat -- '${MARKER_PATH}'`);
const MARKER_CLAIM_COMMAND = shellCommand(
  `umask 077; set -C; printf '%s' "$MSTAR_ATTEMPT_MARKER" > '${MARKER_PATH}'`,
);
const MARKER_READ_TIMEOUT_MS = 30_000;

const REVOKED_KEY = "attempt-revoked";

const CONTAINER_IMAGE_KEY = "sandbox";
const CONTAINER_INSTANCE = "basic" as const;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

const utf8 = new TextDecoder();
const utf8Encoder = new TextEncoder();

async function writeExecStdin(stream: WritableStream | null, payload: Uint8Array): Promise<void> {
  if (stream === null) throw new Error("the container exec opened no stdin stream");
  const writer = stream.getWriter();
  await writer.write(payload);
  await writer.close();
}

/**
 * The review-sandbox Durable Object (wrangler `class_name: "SandboxV1"` — the
 * exported name must match wrangler.jsonc's containers/durable_objects/
 * migrations entries). Owns and starts its own container; the Worker reaches
 * its RPC methods through `getSandbox()`.
 *
 * The class carries a NEW name (and a new `new_sqlite_classes` migration tag)
 * on purpose: a container application cannot change its scheduling policy in
 * place or attach to a Durable Object namespace the 0.12-era application
 * already owns — the 1.0 replacement must be a new class/namespace, or the
 * deploy lands the new Worker version with no durable_object application
 * behind it (containers migration guide, migrate-to-durable-object-scheduling-policy).
 */
export class SandboxV1 extends DurableObject {
  private revoked = false;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
    void ctx.blockConcurrencyWhile(async () => {
      this.revoked = (await ctx.storage.get<boolean>(REVOKED_KEY)) === true;
    });
  }

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("The container binding is not configured");
    return container;
  }

  private async ensureRunning(container: Container): Promise<void> {
    if (this.revoked) {
      throw new Error("this attempt was revoked by the successor that took its PR — nothing may start");
    }
    if (!container.running) {
      const image = container.images[CONTAINER_IMAGE_KEY];
      if (image === undefined) {
        throw new Error(`container image "${CONTAINER_IMAGE_KEY}" is not configured`);
      }
      container.start({ image, instance: CONTAINER_INSTANCE, enableInternet: true });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  private gate: Promise<unknown> = Promise.resolve();

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.gate.then(run, run);
    this.gate = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async runCommand(
    command: ShellCommand,
    opts?: CommandOpts,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const prepared = { stdin: this.assertBounds(command, opts) };
    const container = await this.exclusive(async () => {
      const handle = this.container;
      const started = await boundedAwait(this.ensureRunning(handle), LOCKED_AWAIT_MARGIN_MS);
      if (started === LOCKED_AWAIT_TIMEOUT) {
        throw new Error(`container did not become ready within ${LOCKED_AWAIT_MARGIN_MS}ms`);
      }
      return handle;
    });
    const result = await this.execCommand(container, command, opts, prepared);
    if ("kind" in result) {
      throw new Error("the exec deadline was spent before the process started");
    }
    return result;
  }

  async claimMarker(marker: string): Promise<"written" | "matched" | "unknown"> {
    const opts = { env: { MSTAR_ATTEMPT_MARKER: marker } };
    this.assertBounds(MARKER_CLAIM_COMMAND, opts);
    return this.exclusive(async () => {
      const container = this.container;
      const started = await boundedAwait(this.ensureRunning(container), LOCKED_AWAIT_MARGIN_MS);
      if (started === LOCKED_AWAIT_TIMEOUT) return "unknown";
      let exitCode: number;
      try {
        const claimed = await boundedAwait(
          this.execCommand(container, MARKER_CLAIM_COMMAND, opts),
          MARKER_READ_TIMEOUT_MS + LOCKED_AWAIT_MARGIN_MS,
        );
        if (claimed === LOCKED_AWAIT_TIMEOUT) return "unknown";
        if ("kind" in claimed) return "unknown";
        exitCode = claimed.exitCode;
      } catch {
        exitCode = 1;
      }
      if (exitCode === 0) return "written";
      const current = await boundedAwait(this.readMarker(container), MARKER_READ_TIMEOUT_MS + LOCKED_AWAIT_MARGIN_MS);
      return current === marker ? "matched" : "unknown";
    });
  }

  async runMarked(marker: string, command: ShellCommand, opts?: CommandOpts): Promise<MarkedRun> {
    return this.exclusive(async () => {
      const container = this.container;
      if (!container.running) return { kind: "unknown" };
      const proof = await boundedAwait(this.readMarker(container), MARKER_READ_TIMEOUT_MS + LOCKED_AWAIT_MARGIN_MS);
      if (proof === LOCKED_AWAIT_TIMEOUT || proof !== marker) return { kind: "unknown" };
      const awaitBoundMs =
        opts?.deadlineEpochMs === undefined
          ? normalizedTimeoutMs(opts?.timeout)
          : Math.max(0, opts.deadlineEpochMs - Date.now()) + KILL_GRACE_MS;
      try {
        const ran = await boundedAwait(
          this.execCommand(container, command, opts),
          awaitBoundMs + LOCKED_AWAIT_MARGIN_MS,
        );
        if (ran === LOCKED_AWAIT_TIMEOUT) return { kind: "unknown" };
        return "kind" in ran ? ran : ({ kind: "ran", ...ran } as const);
      } catch {
        return { kind: "unknown" };
      }
    });
  }

  async destroyMarked(marker: string, retention: RetentionProof): Promise<"destroyed" | "unknown"> {
    if (!isRetentionProof(retention)) return "unknown";
    return this.exclusive(async () => {
      const container = this.container;
      if (!container.running) return "unknown";
      const proof = await boundedAwait(this.readMarker(container), MARKER_READ_TIMEOUT_MS + LOCKED_AWAIT_MARGIN_MS);
      if (proof === LOCKED_AWAIT_TIMEOUT || proof !== marker) return "unknown";
      await container.destroy();
      return "destroyed";
    });
  }

  private async readMarker(container: Container): Promise<string | null> {
    try {
      const read = await this.execCommand(container, MARKER_READ_COMMAND, { timeout: MARKER_READ_TIMEOUT_MS });
      if ("kind" in read) return null;
      return read.exitCode === 0 ? read.stdout : null;
    } catch {
      return null;
    }
  }

  private assertBounds(command: ShellCommand, opts: CommandOpts | undefined): Uint8Array | undefined {
    const commandBytes = utf8Encoder.encode(command).byteLength;
    if (commandBytes > MAX_EXEC_COMMAND_BYTES) {
      throw new Error(`exec command is ${commandBytes} bytes, above the ${MAX_EXEC_COMMAND_BYTES}-byte bound`);
    }
    for (const [name, value] of Object.entries(opts?.env ?? {})) {
      const valueBytes = utf8Encoder.encode(value).byteLength;
      if (valueBytes > MAX_EXEC_ENV_VALUE_BYTES) {
        throw new Error(`exec env ${name} is ${valueBytes} bytes, above the ${MAX_EXEC_ENV_VALUE_BYTES}-byte bound`);
      }
    }
    const stdinPayload = opts?.stdin === undefined ? undefined : utf8Encoder.encode(opts.stdin);
    if (stdinPayload !== undefined && stdinPayload.byteLength > MAX_EXEC_STDIN_BYTES) {
      throw new Error(
        `the exec stdin payload is ${stdinPayload.byteLength} bytes, above the ${MAX_EXEC_STDIN_BYTES}-byte bound`,
      );
    }
    return stdinPayload;
  }

  private async execCommand(
    container: Container,
    command: ShellCommand,
    opts: CommandOpts | undefined,
    prepared?: { stdin: Uint8Array | undefined },
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | ExecDeadlineSpent> {
    const stdinPayload = prepared === undefined ? this.assertBounds(command, opts) : prepared.stdin;
    const deadlineMs = opts?.deadlineEpochMs;
    if (deadlineMs !== undefined && deadlineMs - Date.now() <= KILL_GRACE_MS) {
      return { kind: "deadline-spent", remainingMs: deadlineMs - Date.now() };
    }
    const argv =
      deadlineMs === undefined
        ? [
            "timeout",
            `--kill-after=${KILL_GRACE_MS / 1000}`,
            String(normalizedTimeoutMs(opts?.timeout) / 1000),
            "/bin/sh",
            "-lc",
            command,
          ]
        : [
            "/bin/sh",
            "-c",
            EXEC_DEADLINE_WRAPPER,
            "mstar-deadline",
            String(Math.floor(deadlineMs / 1000)),
            String(KILL_GRACE_MS),
            command,
          ];
    const process = await container.exec(argv, {
        cwd: opts?.cwd,
        env: opts?.env,
        ...(stdinPayload === undefined ? {} : { stdin: "pipe" as const }),
      },
    );
    const drained = process.output();
    let stdinFailure: Error | undefined;
    if (stdinPayload !== undefined) {
      try {
        await writeExecStdin(process.stdin, stdinPayload);
      } catch {
        stdinFailure = new Error("exec stdin closed before the payload was delivered");
      }
    }
    const output = await drained;
    if (stdinFailure !== undefined && output.exitCode === 0) {
      throw stdinFailure;
    }
    const stderrText = utf8.decode(output.stderr);
    const stdinNote = stdinFailure === undefined ? "" : `exec stdin: ${stdinFailure.message}`;
    return {
      stdout: utf8.decode(output.stdout),
      stderr:
        stdinNote === ""
          ? stderrText
          : stderrText.trimEnd() === ""
            ? stdinNote
            : `${stderrText.trimEnd()}\n${stdinNote}`,
      exitCode: output.exitCode,
    };
  }

  async destroy(): Promise<void> {
    return this.exclusive(() => this.container.destroy());
  }

  async revoke(): Promise<{ revoked: boolean; running: boolean }> {
    return this.exclusive(async () => {
      if (this.ctx.container?.running === true) return { revoked: false, running: true };
      if (!this.revoked) {
        this.revoked = true;
        await this.ctx.storage.put(REVOKED_KEY, true);
      }
      return { revoked: true, running: false };
    });
  }
}

/**
 * Compatibility class for the RETAINED legacy `v1` migration
 * (`new_sqlite_classes: ["Sandbox"]` in wrangler.jsonc). Wrangler replays
 * every unapplied migration on a first deploy, and a fresh account / DR
 * rebuild / recreated smoke Worker has no prior script — so the class the
 * migration names must stay exported from the Worker entry or the upload
 * fails. It serves no requests and configures nothing: no container, no
 * `this.ctx` use, no traffic path (the durable_objects binding points at
 * `SandboxV1` only) — `SandboxV1` is the only live implementation.
 * This export is PERSISTENT: the `v1` tag must stay declared forever and every
 * fresh worker replays it, so removing the class re-arms the upload rejection.
 * ops deletes the orphaned `mstar-inspector-sandbox` container application and
 * a later `v3` tag adds `deleted_classes: ["Sandbox"]` to stop NEW namespaces
 * carrying it — but the export stays (docs/deploy.md § Cloudflare resources).
 */
export class Sandbox extends DurableObject {
}

/**
 * Get (or create) a sandbox instance by id. The id MUST be unique per
 * attempt: a destroyed sandbox's id must never be reused
 * (attach-after-destroy behavior is unknown = ASSUMPTION; uniqueness wins).
 * DO names are case-sensitive-rejected by the platform — lowercase here
 * (0.12's `normalizeId` is gone).
 */
export async function getSandbox(binding: SandboxBinding, id: string): Promise<ReviewSandbox> {
  const namespace = binding as { getByName(name: string): ReviewSandbox };
  return namespace.getByName(id.toLowerCase());
}
