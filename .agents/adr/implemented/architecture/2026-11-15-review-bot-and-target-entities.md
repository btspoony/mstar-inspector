# ADR: Separate the execution identity from the review configuration unit

Status: implemented — retrospective: `review_bots` and `review_targets` shipped in migrations `0056_review_bots_rename.sql` and `0057_review_targets.sql`; this record was filed after the fact.
Spec: docs/specs/feature/review-targets.md § Entities
Superseded-by: 2026-11-25-github-app-review-bot-split.md — the `review_bots`-as-one-execution-and-configuration-row half only; the `review_targets` half stands

## Problem

One `github_apps` row carried two kinds of fact. The GitHub App execution identity — credentials, bot slug and cached profile, provider keys, model configuration, sandbox image, installations — belongs to exactly one owning workspace. The review configuration — trigger mode, review depth, Check gate, owner allowlist, business pause — belongs to the workspace whose repositories get reviewed. A single row forced both onto one workspace: a platform bot shared across tenants would have to hold every consumer's policy on its own row, and the webhook, which resolved a workspace through the bot row, could only ever review for the bot's owner.

## Decision

Two tables, one bot to many targets:

- `review_bots` (renamed from `github_apps` in `migrations/0056_review_bots_rename.sql`) owns the execution identity: credentials, slug and cached profile, provider keys, model chain, sandbox image, installations, and the operational pause (`review_enabled`).
- `review_targets` (`migrations/0057_review_targets.sql`) owns the configuration unit a workspace holds: workspace, installation binding, trigger mode, review depth, Check gate, owner allowlist, business pause. `UNIQUE (bot_id, installation_id) WHERE installation_id IS NOT NULL` keeps one bound installation on at most one target.
- The five configuration columns leave `review_bots` through `ALTER TABLE … DROP COLUMN`; a parent rebuild is forbidden because `DROP TABLE review_bots` fires `pull_requests`' `ON DELETE CASCADE`.
- Every pre-existing bot gains exactly one target carrying its previous values, and the migration fails outright when any bot does not end with exactly one target.
- The webhook resolves `(bot_id, installation.id)` to a target through `resolve` (`src/dashboard/targets-store.ts`): the bound installation first, else the bot's single live target, that fallback suppressed for a shared bot with no binding.
- `ReviewJobPayload` (`src/contracts/review-job.ts`) carries both ids — `botRef.appId` and `targetId`; the consumer reads credentials, model chain, sandbox image and operational pause from the bot row and review depth, Check gate and business pause from the target row.
- Tenant reads bind `target_id` and the joined `review_targets.workspace_id` in SQL; execution reads (webhook bot lookup, consumer credential load, publication recovery, PR-head lookup) carry no workspace predicate.

Zero behaviour change, by construction: with one live target per bot the resolver's second step returns the target the old bot-keyed path attributed the delivery to, and the payload names the same bot id in `botRef.appId` that the retired `appRef` named.

## Alternatives considered

- **A per-workspace policy table beside an unchanged `github_apps`.** The execution identity would still be the resolver's only hop, so the webhook could not reach a consumer's policy without a second lookup whose key did not exist; and the bot row would keep a stale copy of the owning workspace's policy, a second source of truth.
- **Add `workspace_id` to `github_apps` and keep one row per tenant.** Copies the App credentials per consumer, so key rotation, provider configuration and installation state multiply by tenant; `resolve` could not then answer "which App serves this delivery" from the installation alone.
- **Keep the bot-keyed join as the tenant predicate.** The `pull_requests` join is unique only while a bot has one live target, so the first second target would silently widen a tenant read.
- **Nullable `target_id` on every ledger with a bot-keyed fallback.** A read that can fall back to the bot is a read that leaks once two targets exist; the fallback would be the bug, not the migration path.

## Consequences

- A bot is addressable by any workspace only through a target it holds; `resolve` (`src/dashboard/targets-store.ts`) is the single attribution point, and the spec's resolution table (bound / removed installation / owned / shared / ambiguous) is that function's contract.
- Execution ledgers gain `target_id` and tenant reads lose the bot-keyed join: see [target attribution](2026-11-15-review-target-attribution.md).
- One target per bot is a product constraint, not a schema rule; the execution ledgers do carry `target_id`, so a second target is no longer blocked on schema work: see [target attribution](2026-11-15-review-target-attribution.md).
- The split costs a second entity on every route: a route that addresses an App resolves the App *and* its target in the caller's workspace, and a target id from another workspace is a 404 rather than a 403 (spec § Tenant isolation).
