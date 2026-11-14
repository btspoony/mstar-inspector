---
module: dashboard tenancy / review configuration store
date: 2026-11-15
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - one execution identity is split from several per-tenant configuration rows
  - a tenant read filters by a foreign key that is no longer workspace-unique
  - a queue payload or cutover migration must carry a new tenant column
tags:
  - multi-tenant
  - tenancy
  - d1
  - sql-predicates
  - indexes
  - cutover
related_components:
  - review_targets
  - review_bots
  - dashboard
  - pipeline-consumer
---

# After an identity/configuration split, every tenant read binds the target id *and* the owning workspace id

## Context

A table that was one row per workspace stops being one. An execution identity — a GitHub App with its
credentials, model chain and sandbox image — is split from the configuration units tenants actually edit, one
per workspace/installation. The old table's id was the tenant key only because the two happened to coincide;
after the split one identity owns several configuration rows, and the id names *which identity*, not *whose*.

Nothing breaks at the moment of the split. The backfill produces exactly one row per identity, so every query
filtered by the identity id still returns that tenant's rows — until someone writes the second row. Then a
read filtered by the identity id alone silently spans both workspaces, and the leak looks like correct output.

## Guidance

**A tenant read binds both ids in the same statement.** The row id selects the row; the workspace predicate
proves the row belongs to the caller's tenant. A single bind on the row id trusts the caller — or a later bug
in the caller — to have scoped it already.

```sql
-- tenant read: both predicates, one statement, workspace second
WHERE t.id = ? AND t.workspace_id = ? AND t.deleted_at IS NULL

-- tenant read over a child table: the row id plus the owner reached in SQL
WHERE r.target_id = ?
  AND EXISTS (SELECT 1 FROM review_targets t WHERE t.id = r.target_id AND t.workspace_id = ?)
```

Three rules that make the pair hard to erode:

1. **The store holds the rule, not the route.** `createXStore(db).getById(workspaceId, id)` takes the
   workspace as a required argument, so a route cannot forget it and a store bug cannot invent it. A route-level
   "this id belongs to me" check is not a substitute: it is one more place to be wrong, and it has to be
   repeated on every new route.
2. **Cross-workspace is absence, never refusal.** Another workspace's row id reads `null` / empty result and the
   route answers the same 404 an unknown id produces. Distinguishing "exists but forbidden" from "does not
   exist" turns the id space into a tenant-existence oracle.
3. **Every ledger that a tenant read reaches must carry the tenant id, non-null.** A column added nullable for the
   backfill must be required by the write path afterwards (`upsert…` throws when it is missing); otherwise a
   writer silently produces a row that is invisible to every tenant read, including the one that paid for it.

**The execution lanes are the documented exception.** A webhook delivery names an identity and an installation,
never a workspace; credential load and publication recovery do the same. Those reads carry *no* workspace
predicate on purpose — they are not tenant faces:

```ts
// execution read: bot + installation -> the one target; no workspace to bind
WHERE bot_id = ? AND installation_id = ? AND deleted_at IS NULL

// execution read: the queue already names the resolved target
WHERE id = ? AND deleted_at IS NULL
```

State that boundary in the store header, so a future reader who greps for the missing `workspace_id` finds the
reason instead of "fixing" it. The tenant-facing read of the same table (an identity's configuration *in this
workspace*) is a different function and does bind both ids.

## Why This Matters

The failure is a silent cross-tenant read: no error, no 403, a plausible page. It appears only once a second
configuration row exists, which is after the migration's own verification has passed — and the row that leaks is
the one belonging to whichever tenant did not create it. There is also a second, quieter failure in the other
direction: writes that omit the tenant id land in a row no read can reach, so the feature looks empty rather than
broken.

## When to Apply

- Splitting an execution identity (credentials, model configuration, runtime identity) from per-tenant
  configuration, one row per workspace or installation.
- Adding any query or route over the new table, or over a child ledger it is joined to.
- Reviewing whether a route-level tenant check is "enough" (it is not).
- Writing the migration's payload or backfill: both ids have to arrive together.

## Examples

### Before

```ts
// one row per workspace, so the id WAS the tenant
const row = await db.prepare(`SELECT * FROM review_bots WHERE id = ? AND deleted_at IS NULL`)
  .bind(botId).first();
```

### After

```ts
// tenant read — the id plus the owning workspace, in the same statement
const row = await db
  .prepare(`SELECT * FROM review_targets WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
  .bind(targetId, workspaceId).first();

// execution read — no workspace predicate, and the header says why
async resolve(botId: string, installationId: number | null) { /* bot + installation only */ }
```

## Traps worth naming

- **The payload carries both ids in one cutover, with no reader of the old key.** The queue job must name the
  target *and* the identity (the credential and publication lanes still resolve by identity), the old
  configuration columns are dropped in the same migration that adds the new table, and the consumer switches in
  the same deploy. A compatibility reader of the old key keeps a half-migrated payload alive — and a message that
  reaches the write path without the tenant id produces an unreachable row. Messages already in flight are not in
  the database: fail those closed rather than guessing a workspace.
- **A partial unique index does not serve the plain column lookup.** The split table's uniqueness constraint is
  naturally *partial* — one target per (identity, installation) `WHERE installation_id IS NOT NULL` — and that
  index is only usable when the installation is known. The webhook fallback (`WHERE bot_id = ?`) and the
  attribution backfills scan the identity column with no installation to give, so the new table needs its own
  plain index on it. Add it in the same migration that creates the table; afterwards it costs another one.

## How to check

```bash
rg -n 'target_id = \?' src/
```

Every hit must either sit in a statement that also binds `workspace_id` (directly, or through the
`review_targets` join), or live in an execution lane that its module header documents as one. The behavioural pin
is a two-target, two-workspace fixture: one identity, two workspace-owned configuration rows, and every read face
asked for the *other* workspace's id must come back empty with no outbound call.
