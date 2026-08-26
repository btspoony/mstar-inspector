/**
 * GitOps command construction (plan 06 Task 3) — pure command builders for the
 * sandbox exec steps. Trusted orchestration: the consumer runs these commands
 * inside the sandbox with GH_TOKEN injected via exec env (never in the command
 * string, never in the image, never in logs — compass contracts D). The
 * interpolated fields (owner/repo/pr number/sha) come from the verified
 * webhook payload, not from untrusted free text.
 *
 * Every payload-derived field is validated against a strict allowlist and
 * single-quoted before interpolation (plan QC 06 fix round 1 / qc2 F-001):
 * owner/repo are GitHub name chars ([A-Za-z0-9._-]), headSha is hex (40–64
 * chars), prNumber is a positive integer. Anything else fails closed with a
 * descriptive error BEFORE a shell string is built — a metacharacter (`;`,
 * space, backtick, `$(...)`, `'`) can never reach `sh -c`.
 *
 * Primary diff path is `gh pr diff` (T1 falsified: GH_TOKEN env injection
 * works, non-empty diff, exit 0). The clone step exists so the in-image
 * runner's session cwd is the PR head checkout (the model reads repo files).
 */

export type GitOpsInput = {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  cloneDir: string;
  diffPath: string;
  runnerPath: string;
};

export type GitOpsCommands = {
  /** Shallow clone of the PR head sha into cloneDir. */
  clone: string;
  /** Write the PR unified diff to diffPath via gh. */
  diff: string;
  /** Run the in-image review runner against diffPath. */
  runner: string;
};

/** GitHub name charset (owner/repo) — matches signed webhook payload reality. */
const GITHUB_NAME_RE = /^[A-Za-z0-9._-]+$/;
/** Git object id: 40-char SHA-1 or 64-char SHA-256, lowercase hex. */
const HEAD_SHA_RE = /^[0-9a-f]{40,64}$/;

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

function assertHeadSha(headSha: string): void {
  assertShellSafe(headSha, HEAD_SHA_RE, "headSha");
}

/**
 * Resolve the PR head sha via gh (used when the queue payload sha is null —
 * e.g. `/review` commands). stdout is the bare sha (gh --jq .headRefOid).
 */
export function resolveHeadShaCommand(owner: string, repo: string, prNumber: number): string {
  assertOwnerRepo(owner, repo);
  assertPrNumber(prNumber);
  return `gh pr view '${prNumber}' --repo '${owner}/${repo}' --json headRefOid --jq .headRefOid`;
}

/**
 * Shallow clone of the exact head sha. `git clone --branch <sha>` does not
 * accept a sha, so the clone is init + fetch of the pinned commit (GitHub
 * serves arbitrary reachable shas for public repos) + checkout FETCH_HEAD.
 */
export function cloneCommand(owner: string, repo: string, headSha: string, cloneDir: string): string {
  assertOwnerRepo(owner, repo);
  assertHeadSha(headSha);
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  return [
    `rm -rf '${cloneDir}'`,
    `git init '${cloneDir}'`,
    `cd '${cloneDir}'`,
    `git remote add origin '${repoUrl}'`,
    `git fetch --depth 1 origin '${headSha}'`,
    `git checkout FETCH_HEAD`,
  ].join(" && ");
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

/** All main-flow commands in execution order (clone → diff → runner). */
export function buildGitOpsCommands(input: GitOpsInput): GitOpsCommands {
  return {
    clone: cloneCommand(input.owner, input.repo, input.headSha, input.cloneDir),
    diff: diffCommand(input.owner, input.repo, input.prNumber, input.diffPath),
    runner: runnerCommand(input.runnerPath, input.diffPath),
  };
}
