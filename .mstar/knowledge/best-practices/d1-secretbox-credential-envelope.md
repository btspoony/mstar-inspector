---
module: dashboard / secretbox (credential encryption at rest)
date: 2026-08-29
problem_type: best_practice
category: best-practices
severity: high
plan_id: 13-dashboard-multi-app
tags: [d1, aes-gcm, secretbox, credential-storage, webcrypto, workers]
related_components: [github_apps, app_provider_keys, manifest-hold-cookie]
---

# AES-256-GCM credential envelope for D1-stored secrets (secretbox)

## Context

v0.5 moved GitHub App PEMs / webhook secrets / provider API keys from Cloudflare Worker secrets into D1 (`github_apps`, `app_provider_keys`). Plaintext secrets must never touch SQLite files, backups, or exports, so everything is stored through one encryption leaf module (`src/dashboard/secretbox.ts`) shared by dashboard routes, the worker webhook face, and the pipeline consumer.

## Guidance

- **Envelope**: `v1.<keyId>.<iv_b64>.<ct_b64>` — standard base64 (NOT base64url: the D1 carrier differs from the manifest-hold cookie), 12-byte random IV, ciphertext-and-GCM-tag encoded once, `keyId` constant `primary` (rotation-ready: decrypt dispatches on keyId).
- **Master key**: Worker secret `DASHBOARD_ENCRYPTION_KEY`, base64 of exactly 32 bytes; missing / malformed / unknown keyId → typed `SecretboxKeyError` → routes map to 5xx fail-closed. **Never** fall back to `DASHBOARD_SESSION_SECRET` (rotation decoupling).
- **AAD is mandatory and structural**: `encryptSecret(plain, aad)` with AAD `<table>.<column>:<rowKey>`. The rowKey MUST be the row's primary key (`github_apps` → its UUID `id`, supplied by the caller at insert time; composite `<appId>:<provider>` for `app_provider_keys`). Compute the AAD **before** INSERT — a store that mints the id internally cannot deliver a lock-conformant AAD and produces undecryptable rows.
- **Leaf discipline**: `secretbox.ts` imports nothing (WebCrypto only) so dashboard, worker, and pipeline can all use it without violating the one-way `dashboard ↛ pipeline/worker` isolation.
- **Plaintext lifetime**: decrypt at the last responsible moment (consumer-side resolution; PEM never enters queue payloads or logs); per-message re-read makes key rotation apply to the next review without redeploy.

## Why This Matters

Worker secrets are single-valued per deployment; multi-App storage requires a database, and SQLite/D1 artifacts (backups, `wrangler d1 export`) leak unless encrypted at rest. The AAD binding is what makes ciphertexts non-replayable across rows — a ciphertext copied to another row (or another provider slot) fails the GCM tag.

## When to Apply

Any Worker/D1 feature that must persist per-tenant or per-entity credentials; anywhere a "hold in an encrypted cookie" pattern (B1 manifest hold) needs a durable sibling.

## Examples

- `src/dashboard/secretbox.ts` (envelope + key cache); `src/dashboard/apps-store.ts` (`createApp` takes caller-supplied `id`, encrypts before insert); `src/dashboard/app-config-store.ts` (composite AAD for provider keys); `src/pipeline/consumer.ts` (decrypt face, per-message re-read).
- Tests to copy: tamper + AAD-mismatch anchors (`/AAD mismatch/`), short-key rejection, cross-provider/cross-app isolation, `not.toContain` sweeps in HTML fixtures.
