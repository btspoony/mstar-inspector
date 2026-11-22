/**
 * invariant: Sandbox adapter (STOP gate) — the ONLY module in the repo that reaches the
 * sandbox runtime (compass contracts A / the Global Constraints). Wraps it
 * behind the locked `ReviewSandbox` contract so the consumer and the smoke
 * never touch the runtime surface directly.
 *
 * `@cloudflare/sandbox` 1.0.0 removed the `Sandbox` class and `getSandbox()`
 * (the package now ships only `Files`/`S3Mount`/`DirectoryBackup` + error
 * classes, none used here). The Durable Object below is written in-repo and
 * drives the container itself through the workerd-only `cloudflare:workers`
 * builtin (`DurableObject` base + `this.ctx.container`); the package stays
 * pinned at 1.0.0 as the version anchor for the image's `sandbox-shim`
 * (`sandbox-image/Dockerfile` must copy it from the same 1.0 line).
 *
 * Container model (1.0):
 *   - the DO starts its own container: `container.start({ image:
 *     container.images.<key>, instance, enableInternet })` — `start()` returns
 *     before readiness and the first `exec()` waits for it;
 *   - every request path calls `ensureRunning()` first, and every step after
 *     `start()` is safe to repeat (a deploy restarts the DO; the inactivity
 *     timeout does not survive a restart, so it is (re)set on every guard);
 *   - `container.exec(argv, { cwd, env, stdin })` runs ONE process — no
 *     implicit shell, no session state (0.12's `enableDefaultSession: false`
 *     becomes the platform default). `env` is per-call and does not inherit
 *     image `ENV` lines except `PATH`. `stdin` is the payload channel for the
 *     credentials AND the runner-input document (`"pipe"`): it hands back the
 *     child's `WritableStream`, which the adapter writes once and CLOSES (the
 *     close is the EOF a reader waits for).
 *
 * Command-string boundary (scanner CWE-78 / qc2 F-001): 1.0 has no string-form
 * shell runner, so the validated shell string is wrapped ONCE below into the
 * explicit `["/bin/sh", "-lc", command]` argv — still a single sink, still
 * gated by the `ShellCommand` brand minted ONLY by the validated
 * pipeline/gitops.ts builders (allowlist + fail-closed + single-quote
 * discipline) or audited in-repo constants (smoke). A raw string —
 * webhook/HTTP-derived or otherwise unvalidated — is a type error at the sink.
 *
 * `timeout` (ms) keeps its meaning: the 0.12 SDK option is gone, so every run
 * is bounded by GNU coreutils `timeout` in the argv (`--kill-after=5` then
 * SIGKILL). A caller-provided timeout wins, otherwise DEFAULT_EXEC_TIMEOUT_MS
 * applies — a hung gh/git/model call can never outlive the container silently
 * (qc3 F-001). Exit code 124 means the bound fired (0.12 threw instead; the
 * consumer fails the stage on either path).
 *
 * The binding is typed `unknown` per the consumer contract
 * (`PipelineEnv.SANDBOX: unknown` — the binding shape is pinned by tests and
 * cast here). The cast boundary stays: consumers never see the namespace.
 */

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

/** note: One exec's options (command, env and stdin bounds all apply). */
type CommandOpts = {
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  /**
   * invariant: An ABSOLUTE Unix-ms instant the child must be gone by. When set, `timeout`
   * is ignored: the remaining window is derived inside the CONTAINER's shell
   * immediately before it starts the bounded command, so the request queue, the
   * RPC, any marker proof and the DO's own scheduling are all charged to it. A
   * window at or below the kill grace starts nothing.
   */
  deadlineEpochMs?: number;
  stdin?: string;
};

/** invariant: The exec that never started: the absolute deadline (less the kill grace) was already gone. */
type ExecDeadlineSpent = { kind: "deadline-spent"; remainingMs: number };

/**
 * The result of a marker-guarded operation: either it ran on a container that
 * still carries the attempt's exact marker bytes, or the container could not
 * be proven to be that one and NOTHING ran.
 */
