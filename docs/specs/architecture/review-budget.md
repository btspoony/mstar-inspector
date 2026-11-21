# Review budget — one derivation from the attempt's frozen deadline

## Scope

The attempt's one absolute deadline, the runner's wall-clock allocation inside it, the tier
ceilings, the per-tier size curve, and the typed `budget-exhausted` stop. The review lifecycle that
consumes these windows lives in [`review-lifecycle.md`](../feature/review-lifecycle.md).

## Current state

Owner module: `src/review-budget.ts`; status: implemented.

### One absolute deadline

An attempt's hard stop is ONE absolute instant, frozen when its delivery is first
admitted:

```
deadlineMs = enqueued_ms + capMs
```

`enqueued_ms` is the original Queue send stamp (the queue wait counts against
the cap) and `capMs` is the operator's end-to-end cap: the system row
`review.attempt.duration_cap_ms` in `review_runtime_settings`, whose absent-row
default is `1 200 000 ms` (20 minutes — see
[`docs/runtime-configuration.md`](../../runtime-configuration.md)). The instant
is recorded on the delivery's handoff row and written as the Check attempt row's
`execution_deadline_ms`, so a redelivery, a recovery replay and the independent
Check reconciler all read the same value. No step re-derives it, and a
present-but-untrusted cap leaves admission retryable instead of inventing one.

The Queue consumer's 900 000 ms invocation cap remains an **admission**
invariant — the guard TTL and the Check attach window derive from it — and no
longer bounds execution.

The runner budget is derived from that instant, never typed per tier:

```
reserveMs       = 90 000 (bounded output reads)
                + 12 000 (inline resolution)
                +  2 000 (Check begin)
                + 120 000 (Worker tail slack)
                + terminalizeMs            (live Check terminalize window, 1 000–30 000)
runnerCutoffMs  = deadlineMs − reserveMs
```

At the 20-minute default and the 10 000 ms terminalize default the reserve is
234 000 ms and the cutoff is 966 000 ms; at the supported 30 000 ms maximum it is
254 000 ms and the cutoff is 946 000 ms. The tier table below is unchanged: every
tier maximum fits inside the cutoff at each supported terminalize value.

The paid exec is started with the remaining time to its anchored instant
(`min(tier request, cutoff − anchor)`) and the sandbox's own timeout kills a hung
child there. A returned status (`124` included) is a confirmed stop and is
recorded as one; a lost reply is `unknown` — no Check conclusion, no destruction,
no capacity release.

| Tier | `tierMaxMs` | Guard TTL |
|------|-------------|-----------|
| `quick` | 480 000 | 2 292 s |
| `default` | 600 000 | 2 412 s |
| `deep` | 646 000 | 2 458 s |

### Allocation inside the tier

The diff size is known before the runner starts because the numstat is already read for the seat
partition. That size allocates the budget within the tier:

- One work unit per textual changed line, with a minimum of one unit per file.
- The floor is priced per tier by the seats that tier dispatches, never by one model call:
  `floor(tier) = 60 000 + PR_REVIEW_TIER_BUDGETS[tier].maxSeats × 220 000`, clamped to
  `tierMaxMs`. The 60 000 ms tail mirrors the runner's `PUBLICATION_TAIL_MS`. The 220 000 ms seat
  figure is measured, not a guess: over 30 days of successful reviews (n = 1 361) the round
  duration sat at p50 304 584 ms and p90 508 800 ms, so the earlier 150 000 ms price put the
  two-seat `default` floor at 360 000 ms — above the median round but below the p90, cutting
  into the slowest tenth of ordinary rounds. The observed failure was sharper still: one head
  was stopped at 362 s and then passed inside the same budget. The seat counts come from the
  engine table — quick 1, default 2, deep 4.
- `requestedMs = floor(tier) + floor((tierMax − floor(tier)) × min(units, 5 000) / 5 000)`.
- The resulting smallest allocations are quick 280 000, default 500 000 and deep 646 000 ms. `deep`
  dispatches four seats whose pre-clamp floor is 940 000 ms (four seat prices plus the 60 000 ms
  tail), above its 646 000 ms ceiling, so its floor clamps to the ceiling and its curve has no ramp.
- 5 000 work units is the saturation point: real PRs cluster at 100–1 000 changed lines, so the
  curve lifts them off their floor. The old 20 000-unit boundary reached them as well, but added
  only about 2.4–24 s across 100–1 000 units — too little to change what a round could finish.
- Unknown size (absent, malformed, truncated, non-safe-integer counts) requests `tierMaxMs`; it never
  shrinks a review.
- `parseNumstatSize` returns `{ changedLines, workUnits }` in one pass, or `null`. A non-empty stdout
  that does not end with a newline is treated as truncated, because the sandbox exec reports no
  truncation flag.
- An explicit request above `tierMaxMs` is refused as `oversized`, not clamped. A non-finite or
  non-positive request is refused as `invalid`.

### Exhaustion outcome

A wall-clock stop is a terminal execution outcome, **outside** the review verdict envelope.

| Field | Rule |
|-------|------|
| `kind` | `"budget-exhausted"` |
| `cause` | `runner-deadline` \| `consumer-deadline` \| `sandbox-kill` |
| `budgetWindow` | `runner` \| `preparation` |
| `tier`, `budgetMs` | Always present, from this attempt's derivation |
| `seatsDispatched`, `seatsStopped` | Required keys, nullable; only actual primary review seats and deadline stops are counted |
| `changedLines` | Required key, nullable; from the round's textual numstat, never the allocator's work units |

