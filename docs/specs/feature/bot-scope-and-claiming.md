# Feature: bot scope and installation binding

## Scope

A review bot's visibility (`owned` / `shared`), the platform's official workspace, the bind that attaches a shared bot installation to the application, and the guards that decide whether a delivery reviews at all.

## Current state

### Bot scope

Two independent switches — an App and a bot are different entities, and sharing
one grants nothing about the other. Each has its own column, guard, route and
audit action:

| Switch | Column | What sharing it grants |
|---|---|---|
| Share this App | `github_apps.scope` (`owned` default, `shared`), `github_apps.shared_at` | other workspaces may bind this App's installations and mount its bots: the bind route, the pending list, App visibility and the marketplace list (`SHARED_APP_LIST_SQL`) |
| Share this Bot | `review_bots.scope`, `review_bots.shared_at` | another workspace may mount the bot in its chain and spend against its capability and ceiling: the mountability check, the relay's capability gate and the bot list |

- A `shared` bot has no GitHub identity of its own: it publishes as the App of
  the installation it is mounted on. Sharing a bot changes no App's scope;
  sharing an App changes no bot's scope and no review's price.
- `shared_at` is set when the entity is shared and cleared when it is unshared.
  A same-value write is a no-op: no row change, no audit row.
- **Authority.** The platform operator, through the console (`PATCH
  /api/bots/:botId/scope` for an App — the pre-split path is kept — and `PATCH
  /api/review-bots/:botId/scope` for a bot, `src/admin/index.ts`); and the
  owning workspace's owner/admin, through `PATCH
  /dashboard/:workspaceRef/api/apps/:appId/scope` and `PATCH
  /dashboard/:workspaceRef/api/review-bots/:botId/scope`
  (`src/dashboard/index.ts`). Both land on `setAppScope` / `setReviewBotScope`
  (`src/dashboard/apps-store.ts`); the bot writer re-checks ownership and the
  owner/admin role inside the store, so a caller that bypasses the route
  cannot write.
- **One guard, bound to each entity's owner.** `shared` is accepted only while
  that entity's owning workspace is the **official workspace** at write time:
  the App guard resolves the owner through `app_workspaces`, the bot guard
  binds `review_bots.workspace_id`. The check runs inside the same batch as the
  write, so a designation changed concurrently cannot authorize a stale share.
  Unsharing carries no guard on purpose — an entity shared before a
  designation change stays revocable by its owning workspace, and the UI may
  hide the control while the API path stays open.
- Everyone else has no scope write: `canWriteBotScope` (`src/dashboard/index.ts`)
  admits only the entity's owning workspace, and a member route reaches no
  entity whose workspace they do not own.

A retained target grants its workspace no bot-scope write; the bot's lifecycle,
configuration, keys, metadata, installations and deliveries belong to its owning
workspace, and a Blocked target's payload carries only target-owned
configuration.

### Official workspace

`review_runtime_settings["platform.official_workspace_id"]` — the platform parameter store's second key domain. Absent row means "no official workspace": no new share is possible, existing shares stay and remain revocable.

- Read: one parser (`runtime-config-store.ts`); an unknown, soft-deleted or unparsable value reads as absent.
- Write: trimmed, pattern-checked, and verified against a live workspace inside the batch. The value and its `platform_audit_events` row commit together; a refused write appends nothing.
- Audit action `runtime.official_workspace.set`, target `runtime`, detail `{before, after}`.

The store is not renamed: `review_runtime_settings` is the platform parameter store, and keys group by domain prefix (`review.*`, `platform.*`). A future rename is its own mechanical migration.

### Installation binding

Three tables answer three different questions: a physical installation is
GitHub's, an install state is one workspace's, and the chain is what that state
mounts.

| Table | Holds | Written by |
|---|---|---|
| `github_app_installations` (pre-split `bot_installations`, renamed and re-pointed in `0115`) | one row per GitHub installation of one App — `installation_id`, `account_login`, `seen_at`, `removed_at`, and `bound_workspace_id` (migration `0104`) — keyed `(app_id, installation_id)`; the id changes on reinstall | the `installation.created` / `deleted` webhooks (`upsertInstallation`), and the bind for `bound_workspace_id` only |
| `app_installations (github_app_id, workspace_id)` | one workspace's install of one App — never the physical row; both columns are its key | `createApp` (the owner's own state, with zero physical installations) and `bindInstallation` (a workspace's first installation of the App), each in the batch that carries its authority; backfilled by `0118`; removed with its chain when a non-owned App loses its last installation |
| `app_install_bots (github_app_id, workspace_id, position, bot_id)` | the ordered chain under one install state; key `(github_app_id, workspace_id, position)`, composite foreign key to `app_installations`; a position is a stored order, never a rank to renumber | `createApp`, `bindInstallation` and the chain rewrite `PATCH /api/apps/:appId/chain`; nothing else |

- **A new install state copies the App owner's chain.** The owner's chain is the
  `app_install_bots` rows of `(app.id, app.owner)` — `app_workspaces.workspace_id`
  — and it is what the App brings. A first bind copies those rows in the
  owner's positions, keeping only bots that are `shared` or owned by the binding
  workspace; when none qualifies the chain is empty and the App's Bots tab says
  so. App creation writes the owner's state with one row at position 1 naming
  the bot the App created. A bind by a workspace that already holds the state
  writes no chain row, a target creation never writes one, and a chain rewrite
  keeps the requested order rather than renumbering.
- A chain row is mountable while its bot is `shared` or owned by the chain's
  workspace, checked inside the writing batch. A bot its owner later stops
  sharing stays in the chain as a skipped row, and only a newly added bot must
  be mountable.
- **The pending list is physical.** `pending_installations` lists live
  `github_app_installations` rows of that App minus those bound to a live
  workspace, and is empty unless the App is `shared` or mapped to the addressed
  workspace. The bind writes `bound_workspace_id` only after the signed-in
  manager's own GitHub user token shows they administer the installation's
  account; the webhook never writes it. There is no pre-install intent table and
  no callback route: the app-creation manifest sets no `setup_url`, so GitHub
  never redirects to one.
- **Membership of `/api/apps` is the install state.** A row appears because the
  workspace owns the App or holds its `app_installations` row; a live target and
  a physical installation decide nothing — they can neither resurrect an App
  with no state nor hide one whose state exists (a bound App its owner stopped
  sharing stays listed). `listInstalledBotIds` reads `app_installations` alone,
  and an installed row's month cell sums the bots its chain mounts, not a bot
  sharing the App's id.

Migration `0081` drops `install_claims`; migration `0067` dropped the
target-keyed variant before it.

### Resolution guards

`targets-store.resolveByRepo`, keyed by the App's id:

After signature verification and classification, the delivery resolves its target by repository: `(app_id, repo_id)` first; otherwise a live unclaimed owner/name row is claimed in that request; otherwise the App's single live row with no repository columns is claimed. Two unclaimed candidates or no hit resolve to nothing. No hit answers `200` with `no_target_for_repo`, enqueues nothing and writes no ledger row.

A shared bot reviews once the consuming workspace holds a target for that repository.

`shared` is also a plan capability, not only a bot scope:
`checkEntitlement({kind: "shared-bot", …})`
([entitlement](../architecture/entitlement-and-deployment-modes.md) §5) refuses
a target creation on a shared bot and refuses the enqueue for a target whose
workspace plan no longer includes it. It is the one entry every plan verdict
comes from, and `assertSharedBotAllowed` survives only as that branch's internal
body. A creation refusal writes nothing and the enqueue refusal sends nothing —
its Check is settled `neutral` and the delivery records one terminal
`entitlement` failure. `self-hosted` always has the capability and never reads
the column.

A second enqueue refusal sits beside it, produced by the relay
([entitlement](../architecture/entitlement-and-deployment-modes.md) § RP metering
and the monthly ceiling): a shared bot that no ceiling admits. It has the SAME
shape and sends nothing — the attached Check settles `neutral` and one terminal
failure is recorded — under the `quota` stage, because the cause is consumption
rather than capability. A delivery records at most one refusal, and the relay's
precedence is the workspace's plan month, then the bot's month, then the
capability; an empty chain, or a chain of bots whose owners stopped sharing,
refuses `no-review-bot`.

## Invariants

- `shared` is platform-authorized and batch-verified against the current designation.
- The bind writes only an installation the App already reported: the pending read is the gate, so an id the App never saw attaches nothing.
- A shared App's installation grants its repositories to the one workspace it is bound to; an unbound row grants none, and a row bound to another live workspace is never rebound (first binder wins). A deleted workspace's binding counts as unbound.
- A wrong installation is repaired at the installation level; no per-target binding column exists to clear. No route unbinds an installation bound to a live workspace. Deleting the wrongly bound workspace is the full repair: its binding then counts as unbound and the same batch retires its targets. Uninstalling and reinstalling the App gives a new installation id that arrives unbound, but the wrongly bound workspace's live targets keep their repository claims (delivery resolution reads targets, not bindings) until they are removed in that workspace.
- The webhook writes installations and deliveries; it claims a null repository identity on its target and writes no installation binding.
- A delivery whose repository matches no live target, and one matching two unclaimed rows, resolves to nothing; silently falling back would re-attribute a review.

## Where it lives

- `migrations/0058_review_bot_scope.sql`, `migrations/0067_repo_target_identity.sql`, `migrations/0081_drop_install_claims.sql`, `migrations/0104_bot_installation_binding.sql`
- `migrations/0115_app_bot_split.sql` (the two entities, `github_app_installations`, `app_installations`, `app_install_bots`), `migrations/0116_github_apps_sandbox_image_drop.sql`, `migrations/0118_app_install_state_backfill.sql` (the install-state backfill), `migrations/0124_app_install_chain_guard.sql` (the chain rewrite's all-or-nothing guard)
- `migrations/0062_review_usage_indexes.sql` (the usage read's composite indexes)
- `src/dashboard/runtime-config-store.ts` (key + domain registry), `src/dashboard/apps-store.ts` (`setAppScope`, `setReviewBotScope`, `getInstallation`, `bindInstallation`, `listPendingInstallations`, `listInstalledBotIds`, `listInstallChainBots`, `replaceInstallChain`)
- `src/dashboard/targets-store.ts` (`resolveByRepo`), `src/admin/index.ts` (`GET /api/usage`)
- `src/dashboard/review-usage-store.ts` (`readReviewUsage`, `reviewUsageMonth`), `src/dashboard/index.ts` (`GET /dashboard/<ref>/api/settings/review-usage`)
- `src/spa/pages/ReviewUsageCard.tsx`, `src/spa/admin/UsagePage.tsx`
- `src/spa/pages/SettingsPage.tsx`, `src/spa/pages/data.ts`, `src/i18n/*`

## Change obligations

Any change to scope authority, the bind write or the resolution guards updates this page. A chooser for non-operator workspaces, a Blocked state after a designation change, and quota live in later phases and must record their own contract here.

### Resolving a target for a workspace

A workspace may read a target when it holds that live target: the repository claim makes a target reachable inside its own workspace only. A foreign `owned` bot with no target here is a 404. The app list's membership is the install state (§ Installation binding), so a revoked-share target stays reachable by URL without adding its App to the list.

### Pending installations and binding

`GET`-side payload field `pending_installations` lists live `github_app_installations` of that App that are bound to no live workspace (`removed_at` excluded; a deleted workspace's binding counts as unbound), and is empty unless the App is `shared` or mapped to the addressed workspace.

`POST /api/apps/:appId/bind-installation` (manager, `access: write`) writes nothing itself. Guard order: unknown or foreign app → 404; non-manager → 403; App not `shared` → 404 `bot is not shared`; malformed id → 400; already bound here → `200 { bound: true }`; id absent from the pending read (including one bound to another workspace) → 404 `unknown installation`. Otherwise it sets a signed, short-lived bind-state cookie and answers `200 { bound: false, authorize_url }`, a GitHub OAuth step-up with `read:user read:org`.

The OAuth callback recognises that state and binds only when every check holds, else it renders an error page and binds nothing: the state matches this browser's cookie and is unexpired; the GitHub user is the signed-in user and still manages the workspace (re-checked immediately before the write); no maintenance window is closed (503); the installation is live and not bound elsewhere (409); and the installation's account (`GET /app/installations/{id}`, App JWT) is either that same user or an organization where `GET /user/memberships/orgs/{org}` with the user's token is `active` + `admin` (else 403). The write is `UPDATE … SET bound_workspace_id` guarded by `bound_workspace_id IS NULL OR = caller OR` the bound workspace is deleted. The user token is used for these reads only and is never stored.

### Derived Blocked state

Both detail payload faces carry `blocked` and, when true, `blocked_reason = "bot_not_shared"`. It is derived per request from the bot row and the target's workspace — true exactly when the bot is `owned` and the target's workspace is not the bot's workspace. There is no column and no projection. The page names the reason and hides the install action, pointing it at the application's 已安装 face; the repository detail keeps rendering trigger, depth, gate and pause.

### Shared bots are read-only for their consumers

Every bot-scoped write route — settings operations, key deletion, provider-key verification (`keys/verify`, both the builtin and the custom/declared path), disable/enable and delete — is gated by one predicate, `canWriteBotScope` (`src/dashboard/index.ts`, `app.workspace_id === scope.workspaceId`): the caller's workspace must be the bot's owning workspace, read off the same joined row. Scope is **not** part of the decision, so a `shared` bot's owning workspace keeps every configuration write — including the share switch, `PATCH /dashboard/:workspaceRef/api/review-bots/:botId/scope` — while a consuming workspace is refused: a retained target grants review configuration, never the bot. A refusal makes no outbound call and no storage change, but the check's position differs by family: the settings operations parse the body first to read their `op` (`appSettingsSaveRoute`, `src/dashboard/index.ts`) and then gate on the predicate, while key deletion and provider-key verification refuse before parsing anything. `refresh-metadata` and `keys/usage` are not configuration writes but must still authorize the bot.

Two surfaces carry the two halves of a bot's configuration, and only one of them is refused here:

- The application detail's 应用设置 tab body (`BotSettingsPage.tsx`) is bot-owned configuration only — credentials health, provider keys, model chains, seats, sandbox image and installations.
- The target's review policy — trigger mode, depth, Check gate and pause — is **target** data, written on the repository detail, `/dashboard/<workspaceRef>/repos/<targetId>` (`TargetDetailPage` in `src/spa/pages/TargetsPage.tsx`, whose 评审配置 tab is `TargetSettingsTab` in `src/spa/pages/TargetSettingsTab.tsx`). `…/apps/:appId/settings` and `…/apps/:appId/bot` both redirect to `…/apps/:appId?tab=settings` (`settingsTabRedirect`, `src/spa/routes.ts`). It is governed by the target's workspace role, not by `canWriteBotScope`.

A consumer workspace may therefore still change its own target policy; only the bot-scoped writes above are refused for a `shared` bot.

### Execution ledgers

`review_findings` and `review_failures` carry `target_id`, backfilled from their pull-request row and guarded three ways: a row with no resolvable target aborts the migration, a row with several candidate targets aborts it, and only an exactly-one candidate is attributed. Tenant reads bind `target_id` directly; the bot-keyed pull-request join is no longer load-bearing. `audit_events.target_id` is nullable so a target-scoped audit row can name its target.

A row's `target_id` is set when it is first recorded and never rewritten; retiring and re-adding a repository moves future publications, not history.

### Review usage

The workspace settings card (`/dashboard/<ref>/settings`) carries two counters
for one UTC month — the credit block above, the published-review counts below —
and the operator console has a face per counter: `/_internal_admin/usage` for
the review counts and `/_internal_admin/quota-versions` for the quota profiles
that price the credits. The published-review counts on both faces read one
statement (`src/dashboard/review-usage-store.ts#readReviewUsage`) parameterized
by workspace.

| Rule | Contract |
|---|---|
| Window | One UTC calendar month of `reviews.reviewed_at` — the instant the review row was recorded, i.e. the month the review finished, never the month it was requested. Half-open: `>=` the first instant of the month, `<` the first instant of the next, compared as plain `YYYY-MM-DD HH:MM:SS` text. No local-time bucketing, no rolling 30-day window, no cache. Only review rows count: a target with no review in the window adds nothing. |
| Attribution | A review belongs to the workspace of its **target**: `reviews.target_id` → `review_targets.workspace_id`. `reviews.installation_id` is not a substitute — it names the credential the run used and says nothing about which workspace consumed the review. |
| Split | `review_bots.scope` decides the column, never which workspace owns the bot: `shared` counts as a shared-bot review **even in the shared bot's own workspace**, every other scope counts as own-bot. The scope is read at query time, so a month's split reflects the bot's scope *now*; it is not a snapshot of the scope at review time. |
| No target | A review with no `target_id` has no bot either (migration `0057_review_targets.sql` attributes history only where `bot_id` is NOT NULL), so it names no workspace and is **excluded from both counts**. This sentence is the rule; the row is not dropped silently. |
| Soft deletion | `workspaces.deleted_at` filters the row (a retired tenant has no face). `review_targets.deleted_at` and `review_bots.deleted_at` do **not**: the count is what happened, and a soft-deleted target keeps its month. |
| Visibility | `?3` is the caller's workspace id on the settings card and `NULL` (every live workspace) on the operator face — one shape, two bindings. The workspace face cannot read another tenant's row, and the operator face lists live workspaces with zero reviews as well. |
| Order | Shared-bot reviews descending, then own-bot reviews descending, then the workspace name ascending, then the workspace id ascending — `workspaces.name` is not unique, so the id closes the last key and two same-named workspaces cannot swap places between reloads. |
| Paging | None, by design. The operator face answers **every** live workspace with both counts in one statement — the bound is the deployment's live workspace count (three numbers per row, a few hundred at the scale this platform runs) — and the page filters the loaded rows client-side. If a measured read ever exceeds that bound, server paging is a new stated contract — never a silent cap that hides rows the counter still counts. |

Indexes: `migrations/0062_review_usage_indexes.sql` adds the composite
`reviews(target_id, reviewed_at)` and `review_targets(workspace_id)` indexes, so
the month drives the join instead of a per-target history scan filtered
afterwards. `idx_reviews_reviewed_at` stays: reads that filter the window with
no target still use it.

Heading placement: a page's title names the surface, and the window sits in
the description line under it — the month is only known once the read has
answered, so a title carrying it would render blank and then reflow.

#### Which counter each label reads

Three counters exist and the surfaces never present them as one number:

| Counter | Read by | What it counts |
|---|---|---|
| `usage_events.rp` | the card's credit block; the enqueue's ceiling | Integer RP charged per **started** review, priced by the profile judging the month. |
| `usage_events` rows | the members page's "this workspace" meter | Started review **attempts**. One review can contribute several rows (a retry after a runner failure mints the next `seq`). |
| `reviews` | the card's published-review rows; `/_internal_admin/usage` | **Published** reviews — a row exists only once a review finished and was stored. |

They differ by construction, and the differences are the rule rather than noise:
an attempt that fails after being charged spends RP and writes no review row; a
retry charges again; a review that never publishes is never counted as one. So
the credits and the review counts are never equal and no copy may imply they
are. The card states this on the surface (`workspace.quotaBasis`) and the labels
keep the words apart: the review rows say `reviews`, the members meter says
attempts, and the credit block speaks credits throughout — the internal unit
never reaches an operator-visible string.

Counters are not unified, and no report may substitute one for another: a
workspace at its ceiling is refused by the credits (the RP ceiling), not by the
published-review count.

#### The credit block

Credits are **presentation over integer RP**. Every stored and compared value is
RP (`usage_events.rp`, `quota_profile_plans.monthly_rp`); the card divides by
`rp_per_credit` from the profile that judges the month and shows two decimals.
No float reaches storage, and the ratio is a column rather than a constant so a
later profile can re-denominate credits without a code change.

The profile that judges a month is the one `workspace_quota_binding` pinned for
that workspace and month — `resolveWorkspaceMonthlyQuota`, over
`resolveWorkspaceQuotaProfile`. A workspace already metering keeps the version
its month opened under, even after a newer one is published (that version shows
as current only for workspaces with no binding); a workspace with no binding for
the month reads the version in force now, so a newly created workspace adopts
the latest at its first review. The card names the judging profile, never "the
profile current at render time".

At or past the ceiling (`usedRp >= monthlyRp`) the used/limit pair stays — the
measurement is never hidden — and one banner states the consequence and the
reset: the next review is refused, a review that already started still finishes,
and an operator moving the workspace to a larger plan restores it sooner. The
enqueue's own comparison is `used + cost > monthlyRp`; because a charged review
costs at least 1 RP it refuses exactly the months the card banners, plus the ones
one review would tip over. `self-hosted` resolves no ceiling and renders no
credit block at all.

The block's "where it went" rows split the month's spend into the shared bot's and
the workspace's own Apps', each rendered on the same credit scale as the pair
above (the same `rp_per_credit` division, so no second unit appears).
`usage_events.source` records which one paid, written
in the same statement that records the price (migration
`0065_usage_events_source.sql`) — the price alone is not invertible, because
`rp = ceil(base × multiplier)` and each bot chooses its own multiplier. Rows written
before that column exist have a NULL source: they count in the month's total and
in **neither** split, so the split may total less than the overall figure. That
is the honest reading and nothing is attributed by default.

The operator's create form must show an impact preview before publishing: the
number of live `saas` workspaces with no binding for the current month whose
month's RP has already reached the candidate ceiling for their plan. It is a
**tightness check, not an eviction forecast** — a bound workspace keeps its
month's version and meets the candidate at its next month's first metering, and
every month the candidate judges starts at 0 RP. The count comes from the same month sum the
enqueue reads (`readMonthlyRp`, which `sumMonthlyRp` also answers from) and the
same predicate (`quotaSpent`), so at equal usage it cannot disagree with a
refusal — with one deliberate difference: the preview passes no cost, so it
answers "would even the cheapest review (1 RP) be refused?", while the enqueue
passes the review's own cost and can refuse a workspace the preview does not
count yet. That gap is exactly one review wide and it closes as usage grows; the
preview is a tightness check, not a per-review oracle. It can and will also
differ a month later, because usage moves. A publish echoes the preview it was shown and is
refused without one, or when the numbers moved since — a stale count is worse
than none.

Decision history: [shared bot scope and claiming](../../../.agents/adr/implemented/feature/2026-11-15-shared-bot-scope-and-claiming.md), [retire the install claim](../../../.agents/adr/implemented/feature/2026-11-20-retire-install-claim.md), [derived Blocked and park](../../../.agents/adr/implemented/feature/2026-11-15-derived-blocked-and-park.md).
