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
 * they are still single-quoted, and every bounded read additionally
 * allowlists its absolute in-image path in the shared builder. Anything else
 * fails closed with a descriptive error BEFORE a shell string is built — a
 * metacharacter (`;`, space, backtick, `$(...)`, `'`) can never reach `sh -c`.
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

import type { ReviewLevel } from "../../packages/shared/src/runtime";
import { RECHECK_FILE_MAX_BYTES, RECHECK_STATUS_PATH } from "../../packages/shared/src/recheck-wire";
import { REPORT_FILE_MAX_BYTES, REPORT_OUTPUT_PATH } from "../../packages/shared/src/report-wire";
import { shellCommand, type ShellCommand } from "./shell-command";

export type GitOpsInput = {
  owner: string;
  repo: string;
  prNumber: number;
  cloneDir: string;
  diffPath: string;
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
};

/**
 * The in-image layout every review run execs against. They live HERE so the
 * Step 1–8 commands have ONE source: the consumer passes these paths into the
 * builders, and the sandbox double in the consumer suites derives its
 * expected commands from the same builders (a re-typed literal on either side
 * would turn a real contract assertion into a lockstep edit).
 */
export const CLONE_DIR = "/workspace/repo";
export const DIFF_PATH = "/workspace/pr.diff";
export const RUNNER_INPUT_PATH = "/workspace/review-input.json";
export const RUNNER_PATH = "/opt/runner/packages/runner/src/runner.ts";

/**
 * Cap on the PR diff text the Worker materializes (qc3 F-101): 2 MiB. Beyond
 * it the captured text is treated as unavailable (no evidence slices, base
 * filter for line comments), never truncated — `diffCommand`'s bounded read is
 * what enforces it. Lives here because the command carries the bound.
 */
export const DIFF_PREFETCH_MAX_BYTES = 2 * 1024 * 1024;

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

/** Absolute in-image path charset for the bounded reads — no shell metacharacter. */
const IN_IMAGE_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

/**
 * Bounded read of one in-image file: the first `maxBytes` bytes (`head -c`
 * stops the stream at the bound), a `\n` separator written by `printf`, then
 * the overflow probe's byte count — `wc -c` output, which is ITSELF
 * newline-terminated. So a real run ends `<content>\n0\n` (fit) or
 * `<content>\n1\n` (a byte exists BEYOND the bound). A missing/unreadable file
 * fails the `head` chain (non-zero exit, empty stdout). The path is
 * allowlisted and single-quoted HERE so every caller inherits the same guard
 * (diff capture, recheck document/status); `maxBytes` is always an in-repo
 * constant, never payload-derived.
 */
export function boundedFileReadCommand(path: string, maxBytes: number): ShellCommand {
  assertShellSafe(path, IN_IMAGE_PATH_RE, "bounded read path");
  return shellCommand(
    `head -c '${maxBytes}' '${path}' && printf '\\n' && ` +
      `tail -c '+${maxBytes + 1}' '${path}' | head -c '1' | wc -c`,
  );
}

/**
 * The bounded read's THIRD flag line, beside `0` (fit) and `1` (over the byte
 * bound). It is not a byte count: only a command that itself probed for the
 * path may emit it, and only `readReportCommand` does. Consumers must treat it
 * as "the read PROVED the file is not there", never as a failed read.
 */
export const BOUNDED_READ_ABSENT_FLAG = "2";

/** A commit sha interpolated into a command path segment — hex only. A shell allowlist, never an answer check. */
const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * A COMPLETE git object id: SHA-1's 40 or SHA-256's 64 lowercase hex. The
 * interpolation allowlist above accepts a truncated reply, so it cannot tell
 * an unusable API answer from a real one.
 */
