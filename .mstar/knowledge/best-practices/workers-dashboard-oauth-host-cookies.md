---
module: dashboard
date: 2026-08-28
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
- GitHub fetches: `AbortSignal.timeout`; consume failed bodies; structured `console.warn` JSON without codes/tokens.
- Fail-closed: missing secrets 5xx; bad state 4xx and no session cookie.

## Why This Matters

Wrong Accept on the token endpoint yields form-urlencoded bodies; `res.json()` throws and login never sets a cookie. Mixing App PEM into OAuth exchange is a credential-class bug.

## When to Apply

- Any `/dashboard` auth change. B1 App Manifest is a different GitHub API — do not reuse this token endpoint.

## Examples

### Before

Shared `Accept: application/vnd.github+json` on both token and `/user`.

### After

Token call uses `Accept: application/json`; `/user` keeps REST media type.
