---

> **ARCHIVED 2026-08-26（v0.2）**：Probot 路线已退役（用户裁决 + spike `workers_compatible: partial`）。网关改为 Hono + Octokit 直用（`@octokit/webhooks` + `@octokit/auth-app`）。本文档保留为 M0 spike 历史；新实现见 `cloudflare-sandbox-review-isolation` / `github-app-pem-workerd` / `github-app-headless-verification`。
module: app-gateway
date: 2026-08-25
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 01-probot-gateway-spike
tags:
  - probot
  - bun
  - github-app
  - webhook
  - installation-token
  - workers-compat
applies_when:
  - Standing up a Probot GitHub App gateway on Bun
  - Fetching PR diffs with Installation Tokens under least privilege
  - Keeping gateway code portable to Cloudflare Workers
related_components:
  - createGatewayApp
  - fetchPrDiff
---

# Probot on Bun: gateway scaffold, token auth, and Workers-portability rules

## Context

mstar-inspector M0 spike (plan 01) proved Probot 14.3.2 runs on Bun 1.4.0 (host upgraded from 1.2.17; floor >= 1.3.14) with TypeScript strict + ESM. Live webhook acceptance was deferred only for missing App credentials; a runbook covers it.

## Guidance

1. **Factory, not server, in library code**: `createGatewayApp(options)` returns a Probot app loader and must never `listen`. The process entry (`src/server.ts`) owns the server + `/healthz`; keep Node-only usage there and out of `src/gateway/` (Workers portability lens: `src/gateway/` currently imports Probot types only).
2. **Whitelist events at registration**: subscribe exactly `pull_request.opened|synchronize|reopened` and `issue_comment.created` filtered to PR threads + `/review` prefix (case-sensitive). Non-whitelisted actions never register handlers.
3. **Fail closed on webhook secret**: empty `WEBHOOK_SECRET` falls through to Probot's public default `"development"` — reject empty AND `"development"` at startup (verified against installed probot source; caught by QC after initial green tests).
4. **Installation Token discipline**: `app.auth(installationId)` → octokit scoped per installation; fetch diff via `GET /repos/{owner}/{repo}/pulls/{n}` with `mediaType.diff`; minimal permissions `pull_requests:read`, `contents:read`, `metadata:read`; PATs forbidden as a substitute.
5. **Type the octokit seam structurally**: the plan-sketched `OctokitLike` was not assignable to real `ProbotOctokit` (contravariance); use structural param types (`PullsGetParams`) and guard `octokit.rest.pulls.get` exists before calling (clear rejection beats `TypeError` on `undefined`).
6. **Workers compatibility is a first-class spike question**: record `workers_compatible` in every gateway spike conclusion; Probot-on-Workers (workerd) remains unverified — M1 must either verify a thin fetch + `@octokit/webhooks` adapter (solution doc §7/§8) or keep the process entry outside Workers.
7. **Headless verification path**: creating the GitHub App itself needs the web UI (one-time, manual); but the deferred M0 live acceptance in a headless/no-UI CLI environment should exercise the **App installation-tokens API** (`POST /app/installations/{id}/tokens` via JWT) + `fetchPrDiff` directly, not the smee webhook tunnel — same auth surface under test, no public endpoint dependency. Cost delta vs webhook path: skips smee setup and PR-event plumbing; it does not validate signature verification (leave that to the webhook runbook or M1 e2e).

## Why This Matters

The gateway is the trust boundary for GitHub events; default-secret and PAT shortcuts are the two easiest ways to ship a broken one. Workers portability decisions get expensive after M1 hardening.

## When to Apply

Any Probot/App gateway scaffold; any Bun + Probot version pairing (re-verify on upgrades — record versions in the spike conclusion).

## Examples

`src/gateway/{app,auth,diff}.ts` + `src/server.ts` on `iteration/iter-001-20260825`; live-run runbook and permission checklist in iteration guide `guides/probot-bun-notes.md`.
