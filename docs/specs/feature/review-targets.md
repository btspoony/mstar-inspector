# Feature: review targets

## Scope

The bot/target split: a review bot is an execution identity, a review target is the configuration unit a workspace owns. Storage, backfill, webhook resolution, the review job payload, and the tenant-read predicate.

## Current state

### Entities

| Entity | Owns | Notes |
|---|---|---|
| `review_bots` (formerly `github_apps`) | GitHub App credentials, bot slug and cached profile, provider keys, model configuration, sandbox image, installations, **operational pause** (`review_enabled`) | One GitHub App = one bot. Owned by exactly one workspace through `bot_workspaces`. |
| `review_targets` | workspace, installation binding, **trigger mode, review depth, Check gate, owner allowlist, business pause** | One target binds one bot and at most one installation. `UNIQUE (bot_id, installation_id) WHERE installation_id IS NOT NULL`. |

The bot's workspace and the target's workspace are two facts, not one. They coincide today because a target is created beside its bot; the contract does not require it, and the webhook never uses the bot's workspace to scope a review.

### Backfill

Every pre-existing bot gains exactly one target carrying its previous values. `reviews.target_id` is set exactly where `bot_id` was set; `pull_requests.target_id` is never NULL; the allowlist copies into `target_owner_allowlist`; queued `comment_trigger_claims.payload_json` is rewritten to `botRef.appId` + `targetId`. The migration fails outright — it does not skip rows — when a bot has no workspace row, a bot does not end with exactly one target, an attribution row cannot be resolved, or a queued claim cannot be rewritten.

The five moved columns leave `review_bots` through `ALTER TABLE … DROP COLUMN`. A parent rebuild is forbidden: `DROP TABLE review_bots` fires `pull_requests`' `ON DELETE CASCADE`.

### Webhook resolution

`POST /webhook/{workspaceId}/{appId}` (`src/worker/index.ts`) is unchanged; the path parameter and the `botRef.appId` field below name the same `review_bots` id, so `{appId}` is a naming drift fixed here, not a second identity. After signature verification and classification, the delivery resolves `(bot_id, installation.id)` to a target: the bound installation first — honoured only while no `bot_installations` row for that pair carries `removed_at`, because a removed binding resolves nothing and does not fall through to the next step — else the bot's single non-deleted target, a step suppressed for a `shared` bot with no binding, else nothing. No target answers 200, logs `no_target_for_repo`, records outcome `ignored`, enqueues nothing and writes no ledger row. Allowlist, trigger mode and business pause come from the target; the mention slug comes from the bot; either pause flag suppresses enqueue.

### Review job payload

`ReviewJobPayload` carries `botRef: { appId }` (the bot id) and `targetId`. There is no reader of the former `appRef`. The consumer reads credentials, model configuration, sandbox image and the operational pause from the bot row, and review depth, Check gate and business pause from the target row. A missing target, or a target whose `bot_id` differs from `botRef.appId`, fails the message (`retry` → DLQ); it is never defaulted. Messages already on the queue at deploy time take that path.

### Tenant isolation

A tenant read is any dashboard or API read that returns reviews, insights, pull requests, target settings or Check configuration. Every such SQL binds both `target_id = ?` and the joined `review_targets.workspace_id = ?`; a route-level check is not a substitute. A target id from another workspace is a 404 on a single-target route and an empty result on an aggregation — never 403. Legacy rows with NULL `target_id` stay invisible while the filter is set.

Execution reads — webhook bot lookup, consumer credential load, publication recovery, PR-head lookup — carry no workspace predicate by design.

`review_findings` and `review_failures` carry `target_id` (`migrations/0060_execution_ledger_target.sql`, backfilled from their pull-request row and guarded three ways), so their tenant predicate binds it directly through `ledgerScopeSql` (`src/dashboard/apps-store.ts`); the bot-keyed `pull_requests` join is no longer load-bearing.

### Settings payload and SPA

The settings JSON keeps its existing keys, reads review-policy keys from the target, and adds a top-level `target_id` on **both** the manager and the identity face. It is a **string** (the `review_targets.id` uuid). The SPA parser fails closed when it is absent, empty or not a string. Routes, list links, tabs and labels stay on the numeric `github_app_id`.

### Create, delete, list

Manifest commit writes one bot, its workspace mapping and one unbound target (`installation_id` NULL) in one batch, seeded from the workspace floors. User-facing delete stamps `deleted_at` on the target and the bot in one batch. The list filters `review_targets.deleted_at IS NULL` and still shows a disabled bot's target.

## Invariants

- One target per bot is a product constraint, not a schema rule; a second target requires `target_id` on the execution ledgers first.
- A target's `bot_id` is written once, by an INSERT; a re-bind is a new target. Three INSERTs write it — the manifest commit's inline batch (the caller's own new bot), `CREATE_SHARED_TARGET_SQL` (gated on a `shared`, live bot) and `createTargetsStore().create()` (no production caller today) — plus migration `0057_review_targets.sql`'s backfill; no statement ASSIGNS it after creation. A future writer of that column must call `checkEntitlement({kind: "shared-bot", …})` in that writer, never add a second guard ([entitlement](../architecture/entitlement-and-deployment-modes.md) §5).
- Tenant reads bind both ids in SQL; execution reads bind neither workspace predicate nor target.
- The review job payload names both ids; no code reads `appRef`.
- The five moved columns never return to `review_bots`.
- The same `account_login` on more than one live target in one workspace is a decision for the operator, never an automatic repair.

## Where it lives

- `migrations/0056_review_bots_rename.sql`, `migrations/0057_review_targets.sql`
- `src/dashboard/targets-store.ts` (`resolve`, `resolveInWorkspace`, policy setters)
- `src/dashboard/apps-store.ts`, `src/dashboard/insights-store.ts`, `src/dashboard/index.ts`
- `src/contracts/review-job.ts`, `src/pipeline/consumer.ts`, `src/worker/index.ts`, `src/worker/check-reconcile.ts`
- `src/store/artifact-store.ts`, `src/spa/pages/data.ts`
- `scripts/workspace-backfill.sql` (deploy-time replay)
- `scripts/audit-owner-overlap.sql` (read-only: workspaces where one account owns more than one live target)

## Change obligations

Any change to entity boundaries, the resolution order, the payload shape, or a tenant read face updates this page and the corresponding spec (`app-detail-visibility`, `review-trigger-policy`). A second target per bot is blocked until the execution ledgers carry `target_id`.
