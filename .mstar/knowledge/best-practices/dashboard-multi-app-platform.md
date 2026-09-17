---
module: dashboard / multi-App platform (B4+B5+B2 contract)
date: 2026-08-29
last_updated: 2026-09-18
problem_type: best_practice
category: best-practices
severity: medium
topic: dashboard multi-app
tags:
  - multi-app
  - data-model
  - webhook-routing
  - byok
  - design-contract
  - v0-5
related_components:
  - github_apps
  - app_provider_keys
  - app_model_config
  - reviews
applies_when:
  - planning B3 (per-App ops UI) or B6 (per-role models) on this platform
  - extending the per-App configuration model to new setting kinds
---

# Multi-App audit platform — durable data & contract summary (promoted from v0.5 spec)

> Promoted to: this doc (structured condensation of the v0.5 dashboard multi-app platform spec; the source snapshot was process-local and is not tracked). Source recorded per compound Phase 4 trace.

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
- **Webhook routing**: per-App `POST /webhook/:appSlug` is the ONLY entry (resolve slug → verify with that App's secret) — the legacy bare `POST /webhook` face was retired in v0.9 (route deleted); queue messages always carry `appRef` (required — single shape since v0.9).
- **Consumer**: per-App Octokit instance cache + per-message app-row re-read; `buildRunnerEnv(appCfg, …)` takes NO env argument — keys and the model chain come exclusively from the App's per-App config (`key_source` ∈ `app|custom` only, no global fallback since v0.9 / AL-24-5), and a missing/tampered key or chain fails that App's reviews closed at `assertAppConfigComplete` (F-001 channel) — see `perapp-zero-global-fallback.md`.
- **Manifest flow**: writes D1 (secrets-bulk retired; CLOUDFLARE_* env gone); slug minted at start, carried via signed state; webhook URL `{origin}/webhook/{slug}`.
- **Known accepted trade-offs** (do not re-litigate without a decision): resolution-before-done-check → DLQ noise on disabled-App redelivery; secret-keyed caches without eviction (rotation = non-goal until B3+); no `reviews.app_id` index yet; one undecryptable key row fails that App's reviews closed.

## Why This Matters

**v0.6 update — B3 and B6 are now delivered:**
- **B3 per-App pause** (`github_apps.review_enabled`, migration 0008): pause ≠ disable — paused = webhook verify → **2xx silent ignore** (zero enqueue; `last_webhook_at` still touched), consumer in-flight = **ack-skip** (no retry/DLQ), while disabled = 404 + retry→DLQ. UI toggle (`/dashboard/apps/:slug/pause|/resume`) + install-health panel (`app_installations` + `last_webhook_at`).
- **B6 per-role models** (`app_model_roles`, migration 0009): per-App seat → selector map (4 seat agents), applied runner-side via settings overrides — mechanism doc: `omp-runner-settings-overrides.md`. Quick/default applies at the `seatModels` synthesis (explicit `model` wins over settings overrides); deep via `task.agentModelOverrides`. Custom provider catalog still deferred (image-baked `models.yml`).
- **Hardening** (0007 + caches): commenter cache fingerprinted on `github_app_id`+`private_key_enc` envelope (never `updated_at` — per-webhook writes would thrash it); verifier cache keyed by `cacheKey` with rotation-rebuild; `reviews.app_id` indexed; webhook warns carry real event/stage labels.

The omp B6 research doc (2026-08-29, process-local) is superseded by `omp-runner-settings-overrides.md` for the mechanism; the research doc is not part of the tracked repo.

## When to Apply

Planning any new per-App setting kind (add a column/table + settings route + assembly rule, following the `key_source` pattern), or debugging attribution/isolation issues across Apps.

## Examples

- Access-control / multi-app platform buildout (v0.5, migrations 0003–0009); `src/dashboard/{users,apps-store,app-config-store,secretbox}.ts`; `src/pipeline/consumer.ts`; `tests/pipeline/perapp-env-assembly.test.ts`.


## Per-App insights face (2026-09-18 contract addendum)

- `GET /api/apps/:slug/insights/summary` (window ≤90 clamp / repo / include=repos)
  replaced the retired global `/api/insights/summary`; gate = membership guard +
  slug resolution (404 unknown/soft-deleted) + `canManageApp` 403. The global
  cross-App face was removed outright — insights have no global concept.
- **Composition trap (verified):** the insights store's shared `whereSql` is NOT
  the only WHERE — the opt-in repos aggregation composes only `windowEraWhere`.
  Any new store-level filter (here: `r.app_id = ?`) must be added to BOTH faces
  or the scoped endpoint leaks cross-App rows through the bypassing query.
  Keep the filter additive (WHERE-only, byte-identical when absent) to preserve
  the zero-diff grid pin; compose alongside `windowEraWhere`, never inside.
- `reviews.app_id` (migration 0005; index 0007) backs the predicate; legacy
  `app_id IS NULL` rows are excluded by design.
