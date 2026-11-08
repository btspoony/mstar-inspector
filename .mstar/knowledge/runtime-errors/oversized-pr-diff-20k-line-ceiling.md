---
module: review-pipeline
date: 2026-11-07
problem_type: runtime_error
category: runtime-errors
severity: high
plan_id: 100-diff-too-large-fallback
symptoms:
  - "Every review attempt on the PR fails in the sandbox stage with `diff failed: exit 1, stdout 0B`, retries included"
  - "Four attempts (one delivery plus three retries) at the same head produce zero reviews and zero findings"
  - "The failure text names the stage only — `diffCommand` redirects `gh pr diff` stdout into the diff file, so the 406 on stderr never reaches the error"
root_cause: "GitHub's diff media type refuses any PR diff over 20,000 lines with HTTP 406 (`PullRequest.diff too_large`), and the pipeline had no capture path for a diff the API will not serve"
resolution_type: code_fix
related_components:
  - gitops
  - consumer
  - github-rest-api
  - sandbox-clone
tags:
  - github-diff-api
  - http-406
  - too-large-diff
  - merge-base
  - git-fetch-depth-1
  - review-pipeline
---

# Oversized PR diff: GitHub's 20,000-line ceiling and the local merge-base capture

## Problem

A 65,033-addition / 808-deletion PR over 113 files and 155 commits cannot be reviewed: `gh pr diff` is the pipeline's only diff source, and GitHub's diff media type refuses a PR diff above 20,000 lines. That PR is roughly three times the ceiling, so the refusal is deterministic — every attempt fails the same way and no retry can help.

## Symptoms

- Sandbox stage error `diff failed: exit 1, stdout 0B`; the delivery plus its three retries all fail identically at the same head.
- Zero reviews posted and zero findings recorded across those four attempts.
- The message carries no cause. `diffCommand` (`src/pipeline/gitops.ts`) writes `gh pr diff` stdout into `DIFF_PATH` and reports only stdout on failure, so GitHub's `HTTP 406 … PullRequest.diff too_large` landed on stderr and was discarded.
- With the diagnostic fix the failure carries the redacted stderr tail, so the 406 (`… exceeded the maximum number of lines (20000)`) is visible in the error itself instead of only `exit 1, stdout 0B`.

## What Didn't Work

- **Raising `DIFF_PREFETCH_MAX_BYTES`** (the 2 MiB worker-side bound): the bound governs how much of a captured diff the Worker keeps in memory. The API refuses to render the diff at all, so no read bound can recover it.
- **Per-file pagination through `pulls/{n}/files`**: 16 of the PR's 113 files come back with `patch: null`, so the assembled diff is missing those hunks and is not the PR's diff.
- **Two-dot `base tip..head`** (diffing the base branch tip against the head): the PR is `diverged` with `behind_by: 7`, so commits the base gained would render as deletions against the PR. Only a merge-base diff describes the PR's own changes.

## Solution

Two changes: the git stage reports its cause, and an oversized diff is captured from the clone instead of the API.

**Diagnostics** — the `diff`, `increment diff` and `numstat` failures in `src/pipeline/consumer.ts` go through one formatter that appends the redacted 600-char stderr tail: `<stage> failed: exit N, stdout <n>B, stderr tail: <tail>` (`n` is the UTF-8 byte count of stdout; `stderr empty` when there is none).

**Fallback** — `oversizedDiffCapture` in `src/pipeline/consumer.ts`, with builders in `src/pipeline/gitops.ts`:

```sh
# Before — the only capture path
gh pr diff '<n>' --repo '<owner>/<repo>' > '<diffPath>' && <bounded read of diffPath>

# After — entered only on the 406 signature
gh api 'repos/<owner>/<repo>/pulls/<n>' --jq '.base.ref'
gh api 'repos/<owner>/<repo>/compare/<baseRef>...<headSha>' --jq '.merge_base_commit.sha'
git -C '<cloneDir>' fetch --depth 1 origin '<mergeBaseSha>'
git -C '<cloneDir>' diff '<mergeBaseSha>' '<headSha>' > '<diffPath>' && <same bounded read of diffPath>
```

