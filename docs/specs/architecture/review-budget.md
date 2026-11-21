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
invariant — the guard TTL's FLOOR and the Check attach window derive from it —
and no longer bounds execution; the guard row itself is widened to the frozen
deadline below.

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
child there. That bound is taken at the LAST possible instant — after the
one-way launch claim succeeds, because the claim is a D1 round trip inside the
attempt's clock — and a window the claim spent refuses the exec instead of
issuing a zero-length one. The guarded request carries that instant as an
absolute epoch, never a duration: the container's OWN SHELL computes the bound
immediately before it starts the command (`remaining = deadline − date +%s`) and
reserves the 5 s SIGKILL grace — SIGTERM at `deadline − 5 s`, SIGKILL at the
deadline. A remainder at or below the grace exits 124 without starting
anything, which is the same confirmed cap stop. A relative `timeout` restarts
when the process starts, so no host-side number can be absolute; the DO's early
`deadline-spent` answer is only a fast path. A returned status (`124` included) is a confirmed stop and is recorded
as one; a lost reply is `unknown` — no Check conclusion, no destruction, no
capacity release.

A handoff row written before the deadline column existed carries
`deadline_ms = NULL`. It means "not yet anchored": the next admission anchors
it ONCE from that row's own `created_ms` (the only instant the attempt actually
had) and the store's conditional write makes the first writer win, so every
delivery of that attempt reads the same instant. A row that is still unanchored
after that write refuses to run.

| Tier | `tierMaxMs` | Guard TTL floor |
|------|-------------|-------------------|
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
- The guard TTL's FLOOR is `ceil((tierMax + 14 × 120 000 + 12 000 + 120 000) / 1000)`, derived from
  the tier ceiling. The row taken for one attempt is
  `max(floor, ceil((deadline − now) / 1000) + 60)`, so an operator cap above the level ceiling can
  never let the row that serialises the PR expire before the attempt's own stop.
- The allocation never reaches the admission windows: the guard TTL is widened to the attempt's
  frozen deadline (never shortened by a small PR), and the Check row's lease IS that same deadline.
- The deadline is written once: the admission handoff freezes it, a redelivery or a recovery
  re-enqueue replays it, and the Check row carries the same instant for the independent reconciler.
  A step that re-derives it, or a redelivery that refreshes it, is a defect.

## Deployment gate — the review route

The Workflow route (`src/workflow/review.ts`, handed off by the queue consumer) is
wired as the production queue path, and this page is where an operator reads what
must hold before it carries real deliveries. **Do not enable the route for real
traffic until every claim below holds with its test.** The route is proven only
by interruption tests: each one simulates the interruption or the lying signal
it names, and each one failed against the code before this gate was written
(except claim 6, which already held and is pinned so a later change cannot
regress it).

| # | Recovery claim | Test |
|---|---|---|
| 1 | A comment delivery whose claim was already consumed is still recoverable: a redelivery that finds an `owed`/`ambiguous`/`failed` handoff reaches create, and an interruption between consuming the claim and writing the handoff leaves a row the reconciler hands back. | `tests/pipeline/route-recovery-handoff.test.ts` — all three cases |
| 2 | The settle-once mark proves **completion**, not entry: a host killed inside the settlement leaves no mark and the resumed run settles; a completed settlement is not repeated; one transient error is retried. | `tests/pipeline/route-recovery-settlement.test.ts` — all four cases |
| 3 | The successor outbox row exists **before** the moved-head settlement that terminalizes the old Check, so an interruption leaves an owed row rather than nothing. | `tests/pipeline/route-recovery-successor.test.ts` — both claim-3 cases |
| 4 | The successor dedupe key fences sends and identifies its owner (App/target, observed head, originating delivery); the stored winning payload is what gets sent; a replay of one intent admits once. | `tests/pipeline/route-recovery-successor.test.ts` — both claim-4 cases |
| 5 | Error classification carries proof: a `TypeError` is not evidence a create did not land, and "already exists" is not evidence the same instance exists — this attempt's own instance id is read back, or the outcome is unknown. | `tests/pipeline/route-recovery-handoff.test.ts` — all three claim-5 cases |
| 6 | The paid call cannot start or end past the frozen instant when the request queues or the marker proof takes time: the remaining window is re-derived inside the container, kill grace subtracted. | `tests/pipeline/route-recovery-deadline.test.ts` — both claim-6 cases |
| 7 | The guard window and the attempt's instant come from **one** settled value, including a legacy row anchored concurrently by two callers. | `tests/pipeline/route-recovery-deadline.test.ts` — the claim-7 case |
| 8 | A widened guard never ack-and-forgets a queued retry (the drop records the retry the reconciler owes), and while a paid exec's state is unknown the PR and its capacity are not reassigned. | `tests/pipeline/route-recovery-guard.test.ts` — all three cases |
| 9 | A container suspended between reading its clock and starting the bounded command cannot start the paid command after the deadline (`date` blocked past the instant). | `tests/pipeline/route-recovery-deadline.test.ts` — the claim-9 case |

