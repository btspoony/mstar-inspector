# KV claim stamps have no CAS — writes are owner-exclusive

KV (Workers KV) offers no compare-and-swap. A queued sentinel (`"1"`) is shared by every delivery of the same head, so a stale writer cannot distinguish its own generation's sentinel from a fresh delivery's. Any routine that "repairs" or re-stamps a head-wide claim key after re-reading D1 state can therefore overwrite a **newer delivery's** claim: the repair read sees a still-unsettled row, pauses, a fresh webhook enqueues and writes `"1"`, and the resumed writer replaces it with the old attempt's `"failed"` — letting a later webhook bypass duplicate suppression for work already queued.

## Rule

A head-wide KV claim mutation is allowed only by the pass that can prove ownership — concretely, the pass whose D1 insert landed the record (`meta.changes > 0` on the attempt-keyed `INSERT ... ON CONFLICT DO NOTHING`). Every other pass (insert losers, repair-shaped passes, passes after any D1 fault) writes **nothing** to that key. A settled row must never be re-stamped, and an unsettled row is not proof the stamp is still owed (an open Check can keep it incomplete after the claim lands).

## Consequences (accepted, documented)

- A pass whose KV write faults leaves the stamp owed forever: no later pass can prove ownership, so the stale sentinel suppresses same-head admission until the 24-hour sentinel TTL expires. The durable failure row still records the outcome; this is an availability/latency residual, not a correctness one (`I-000688`).
- The recovery selector must not let such permanently non-actionable rows monopolize its bounded oldest-first batch.

Proven in `workflow-budget-recovery` (v1.24): three QC rounds converged on this rule after sequential re-reads and "repair if unstamped" variants both failed interleaving review. Regression pattern: hold the losing pass inside its KV read, let the owner settle and a fresh webhook claim the head, release, assert the fresh sentinel survives. See `src/contracts/idem.ts` (`written | done | unreadable`) and `src/pipeline/route-reconcile.ts`.
