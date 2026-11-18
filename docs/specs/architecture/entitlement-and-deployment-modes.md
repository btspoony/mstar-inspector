# Architecture: entitlement and deployment modes

## Scope

Plan catalogue, nullable seat limits, membership-based free slots, and SaaS/self-hosted boundaries.

## Current state
### 1. Plan catalogue

`plans` has eight columns: `id`, `name`, `monthly_price_cents`,
`included_members`, `extra_member_price_cents`, `apps_per_workspace`,
`created_at` and `shared_bot_allowed`. This is the schema from
`0032_unlimited_plan.sql` after `0061_plan_shared_bot_allowed.sql` adds the
capability and `0063_quota_profiles.sql` drops the two consumption columns.
Entitlement decisions read three limit/capability columns: `included_members`,
`apps_per_workspace` and `shared_bot_allowed`.

NULL on a nullable limit means unlimited: for example, the `unlimited` row's
`included_members` and `apps_per_workspace` are NULL. Migration
`0032_unlimited_plan.sql` makes `included_members` nullable before inserting
that row. Migration `0063_quota_profiles.sql` drops `platform_key_limit` and
`reviews_included`; monthly consumption ceilings instead live in
`quota_profile_plans.monthly_rp`, where a present NULL is unlimited and an
absent plan row is a configuration error.

| id | included_members | apps_per_workspace | shared_bot_allowed | meaning |
|----|------------------|--------------------|--------------------|---------|
| `free` | 5 | 1 | 0 | SaaS default for a newly created workspace |
| `pro` | 5 | 10 | 1 | SaaS sellable tier; seeded limits |
| `unlimited` | NULL | NULL | 1 | no seat or App cap; assigned to every self-hosted workspace |

`shared_bot_allowed` (migration `0061_plan_shared_bot_allowed.sql`) is a
capability, not a quota: the column is `NOT NULL DEFAULT 0`, so NULL is never
another spelling of unlimited, and the default is what keeps every plan added
later closed until someone says otherwise.

`unlimited` is added as a catalogue row plus a code constant. It is not a
sentinel: no code may treat `-1`, `0` or `Infinity` as "unlimited".

Operator Admin changes a **workspace's** `plan_id`; it does not
edit `plans` rows.

### 2. Resolution rules

`resolveWorkspacePlan(db, workspaceId, mode)` returns:

1. `unlimited` when `mode === "self-hosted"` — before any DB read.
2. else the active subscription's plan.
3. else the seeded `free` row (throwing when that row is absent, as today).

`PlanLimits.includedMembers` is `number | null`:

- `null` → no seat cap. The `member-slot` verdict is always `ok`.
- `number` → existing rule: members + live pending invites `< limit`.

`PlanLimits.sharedBotAllowed` is the resolved shared-bot capability (a boolean;
§5). It rides the same three read points as the seat limit — the subscription
`SELECT`, the seeded-`free` `SELECT` and the `self-hosted` constant — so the
mode and the plan cannot disagree about it.

Every seat-cap enforcement point must accept `null`, not just the UI:

- route fast-fail before an invite (`src/dashboard/index.ts`)
- write-time `SEAT_GUARD_SQL` insert in `createInvite` — guard text
  `src/dashboard/invite-store.ts`
- invite-acceptance path

The write-time guard is the trap: `SEAT_GUARD_SQL` compares against the named
`:limit` bind (`createInvite`, via `bindNamed`), and SQL `count < NULL` evaluates to
NULL — the insert would write no row and mint a spurious refusal. A null
limit therefore short-circuits BEFORE the bind: when
`includedMembers === null` the insert runs without the seat condition; the
numeric path's SQL text is unchanged.

The refusal functions in `src/dashboard/entitlement.ts` name
the plan's actual limit; for an unlimited plan the refusal is unreachable and
must not be produced.

### 3. Free-workspace slot (unchanged rule)

One free workspace per login, counted across **membership** — being invited into
someone else's free workspace consumes your slot. The rule's shape and its two
guards are unchanged where the rule applies (`saas`):

- create: `FREE_SLOT_GUARD_SQL` + `countFreeMembershipsForLogin`
- accept: `ACCEPT_FREE_SLOT_GUARD_SQL` (`src/dashboard/invite-store.ts`)

