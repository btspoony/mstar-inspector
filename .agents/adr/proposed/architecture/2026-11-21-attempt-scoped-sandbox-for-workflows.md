# ADR: Use an attempt-scoped blocking sandbox for Workflows
Status: proposed — the sandbox ownership boundary has been chosen but has not shipped
Spec: docs/specs/feature/review-lifecycle.md § 7.7 Publication journal, complete payload and crash recovery

## Problem

Preparation leaves a checkout and inputs in the sandbox that the paid runner needs. A successful preparation checkpoint does not prove those files or the original container survived ([Cloudflare's sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)). The [review lifecycle section](../../../../docs/specs/feature/review-lifecycle.md#77-publication-journal-complete-payload-and-crash-recovery) describes the pre-decision sandbox and cleanup (`docs/specs/feature/review-lifecycle.md:392–403`). It is the closest specification of the consumer-scoped behavior; this record extends that ownership across Workflow step boundaries and into recovery.

## Proposal

Make the sandbox an attempt-scoped resource and keep the runner call blocking: the paid step waits for the runner RPC, while the container outlives both preparation and the paid step for result collection. A cleanup step destroys the container after collection. If the Workflow is interrupted, a recovery owner first verifies that it is the same live container, then collects and durably retains its result before destroying it. Destroying first can erase the only copy. Lost contact is not permission to launch a replacement paid run.

## Alternatives considered

- **Step-scoped sandbox.** One step could own checkout through result capture, so later steps would not depend on live files. Retrying that step would also rerun paid work after a lost response; keeping the container inside the step does not make the call safe to replay ([Workflow step retries](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/#retry-steps)).
- **Detached attempt-scoped runner.** A detached job could let the Workflow wait for an event without holding a running slot, but it requires a durable job identity and liveness reporting that the current blocking sandbox RPC does not provide (`src/pipeline/sandbox.ts:252–280,331–343`; [Workflow concurrency](https://developers.cloudflare.com/workflows/build/concurrency-limits/#how-per-workflow-concurrency-limits-are-applied)).

## Acceptance criteria

- The same attempt's prepared checkout is available to the paid step, and output remains collectable after it ends. Cleanup is bounded; after interruption, recovery verifies container sameness and collects any recoverable result before destruction.
- Verify the assumption that recovery can re-attach to the same live container after a Durable Object (DO) restart; a matching DO name is not proof. If recovery cannot establish sameness after an uncertain launch, it does not restart paid work.

## Risks

A DO restart re-attaching to the same live container is an unverified assumption. `SandboxV1` re-arms the inactivity timeout if it finds a running container (`src/pipeline/sandbox.ts:171–185`); that is not evidence that the original process and files remain attachable. A blocking call also occupies a running Workflow slot while it waits ([Workflow concurrency](https://developers.cloudflare.com/workflows/build/concurrency-limits/#how-per-workflow-concurrency-limits-are-applied)).
