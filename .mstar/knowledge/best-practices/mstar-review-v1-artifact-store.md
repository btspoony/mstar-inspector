---
module: review-store
date: 2026-08-28
problem_type: best_practice
category: best-practices
severity: high
plan_id: 07-review-engine
applies_when:
  - "Persisting cloud PR reviews from mstar-harness 3.5.0"
  - "Implementing ArtifactStore kind review on D1"
tags:
  - mstar-review-v1
  - artifact-store
  - synthesizeReview
---

# Persist `mstar.review/v1` via D1 ArtifactStore

## Context

M1 stored inspector-local `ReviewOutput` (`comment`/`request_changes`/`approve`). Harness 3.5.0 made `mstar.review/v1` + `synthesizeReview` + `ArtifactStore` the persist SSOT. Inspector M1 vocab is rejected at put.

## Guidance

- Envelope is produced in the sandbox (`synthesizeReview`) and validated on put (`validateMstarReviewV1`) before any D1 write.
- D1 adapter implements `ArtifactStore` for `kind: "review"` only; other kinds throw. Key = idempotency string; UNIQUE `(installation_id, owner, repo, pr_number, head_sha)` still wins (first write, no overwrite).
- Migration `0002` adds `reviews.envelope TEXT CHECK (json_valid)`; new rows do not write `raw_output`. `findings.severity` column stores `mergeClass`.
- GitHub posting is COMMENT-only Issues upsert. Never `APPROVE` / `REQUEST_CHANGES`.

## Why This Matters

A second inspector schema forks from local `/amazing-pr-review`. Engine persist refuses M1 documents; dual-write would resurrect the fork.

## When to Apply

- Any change to review persist, comment rendering, or harness pin.
- Do not reintroduce `createReviewStore` / M1 verdict enums as write authority.

## Examples

### Before

`parseReviewOutput` → `insertReview(ReviewOutput)` with `verdict: "approve"`.

### After

`runtime.runReview` → `MstarReviewV1` → GitHub COMMENT → `store.put({ kind: "review", schema: "mstar.review/v1", payload })`.
