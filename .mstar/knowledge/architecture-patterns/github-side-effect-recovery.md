---
module: review-lifecycle
date: 2026-09-13
problem_type: architecture_pattern
category: architecture-patterns
severity: high
topic: checks integration
applies_when:
  - adding recoverable GitHub mutations to queue consumers
  - reconciling external writes without replaying paid review work
  - bounding retries across D1 leases and remote APIs
tags:
  - github
  - d1
  - recovery
  - leases
  - idempotency
  - check-runs
  - queue-consumer
---

# Recover GitHub side effects with fenced durable intent

## Context

A queue consumer can publish the primary review successfully while a secondary GitHub mutation—thread resolution or Check Run update—times out, crashes, or returns an ambiguous transport result. Replaying the paid review to repair that side effect is wasteful and can duplicate comments. Treating a timeout as “not sent” is unsafe because GitHub may have accepted the request after the caller stopped waiting.

The repository implements this pattern across `src/pipeline/checks.ts`, `src/pipeline/consumer.ts`, `src/store/review-checks.ts`, and `src/worker/check-reconcile.ts`. The normative product contract is `.mstar/specs/review-lifecycle.md` §7.5, §7.7, §7.9, and §7.11.

## Guidance

### Persist identity and intent before relying on the remote result

Give each logical attempt a durable key and monotonically increasing generation. Persist a stable external marker derived from that row and generation; never recycle it. Keep immutable desired terminal intent separate from observed remote state:

```ts
interface RecoverableSideEffect {
  attemptKey: string;
  generation: number;
  externalId: string;
  desiredConclusion: "success" | "neutral" | "failure" | null;
  remoteStatus: "not-sent" | "sending" | "in-progress" | "completed" | "remote-unconfirmed";
}
```

Set the desired conclusion from persisted publication proof before attempting the terminal remote update. A failed update changes observed state, not the proof-derived desired intent.

### Fence every writer

Claim work with `(holder, lease_epoch, lease_expires_ms)`. Every attach, desired-intent, retry, suspension, and completion write includes the row identity, generation, holder, epoch, live lease, and expected nonterminal state in its predicate. A stale worker therefore updates zero rows instead of terminating newer work.

Use a stable execution deadline for abandonment. Ordinary `updated_at` activity must not extend that deadline.

### Distinguish proven zero-dispatch from unknown dispatch

Use three creation states:

1. `not-sent`: no request crossed the transport boundary;
2. `sending`: a request may have crossed, but no validated response was attached;
3. `in-progress`: a validated remote run id was attached.

Only a typed pre-dispatch refusal may report zero requests and roll `sending` back to `not-sent`. Any ordinary fetch rejection remains possibly sent. Recovery adopts by the durable external marker before considering creation.

A bounded adoption walk must be complete and unique. With two pages maximum, a saturated second page is incomplete even when only one candidate has been observed; duplicate candidates are ambiguous. Neither case authorizes update or re-create.

### Make inline cancellation invocation-owned

The primary review path has a short best-effort side-effect budget. A `begin` that outlives that budget continues detached, so its abandonment state must be owned by that invocation:

```ts
const abort = new AbortController();
const begin = lifecycle.begin(input, { signal: abort.signal });
const handle = await raceWithBudget(begin, () => abort.abort());
```

Never store this flag on a consumer-wide object and reset it for the next message. Multiple attempts for the same PR and SHA can coexist. A late begin must consult its own signal, retain any possibly-created remote identity, freeze a terminal desired state, and make recovery immediately due. Starting another message cannot un-abandon it.

### Suspend unchanged operator failures without hiding recovery

Credential identity mismatch, decrypt failure, missing exact-App routing, disabled Apps, and review pause are operator-state failures, not transient per-row retries. Persist a bounded typed suspension reason plus a non-secret digest of the relevant encrypted envelope/routing state. An unchanged state stays outside the due batch and performs no credential probe.

Re-enable only after a relevant state change and a bounded proof:

- disabled → App becomes active and not deleted;
- paused → review is enabled;
- recorded digest differs from the readable current exact-App digest, including a previously absent recorded digest after a mapping repair.

Admission-check the run budget before invoking the proof factory. A pre-dispatch budget refusal writes no credential verdict or digest, so a later pass remains eligible. A real failed proof may stamp the new digest to prevent repeated probes.

### Count actual remote work and preserve stage isolation

Meter each actual request against both the per-run and active-row budgets. Credential preflight can consult only the run budget before a row is active; once active, its probe and mint requests count toward both caps. A refused request consumes no request budget and does not spend an attempt.

Keep secondary reconcilers independently guarded in scheduled composition. A failure in finding recovery must not suppress Check recovery, and a Check failure must not block the read-only sweep or primary review publication.

## Why This Matters

The state model makes ambiguous network outcomes honest. It prevents duplicate GitHub mutations, stale-worker completion, indefinitely pending Checks, repeated credential churn, and accidental paid-review replay. Separating desired proof from observed remote state also preserves the user-facing truth when GitHub is unavailable: the system can state what should be published without claiming that publication was confirmed.

## When to Apply

- A queue or cron worker mutates a remote API after the main business result is already durable.
- The remote API supports an application-controlled marker that can be listed and adopted.
- Network timeout cannot prove whether a write was accepted.
- Multiple deliveries, retries, generations, or workers may act on the same logical operation.
- Operator state such as credentials or pause can remain unchanged across many cron passes.

## Examples

### Unsafe

```ts
try {
  await createRemoteRun();
} catch {
  // A timeout is treated as absent, so the next pass creates another run.
  state = "not-sent";
}
```

A remote run may already exist. Re-create duplicates it, and a stale worker can later overwrite newer state.

### Recoverable

```ts
await markSending(fence);
try {
  const run = await createRemoteRun(externalId);
  await attachRun(fence, run.id);
} catch (error) {
  if (error instanceof RequestNotDispatched) {
    await rollbackSending(fence); // proven zero-dispatch only
  } else {
    await markRemoteUnconfirmed(fence); // adopt by externalId on recovery
  }
}
```

Recovery first performs a bounded complete adoption walk. It creates only after complete absence is proven, and it terminalizes only while the same fenced lease remains valid.
