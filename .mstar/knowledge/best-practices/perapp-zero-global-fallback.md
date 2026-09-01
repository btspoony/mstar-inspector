---
module: pipeline-perapp-credentials
date: 2026-09-01
last_updated: 2026-09-01
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - "Designing multi-tenant credential or model-chain resolution for per-App/per-tenant review jobs"
  - "Deciding whether an operator-level (global) key/model fallback is acceptable in a BYOK product"
  - "Implementing fail-closed gates for incomplete tenant configuration in queue consumers"
plan_id: 24-legacy-webhook-retirement
tags:
  - multi-tenant
  - byok
  - fail-closed
  - zero-global-fallback
---

# Per-App credentials only — zero global fallback in a multi-tenant BYOK pipeline

## Context

mstar-inspector reviews PRs for MULTIPLE GitHub Apps from one Worker deployment. Each App (tenant) configures its own provider keys (BYOK) and per-role model chains, stored encrypted in D1 (`github_apps` + per-App config stores). Through v0.8 the runner env still carried operator-level fallbacks: a global `OMP_MODEL_KEY` (injected as `ARK_API_KEY`), a global `OMP_REVIEW_MODEL` chain, and 18 per-provider Worker secrets forwarded into every review container. v0.9 (plan 24, AL-24-5) removed ALL of them after the owner ruled: 「不能存在全局兜底！per-app 的多租户产品」.

## Guidance

1. **Tenant credentials have exactly one source**: the per-App config read per message (`resolveAppConfig` → keys map + model chain). The runner env assembler takes no env-level credential parameter at all (`buildRunnerEnv` lost its `env` argument; `key_source` logs only `app | custom`).
2. **Provider registry is data, not plumbing**: the built-in provider table (`PROVIDERS`) maps provider id → env name (e.g. `ark → ARK_API_KEY`) so a BYOK key rides the same keys map as any custom provider. The dashboard keeps a parity-locked mirror of the id list. Adding a provider = one registry row + mirror row + parity test, never a new env field.
3. **Missing tenant config = loud fail-closed at ONE gate**: `assertAppConfigComplete` runs inside the per-message try, AFTER App/config resolution, BEFORE in-flight guard / sandbox / token mint / any side effect. Missing model chain — including "zero-selector" chains like `','` (trim-then-require-one-nonempty-selector, matching the runner's `parseModelSelectors` grammar) — or a chain referencing a provider with no configured key throw through the standard structured channel: `review failed:` log + `review_failures` row (`stage=pipeline`) + rethrow → queue retry×3 → DLQ. One unhealthy message never aborts its batch siblings.
4. **Operator knobs are not tenant fallback**: `REVIEW_ENABLED` (kill-switch) and `REVIEW_LEVEL` (default tier) remain deployment-level env — they gate WHETHER/HOW reviews run, never WHOSE credentials run them.
5. **In-image scaffolds stay inert**: the container's default `models.yml` keeps env-NAME references only (zero credential) and the runner's default-model pattern remains for direct/manual runner invocation — both unreachable from the production consumer path once the gate fails closed upstream.

## Why This Matters

A global fallback key in a multi-tenant product is a tenant-isolation defect: tenant reviews silently bill the operator's key, cost attribution dies, and "the App has no keys yet" becomes an invisible state instead of a loud onboarding gap. Fail-closed turns misconfiguration into a visible DLQ + settings-page signal with zero cross-tenant bleed.

## When to Apply

- Any per-tenant execution pipeline where credentials/model selection could tempt an operator-level default.
- Retiring a legacy single-tenant face from a product that has since gone multi-tenant: delete the env fields AND the forwarding/management surface (the `bun run keys` script, its tests, README sections) in the same cut — half-retired fallbacks rot into "temporary" permanently.

## Examples

- `src/pipeline/consumer.ts` `assertAppConfigComplete` + `buildRunnerEnv` (post-24-AL-24-5): gate placement, strict chain emptiness, `key_source ∈ {app, custom}`.
- Negative-test pattern: seed a second App with a persisted zero-selector chain via the real store, healthy sibling first — asserts sibling completes, failing message leaves exactly one structured `review_failures` row, zero runner execs (tests/pipeline/consumer.test.ts, perapp-env-assembly.test.ts; the custom-provider chain case exercises the third gate branch via `CUSTOM_<ID>_API_KEY`).

## Related

- Platform data model / routing / BYOK contract: `best-practices/dashboard-multi-app-platform.md`
- Per-review models.yml synthesis: `best-practices/omp-per-review-models-synthesis.md`
