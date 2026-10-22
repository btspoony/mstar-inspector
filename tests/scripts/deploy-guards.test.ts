/**
 * Behaviour tests for the deploy control-flow script.
 *
 * The workflows only wire the script in; the decision lives here and is
 * executed, not string-matched:
 *   - `scripts/deploy-status.sh`: prints exactly one mutually exclusive status
 *     block, so a failed deploy can never be summarized as deployed.
 *
 * The tenant-mode resolver and the replay guard it fed are deleted with the
 * tenant read switch: there is one deployment, so there is nothing to replay
 * and no mode to resolve.
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
    // both deploys landed: the SHA is what this run shipped
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

