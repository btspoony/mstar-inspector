/**
 * GitOps command construction — pure command builders for the
 * sandbox exec steps. Trusted orchestration: the consumer runs these commands
 * inside the sandbox with credentials injected via exec env (never in the
 * command string, never in the image, never in logs — compass contracts D).
 * The interpolated fields (owner/repo/pr number/clone dir) come from the
 * verified webhook payload, not from untrusted free text.
 *
 * Payload-derived fields (owner/repo/prNumber) are validated against a
 * strict allowlist and single-quoted before interpolation (qc2 F-001):
 * owner/repo are GitHub name chars
 * ([A-Za-z0-9._-]), prNumber is a positive integer. The in-image path
 * fields (clone/diff/runner/input) are NOT payload-derived — they are
 * fixed constants supplied by the consumer (verified against qc2 F-006);
 * they are still single-quoted. Anything else fails closed with a
 * descriptive error BEFORE a shell string is built — a metacharacter
 * (`;`, space, backtick, `$(...)`, `'`) can never reach `sh -c`.
 *
 * Primary diff path is `gh pr diff` (falsified: GH_TOKEN env injection
 * works, non-empty diff, exit 0). The clone step exists so the in-image
 * runner's session cwd is the PR head checkout (the model reads repo files).
 *
 * Sha consistency (bugbot A2): the clone checks out the LIVE PR head
 * (`pull/<n>/head`, the same commit `gh pr diff` reads), then the consumer
 * reads the checked-out sha back with `git rev-parse HEAD` and keys the
 * idempotency/D1/KV/commit_id off THAT sha. The diff, the clone files and
 * the posted commit_id therefore always describe the same commit — a
 * force-push between webhook delivery and processing is captured by the
 * rev-parse instead of drifting silently.
 */

import type { ReviewLevel } from "../review/runtime";
import { RECHECK_FILE_MAX_BYTES } from "../contracts/recheck";
import { shellCommand, type ShellCommand } from "./shell-command";

export type GitOpsInput = {
  owner: string;
  repo: string;
  prNumber: number;
  cloneDir: string;
  diffPath: string;
  runnerPath: string;
  /** Review tier for the runner CLI `--level` (port-validated upstream). */
  level: ReviewLevel;
  /** In-image path of the runner `--input` JSON file (reconFacts carrier). */
  inputPath: string;
};

export type GitOpsCommands = {
  /** Shallow clone of the PR head branch into cloneDir. */
  clone: ShellCommand;
  /** Read the sha of the checked-out HEAD (authoritative review sha). */
  checkedOutSha: ShellCommand;
  /** Write the PR unified diff to diffPath via gh. */
  diff: ShellCommand;
  /** Numstat of the PR diff — the runner's seat-partition universe. */
  numstat: ShellCommand;
  /** Run the in-image review runner (`--level`/`--input` reconFacts JSON). */
  runner: ShellCommand;
};

/** GitHub name charset (owner/repo) — matches signed webhook payload reality. */
const GITHUB_NAME_RE = /^[A-Za-z0-9._-]+$/;

function assertShellSafe(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new Error(`unsafe ${label} for shell interpolation: ${JSON.stringify(value)}`);
  }
}

function assertOwnerRepo(owner: string, repo: string): void {
  assertShellSafe(owner, GITHUB_NAME_RE, "owner");
  assertShellSafe(repo, GITHUB_NAME_RE, "repo");
}

function assertPrNumber(prNumber: number): void {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`unsafe prNumber for shell interpolation: ${JSON.stringify(prNumber)}`);
  }
}

/**
 * Shallow clone of the PR head branch. `gh pr diff` reads the LIVE PR head,
 * so the checkout must match the diff: fetch the `pull/<n>/head` ref (GitHub
 * serves it for every open PR) and detach at FETCH_HEAD. The authoritative
 * sha is read back with checkedOutShaCommand AFTER the clone (bugbot A2).
 * Private-repo transport auth is injected by the consumer via scoped git
 * env config (http.https://github.com/.extraheader) — never in the string.
 */
export function cloneCommand(owner: string, repo: string, prNumber: number, cloneDir: string): ShellCommand {
  assertOwnerRepo(owner, repo);
  assertPrNumber(prNumber);
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  return shellCommand(
    [
      `rm -rf '${cloneDir}'`,
      `git init '${cloneDir}'`,
      `cd '${cloneDir}'`,
      `git remote add origin '${repoUrl}'`,
      `git fetch --depth 1 origin 'pull/${prNumber}/head'`,
      `git checkout FETCH_HEAD`,
    ].join(" && "),
  );
}

