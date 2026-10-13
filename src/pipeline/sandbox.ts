/**
 * Sandbox adapter (STOP gate) — the ONLY module in the repo that reaches the
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
 * (`sandbox-image/omp/Dockerfile` must copy it from the same 1.0 line).
 *
 * Container model (1.0):
 *   - the DO starts its own container: `container.start({ image:
 *     container.images.<key>, instance, enableInternet })` — `start()` returns
 *     before readiness and the first `exec()` waits for it;
 *   - every request path calls `ensureRunning()` first, and every step after
 *     `start()` is safe to repeat (a deploy restarts the DO; the inactivity
 *     timeout does not survive a restart, so it is (re)set on every guard);
 *   - `container.exec(argv, { cwd, env })` runs ONE process — no implicit
 *     shell, no session state (0.12's `enableDefaultSession: false`
 *     becomes the platform default). `env` is per-call and does not inherit
 *     image `ENV` lines except `PATH`.
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
 * A shell command cleared for the sandbox sink (CWE-78 boundary). Branded so
 * a raw `string` is a type error at `ReviewSandbox.runCommand`: only the
 * pipeline/gitops.ts builders (allowlist + fail-closed before any shell
 * string exists) and audited in-repo constants mint it via `shellCommand()`.
 * The brand lives in ./shell-command (dependency-free) and is re-exported
 * here as part of the sandbox boundary surface.
 */
export { shellCommand, type ShellCommand };

/** Locked contract (compass contracts B). */
export type ReviewSandbox = {
  runCommand(
    command: ShellCommand,
    opts?: { env?: Record<string, string>; cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  destroy(): Promise<void>;
};

/** Container image key in `wrangler.jsonc` → `containers[].images`. */
const CONTAINER_IMAGE_KEY = "sandbox";
/** Instance size carried over from the 0.12 `instance_type: "lite"` pin. */
const CONTAINER_INSTANCE = "lite" as const;
/**
 * Container inactivity bound. The DO stays active while a `runCommand` RPC is
 * in flight, so this guards the gaps BETWEEN calls — it must outlive the
 * longest single review (deep: 14 min runner + git steps, src/pipeline/
 * consumer.ts runnerTimeoutMs + the 15-min queue wall-clock cap).
 */
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

const utf8 = new TextDecoder();

/**
 * The review-sandbox Durable Object (wrangler `class_name: "Sandbox"` — the
 * exported name must match wrangler.jsonc's containers/durable_objects/
 * migrations entries). Owns and starts its own container; the Worker reaches
 * its RPC methods through `getSandbox()`.
 */
export class Sandbox extends DurableObject {
  /**
   * A restarted DO (deploy, eviction) loses the container's inactivity
   * timeout while the container keeps running, so the timeout is armed again
   * here — before any request — for a container this DO finds already
   * running. `blockConcurrencyWhile` keeps requests behind the re-arm. The
   * request-path guard re-arms it as well (both are idempotent).
   */
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  /** The container bound to this DO (absent only when the binding is misconfigured). */
  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("The container binding is not configured");
    return container;
  }

  /**
   * Start the container when needed and (re)set the inactivity timeout —
   * idempotent by construction: `running` is true as soon as `start()`
   * returns, the check→start sequence has no await in between (concurrent
   * calls cannot double-start), and every step after `start()` is safe to
   * repeat because a deploy restarts the DO.
   */
  private async ensureRunning(): Promise<void> {
    const container = this.container;
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
   * THE shell sink. `command` is a branded `ShellCommand`; it reaches a shell
   * exactly once, as the `-c` payload of `/bin/sh` under the GNU `timeout`
   * bound. The bound is forwarded in seconds WITHOUT rounding — GNU `timeout`
   * takes fractional durations, so an explicit millisecond override keeps the
   * caller's exact bound (`{ timeout: 250 }` → `0.25`). Exit code 124 = the
   * bound fired.
   */
  async runCommand(
    command: ShellCommand,
    opts?: { env?: Record<string, string>; cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await this.ensureRunning();
    // Clamp before converting: a zero/negative value must never reach the argv
    // as a zero or negative duration (GNU `timeout 0` DISABLES the bound).
    const timeoutMs = Math.max(1, opts?.timeout ?? DEFAULT_EXEC_TIMEOUT_MS);
    const timeoutSeconds = timeoutMs / 1000;
    const process = await this.container.exec(
      ["timeout", "--kill-after=5", String(timeoutSeconds), "/bin/sh", "-lc", command],
      { cwd: opts?.cwd, env: opts?.env },
    );
    const output = await process.output();
    return {
      stdout: utf8.decode(output.stdout),
      stderr: utf8.decode(output.stderr),
      exitCode: output.exitCode,
    };
  }

  /** Terminate the container. Ids are never reused (see getSandbox). */
  async destroy(): Promise<void> {
    await this.container.destroy();
  }
}

/**
 * Get (or create) a sandbox instance by id. The id MUST be unique per
 * attempt: a destroyed sandbox's id must never be reused
 * (attach-after-destroy behavior is unknown = ASSUMPTION; uniqueness wins).
 * DO names are case-sensitive-rejected by the platform — lowercase here
 * (0.12's `normalizeId` is gone).
 */
export async function getSandbox(binding: SandboxBinding, id: string): Promise<ReviewSandbox> {
  // The stub exposes exactly the RPC methods the DO class defines
  // (runCommand/destroy) — the ReviewSandbox shape.
  const namespace = binding as { getByName(name: string): ReviewSandbox };
  return namespace.getByName(id.toLowerCase());
}
