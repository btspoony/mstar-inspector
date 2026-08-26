/**
 * Sandbox adapter unit tests (plan 06 Task 1) — mock the @cloudflare/sandbox
 * SDK boundary (same technique as tests/review/session.test.ts) so the tests
 * are deterministic. Contract under test (plan interface section):
 *   - getSandbox(binding, id) returns a ReviewSandbox whose exec passes the
 *     command string + env/cwd options through to the SDK and maps the
 *     buffered result to { stdout, stderr, exitCode }
 *   - destroy() delegates to the SDK destroy
 *   - the SDK import point is this module only (compass contracts A)
 *
 * The adapter is imported dynamically: its static `@cloudflare/sandbox`
 * import is hoisted above `mock.module` in ESM, and the real dist references
 * the workerd builtin `cloudflare:workers` (unresolvable in Bun's test
 * runner). Dynamic import resolves after the mock is registered.
 */

import { describe, expect, mock, test } from "bun:test";

const execCalls: Array<{ cmd: string; opts?: unknown }> = [];
const destroyCalls: string[] = [];
let execResult: { success: boolean; exitCode: number; stdout: string; stderr: string } = {
  success: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
};
let execError: Error | undefined;
let destroyError: Error | undefined;

mock.module("@cloudflare/sandbox", () => ({
  getSandbox: mock((_ns: unknown, id: string) => ({
    exec: mock(async (cmd: string, opts?: unknown) => {
      execCalls.push({ cmd, opts });
      if (execError) throw execError;
      return execResult;
    }),
    destroy: mock(async () => {
      destroyCalls.push(id);
      if (destroyError) throw destroyError;
    }),
  })),
  Sandbox: class Sandbox {},
}));

const { getSandbox } = await import("../../src/pipeline/sandbox");
import type { ReviewSandbox } from "../../src/pipeline/sandbox";

const binding = {} as never;

describe("getSandbox", () => {
  test("exec passes the command string and env/cwd options through and maps the result", async () => {
    execResult = { success: true, exitCode: 0, stdout: "diff --git a/x b/x\n", stderr: "review mode: structured\n" };
    const sandbox: ReviewSandbox = await getSandbox(binding, "smoke-abc");

    const result = await sandbox.exec("gh pr diff 1 --repo btspoony/todo-bots", {
      env: { GH_TOKEN: "tok" },
      cwd: "/workspace/repo",
    });

    expect(execCalls).toEqual([
      {
        cmd: "gh pr diff 1 --repo btspoony/todo-bots",
        opts: { env: { GH_TOKEN: "tok" }, cwd: "/workspace/repo" },
      },
    ]);
    expect(result).toEqual({ stdout: "diff --git a/x b/x\n", stderr: "review mode: structured\n", exitCode: 0 });
  });

  test("exec without options passes undefined env/cwd", async () => {
    execCalls.length = 0;
    execResult = { success: true, exitCode: 0, stdout: "out", stderr: "" };
    const sandbox: ReviewSandbox = await getSandbox(binding, "smoke-2");

    const result = await sandbox.exec("echo hi");

    expect(execCalls).toEqual([{ cmd: "echo hi", opts: { env: undefined, cwd: undefined } }]);
    expect(result).toEqual({ stdout: "out", stderr: "", exitCode: 0 });
  });

  test("exec propagates SDK errors (caller decides retry/DLQ)", async () => {
    execError = new Error("container unavailable");
    const sandbox: ReviewSandbox = await getSandbox(binding, "smoke-3");

    await expect(sandbox.exec("gh pr diff 1")).rejects.toThrow("container unavailable");
    execError = undefined;
  });

  test("destroy delegates to the SDK destroy for the same sandbox id", async () => {
    destroyCalls.length = 0;
    const sandbox: ReviewSandbox = await getSandbox(binding, "smoke-4");

    await sandbox.destroy();

    expect(destroyCalls).toEqual(["smoke-4"]);
  });

  test("destroy propagates SDK errors (evidence for the Verdict, not silent)", async () => {
    destroyError = new Error("teardown hung");
    const sandbox: ReviewSandbox = await getSandbox(binding, "smoke-5");

    await expect(sandbox.destroy()).rejects.toThrow("teardown hung");
    destroyError = undefined;
  });
});
