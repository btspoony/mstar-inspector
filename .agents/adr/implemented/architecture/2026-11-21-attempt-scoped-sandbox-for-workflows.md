# ADR: Use an attempt-scoped blocking sandbox for Workflows

Status: implemented — the attempt owns one marker-guarded slot: provision, marked run, collect-then-destroy and the refusal to restart paid work all live in `SandboxV1`
Spec: docs/specs/feature/review-lifecycle.md § 7.7 Publication journal, complete payload and crash recovery

## Problem

Preparation leaves a checkout and inputs in the sandbox that the paid runner needs. A successful preparation checkpoint does not prove those files or the original container survived ([Cloudflare's sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)). The [review lifecycle section](../../../../docs/specs/feature/review-lifecycle.md#77-publication-journal-complete-payload-and-crash-recovery) describes the pre-decision sandbox and cleanup (`docs/specs/feature/review-lifecycle.md:392–403`). It is the closest specification of the consumer-scoped behavior; this record extends that ownership across Workflow step boundaries and into recovery.

## Decision

The sandbox is an attempt-scoped resource and the runner call blocks: the paid step waits for the runner RPC, while the container outlives both preparation and the paid step for result collection. A cleanup step destroys the container after collection. If the Workflow is interrupted, a recovery owner first verifies that it is the same live container, then collects and durably retains its result before destroying it. Destroying first can erase the only copy. Lost contact is not permission to launch a replacement paid run.

`SandboxV1` in `src/pipeline/sandbox.ts` is the whole of that boundary and exposes exactly three marker-guarded operations — `provision`, `runMarked` and `destroyMarked` — over one marker path (`/tmp/mstar-review-attempt`) written inside the caller's one absolute deadline. `provision` is the only method that may start a container; a container that is not already running is `unavailable` or `misconfigured`, never silently restarted. `destroyMarked` takes a retention proof, so a marker match alone authorizes nothing. The interface also carries an unguarded `destroy()` and a `revoke()`: the first exists for the smoke entry, which owns a container it created and never runs a paid review in it, and the second releases a container without destroying it. Neither is reachable from the review path, and neither can stand in for `destroyMarked` there — the review's cleanup requires a proof, and a review that cannot name one leaves its container to the platform's inactivity reclamation.

## Alternatives considered

- **Step-scoped sandbox.** One step could own checkout through result capture, so later steps would not depend on live files. Retrying that step would also rerun paid work after a lost response; keeping the container inside the step does not make the call safe to replay ([Workflow step retries](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/#retry-steps)).
- **Detached attempt-scoped runner.** A detached job could let the Workflow wait for an event without holding a running slot, but it requires a durable job identity and liveness reporting that the current blocking sandbox RPC does not provide (`src/pipeline/sandbox.ts:252–280,331–343`; [Workflow concurrency](https://developers.cloudflare.com/workflows/build/concurrency-limits/#how-per-workflow-concurrency-limits-are-applied)).

## Consequences

- The same attempt's prepared checkout is available to the paid step, and output remains collectable after it ends — `tests/pipeline/sandbox-attempt.test.ts`, "a matching live incarnation collects the result documents": the container name and the marker derive from the attempt id alone.
- Collection after the paid step ends is bounded by a retained proof rather than by hope — `sandbox-attempt.test.ts`, "a matching marker with a retained proof allows collect-then-destroy".
- Cleanup is bounded: a slot the platform already stopped still releases capacity — `sandbox-attempt.test.ts`, "a slot the platform already stopped reports stopped, which still releases capacity".
- Recovery verifies container sameness before destroying — `sandbox-attempt.test.ts`, "a replaced marker destroys nothing and reports unknown" and "a matching marker alone destroys nothing: only the two facts authorise it".
- A matching Durable Object name is not proof of sameness — `sandbox-attempt.test.ts`, "a fenced slot refuses provisioning: a rebuilt DO on the same storage answers retired and never starts" and "a second entry provisions the slot again instead of proving the old incarnation".
- An uncertain launch does not restart paid work — `sandbox-attempt.test.ts`, "a replaced marker at the pre-paid entry is lost-before-paid: nothing was charged".

## Risks

A DO restart re-attaching to the same live container is an unverified assumption. `SandboxV1` re-arms the inactivity timeout if it finds a running container (`src/pipeline/sandbox.ts:245–250`, and again on the provisioning path at `:283`); that is not evidence that the original process and files remain attachable. A blocking call also occupies a running Workflow slot while it waits ([Workflow concurrency](https://developers.cloudflare.com/workflows/build/concurrency-limits/#how-per-workflow-concurrency-limits-are-applied)).
