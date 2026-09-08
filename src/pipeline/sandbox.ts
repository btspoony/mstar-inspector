/**
 * Sandbox thin adapter (plan 06 Task 1, STOP gate) — the ONLY module in the
 * repo that imports `@cloudflare/sandbox` (compass contracts A / plan Global
 * Constraints). Wraps the SDK behind the locked `ReviewSandbox` contract so
 * the consumer (T3) and the smoke (T1) never touch the SDK surface directly.
 *
 * Verified SDK surface (@cloudflare/sandbox 0.12.8, dist types + live smoke):
 *   - getSandbox(ns, id, options?) -> Sandbox (sync; container starts lazily
 *     on first operation)
 *   - shell runner: `Sandbox` exposes a STRING-FORM-ONLY shell runner (no
 *     argv-array variant in 0.12.8) -> Promise<ExecResult>, options
 *     { env?: Record<string, string | undefined>, cwd?: string,
 *     timeout?: number, ... } — per-call env/cwd, buffered result
 *   - Sandbox.destroy() -> Promise<void> (terminates container, deletes state)
 *
 * Command-string boundary (scanner CWE-78 / qc2 F-001): because the SDK sink
 * is a single shell string, the wrapper funnels it through ONE bound call
 * below and types the contract input as `ShellCommand` — a branded string
 * minted ONLY by the validated pipeline/gitops.ts builders (allowlist +
 * fail-closed + single-quote discipline) or audited in-repo constants
 * (smoke). A raw string — webhook/HTTP-derived or otherwise unvalidated —
 * is a type error at the sink.
 *
 * `timeout` (ms) is the SDK's max execution time per command. Every run is
 * bounded: a caller-provided timeout wins, otherwise DEFAULT_EXEC_TIMEOUT_MS
 * applies — a hung gh/git/model call can never outlive the container silently
 * (plan QC 06 fix round 1 / qc3 F-001).
 *
 * `enableDefaultSession: false` (lifecycle docs recommendation): each run
 * executes in isolation — no shell state carries between calls. The consumer
 * passes cwd/env per call, so no session state is needed.
 *
 * The binding is typed `unknown` per the plan contract
 * (`PipelineEnv.SANDBOX: unknown` — the binding shape is pinned at T1 and
 * cast here). The SDK's own `DurableObjectNamespace` type is ambient
 * (capnweb) and does not satisfy @cloudflare/workers-types' branded
 * constraint, so the cast is the single, documented boundary.
 */

import { getSandbox as cfGetSandbox, type Sandbox } from "@cloudflare/sandbox";
import { shellCommand, type ShellCommand } from "./shell-command";

/** Re-export for Durable Object registration from the Worker entry point. */
export { Sandbox } from "@cloudflare/sandbox";

/** The Worker binding shape (pinned at T1; plan `PipelineEnv.SANDBOX`). */
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

/** Locked contract (plan interface section / compass contracts B). */
export type ReviewSandbox = {
  runCommand(
    command: ShellCommand,
    opts?: { env?: Record<string, string>; cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  destroy(): Promise<void>;
};

/**
 * Get (or create) a sandbox instance by id. The id MUST be unique per
 * attempt (plan Clarify #11): a destroyed sandbox's id must never be reused
 * (attach-after-destroy behavior is unknown = ASSUMPTION; uniqueness wins).
 */
export async function getSandbox(binding: SandboxBinding, id: string): Promise<ReviewSandbox> {
  const sandbox = cfGetSandbox(
    binding as Parameters<typeof cfGetSandbox>[0],
    id,
    { enableDefaultSession: false },
  );
  // The SDK shell runner is string-form only (no argv array), so the sink
  // stays a single string — bound once here: this is the ONE line in the
  // repo that reaches it, and every command arrives as a pre-validated
  // ShellCommand minted by the gitops builders.
  const sdkRun = sandbox.exec.bind(sandbox);
  return {
    async runCommand(command, opts) {
      const result = await sdkRun(command, {
        env: opts?.env,
        cwd: opts?.cwd,
        timeout: opts?.timeout ?? DEFAULT_EXEC_TIMEOUT_MS,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
    async destroy() {
      await sandbox.destroy();
    },
  };
}