- **Entry gate**: `isDiffTooLarge(stderr)` — the stderr with `(…)` URLs stripped must contain a standalone `too_large` token or the phrase `exceeded the maximum number of lines`. An auth (401/404) or transport failure never takes the fallback; it rethrows and keeps its own cause.
- **Head is already local**: `cloneCommand` fetched `pull/<n>/head`, so only the merge base needs fetching.
- **Output contract unchanged**: the same unified diff lands in the same `DIFF_PATH` and comes back through the same `boundedFileReadCommand` at `DIFF_PREFETCH_MAX_BYTES`, so the numstat source and the fit/overflow/unreadable outcomes are identical to the API path. Successful runs log `diff_source: "oversized-local"`.
- **One clock**: `diffCaptureDeadlineMs` (`EXEC_TIMEOUT_GIT_MS`, 120 s) is created once for the diff stage and every one of the four fallback execs draws its timeout from what remains of it, each step capped at `PR_CONTEXT_EXEC_TIMEOUT_MS` (30 s). A refused `gh pr diff` plus a complete fallback therefore bills one 120 s ledger window, never two.
- **One derived deadline for everything after the diff**: the runner's exec timeout, `numstat`, the runner-input write, the PR-context reads and the increment capture all draw from `runnerDeadlineMs = roundDeadline − postRunnerReserveMs(live terminalize budget)` — 666 s at the defaults — and a step that would start past it declines with an explicit `round budget spent: <step> declined` failure instead of running on a fresh window, so a legal sequence cannot cross the 900 s cap.
- **Round gate**: the fallback is declined unless that derived deadline still leaves one `EXEC_TIMEOUT_GIT_MS` (120 s) capture window. `deep` reaches the fallback (666 s > 120 s) because its 840 s runner table is a ceiling, not a reservation; a round that already spent more than ~546 s declines and keeps the fast 406 failure row.
- **Fail-closed, never silent**: every decline returns a reason and the step it stopped at — `budget`, `step-timeout`, `base-ref-empty`, `merge-base-empty`, `merge-base-unreadable`, `fetch-exit`, `local-diff-exit`, `guard-rejected` or `transport`. The caller emits ONE structured warn (`diff_fallback`, `diff_fallback_step`, plus that step's exit code and its redacted 600-char stderr tail) and rethrows the ORIGINAL diff failure with `; oversized fallback: <reason> at <step>` appended, so `review_failures.error` tells "not attempted (budget)" from "failed at fetch" from "an unusable API answer" (`merge-base-unreadable`: the compare call exited 0 with a value that is not a complete git object id — 40 or 64 hex — e.g. `--jq`'s `null` for an absent field or a truncated reply) from "a hostile ref rejected". A partial capture is never published, and a hostile ref or sha is rejected by `assertBranchRef` / `assertSha` before it reaches a shell string.

## Why This Works

The 20,000-line ceiling is a limit on rendering a diff through the diff media type, not on the repository objects. GitHub still reports the PR's base ref and its comparison, and `merge_base_commit.sha` is exactly the commit the PR's changes are measured from: base advances since the fork do not appear, so the two-dot `merge-base..head` diff equals the PR's own change set. Because the head commit is already in the clone, one depth-1 fetch of the merge base is enough history for `git diff`, and the resulting bytes travel the existing bounded read like any other capture.

Measured on the prototype recorded in `{PLAN_DIR}/100-diff-too-large-fallback.md`, against that PR:

- `gh pr diff` → exit 1, `HTTP 406 … exceeded the maximum number of lines (20000)`, 0-byte file.
- `gh api repos/<owner>/<repo>/compare/<base>...<head>` → `merge_base_commit.sha` present, `ahead_by: 155`, `behind_by: 7`, `status: diverged`.
- Depth-1 fetch of the merge base 6.0 s, of the head 5.6 s (the shipped path fetches only the merge base).
- `git diff <merge-base> <head>` → 2,743,756 B / 69,205 lines; `git apply --numstat` → 113 files, matching `changed_files: 113`.

## Prevention

- A stage failure must carry the command's stderr tail. `exit N, stdout 0B` describes the redirection, not the fault — a write-only stage (stdout redirected to a file) must never be the only channel that reports a cause.
- Gate a fallback on the provider's exact refusal signature, not on the stage name: `too_large` in a URL or a similarly named repository is not the verdict, and an auth failure must keep failing.
- When one logical stage becomes several execs, give them one deadline. Per-exec timeouts that each start fresh break the ledger window the stage is billed against.
- Keep one capture contract. The fallback writes to the same path and reads back through the same bounded transport, so overflow semantics never fork into two implementations.

## Known Limits

- `shortcut:` incremental recheck capture still uses the compare-API diff and shares the 20,000-line ceiling, so a recheck round on an oversized PR still fails at the increment stage; upgrade when rechecking oversized PRs matters (issue I-000503).
- `shortcut:` the base-ref guard admits only `[A-Za-z0-9._/-]`, so a legal GitHub ref outside that set (for example one containing `+`) declines the fallback and the round rethrows the 406; upgrade on the first such PR (issue I-000505).
- `shortcut:` `isDiffTooLarge` can still match a repository literally named `too_large` in non-URL error text; every sub-step then fails and the original error is rethrown, so the cost is a spent 120 s window, not a wrong capture (issue I-000506).
- `shortcut:` a round that has already spent more than ~546 s of its 900 s window (the derived runner deadline less one 120 s capture) declines the fallback and keeps the fast 406 failure row; upgrade if blocked-by-budget oversized rounds become common.
- Unverified: live fetchability of an arbitrary merge-base sha, 406 wording drift, deployed Worker behaviour, real container timing on a multi-megabyte diff through the fallback, and a local diff above 2 MiB (no case covers it).

## Adjacent Knowledge

- `runtime-errors/sandbox-exec-argv-e2big.md` — a different platform ceiling on the same stage family (per-argument bytes, not API lines); the payload discipline it establishes is untouched by this fallback, which adds no argv payload.
- `best-practices/github-app-headless-verification.md` — verification through the Worker gateway's `fetchPrDiff` media-type path, which is the API surface this fallback bypasses on a 406.
