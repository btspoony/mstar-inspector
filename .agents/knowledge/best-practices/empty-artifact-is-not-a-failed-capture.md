---
module: review-pipeline
date: 2026-11-08
problem_type: best_practice
category: best-practices
severity: high
resolution_type: code_fix
applies_when:
  - "a stage writes its output to a file and a later step parses that file"
  - "an empty result and a failed capture both look like a non-zero exit from the parser"
  - "a shell redirect targets an artifact that already holds evidence needed by the round"
tags:
  - capture-classification
  - write-only-stage
  - shell-redirect-truncation
  - empty-vs-failed
  - exit-code-is-not-evidence
related_components:
  - consumer
  - gitops
---

# An empty artifact is not a failed capture: classify by the delivered file, not the exit code

## Context

The review pipeline captures a diff in two steps: a shell command writes the
unified diff into `DIFF_PATH` (stdout redirected to the file), then a parser step
reads that file back — `git apply --numstat` for the seat partition, and the
bounded read for the diff text itself.

Both steps can fail in ways that look identical from the outside. `git apply
--numstat` exits 128 on an empty file (`error: unrecognized input`) exactly as it
does on a corrupt one, and a shell redirect truncates the target before the
command runs, so a refused command leaves an EMPTY file where the previous round's
evidence used to be.

That combination produced two wrong verdicts in one place:

- a PR whose new head added no diff failed the round at the sandbox stage and
  retried, instead of taking the documented no-increment acknowledgement;
- an oversized-`base...head` capture refused by the API truncated the full diff,
  which the next step then read as "nothing to review" — an acknowledgement over a
  real diff.

## Guidance

1. **Never classify emptiness from the exit code.** A parser's non-zero exit says
   the input was unusable; it does not say the input was empty. Carry the
   artifact's own state from the read that observed it (`empty` / `captured` /
   `overflow` / `unreadable`) and let the parser's exit refine that state, not
   replace it.
2. **One round, one read.** The state must come from the same round's read of the
   same artifact. A second probe, a fresh `stat`, or a different step's stdout can
   disagree with what the parser consumed and invites a verdict about a file
   nobody parsed.
3. **Stage, then deliver.** A command that writes evidence must write to a scratch
   path and move it onto the real one only after it succeeded
   (`cmd > "$path.increment" && mv -f "$path.increment" "$path"`). A redirect
   straight into the live path destroys the previous evidence before the command
   has a chance to fail.
4. **Keep the causes distinguishable.** An empty file, an over-bound capture and a
   genuine command failure are three outcomes with three different round
   decisions; collapse them and a capture fault becomes a silent "nothing to
   review".
5. **Name the state in the failure text.** When the command truly failed, append
   the artifact's state (`; diff file: unreadable`) next to the redacted stderr, so
   "empty input" and "could not read the input" never share one message.

## Why This Matters

An acknowledgement is a claim about the world: "this head has nothing new". The
safest-looking branch — treat an empty read as nothing to review — silently
converts a capture fault into that claim, and the round publishes no review for a
PR that did change. The inverse mistake is just as costly: a genuinely empty diff
turned into a sandbox failure retries three times and blocks a harmless empty
commit.

Both outcomes are decided by evidence, not by handling: the artifact's observed
state plus the parser's answer to it. Everything else is a guess dressed as a
branch.

## When to Apply

- Any stage that redirects command output into a file and later parses that file.
- Any two-step capture where the second step's exit code is the only signal the
  first step left behind.
- Any degradation path that rewrites an artifact the round already depends on.

## Examples

```ts
// Observed state first, exit code second.
const read = parseBoundedRead(stdout);          // "empty" | "overflow" | "unreadable" | text
const state = read.failure ?? (read.text === "" ? "empty" : "captured");

if (exitCode !== 0 && state !== "empty") {
  throw new Error(`${failureDetail(stage, run)}; diff file: ${state}`);
}
// Only a delivered-empty artifact with nothing parsed from it is the ack — and
// on a FIRST round (no `sinceSha` to inherit from) the parser must also have
// failed: an exit-0 read with no lines there keeps the normal round, so a
// capture fault can never ride in as "nothing to review".
const empty =
  state === "empty" && parsedLines.length === 0 && (sinceSha !== null || exitCode !== 0);
```

```sh
# Delivery is a rename, never an in-place overwrite.
gh api -H 'Accept: application/vnd.github.v3.diff' 'repos/o/r/compare/a...b' > "$path.increment" \
  && head -c "$PREFETCH" "$path.increment" \
  && mv -f "$path.increment" "$path"
```

## Adjacent Knowledge

- `runtime-errors/oversized-pr-diff-20k-line-ceiling.md` — the fallback whose
  refusal exposed the truncation. The scratch-file discipline is the
  increment/compare capture's, not the fallback's: `incrementDiffCommand` stages
  into `${diffPath}.increment` and renames that over `diffPath` only after a
  delivered capture. The fallback's `localDiffCommand` still writes `DIFF_PATH`
  directly — harmless only because it is that round's first write to the file.
- `best-practices/guard-preprocessing-fails-toward-reporting.md` — the same
  principle one layer up: a guard that mutates its input before deciding fails
  open.
