/**
 * Sandbox thin adapter (plan 06 Task 1, STOP gate) — the ONLY module in the
 * repo that imports `@cloudflare/sandbox` (compass contracts A / plan Global
 * Constraints). Wraps the SDK behind the locked `ReviewSandbox` contract so
 * the consumer (T3) and the smoke (T1) never touch the SDK surface directly.
 *
 * Verified SDK surface (@cloudflare/sandbox 0.12.8, dist types + live smoke):
 *   - getSandbox(ns: DurableObjectNamespace<Sandbox>, id, options?) -> Sandbox
 *     (sync; container starts lazily on first operation)
 *   - Sandbox.exec(command: string, options?: ExecOptions) -> Promise<ExecResult>
 *     ExecOptions: { env?: Record<string, string | undefined>, cwd?: string,
 *     timeout?: number, ... } — per-command env/cwd, buffered result
 *   - Sandbox.destroy() -> Promise<void> (terminates container, deletes state)
 *
 * `enableDefaultSession: false` (lifecycle docs recommendation): each exec
 * runs in isolation — no shell state carries between calls. The consumer
 * passes cwd/env per exec, so no session state is needed.
 *
 * The binding is typed `unknown` per the plan contract
 * (`PipelineEnv.SANDBOX: unknown` — the binding shape is pinned at T1 and
 * cast here). The SDK's own `DurableObjectNamespace` type is ambient
 * (capnweb) and does not satisfy @cloudflare/workers-types' branded
 * constraint, so the cast is the single, documented boundary.
 */

import { getSandbox as cfGetSandbox, type Sandbox } from "@cloudflare/sandbox";

/** Re-export for Durable Object registration from the Worker entry point. */
export { Sandbox } from "@cloudflare/sandbox";

/** The Worker binding shape (pinned at T1; plan `PipelineEnv.SANDBOX`). */
export type SandboxBinding = unknown;

/** Locked contract (plan interface section / compass contracts B). */
export type ReviewSandbox = {
  exec(
    cmd: string,
    opts?: { env?: Record<string, string>; cwd?: string },
  ): Promise<{ stdout: string; exitCode: number }>;
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
  return {
    async exec(cmd, opts) {
      const result = await sandbox.exec(cmd, { env: opts?.env, cwd: opts?.cwd });
      return { stdout: result.stdout, exitCode: result.exitCode };
    },
    async destroy() {
      await sandbox.destroy();
    },
  };
}
