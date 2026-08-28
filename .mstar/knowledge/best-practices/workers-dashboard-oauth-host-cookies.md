---
module: dashboard
date: 2026-08-28
last_updated: 2026-08-29
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 08-dev-dashboard-scaffold
applies_when:
  - "Adding GitHub OAuth login on a Cloudflare Worker"
  - "Using __Host- cookies on workers.dev"
tags:
  - oauth
  - host-cookies
  - dashboard
---

# GitHub OAuth + `__Host-` cookies on Workers

## Context

B0 dashboard needs GitHub user login without mixing GitHub App JWT credentials. Session must be Worker-native (no extra KV for B0).

## Guidance

- Separate OAuth App (`GITHUB_OAUTH_CLIENT_ID` / `CLIENT_SECRET`) from GitHub App `APP_ID` / `PRIVATE_KEY`.
- Token URL: `POST https://github.com/login/oauth/access_token` with `Accept: application/json` (not `vnd.github+json`). User API keeps REST accept header.
- Cookies: `__Host-mstar-session` and `__Host-mstar-oauth-state` — HttpOnly, Secure, SameSite=Lax, Path=/, no Domain. HMAC-SHA256 via WebCrypto; independent `DASHBOARD_SESSION_SECRET`.
- CSRF state: random + HMAC, Max-Age ≤600s, invalidate on every callback.
- B1 Manifest: `__Host-mstar-manifest-state` (CSRF) and `__Host-mstar-manifest-hold` (AES-256-GCM PEM hold, HKDF info `mstar-manifest-hold`, Max-Age 600). Bind `hold.login` to session login. **Keep** hold on retryable commit failures (400 missing confirm, 500 missing CF config, 502); **expire** on success, login mismatch, bad hold, and logout (with session + state).
- GitHub fetches: `AbortSignal.timeout`; consume failed bodies; structured `console.warn` JSON without codes/tokens.
- Fail-closed: missing secrets 5xx; bad state 4xx and no session cookie.

## Why This Matters

Wrong Accept on the token endpoint yields form-urlencoded bodies; `res.json()` throws and login never sets a cookie. Mixing App PEM into OAuth exchange is a credential-class bug.

## When to Apply

- Any `/dashboard` auth change. Manifest conversion uses GitHub App Manifest API (`Accept: application/vnd.github+json`), not the OAuth token endpoint.

## Examples

### Before

Shared `Accept: application/vnd.github+json` on both token and `/user`.

### After

Token call uses `Accept: application/json`; `/user` keeps REST media type.
