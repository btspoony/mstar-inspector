/**
 * Behaviour tests for the deploy control-flow scripts.
 *
 * The workflows only wire these scripts in; the decisions live here and are
 * executed, not string-matched:
 *   - `scripts/resolve-tenant-mode.sh`: dispatch input → steady-state variable
 *     → off, so a routine release/push cannot silently demote a `strict`
 *     installation.
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

describe("resolve-tenant-mode.sh", () => {
  /** Run with the Actions files wired, so the outputs are read, not assumed. */
  function resolveWithFiles(...args: string[]): { code: number; out: string; err: string; output: string; summary: string } {
    const dir = mkdtempSync(join(tmpdir(), "tenant-mode-"));
    const output = join(dir, "output");
    const summary = join(dir, "summary");
    try {
      writeFileSync(output, "");
      writeFileSync(summary, "");
      const proc = Bun.spawnSync(["bash", join(SCRIPTS, "resolve-tenant-mode.sh"), ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      });
      return {
        code: proc.exitCode,
        out: proc.stdout.toString(),
        err: proc.stderr.toString(),
        output: readFileSync(output, "utf8"),
        summary: readFileSync(summary, "utf8"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a dispatch input wins over the steady-state variable", () => {
    for (const [input, steady, expected] of [
      ["strict", "off", "strict"],
      ["off", "strict", "off"],
    ] as const) {
      const result = resolveWithFiles(input, steady, "false");
      expect(result.code, `${input}|${steady}`).toBe(0);
      expect(result.output, `${input}|${steady}`).toBe(`mode=${expected}\n`);
      // an explicit dispatch is the operator's decision: never a change warning
      expect(result.summary, `${input}|${steady}`).toBe("tenant_mode_change=none\n");
      expect(result.out, `${input}|${steady}`).not.toContain("::warning::");
    }
  });

  test("a routine release/push arm deploys the steady-state mode — strict stays strict", () => {
    const result = resolveWithFiles("", "strict", "true");
    expect(result.code).toBe(0);
    expect(result.output).toBe("mode=strict\n");
    expect(result.summary).toBe("tenant_mode_change=none\n");
    expect(result.out).not.toContain("::warning::");
  });

  test("a routine arm resolving to off cannot prove the live mode: warns and records the change key", () => {
    for (const steady of ["off", ""]) {
      const result = resolveWithFiles("", steady, "true");
      expect(result.code, steady).toBe(0);
      expect(result.output, steady).toBe("mode=off\n");
      expect(result.out, steady).toContain("::warning::");
      expect(result.out, steady).toContain("not observed");
      expect(result.summary, steady).toBe("tenant_mode_change=unproven->off\n");
    }
  });

  test("no input, no steady-state variable, no routine arm (manual local run) is plain off", () => {
    const result = resolveWithFiles("", "", "false");
    expect(result.code).toBe(0);
    expect(result.output).toBe("mode=off\n");
    expect(result.summary).toBe("tenant_mode_change=none\n");
    expect(result.out).not.toContain("::warning::");
  });

  test("an illegal value fails the run before any deploy-capable step", () => {
    for (const args of [
      ["on", "", "false"],
      ["STRICT", "", "false"],
      ["", "  ", "true"],
    ] as const) {
      const result = resolveWithFiles(...args);
      expect(result.code, args.join("|")).toBe(1);
      expect(result.out, args.join("|")).toContain("::error::invalid tenant mode");
      expect(result.output, args.join("|")).toBe(""); // no mode resolved
    }
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

  test("the serving step's outcome gates the deployed verdict (prod publishes it last)", () => {
    // Production creates the serving version in a LATER step than the first
    // `wrangler deploy`, so the first deploy's success alone is not proof.
    for (const serving of ["failure", "skipped", "cancelled", ""]) {
      const result = status("success", SHA_A, SHA_B, serving);
      expect(result.code, serving).toBe(0);
      expect(parseSingleBlock(result.out), serving).toEqual({
        status: "not-deployed",
        lines: ["deploy_status=not-deployed", `requested_sha=${SHA_A}`],
      });
      expect(result.err, serving).toContain("the serving step did not succeed");
    }
    // both deploys landed: the SHA is a real replay source
    const both = status("success", SHA_A, SHA_B, "success");
    expect(both.code).toBe(0);
    expect(parseSingleBlock(both.out)).toEqual({
      status: "deployed",
      lines: ["deploy_status=deployed", `deployed_sha=${SHA_B}`],
    });
  });

  test("staging (no serving step) keeps its single-deploy verdict", () => {
    // Staging passes three arguments only: there, the `wrangler deploy` IS the
    // last version-creating step, so its outcome alone decides.
    const result = status("success", SHA_A, SHA_B);
    expect(result.code).toBe(0);
    expect(parseSingleBlock(result.out)).toEqual({
      status: "deployed",
      lines: ["deploy_status=deployed", `deployed_sha=${SHA_B}`],
    });
  });

  test("MUTATION: dropping the serving guard from the real script is caught by the pinned output", () => {
    // The expectation above is the shipped script's own output, not a check the
    // test invented: remove the guard and the same call reports `deployed`.
    const args = ["success", SHA_A, SHA_B, "failure"];
    const DEPLOYED = `deploy_status=deployed\ndeployed_sha=${SHA_B}\n`;
    expect(status(...args).out).toBe(`deploy_status=not-deployed\nrequested_sha=${SHA_A}\n`);

    const src = readFileSync(join(SCRIPTS, "deploy-status.sh"), "utf8");
    const guardStart = src.indexOf("# Two version-creating steps:");
    const guardEnd = src.indexOf('if [ "$outcome" = "success" ]; then');
    expect(guardStart, "the serving guard is missing from deploy-status.sh").toBeGreaterThan(-1);
    expect(guardEnd).toBeGreaterThan(guardStart);
    const tampered = src.slice(0, guardStart) + src.slice(guardEnd);
    expect(tampered).not.toBe(src);

    const dir = mkdtempSync(join(tmpdir(), "deploy-status-"));
    try {
      const path = join(dir, "deploy-status.sh");
      writeFileSync(path, tampered);
      const result = runBash(path, args);
      expect(result.code).toBe(0);
      expect(result.out).toBe(DEPLOYED); // the pinned expectation no longer holds
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
