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

A second enqueue refusal sits beside it: a workspace whose month has reached its
plan's RP ceiling
([entitlement](../architecture/entitlement-and-deployment-modes.md) § RP metering
and the monthly ceiling). It has the SAME shape and sends nothing — the attached
Check settles `neutral` and one terminal failure is recorded — but under its own
`quota` stage, because the cause is consumption rather than capability. The two
are ordered capability first and can never both fire on one delivery: one
verdict per delivery, recorded once.

## Invariants

- `shared` is platform-authorized and batch-verified against the current designation.
- The bind's ownership proof is the request token; a losing consume mutates nothing.
- A `GET` never writes: the bind needs the explicit confirm `POST`, so a mailed or prefetched `installation_id` cannot attach anything.
- A wrong bind is repairable: an operator clears the binding without touching the installation row.
- The webhook writes installations and deliveries, never target bindings.
- A removed installation or a shared bot without a binding resolves to nothing; silently falling back would re-attribute a review.

## Where it lives

- `migrations/0058_review_bot_scope.sql`, `migrations/0059_install_claims.sql`
- `migrations/0062_review_usage_indexes.sql` (the usage read's composite indexes)
- `src/dashboard/runtime-config-store.ts` (key + domain registry), `src/dashboard/apps-store.ts` (`setBotScope`, `listBotScopes`, `getInstallation`)
- `src/dashboard/install-claims-store.ts`, `src/worker/install-setup.ts`
- `src/dashboard/targets-store.ts` (`resolve` guards), `src/admin/index.ts` (`POST /api/targets/:targetId/unbind`, `GET /api/usage`)
- `src/dashboard/review-usage-store.ts` (`readReviewUsage`, `reviewUsageMonth`), `src/dashboard/index.ts` (`GET /dashboard/<ref>/api/settings/review-usage`)
- `src/spa/pages/ReviewUsageCard.tsx`, `src/spa/admin/UsagePage.tsx`
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

Every bot-scoped write route — settings operations, key deletion, provider-key verification (`keys/verify`, both the builtin and the custom/declared path), disable/enable and delete — refuses a `shared` bot before parsing, probing or persisting, with zero outbound calls and no storage change. `refresh-metadata` and `keys/usage` are not configuration writes but must still authorize the bot. The predicate is `canWriteBotScope` (`src/dashboard/index.ts`), which requires the bot to be `owned` **and** the caller's workspace to be the bot's owning workspace.

Two surfaces carry the two halves of a bot's configuration, and only one of them is refused here:

- The bot page `/dashboard/<workspaceRef>/apps/:appId/bot` (`BotSettingsPage.tsx`) is bot-owned configuration only — credentials health, provider keys, model chains, seats, sandbox image and installations.
- The target's review policy — trigger mode, depth, Check gate, owner allowlist, pause and park — is **target** data, written on the target surface, `/dashboard/<workspaceRef>/targets/:appId` (`TargetDetailPage` in `src/spa/pages/TargetsPage.tsx`, which renders `SettingsView` from `src/spa/pages/SettingsPage.tsx`). The app detail's former settings tab is gone: `…/apps/:appId/settings` and its `?tab=settings` spelling both redirect there (`settingsTabRedirect`, `src/spa/routes.ts`). It is governed by the target's workspace role, not by `canWriteBotScope`.

A consumer workspace may therefore still change its own target policy; only the bot-scoped writes above are refused for a `shared` bot.

### Execution ledgers

`review_findings` and `review_failures` carry `target_id`, backfilled from their pull-request row and guarded three ways: a row with no resolvable target aborts the migration, a row with several candidate targets aborts it, and only an exactly-one candidate is attributed. Tenant reads bind `target_id` directly; the bot-keyed pull-request join is no longer load-bearing. `audit_events.target_id` is nullable so a park audit can name its target.

A row's `target_id` is set when it is first recorded and never rewritten; rebinding an installation moves future publications, not history.

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
| Soft deletion | `workspaces.deleted_at` filters the row (a retired tenant has no face). `review_targets.deleted_at` and `review_bots.deleted_at` do **not**: the count is what happened, and a parked target keeps its month. |
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
attempts, and the credit block says credits with the RP detail beside it.

Counters are not unified, and no report may substitute one for another: a
workspace at its ceiling is refused by the credits (the RP ceiling), not by the
published-review count.

#### The credit block

Credits are **presentation over integer RP**. Every stored and compared value is
RP (`usage_events.rp`, `quota_profile_plans.monthly_rp`); the card divides by
`rp_per_credit` from the profile that judges the month and shows two decimals.
No float reaches storage, and the ratio is a column rather than a constant so a
later profile can re-denominate credits without a code change.

The profile that judges a month is the one covering that month's **1st** (D5):
`resolveQuotaProfile(db, quotaMonth(now).startIso)`. A profile published
mid-month therefore never judges the month it was published in — it shows as
scheduled and starts judging at the next 1st, which is what keeps a price change
from pushing a workspace over mid-month. The card names the judging profile,
never "the profile current at render time".

At or past the ceiling (`usedRp >= monthlyRp`) the used/limit pair stays — the
measurement is never hidden — and one banner states the consequence and the
reset: the next review is refused, a review that already started still finishes,
and an operator moving the workspace to a larger plan restores it sooner. The
enqueue's own comparison is `used + cost > monthlyRp`; because a charged review
costs at least 1 RP it refuses exactly the months the card banners, plus the ones
one review would tip over. `self-hosted` resolves no ceiling and renders no
credit block at all.

The block's "where it went" rows split the month's RP into the shared bot's and
the workspace's own Apps'. `usage_events.source` records which one paid, written
in the same statement that records the price (migration
`0065_usage_events_source.sql`) — the price alone is not invertible, because
`rp = base × source` and a profile chooses its own multipliers. Rows written
before that column exist have a NULL source: they count in the month's total and
in **neither** split, so the split may total less than the overall figure. That
is the honest reading and nothing is attributed by default.

The operator's create form must show an impact preview before publishing: the
number of live `saas` workspaces whose current month's RP has already reached the
candidate ceiling for their plan. It is a **tightness check, not an eviction
forecast** — under D5 the candidate cannot judge the current month, and every
month it does judge starts at 0 RP. The count comes from the same month sum the
enqueue reads (`readMonthlyRp`, which `sumMonthlyRp` also answers from), so it
cannot disagree with a refusal at equal usage; it can and will differ a month
later, because usage moves. A publish echoes the preview it was shown and is
refused without one, or when the numbers moved since — a stale count is worse
than none.

### Parking an overlapping target

`POST /dashboard/<workspaceRef>/apps/:appId/park` (`appParkRoute`, the `APP_ROUTES` entry `{ method: "post", path: "/apps/:appId/park" }` mounted under `/:workspaceRef`; owner or admin of the target's workspace) writes in one batch: one `target.park` audit row, `review_enabled = 0`, and `account_login = NULL`. It refuses `no-overlap` (no other live target in the workspace carries the same `account_login`), `only-live-target` (parking would leave that owner in this workspace with no live target), and a target outside the caller's workspace, all with zero writes. It never sets `deleted_at`, so the rows stay visible. Park is a form action, never a page: the path carries no `/api` segment.

Decision history: [shared bot scope and claiming](../../../.agents/adr/implemented/feature/2026-11-15-shared-bot-scope-and-claiming.md), [derived Blocked and park](../../../.agents/adr/implemented/feature/2026-11-15-derived-blocked-and-park.md).
