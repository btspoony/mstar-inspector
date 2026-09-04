---
module: dashboard / provider catalog (ai-sdk ecosystem + workers-ai template tier)
date: 2026-09-04
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 35-apps-detail-ops-providers
tags: [provider-catalog, ai-sdk, models-dev, workers-ai, custom-providers, byok, zero-runtime-network]
related_components: [src/pipeline/provider-catalog.ts, scripts/generate-provider-catalog.ts, src/dashboard/provider-verify.ts, src/dashboard/app-config-store.ts]
---

# Sourcing the provider catalog from models.dev (ai-sdk ecosystem) with a template tier

## Context

The BYOK dashboard hand-maintained a 19-entry provider map (`src/pipeline/providers.ts`). iter011 plan 35 replaced it with a generated catalog (PM decision, user-directed): ai-sdk-ecosystem metadata via a pinned **models.dev** snapshot, plus Cloudflare Workers AI as an entry — evaluated and rejected for ai-sdk runtime adoption, and `void` verified to have no provider catalog surface (T0 verdict 2026-09-04).

## Guidance

- **Generated static module, zero runtime network**: `scripts/generate-provider-catalog.ts` reads a vendored `models.dev-<date>.json` snapshot and emits `src/pipeline/provider-catalog.ts` (regen byte-identical). No ai-sdk runtime dependency — the ai-sdk ecosystem is the *metadata source*, not an execution layer; the runner remains omp + `models.yml`.
- **Two tiers**: `builtin` = runner-consumable entries (display name / default base URL / env key / representative models; keeps `providerEnvName` + `PROVIDER_ENV_NAMES` parity tests and plan-31 `PROVIDER_VERIFY_ENDPOINTS` green). `template` = providers that are **not** directly runner-consumable (omp has no built-in discovery for them) — they materialize through the existing `app_custom_providers` machinery instead.
- **Workers AI = template**: OpenAI-compatible REST endpoint with account-id templated base URL + `CUSTOM_WORKERS_AI_API_KEY` env + the plan-31 custom-provider verify probe. Never a builtin-style env-name entry — the in-image base `models.yml` only knows its own providers, so a fake builtin entry would synthesize a models.yml the runner cannot authenticate.
- **Mirror discipline**: the dashboard keeps a `PROVIDER_META` mirror (tier/verifiable flags) for UI; a parity test locks catalog ↔ mirror so a regen cannot silently desync the two faces.
- **Secrets**: template materialization follows the existing verify-first custom-provider flow (key verified outbound before persist; secretbox envelope unchanged).

## Why This Matters

A hand-maintained provider list rots; a generated one from a pinned upstream snapshot stays auditable (snapshot date in header) and reproducible (byte-identical regen), while the tier model keeps the runner contract (env-name keys, models.yml synthesis) untouched.

## When to Apply

Adding/updating providers, refreshing the models.dev snapshot, onboarding another template-tier provider (any OpenAI-compatible gateway works through the same materialization path).

## Examples

- `scripts/generate-provider-catalog.ts` — generator with snapshot header + idempotency.
- `add-template-provider` op (settings POST family) — workers-ai materialization reference.
