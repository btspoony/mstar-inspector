---
module: review target identity / dashboard tenancy / webhook resolution
date: 2026-11-17
problem_type: architecture_pattern
category: architecture-patterns
severity: high
applies_when:
  - a per-repository configuration row must survive repository renames and transfers
  - a webhook delivery has to resolve the configuration row for one repository
  - a migration adds repository identity to rows that only recorded owner/name
  - two workspaces could otherwise claim the same repository
tags:
  - github-app
  - repository-identity
  - multi-tenant
  - d1
  - migration
  - webhook
  - collation
related_components:
  - review_targets
  - review_bots
  - worker
  - pipeline-consumer
  - finding-lifecycle
---

# Repository identity is the numeric repository id, never owner/name

## Problem

A review target is per-repository configuration: trigger mode, depth and Check gate. Keying it by `(owner, name)` breaks the moment a repository is renamed or transferred, which silently orphans the configuration and splits the review ledger. GitHub reuses neither name, and the same owner/name can be recreated as a different repository.

## What does not work

- **`(workspace_id, repo_owner, repo_name)` as the identity.** A rename makes the stored row unreachable while the delivery keeps arriving; the row and its history are stranded.
- **Resolving by installation alone.** One installation covers many repositories, so it cannot name a target.
- **Adding a `scope = 'shared'` guard to app visibility.** An owned bot that a second workspace uses through a live target becomes invisible, and the blocked-app face (`bot_not_shared`) becomes unreachable. App visibility is "workspace mapping exists OR a live target for this app exists in the workspace"; the scope flag narrows that rule incorrectly.
- **Migrating rows by moving an "installation binding".** Installations belong to the app, not to a target; a per-target installation column cannot survive more than one repository per app.

## Working solution

1. **Store `repo_id INTEGER` (GitHub's numeric `repository.id`) plus `repo_owner` / `repo_name` as mutable display caches.** The id survives renames and transfers; a delivery that hits an existing row refreshes the caches.
2. **Uniqueness is partial and id-based:** `UNIQUE (workspace_id, repo_id) WHERE repo_id IS NOT NULL AND deleted_at IS NULL`. A soft-deleted row may be re-added; an unclaimed legacy row is outside the claim.
3. **Resolution order:** `(bot_id, repo_id)` → legacy `(bot_id, repo_owner, repo_name) WHERE repo_id IS NULL` with an in-request claim → a bot's single all-NULL placeholder row (migration residue) → no target, delivery ignored.
4. **Collation is one decision.** Compare owner/name with `COLLATE NOCASE` *and* index them `COLLATE NOCASE`; otherwise the comparison bypasses the index and attribution disagrees with the gate reads.
5. **Historical rows carry NULL identity until a claim or a data upgrade fills it.** Zero-ledger legacy rows cannot be attributed to a repository; either soft-delete them or leave them claimable by the single-placeholder rule.
6. **App-level claims, not target-level.** A claim records "this user intends to install this app in this workspace"; the bind writes `bot_installations` only.

## Why

The numeric id is the only stable repository handle GitHub exposes. Every reader that filters by owner/name is a cache read, so a rename degrades display only. Keeping one uniqueness predicate and one collation prevents "resolves to A, gates from B" splits across workspaces.

## Migration mechanics that matter

- `ALTER TABLE … DROP COLUMN` refuses while an index references the column: drop the index first, then the column.
- Never rebuild the parent table to change columns: a D1 migration runs in one transaction where `PRAGMA foreign_keys = OFF` is inert, so a parent rebuild fires child cascades and empties the ledger.
- A migration that adds identity without data movement leaves legacy rows NULL; that is a deploy-coupled state, so the follow-up data upgrade must run in the same release window (maintenance mode), or legacy repositories stop reviewing.
- Batch the backfill by target with a frozen cursor and verify with guards (no live target missing identity while holding ledger rows; no ledger row pointing at a replaced target), so a re-run is a no-op.

## Prevention

- Grep for owner/name comparisons after introducing an id: every read that resolves a target must key on the id first.
- Re-run the app-visibility tests when an ownership predicate changes; an owned bot used by another workspace is the case that regresses.
- Keep one effective-settings reader: execution lanes, the reconciler and the settings face must all call it, or a stale placeholder (a column default) silently becomes the live gate.
