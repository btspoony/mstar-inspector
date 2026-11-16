# Architecture: operator admin surface

## Scope

The SaaS-only `/_internal_admin` authorization boundary, flags, plan assignment, bot scope, platform settings, read lists, support grants and audit ledgers.

## Current state
### 1. Identity and authorization

- Identity source: `PLATFORM_OPERATORS` (`src/worker/env.ts`), comma
  separated GitHub logins, case-insensitive, parsed by `parseLoginList`. Unset or
  empty means nobody is an operator.
- Authorization is checked **per request inside every handler**, via the existing
  `isPlatformOperator` (`src/dashboard/index.ts`). It is not inherited from
  an upstream middleware, a workspace role, or a support grant.
- A non-operator receives **404**, identical to any unknown path. The surface does
  not confirm its own existence.
- `self-hosted` mode registers no admin routes and renders no entry point. This is
  enforced at registration time, not by a runtime flag inside each handler.

### 2. Route namespace

`/_internal_admin` and `/_internal_admin/api/*`, mounted on the same Hono worker
(`src/worker/index.ts`), **outside** `dashboardApp` and therefore outside the
`/dashboard` tenant gate, workspace principal classifier and
`isOperatorReadPath` ceiling (`src/dashboard/index.ts`).

Reason: `isOperatorReadPath` matches by `path.endsWith(route.path)`; placing admin
paths in `APP_ROUTES` with `access: "read"` would silently widen the operator
read ceiling for workspace routes. The admin namespace must not join that
table — page routes AND `api/*` routes alike; the ceiling rule has no
exception for API paths. Admin route declarations live ONLY in the sub-app's
own local table inside `src/admin/index.ts`, mounted beside the dashboard app
(`app.route("/_internal_admin", adminApp)` next to
`app.route("/dashboard", dashboardApp)`, `src/worker/index.ts` — disjoint
prefixes, so no dispatch-order coupling exists).

Session: reuse the existing signed-cookie session. An admin request without a
valid session is a 404 (not a redirect to login, which would confirm the path).

### 3. Surfaces

### 3.1 Server flags

Table `server_flags (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`.

Initial keys and their exact consumer:

| key | consumer | semantics when disabled |
|-----|----------|-------------------------|
| `review_global` | enqueue decision in `src/worker/index.ts`, beside the per-App `review_enabled` pause gate | webhook still answers 2xx, nothing is enqueued. Already-queued reviews are **not** cancelled — the UI states this |
| `signup_open` | OAuth callback's first-sign-in branch (`src/dashboard/index.ts` region) | an unknown login cannot create a `users` row; existing rows are unaffected |
| `workspace_creation_open` | `POST /dashboard/api/workspaces` and the dashboard "new workspace" menu item | 409 with a named refusal; the menu item is disabled with the reason |

Read pattern: one prepared `SELECT enabled FROM server_flags WHERE key = ?` per decision
site, no caching layer, no KV. Absent row = enabled (fail-open to current
behaviour) so a missing row never breaks the platform.

Read cost: the per-request prepared point read
is accepted; no request-scoped memo is required. Each consumer reads its flag
exactly once per request, and the `review_global` site rides a webhook path
that already executes several D1 statements per verified delivery
(`recordDelivery`, `touchLastWebhook` — `src/worker/index.ts`) plus a
KV idempotency check and the queue send; one PK point read is marginal.
Absent rows remain enabled; read exceptions on the job path instead fail closed
(`review_global_read_failed`), preserving webhook response and diagnostic writes
while suppressing enqueue. Non-job deliveries and already-paused Apps skip the read. A request-scoped memo becomes REQUIRED only if a future consumer
reads the same flag twice within one request; cross-request caching stays
forbidden.

### 3.2 Workspace plan assignment

`PATCH /_internal_admin/api/workspaces/:id/plan` with `{ planId }`.

- Validates `planId` against the `plans` catalogue (unknown id → 400).
- Upserts `workspace_subscriptions` (`status='active'`, `updated_at` now).
- Downgrading below the current live member count is allowed: it blocks **new**
  invites, never removes members.
- Writes one platform audit row.
- Never edits `plans` rows.