export type MarkedRun =
  | { kind: "ran"; stdout: string; stderr: string; exitCode: number }
  | { kind: "unknown" }
  /**
   * invariant: The absolute deadline (less the kill grace) was gone before the child
   * started: NOTHING ran, so the caller owes a confirmed cap stop — never
   * `unknown` (which would hold the container and capacity).
   */
  | { kind: "deadline-spent"; remainingMs: number };

/** Locked contract (compass contracts B). */
export type ReviewSandbox = {
  runCommand(
    command: ShellCommand,
    opts?: CommandOpts,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /**
   * invariant: Write this attempt's marker exactly once. `matched` = the container already
   * carries those exact bytes (a replay of the same attempt's prepare);
   * `unknown` = it carries other bytes, so it is NOT this attempt's container
   * and the marker is never repaired over it.
   */
  claimMarker(marker: string): Promise<"written" | "matched" | "unknown">;
  /**
   * invariant: Run `command` ONLY on an already-running container whose marker is exactly
   * `marker`. Never starts a container: a missing/different marker, or no live
   * container at all, runs nothing and reports `unknown` (not a failure — the
   * state of the container is unknown, so no result may be claimed from it).
   */
  runMarked(marker: string, command: ShellCommand, opts?: CommandOpts): Promise<MarkedRun>;
  /**
   * invariant: Destroy ONLY an already-running container whose marker is exactly `marker`
   * AND whose result the caller has shown to be retained (or whose paid call
   * never started). A missing/different marker or a missing proof destroys
   * nothing and reports `unknown`: a replacement incarnation is never torn down
   * on another attempt's behalf, and a paid command whose completion is
   * unproven is left to the platform's inactivity reclamation.
   */
  destroyMarked(marker: string, retention: RetentionProof): Promise<"destroyed" | "unknown">;
  /**
   * note: Unproven teardown, for a container that is not an attempt's (the smoke's
   * own health-check sandbox). Attempt-owned containers use `destroyMarked`.
   */
  destroy(): Promise<void>;
  /**
   * invariant: Observe, then revoke: ONE critical section answers whether this attempt's
   * container is running, and revokes the attempt only when it is NOT.
   *
   * `{ revoked: true, running: false }` is the fact a successor may take the
   * attempt's PR on — nothing can act now, and the durable flag stops every
   * later start. `{ revoked: false, running: true }` is a live holder: nothing
   * was revoked and the PR must stay where it is (`revoked: false` is the
   * promise that no authority was taken away from an attempt that can still
   * act). Absent means the host cannot observe, which is not a stop either.
   */
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

/**
 * invariant: Headroom a host-side bound gives a locked operation beyond the child's own
 * GNU-timeout bound. The shell bound only covers a process after it starts; the
 * platform calls around it (setInactivityTimeout, exec admission, the output
 * stream) have no deadline of their own, and one that never settles would hold
 * the DO's critical section forever.
 */
const LOCKED_AWAIT_MARGIN_MS = 15_000;

const LOCKED_AWAIT_TIMEOUT = Symbol("locked-await-timeout");

/**
 * invariant: GNU `timeout`'s SIGKILL grace (ms): SIGTERM first, SIGKILL this much later.
 * An absolute deadline reserves it OUT of the remaining window, so the kill
 * never lands after the deadline. Drives BOTH the in-container subtraction and
 * the `--kill-after` argument.
 */
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
  // invariant: Re-sample: the first read may predate a suspension, and the duration the
  // child is granted must be what is left NOW, not what was left then. The
  // extra second is shaved so SIGKILL still lands at or before the millisecond
  // deadline, never up to a second after it.
  "remaining=$((deadline_s - $(date +%s) - 1))",
  'if [ "$remaining" -le "$grace_s" ]; then exit 124; fi',
  'exec timeout --kill-after=$grace_s "$((remaining - grace_s))" /bin/sh -lc "$1"',
].join("; ");

/** note: The ONE clamp: a zero/negative/NaN override is not a duration (GNU `timeout 0` disables its bound). */
function normalizedTimeoutMs(requested: number | undefined): number {
  const ms = requested ?? DEFAULT_EXEC_TIMEOUT_MS;
  return Number.isFinite(ms) ? Math.max(1, ms) : DEFAULT_EXEC_TIMEOUT_MS;
}

/** note: Bound one await inside the critical section; the work is abandoned, not cancelled. */
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

/** note: The attempt marker's fixed in-container path: ephemeral `/tmp`, outside the checkout and any mount. */
const MARKER_PATH = "/tmp/mstar-review-attempt";
/**
 * invariant: Read the marker; exit 3 names "absent" so a missing file stays distinct from
 * an unreadable one (both refuse, but only one means "wrong container").
 */
const MARKER_READ_COMMAND = shellCommand(`[ -f '${MARKER_PATH}' ] || exit 3; cat -- '${MARKER_PATH}'`);
/**
 * invariant: Exclusive create: noclobber makes the redirection itself fail when the file
 * exists, so an existing marker is never truncated or replaced. The payload
 * rides the env (bounded above), never the command string.
 */
const MARKER_CLAIM_COMMAND = shellCommand(
  `umask 077; set -C; printf '%s' "$MSTAR_ATTEMPT_MARKER" > '${MARKER_PATH}'`,
);
/** invariant: The marker is ~60 bytes; a hung read must not hold an attempt's collection. */
const MARKER_READ_TIMEOUT_MS = 30_000;

/** note: The DO's durable revocation flag (see `revoke`); read before any start. */
const REVOKED_KEY = "attempt-revoked";

/** note: Container image key in `wrangler.jsonc` → `containers[].images`. */
const CONTAINER_IMAGE_KEY = "sandbox";
/**
 * note: Instance size. `lite` (256 MiB, 1/16 vCPU) carried the pin over from the
 * 0.12 `instance_type` value. The note it replaced claimed the all-silent
 * stall "was not resource exhaustion — a memory-starved process would not
 * emit nothing on either stream". That reasoning is wrong on its own terms:
 * an OOM-killed process emits exactly nothing, and a container dying reaches
 * `exec` as `Network connection lost`.
 *
 * Established: no review has completed since 2026-08-30. Every run observed
 * since records either the bound firing with both streams empty or
 * `Network connection lost`. On the image that ships the stage trace (the
 * 2026-11-02 rebuild), the first `review_stage` line never appears; that puts
 * the stall before `enter_run_review`: the exec never yielded a running
 * process, or the process stalled in bootstrap, module init, or the credential
 * stdin read.
 *
 * NOT established: which change started it. An earlier move of this pin to
 * `basic` was written, but that deploy FAILED, so the change never reached the
 * container and the hypothesis has never actually been exercised. Do not treat
 * that earlier attempt as a negative result.
 *
 * `basic` (1 GiB, 1/4 vCPU) is that exercise, not a proven fix.
 */
const CONTAINER_INSTANCE = "basic" as const;
/**
 * invariant: Container inactivity bound. The DO stays active while a `runCommand` RPC is
 * in flight, so this guards the gaps BETWEEN calls — it must outlive the
 * longest single review (deep: 14 min runner + git steps, src/pipeline/
 * consumer.ts runnerTimeoutMs + the 15-min queue wall-clock cap).
 */
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

const utf8 = new TextDecoder();
const utf8Encoder = new TextEncoder();

/**
 * invariant: Write one payload into the child's stdin and CLOSE it.
 *
 * Closing is what sends **EOF**: a reader that consumes stdin to the end (the
 * in-image runner reads its credential payload and its runner-input document
 * that way) would otherwise wait until the exec bound fires — which reads as a
 * timeout instead of an input bug. The write is awaited, so the stream's own
 * backpressure governs and a payload larger than the pipe buffer cannot
 * outrun the child.
 *
 * Errors are REDACTED: the writer's own error is discarded rather than
 * interpolated, so the payload can never surface in a diagnostic.
 */
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
  /**
   * why: A restarted DO (deploy, eviction) loses the container's inactivity
   * timeout while the container keeps running, so the timeout is armed again
   * here — before any request — for a container this DO finds already
   * running. `blockConcurrencyWhile` keeps requests behind the re-arm. The
   * request-path guard re-arms it as well (both are idempotent).
   */
  /**
   * note: A revocation outlives an eviction: a restarted DO that forgot it could
   * start a container for an attempt a successor already owns.
   */
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

  /** invariant: The container bound to this DO (absent only when the binding is misconfigured). */
  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("The container binding is not configured");
    return container;
  }

  /**
   * why: Start the container when needed and (re)set the inactivity timeout —
   * idempotent by construction: `running` is true as soon as `start()`
   * returns, the check→start sequence has no await in between (the
   * incarnation lock makes concurrent calls impossible), and every step after
   * `start()` is safe to repeat because a deploy restarts the DO.
   */
  private async ensureRunning(container: Container): Promise<void> {
    // invariant: THE revocation gate: every start-permitted call goes through here, so a
    // revoked attempt cannot provision a container again — not with a replay,
    // not after an eviction, not with a command queued before the revocation.
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

  /**
   * invariant: One guarded critical section at a time on this DO: a guarded operation's
   * proof-and-action pair, and the start decision of a plain run (the only
   * start-permitted path). Holding it across the pair is what stops another
   * request from provisioning between the marker read and the command/destroy
   * that read justifies.
   *
   * It is deliberately NOT held across a paid execution: `runCommand` leaves
   * the queue as soon as its container is ready, so a hung exec can never keep
   * a later teardown from acquiring the lock and checking sameness.
   *
   * Bound: an out-of-band platform restart between the marker read and the
   * action is outside what this DO can serialise. The guarantee is "the same
   * handle this request proved", not "the same process across a platform
   * restart".
   */
  private gate: Promise<unknown> = Promise.resolve();

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.gate.then(run, run);
    this.gate = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * safety: THE shell sink. `command` is a branded `ShellCommand`; it reaches a shell
   * exactly once, as the `-c` payload of `/bin/sh` under the GNU `timeout`
   * bound. The bound is forwarded in seconds WITHOUT rounding — GNU `timeout`
   * takes fractional durations, so an explicit millisecond override keeps the
   * caller's exact bound (`{ timeout: 250 }` → `0.25`). Exit code 124 = the
   * bound fired.
   *
   * `stdin` is the payload channel (credentials, the runner input document):
   * when present it is written into the child's stdin pipe and the stream is
   * closed (EOF). Nothing about it appears in `argv`, `env` or the return
   * value, and an oversized payload — like an oversized argument — fails
   * closed before a process exists.
   */
  async runCommand(
    command: ShellCommand,
    opts?: CommandOpts,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // invariant: Bounds first: a payload that can never be delivered must not start a
    // container. The start is serialized with the guarded pair; the exec that
    // follows is not — a long run must not hold the queue.
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
      // invariant: No caller passes an absolute deadline on the unguarded path; a refusal
      // here is a programming error, never a startable run.
      throw new Error("the exec deadline was spent before the process started");
    }
    return result;
  }

  /**
   * why: Write the attempt marker once. Starting is deliberate: prepare owns
   * provisioning, so this is the ONE marker path allowed to start a container.
   * A lost reply is resolved by reading the marker back from the same handle —
   * a replay sees the same bytes and reports `matched` instead of failing.
   */
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
        // why: A timed-out write is not retried and not read back: the marker's
        // presence is unprovable, so the outcome is unknown.
        if (claimed === LOCKED_AWAIT_TIMEOUT) return "unknown";
        // invariant: No deadline rides this path, so a refusal cannot happen; if it did,
        // nothing was written and the marker is unprovable.
        if ("kind" in claimed) return "unknown";
        exitCode = claimed.exitCode;
      } catch {
        // invariant: The write failed (noclobber refusal, container loss). Only a matching
        // marker can turn that into a replay; anything else is not provable.
        exitCode = 1;
      }
      if (exitCode === 0) return "written";
      const current = await boundedAwait(this.readMarker(container), MARKER_READ_TIMEOUT_MS + LOCKED_AWAIT_MARGIN_MS);
      return current === marker ? "matched" : "unknown";
    });
  }

  /**
   * invariant: The sameness gate. The handle is captured ONCE, the marker is read from
   * it, and the command runs on that same handle — never a fresh
   * `this.container` read after the awaited probe, and no start-permitted path
   * can run in between (`exclusive`). `running` is checked first, so a probe
   * never starts a container.
   */
  async runMarked(marker: string, command: ShellCommand, opts?: CommandOpts): Promise<MarkedRun> {
    return this.exclusive(async () => {
      const container = this.container;
      if (!container.running) return { kind: "unknown" };
      const proof = await boundedAwait(this.readMarker(container), MARKER_READ_TIMEOUT_MS + LOCKED_AWAIT_MARGIN_MS);
      // invariant: A timed-out proof never reaches the action: the container is unknown,
      // and a proof that settled later must not race the replacement it may
      // have described.
      if (proof === LOCKED_AWAIT_TIMEOUT || proof !== marker) return { kind: "unknown" };
      // invariant: The host-side await must outlive what the child was granted: with an
      // absolute deadline that is the window left AFTER this proof, not the
      // caller's relative `timeout`.
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
        // invariant: The exec reply was lost: whether the command ran is unprovable, so
        // the outcome is `unknown` — never a document read as unreadable.
        return { kind: "unknown" };
      }
    });
  }

  /**
   * invariant: Prove sameness on the captured handle, then destroy that same container —
   * but only on a fact that says nothing can be lost.
   *
   * Refused (`unknown`, nothing destroyed) when the proof is missing or is not
   * one of the two facts, when the container is not live, when it carries other
   * bytes, or when the marker read cannot be bounded. There is deliberately no
   * allowance for an unsettled run: an in-memory count, elapsed time or a lost
   * reply never proves a paid child stopped. The refused container is left to
   * the platform, whose absolute reclamation bound is UNVERIFIED — the
   * configured inactivity timeout bounds idle gaps only, not a still-active
   * process or a stalled destroy.
   *
   * `destroy()` is NOT bounded and never abandoned: when it is issued the
   * attempt is already safe to lose, and abandoning it mid-flight would let it
   * land later against a container another run has started.
   *
   * Destroying for an attempt this caller did not run (a Workflow recovery
   * deciding for someone else) is the durable attempt row's job: it must own
   * the first-provisioning claim before that authority exists. No such caller
   * exists yet, and this proof cannot be borrowed for it.
   */
  async destroyMarked(marker: string, retention: RetentionProof): Promise<"destroyed" | "unknown"> {
    if (!isRetentionProof(retention)) return "unknown";
    return this.exclusive(async () => {
      const container = this.container;
      if (!container.running) return "unknown";
      const proof = await boundedAwait(this.readMarker(container), MARKER_READ_TIMEOUT_MS + LOCKED_AWAIT_MARGIN_MS);
      // invariant: A stalled proof never reaches the destroy below.
      if (proof === LOCKED_AWAIT_TIMEOUT || proof !== marker) return "unknown";
      await container.destroy();
      return "destroyed";
    });
  }

  /** invariant: The marker's exact bytes, or null when it is absent/unreadable. Never starts a container. */
  private async readMarker(container: Container): Promise<string | null> {
    try {
      const read = await this.execCommand(container, MARKER_READ_COMMAND, { timeout: MARKER_READ_TIMEOUT_MS });
      // invariant: No deadline rides this path; a refusal would mean nothing was read.
      if ("kind" in read) return null;
      return read.exitCode === 0 ? read.stdout : null;
    } catch {
      return null;
    }
  }

  /**
   * invariant: The exec bounds, checked before anything starts: an argv or payload that
   * can never be delivered must not provision a container. Returns the encoded
   * stdin so the caller can hand it to `execCommand` instead of re-encoding.
   */
  private assertBounds(command: ShellCommand, opts: CommandOpts | undefined): Uint8Array | undefined {
    // note: Linux caps ONE argv string at MAX_ARG_STRLEN (128 KiB); these bounds leave
    // headroom and fail before `execve` can report E2BIG. No value is echoed.
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

  /**
   * invariant: The bounded exec itself, on the caller's handle. Never starts a container:
   * a start is the caller's separate, locked decision.
   */
  private async execCommand(
    container: Container,
    command: ShellCommand,
    opts: CommandOpts | undefined,
    prepared?: { stdin: Uint8Array | undefined },
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | ExecDeadlineSpent> {
    const stdinPayload = prepared === undefined ? this.assertBounds(command, opts) : prepared.stdin;
    const deadlineMs = opts?.deadlineEpochMs;
    // invariant: FAST PATH only: the shell below is the GUARANTEE. A window the DO can
    // already see as spent returns before a process exists; a window this
    // check still believes in is evaluated again by the container's own clock,
    // so queueing between this request and the process start cannot move it.
    if (deadlineMs !== undefined && deadlineMs - Date.now() <= KILL_GRACE_MS) {
      return { kind: "deadline-spent", remainingMs: deadlineMs - Date.now() };
    }
    // invariant: Two shapes: the relative bound every ordinary step uses, and the
    // absolute one whose arithmetic the container's shell performs. The shell
    // receives the epoch in seconds and the grace in ms — never a frozen
    // duration — so the `timeout` it starts is derived at the last instant.
    const argv =
      deadlineMs === undefined
        ? [
            "timeout",
            `--kill-after=${KILL_GRACE_MS / 1000}`,
            // invariant: Clamp before converting: a zero/negative value must never reach
            // the argv as a zero or negative duration (GNU `timeout 0`
            // DISABLES the bound); a non-finite override is not a duration.
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
        // note: No `stdin` option at all = the platform closes stdin and sends EOF.
        ...(stdinPayload === undefined ? {} : { stdin: "pipe" as const }),
      },
    );
    // why: Drain stdout/stderr CONCURRENTLY with the write: a child that emits ahead
    // of reading its stdin would otherwise deadlock against a full output pipe.
    // (`output()` is readable once, so it is started here and awaited once.)
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
    // invariant: A child that exited while reporting its own failure keeps its result —
    // that stderr is the real diagnosis. One that claims SUCCESS after the
    // payload failed to land is refused: never report a credential-carrying run
    // as completed when its credentials never arrived.
    if (stdinFailure !== undefined && output.exitCode === 0) {
      throw stdinFailure;
    }
    // invariant: A non-zero exit keeps the child's own stderr, but a stdin write failure
    // is still evidence and must not vanish with it: "the payload never landed"
    // and "the payload landed and the child then failed" are different
    // diagnoses, and the caller only sees this string.
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

  /** invariant: Terminate the container. Ids are never reused (see getSandbox). */
  async destroy(): Promise<void> {
    return this.exclusive(() => this.container.destroy());
  }

  /**
   * invariant: The successor's takeover fact (spec §7.9): observe, then revoke — both
   * inside the ONE critical section that also serialises starts, so a start
   * either completed before this call (`running: true`, nothing revoked, the
   * successor refuses) or meets the flag on its way in. The answer never
   * reports a container this DO did not just prove.
   */
  async revoke(): Promise<{ revoked: boolean; running: boolean }> {
    return this.exclusive(async () => {
      // note: Observe FIRST. A live container is reported untouched: revoking it
      // would take away authority from an attempt that can still act, which is
      // the one limb the successor rule forbids.
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
  // invariant: Intentionally empty — the legacy `v1` migration's name holder only.
}

/**
 * Get (or create) a sandbox instance by id. The id MUST be unique per
 * attempt: a destroyed sandbox's id must never be reused
 * (attach-after-destroy behavior is unknown = ASSUMPTION; uniqueness wins).
 * DO names are case-sensitive-rejected by the platform — lowercase here
 * (0.12's `normalizeId` is gone).
 */
export async function getSandbox(binding: SandboxBinding, id: string): Promise<ReviewSandbox> {
  // invariant: The stub exposes exactly the RPC methods the DO class defines
  // (runCommand/destroy) — the ReviewSandbox shape.
  const namespace = binding as { getByName(name: string): ReviewSandbox };
  return namespace.getByName(id.toLowerCase());
}