/**
 * Read the sha of the checked-out HEAD — the authoritative review sha. The
 * consumer keys the idempotency check, the D1 row, the posted commit_id and
 * the KV completion state off it (bugbot A2: diff/files/commit_id always
 * describe the same commit; a force-push mid-flight is captured here).
 */
export function checkedOutShaCommand(cloneDir: string): ShellCommand {
  return shellCommand(`git -C '${cloneDir}' rev-parse HEAD`);
}

/** Write the PR unified diff to diffPath via gh (primary path, falsified). */
export function diffCommand(owner: string, repo: string, prNumber: number, diffPath: string): ShellCommand {
  assertOwnerRepo(owner, repo);
  assertPrNumber(prNumber);
  return shellCommand(`gh pr diff '${prNumber}' --repo '${owner}/${repo}' > '${diffPath}'`);
}

/**
 * Numstat lines (`"<add>\t<del>\t<path>"`) of the PR diff without applying it
 * (`git apply --numstat` reads a unified diff from any cwd). These lines are
 * the runner's seat-partition universe (reconFacts convention).
 */
export function numstatCommand(diffPath: string): ShellCommand {
  return shellCommand(`git apply --numstat '${diffPath}'`);
}

/**
 * Write a JSON document to an in-image path (the runner `--input` file). The
 * caller base64-encodes the content; `base64 -d` decodes it in-container, so
 * arbitrary JSON (quotes, unicode, tabs, newlines) never touches shell
 * interpolation. The base64 payload itself is allowlist-validated.
 */
export function writeJsonCommand(path: string, contentBase64: string): ShellCommand {
  assertShellSafe(contentBase64, /^[A-Za-z0-9+/]+={0,2}$/, "base64 content");
  return shellCommand(`printf '%s' '${contentBase64}' | base64 -d > '${path}'`);
}

/**
 * Run the in-image review runner on the runtime envelope path:
 * `--level` is the review tier, `--input` the reconFacts JSON file. stdout
 * carries ONLY the validated mstar.review/v1 envelope; exit 0 = success
 * (there is no summary-degrade mode on this path). `recheckOutPath` is the
 * optional `--recheck-out` target — passed through verbatim when
 * provided (the consumer reads that file back through readRecheckCommand).
 */
export function runnerCommand(
  runnerPath: string,
  level: ReviewLevel,
  inputPath: string,
  recheckOutPath?: string,
): ShellCommand {
  const base = `bun run '${runnerPath}' --level '${level}' --input '${inputPath}'`;
  return shellCommand(recheckOutPath !== undefined ? `${base} --recheck-out '${recheckOutPath}'` : base);
}

/**
 * Bounded read of the runner's recheck output file (spec §7.8):
 * the Worker consumes the seat's validated document through THIS audited
 * command — never an arbitrary model-produced path. Output contract (the exact
 * bytes the consumer parses and its double mirrors): the first
 * RECHECK_FILE_MAX_BYTES (262,144) bytes of the file (`head -c` stops the
 * stream at the bound), a `\n` separator written by `printf`, then the overflow
 * probe's byte count — `wc -c` output, which is ITSELF newline-terminated. So
 * a real run ends `<content>\n0\n` (fit) or `<content>\n1\n` (a byte exists
 * BEYOND the bound: tail probes byte bound+1 → treat the read as invalid).
 * A missing/unreadable file fails the `head` chain (non-zero exit, empty
 * stdout) — the consumer fails closed either way (invalid → no recheck).
 * The path is allowlisted and single-quoted like every builder here; the
 * consumer passes the same fixed constant the runner flag wrote
 * (RECHECK_OUTPUT_PATH).
 */
export function readRecheckCommand(path: string): ShellCommand {
  assertShellSafe(path, /^\/[A-Za-z0-9._/-]+$/, "recheck output path");
  return shellCommand(
    `head -c '${RECHECK_FILE_MAX_BYTES}' '${path}' && printf '\\n' && ` +
      `tail -c '+${RECHECK_FILE_MAX_BYTES + 1}' '${path}' | head -c '1' | wc -c`,
  );
}

/** Main-flow commands in execution order (clone → sha → diff → numstat → runner). */
export function buildGitOpsCommands(input: GitOpsInput): GitOpsCommands {
  return {
    clone: cloneCommand(input.owner, input.repo, input.prNumber, input.cloneDir),
    checkedOutSha: checkedOutShaCommand(input.cloneDir),
    diff: diffCommand(input.owner, input.repo, input.prNumber, input.diffPath),
    numstat: numstatCommand(input.diffPath),
    runner: runnerCommand(input.runnerPath, input.level, input.inputPath),
  };
}
