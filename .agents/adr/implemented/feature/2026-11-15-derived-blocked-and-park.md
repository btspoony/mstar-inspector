# ADR: Derive Blocked from the bot row, and park without deleting

Status: implemented — retrospective: derived `blocked` and the target park route shipped with the shared-bot work; this record was filed after the fact.
Spec: docs/specs/feature/bot-scope-and-claiming.md § Derived Blocked state

## Problem

Two states needed a home, and neither could be a column.

A consumer's target on a bot whose share was revoked must stop reviewing and must say why, without deleting the rows that hold what was reviewed. Storing that state makes it a second source of truth: a re-share, an unshare, or an operator re-pointing the official workspace would each have to remember to update it, and the one path that forgot would leave a target telling its workspace it is blocked when the resolver would review again.

Separately, one workspace can hold two live targets whose `account_login` is the same account (two bots installed by one login). No automatic rule can say which target should stop; and the tempting repair — soft-delete the surplus — destroys a review record the workspace still owns.

## Decision

**Blocked is derived on every read.** `blockedReasonFor` (`src/dashboard/index.ts`) returns `bot_not_shared` exactly when the bot is `owned` and the target's workspace is not the bot's workspace. `BlockedReason` has that one member. There is no column and no projection: a re-share clears the state on the next read. Both detail payload faces carry `blocked` and, when true, `blocked_reason`; the page names the reason, hides the install/claim action and the bot-settings link, and still renders trigger, depth, gate and pause so the target remains readable.

**Park retires the claim, not the row.** `park` (`src/dashboard/targets-store.ts`) writes one batch — the `target.park` audit row, `review_enabled = 0`, and `account_login = NULL` — after the pre-read names a refusal. The park predicate `PARKABLE_TARGET` is repeated by both statements: a live target in the addressed workspace whose account another live target in that workspace also carries. Refusals write nothing:

- `no-overlap` — no other live target in the workspace carries the same `account_login`;
- `only-live-target` — parking would leave that login with no live target in this workspace;
- `unknown-target` — the target is not live in the caller's workspace (the route answers 404).

`park` never sets `deleted_at`, so the rows stay listed and the review history stays readable. The route is `POST /dashboard/<workspaceRef>/apps/:appId/park` — `appParkRoute`, registered as `APP_ROUTES` entry `{ method: "post", path: "/apps/:appId/park" }` and mounted `/:workspaceRef${route.path}` — a form action available to an owner or admin of the target's workspace; a support-granted platform operator reaches only `access: "read"` routes, so park answers 403 for one.

## Alternatives considered

- **A `blocked` column (or a projection table).** A second source of truth beside the bot row and the target's workspace; every writer of scope or designation would have to maintain it, and the resolver would still have to derive the truth to decide whether to review.
- **Hide the target instead of deriving.** A blocked target that vanishes from every list reads as a bug; the workspace can neither see why review stopped nor repair it by claiming an installation.
- **Block the delivery and say nothing in the UI.** The resolver already returns no target for this case, so the review genuinely stops — without the derived state the workspace has no way to learn that the cause is the bot's scope rather than its own configuration.
- **Soft-delete the parked target.** Destroys history the workspace owns, and makes parking indistinguishable from a user delete.
- **An automatic overlap repair (keep the newest / keep the oldest).** Which of two targets a workspace keeps reviewing is the owner's decision; `scripts/audit-owner-overlap.sql` reports the overlap read-only, and park is the explicit act.
- **Park by clearing the installation binding.** That is a different repair (operator-only unbind) and would orphan the installation row for the bot's owner; park changes only the target's own claim.

## Consequences

- `blocked` is computed per request — the cost is the bot row the read already joins, and the correctness is that no state can drift.
- `audit_events.target_id` is nullable so a park audit row can name its target; the audit insert runs first in the batch because it reads the `account_login` the update clears.
- A parked target keeps its policy, its reviews and its installation binding: re-claiming the login (or the operator unbinding it) is a separate act, and nothing about the park prevents it.
- Parking a target does not touch the bot or its other targets, so a workspace can park one duplicate and keep the other live — which is the only outcome the refusal vocabulary permits.
- The affordance and the write share one predicate (`hasOwnerOverlap` reads `PARKABLE_TARGET`), so a button that would be refused is not offered.
