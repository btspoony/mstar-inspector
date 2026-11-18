#!/usr/bin/env bun
/**
 * pr-verdict.ts — turn the refresh run's verification outcomes into the PR's
 * red/green marks.
 *
 *   bun run scripts/provider-catalog/pr-verdict.ts \
 *     --typecheck success --test failure --log "${RUNNER_TEMP}/test.log" \
 *     --github-output "${GITHUB_OUTPUT}"
 *
 * This is the ONE place that decides whether the refresh PR claims green. It is
 * a script rather than inline shell because the claim must be provable: a
 * pipeline whose exit status is `tee`'s, or a `steps.*.outcome` read under the
 * wrong condition, silently reports success for a failed suite — and that is
 * the one failure mode the workflow exists to prevent. A unit test feeds this
 * every outcome combination, including a failing log with a green outcome.
 */
import { appendFile, readFile } from "node:fs/promises";

export type VerificationMarks = {
  /** Markdown bullets for the PR body's verification section. */
  lines: string[];
  /** True when either check failed — the PR title and body must say so. */
  red: boolean;
};

/** The `N pass` count bun prints, when the log has one. */
export function passCount(log: string): string {
  const matches = [...log.matchAll(/(\d+) pass/g)];
  return matches.length === 0 ? "unknown" : matches.at(-1)![1]!;
}

/**
 * The marks for one run. `testOutcome` is the STEP's outcome, so a test step
 * that loses its exit status (`bun test | tee`, no `pipefail`) reports
 * `success`; `log` is read as the second, independent witness — a log with
 * `N fail` non-zero overrides a green outcome and turns the body red. Two
 * signals, because one of them is exactly the thing that breaks.
 */
export function verificationMarks(
  typecheckOutcome: string,
  testOutcome: string,
  log: string,
): VerificationMarks {
  const failed = [...log.matchAll(/^ *(\d+) fail$/gm)].reduce((max, match) => Math.max(max, Number(match[1])), 0);
  const testGreen = testOutcome === "success" && failed === 0;
  const lines = [
    typecheckOutcome === "success" ? "- ✅ typecheck" : "- ❌ typecheck FAILED",
    testGreen ? `- ✅ bun test tests (${passCount(log)})` : `- ❌ bun test tests FAILED (${passCount(log)})`,
  ];
  return { lines, red: typecheckOutcome !== "success" || !testGreen };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const index = args.indexOf(`--${name}`);
    if (index === -1 || args[index + 1] === undefined) throw new Error(`--${name} is required`);
    return args[index + 1]!;
  };
  const log = await readFile(flag("log"), "utf8").catch(() => "");
  const marks = verificationMarks(flag("typecheck"), flag("test"), log);
  console.log(marks.lines.join("\n"));
  await appendFile(flag("github-output"), `red=${marks.red}\n`);
}