**What these tests cannot prove, and must be observed on the platform before
enabling.** The tests own the database, the clock and the command line; they do
not own Cloudflare's behaviour. Before the route carries real deliveries:

- a Workflow **step** that was interrupted mid-callback re-executes its callback
  on resume (claims 2 and 3 assume this, and that a completed step's result is
  not re-run);
- `step.do` **retries** honour the declared `retries.limit` (claim 2's transient
  case is a model of that policy, not the platform's implementation);
- `Workflow.get(id).status()` **rejects** for an id that has no instance
  (claim 5's proof reads that answer; if it synthesizes a status, the probe
  confirms nothing);
- a queue **redelivery** preserves the message body (the delivery key depends on
  it) and a re-enqueue is at-least-once;
- the container's shell and GNU `timeout` behave as the image pins them.

**Accepted residual (claim 9).** A suspension strictly between the *final* clock
sample and `exec timeout` still hands the child a duration computed before the
freeze. No shell can close that gap — it needs a kernel-side watchdog the
sandbox SDK does not expose — and it is now a few syscalls wide instead of the
whole request. The claim-9 test proves the observable half: a stale sample can
no longer start the paid command after the deadline. If the platform later
exposes a kernel-side deadline, the wrapper's second sample is what it replaces.

## Where it lives

- `src/review-budget.ts` — the cap's read and structured warn, the derivation, constants and types
  above.
- `src/dashboard/runtime-config-store.ts` — the `review.attempt.duration_cap_ms` row's parse, the
  absent-row default and the degraded answer.
- `src/pipeline/consumer.ts` — freezes `deadlineMs` on the delivery's handoff row at admission, extends
  the lease to that settled value, and records a terminal guard drop as an owed retry.
- `src/store/review-route-store.ts` — the handoff, settle-once (completion) mark, successor outbox and
  the comment-claim payload lifecycle the recovery pass replays.
- `src/pipeline/route-reconcile.ts` — the pass that delivers what an interrupted host left owed:
  successors, unconfirmed handoffs and orphaned comment claims.
- `src/workflow/review.ts` — the five durable phases, the settlement step and the successor step.
- `src/store/inflight-store.ts` — the guard row; an expired row whose paid state is unknown holds the
  PR and its capacity until a fact says the paid process stopped.
- `src/pipeline/review-attempt-execution.ts` — derives each phase's windows from that instant and
  writes it as the Check row's `execution_deadline_ms`; writes the moved-head successor intent before
  it terminalizes the old Check; marks a settlement complete only at its own end.
- `src/pipeline/review-attempt.ts` — takes the exec bound after the launch claim, at the last instant
  before the send, and carries it into the container as an absolute epoch.
- `src/pipeline/sandbox.ts` — hands the epoch to the container's shell, which re-derives the bound
  from a fresh clock sample and reserves the kill grace out of it.
- `tests/pipeline/review-budget.test.ts` — the tier-table and allocation cases.
- `tests/pipeline/hard-stop.test.ts` — the container stop, the lost reply, the resume and the cap's
  read path.
- `tests/pipeline/route-recovery-*.test.ts` — the nine recovery claims above, one file per claim group.
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
- A delivery the guard refuses is retried on the level's ladder, which is sized against the level's
  TTL floor. With an operator cap above that floor the live row can outlast the ladder, so the last
  retry is ack-recorded as held rather than reclaiming the row — never a second execution. That drop
  is not the end of the obligation: it is recorded once per delivery in the successor outbox, and the
  route's recovery pass re-enqueues it after the guard has had time to release (claim 8).
