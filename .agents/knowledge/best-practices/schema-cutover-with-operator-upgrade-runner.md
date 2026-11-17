---
module: operator data upgrade / maintenance window
date: 2026-11-18
problem_type: best_practice
category: best-practices
severity: medium
applies_when:
  - a schema migration must be followed by a data rewrite across tenant rows
  - the rewrite cannot run online without changing what live deliveries mean
  - an operator needs a resumable, verifiable migration instead of a one-off script
tags:
  - migration
  - maintenance-window
  - queue
  - d1
  - operator
  - idempotency
related_components:
  - admin-data-upgrades
  - pipeline-consumer
  - runtime-config-store
  - dashboard-gate
---

# Pair a schema cutover with an operator upgrade runner, not a one-off script

## Problem

A forward migration adds repository identity to rows that never had it. Until the historical rows are split and re-pointed, deliveries resolve to nothing and reviews silently stop. The rewrite is too large for one request and must be safe to interrupt, resume and re-run. Queue messages and webhook deliveries must not run against half-migrated rows.

## Shape that works

1. **Maintenance is a stored platform setting**, not a deploy flag: three keys (enabled / reason / since), absent row = off, one writer path, an audit row per change. The dashboard, the workspace API, webhooks (503 so GitHub retries) and the queue/cron read it once per request or invocation.
2. **Exemptions are exact paths**, not prefixes: liveness, the operator console, the install callback, login/oauth, locale and logout.
3. **Queue work is deferred, never acked away.** Retry with a delay while attempts remain; when the attempt budget is exhausted, record a `maintenance_deferred` failure row (so the sweep alerts and a human can replay) and ack. The window must stay shorter than the retry budget — write that in the runbook, not only in code.
4. **The upgrade is a registered item with a state machine**: preflight (counts, no writes), step (one bounded batch per call, cursor in state), verify (read-only checks), reset (state only, never un-migrates). Every mutating phase claims the row with one conditional upsert carrying a lease and a per-call token; every statement that writes the window, ownership, progress or the claim itself is fenced by that token, and a zero-change guarded write is a `409`, never a success.
5. **Batch by the unit you can reason about**, not by row count: one target can name hundreds of repositories, so cap groups and chunk every `IN (…)` list under the platform bind limit.
6. **Group identity includes every tenant key** (`bot_id`, `workspace_id`, owner, repo) and compares names case-insensitively; a winner rule resolves several old rows naming the same repository deterministically.
7. **Retire only the rows this batch migrated.** A row that also names another repository stays live for a later batch; otherwise its other ledger rows orphan and verify reports a partial migration as complete.
8. **Verify distinguishes this run's damage from history.** A run-start stamp separates rows retired by this upgrade from deletions that predate it; historical rows are reported, not failing. Reset must not clear that stamp, or an interrupted run's leftovers become "history".
9. **One window, one owner.** A phase that opened the window closes it; a window the operator opened is never closed by a runner.

## Traps

- Letting a step write progress with an id-only predicate: a taken-over claim clears the successor's lease and two batches interleave.
- Closing the maintenance window as a separate await after releasing the claim: a stale caller closes a newer run's window. Do the ownership clear, the window writes and the audit in one guarded batch.
- Trusting an id list parameter count: a tenant-scope read keyed by resolved ids hits the D1 bind ceiling at a few dozen rows.
- Treating a process kill between the data batch and the progress write as fatal: data and cursor are protected by replay, the ledger entry is not; either join them or state the loss window.
