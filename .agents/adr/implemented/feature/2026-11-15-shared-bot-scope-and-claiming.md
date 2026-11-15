# ADR: Share a bot only from the official workspace, and attach its installation by claim

Status: implemented — retrospective: `review_bots.scope`, the official-workspace designation and the `install_claims` bind shipped in migrations `0058_review_bot_scope.sql` and `0059_install_claims.sql`; this record was filed after the fact.
Spec: docs/specs/feature/bot-scope-and-claiming.md § Bot scope

## Problem

The platform's own GitHub App has to review repositories in workspaces it does not belong to, while its credentials, model chain, provider keys and installation state stay under one owner. Copying the App per consumer multiplies secret rotation and lets any workspace owner grant itself platform-wide reach. Once a bot *can* be shared, the second half of the problem appears: GitHub's setup redirect carries `installation_id` and `setup_action` but no `state`, so a browser-delivered installation id proves nothing about who may attach it.

## Decision

Three facts, each with one writer:

- **Scope.** `review_bots.scope` is `owned` (default) or `shared` (`migrations/0058_review_bot_scope.sql`); `shared_at` is set when shared and cleared when unshared. Only the platform operator may write it, through `PATCH /_internal_admin/api/bots/:botId/scope` → `setBotScope` (`src/dashboard/apps-store.ts`). A member route cannot reach `/_internal_admin`, and a workspace owner cannot share its own bot.
- **The designation.** `shared` is accepted only while the bot's workspace *is* the official workspace. The official workspace is `review_runtime_settings["platform.official_workspace_id"]` (`OFFICIAL_WORKSPACE_KEY` in `src/dashboard/runtime-config-store.ts`) — the platform parameter store's `platform.*` key domain, not a new table. The check is `officialWorkspaceGuardSql`, embedded in **both** statements of the write batch: the `platform_audit_events` insert and the `UPDATE review_bots SET scope = 'shared'`. A designation cleared or re-pointed concurrently therefore authorizes nothing — the pre-read that names a refusal (`outside_official_workspace`) is not the authority.
- **The claim.** A consumer attaches a shared bot's installation to its own target through `install_claims` (`migrations/0059_install_claims.sql`): one live claim per `(user_id, target_id)` enforced by the partial unique index `install_claims_live_target`, TTL `INSTALL_CLAIM_TTL_MS` (15 minutes), live predicate `consumed_at IS NULL AND expires_at > :now`. `GET /bot/setup` (`handleSetupGet`, `src/worker/install-setup.ts`) renders the claims and **never binds**; `POST /bot/setup` (`handleSetupPost`) is the only bind, and `consumeAndBind` (`src/dashboard/install-claims-store.ts`) runs it as one batch: consume the claim, upsert `bot_installations`, bind the target. Ownership inside that batch is the request's own `consumed_token`, because two callbacks in the same millisecond capture the same `now`.

A shared bot with no live binding resolves to no target at all (`resolve`, `src/dashboard/targets-store.ts`): there is no implicit attribution by workspace.

## Alternatives considered

- **A workspace-level "platform bot" flag instead of a bot scope.** The entitlement would live on the consumer, so nothing would stop a workspace from asserting platform reach over a bot it does not own; and the refusal could not be checked in the same batch as the write.
- **Copy the App into each consumer workspace.** Multiplies credentials, provider keys and installation state by tenant, and every rotation becomes N operations with no single owner.
- **Trust the setup redirect's `installation_id`.** The value is caller-supplied and delivered by a top-level browser navigation; a mailed or prefetched link would attach an installation the visitor never installed.
- **Bind on the `GET` for convenience.** A `GET` that writes turns any cache, prefetch or link preview into an installation attach.
- **Key the claim's ownership on its timestamp.** Two callbacks in the same millisecond would both pass, so the loser would mutate a target it does not hold.
- **Store the designation in a new settings table.** `review_runtime_settings` already groups platform parameters by key prefix; a dedicated table buys a second read path for one string.

## Consequences

- `shared` is read-only for its owning workspace too: `canWriteBotScope` (`src/dashboard/index.ts`) requires `scope === "owned"` *and* the caller's workspace to be the bot's owning workspace, so the operator's `/_internal_admin` path is the only writer of a shared bot's configuration.
- A share is reversible without the designation: unsharing is not gated on the official workspace, so a stale share stays revocable by the only role that can revoke it. An absent designation row means "no official workspace" — no new share, existing shares intact.
- The operator surface exists only on the `saas` router (`saasApp` in `src/worker/index.ts` mounts `/_internal_admin`; `self-hosted` serves 404 for it), so a self-hosted deployment can grant no share at all — the deployment-mode boundary is [entitlement and deployment modes](../../../../docs/specs/architecture/entitlement-and-deployment-modes.md) § 4. Deployment modes.
- Sharing stops review until a consumer claims an installation: the resolution table's `shared` row falls back to nothing, deliberately, so a review is never attributed to a workspace that has not proved the binding.
- A target that already holds a binding cannot start a new claim; repair is the operator's `POST /_internal_admin/api/targets/:targetId/unbind`, which clears the binding and leaves the `bot_installations` row.
