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
