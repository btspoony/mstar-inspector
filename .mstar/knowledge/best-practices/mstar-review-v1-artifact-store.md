---
module: review-store
date: 2026-08-28
problem_type: best_practice
category: best-practices
severity: high
topic: review engine
applies_when:
  - "Persisting cloud PR reviews from mstar-harness"
  - "Implementing ArtifactStore kind review on D1"
  - "Adopting a new harness review contract (for example a new verdict or envelope field)"
last_updated: 2026-10-18
tags:
  - mstar-review-v1
  - artifact-store
  - synthesizeReview
  - incomplete
  - redaction
---

# Persist `mstar.review/v1` via D1 ArtifactStore

## Context

M1 stored inspector-local `ReviewOutput` (`comment`/`request_changes`/`approve`). Harness 3.5.0 made `mstar.review/v1` + `synthesizeReview` + `ArtifactStore` the persist SSOT. Inspector M1 vocab is rejected at put.

## Guidance

- Envelope is produced in the sandbox (`synthesizeReview`) and validated on put (`validateMstarReviewV1`) before any D1 write.
- D1 adapter implements `ArtifactStore` for `kind: "review"` only; other kinds throw. Key = idempotency string; UNIQUE `(installation_id, owner, repo, pr_number, head_sha)` still wins (first write, no overwrite).
- Migration `0002` adds `reviews.envelope TEXT CHECK (json_valid)`; new rows do not write `raw_output`. `findings.severity` column stores `mergeClass`.
- GitHub posting is COMMENT-only Issues upsert. Never `APPROVE` / `REQUEST_CHANGES`.
- **Two transports, one contract.** The in-process zod mirror (`src/review/schema.ts`) and the OMP strict parent JSON Schema (`src/review/runtime-omp.ts`) both gate a review before it is published. A new optional envelope field must be declared at both levels (envelope and `tally`); the strict schema is `additionalProperties: false`, so an undeclared engine-emitted field is a hard rejection, and a zod object that omits it silently strips it *after* the engine gate has accepted the document.
- **Engine-first, then narrow.** `parseReviewOutput` runs `validateMstarReviewV1` before zod. Presence and shape rules belong to the engine; the mirror exists to preserve types, not to re-derive scoring or vocabulary. Import the enum and the fact type (`PR_VERDICTS`, `PrIncomplete`) instead of re-declaring them.
- **Every model-controlled string that can reach the public body or D1 passes both redaction passes.** `redactReviewOutput` (shape) and `redactReviewOutputExact` (resolved values) are the single choke point in the consumer; a new envelope field that renders publicly must be added there, with conditional spreads so an absent field stays absent.
- **Persistence needs no migration for a new optional field.** `reviews.verdict` is unconstrained `TEXT` and `reviews.envelope` stores the validated payload as whole JSON; `artifact-store.put` writes the caller's object unchanged.
- **Sandbox pins move together.** `OMP_SANDBOX_IMAGE_PINS` (harness version/ref and CLI pin), the Dockerfile fetch/install literals, and the append-only superseded-ref list are one declaration; the pin tests derive from it.

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
