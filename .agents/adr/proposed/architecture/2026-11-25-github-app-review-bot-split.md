# ADR: Split the GitHub App from the Review Bot and relay quota across an ordered bot chain
Status: proposed — the split, the per-bot quota and the relay are specified here; none of it is shipped, and the current model stands until the atomic cutover in P1
Spec: docs/specs/feature/bot-scope-and-claiming.md § Current state

## Problem

One `review_bots` row is three things at once: a GitHub App's credentials, a review configuration, and one workspace's ownership of both. The rename that created the table moved all three together (`migrations/0056_review_bots_rename.sql:22`), and the ownership row is keyed by that same id (`migrations/0026_workspaces.sql:43-46`; its column was renamed at `migrations/0056_review_bots_rename.sql:35`). Because credential, configuration and owner share one primary key, three facts the product needs cannot be stated in the schema:

- **One install, several review bots.** Every configuration table hangs off the bot row by `bot_id` (the eight `bot_*` tables, `migrations/0056_review_bots_rename.sql:25-43`), and so does the sandbox image (`migrations/0018_app_sandbox_images.sql:24`). The consumer resolves credentials, model overrides, custom providers and the sandbox image from the single id in `payload.botRef.appId` (`resolveCommenter`, `resolveAppConfig`, `resolveModelOverrides`, `resolveCustomProviders`, `resolveSandboxImage`, `src/pipeline/consumer.ts:470-603`), and one GitHub App is at most one row (`github_app_id INTEGER UNIQUE NOT NULL`, `migrations/0038_webhook_path_drop.sql:81`). A repository is therefore reviewed by exactly one configuration: a target is keyed by the bot (`CREATE TABLE review_targets`, `migrations/0057_review_targets.sql:40`; `resolveByRepo`, `src/dashboard/targets-store.ts:570`).
- **A quota per (bot, workspace).** The usage ledger records no bot (`recordUsageEvent`, `src/store/usage-store.ts:113-136`); its latest column is `source` (`migrations/0065_usage_events_source.sql:30`). One refusal point compares one workspace-wide sum against one plan ceiling (`quotaRefusal`, `src/worker/index.ts:415-440`: `sumMonthlyRp` at `src/store/usage-store.ts:102-110`, `resolveMonthlyQuota` at `src/store/quota-store.ts:113`), and that sum does not filter by source, so a workspace's own bot also spends its plan ceiling. The only price multipliers are two columns of the operator's profile (`migrations/0063_quota_profiles.sql:58-59`; `rpFor`, `src/store/quota-store.ts:136-138`), so a bot's owner cannot price or cap its own bot.
- **Two sharing semantics.** One column answers two unrelated questions: `scope` (`migrations/0058_review_bot_scope.sql:25-27`) decides both whether another workspace may bind an installation (`appBindInstallationRoute`, `src/dashboard/index.ts:4142`; `listPendingInstallations`, `src/dashboard/apps-store.ts:919`) and whether a review is platform-funded and plan-gated (`src/worker/index.ts:648`; `src/pipeline/consumer.ts:1806`).

"Which workspace installed which GitHub App" has no row of its own either. It is derived from the ownership table, from `bound_workspace_id` on the physical installation (`migrations/0104_bot_installation_binding.sql:10`; `bindInstallation`, `src/dashboard/apps-store.ts:896-917`) and from "holds a live target" (`SCOPED_APP_SQL`, `src/dashboard/apps-store.ts:444`; `appsListWithHealth`, `src/dashboard/index.ts:2082-2091`).

## Proposal

### Two entities and the install state

| Entity | Owns | May be shared |
| --- | --- | --- |
| **GitHub App** — `github_apps`, the current `review_bots` row renamed in place | `github_app_id` (unique), `private_key_enc`, `webhook_secret_enc`, the slug and cached GitHub metadata, `status`, `review_enabled`, `last_webhook_at`, the owner workspace (`app_workspaces`), `scope` and `shared_at`, `default_bot_id`; its physical installations, today's `bot_installations` table renamed `github_app_installations` (webhook-maintained, one row per GitHub installation, id changes on reinstall) | its installations may be bound by several workspaces |
| **Review Bot** — `review_bots`, a new table | `github_app_id` (its host App, not null), `workspace_id` (its owner), `name`, `description`, `scope` and `shared_at`, `sandbox_image_id`, `multiplier` (1–10), `monthly_rp`, and the eight `bot_*` configuration tables | its capability and quota may be used by several consuming workspaces, each with its own quota |