const COMPLETE_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** For a caller that must tell an unusable API answer (`--jq`'s `null`, a truncated reply) from a real object id. */
export function isApiSha(value: string): boolean {
  return COMPLETE_SHA_RE.test(value);
}

function assertSha(value: string, label: string): void {
  assertShellSafe(value, SHA_RE, label);
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
 * The ONE git transport-auth env: a scoped `http.extraheader` (git ignores
 * GH_TOKEN, so a private-repo clone/fetch fails without it). The header is the
 * GitHub-app token form `basic base64(x-access-token:<token>)` — NOT `Bearer`,
 * which GitHub's git server rejects even on public repos. The token travels in
 * exec env only: never in a command string, never in the image, never in logs.
 */
export function gitTransportEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${btoa(`x-access-token:${token}`)}`,
  };
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

/**
 * Capture the PR unified diff: `gh pr diff` STREAMS into `diffPath` (the
 * numstat source) and the Worker reads it back through the same bounded
 * transport as `readRecheckCommand`. The old shape redirected stdout into the
 * file and left the exec's stdout EMPTY, so every round captured no diff and
 * every prior-finding row fell to a fabricated `no-evidence`.
 *
 * The read half is `boundedFileReadCommand` at DIFF_PREFETCH_MAX_BYTES (its
 * output contract lives there): `<diff>\n0\n` (fit) or `<diff-prefix>\n1\n`
 * (a byte exists BEYOND the bound → the text is unavailable, never
 * truncated). gh's own failure fails the chain (non-zero exit, no stdout) —
 * no file, no capture.
 */
export function diffCommand(owner: string, repo: string, prNumber: number, diffPath: string): ShellCommand {
  assertOwnerRepo(owner, repo);
  assertPrNumber(prNumber);
  return shellCommand(
    `gh pr diff '${prNumber}' --repo '${owner}/${repo}' > '${diffPath}' && ` +
      boundedFileReadCommand(diffPath, DIFF_PREFETCH_MAX_BYTES),
  );
}

/**
 * GitHub refuses `gh pr diff` on a PR whose diff exceeds its 20,000-line API
 * ceiling: HTTP 406 on stderr, nothing on stdout. Those two wordings are the
 * ONLY signature of that ceiling — an auth (401/404) or transport failure is
 * a different cause and must keep failing the round, never take the fallback.
 *
 * gh appends the request URL in parentheses, and a repo name may contain the
 * ceiling token itself (`auth_too_large`, `too_larger`), so URLs are cut and
 * the token must stand alone: a substring of a URL is not GitHub's verdict.
 */
export function isDiffTooLarge(stderr: string): boolean {
  const message = stderr.replace(/\s*\(https?:\/\/[^)]*\)/g, "");
  return /\btoo_large\b/.test(message) || message.includes("exceeded the maximum number of lines");
}

/** A branch ref as GitHub reports it (`base.ref`) — no traversal, no option form. */
const BRANCH_REF_RE = /^[A-Za-z0-9._/-]+$/;

function assertBranchRef(baseRef: string): void {
  assertShellSafe(baseRef, BRANCH_REF_RE, "base ref");
  // The charset admits `.` and `-`; `..` escapes a path segment and a leading
  // `-` reads as an option wherever the ref lands as an argument.
  if (baseRef.startsWith("-") || baseRef.includes("..")) {
    throw new Error(`unsafe base ref for shell interpolation: ${JSON.stringify(baseRef)}`);
  }
}

/**
 * The PR's base branch name (`base.ref`) — the first half of the local merge
 * base. Reads through gh's `--jq` surface so the name never needs JSON parsing.
 */
export function pullRequestBaseRefCommand(owner: string, repo: string, prNumber: number): ShellCommand {
  assertOwnerRepo(owner, repo);
  assertPrNumber(prNumber);
  return shellCommand(`gh api 'repos/${owner}/${repo}/pulls/${prNumber}' --jq '.base.ref'`);
}

/**
 * The commit `baseRef...headSha` forks from, resolved by GitHub's compare API.
 * A depth-1 fetch of that sha plus the already-checked-out head is enough for
 * a two-dot `git diff`, so no history has to come down with it.
 */
export function mergeBaseCommand(
  owner: string,
  repo: string,
  baseRef: string,
  headSha: string,
): ShellCommand {
  assertOwnerRepo(owner, repo);
  assertBranchRef(baseRef);
  assertSha(headSha, "head sha");
  return shellCommand(
    `gh api 'repos/${owner}/${repo}/compare/${baseRef}...${headSha}' --jq '.merge_base_commit.sha'`,
  );
}

/**
 * Depth-1 fetch of one commit into the existing clone (the merge base). The
 * head commit is already there — `cloneCommand` fetched `pull/<n>/head` — so
 * this is the only object the local diff still needs.
 */
export function fetchDepthOneCommand(cloneDir: string, sha: string): ShellCommand {
  assertSha(sha, "fetch sha");
  return shellCommand(`git -C '${cloneDir}' fetch --depth 1 origin '${sha}'`);
}

/**
 * Capture the PR diff from the clone when `gh pr diff` refuses it (oversized):
 * the same two-dot merge-base..head diff, written to `diffPath`, read back
 * through the SAME bounded transport as `diffCommand` — one overflow contract,
 * never a second read.
 */
export function localDiffCommand(
  cloneDir: string,
  mergeBaseSha: string,
  headSha: string,
  diffPath: string,
): ShellCommand {
  assertSha(mergeBaseSha, "merge base sha");
  assertSha(headSha, "head sha");
  return shellCommand(
    `git -C '${cloneDir}' diff '${mergeBaseSha}' '${headSha}' > '${diffPath}' && ` +
      boundedFileReadCommand(diffPath, DIFF_PREFETCH_MAX_BYTES),
  );
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
 * GitHub's verdict on a base...head comparison (`ahead` | `behind` |
 * `diverged` | `identical`). Only `ahead` makes an incremental round honest:
 * the previous head is then an ancestor of this one, so base...head is exactly
 * the work done since the last review. Any other status (or a non-zero exit —
 * a 404 after a force-push) keeps the full-diff path.
 */
export function compareStatusCommand(owner: string, repo: string, baseSha: string, headSha: string): ShellCommand {
  assertOwnerRepo(owner, repo);
  assertSha(baseSha, "base sha");
  assertSha(headSha, "head sha");
  return shellCommand(
    `gh api 'repos/${owner}/${repo}/compare/${baseSha}...${headSha}' --jq '.status'`,
  );
}

/**
 * Capture the INCREMENT diff (`base...head`) with the SAME bounded transport as
 * `diffCommand`: the diff media type lands in `diffPath` for numstat, then the
 * first DIFF_PREFETCH_MAX_BYTES bytes stream back, then the overflow probe.
 * `base...head` is GitHub's three-dot form (compared against the merge base),
 * which is what `compare` reports as `ahead` — the two steps agree by
 * construction.
 */
export function incrementDiffCommand(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  diffPath: string,
): ShellCommand {
  assertOwnerRepo(owner, repo);
  assertSha(baseSha, "base sha");
  assertSha(headSha, "head sha");
  return shellCommand(
    `gh api -H 'Accept: application/vnd.github.v3.diff' 'repos/${owner}/${repo}/compare/${baseSha}...${headSha}' > '${diffPath}' && ` +
      `head -c '${DIFF_PREFETCH_MAX_BYTES}' '${diffPath}' && printf '\\n' && ` +
      `tail -c '+${DIFF_PREFETCH_MAX_BYTES + 1}' '${diffPath}' | head -c '1' | wc -c`,
  );
}

/**
 * Write a JSON document to an in-image path (the runner `--input` file). The
 * payload arrives on the exec STDIN pipe base64-encoded (the caller passes it
 * as `runCommand(..., { stdin })`); `base64 -d` decodes it in-container, so
 * arbitrary JSON (quotes, unicode, tabs, newlines) never touches shell
 * interpolation — and the document never becomes an exec ARGUMENT, which Linux
 * caps at 128 KiB (E2BIG above it).
 */
export function writeJsonCommand(path: string): ShellCommand {
  assertShellSafe(path, IN_IMAGE_PATH_RE, "write path");
  // The charset admits `.`; a `..` segment would still escape the path.
  if (path.includes("..")) {
    throw new Error(`unsafe write path for shell interpolation: ${JSON.stringify(path)}`);
  }
  return shellCommand(`base64 -d > '${path}'`);
}

/**
 * Run the in-image review runner on the runtime envelope path:
 * `--level` is the review tier, `--input` the reconFacts JSON file. stdout
 * carries ONLY the validated mstar.review/v1 envelope; exit 0 = success
 * (there is no summary-degrade mode on this path). `recheckOutPath` is the
 * optional `--recheck-out` target and `reportOutPath` the optional
 * `--report-out` target — each passed through verbatim when provided (the
 * consumer reads those files back through the same bounded read).
 */
export function runnerCommand(
  runnerPath: string,
  level: ReviewLevel,
  inputPath: string,
  recheckOutPath?: string,
  reportOutPath?: string,
): ShellCommand {
  let command = `bun run '${runnerPath}' --level '${level}' --input '${inputPath}'`;
  if (recheckOutPath !== undefined) command += ` --recheck-out '${recheckOutPath}'`;
  if (reportOutPath !== undefined) command += ` --report-out '${reportOutPath}'`;
  return shellCommand(command);
}

/**
 * Bounded read of the runner's recheck output file (spec §7.8): the Worker
 * consumes the seat's validated document through THIS audited command — never
 * an arbitrary model-produced path. The transport (byte bound + `\n` +
 * newline-terminated overflow flag) is `boundedFileReadCommand`, shared with
 * the diff capture and the status read. A missing/unreadable file fails the
 * `head` chain (non-zero exit, empty stdout) — the consumer fails closed
 * either way (invalid → no recheck). The consumer passes the same fixed
 * constant the runner flag wrote (RECHECK_OUTPUT_PATH).
 */
export function readRecheckCommand(path: string): ShellCommand {
  return boundedFileReadCommand(path, RECHECK_FILE_MAX_BYTES)
}

/**
 * Bounded read of the seat's recheck STATUS document — the same audited
 * transport (byte bound + overflow flag) as the document read. The production
 * path is the fixed RECHECK_STATUS_PATH (the same constant the runner wrote);
 * the optional parameter exists only so a shell-level oracle can point at a
 * temporary file instead of the real one. A missing file fails the `head`
 * chain exactly like the document read, which the consumer maps to "no status
 * recorded".
 */
export function readRecheckStatusCommand(path: string = RECHECK_STATUS_PATH): ShellCommand {
  return readRecheckCommand(path);
}

/**
 * Bounded read of the runner's `--report-out` document (mstar.report/v1) —
 * the same transport and the same fail-closed rule as the recheck read: the
 * Worker validates the seat's narrative against its own gate
 * (`validateReportDoc`) and renders `none` headings when it cannot.
 *
 * A seat that wrote NO document and a read that broke are different facts, so
 * this command proves the first one itself: a positive `[ -e ]` probe
 * short-circuits a missing path to the absent flag line (`\n2\n`, exit 0),
 * while a file that exists but cannot be read still fails the `head` chain
 * (non-zero exit) as any transport fault does.
 *
 * shortcut: `test -e` cannot tell "no such file" from a parent directory the
 * shell may not search, so an EACCES-only miss reads as absent; a sandboxed
 * report path has no untraversable parent, so upgrade if one ever appears.
 */
export function readReportCommand(path: string = REPORT_OUTPUT_PATH): ShellCommand {
  assertShellSafe(path, IN_IMAGE_PATH_RE, "bounded read path");
  return shellCommand(
    `if [ -e '${path}' ]; then ${boundedFileReadCommand(path, REPORT_FILE_MAX_BYTES)}; ` +
      `else printf '\\n${BOUNDED_READ_ABSENT_FLAG}\\n'; fi`,
  );
}

/** Main-flow commands in execution order (clone → sha → diff → numstat). */
export function buildGitOpsCommands(input: GitOpsInput): GitOpsCommands {
  return {
    clone: cloneCommand(input.owner, input.repo, input.prNumber, input.cloneDir),
    checkedOutSha: checkedOutShaCommand(input.cloneDir),
    diff: diffCommand(input.owner, input.repo, input.prNumber, input.diffPath),
    numstat: numstatCommand(input.diffPath),
  };
}

/**
 * `gh pr view --json body` — the PR description for the report seat. Reads
 * through the gh JSON surface so the body never needs HTML/format parsing.
 */
export function prBodyCommand(owner: string, repo: string, prNumber: number): ShellCommand {
  assertOwnerRepo(owner, repo);
  assertPrNumber(prNumber);
  return shellCommand(`gh pr view '${prNumber}' --repo '${owner}/${repo}' --json body`);
}

/**
 * `gh issue view <n> --json number,title,body` — one linked issue for the
 * report seat. `n` comes from the consumer's CLOSED keyword extraction over
 * the PR body (an integer, never free text), and carries the same numeric
 * guard as every other interpolated number here.
 */
export function issueViewCommand(owner: string, repo: string, issueNumber: number): ShellCommand {
  assertOwnerRepo(owner, repo);
  assertPrNumber(issueNumber);
  return shellCommand(`gh issue view '${issueNumber}' --repo '${owner}/${repo}' --json number,title,body`);
}
