# Changelog

Chinese summary: [CHANGELOG_CN.md](CHANGELOG_CN.md).

All notable changes to this repository are documented here. Version sections are assembled
from [`.changes/`](.changes/README.md) fragments at release time — see that README for the
fragment format and the per-change commit flow.

## [Unreleased]

## [1.0.0] - 2026-11-18

### Changed

- **The App detail's credentials panel is now a 投递状态 tab**: the delivery log moved out of 应用设置 into its own tab, as a table of repository, delivery type, time, outcome and — for a refused delivery — the reason. The reason is persisted from the classifier's own sentence (new nullable `webhook_deliveries.reason` column), so a `rejected` row no longer says only "401". The tab filters by repository, time window and delivery type, and pages on the server: `GET …/api/apps/:appId/deliveries` takes `repo` / `since` / `type` / `offset` and answers the matching `total` beside the page plus the App's unnarrowed filter option sets. A malformed parameter is a 400; a well-formed value matching nothing is an honest empty page.
- **The App detail no longer links back to the repository surface**: an App with no repository, or with several, states the fact without offering a 仓库 link.
- **omp SDK 18.22.2 and harness engine 4.7.3 across root, runner and the review image**: the root manifest's `@oh-my-pi/pi-coding-agent` pin moves from `18.18.6` to `18.22.2`, `packages/runner`'s from `18.18.1` to `18.22.2`, and the engine pins from `^4.7.0`/`4.7.0` to `^4.7.3`/`4.7.3`; both lockfiles regenerate. The image's harness pin moves with them — `HARNESS_VERSION`/`harnessRef` (tag v4.7.3), the global-install `@mstar-harness/cli` 4.7.0 → 4.7.3 and its lock, and the Dockerfile clone ref — so the container runs the same harness release as the Worker's engine. The runner learns the SDK's new run lifecycle: `agent_end` is now emitted once, when nothing can resume the run, and a model loop that stops while the run continues emits `agent_pause` instead. The deep parent turn reads a pause from `agent_pause` (and waits for the resume only when the pause names outside work) where it used to read a non-terminal `agent_end`, so a parked deep review is still awaited rather than published as a stopped one. The regenerated provider catalog follows omp's own registry: it is the measurement of what omp now ships.
- **The image rebuild gate records a fingerprint instead of asking for a comment**: `sandbox-image/Dockerfile` carried 51 `# rebuild:` prose lines, each present only to change the file's bytes so `wrangler` re-hashes it. One `# image-inputs:` line now hashes every copied source plus the container block, and `bun scripts/check-image-inputs.ts --base origin/main --write` is the whole repair. A stale line fails the check; the prose is gone.
- **Command Code's model list is now measured from the provider itself**: omp 18.22.2's own registry is farther from the live vocabulary than 18.18.6 was for the main bucket, so `scripts/provider-catalog/inputs/overrides.json` records the endpoint's own list and the extractor applies it last, replacing each protocol bucket wholesale. The catalog now carries 92 chat-completions ids, 12 anthropic-messages ids and 78 responses ids — the live API's exact vocabulary, ids verbatim in both dialects. The override is data, not a hand edit: `bun run provider:catalog` reapplies it every run, and its `fetched` date marks when it was last re-measured.
- **Harness 4.6.2 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.6.2`, `packages/runner`'s exact pin to `4.6.2`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `e276cdac15a9bc5f91c8d6bea3c1f26895960a0c`, tag `v4.6.2`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. 4.6.2 raises the DSH corridor to 0.2.2-rc.3, authorizes `milestone.assign` by seat and revision CAS rather than a session, closes residual engine/CLI/coordination findings from the 2026-11-14 iteration, and bumps several DSH/OpenCode/dev dependencies, plus the monorepo version alignment. This repo's declared corpus layout and consumed review/seat contract are unchanged by the pin bump.
- **Harness 4.7.0 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.7.0`, `packages/runner`'s exact pin to `4.7.0`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `cb14eb364c339c07318b4d2ae7ce25f004adb45c`, tag `v4.7.0`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. 4.7.0 gates and describes the rc.3 Agent Teams surface in the dsh plugin and host skills, removes `spawn_teammate` and the roster-era Team carriers with no compatibility shim, and narrows host-detect vocabulary to rc.3's dsh channels (`subagent`, `team_task_create`), plus the monorepo version alignment. This repo's declared corpus layout and consumed review/seat contract are unchanged by the pin bump.
- **The provider-catalog scripts now state their own layout**: `scripts/provider-catalog/` splits into `inputs/` (the only directory a human or an external service writes — the dated models.dev snapshot and the hand-measured `overrides.json`), `generated/` (rebuilt from the installed SDK by `extract-omp-snapshot.ts`), and `lib/` (pure functions with no filesystem access); its root holds only executable steps, one per verb. `scripts/provider-catalog/README.md` is the contract: one row per file naming what produces it, when it changes and who reads it, plus the pipeline order and the override/snapshot rules. Nothing there is gitignored — `generated/omp-provider-verify.json` is imported by the Worker, so regenerable is not the same as disposable — and a test compares the README's table with `git ls-files` so the two cannot drift — the dated snapshot compares as a NAME FAMILY, so a refresh that renames it keeps the contract green.
- **The provider catalog now refreshes itself daily, behind one reviewed PR**: a scheduled workflow (`refresh-catalog.yml`, 04:17 UTC) re-fetches the models.dev directory through `scripts/provider-catalog/fetch-models-dev.ts` — which converts the upstream id-keyed `models` map into the trimmed snapshot the generator reads, writes nothing when the payload is byte-identical to the committed one, and prunes older dated snapshots — then regenerates both contract modules. The generator no longer carries a hardcoded snapshot date: it reads the newest dated snapshot, so a refresh is a data commit rather than a code edit. When the omp SDK or harness engine has a newer release, the same run moves every pin surface (both manifests, `HARNESS_VERSION`/`harnessRef`, the CLI pin and the Dockerfile) and notes it in the PR. The PR lands on the fixed branch `chore/catalog-refresh`, opens once and is updated in place afterwards, and the body lists every provider and every model id the regeneration removed — a chain naming a vanished id fails at request time, so that list is the review's reason to exist. Green is the only path to a PR: typecheck and the whole test suite run before anything is published, and a failing run commits nothing, pushes nothing and leaves any open PR untouched — the failed Actions run is the signal. Nothing auto-merges and nothing pushes to `main`.
- **One provider row per provider, with the protocol as a choice when you add it**: a provider that serves several API protocols no longer appears as separate providers ("Command Code", "Command Code — anthropic-messages", …). It is one row under its own name, and the add-provider form offers its protocols as a selectable option; picking one points the base URL field at that protocol's endpoint and the saved declaration carries that protocol's model list. A provider that serves one protocol looks and behaves exactly as before. An App still uses one protocol per provider, and an existing declaration keeps the protocol it was saved with — switching means removing the provider and adding it again, which removes its keys with it.
- **Model sizes are pre-filled for providers that had none**: Command Code, OpenCode Go, ZenMux and DeepInfra now carry the directory's context-window and max-output numbers for every model they serve, so the model dialog pre-fills those fields and saves without hand-typed sizes. A model the directory does not size still asks for the number, and a declaration pointed at your own endpoint keeps its hand-typed values instead of borrowing the vendor's.
- **A provider you already configured keeps working**: a declaration saved under one of the old per-protocol names is still listed under the provider's real name, shows the matching protocol's model list, and gets the same pre-filled sizes. Its stored endpoint, protocol and keys are untouched.
- **The dashboard opens on the repositories page.** `/dashboard` and the retired `/dashboard/apps` spelling both redirect to `/dashboard/<workspaceRef>/repos` (the sign-in landing, the operator landing and the post-creation landing follow it), one repository lives at `/dashboard/<workspaceRef>/repos/<targetId>`, and the sidebar wordmark follows the same page. The overview now carries a page header instead of a bare title: one line saying that review settings live on each repository while insights and pull requests are shared across the workspace, plus three figures derived from the list it already loads — the repository count, how many are awaiting an installation, and how recently the workspace last reviewed.
- **A repository that lost its installation keeps its name.** A target whose `repo_id` is NULL but which still carries `repo_owner`/`repo_name` renders `owner/name` (and in the detail header) instead of an em dash; only a target naming no repository at all falls back to the dash and the 待安装 copy. The 待安装 badge still keys on `repo_id`.
- **The repository surface reads like a table, and adding a repository is a three-step flow.** The sidebar's Repositories entry has its icon back. The repository list now uses the same table vocabulary as the Apps list — a name cell with the bound App underneath, a state badge, total reviews, reviews in the last 7 days and the last review — ordered by review recency with never-reviewed repositories last, so a reload shows the same order. The band reports review volume instead of repeating the row badges. Waiting-for-install is a filter carrying its own count rather than a metric. The Apps table drops its trailing detail column: the row itself is the destination. The add-repository dialog asks which App the repository belongs to (always, even when there is only one), shows that App's live installations with the GitHub install link and a re-check when there are none, and only searches repositories once you type — offering nothing the add could only refuse, so a repository another workspace already reviews under the same App shows as taken instead of failing later. The repository list also survives a failed read of its secondary App list, which now degrades the add panel instead of the page. The review-settings tab names the App the repository is bound to and says that changing it is planned.
- **The App-owned schema now uses the bot vocabulary**: `github_apps` became `review_bots`, the tables it owns took the `bot_` prefix (`bot_installations`, `bot_workspaces`, `bot_provider_keys`, `bot_model_config`, `bot_model_roles`, `bot_model_chains`, `bot_model_chain_seats`, `bot_custom_providers`, `bot_custom_provider_keys`, `bot_provider_models`), and the `app_id` column on every table that records which bot acted is now `bot_id`. The three indexes that still named the App were recreated as `idx_reviews_bot_id`, `idx_webhook_deliveries_bot_created` and `idx_pull_requests_bot_pr`. Nothing else changed: no row was rewritten and no table was rebuilt, stored credentials and webhook URLs stay valid because the encryption AAD strings and public paths keep their old spelling, and `app_owner_allowlist` keeps its own name and column.
- **The deploy replay follows the rename**: the App-attribution repair every deploy replays moved from the historical `migrations/0027_workspace_backfill.sql` to `scripts/workspace-backfill.sql`, expressed against `review_bots` / `bot_workspaces`. `0027` still runs in the migration chain on a fresh database, and the zero-orphan gate's repair pointer names the new file.
- **Review configuration now lives on a workspace-owned review target**: a bot is the execution identity — its GitHub App credentials, model chain, sandbox image and installations — while a new `review_targets` row owns the trigger mode, review depth, Check gate, owner allowlist and the business pause. The migration gives every existing bot exactly one target, copying its settings, workspace and soft-delete stamp, so the product does not change: the same list, the same detail page, the same values, the same review outcome, and webhook URLs still keyed by the bot id. The bot row keeps an operational pause that is reset to clear, so the effective pause is still the old flag and a settings resume is not blocked by a stale copy of it. The owner allowlist moves onto the target (`target_owner_allowlist`) and the old per-App table is dropped; reviews and pull requests gain a nullable `target_id`, and the pull-request ledger's uniqueness moves from the bot's `(owner, repo, pr_number)` to the target's. Queued comment-trigger claims are rewritten to the new job shape — `botRef` plus `targetId`, no `appRef` — because the sweep resends the stored JSON verbatim. Every step is guarded: a bot without a workspace row, a bot with anything but one target, a review or ledger row left unattributed, or a rewritten claim without a target fails the migration instead of skipping the row.

### Fixed

- **The `mstar-inspector review` Check no longer claims a review is running before it starts**: the run is created `queued` when the webhook is accepted, and the review's own begin promotes it to `in_progress` with a one-line summary naming the commit — so the PR's checks list and merge box, which read only the run's name and status, show a queued run during the wait behind the previous review instead of a green-less `in_progress` that looked stuck. The promotion is bounded by the configured check update budget, never the begin hook's 2 s, and a failed promotion is one warning: the review runs either way. The held-check relabel still only rewrites the summary, which now stays truthful because the run is already `queued`.
- **A model with no catalog size and no typed size now saves**: the model dialog used to refuse the save when neither the model catalog nor the form supplied a context window or a max token count, so a declaration on your own endpoint — which never borrows the vendor's numbers — could not be saved for a model the catalog does not size. The save now lands: the model is stored as unstated and the runtime's own default applies. A catalog size is still pre-filled and labelled with its snapshot, and a stated size must still be a positive whole number, so a typo is still named instead of stored.
- **A provider card's model count now reports what the App actually runs**: the count and the model-id disclosure follow the stored declaration, which is the same list the 编辑模型 dialog seeds from. The catalog snapshot's per-protocol vocabulary is only the prefill for a provider the App has not declared yet, and that case is now labelled as the catalog's vocabulary instead of being passed off as the App's. Before this, a snapshot that was both stale and spelled in an older dialect made a provider serving 104 models report 50 (`I-000644`).
- **A declared provider's model list can be synced from the provider's own endpoint**: 同步模型 on the provider card asks the declaration's `/models` URL for the vocabulary it serves now, shows the replace arithmetic (how many stored ids it keeps, how many it adds, how many it drops), and — only then — replaces the stored list. The credential is optional: several template providers publish their directory unauthenticated, so a stored key is presented when the pool has one and the request goes out without one when it does not. Ids are stored verbatim (no prefix added or stripped: one vendor serves `org/Model` ids on its chat endpoint and bare ids on its messages endpoint), an id is dropped only when the provider's own `supported_endpoints` says the declaration's protocol cannot reach it, and a provider error, an empty list, a key-mandatory endpoint, or a list past the 128-entry bound each leaves the stored list untouched.
- **Model-chain rows can be reordered**: each row carries move-up / move-down controls, disabled at the chain's ends. A move swaps adjacent entries in the unsaved local array, so the existing save persists the new order — no route or schema change — and the row keeps keyboard focus after the swap (`I-000645`).
- **A provider with no catalog row no longer implies its sizes are unsavable**: the model dialog showed two blank size fields under a "these sizes come from the catalog snapshot" line for every provider the vendor directory does not describe, which read as "the catalog has not loaded" rather than "there is nothing to load". It now states that the provider has no catalog sizes and that a blank field saves as unstated, with the runtime's own defaults applying. A partial set already saved as-is — the server skips an absent size before any shape check — so neither field was ever a precondition; a test now pins that, one field at a time.
- **The add-key dialog says what actually failed**: every non-2xx answer and every unparsable body used to collapse into one "unexpected response" sentence, so a permission problem, a retired App, a shared bot and a provider refusal all read the same. The dialog now resolves the status first and the body second: 400 keeps the provider's own per-reason faces, 403 separates a shared bot from a non-manager, 404/409/429 name their own cause, and 500 splits a missing `DASHBOARD_ENCRYPTION_KEY` from a rejected write. None of the new sentences echo the key, the response body or the status code.
- **A declaration's catalog sizes now follow the provider id, not the base URL**: one provider can be documented under three different endpoints (a saved declaration, the catalog row, models.dev), and the old equality gate then left models the vendor table sizes with no context window and no output cap at all. A model's sizes are the model's, so the id alone resolves them now — a declaration on any endpoint, the vendor's or the operator's own, gets that row's numbers, and an id the catalog does not carry still gets nothing. The model dialog pre-fills under the same rule.
- **One behavior is given up**: a declaration on the operator's own endpoint that reuses a catalog id now inherits that row's sizes (it inherited nothing before) — a private deployment that needs its own numbers needs a provider id of its own.
- **A recheck round is fitted to the seat's context budget instead of being skipped whole**: the seat's ask is now sized to `review.recheck.assignment_max_bytes` (absent-row default 65,536 B, range 8,192–262,144 — still the only adjustable cap). Previously a long-lived pull request whose open findings plus discussion exceeded that budget produced `skipped: budget (config)` on every round, so no finding was re-assessed and the conversations of already-addressed findings never resolved. Now the findings ride in rotation order until the budget is reached: the rows that fit are sent, every remaining row is accounted `budget` (never sent, never attempted), and the rows the budget could not fit keep their place in the rotation, so the next round prefers them and no row starves — every other selected row (one the catalog could not prove, or one a round with no captured context never offered) keeps advancing, so nothing can park at the head of the rotation either. A finding that does not fit whole still ships when it heads the rotation — with its original body bounded and marked `[... body truncated ...]` and as much of its own evidence as still fits, row id, title, file path and line anchors unchanged — so an oversized head is bounded instead of skipped; a row behind it that does not fit waits its turn and is rescued the same way once it reaches the head. The one case the fitting cannot serve is a budget too small for even a minimal document — the head's fixed fields plus the discussion, with no body and no catalog: then the round sends nothing, starts no seat and records no failure, and that head stays `budget` until `review.recheck.assignment_max_bytes` is raised or the ask shrinks. A thread whose finding was not sent is never offered for resolution. A round that no fit can reach sends nothing, starts no seat and records no failure, exactly as before.
- **The App detail and review-usage reads parse again.** Two parsers still demanded fields the worker had stopped sending — the retired owner allowlist plus its `owner_overlap` flag on the settings face, and a `quota.month` the credit block never carried — so a valid staging payload failed the parse and the page fell into its load-failed face. Both requirements and the dead park rendering they fed are gone; every other check, the blocked/reason pairing and the target-id rules included, still fails on genuine drift.
- **The model-chain editor's action row anchors to the panel's trailing edge** (`I-000647`). The picker, 加入模型链, 保存模型链 and the draft's discard share one right-aligned wrapping row, so the controls can no longer run past the container's edge at any width and 保存模型链 stays the row's primary face.
- **A seat and the chain it runs on are one row** (`I-000648`). 席位链 renders one identity-plus-select row per seat, separated by hairlines, with the role caption on the identity side; 保存席位链 is the section's own trailing action instead of trailing the last seat. The control's behaviour is unchanged.
- **The 投递状态 tab no longer reports "no deliveries" while its first read is in flight** (`I-000649`). The table, its empty state and the pager range appear only once a page resolves; the in-flight frame shows the loading line alone.