- **A Review Bot belongs to exactly one GitHub App.** It has no GitHub identity of its own: every bot under one App publishes as that App.
- **Both ids inherit the pre-split `review_bots.id`.** The credential AAD (`github_apps.private_key_enc:${id}`, `src/pipeline/consumer.ts:520`, `src/worker/index.ts:524`), the provider-key AAD (`app_provider_keys.key_enc:${id}:…`, `src/dashboard/app-config-store.ts:737-746`) and the webhook URL (`src/dashboard/manifest.ts:119`) all bind the row id, so no ciphertext and no public URL changes. Because the two ids are then equal, every column that points at the App is renamed `app_id` in the same migration; a `bot_id` column may point only at a Review Bot.
- **The install state is the parent of the chain.** `app_installations (github_app_id, workspace_id)` is a **new** table — not the physical installation rows, which stay in `github_app_installations` — and it is one workspace's install of one GitHub App. `app_install_bots (github_app_id, workspace_id, position, bot_id)` is the ordered chain under it, bound by a composite foreign key. A chain may contain any bot of that App that is shared or owned by the installing workspace: `bot.github_app_id = app.id AND (bot.workspace_id = installer OR bot.scope = 'shared')`, checked in the store batch that writes the row.
- **Only the installing workspace's owner or admin edits a chain** (`canManageRole`, `src/dashboard/index.ts`). The order lives per install state, not on the GitHub App row and not on the physical installation: the physical row is maintained by the webhook (`upsertInstallation`, `src/dashboard/apps-store.ts:840`) and changes id on reinstall (`docs/specs/feature/bot-scope-and-claiming.md`, Invariants), and a shared App's owner must not impose an order on its consumers.
- **An install-state row written by a bind carries its installation.** A bind writes the install state in the same batch as the proof of ownership, so it always names the installation it proves and can never disagree with `bound_workspace_id`. Creating an App writes the owner's own install state with zero physical installations, which is the state an uninstall removes; that row declares an install of the App, not of an installation.

### Attribution columns

| The fact a row records | Column | Tables |
| --- | --- | --- |
| Which GitHub App acted on GitHub | `app_id` → `github_apps` | `review_targets` (renamed from `bot_id`, value unchanged), `pull_requests` (keeps `ON DELETE CASCADE`, `migrations/0039_pull_requests.sql:33`), `webhook_deliveries`, `review_publications`, `review_threads`, `review_checks`, `review_findings`, `reviews` (renamed), `lifecycle_recovery_cursor`, `check_reenable_cursor`, `degraded_target_leases` |
| Which Review Bot executed | `bot_id` → `review_bots` | `reviews` (a new column, backfilled equal to `app_id`) and the eight `bot_*` configuration tables (their foreign key is re-pointed) |

A target therefore belongs to a GitHub App and a repository, never to a physical installation: one installation covers many repositories (`migrations/0067_repo_target_identity.sql:57-58` dropped `installation_id` for that reason) and the job payload already carries `installation_id` (`ReviewJobPayload`, `src/contracts/review-job.ts`). The tenant predicate is untouched: tenant reads still bind `target_id` (`migrations/0060_execution_ledger_target.sql:201`).

### Quota

- **The plan ceiling comes first and counts shared bots only.** `quota_profile_plans.monthly_rp` stays. Its used side becomes `SUM(rp)` over `source = 'shared'` rows of the consuming workspace for the month.
- **An own bot bypasses the plan ceiling entirely.** Its RP is still recorded per bot, for display.
- **A per-(bot, workspace) ceiling sits on top for shared bots.** `review_bots.monthly_rp` is the bot-level default; a row in `bot_quota_overrides (bot_id, workspace_id, monthly_rp)` replaces it for one workspace, and a stored NULL there means unlimited. NULL as the default means "no bot-level cap".
- **`multiplier` replaces the profile's source multipliers; it does not multiply them.** The price becomes `rp = base(level) × bot.multiplier`. `quota_profiles.source_byok` and `source_shared` are dropped, `rpFor` takes the multiplier, and `usage_events.source` stays as the record of which category paid at charge time (`migrations/0065_usage_events_source.sql` explains why it cannot be derived later).
- **`usage_events` gains `bot_id`.** Every workspace's spend is attributed to a Review Bot, which is what "each bot's spend this month" reads.

