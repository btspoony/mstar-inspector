/**
 * GitOps command construction (plan 06 Task 3) — pure command builders for the
 * sandbox exec steps. Trusted orchestration: the consumer runs these commands
 * inside the sandbox with GH_TOKEN injected via exec env (never in the command
 * string, never in the image, never in logs — compass contracts D). The
 * interpolated fields (owner/repo/pr number/sha) come from the verified
 * webhook payload, not from untrusted free text.
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

/**
 * Resolve the PR head sha via gh (used when the queue payload sha is null —
 * e.g. `/review` commands). stdout is the bare sha (gh --jq .headRefOid).
 */
export function resolveHeadShaCommand(owner: string, repo: string, prNumber: number): string {
  return `gh pr view ${prNumber} --repo ${owner}/${repo} --json headRefOid --jq .headRefOid`;
}

/**
 * Shallow clone of the exact head sha. `git clone --branch <sha>` does not
 * accept a sha, so the clone is init + fetch of the pinned commit (GitHub
 * serves arbitrary reachable shas for public repos) + checkout FETCH_HEAD.
 */
export function cloneCommand(owner: string, repo: string, headSha: string, cloneDir: string): string {
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  return [
    `rm -rf ${cloneDir}`,
    `git init ${cloneDir}`,
    `cd ${cloneDir}`,
    `git remote add origin ${repoUrl}`,
    `git fetch --depth 1 origin ${headSha}`,
    `git checkout FETCH_HEAD`,
  ].join(" && ");
}

/** Write the PR unified diff to diffPath via gh (primary path, T1-falsified). */
export function diffCommand(owner: string, repo: string, prNumber: number, diffPath: string): string {
  return `gh pr diff ${prNumber} --repo ${owner}/${repo} > ${diffPath}`;
}

/** Run the in-image review runner against the diff file (stdout = ReviewOutput JSON). */
export function runnerCommand(runnerPath: string, diffPath: string): string {
  return `bun run ${runnerPath} --diff ${diffPath}`;
}

/** All main-flow commands in execution order (clone → diff → runner). */
export function buildGitOpsCommands(input: GitOpsInput): GitOpsCommands {
  return {
    clone: cloneCommand(input.owner, input.repo, input.headSha, input.cloneDir),
    diff: diffCommand(input.owner, input.repo, input.prNumber, input.diffPath),
    runner: runnerCommand(input.runnerPath, input.diffPath),
  };
}
