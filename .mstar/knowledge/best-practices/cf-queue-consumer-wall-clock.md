---
module: pipeline-consumer
date: 2026-08-29
last_updated: 2026-10-14
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

### Concurrency: UNSET max_concurrency auto-scales by backlog (v0.7, AL-5)

Wrangler's config schema states it plainly: an unset consumer `max_concurrency` means the platform **scales concurrency up by backlog** — "serial by accident" is not a safety property. The fix is explicit: `max_concurrency: 1` (`wrangler.jsonc`; deliberately NOT env-configurable).

The 1.0 cutover changed the *why*, not the pin. Under `scheduling_policy: "durable_object"` each attempt's unique sandbox id (`SandboxV1` DO, `getSandbox(...)`) starts its **own** container, and the 0.12 `image` / `instance_type` / `max_instances` / `image_build_context` fields have no durable-object equivalent (`wrangler.jsonc` containers comment). So the old per-attempt acquisition-blocking / `instanceGetTimeoutMS` back-pressure no longer exists: >1 concurrency simply runs containers concurrently against the account's container limits. The pin stays the cheap protection — and deep (14 min in-flight) against the 15-min consumer cap leaves no headroom for contention retries.

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
