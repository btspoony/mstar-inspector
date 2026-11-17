# Feature: operator data upgrade

## Scope

The operator-owned machinery for data migrations too large to run as a schema change: the maintenance window, the upgrade registry and its state machine, and the repository backfill item that gives historical targets their repository identity. It also fixes how this machinery couples to the ordinary schema migrations that ship beside it.

Ordinary schema migrations stay forward-only SQL files and are never upgrade items. The product-facing wording shown during the window is part of the repository surface page; this page fixes the technical contract. Out of scope: per-workspace maintenance, an ETA promise, and any user-visible surface of the upgrade state beyond the operator console.

## Current state

### Maintenance window

| ID | Contract |
|----|----------|
| M1 | The window is three rows in the platform parameter store: `platform.maintenance.enabled` (`'1'` \| `'0'`), `platform.maintenance.reason` (operator-set text) and `platform.maintenance.since` (ISO-8601 UTC). An absent `enabled` row is the documented default — the platform is open — and that default lives only in the read helper, never in a deploy-time constant. A read fault is NOT that default: the helper answers a third state, `unreadable: true` (with `enabled: false`), logs one `maintenance_read_failed` line, and every gate treats it as CLOSED, so a settings outage can never unlock traffic while the window is the only fence around the destructive backfill. |
| M2 | One helper reads the window in a single statement over the three keys, with absent rows reading as open and no cross-request cache. Each consumer reads once per unit of work: the dashboard middleware once per request (cached on the request context), the webhook once per delivery, the queue consumer once per invocation, each cron entry once per invocation. |
| M3 | A dashboard request while the window is open answers the maintenance page instead of its content: 维护中, the operator's reason, the start time, and the closing sentence that the upgrade resumes service when it finishes. No ETA is promised. |
| M4 | A workspace API request answers `503 { "maintenance": true, "reason": …, "since": … }`. A webhook delivery answers `503` so GitHub retries it: the user-facing claim is that a delivery made during the window is retried after recovery, not dropped. |
| M5 | The queue face defers instead of running: every message of the batch is retried 300 seconds out. When the runtime offers no delayed redelivery, or a message has exhausted the queue's attempt budget, the delivery is recorded as a `review_failures` row (`stage = maintenance_deferred`, the payload's target/installation/repository/PR identity, error prefixed `maintenance_window:`) and acked, so the sweep counts it and alerts; the invocation writes one `maintenance_defer` line naming the queue and the batch size. A deferral spends one delivery attempt, so the window must stay shorter than the queue's retry budget. |
| M6 | A cron invocation does not run its work while the window is open: it records a `maintenance_skip` line naming the cron expression and returns, so the next scheduled invocation runs. |
| M7 | Not gated: `/healthz` (liveness is not maintenance), the operator console and its API, `/bot/setup` (the short-lived install callback that writes claims only), and the two pre-session dashboard paths `/dashboard/login` and `/dashboard/oauth/callback`. `/dashboard/locale` and `/dashboard/logout` stay reachable for the same reason — a session-less language toggle and burning one's own cookie are not tenant reads. |
| M8 | The operator writes the window through the existing `PATCH /_internal_admin/api/runtime` route, which accepts exactly one of `concurrency`, `checkBudgets`, `commentClaim`, `reviewLevel`, `recheckAssignment`, `maintenance` per request; the `maintenance` body is `{ enabled, reason? }`. The store writes the three keys with one platform audit event in the same batch, and enabling stamps `since` with the request's instant. |
| M9 | The upgrade runner opens and closes the window through the same helper, so there is exactly one writer path and no second API. A window the runner opened and a window the operator opened are distinguishable in state (`maintenance_owned`), never by inspecting the reason text. |

### Upgrade registry and state machine

