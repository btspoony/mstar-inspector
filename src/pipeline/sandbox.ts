
import { DurableObject } from "cloudflare:workers";
import type { Container, DurableObjectState } from "@cloudflare/workers-types";
import { ContainerNotRunningError, execCause, execSensitiveValues } from "./sandbox-errors";
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
 * The process was opened and its reply never arrived inside the host timer. The
 * command may have run (and may have written a result), so this is NEVER a
 * "nothing ran" verdict: only a refusal that precedes the exec proves that.
 *
 * `cause` is bounded evidence and NEVER a second discriminant: callers classify
 * on `kind` alone.
 */
type ExecReplyLost = { kind: "reply-lost"; cause?: string };

/**
 * What `provision` observed inside the DO's exclusive gate. `provisioned` means
 * the slot runs and its disk carries this attempt's marker; `unavailable` means
 * the start, the inactivity setting or the marker write did not answer inside
 * the caller's absolute deadline and NOTHING may be assumed about the slot;
 * `misconfigured` means the container has no image bound for this slot, a
 * terminal setup fault a retry cannot fix; `retired` means the durable fence is
 * set and nothing may ever start here.
 */
export type ProvisionOutcome =
  | { kind: "provisioned" }
  | { kind: "unavailable" }
  | { kind: "misconfigured" }
  | { kind: "retired" };

/**
 * The closed outcome set of ONE marker-guarded operation, as classified at the
 * observation inside the exclusive gate. `container.running` is sampled once, on
 * entry: it separates `not-running` from everything else and is never used to
 * explain a failed marker read.
 *
 * Only `ran` and `deadline-spent` prove that nothing is running. `reply-lost`
 * covers an issued exec with no reply (the child may still be alive), so it is
 * never treated as "nothing ran".
 */
export type MarkedRun =
  | { kind: "ran"; stdout: string; stderr: string; exitCode: number }
  | { kind: "reply-lost"; cause?: string }
  | { kind: "not-running" }
  | { kind: "marker-mismatch" }
  | { kind: "marker-unreadable" }
  | { kind: "retired" }
  | { kind: "deadline-spent"; remainingMs: number };

/**
 * The terminal state of a destruction attempt. `destroyed` and `stopped` both
 * mean the slot ends here and the fence is set; `unknown` means nothing was
 * proven, nothing was destroyed and the slot keeps whatever it holds.
 */
export type DestroyOutcome = "destroyed" | "stopped" | "unknown";

/**
 * A command was addressed to a slot that is not running. Declared in the
 * dependency-free `./sandbox-errors` leaf so a caller that only classifies
 * outcomes never links the container binding; re-exported here as part of the
 * sandbox boundary surface.
 */
export { ContainerNotRunningError } from "./sandbox-errors";

