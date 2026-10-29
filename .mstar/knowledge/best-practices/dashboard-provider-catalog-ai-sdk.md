---
module: dashboard / provider catalog (ai-sdk ecosystem + workers-ai template tier)
date: 2026-09-04
last_updated: 2026-10-30
problem_type: best_practice
category: best-practices
severity: medium
topic: app detail ops & providers
tags: [provider-catalog, ai-sdk, models-dev, omp-providers, workers-ai, custom-providers, byok, zero-runtime-network]
related_components: [src/pipeline/provider-catalog.ts, scripts/generate-provider-catalog.ts, src/dashboard/provider-verify.ts, src/dashboard/app-config-store.ts, src/contracts/provider-catalog.generated.ts]
---

# Sourcing the provider catalog from models.dev (ai-sdk ecosystem) with a template tier

## Context

The BYOK dashboard hand-maintained a 19-entry provider map (`src/pipeline/providers.ts`). The 2026-09 provider-catalog rework replaced it with a generated catalog (PM decision, user-directed): ai-sdk-ecosystem metadata via a pinned **models.dev** snapshot, plus Cloudflare Workers AI as an entry — evaluated and rejected for ai-sdk runtime adoption, and `void` verified to have no provider catalog surface (T0 verdict 2026-09-04).

## Guidance

- **Generated static module, zero runtime network**: `scripts/generate-provider-catalog.ts` reads a vendored `models.dev-<date>.json` snapshot and emits the generated contract `src/contracts/provider-catalog.generated.ts` (regen byte-identical; a later consolidation pass moved the SSOT from the pipeline module into the generated contract — full breadth: 19 builtin + 194 models.dev breadth rows + the curated workers-ai template + the omp union rows; enumeration rules: 18 builtin-sourceKey exclusions + dedupe + id-regex skip-count, then the four union rules). `src/pipeline/provider-catalog.ts` remains the hand-written pipeline face (`export *` from the contract + the `../review/runtime` re-export the consumer imports). No ai-sdk runtime dependency — the ai-sdk ecosystem is the *metadata source*, not an execution layer; the runner remains omp + `models.yml`.
- **Two tiers**: `builtin` = runner-consumable entries (display name / default base URL / representative models, plus the retained env-name metadata that now only marks allowlist membership; keeps `providerEnvName` + `PROVIDER_ENV_NAMES` parity tests and the `PROVIDER_VERIFY_ENDPOINTS` inventory green). `template` = providers that are **not** directly runner-consumable (omp has no built-in discovery for them) — they materialize through the existing `app_custom_providers` machinery instead.
- **Workers AI = template**: OpenAI-compatible REST endpoint with account-id templated base URL, materialized as a custom-provider declaration whose key is transported under its own provider id in the credential payload, plus the custom-provider verify probe. Never a builtin-style env-name entry — a builtin id is runner-consumable by contract (allowlisted pool + a models.yml block), and Workers AI has no capability-host block to synthesize.
- **Three pinned inputs, one generated artifact**: (1) the dated models.dev snapshot, (2) the generator's builtin override table + curated `workers-ai` template, (3) `scripts/provider-catalog/omp-api-key-providers.json` — a vendored snapshot of the omp SDK's API-key LLM providers (its header names the omp version, the extraction date and the extraction rules: seed api/base-url, `api-routes` per-model protocols, factory default base URLs). The generator merges (3) AFTER the models.dev breadth pass, so rules can see every earlier row.
- **Union rules (each counted in the generated header)**: (a) id already in the catalog (builtin, template, or a models.dev key a builtin consumed) → skip; (b) omp id is a naming alias of an existing catalog row → skip and record the mapping; (c) non-model provider (no API-key env, search/local-inference) → skip; (d) not materializable — id fails `CUSTOM_PROVIDER_ID_PATTERN`, `api` outside `CUSTOM_PROVIDER_API_IDS`, or a URL placeholder other than `{account_id}` (OAuth/device-code-only logins are recorded here too). Every surviving record becomes a `template` row with a null `envName`, the mapped protocol, the base URL (null when omp ships none or only a loopback `http://` default) and the seed vocabulary capped at 20.
- **Mixed-protocol providers split into rows**: a custom-provider declaration carries exactly one `api`, so a provider serving different protocols per model contributes one row per protocol (`commandcode` → `openai-responses` at `/provider/v1`; `commandcode-anthropic` → `anthropic-messages` at `/provider`). `typesafe` is its own judge row and never a prefill for either.
- **`typesafe` protocol**: `CUSTOM_PROVIDER_API_IDS` carries it, and the custom verify probe treats it as the OpenAI-shaped Bearer `GET {base}/v1/models` path (omp's own TypeSafe discovery). Known limit: Command Code's public models endpoint answers 2xx without a valid key, so that probe cannot reject a bogus key — omp's `/alpha/whoami` check is deliberately out of scope.
- **Mirror discipline**: the dashboard mirror (`PROVIDER_IDS` = builtin ids, `PROVIDER_META` = full catalog) re-exports the generated contract (structurally assigned), and parity tests lock the builtin set + generator id-regex grammar so a regen cannot silently desync the faces. Dashboard imports the `src/contracts` module, never the pipeline face (Q2 boundary).
- **Secrets**: template materialization follows the existing verify-first custom-provider flow (key verified outbound before persist; secretbox envelope unchanged).

## Display tier vs runner tier (dashboard-UX rework, AD-547)

The builtin tier doubles as the runner-consumable BYOK allowlist, so a UI-facing regroup (常用 five: anthropic/openai/gemini/copilot/xai; everything else shown under 目录模板) must **never** re-tier the catalog. Locked mechanism:

- The generator emits an additional frozen `PROVIDER_IDS_COMMON` array (display-only; guard tests pin exact-5 order + ⊆ BUILTIN + frozen + runner surfaces byte-unchanged).
- The settings route stamps each assembled entry with `display_group: "common" | "catalog"` (= `PROVIDER_IDS_COMMON.includes(id)`); array order and `tier`/`eligibility` semantics stay untouched, so the server never regroups.
- The SPA groups the picker by `display_group` only; **form/config branching must never read it** (mechanics stay keyed to `tier`/`eligibility` — a demoted builtin keeps its key-only flow under the 目录模板 header). A negative pin proves SettingsPage has zero `display_group` references outside the picker grouping.

Red line for any future change: `PROVIDER_IDS_BUILTIN` / `PROVIDER_ENV_NAMES` / `providerEnvName` / verify-save-consumer faces are byte-semantics frozen; display grouping rides only the added array + stamped field.

## Why This Matters

A hand-maintained provider list rots; a generated one from a pinned upstream snapshot stays auditable (snapshot date in header) and reproducible (byte-identical regen), while the tier model keeps the runner contract (builtin allowlist + pool transport, models.yml synthesis) untouched.

## When to Apply

Adding/updating providers, refreshing the models.dev snapshot, onboarding another template-tier provider (any OpenAI-compatible gateway works through the same materialization path).

## Examples

- `scripts/generate-provider-catalog.ts` — generator with snapshot header + idempotency.
- `add-template-provider` op (settings POST family) — workers-ai materialization reference.
