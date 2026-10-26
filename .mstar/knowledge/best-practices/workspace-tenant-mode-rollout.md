---
module: dashboard / tenancy / deploy
date: 2026-10-22
problem_type: best_practice
category: best-practices
severity: high
topic: workspace tenant attribution (single read path)
tags:
  - multi-tenant
  - workspace
  - d1
  - route-gating
  - deploy-gates
  - fail-closed
related_components:
  - app_workspaces
  - workspace_members
  - apps-store
  - consumer
  - worker
last_updated: 2026-10-26
---

# Workspace tenant attribution

> **Status: the mode switch is retired.** An earlier revision of this document described a two-deploy
> `off | strict` rollout. That switch has been deleted along with its env var: the read path is single,
> and there is no configuration that can make a deployment serve cross-tenant reads. What remains below is
> the part that still holds.

## Context

The platform moved from "one deployment = one tenant" to workspace attribution. Three properties were
required at once: every App resolves to exactly one workspace, the tenant-facing read face cannot produce an
unattributed App, and the migration could not lose an existing row.

## Guidance

1. **Attribution is a narrow map table**, `app_workspaces(app_id PK, workspace_id NOT NULL)`, never a nullable
   column on the App table. SQLite cannot add `NOT NULL` to an existing column without rebuilding the table and
   its foreign-key children.
2. **One write face**: `apps-store.createApp` inserts the App and its mapping in one `db.batch`. The
   creation right is judged in the workspace the request addresses (see
   `workspace-scoped-creation-rights.md`).
3. **One read face**: the SQL always `INNER JOIN`s `app_workspaces` and returns `workspace_id`. An orphan App is
   simply absent. There is exactly one SQL text per read — no mode, no second branch.
4. **Enforce the read-face boundary by face, not by file.** Tenant-facing modules must not contain
   `from github_apps`; maintenance reads (reconcile, review-threads, review-checks) may query directly only when
   keyed by `app_id`/`installation_id` or bounded to identifiers, each annotated
   `// shortcut: tenant-bypass — <reason>`. Pin the allowlist per file **and per call site** (a file-level set
   misses a second read), scanning `.prepare(...)` arguments with a string-literal-aware matcher.
5. **Resolve the workspace after authentication.** A pre-auth lookup that returns 404 for unknown refs and
   302/403 for known ones is a tenant-existence oracle and an unauthenticated D1 read per probe. Classify the
   path in the gate; resolve the workspace and membership inside the member gate.
6. **One route table, two registrations.** Hono mounts at import time. A `{method, path, handler, access}` table
   registered under `""` and `/:workspaceRef` avoids duplicate handler bodies, and the `access` field doubles as
   the operator ceiling (see `platform-operator-support-access.md`).
7. **Put the tenant gate before SPA dispatch.** With `ASSETS` bound, `spaDispatch` runs before the dashboard app;
   a legacy App URL would otherwise be served by the shell.
8. **Membership removal is membership-only.** `workspace_members` is deleted; the `users` row and any
   deployment-level tombstone survive, because a workspace-scoped action must not ban a login globally.
9. **Put the zero-orphan assertion before every deploy-capable step** (migrations → backfill → assertion →
   secret writes → deploy → smoke → assertion), and make the assertion parser fail closed on any wrangler output
   shape other than one successful statement with one integer row.
10. **Count the version-creating steps, not just `wrangler deploy`.** `wrangler secret bulk` publishes a new
    version; any var passed to an earlier deploy does not survive it.

## Why This Matters

Each rule protects a failure mode that is invisible in unit tests:

- A nullable ownership column or a second write path lets an unattributed App exist and be executed — a billing
  and isolation hole that backfill cannot repair later.
- A file-level allowlist lets a new direct read drift in without failing.
- A pre-auth workspace lookup leaks tenant existence and amplifies anonymous traffic.
- A membership table without deletion semantics silently makes access revocation fail; a membership delete that
  also deletes the user row silently bans the person everywhere.

## When to Apply

- Adding or changing a tenant/ownership boundary over an existing single-tenant schema.
- Reviewing a read path that touches tenant-owned rows.
- Reviewing any deploy sequence that must assert data integrity before traffic.

## Examples

- Read-face allowlist: `tests/store/tenant-read-face.test.ts`.
- Consumer row gate with zero side effects: `tests/pipeline/consumer.test.ts`.
- Route family gating, cross-workspace 404 and role matrix: `tests/worker/dashboard-tenancy.test.ts`,
  `tests/worker/tenant-isolation-matrix.test.ts`.
- Deploy ordering and ref identity: `tests/scripts/deploy-workflow-ordering.test.ts`,
  `tests/scripts/deploy-prod-workflow-guards.test.ts`.
- Idempotent backfill and zero-orphan SQL: `migrations/0027_workspace_backfill.sql`,
  `scripts/assert-tenant-attribution.ts`.
