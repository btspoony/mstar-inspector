---
module: pipeline / consumer (per-App credential resolution)
date: 2026-08-29
problem_type: best_practice
category: best-practices
severity: high
plan_id: 13-dashboard-multi-app
tags: [queue-consumer, octokit, app-auth, per-app, instance-cache, comment-upsert]
related_components: [review-job-contract, comment.ts, webhooks.ts, artifact-store]
---

# Per-App credential resolution in a single queue consumer

## Context

v0.5 lets one Worker deployment serve many audit GitHub Apps. The queue consumer previously built one global Octokit App auth from Worker secrets; now each queue message carries `appRef` (`{ kind: "app", appId }` | `{ kind: "legacy" }`, optional field on `ReviewJobPayload` in `src/contracts/review-job.ts`) and resolves credentials per message.

## Guidance

- **Contract evolution**: optional field, absent = legacy — old in-flight messages keep working and rollbacks ignore the extra field. The legacy route attaches an **explicit** `{ kind: "legacy" }` (no producer-side dual convention).
- **Single construction point**: `createReviewCommenter(CommenterEnv)` in `src/pipeline/comment.ts` remains the only `createAppAuth` call site. Per-App = a `Map<appId, ReviewCommenter>` instance cache beside `ProcessDeps.commenter`; **token mint and comment posting must share the same instance** (auth-app token caches are per-instance).
- **Consumer-side resolution**: the PEM is decrypted only in consumer memory; the queue carries the appId reference only. Re-read the app row **per message** (active + not deleted) even on cache hits — this is what makes dashboard disable/delete and key rotation take effect without redeploy.
- **Fail closed, not silent**: missing / disabled / soft-deleted / undecryptable → structured error through the existing retry→DLQ path, zero GitHub writes, no fallback to global credentials (a silent fallback would spend the deployment owner's quota on someone else's App). Note the accepted trade-off: resolution precedes the KV done-state check, so a redelivered *already-completed* review of a since-disabled App goes to DLQ instead of quiet-acking.
- **Webhook face**: verify signatures with a **per-secret verifier cache** — a module-level `Webhooks` singleton verifies every later secret against the first-cached one and silently voids multi-App isolation. Route order: body cap → kill-switch → app lookup → verify.

## Why This Matters

One consumer process, many identities. The cache/re-read split (construction cached, authorization state re-read) is the balance between token-mint cost and admin-action latency; the explicit-appRef contract keeps the message schema evolvable.

## When to Apply

Any queue consumer that must act as one of N stored identities; any webhook endpoint serving N Apps from one route table.

## Examples

- `src/pipeline/consumer.ts` (`resolveCommenter`, `resolveAppConfig`, per-App env assembly); `src/worker/index.ts` (`POST /webhook/:appSlug`); `src/worker/webhooks.ts` (secret-keyed verifier cache); `tests/pipeline/app-credential-resolution.test.ts` (sibling-secret isolation, disabled-mid-flight, legacy byte-compat).
