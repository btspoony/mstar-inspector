# Feature: bot scope and installation claiming

## Scope

A review bot's visibility (`owned` / `shared`), the platform's official workspace, the installation-claim loop that attaches a shared bot installation to a review target, and the resolution guards that decide whether a delivery reviews at all.

## Current state

### Bot scope

| Field | Contract |
|---|---|
| `review_bots.scope` | `owned` (default) or `shared`. A `shared` bot may be referenced by targets outside its owning workspace. |
| `review_bots.shared_at` | Set when the bot is shared, cleared when unshared. A same-value write is a no-op: no row change, no audit row. |
| Authority | Platform operator only, through `/_internal_admin`. A workspace owner cannot mark its own bot shared. |
| Constraint | `shared` is only accepted for a bot whose workspace is the **official workspace** at write time. The check runs inside the same batch as the write, so a designation changed concurrently cannot authorize a stale share. |

A retained target grants its workspace no bot-scope write; the bot's lifecycle, configuration, keys, metadata, installations and deliveries belong to its owning workspace, and a Blocked target's payload carries only target-owned configuration.

### Official workspace

`review_runtime_settings["platform.official_workspace_id"]` — the platform parameter store's second key domain. Absent row means "no official workspace": no new share is possible, existing shares stay and remain revocable.

- Read: one parser (`runtime-config-store.ts`); an unknown, soft-deleted or unparsable value reads as absent.
- Write: trimmed, pattern-checked, and verified against a live workspace inside the batch. The value and its `platform_audit_events` row commit together; a refused write appends nothing.
- Audit action `runtime.official_workspace.set`, target `runtime`, detail `{before, after}`.

The store is not renamed: `review_runtime_settings` is the platform parameter store, and keys group by domain prefix (`review.*`, `platform.*`). A future rename is its own mechanical migration.

### Installation claims

GitHub's setup redirect carries `installation_id` and `setup_action` but **not** `state`, so attribution is session-based.

```
install_claims(id, user_id, workspace_id, target_id, created_at, expires_at, consumed_at, consumed_token)
```

- A claim is created (or refreshed in place) by a manager on the target page; TTL 15 minutes, enforced by the writer, no sweeper.
- The live predicate is one string everywhere: `consumed_at IS NULL AND expires_at > now`. A partial unique index keeps at most one live claim per `(user_id, target_id)`.
- A claim belongs to its creator: another session sees none, and the two states are indistinguishable.

### Setup callback

`GET` **never binds**. It is reached by a top-level browser navigation, and its
`installation_id` is caller-supplied and unverified — nothing in a `GET` can
prove that installation belongs to the claim's bot. Binding is a state change,
so it happens only on the explicit `POST`; the `GET` renders what it was told
and one form per claim.

| Request | Behaviour |
|---|---|
| `GET /bot/setup?installation_id=…&setup_action=install` | Requires a signed session (401 HTML otherwise). 0 live claims → a page that says `no_live_claim` and links back to the dashboard. 1 or N claims → a `confirm_required` page showing the installation id it was given, the claims (target, workspace, claimed instant) and one `POST` form per claim, carrying the claim's server-side id. **Writes nothing.** |
| `POST /bot/setup` | The only bind. Body: `installation_id`, `claim_id`. Refusals are JSON envelopes (`404 {"error":"claim not found"}`); the bind refusals keep their text bodies and the `GET` pages stay HTML/text. The session cookie is `SameSite=Lax`, so a cross-site `POST` cannot reach it — the confirm page is also the CSRF boundary. |

Binding is **one** batch of three statements: consume the claim, upsert `bot_installations` (copying `account_login` from the row, never inventing it), then bind the target. Ownership inside the batch is a per-call `consumed_token`, never the timestamp — two callbacks in the same millisecond must not let the loser mutate anything. A second **target** claiming an installation a target already holds is refused by `review_targets`' `UNIQUE (bot_id, installation_id) WHERE installation_id IS NOT NULL`; the batch rolls back with the claim left live and the answer is `409 installation already bound`. The `bot_installations` upsert cannot raise it at all: it is deliberately conflict-tolerant (`ON CONFLICT (bot_id, installation_id) DO UPDATE`).

A target that already holds a binding cannot start a new claim (`409 target already bound`): the batch would refuse a different installation and a same-installation claim has nothing to do. Repair is the operator's:

| Request | Behaviour |
|---|---|
| `POST /_internal_admin/api/targets/:targetId/unbind` | Operator only (`404` for anyone else), saas only. Clears `review_targets.installation_id` **and** the `account_login` copied from it, leaving the `bot_installations` row (the bot still has that installation), and appends one `bot.target_unbind` audit row in the same batch carrying the cleared before-state. `200 {"targetId","unbound":true}`; a target that holds no binding answers `200 … "unbound":false` and writes nothing; an unknown or soft-deleted target is `404 {"error":"target not found"}` and writes nothing. After it, the target is claimable again.

The webhook **never** writes a binding. An installation no target references is invisible to review.

### Resolution guards

`targets-store.resolve(botId, installationId)`:

