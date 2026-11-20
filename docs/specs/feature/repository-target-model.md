# Feature: repository target model

## Scope

The data and execution contract behind the repository surface: target identity and schema, webhook resolution, effective review settings, the target store, the add-repository API, installation binding, and the application-settings gates that survive the surface split. This page also states what the previous installation-bound model no longer does.

Page layouts and journey states live in the repository surface page; the operator window and the historical backfill live in the operator data-upgrade page. Out of scope: cross-workspace sharing of one repository, billing and quota semantics, and any compatibility layer for the retired application-scoped surfaces.

## Current state

### Identity and schema

| ID | Contract |
|----|----------|
| I1 | A target row is one repository under one workspace (`review_targets`): it names the bot that executes reviews, its workspace, the repository identity, the inheritance flag and the review policy it owns. |
| I2 | `repo_id INTEGER` holds GitHub's numeric `repository.id` and is the identity. It is null for exactly two shapes: a historical row the schema migration left with no repository columns at all, and a row the operator backfill created from an owner/name pair. Both acquire the id from their first delivery that carries one; every target created through the add-repository surface carries it from creation. |
| I3 | `repo_owner` / `repo_name` are display caches, not identity. A delivery that spells the repository differently refreshes them in the same request, so a rename or a transfer keeps one row and one URL. |
| I4 | Uniqueness is bot-level: `CREATE UNIQUE INDEX review_targets_bot_repo_unique ON review_targets(bot_id, repo_id) WHERE repo_id IS NOT NULL AND deleted_at IS NULL`. One repository belongs to one workspace per App; a soft-deleted row is outside the claim, so a removed repository may be re-added, and an unclaimed (`repo_id IS NULL`) row is outside it too — the store refuses that duplicate on owner/name instead. |
| I5 | `follow_workspace_defaults INTEGER NOT NULL DEFAULT 0 CHECK (follow_workspace_defaults IN (0, 1))` decides whether the row's policy columns answer or the workspace defaults do. |
| I6 | The installation-keyed machinery is gone: `installation_id`, `account_login` and `allowlist_enabled` are dropped columns (with the `review_targets_bot_installation` index), and `target_owner_allowlist` is a dropped table whose rows are deleted with it and migrate nowhere. Columns drop in place, never through a parent rebuild. |
| I7 | Workspace defaults live on `workspaces`: `default_review_trigger_mode` (`'open' \| 'every_push' \| 'manual'`, default `'every_push'`), `default_review_level` (`'quick' \| 'default' \| 'deep'`), `default_check_pass_verdicts` (JSON array, default `["ship it"]`). The gate floor is the existing `workspaces.check_min_score` — there is no fourth column. |
| I8 | Resolution indexes: `(bot_id, repo_id)`, `(bot_id, repo_owner COLLATE NOCASE, repo_name COLLATE NOCASE)`, `(bot_id, workspace_id)`, `(workspace_id)`, plus the pre-existing bot index. The name index carries the collation every owner/name predicate uses, so those comparisons seek rather than scan. |

### Backfill and historical rows

Migration `0057_review_targets.sql` gave every pre-existing bot exactly one target carrying its previous values, set `reviews.target_id` exactly where `bot_id` was set, kept `pull_requests.target_id` non-NULL, and rewrote queued `comment_trigger_claims.payload_json` to `botRef.appId` + `targetId`. It fails outright rather than skipping rows when a bot has no workspace row, a bot does not end with exactly one target, an attribution row cannot be resolved, or a queued claim cannot be rewritten.

The allowlist copy that shipped with that migration is gone: `target_owner_allowlist` was dropped with the column and its rows migrate nowhere.

A row that migration produced now carries three NULL repository columns (`repo_id`, `repo_owner`, `repo_name`); it reviews again once its first delivery claims it (R1), and the split and repoint of historical rows onto their repository identity is the operator `repo-backfill` item described on the operator data upgrade page, never a schema migration.

### Resolution

