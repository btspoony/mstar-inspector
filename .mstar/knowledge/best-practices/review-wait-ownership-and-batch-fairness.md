# Review-wait ownership and batch fairness

**Area:** review pipeline · Check recovery · `src/worker/check-reconcile.ts`

## The contract

`.mstar/specs/review-lifecycle.md` §7.11.2 states it in two steps, and both matter:

1. **Reacquire before doing anything.** Selection alone grants nothing; a due attempt is claimed with a conditional `UPDATE` that repeats the eligibility predicate and increments the epoch.
2. **A wait is a claim that is given straight back.** A row inside its execution deadline with no readable proof of the publication it owes takes the claim and releases it with `next_attempt_ms = now + CHECK_BACKOFF_MS[0]` — no send, no attempt spent.

The D1 lifecycle gate runs **before** the wait: a pair whose App is missing, soft-deleted or disabled, or whose installation mapping vanished, is suspended first.

## What breaks when the order is inverted

Running the wait-terminal short-circuit **before** `pairUnusableReason` looks like a pure saving (one probe instead of five statements) and silently loses two guarantees:

- a wait-terminal row on a disabled App no longer takes the durable suspension path, and
- nothing moves the row's due time, so it keeps its early sort key in `SELECT … ORDER BY COALESCE(next_attempt_ms, created_ms), id LIMIT 25`.

The second one is the dangerous half: with more wait-terminal rows than the batch limit, every pass re-reads the same head rows and a publishable attempt behind them is never examined. It is not a delay, it is an unbounded stall. Prove it by seeding `CHECK_RECONCILE_LIMIT + 1` wait-terminal rows ahead of one publishable row and asserting the publishable row appears in the next selection.

## Rules

- Keep the pair gate first for every due row inside its deadline; the wait comes after it.
- Never move `next_attempt_ms` without a claim you took: a bare `UPDATE` guarded only by `holder IS NULL` is not a fence, and two passes can overwrite each other's newer due time.
- If a helper's spec sentence says "the first backoff rung", do not widen it to an elapsed-indexed ladder without amending the spec. The widening is a latent recovery-latency regression: a proof that lands right after a probe waits a full rung.
- A cheap unclaimed write is a design smell in this lane, not an optimisation; each wait pass costs five statements by contract (gate, probe, claim UPDATE, claim read, fenced defer). If that cost is unacceptable, change the spec, not the ownership.

## Evidence trail

The baseline already ran the pair gate before the journal probe and the wait. What shipped is a regression test that locks that order: a wait-terminal row on a disabled App still suspends the pair. Two proposed shortcuts were reverted — an unclaimed due-time write and an elapsed-indexed widening ladder — and the batch-starvation and disabled-App suspension regressions now live in `tests/worker/check-reconcile-journal.test.ts`, where the wait cost is pinned at five own statements per pass.
