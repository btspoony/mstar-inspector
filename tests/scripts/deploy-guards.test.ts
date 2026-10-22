/**
 * Behaviour tests for the deploy control-flow scripts.
 *
 * The workflows only wire these scripts in; the decisions live here and are
 * executed, not string-matched:
 *   - `scripts/resolve-tenant-mode.sh`: an explicit dispatch input → the
 *     steady-state variable → off (`steady`, the dispatch default, and an empty
 *     non-dispatch value both mean "take the variable"), so a routine
 *     release/push cannot silently demote a `strict` installation.
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

  test("replay=none never binds and never reads the SHAs — unless a Deploy-A SHA is supplied", () => {
    for (const args of [
      ["none", "", "", ""],
      ["none", "", SHA_A, SHA_A],
      ["off", "", "", ""],
      ["", "", "", ""],
    ]) {
      expect(guard(...args).code, args.join("|")).toBe(0);
    }
    // A SHA on a non-replay run asks for a binding the run does not enforce
    // (I-000089): refused, never silently discarded — `steady` may serve
    // `strict`, so the ignored SHA would look like a completed Deploy B.
    for (const replay of ["none", "off", ""]) {
      const result = guard(replay, SHA_A, SHA_A, SHA_A);
      expect(result.code, replay).toBe(1);
      expect(result.err, replay).toContain(`expected_deploy_sha ${SHA_A} was supplied but this run is not a strict replay`);
      expect(result.err, replay).toContain("re-dispatch with -f tenant_mode=strict");
      expect(result.out, replay).toBe("");
    }
  });

  test("replay=required with all three SHAs equal passes", () => {
    const result = guard("required", SHA_A, SHA_A, SHA_A);
    expect(result.code).toBe(0);
    expect(result.out).toContain("strict replay bound to");
  });

  test("replay=required with any empty SHA fails and names the missing input", () => {
    for (const [missing, args] of [
      ["expected_deploy_sha", ["required", "", SHA_A, SHA_A]],
      ["github_sha", ["required", SHA_A, "", SHA_A]],
      ["resolved_ref_sha", ["required", SHA_A, SHA_A, ""]],
    ] as const) {
      const result = guard(...args);
      expect(result.code, missing).toBe(1);
      expect(result.err, missing).toContain("strict replay requires the SHA deployed by Deploy A");
      expect(result.err, missing).toContain(`${missing} is empty`);
      expect(result.out, missing).toBe("");
    }
  });

  test("replay=required with a mismatched expected SHA fails", () => {
    const result = guard("required", SHA_B, SHA_A, SHA_A);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`expected_deploy_sha ${SHA_B} != this run's SHA ${SHA_A}`);
  });

  test("replay=required with a moved ref fails", () => {
    const result = guard("required", SHA_A, SHA_A, SHA_B);
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

  test("an EXPLICIT dispatch input wins over the steady-state variable", () => {
    for (const [input, steady, expected] of [
      ["strict", "off", "strict"],
      ["off", "strict", "off"],
    ] as const) {
      const result = resolveWithFiles(input, steady);
      expect(result.code, `${input}|${steady}`).toBe(0);
      expect(result.output, `${input}|${steady}`).toBe(
        `mode=${expected}\nreplay=${expected === "strict" ? "required" : "none"}\n`,
      );
      // an explicit dispatch is the operator's decision: never a change warning
      expect(result.summary, `${input}|${steady}`).toBe("tenant_mode_change=none\n");
      expect(result.out, `${input}|${steady}`).not.toContain("::warning::");
    }
  });

  test("steady (the default) takes the steady-state variable — strict stays strict, no warning", () => {
    for (const input of ["steady", ""]) {
      const result = resolveWithFiles(input, "strict");
      expect(result.code, input).toBe(0);
      expect(result.output, input).toBe("mode=strict\nreplay=none\n");
      expect(result.summary, input).toBe("tenant_mode_change=none\n");
      expect(result.out, input).not.toContain("::warning::");
    }
  });

  test("steady resolving to off cannot prove the live mode: warns and records the change key", () => {
    for (const input of ["steady", ""]) {
      for (const steady of ["off", ""]) {
        const result = resolveWithFiles(input, steady);
        expect(result.code, `${input}|${steady}`).toBe(0);
        expect(result.output, `${input}|${steady}`).toBe("mode=off\nreplay=none\n");
        expect(result.out, `${input}|${steady}`).toContain("::warning::");
        expect(result.out, `${input}|${steady}`).toContain("not observed");
        expect(result.summary, `${input}|${steady}`).toBe("tenant_mode_change=unproven->off\n");
      }
    }
  });

  test("an illegal value fails the run before any deploy-capable step", () => {
    for (const args of [
      ["on", ""],
      ["STRICT", ""],
      ["steady", "  "],
    ] as const) {
      const result = resolveWithFiles(...args);
      expect(result.code, args.join("|")).toBe(1);
      expect(result.out, args.join("|")).toContain("::error::invalid tenant mode");
      expect(result.output, args.join("|")).toBe(""); // no mode resolved
    }
  });

  test("COMPOSED: the resolver's replay output into the guard decides every real case", () => {
    // The wiring both workflows use: resolve the mode, then feed `replay` into
    // deploy-replay-guard.sh. Nothing here restates either decision.
    const decide = (
      input: string,
      steady: string,
      expectedSha: string,
      runSha: string,
      refSha: string,
    ): { mode: string; replay: string; code: number; err: string } => {
      const resolved = resolveWithFiles(input, steady);
      const replay = /^replay=(.*)$/m.exec(resolved.output)?.[1] ?? "";
      const mode = /^mode=(.*)$/m.exec(resolved.output)?.[1] ?? "";
      const guarded = runBash(join(SCRIPTS, "deploy-replay-guard.sh"), [replay, expectedSha, runSha, refSha]);
      return { mode, replay, code: guarded.code, err: guarded.err };
    };

    // 1. steady + variable strict, no Deploy-A SHA: deploys strict and is NOT
    //    refused (the L2 regression).
    const steady = decide("steady", "strict", "", SHA_A, SHA_A);
    expect(steady.mode).toBe("strict");
    expect(steady.replay).toBe("none");
    expect(steady.code).toBe(0);

    // 2. DISPATCH strict without the expected SHA: refused, never fabricated.
    const noBinding = decide("strict", "", "", SHA_A, SHA_A);
    expect(noBinding.mode).toBe("strict");
    expect(noBinding.replay).toBe("required");
    expect(noBinding.code).toBe(1);
    expect(noBinding.err).toContain("expected_deploy_sha is empty");

    // 3. DISPATCH strict with the matching SHA: the real Deploy B replay.
    const replayRun = decide("strict", "", SHA_A, SHA_A, SHA_A);
    expect(replayRun.replay).toBe("required");
    expect(replayRun.code).toBe(0);

    // 4. A dispatch `off` is no replay at all (the rollback door).
    const rollback = decide("off", "strict", "", SHA_A, SHA_A);
    expect(rollback.mode).toBe("off");
    expect(rollback.replay).toBe("none");
    expect(rollback.code).toBe(0);

    // 5. steady with the variable unset stays a plain non-replay deploy.
    const steadyOff = decide("steady", "", "", SHA_A, SHA_A);
    expect(steadyOff.mode).toBe("off");
    expect(steadyOff.replay).toBe("none");
    expect(steadyOff.code).toBe(0);

    // 6. A MOVED ref still reds on the replay path: expected == run, but the ref
    //    resolves to a different commit (the tag/branch moved between A and B).
    const movedReplay = decide("strict", "", SHA_A, SHA_A, SHA_B);
    expect(movedReplay.replay).toBe("required");
    expect(movedReplay.code).toBe(1);
    expect(movedReplay.err).toContain("the ref moved");

    // 7. …and a moved ref reds on the steady-state path too: replay=none skips
    //    the expected-SHA binding, never the ref identity assertion.
    const movedSteady = decide("steady", "strict", "", SHA_A, SHA_B);
    expect(movedSteady.replay).toBe("none");
    expect(movedSteady.code).toBe(1);
    expect(movedSteady.err).toContain("the ref moved");
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
