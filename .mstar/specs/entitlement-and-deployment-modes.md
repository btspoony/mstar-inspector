# Entitlement and deployment modes (entitlement-and-deployment-modes)

> **Status:** FROZEN 2026-10-25 — promoted at iteration close from the iteration package, after architect review and a three-seat plan QC plus mandatory QA on the two plans that implement it.
> **SSOT:** This file — the plan catalogue, the nullable-limit contract, the free-slot rule and the deployment-mode split.
> **Authority:** Delivered 2026-10-25; the code paths named below are the implementation references.

## 1. Plan catalogue

`plans` rows are the only plan definitions. Code reads exactly one column today:
`included_members`. NULL on a quota column means unlimited (migration
`0031_plans_usage.sql` header, lines 4-11, which names `platform_key_limit`,
`reviews_included` and `apps_per_workspace`). Migration `0032` extends that
contract to `included_members`: the column is `INTEGER NOT NULL` today
(`0031_plans_usage.sql:56`), so `0032` relaxes it to nullable first (SQLite
table rebuild under `PRAGMA defer_foreign_keys`; the seeded rows and the
`workspace_subscriptions` FK are preserved) and then inserts the `unlimited`
row.

| id | included_members | meaning |
|----|------------------|---------|
| `free` | 5 | SaaS default for a newly created workspace |
| `pro` | 5 (unchanged this iteration) | SaaS sellable tier; seat count unchanged from its seeded value |
| `unlimited` | NULL | no seat cap; assigned to every self-hosted workspace |

`unlimited` is added as a catalogue row plus a code constant. It is not a
sentinel: no code may treat `-1`, `0` or `Infinity` as "unlimited".

Editing the catalogue itself (price, seat numbers of `free`/`pro`) is NOT part of
this iteration. Operator Admin changes a **workspace's** `plan_id`; it does not
edit `plans` rows.

## 2. Resolution rules

`resolveWorkspacePlan(db, workspaceId, mode)` returns:

1. `unlimited` when `mode === "self-hosted"` — before any DB read.
2. else the active subscription's plan.
3. else the seeded `free` row (throwing when that row is absent, as today).

`PlanLimits.includedMembers` becomes `number | null`:

- `null` → no seat cap. `memberSlotAvailable` returns true unconditionally.
- `number` → existing rule: members + live pending invites `< limit`.

Every seat-cap enforcement point must accept `null`, not just the UI:

- route fast-fail before an invite (`src/dashboard/index.ts:1780-1788`)
- write-time `SEAT_GUARD_SQL` insert in `createInvite` — guard text
  `src/dashboard/invite-store.ts:163-166`, the insert carrying it `:232-249`,
  refusal `:257`
- invite-acceptance path

The write-time guard is the trap: `SEAT_GUARD_SQL` binds the limit into the
insert as `?8` (`invite-store.ts:248`), and SQL `count < NULL` evaluates to
NULL — the insert would write no row and mint a spurious refusal. A null
limit therefore short-circuits BEFORE the bind: when
`includedMembers === null` the insert runs without the seat condition; the
numeric path's SQL text is unchanged.

The refusal copy currently hardcodes "five" (`entitlement.ts:104-105`). It becomes
the plan's actual limit; for an unlimited plan the refusal is unreachable and
must not be produced.

## 3. Free-workspace slot (unchanged rule)

One free workspace per login, counted across **membership** — being invited into
someone else's free workspace consumes your slot. The rule's shape and its two
guards are unchanged where the rule applies (`saas`):

- create: `FREE_SLOT_GUARD_SQL` + `countFreeMembershipsForLogin`
- accept: `ACCEPT_FREE_SLOT_GUARD_SQL` (`invite-store.ts:176-188`)

Both already treat "plan id that is not `free`" as paid, so `unlimited` members do
not consume a slot. This must stay true after the new tier is added: the guards
compare against `FREE_PLAN_ID` explicitly, never against a list of non-free ids.

Enforcement domain (architect decision, 2026-10-25): the free-slot rule binds
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

## 4. Deployment modes

`DEPLOYMENT_MODE` (`src/worker/env.ts:84`, resolver `:112-118`) is the only mode
switch. Invalid or unset values throw — do not add a default.

| Surface | `saas` | `self-hosted` |
|---------|--------|---------------|
| Member page plan card | shown | not rendered |
| Seat cap | plan-driven | unlimited (all workspaces `unlimited`) |
| Invite refusal for seat cap | possible | unreachable |
| "New workspace" menu item | disabled at the free-slot cap, or when the `workspace_creation_open` flag is off (`operator-admin-surface.md` §3.1); the reason under the label names which | always allowed |
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
`active free` subscription row (`workspace-store.ts:460-508`). Conditioning
`unlimited` on "no active subscription" would leave all existing self-hosted
workspaces capped at five — the exact requirement failure this rule exists to
avoid.

Consequences:

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

## 5. What must not change

- The free-slot rule's strictness (membership-based).
- `usage_events` metering: counts only, no enforcement.
- Soft-delete semantics for workspaces.
- `PLATFORM_OPERATORS` parsing and `isPlatformOperator`.
