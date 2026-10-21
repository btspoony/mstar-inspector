---
module: dashboard / tenancy / deploy
date: 2026-10-22
problem_type: best_practice
category: best-practices
severity: high
topic: workspace tenant attribution and two-deploy mode switch
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
---

# Workspace tenant attribution and the two-deploy mode switch

## Context

The platform moved from "one deployment = one tenant" to workspace attribution while
keeping a single deployable artifact. The transition needed three properties at once:
every App resolves to exactly one workspace, the tenant-facing read face cannot produce
an unattributed App, and the old read/auth behaviour stays byte-identical until a switch
flips it.

The design that satisfied this:

- **Attribution is a narrow map table**, `app_workspaces(app_id PK, workspace_id NOT NULL)`,
  never a nullable column on the App table. SQLite cannot add `NOT NULL` to an existing
  column without rebuilding the table and its foreign-key children.
- **One write face**: `apps-store.createApp` inserts the App and its mapping in one
  `db.batch`, guarded by `SELECT id FROM workspaces LIMIT 2` requiring exactly one row.
- **One read face**: mode-aware SQL constants (`APP_READ_SQL.*.off/.strict`). Strict adds
  `INNER JOIN app_workspaces` and returns `workspace_id`; off is the exact historical
  string. An orphan App is simply absent under strict.
- **One switch, four layers**: `WORKSPACE_TENANT_MODE = off | strict` governs read SQL,
  route visibility, authorization, and the consumer's missing-mapping gate. An illegal
  value throws from one shared reader (`tenantModeOf`); there is no silent off fallback.
- **Two deploys of the same artifact**: Deploy A (`off`) turns on dual writes and closes
  the orphan window with an idempotent backfill plus a zero-orphan assertion; Deploy B
  (`strict`) replays the same commit with the switch flipped.

## Guidance

1. Make the mode reader the only place that interprets the env value. Return `off` only
   for unset/empty; throw on anything else. Every layer calls it, so a typo fails one
   request loudly instead of half-enabling tenancy.
2. Keep the off SQL frozen by literal. A test that compares captured SQL to the production
   constant is a tautology — pin the three literal strings independently.
3. Enforce the read-face boundary by face, not by file. Tenant-facing modules must not
   contain `from github_apps`; maintenance reads (reconcile, review-threads, review-checks)
   may query directly only when keyed by `app_id`/`installation_id` or bounded to
   identifiers, each annotated `// shortcut: tenant-bypass — <reason>`. Pin the allowlist
   per file **and per call site** (a file-level set misses a second read), scanning
   `.prepare(...)` arguments with a string-literal-aware matcher.
4. Resolve the workspace **after** authentication. A pre-auth lookup that returns 404 for
   unknown slugs and 302/403 for known ones is a tenant-existence oracle and an
   unauthenticated D1 read per probe. Classify the path in the gate; resolve the workspace
   and membership inside the member gate.
5. Register both route families unconditionally. Hono mounts at import time, so a request
   cannot choose a block. One `{method, path, handler}` table registered under `""` and
   `/:workspaceSlug` avoids duplicate handler bodies; a pre-route gate rejects the family
   that the current mode does not serve.
6. Put the tenant gate before SPA dispatch. With `ASSETS` bound, `spaDispatch` runs before
   the dashboard app; a strict legacy App URL would otherwise be served by the shell.
7. Move membership with the user row. `workspace_members.user_id` has no `ON DELETE`, so
   the removal batch must delete the membership before the user row; creation and role
   changes must mirror the role (`admin → owner`, `member → member`) in the same batch.
8. Count the version-creating steps, not just `wrangler deploy`. `wrangler secret bulk`
   publishes a new version; a mode var passed only to an earlier deploy does not survive
   it. End the sequence with a deploy that carries the var, and make the run summary name
   the mode of the serving version.
9. Bind the replay. A strict replay must receive the SHA that Deploy A actually deployed
   and abort if the tag moved; otherwise both runs can agree with a newer tag and still
   claim "same artifact".
10. Put the zero-orphan assertion before every deploy-capable step (migrations → backfill →
    assertion → secret writes → deploy → smoke → assertion), and make the assertion parser
    fail closed on any wrangler output shape other than one successful statement with one
    integer row.

## Why This Matters

Each of these rules protects a failure mode that is invisible in unit tests:

- A nullable ownership column or a second write path lets an unattributed App exist and be
  executed — a billing and isolation hole that backfill cannot repair later.
- A silent mode fallback makes a misconfigured deploy look healthy while tenancy is off.
- A file-level allowlist lets a new direct read drift in without failing.
- A pre-auth workspace lookup leaks tenant existence and amplifies anonymous traffic.
- A mode var lost to a later `secret bulk` means the run is green while production serves
  the old behaviour.
- A membership table without deletion semantics silently makes access revocation fail.

## When to Apply

- Adding or changing a tenant/ownership boundary over an existing single-tenant schema.
- Rolling out a behaviour switch across application and deploy layers with one artifact.
- Reviewing any "mode" flag that is read in more than one layer.

## Examples

- SQL constants and the frozen-off literal test: `tests/store/tenant-read-face.test.ts`.
- Per-site maintenance allowlist: the same file's statement scanner.
- Consumer row gate with zero side effects: `tests/pipeline/consumer.test.ts` (`strict`
  orphan case).
- Route family gating, cross-workspace 404 and role matrix:
  `tests/worker/dashboard-tenancy.test.ts`, `tests/worker/tenant-isolation-matrix.test.ts`.
- Deploy ordering, replay binding and serving-mode summary:
  `tests/scripts/deploy-workflow-ordering.test.ts`, `tests/scripts/deploy-guards.test.ts`.
- Idempotent backfill and zero-orphan SQL: `migrations/0027_workspace_backfill.sql`,
  `scripts/assert-tenant-attribution.ts`.
