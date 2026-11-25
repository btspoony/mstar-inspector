# A review delivers what it found; the budget bounds the render

## The rule

The review budget exists to bound the model's rendering cycle, not to decide whether a task succeeds. A round that produced usable findings **delivers** them and states what it did not cover. Only a round with zero usable seat output is a failure.

Two consequences follow, and both are easy to get wrong:

1. **A partial round is a delivered round — for any seat loss, not just a cap stop.** Discarding completed seats because a sibling hit the cap *or* failed converts a real review into a platform failure and teaches authors to distrust the Check. The lost seat is named in the coverage block with its reason.
2. **Per-seat quotas manufacture failures.** Dividing a window across concurrent seats makes two slow seats die at half the ceiling. Give every seat the full tier ceiling, bounded only by the attempt's absolute deadline; a seat that finishes early simply stops competing.

**The Check still follows the review's verdict.** "Do not fail a task because it ran out of time" does not mean "pass a review that found blocking problems". A partial round whose verdict is blocked, or whose score is under the floor, concludes **failure** while still publishing its findings and its coverage statement. Otherwise a PR the review itself blocked could satisfy a required branch-protection Check.

**Delivery keys on usable output, not on a completed seat.** A seat cut by the cap still returns whatever payload it had collected, so a round whose every seat was cap-stopped can still have findings worth publishing — coverage then honestly says `0/2`, and every stopped seat is named in `unreviewed`. A round with literally nothing usable is the failure case.

## What a seat must be given

A seat that never receives the diff cannot review it: it must infer the change by opening whole files, which makes cost independent of diff size and leaves the actual change unexamined. Pass the pinned diff snapshot and instruct the seat to read it first. Everything else in the prompt (reference documents, skill corpus) is a fixed cost that the diff never amortizes.

## The transport

A successful run of the quick/default path carries a `coverage` block beside its envelope:

```jsonc
"coverage": {
  "seatsTotal": 2, "seatsCompleted": 1,
  "stoppedReason": "cap" | "failed" | null,
  "unreviewed": [{ "seat": "changeset-1-src", "scope": ["src/a.ts"], "reason": "cap" }]
}
```

Two legal states only: full (`null`, empty `unreviewed`) and partial (non-null reason, one entry per missing seat, `unreviewed.length === seatsTotal - seatsCompleted`). A `"cap"` headline requires at least one `cap` entry and a `"failed"` headline forbids any; a block that contradicts itself is ignored rather than trusted. A round with `seatsCompleted: 0` carries no block — it failed, and a failure is not a coverage statement.

The deep tier emits **no** coverage: its parent dispatches domain seats through the task tool and cannot observe their completion, so "no `incomplete` fact" must never be read as "every seat finished".

One formatter renders the partial sentence, and both the published body and the Check summary use it verbatim — including Markdown-inert normalization of repository-controlled scope paths — so the two surfaces cannot disagree.

## Trace honesty

Every terminal stage must name what actually happened: a seat that failed is not `seat_done`; a report seat that never ran is not `report_start`; a rejected call is not `report_absent`. A trace that reports the last pre-work stage (`session_ready`) for every failure costs more debugging time than the feature saves.

## Where the numbers live

- Tier ceilings: `RUNNER_MAX_BUDGET_MS` (`packages/shared/src/runtime.ts`).
- Allocation and the absolute cutoff: `src/review-budget.ts` (one `min()`, one owner).
- Seat timing: `packages/runner/src/runtime-omp.ts` (`seatDeadlineMs`); the clock starts at the first completed assistant message, not the SDK's initial `running` snapshot.

## Evidence discipline

A test for this area must fail when the behaviour is reverted. Assertions that re-derive the expected value from the same function under test, or that run at timings far from the boundary, pass whether or not the fix exists.
