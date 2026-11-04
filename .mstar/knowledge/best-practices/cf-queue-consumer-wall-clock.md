---
module: pipeline-consumer
date: 2026-08-29
last_updated: 2026-11-03
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - "Sizing Cloudflare Queue consumer timeouts for sandbox review jobs"
  - "Setting EXEC/runner budgets larger than 10 minutes"
topic: review deep-run budget
tags:
  - cloudflare-queues
  - wall-clock
  - review-timeout
  - max-concurrency
---

# Queue consumer wall-clock vs sandbox runner timeout

## Context

v0.4 D5 originally locked a 30 minute deep runner (`1_800_000` ms). Plan QC found Cloudflare Queue **consumers are capped at 15 minutes wall-clock per invocation** (platform, non-configurable). A 30 minute in-consumer run is killed mid-flight; `finally` (guard release, sandbox destroy) may not run; retries burn quota and still DLQ.

## Guidance

Size the in-consumer runner **under 15 minutes with headroom**. v0.4 pin: deep `840_000` (14 min). Recompute guard TTL from the same formula: `ceil((runner + 5×git + slack) / 1000)`. Keep retry delays strictly below that TTL.

Do not advertise a runner budget the consumer cannot finish.

### Concurrency: a deploy-time ceiling plus a per-message runtime cap (2026-11)

Wrangler's config schema states it plainly: an unset consumer `max_concurrency` means the platform **scales concurrency up by backlog** — "serial by accident" is not a safety property, so `wrangler.jsonc` always sets it explicitly. Since the review-concurrency cutover it is **not** the admission control:

- **`max_concurrency: 250` is the deploy-time CEILING only.** It is Cloudflare Queues' hard limit on concurrent consumer invocations and bounds how many queue messages are delivered at once; it is deliberately NOT env-configurable. The runtime maximums are 256 (system quota) and 32 (workspace) — the values `wrangler.jsonc`'s comment and `src/dashboard/runtime-config-store.ts` both name. The system quota may therefore sit ABOVE the ceiling: a stored 256 is a valid business quota that the platform can only saturate to 250, and the ceiling is what bounds the account.
- **The effective admission is per-message, read from D1.** `min(system, workspace)` comes from `src/pipeline/concurrency-reader.ts` → `review_inflight` admission on EVERY message, so per-PR serial and cross-PR parallel are runtime decisions, not config. A degraded read fails closed to the conservative cap of 1.
- **`max_batch_size: 1` keeps the wall-clock model honest.** One review per batch means one runner budget owns the invocation, so the 15-minute consumer cap above still binds.
- **The ceiling is bounded, not a concurrency licence.** Under `scheduling_policy: "durable_object"` each attempt's unique sandbox id (`SandboxV1` DO, `getSandbox(...)`) starts its **own** container, and the 0.12 `image` / `instance_type` / `max_instances` / `image_build_context` fields have no durable-object equivalent (`wrangler.jsonc` containers comment). The old per-attempt acquisition-blocking / `instanceGetTimeoutMS` back-pressure no longer exists, so a higher ceiling simply runs that many containers concurrently against the account's container limits — which is why the runtime caps, not the ceiling, carry the protection.

This is why the parity contract pins the ceiling VALUE (250) in both blocks rather than trusting set-equality: an equal-but-wrong value would otherwise pass. The quota (up to 256) is not the ceiling — do not collapse the two numbers.

## Why This Matters

False 30 minute product locks fail closed as DLQ storms, not as honest timeouts.

## When to Apply

- Any Queue-consumer path that `await`s a long sandbox/model call
- Changing `runnerTimeoutMs` / `reviewGuardTtlSeconds`

## Examples

### Before

`src/pipeline/consumer.ts` (module-scope `RUNNER_TIMEOUT_MS`): `deep = 1_800_000`.

### After

`RUNNER_TIMEOUT_MS.deep = 840_000`; TTL 1560 s; delays `[180, 360, 720]`. Longer runs need a Durable Object / Workflow handoff, not a bigger consumer timeout.