| Bound? | Installation state | Bot scope | Result |
|---|---|---|---|
| yes | live | any | that target |
| yes | `removed_at` set | any | `null` — no fallback; a removed installation is not re-attributed |
| no | — | `owned` | the bot's single live target, else `null` |
| no | — | `shared` | `null` — no implicit attribution |
| ambiguous (two live targets) | — | any | `null` |

Dependency: `shared` stops reviewing until an installation is claimed. Operators must share, then claim.

`shared` is also a plan capability, not only a bot scope: `assertSharedBotAllowed`
([entitlement](../architecture/entitlement-and-deployment-modes.md) §5) refuses
a target creation on a shared bot and refuses the enqueue for a target whose
workspace plan no longer includes it. A creation refusal writes nothing and the
enqueue refusal sends nothing — its Check is settled `neutral` and the delivery
records one terminal `entitlement` failure. `self-hosted` always has the
capability and never reads the column.

## Invariants

- `shared` is platform-authorized and batch-verified against the current designation.
- The bind's ownership proof is the request token; a losing consume mutates nothing.
- A `GET` never writes: the bind needs the explicit confirm `POST`, so a mailed or prefetched `installation_id` cannot attach anything.
- A wrong bind is repairable: an operator clears the binding without touching the installation row.
- The webhook writes installations and deliveries, never target bindings.
- A removed installation or a shared bot without a binding resolves to nothing; silently falling back would re-attribute a review.

## Where it lives

- `migrations/0058_review_bot_scope.sql`, `migrations/0059_install_claims.sql`
- `src/dashboard/runtime-config-store.ts` (key + domain registry), `src/dashboard/apps-store.ts` (`setBotScope`, `listBotScopes`, `getInstallation`)
- `src/dashboard/install-claims-store.ts`, `src/worker/install-setup.ts`
- `src/dashboard/targets-store.ts` (`resolve` guards), `src/admin/index.ts` (`POST /api/targets/:targetId/unbind`)
- `src/spa/pages/SettingsPage.tsx`, `src/spa/pages/data.ts`, `src/i18n/*`

## Change obligations

Any change to scope authority, the claim lifecycle, the bind batch or the resolution guards updates this page. A chooser for non-operator workspaces, a Blocked state after a designation change, and quota live in later phases and must record their own contract here.

### Resolving a target for a workspace

A workspace may read a target when it holds a live target on that bot, **or** the bot is `shared`. The bot the workspace owns is always reachable through its own mapping. A foreign `owned` bot with no target here is a 404, and the list keeps the narrower rule (own, or shared with a live target here) so a revoked-share target is reachable by URL but not listed.

### Pending installations and binding

`GET`-side payload field `pending_installations` lists live `bot_installations` of the target's bot that no live target references (`removed_at` excluded), and is empty unless the bot is `shared` or mapped to the addressed workspace.

`POST /api/apps/:appId/bind-installation` (manager, `access: write`) creates-or-refreshes a claim and then runs the same guarded batch as the setup confirm. Guard order: unknown or foreign app → 404; non-manager → 403; bot not `shared` → 404 `bot is not shared` (no claim written); no target → 404; malformed id → 400; id absent from the pending read → 404 `unknown installation`; target already bound → 409 `target already bound`; lost race → 409 `installation already bound`. The batch remains the only writer of `review_targets.installation_id`.

### Derived Blocked state

Both detail payload faces carry `blocked` and, when true, `blocked_reason = "bot_not_shared"`. It is derived per request from the bot row and the target's workspace — true exactly when the bot is `owned` and the target's workspace is not the bot's workspace. There is no column and no projection. The page names the reason, hides the install/claim action and the bot-settings link, and still renders trigger, depth, gate and pause.

### Shared bots are read-only for their consumers

Every bot-scoped write route — settings operations, key deletion, provider-key verification (`keys/verify`, both the builtin and the custom/declared path), disable/enable and delete — refuses a `shared` bot before parsing, probing or persisting, with zero outbound calls and no storage change. `refresh-metadata` and `keys/usage` are not configuration writes but must still authorize the bot.

### Execution ledgers

`review_findings` and `review_failures` carry `target_id`, backfilled from their pull-request row and guarded three ways: a row with no resolvable target aborts the migration, a row with several candidate targets aborts it, and only an exactly-one candidate is attributed. Tenant reads bind `target_id` directly; the bot-keyed pull-request join is no longer load-bearing. `audit_events.target_id` is nullable so a park audit can name its target.

A row's `target_id` is set when it is first recorded and never rewritten; rebinding an installation moves future publications, not history.

### Parking an overlapping target

`POST /api/apps/:appId/park` (manager on the target's workspace, or operator) writes in one batch: one `target.park` audit row, `review_enabled = 0`, and `account_login = NULL`. It refuses `no-overlap` (no other live target in the workspace carries the same `account_login`), `only-live-target` (parking would leave that owner in this workspace with no live target), and a target outside the caller's workspace, all with zero writes. It never sets `deleted_at`, so the rows stay visible.