Both already treat "plan id that is not `free`" as paid, so `unlimited` members do
not consume a slot. This must stay true after the unlimited tier is used: the guards
compare against `FREE_PLAN_ID` explicitly, never against a list of non-free ids.

Enforcement domain: the free-slot rule binds
`saas` only. Both guards are row-based SQL baked into write batches and never
see the resolver, while `self-hosted` keeps writing `active free` rows — so
`createWorkspace` and `acceptInvite` receive the mode and the guard condition
is inert in `self-hosted` (§4's "always allowed"). Normative rule: a membership
consumes a free slot only when its workspace RESOLVES to `free` — in `saas`
that is exactly today's row-based predicate (an admin-assigned `unlimited`
row is already treated as paid); in `self-hosted` nothing resolves to `free`,
so both guards are inert and the `saas` SQL texts stay byte-identical.

New workspaces are always created on `free` in SaaS mode. Upgrade happens only
through Operator Admin.

### 4. Deployment modes

`DEPLOYMENT_MODE` (`src/worker/env.ts`) is the only mode
switch. Invalid or unset values throw — do not add a default.

| Surface | `saas` | `self-hosted` |
|---------|--------|---------------|
| Member page plan card | shown | not rendered |
| Seat cap | plan-driven | unlimited (all workspaces `unlimited`) |
| Invite refusal for seat cap | possible | unreachable |
| "New workspace" menu item | disabled at the free-slot cap, or when the `workspace_creation_open` flag is off ([operator admin](operator-admin-surface.md), server flags); the reason under the label names which | always allowed |
| Operator Admin (menu + routes) | present for a listed operator | absent; routes not registered |
| `GET /api/members` `plan` field | present | still present in the payload (single data model), never rendered |

Rationale for keeping the payload field: the same endpoint and the same
`WorkspaceSummary` shape serve both modes; branching the wire shape would double
the contract for zero user-visible gain. The mode decides rendering, not the
data model.

Self-hosted resolves `unlimited` **at read time**; no data backfill is written and
no subscription row is rewritten. The resolution order is the one in §2 (mode
first, before any DB read) — §4 adds only why that ordering is load-bearing:

Step 1 must come first because every workspace created today already carries an
`active free` subscription row (`src/dashboard/workspace-store.ts`). Conditioning
`unlimited` on "no active subscription" would leave all existing self-hosted
workspaces capped at five — the exact requirement failure this rule exists to
avoid.

Mode-switch behavior:

- No migration mutates subscription rows. A SQL migration cannot read
  `DEPLOYMENT_MODE`, and a shared backfill would silently grant unlimited seats to
  SaaS workspaces that currently resolve to the implicit `free` default.
- The stored rows stay truthful to what was last assigned in SaaS; switching a
  deployment from `self-hosted` back to `saas` restores each workspace's own row
  (usually `free`) instead of leaving it upgraded.
- Self-hosted cannot change a plan through Admin (the admin surface is absent in
  that mode), so mode and row never disagree in a way a user could edit.
- Switching a deployment from `self-hosted` back to `saas` also re-activates
  the free-slot guards against the stored rows (§3): a login holding several
  free-row workspaces created while self-hosted must drop to one before
  creating another. The rows stay truthful; the guards key on them again.

### 5. Shared-bot capability

A workspace may attach a review target to a bot the platform shares only when
its resolved plan includes that bot. `checkEntitlement({kind: "shared-bot", …})`
in `src/dashboard/entitlement.ts` answers it, as the `shared-bot` branch of the
one function every plan verdict comes from: `ok: true` = allowed, `ok: false`
with a refusal carrying the resolved plan id = refused. `assertSharedBotAllowed`
survives only as that branch's internal body, so it has no caller outside the
module. Exactly two surfaces ask the question, and neither re-derives the rule:

- creating a target on a shared bot (`targetsStore.createOnSharedBot`), which
  decides before writing anything, so a refusal leaves no target and no audit
  row, and answers the plan-named `400` body;
