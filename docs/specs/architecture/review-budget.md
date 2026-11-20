# Review budget — one derivation from the platform cap

## Scope

The runner's per-round wall-clock allocation and its exhaustion outcome: the round clock, the tier
ceilings, the per-tier size curve, and the typed `budget-exhausted` stop. The review lifecycle that
consumes these windows lives in [`review-lifecycle.md`](../feature/review-lifecycle.md).

## Current state

Owner module: `src/review-budget.ts`; status: implemented.

### One round clock

A Cloudflare Queue consumer invocation is capped at 900 000 ms (platform limit, not configurable).
One review runs inside one message (`max_batch_size: 1`), so that cap is the round clock.

The runner budget is derived, never typed per tier:

```
reserveMs      = 90 000 (bounded output reads)
               + 12 000 (inline resolution)
               +  2 000 (Check begin)
               + 120 000 (Worker tail slack)
               + terminalizeMs            (live Check terminalize window, 1 000–30 000)
runnerCeilingMs = 900 000 − reserveMs
```

`reserveMs` is 234 000 ms at the 10 000 ms default, so the ceiling is 666 000 ms; at the supported
30 000 ms maximum it is 254 000 ms and the ceiling is 646 000 ms.

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
  `floor(tier) = 60 000 + PR_REVIEW_TIER_BUDGETS[tier].maxSeats × 150 000`, clamped to
  `tierMaxMs`. The 60 000 ms tail mirrors the runner's `PUBLICATION_TAIL_MS`; the 150 000 ms seat
  figure is the observed 280 s two-seat round (staging PR #334) plus headroom, not a guess. The seat
  counts come from the engine table — quick 1, default 2, deep 4.
- `requestedMs = floor(tier) + floor((tierMax − floor(tier)) × min(units, 5 000) / 5 000)`.
- The resulting smallest allocations are quick 210 000, default 360 000 and deep 646 000 ms. `deep`
  dispatches four seats whose seat price is 660 000 ms, above its 646 000 ms ceiling, so its floor
  clamps to the ceiling and its curve has no ramp.
- 5 000 work units is the saturation point: real PRs cluster at 100–1 000 changed lines, so the
  curve lifts them off their floor; the documented 20 000-line GitHub boundary never did.
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

- Every tier maximum satisfies `tierMaxMs <= runnerCeilingMs` for the whole supported
  `terminalizeMs` range. A test asserts it, so a table that advertises a budget the consumer cannot
  finish fails CI instead of shipping.
- A round's allocation is clamped by exactly one `min()`, inside `anchorRunnerBudget`; the tier
  table's own `deep` floor clamp (see Current state) is fixed derivation, not a per-round clamp. A
  second clamp at a call site is a defect: it makes an unreachable tier value look shipped.
- The tier `terminalizeMs` range has one owner — the operator-facing settings store; the derivation
  imports none of it, names the bounds in a comment, and the table test exercises both store
  endpoints. Widening the store's range past the shipped deep ceiling fails the proof, never drifts
  silently.
- The guard TTL is `ceil((tierMax + 14 × 120 000 + 12 000 + 120 000) / 1000)`, derived from the same
  budget. Admission retry rungs stay below their TTL with a cumulative sum above it.
- The allocation never reaches the admission windows: guard TTL and the Check lease derive from the
  ceiling, so a small PR cannot shorten the window a retry or recovery needs.

## Where it lives

- `src/review-budget.ts` — the derivation, constants and types above.
- `tests/pipeline/review-budget.test.ts` — the tier-table and allocation cases.
- `docs/specs/architecture/review-budget.md` — this page.

## Change obligations

A change to the platform cap, the reserve ledger, the tier table, the per-tier floors, the
saturation point or the refusal vocabulary updates this page and
`tests/pipeline/review-budget.test.ts` in the same change.

## Known limits

- The runner-side derivation of the `incomplete` verdict remains staged in the runner
  (`ENGINE-OWNED, STAGED HERE`); moving it into `@mstar-harness/engine` is not part of this
  implementation.
- A truncation exactly at a line boundary cannot be detected: the platform supplies no truncation
  flag.
- A review that cannot finish even at the ceiling needs a Workflow or Durable Object handoff; the
  budget derivation deliberately stops at the honest ceiling instead of advertising more.
