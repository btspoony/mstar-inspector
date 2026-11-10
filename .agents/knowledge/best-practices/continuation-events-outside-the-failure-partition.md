---
module: review-observability
date: 2026-11-07
problem_type: best_practice
category: best-practices
severity: medium
topic: failure partition and continuation events
tags:
  - review-failures
  - dashboard
  - sweep
  - rate-limit
  - observability
  - queue
---

# A continuation event needs its own stage, outside the failure partition

> `review_failures` is one table with two meanings: rows that say the review failed, and rows that
> say a side effect did not happen while the review stands. A new row written under a failure stage
> is silently counted as a review failure by every dashboard face and by the cron sweep.

## Context

The review queue writes `review_failures` rows from several places. The stage column is the
attribution partition: `parse`, `runner`, `sandbox` and `pipeline` are review failures; the
non-failure stages (`recheck`, `usage`, and now `rate-limit`) are continuation events — a round
that produced no usable document, a dropped metered attempt, or a best-effort side effect that a
rate limit prevented. The dashboard and the sweep both exclude the non-failure set through the one
exported `PAGING_EXCLUDED_STAGES` list in `src/contracts/failure-stages.ts`; no face may hand-write
its own stage predist.

## Guidance

- **Name the stage by what the row means, not by where it was written.** A throttled cleanup after a
  successful publication is not a review failure. Give it a stage in the excluded partition and add
  that stage to the shared list.
- **Best-effort blocks swallow returns and throws.** A cleanup block that warns on a returned error
  and catches a throw cannot feed the outer failure path. A metric derived from such a side effect
  must be persisted at that boundary — one row, in its own try/catch, never a retry of the whole
  round and never a change to the already-published review.
- **Classify before falling back to a "dead target".** GitHub answers `403` both for a foreign bot
  marker and for a secondary rate limit. A fallback that treats every `403` as "target is dead,
  create a replacement" (or as "skip the delete") absorbs the rate limit: the request never reaches
  the single consumer catch, so nothing is counted. Consult the rate-limit classifier first, and let
  only a plain `403`/`404` take the fallback.
- **Split the kinds.** `429` is a primary limit; `403` with `retry-after`, `x-ratelimit-remaining: 0`
  or a "secondary rate limit" message is a secondary one. A single count that folds both inflates
  the secondary metric; keep one prefix per kind and count each separately.
- **A degraded read is `null`, not zero.** A queue gauge that cannot be read renders "not readable",
  never `0`, and never turns the read into a 500.

## Why this matters

Two failures of this shape shipped together: a rate-limited deletion was reported as "skipped" and a
rate-limited update became a duplicate CREATE, while the console claimed no rate-limit surface
existed. The repair is small (a classifier, one tagging point, one stage) but only correct if the
partition and the count agree: a row that counts as a metric must not also count as a review
failure, and a primary limit must not inflate a secondary number.

## When to apply

- Adding any row to `review_failures` from a best-effort or post-success path.
- Adding a count or an operator card over the same table.
- Touching a `403` fallback that mutates or skips a GitHub side effect.

## Examples

- `src/contracts/failure-stages.ts` — `PAGING_EXCLUDED_STAGES`, the classifier and the per-kind
  prefixes; every consumer interpolates the same list.
- `src/pipeline/consumer.ts` — the single tagging point before redaction, and the best-effort
  continuation-row write inside the degraded-delete block.
- `src/admin/index.ts` — the runtime read that reports the gauge (`null` on failure) and the 24 h
  count side by side with the admission-drop buckets.
- Tests that pin the shape: a `429` on delete increments only the primary kind; a `rate-limit` row
  never pages as a failure while the secondary count still sees it.