### 3.3 Read lists

- `GET /_internal_admin/api/workspaces` — id, name, slug, owner login, live
  member count, pending invite count, `planId`, `createdAt`.
- `GET /_internal_admin/api/users` — login, first-seen (`users.created_at`),
  workspace count, `isOperator` (from the env list), active support-grant count.
- `GET /_internal_admin/api/bots` — bot id, name, GitHub App id, workspace,
  `scope`, `sharedAt`, `deletedAt` for every non-deleted bot (§ 3.5).

Both workspace and user reads are single-statement reads with the counts
resolved in SQL, not N+1; the bot read is a single name-ordered join.

### 3.4 Support grants

- `GET /_internal_admin/api/support-grants` — active grants across workspaces.
- `POST /_internal_admin/api/support-grants` — `{ workspaceId, operatorLogin,
  reason, ttlHours }`; reuses `insertSupportGrant` and its validation.
- `DELETE /_internal_admin/api/support-grants/:id` — deletes the row; a grant is a
  time-boxed access aid, not history, so removal is a delete, not a tombstone.
- Grant writes append to the existing `audit_events` table with the target
  `workspace_id` (that table requires one).

### 3.5 Bot scope and platform settings

A review bot carries a scope: `owned` serves its own workspace, `shared` is
offered platform-wide. Only a bot inside the platform's official workspace may
be shared, and the designation is global platform state — not a tenant column
and not a boolean flag.

`PATCH /_internal_admin/api/official-workspace` with `{ workspaceId }`:

- The value is the one row `review_runtime_settings["platform.official_workspace_id"]`.
  `src/dashboard/runtime-config-store.ts` is its only parser and writer; no
  handler, route or SPA code queries that row.
- An id must name a live (`deleted_at IS NULL`) workspace. An unknown, retired
  or malformed id is `400 {"error":"workspace not found"}` with no write and no
  audit row.
- `null` clears the row — a DELETE of the key, never an insert of an empty
  value — and is idempotent: an absent row still answers `200` with no audit
  row. An empty string is a body-shape error, never "clear".
- Success is `200 {"workspaceId":<id>|null}`; the value and its audit row land
  in ONE `batch`.
- An absent row means "no official workspace". It disables new shares and
  nothing else: it does not revoke an existing share and does not disturb a
  bound installation.
- The read degrades rather than refusing: an id naming a soft-deleted workspace
  reads as "none", so a tenant retired after the write cannot keep platform-wide
  sharing enabled through a stale value. Only the write refuses.

`PATCH /_internal_admin/api/bots/:botId/scope` with `{ scope, confirm }`:

| From → to | Conditions | Writes |
|-----------|------------|--------|
| `owned → owned`, `shared → shared` | bot live | none: `200` with the current row, no audit row |
| `owned → shared` | bot live, official workspace set, and the bot's `bot_workspaces.workspace_id` is that id | `scope='shared'`, `shared_at` = now |
| `shared → owned` | bot live, `confirm: true` | `scope='owned'`, `shared_at = NULL` |

- Refusals, with their exact bodies: invalid scope is
  `400 {"error":"body must be { scope: \"owned\" | \"shared\" }"}`; an unknown or
  soft-deleted bot is `404 {"error":"bot not found"}`; a share outside the
  official workspace (or with none designated) is
  `409 {"error":"bot is outside the official workspace"}`; a revoke without
  `confirm: true` is `400 {"error":"unsharing requires confirm: true"}`. A
  refused write appends no audit row.
- Every condition is re-checked inside the write's own `batch`, so the
  designation a share is authorized by is the one in force when the row is
  written: clearing or re-pointing it between the console's read and its write
  refuses the share instead of letting it land against a stale value. The FROM
  scope is guarded the same way, so two identical transitions land once — the
  loser reports the state the winner persisted, with no second audit row.
- Unsharing is deliberately NOT gated on the official workspace: a stale share
  must stay revocable by the only role that can revoke it.
- The flag is a platform authorization, never workspace self-service. No
  dashboard route, workspace-owner path or API key writes `scope`, and no
  per-bot or per-workspace operator scope exists to widen it.
