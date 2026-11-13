---
module: review-lifecycle
date: 2026-11-13
problem_type: logic_error
category: logic-errors
severity: high
symptoms:
  - "review_threads rows stay resolution_state='pending' with attempts=0 and verified_json IS NULL"
  - "the published round line says 'context coverage: truncated' and every closure-table thread cell is '-'"
  - "findings are assessed 'addressed (verified-fix)' yet the GitHub conversations stay open across rounds"
root_cause: "The app's own published line-comment report entered the discussion model view, exceeded the per-item cap, and flipped its own thread to modelCoverage=truncated, which withholds the resolution authorization that would write verified_json."
resolution_type: code_fix
tags:
  - review-lifecycle
  - discussion-context
  - budget
  - deadlock
  - github-threads
---

# An app's own output must not spend its own model budget

## Problem

Prior findings are verified as fixed and published as `addressed`, but their GitHub conversations never resolve. The resolution executor looks broken and is not: it is never handed work.

## Symptoms

- `review_threads` for the PR: every row `resolution_state='pending'`, `attempts=0`, `verified_json IS NULL`, `next_attempt_ms=NULL`.
- The round line says `context coverage: truncated`; the closure table lists every revalidated finding as `addressed (verified-fix)` while its `thread` cell is `-`.
- The recovery selector requires `verified_json IS NOT NULL`, so the queue is permanently empty — no error, no retry, no DLQ entry.

## What Didn't Work

- **Reading the executor first**: `resolveFindingThread` has ownership, digest, HEAD and mutation-confirmation fences that all look like plausible culprits. It never ran; `attempts=0` proves it. The eligibility column is the first thing to read, not the last.
- **Fixing the rotation path**: an earlier change made the recheck rotation re-select `addressed` rows whose association is still non-terminal. Correct, and still unreachable — the authorization gate is upstream of it.
- **Assuming a version/deploy mismatch**: staging ran the current `main`; the rows were created by that build.

## Solution

Exclude the app's own published report from the model view before the caps, in **both** lanes — issue comments by the review/degraded marker prefix, line-comment roots by the Inspector thread marker — and require the authenticated `viewerDidAuthor` as the other half:

```ts
// before: issue-only, so a 2133-char line-comment root clamped at 1200 and
// flipped its own thread to truncated
!(
  item.source === "issue" &&
  item.ownAuthor &&
  /^<!--\s*mstar-inspector:[a-zA-Z-]+:v1\b/.test(item.body.trimStart())
)

// after: the lane's own marker, authorship still required
!(
  item.ownAuthor &&
  (item.source === "issue"
    ? /^<!--\s*mstar-inspector:[a-zA-Z-]+:v1\b/.test(item.body.trimStart())
    : parseLineMarker(item.body) !== null)
)
```

The same report also had a companion defect in discovery: GitHub re-anchors a still-valid thread when the code above it moves (`line` 641 → 653, `1519` → 1543) while `originalLine` still names the published line. An anchor fence that accepted `originalLine` only for `outdated` threads with a null live line rejected these forever, so the association never entered the discussion at all.

```ts
if (thread.path !== intent.path) return false;
if (thread.line === intent.line) return true;
if (thread.line === null) return thread.isOutdated && thread.originalLine === intent.line;
return !thread.isOutdated && thread.originalLine === intent.line;
```

## Why This Works

The resolution fence exists to ensure the model saw the whole discussion before anything is closed: a truncated view could hide a rebuttal. The app's own finding report is not discussion — the recheck input already carries that concern verbatim and untruncated — so counting it as lost context made the fence's satisfiability depend on the publisher's text length. Once it is out of the accounting, a thread with one short human reply is `complete` and the authorization is reachable.

The anchor change does not widen ownership: the marker, body digest, review id and original commit still prove the thread, and `originalLine` only decides which candidate those proofs are applied to.

## Prevention

- **An authorization fence must not depend on a budget the producing side controls.** If the fence needs "the model saw everything", anything the system itself writes into that stream must sit outside its accounting.
- **Read the queue's eligibility column before the executor.** `attempts = 0` plus a NULL proof column means never selected, not failed.
- **Treat the published coverage word as evidence.** `context coverage: truncated` names the fence that refused.
- **Test the fence, not the executor.** Drive `boundDiscussion` with a root at the real published size (2133 characters, marker included) plus one short human reply and assert the thread stays `complete`; drive discovery with `line = intent.line + 12`, `originalLine = intent.line`, `isOutdated: false`. Both must fail against the pre-change predicates.

## Related

- `recheck-seat-context-budget.md` — the sibling failure: a seat handed more than it can hold yields nothing and the round is attributed `invalid-output`.
- `docs/specs/feature/review-lifecycle.md` §7.4 (own-report exclusion) and §7.5 (anchor fence).