- enqueueing a review for a target on a shared bot: the webhook route decides
  ONCE, before the enqueue, from the TARGET's workspace (the bot's workspace is
  another fact). `handleReviewJob` then takes no KV claim and writes no comment
  claim, still attaches the Check, and the route chains that Check's `neutral`
  settlement onto the attach (the webhook may have stopped waiting for it),
  records one terminal `entitlement` failure row, and sends nothing.

The gate reads the bot's scope first: only a bot the platform SHARES consults
the plan. A workspace's own bot never does — a Free workspace keeps reviewing
with its own App exactly as before, and the `own` branch mints `ok` without
looking at the capability column.

`self-hosted` answers before any read: `resolveWorkspacePlans` returns the
unlimited constant, so that mode never touches the column. Every other mode
reads the plan on each attempt, so an Operator Admin plan change — in either
direction — applies to the next attempt with no restart and no cache.

Deploy order is migration first, then the Worker
(`migrations/0061_plan_shared_bot_allowed.sql` before the code that reads it).
A Worker that lands first reads a column that does not exist and every plan read
throws — fail-closed, but a 500 on the webhook and dashboard faces rather than
the refusal this gate exists to give.

The creation check is the early, human-facing refusal; the enqueue check is what
makes the rule durable. A target created before the rule existed, a workspace
moved to a plan without the capability, and a bot unshared after the fact are
all closed on the next delivery. The capability's other inputs can change after
creation (`plans.shared_bot_allowed`, `review_bots.scope`, the workspace's
plan); a target's `bot_id` cannot — it is written once by an INSERT
([repository target model](../feature/repository-target-model.md) § Invariants), so the next
writer of that column must consult this same function rather than add a second
guard.

The usage card's shared-bot status row reads the capability through the same
resolution: `resolveWorkspacePlan` answers `sharedBotAllowed`, and
`sharedBotAvailability` turns that answer plus "does any live `shared` bot
exist" into one of three states. `available` = the plan grants the capability
and a `shared` bot is designated. `not-in-plan` = the resolved plan excludes it,
so the reader can still act: use an own App, or move plans. `not-designated` =
the capability is granted but no operator has shared a bot yet, so the reader
waits for a platform operator and has nothing to buy. The two unavailable
states never share copy because they differ in who can fix them. A plan change
or a designation therefore moves the card on the next read with no cache,
exactly as both move `checkEntitlement`'s `shared-bot` branch; `self-hosted` renders no
shared-bot row at all, because the console that designates one is not
registered in that mode — the absence is a property of the deployment, not a
fourth state of the workspace.

`entitlement` stays outside both `ATTRIBUTION_EXCLUDED_STAGES` and
`PAGING_EXCLUDED_STAGES`: its rows remain visible on the dashboard and count
toward the global infrastructure alert. `quota` stays visible too, but joins
only the paging exclusion set: one tenant's exhausted month is not a platform
incident. The sweep reads one grouped statement over the trailing 24 hours;
the returned stage counts supply both the infrastructure total and its
breakdown, so they describe the same read. Paging requires counted failures
strictly greater than `SWEEP_FAILURE_THRESHOLD`, derived in `src/worker/sweep.ts`
as `QUEUE_MAX_ATTEMPTS + 1` from `src/store/failure-store.ts`.

## RP metering and the monthly ceiling

Every started review records an integer RP cost on its `usage_events` row
(`usage_events.rp`, migration `0064_usage_events_rp.sql`), written in the SAME
statement that mints the row's `seq` so the attempt ordinal and its charge can
never disagree.

- **The price.** `rp = base(strength) × source(multiplier)`, read from the
  resolved quota profile: `base` ∈ 1/2/6 RP for Quick/Standard/Deep and
  `source` ∈ 1/10 for BYOK and the shared bot. BYOK is metered, never exempt
  (D7) — there is no second "own bot" allowance. `1 Credit = 20 RP` is the
  profile's `rp_per_credit`, so the display ratio is configuration, not code.
- **Both inputs are already on the path.** The strength is the target's
  `review_level` (`parseTargetReviewLevel`, falling back to the operator
  default only when the row states none — the same read the pipeline makes);
  the source is the bot's `scope` on the row the gate already holds. The value
  is computed twice from the one pure function (once for the enqueue verdict,
  once at the metering write) and never carried on the queue message, so the
  charge always describes what actually ran.