- Success is `200 {"botId","scope","sharedAt"}`; the row and its audit row land
  in ONE `batch`, and a re-share stamps a new `shared_at` — the earlier instant
  survives only in the audit ledger.

`GET /_internal_admin/api/bots` lists every bot with `deleted_at IS NULL`,
ordered by `name, id`, as
`{"bots":[{"botId","name","githubAppId","workspaceId","scope","sharedAt","deletedAt"}]}`;
the console read is unaudited. `GET /_internal_admin/api/runtime` additionally
states `officialWorkspaceId: string | null`.

Table reuse, deliberate: `review_runtime_settings` is the **platform's parameter
store**, whose keys group by domain prefix — `review.*` for review behaviour,
`platform.*` for platform state — and `RUNTIME_SETTING_DOMAINS` /
`isRuntimeSettingKey` in `runtime-config-store.ts` is what holds that line.
A fourth settings table would buy a migration, a second audit wiring and a
second parser while duplicating three rules this table already provides (absent
row = default, an invalid value fails loud at the writer, write + audit in one
batch). The table's name is the honest cost; renaming it later is a mechanical
migration, not a behaviour change.

The encryption master key is not platform state and no route here reads it:
`DASHBOARD_ENCRYPTION_KEY` is a deploy-time Worker secret
(`docs/deploy.md` § Multi-App go-live → *Set DASHBOARD_ENCRYPTION_KEY*). That
section also states the pre-deploy gate that refuses a malformed key, so an
operator console whose settings writes answer 500 is debugged against the
deploy, not against this surface.

### 3.6 Provider sizes and the add-key refusal

Two operator-facing rules on the bot settings page, both presentation-only —
neither changes a route, a payload or a stored column.

**An unstated provider size is a normal answer.** The per-model size set
(`contextWindow`, `maxTokens`) is stored only as far as the operator states it.
`parseCustomProviderModelsMeta` (`src/dashboard/index.ts`) skips an absent field
before any shape check, so a partial set saves as-is and a model that states no
size stores no override at all — the runtime's own default applies. A stated
value must still be a positive whole number, and the refusal names the model and
the field. The dialog therefore pre-fills only a catalog-supplied number, posts
no value the operator left untouched, and never disables the save for a blank
size. A provider with **no** catalog row has unknown sizes, not zero sizes: it
states that case instead of naming a snapshot it cannot have.

**One refusal per status.** `verifyRefusalMessage` resolves STATUS first, body
second. 400 keeps the route's per-reason faces; 403 separates a `shared` bot
(the keyed `settings.error.botReadOnly` body) from the non-manager forbidden
page; 404, 409 and 429 name their own cause; 500 splits by body shape, because
the Worker already answers a missing `DASHBOARD_ENCRYPTION_KEY` in plain text
and a rejected write as JSON. A body this page cannot read falls back to that
family's copy, and the one shared "unexpected response" sentence survives only
for a 400 naming a reason the page does not know. No face echoes the submitted
key, the response body or the status code.

### 4. Platform audit

Table `platform_audit_events (id TEXT PRIMARY KEY, actor_login TEXT NOT NULL COLLATE NOCASE, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, detail_json TEXT, created_at TEXT NOT NULL)` with an index on `(created_at)`.

Written for: flag toggles, workspace plan changes, and the two runtime
decisions — `runtime.official_workspace.set` (`target_type` `runtime`,
`target_id` `platform.official_workspace_id`, `detail_json`
`{"before":<id>|null,"after":<id>|null}`) and `runtime.bot_scope.set`
(`target_type` `bot`, `target_id` the bot id, `detail_json`
`{"before":{"scope","shared_at"},"after":{"scope","shared_at"}}`). Each of those
writes appends its row in the SAME `batch` as the value change, so a refused
write appends nothing and an accepted one cannot lose its row. Not reused for
support grants (they already fit `audit_events`).

The existing `audit_events.workspace_id NOT NULL` is deliberately not relaxed: it
is a forward-only column contract shared with workspace-level auditing, and
platform scope is a different lifecycle.

