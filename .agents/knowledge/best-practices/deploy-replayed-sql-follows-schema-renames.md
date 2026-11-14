---
module: ops-deploy / d1
date: 2026-11-15
problem_type: best_practice
category: best-practices
severity: high
tags:
  - d1
  - migrations
  - schema-rename
  - github-actions
  - deploy
  - idempotent-repair
applies_when:
  - a deploy workflow replays a SQL file from migrations/ after `d1 migrations apply`
  - landing an `ALTER TABLE … RENAME TO` / `RENAME COLUMN` migration any replayed file names
  - reviewing a deploy sequence whose repair step must stay idempotent
---

# A replayed migration file is a schema-version dependency: rename the schema, never the replay target

## Context — why it bites

Both deploy workflows run one repair file **after** `d1 migrations apply` and **before** the
zero-orphan abort gate, so a partially applied deploy heals without a manual run. That file was
`migrations/0027_workspace_backfill.sql`, a `INSERT INTO app_workspaces (app_id, …) SELECT … FROM
github_apps` guarded by `WHERE NOT EXISTS`.

The step is coupled to a *schema version*, not to a *filename*. `d1 migrations apply` runs files in
order and then the replay runs against whatever schema exists at the head of the chain — so a
forward rename migration rewrites the names the replayed file was written with, while the file
itself stays frozen at the old ones. On a fresh database the same file runs **before** the rename,
so editing it to the new names breaks the fresh chain instead. Both directions are wrong; the file
cannot be made to satisfy both.

The trap is that nothing fails at rename time. No test, typecheck or `ci.yml` step executes a
workflow's replay, so the coupling surfaces only on the next deploy — with the rename code, the
rename migration and the workflow already merged.

## The failure

The replay step exits non-zero on the first statement and `bash -e` aborts the job before anything
deploys:

```
ERROR 7500: no such table: app_workspaces
```

(`app_workspaces`, or `github_apps`, depending on which name the statement reaches first — the
error names the table, never the rename that invalidated it.) Every subsequent deploy fails the
same way until the workflow is repointed; the deploy itself is fine, only its repair step is
version-stale.

## Guidance

- **Leave the historical migration as written.** It is part of a chain a fresh database replays in
  order; the pre-rename names are what it must say at its own position.
- **Move the repair, not the names.** Add the same idempotent statement expressed against the new
  names as a plain script outside `migrations/` (`scripts/workspace-backfill.sql`), so no chain ever
  runs it and `d1 migrations apply` never counts it.
- **Repoint the workflow `--file` and keep the step where it is** — same position after the
  migration apply, still before the abort gate, same idempotent-only content (a routine deploy
  re-runs it). A replay that writes per-person rows is a separate defect; the abort gate must
  still be able to rely on repaired rows.
- **Generalise the audit, not the exception.** Every `.github/**` step that executes a
  `migrations/*.sql` file is a schema-version-coupled dependency. Audit them before landing any
  rename; a hit means "repoint or split", never "the replay will be fine".

## How to check

```bash
rg -n -- '--file[= ]+migrations/' .github/
```

Empty output means no workflow executes a migration file; any hit must be a file whose identifiers
the rename leaves alone.

## Why This Matters

The failure is loud but late: it blocks every production deploy of an otherwise correct change, and
the obvious repair (edit the replayed migration to the new names) silently breaks the fresh-chain
path that a new environment or a test fixture takes. Deciding the file's lifetime at
rename-authoring time — historical file frozen, repair script repointed — is the only shape that
keeps both the chain and the deploy honest, and it costs one `rg` call to find the couplings.

## When to Apply

- Landing `ALTER TABLE … RENAME TO` / `RENAME COLUMN` / `DROP` migrations in a repo whose deploy
  workflow executes any SQL file outside `d1 migrations apply`.
- Adding a new "re-run this repair" step: decide up front whether it is forward-only (a migration)
  or re-runnable (a script), because only the latter may be replayed by a workflow.
- Reviewing a rename PR: check the workflow's replay targets against the rename list, not just the
  migration's own SQL.
