---
module: dashboard read scope / D1 bind limits
date: 2026-11-17
problem_type: best_practice
category: best-practices
severity: medium
applies_when:
  - a workspace-scope read must cover a set of tenant rows
  - a query builds an IN list from a per-tenant collection
  - the same predicate is spliced into several statements
tags:
  - d1
  - sql
  - bind-limits
  - multi-tenant
  - query-shape
related_components:
  - apps-store
  - insights-store
  - review_targets
---

# Scope a tenant read by subquery, not by one bind per row

## Problem

A workspace-level read needs every ledger row belonging to the workspace's current repositories. The first implementation resolved the live target ids and bound them: `target_id IN (?, ?, …)`. Cloudflare D1 caps a statement's bound parameters (100), and some statements splice the same scope predicate twice (the outer filter plus a windowed subquery). The list face therefore failed at roughly 48 live repositories, while a local SQLite test double (32766 binds) could never notice.

## Working solution

```sql
target_id IN (SELECT id FROM review_targets
               WHERE workspace_id = ? AND deleted_at IS NULL)
```

One bind, any tenant size. The subquery re-checks liveness and ownership in the same statement, so a route-level ownership check is not the only thing standing between a caller and another workspace's rows. Keep the target-scope arm as `target_id = ?` and select the arm by a scope discriminant (`{kind:"target",targetId}` / `{kind:"workspace"}`) — never build SQL text from a caller-supplied list.

## Why it is better

- Constant parameter count: the statement text is identical for one target and three hundred.
- One tenant predicate, evaluated in the database; the route cannot widen it.
- No empty-list special case: an empty subquery result yields zero rows naturally.
- The plan can be asserted structurally: a test compares the prepared SQL for one and three targets and requires it to be identical with a single placeholder.

## Prevention

- Treat any `IN (${placeholders})` built from a row count as a defect unless the count is capped by protocol.
- When a predicate appears twice in one statement, count its binds twice; the cap is per statement.
- A SQLite test double hides the platform cap — assert the SQL shape, not just behaviours that fit in memory.
- Index the subquery's filter columns (`workspace_id`, `deleted_at`) so the replacement is not a scan.
