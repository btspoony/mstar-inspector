# Operator admin surface (operator-admin-surface)

> **Status:** FROZEN 2026-10-25 — promoted at iteration close from the iteration package, after architect review, a three-seat plan QC and mandatory QA.
> **SSOT:** This file — the `/_internal_admin` namespace, its authorization model, its four surfaces plus support-grant maintenance, and the platform audit split.
> **Authority:** Delivered 2026-10-25; the code paths named below are the implementation references.
> **Staged amendment (032-cleanup-sweep):** full copy of the frozen global spec plus ONE added §4 clause recording the audit-retention decision (compass D15, plan 119 Task 5). The global `{SPECS_DIR}` copy is frozen for this iteration and is not edited; PM promotes this copy at iteration-close.

## 1. Identity and authorization

- Identity source: `PLATFORM_OPERATORS` (`src/worker/env.ts:66-74`), comma
  separated GitHub logins, case-insensitive, parsed by `parseLoginList`. Unset or
  empty means nobody is an operator.
- Authorization is checked **per request inside every handler**, via the existing
  `isPlatformOperator` (`src/dashboard/index.ts:897-901`). It is not inherited from
  an upstream middleware, a workspace role, or a support grant.
- A non-operator receives **404**, identical to any unknown path. The surface does
  not confirm its own existence.
- `self-hosted` mode registers no admin routes and renders no entry point. This is
  enforced at registration time, not by a runtime flag inside each handler.

## 2. Route namespace

`/_internal_admin` and `/_internal_admin/api/*`, mounted on the same Hono worker
(`src/worker/index.ts`), **outside** `dashboardApp` and therefore outside the
`/dashboard` tenant gate, workspace principal classifier and
`isOperatorReadPath` ceiling (`src/dashboard/index.ts:916-921`).

Reason: `isOperatorReadPath` matches by `path.endsWith(route.path)`; placing admin
paths in `APP_ROUTES` with `access: "read"` would silently widen the operator
read ceiling for workspace routes. The admin namespace must not join that
table — page routes AND `api/*` routes alike; the ceiling rule has no
exception for API paths. Admin route declarations live ONLY in the sub-app's
own local table inside `src/admin/index.ts`, mounted beside the dashboard app
(`app.route("/_internal_admin", adminApp)` next to
`app.route("/dashboard", dashboardApp)`, `src/worker/index.ts:138` — disjoint
prefixes, so no dispatch-order coupling exists).

Session: reuse the existing signed-cookie session. An admin request without a
valid session is a 404 (not a redirect to login, which would confirm the path).

## 3. Surfaces

### 3.1 Server flags

Table `server_flags (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`.

Initial keys and their exact consumer:

| key | consumer | semantics when disabled |
|-----|----------|-------------------------|
| `review_global` | enqueue decision in `src/worker/index.ts`, beside the per-App `review_enabled` pause gate (`:334`; the enqueue itself is `handleReviewJob` at `:348`) | webhook still answers 2xx, nothing is enqueued. Already-queued reviews are **not** cancelled — the UI states this |
| `signup_open` | OAuth callback's first-sign-in branch (`src/dashboard/index.ts:992-1050` region) | an unknown login cannot create a `users` row; existing rows are unaffected |
| `workspace_creation_open` | `POST /dashboard/api/workspaces` (`index.ts:1069-1112`) and the dashboard "new workspace" menu item | 409 with a named refusal; the menu item is disabled with the reason |

Read pattern: one prepared `SELECT key, enabled FROM server_flags` per decision
site, no caching layer, no KV. Absent row = enabled (fail-open to current
behaviour) so a missing row never breaks the platform.

Read cost (architect verdict, 2026-10-25): the per-request prepared point read
is ACCEPTED; no request-scoped memo is required. Each consumer reads its flag
exactly once per request, and the `review_global` site rides a webhook path
that already executes several D1 statements per verified delivery
(`recordDelivery`, `touchLastWebhook` — `src/worker/index.ts:294-323`) plus a
KV idempotency check and the queue send; one PK point read is marginal and
fail-open. A request-scoped memo becomes REQUIRED only if a future consumer
reads the same flag twice within one request; cross-request caching stays
forbidden.

### 3.2 Workspace plan assignment

