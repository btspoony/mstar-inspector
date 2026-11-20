# ADR: Keep a container hard stop and decide continuation from durable progress
Status: proposed — the deadline authority split has been chosen but has not shipped
Spec: docs/specs/architecture/review-budget.md § Exhaustion outcome

## Problem

An orchestrator can lose contact during a blocking paid call. Losing the reply, or reaching the [Workflow step timeout](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/#retry-steps), does not prove that the runner stopped or reached the [review budget exhaustion boundary](../../../../docs/specs/architecture/review-budget.md#exhaustion-outcome).

## Proposal

Keep one absolute hard stop in the container across waits and recovery. The Workflow decides whether to continue only at durable progress boundaries. The existing `deep` whole-wave stop and exhaustion precedence in the [budget spec](../../../../docs/specs/architecture/review-budget.md#exhaustion-outcome) remain constraints.

A confirmed hard stop is an expected platform decision with its own approved Check summary wording, not a generic fault; see the [failure-status decision](2026-11-21-review-failure-user-facing-status.md).

## Alternatives considered

- **Workflow-only absolute instant.** The Workflow can anchor a deadline but cannot observe the runner's live progress or outcome mid-run through the blocking call (`src/pipeline/consumer.ts:6140–6159`). Its own timeout is not proof that the container obeyed the deadline ([Workflow step timeouts](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/#retry-steps)).
- **Progress-driven only.** A stuck paid call may never reach the next progress boundary. A continuation check cannot interrupt a call that is already running, so progress cannot replace the container's hard stop.

## Acceptance criteria

A hung paid call stops at its absolute deadline even without a new checkpoint. A resumed execution keeps the original hard stop, and a lost response alone is not evidence that the stop happened.

## Risks

The local stop can take effect while its evidence is lost in transit. Until the stop can be established, recovery must treat the outcome as unknown rather than report exhaustion or assume it is safe to launch again.
