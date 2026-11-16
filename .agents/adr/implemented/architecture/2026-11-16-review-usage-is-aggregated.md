# ADR: Aggregate review usage from the review rows instead of an event log

Status: implemented — retrospective: the usage faces shipped in `9ca0d810` before this record was filed; the aggregation, its window and its attribution rule were settled while building them.
Spec: docs/specs/feature/bot-scope-and-claiming.md § Review usage

## Problem

Selling or capping a shared bot needs a number a tenant can check: how many reviews ran against the shared bot this month, and how many against the workspace's own bots. Two shapes were available — aggregate the `reviews` rows that already exist, or write an append-only `usage_events` log and count that.

The log looks safer because it is designed for accounting. It is also a second source of truth: every path that can produce a review would have to remember to append an event, and any path that forgets produces a number that silently disagrees with the reviews a tenant can see on screen.

## Decision

Usage is a read over `reviews`, joined through the existing target→bot attribution: `workspaces → review_targets → reviews → review_bots`, split by `review_bots.scope`, filtered to one UTC calendar month by `reviewed_at`.

- **One statement serves both faces.** The workspace card passes its own workspace id; the operator table passes null. There is no second implementation and no client-side sum.
- **A review with no `target_id` is out of both counts.** Since the target split backfilled `target_id` exactly where `bot_id` was present, such a row has no bot at all; attributing it to a workspace would be an invention. The counts therefore start at the split and say so.
- **Split by `scope`, not by workspace equality**, because a shared bot serving its own workspace is still shared.
- **`0062` adds `reviews(target_id, reviewed_at)` and `review_targets(workspace_id)`**, so the month drives the join instead of scanning a target's history.
- **The operator face returns every live workspace, unpaged.** The bound is the live workspace count; a future page is a new contract, never a silent truncation.

## Alternatives considered

**An `usage_events` table written at enqueue.** Rejected: two stores that can disagree, for a number nobody bills against yet. When billing arrives it needs the *money* event, which carries price and plan, not a bare count that can be re-derived.

**Counting `usage_events` that already exist for the member meter.** Rejected: those count attempts, not reviews, and the two labels would be read as agreeing.

**A rolling 30-day window.** Rejected: it cannot be reconciled against an invoice period or a tenant's own "this month" reading, and it makes every boundary row ambiguous.

**Falling back to the bot recorded on the row when `target_id` is null.** Rejected as unreachable — the backfill guarantees that case has no bot either. A fallback that can never fire reads as coverage and is not.

## Consequences

The number a tenant sees is the number of reviews they can list; no path can drift from it. A pre-split review is excluded rather than guessed, so early counts are understated by exactly the pre-split population — a fact the spec states instead of hiding.

`reviewed_at` is the review's completion instant, not its creation, so the copy must not be read as "reviews requested". Text comparison against `datetime('now')` output is what makes the month window cheap; a row written with a timezone offset would break it, and no writer does that.

The aggregation is read-only, so it adds no failure mode to the delivery path and cannot spend money. The cost is a join over the month's rows, bounded by `0062`.