| ID | Contract |
|----|----------|
| R1 | A delivery resolves in three steps: (1) a payload `repository.id` hits the live row holding that `(bot_id, repo_id)`, and a changed name refreshes the caches in the same request; (2) otherwise a live row matching `(bot_id, repo_owner, repo_name)` with `repo_id IS NULL` is claimed — it takes the id and the names inside that request; (3) otherwise the bot's *single* live row whose repository columns are all null is claimed by the same guarded update. |
| R2 | A payload that carries no `repository.id` never claims: a matching unclaimed row is still returned so the repository reviews, and the row keeps its null identity until a delivery with an id arrives. |
| R3 | Two candidate unclaimed rows for one owner/name resolve to nothing. The lookup reads `LIMIT 2` and refuses rather than attributing the delivery by `created_at`, and the all-null step refuses unless the bot holds exactly one such row. |
| R4 | Owner/name comparisons are case-insensitive (`COLLATE NOCASE`) on every face that compares them — resolution, the duplicate rule, the attribution subquery, both Check-gate reads. GitHub repository identities are case-insensitive, so one spelling must not produce a second row. |
| R5 | No hit answers `200` with the `no_target_for_repo` seam: nothing is enqueued, no ledger row is written, and the outcome is recorded as ignored. Classification never rejects a delivery for policy reasons. |
| R6 | `repo_id` is assigned onto an existing row only by the resolver's claim. The insert path writes it on creation (the add-repository surface); the operator backfill inserts rows with owner/name identity and a null id, and never fabricates one. No other statement assigns it. |
| R7 | The classifier receives `{ installationId, repository: { id, owner, name } \| null }` where `repository.id` is an optional integer, and takes its trigger mode from the target's effective settings. The enqueue payload carries the resolved `targetId`; nothing resolves a second time in the queue, and a delivery whose target no longer resolves fails the message rather than defaulting. |

### Effective settings

| ID | Contract |
|----|----------|
| E1 | One read decides what a target runs with: `follow_workspace_defaults = 1` answers the workspace defaults (trigger mode, review level, gate floor, passing verdicts), `= 0` answers the row's own four columns. The workspace defaults are read only for a target that actually inherits, so an overridden target pays no second round trip. |
| E2 | While a target inherits, its effective settings are computed on every read and never copied into the row. A defaults change therefore reaches all inheriting targets immediately; no propagation job exists. |
| E3 | Turning inheritance off snapshots the currently effective values into the row; turning it on sets the flag only, leaving the stored overrides inert. A target that never overrode anything and a target whose overrides are inert answer the same policy. |
| E4 | New targets created through the surface inherit (`= 1`); targets created by the historical backfill do not (`= 0`, with the winner's configuration copied), so the upgrade changes no live review behaviour. |
| E5 | An unreadable stored `check_pass_verdicts` fails closed (an empty verdict list) with a `check_pass_verdicts_readable: false` flag on the wire, so a page can tell "saved nothing" from "could not read it" and refuse the policy save instead of overwriting the gate. |

### Store surface

| ID | Contract |
|----|----------|
| S1 | Reads: `listLive` (the workspace scope), `listLiveWithApp` (the list's one join carrying the application name and the newest review stamp), `listLiveByBot`, `countLive` (the list pill), `getInWorkspace(workspaceId, targetId)` (detail by UUID; foreign or deleted reads null) and `getForExecution(targetId)` (the queue's read, with no workspace predicate). |
| S2 | `create(...)` inserts one repository target and refuses as a duplicate when the same bot already holds a live row for that `repo_id`, or a live unclaimed row for the same owner/name — a migrated row is the same repository. The refusal writes nothing and returns a value the caller reports per repository. |
| S3 | `setReviewConfig` writes the row's policy columns with the store's vocabulary guards as the backstop behind the route's own parser; `setReviewEnabled` writes the business pause and refuses a foreign or deleted target. |
| S4 | `resolveByRepo` is the one execution-path resolver (R1–R6). The store no longer carries park, owner-overlap, allowlist or installation-binding operations; those code paths and their SQL are deleted, not retained behind a flag. |

### Add-repository API

| ID | Contract |
|----|----------|
| A1 | `GET …/api/apps/:appId/installation-repositories` walks the application's live installations with the App JWT (`per_page=100`, at most 5 pages and 500 repositories per installation, plus a listing time budget), dedupes by `repo_id` and answers `200 { repositories, degraded }`. A walk that stops with a next page pending is an incomplete answer, not a short one: it counts as a failed installation. `degraded: true` means some installations gave no answer while others did; an application that grants nothing is `200 []` (the dialog's empty state), and a walk that could not run at all — no encryption key, an undecryptable App key, a JWT that cannot be minted — or that failed for every installation is `502 installation_repositories_unavailable`. |
| A2 | `POST …/api/targets` takes `{ bot_id, repositories: [{ repo_id, owner, name }] }`, resolves the bot through the same workspace-scoped visibility rule as its sibling reads (owned apps plus shared bots already holding a live target here), and creates one target per repository with `follow_workspace_defaults = 1`. |
| A3 | The write refuses before the first insert: an empty or malformed selection is `400`, an invisible or unknown bot is `404 unknown app`, a non-manager is `403`, a `repo_id` outside the application's granted set is `400 repository_not_installed` with zero rows written, and an incomplete installation walk is `502` (fail closed — an incomplete walk proves nothing). |
| A4 | The list read (`GET …/api/targets`) answers each live target with `target_id, repo_id, repo_owner, repo_name, bot_id, app_name, review_enabled, follow_workspace_defaults, last_reviewed_at`, where `repo_id: null` is the only 待安装 discriminator. |