- **The month.** The ceiling compares against `SUM(rp)` over the UTC calendar
  month of `usage_events.occurred_at`, in a half-open window from `quotaMonth`.
  The ceiling itself comes from the profile covering that month's **first
  day** (D5), so a profile published mid-month starts judging on the next 1st
  and cannot evict a workspace mid-month. `null` is unlimited.
- **`0` is the pre-metering sentinel.** `rpFor` is `>= 1` by construction
  (every profile factor is `> 0` by DDL CHECK), so no metered row can hold 0:
  rows written before this iteration default to 0 and contribute nothing to any
  ceiling, and the column stays non-nullable with no `COALESCE` at the read.
- **Whose month it is.** The ledger row is charged to the TARGET's workspace
  (`review_targets.workspace_id`) — the tenant that asked for the review — which
  is also the workspace the enqueue's ceiling check reads. It is deliberately
  NOT the bot's owning workspace: for an OWNED bot the two are equal, but a
  shared bot belongs to the platform's workspace while `createOnSharedBot`
  writes only the target into the tenant's, so charging the bot's owner would
  bill one workspace for every tenant's spend and leave each tenant's own month
  at zero. The bot's workspace stays the CONCURRENCY key, which is a bot-scoped
  fact and unrelated to who pays.
- **The refusal.** A workspace whose month has reached its ceiling is refused
  AT ENQUEUE, in the shared-bot gate's shape: the Check is still attached and
  settles `neutral`, one terminal failure row is recorded under the `quota`
  stage (`QUOTA_STAGE`, in `PAGING_EXCLUDED_STAGES` but not
  `ATTRIBUTION_EXCLUDED_STAGES` — visible on the dashboard, excluded from
  infrastructure paging), and nothing is sent, claimed or started.
  The comparison is `used + cost > limit` (`quotaSpent`),
  so a review whose cost exactly fills the remaining headroom is admitted and
  everything above it is refused — and a month already AT its ceiling refuses
  every review, because the cheapest one costs 1 RP.
- **Order: capability first, then quota.** One delivery carries at most one
  refusal, so the two gates cannot both fire. The capability is a property of
  the plan (only the plan or the bot changes it) while quota is consumption
  against that plan; a workspace that may not use the shared bot is told that,
  because a quota message would send it looking for a top-up it cannot buy in
  this repository (D9). Quota is evaluated only in the branch the capability
  admitted, which also keeps the cheap refusal cheap.
- **A gate that cannot answer refuses, and says so.** Any fault in the enqueue
  decision — a store error, an empty `quota_profiles`, or a plan with no ceiling
  row in the judging profile — is a REFUSAL, not a failed request: the delivery
  is skipped on the `entitlement` stage with the
  `ENTITLEMENT_UNREADABLE_SKIP_REASON` sentence, the route still answers 200,
  and one structured warn carries the cause. The third case is the only one an
  operator can cause and cannot see on the affected surface, so
  `GET /_internal_admin/api/quota-versions` reports `uncoveredPlanIds` — the
  plan ids the JUDGING version states no ceiling for — and the console's quota
  versions page renders it as a notice naming the plans. **Publishing a version
  that covers the plan is the only repair**: no setting, no per-workspace
  override and no mode check adds the missing `quota_profile_plans` row, and
  until one is published every delivery of a workspace on that plan is refused
  with that recorded stage. A gap in a version that does not judge this month
  refuses nothing and is therefore not reported.
- **Metering never refuses.** The consume-time charge is inside the same error
  boundary as its insert: when the profile cannot be read there, the review
  still runs to completion (no retry, no DLQ) and one `usage` failure row
  records the attempt's token, the charged workspace and the source, so the lost
  charge is reconcilable. This is the module's own rule — count, never refuse —
  and it matters most on `self-hosted`, where no enqueue gate exists to have
  caught the fault first.
