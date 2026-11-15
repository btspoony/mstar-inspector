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
| `POST /_internal_admin/api/targets/:targetId/unbind` | Operator only (`404` for anyone else), saas only. Clears `review_targets.installation_id` **and** the `account_login` copied from it, leaving the `bot_installations` row (the bot still has that installation). `200 {"targetId","unbound":true}`; a target that holds no binding answers `200 … "unbound":false`; an unknown or soft-deleted target is `404 {"error":"target not found"}`. After it, the target is claimable again.

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
