/**
 * GitOps command construction (plan 06 Task 3) — pure command builders for the
 * sandbox exec steps. Trusted orchestration: the consumer runs these commands
 * inside the sandbox with credentials injected via exec env (never in the
 * command string, never in the image, never in logs — compass contracts D).
 * The interpolated fields (owner/repo/pr number/clone dir) come from the
 * verified webhook payload, not from untrusted free text.
 *
 * Every payload-derived field is validated against a strict allowlist and
 * single-quoted before interpolation (plan QC 06 fix round 1 / qc2 F-001):
 * owner/repo are GitHub name chars ([A-Za-z0-9._-]), prNumber is a positive
 * integer, clone/diff/runner paths are fixed in-image constants. Anything
 * else fails closed with a descriptive error BEFORE a shell string is built
 * — a metacharacter (`;`, space, backtick, `$(...)`, `'`) can never reach
 * `sh -c`.
 *
 * Primary diff path is `gh pr diff` (T1 falsified: GH_TOKEN env injection
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

export type GitOpsInput = {
  owner: string;
  repo: string;
  prNumber: number;
  cloneDir: string;
  diffPath: string;
  runnerPath: string;
};

export type GitOpsCommands = {
  /** Shallow clone of the PR head branch into cloneDir. */
  clone: string;
  /** Read the sha of the checked-out HEAD (authoritative review sha). */
  checkedOutSha: string;
  /** Write the PR unified diff to diffPath via gh. */
  diff: string;
  /** Run the in-image review runner against diffPath. */
  runner: string;
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
export function cloneCommand(owner: string, repo: string, prNumber: number, cloneDir: string): string {
  assertOwnerRepo(owner, repo);
  assertPrNumber(prNumber);
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  return [
    `rm -rf '${cloneDir}'`,
    `git init '${cloneDir}'`,
    `cd '${cloneDir}'`,
    `git remote add origin '${repoUrl}'`,
    `git fetch --depth 1 origin 'pull/${prNumber}/head'`,
    `git checkout FETCH_HEAD`,
  ].join(" && ");
}

/**
 * Read the sha of the checked-out HEAD — the authoritative review sha. The
 * consumer keys the idempotency check, the D1 row, the posted commit_id and
 * the KV completion state off it (bugbot A2: diff/files/commit_id always
 * describe the same commit; a force-push mid-flight is captured here).
 */
export function checkedOutShaCommand(cloneDir: string): string {
  return `git -C '${cloneDir}' rev-parse HEAD`;
}

/** Write the PR unified diff to diffPath via gh (primary path, T1-falsified). */
export function diffCommand(owner: string, repo: string, prNumber: number, diffPath: string): string {
  assertOwnerRepo(owner, repo);
  assertPrNumber(prNumber);
  return `gh pr diff '${prNumber}' --repo '${owner}/${repo}' > '${diffPath}'`;
}

/** Run the in-image review runner against the diff file (stdout = ReviewOutput JSON). */
export function runnerCommand(runnerPath: string, diffPath: string): string {
  return `bun run '${runnerPath}' --diff '${diffPath}'`;
}

/** All main-flow commands in execution order (clone → sha → diff → runner). */
export function buildGitOpsCommands(input: GitOpsInput): GitOpsCommands {
  return {
    clone: cloneCommand(input.owner, input.repo, input.prNumber, input.cloneDir),
    checkedOutSha: checkedOutShaCommand(input.cloneDir),
    diff: diffCommand(input.owner, input.repo, input.prNumber, input.diffPath),
    runner: runnerCommand(input.runnerPath, input.diffPath),
  };
}