The runner reports, the Worker publishes:

- The runner emits an exit-0 stdout document `{ schema: "mstar.review-budget-exhausted/v1",
  seatsDispatched, seatsStopped }` with safe-integer counts and `0 <= stopped <= dispatched`. It
  never computes a tier budget or a Check conclusion. The Worker validates the document by exact
  schema literal and own keys.
- A positively identified cap stop decides its wave: it outranks a differently-failed sibling (whose
  loss is still reported), and a deadline stop outranks an earlier deep-parent yield.
- The Worker normalizes the runner signal, the consumer deadline refusal, the sandbox `124` kill,
  the anchor refusal and an expired execution deadline into the one typed outcome, and resolves it
  **before** verdict parsing, journal staging, any new review comment, recheck/resolve mutation and
  success bookkeeping.
- The outcome outranks a prior generation's same-head publication proof; the exhaustion attempt
  freezes its own Check intent and never rewrites an older Check or comment.
- The Check concludes `failure`. Full form when the runner window and all counters are observed:
  “Review budget exhausted: <tier> review stopped at <budget>s with <seatsStopped>/<seatsDispatched>
  seats stopped before finishing (<changedLines> changed lines) — a time-budget failure, not a verdict
  on the PR; shrink the diff or use a tier whose ceiling covers it.” Short form when any counter is
  unobservable: “Review budget exhausted: <tier> review reached its <budget>s <budget window> budget
  (<cause>) — a time-budget failure, not a verdict on the PR; shrink the diff or use a tier whose
  ceiling covers it.” Neither form implies a rerun would succeed.
- A confirmed exhaustion is ACKed without another paid queue retry. The failure row carries only
  trusted budget fields and fixed diagnostics; provider stderr stays in the logs.
- `incomplete` keeps its narrower meaning: a run that published partial work under a healthy budget.

## Invariants

- Every tier maximum satisfies `tierMaxMs <= deadlineMs − reserveMs` at the documented absent-row
  cap for the whole supported `terminalizeMs` range. A test asserts it, so a table that advertises a
  budget the attempt cannot finish fails CI instead of shipping.
- A round's allocation is clamped by exactly one `min()`, inside `anchorRunnerBudget`; the tier
  table's own `deep` floor clamp (see Current state) is fixed derivation, not a per-round clamp. A
  second clamp at a call site is a defect: it makes an unreachable tier value look shipped.
- The tier `terminalizeMs` range has one owner — the operator-facing settings store; the derivation
  imports none of it, names the bounds in a comment, and the table test exercises both store
  endpoints. Widening the store's range past the shipped deep ceiling fails the proof, never drifts
  silently.
- The guard TTL is `ceil((tierMax + 14 × 120 000 + 12 000 + 120 000) / 1000)`, derived from the same
  budget. Admission retry rungs stay below their TTL with a cumulative sum above it.
- The allocation never reaches the admission windows: the guard TTL derives from the tier ceiling,
  and the Check row's lease IS the attempt's frozen deadline, so a small PR cannot shorten the
  window a retry or recovery needs.
- The deadline is written once: the admission handoff freezes it, a redelivery or a recovery
  re-enqueue replays it, and the Check row carries the same instant for the independent reconciler.
  A step that re-derives it, or a redelivery that refreshes it, is a defect.

## Where it lives

- `src/review-budget.ts` — the cap's read and structured warn, the derivation, constants and types
  above.
- `src/dashboard/runtime-config-store.ts` — the `review.attempt.duration_cap_ms` row's parse, the
  absent-row default and the degraded answer.
- `src/pipeline/consumer.ts` — freezes `deadlineMs` on the delivery's handoff row at admission.
- `src/pipeline/review-attempt-execution.ts` — derives each phase's windows from that instant and
  writes it as the Check row's `execution_deadline_ms`.
- `tests/pipeline/review-budget.test.ts` — the tier-table and allocation cases.
- `tests/pipeline/hard-stop.test.ts` — the container stop, the lost reply, the resume and the cap's
  read path.
- `docs/specs/architecture/review-budget.md` — this page.

## Change obligations

A change to the cap's read or absent-row default, the reserve ledger, the tier table, the per-tier
floors, the saturation point or the refusal vocabulary updates this page,
`docs/runtime-configuration.md` and `tests/pipeline/review-budget.test.ts` in the same change.

## Known limits

- The runner-side derivation of the `incomplete` verdict remains staged in the runner
  (`ENGINE-OWNED, STAGED HERE`); moving it into `@mstar-harness/engine` is not part of this
  implementation.
- A truncation exactly at a line boundary cannot be detected: the platform supplies no truncation
  flag.
- The cap's own terminal Check category (`cap stop`) and its customer wording are owned by the
  operator duration plan. Until that lands, an attempt that cannot start or finish inside the frozen
  deadline reports the existing `budget-exhausted` outcome, whose Check summary names the budget
  window rather than the cap.
- A cap set far above the admission guard TTL would outlive the row that serialises the PR. The
  documented range tops out at one hour, and the shipped guard TTLs (2 292–2 458 s) cover the
  20-minute default with the queue wait inside it.
