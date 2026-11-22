#!/usr/bin/env bun
/**
 * note: pr-verdict.ts — decide whether a refresh run may publish.
 *
 *   bun run scripts/provider-catalog/pr-verdict.ts \
 *     --typecheck success --test failure --log "${RUNNER_TEMP}/test.log"
 *
 * A refresh run publishes a pull request ONLY when the tree it publishes has
 * passed typecheck and the test suite. This module is the one place that decides
 * it, and it is a GATE: a non-zero exit means the workflow stops before any
 * commit, push or PR. A channel that periodically publishes red PRs teaches
 * everyone to ignore the red, so there is no "label it red and ship" path.
 *
 * Two signals, because one of them is exactly the thing that broke once: the
 * step outcome, and the log. A pipeline that lost the exit status (`bun test |
 * tee` under `bash -e`, no `pipefail`) reports `success`; a log recording a
 * non-zero `N fail` count still refuses publication. That was round 1's bug, and
 * the log witness is what proves it cannot come back silently.
 */
import { readFile } from "node:fs/promises";

export type Verification = { green: boolean; reason: string };

/** The `N pass` count bun prints, when the log has one. */
export function passCount(log: string): string {
  const matches = [...log.matchAll(/(\d+) pass/g)];
  return matches.length === 0 ? "unknown" : matches.at(-1)![1]!;
}

/** The highest `N fail` count the log records (0 when it records none). */
export function failCount(log: string): number {
  return [...log.matchAll(/^ *(\d+) fail$/gm)].reduce((max, match) => Math.max(max, Number(match[1])), 0);
}

/**
 * Whether this run may publish. `testOutcome` is the STEP's outcome, so a step
 * that lost its exit status reports `success`; `log` is the second, independent
 * witness. Any failure — from either — refuses publication.
 */
export function verdict(typecheckOutcome: string, testOutcome: string, log: string): Verification {
  if (typecheckOutcome !== "success") return { green: false, reason: `typecheck ${typecheckOutcome}` };
  const failed = failCount(log);
  if (failed > 0) return { green: false, reason: `the test log records ${failed} failure(s)` };
  if (testOutcome !== "success") return { green: false, reason: `tests ${testOutcome}` };
  return { green: true, reason: `${passCount(log)} tests passed` };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const index = args.indexOf(`--${name}`);
    const value = index === -1 ? undefined : args[index + 1];
    if (value === undefined) throw new Error(`--${name} is required`);
    return value;
  };
  const log = await readFile(flag("log"), "utf8").catch(() => "");
  const result = verdict(flag("typecheck"), flag("test"), log);
  console.log(result.green ? `green — ${result.reason}` : `RED — ${result.reason}`);
  // safety: a red run must abort the job, so nothing is published.
  if (!result.green) process.exit(1);
}
