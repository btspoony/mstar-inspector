---
module: review-checks
date: 2026-11-06
last_updated: 2026-11-11
problem_type: best_practice
category: best-practices
severity: high
topic: check conclusion and publication proof
tags:
  - check-runs
  - publication-proof
  - attribution
  - queue-consumer
  - d1
---

# A terminal conclusion needs attempt-owned proof

## Pair

Every fast-path version of the review-Check wait (plan 313, 2026-11-06, commits `36a633cc`,
`f5164a99`, `2488f1fa`, `d1981eb0`) was falsified by a writer-side fact. The shipped rule is:
the wait ends only on a readable persisted publication proof or the execution deadline.

- Bug: `reviewCanStillPublish` ended a Check's publication wait early from head-matched rows.
- Fix: `src/worker/check-reconcile.ts` keeps waiting unless `probePendingPublication` sees an
  open journal row or `readProof` returns a proof; past `execution_deadline_ms` the honest
  unconfirmed failure stands.
- Paired assertion: `tests/worker/check-reconcile.test.ts` — "a reviews row from an EARLIER
  attempt never ends the wait", "an admission-drop row never ends the wait", "a parse-stage
  failure row is NOT terminal"; each fails against its falsified predicate.

## Rule

A state machine may reach a terminal conclusion only from a persisted fact that the CURRENT
attempt wrote, or that is bound to the current attempt's identity. A row matched by business
keys (head SHA, PR number) is not such a fact when the same keys can be re-triggered.

Three writer-side facts defeat head-matched early exits, and each was found only by reading
the writer, never by reviewing the reader:

1. **A stage's name can lie about its side effects.** The parse-failure path records its
   failure row and then still publishes the degraded comment. "parse" reads as terminal; the
   writer says otherwise (`consumer.ts` degrade branch).
2. **Ack-before-record removes ordering guarantees.** The terminal drop acks the queue message
   first and writes its failure row best-effort afterwards; the row can land after a newer
   attempt already exists (`handleGuardHeld`: `message.ack()` then `failureStore.record`).
3. **Shared business keys are not identity.** `review_failures` and `reviews` carry no attempt
   id, and `created_at` has second granularity — neither a head match nor a time window can
   attribute a row to this attempt on a same-SHA re-trigger.

## Traps

- **Reviewing the reader, not the writer.** Three review rounds approved reader-side
  predicates that the writer's own code falsified. The reviewer must read the writer of every
  table the predicate consults, in the same pass.
- **"Terminal" as a stage label.** Whether a failure stage prevents a later publication is a
  property of the writer's control flow, not of the stage name.
- **Time windows as attribution.** A coarse timestamp column can at best bound a window; it
  cannot attribute. A same-second boundary is an accepted ceiling only when the misplaced
  writer provably cannot exist (it can here).
- **Letting tests drive the state.** The first reconciler tests hand-froze the old-style
  intent, so the unreachable-in-production path stayed green. Produce the state through the
  real production entry point (the abandonment path), or the test proves nothing.

## Consequence to accept

Without a trustworthy early signal, a dropped or degraded attempt waits out its full execution
deadline before turning red. That is the honest cost: a bounded late red is correct; an early
red that later proves wrong is not.

## Cross-references

- Complements `finding-fingerprint-identity.md` (identity of findings vs identity of attempts).
- Writer-side examples: `src/pipeline/consumer.ts` `handleGuardHeld` (ack-then-record) and the
  parse degrade branch (record-then-publish); `src/store/review-checks.ts` recovery selector.

## The journal handoff: link the publication, release the attempt

A handoff happens when a delivery finds an existing publication row for the same head: this
attempt claimed a Check but staged nothing itself. Two rules keep the conclusion honest:

- **Link, do not conclude.** Persist this attempt's `publication_id` link to the attributed row and
  release the attempt (`remote-unconfirmed`). Calling `terminalize` here freezes a conclusion and,
  when a remote run exists, completes it; the terminal write then blocks any later proof from
  correcting the row. A link-only write leaves `desired` at `in_progress` and issues no request.
- **The wait ends on a linked applied proof, or the deadline.** With the link in place the reconciler
  reads exactly that publication: an applied proof plus the gate decide `success`, and the deadline
  decides a `failure` naming the missing evidence (no staged row / proof never landed / proof
  unreadable).

**The attribution floor is not an authorship claim.** The reconciler admits a same-head journal row
written after the attempt was admitted (`updated_ms >= attempt.created_at`). That is a heuristic
about *which row can end the wait*, because the writer reuses one row per scope/head/kind. What it
admits is still only a journal row: without an applied proof the wait defers — an earlier
generation's bare claim decides nothing — and at the deadline the attempt fails closed. When the
admitted row does carry an applied proof, concluding from it is the honest result for that commit.
That rests on the journal's own storage rule, not on the timestamp: `stagePublication` inserts with
`ON CONFLICT DO NOTHING` and the conflicting path returns the **existing immutable payload**
(`src/store/finding-lifecycle.ts`), so one scope/head/kind keeps exactly one recorded result and a
later generation cannot replace it. The row a later attempt reads is therefore the commit's recorded
outcome, not a race winner. Do not promote the floor into "this attempt wrote it", do not assume a
later publication overwrites an earlier one, and do not replace the floor with a head-only fallback.

A different-verdict sequence is the case to test: an earlier generation's applied payload decides
the later, unlinked attempt exactly as it decided its own round — the later attempt cannot publish a
second payload for the same head. A test that only covers the pass case would hide this.

The cost stays explicit: an attempt whose publication is still unproven waits out its execution
deadline, then turns red with a named cause. That bounded late red is correct; an early red that a
later proof contradicts is not.

The sibling question for failure text: a durable failure row may name only state the process observed, and it must be composed under a budget the producer owns - see `bounded-failure-text-in-a-log-tail.md`.
