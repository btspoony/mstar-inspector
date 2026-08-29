---
module: pipeline-consumer
date: 2026-08-29
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - "Sizing Cloudflare Queue consumer timeouts for sandbox review jobs"
  - "Setting EXEC/runner budgets larger than 10 minutes"
plan_id: 10-review-d5-budget
tags:
  - cloudflare-queues
  - wall-clock
  - review-timeout
---

# Queue consumer wall-clock vs sandbox runner timeout

## Context

v0.4 D5 originally locked a 30 minute deep runner (`1_800_000` ms). Plan QC found Cloudflare Queue **consumers are capped at 15 minutes wall-clock per invocation** (platform, non-configurable). A 30 minute `sandbox.exec` is killed mid-flight; `finally` (guard release, sandbox destroy) may not run; retries burn quota and still DLQ.

## Guidance

Size the in-consumer runner **under 15 minutes with headroom**. v0.4 pin: deep `840_000` (14 min). Recompute guard TTL from the same formula: `ceil((runner + 5×git + slack) / 1000)`. Keep retry delays strictly below that TTL.

Do not advertise a runner budget the consumer cannot finish.

## Why This Matters

False 30 minute product locks fail closed as DLQ storms, not as honest timeouts.

## When to Apply

- Any Queue-consumer path that `await`s a long sandbox/model call
- Changing `runnerTimeoutMs` / `REVIEW_GUARD_TTL`

## Examples

### Before

`RUNNER_TIMEOUT_MS.deep = 1_800_000` inside `createReviewConsumer`.

### After

`RUNNER_TIMEOUT_MS.deep = 840_000`; TTL 1560 s; delays `[180, 360, 720]`. Longer runs need a Durable Object / Workflow handoff, not a bigger consumer timeout.