### Relay

`selectReviewBot` replaces the call to `quotaRefusal` at the single refusal point, the enqueue branch of the webhook route (`src/worker/index.ts:646-673`). Execution meters and never refuses (`docs/specs/architecture/entitlement-and-deployment-modes.md:300`), and never switches bot.

1. Read the chain of the target's workspace under the resolved GitHub App, in position order, live bots only. An empty chain is refused.
2. For each bot in order: an own bot is selected at once, before any quota read (no profile, no month sum, no plan).
3. A shared bot needs, in this order: the plan capability (`checkEntitlement` with `kind: "shared-bot"`, `src/dashboard/entitlement.ts:284`), then the plan month over shared RP, then the bot month. A bot that fails any of them is skipped and the reason is remembered; the plan month is read once per delivery.
4. The first bot that passes executes. Only when every bot failed is the delivery refused, with the remembered reason in capability > plan > bot order.

A refusal keeps today's three surfaces: one `review_failures` row through `refuseDelivery` (`src/worker/handlers.ts:193`), a Check that is still attached and settles neutral (`attachCheckOnAcceptance`, `src/worker/index.ts:803`), and a `skipped` delivery outcome (`deliveryOutcomeFromWebhook`, `src/worker/index.ts`). A delivery records at most one refusal; skipped bots record nothing. The refusal value gains `scope` (plan or bot) and `botId`, and a bot-level refusal gets its own author-facing sentence, because the author's next step differs: wait for the bot's owner, or change plan.

### Sharing

Two independent predicates and two independent switches:

| | Shared GitHub App | Shared Review Bot |
| --- | --- | --- |
| Predicate | `github_apps.scope = 'shared'` | `review_bots.scope = 'shared'` |
| What is shared | installations may be bound by other workspaces | the capability and its quota may be used by other workspaces |
| Who reads it | the bind route and the pending list (`src/dashboard/index.ts:4142`, `src/dashboard/apps-store.ts:919`), App visibility | the enqueue capability gate (`src/worker/index.ts:648`) and the price source (`src/pipeline/consumer.ts:1806`) |
| Quota | none of its own | `bot_quota_overrides`, else `review_bots.monthly_rp`; spend is charged to the consuming workspace |
| Switch | "Share this App" on the GitHub App detail | "Share this Bot" on the Review Bot detail |

Today only a workspace designated as the official one may share (`officialWorkspaceGuardSql`, `src/dashboard/apps-store.ts:1537-1543`; `OFFICIAL_WORKSPACE_KEY`, `src/dashboard/runtime-config-store.ts:1422`), and the guard is evaluated inside the writing batch (`setBotScope`, `src/dashboard/apps-store.ts:1585`). That rule is kept, behind one function with a single switch point, so that "any workspace may share" can later be enabled without touching either writer. Each entity gets its own store function; no SQL is built from a table name.

### UI

- **The Apps page becomes three tabs, addressable in the URL** (`/dashboard/<workspaceRef>/apps?tab=…`; today it is one list, `AppsPage`, `src/spa/pages/AppsPage.tsx`):
  - `installed` — **installed GitHub Apps**, the consumer's view: the GitHub Apps this workspace installed or bound, each opening an ordered list of mounted Review Bots (shared or own) with each bot's spend this month;
  - `created` — **GitHub Apps I created**, the supply view: today's App detail (credentials, installations, delivery, metadata);
  - `bots` — **Review Bots I created**: this workspace's own bots, each opening its configuration, its sharing switch and its quota.
- **The App detail's `settings` tab is split in two.** `delivery` and `installations` stay on the App detail (`AppDeliveryTab`, `src/spa/pages/AppDeliveryTab.tsx:44`, mounted at `src/spa/pages/AppDetailPage.tsx:491`; `AppInstallSection` and `AppInstallationsSection`, `src/spa/pages/AppDetailPage.tsx:504-514`). What stays on the App side is the App's own settings: GitHub metadata, enable/disable/delete (`TargetOpsZone`, `src/spa/pages/AppDetailPage.tsx:323`) and "Share this App". What moves out is the review-bot configuration now rendered by `BotSettingsView` (`src/spa/pages/AppDetailPage.tsx:475`): sandbox image, providers and keys, model chains and seats (`SandboxSection`, `src/spa/pages/BotSettingsPage.tsx:312`). The App detail also gains a `bots` tab for the chain.
- **A Review Bot detail page is new**: `/dashboard/<workspaceRef>/bots/<botId>`, with a `config` tab (model chains, sandbox, provider keys) and a `quota` tab (multiplier, default ceiling, per-workspace overrides). Only the owner workspace's owner or admin writes either; a consumer reads the bot, its App and this workspace's remaining quota. The routes join `WORKSPACE_FAMILY_SEGMENTS` (`src/spa/routes.ts:66`), which the Worker's tenant gate derives from (`src/dashboard/index.ts:620`).