`PATCH /_internal_admin/api/workspaces/:id/plan` with `{ planId }`.

- Validates `planId` against the `plans` catalogue (unknown id → 400).
- Upserts `workspace_subscriptions` (`status='active'`, `updated_at` now).
- Downgrading below the current live member count is allowed: it blocks **new**
  invites, never removes members.
- Writes one platform audit row.
- Never edits `plans` rows.

### 3.3 Read lists

- `GET /_internal_admin/api/workspaces` — id, name, slug, owner login, live
  member count, pending invite count, `planId`, `createdAt`.
- `GET /_internal_admin/api/users` — login, first-seen (`users.created_at`),
  workspace count, `isOperator` (from the env list), active support-grant count.

Both are single-statement reads with the counts resolved in SQL, not N+1.

### 3.4 Support grants

- `GET /_internal_admin/api/support-grants` — active grants across workspaces.
- `POST /_internal_admin/api/support-grants` — `{ workspaceId, operatorLogin,
  reason, ttlHours }`; reuses `insertSupportGrant` and its validation.
- `DELETE /_internal_admin/api/support-grants/:id` — deletes the row; a grant is a
  time-boxed access aid, not history, so removal is a delete, not a tombstone.
- Grant writes append to the existing `audit_events` table with the target
  `workspace_id` (that table requires one).

## 4. Platform audit

New table `platform_audit_events (id TEXT PRIMARY KEY, actor_login TEXT NOT NULL COLLATE NOCASE, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, detail_json TEXT, created_at TEXT NOT NULL)` with an index on `(created_at)`.

Written for: flag toggles, workspace plan changes. Not reused for support grants
(they already fit `audit_events`).

The existing `audit_events.workspace_id NOT NULL` is deliberately not relaxed: it
is a forward-only column contract shared with workspace-level auditing, and
platform scope is a different lifecycle.

Split verdict (architect, 2026-10-25): no admin action loses its audit trail.
Every admin WRITE has exactly one home — flag toggles and plan assignment are
platform-scope decisions → `platform_audit_events` (actor, action, target,
before/after detail); support-grant create/delete are workspace-scope writes →
`audit_events`, whose `workspace_id NOT NULL`
(`migrations/0029_operator_support.sql:50-55`) the grant's target workspace
always satisfies. Admin list reads are deliberately unaudited: audit rows
attach to writes and to operator presence inside a tenant (the existing
support-grant middleware already writes `support.read` / `support.denied`,
`src/dashboard/index.ts:861-880`), not to platform-scope reads.

### 4.1 Retention

**Append-only, no pruning, retained indefinitely.** Neither table gains a delete
path: `audit_events` has no `UPDATE` or `DELETE` statement by construction
(`migrations/0029_operator_support.sql:19`), and `platform_audit_events` is
written the same way — the operator surface exposes no route that would remove a
row from either ledger. Retention is therefore a property of the schema, not a
job that has to be scheduled and kept working.

Revisit this decision when **row count or query latency becomes a problem** —
whichever is observed first. Because both tables are indexed for the read that
matters, the revisit starts from measured numbers, not from a fixed horizon:
`audit_events` carries `audit_events_workspace ON audit_events (workspace_id,
created_at)` for the per-workspace timeline its readers ask for, and
`platform_audit_events` carries `platform_audit_events_created ON
platform_audit_events (created_at)` for the platform timeline. Any future
pruning or archival must land as an explicit schema and contract change here —
never as an ad-hoc cleanup run against production data.

## 5. Entry point visibility

The dashboard shell renders a "platform operations" link only when the boot
payload says the viewer is an operator **and** the deployment mode is `saas`.
Boot gains one boolean; it is derived server-side from
`isPlatformOperator(env, login)` combined with
`deploymentModeOf(env.DEPLOYMENT_MODE) === "saas"`, never from a client check.
`isPlatformOperator` takes the `Env` (it parses `PLATFORM_OPERATORS`), not a mode
string — the mode is a separate conjunct.

## 6. Non-goals

- No billing, invoicing or payment integration.
- No `plans` catalogue editor.
- No operator impersonation of a workspace member (support grant remains the only
  cross-workspace access path).
- No admin action on review findings, review rows or apps beyond the
  `review_global` flag.