/** Locked contract (compass contracts B). */
export type ReviewSandbox = {
  provision(marker: string, opts: { deadlineEpochMs: number }): Promise<ProvisionOutcome>;
  runCommand(
    command: ShellCommand,
    opts?: CommandOpts,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  runMarked(marker: string, command: ShellCommand, opts?: CommandOpts): Promise<MarkedRun>;
  destroyMarked(marker: string, retention: RetentionProof): Promise<DestroyOutcome>;
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

const AWAIT_EXPIRED = Symbol("await-expired");

const KILL_GRACE_MS = 5_000;

/**
 * Printed on stderr by the wrapper's own refusal. Exit 125 alone proves
 * nothing — `timeout` also exits 125 when it cannot run the command, and the
 * command may `exit 125` itself — so a deadline refusal must be named.
 */
export const EXEC_DEADLINE_REFUSED_SENTINEL = "mstar-deadline-refused";

/**
 * The in-container deadline evaluation, run by the container's own shell:
 * `$1` = the absolute deadline in Unix SECONDS, `$2` = the SIGKILL grace in ms,
 * `$3` = the command. `container.exec`'s relative timeout restarts when the
 * process actually starts, so a host-side number can never be absolute; the
 * wrapper reads `date +%s` inside the container and a window at or below the
 * grace REFUSES with 125 and the sentinel on stderr, WITHOUT starting anything.
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
  `if [ "$remaining" -le "$grace_s" ]; then echo ${EXEC_DEADLINE_REFUSED_SENTINEL} >&2; exit 125; fi`,
  "remaining=$((deadline_s - $(date +%s) - 1))",
  `if [ "$remaining" -le "$grace_s" ]; then echo ${EXEC_DEADLINE_REFUSED_SENTINEL} >&2; exit 125; fi`,
  'exec timeout --kill-after=$grace_s "$((remaining - grace_s))" /bin/sh -lc "$1"',
].join("; ");

function normalizedTimeoutMs(requested: number | undefined): number {
  const ms = requested ?? DEFAULT_EXEC_TIMEOUT_MS;
  return Number.isFinite(ms) ? Math.max(1, ms) : DEFAULT_EXEC_TIMEOUT_MS;
}

async function boundedAwait<T>(work: Promise<T>, atMs: number): Promise<T | typeof AWAIT_EXPIRED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof AWAIT_EXPIRED>((resolve) => {
        timer = setTimeout(() => resolve(AWAIT_EXPIRED), Math.max(0, atMs - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const MARKER_PATH = "/tmp/mstar-review-attempt";
const MARKER_READ_COMMAND = shellCommand(`[ -f '${MARKER_PATH}' ] || exit 3; cat -- '${MARKER_PATH}'`);
const MARKER_WRITE_COMMAND = shellCommand(
  `umask 077; printf '%s' "$MSTAR_ATTEMPT_MARKER" > '${MARKER_PATH}'`,
);

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

  /**
   * THE one method that may start a container. Everything the start owes — the
   * start, the inactivity setting and the marker write — must answer inside the
   * caller's ONE absolute deadline, or the whole provisioning is `unavailable`
   * and nothing is assumed about the slot.
   */
  async provision(marker: string, opts: { deadlineEpochMs: number }): Promise<ProvisionOutcome> {
    const markerOpts = { env: { MSTAR_ATTEMPT_MARKER: marker } };
    this.assertBounds(MARKER_WRITE_COMMAND, markerOpts);
    return this.exclusive(async () => {
      if (this.revoked) return { kind: "retired" };
      const deadlineEpochMs = opts.deadlineEpochMs;
      try {
        const container = this.container;
        if (!container.running) {
          const image = container.images[CONTAINER_IMAGE_KEY];
          // A missing image is a terminal setup fault, never a transient start
          // failure: RETURN it (a throw here would be caught as `unavailable`).
          if (image === undefined) return { kind: "misconfigured" };
          container.start({ image, instance: CONTAINER_INSTANCE, enableInternet: true });
          const armed = await boundedAwait(
            container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
            deadlineEpochMs,
          );
          if (armed === AWAIT_EXPIRED) return { kind: "unavailable" };
        }
        // A running slot keeps its disk, so the marker is rewritten only when
        // the bytes are ABSENT or different; the fresh-disk case is the branch
        // above. An UNREADABLE marker is neither: writing over it would claim a
        // provision the slot never proved, so it is `unavailable` and the next
        // entry tries again.
        const current = await this.readMarker(container, deadlineEpochMs);
        if (current.kind === "unreadable") return { kind: "unavailable" };
        if (current.kind !== "bytes" || current.text !== marker) {
          const written = await this.writeMarker(container, marker, markerOpts, deadlineEpochMs);
          if (!written) return { kind: "unavailable" };
        }
        // The write is proved by reading it back, so `provisioned` never means
        // "I sent a write": it means the slot carries this attempt's bytes.
        const confirmed = await this.readMarker(container, deadlineEpochMs);
        if (confirmed.kind !== "bytes" || confirmed.text !== marker) {
          return { kind: "unavailable" };
        }
        return { kind: "provisioned" };
      } catch {
        return { kind: "unavailable" };
      }
    });
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
      // A retired slot is a different refusal from a stopped one: the fence is
      // permanent (a successor owns the PR or the container was destroyed), so
      // the caller must not treat it as a transient "provision me again".
      if (this.revoked) {
        throw new Error("this attempt was revoked by the successor that took its PR — nothing may start");
      }
      const handle = this.container;
      if (!handle.running) {
        throw new ContainerNotRunningError(
          "the attempt container is not running — only provisioning may start it",
        );
      }
      return handle;
    });
    const result = await this.execCommand(container, command, opts, prepared);
    if ("kind" in result && result.kind === "reply-lost") {
      // The command was opened; only its reply is missing. A caller that mutates
      // the slot must treat this exactly like a lost reply on any other path,
      // and the bound's own cause (a thrown fault OR a host timer) rides the
      // message — this path has no outcome field to carry it.
      throw new Error(
        `the exec was issued and its reply was lost — the command may have run${result.cause === undefined ? "" : ` — ${result.cause}`}`,
      );
    }
    if ("kind" in result) {
      throw new Error("the exec deadline was spent before the process started");
    }
    return result;
  }

  /**
   * Probe-only: it never starts a container. The caller's absolute deadline is
   * the ONE budget — the marker read and the command share it, and the proof
   * gets none of its own.
   */
  async runMarked(marker: string, command: ShellCommand, opts?: CommandOpts): Promise<MarkedRun> {
    return this.exclusive(async () => {
      if (this.revoked) return { kind: "retired" };
      const container = this.container;
      if (!container.running) return { kind: "not-running" };
      const deadlineEpochMs =
        opts?.deadlineEpochMs ?? Date.now() + normalizedTimeoutMs(opts?.timeout);
      if (deadlineEpochMs - Date.now() <= KILL_GRACE_MS) {
        return { kind: "deadline-spent", remainingMs: deadlineEpochMs - Date.now() };
      }
      const proof = await this.readMarker(container, deadlineEpochMs);
      if (proof.kind === "unreadable") return { kind: "marker-unreadable" };
      if (proof.kind !== "bytes" || proof.text !== marker) return { kind: "marker-mismatch" };
      if (deadlineEpochMs - Date.now() <= KILL_GRACE_MS) {
        return { kind: "deadline-spent", remainingMs: deadlineEpochMs - Date.now() };
      }
      const openedAtMs = Date.now();
      try {
        const ran = await this.execCommand(container, command, { ...opts, deadlineEpochMs });
        return "kind" in ran ? ran : ({ kind: "ran", ...ran } as const);
      } catch (err) {
        // The exec was opened; only its reply is missing. The cause is the one
        // thing this boundary would otherwise discard before any caller logs it,
        // sanitized against everything THIS exec carried.
        return {
          kind: "reply-lost",
          cause: execCause(err, openedAtMs, execSensitiveValues(command, opts)),
        };
      }
    });
  }

  /**
   * `destroyed` and `stopped` both fence the slot; `stopped` is the platform
   * having ended the incarnation already, which the caller's retention proof
   * makes equivalent to destroying it. `unknown` destroys nothing.
   */
  async destroyMarked(marker: string, retention: RetentionProof): Promise<DestroyOutcome> {
    if (!isRetentionProof(retention)) return "unknown";
    return this.exclusive(async () => {
      if (this.revoked === true) return "stopped";
      const container = this.container;
      if (!container.running) {
        await this.fence();
        return "stopped";
      }
      const deadlineEpochMs = Date.now() + DEFAULT_EXEC_TIMEOUT_MS;
      const proof = await this.readMarker(container, deadlineEpochMs);
      if (proof.kind !== "bytes" || proof.text !== marker) return "unknown";
      await container.destroy();
      await this.fence();
      return "destroyed";
    });
  }

  /**
   * Persist the fence FIRST, then raise the in-memory flag: a failed put must
   * leave both sides agreeing the slot is open (a later entry retries), never
   * the memory claiming a fence the storage does not hold.
   */
  private async fence(): Promise<void> {
    if (this.revoked) return;
    await this.ctx.storage.put(REVOKED_KEY, true);
    this.revoked = true;
  }

  /**
   * The marker's verdict on one sampled running slot. `absent` (the file is not
   * there) and `unreadable` (the read gave no verdict inside the deadline) are
   * different observations and stay apart: only the first can be repaired by
   * writing the marker.
   */
  private async readMarker(
    container: Container,
    deadlineEpochMs: number,
  ): Promise<{ kind: "bytes"; text: string } | { kind: "absent" } | { kind: "unreadable" }> {
    try {
      const read = await boundedAwait(
        this.execCommand(container, MARKER_READ_COMMAND, { deadlineEpochMs }),
        deadlineEpochMs,
      );
      if (read === AWAIT_EXPIRED || "kind" in read) return { kind: "unreadable" };
      if (read.exitCode === 3) return { kind: "absent" };
      return read.exitCode === 0 ? { kind: "bytes", text: read.stdout } : { kind: "unreadable" };
    } catch {
      return { kind: "unreadable" };
    }
  }

  /** Write the marker; `false` when it did not land or did not answer in time. */
  private async writeMarker(
    container: Container,
    marker: string,
    opts: { env: Record<string, string> },
    deadlineEpochMs: number,
  ): Promise<boolean> {
    try {
      const written = await boundedAwait(
        this.execCommand(container, MARKER_WRITE_COMMAND, { env: opts.env, deadlineEpochMs }),
        deadlineEpochMs,
      );
      return written !== AWAIT_EXPIRED && !("kind" in written) && written.exitCode === 0;
    } catch {
      return false;
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
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | ExecDeadlineSpent | ExecReplyLost> {
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
    // `container.exec` itself can stall (readiness, supervisor). With an
    // absolute deadline the call is bounded host-side too, so a wedged platform
    // RPC cannot hold the DO's exclusive gate past the attempt's own instant.
    const execOptions = {
      cwd: opts?.cwd,
      env: opts?.env,
      ...(stdinPayload === undefined ? {} : { stdin: "pipe" as const }),
    };
    const openedAtMs = Date.now();
    const opened =
      deadlineMs === undefined
        ? await container.exec(argv, execOptions)
        : await boundedAwait(container.exec(argv, execOptions), deadlineMs);
    // The open may already have been dispatched by the platform, so a host
    // timer here proves neither "did not run" nor "no result": lost reply. The
    // cause is sanitized against what THIS exec carried, so a host-timer
    // sentence is as bounded as a thrown one, and the two timer paths below
    // stay distinguishable in the row.
    if (opened === AWAIT_EXPIRED) {
      return {
        kind: "reply-lost",
        cause: execCause(
          new Error("the host timer expired before the exec dispatch answered"),
          openedAtMs,
          execSensitiveValues(command, opts),
        ),
      };
    }
    const process = opened;
    const drained = process.output();
    let stdinFailure: Error | undefined;
    if (stdinPayload !== undefined) {
      try {
        await writeExecStdin(process.stdin, stdinPayload);
      } catch {
        stdinFailure = new Error("exec stdin closed before the payload was delivered");
      }
    }
    const output =
      deadlineMs === undefined ? await drained : await boundedAwait(drained, deadlineMs + KILL_GRACE_MS);
    // The command demonstrably ran (it was opened); the reply missed the timer.
    // Its output may already be durable on the slot, so this is a lost reply.
    if (output === AWAIT_EXPIRED) {
      return {
        kind: "reply-lost",
        cause: execCause(
          new Error("the host timer expired while the exec output was being drained"),
          openedAtMs,
          execSensitiveValues(command, opts),
        ),
      };
    }
    if (stdinFailure !== undefined && output.exitCode === 0) {
      throw stdinFailure;
    }
    // 125 alone proves nothing: `timeout` exits 125 when it cannot run the
    // command, and the command may `exit 125` itself. Only the wrapper's own
    // sentinel marks the refusal that ran BEFORE `exec`, so the command
    // provably never started. 124 stays a real timeout kill (the platform's
    // `timeout`), which is why the two codes differ.
    const stderrText = utf8.decode(output.stderr);
    if (output.exitCode === 125 && stderrText.includes(EXEC_DEADLINE_REFUSED_SENTINEL)) {
      return { kind: "deadline-spent", remainingMs: 0 };
    }
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
      await this.fence();
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