### Installation binding

| ID | Contract |
|----|----------|
| C1 | There is no install-claim table. Migration 0081 drops `install_claims`; an installation is recorded by the `installation.created` webhook into `bot_installations`, and nothing carries a pre-install intent. |
| C2 | There is no `/bot/setup` callback. The app-creation manifest sets no `setup_url`, so GitHub never redirects there; installation state is read from `bot_installations`, which the 已安装 tab and the bind action both read. |
| C3 | `POST …/api/apps/:appId/bind-installation` keeps its path and its shared-only bar; it upserts the installation directly (the webhook's own `bot_installations` upsert) and writes no target binding. The installation it is given must answer the pending read. |
| C4 | The operator `POST …/api/targets/:targetId/unbind` route is deleted with the binding column. A wrong installation is repaired through `bot_installations` handling, not by clearing a target column. |

### Application settings gates

| ID | Contract |
|----|----------|
| G1 | The visibility distinction is unchanged: `canManageApp` alone decides whether a caller receives the operational/settings face or the identity-only face, and the identity face keeps its field set. |
| G2 | An application with zero targets — or several — in the workspace is a valid settings subject: the gate resolves a single target only when the workspace holds exactly one live target under that application (exposing `targets_many` otherwise), and the blocked reason is derived from the requesting workspace instead of a target's workspace, with unchanged semantics. Visibility discrimination itself is untouched. The settings payload carries a top-level `target_id` only in that one-target case: a string, omitted with zero targets, and explicit `null` with `targets_many: true` on the Blocked face. The SPA parser reads target facts from `can_manage && typeof target_id === "string"`; an absent or null id is a named state, not a parse failure. The application payload carries no allowlist and no `owner_overlap` field. |
| G3 | The application detail's address is the canonical settings address: `/apps/:appId?tab=settings` serves it, the `/bot` sub-path and `?tab=settings` spellings both land on the 应用设置 tab, and `BotSettingsPage`'s view is the settings tab's body rather than a page of its own. |

### Tenant isolation

A tenant read is any dashboard or API read that returns reviews, insights, pull requests, target settings or Check configuration. Every such SQL binds both `target_id = ?` and the joined `review_targets.workspace_id = ?`; a route-level check is not a substitute. A target id from another workspace is a 404 on a single-target route and an empty result on an aggregation — never 403. Legacy rows with a NULL `target_id` stay invisible while the filter is set.

Execution reads — webhook bot lookup, consumer credential load, publication recovery, PR-head lookup — carry no workspace predicate by design.

`review_findings` and `review_failures` carry `target_id` (migration `0060_execution_ledger_target.sql`, backfilled from their pull-request row and guarded three ways), so their tenant predicate binds it directly through `ledgerScopeSql` (`src/dashboard/apps-store.ts`); the bot-keyed `pull_requests` join is no longer load-bearing. The aggregate face binds a target-id set resolved from the workspace's live targets in a subquery, so the bind count stays constant however many targets the workspace holds.

### Retired by this model

| ID | Contract |
|----|----------|
| X1 | No installation-bound target identity remains: a target holds no `installation_id` and no `account_login`, and there is no one-target-per-installation uniqueness. A bot owns one target per repository across all of its workspaces. |
| X2 | Creating an application creates no target. An application exists through its workspace mapping; a target appears only when a repository is added (or the first delivery claims a migrated row). A user-facing delete of an application that holds targets stamps `deleted_at` on those targets and on the bot in one batch. |
| X3 | No admission or repair machinery remains for per-repository exceptions: no allowlist, no park action, no owner-overlap check or audit repair path, and no per-target installation binding. The surface's admission answer is installation scope alone. |

## AuthZ matrix

| Surface | member (non-manager) | workspace owner / admin |
|---|---|---|
| `GET …/api/targets` | 200 | 200 |
| `GET …/api/targets/:targetId`, `GET …/api/targets/all` | 200 | 200 |
| `POST …/api/targets`, `POST …/api/targets/:targetId`, `POST …/api/targets/defaults` | 403 | 200 / 201 |
| `GET …/api/apps/:appId/installation-repositories`, `POST …/api/apps/:appId/bind-installation` | 403 | 200 |
| `GET …/api/targets/:targetId/insights/summary`, `GET …/api/targets/:targetId/pull-requests`, `GET …/api/insights/summary`, `GET …/api/pull-requests` | 403 | 200 |
| Application settings payload (operational fields, keys, chains, pause) | hidden (`can_manage: false` face) | visible |
| Webhook route, queue consumer | no session; resolves `(bot_id, repository)` from the delivery | same |
| Operator routes (`/_internal_admin/**`) | 404 | 404 (operator identity required) |

## Invariants

- One live target per `(bot, repository)`; the duplicate rule covers both an existing `repo_id` and an unclaimed owner/name match.
- `repo_id` is assigned onto an existing row only by the resolver's claim; the add-repository insert writes it, and the backfill never invents one.
- Effective settings are computed, never copied while inheriting; a migrated target never changes live review behaviour.
- A repository without a numeric id yet still resolves — by owner/name for the claim, and by the bot's lone placeholder row for a migrated one — so a null id means "awaiting the first delivery", never "unreviewable".
- The review job payload names the bot and the target; the consumer reads credentials and operational pause from the bot row and policy from the target row, and never defaults a missing target.
- `bot_id` is written once, by an INSERT: the store's `create()` (the add-repository route) and the operator backfill's insert. The resolver's claim updates repository columns, never `bot_id`. A new creating writer calls `checkEntitlement({kind: "shared-bot", …})` itself ([entitlement](../architecture/entitlement-and-deployment-modes.md) §5).
- No reader or writer of `allowlist_enabled`, `target_owner_allowlist`, the park/overlap operations, or the target installation binding remains.

## Where it lives

- `migrations/0067_repo_target_identity.sql`, `migrations/0068_target_repo_global_unique.sql`
- `src/dashboard/targets-store.ts` (`resolveByRepo`, `create`, `listLiveWithApp`, `countLive`, `getInWorkspace`, `getForExecution`, `readEffectiveTargetSettings`, `setInheritance`, `setReviewConfig`, `setReviewEnabled`)
- `src/worker/index.ts`, `src/worker/webhooks.ts` (repository classifier and target resolution)
- `src/dashboard/index.ts` (the target and defaults routes, the application-settings gates), `src/dashboard/apps-store.ts` (application visibility and installations)
- `src/pipeline/consumer.ts`, `src/contracts/review-job.ts` (execution reads)
- `tests/dashboard/targets-store.test.ts`, `tests/worker/webhook-routing.test.ts`

## Change obligations

A change to target identity, the uniqueness claim, resolution order or the claim paths, effective settings and inheritance, the add-repository API, the installation binding, the tenant read predicates, or the workspace default columns updates this page in the same change. A second target per bot is ordinary: the execution ledgers already carry `target_id`. A change to the repository claim or the resolution order updates this page and the repository surface page together. A new admission mechanism replaces the Admission rules of the repository surface page and the retired-model section here in the same change.
