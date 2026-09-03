---
module: dashboard / SPA-shell-on-Worker dispatch + i18n + provider-first settings
date: 2026-09-02
last_updated: 2026-09-02
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 29-dashboard-shell-i18n
tags: [spa, vite, assets, i18n, open-redirect, per-app, review-enabled]
related_components: [src/worker/spa-dispatch.ts, src/worker/redirects.ts, src/i18n/, src/dashboard/provider-verify.ts, github_apps.review_enabled]
applies_when:
  - serving a built SPA from the existing Hono Worker without a framework router
  - adding server-resolved locale or per-request membership checks to SPA shell routes
  - restructuring per-App settings toward verify-then-select flows
---

# SPA shell on the Worker — dispatch, locale, review-brake, provider-first (v1.1)

## Guidance (durable contract)

- **Dispatch order** (`src/worker/index.ts`): `trailingSlashRedirect` (301, GET/HEAD only, `/dashboard*`) → `spaDispatch` → legacy `dashboardApp`. `SPA_PAGES` is an ENUMERATED set (home /dashboard, /insights, /members, /login, /apps/:slug/settings); anything not enumerated (POST family, /api/*, /webhook/*, /manifest/*) falls to legacy. NEVER use assets `not_found_handling` SPA fallback (it swallows legacy 404s).
- **Shell is membership-gated** (plan-12 contract): `serveSpaIndex` re-reads membership (same users lookup as the guard; fail-closed 500 on DB-unbound) → removed member gets removedPage 403 any-Accept, valid member gets shell. Test envs MUST bind ASSETS or they silently test the fall-through, not production.
- **POST duality**: SPA fetch posts carry `X-Mstar-Spa-Post: 1`; handlers branch on it — fetch → JSON/text, HTML-nav → 302 back to the SPA page (Referer sanitized via `new URL(referer, origin)` + origin equality + pathname `/`-not-`//`; never echo raw Referer — `/\evil` bypass).
- **i18n**: `src/i18n/` — en.ts is the `Dictionary` source (zh-CN typed = keyof), `resolveLocale` = cookie `mstar_locale` → Accept-Language `zh*` (first-tag, no q-values, documented) → en. Server (SSR manifest pages + boot) and SPA both call it; no middleware.
- **Boot injection**: Worker replaces `<!--SPA_BOOT-->` with `window.__BOOT__ = {locale, login, name, role}` (`<` escaped `\u003c`, no secrets); `Cache-Control: private, no-store` on boot-injected HTML and settings/models JSON routes.
- **REVIEW_ENABLED (inverted, plan 31)**: emergency brake ONLY — `!== "false"` passes; per-App `github_apps.review_enabled` is the primary switch (paused = 2xx ignore + `review_paused`; brake = `review_disabled_kill_switch`). Never surface in dashboard UI. Pre-deploy checklist: SELECT slug, review_enabled (cutover is live-immediate).
- **Provider-first settings** (per-App BYOK): add-key → server-side `verifyProviderKey` (list-models per provider; auth-probe fallback; 10s timeout; key never logged) → fail 400 + zero writes; success stores key (secretbox) + model cache (`app_provider_models`, PK(app_id, provider), ark→ark-plan alias via single `modelCacheProviderKey`). Chain/role selectors = dropdowns from verified cache only; server validates membership (`not_in_verified_models` code → i18n). Removing a key deletes its cache row in the same batch. Unsupported providers (azure-openai, ai-gateway — account-scoped hosts) are hidden + `unsupported_provider` reason.
- **Manifest auto-commit**: callback runs the same `commitManifestApp` as POST /manifest/commit (hold.login check both paths); success → 302 `/dashboard/apps/:slug/onboarding`; conflicts burn hold; retryable parks hold (confirm-resume intact).

## Why This Matters

These are the load-bearing invariants of the v1.1 dashboard carrier; new dashboard surfaces must extend the enumerated dispatch + dictionary + verify-first patterns rather than reintroducing free-text config or pre-guard shell serving.

## Examples

- `src/worker/{spa-dispatch,redirects}.ts`; `src/spa/{routes,router,Layout}.tsx`; `src/i18n/*`; `src/dashboard/provider-verify.ts`; `tests/worker/spa-dispatch.test.ts` (dispatch matrix), `tests/worker/webhook-routing.test.ts` (brake matrix).