| ID | Contract |
|----|----------|
| U1 | An upgrade item is `{ id, title, requiresDowntime, order, preflight(db) → counts, runBatch(db, cursor) → ONE transaction, verify(db, { runStartedAt }) → read-only checks, advisoryChecks? }`. `preflight` and `verify` write nothing. A count named in `advisoryChecks` is reported and never fails the item. The registry is one ordered list; an unregistered id is the operator API's 404. |
| U2 | State lives in `operator_data_upgrades`: `id` (primary key), `status` (`pending` \| `running` \| `verifying` \| `completed` \| `failed`, enforced by CHECK), `cursor_json`, `processed`, `maintenance_owned` (0/1), `started_at` (the per-phase claim), `run_started_at` (when the current run began), `finished_at`, `last_error`, `log_json`. An absent row is `pending`: the item was never started. |
| U3 | The console reads `GET /_internal_admin/api/data-upgrades` — every registered item with its state and preflight counts, one state read for the whole list — and writes `POST /_internal_admin/api/data-upgrades/:id/preflight \| step \| verify \| reset`. These routes are operator-only. |
| U4 | `step` runs from `pending` or `running` and leaves the item `running`: the item's batch is one transaction (its statements commit or roll back together), then the progress write records the new cursor, the processed count and an appended log entry. A worker that dies between the two leaves the previous cursor, and the next step re-plans from it — safe because every item's worklist excludes finished work. An empty batch answers `done: true` and the item still stays `running` until an explicit verify. |
| U5 | A `requiresDowntime` item refuses `step` while the window is closed — except its first step from `pending`, which opens the window and records ownership. `maintenance_owned = 1` means the runner owns the window and may close it; `0` means the window belongs to the operator and the runner leaves it open. A refused step or verify answers `409` with the reason and the unchanged state, so the console can name why nothing ran. |
| U6 | `verify` runs from `running`, `verifying` or `failed` (a verify interrupted mid-flight is retryable), touches no migrated data — only the item's own state row — and settles the item: any non-zero blocking check makes it `failed` with `last_error` naming the failing checks, all blocking zero makes it `completed` with `finished_at`. It reads `run_started_at` and passes it to `verify` as `{ runStartedAt }`, so the item can date what this run touched. An advisory check is reported in `checks` and the ledger row and never fails the item. Only a successful verify closes a window the runner owns, and it flips `maintenance_owned` back to 0 so a later pass cannot re-close an operator window. |
| U7 | `reset` moves any state to `pending`, clears the cursor, the processed count and the timestamps, the last error and the ownership flag, and never undoes migrated rows — replay is a no-op pass because the worklist excludes finished work. It KEEPS `run_started_at`: that stamp is the item's lifetime boundary, not a per-attempt value, so rows retired by an earlier attempt of the same item still block verify while only deletions predating the item count as history. It closes a window the runner owned and leaves an operator-enabled window open. The batch log survives, as the only record of what earlier batches discarded. |
| U8 | Every mutating phase is single-flight per item. `step`, `verify` and `reset` each claim the row with one conditional upsert (`status` set plus a five-minute `started_at` lease); a caller that loses the claim is refused with `409 upgrade_running` and the unchanged state, never a second batch. The claim is cleared in the same statement set that writes the phase outcome, and a thrown phase releases it before rethrowing. Two operators, or two tabs, therefore cannot plan the same worklist and insert one target per repository each. |

### Repository backfill item (`repo-backfill`)

| ID | Contract |
|----|----------|
| B1 | The item is registered first (`order` 10) and requires downtime: a review that landed between a repoint and a soft delete would write against a target the batch just retired. |
| B2 | The worklist is the leftover shape — live targets whose `repo_id`, `repo_owner` and `repo_name` are all null — holding at least one `pull_requests` row, read in `id` order with the cursor `{ "last_target_id": string }`. The scan is bounded like the work: at most 20 worklist rows are read per step. |
| B3 | Group identity is `(bot_id, owner, repo)` with owner/repo compared case-insensitively, because the uniqueness claim and the resolver are bot-scoped: two bots reviewing the same repository own two targets, while one bot's two workspaces own ONE. A step moves at most 20 groups, deduped case-insensitively, and every `IN (…)` list is chunked at 40 values. |
| B4 | Members are read for the whole bot — across its workspaces, not only the current batch: the winner is the row with the newest `pull_requests.last_seen_at` for that repository, then the newest `reviews.reviewed_at`, then the lowest id. Losers' configuration is discarded and counted in the batch log; no user choice is ever surfaced. |
| B5 | A group's home is the bot's live target that already names that repository, in any of the bot's workspaces, when one exists — adopting it keeps one live target per repository. Otherwise one new live target is inserted in the D22 winner's workspace, copying that winner's configuration with inheritance off (`follow_workspace_defaults = 0`). |
| B6 | The new target carries the repository's owner/name and no `repo_id`: identity is owner/name after the split, and the numeric id arrives with the repository's first delivery. The item never fabricates an id. |
| B7 | `pull_requests`, `reviews`, `review_findings` and `review_failures` are repointed from every member of the group onto the home target, matched by `(target_id, owner, repo)` case-insensitively, whichever workspace the member sits in. Two members holding the same PR number cannot both survive: the later `last_seen_at` (then the lower id) keeps the row and the duplicates are deleted before the repoint, so the unique key is never violated. |
| B8 | Only the batch's own old rows are retired, and only after every group of the batch ran — one row may hold ledger rows for several repositories, so retiring it inside a group would hide it from the next group. A member whose repositories did not all fit stays live and is read again by the next step, and the cursor never advances past a row left live. A later row whose only repositories were planned by an earlier row's groups is retired by the same batch: the worklist finds a row by its `pull_requests` rows, so a row left live after they moved would never be scanned again. A row reads `done` only when the scan is short and nothing was left undrained. |
| B9 | A leftover row with no ledger rows is untouched except its inheritance flag (`follow_workspace_defaults = 0`), so its copied configuration keeps answering instead of the workspace's. It awaits its first delivery as a 待安装 row. |
| B10 | Preflight, with no writes: `unidentified_targets` (live rows of the leftover shape), `ledger_pairs` (the `(target, repository)` pairs a run moves), `conflicting_groups` (repositories covered by more than one live row) and `leftover_without_ledger` (rows of the leftover shape awaiting their first delivery). |
| B11 | Verify, read-only: `unidentified_targets_with_ledger` (a live row holding ledger rows but naming no repository) and `duplicate_repository_groups` (one bot naming the same repository twice among rows holding ledger rows, across its workspaces) must reach zero. Ledger rows still naming a retired target while a live target of the same bot already covers that repository are SPLIT by `run_started_at`: rows whose target was deleted at or after it are this run's crash residual and BLOCK (`unrepointed_ledger_rows` must reach zero); rows on a target deleted earlier are reported as the advisory `historical_rows` and never fail the item. With no `run_started_at` every such row is historical. |
| B12 | Replay is idempotent: the worklist predicate is the leftover shape, and every row a batch creates or adopts names its repository, so a second pass over finished work moves nothing. |

