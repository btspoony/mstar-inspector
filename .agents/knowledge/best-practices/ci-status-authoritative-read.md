# Read CI status from the pull request's rollup, never from a commit's check-runs

## The mistake this prevents

A PR's review check was reported "failing three times in a row" while it had actually passed. The evidence used was `repos/{owner}/{repo}/commits/{sha}/check-runs`, which returns **every check-run ever created for that commit** — including the one or two attempts that failed before a re-run. A re-run appends a new run; the old failure keeps sitting in that list with an earlier `started_at`. Reading the list without ordering by time turns a recovered failure into a permanent one.

A second trap compounds it: `gh pr checks --watch` binds to the snapshot that existed when it started. If a re-run begins afterwards, the watcher keeps reporting the old conclusion, and each "still failing" line looks like fresh confirmation.

## The rule

- **Authoritative state is the PR rollup**: `gh pr view <n> --json statusCheckRollup` — one entry per context, reporting the newest run. `mergeStateStatus` and the rollup come from the same read.
- **A commit's check-runs are history**, not status. Use them only to enumerate attempts, and always sort by `started_at` and compare timestamps before drawing a conclusion.
- **Before calling a failure "consecutive", prove the newest run exists**: compare the failure's `completed_at` with now, and confirm whether a later run has started. A re-run triggered seconds ago has no result yet; the previous failure is then not evidence about the current attempt.
- **After triggering a re-run, start a fresh watcher**; do not reuse one that began before the re-run.
- If two sources disagree, the rollup wins, and the disagreement itself is worth stating (for example: an old failure plus a new success means "recovered", not "still failing").

## Why it matters beyond politeness

A false "platform is broken" conclusion stops work that could ship, invites a workaround merge, and produces issue reports that overstate the defect. Both directions cost more than the extra query.

## When a failure genuinely has no record

A check-run can fail with a generic "something went wrong" and leave no row in the product's own failure table — meaning it aborted before the pipeline wrote anything. That is a real defect worth its own issue (the abort must record the stage it reached), but it is a different claim from "the check keeps failing", and the rollup is what tells you which case you are in.