### Added

- **The App detail's 已安装 tab lists the App's installations.** Each live installation is one row — account, installation ID, last sync and state — in the same table the rest of the dashboard uses. The figure in the header band counts the same list, so the two can never disagree, and an App with no installation says so instead of showing an empty table. The install link and the pending-binding entry stay above the list.
- **Removed installations keep their own face.** The list covers the App's live installations; when GitHub no longer has an installation the install block above states that reviews have stopped for it, rather than leaving it to be inferred from a row's absence.
- **The workspace settings card shows the month in credits, with the RP detail and the version that governs it.** The credit block sits above the published-review counts: credits primary (two decimals, divided by the profile's own `rp_per_credit`), the integer RP pair beneath it, the shared-bot / BYOK split under that, and the quota version that judged the month. At or past the ceiling the used/limit pair stays and one banner states the consequence — new reviews are refused until the next UTC month, or sooner if an operator moves the workspace to a larger plan — and that a review already started still finishes. `self-hosted` renders no credit block: it has no ceiling to report.
- **One sentence now says which counter each figure reads.** Credits weigh the same started reviews the members page counts as attempts; the review counts on the card are published reviews. The three counters differ by construction, and the card says so instead of leaving two look-alike numbers side by side.
- **Operators get a quota-versions screen.** Every version with its interval (derived from the next version's start), the one judging this month, and anything scheduled. A new version copies the current numbers, and publishing appends it — an existing version is never edited.
- **Publishing requires an impact preview.** Before a version can be created, the screen must show how many live workspaces today's usage would already put over the new ceilings, and the first 1st the version judges. Editing any number invalidates the preview, so a stale count cannot be published. The count is a tightness check, not a forecast: a version published mid-month judges from the next month's 1st.
- **The usage ledger records which source paid.** `usage_events.source` (`byok` or `shared`) is written in the same statement that records the RP price, so the card's split is a recorded fact rather than an inference. Rows written before the column keep a NULL source: they count in the month's total and in neither split.
- **The add-repository dialog has a search filter.** An App installed on "All repositories" grants hundreds, so the list is now filtered on its `owner/name` label as you type. The unfiltered list stops at 40 rows and says how many repositories there are; a query shows every match with its count, and a query that matches nothing says so in place of the list.

## [1.0.0-rc.4] - 2026-11-14

### Changed

- **Harness 4.6.0 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.6.0`, `packages/runner`'s exact pin to `4.6.0`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `109922bb7d4cae3b87956e7c14576500cdca25cf`, tag `v4.6.0`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. 4.6.0 adds Guard 13/14, the `skill-corpus-audit` variant, Depth and Spec-Fidelity lenses on QC1, one-round frontier `clarify`, skill completion-criteria guidance, Evidence / Merge-danger on the PR body, and mechanical/judgement audit-finding classification. This repo's declared corpus layout and consumed review/seat contract are unchanged by the pin bump.
- **Harness 4.6.1 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.6.1`, `packages/runner`'s exact pin to `4.6.1`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `8ff83b33141b67a353886d5ac18457ba08cc4dd5`, tag `v4.6.1`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. 4.6.1 is a harness-internal patch: the dashboard generated asset is a gitignored build output again, `--adopt` redacts pasted credentials, the Linear label-discovery recovery names the real repair, `plan.bind`'s caller-identity refusal is host-neutral, and the harness pins bun 1.4.4. This repo's declared corpus layout and consumed review/seat contract are unchanged by the pin bump.

### Fixed

- **A save in flight is announced, not just spun**: while a settings or operator card's save button is working, a live region tells a screen-reader user that the save is in progress. Success and failure announcements are unchanged.
- **The consumer test suites no longer share one mutable harness**: each test file owns its own recorders, so one suite's cleanup can no longer clear another suite's evidence and a slow module load can no longer turn every assertion into `undefined is not a function`. Test-only change; no runtime behaviour moves.
- **A queued Check says so, and a held delivery retries in minutes.** When another review is already running for the same pull request, a new commit's delivery is refused by the per-PR guard and retried; its Check was attached at webhook time, so it used to read a bare `in_progress` for the whole backoff (observed on staging: 41 of one run's 49 minutes were queue time). It now carries "Queued — the review in flight for this pull request (head <sha7>) holds the slot; this commit starts when it finishes", with the status untouched, and the retry schedule ends in short rungs — 60 s → 300 s → 300 s → 900 s → 900 s by default, 90 s → 480 s → 300 s → 900 s → 900 s for `deep` — whose cumulative sum still covers the in-flight lock. The worst-case queue wait drops from the 35 minutes a single long tail cost to at most 15 minutes, and typically five or less: the first rung after the live review releases the lock is the one that starts the review. The queue's retry budget grows with the schedule, so the last rung still ends in a clean ack rather than the DLQ.
- **The dashboard document speaks the language it is written in**: a `zh_CN` workspace shell now declares `<html lang="zh-CN">` and a localized page `<title>` instead of shipping Chinese copy under `lang="en"`, so screen readers use the right speech engine and browser tabs distinguish pages (WCAG 3.1.1, 2.4.2).
- **The sidebar is a navigation landmark, and the shell has a skip link**: the left navigation is now reachable as a named `navigation` region, and the first focusable control jumps straight to the page content.
- **A client-side navigation announces itself**: moving between Apps, Members and Settings rewrites the document title and moves focus into the content region, so keyboard and screen-reader users learn that the page changed.

## [1.0.0-rc.3] - 2026-11-13

### Changed

- **Harness 4.5.3 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.5.3`, `packages/runner`'s exact pin to `4.5.3`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `bc33a78c6d4fbc079c3e954833ae0bdc93a1ac3c`, tag `v4.5.3`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. 4.5.3 is a documentation, packaging and harness-internal release (the accepted-limits ADR is implemented with no behavior change; release prep now packs built CLI/OpenCode dist; the consumer-manifest digest gate and advisory artifact-byte comparisons are removed; `calibrate` missing-artifact errors go through the artifact helper). This repo's declared corpus layout and consumed review/seat contract are unchanged by the pin bump.
- **Model sizes come from the catalog, not a hand-typed ritual**: the model picker pre-fills each model's context window and max token count from the provider catalog's snapshot. A value the operator leaves untouched is labelled with its snapshot and is not posted back as an override; only a model the catalog does not cover still asks for both sizes. A save whose sizes all come from the catalog stores no override field.
- **The size copy now states the effect, not a disclaimer**: the required-size line says what the two numbers set (when context gets compacted, how long one reply can run), and the incomplete-declaration note names the missing facts and the next step. The "we do not guess" wording is gone from both locales.
- **The sandbox image no longer declares a provider or a model**: the image registry is build inputs only. The per-review `models.yml` is synthesized from the App's own provider declarations, and a built-in provider resolves from the runtime's own catalog. The test fixture that had been shipped as a product capability host is gone; an App's model chain must name a provider it actually configured.
- **A chain that still names the retired `ark-plan` provider now says what to do**: it fails with "the ark-plan provider was removed — point the chain at a provider the runtime serves" instead of a bare "no configured key". Verified-model evidence the previous release wrote under the alias still reads as the `ark` pool's own, so that App's settings list does not silently empty. No data rewrite is performed: the runner declares no provider for the old prefix, so the selector must be pointed at a built-in catalog provider (with its key configured) or a custom declaration — `docs/deploy.md` carries the step.

### Fixed

- **Incremental reviews no longer absorb the base branch's merged commits**: a round uses the previous reviewed head as its delta only when the compare gate answers `ahead`, the range carries no merge commit, and the commit list is complete. A PR branch that merged its base into itself ("update branch") previously handed the base branch's whole changeset to the review seats as this PR's "work since the last review" and reported findings about code the PR never touched (observed on PR #268: `fb75d4d...1352814` answered `ahead` with one merge and 62 files, all from a separately merged PR, while #268 changed 9). Such a round now reviews the full PR diff and logs one `increment_status: "ahead-merge"` line; an exit-0 answer that is not the gate's JSON logs `increment_status: "unusable"`.

## [1.0.0-rc.2] - 2026-11-13

### Fixed

- **Installations match GitHub again.** An `installation.deleted` delivery now marks that installation removed instead of being dropped, so the App settings' installed list stops showing it; a later reinstall makes it appear again. A missed delivery is repaired by the existing GitHub metadata refresh, which now also reconciles the App's installation list with GitHub.
- **Any configured provider can take another key**: the App settings add-key flow no longer refuses a `template`-tier or custom provider — its key is verified against that provider's own declaration (the base URL, protocol and model ids it was declared with) and appended to the same pool, so a provider with a single key no longer has to be re-declared to hold a second one. A provider the App never declared stays refused, with the copy naming it.
- **Model details fold away in the model picker**: the dialog now shows the search field, the model list and the save controls by default; an "Edit model details" control opens one model picker and that one model's fields, so selecting several models no longer fills the dialog with empty form rows. What is typed for one model survives switching to another.
- **Mixed-protocol providers are distinguishable in the provider picker**: a provider that ships one row per protocol (e.g. OpenCode Go, Command Code, ZenMux) now names the protocol in each row's label instead of showing identical entries.
- **Addressed findings now close their GitHub conversations again**: the app's own published finding report no longer counts against the review model's discussion budget, so a thread whose root comment is that report is not marked truncated just for containing it — a thread with one human reply stays eligible to resolve. A human comment still counts in full, and a reply that spoofs the bot marker stays visible.
- **Comments survive GitHub re-anchoring**: when code above a review comment moves and GitHub keeps the thread valid at a shifted line, the thread is still recognised as ours through the line it was originally published on. Threads that are outdated, point at another file, or carry a different original line stay unrecognised.

### Changed

- **Save feedback rides the button**: a settings save now answers where the user is already looking — the save button shows a spinner while the write is in flight, a check on success (reverting to the plain label after about two seconds) and an alert on failure — instead of leaving a full-width "Changes saved." notice box on the card until the next navigation. The success sentence is preserved as assistive text announced by a live region, and a failed save keeps its persistent, readable error notice alongside the button's error face. Success notices that remain on the op-outcome channel now expire on their own after about three seconds; warnings and errors stay until the next op replaces them.
- **Production is served through Workers Routes.** The production Worker no longer holds a Custom Domain on `inspector.mstar.page`; it answers five specific patterns on the `mstar.page` zone (`inspector.mstar.page/dashboard*`, `inspector.mstar.page/_internal_admin*`, `inspector.mstar.page/webhook/*`, `inspector.mstar.page/healthz`, `inspector.mstar.page/app-assets/*`), which leaves the hostname root to the marketing site. The hostname now needs a proxied DNS record of its own — routes never create one.
- **The SPA bundle moved to `/app-assets/`.** The build emits `dist/spa/app-assets/`, and `/assets/*` and `/index.html` now belong to the marketing site on this hostname.

## [1.0.0-rc.1] - 2026-11-13

### Added

- **Per-key usage action in App settings**: every stored model-provider key row now carries a usage action that asks the provider's own quota endpoint with that key and answers, in one dialog, both whether the key is still accepted and what remains of its allowance — a window's remaining share with its reset time, or an account-wide balance, labelled as shared so several keys drawing on one pool do not read as separate allowances. Coverage is limited to providers whose quota endpoint accepts a plain API key: Command Code, OpenCode Go, Z.AI/Zhipu, the MiniMax token plan, ClinePass, Synthetic, Umans, Charm Hyper, Kimi for coding, and Cursor through its API-key usage route alone. A provider whose usage surface is OAuth-only is not covered and shows no usage action — Cursor's OAuth surfaces included — and neither does a provider with no quota endpoint. The dialog probes when it opens, and its refresh control probes the provider again — nothing is cached, so every look reports the key's state at that moment.
- **App detail page with 应用设置/洞察 tabs**: `/dashboard/apps/:slug` hosts an identity header (slug, status, creator) over a two-tab shell — the settings content becomes the 应用设置 tab and a new 洞察 tab serves per-App insights; the legacy `.../settings` URL remains a deep link onto the settings tab, and Apps-list rows now open the detail route.
- **Per-App insights API**: `GET /dashboard/api/apps/:slug/insights/summary` serves the full insights aggregation scoped to one App (member-gated, creator-or-admin for the data face); the cross-App global endpoint is retired with no compat shim and answers 404, and the SPA's standalone global insights page is retired with it — insights now live on the App detail page.
- **Non-manager face narrowed**: a member who is neither creator nor admin receives an identity-only payload (public profile + creation time, `can_manage: false`) — the ops stores and settings payload stay manager-only, and the 洞察 tab renders for managers only.
- **Incremental review rounds**: when the pull request's previous reviewed head is an ancestor of the new
  one (GitHub `compare` → `ahead`), the seats review the `since <base>` delta instead of the whole PR, and
  the comment header marks the round with `· since <sha7>`. The prior-findings evidence catalog still reads
  the full PR diff, and any other compare verdict (or a force-push 404) keeps the full-diff round.
- **Complete review reports**: where a round could capture its PR context, the published comment now
  carries what the envelope cannot — a `**What this PR does**` overview, a mechanical
  `### Revalidated findings` table, `### Linked-issue AC`, `### ✅ Verified`,
  `### 🗑️ Considered & rejected`, and a collapsible `## 🛠️ Plan to fix`. These ride a side document
  (`mstar.report/v1`) written by a bounded report seat, validated fail-closed by the Worker, and rendered
  as `none` when unavailable. The `deep` tier never publishes that document: the queue window leaves no
  room for the PR-context capture next to its own runner budget, so `What this PR does` is omitted and
  `Linked-issue AC`, `Verified`, `Considered & rejected` and `Plan to fix` publish `none`.
  Report text cannot fold, fence or re-head the comment: headings, thematic breaks, code-fence lines and
  raw HTML are neutralized before insertion, and the fix plan stays fenced as code.
- **The report is bound to the reviewed head**: the side document carries the reviewed `headSha`, written
  by the runner from the envelope rather than the seat, and the Worker refuses a document bound to any
  other head — a report a skipped seat left behind in the container can no longer speak for a later
  review. A missing seat definition or an unbound envelope degrades to `none`, never a failed review.
- **Prior findings render once**: the in-body `### Revalidated findings` section carries the full §7.10
  rendering (coverage line, per-row disposition, evidence, thread and the display cap), so a report body
  publishes exactly one prior-findings table instead of a second, folded copy beneath it.
- **Increment bases and report context are bounded**: two Apps on one installation never share an increment
  base — only the reviewing App's own last reviewed head can bound the delta — and the best-effort PR
  context is skipped with one named log line when the round no longer has the wall clock it costs, so a slow
  sandbox cannot spend the review's window on narrative. The capture gate reserves the level's own runner
  budget as well, so a capture that fits but would starve the paid run is skipped too. An eligible increment
  base whose `base...head` is genuinely empty is nothing to review: the delivery is acked with one structured
  line, no review body and no `context_incomplete` row, and its Check inherits the reviewed head's gate result
  against the current gate (`success`/`failure`, naming that head and its verdict/score) instead of ending in a
  free-standing `neutral` — an empty commit cannot replace the reviewed head's failing required check; an
  unreadable baseline result (missing row, unparseable envelope, missing score) fails the check closed
  instead of going `neutral`. The
  report document's byte bound is derived from its per-field character budgets, so a document that honours
  every budget can never be rejected.
- **`may-fix` merge class**: engine 4.2.2's finding class between `should-fix` and `nit` now reaches every layer that carries a class — the review tally and the finding cap rank it, the PR detail's findings filter offers it, the insights distribution zero-fills it, and the severity chart plots it as its own series — so a review that emits `may-fix` no longer drops the finding or misreports the distribution.
- **Pull-request ledger toolbar**: the App's Pull requests tab gains a repository filter and a refresh control. The filter runs on the server inside the ledger's bounded window, so a repository whose PRs all sit behind the newest 200 rows is still reachable once selected; the option list is the App's whole distinct repository set and never narrows with the current selection.
- **Real App avatar and availability badge**: the App install panel now shows the App's real GitHub avatar (the cached column, or the URL derived from the App id; the octocat placeholder only after a CDN miss) instead of the generic GitHub mark, and the Installed tab's table gains an availability column that grades each installation against the stored owner allowlist — valid when the allowlist is off, otherwise only for an account on it.
- **Release-gated production environment**: a **non-prerelease** release now deploys a second Worker, `mstar-inspector-production` at `https://inspector.mstar.page`, with its own D1, KV namespace, queue pair (`review-queue-prod` / `review-dlq-prod`) and container application; nothing is shared with the staging Worker `mstar-inspector` (`mstar-inspector.42ch.dev`), which keeps deploying on every push to `main`. The Release workflow starts that deploy by dispatching the production workflow on the tag — a Release published with the workflow's `GITHUB_TOKEN` triggers no `release: published` run, so the explicit dispatch is what starts the deploy for that Release, and the release job needs `actions: write` for it (a Release published by hand instead deploys through the retained `release: published` trigger, whose job-level tag guard skips a prerelease tag). The automated chain never dispatches a prerelease (`-` in the tag) to production; a manual `workflow_dispatch` on a tag ref **may** deploy one — that is how the first bring-up happens (on a tag cut **after** this change ships: the older `v1.0.0-alpha.2` predates the workflow), and rollback dispatches the same way (`gh workflow run deploy-prod.yml --ref <tag>`). The production workflow takes no `ref` input, so a run deploys exactly the tag it runs on and the run's ref is the deployed checkout (a non-tag ref is refused before any mutation).
- **Release evidence names the production run**: each GitHub Release's *Deploy evidence* section now resolves the production deploy run for the tagged commit instead of the staging run.
- **Production bring-up documented**: `docs/deploy.md` gains a Production environment section (the two deploy paths, the one-time Cloudflare + GitHub `production` environment runbook — carrying a deployment policy that allows `v*` tags only, because a branch-only policy rejects tag-ref deployments — the extra OAuth callback URL, how the deployment-level operator allowlist is supplied to the production Worker, the `env.production` duplication maintenance rule, and rollback), `docs/release.md` describes the production deploy, and `.env.example` states the environment scoping (shared repository variables, per-environment secrets).
- **Several API keys per provider**: an App can now store multiple keys for the same provider from dashboard Settings — each row shows its own last4, verification state and updated time, and can be deleted individually (up to 8 keys per provider). Re-submitting a key that is already stored re-verifies that row in place, and an App with a single key behaves exactly as before.
- **The sandbox rotates across an App's keys with omp's own credential pool**: the review container receives the App's keys over the runner's stdin pipe and hands them to the review agent's own credential store, so a rejected or rate-limited key falls through to the next one, with per-credential backoff and session affinity, instead of the run being pinned to a single key.
- **Upgrade note for the per-key model evidence**: migration `0025` deliberately does not carry the previous aggregate model cache forward (it cannot say which key contributed which model). An App whose provider was verified before the upgrade shows the probe-only face — an empty model dropdown — until **every** current key of that provider is re-verified and the per-key reports share at least one model, because the offered set is the intersection over the current pool. The loss is self-healing and touches only that rebuildable derived cache: credentials, provider declarations, model chains and seats are untouched.
- **Per-App review gate — the Check now reports a gate, not execution
  completion.** The `mstar-inspector review` Check run concludes `success` only
  when the published review's verdict is one of the App's passing verdicts
  **and** its tally score is at least the App's floor; the defaults are the
  verdict `ship it` and a floor of 60; an App connected from now on starts at
  its workspace's default (60 unless the workspace chose another), while an App
  that predates the change keeps the floor it already stored — every App that
  existed when the gate column was added carries the 80 that migration `0045`
  materialized, and nothing moves it to 60. A confirmed degraded
  publication, an unconfirmed or expired attempt, an execution failure, a
  published review below the bar, an unreadable App gate and a published review
  without a readable tally all conclude `failure`; `neutral` is no longer
  produced (it survives only in historical rows). The review is read by the
  attempt's own publication id, so a row belonging to another attempt for the
  same commit cannot decide it, and a missing payload fails the gate instead of
  falling back to that row. The summary names the verdict, score, floor and
  allowed verdicts whenever the gate decided the outcome; the run still
  carries no `details_url` and is still never an approval or a merge gate.
- **The gate is App configuration on the settings page.** A *Review gate*
  section saves the floor (a whole number 0–100) and the set of passing
  verdicts (the engine vocabulary: `ship it`, `needs fixes`, `blocked`,
  `incomplete`). An off-vocabulary verdict or an out-of-range score is a keyed
  400 with zero writes. An empty verdict set is legal and fails closed — no
  review can ever pass, and the page warns before saving. A change applies to
  the next Check with no deploy. Migration `0045` is additive: existing rows
  materialize the defaults, so no backfill or settings visit is needed.
- **The floor a new App starts at is a workspace setting.** The workspace
  settings page gains a *Review gate default* card (`workspaces.check_min_score`,
  migration `0049_workspace_check_min_score.sql`); connecting an App seeds its
  floor from that value, and the platform default is 60. Existing Apps keep
  their own stored floor — the workspace value is a default, not a backfill —
  and the per-App *Review gate* section remains their writer.
- **Owner allowlist on the Installed tab — off by default.** With the switch
  off nothing is filtered: every owner is reviewed as before. With it on, the
  App reviews only deliveries whose `repository.owner.login` it lists, on the
  `pull_request` trigger and the `issue_comment` mention alike; logins compare
  case-insensitively and a case variant collapses onto the first submitted
  spelling. The list is replaced on every save, accepts at most 100 owners, and
  each entry must be a valid GitHub login — otherwise a keyed 400 naming the
  offending entry, with zero writes. An enabled list that is empty is legal and
  refuses every owner (fail closed), and the page warns before saving.
- **A refused delivery leaves no trace.** An unlisted owner is answered `200`
  — a policy outcome, not a retryable error — with no `webhook_deliveries` row,
  no PR ledger row, no `last_webhook_at` touch and no enqueued job; the only
  record is one structured warn whose event is `owner_not_allowlisted`.
  Refusals never reach the delivery ledger, so that log line is the only
  evidence a delivery was refused rather than lost.
- **Allowlist reads fail closed.** An unreadable allowlist — a thrown read or a
  row that vanished after the App lookup — refuses the delivery with `500` and
  those same zero writes, so GitHub retries instead of the delivery slipping
  past an unapplied gate (`owner_allowlist_read_failed` /
  `owner_allowlist_row_vanished`). The read runs for every classified delivery
  that carries a repository owner, on and off alike, so an outage now costs
  delayed deliveries where nothing used to be read at all. A payload with no
  readable owner (an install event, a malformed body) cannot be judged and
  proceeds.
- **GitHub App visibility is probed and cached, never enforced.** Whether an
  App is public or private has no authenticated API field, so the dashboard
  probes it anonymously — `GET /apps/{slug}` with no credentials, a 3-second
  budget and no retries: `200` stores `public`, `404` stores `private`, and any
  other answer keeps the stored value, whether the probe ran on the
  metadata-refresh path or was forced by enabling the allowlist. The cached
  `github_visibility` only adds a note under the allowlist control; `404` also
  answers for a missing or renamed slug, so `private` is a UI hint and never
  gates admission. The control renders for every cached value — including a
  private App — because hiding it would leave a live filter unmanageable. An
  App never probed reads `unknown`, which means "cannot prove private".
- **The release version moves to the platform console.** The tenant dashboard
  no longer renders a version footer; the platform console's Runtime screen
  shows `Version vX.Y.Z` from the same build-time constant as `/healthz` and
  the release tags, in every read state of that screen.
- **Per-App review trigger modes**: each App now chooses when PR reviews run automatically — `open` (the first opening event only), `every_push` (the default; today's behavior unchanged), or `manual` (never auto-triggers) — via a segmented control in App settings backed by a new pinned settings action; existing Apps keep their current behavior.
- **@bot-mention comment trigger (BREAKING — `/review` is retired)**: commenting the App's `@<slug>` mention on a PR now requests a review; the `/review` command no longer does anything, with no alias and no deprecation window. The mention fires only for the PR author or a repository owner, only on a PR thread, never from a bot account, and never on a PR opened by a `[bot]` login; any other comment does not start a review. The exact mention string renders beside the control as a single copyable snippet.
- **Workspace settings page.** The sidebar gains a **Settings** entry (`/dashboard/<ref>/settings`) carrying the workspace URL (slug) rename, moved out of the App settings tab so there is one editor rather than two. The rename stays owner-only: a non-owner sees the refusal copy instead of a form whose save would 403. The sidebar also spans the full viewport height.

### Changed

- **Installations get their own App detail tab**: the installations table and the recent deliveries move off the settings tab into a manager-only 已安装 / Installed tab. Deliveries now list up to 10 rows (was 5) and each names its source repository — `owner/name` from the new nullable `webhook_deliveries.repository_full_name`, with rows written before migration `0043_webhook_delivery_repository.sql` rendering the unknown-repo label.
- **PR detail links out to GitHub**: the PR number in the header and the repository in the aside are now links to `github.com`, opened in a new tab with `rel="noopener noreferrer"`.
- **PR detail records load one page at a time**: findings, reviews and failures are fetched per section on demand (default 10 rows, server-enforced max 50) instead of arriving with the header; the detail payload returns `{ pull_request, counts, latest_review }` and each section `{ items, total }`, so the family tabs count from the head counts and prev/next move the page. Findings add a severity filter whose filtered total drives the pager. The counts carry the PR's own must-fix tally, so the findings tab's danger dot and the "N must-fix" note beside the findings figure describe the PR — a severity filter or a later page can neither clear the dot nor change the note — and an empty PR opens on the reviews tab (records first, history last).
- **App detail page polish**: back-to-apps wayfinding moves into the page shell above the identity header (serving both tabs); the tab bar adopts the line-tab face — full-width triggers on a 40px bar over a bottom hairline, with the active underline seated on the hairline; a manager's `?tab=insights` deep link lands on the insights tab on first paint (no settings flash), and the initial insights fetch shows a polite loading line instead of a bare filter toolbar; the settings identity group eyebrow is relabeled "App info"（应用信息）.
- **Runtime and toolchain pins refreshed** (Dependabot-driven): `wrangler` 4.125.0 → 4.147.0, `vite` 8.2.2 → 8.3.2, `@cloudflare/workers-types` 5.20260825.1 → 5.20261005.1, `@types/bun` 1.4.0 → 1.4.2, `@vitejs/plugin-react` 6.1.1 → 6.1.2, `lucide-react` 1.40.0 → 1.52.0, `tailwind-merge` 3.6.0 → 3.7.0, plus `react` / `react-dom` 19.2.7 → 19.3.0 (with `@types/react` 19.3.0) and `zod` 4.4.3 → 4.6.5. Every pin stays exact (no `^`).
- **TypeScript 5.9.3 → 7.0.2** with the configuration migration it requires: both `tsconfig.json` and `tsconfig.spa.json` drop the removed `baseUrl` and write their `paths` targets relative to their own file (`"@/*": ["./src/spa/*"]`) — TypeScript 7 rejects a bare target with `TS5090`.
- **Dependabot refresh, second batch** (2026-10-16): `hono` 4.13.4 → 4.13.13, `@octokit/auth-app` 8.3.0 → 8.3.1, `@cloudflare/workers-types` 5.20261005.1 → 5.20261016.1, `wrangler` 4.147.0 → 4.151.0, `vite` 8.3.2 → 8.3.4, `@types/bun` 1.4.2 → 1.4.3, `@types/react-dom` 19.2.5 → 19.3.0, `lucide-react` 1.52.0 → 1.57.0, plus the nine `@radix-ui/*` component packages (`react-dialog` 1.1.23 → 1.3.1, `react-dropdown-menu` 2.1.24 → 2.2.1, `react-select` 2.3.7 → 2.4.1, `react-separator` 1.1.15 → 1.2.0, `react-slot` 1.3.3 → 1.5.0, `react-tabs` 1.1.21 → 1.2.1, `react-toggle` 1.1.18 → 1.2.1, `react-toggle-group` 1.1.19 → 1.2.1, `react-tooltip` 1.2.16 → 1.4.1). Every pin stays exact (no `^`).
- **BREAKING — one deployment shape variable, one tenant read path.** The v1.2
  tenant mode is deleted end to end: no reader, no validator, no workflow
  dispatch input, no `--var`, no `env.production.vars` entry, no replay guard.
  Tenant reads are unconditional — every execution-facing App read INNER JOINs
  `app_workspaces`, and `/dashboard/<workspace-slug>/apps…` is the only App
  route family, so the pre-workspace root paths (`/dashboard/apps…`,
  `/dashboard/api/apps…`) answer 404. **Upgrade note:** delete the now-unused
  `WORKSPACE_TENANT_MODE` GitHub Actions variable and any `tenant_mode=…`
  dispatch habit; nothing reads either, so no leftover value is worth keeping.
- **New `DEPLOYMENT_MODE` Worker var (`self-hosted` | `saas`)** — the axis this
  replaces is the *product shape*, not the read path. It decides one question:
  whether an instance whose `users` table is empty tells its first signer-in
  the empty-instance story (this login is now an account on this instance; next
  step is workspace creation). `saas` never shows it. Both deploy workflows
  pass `saas` with `--var`, `env.production.vars` carries `saas`, and local dev
  declares `self-hosted`. There is **no default**: unset, empty or any other
  value fails loud at startup with
  `DEPLOYMENT_MODE must be "self-hosted" or "saas", received <value>`, and the
  SPA boot and OAuth-callback faces answer 500 with that text instead of
  serving a guessed shape. The webhook and queue faces never read it, so a bad
  value cannot 404 webhooks or stop reviews.
- **One deploy, not a two-deploy rollout.** The same build no longer needs an
  `off` deploy followed by a `strict` replay on the same SHA/tag, so the
  `tenant_mode` and `expected_deploy_sha` dispatch inputs, the replay binding
  and `scripts/resolve-tenant-mode.sh` are gone. What survives is what protects
  a normal deploy: the run's ref identity is asserted before every
  deploy-capable step (checked-out `HEAD` on staging, `refs/tags/<tag>^{commit}`
  on production, so a moved tag/branch can never deploy), migrations and the
  idempotent `0027` App-attribution repair run before the first
  version-creating step, and the zero-orphan gate aborts before every deploy
  and is re-asserted against the version serving traffic. Rollback is
  `git revert` of the merge commit — the config-level mode lever no longer
  exists.
- **New workspace ownership data plane** (migrations `0026`/`0027`/`0030`): every
  App and dashboard user belongs to a workspace. `0027` attributes existing Apps
  to the `default` workspace and is the only replayable half (both deploy
  workflows re-run it before any deploy-capable step); `0030` backfills the
  pre-open-sign-in users' memberships exactly once, cutover-scoped, because
  replaying a per-person write made every routine deploy re-add every login —
  removed members included — to `default`. Both workflows abort before any
  deploy-capable step when an App is still unmapped.
- **Dark theme is now the deterministic default**: the SPA no longer follows the OS `prefers-color-scheme` light fallback — the effective theme is the stored navbar-toggle choice, or dark when unset; the document body now paints the theme canvas so no unstyled gap surrounds the app. Stored toggle choices still win.
- **Dashboard App URLs now use the GitHub App id (breaking)**: the App detail page and every App-scoped API path are keyed by the numeric `github_app_id` (`/dashboard/apps/{githubAppId}`, `/dashboard/{workspaceRef}/apps/{githubAppId}`). Old links and bookmarks built from the locally minted slug no longer match and there is no redirect. That local slug no longer exists — the column is renamed `webhook_path` and is used only as the opaque webhook route key, so existing webhook URLs keep working unchanged.
- **Apps show their own logo, not the owner's**: the settings identity card and the Apps list now render the avatar of the App's bot account (`GET /users/{slug}[bot]`), because the REST `GET /app` payload has no logo field — the previous image was the App owner's avatar.
- **Managers can refresh the App's GitHub metadata on demand**: a *Refresh from GitHub* control on the settings page re-fetches the cached name, description, settings URL, slug and logo, bypassing the 24-hour lazy refresh, so a rename or a new logo appears immediately. An upstream failure shows a keyed error and keeps the cached values.
- **The bot mention uses GitHub's real App slug**: the settings page displays the bare `@<slug>` mention built from the slug cached in `github_slug` (filled at registration and on every metadata refresh), and shows nothing until that first sync instead of a locally invented name. The mention grammar and its authorization rules are unchanged.
- **App names fall back through GitHub's facts**: the Apps list and settings card render `github_name`, then `github_slug`, then the numeric App id, with the cached App logo beside them.
- **Upgrade step for existing Apps: sync each App's metadata once after deploying**. `github_slug` has no backfill, so right after this deploy every App that already exists answers to no bot mention until its metadata is fetched once — open its settings page **or** press *Refresh from GitHub* — both sync it, because a row whose `github_slug` is still NULL counts as unsynced regardless of the 24-hour metadata TTL. An App on `manual` trigger mode reviews on the mention only and will not review until then. The webhook face logs a structured `mention_unresolved` warn (with `webhook_path` and app id) for a comment that mentioned a login while the App's slug is still unknown, so an unsynced App is visible instead of silently ignoring deliveries.
- **Harness 4.4.0 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.4.0`, `packages/runner`'s exact pin to `4.4.0`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `a6721f5231e74ade74e80af5b1596edc6898f4be`, tag `v4.4.0`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs.
- **Review bodies no longer carry an unverified count**: the engine retired that tally bucket, so the seat wire contract, the seat merge, the parent output contract and the inspector's envelope schema drop it, and a published review body renders only the must-fix / should-fix / may-fix / nit rows. Envelopes already stored keep every field they were written with — reads are not re-validated against the new shape.
- **Harness 4.4.1 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.4.1`, `packages/runner`'s exact pin to `4.4.1`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `e834dce3ff66403463207e267fd4bcf62c8d4d55`, tag `v4.4.1`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. No API change reaches this repo: 4.4.1 only adds the specs/ADR document-layer lints and skill-corpus errata to the harness's own surfaces.
- **Harness 4.5.2 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.5.2`, `packages/runner`'s exact pin to `4.5.2`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `1a6a90c3fe097e618ec6ebd154b630857ad1f3be`, tag `v4.5.2`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. 4.5.0 renamed the completion payload's `qa` carrier to `acceptance` and added an issue `obsolete` disposition on the harness's own surfaces; 4.5.1 moved tracked-corpus defaults to `.agents/<kind>/` (`.mstarc` remains authoritative). This repo's declared corpus layout and consumed review/seat contract are unchanged by the pin bump.
- **Engine 4.0.2 adopted**: `@mstar-harness/engine` 4.0.1 → 4.0.2, which adds the neutral fourth PR-review verdict `incomplete`; both review output schemas now declare the `incomplete` fact, and the deep parent-session yield schema also accepts the engine-emitted tally `band`, so a valid deep review yield is no longer refused for carrying them.
- **`incomplete` verdict with a mandatory fact**: a PR review can now report `incomplete` together with `{ reason, unscanned }` — the declared cause and the scope the run never reached (an empty scope list is legal). The fact is required exactly by that verdict, rejected on every other verdict, and a provided tally must echo it unchanged; both the deep parent-session yield schema and the envelope parser preserve it instead of dropping it. The posted review body renders it as `cause:` / `unscanned:` right below the verdict (and tally, when present), while every other verdict's body is byte-identical to before.
- **Sandbox image harness inputs moved to 4.0.2**: the omp image's plugin clone ref and its preinstalled `@mstar-harness/cli` pin now follow tag `v4.0.2`.
- **Harness corpus moved onto the mstar 4.4.1 layout**: the tracked engineering corpus now splits three ways — `.agents/knowledge/` (experience and reusable patterns, moved verbatim from `.mstar/knowledge/` with history preserved), `.agents/adr/` (one decision per record, with its real alternatives and consequences, under `{bucket}/{class}/`), and `docs/specs/` (current-state contracts on the fixed `Scope` / `Current state` / `Invariants` / `Where it lives` / `Change obligations` skeleton). The old `.mstar/specs/` tree is gone; its normative content survives in the new specs, and its write-retired M1 review-output contract is preserved as an archived ADR.
- **`.mstarc` is now git-tracked** and declares the layout (`knowledge_dir`, `adr_dir`, `specs_dir`), so a clone resolves the same directories without per-host configuration.
- **Specs corrected against the code**: `webhook_path` is gone (migration `0038`; the webhook route is `/webhook/:workspaceId/:appId`), the platform `review_global` brake exists alongside the per-App switch, flag reads are point reads whose worker-side exceptions fail closed, the invite seat guard binds a named `:limit`, refusal copy carries the actual limit, and the pinned `@octokit/auth-app` is 8.3.1.
- **Harness engine 4.2.0 across root and runner**: the root manifest's `@mstar-harness/engine` range moves to `^4.2.0` and `packages/runner`'s exact pin to `4.2.0`; both lockfiles regenerate on the engine graph alone, so no transitive entry moves.
- **Review sandbox image follows to 4.2.0**: the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin and Dockerfile clone ref move to 4.2.0, and the image rebuild marker is touched in the same commit because the runner manifest, the CLI manifest and the pinned ref are image inputs.
- **No operational change from this entry**: the change is version pins, lockfiles, the pin contract and the rebuild marker — no image build, deployment, or smoke was run.
- **Harness engine 4.2.2 across root and runner**: the root manifest's `@mstar-harness/engine` range moves to `^4.2.2` and `packages/runner`'s exact pin to `4.2.2`; both lockfiles regenerate, and `@oh-my-pi/pi-coding-agent` stays at 18.13.3.
- **Review sandbox image follows to 4.2.2**: the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `98504a71dcf09cfb551847b85e81d33e682e0bd9`, tag `v4.2.2`) and Dockerfile clone ref move to 4.2.2, and the image rebuild marker is touched in the same commit because the runner manifest, the CLI manifest and the pinned ref are image inputs.
- **No operational change from this entry**: the change is version pins, lockfiles, the pin contract and the rebuild marker — no image build, deployment, or smoke was run.
- **Documentation housekeeping**: the review runner's recheck docstring now names the shared source tree the sandbox image actually copies (`packages/shared/src`) instead of a retired contracts path, and the production rollback runbook records its D1 restore limitation together with the bookmark an operator must capture before a risky deploy.
- Removed the **Findings by category** chart and the **Recurring findings** table from App detail → Insights. The category axis was an open set of model-authored slugs, so a bucket union was not a comparable metric.
- `/api/apps/:appId/insights/summary` no longer emits `findings_by_category`, `recurring_top`, or `by_category` inside `findings_distribution` rows; the remaining fields are unchanged. External readers of those keys break by design.
- **The platform console is bilingual.** The operator console
  (`/_internal_admin/*`) resolves its header, nav, page copy and empty /
  loading / error states in the operator's language, driven by the same
  `boot.locale` the workspace shell uses. The locale switch is the same
  zero-JS form as the dashboard: one POST to `/dashboard/locale` re-GETs the
  document with the new cookie, and the preference cookie now spans both the
  dashboard and the console paths.
- **Flag toggles confirm first.** Clicking a server flag's switch opens a
  dialog naming the flag, the ON → OFF (or reverse) change and its effect
  before any write; only the confirm button sends the single `PATCH
  /api/flags`, followed by a short inline "Saved." note.
- **Console tables are searchable.** The Users and Workspaces tables gain a
  client-side search input with a shown / total counter — filtering runs over
  the already-loaded rows, with no URL state and no extra request.
- **The support-grant form sits in a real card.** The grant create form
  moves inside `CardHeader` + `CardContent` of its `SectionCard`, matching the
  Support / Settings page structure, instead of the previous ad-hoc wrapper.
- **The deployment operator no longer holds tenant rights.** No deployment-level
  allowlist grants tenant access any more; the new `PLATFORM_OPERATORS` var is an
  allowlist gating the operator console and the support-grant workspace view;
  it grants nothing by default.
  The workspace gate classifies `member → invitee → operator-granted →
  operator-denied → outsider`: an operator who is a member keeps ordinary
  membership rights, one without a live `support_grants` row gets the same 404
  an outsider does, and one **with** a live grant may read only the workspace
  identity fields, the member list (login + role) and `GET
  /dashboard/<ref>/api/support/grants` — where the operator sees only their own
  grant row, while the tenant notice carries the whole live set. App list, App settings,
  credentials, model chains, settings writes, role changes, member removal,
  invites and the audit list all answer 403 to a granted operator.
- **Every grant decision is audited by the gate.** The workspace middleware
  appends exactly one `audit_events` row before dispatch —
  `support.read`, `support.forbidden` or `support.denied` — whenever it classifies
  a request as operator-granted or operator-denied, so a route handler cannot
  skip the record. An operator who is an ordinary workspace member takes the
  member branch and writes no audit row. HTML shell loads (`/dashboard`, `/dashboard/<ref>/apps`)
  are dispatched by `spa-dispatch`, not by the workspace gate, and write no row.
  Grants are time-boxed and evaluated per request from `expires_at`; an expired
  grant behaves exactly like no grant.
- **Tenants can see the window.** Every member of the workspace gets an
  undismissable notice naming the operator, the grant reason and its expiry —
  with no control that ends or edits the grant. `owner`/`admin` can read the
  audit rows through `GET /dashboard/<ref>/api/audit`; a plain `member` gets
  403. The notice is read once per workspace session — the shell survives
  client-side navigation — so a grant that lapses (or appears) mid-session
  changes only after a reload.
- **Pull-request detail: the record pill row now carries the filter, and the aside starts level with it.** The findings severity filter moved out of the findings body into a toolbar slot beside the three-family pill, and the content region became a two-column shell whose right rail tops out on that same row instead of below it — a tall facts/activity rail can no longer push the record list down.
- **Review rows now read as two facts lines**: the round, the short commit (linked to its GitHub commit), the model attribution and the run clock on the first line; the verdict plus one count per finding class on the second (`must-fix 2 · should-fix 1`). Classes outside the current merge-class vocabulary — the older `critical/warning/suggestion/info` rounds — are summed into one trailing **Other** count instead of disappearing, and each row carries its reviewed-at time in a narrow right-hand column.
- **Finding cards**: the round chip moved to the card's bottom-right corner as a small inset pill, so it no longer crowds the title row and reads the same size as a review row's round chip.
- **Pull request detail face rebuilt around a fixed-height first screen**: PR facts and aggregates sit in a header band, findings / reviews / failures become switchable record families behind an embedded segmented pill with their counts, findings are grouped by severity (must-fix expanded, other groups collapsed), the latest review is expanded with its history collapsed, failures show the first error line with the full output behind a disclosure, and an aside (full-width below `xl`, 256px wide at `xl` and up) carries the PR's own facts plus one merged activity timeline. The approved prototype is archived as a design-system reference page (`src/design-system/prototypes/record-detail.html`, a proposal reference read alongside `DESIGN.md`, not a shipped component).
- **Provider catalog refreshed to the current omp/models.dev snapshots**: the review runner moves to omp `18.18.1` and mstar-harness `4.2.3` (engine + CLI + image pin), and the generated provider catalog is rebuilt from the `2026-11-06` models.dev snapshot plus omp `18.18.1`'s own bundled model registry. The vendored omp snapshot is now produced by `scripts/provider-catalog/extract-omp-snapshot.ts` (`bun run provider:catalog`), so a dependency bump refreshes the catalog in one command.
- **A provider's model list is complete**: the earlier extraction cap and the builtin representative-model cap are gone, a mixed-protocol provider (e.g. Command Code, OpenCode Go) ships one row per protocol with its full vocabulary, and the settings card's model disclosure shows the catalog's whole list instead of a truncated sample. A declaration may now carry up to 128 model ids (was 32), so a full provider vocabulary fits.
- **Provider keys are verified without inference**: every dashboard key check is a `GET` against the provider's models/usage/identity endpoint — the remaining 1-token chat probes are gone, and nothing is stored on a failed check. `kilo` and `umans` stay verifiable on their public models list, recording the weaker `reachable` state (a public list answers 2xx for any bearer); `zai` is the only `unsupported` provider (no documented models/usage endpoint).
- **`ok` now means the probe could reject the key**: one allow-list of key-rejecting probe URLs decides `ok` versus `reachable` for built-in and custom saves alike, so no verified key is stored unverified. OpenRouter stays on its public `GET /api/v1/models` — that catalog is what fills the model picker — and, because it answers 2xx for any bearer, its save records `reachable` instead of `ok` (omp's stricter `/api/v1/auth/key` check answers account data, not models, so a spec pointed there would leave OpenRouter with nothing to select).
- **The built-in verify table is aligned with omp 18.13.3**: a new vendored snapshot (`scripts/provider-catalog/omp-provider-verify.json`) records every `validate "models-endpoint"` entry (28 endpoints, source version and extraction date in its header) and the built-in specs derive from it through the existing provider-id alias map.
- **Custom provider probes are normalized and identify themselves**: the declared base URL is resolved with `new URL()` (a base ending in `/`, `/v1`, `/v1/` or `/models` yields exactly one `…/models` probe; a carried query/fragment is dropped), an unparseable URL now reports `unreachable` instead of surfacing the throw as a failed check, and every verify request sends `Accept: application/json` plus an explicit `User-Agent`. These are changes to how the probe is built and sent; the root cause of the occasional spurious "could not be reached" report was not confirmed on a deployed Worker, so the symptom is not claimed to be eliminated.
- **Custom providers get the multi-key pool the other faces already had**: a new authenticated settings action appends a key to an existing custom declaration (verify-first against its stored endpoint, no declaration rewrite, the endpoint lock and the 8-key cap intact), with an "Add key" action and the same masked per-key rows on the custom-provider row.
- **Pull request detail:** every Review row now names its round (`Round N`), the findings that round reported and how long the run took, so the reviews tab carries information without opening an empty summary fold — that fold is gone. Findings rows name the round that first reported them.
- **Store:** added the nullable `reviews.duration_ms` column; rows written before the measurement keep NULL and the UI omits their run time.
- **README refocused on self-deployment (English + 中文).** The Quick start is
  now the single self-host path; the repo's own staging path and the
  production / release-train detail moved out of both READMEs — both were
  already covered in `docs/deploy.md` / `docs/release.md`. The Architecture
  section reflects the Multi-App shape (dashboard registration, per-slug
  webhook routing, per-App encrypted credentials in D1) and the
  `DEPLOYMENT_MODE` deployment-shape switch (details linked, not inlined).
  The Chinese README additionally gains the review-behavior sections that had
  drifted out (credentials scoping, permissions, advisory Check runs, recovery
  semantics). Stale facts fixed in both: Bun `>= 1.4.0` (matches
  `package.json` engines) and review runner levels `quick|default|deep`
  (`deep` is alive per `packages/runner/src/runner.ts`).
- **The review comment body is now rendered by the engine**: `@mstar-harness/engine`'s `renderReviewMarkdown` owns the layout — verdict head (with score), the `cause:`/`unscanned:` pair, the tally table, `## 📋 Review`, and one block per finding in seat order — so the verdict, score, tally and finding titles no longer appear twice. This repo keeps only what the engine cannot express: the omitted-findings footer and the folded prior-findings recheck.
- **A seat narrative is optional**: the runner's output contract no longer requires `summary_md`, and engine 4.1.6 no longer fabricates one, so a review without a seat-written summary shows the bare Review heading instead of machine facts echoed back into the body.
- **The round header moved under the body**: `Review N · commit <sha>` is now the trailer directly above the publication marker; the hidden round marker stays the first line.
- **Review sandbox cohort moved to mstar-harness 4.1.6**: the engine manifest range, the runner's exact pin, the preinstalled CLI pin, the image tag/ref, and the regenerated lockfiles move together — the pin suite fails if any of them drifts.
- **The cross-round repeat callout is removed**: the engine's tally table is no longer ours to recompute, so a repeat can neither be annotated in the finding blocks nor excluded from the counts. It listed titles the findings section already carried, so the prior-findings recheck is what now answers what happened to earlier concerns. Its store query and its tests go with it.
- **The review image is rebuilt**: the runner no longer requires a seat summary, and that half must ship with the engine pin above it.
- **Review concurrency limits re-scaled**: the platform quota now defaults to and accepts up to **256**, each workspace is bounded by its own maximum of **32**, and the default admission therefore rises from **16 to 32 per workspace** (Cloudflare Queues delivers at most 250 at once; that aggregate is only reachable across at least eight workspaces at their own maximum). The workspace settings card no longer displays or returns the platform cap, and a workspace write is validated only against its own range (1..32) — the platform quota applies at admission, so no tenant request can reveal it by being refused. On upgrade, any workspace that stored a value above **32** under the previous 1..64 range is lowered to **32** by migration `0043_workspace_concurrency_bound.sql`, which records each previous value in `workspace_concurrency_clamp_0043`.
- **A stopped review seat no longer fails the run**: when a quick/default review has any seat stopped by its wall-clock cap, the run now publishes an `incomplete` verdict stating the cause and the assigned scope it did not fully cover — one entry per stopped seat, each naming that seat's assigned scope — instead of throwing the whole review away; findings collected from the seats that did return are retained, so the run is reported as not settled rather than lost.
- **The posted body states the cause/scope pair exactly once and bounded**: the cause and unscanned lines the renderer emits are capped per line with an ellipsis, and machine-written duplicates of those lines are stripped from the rendered summary only — the stored envelope keeps the validated values — while a run with no stopped seat stays byte-identical to before.
- **A deep review that ends without a yield is published as `incomplete` too**: when the deep parent turn ends without producing a structured yield, the run no longer fails — it publishes an `incomplete` verdict carrying the summary that turn had already gathered, the cause it states and the deep scope it never completed (the whole diff, one entry); a prompt error with no terminal end, and a yield the contract rejects, remain fatal. The rendered scope line is bounded before it is assembled — a list that fits is printed verbatim, and only an overflowing one stops at the budget and ends with an omitted-count marker — while the stored fact keeps its validated values.
- **The App setting previously called "Runtime image" now reads as the runtime
  harness.** The sandbox image is a single build; what the selector chooses is
  the harness (`omp`) mounted into it. The card, the saved notice, the
  provider-eligibility copy and the save-refusal message now say harness in
  both locales. Stored identifiers (`sandbox_image_id`, the registry and the
  save operation) are unchanged.
- **Sandbox harness pin bumped to mstar-harness 3.10.2** (up from 3.8.1 at the previous release): the sandbox image's plugin clone ref, the `@mstar-harness/cli` preinstall pin, the repo manifest range with its lockfile, and the deploy-docs pin table all move together, with the pin-chain tests re-pointed.
- **Sandbox image pins bumped**: mstar-harness 3.10.2 → 3.11.2 (plugin clone ref, CLI preinstall, manifest range, deploy-docs pin table) and the omp SDK (`@oh-my-pi/pi-coding-agent`) 18.0.4 → 18.2.6.
- **Sandbox image pins bumped**: mstar-harness 3.11.2 → 4.0.0 (plugin clone ref, CLI preinstall, manifest range, `engines.bun` floor, deploy-docs bump narrative).
- **Review sandbox cohort moved to omp 18.12.3 / mstar-harness 4.0.4**: the image pin block (harness tag/ref and the preinstalled `@mstar-harness/cli`), the `@mstar-harness/engine` `^4.0.4` manifest range, the `@oh-my-pi/pi-coding-agent` pin, and the regenerated lock move together — the pin suite fails if the engine range, its lock resolution, the image CLI pin, or the derived skill version drift apart.
- **Review envelopes can now leave the Worker through the harness persist surface**: `scripts/mstar-export-review.ts` validates one `mstar.review/v1` envelope with the engine and writes it as a `review` artifact — `FsStore` under the resolved harness root by default, `--store <module>` to supply a custom store module. This is not a migration of the D1 review store: the publication journal, leases, recurrence queries, and dashboard reads stay in D1.
- **No operational change from this entry**: the change is pins, one CLI-side script with its test, and documentation — no image build, in-image replay, deployment, or smoke was run.
- **Review sandbox cohort moved to omp 18.13.3 / mstar-harness 4.1.2**: the image pin block (harness tag/ref and the preinstalled `@mstar-harness/cli`), the `@mstar-harness/engine` `^4.1.2` manifest range, the `@oh-my-pi/pi-coding-agent` pin, and the three regenerated lockfiles move together — the pin suite fails if the engine range, its lock resolution, the image CLI pin, or the derived skill version drift apart.
- **The provider picker now offers every omp API-key LLM provider**: a vendored snapshot of the omp catalog is merged into the generated provider catalog as `template` rows, so providers the models.dev snapshot lacks (Command Code, TypeSafe, Qianfan, SambaNova, LiteLLM, Ollama, vLLM, AIML API, CoreWeave, Fire Pass, Helmcode, Yolo-Auto, Qwen Portal and the two SingularityAPI gateways) are selectable without hand-writing a custom provider. Every added row is `template` tier, so the 19 built-in BYOK providers, their env-name allowlist and the models.yml synthesis are untouched.
- **`typesafe` joins the custom-provider protocol set**: a declaration may now name omp's TypeSafe wire, verified through the OpenAI-shaped Bearer models probe. Command Code is mixed-protocol per model, so it materializes as two rows — `commandcode` (Responses) and `commandcode-anthropic` (Messages).
- **A reachable endpoint no longer reads as a verified key**: a declared custom/template provider records `verified_status = "ok"` only when its models endpoint is known to reject a bogus key, and `reachable` otherwise — so Command Code's public `/provider/v1/models` and every other declaration (including an operator-supplied `base_url`) land `reachable`, and the settings row renders "endpoint reachable … — key not verified" instead of "verified …". Only `api.typesafe.ai` is allow-listed today (omp validates a key against its `/v1/models`), and built-in providers keep `ok` — their probes all reject a bogus key.
- **No operational change from this entry**: the change is pins, the generated catalog with its vendored input, protocol plumbing and tests — no image build, in-image replay, deployment, or smoke was run.
- **OMP updated to 18.18.1**: the root and runner pins move from 18.17.0 to 18.18.1 with both lockfiles regenerated, and the sandbox image rebuilds. The regenerated vendored provider catalog changes only the version and extraction date; provider lists, model IDs and header hooks are unchanged.
- **The image's harness ref now matches its tag**: `harnessRef` still named the `v4.2.2` commit under a `4.2.3` version, so `REVIEW_SKILL_VERSION` read `4.2.3+98504a71` — a suffix no `v4.2.3` checkout contains. It now carries the `v4.2.3` commit `abf3167d`, and a contract test locks the Dockerfile's clone ref to it. Reviews recorded before this change keep their historical suffix.
- **omp SDK bumped**: the `@oh-my-pi/*` cohort (`@oh-my-pi/pi-coding-agent` and its dependency graph) 18.2.6 → 18.11.1; the review runner's credential write moves to the SDK's namespaced `AuthStorage.credentials.set` / `credentials.list` API, with the in-memory credential store, the models.yml synthesis and the session shapes unchanged.
- **Sandbox SDK 0.12.8 → 1.0.0**: version 1.0 no longer ships the `Sandbox` class or `getSandbox()`, so `src/pipeline/sandbox.ts` now owns a Durable Object written in-repo that starts and drives its own container (`this.ctx.container`) and exposes the same `runCommand` / `destroy` RPCs to the Worker.
- **Container configuration moved to the Durable Object scheduling policy**: `wrangler.jsonc` / `wrangler.smoke.jsonc` use `scheduling_policy: "durable_object"` with a named image map (the instance size moves into `container.start()`), and the container application gets a NEW name — the 0.12-era application name cannot be reused.
- **Review sandbox image rebuilt on a base we control**: the SDK's runtime base image is gone, so the Dockerfile starts from a digest-pinned Debian base (linux/amd64) — the base layer and the libc it carries are frozen against silent drift, while the apt-installed tools (`ca-certificates`, `curl`, `git`) still resolve from the rolling suite at build time — and copies `sandbox-shim` from the matching 1.0.0 image; a long-lived default command keeps the container alive.
- **The consumer contract is unchanged**: `ReviewSandbox`, `getSandbox(binding, id)`, the branded `ShellCommand` single-sink boundary and the per-command 600-second bound all keep their meaning — a fired bound now reports exit code 124 instead of throwing.
- **Only the newest commit of a PR is reviewed**: a delivery whose PR head has since advanced is acknowledged as `superseded` before any sandbox is created — no container, no retry, no failure row — and the delivery carrying the current commit is the one that reviews. The skip also requires that newer commit to own a queued job (its idempotency claim, written only after a successful enqueue, and rewritten to `dropped` when the guard drops that job for good). A head advance produced by a delivery that queued nothing — a `synchronize` in `open` mode, a paused App, a failed send — therefore never makes this delivery skippable. That proof is read once, at the moment of the ack: it is not a reservation, so a newer job that is terminally dropped afterwards still leaves the PR head unreviewed, with the drop's `review_failures` row as the only trace and no automatic re-enqueue. The ack also stamps `superseded` on the overtaken commit's own key (same TTL), so the worker never re-enqueues a commit a newer one already replaced — that value is never proof for the newer commit — while a force-push back to a previously superseded commit does re-enqueue it, because it can become the head again. One structured info line tagged `event=review_superseded` names the newer `head_at` that overtook it, so a missing review can be explained without a second query.
- **A newer commit is no longer dropped behind the delayed-retry window**: a message held by `pr-held` now retries at `60/300/1200` seconds (quick/default) or `90/480/1200` seconds (deep). The cumulative wait outlasts the level's guard TTL, so a lock that is released or expires before the final delayed attempt admits the retry and the new commit is reviewed. A review that outlives the whole schedule still drops the message, and that drop is recorded — never silent.
- **The watermark only moves forward**: the ledger keeps the `pull_request.updated_at` of the most recent stamped delivery for the PR — a delivery naming the same commit moves it too, which is harmless because the skip needs a different commit — and `head_sha` never rewinds: an out-of-order delivery, stamped or not, leaves the newer commit in place. A delivery at the same instant or for the newest commit is always reviewed. `issue_comment` jobs and any message without a stamp — including all traffic before this deploy — take exactly the previous path, and a ledger read failure or absent row fails open to a normal review.
- **Webhook body cap enforced on streamed bytes**: the 413 request-size cap no longer trusts the client-supplied `content-length` header — oversized bodies are rejected mid-stream the moment the limit is exceeded, even when the header is missing or lying.
- **Bot-authored PRs are never reviewed**: a `pull_request` delivery whose author login ends in `[bot]` (`dependabot[bot]`, `github-actions[bot]`, another App's own `<slug>[bot]`) is ignored instead of enqueued, independent of the App's trigger mode and action. The same check applies to `issue_comment`, so a mention on such a PR does not start a review either. The suffix match is case-insensitive and only the suffix counts: a login without `[bot]` still triggers, whatever its account type.
- **Missing author fails closed**: a delivery without the PR author login (`pull_request.user.login` / `issue.user.login`) cannot prove a human authored the PR, so it is ignored rather than reviewed on both faces. GitHub always sends the field; this only covers a truncated payload.
- **Skip is logged**: both faces emit one info-level structured line (`reason` = `bot_author` or `missing_author`, with the author login and PR number) when a delivery is skipped for its author, so an operator can tell why a PR got no review. The HTTP response and the delivery row's `ignored` vocabulary are unchanged.
- **Comment-face guard order**: the PR-thread gate and the bot-author check run before the mention grammar, so neither a bot-authored PR nor a comment on a plain issue reports the mention miss. The unsynced-App `mention_unresolved` operator warn correspondingly stays limited to comments on PRs authored by a non-bot. Status also moves: an `issue_comment` delivery whose action is whitelisted but lacks a required field (installation id, repository, issue number) now answers 400 before the author/mention/actor gates, so those truncated deliveries record `rejected` instead of `ignored`; the action whitelist still runs first.
# Breaking: per-App webhook URL is now `<workspace_id>/<app_id>`
The webhook delivery URL for every GitHub App is now
`<origin>/webhook/<workspace_id>/<app_id>` — the workspace's stable id and the
App's local row id, both immutable internal identifiers. The old single-segment
`/webhook/<uuid>` route is **retired with no compatibility path**: GitHub keeps
delivering to the old address and receives a **404** until the App's Webhook URL
is updated.
**Upgrade step (required).** After deploying, open each App's settings card
(`/dashboard/<workspace_id>/apps/<github_app_id>/settings`), copy the
**Webhook URL** it prints (both segments are shown on the card, including the
Local App ID), and paste it into the GitHub App's settings → Webhook → Webhook
URL. Until then the App receives no events.
Migration `0038` rebuilds `github_apps` to drop the now-duplicate
`webhook_path` column (SQLite cannot drop a `UNIQUE` column, so this is a
table rebuild inside the migration transaction — a brief write lock on a small
table; every row survives). No data is migrated: the two URL segments already
exist in the database.
- **Sign-in is open; a workspace is created, not assigned.** The deployment-level
  login allowlist is gone: any GitHub login that completes the OAuth callback and
  is not recorded as removed gets a `users` row with `role = 'member'` and no
  workspace membership, unless the operator has closed `signup_open` — closed
  means no new row, while a login that already has one signs in unchanged. A
  signed-in login with no workspace lands on a **Create a workspace** form
  (`POST /dashboard/api/workspaces`), which mints a lowercase `ws_…` workspace and
  makes the creator its `owner` in one transaction. The form always renders; when
  the operator has closed workspace creation (`workspace_creation_open`) the
  submit is refused 409 `WORKSPACE_CREATION_CLOSED_REFUSAL` (a saas deployment
  can also refuse it with `FREE_SLOT_REFUSAL`), and the setup page shows only a
  generic create-failure notice. Creating is the only way for an uninvited login
  to get into a workspace — the same setup page also lists any pending invite
  and accepts it — and ownership can be transferred afterwards by a role
  change. A successful create lands directly inside the new workspace
  (the `201` names `/dashboard/<ref>/apps`), so the creator never depends on
  sole-workspace resolution finding a second workspace. There is no
  auto-join and no first-user-becomes-admin fallback; authority is
  workspace-scoped from then on.
- **Deploy wiring loses the allowlist**: the allowlist's required-variable
  gate, its post-deploy settings assertion and its `--var` bind are removed
  from both workflows; the deployment shape and operator binds stay. A bare
  `wrangler deploy` is the supported manual path for a self-hosted copy.
- **Workspace role changes are owner-only, and promotion is how ownership moves.**
  A role change now targets `owner` too, so an `owner` promotes an existing
  `admin` or `member` to `owner` and then steps down — there is no separate
  transfer action. An `admin` may still invite, revoke an invite and remove a
  plain `member`, but may not change any role, nor remove an `owner` or another
  `admin` (403 — including when that owner is the last one, never a 409).
- **The last owner cannot be removed or demoted**, and an `owner` demoting
  themselves while they are the only `owner` is refused with a 409; after a
  second owner exists the same self-demotion is allowed. Removing the last
  owner answers that same 409, even when the actor is that owner (it outranks
  the generic self-removal 400). `users.role` is no longer read or written by
  any workspace authorization decision.
- **Removing a member removes only the membership.** Leaving a workspace
  deletes the `workspace_members` row and nothing else: the account (`users`
  row) survives, so the person can still sign in, keeps the invites they
  created, and can be invited into another workspace or create their own. The
  deployment-level login ban (`removed_logins`) stays an operator action,
  never a side effect of a workspace membership change.
- **A workspace's URL is its immutable id.** Every link the Worker emits —
  the shell boot ref, the operator support landing, the creation target, the
  `/dashboard` landing, the onboarding redirect, invite discovery, the sidebar
  fallback and the switcher's options — now names `ws_…` instead of the
  readable slug, so a link can never go stale because someone renamed the
  workspace. The `(slug = ? OR id = ?)` resolvers and the path-matching
  predicate are unchanged: an old `/dashboard/<slug>/…` link still serves the
  same workspace, and the browser URL is never rewritten.
- **The owner-facing slug editor is gone.** `PUT /dashboard/<ref>/api/settings/slug`
  and the Settings card that drove it are deleted, not redirected — the path
  segment is not something a tenant can change any more, and the request now
  answers the catch-all 404 for every role. Slug authoring moved to the
  platform console.
- **The owner renames the workspace label instead.** A new owner-only
  `PUT /dashboard/<ref>/api/settings/name` takes `{ name }`, trimmed and capped
  at the creation limit, and the workspace settings page renders a name card in
  place of the slug card. A save updates the top-bar switcher's label without a
  reload and without touching the path.
- **The platform console authors the slug.**
  `PATCH /_internal_admin/api/workspaces/:id/slug` lets an operator set a
  workspace's readable slug under the grammar, reserved-word and collision rules
  the owner route used to enforce (including "a slug may not equal another
  workspace's id"), and records one `workspace.slug.set` audit row in the same
  transaction. The Workspaces table shows the slug beside the name with a row
  action to edit it.

### Fixed

- **The review Check attaches when the delivery is accepted, and closes right after the verdict.** The Check attempt is now claimed and its `in_progress` run created on the delivery path — before `REVIEW_QUEUE.send`, not inside the consumer's admission block — so the attach no longer waits for the queue and a cold sandbox, and an admitted message finds a released row instead of racing its creator. The webhook waits at most 2.5 s for the attach; past that the enqueue proceeds and the attach finishes on the invocation context. When the message is admitted before the attach released the row, the consumer retries the adoption once, 250 ms later, as long as the row is still under a delivery holder (never for a running review's holder or a frozen intent), and it takes over a delivery holder that has been silent for 5 s. A released attach row carries a two-minute grace due time, so if nobody adopts it the minute reconciler takes it then — not at the one-hour window's expiry. A delivery that is SKIPPED before execution — an idempotency hit, a publication-journal hand-off, a paused App — settles its attached run `neutral` with the skip reason instead of leaving it to close red at the one-hour window. The settlement follows the payload's head SHA (what the attach used, not the checkout) and the delivery identity the attach records on the row and carries on the queued message — so it closes its OWN run, never a duplicate delivery's, even when the attach outlived the inline budget and released the row later — and does not retire the head: a retried or resumed delivery still claims a fresh generation and runs its own review. An in-flight guard rejection settles only on the final, terminal refusal (the retried refusals settle nothing, so a duplicate delivery can never close the live review's run); a retry that is later admitted still claims a fresh generation with its own run — a neutral settlement never retires the head. Where the App's Checks client is already at hand the skip sends that one update itself; on a paused App — whose gate makes zero credential/GitHub calls — the skip only freezes the intent, and the minute reconciler sends it on its next pass. The admitted message adopts the row through the same fenced claim (epoch bump, execution deadline narrowed to the 900 s execution window) and terminalizes the run inline from its handle; an adoption that lands after the begin budget releases the row again rather than returning a handle nobody awaits. Measured on staging before this change: attach lag was the queue delay — 10 s, 3 m 20 s, 16 m 45 s and 15 m 31 s across four pull requests — and post-verdict close took 122 s and 113 s, because 69 of 85 attempts in seven days recorded `terminalize_outcome = 'no-handle'`: the consumer never held a handle, so its step-12 terminalize could never run. A refused attach (no Checks surface, a token/GitHub refusal, a failed run-id write) is one redacted `check_attach_failed` warn and changes neither the `accepted` answer nor the enqueue; a release fenced out by an adopting consumer is not a failure. A duplicate delivery, a queue redelivery or a synchronize event for the same head still creates no second run.
- **A Check whose begin budget expires while its run is being attached no longer waits out the execution deadline.** The consumer's 2 s bound can elapse between the create and the attach write; the created run was then attached and the handle returned into a promise nobody awaited, leaving the attempt on a live 900 s lease that nothing could terminalize. Measured on production before this change: 108 of 269 attempts closed at `terminal - created = 904–965 s`, i.e. the deadline, with nothing in the 615–900 s range. The attempt is now released to recovery like the pre-attach case — the run id is already persisted, so the reconciler adopts that run within about a minute instead of at the deadline.
- **A decided Check no longer waits out the 15-minute execution window**: after a review publishes, a Check whose conclusion is already decided is taken over by recovery once the writer that froze it has gone quiet for two minutes, instead of waiting for its 900-second claim to expire. A Check whose conclusion is not decided yet still keeps its claim until its execution deadline, so a review that is still running is never raced, and the previous writer's late writes are refused because the taker bumps the lease epoch.
- **A Check now carries its gate result.** `checks.update` sent the frozen title and summary as top-level fields; GitHub reads them only from `output`, so every run closed as a bare name plus conclusion and the frozen text (`Review gate met for <sha7> (round N): verdict "ship it", score 100 (floor 80; allowed: ship it).`) never reached the PR. The pair is nested under `output` now, and the adapter's own parameter type says so instead of inventing a shape the API drops.
- **A Check attempt records why it closed.** `review_checks` gains `terminalize_outcome` and `terminalize_elapsed_ms` (migration `0052`, documented in the review-lifecycle spec): `completed` only when the row proves a terminal send landed (`observed = desired` with a frozen, non-`in_progress` intent); `handed-off` when the hook returned without that proof, which covers a fence-refused freeze and a `completeCheck` that could not confirm — both release the attempt to recovery; `budget-exceeded`; `hook-failed`; `no-handle` (the begin budget expired, so the consumer never held a handle). Those exits previously reported through `log.warn` only, so a run that closed at the 900 s execution deadline left no evidence of which branch it took.
- **The check run appears when the review starts and finishes about a minute after it publishes**: the Check attempt is now claimed at admission — after the in-flight guard accepts the message, before the container is acquired and the PR is cloned — using the delivery's head SHA or the PR head watermark, so a cold sandbox no longer hides the first five minutes of a run. When the authoritative checkout disagrees with that claim (a force-push mid-flight), the early run is closed as `superseded` and a fresh attempt is claimed at the checked-out commit; a duplicate delivery that hits idempotency closes its run before acking. The claim now sits at the start of the existing 15-minute execution window — the Cloudflare Queues per-invocation cap, neither widened nor a tuning knob — so that window covers the container phase without being stretched.
- **Giving up on the terminal `checks.update` now releases the attempt instead of waiting out the deadline**: when the consumer's terminalize budget elapses, the hook throws, the checkout contradicts the claimed head, or a publication-journal hand-off supersedes the review, the lifecycle freezes a terminal intent only where none is frozen yet — a proof-derived conclusion and its exact summary are never replaced, the condition living in the UPDATE predicate — and hands the attempt to recovery with `remote-unconfirmed` and the first 60 s backoff rung. No remote request, and a no-op if recovery already claimed it. The Check recovery reconciler also runs on its own every-minute cron (declared for the top-level Worker and every named environment) while the failure sweep and the publication reconciler stay on fifteen minutes, so a released attempt closes about one to two minutes later instead of at the next quarter hour after its execution deadline. Give-ups are diagnosable through the structured `check_terminalize_budget_exceeded`, `check_terminalize_failed` and `check_abandon_released` lines.
- **The review check run finishes when the review publishes**: the terminalize hook now owns a 10-second budget (spec §7.10) instead of sharing the 2-second begin-hook bound, and its promise is handed to the queue invocation's `ctx.waitUntil`, so a slow `checks.update` finishes out of band instead of being reclaimed with the isolate. A PR no longer sits on an `in_progress` check until the 15-minute recovery cron adopts it; an overrun logs one warn line and never blocks the review.
- **A Check refusal that never reached GitHub no longer spends a recovery attempt, so a transient token-mint failure can no longer strand a running Check.** The reconciliation lanes charged every `unavailable` read or update as a failed attempt; five credential-mint failures in a row therefore walked a live attempt to `local-error`/`terminal_ms`, which the selector never revisits, while GitHub still showed the run `in_progress`. Observed on production: one Check sat `in_progress` for over four hours with `last_error` = "gave up after 5 attempts … no review-write Checks client for this App". Read and terminal-update refusals proven zero-dispatched now release the claim under the identity fence like the create lane already did: no attempt, no backoff, due again at the same instant. The credential resolution's own redacted text now rides the reason, so `last_error` names the cause instead of collapsing every failure into "no client".
- **Checks that ran to their execution deadline are unchanged**: an attempt that really dispatched and exhausted its window still concludes at the deadline.
- **A repository renamed after its scope was persisted no longer freezes the Check forever.** GitHub matches a token's `repositoryNames` exactly while the REST paths follow the rename, so the old name 404s every scoped mint — and the persisted identity is immutable. Observed on production: a Check stayed `in_progress` for over four hours on a PR whose repository had been renamed minutes earlier. The `review-write` mint now retries once, on a 404, with the same installation and permission set and no repository narrowing; `sandbox-read` still fails closed.
- **A deferred Check wait never outlives the attempt's own deadline**: while a Check attempt waits for its publication's proof, the reconciler gives the claim back due at the first backoff rung — now clamped to the attempt's execution deadline. When that deadline fell inside the rung, the row stayed unselected until the rung elapsed, so the PR's check sat on `in_progress` past the hard stop it was supposed to conclude at. The row is now due at the deadline itself and concludes on the next pass after it.
- **One bot-mention comment triggers at most one review**: the `issue_comment` job now carries the comment's own id (`comment_id`, from `comment.id`), and a `comment_trigger_claims` row (migration 0048_comment_trigger_claims.sql) is inserted **before** the queue send — the row's primary key, not a KV get-then-put, is what refuses a second delivery, whether it arrives concurrently or after the KV fast path's 24-hour TTL lapsed. The pipeline then consumes that row atomically before any costly step, so a queue redelivery, an outbox re-send or a duplicate delivery acknowledges without running a second review. A failed send deletes the row so GitHub's retry can claim it again, and a crash between the insert and the send is recovered by the cron sweep, which re-sends `queued` rows older than its retry window and expires a claim that reaches the attempt cap. A consumed claim is never re-executed: a failed comment-triggered review is re-run by posting a new comment. Jobs without a readable comment id enqueue exactly as before. The
recovery window, attempt cap and per-run resend cap are operator settings under
`review.comment_claim.*` (admin runtime page), defaulting to 300000 ms / 3 / 20.
- **App detail's recent-deliveries panel leads with review verdicts**: the panel was a raw last-5 timeline, so bypass traffic (`check_run`, `ping`) — orders of magnitude more frequent than review traffic and always `ignored` — filled every row and made a healthy App look stuck on "Ignored". It now ranks by the same outcome tier as the Apps list health column (`ok` / `paused` / `rejected` ahead of `ignored`), newest first within each tier; stored rows are untouched, and an App whose only traffic is bypass still lists its newest rows. The heading copy stops claiming "the last 5 deliveries".
- **Deploy workflows now pass the platform-operator allowlist.** Both the staging and production deploys read the `PLATFORM_OPERATORS` repository variable and bind it as a Worker var, so setting it in GitHub actually grants the operator console; previously the workflows never read it and `/_internal_admin` answered 404 for every caller.
- **The PR diff now actually reaches the Worker.** The diff step redirected
  `gh pr diff` into `/workspace/pr.diff` and read the *exec's stdout*, which a
  redirect always leaves empty — so the trusted evidence catalog was built from
  an empty string, every selected prior finding was excluded as unprovable, and
  a round could only publish `unverifiable (no-evidence)` for rows the seat was
  never shown. The command now writes the file (still the numstat source) and
  reads it back through the same bounded transport as the recheck documents:
  the first 2 MiB, then a `wc -c` overflow flag. Over-size still yields no
  slices and keeps the base-filter fallback for line comments; the round is
  never dropped.
- **A diff capture that cannot prove a row is reported, not fabricated.** An
  empty capture is judged against the SAME round's numstat: nothing read while
  the numstat shows a diff is a capture failure, while nothing read and an empty
  numstat is a genuinely empty PR — a normal round, not a lost capture. An
  over-bound diff exists but cannot prove a row, and a read with no flag line
  means the transport broke. Each of those leaves the round
  `context-incomplete` with a `diff_capture: "empty" | "overflow" |
  "unreadable"` warn, instead of publishing a confident `no-evidence` verdict
  per row.
- **An empty diff acks instead of failing the review.** `git apply --numstat`
  rejects an empty diff file as unusable input, so a round whose `base..head`
  (or whole PR) adds no changes failed at the sandbox stage and was retried.
  The same round's read of that file now classifies the exit: an empty file is
  the documented no-changes outcome and acks with no publication, no review row
  and no failure row — on a first round (`review_no_diff`) and on an empty
  increment (`review_no_increment`, which also keeps the Check on the last
  reviewed head). Every other non-zero exit still fails, naming git's stderr
  plus the diff-path state.
- **Git-stage failures no longer echo a credential**: a failed diff, increment-diff or numstat step now removes the session's own secret values from the stderr tail it reports, not only credential-shaped text — so a credential that evades the pattern list cannot ride the failure message into the logs or the durable failure row.
- **Insights charts render at their true measured width** instead of stretching a fixed 560px SVG across wide cards (which inflated the designed tick text) — width comes from a ResizeObserver-measured container, with the fixed size kept for static/SSR and webviews without ResizeObserver.
- **Chart date labels are pinned to a numeric M/D format** shared by every locale, instead of varying with the app language.
- **The insights trend card now matches its window's bucketing**: 7/30-day windows read a new additive daily-trend series (zero-filled day buckets); 90-day windows keep weekly buckets zero-filled over the same grid the stacked charts use, so trend and distribution bucket counts always agree.
- **An oversized increment capture degrades to a full-diff round instead of
  failing the review.** A recheck round captures its increment through the
  compare API, which enforces the same 20,000-line ceiling `gh pr diff` answers,
  so a large `base...head` diff was refused and failed the sandbox stage on every
  attempt. The increment reply now lands in a scratch file that replaces the
  round's full diff only once it was delivered, and a refusal is classified:
  the round logs one structured warning naming the reason and the step it
  stopped at, drops the `since` fact — never keeping a claim the diff no longer
  supports — and reviews the full diff it already captured. Any other increment
  failure still fails with its own named cause (exit code, redacted stderr and
  the diff-file state).
- **Solved conversations from earlier rounds are resolved after a later review re-verifies them**: the Inspector's own publication comments (bot-authored review/degraded marker bodies) are excluded from the captured issue discussion, so the model context, the capture-time digest and the resolve-side digest share one domain and posting a review no longer invalidates the verification it was captured against. The recheck rotation now also selects `addressed` findings that still own a non-superseded association in a non-terminal state (`pending`, `retry`, `needs-recheck`, `local-error`), so the seat re-checks those concerns against the CURRENT head and discussion in a real round and the ordinary resolution path resolves them with that round's own verified snapshot. Once the association is resolved or abandoned the finding leaves the rotation, every selected row still advances `last_scheduled_ms` (no row can starve the ones behind it), and the round's coverage total counts this extended selection (`totalOpen` = recheckable rows) so the published `assessed + invalid-output + omitted = selected` identity stays true. The resolve fence now requires the finding to still be `addressed` plus this row's own addressed verdict instead of `last_publication_id`, because the seen upsert never bumps a re-assessed row's publication. Supersession, ownership, coverage, HEAD/conversation/issue-digest fences and mutation confirmation are unchanged, so a recurrence, a superseded association or a human reply still fails closed.
- **A throttled provider check now says so, instead of guessing that the account is out of credit.** Key verification answers a 429 with its own reason, `rate_limited`: the provider throttled the request, the key was not judged, and nothing was stored. The 429 body is not read at all — Gemini answers both a plain throttle and a genuinely exhausted quota with `RESOURCE_EXHAUSTED` and "Quota exceeded. Please check your plan and billing details", so no wording can tell those two apart from the outside. This entry also introduces two reasons the shipped classifier did not have: `quota_exhausted` for a 402 (the only status that asserts a spent account) and `quota_exhausted` for any other non-2xx whose error body names credits/quota/billing. Before this change the classifier knew only `invalid_key`, `unreachable`, `unexpected_response` and `unsupported_provider`, so both cases were reported as `unexpected_response` or `invalid_key`. The status ladder is now: 401/403 → `invalid_key` (a 403 billing refusal still means "this key cannot do this"), 402 → `quota_exhausted` — the only status that asserts a spent account — 429 → `rate_limited`, and any other non-2xx keeps the existing credits/quota/billing body test → `quota_exhausted`, else `unexpected_response`. The three verify paths — built-in models endpoint, built-in probe and custom-provider probe — still share ONE classifier. Both locales carry the new copy: it names the throttle, says the key was not judged, and keeps quota exhaustion as a possible cause when the account really is out.
- **A lost publication response now recovers instead of backing off**: when a review comment's send ends with an unknown outcome, recovery re-reads the PR conversation looking for the comment it may have posted. That read filtered out the Inspector's own publication comments — exactly the comment being looked for — so every such attempt reported "no exact publication match" and backed off until the attempt cap, leaving a published comment unrecorded for operator inspection. The read can now opt in per call, and only this recovery lane does; the discussion digest and the model context keep their existing filtered domain and are byte-identical for an unchanged PR.
- **Every failed recheck round names its cause**: a single row's `error` no longer short-circuits the seat's attribution, and a thrown seat rejection keeps the settled child's abort reason, stderr tail and exit code, so both failure exits report the same chain (`structuredOutput.error` → `abortReason` → `error` → stderr tail → exit code) instead of a bare seat-failed text.
- **One bad recheck row no longer discards the whole round.** The recheck
  document validator now separates two distrust levels. Document-level faults
  (wrong schema, stale HEAD, non-array or oversized `results`, a duplicate row
  ID, a row ID absent from the targets) still fail the document as a whole. A
  row-level content fault now drops only that row: it lands in `rejected` and
  the worker surfaces it as `unverifiable/invalid-output`, while the surviving
  rows are accepted and published. Previously one imprecise citation threw away
  every other assessment in the round.
- **Quote matching forgives formatting noise.** An `addressed` citation is
  compared after normalization — CRLF/CR→LF, per-line trailing whitespace
  stripped, one trailing newline dropped — instead of byte equality, so
  invisible trailing blanks no longer invalidate a correct quote. Every other
  eligibility rule is unchanged: ranges, slice membership/completeness, old-range
  intersection and the structural-change requirement still apply — and
  `removed-code`'s "old lines are gone from the new side" test is normalized the
  same way, so one trailing space on still-present code can no longer forge a
  closure that was never fixed. Normalization never rescues a BLANK quote: a
  whitespace-only `quote` normalizes to `""`, which byte-equals a blank cited
  line, so it is now rejected outright and the 1–4096 bound counts the visible
  text.
- **A lost recheck round is now attributable.** The seat writes a bounded
  `mstar.recheck-status/v1` document on every exit path — `ok` with the rejected
  row IDs and their count, `skipped` when the budget left no room, or `failed`
  with a bounded reason/error — and the worker reads it beside the document. A
  round that produced no usable document therefore records a `review_failures`
  row with `stage: recheck` and one D1 log line even when the container's stderr
  is gone. The seat writes a document it already filtered, so the status's
  `rejected_row_ids` is what keeps those rows `invalid-output` instead of
  silently `omitted`, and the status `error` is redacted before it is bounded —
  a secret straddling the cut no longer survives as a fragment.
- **The recheck seat is told how to quote and when context gaps matter.** Its
  assignment now requires copying the cited lines verbatim from the input
  document's `evidence` catalog instead of retyping them, and truncation
  downgrades only the conclusions that depend on the missing context rather
  than every row in the round.
- **A budget-skipped round no longer reads as invalid output.** The seat's own
  `skipped` status now accounts every selected row as `unverifiable/budget`
  (never sent) instead of `invalid-output` (sent and answered badly), and the
  worker bounds a status `reason`/`error` at parse time so the D1 failure text
  and the log field carry one capped value. The same honour applies to the
  worker's own §7.3 size budget: a row the budget excluded from the input was
  never sent either, so it is `budget` even when no document exists — and the
  round still emits its accounting line, naming the exclusion, instead of
  silently accounting every row as an unanswered `invalid-output`. A status from
  another HEAD — or one naming a row this round never sent — attributes nothing.
- **A round the runner cancels by design is no longer recorded as a failure.**
  The runner aborts an unfinished recheck seat as soon as the main review
  settles, so the round answers nothing because it was stopped, not because it
  ran and lost. That abort now reports `skipped` with reason `aborted` instead of
  `failed`/`seat-failed`: the worker writes no `review_failures` row, leaves
  every row `unverifiable/omitted` and leaves the rotation clock untouched, while
  a genuine seat error or non-`Error` rejection keeps `failed`/`seat-failed`.
- **A recheck document-write failure is recorded, not hidden.** The runner
  writes the round status only after the document lands; a failed document
  write exits 1 with no stdout (the worker's runner-failure path), so no status
  ever reports an `ok` for a document that never reached the worker, and D1
  cannot keep a round that published nothing as clean. The status error is
  redacted with the worker's own credential-pattern list
  (`packages/shared/src/secret-shapes.ts` — one canonical list for both halves).
- **A round that delivered nothing reports `failed`, not `ok`.** When the gate
  accepts a document but not one submitted row survives it, the status is
  `failed` with reason `all-rows-rejected`, so the worker writes its
  `review_failures` row instead of keeping a round that delivered nothing as
  clean. A valid document with **zero** results for a non-empty target list is
  the same failure without a gate drop and now reports `failed` with reason
  `empty-result`: the round is attributable and the rows it was sent are
  `invalid-output` (answered badly), never `omitted` (never ran). A partial
  drop still reports `ok` with the rejected IDs. The status's
  `rejected` count is derived from `rejected_row_ids` on read, so the two faces
  of the count cannot disagree.
- **`current-code` closure needs a line the change ADDED.** A verified fix used
  to be provable with an unchanged context line: the quote matched and the range
  sat inside the hunk, so citing pre-change code closed the row. The catalog
  slice now carries `addedNewLines` (the new-side line numbers its `+` lines
  occupy) and a `current-code` citation must include at least one of them; a
  presence-only citation is dropped as `invalid-output`, and a real replacement
  cites `replaced-code`, whose old-side proof already tests that the code
  changed.
- **An empty-result round no longer charges a never-sent row.** The rejection
  covered every unanswered row, so a row the trusted catalog could not prove (or
  whose slices lost the catalog byte budget) still advanced its rotation clock
  even though the seat never received it. Only rows that actually rode the wire
  are now `invalid-output` and counted as attempted; catalog-excluded rows keep
  `no-evidence`, catalog-budget rows keep `budget`, and both keep their clocks.
- **Still-present evidence is tested line by line.** The `removed-code` /
  `replaced-code` "old lines are gone" guard no longer searches the joined
  new-side block for the joined quote: an insertion inside the cited block
  split it and forged a removal. Every non-blank normalized cited line must now
  be absent from the cited range's OWN new-side counterpart — the lines that
  stand where the cited old lines stood, insertions inside the block included —
  so the insertion still proves nothing, while a genuine replacement passes:
  a surviving identical context line inside the range, and identical text that
  only recurs elsewhere in the hunk, no longer make it look present.
- **A size-budget row is judged against the input that is actually sent.** The
  §7.3 byte budget measured each row against the evidence of every candidate,
  including rows that pass was about to drop, so a row excluded early could
  never return even after the evidence set shrank. Rows are now measured
  against the rows already accepted: a dropped neighbour contributes no slices,
  and a row that cannot fit the final input is the only one excluded.
- **The status `reason` is a closed vocabulary.** `budget`, `aborted`,
  `all-rows-rejected`, `empty-result`, `seat-failed` and `invalid-document` are
  the only accepted values (one shared constant both halves use). The worker's
  per-row accounting branches on those exact literals, so an off-vocabulary
  string is dropped on read instead of silently picking a branch.
- **A lost recheck document names its real cause.** A round whose seat reported
  `ok` but whose document failed the read (absent, overflow, validation) used to
  persist `error: "ok: null: null"`. The read cause now leads that text, and a
  zero-byte document reads `absent`: the seat wrote nothing, so the round is
  not blamed for a malformed payload it never produced.
- **A stale drop note no longer erases a real answer.** When the seat's status
  names a row the surviving document also answered, the answer wins instead of
  being overwritten with `unverifiable/invalid-output`.
- **The published coverage line counts real seat answers.** A row the gate
  dropped was attempted and still advances its rotation clock
  (`last_assessed_ms`), but it was never assessed: the coverage line and the
  round's accounting log field count only rows that carry a document result, so
  a round can no longer claim reassessments the seat never delivered. The
  lifecycle clock keeps the attempted rows, so fair rotation is unchanged. Each
  selected row is published under exactly one term — `assessed`, `invalid-output`
  or `omitted`, so `assessed + invalid-output + omitted = selected` — and the
  middle term is the closure table's own label, so the line and the rows agree.
  A gate drop that carried no usable row ID is attributed to the
  sent-but-unanswered row at its position instead of being reported `omitted`;
  the status now carries `rejected_unnamed` (a count, since such a drop cannot
  be named), so that attribution also works for a document the runner already
  filtered. That seat-authored count has no ceiling, so it is clamped to the
  rows it could legitimately claim (sent, unanswered, unnamed): any excess is
  ignored and reported as `rejected_unnamed_ignored`, never spread onto rows the
  seat never received.
- **A finding inside an oversized hunk keeps local evidence.** A hunk larger
  than the 80-line slice bound is no longer excluded whole (which left every
  finding inside it permanently `no-evidence`): it is split into consecutive
  ≤80-line windows, nearest the concern's line first, and each window states
  its start lines from the hunk header's own arithmetic. A quote from inside
  the window validates; a quote outside it still fails.
- **`recheck` and `usage` failures stop paging ops.** The cron failure sweep
  counted every `review_failures` row in the window: its query had no stage
  predicate, and `recheck` was not even an accepted stage yet, so both
  attribution stages — a recheck round that budget-skipped, lost its seat or
  produced an invalid document, and a review that continued after its usage
  event failed to record — could page the on-call for reviews that published
  normally. Both stages are now outside the paging signal, and both are out of
  the per-PR failure count. The per-PR failure history lists BOTH, so a lost
  metered-usage record and a recheck round that produced no usable document
  each keep a surface in the App detail page. The stage list is written once in
  `src/contracts/failure-stages.ts` and interpolated into the sweep and
  dashboard queries; the history query carries no stage predicate at all.
- **Recheck rounds can finish inside their budget**: the recheck seat now runs on its review tier's own wall clock (quick 300 s, default 600 s, deep 900 s) instead of a fixed 180 s that killed it mid-read; the outer guard less a 60 s publication tail caps that clock, so the effective caps are 300 s, 540 s and 780 s. A lost round's status error now names the child's `abortReason`, its stderr tail or its exit code, so a timeout is attributable from D1 instead of a bare `unavailable`.
- **A large recheck round is asked within the seat's context budget.** The seat's
  assignment used to embed the whole `mstar.recheck-input/v1` document — up to the
  512 KiB input cap, ~131k–150k tokens of JSON — so a large round asked for far more
  prompt than a one-shot seat reliably holds and its `yield` never arrived
  (`failed / seat-failed`, status `unavailable`; I-000396). The ask is now fitted to a
  bounded budget: every target and the discussion always ride, and evidence slices ride
  unmodified until the budget is spent — one slice per row first, so the fit can only
  starve rows the budget never reached, never the rows that happen to sort last. The
  seat is told to answer a row whose proof was not retained as
  `unverifiable`/`context-incomplete`, never an unproven `addressed` — and the
  yield is validated against the catalog the seat actually received, so a row
  citing an omitted slice is dropped by name instead of being published as
  `addressed`. Document-level validation and the strict output schema are
  unchanged.
- **A round that cannot be asked is recorded, never dispatched.** When targets plus
  discussion alone exceed the budget, no seat is started: the round reports
  `skipped`/`budget` with a bounded error naming the required and available bytes, so
  the worker accounts every sent row `unverifiable/budget` instead of spending the
  180s window on a guaranteed empty yield.
- **The ask budget is an operator setting.** `review.recheck.assignment_max_bytes`
  (default `65536`, range `8192..262144`) is a system runtime setting on the
  operator console, read once per round and passed to the runner as a top-level
  input field — the frozen `mstar.recheck-input/v1` document is unchanged. A model
  with a larger window can therefore take a larger ask without a redeploy.
- **A removed login cannot be re-created**: sign-in's own row creation (`signInCreateUser`) carries `WHERE NOT EXISTS (removal record)`, so an OAuth callback cannot create a `users` row for a login recorded in `removed_logins`.
- **A tombstone on a live account stops new invites, not sign-in**: a login that still has a `users` row keeps signing in and keeps its memberships, and a pending invite minted before the tombstone can still be accepted; only minting a new invite is refused. Sign-in is refused once the row is gone.
- **Removal has no in-product surface**: no owner can undo a tombstone. The invite route answers 409 `invite.login_removed` (the dashboard surfaces only its generic invite-failure notice), and the only writer that clears a tombstone (`createUser`) has no production caller — tombstones are maintained by a deployment operator directly in D1. **Leaving a workspace is not a removal**: that deletes only the `workspace_members` row, so the account, its invites and its GitHub login are untouched.
- **The durable runner-failure text now reports stdout in real UTF-8 bytes.** `runnerFailureDetail` printed `String.length` with a `B` suffix, so a run that emitted non-ASCII output under-reported its size — counted UTF-16 code units rather than UTF-8 bytes. The count now matches the sibling git-stage detail, and an empty stdout still reads `0B`.
- **The runner input travels on the exec stdin pipe**: the `--input` document is now base64-encoded into the container step's stdin (`base64 -d > '<path>'`) instead of being embedded in the shell string. A recheck round with enough findings pushed the encoded document past Linux's 128 KiB per-argument limit, so `execve` returned `E2BIG` and every later round died at `stage=sandbox` before `timeout` started. The write step still fails the round on a non-zero exit.
- **Commands that approach the per-argument limit fail closed with a readable error**: `runCommand` measures the command (and each env value) in UTF-8 bytes before starting a container or a process, and refuses above 96 KiB (8 KiB per env value). The error names the size and the bound and never echoes the command, so an over-large step is diagnosed as a step problem instead of a platform `E2BIG`.
- **The sandbox image no longer fetches its toolchains from GitHub's release-asset CDN.** `github.com/…/releases/download/…` answered `504` for the Bun and gh CLI assets, which failed the image build and with it the staging deploy. Retrying does not recover it: eight attempts from the build network all returned `504` while `github.com`, `codeload` and `git` stayed healthy. Bun now comes from the official Docker Hub image copied at a pinned digest (still 1.4.0, declared as `bunImageDigest` alongside `bunVersion`), and gh installs from GitHub's own apt pool. Docker Hub is already a hard dependency of this Dockerfile — the base image and the sandbox shim are copied from it.
- **gh CLI installs unpinned from GitHub's apt pool, on purpose.** Four probes of that pool on 2026-11-08 resolved 2.98.0 and 2.103.3 but returned 404 for 2.90.0 and 2.80.0, so an old release is not demonstrably durable there and a filename-pinned URL can turn a future cold build into a 404. The image therefore installs whatever the pool serves and writes the resolved `bun`/`gh` versions into `/etc/mstar-image-versions` — the build log alone is not inspectable from a running executor. `gh` is the one build input not recorded in `OMP_SANDBOX_IMAGE_PINS`, and the type carries that trade-off in writing.
- **`unzip` is gone from the image.** It existed only to expand the Bun release zip, which no longer exists; nothing else in the file unpacks an archive.
- **A malformed refusal param no longer prints `[object Object]` on the settings page.** Both readers of a mapped 400 body — the shared settings/pinned-op resolver and the key-verify path — cast `params` on a bare `typeof === "object"` check, so a server body whose param value was an object or an array interpolated `String(value)` into the localized sentence (`[object Object] is not a supported provider…`) or left `{provider}` bare. A param is now accepted only when every value is a string or a number; otherwise the keyed face is refused and the reader's own generic copy renders, never the raw JSON body.
- **The dashboard shell is pinned to the viewport.** The sidebar and navbar no
  longer scroll away with the page: the shell wrapper and the inset are
  viewport-height and non-scrolling, and the page body is the single vertical
  scroll container. Narrow widths keep the in-flow sidebar column.
- **Printing a dashboard page no longer clips to one viewport.** The pinned shell
  keeps the sidebar and navbar in place on screen, but relaxes its fixed height
  and hidden overflow under print media, so a printed page grows to its full
  content.
- **Review threads bind and resolve again**: two identity/anchor shape mismatches kept every association at `pending` forever. GitHub reports this App's own login as `<slug>[bot]` over REST but as the bare `<slug>` from GraphQL `author.login`, and the ownership comparison demanded only the suffixed form — so every discovery resolved `unknown`/`foreign` and no thread, comment or review id was ever bound. Thread ownership and review-stub identity now accept both shapes of the one canonical identity, and still require the `Bot` author type beside it. Read-only publication recovery stops trusting the login text entirely — a copied body is not authorship — and proves authorship from GitHub's authenticated viewer-author flag on the captured comment, so a human account named after the App cannot pass. Separately, the comments of a freshly created line review are now matched to their findings by the trusted thread marker in the comment body, because that endpoint answers with `line`, `original_line` and `side` all null; the path/line anchor remains only as the fallback for a comment without a readable marker, and an unknown or duplicated marker never fabricates a mapping. Same endpoints, same request count.
- **Review conversations can now close**: a recheck round binds each prior finding's review thread before it captures that thread's discussion, so an association whose original send response was lost — and therefore had no stored thread id — can still earn a verified resolution instead of staying open forever. The pass is bounded per review round, and any association the bound could not reach stays queued for a later round. The created line review's comment ids are now read back from the review's own comments connection, because GitHub's create-review response carries no comments array — without them the posted comments could never be matched back to their findings. A failed read leaves the capture unconfirmed rather than failing the review, so nothing is fabricated.
- **Trigger-mode selection echoes on save success**: the App settings control no longer holds a stale highlight after a successful save — the saved mode is highlighted as soon as the save resolves (success means stored) instead of waiting for the background reload; failed saves still resync from the stored mode.
- **Escape closes the usage panel you opened last**: Escape still dismisses the panel you opened last, even after a re-render hands it a new close callback.
- **The workspace check-min-score audit records the floor the workspace was
  actually running.** The ledger's `before` used to name the platform default
  (60) even when the stored floor was unreadable and therefore never in effect.
  It now records the absent state (`null`) for any value the reader does not
  trust, so the ledger names only floors a workspace actually ran with.
- Connecting a GitHub App no longer reports a generic database rejection when the workspace's default score floor cannot be read: the connect page names the unreadable workspace setting, states that nothing was stored, and links to the workspace settings page to repair it before resubmitting. A genuine database failure keeps its own copy.
- **App creation works once a deployment has several workspaces.** The creation
  right is now judged in the workspace the request addresses (`owner`/`admin`
  there), not in "the deployment's only workspace", which stopped existing the
  moment a second workspace was created. The SPA's Create action posts under the
  page's own workspace prefix and the chosen workspace's stable id rides the signed
  state and the encrypted hold, so the App lands where the operator started
  even if that workspace is renamed mid-flow.
  A request that names no workspace on a multi-workspace deployment now answers
  `409 {"code": "workspace_required", …}` (styled error page for a navigation)
  instead of a bare `403`.
- **The Create action no longer disappears.** When the caller cannot run the
  flow, the SPA renders the control disabled with the reason — the addressed
  workspace's role, or the missing workspace — in both locales.
- **`/dashboard` lands on a real route.** A login with several memberships is
  sent to its first workspace's Apps page (its membership list is ordered by
  name, then id) instead of the retired `/dashboard/apps` root, and the shell's
  nav follows that workspace.
- **The operator audit-order tests are deterministic.** `audit_events` rows
  written inside one request batch share a millisecond, so the tests now break
  the tie on `rowid` (write order) rather than the random UUID primary key.

### Removed

- **BREAKING — the deployment-wide review brake is gone.** The `REVIEW_ENABLED`
  Worker variable no longer exists: no reader, no env declaration, no docs row,
  no `keep_vars` note, no test fixture. Per-App
  `github_apps.review_enabled` (the dashboard Pause/Resume switch) is the only
  review control, so no deployment-level value can freeze every tenant's
  reviews. Behaviour is otherwise unchanged: a webhook for an App with
  `review_enabled = 1` enqueues, and one with `0` is ignored with 2xx and zero
  enqueue.
- **A deployment still holding `REVIEW_ENABLED=false` resumes reviews for every
  App except those already paused the moment this Worker lands.** The value is
  no longer read, so it can no longer keep anything frozen: an App with
  `review_enabled = 1` starts reviewing for real on its next webhook, while
  Apps already at `review_enabled = 0` stay frozen. **Before deploying**, apply
  one of the three stop levers to each App you meant to keep frozen: pause it
  (`review_enabled = 0` on its dashboard Settings page), disable it in the
  dashboard (`POST /apps/:slug/disable` sets `status = 'disabled'`, and a
  disabled App 404s at the webhook face), or suspend it at GitHub. There is no
  deployment-wide brake. **Upgrade note:** delete the leftover `REVIEW_ENABLED`
  Worker variable (and the matching GitHub Actions variable, if one was set) —
  nothing reads it, and leaving it behind suggests a control that no longer
  exists.

## [1.0.0-alpha.2] - 2026-09-14

### Changed

- **App settings page gains a GitHub identity card**: avatar, the App's name hyperlinked to its GitHub settings page, description, and App ID — served from GitHub metadata fetched per-App with a dashboard-local App JWT, cached in D1 with a 24h lazy refresh, and degrading gracefully when GitHub is unreachable.
- **Provider picker rebuilt**: the flat 214-entry dropdown is now a type-to-filter combobox (full keyboard operability), with a new "Common providers" group (Anthropic, OpenAI, Google Gemini, GitHub Copilot, xAI) ahead of the catalog templates; provider terminology is unified as "model provider" in Chinese. Runner/BYOK mechanics are unchanged.
- **Model-chain micro-UX**: the new-chain draft tab now live-relabels as you type the chain name, and the discard button sits inline with save as a visible outline control.
- **Insights stat sections are now charts**: findings by severity and by category render as count bars, weekly trends as a dual-series (reviews/findings) chart with a dated axis and legends — hand-rolled SVG, zero new dependencies, dark/light theme tokens.

## [1.0.0-alpha.1] - 2026-09-07

### Added

- Added a **GitHub Actions release chain**: the manually-triggered **Release prep** workflow assembles changelog fragments, bumps the version surface, validates, and opens a `release vX` PR; merging it triggers the **Release** workflow, which re-verifies on the merge commit and cuts an annotated tag plus a bilingual GitHub Release. Releasing is fully decoupled from deploying — staging automation is untouched.
- Established the **bilingual changelog fragment protocol** (`.changes/`): every change ships a fragment with paired English / Chinese bullets, assembled into `CHANGELOG.md` / `CHANGELOG_CN.md` at release time and archived per released version.
- **Version visibility**: `/healthz` now reports the deployed version and the dashboard displays it (single source `package.json#version`), with consistency pinned by `release:validate`.
- **Release ↔ deploy reconciliation**: release notes record the deployed Worker Version ID, sandbox image digest, and deploy run link from deploy evidence — never blocking the tag, and stating explicitly when evidence is missing.

### Baseline

- **Automated PR reviews as real agent sessions**: every review runs a multi-seat coding-agent session inside a one-shot Cloudflare Sandbox container (clone → review → destroy), with no secrets baked into the image.
- **Review pipeline**: GitHub webhooks land on a Hono Worker gateway (per-App routing + signature verification) → Cloudflare Queues → Sandbox execution → one upserted PR comment plus structured `mstar.review/v1` findings stored in D1.
- **Review engine**: `/amazing-pr-review` multi-tier reviews (quick / default / deep) with classified findings, line comments, model-chain fallback, and persisted review version records.
- **Operational hardening**: per-App sandbox image management, a fixed provider allowlist, rate limiting, Cron-based monitoring, and fail-closed review semantics — a misconfigured App fails loudly on its own credentials, never on someone else's.
- **Insights**: finding fingerprint deduplication and per-App Health reports turn stored findings into recurrence and quality signals.
- **Deploy automation**: a full GitHub Actions chain — CI on PRs, automated staging deploys with secrets injection, D1 migrations, post-deploy smoke, and image-digest records.
- **Dashboard platform**: register and operate any number of GitHub Apps from one deployment, each with its own access control, BYOK provider keys, model chain, and operations surface (pause/resume, settings, member management).
- **Dashboard experience**: a bilingual (en / zh-CN) Vite SPA with a shadcn-based visual system, redesigned information architecture, per-App sandbox image registry selection, and feedback-driven polish.

