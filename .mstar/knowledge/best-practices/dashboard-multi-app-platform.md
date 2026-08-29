---
module: dashboard / multi-App platform (B4+B5+B2 contract)
date: 2026-08-29
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 13-dashboard-multi-app
tags: [multi-app, data-model, webhook-routing, byok, design-contract, v0-5]
related_components: [github_apps, app_provider_keys, app_model_config, reviews]
applies_when:
  - planning B3 (per-App ops UI) or B6 (per-role models) on this platform
  - extending the per-App configuration model to new setting kinds
---

# Multi-App audit platform — durable data & contract summary (promoted from v0.5 spec)

> Promoted to: this doc (structured condensation; source snapshot: `.mstar/iterations/v0.5/specs/dashboard-multi-app-platform.md`, process-local). Source recorded per compound Phase 4 trace.

## Context

v0.5 turned the single-App dashboard into a platform: invite-only members, N audit GitHub Apps per deployment, per-App AI configuration. This is the implementation-SSOT condensation that B3/B6 should plan against.

## Guidance (durable contract)

- **Data model** (migrations 0003–0006, append-only, no ON DELETE — soft-delete-only):
  - `users(github_login UNIQUE, role admin|member)` — removal = delete row; guard re-reads per request.
  - `github_apps(id UUID PK, slug UNIQUE, github_app_id UNIQUE, private_key_enc, webhook_secret_enc, status active|disabled, deleted_at)`.
  - `app_installations(app_id, installation_id)` — upserted on per-App webhooks; legacy route writes nothing (no app row).
  - `reviews.app_id` (NULL = legacy global App); findings join via `review_id`.
  - `app_provider_keys(app_id, provider, key_enc, PK(app_id, provider))`; `app_model_config(app_id PK, model_chain)`.
- **Crypto**: AES-256-GCM envelope via `secretbox`, master key `DASHBOARD_ENCRYPTION_KEY`, AAD rowKey = row PK (composite for provider keys) — see `d1-secretbox-credential-envelope.md`.
- **Webhook routing**: legacy `POST /webhook` (Worker-secrets App, untouched) + per-App `POST /webhook/:appSlug` (resolve slug → verify with that App's secret); queue messages carry optional `appRef` (absent = legacy).
- **Consumer**: per-App Octokit instance cache + per-message app-row re-read; `buildRunnerEnv(env, appCfg)` — App provider keys win, global env keys are the per-provider fallback (`key_source: app|global`), App `model_chain` overrides `OMP_REVIEW_MODEL`, `OMP_MODEL_KEY → ARK_API_KEY` stays global; fail-closed on tampered/missing key material.
- **Manifest flow**: writes D1 (secrets-bulk retired; CLOUDFLARE_* env gone); slug minted at start, carried via signed state; webhook URL `{origin}/webhook/{slug}`.
- **Known accepted trade-offs** (do not re-litigate without a decision): resolution-before-done-check → DLQ noise on disabled-App redelivery; secret-keyed caches without eviction (rotation = non-goal until B3+); no `reviews.app_id` index yet; one undecryptable key row fails that App's reviews closed.

## Why This Matters

B3 (per-App `REVIEW_ENABLED`, install-health UI) and B6 (per-role models via omp `modelRoles`, custom-provider `models.yml` generation) build directly on these tables and seams; the omp-side research for B6 lives in `.mstar/projects/dev-dashboard/research/2026-08-29-access-control-and-multi-app.md` (process-local — re-promote when B6 starts).

## When to Apply

Planning any new per-App setting kind (add a column/table + settings route + assembly rule, following the `key_source` pattern), or debugging attribution/isolation issues across Apps.

## Examples

- `.mstar/plans/12..14` (v0.5); `src/dashboard/{users,apps-store,app-config-store,secretbox}.ts`; `src/pipeline/consumer.ts`; `tests/pipeline/perapp-env-assembly.test.ts`.
