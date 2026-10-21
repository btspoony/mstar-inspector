/**
 * Behaviour tests for the deploy control-flow scripts.
 *
 * The workflows only wire these scripts in; the decisions live here and are
 * executed, not string-matched:
 *   - `scripts/deploy-replay-guard.sh`: a `strict` replay must bind Deploy A's
 *     SHA (expected == run == resolved ref, all non-empty); anything else exits 1.
 *   - `scripts/deploy-status.sh`: prints exactly one mutually exclusive status
 *     block, so a failed deploy can never be summarized as deployed.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS = join(import.meta.dir, "..", "..", "scripts");

function runBash(scriptPath: string, args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["bash", scriptPath, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("deploy-replay-guard.sh", () => {
  const guard = (...args: string[]) => runBash(join(SCRIPTS, "deploy-replay-guard.sh"), args);

  test("a non-strict mode always passes (normal deploy, empty input allowed)", () => {
    for (const args of [
      ["off", "", "", ""],
      ["off", SHA_A, SHA_B, SHA_B],
      ["", "", "", ""],
    ]) {
      expect(guard(...args).code, args.join("|")).toBe(0);
    }
  });

  test("strict with all three SHAs equal passes", () => {
    const result = guard("strict", SHA_A, SHA_A, SHA_A);
    expect(result.code).toBe(0);
    expect(result.out).toContain("strict replay bound to");
  });

  test("strict with any empty SHA fails and names the missing input", () => {
    for (const [missing, args] of [
      ["expected_deploy_sha", ["strict", "", SHA_A, SHA_A]],
      ["github_sha", ["strict", SHA_A, "", SHA_A]],
      ["resolved_ref_sha", ["strict", SHA_A, SHA_A, ""]],
    ] as const) {
      const result = guard(...args);
      expect(result.code, missing).toBe(1);
      expect(result.err, missing).toContain("strict replay requires the SHA deployed by Deploy A");
      expect(result.err, missing).toContain(`${missing} is empty`);
      expect(result.out, missing).toBe("");
    }
  });

  test("strict with a mismatched expected SHA fails", () => {
    const result = guard("strict", SHA_B, SHA_A, SHA_A);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`expected_deploy_sha ${SHA_B} != this run's SHA ${SHA_A}`);
  });

  test("strict with a moved ref fails", () => {
    const result = guard("strict", SHA_A, SHA_A, SHA_B);
    expect(result.code).toBe(1);
    expect(result.err).toContain("the ref moved");
  });
});

describe("deploy-status.sh", () => {
  const status = (...args: string[]) => runBash(join(SCRIPTS, "deploy-status.sh"), args);

  /**
   * The invariant every block must satisfy: exactly one `deploy_status=` line,
   * and the two shapes never mix (`deployed_sha` with `not-deployed`, or
   * `requested_sha` with `deployed`).
   */
  function parseSingleBlock(out: string): { status: string; lines: string[] } {
    const lines = out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const statuses = lines.filter((line) => line.startsWith("deploy_status="));
    if (statuses.length !== 1) {
      throw new Error(`expected exactly one deploy_status line, got ${statuses.length}: ${out}`);
    }
    const value = statuses[0]!.slice("deploy_status=".length);
    const hasDeployed = lines.some((line) => line.startsWith("deployed_sha="));
    const hasRequested = lines.some((line) => line.startsWith("requested_sha="));
    if (value === "deployed" && hasRequested) {
      throw new Error(`deployed block also carries requested_sha: ${out}`);
    }
    if (value === "not-deployed" && hasDeployed) {
      throw new Error(`not-deployed block also claims deployed_sha: ${out}`);
    }
    return { status: value, lines };
  }

  test("success emits deploy_status=deployed + deployed_sha only", () => {
    const result = status("success", SHA_A, SHA_B);
    expect(result.code).toBe(0);
    expect(parseSingleBlock(result.out)).toEqual({
      status: "deployed",
      lines: ["deploy_status=deployed", `deployed_sha=${SHA_B}`],
    });
  });

  test("failure / skipped / cancelled emit deploy_status=not-deployed + requested_sha only", () => {
    for (const outcome of ["failure", "skipped", "cancelled", ""]) {
      const result = status(outcome, SHA_A, SHA_B);
      expect(result.code, outcome).toBe(0);
      expect(parseSingleBlock(result.out), outcome).toEqual({
        status: "not-deployed",
        lines: ["deploy_status=not-deployed", `requested_sha=${SHA_A}`],
      });
    }
  });

  test("a success outcome without a SHA exits 2 and emits nothing", () => {
    const result = status("success", SHA_A, "");
    expect(result.code).toBe(2);
    expect(result.out.trim()).toBe("");
    expect(result.err).toContain("no deployed SHA");
  });

  test("MUTATION: a tampered copy that emits both shapes is rejected by the invariant", () => {
    // The exact regression this guards: a summary that claims the deploy
    // succeeded AND that nothing shipped.
    const src = readFileSync(join(SCRIPTS, "deploy-status.sh"), "utf8");
    const tampered = src.replace(
      `  printf 'deploy_status=deployed\\ndeployed_sha=%s\\n' "$deployed"`,
      `  printf 'deploy_status=deployed\\ndeployed_sha=%s\\n' "$deployed"\n  printf 'deploy_status=not-deployed\\nrequested_sha=%s\\n' "$requested"`,
    );
    expect(tampered).not.toBe(src);
    const dir = mkdtempSync(join(tmpdir(), "deploy-status-"));
    try {
      const path = join(dir, "deploy-status.sh");
      writeFileSync(path, tampered);
      const result = runBash(path, ["success", SHA_A, SHA_B]);
      expect(result.code).toBe(0);
      expect(() => parseSingleBlock(result.out)).toThrow(/exactly one deploy_status line/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
