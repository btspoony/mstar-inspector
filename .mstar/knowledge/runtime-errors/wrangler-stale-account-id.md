---
module: ops-deploy-wrangler-account
date: 2026-09-01
last_updated: 2026-09-01
problem_type: runtime_error
category: runtime-errors
severity: medium
applies_when:
  - "wrangler (d1 execute / deploy / secret) fails with Cloudflare API error 7403 'The given account is not valid or is not authorized'"
  - "Cloudflare operations work for one teammate/machine but fail from another checkout"
  - "Auditing which Cloudflare account a Worker/D1 actually lives in before deploy"
plan_id: 24-legacy-webhook-retirement
tags:
  - cloudflare
  - wrangler
  - account-id
  - env-hygiene
---

# wrangler 7403 "account is not valid or is not authorized" — stale CLOUDFLARE_ACCOUNT_ID env

## Problem

`npx wrangler d1 execute DB --remote …` (and any account-scoped wrangler call) fails with:

```
APIError 7403 — "The given account is not valid or is not authorized to access this service"
accountTag: 9dee30da5bcc25895788d8e4f71fe46d
```

The token is fine; the operation succeeds from other machines.

## Symptoms

- Error appears only on machines/shells where `CLOUDFLARE_ACCOUNT_ID` is exported.
- The `accountTag` in the error names an account that is NOT the one owning the Worker/D1 (stale after an account migration or re-org).
- Recurred in this repo across v0.7→v0.9 (flagged in the v0.8 retrospective: the stale value sat in env for several iterations until a pre-flight caught it).

## What Didn't Work

- Re-logging in (`wrangler login`) — token was already valid; the env var overrides account resolution.
- Retrying / network diagnostics — nothing wrong with connectivity (this repo hit a coincidental GitHub TLS outage the same day; do not conflate the two).

## Solution

Drop the stale env override so wrangler resolves the account from the API token's default:

```bash
env -u CLOUDFLARE_ACCOUNT_ID npx wrangler d1 execute DB --remote --command "SELECT …"
# or: unset CLOUDFLARE_ACCOUNT_ID
```

Then fix the source: remove `CLOUDFLARE_ACCOUNT_ID` from the shell profile / `.env*` files that export it, or set it to the owning account (this repo's live Worker lives under the Bohao account, `f68fcd78…`; the stale value `9dee30da…` belonged to a previous org).

## Why This Works

Wrangler prefers an explicit `CLOUDFLARE_ACCOUNT_ID` over token-derived account resolution. When the env value names an account the token cannot access, every account-scoped API call fails with 7403 regardless of the token's actual validity — the error text points at the account, which is the tell.

## Prevention

- Ops runbooks (docs/deploy.md § Multi-App go-live) treat "unset/verify `CLOUDFLARE_ACCOUNT_ID`" as a pre-flight step, not tribal knowledge.
- One-off remedy: `env -u CLOUDFLARE_ACCOUNT_ID wrangler …`; durable remedy: purge the var from the environment that exports it.
- When the error names an `accountTag`, diff it against the account that owns the resource before touching credentials.