### Migration and delivery phases

| Phase | Content | Ships alone? |
| --- | --- | --- |
| P0 | The `installed` and `created` tabs over today's `/api/apps` data (`src/dashboard/index.ts:4989`); the install wizard's client-side steps. No schema change. | yes |
| P1 | The split migration: `github_apps` and the new `review_bots` table, `app_workspaces`, `github_app_installations`, and the new `app_installations` and `app_install_bots` DDL; the re-pointed configuration tables; every `app_id` rename; `botRef.botId`; the consumer's resolution; the configuration routes under `/api/review-bots/:botId`; the `bots` tab and the Review Bot detail. Behaviour is unchanged: one bot per App, `multiplier` backfilled from the profile, `monthly_rp` NULL. | **no — schema, Worker, pipeline, dashboard and SPA move in one release; migration first, then the Worker** |
| P2 | Install states and a length-1 chain take effect; the bind batch writes the install state; uninstall. The chain is displayed read-only — no order is editable yet. | yes |
| P3a | `usage_events.bot_id` and its backfill; `multiplier` replaces the source multipliers; own bots bypass the plan ceiling; each bot's spend is shown. | yes, in its own announced window: it changes billing |
| P3b | Bot-level ceilings (default and overrides), the `quota` tab, `selectReviewBot` and the relay, both sharing switches, and the editable chain order (add, remove, reorder). | with its own selection logic: the order becomes editable only in the release that reads it |

P1 cannot be split because the configuration tables follow the new bot row while the credentials stay on the App row: a Worker that reads one and not the other resolves half a bot. Rehearsal on SQLite 3.51.0 with `foreign_keys = ON` and one transaction per migration file showed the split committing with an empty `PRAGMA foreign_key_check`; a `DROP TABLE github_apps` attempt failed on the non-cascading children's references while its `pull_requests` cascade would have emptied the ledger had the drop been allowed; and a pre-split row without an owner row aborted the whole migration with the schema left unsplit. It was not run on D1.

## Alternatives considered

- **Add an `apps` aggregate table and leave `review_bots` as it is.** An app listing N bots would still need N GitHub Apps installed on every repository: an installation token can only be minted by the App that owns the installation (`resolveCommenter`, `src/pipeline/consumer.ts:518-522`), and each bot row is its own webhook entry (`src/worker/index.ts:444`, `src/dashboard/manifest.ts:119`). "One installed app with several bots" would be N installs and N binds for the user, and the aggregate row would carry nothing once N bots share one GitHub App.
- **Bind the target to the physical installation.** This was tried and removed: one installation covers many repositories, which is why `migrations/0067_repo_target_identity.sql:57-58` dropped `installation_id` from `review_targets`. It would also restore the one-installation-one-target coupling that `review_targets_bot_installation` enforced (`migrations/0057_review_targets.sql:72-74`), while the executing installation is already on the job payload (`ReviewJobPayload`, `src/contracts/review-job.ts`).
- **Relay by switching to another GitHub App** (each bot keeps its own credentials). The comment author and the Check-run App would change at every relay, and `@mention` resolution follows the App's slug (`payloadMentionsALogin`, `src/worker/webhooks.ts:133`). The user would install and bind N GitHub Apps; there would be N webhook entries, and the Check would have to be created with the selected bot's credentials while `attachCheckOnAcceptance` uses the entry row (`src/worker/index.ts:803`). The platform would rotate N keys, the cost [shared bot scope and claiming](../../implemented/feature/2026-11-15-shared-bot-scope-and-claiming.md) already rejected when it refused to copy the App per consumer.
- **One independent RP pool per shared bot, with no plan total.** It would retire the versioned ceilings the operator publishes per plan (`resolveMonthlyQuota`, `src/store/quota-store.ts:113`; `src/admin/quota-versions.ts`), and a workspace's total spend would become the sum of every mounted bot's pool, so mounting one more bot raises the total with no plan change. Free and pro would no longer differ in their monthly review ceiling (`migrations/0063_quota_profiles.sql:83-87`). The plan ceiling is kept, with the bot ceiling on top and NULL by default.
- **Multiply the profile's source multiplier by a per-bot multiplier.** A shared bot would cost `base × 10 × up to 10`, because `source_shared` is 10 (`migrations/0063_quota_profiles.sql:78`), and two places would state the same fact, which is the defect `migrations/0065_usage_events_source.sql` records for a single `rp` value. `multiplier` replaces the source columns instead: an own bot is backfilled with 1 and a shared bot with the profile's `source_shared`, so no stored price changes.

