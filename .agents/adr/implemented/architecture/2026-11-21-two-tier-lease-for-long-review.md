# ADR: Separate renewable execution from short publication leases

Status: implemented — the attempt's execution lease and the per-action `publication_leases` row are separate epoch-fenced records, and neither is evidence for the other
Spec: docs/specs/feature/review-lifecycle.md § 7.9 App-owned Check attempt fencing and conclusions

## Problem

A long review needs to retain exclusive execution ownership while waiting, but that wait should not reserve the right to mutate GitHub. A [Workflow wait or resume](https://developers.cloudflare.com/workflows/build/concurrency-limits/#how-per-workflow-concurrency-limits-are-applied) says nothing about whether the old executor can still act. See the [Check fencing boundary](../../../../docs/specs/feature/review-lifecycle.md#79-app-owned-check-attempt-fencing-and-conclusions).

## Decision

A renewable, fenced execution lease retains PR exclusion and capacity while the attempt is live, without extending its hard deadline. A separate short, fenced publication lease is taken only when sending or recovering a GitHub mutation. Execution renewal does not block an otherwise-ready publication and does not determine the Check's conclusion.

The two are literally two records. The execution lease is the attempt row's own `(holder, lease_epoch, lease_until_ms)`, renewed as `MAX(lease_until, MIN(now + CHECK_LEASE_MS, execution_deadline_ms))`. The publication lease is its own `(attempt_id, action_key)` row (`migrations/0092_publication_leases.sql`) with a fixed 120,000 ms non-renewable window, claimed by one conditional statement that takes only a free or expired row and increments `lease_epoch`; `action_key` is the durable mutation identity (`check:complete`, `comment:<id>`), and `mode` (`send` / `recover`) is deliberately not part of the key.

A successor must have evidence that the old executor cannot act: the current fence rejects the old owner at both paid launch and GitHub send, and any already-running sandbox is confirmed stopped before execution capacity is reassigned. Lease expiry or Workflow silence is not that evidence. A GitHub request already sent is not canceled by the fence; its outcome is reconciled before any further send.

## Alternatives considered

- **One fixed lease.** An execution longer than its fixed window necessarily outlasts it. Expiry can expose a still-running attempt to takeover, while sizing the same lease for the longest review makes publication recovery wait needlessly.
- **One renewable lease.** The same holder owns both execution and the publication window. A long, live run can therefore hold publication authority while it is still observing, even when someone else could safely publish or recover. The issue is who holds the publication window, not how quickly the lease renews.

## Consequences

- A long attempt retains execution ownership without monopolising publication — `tests/pipeline/lease-tiers.test.ts`, "a publication acquisition succeeds while execution is held; releasing execution keeps it held".
- Renewal cannot extend the execution deadline — `lease-tiers.test.ts`, "renewal re-stamps the window and leaves execution_deadline_ms byte-identical".
- An expired holder cannot act after fencing — `lease-tiers.test.ts`, "a delayed renewal whose epoch has moved is refused, not renewed onto the newer lease" and "a delayed claim cannot read a later same-holder acquisition as its own".
- `send` and `recover` contend on one key so no mode bypasses a live holder — `lease-tiers.test.ts`, "send and recover contend on one action key; distinct actions do not".
- Releasing a publication lease leaves execution and the Check untouched — `lease-tiers.test.ts`, "releasing a publication lease leaves execution and the Check row untouched".
- The publication lease exists as its own record — `migrations/0092_publication_leases.sql`.

## Risks

The two leases expire independently. Reconciliation may delay capacity reuse or settlement while proof is missing, and local fencing cannot undo a request already accepted by GitHub (`docs/specs/feature/review-lifecycle.md:35,399–407`).

The PR author may see the Check stay in progress materially longer than the old round clock. Only the [operator's end-to-end cap](2026-11-21-review-duration-owned-by-operator.md) bounds that wait, not the publication lease. While the attempt is live the author sees an in-progress Check with no failure text; the [failure-status decision](2026-11-21-review-failure-user-facing-status.md) owns terminal wording.
