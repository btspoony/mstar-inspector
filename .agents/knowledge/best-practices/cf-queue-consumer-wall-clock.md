---
module: pipeline-consumer
date: 2026-08-29
last_updated: 2026-11-20
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

Derive the runner budget from the cap in one place, never by typing a number per tier. `src/review-budget.ts` owns the derivation: the 900 000 ms cap minus the named post-runner costs (90 s bounded output reads + 12 s inline resolution + 2 s Check begin + 120 s Worker tail + the live `terminalizeMs`, 1–30 s) yields the ceiling, and the tier table declares maxima that must sit inside it. Shipped maxima are `quick 480 s / default 600 s / deep 646 s`; the ceiling is 666 000 ms at the 10 s default terminalize and 646 000 ms at the supported 30 s maximum. A test asserts every tier maximum against the ceiling as a function of `terminalizeMs`, so a table that advertises a budget the consumer cannot finish fails CI instead of shipping.

**There is one `min()` and it lives inside the derivation.** A second clamp at the call site hides exactly this class of defect: with `Math.min(runnerDeadline, now + tierMs)` the derived deadline silently won, the `deep` entry above the ceiling became dead code, and the published `deep 840 s` was never reachable. If a caller wants more than its tier maximum, the shared entry must refuse it explicitly rather than trim it.

Recompute guard TTL from the same formula: `ceil((runner + N×git + inline + slack) / 1000)`, where `N` is `GUARD_TIMED_SANDBOX_STEPS.length` — one entry per 120s window, and the recheck document/status reads share one window because they run in a single `Promise.all`. That list is pinned against a real maximal round by the consumer suite, so a new sandbox step fails the suite until it is billed. Keep retry delays strictly below that TTL, with a cumulative sum above it.


### Allocate within the tier, never past it

A tier maximum is a ceiling, not a quota. When the diff size is already known, spend it: `src/review-budget.ts` derives a requested budget from the numstat the consumer already reads — one work unit per textual changed line with a minimum of one unit per file, a 120 s floor, and a linear ramp saturated at 20 000 units. Unknown size requests the tier maximum, so an unreadable numstat can never shrink a review's budget.

Three properties keep the allocation safe:

- **The size is parsed once, from the same stdout the seat partition consumes.** No second read. `parseNumstatSize` returns `{ changedLines, workUnits }` or `null`; a row that is not exactly three fields, a count that is not a safe integer, or a total that leaves the safe-integer range is `null` (unknown size), never a small diff and never an exec-time refusal.
- **Truncation is detected by the terminating newline.** The sandbox exec reports no truncation flag, so a non-empty stdout that does not end with a newline is treated as truncated; the residual limit is a cut exactly at a line boundary, which no available signal distinguishes.
- **The allocation never reaches the admission windows.** Guard TTL and the Check lease derive from the tier ceiling, so a small PR's shorter budget cannot shorten the window a retry or recovery needs. A test asserts the two are request-independent.


### A spent budget is a failure, not a verdict

When the wall clock runs out, say so. `budget-exhausted` is a terminal execution outcome **outside** the review verdict envelope: the attempt's Check concludes `failure` with a sentence that names the tier, the freeze-time budget and — only when observed — the stopped/dispatched seats and changed lines. `incomplete` keeps its narrower meaning: a run that published partial work under a healthy budget.

Three rules make the outcome trustworthy:

- **The runner reports, the Worker publishes.** The runner emits one exit-0 stdout document (`mstar.review-budget-exhausted/v1`) with safe-integer counts; the Worker validates it by exact schema and own keys, then decides the Check. A model payload never supplies it, and the runner never computes the Worker's runner budget or a Check conclusion — its engine-owned seat soft cap (`PR_REVIEW_TIER_BUDGETS`) is a different clock that bounds an individual seat, not the round.
- **Unobservable is `null`, never zero.** A deadline before numstat, or a sandbox kill with no stdout, knows no seat counts; the short sentence states the cause (`runner deadline reached` / `consumer deadline reached` / `sandbox execution killed at its deadline`) and omits the numbers. A fabricated count is worse than an absent one.
- **Nothing is rewritten and nothing is retried.** Already-published review comments stay as written, an older same-head Check is never mutated, and a confirmed exhaustion is ACKed — a retry would re-spend the same budget on the same diff and end the same way.

The resolved outcome must precede verdict parsing, journal staging and every publication step, and it must outrank a prior generation's same-head publication proof: otherwise a rerun on an already-reviewed head can freeze the old result. Persist only trusted budget fields in the failure row; provider stderr belongs in logs.

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

`RUNNER_MAX_BUDGET_MS = { quick: 480_000, default: 600_000, deep: 646_000 }` derived from the cap; guard TTLs 2 292 / 2 412 / 2 458 s; admission delays stay below their TTL with cumulative sums above it (2 460 / 2 670 s). A run that needs more than the ceiling needs a Durable Object / Workflow handoff, not a bigger consumer timeout.