## Acceptance criteria

- **The split migration is idempotent and foreign-key sound.** The backfill run twice inside the split transaction leaves exactly one `github_apps` row and one `review_bots` row per pre-split row, with the same id. `PRAGMA foreign_key_check` is empty; the eight `bot_*` tables reference `review_bots`; every publishing column references `github_apps` as `app_id`; no `bot_id` column references `github_apps`; `pull_requests.app_id` keeps `ON DELETE CASCADE` (the one child a parent rebuild would empty rather than refuse). A pre-split row without an owner row aborts the whole migration and leaves the schema unsplit.
- **One entry per GitHub App, unchanged.** The webhook route stays `POST /webhook/:workspaceId/:appId` (`src/worker/index.ts:444`) with one secret per App; a Review Bot holds no `webhook_secret_enc`. Two bots under one App publish reviews and Check runs under the same `github_app_id`.
- **An own bot never refuses for quota.** With the chain's first bot owned by the consuming workspace and that workspace past its plan ceiling, the delivery is enqueued and no `review_failures` row is written on the `quota` stage. No quota read (profile, month sum, plan) is issued before the selection.
- **Chain order decides the executing bot.** With the chain `[A shared with quota left, B own]`, A executes; with A exhausted, B executes. The enqueued job's `botRef.botId` names that bot and `usage_events.bot_id` records it.
- **A plan refusal and a bot refusal can be told apart.** They carry different refusal values (`scope`) and different author-facing sentences, and both come from the single refusal point (`src/worker/index.ts:646-673`). One delivery writes at most one failure row.
- **`usage_events.bot_id` attribution is reported to the operator.** After the migration, an operator-visible report states how many pre-migration rows with `rp > 0` carry a `bot_id` and how many are left NULL. Every row written after the migration carries a `bot_id`.
- **The two sharing switches do not affect each other.** Sharing a GitHub App changes no bot's `scope` and no review's price source. Sharing a bot without sharing its App leaves the bind route refusing exactly as it does today (`src/dashboard/index.ts:4142`).

## Risks

**Key risks carried from the assessment.**

