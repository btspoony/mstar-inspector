# Architecture: entitlement and deployment modes

## Scope

Plan catalogue, nullable seat limits, membership-based free slots, and SaaS/self-hosted boundaries.

## Current state
### 1. Plan catalogue

`plans` rows are the only plan definitions. Code reads two columns:
`included_members` and the boolean `shared_bot_allowed`. NULL on a quota column
means unlimited (migration `0031_plans_usage.sql` header, lines 4-11, which
names `platform_key_limit`, `reviews_included` and `apps_per_workspace`).
Migration `0032_unlimited_plan.sql` extends that contract to
`included_members`: the original column is `INTEGER NOT NULL`
(`0031_plans_usage.sql:56`), so `0032_unlimited_plan.sql` relaxes it to nullable
first (SQLite table rebuild under `PRAGMA defer_foreign_keys`; the seeded rows
and the `workspace_subscriptions` FK are preserved) and then inserts the
`unlimited` row.

| id | included_members | shared_bot_allowed | meaning |
|----|------------------|--------------------|---------|
| `free` | 5 | 0 | SaaS default for a newly created workspace |
| `pro` | 5 | 1 | SaaS sellable tier; seeded seat count |
| `unlimited` | NULL | 1 | no seat cap; assigned to every self-hosted workspace |

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

- `null` → no seat cap. `memberSlotAvailable` returns true unconditionally.
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
its resolved plan includes that bot. `assertSharedBotAllowed(db, workspaceId,
mode)` in `src/dashboard/entitlement.ts` is THE decision: `null` = allowed, a
typed refusal carrying the resolved plan id = refused. Exactly two call sites
consult it, and neither re-derives the rule:

- creating a target on a shared bot (`targetsStore.createOnSharedBot`), which
  decides before writing anything, so a refusal leaves no target and no audit
  row, and answers the plan-named `400` body;
- enqueueing a review for a target on a shared bot: the webhook route decides
  ONCE, before the enqueue, from the TARGET's workspace (the bot's workspace is
  another fact). `handleReviewJob` then takes no KV claim and writes no comment
  claim, still attaches the Check, settles it `neutral` through
  `CheckLifecycle.settleSkipped`, records one terminal `entitlement` failure
  row, and sends nothing.

`self-hosted` answers before any read: `resolveWorkspacePlans` returns the
unlimited constant, so that mode never touches the column. Every other mode
reads the plan on each attempt, so an Operator Admin plan change — in either
direction — applies to the next attempt with no restart and no cache.

The creation check is the early, human-facing refusal; the enqueue check is what
makes the rule durable. A target created before the rule existed, a workspace
moved to a plan without the capability, and a bot unshared after the fact are
all closed on the next delivery. The capability's other inputs can change after
creation (`plans.shared_bot_allowed`, `review_bots.scope`, the workspace's
plan); a target's `bot_id` cannot — it is written once by an INSERT
([review targets](../feature/review-targets.md) § Invariants), so the next
writer of that column must consult this same function rather than add a second
guard.

Operational consequence, known and accepted: `entitlement` joins the failure
vocabulary and deliberately stays OUTSIDE `PAGING_EXCLUDED_STAGES`, so the cron
sweep counts these rows and its global ops alert — more than
`SWEEP_FAILURE_THRESHOLD` (7) rows across ALL tenants in 24 h — can fire on the
8th refusal within a day for a workspace that simply left its plan. A
workspace-level condition is presented as a platform-wide one. That is the
intended trade (refusals must stay countable and listable on the dashboard);
the future lever is a separate alert-only exclusion list, never a change to
`PAGING_EXCLUDED_STAGES`, which would also hide the rows from the dashboard's
failure counts and PR history.

## Invariants

- Free slots count memberships, not ownership.
- `usage_events` is counts-only metering, not enforcement.
- Workspace soft deletion and `PLATFORM_OPERATORS` / `isPlatformOperator` parsing are unchanged.
- Unlimited means `null`, never a numeric sentinel.
- The shared-bot capability has exactly one decision function
  (`assertSharedBotAllowed`); a second spelling in a route, a store or the SPA
  is a defect.

## Where it lives

- `src/dashboard/entitlement.ts`: `resolveWorkspacePlan`, `resolveWorkspacePlans`, `memberSlotAvailable`, `assertSharedBotAllowed`.
- `src/dashboard/targets-store.ts`: `createOnSharedBot` (the creation refusal).
- `src/worker/index.ts` + `src/worker/handlers.ts`: the enqueue refusal (`deliveryOutcomeFromWebhook`, `handleReviewJob`).
- `src/dashboard/invite-store.ts`: `createInvite`, `acceptInvite`, seat/free-slot SQL guards.
- `src/dashboard/workspace-store.ts`: `createWorkspace` and subscription writes.
- `src/dashboard/index.ts`: members/invite routes and plan rendering.
- `src/worker/env.ts`: `deploymentModeOf`.
- `migrations/0031_plans_usage.sql`, `migrations/0032_unlimited_plan.sql`, `migrations/0061_plan_shared_bot_allowed.sql`: catalogue, nullable column, capability.

## Change obligations

Update this page with any catalogue, resolution, guard, wire or mode-rendering change. Numeric guard SQL must retain its semantics; every nullable-limit consumer and its tests must change together.
