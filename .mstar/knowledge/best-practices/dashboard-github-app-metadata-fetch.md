---
module: dashboard / github app metadata (settings read face)
date: 2026-09-08
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 53-app-info-header
tags:
  - github-app
  - jwt
  - webcrypto
  - fail-open
  - d1-cache
  - lazy-refresh
  - secretbox
  - workerd
related_components:
  - src/dashboard/github-app-metadata.ts
  - src/dashboard/apps-store.ts
  - src/dashboard/private-key.ts
  - src/dashboard/index.ts
---

# Per-App GitHub metadata fetch: dashboard-local JWT + fail-open-by-structure + TTL lazy refresh

## Context

Plan 53 (017-dashboard-ux) needed the App settings page to show the GitHub App's real identity (avatar, name, description, settings URL). The dashboard had zero GitHub API calls — only the review pipeline used octokit, and `consumer.ts:449-455` pins `createAppAuth` construction to a single pipeline site (installation-token face). The metadata need is a *different* auth shape: a short-lived App JWT for one `GET /app` call, per-App, from the dashboard read path.

## Guidance

- **Mint locally, never import the pipeline.** `src/dashboard/github-app-metadata.ts` is a dashboard-local module: secretbox-decrypt the per-App PEM → reuse `normalizePrivateKey` from `src/dashboard/private-key.ts` (the lock-L1 reserved copy of the pipeline helper — its intended first consumer) → pure WebCrypto RS256 JWT (numeric `iss` = github_app_id, 60s iat backdate, ≤600s life) → plain `fetch` with `Authorization: Bearer`. Zero octokit, zero `createAppAuth` construction; the pipeline pin stays intact because the pin governs the installation-token octokit face, not raw JWT minting.
- **Fail-open by structure, not intention.** The whole refresh leg (decrypt → mint → fetch → persist) sits inside its own catch-all that returns `{ok:false}` and is *called outside the route's outer error-face try*. No failure class inside the leg can produce a 5xx. Missing `DASHBOARD_ENCRYPTION_KEY` / undecryptable PEM → skip refresh silently, serve cached columns. Missing key on the manage-write branches keeps its pre-existing 500 semantics — the fail-open applies to the metadata read face only.
- **TTL lazy refresh on the read path; no cron/queue/retry.** Refresh at most once per request when `github_metadata_synced_at` is NULL or older than `GITHUB_METADATA_TTL_MS` (24h). Success persists via a **single writer** (`saveGithubMetadata`, new-columns-only UPDATE, never touches `updated_at`) and stamps the sync time; failure leaves stale values. Bound is "≤1 fetch per request; ≤1/App/day once a sync succeeds" — while GitHub keeps failing every stale read attempts once (accepted; a warn log with stage + appId keeps outage mode observable).
- **Timestamps follow table convention.** `github_metadata_synced_at` is nullable TEXT via `datetime('now')` (matching 0004/0008), parsed as UTC in JS; NULL/garbage/future → stale (safe direction).
- **Extract only public profile fields and gate their shape.** From `GET /app` keep name/description/html_url/avatar_url; enforce `https:` on extracted URLs at the extraction layer (drop otherwise) so downstream `href`/`img` faces never receive a scheme surprise.
- **Degrade per field in the SPA.** The settings identity card renders whatever columns exist; all-null still renders local fields (slug/AppID) with no link; name-without-URL is plain text, never an empty href.

## Why This Matters

The pin discipline (single `createAppAuth` construction point) and the fail-closed posture elsewhere in the platform make "just call the GitHub API from the dashboard" non-obvious. This pattern adds a GitHub-calling face without touching the pipeline, without new failure classes on the settings route, and without an unbounded egress amplification surface — and every property is pinned by route tests (first-sync / TTL-hit / fail-open / decrypt-miss / missing-key / viewer parity).

## When to Apply

Any dashboard-side, read-path GitHub API need that is metadata-only (public profile), per-App, and non-interactive. Not for installation-token operations (pipeline face), not for anything needing retries or write scopes.

## Examples

`src/dashboard/github-app-metadata.ts` (fetchAppMetadata, isGithubMetadataStale), `src/dashboard/index.ts` `refreshGithubMetadataForRead` (fail-open leg + logging), `tests/worker/settings-github-metadata.test.ts` (three-state route pins), `tests/dashboard/github-app-metadata.test.ts` (JWT/timeout/retry pins).

Related: `github-app-pem-workerd.md` (workerd WebCrypto PKCS#1→PKCS#8 JWT base), `d1-secretbox-credential-envelope.md` (PEM envelope).