- **`self-hosted` meters, but never refuses for quota.** Started reviews use
  the same profile pricing and `usage_events` write as SaaS, including the
  charge-time `source` (`byok` or `shared`, migration
  `0065_usage_events_source.sql`). Metering faults follow the non-blocking
  boundary above. Separately, the mode resolves the unlimited plan constant
  before any plan read and skips the enqueue quota branch entirely; no monthly
  ceiling is consulted to admit a self-hosted review.

`apps_per_workspace` (a plan capability, not consumption) is enforced at App
creation only: `free` 1, `pro` 10, NULL = no cap. A pre-check gives an early
refusal; the authoritative guard is inside the App insert, counting live bots
of the workspace (`bot_workspaces` joined live `review_bots`, so a soft-deleted
App frees its slot). The ownership insert is conditional on that App existing
in the same batch, so concurrent cap refusals leave neither row and retain the
existing `app_cap_reached` outcome. Both manifest handlers in
`src/dashboard/index.ts` map that outcome to an HTTP 409 HTML error page.
`self-hosted` never reads the limit — the mode resolves the unlimited constant
before its first read.

## Invariants

- Free slots count memberships, not ownership.
- `usage_events.rp` is the ceiling's input: the ledger is metering AND the
  evidence the next enqueue is judged on. A row's `rp` is written by the same
  statement as its `seq`, and 0 marks a row that predates the column.
- Workspace soft deletion and `PLATFORM_OPERATORS` / `isPlatformOperator` parsing are unchanged.
- Unlimited means `null`, never a numeric sentinel.
- Every plan verdict is minted by `checkEntitlement` in
  `src/dashboard/entitlement.ts`; `memberSlotAvailable`, `freeSlotAvailable` and
  `assertSharedBotAllowed` are its internals and have no caller outside that
  module. A second decision spelling in a route, a store or the SPA is a defect.
  `resolveWorkspacePlan` keeps its display and audit readers (switcher label,
  members plan card, usage card, operator audit detail) — the invariant is one
  decision site, not one caller.

## Where it lives

- `src/dashboard/entitlement.ts`: `checkEntitlement` (the one decision: `member-slot`, `free-workspace-slot`, `shared-bot`, `app-count`, `review-quota`), `resolveWorkspacePlan`, `resolveWorkspacePlans`, `sharedBotAvailability`.
- `src/dashboard/review-usage-store.ts`: `readReviewUsage` (the counts the usage card and the console's usage page read).
- `src/dashboard/targets-store.ts`: `createOnSharedBot` (the creation refusal).
- `src/worker/index.ts` + `src/worker/handlers.ts`: the enqueue refusal (`deliveryOutcomeFromWebhook`, `handleReviewJob`, `DeliveryRefusal`).
- `src/dashboard/invite-store.ts`: `createInvite`, `acceptInvite`, seat/free-slot SQL guards.
- `src/dashboard/workspace-store.ts`: `createWorkspace` and subscription writes.
- `src/dashboard/index.ts`: members/invite routes and plan rendering.
- `src/worker/env.ts`: `deploymentModeOf`.
- `src/store/usage-store.ts`: `recordUsageEvent` (the one statement that mints `seq` and writes `rp`), `sumMonthlyRp` (the ceiling's read).
- `src/store/quota-store.ts`: `resolveQuotaProfile`, `resolveMonthlyQuota`, `rpFor`, `quotaMonth`.
- `migrations/0031_plans_usage.sql`, `migrations/0032_unlimited_plan.sql`, `migrations/0061_plan_shared_bot_allowed.sql`: catalogue, nullable column, capability.
- `migrations/0063_quota_profiles.sql`, `migrations/0064_usage_events_rp.sql`: the profile tables, the `apps_per_workspace` seed, and the metered ledger column.
- `migrations/0065_usage_events_source.sql`: the charge-time source; older NULL sources remain unattributed in the monthly split.
- `src/dashboard/apps-store.ts`: `createApp` write-time App cap and conditional ownership insert.
- `src/contracts/failure-stages.ts` + `src/worker/sweep.ts`: separate dashboard/paging exclusions and the grouped infrastructure failure read.

## Change obligations

Update this page with any catalogue, resolution, guard, wire or mode-rendering change. Numeric guard SQL must retain its semantics; every nullable-limit consumer and its tests must change together.
