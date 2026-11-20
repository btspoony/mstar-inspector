# ADR: Separate renewable execution from short publication leases
Status: proposed — the two lease lifetimes and takeover boundary have not shipped
Spec: docs/specs/feature/review-lifecycle.md § 7.9 App-owned Check attempt fencing and conclusions

## Problem

A long review needs to retain exclusive execution ownership while waiting, but that wait should not reserve the right to mutate GitHub. A [Workflow wait or resume](https://developers.cloudflare.com/workflows/build/concurrency-limits/#how-per-workflow-concurrency-limits-are-applied) says nothing about whether the old executor can still act. See the [Check fencing boundary](../../../../docs/specs/feature/review-lifecycle.md#79-app-owned-check-attempt-fencing-and-conclusions).

## Proposal

Use a renewable, fenced execution lease to retain PR exclusion and capacity while the attempt is live, without extending its hard deadline. Use a separate short, fenced publication lease only when sending or recovering a GitHub mutation. Execution renewal must not block an otherwise-ready publication or determine the Check's conclusion.

A successor must have evidence that the old executor cannot act: the current fence rejects the old owner at both paid launch and GitHub send, and any already-running sandbox is confirmed stopped before execution capacity is reassigned. Lease expiry or Workflow silence is not that evidence. A GitHub request already sent is not canceled by the fence; reconcile its outcome before any further send.

## Alternatives considered

- **One fixed lease.** An execution longer than its fixed window necessarily outlasts it. Expiry can expose a still-running attempt to takeover, while sizing the same lease for the longest review makes publication recovery wait needlessly.
- **One renewable lease.** The same holder owns both execution and the publication window. A long, live run can therefore hold publication authority while it is still observing, even when someone else could safely publish or recover. The issue is who holds the publication window, not how quickly the lease renews.

## Acceptance criteria

- A long or suspended attempt retains execution ownership without monopolizing publication. An expired holder cannot start paid work or send a GitHub mutation after fencing, and capacity is not reassigned while its sandbox may still be running.
- With an ambiguous GitHub send, recovery reconciles the existing effect rather than resending blindly. A waiting live attempt does not get a false terminal Check, and an abandoned attempt can be settled without reopening a terminal Check.

## Risks

The two leases can expire independently. Reconciliation may delay capacity reuse or settlement while proof is missing, and local fencing cannot undo a request already accepted by GitHub (`docs/specs/feature/review-lifecycle.md:35,399–407`).

The PR author may see the Check stay in progress materially longer than the old round clock. Only the [operator's end-to-end cap](2026-11-21-review-duration-owned-by-operator.md) bounds that wait, not the publication lease. While the attempt is live the author sees an in-progress Check with no failure text; the [failure-status decision](2026-11-21-review-failure-user-facing-status.md) owns terminal wording.
