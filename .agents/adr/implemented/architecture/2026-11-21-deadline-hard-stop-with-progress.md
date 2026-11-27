# ADR: Keep a container hard stop and decide continuation from durable progress

Status: implemented — the attempt's deadline is frozen at admission and enforced inside the container by the shell wrapper, and recovery replays the recorded instant rather than re-deriving it
Spec: docs/specs/architecture/review-budget.md § Exhaustion outcome

## Problem

An orchestrator can lose contact during a blocking paid call. Losing the reply, or reaching the [Workflow step timeout](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/#retry-steps), does not prove that the runner stopped or reached the [review budget exhaustion boundary](../../../../docs/specs/architecture/review-budget.md#exhaustion-outcome).

## Decision

One absolute hard stop lives in the container across waits and recovery. The Workflow decides whether to continue only at durable progress boundaries. The existing `deep` whole-wave stop and exhaustion precedence in the [budget spec](../../../../docs/specs/architecture/review-budget.md#exhaustion-outcome) remain constraints.

The instant is `enqueued_ms + capMs`, frozen when the delivery is first admitted and written as the Check attempt's `execution_deadline_ms`; no step re-derives it. `EXEC_DEADLINE_WRAPPER` (`src/pipeline/sandbox.ts:178`) computes `remaining = deadline − date +%s` in the container's own shell immediately before the command starts, and refuses rather than issuing a zero-length bound when the window is already spent.

A confirmed hard stop is an expected platform decision with its own approved Check summary wording, not a generic fault; see the [failure-status decision](2026-11-21-review-failure-user-facing-status.md).

## Alternatives considered

- **Workflow-only absolute instant.** The Workflow can anchor a deadline but cannot observe the runner's live progress or outcome mid-run through the blocking call (`reviewAttempt`, `src/pipeline/review-attempt-execution.ts:3922`). Its own timeout is not proof that the container obeyed the deadline ([Workflow step timeouts](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/#retry-steps)).
- **Progress-driven only.** A stuck paid call may never reach the next progress boundary. A continuation check cannot interrupt a call that is already running, so progress cannot replace the container's hard stop.

## Consequences

- A hung paid call stops at its absolute deadline without a new checkpoint — `tests/pipeline/hard-stop.test.ts`, "the exec's timeout is the deadline remainder, and a kill at it is a confirmed stop".
- A resumed execution keeps the original hard stop — `hard-stop.test.ts`, "a replayed prepare derives the same cutoff from the recorded instant, not the cap seam".
- A lost response is not evidence that the stop happened — `hard-stop.test.ts`, "a lost reply is unknown: its own cause is recorded, no Check conclusion, nothing destroyed".
- The recorded instant survives an operator changing the cap — `hard-stop.test.ts`, "a redelivery replays the recorded instant even after the operator changes the cap".

## Risks

The local stop can take effect while its evidence is lost in transit. Until the stop can be established, recovery must treat the outcome as unknown rather than report exhaustion or assume it is safe to launch again.
