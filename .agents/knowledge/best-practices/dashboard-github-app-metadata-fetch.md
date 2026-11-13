---
module: dashboard / github app metadata (settings read face)
date: 2026-10-29
problem_type: best_practice
category: best-practices
severity: medium
topic: app info header
tags:
  - github-app
  - jwt
  - webcrypto
  - fail-open
  - d1-cache
  - lazy-refresh
  - secretbox
  - workerd
  - app-icon
  - webhook-url
related_components:
  - src/dashboard/github-app-metadata.ts
  - src/dashboard/apps-store.ts
  - src/dashboard/private-key.ts
  - src/dashboard/index.ts
  - src/spa/components/AppAvatar.tsx
---

# Per-App GitHub metadata fetch: dashboard-local JWT + fail-open-by-structure + TTL lazy refresh

## Context

The dashboard-UX work needed the App settings page to show the GitHub App's real identity (logo, name, description, settings URL). The dashboard had zero GitHub API calls — only the review pipeline used octokit, and `consumer.ts:449-455` pins `createAppAuth` construction to a single pipeline site (installation-token face). The metadata need is a *different* auth shape: a short-lived App JWT for one `GET /app` call, per-App, from the dashboard read path.

## Guidance

- **Mint locally, never import the pipeline.** `src/dashboard/github-app-metadata.ts` is a dashboard-local module: secretbox-decrypt the per-App PEM → reuse `normalizePrivateKey` from `src/dashboard/private-key.ts` (the lock-L1 reserved copy of the pipeline helper — its intended first consumer) → pure WebCrypto RS256 JWT (numeric `iss` = github_app_id, 60s iat backdate, ≤600s life) → plain `fetch` with `Authorization: Bearer`. Zero octokit, zero `createAppAuth` construction; the pipeline pin stays intact because the pin governs the installation-token octokit face, not raw JWT minting.
- **Fail-open by structure, not intention.** The whole refresh leg (decrypt → mint → fetch → persist) sits inside its own catch-all that returns `{ok:false}` and is *called outside the route's outer error-face try*. No failure class inside the leg can produce a 5xx. Missing `DASHBOARD_ENCRYPTION_KEY` / undecryptable PEM → skip refresh silently, serve cached columns. Missing key on the manage-write branches keeps its pre-existing 500 semantics — the fail-open applies to the metadata read face only.
- **The same refresh reconciles the App's installation rows.** A `GET /app/installations?per_page=100` (same App JWT; the JWT is valid on `/app*`) returns the ids GitHub still has, and `reconcileInstallations` stamps `app_installations.removed_at` on local rows absent from that set (clearing the stamp for rows present), so a missed `installation.deleted` delivery repairs itself on the next refresh or the manager's forced one. The fetch is **all-or-nothing**: a `Link rel="next"` outside `api.github.com/app/installations`, or a pending next page at the 10-page cap, is `{ok:false}` — a truncated id set must never reach a `NOT IN` reconcile that would hide installations GitHub still has. Rows are never deleted (the credential-routing and failure-attribution joins read the table). The id set travels as one JSON bind through `json_each(?)`: D1 caps a statement at 100 bound parameters, so one placeholder per installation would fail exactly at the first full page. Cost is bounded as a LEG, not per page: the listing shares ONE 5 s wall-clock budget across its 1–10 sequential pages (100 ids each), so a real refresh is profile (≤5 s) + listing (≤5 s total) + visibility probe (≤3 s) ≈ 13 s worst case — not one request, and not ten times the profile budget. None of it runs on the fresh-TTL or key-missing paths, and a failure (an exhausted budget included) changes no row. The reconcile also carries the store clock captured BEFORE the listing was fetched: both UPDATEs are gated on it (`seen_at <= observedAt` to stamp, `removed_at < observedAt` to clear) and run in one batch, so a row created while the listing was in flight and a removal newer than the snapshot both survive. Every compared stamp is written sub-second (`strftime('%Y-%m-%d %H:%M:%f','now')`, not `datetime('now')`): a plain second marker makes every same-second comparison a tie and would either leave a just-cleared installation hidden for a TTL or stamp a same-second in-flight row. Lexicographic comparison stays valid — a legacy second-resolution value is a prefix of, and sorts before, its fractional successor — so no migration or column change is involved. A replayed `installation.deleted` processed after a reinstall's `created` still stamps — the payload carries no reliable order — and the next refresh clears it; that window is bounded by the 24 h TTL.
- **TTL lazy refresh on the read path, plus a manager-forced refresh.** Refresh at most once per request when `github_metadata_synced_at` is NULL or older than `GITHUB_METADATA_TTL_MS` (24h). Success persists via a **single writer** (`saveGithubMetadata`, new-columns-only UPDATE, never touches `updated_at`) and stamps the sync time; failure leaves stale values. Bound is "≤1 refresh per request — profile (≤5 s) + installation listing (1–10 pages inside one 5 s budget) + visibility probe (≤3 s), ≈13 s worst case — and ≤1/App/day once a sync succeeds" — while GitHub keeps failing every stale read attempts once (accepted; a warn log with stage + appId keeps outage mode observable). The same `refreshGithubMetadata(app, apps, key, { force })` core serves a manager-only `POST /api/apps/:appId/refresh-metadata`: `force: true` always calls GitHub, so a rename or a new logo is visible without waiting out the TTL. An upstream failure there answers the keyed 400 `settings.error.githubMetadataRefreshFailed` (never a 5xx) and leaves the cached columns untouched; the read path stays fail-open because its result is discarded.
- **Never invent an identity; cache what GitHub says.** Local identity is the row, not a path column: `webhook_path` no longer exists (migration 0038 dropped it — and had to rebuild `github_apps` rather than `ALTER TABLE … DROP COLUMN`, because 0036's rename carried the original `UNIQUE` constraint onto the column and SQLite refuses to drop a UNIQUE column), and the App's webhook URL is `{origin}/webhook/{workspaces.id}/{github_apps.id}` — the row's own primary key is the URL's app segment, so there is one local identifier instead of two. The manifest constraint fixes the order: the hook URL must be final **before** GitHub creates the App, so it can never contain `github_app_id`; `workspaces.id` and the locally minted `github_apps.id` both exist at that moment, which is why only they may appear in it. `github_app_id` is the external identity every dashboard/API URL keys on; `github_slug` is a **cache** of GitHub's mutable App slug, filled from `GET /app` at manifest conversion and on every refresh. `github_slug` is the bot-mention target and the display fallback — NULL until the first sync, so no mention can match a guessed slug (fail-safe), and a GitHub-side rename takes effect only on the next refresh.
- **Timestamps follow table convention.** `github_metadata_synced_at` is nullable TEXT via `datetime('now')` (matching 0004/0008), parsed as UTC in JS; NULL/garbage/future → stale (safe direction).
- **Extract only GitHub facts, gate their shape, and know which response has which field.** From `GET /app` keep name/description/`html_url`/`slug`, and enforce `https:` on extracted URLs at the extraction layer (drop otherwise) so downstream `href`/`img` faces never receive a scheme surprise. The REST `integration` schema (`GET /app`) has **no logo field**, and no follow-up request can recover one: an App JWT is valid only on `/app*`, `GET /orgs/:org/installation`, `GET /repos/:owner/:repo/installation` and `GET /users/:username/installation`, so even the public `GET /users/<slug>[bot]` needs an installation or user token — the previously documented second request always failed and is removed. Derive the icon from `github_app_id` instead: `https://avatars.githubusercontent.com/in/<id>?s=120&v=4` is the very object the bot account's `avatar_url` points at. No request, no slug dependency, so this leg cannot fail; a CDN failure degrades to the default mark in the SPA (`AppAvatar` onError).
- **Derive the slug only from a verifiable shape.** `data.slug` is authoritative; `githubAppSlugFromHtmlUrl` covers a payload that drops it, accepting only `https://…/apps/<one-segment>` and returning null for anything else — a guessed slug would become the bot-mention target. The one `GET /app` response feeds the SPA's per-field degradation: display name `github_name ?? github_slug ?? String(github_app_id)`, avatar the derived `github_avatar_url`; all-null still renders the App id with no link, and name-without-URL is plain text, never an empty href.

## Why This Matters

The pin discipline (single `createAppAuth` construction point) and the fail-closed posture elsewhere in the platform make "just call the GitHub API from the dashboard" non-obvious. This pattern adds a GitHub-calling face without touching the pipeline, without new failure classes on the settings route, and without an unbounded egress amplification surface. The identity split it now feeds is the other half: a locally minted row id can route webhooks, and a cached GitHub slug can name the bot, but neither may become the App's identity — only `github_app_id` is stable enough to address it.

## When to Apply

Any dashboard-side, read-path GitHub API need that is metadata-only (public profile), per-App, and non-interactive. Not for installation-token operations (pipeline face), not for anything needing retries or write scopes. Treat every profile column as a mutable cache: if a value could address or authorize something, it belongs in its own identity column instead.

## Examples

`src/dashboard/github-app-metadata.ts` (`fetchAppMetadata`, `githubAppSlugFromHtmlUrl`, `isGithubMetadataStale`), `src/spa/components/AppAvatar.tsx` (icon + `onError` default-mark fallback), `src/dashboard/index.ts` (`refreshGithubMetadata` with `{ force }`, `refreshGithubMetadataForRead`, `appRefreshMetadataRoute`), `tests/worker/settings-github-metadata.test.ts` (three-state read pins + the forced-refresh 400/2xx), `tests/dashboard/github-app-metadata.test.ts` (JWT/timeout/avatar-derivation/degradation pins).

Related: `github-app-pem-workerd.md` (workerd WebCrypto PKCS#1→PKCS#8 JWT base), `d1-secretbox-credential-envelope.md` (PEM envelope).