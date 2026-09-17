---
module: dashboard / membership authz (B4)
date: 2026-08-29
last_updated: 2026-09-18
problem_type: best_practice
category: best-practices
severity: high
topic: dashboard access control
tags:
  - oauth
  - allowlist
  - guard-middleware
  - stateless-cookies
  - invite-only
  - hono
related_components:
  - session.ts
  - users.ts
  - index.ts
---

# Invite-only membership on top of stateless OAuth sessions (Workers dashboard)

## Context

v0.5 B4 added membership control to a dashboard whose sessions are stateless HMAC cookies (`__Host-mstar-session`, payload `login/name/iat/exp` — no new claims). Authorization had to work per-request without a session store.

## Guidance

- **Bootstrap precedence (exact order)**: user row exists → proceed; GitHub login in `ADMIN_LOGINS` (comma-separated **var**) → create admin; table empty **and** `ADMIN_LOGINS` unset → first login becomes admin; otherwise deny (403 page, **zero Set-Cookie**, zero writes). Logins compare case-insensitively (`COLLATE NOCASE` lookup); migration 0016 adds a NOCASE UNIQUE index on `users.github_login` (the 0003 UNIQUE is BINARY), so a case-variant insert conflicts at the DDL layer — the store surfaces `DuplicateLoginError` and the invite route answers 409. The NOCASE pre-read remains the sequential-path friendly no-op; the index closes the concurrent window.
- **Single guard mount**: one Hono `app.use("*", guard)` before all route definitions; exempt set is exactly the login + OAuth callback paths (loop impossibility). The guard adds only the D1 membership check on top of each route's own session handling — removed members' existing cookies fail there, no session invalidation store needed. Logout is **session-gated but not membership-gated** (a removed member must be able to burn their cookie; a data route must not).
- **Admin gates**: shared fail-closed `requireAdmin` before any membership read/write; refuse self-removal and last-admin removal; make the last-admin delete a single conditional `DELETE ... WHERE` statement (read-check-delete is a TOCTOU).
- **Fail closed on unbound D1**: 500, never silently treat as "no members" or "not a member".

## Why This Matters

Stateless cookies are the cheap option on Workers, but they cannot be revoked — the per-request D1 check is the revocation mechanism. The bootstrap matrix is the security boundary of the whole deployment (first login on a public URL claims admin), so it is pinned by a four-case test matrix, not prose.

## When to Apply

Any multi-user dashboard on stateless sessions; any "first operator claims admin" bootstrap; any Hono sub-app where middleware order (guard before routes and catch-alls) matters.

## Examples

- `src/dashboard/users.ts` (store + `bootstrapDashboardAccess`), `src/dashboard/index.ts` (guard mount + `requireAdmin` + members routes), `tests/worker/dashboard.test.ts` (bootstrap matrix, removed-member 403 with zero-network assertion, conditional-delete matrix).


## Read-face visibility layer over membership (2026-09-18 refinement)

The membership guard answers "may this login see the dashboard at all"; a second
layer answers "how much of this App may this member see". Verified contract
(frozen spec `dashboard-app-detail-visibility`):

- **Two-tier read faces on every App surface.** `canManageApp` (creator-or-admin)
  splits each payload into an identity tier and an ops tier. Identity tier =
  exactly what the Apps-list rows expose (slug, `github_app_id`, `status`,
  `review_enabled`, `created_by`) plus `created_at` + the public `github_*`
  profile block + `can_manage: false` — safe for every member. Ops tier
  (installations, deliveries, sandbox image, provider keys/chains, trigger
  runtime config, insights) rides only the manager branch.
- **Discrimination key stays `can_manage`** on one endpoint/one matcher entry;
  the client parses both faces from the same route. Never open a second data
  face for a visibility tier — it re-creates the leak the tier exists to close.
- **Insights are per-App by contract.** A cross-App aggregation face (page or
  API) has no legitimate member consumer; if it ever exists it must be
  admin-gated — the 2026-09-18 iteration removed the global face entirely
  (removal > gating: deletes the exposure root and the second face to maintain).
- Test anchor: `tests/worker/app-permission-matrix.test.ts` pins both faces'
  exact key sets (sorted-equality, so a new ops key cannot leak by accident).