Audit ownership: no admin action loses its audit trail.
Every admin WRITE has exactly one home — flag toggles and plan assignment are
platform-scope decisions → `platform_audit_events` (actor, action, target,
before/after detail); support-grant create/delete are workspace-scope writes →
`audit_events`, whose `workspace_id NOT NULL`
(`migrations/0029_operator_support.sql`) the grant's target workspace
always satisfies. Admin list reads are deliberately unaudited: audit rows
attach to writes and to operator presence inside a tenant (the existing
support-grant middleware already writes `support.read` / `support.denied`,
`src/dashboard/index.ts`), not to platform-scope reads.

### 4.1 Retention

**Append-only, no pruning, retained indefinitely.** Neither table gains a delete
path: `audit_events` has no `UPDATE` or `DELETE` statement by construction
(`migrations/0029_operator_support.sql`), and `platform_audit_events` is
written the same way — the operator surface exposes no route that would remove a
row from either ledger. Retention is therefore a property of the schema, not a
job that has to be scheduled and kept working.

Revisit this decision when **row count or query latency becomes a problem** —
whichever is observed first. Because both tables are indexed for the read that
matters, the revisit starts from measured numbers, not from a fixed horizon:
`audit_events` carries `audit_events_workspace ON audit_events (workspace_id,
created_at)` for the per-workspace timeline its readers ask for, and
`platform_audit_events` carries `platform_audit_events_created ON
platform_audit_events (created_at)` for the platform timeline. Any future
pruning or archival must land as an explicit schema and contract change here —
never as an ad-hoc cleanup run against production data.

### 5. Entry point visibility

The dashboard shell renders a "platform operations" link only when the boot
payload says the viewer is an operator **and** the deployment mode is `saas`.
The boot boolean is derived server-side from
`isPlatformOperator(env, login)` combined with
`deploymentModeOf(env.DEPLOYMENT_MODE) === "saas"`, never from a client check.
`isPlatformOperator` takes the `Env` (it parses `PLATFORM_OPERATORS`), not a mode
string — the mode is a separate conjunct.

### 6. Non-goals

- No billing, invoicing or payment integration.
- No `plans` catalogue editor.
- No operator impersonation of a workspace member (support grant remains the only
  cross-workspace access path).
- No admin action on review findings, review rows or apps beyond the
  `review_global` flag.

## Invariants

- Every handler checks operator identity; missing sessions and non-operators receive 404.
- No admin route joins tenant `APP_ROUTES`; self-hosted registers none.
- Every admin write has exactly one audit home; list reads are unaudited.
- Both audit ledgers are append-only and retained indefinitely.
- A provider size is never a save precondition: only a stated value is stored and
  shape-checked, and an absent one means the runtime default.
- No add-key status reaches the operator as one undifferentiated sentence, and
  no refusal face echoes the key, the body or the status code.

## Where it lives

- `src/admin/index.ts`: admin sub-app, local routes, per-handler authorization.
- `src/admin/flags.ts`: `isFlagEnabled` point reads and absent-row defaults.
- `src/worker/index.ts`: sibling sub-app mounts and `review_global` enqueue gate.
- `src/worker/env.ts`: `parseLoginList`, `PLATFORM_OPERATORS`, deployment mode.
- `src/dashboard/index.ts`: session, signup/workspace gates, boot visibility.
- `migrations/0029_operator_support.sql`: grants and workspace audit.
- `migrations/0033_platform_admin.sql`: flags and platform audit.
- `migrations/0058_review_bot_scope.sql`: `review_bots.scope` / `shared_at`.
- `src/dashboard/runtime-config-store.ts`: the platform parameter store —
  `platform.official_workspace_id` and the key-domain registry.
- `src/dashboard/apps-store.ts`: the bot-scope transition and its audit row.
- `src/spa/pages/provider-models-dialog.tsx`: the per-model size fields, the
  catalog pre-fill and the unknown-size sentence (§3.6).
- `src/spa/pages/SettingsPage.tsx` (`verifyRefusalMessage`): the add-key
  refusal's status-first resolution, rendered by the bot page's verify submit.

## Change obligations

Update this page when routes, flags/defaults, authorization, payloads or audit ownership change. Retention/pruning is an explicit schema-and-contract change, prompted by measured row count or query latency, never ad-hoc cleanup.