### Release-window coupling

| ID | Contract |
|----|----------|
| X1 | Migration `0068` installs the bot-level repository claim (`review_targets(bot_id, repo_id)` unique over live, identified rows). It is a schema migration, not an upgrade item: a live duplicate that predates it fails the deploy loudly instead of a winner being picked silently. |
| X2 | Migration `0069` creates `operator_data_upgrades` — the upgrade machinery's only new table. The maintenance keys need no migration: they live in the existing platform parameter store under its registered `platform.` domain. |
| X3 | Migration `0067` drops the allowlist and the installation binding, and no upgrade item exists for the allowlist: its rows are deleted with the table and migrate nowhere. The only historical data the upgrade machinery moves is repository identity and the ledger repointing. |
| X4 | The surface and the backfill ship in one release window and the backfill runs after it: until the item completes, historical rows stay 待安装 and are claimed by their first delivery, so no repository goes unreviewed while the operator decides when to run it. |

## AuthZ matrix

| Surface | workspace member / owner / admin | platform operator |
|---|---|---|
| `/dashboard/*` HTML, workspace API | 503 maintenance page / `503` JSON while the window is open (role cannot bypass it) | same |
| `/healthz` | 200 | 200 |
| `/bot/setup` | reachable (session required) | reachable |
| `/_internal_admin/*` console and API, including the upgrade routes | 404 | visible; the console shows state, preflight counts, the window reason and start time, the current item, progress, the last error and a stop control for the step loop |
| Webhook route, queue consumer, cron entries | no session; gated by the window (503 / defer / skip) | same |

## Invariants

- Idempotent replay: a second step over finished work processes nothing.
- A downtime item never steps while the window is closed; the runner closes only a window it opened.
- A run's start is stamped once by its first step and kept across reset — it is the item's lifetime boundary, so verify always dates the item's own retirements.
- Verify refuses `completed` on any non-zero blocking check; an advisory count is reported and never fails the item. Verify and preflight write nothing.
- Ledger rows are repointed or deleted, never orphaned, and no upgrade item rebuilds a parent table.
- `repo_id` stays null exactly for historical rows: the backfill does not invent an id, and the resolver or the backfill are its only two writers.

## Where it lives

- `src/dashboard/runtime-config-store.ts` (`getMaintenanceMode`, `setMaintenanceMode`, the `platform.maintenance.*` keys, the `platform.` domain registry)
- `src/admin/index.ts` (the runtime `maintenance` body, the data-upgrade routes), `src/admin/data-upgrades.ts` (registry, state machine), `src/admin/data-upgrades/repo-backfill.ts` (the item)
- `src/worker/index.ts` (webhook and cron gates), `src/dashboard/index.ts` (dashboard middleware gate), `src/pipeline/consumer.ts` (the queue's deferral)
- `src/spa/admin/DataUpgradePage.tsx`, `src/spa/admin/pages.ts`, `src/spa/admin/api.ts`, `src/i18n/en.ts`, `src/i18n/zh-CN.ts`
- `migrations/0069_operator_data_upgrades.sql`
- `tests/admin/data-upgrades.test.ts`, `tests/admin/repo-backfill.test.ts`, `tests/pipeline/consumer-maintenance.test.ts`

## Change obligations

A change to the maintenance keys, the gated or exempt surface list, the item interface, the state machine, the ownership rules or the merge rule updates this page in the same change. A new upgrade item is registered here when it ships, with its own worklist and verify contracts.
