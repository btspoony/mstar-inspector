# ADR: De-bounce the sweep's alerts on an audit window, not a latch row

Status: implemented — the paging lane shipped in `807f9499` and the maintenance lane in
`a2563f3f`; both replaced an earlier single-row latch that never converged under review.
Spec: docs/deploy.md § Cron failure sweep

## Problem

The 15-minute sweep posts a webhook when the trailing-window failure count crosses a threshold.
A breach that persists must not re-post on every sweep, which needs some cross-sweep state.
The first shape used `review_runtime_settings['platform.alert.failure_paging']` as a latch:
read it, post on the crossing, write it after a 2xx, delete it on a healthy window.

Seven review rounds found a new race in every version of that state machine: an older sweep's
late write clobbering a recovery, a read failure making a stale row un-retryable, a clock-ahead
stamp suppressing the next window, a malformed value blocking repair, generation rollback on an
unconditional rearm. Each was real and each fix moved the problem rather than closing it — a
single mutable row read and written by overlapping schedulers is a distributed state machine,
and the sweep has no lock, no leader and no transactional read-modify-write.

## Decision

The de-bounce is a **read of what was already delivered**, not a state to maintain.

- Before posting, the sweep reads `MAX(created_at)` of the lane's audit action
  (`alert.failure_paging` / `alert.maintenance_deferred`) in `platform_audit_events`.
- A stamp that is strictly in the past and inside `SWEEP_WINDOW_HOURS` suppresses this post.
  A stamp ahead of the reader is ignored (it cannot be evidence of a delivery), and an
  unreadable read never suppresses.
- After a 2xx the sweep appends one audit row with the lane's action. A failed append is logged
  and changes nothing about the POST outcome.
- Nothing is latched and nothing is cleared. A healthy window writes nothing.

The only failure mode left is **duplicate**: two overlapping sweeps that both see no recent row
may both post once. A missed alert is structurally impossible on that path. The project's
alerting contract already prefers that direction.

## Alternatives considered

**A latch row (the original design).** Rejected after seven rounds: every variant needs an
atomic read-modify-write across schedulers that the platform does not provide. Its failure
direction was a silent miss, which is the wrong direction for an ops alert.

**A durable outbox row per breach.** Rejected: it is the same mutable state with more columns,
and it adds a delivery worker to a lane whose payload is one webhook POST.

**A cooldown tunable.** Rejected as a second de-bounce knob with no proof it fixes anything the
window read does not: the window already bounds posting to one per window.

**A derived "last alert" from webhook logs.** Rejected: those logs are redacted, retained by an
external policy and not queryable transactionally; the platform audit ledger already exists for
this purpose.

## Consequences

- De-bounce cost is one indexed `MAX()` read per lane per sweep, plus one insert per delivered
  alert. No delete path, so no repair job.
- The runbook must state the one remaining loss path: a hand-edited or clock-ahead audit row is
  ignored while it is ahead, then read as a delivery once the clock passes it; deleting or
  re-stamping that row is the operator repair.
- Concurrent duplication is accepted and documented; the receiver must tolerate two identical
  alerts inside one window.
