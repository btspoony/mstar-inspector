# ADR: Fix a row's target at first record and never rewrite it

Status: implemented — retrospective: attribution-at-first-record shipped with the target backfill; this record was filed after the fact.
Spec: docs/specs/feature/bot-scope-and-claiming.md § Execution ledgers

## Problem

Rebinding a bot installation moves it from one workspace's target to another's. Review history — `reviews`, `findings`, lifecycle rows, failure rows — was written while the previous target held the binding. Rewriting `target_id` on a rebind would move that history into the new tenant's list, and move the previous tenant's record of what it reviewed out of its reach. Leaving history reachable only through a bot-keyed join was the same leak with an extra step: the join resolves to whichever target holds the binding now.

## Decision

A row's `target_id` is written when the row is first recorded and never rewritten. A rebind moves future publications only.

- The binding is resolved *inside* the inserting statement, not by the caller: `LIVE_BINDING_TARGET_SQL` in `src/store/finding-lifecycle.ts` is a scalar subquery — `(SELECT id FROM review_targets WHERE bot_id = ? AND installation_id = ? AND deleted_at IS NULL)` — embedded in the review INSERT and in every finding INSERT of the apply batch. It reads when the statement runs, inside the same transaction as the write it feeds, so a concurrent unbind or claim cannot strand it.
- The artifact's own target id is only the fallback hint for a new row: `applyPublishedLifecycle` passes `targetIdExpression: { sql: COALESCE(<live binding>, ?), binds: […, payload.artifact.targetId] }` (`src/store/finding-lifecycle.ts`) into `ArtifactPutOptions.targetIdExpression` (`src/store/artifact-store.ts`). Nothing bound means the payload decides; a target that keeps `installation_id` but is soft-deleted holds nothing.
- No statement rewrites `target_id` on an existing row: the apply's review INSERT is `ON CONFLICT … DO NOTHING` and every lifecycle statement is an upsert keyed by its own id.
- `migrations/0060_execution_ledger_target.sql` backfilled the ledgers from their pull-request row, guarded three ways: a row with no resolvable target aborts the migration, a row with several candidate targets aborts it, and only an exactly-one candidate is attributed.
- Reads bind `target_id` directly; the bot-keyed pull-request join is no longer load-bearing for tenant scope.

## Alternatives considered

- **Rewrite `target_id` on rebind.** Moves settled history across a tenant boundary, and destroys the answer to "which workspace's policy produced this review".
- **Attribute from the job payload.** The producer's copy of the target id is a read taken before the batch; a rebind or unbind between the read and the write attributes the row to a workspace that no longer holds the binding.
- **Keep the bot-keyed join and derive the tenant at read time.** Unique only while a bot has one live target, so the derivation silently widens the first time a bot serves two workspaces.
- **Backfill and then re-attribute on demand (an operator "move history" action).** No such action exists and none was built: history that legitimately belongs to the old tenant would need a per-row proof of legitimacy that nothing can supply.

## Consequences

- A rebind leaves the previous tenant's reviews on the previous target: they stay visible to that workspace and absent from the new one. That is the decision, not an oversight.
- An unbind clears the live binding, so rows recorded afterwards fall back to the payload's target hint — a target with no binding still records where the review ran.
- The execution ledgers carry `target_id` and every tenant read binds it; a row whose target is soft-deleted stays attributable rather than becoming invisible to everyone.
- The guard is a statement-local subquery, so it costs one correlated read per inserting statement rather than an extra round trip.
