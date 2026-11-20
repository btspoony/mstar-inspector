# ADR: Run the paid review step at most once per attempt
Status: proposed — the paid-step replay and result-durability boundaries have not shipped
Spec: docs/specs/feature/review-lifecycle.md § 7.7 Publication journal, complete payload and crash recovery

## Problem

A provider can accept and charge for work before the Workflow receives or checkpoints the result. Replaying the [step body](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/#retry-steps) can then buy the same work twice. The [review lifecycle's recovery section](../../../../docs/specs/feature/review-lifecycle.md#77-publication-journal-complete-payload-and-crash-recovery) covers recovery after the payload is durably persisted. This decision adds a fence on the launch side, before there is a durable result to recover. The linked section is the closest specification of the consumer-scoped behavior; this record extends that boundary across the Workflow step that runs the paid review.

## Proposal

Fence the paid launch by attempt and set the paid Workflow step's `retries.limit: 0` ([retry configuration](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/#retry-steps)). Persist the result, or an immutable reference to it, durably before confirming completion. Recovery retries may only attach to the same execution, observe it, or read its result. If acceptance is unknown, do not launch again within that attempt.

The user authorizes a new attempt by re-triggering the review through the [existing bot-mention comment path](../../../../docs/specs/feature/review-trigger-policy.md#3-bot-mention-comment-trigger-normative). An operator-initiated rerun takes the same path under the same authorization rules; a [Workflow restart](https://developers.cloudflare.com/workflows/build/workers-api/#restart) cannot bypass the launch fence.

The [failure-status decision](2026-11-21-review-failure-user-facing-status.md) owns user-facing wording, not the retry contract.

## Alternatives considered

- **Rely on provider idempotency.** This could make an ambiguous launch safe to repeat only if the provider honors the same operation identity. The current runner invocation exposes no such capability (`src/pipeline/consumer.ts:6117–6159`; [idempotent external calls](https://developers.cloudflare.com/workflows/build/rules-of-workflows/#ensure-apibinding-calls-are-idempotent)).
- **Shrink the retry unit.** Retrying one seat or a standalone “run model and save output” step reduces the work at risk, but still pays twice if the call was accepted and that smaller step failed before saving its result ([Workflow step granularity](https://developers.cloudflare.com/workflows/build/rules-of-workflows/#make-your-steps-granular)).

## Acceptance criteria

Losing the launch response or failing before the result is persisted cannot trigger a second paid launch for the same attempt, including after a restart. Once persisted, the result can be recovered without calling the model again, and no completion confirmation precedes durability.

## Risks

An ambiguous launch may never have reached the provider. Refusing to resend can therefore leave a review without a result even when nothing was charged. Conversely, if the original attempt was charged but the charge cannot be proven, a user-triggered new attempt may bill the same review twice. How the customer is billed in that case is unresolved and must be decided before the paid path ships.