- **Data backfill (R4).** The App row can only be renamed, never rebuilt. A rebuild's `DROP TABLE github_apps` empties `pull_requests` through its `ON DELETE CASCADE` (`migrations/0039_pull_requests.sql:33`) — that child cannot refuse the drop — while the non-cascading children leave foreign-key violations, so the rebuild cannot commit; `migrations/0057_review_targets.sql:29-33` records the same mechanism. The rehearsal ran on the SQLite CLI, not on D1. Mitigate with CHECK-constrained guards inside the migration, a rehearsal on a production snapshot in a preview D1, and migration before Worker.
- **Pricing switch (R12).** `multiplier` is backfilled from the profile in force, so no stored price changes, but the operator loses a per-version multiplier. `tests/worker/admin-quota-versions.test.ts` must follow.
- **Own bots are uncapped (R8).** This supersedes rule D7 of the [entitlement spec](../../../../docs/specs/architecture/entitlement-and-deployment-modes.md), which says "BYOK is metered, never exempt" (`docs/specs/architecture/entitlement-and-deployment-modes.md:240-241`). The remaining cost gates are `workspaces.max_concurrent_reviews` and `apps_per_workspace`, plus an operator alert that never refuses.
- **In-flight jobs without `botId` (R7).** Messages already queued, and payloads persisted by `comment_trigger_claims` (`src/worker/handlers.ts:277`) and by maintenance replay (`src/admin/maintenance-replay.ts:90`), predate the field. Drain the queue inside the maintenance window, rewrite queued claims in the migration, and make the replay tool name the bot.
- **Three kinds of writer (R5).** The App owner, the bot owner and the installing workspace each write different things. A bot's write permission is judged on `review_bots.workspace_id`, not on the App row as `canWriteBotScope` does today (`src/dashboard/index.ts:2007`).
- **Re-runs may land on another bot (R1).** The publishing identity is stable; only the executing configuration can differ between two runs of one head.
- **Blast radius (R4, R13).** Non-test sources touching the renamed identifiers, counted at commit `1981816d` with `grep -rlE <identifier> src` over `*.ts` and `*.tsx`: `review_bots` in 19 files, `bot_workspaces` in 3, `bot_installations` in 11, `bot_id` in 23. Twelve index names still contain `bot` after the rename; renaming them is optional.
- **Documentation drift (R14).** Every record and spec this proposal changes is named in [ADR impact at promotion](#adr-impact-at-promotion); promotion settles each row there. The entitlement spec's shared-bot gate on target creation has no counterpart in code (`SHARED_BOT_REFUSAL` has no caller in `src/`, `src/dashboard/entitlement.ts:410`), so that correction is owed independently of the split.

**Open decisions.**

- Which tab the Apps page opens by default.
- Whether the three `DROP COLUMN` statements move to a second migration file. The backfill reads `github_apps.sandbox_image_id` and `quota_profiles.source_*`, which the same file removes later, so as drafted it cannot be replayed on its own after the file has applied.

**Known gaps.**

- **Existing usage is only partly attributable.** The backfill joins `usage_events.review_id` to `reviews.id`, which holds when the job payload carried a head (`idemKey` in both places, `src/pipeline/review-attempt-execution.ts:3013-3016` and `:4427`). A comment-triggered job carries `head_sha: null` (`src/worker/webhooks.ts:721`), so its usage id says `no-sha` while its review id says the resolved sha, and those rows stay NULL. The coverage rate has not been measured.
- **The 286 test files are not inventoried** (`find tests -name "*.test.ts" -o -name "*.test.tsx"` at commit `1981816d`). The P1 figure is a per-identifier count, not a per-test plan.
- **Spec rule D7 must be superseded.** See R8 above; it needs its own record before P3a ships.
- **Sharing from any workspace is a future item.** Today only the official workspace may share (`src/dashboard/apps-store.ts:1537-1543`); the guard is switchable, not switched.

### ADR impact at promotion

Promotion to `implemented/` is one change that settles every row below. A `Supersedes` / `Superseded-by` pair is written in that same change, on both records, on relative paths ([README](../../README.md) § Header); a row whose answer is "not a supersession" says so in the promoted body instead of leaving the question open.

| Record or spec | What this proposal changes | Promotion must |
| --- | --- | --- |
| [`implemented/architecture/2026-11-15-review-bot-and-target-entities.md`](../../implemented/architecture/2026-11-15-review-bot-and-target-entities.md) | Separates what that record calls one bot entity into a GitHub App (identity, installations, publishing) and a Review Bot (configuration, quota), hosted by that App | Decide supersession. If superseded, add both header lines and name the paragraphs it replaces. |
| [`implemented/feature/2026-11-15-shared-bot-scope-and-claiming.md`](../../implemented/feature/2026-11-15-shared-bot-scope-and-claiming.md) | Splits one `scope` into two independent switches — sharing a GitHub App (bindable installations) and sharing a Review Bot (funded capacity and quota) — and adds a publisher guard that is switchable but not switched | Decide supersession. If superseded, add both header lines; until then the bind route's refusal stays that record's authority (`src/dashboard/index.ts:4142`). |
| `docs/specs/architecture/entitlement-and-deployment-modes.md` § RP metering and the monthly ceiling | Rule D7 says BYOK is metered, never exempt; this proposal exempts a workspace's own bot from the plan ceiling | Write the superseding record before P3a ships, and correct that section. |
| `docs/specs/feature/bot-scope-and-claiming.md` § Current state | One `scope` answers two questions today (bindability and plan funding) | Restate as two switches after P3b; until the cutover, that section remains the description of shipped behaviour. |
| `docs/specs/architecture/operator-admin-surface.md` | Adds a bot-level sharing route and a quota surface next to the existing App route | Add both surfaces, the audit actions they write, and the guard that keeps only the official workspace publishing. |
