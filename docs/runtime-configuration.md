# Runtime configuration inventory

Every non-secret parameter that changes review behaviour without a code change,
with the layer that owns it and the value an absent row (or NULL column) reads
as. Two rules hold across the whole inventory:

- **One layer per parameter.** A value is either a system row, a workspace
  column, an App column or deploy-time config. Nothing is configured twice, and
  no parameter is a Worker plain var.
- **The read is per decision point.** No KV, no request cache: a change applies
  to the next queue message (or the next request) without a redeploy. A
  present-but-untrusted value degrades to a conservative answer, never throws,
  and never silently becomes the default.

Deploy-time config is the one layer that needs a deploy; everything else is a
D1 row. `docs/deploy.md` documents the deployment procedure and the behaviour of
the review-related parameters; the tables here are the source list.

## System layer — `review_runtime_settings` (migration `0040`)

One row per overridden key; the row is `(key, value, updated_at, updated_by)`,
the value is TEXT and only `src/dashboard/runtime-config-store.ts` parses it.
Read and written by the platform operator through the console
(`/_internal_admin` → `GET` / `PATCH /_internal_admin/api/runtime`). One save
writes one parameter, and every accepted write lands with its
`platform_audit_events` row in the same D1 batch.

| Key | Absent-row default | Accepted values | Read by | Effect |
|---|---|---|---|---|
| `review.concurrency.system` | `256` | integer `1..256` | `getSystemConcurrency` / `getEffectiveConcurrency` (`src/dashboard/runtime-config-store.ts`, called from `src/pipeline/concurrency-reader.ts`) | Platform-wide admission quota; combined with the workspace cap as `min(system, workspace)` |
| `review.level.default` | `default` | `quick` \| `default` \| `deep` (`REVIEW_LEVELS`) | `readDefaultReviewLevel` (`src/pipeline/consumer.ts`, only when `github_apps.review_level` is NULL) | The review depth every App without its own choice inherits |
| `review.check.terminalize_timeout_ms` | `10000` | integer `1000..30000` | `getCheckBudgets` (`src/pipeline/consumer.ts` terminalize wait) | Bound on the inline terminalize hook |
| `review.check.update_timeout_ms` | `5000` | integer `500..15000` | `getCheckBudgets` (`src/pipeline/checks.ts`, `src/pipeline/comment.ts`, `src/worker/check-reconcile.ts`) | Bound on the one terminal `checks.update` |
| `review.recheck.assignment_max_bytes` | `65536` | integer `8192..262144` | `getRecheckAssignmentMaxBytes` (`src/pipeline/consumer.ts`, one read per recheck round; passed to the seat as the runner input's `recheckAssignmentMaxBytes`) | UTF-8 bytes of assignment the prior-findings seat may be asked with — every prior finding and the discussion always ride, evidence slices ride until the budget is spent |

Degraded reads: an untrusted concurrency value answers `1` (serial) with
`degraded: true`; an untrusted level answers `default` with `degraded: true`; an
untrusted Check budget answers its default with `degraded: true`; an untrusted
recheck assignment budget answers the seat's documented default (`65536`) with
`degraded: true`. The Check
budgets are saved as a pair (`checkBudgets: {terminalizeMs, updateMs}`) because
one operator action defines both.

## System layer — `server_flags` (migration `0033`)

Platform-wide switches. **An absent row reads as enabled**, so a flag nobody has
toggled cannot break a live consumer. Written from the console's flags page
(`PATCH /_internal_admin/api/flags`); on a `self-hosted` deployment, where the
console is not mounted, the operator writes the row directly (the statement is
in `docs/deploy.md` § Secrets and vars inventory).

| Key | Absent-row default | Effect |
|---|---|---|
| `review_global` | enabled | Closes the enqueue face for every App (`src/worker/index.ts`); queued work is untouched |
| `signup_open` | enabled | Off: an unknown login cannot create an account (an existing user still signs in) |
| `workspace_creation_open` | enabled | Off: nobody may mint a new workspace, whatever the plan |

## Workspace layer — `workspaces` columns

The tenant cap, read together with the system cap in one statement. Both
workspace reads filter `deleted_at IS NULL`, so a retired workspace falls back
to the default instead of pinning a value nobody can change.

| Column | Absent (NULL) default | Accepted values | Changed by | Effect |
|---|---|---|---|---|
| `max_concurrent_reviews` (migration `0040`; bounded by `0043_workspace_concurrency_bound.sql`) | `32` | integer `1..32` (an above-maximum stored value is clamped to `32` on read) | workspace owner/admin — dashboard Settings, `PUT /<workspaceRef>/api/settings/concurrency` | This workspace's share of the admission quota; the tenant face never sees or writes the system value |
| `check_min_score` (migration `0049_workspace_check_min_score.sql`) | `60` (`DEFAULT_CHECK_MIN_SCORE`, `src/contracts/review-gate.ts`) | integer `0..100` | workspace owner/admin — dashboard Settings, `PUT /<workspaceRef>/api/settings/check-min-score` | The floor a NEW App of this workspace starts at; `createApp` seeds the App row from it, and an existing App keeps its own stored floor |

## Per-App layer — `github_apps` columns and their tables

Read per delivery, so a change applies to the next webhook or the next queue
message. The parameters sit at three distinct decision points:

- **Webhook classification and enqueue.** `review_trigger_mode` is read by the
  webhook route and gates only the `pull_request` auto face (`open` →
  `opened`; `every_push` → every whitelisted action; `manual` → none — a bot
  mention is then the only trigger). The mention target is the row's
  `github_slug`, not the mode. `allowlist_enabled` is read there too — a
  refused review-triggering delivery is answered before any ledger write or
  enqueue. Neither gates the consumer.
- **Consumer, before admission.** `review_enabled` (the paused gate) and
  `review_level` (the seat split, runner budget and guard TTL) ride the
  per-message row read. `sandbox_image_id` is resolved on its own App-row read
  immediately after — still before the in-flight guard and sandbox creation, so
  an unknown or disabled image never starts a container.
- **After the review.** `check_min_score` and `check_pass_verdicts` are evaluated
  when the review's Check is reconciled. `github_visibility` is a UI hint only
  and never gates anything.

Values are validated at the write face and again in the store; the DDL `CHECK`
is the last line.

| Column | Default | Accepted values | Changed by | Effect |
|---|---|---|---|---|
| `review_level` (migration `0047_review_level_per_app.sql`) | `NULL` = follow `review.level.default` | `quick` \| `default` \| `deep` | dashboard App Settings, `save-review-level` (the "follow the operator default" choice writes `NULL` back) | Review depth: seats, runner wall clock and guard TTL (see below) |
| `review_enabled` (migration `0008`) | `1` | `0` \| `1` | dashboard Pause/Resume (`POST /apps/:appId/pause` \| `/resume`) | `0` acks new work without reviewing; queued work is untouched |
| `review_trigger_mode` (migration `0022`) | `every_push` | `open` \| `every_push` \| `manual` | dashboard App Settings, `POST /apps/:appId/review-trigger-mode` | Which PR events auto-enqueue a review |
| `sandbox_image_id` (migration `0018`) | `omp` | an enabled id from the sandbox image registry | dashboard App Settings, `save-sandbox-image` | Which runtime image runs the review |
| `check_min_score` (migration `0045`; seeded on creation from the workspace default, `0049_workspace_check_min_score.sql`) | `60` via the create path | integer `0..100` | dashboard App Settings, `save-check-gate` | Score floor for a passing review Check. The column's own DDL default (80) is the historical 0045 value: `createApp` writes the workspace's default (platform default 60) explicitly, so it applies only to rows 0045 materialized on Apps that already existed — those keep 80 until their settings page writes a new floor |
| `check_pass_verdicts` (migration `0045`) | `["ship it"]` | JSON array of `PR_VERDICTS` spellings | dashboard App Settings, `save-check-gate` | Verdicts that satisfy the gate (an empty set fails closed: nothing can pass) |
| `allowlist_enabled` (migration `0045`) | `0` | `0` \| `1` | dashboard App Settings, `save-allowlist` | Owner allowlist switch; on with an empty list refuses every owner |
| `github_visibility` (migration `0045`) | `NULL` = `unknown` | `public` \| `private` \| `unknown` | the App metadata refresh's anonymous probe (not operator-editable) | UI hint only; never gates admission |

`app_owner_allowlist` (migration `0045`) holds the owner logins the switch
enforces — one row per `(app_id, owner_login)`, replaced atomically by
`save-allowlist`.

Model selection is per-App configuration, not a credential: the chains are
stored as plaintext TEXT in two App tables (migration `0017`) and are read on
every message, with no deployment-level fallback.

| Row | Absent default | Accepted values | Changed by | Effect |
|---|---|---|---|---|
| `app_model_chains`, reserved name `default` | no row = no chain: that App's reviews fail closed (`per-App config incomplete: app <id>: missing model chain`) | ≥1 comma-separated provider/model selectors, stored verbatim | dashboard App Settings, `save-chain` (empty clears the row) | The chain every seat without its own reference runs |
| `app_model_chains`, named rows | only the `default` row exists | a non-reserved chain name + selectors, stored verbatim | dashboard App Settings, `add-chain` / `remove-chain` | Per-seat alternative chains; removing one deletes its seat references in the same batch |
| `app_model_chain_seats` | no row = the seat uses the `default` chain | `(role, chain name)` for the audit seats, naming an existing chain | dashboard App Settings, `save-roles` (blank = the default chain) | Routes one seat to a named chain; a reference to a missing chain fails that App's reviews closed |

Per-App credentials and provider keys are the App rows that ARE encrypted in D1
rather than Worker secrets; they stay out of this inventory because they are not
tuning parameters (see `.env.example`).

### Review depth

`review_level` (and its operator default) selects three bounds, all stated once
in `src/pipeline/consumer.ts`:

| Level | Tenant label | Orchestration | Runner budget | `review_inflight` TTL |
|---|---|---|---|---|
| `quick` | Quick | Bun fan-out, 1 seat | 600 s | 2292 s |
| `default` | Standard | Bun fan-out, 2 seats | 600 s | 2292 s |
| `deep` | Deep | one parent session, no seat split | 840 s | 2532 s |

`runnerTimeoutMs`, `reviewGuardTtlSeconds` and `guardRetryDelaysSeconds` are the
only consumers of the tier. The resolved tier rides the `guard-held` outcome, so
the retry path never re-reads it. An off-vocabulary stored value is treated as
absent, never a throw: a review must still run.

## Deploy-time layer — `wrangler.jsonc`

Ships with the Worker; changing it is a deploy. Nothing here changes the
business quota except as a hard upper bound.

| Parameter | Value | Why |
|---|---|---|
| `queues.consumers[…].max_concurrency` (top level **and** `env.production`) | `250` | Cloudflare Queues' hard limit on concurrent consumer invocations — the blast-radius ceiling, not the quota |
| `queues.consumers[…].max_batch_size` | `1` | One review per batch, so one message owns one round |
| `queues.consumers[…].max_retries` | `3` | One initial delivery + three retries, then the DLQ (the guard-held path uses per-message `message.retry`, not these) |
| `queues.consumers[…].dead_letter_queue` | `review-dlq` (staging) / `review-dlq-prod` (production) | Terminal failures |
| `vars.DEPLOYMENT_MODE` | `self-hosted` top level, `saas` in `env.production`; both workflows also pass `--var DEPLOYMENT_MODE:saas` | Deployment shape; no code default — unset/invalid fails loud |
| `PLATFORM_OPERATORS` (Worker var, not declared in `wrangler.jsonc`) | unset = no operators | Bound on every deploy from the GitHub repository variable `vars.PLATFORM_OPERATORS` via `--var` |

## The admission contract

Three bounds, applied in this order:

1. **Platform ceiling** — the deploy-time `max_concurrency` (`250`).
2. **Business quota** — `min(system, workspace)`, read from D1 on every queue
   message. Absent rows give `min(256, 32) = 32` per workspace; the ceiling is
   only reachable as the aggregate of workspaces each at their own maximum.
3. **Per-PR lock** — the `review_inflight` primary key holds one row per PR, so
   a second message for the same PR is refused at admission and retried on the
   guard-held delay schedule. Not configurable.

The shipped contract is therefore **per-PR serial, cross-PR parallel**: two
different PRs may be reviewed in two containers at once, while two messages for
the same PR never enter a sandbox concurrently. A read failure or an untrusted
value answers the conservative serial cap `1` and logs one
`review_concurrency_degraded` warn — the gate degrades toward serial, never
toward unlimited.

## Secrets — these stay on the secret store

Never in `review_runtime_settings`, never a plain var, never in git. They are
GitHub environment secrets injected into the Worker by
`wrangler secret bulk` on every deploy (`docs/deploy.md` § Secrets and vars
inventory; per-key notes in `.env.example`):

| Worker name | Purpose | Required |
|---|---|---|
| `DASHBOARD_ENCRYPTION_KEY` | AES-256-GCM master key for the App credentials stored in D1 | yes, for the dashboard/consumer credential paths |
| `DASHBOARD_SESSION_SECRET` | dashboard session/state cookie HMAC key | yes, for sign-in |
| `GITHUB_OAUTH_CLIENT_SECRET` | user OAuth login App secret | yes, for sign-in |
| `ALERT_WEBHOOK_URL` | ops sweep alert webhook; unset = log-only alerting | no (deleted from the Worker when unset) |

`GITHUB_OAUTH_CLIENT_ID` is a **variable**, not a secret (a client id is public),
and `PLATFORM_OPERATORS` is a plain var — neither belongs on the secret store.

## What this repository cannot verify

- **Deployed-only plain vars.** The inventory above is derived from
  `src/worker/env.ts` and the code that reads those bindings. A var that exists
  only on a deployed Worker is invisible here; if one survives from before the
  `REVIEW_LEVEL` retirement it is inert (nothing reads it) but its presence is
  **unverified** from the repository. Confirm the live bindings from the
  deployed version before assuming a Worker is clean (Cloudflare dashboard →
  Worker → Settings, or `wrangler versions view <version-id>`), and note that a
  plain var set from a dashboard does not survive the next deploy anyway.
- **Deployed level resolution after migration `0047_review_level_per_app.sql`.**
  Per-App and operator defaults are covered by unit tests only; no live
  deployment receipt exists in this repository. The first live review after the
  deploy is the evidence.
