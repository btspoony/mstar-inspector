---
title: Bounded background sweeps
type: best-practice
status: active
last_updated: 2026-10-26
tags: [d1, cron, sweep, performance]
---

# Bounded background sweeps

A sweeper that runs on a cron is bounded only when four things hold **at once**. Any three
still let a run cost unbounded work or starve rows forever.

1. **A narrow predicate.** `status = 'pending' AND expires_at <= ?` selects candidates; a
   partial index over exactly that predicate keeps the scan to the candidate set.
2. **A limit per run.** `LIMIT ?` caps how many rows one run touches.
3. **A stable order.** `ORDER BY expires_at, id LIMIT ?` is what makes the cap *fair*. Without
   it the cap selects an arbitrary subset, and a steady inflow of newer rows can keep older
   ones pending indefinitely — the run is cheap and the backlog still never drains.
4. **An index that matches the order and the predicate.** `(expires_at, id) WHERE status =
   'pending'` turns the ordered slice into a range seek. With `(expires_at)` alone SQLite sorts
   every matched row (`USE TEMP B-TREE FOR LAST TERM OF ORDER BY`); with no expiry column the
   plan falls back to a full scan of the pending set even when zero rows flip.

## Counter truth

Return the driver's real `meta.changes` for the sweep statement, not a computed expectation. A
computed number reports what the code *meant* to do; the driver reports what it did. `null`
(not `0`) marks "the statement failed and was warn-logged", so a later reader can tell
"nothing to do" from "did not run".

## Proving it

A fixed backlog test cannot prove fairness — it drains under any order. Two tests are needed:

- **Drain**: a backlog larger than one run's cap reaches zero across successive runs, with
  every row ending in the terminal state and no row lost.
- **Fairness under inflow**: seed one oldest row whose identifier sorts *last*, then feed
  cap-sized cohorts of newer rows between runs; the oldest row must be flipped first and the
  backlog must stay at or below the cap while inflow continues.

Adding the index without the order (or the order without the index) still passes a naive
drain test, so each half needs its own negative control.
