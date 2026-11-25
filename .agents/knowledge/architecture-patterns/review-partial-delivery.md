# A review delivers what it found; the budget bounds the render

## The rule

The review budget exists to bound the model's rendering cycle, not to decide whether a task succeeds. A round that produced usable findings **delivers** them, states what it did not cover, and passes its Check. Only a round with zero usable seat output is a failure.

Two consequences follow, and both are easy to get wrong:

1. **A partial round is a delivered round.** Discarding completed seats because a sibling hit the cap converts a real review into a platform failure and teaches authors to distrust the Check.
2. **Per-seat quotas manufacture failures.** Dividing a window across concurrent seats makes two slow seats die at half the ceiling. Give every seat the full tier ceiling, bounded only by the attempt's absolute deadline; a seat that finishes early simply stops competing.

## What a seat must be given

A seat that never receives the diff cannot review it: it must infer the change by opening whole files, which makes cost independent of diff size and leaves the actual change unexamined. Pass the pinned diff snapshot and instruct the seat to read it first. Everything else in the prompt (reference documents, skill corpus) is a fixed cost that the diff never amortizes.

## The transport

A successful run carries a `coverage` block beside its envelope:

```jsonc
"coverage": {
  "seatsTotal": 2, "seatsCompleted": 1,
  "stoppedReason": "cap" | null,
  "unreviewed": [{ "seat": "correctness", "scope": ["src/a.ts"] }]
}
```

Two legal states only: full (`stoppedReason: null`, empty `unreviewed`) and partial (`"cap"`, one entry per missing seat). A block that contradicts itself is ignored rather than trusted; a block with `seatsCompleted: 0` is absent because that round has nothing to deliver.

One formatter renders the partial sentence, and both the published body and the Check summary use it verbatim — including the normalization applied to repository-controlled scope text — so the two surfaces cannot disagree.

## Trace honesty

Every terminal stage must name what actually happened: a seat that failed is not `seat_done`; a report seat that never ran is not `report_start`; a rejected call is not `report_absent`. A trace that reports the last pre-work stage (`session_ready`) for every failure costs more debugging time than the feature saves.

## Where the numbers live

- Tier ceilings: `RUNNER_MAX_BUDGET_MS` (`packages/shared/src/runtime.ts`).
- Allocation and the absolute cutoff: `src/review-budget.ts` (one `min()`, one owner).
- Seat timing: `packages/runner/src/runtime-omp.ts` (`seatDeadlineMs`); the clock starts at the first completed assistant message, not the SDK's initial `running` snapshot.

## Evidence discipline

A test for this area must fail when the behaviour is reverted. Assertions that re-derive the expected value from the same function under test, or that run at timings far from the boundary, pass whether or not the fix exists.
