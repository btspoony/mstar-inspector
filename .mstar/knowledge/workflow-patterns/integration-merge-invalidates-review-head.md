---
module: integration delivery (parallel workstream branches into one integration branch)
date: 2026-11-06
problem_type: workflow_issue
category: workflow-patterns
severity: high
applies_when:
  - "Serially merging parallel workstream branches into one delivery branch"
  - "A pull request's head advanced after it was reviewed: rebase, catch-up merge, dependency refresh, any resolution"
  - "Deciding whether an existing green run authorizes a merge"
tags:
  - merge
  - integration-branch
  - review-head
  - ci-evidence
  - catch-up-merge
---

# A merge that changes reviewed bytes invalidates the review head

## Context

Three independent workstreams merged serially into one integration branch. Each
workstream branch had passed its own review seats and its own checks at its own head.

When a later branch absorbed the integration branch to settle conflicts — a catch-up
merge: merge integration *into* the feature branch, resolve, then merge the branch back —
the resolution was a hand edit in a file that had already been reviewed and approved. One
CSS utility, one line, in `src/spa/pages/PullRequestDetail.tsx`.

Nothing about that merge looked like a product change. Its subject was about the merge.
Its diff against the integration tip showed only the branch's own work. The next merge —
branch into integration — was clean, so the resolved line arrived on integration with
nothing to flag it. The approval and the green run belonged to the branch head *before*
the resolution.

## The commits

| Commit | What it is |
|---|---|
| `e40dc869` | The reviewed head: the design-system gate reads a script's references raw. Approved by its review seats, with a CI run obtained at that commit by targeting `main` from a temporary draft PR. |
| `7beaaea4` | Catch-up merge: integration absorbed into the branch. One manual resolution in `PullRequestDetail.tsx`, `mt-(--spacing-6)` became `mt-5`. |
| `a357a8fa` | The branch merged back into integration. Clean — the rewritten line came along. |
| `f0747c4f` | The one-line fix: `mt-5` back to `mt-(--spacing-6)`. |
| `f61e49f0` | The fix merged into integration. |

The change itself: `--spacing-6` is 24px and one of the nine declared spacing steps;
`mt-5` is 20px, a step the design scale does not declare. Neither candidate was
unapproved — `mt-5` was the branch's own repair for a dangling `--spacing-5` reference,
and `mt-(--spacing-6)` was the other workstream's line on the same wrapper. So the merge
was not choosing a right side over a wrong one; it was making a design decision neither
review had been asked to make, and making it silently. That is why it needed a
decision-maker and a targeted re-review rather than a conflict-resolution reflex.

## How it was caught

A targeted merge-resolution review of the catch-up commit itself: not the branch, not the
workstream around it.
The diff basis was the merge's two parents plus `git show --remerge-diff <merge>`, which
prints only what a human resolved and elides git's own automatic result. The remerge diff
contained exactly one line. The review compared that line against the design contract —
the declared spacing scale, the token definitions, the neighbouring blocks that already
use `spacing-6` — and returned one blocking warning: keep the 24px token.

The reusable part is the instrument. On any merge, `--remerge-diff` is the only view that
separates "git computed this" from "someone chose this". A plain `git show` on a merge
hides the resolution inside the union of both parents' work.

## Guidance

- **Evidence is bound to a commit, never to a branch or a pull request.** An approval, a green
  run, and a QA receipt each describe one SHA. Before authorizing a merge, compare the
  authorized SHA with the branch's current head; if they differ, the evidence does not
  transfer and the delta needs its own look. Never relabel an older green run as the new
  head's pass — record which head each receipt belongs to.
- **Treat a catch-up merge as an unreviewed product edit.** Before merging it back, run
  `git show --remerge-diff <merge>`. Empty output means git resolved everything; non-empty
  output is code written after approval and gets the same review as any other
  post-approval change.
- **Scope the re-review to the resolution.** Diff basis = the merge's parents plus the
  remerge diff; the question is "does this line preserve both sides' intent", not a re-read
  of the branch. One seat, targeted, with the design or testing contract the touched lines
  belong to in hand.
- **Prefer the absorbing branch's reviewed bytes.** When two approved sides conflict, the
  resolution reproduces one side's approved line verbatim, or moves the decision to the
  side that owns the contract. A resolution that invents a third value is a new decision
  and must say so.
- **Re-run what the change class demands, on the new head.** A CSS utility rewritten by a
  resolution needs the gate that reads CSS references, at the merged SHA; a pipeline branch
  needs its suites at the merged SHA. Only the affected evidence is invalidated — the rest
  keeps its original range and the reason it still applies.
- **A clean merge of an already-resolved branch is not a second check.** Integration's
  merge of the branch was automatic and therefore silent. The only place the resolution
  could be caught was the review of the resolution itself.
- **Know which refs your CI actually covers.** In this repository `ci.yml` triggers on
  `main` pushes and on pull requests that target `main`, so an integration branch and its
  workstream branches run nothing. Every green run obtainable there is borrowed from a
  differently-based ref — a temporary `main`-targeting PR, or a local run — which is
  precisely why the SHA, not the delivery record, has to be the evidence key.

## Why This Matters

The integration resolution is the least-reviewed code in a parallel delivery: it is written
by whoever is merging, under conflict pressure, in a file that already passed review, and
it leaves no diff in either parent's history. The verdict and the CI run that appear to
cover it were true of an earlier tree. Without a targeted look at the resolution, an
integration branch reaches `main` carrying a line nobody approved, while the delivery record
shows a fully approved change — the worst combination, because it is the one nobody audits.

## When to Apply

- Serial integration of parallel branches into one delivery branch.
- Any pull request whose head advanced after review — rebase, catch-up merge, dependency
  refresh, a resolution of any kind.
- Deciding whether an existing green run authorizes a merge.
- Reviewing a merge commit: ask for `--remerge-diff` before reading anything else.

## Examples

### Before — the views that hide the resolution

```console
$ git show --stat 7beaaea4
# a merge: reports the union of both parents' work, not the line someone chose
```

A plain diff of a merge commit shows what arrived, never which bytes a human picked.

### After — the view that shows only the choice

Excerpt of the remerge diff (its header lines and the parents' subject lines elided):

```console
$ git show --remerge-diff --format='%h' 7beaaea4
7beaaea4

diff --git a/src/spa/pages/PullRequestDetail.tsx b/src/spa/pages/PullRequestDetail.tsx
@@ -725,11 +725,7 @@ export function PullRequestDetailView({
-<<<<<<< e40dc869 (fix(design-system): read a script's references raw, ...)
         <div className="mt-5 flex flex-col gap-(--spacing-6) xl:flex-row ...">
-=======
-        <div className="mt-(--spacing-6) flex flex-col gap-(--spacing-6) xl:flex-row ...">
->>>>>>> 661f581d
```

Both candidates are printed, and the kept one has no marker in front of it. The review's
whole evidence base is that block. The fix is then a one-line diff, `mt-5` back to
`mt-(--spacing-6)`, and the branch is mergeable again at a head whose evidence matches it.
