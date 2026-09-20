# Deploy — mstar-inspector

> **Primary path: automation.** Merging to `main` deploys automatically via
> [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml): D1
> migrations, secrets injection, `wrangler deploy`, post-deploy smoke, and the
> image-digest record all run in CI. The manual runbook below is retained as
> reference / rollback material.
>
> Status: the ops-config surfaces have landed (queue concurrency cap +
> cron failure sweep + optional alert webhook — SSOT in § Ops config below);
> this runbook documents the full procedure; each deploy fills the
> deployed image digest + deploy date in § Image pins and digest record.
> 2026-08-31: domains/preview surface added (§ Domains and previews).

## Automated deploy (primary path)

Merging to `main` triggers the **Deploy** workflow
([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)):

- **Triggers** — `push` to `main` (skipped for `docs/**`, `.mstar/**`, `*.md`,
  `LICENSE` — doc-only pushes need no redeploy) and manual `workflow_dispatch`
  (emergency channel, not subject to the path filter). Deploys are serialized
  (`concurrency` group, no cancel-in-progress).
- **Sequence** — `test` job (typecheck + `build:spa` + unit tests, mirrors `ci.yml`) →
  `deploy` job: account verification → secrets injection (`wrangler secret
  bulk`, required + optional alert) → D1 migrations (`--remote`) →
  `bun run build:spa` → `wrangler deploy` → post-deploy smoke (healthz / cron / digest) → digest
  recorded in the run summary + `deploy-evidence` artifacts (§ Image pins and
  digest record).
- **Failure semantics** — any step failure turns the run red and **stops**
  (no automatic rollback): D1 migrations are forward-only, so a rollback after
  they applied would be a schema mismatch. A red run means a human intervenes
  (see § Rollback); a deploy that succeeded but failed to record its digest
  baseline is also red — the digest is recoverable from the run's
  `deploy-evidence` artifact (see § Image pins and digest record).

## Prerequisites

### Cloudflare resources (one-time)

All bindings are declared in `wrangler.jsonc`; the backing resources must
exist before the first deploy:

- KV namespace `IDEMPOTENCY_KV` (id `554c5cd446e4401fa878570ac66bbba4`,
  already in `wrangler.jsonc`).
- Queues — create BOTH before deploy (the consumer config references the DLQ
  by name):
  ```bash
  wrangler queues create review-queue
  wrangler queues create review-dlq
  ```
- D1 database `mstar-inspector-db` (id
  `7a737173-e202-430f-8b47-e087d5e885c4`, already in `wrangler.jsonc`) with
  migrations applied — see below.
- Containers: no separate setup — the `Sandbox` DO class builds from
  `sandbox-image/omp/Dockerfile` at deploy time (`image_build_context: "."`,
  `instance_type: lite`, `max_instances: 1`).

### D1 migrations (0001–0022, forward-only)

```bash
wrangler d1 migrations apply mstar-inspector-db --remote   # production
wrangler d1 migrations apply mstar-inspector-db            # local dev
```

| Migration | Contents |
|---|---|
| `0001_reviews` | reviews + findings base tables (Central Review Store) |
| `0002_mstar_review_v1` | mstar.review/v1 envelope columns (era lock: `envelope IS NOT NULL` ⇔ v1 row) |
| `0003_dashboard_users` | dashboard membership |
| `0004_github_apps` | multi-App registry (secretbox-encrypted App credentials) |
| `0005_reviews_app_id` | `reviews.app_id` attribution (NULL = historical rows from the retired global App — archaeology: the legacy env-App face was deleted) |
| `0006_app_provider_config` | per-App BYOK provider keys + model chain |
| `0007_reviews_app_id_index` | index on `reviews.app_id` |
| `0008_github_apps_ops` | per-App ops columns (`review_enabled` pause switch) |
| `0009_app_model_roles` | per-App per-role model overrides |
| `0010_review_failures` | all-stage failure table — the cron sweep's signal |
| `0011_webhook_deliveries` | per-App webhook delivery log |
| `0012_custom_providers_and_key_updated_at` | per-App custom provider declarations + provider-key `updated_at` |
| `0013_findings_review_id_index` | index on `findings.review_id` — insights/previous-round lookups |
| `0014_idx_reviews_reviewed_at` | index on `reviews.reviewed_at` — insights window scans |
| `0015_provider_verification` | per-App key `verified_at`/`verified_status` + `app_provider_models` cache |
| `0016_users_login_nocase_unique` | NOCASE unique index on `users.github_login` — case-insensitive membership uniqueness (QC W-1) |
| `0017_app_model_chains` | default + named model chains (`app_model_chains` + `app_model_chain_seats`), backfilled from `app_model_config`/`app_model_roles` |
| `0018_app_sandbox_images` | `github_apps.sandbox_image_id` NOT NULL DEFAULT 'omp' — backfills live AND soft-deleted rows, so no manager visit is needed after deploy |
| `0019_github_apps_metadata` | five metadata-only ADD COLUMNs caching the App's public GitHub profile (`github_name`/`github_description`/`github_html_url`/`github_avatar_url`/`github_metadata_synced_at`) for the settings info card — all nullable, safe over a live DB |
| `0020_finding_lifecycle` | the finding-lifecycle and private pre-publication journal tables (`review_publications`, `review_findings`, `review_finding_rounds`, `review_threads`) — publication proof, closure and thread-resolution state (spec §7.1) |
| `0021_review_checks` | the per-attempt Check registry (`review_checks`) behind the advisory Check Runs, with `UNIQUE(attempt_key, generation)` and the partial unique index keeping at most one nonterminal generation per attempt key (spec §7.1/§7.9) |
| `0022_app_trigger_mode` | `github_apps.review_trigger_mode` TEXT NOT NULL DEFAULT 'every_push' CHECK (review_trigger_mode IN ('open','every_push','manual')) — the per-App review trigger mode (spec `review-trigger-policy.md` §2); metadata-only ADD COLUMN, existing rows (live and soft-deleted) materialize to the `every_push` default, no manager visit needed |

Migrations are **forward-only** (0002 precedent): never hand-edit an applied
migration; add the next file.
Note: migration 0006's `app_model_config` comment ("NULL / absent row = unset → falls back to the global OMP_REVIEW_MODEL") is superseded by AL-24-5 — chain-less Apps fail closed, no global chain since v0.9.

### Secrets and vars inventory

Worker secrets are managed as **GitHub Secrets** — the Deploy workflow
injects them into the Worker via `wrangler secret bulk` on every deploy
(no manual `wrangler secret put` on the primary path). `.dev.vars` is for
local `wrangler dev` only; never put secrets in git (full per-key notes in
`.env.example`). GitHub does not allow secret names starting with `GITHUB_`
(that prefix is reserved for GitHub's own env), so the **GitHub-side** names
drop the prefix, while the **Worker-side** names (the keys `wrangler secret
bulk` writes, and what `src/worker/env.ts` reads) stay unchanged:

| GitHub name (create in staging env) | Worker secret name (bulk key — unchanged) | Kind | Required | Purpose |
|---|---|---|---|---|
| `OAUTH_CLIENT_ID` | `GITHUB_OAUTH_CLIENT_ID` | **variable** (not sensitive) | dashboard | user OAuth login (distinct from the review App) |
| `OAUTH_CLIENT_SECRET` | `GITHUB_OAUTH_CLIENT_SECRET` | secret | dashboard | user OAuth login App secret |
| `DASHBOARD_SESSION_SECRET` | `DASHBOARD_SESSION_SECRET` | secret | dashboard | session-cookie HMAC key |
| `DASHBOARD_ENCRYPTION_KEY` | `DASHBOARD_ENCRYPTION_KEY` | secret | multi-App | AES-256-GCM master key for D1-stored App credentials |
| `ALERT_WEBHOOK_URL` | `ALERT_WEBHOOK_URL` | secret | no — **NEW** | ops sweep alert webhook; unset = log-only alerting (§ Ops config) |

The Deploy workflow maps `vars.OAUTH_CLIENT_ID` →
`env.OAUTH_CLIENT_ID` → `GITHUB_OAUTH_CLIENT_ID` in the bulk payload (same
for `OAUTH_CLIENT_SECRET` → `GITHUB_OAUTH_CLIENT_SECRET`); the values reach
the Worker under the unchanged `GITHUB_` names.

**Environment scoping** — the Deploy workflow's `deploy` job targets the
**`staging` environment** (`environment: staging` on the job), so secrets
resolved for it are the **staging environment** secrets (environment-level
secrets override repository-level ones). `OAUTH_CLIENT_ID` is a **variable**
(environment-level variables override repository-level ones). Configure them under
Settings → Environments → `staging` → **Secrets** (and
Settings → Environments → `staging` → **Variables** — `CLOUDFLARE_ACCOUNT_ID`
is a good environment variable candidate, though it is also read from a repo
variable / secret per the CI-credentials note below). Repository-level
secrets keep working as the fallback for any name not set at the environment
level.

The four required secrets are asserted non-empty in the workflow (a missing
value fails the run red — `wrangler secret bulk` treats a JSON `null` as a
secret **deletion**, so empty values must never reach it). `ALERT_WEBHOOK_URL`
is optional: when the GitHub Secret is set the workflow writes it to the
Worker; when it is absent the workflow **deletes** it from the Worker (a
previously set webhook does not linger) and the Worker falls back to log-only
alerting (§ Ops config).

**CI credentials** — the workflow authenticates wrangler with one GitHub
**Secret** that is never injected into the Worker: `CLOUDFLARE_API_TOKEN`
(wrangler auth). The deploy account id `CLOUDFLARE_ACCOUNT_ID`
(`f68fcd78e7c5c10f0466788bb9e85b8e`) is **public** (not a credential) and is
configured as a **variable** — the workflow reads it from
`vars.CLOUDFLARE_ACCOUNT_ID` (repo variable, or an environment variable under
`staging`). The account-verification step asserts it non-empty and runs
`wrangler whoami` (the run log shows the authenticated account for manual
cross-check); a missing value fails the step red (see § Local tooling for the
stale-account trap this guards).

**Token permissions** — the `CLOUDFLARE_API_TOKEN` must be an **Account API
Token** scoped to the deploy account (`f68fcd78e7c5c10f0466788bb9e85b8e`)
with at least: **D1 → Edit** (migrations apply), **Workers Scripts → Edit**
(`wrangler deploy` + `secret bulk`), **Workers Containers → Edit**
(`containers list` digest extraction). A token that passes `wrangler whoami`
but lacks D1 access fails the migration step with
`The given account is not valid or is not authorized to access this service
[code: 7403]` — the account id is correct; the token's permissions are not.

Provider API keys and the review model chain are **not** Worker env — they
live per App in D1 (`app_provider_keys` / `app_model_config`, migration
0006), configured on each App's dashboard Settings page and injected into the
review container from the App's config only (AL-24-5: the
`OMP_MODEL_KEY` / `OMP_REVIEW_MODEL` / `bun run keys` Worker-secret surface
was retired with the global fallback — an App missing its chain or a chain
provider's key fails its reviews closed).

Plain vars — `wrangler.jsonc` `vars` or the dashboard's Worker variable
settings; redeploy to change:

| Name | Default | Purpose |
|---|---|---|
| `REVIEW_ENABLED` | unset | **emergency brake only**: per-App `github_apps.review_enabled` is the primary review control; only the exact `"false"` (case-sensitive, untrimmed) stops ALL reviews — unset / `""` / `"true"` / `"TRUE"` / other → per-App governs |
| `ADMIN_LOGINS` | unset | comma-separated GitHub logins bootstrapped as dashboard admin |

> **REVIEW_ENABLED cutover checklist (上线即生效 — run BEFORE the deploy that
> flips the semantics; the semantic inversion takes effect the moment the Worker lands):**
>
> 1. `wrangler d1 execute mstar-inspector-db --remote --command "SELECT slug, status, review_enabled FROM github_apps WHERE deleted_at IS NULL;"`
> 2. Confirm each App's state matches operational intent: a `review_enabled=1`
>    App will **immediately review for real** on a live Worker with unset
>    `REVIEW_ENABLED`; any App that must not review yet must be paused
>    (`review_enabled=0`) or disabled first.
> 3. Confirm the live Worker env: set `REVIEW_ENABLED=false` only for an
>    emergency all-stop; otherwise leave it unset. The old `.env.example`
>    empty value no longer means "everything off" after this deploy.
> 4. Post-deploy spot check: an installed App with `review_enabled=1` opening /
>    updating a PR should enqueue; a paused App still answers 2xx with zero
>    enqueue.
> 5. Spot-check the dashboard: no `REVIEW_ENABLED` copy on any page; the
>    Pause/Resume switch is the only review control.

#### GitHub App permissions (fresh-App contract)

The App is created by the dashboard manifest flow (`src/dashboard/manifest.ts`
`buildManifest`); the requested permission set is the locked contract in
[`.mstar/specs/review-lifecycle.md`](../.mstar/specs/review-lifecycle.md) §7.6
and mirrored in `.env.example`:

| Permission | Access | Why |
|---|---|---|
| Contents | **write** | Worker-only, one purpose: resolving positively verified, Inspector-owned review threads. No code-write / push / merge authority. |
| Metadata | read | required by GitHub |
| Pull requests | **write** | the review and its line comments |
| Issues | **write** | the single overall-comment upsert |
| Checks | **write** | advisory review Check Runs — execution status only (`mstar-inspector review` on the reviewed commit). Never an approval or a merge gate. |

**What the Check means.** A `success` conclusion records that the review **was
published** — for every engine verdict. It is not an approval, not a merge
gate, and never a `REQUEST_CHANGES` equivalent; the app requests neither
event. A confirmed degraded publication is `neutral`; an execution failure or
an unconfirmed publication is `failure`. Conclusions are decided from persisted
publication proof, not from the code path, and a Check failure never blocks or
delays the review. The run carries no `details_url`.

**Branch protection is user-controlled.** The app never configures, requires or
recommends a required status check. Whether any Check gates a merge is entirely
the repository owner's choice.

**Two same-name runs are possible (RL-12).** Local attempt fencing is not
external exactly-once, and `external_id` is correlation rather than a
server-side idempotency key. An attempt whose create was **unconfirmed** — the
response was lost, or a refusal landed after the request was dispatched — is
settled read-only by recovery: it adopts and terminalizes, and never creates a
second run. But a **later attempt for the same commit** is a fresh generation
with its own `external_id`, so it creates its own run instead of adopting the
earlier one. GitHub then shows **two runs of `mstar-inspector review`** for one
commit, and the **newest applicable attempt** is authoritative (it carries the
latest persisted proof). This is not a duplicate review and never authorizes
publishing twice.

Two credential boundaries back this set: the Worker mints a purpose-scoped
`review-write` grant that never leaves the Worker, while every Sandbox and
smoke token is the explicitly **repository-scoped, read-only** `sandbox-read`
grant (`contents: read`, `metadata: read`, `pull_requests: read` — the last
one because the diff step runs `gh pr diff` with exactly that token); the
Worker asserts the returned capabilities (`assertSandboxGrant`) and fails
closed on anything broader or unscoped. Webhook events stay `pull_request`
and `issue_comment`.

> **Evidence caliber:** the permission set, the purpose-scoped mint/assert and
> the recovery lanes are covered by the implementation's scoped behavioral
> tests and static checks. Live GitHub / GitHub App behavior is **not**
> verified — no live scoped run was authorized for this delivery
> (§7.13). The historical v0.2 iteration runbook (single global App,
> `wrangler secret put APP_ID`) is superseded by the dashboard manifest flow
> above and is no longer a permission reference.

### Local tooling

- Bun ≥ 1.3.14 (`package.json` engines) + `bun install`.
- wrangler 4.125.0 (pinned devDependency — `bunx wrangler` resolves it; a
  bare `wrangler` works when the global install matches).
- Authenticated to the target Cloudflare account (`wrangler login`, or
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in CI).
  Account-id trap (hit live 2026-08-31): a stale `CLOUDFLARE_ACCOUNT_ID`
  exported in the shell (from another account/project) makes wrangler target
  the WRONG account → `Authentication error [code 10000]` on every API call
  (even `deployments list`). The correct account for this repo is
  `f68fcd78e7c5c10f0466788bb9e85b8e` (Bohao's Account). `wrangler whoami`
  prints the OAuth account but does NOT override the env var — unset it:

  ```bash
  unset CLOUDFLARE_ACCOUNT_ID   # or export the id above
  ```

  In CI the Deploy workflow guards the same trap: the account-verification
  step asserts the `CLOUDFLARE_ACCOUNT_ID` variable (see § Secrets and vars
  inventory) is non-empty and runs `wrangler whoami` — the run log shows the
  authenticated account for manual cross-check against
  `f68fcd78e7c5c10f0466788bb9e85b8e`.

## Domains and previews (2026-08-31 record)

Production URL: `https://mstar-inspector.42ch.dev` — a Workers **Custom
Domain** (Cloudflare API/dashboard-attached, NOT declared in
`wrangler.jsonc`; `wrangler deploy` leaves such attachments untouched). The
Worker also serves its default
`https://mstar-inspector.silent-dew-2478.workers.dev` (account subdomain
`silent-dew-2478`).

A second custom domain `staging-inspector.42ch.dev` was briefly attached to
the SAME production script (a production alias, not a staging environment).
Decision 2026-08-31: REMOVED. Rationale: a genuine staging pair needs a
separate Worker (`env.staging`-style, own name) with its own KV/queues/D1/
container resources — sharing this Worker's bindings or pointing another
domain at the same environments would consume production queue messages and
write production D1. Until that iteration lands, pre-release verification
runs through the flows below instead of a staging domain.

### Pre-production verification (this Worker's real options)

**No versioned Preview URLs.** The Worker implements the `Sandbox` Durable
Object (container binding) — Cloudflare does NOT generate preview URLs for
Workers implementing a DO (docs: Preview URLs → Limitations; verified live:
every version row reports `has_preview:false` and versioned
`<prefix>-mstar-inspector.silent-dew-2478.workers.dev` hosts 404). The
flows that DO work:

1. **Version upload without deploy (verification via gradual rollout).**
   `wrangler versions upload` registers a version that serves 0% traffic and
   prints NO preview URL for this Worker — verify by deploying it at 0%:
   ```bash
   wrangler versions upload --tag "pr-<N>" --message "..."
   wrangler versions deploy <version-id>@0%          # prod stays 100% old
   # pin a test request to the new version in the CURRENT deployment:
   curl -s https://mstar-inspector.42ch.dev/healthz \
     -H 'Cloudflare-Workers-Version-Overrides: mstar-inspector="<version-id>"'
   ```
   The override header only applies while the version is in the active
   deployment (the 0% slot above) — that IS the pre-prod check. Bump to 100%
   with `wrangler versions deploy <version-id>@100%` when satisfied.
   (Version override smoke-tested semantics: docs Version overrides.)
2. **Gradual canary** — same command with e.g. `@10%` instead of `@0%`:
   real traffic splits between old/new; DO instances are assigned a version
   per deployment and reset once when reassigned (docs: Gradual deployments
   with Durable Objects).
3. **Dashboard** — Workers & Pages → mstar-inspector → Deployments: promote
   a version or adjust the split graphically.

Caveats for this container Worker: only ONE version of the Sandbox DO runs
at a time (per-DO assignment, single global class) — a 0% version pinned via
override still boots the container; keep DO-class lifecycle changes out of
verified versions (uploads with lifecycle changes are rejected; deploy them
only via `wrangler deploy`).

## Deploy steps (manual reference)

> The automated path (§ Automated deploy) runs the same sequence in CI —
> typecheck/test → secrets → D1 migrations → `wrangler deploy` → smoke →
> digest record. The steps below are the manual equivalent, kept as reference
> for local runs and for recovering from a failed automated deploy.

Order lock (plan Clarify #5): code merge → `wrangler deploy` (the container
image auto-rebuilds when the Dockerfile/build context changed) → post-deploy
smoke → record the digest.

1. `bun install`
2. `bun run typecheck && bun test` — both must exit 0.

### Sandbox smoke

3. Local sandbox smoke — builds the image and exercises the real sandbox path
   via `wrangler dev` (config `wrangler.smoke.jsonc`, entry
   `src/pipeline/smoke-entry.ts`). The orchestrator reads **shell env only**
   (never Worker secrets, never D1): `SMOKE_APP_ID` + `SMOKE_PRIVATE_KEY`
   (inline PEM or `~`-relative/absolute path — the local orchestrator's
   dual form, resolved by scripts/sandbox-smoke.ts) for the purpose-scoped
   `sandbox-read` installation-token mint — restricted to the one GH_REPO
   repository and asserted read-only against the **returned** grant
   (`assertSandboxGrant`), so a broader or unscoped capability fails the smoke
   closed — plus the optional
   `INSTALLATION_ID` (default 156621513), `GH_REPO` (default
   btspoony/todo-bots), `GH_PR` (default 1), `SMOKE_ROUTE` (default `/smoke`),
   and `ARK_API_KEY` (required when `SMOKE_ROUTE=/smoke-review`):
   ```bash
   SMOKE_APP_ID=… SMOKE_PRIVATE_KEY=… bun run scripts/sandbox-smoke.ts
   # /smoke: getSandbox → exec gh pr diff → destroy
   SMOKE_APP_ID=… SMOKE_PRIVATE_KEY=… SMOKE_ROUTE=/smoke-review ARK_API_KEY=… \
     bun run scripts/sandbox-smoke.ts
   # /smoke-review: full in-image runner (clone + omp review + parse) → destroy
   ```
4. `bun run build:spa && wrangler deploy` — build the SPA assets first
   (`dist/spa` is gitignored — a fresh clone has none, and `wrangler.jsonc`
   serves them via `assets`), then deploy the Worker (webhook face + queue
   consumer + cron trigger). The step also rebuilds/pushes the container
   image when the build context changed. **Copy the image digest from the
   deploy output.**
5. Record the digest baseline — on the automated path the workflow writes it
   to the run summary (`$GITHUB_STEP_SUMMARY`) and uploads `deploy-evidence`
   artifacts; the manual equivalent is to note the digest from the deploy
   output (or `wrangler containers list --json`).
   **Digest drift check (DOCS-01):** after every deploy, verify the live
   version + image against the recorded baseline —
   ```bash
   wrangler deployments list   # or: wrangler versions list
   wrangler containers list --json   # live image digest
   ```
   The **baseline** is the latest successful run's summary / `deploy-evidence`
   artifact (see § Image pins and digest record); the **live truth** is
   `wrangler containers list --json` — a stale baseline makes the "which
   image is live" audit wrong.

### Sandbox image — U-001 synthesis verification

The image ships `/opt/verify-synthesis.sh` (repo `sandbox-image/verify-synthesis.sh`,
COPY'd into the digest — AL-25-3). It replays the U-001 evidence on
ANY image build: per-review models.yml synthesis through the runner's
real `writePerReviewModelsYaml` (the omp capability hosts — `ark-plan`
synthesized without any baked file — plus the keyless custom
declaration `u001-verify` / `https://example.invalid/v1` / `verify-model`),
omp SDK `ModelRegistry`
resolution of the synthesized file, and a minimal `createAgentSession` on the
synthesized `agentDir`. Load-level only — no provider call, no network, zero
secrets; idempotent (`/tmp/omp-agent-<uuid>` only, cleaned up). Not a build
gate; run manually after a build/deploy:

```bash
docker run --rm --entrypoint /opt/verify-synthesis.sh <image>
# expect U001_VERIFY=pass and exit 0 (KEY=VALUE evidence lines per layer)
# --entrypoint is required — the sandbox default entrypoint is long-lived
# (it keeps the server alive after the user command) and would never
# surface this one-shot script's exit code.
```

## Post-deploy smoke

> The Deploy workflow runs the automated smoke on every deploy: healthz
> (3 attempts, 5s apart), cron registration (grep of the deploy log for
> `schedule: */15 * * * *`), and image-digest extraction (live container
> state). Any failure turns the run red and stops. The manual checks below
> are extra / local investigation steps, not the workflow smoke — for local
> runs and for investigating a red run.
>
> **URL permanence:** `/dashboard/apps` — and `/dashboard/apps/` —
> are permanently retired → 301 `/dashboard`; do not re-introduce the path
> (browsers cache the 301).

1. **Cron trigger registered** — the `wrangler deploy` output lists the cron
   trigger `*/15 * * * *` (also visible in the dashboard under Workers →
   mstar-inspector → Settings → Triggers). The sweep is quiet below
   threshold: no log line is expected on a healthy system
   (`src/worker/sweep.ts` emits only the breach event / warns).
2. **D1 migration check (real D1)** — verifies migration 0010 applied and the
   sweep's signal table is queryable:
   ```bash
   wrangler d1 execute mstar-inspector-db --remote --command \
     "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
   wrangler d1 execute mstar-inspector-db --remote --command \
     "SELECT COUNT(*) AS n FROM review_failures"
   ```
   `review_failures` must be present and the count queryable.
3. **End-to-end review (v0.6 `modelOverrides` pin)** — with
   `REVIEW_ENABLED` unset (or any value except the exact `"false"` — the
   emergency brake), open or update a test PR on an installed repo and
   confirm the review comment lands (the App's trigger mode must cover the
   event — the default `every_push` auto-triggers on open/update; from any
   mode, a PR comment @mentioning the App's bot forces a run —
   § Review triggers (per App)). To pin per-role overrides end-to-end,
   first configure a role chain on the dashboard (`app_model_roles`, 0009)
   for the test App: the consumer materializes it into the runner input JSON
   (`src/pipeline/consumer.ts` `resolveModelOverrides`) and the in-image
   runner resolves it (`src/review/runner.ts`). Runner code is baked into the
   image (`COPY src/review`), so this check is what proves the rebuilt image
   actually carries the v0.6 runner. Note: `reviews.model` records the
   effective BASE chain head only — overrides are deliberately not
   column-reflected (consumer.ts put call), so verification is the completed
   review + `wrangler tail` runner evidence, not the column.
4. **Confirm the D1 row:**
   ```bash
   wrangler d1 execute mstar-inspector-db --remote --command \
     "SELECT id, model, skill_version FROM reviews ORDER BY reviewed_at DESC LIMIT 1"
   ```
   `model` is the effective chain head selector, or NULL meaning the in-image
   default ran (§ Image pins and digest record).

## Multi-App go-live

> This section activates the multi-App platform on a deployed Worker — the
> `DASHBOARD_ENCRYPTION_KEY`, the dashboard registration flow, the per-App
> webhook repoint, and the R1/R2 verification pins. Run AFTER § Deploy steps
> and § Post-deploy smoke (the base Worker and D1 migrations **through
> `0022`** must be live); the live execution is QA-coordinated. Historical
> note: the go-live originally required `0001–0011`; the chain now extends
> to `0022` (`0019` profile columns, `0020`
> finding lifecycle, `0021` Check registry, `0022` per-App trigger mode).

### 1. Set DASHBOARD_ENCRYPTION_KEY

The multi-App registry stores each App's private key and webhook secret
encrypted in D1 (migration 0004). The master key is the
`DASHBOARD_ENCRYPTION_KEY` Worker secret: **standard base64 of exactly 32
bytes** (AES-256-GCM; `src/dashboard/secretbox.ts` `KEY_BYTES = 32` — a
missing, non-base64, or wrong-length value throws `SecretboxKeyError` on
first use). Encryption-dependent dashboard routes (manifest commit, App
settings) fail **closed with 5xx** when it is missing or malformed — the
hold is kept and nothing is stored, so fixing the env makes the retry
succeed.

```bash
# Generate: base64 of exactly 32 random bytes
openssl rand -base64 32
```

Set it as a **GitHub Secret** (`DASHBOARD_ENCRYPTION_KEY`) — the Deploy
workflow injects it on the next deploy (never in git; `.dev.vars` for local
`wrangler dev`). The manual `wrangler secret put` below is the local/fallback
form:

```bash
wrangler secret put DASHBOARD_ENCRYPTION_KEY
```

This key is a plain Worker secret (no key script — the `bun run keys`
worker-secret face was retired; provider keys are per-App now).
It is independent of `DASHBOARD_SESSION_SECRET` (session HMAC) — never reuse
either key for the other duty (rotation stays decoupled).

### 2. Register an App from the dashboard

Prerequisites: dashboard OAuth (`OAUTH_CLIENT_ID` /
`OAUTH_CLIENT_SECRET`), `DASHBOARD_SESSION_SECRET`, an admin login
(`ADMIN_LOGINS` bootstrap or the first-login fallback),
`DASHBOARD_ENCRYPTION_KEY` set, and D1 migrations applied **through
`0022`** — the full forward-only chain above, not a historical prefix.
`0020` supplies the finding-lifecycle/publication journal, `0021` the
Check registry, and `0022` the per-App trigger-mode column the webhook
face reads on every delivery. A missing `0022` does NOT stop reviews:
the webhook face degrades to `every_push` semantics (the row's mode
reads as `undefined`, which the classifier treats as every_push). What
fails closed instead is the dashboard: the Settings page
(`parseSettings` rejects the payload without the mode field) and the
trigger-mode POST (its D1 UPDATE errors on the missing column).

1. **Admin login** — open `/dashboard/login` and complete the GitHub OAuth
   flow. The first login against an empty `dashboard_users` table becomes
   admin (or `ADMIN_LOGINS` bootstraps the listed logins).
2. **Create GitHub App** — on the dashboard workbench (`/dashboard`, the
   Apps-first home) click **Create GitHub App**. The dashboard mints the webhook slug
   (`mstar-inspector-<login>`-derived, DB pre-resolved) and POSTs the App
   manifest to `https://github.com/settings/apps/new` — the manifest's
   webhook URL is the App's OWN route `{origin}/webhook/{slug}`
   (`src/dashboard/manifest.ts` `buildManifest`). Confirm the requested
   permissions on GitHub — `contents: write`, `metadata: read`,
   `pull_requests: write`, `issues: write`, `checks: write` (rationale, the
   Worker-only `contents: write` boundary and the advisory Check semantics:
   § GitHub App permissions above).
3. **Manifest commit** — GitHub redirects back to
   `/dashboard/manifest/callback`; the dashboard exchanges the code, parks
   the credentials in the single-use hold cookie, and shows the confirm
   page (App id / name / slug / webhook URL — never the PEM or webhook
   secret). Submit the confirm form (`/dashboard/manifest/commit`): the PEM
   and webhook secret are encrypted with `DASHBOARD_ENCRYPTION_KEY` (AAD
   rowKey = the row PK) and ONE `github_apps` row is written. Missing key →
   500 fail-closed, hold kept (fix the env, then resubmit).
4. **Confirm the row + delivery health** — the success page shows the slug
   and webhook URL. Verify in D1 (grab the `id` — the R1 pin below needs
   it):
   ```bash
   wrangler d1 execute mstar-inspector-db --remote --command \
     "SELECT id, slug, name, status, created_by, created_at FROM github_apps ORDER BY created_at DESC LIMIT 1"
   ```
   Healthy — exactly one row (the App just committed; the query caps at
   `LIMIT 1`). Zero rows means the manifest commit produced no App (the
   confirm form was not submitted, or the missing/malformed
   `DASHBOARD_ENCRYPTION_KEY` 500 held) — re-check step 3.
   The Apps list now shows the new App with `delivery never` (no
   `webhook_deliveries` rows yet — the healthy pre-traffic state). The
   settings page (`/dashboard/apps/<slug>/settings`) is where the model
   chain, per-role overrides, and provider keys are configured.

### 3. Repoint the webhook + R2 checklist

A freshly manifest-registered App needs no repoint — the flow already set
the per-App webhook URL on GitHub. Repointing applies when an App was
created with a different URL or the Worker host changed:

1. Open the GitHub App settings page
   (`https://github.com/settings/apps/<app-name>`).
2. Under **Webhook**, set **Webhook URL** to
   `https://<worker-host>/webhook/<slug>` (the slug from the dashboard
   success page / Apps list) and save.

**R2 checklist** (the "断线看得见" verification face — run after any repoint
or when deliveries look dead):

| Check | Where | Healthy state |
|---|---|---|
| Emergency brake | Worker env var `REVIEW_ENABLED` | unset — only the exact `"false"` (case-sensitive, untrimmed) stops ALL reviews; check per-App `review_enabled` first, brake second, but note the brake return precedes classification and delivery recording, so a zero-rows state can mean brake rather than GitHub-side delivery death |
| Webhook URL | GitHub App settings → Webhook | `https://<worker-host>/webhook/<slug>` — the per-App route |
| Webhook secret | GitHub App settings → Webhook | A secret is set (masked). The manifest flow's GitHub-generated secret is stored encrypted in the dashboard; changing it on GitHub without updating the dashboard breaks signature verification → `rejected` (401) deliveries |
| Active | GitHub App settings → Webhook | The **Active** checkbox is on and the App is not suspended; the dashboard row's status is `active` (a disabled row 404s the per-App route) |
| Delivery health | Dashboard Apps list health column + settings recent-deliveries panel | Recent rows show `ok` / `ignored` / `paused` outcomes; NO `N rejected in 24h` badge; the latest row's relative time is recent |

The dashboard face is the ground truth: every VERIFIED per-App delivery
lands a `webhook_deliveries` row (best-effort, `src/worker/index.ts` per-App
face — `ok` / `paused` / `ignored` / `rejected`; the retired legacy face
recorded nothing by design, AL-20-1 — archaeology). A `rejected` row with 401 = signature
mismatch (secret drift); 400 = malformed payload; 500 = the App's stored
secret is missing/empty/default. Pre-classify failures (unknown/disabled
slug, decrypt failure) record NO row — they surface in the Worker logs, not
the panel. No rows at all = GitHub is not posting (URL wrong, App suspended,
the event never fired, or the emergency brake is pulled — the exact
`REVIEW_ENABLED=false`). Confirm the per-App row first (`review_enabled`
matches operational intent and the App is active), the brake second, per
the checklist above.

### 4. R1 pin: reviews.model vs configured chain head

The R1 pin proves the per-App model configuration reaches the review and is
recorded. `reviews.model` records the **effective BASE chain head** — the
first selector of the App's stored model chain. AL-24-5:
there is no deployment-level chain to fall back to — an App with no chain
fails its reviews closed (structured `review_failures` row, `stage=pipeline`,
retry → DLQ), so a successful review ALWAYS has a non-NULL `model` (NULL
survives only on pre-cutover historical rows — AL-24-4; see
`src/pipeline/consumer.ts` `assertAppConfigComplete`/`effectiveModelChain` +
`chainHeadSelector`). The same gate checks every per-role override selector
chain: an override referencing a provider with no configured key fails
closed the same way (Bugbot 7aaf18f4).
Per-role overrides (`app_model_roles`, migration 0009) are deliberately NOT
column-reflected — pin those with the completed review + `wrangler tail`
runner evidence, not the column.

1. **Configure the chain** — on the App's settings page, set **Model chain**
   to a distinctive chain, e.g. `ark-plan/deepseek-v4-flash, openai/gpt-5:thinking`
   and save. The head (the first selector) is what the column must show.
2. **Real PR** — with `REVIEW_ENABLED` unset (any value except the exact
   `"false"` — the emergency brake), open or update a PR on an installed
   repo of that App (default `every_push` mode auto-triggers; from any
   mode, a PR comment @mentioning the App's bot works too —
   § Review triggers (per App)).
3. **Assert the column** — the review lands and the row records the chain
   head:
   ```bash
   wrangler d1 execute mstar-inspector-db --remote --command \
     "SELECT model, skill_version, reviewed_at FROM reviews WHERE app_id = '<app-id>' ORDER BY reviewed_at DESC LIMIT 1"
   ```
   `model` must equal the configured chain head (`ark-plan/deepseek-v4-flash`
   in the example); NULL means the in-image default ran — the chain was not
   picked up (check the settings save and the precedence in
   `effectiveModelChain`). The triggering delivery is visible in the same
   window:
   ```bash
   wrangler d1 execute mstar-inspector-db --remote --command \
     "SELECT outcome, event_name, status_code, created_at FROM webhook_deliveries WHERE app_id = '<app-id>' ORDER BY created_at DESC LIMIT 1"
   ```
   `outcome` must be `ok` — the ok row records the webhook ACCEPTED
   (classification, written before the enqueue); the review outcome
   follows via the queue. A failed enqueue leaves this ok row until
   GitHub's retry re-records a fresh one — that retry's row is the
   authoritative delivery.

### 5. Rollback (multi-App)

Rollback is `wrangler rollback` (see § Rollback below) — there is no legacy
face to repoint to; the per-App webhook URL on GitHub is unchanged by a
Worker rollback.

- **D1 is forward-only** — never reverse an applied migration on rollback
  (the chain head is `0022`); new code tolerates the prior schema (0002
  precedent), roll back code only.
- **Secrets untouched** — rollback does not remove
  `DASHBOARD_ENCRYPTION_KEY`; rotate it explicitly when the rollback is
  security-motivated. A registered App's encrypted credentials stay valid
  across a Worker rollback (the key is unchanged).

### 6. ADMIN_LOGINS bootstrap warning (deploy-time)

The Deploy workflow's post-deploy smoke emits a **`::warning`** run
annotation when the deployed Worker has **no usable `ADMIN_LOGINS` value**.
The step reads the Worker's live settings via the Cloudflare API (NOT
`wrangler secret list` — `ADMIN_LOGINS` is a plain var, so a secret listing
never shows it) and treats a missing `ADMIN_LOGINS` binding, or one whose
value is blank/comma-only, as unset — mirroring `parseAdminLogins`
(`src/dashboard/users.ts`) and its blank/comma-only rule, modulo whitespace
trimming, which the smoke check additionally strips.

What the warning means: with `ADMIN_LOGINS` unset and an **empty
`dashboard_users` table**, the first OAuth login becomes admin (the
first-login fallback, `bootstrapDashboardAccess`). The fallback is
**self-disarming** — once any user row exists, unknown logins are denied
(403, zero cookies) until an admin invites them. The warning exists so the
fallback is never silently armed: at go-live, either set `ADMIN_LOGINS`
first or knowingly claim the first-login admin identity.

It is visibility, not a gate — the deploy succeeds either way, at most one
warning per deploy. To clear it, set `ADMIN_LOGINS` (plain Worker **var,
not a secret** — login names are public identity; § Secrets and vars
inventory) in the dashboard's Worker variable settings or `wrangler.jsonc`
`vars` and redeploy (`keep_vars` preserves dashboard-managed values across
automated deploys). Transport/API errors inside the check stay silent, and
a 200 response whose body fails the success-payload check (malformed JSON
or `success != true`) degrades to the same silence: the warning fires only
on a positively observed unset.

## Rollback

> Rollback is a **manual human action** — the Deploy workflow never rolls
> back automatically. A failed deploy stops red; the operator investigates
> and, if needed, rolls back by hand.

- Worker code/config: redeploy the previous version — `wrangler rollback`
  (or check out the previous commit and `wrangler deploy`). Rollback restores
  Worker code + cron triggers + consumer config; the container image follows
  the checked-out Dockerfile.
- D1 migrations are **forward-only**: never reverse a migration on rollback
  (0002 precedent — new code tolerates the prior schema; roll back code
  only). Because migrations apply before deploy in the automated path, a
  failed run may have already applied them — roll back code only, never the
  schema.
- Secrets/vars are untouched by rollback — rotate explicitly when the
  rollback is security-motivated.

## Network egress (architect verdict AL-4 — FINAL)

### Verified control surface (real, NOT activated this iteration)

A real egress control surface exists and is verified: `@cloudflare/sandbox`
0.12.8's pinned dependency `@cloudflare/containers` 0.3.7 (bun.lock) ships an
egress face on the `Container` superclass the Sandbox DO extends —
`allowedHosts` (non-empty = allowlist gate, a miss fails the request with
HTTP 520), `deniedHosts` (unconditional block), `enableInternet` (default
true), `interceptHttps` (default false; requires the container to trust the
Cloudflare CA), plus the static `outbound*` handler chain; enforcement lives
in `ContainerProxy.fetch` (denied → allowed gate → handlers → direct).
Evidence: iteration spec m3-production-grade
§1.3 + §4 AL-4.

It is deliberately NOT activated. Reasons (AL-4):

- The host inventory has no SSOT in this repo: the 18 built-in provider API
  hosts resolve in omp's runtime registry (outside the repo — the omp SDK
  registry, NOT the Worker-side `PROVIDERS` allowlist, which is a separate
  19-entry list, `ark` included); the ark capability host is
  declared in-repo in the omp registry entry
  (`src/contracts/sandbox-images.ts`, synthesized at review time).
- Per-App BYOK keeps the provider set open — the host set is a product
  surface, not a constant.
- A missing host fails CLOSED (520 → review failure → retry → DLQ) — a worse
  failure mode than the documented status quo.
- The beta SDK's `interceptHttps` CA behavior on the sandbox base image is
  unverified.

Activation prerequisite (Roadmap next): provider-host SSOT + staging
verification. Until then the boundary below is the contract — no fake
controls are installed (the Dockerfile carries the documentation block only).

### De-facto allowlist (this iteration's boundary)

- **Build time only:** package installs and downloads — base image, Bun/gh
  tarballs, the harness clone (all from github.com), `bun install` — happen
  at image BUILD time, never at container runtime.
- **Container runtime egress:**
  - `github.com` / `api.github.com` — git clone/fetch of the PR head (token
    via scoped extraheader exec env) and gh CLI.
  - Provider API hosts by active provider config — the 18 built-in provider
    hosts resolve in omp's runtime registry (omp SDK 18.2.6, outside this
    repo — NOT the Worker-side `PROVIDERS` allowlist, which is a separate
    19-entry list, `ark` included); the ark capability host
    `ark.cn-beijing.volces.com` is declared in the omp registry entry
    (`src/contracts/sandbox-images.ts`) and synthesized into every per-review
    models.yml (no baked in-image file).
- **Runner tool whitelist:** the in-image review session restricts agent
  tools to read-only `read` / `grep` / `glob`
  (`src/review/runtime-omp.ts` `REVIEW_TOOL_NAMES`) — no write/exec tool
  inside the review session.
- **Worker-side egress** (outside the container, for completeness):
  `api.github.com` via Octokit (token mint, comment posting) and the optional
  `ALERT_WEBHOOK_URL` host (cron sweep alert POST).

## Image pins and digest record

Five pins — mstar-harness bumped to **3.11.2** (2026-09-20, superseding
the 3.10.2 pin); the `mstar` CLI (`@mstar-harness/cli`) preinstall
is the container-level mechanism, carried
forward at the exact `@3.11.2` pin. The CLI
preinstall is container-level only (`sandbox exec` resolves the `mstar`
shim): review sessions stay restricted to the read-only `read` / `grep` /
`glob` whitelist (Runner tool whitelist above), so the review-session model
cannot invoke the CLI today — a sanctioned session toolcall path is a
tracked follow-up, not a shipped mechanism. Base image /
Bun / gh re-verified, no bump:

| Pin | Value | Where |
|---|---|---|
| base image | `docker.io/cloudflare/sandbox:0.12.8` | `sandbox-image/omp/Dockerfile` FROM |
| Bun | `1.4.0` | `sandbox-image/omp/Dockerfile` |
| gh CLI | `2.98.0` | `sandbox-image/omp/Dockerfile` |
| mstar-harness | `2cae49faaa9a7652479f8ad859999fe6da7dbc22` (3.11.2) | `sandbox-image/omp/Dockerfile` |
| mstar-harness CLI | `@mstar-harness/cli@3.11.2` | `sandbox-image/omp/Dockerfile` |

**In-image DEFAULT model selector: `ark-plan/deepseek-v4-flash`** (pins:
`src/review/runtime-omp.ts` `DEFAULT_MODEL_PATTERN` + the omp registry entry's
`ark-plan` capability host in `src/contracts/sandbox-images.ts`, synthesized
into every per-review models.yml — the baked file was removed). This line
is the record for architect
verdict AL-2: with the zero-global-fallback cutover (AL-24-5)
the App's `modelChain` is the only chain source — a chain-less App is
fail-closed by the consumer and the runner's default is reachable only via a
direct/manual in-image runner call (the in-image scaffold, not the Worker
path). On the production path the Worker never records NULL (the column
stays nullable for historical rows, AL-24-4); local manual runs resolve the
in-image default against THIS line.

Deployed image record (DOCS-01 baseline):

> The live image digest is **operational state**, not documentation — the
> Deploy workflow records it in the **run summary** (`$GITHUB_STEP_SUMMARY`:
> digest + Worker version + Actions run link) after every successful deploy,
> and uploads per-run evidence (deploy.log / version_id.txt /
> image_digest.txt) as the `deploy-evidence` Actions artifact. The GitHub
> **Environments → staging** page shows the deployment history (commit,
> actor, timestamp). The **live truth** is `wrangler containers list --json`
> (Cloudflare state); the run summary is the deploy-time baseline for the
> DOCS-01 drift check — compare the live image against the latest run's
> digest after any deploy. Historical record (2026-08-31 manual deploy):
> digest `sha256:09724a204ef38dab02b88a6537bdd3f051997ac144f0aeff7d5901d9d75aa57d`,
> Worker version `62c18d0a`.

## Ops config

### Review triggers (per App)

Each App chooses when its reviews auto-start — the `review_trigger_mode`
column (migration `0022`), set on the App's dashboard Settings page
alongside the pause switch:

- `every_push` (default) — review on `opened`, `synchronize` and
  `reopened` (the historical behavior, preserved exactly).
- `open` — the PR's first `opened` event only; pushes and reopens never
  auto-trigger.
- `manual` — never auto-reviews.

In every mode, a PR comment that @mentions the App's bot — `@<slug>` or
the canonical `@<slug>[bot]`, matched as a standalone token —
(re-)starts a review when the commenter is the PR author or the
repository owner (bot-sender comments are ignored; anyone else gets a
structured warn). The per-App pause (`review_enabled`) and the
`REVIEW_ENABLED` emergency brake still govern every trigger path.
Operator note: the structured-log `event` label for comment-triggered
reviews retires `review_command` → `issue_comment`; operator-saved log
filters keyed on the old label stop matching after deploy.
Contract:
[`.mstar/specs/review-trigger-policy.md`](../.mstar/specs/review-trigger-policy.md)
(§2.1 classification matrix, §3 mention grammar).

### Queue consumer concurrency (architect verdict AL-5)

- `wrangler.jsonc → queues.consumers[review-queue].max_concurrency: 1` —
  protective fix: UNSET means the platform auto-scales consumer concurrency
  by backlog. With a unique sandbox id per attempt against
  `containers[].max_instances: 1`, >1 concurrency only blocks on container
  acquisition (timeout → retry storm → DLQ). Pinned, NOT env-configurable;
  raising it requires raising `max_instances` first.

### Cron failure sweep (architect verdict AL-6)

- `wrangler.jsonc → triggers.crons: ["*/15 * * * *"]` — every 15 min the
  `scheduled` handler (src/worker/index.ts) runs the sweep
  (src/worker/sweep.ts), then the lifecycle reconciler
  ([§ Lifecycle recovery](#lifecycle-recovery-7111)), then the
  Check recovery reconciler ([§ Check recovery](#check-recovery-7112)),
  each stage in its own try/catch so none can break another. The sweep counts
  `review_failures` rows over the
  trailing 24h across ALL stages (parse + runner/sandbox/pipeline; the
  per-attempt rows written by migration 0010 make this table the sufficient failure
  signal).
- Threshold: `failures_24h > 5` (per-attempt semantics — a DLQ'd message
  leaves up to 4 rows: 1 initial delivery + max_retries = 3 retries).
  Constants pinned in src/worker/sweep.ts (`SWEEP_FAILURE_THRESHOLD`,
  `SWEEP_WINDOW_HOURS`, `SWEEP_WEBHOOK_TIMEOUT_MS`).
- Alert transport: structured `ops_sweep_alert` log event
  (`{failures_24h, dlq_check: "skipped", thresholds}`) + optional POST to
  `ALERT_WEBHOOK_URL` (JSON body, 3s timeout; a POST failure degrades to a
  warn log, never throws). Absent `ALERT_WEBHOOK_URL` = log-only alerting.
- DLQ depth is NOT read (no CF API token surface — `dlq_check: "skipped"`);
  guard-leak cleanup stays out of cron (KV guard TTL is the leak upper
  bound).
- The sweep stage is read-only: D1 query + log/webhook only — no queue/KV/D1
  mutation. (The composed lifecycle-recovery stage below does write its own
  D1 journal rows and may call GitHub, strictly within its own bounds.)

### Lifecycle recovery (§7.11.1)

The same `*/15 * * * *` trigger runs a second, independent stage after the
sweep: `reconcileReviewLifecycle` (`src/worker/lifecycle-reconcile.ts`), in its
own try/catch and throw-proof by contract. It completes the finding-lifecycle work from the
private D1 publication journal and **never re-runs a paid review**:

- confirmed publications are applied locally (no GitHub call — works even while
  GitHub is unavailable);
- a due staged publication older than 60s is sent once with its exact prepared
  body, unless a newer round supersedes it;
- an interrupted send is proved read-only by the exact App-owned marker plus
  body digest and then applied; an unprovable send stays `unknown` instead of
  being re-created;
- authorized thread resolutions are retried through the same §7.5
  ownership/HEAD/conversation fences as the inline attempt — a finding's
  *addressed* disposition is never itself a resolve; only a proven-owned thread
  with a confirmed remote `isResolved` counts, and anything weaker stays
  visible as unresolved.

Retries are bounded with backoff; at the cap the row stays visible as a terminal
local-error/unknown and is never deleted (the structured warning carries
App/scope/work ID and reason — no payload, no secret). App-state suspension is
per exact `(app_id, installation_id)` pair; recovery distinguishes the reasons:

- a **disabled** App suspends its pending rows durably (no mutation while
  disabled) and they become eligible again only after **that exact App** is
  re-enabled — each run re-checks the pair, and due rows resume with the same
  IDs under fresh fencing;
- a **missing mapping, deleted App or live identity mismatch** suspends rows
  durably for operator inspection and does **not** resume automatically on
  re-enable: a deleted App can never be re-activated, and recovery only
  proceeds once the operator restores the mapping or corrects the App's
  credentials.

Pause/kill-switch stops new reviews, publications and line-comment creation.
The bounded exceptions — local apply of already-confirmed publications,
read-only proof discovery, and previously-authorized resolution retries —
continue only for an **otherwise active** exact App; a disabled, deleted,
missing or identity-mismatched App keeps its suspension (frozen policy).
Budgets and the exact selection predicates: `.mstar/specs/review-lifecycle.md`
§7.11.1.

### Check recovery (§7.11.2)

A third independent stage on the same trigger — `reconcileReviewChecks`
(`src/worker/check-reconcile.ts`), in its own try/catch and throw-proof by
contract — finishes Check work the inline consumer hook could not complete.
It never re-runs a paid review:

- **Adopt before create.** A run that may already exist is found by exact
  App / `external_id` / SHA (`filter: 'all'`, at most 2 pages), never inferred
  from name or PR association alone. A create is legal only while the attempt
  is `not-sent` — provably never dispatched, including the adapter's pre-send
  refusal — and the App is enabled; once a create may have been sent
  (`sending`/`unknown`) the row is settled by read-only adoption, because
  resetting to `not-sent` would mint a second run for the same head.
- **Conclusions come from persisted proof.** An attempt whose
  `desired = in_progress` expires at its execution deadline and is then
  terminalized from the publication journal (`success` with matching proof,
  `neutral` for a confirmed degraded publication, `failure` otherwise) —
  `in_progress` is never passed to the completion API.
- **Intent before send, observation after validation.** The frozen conclusion is
  persisted before the remote update, and the observed state advances only for a
  response that matches the persisted identity, `completed` status and intended
  conclusion. A late response from an old lease epoch persists nothing.
- **Bounded.** ≤6 requests per row, ≤100 requests per 60s run, ≤5s per request
  (clamped by the remaining run deadline). A budget refusal is pre-dispatch: the
  claim is handed straight back, nothing is mutated, and no attempt is spent.
- **Honest give-up.** At the fifth failure the row is marked `local-error` with
  a `terminal_ms` under the live fence and a structured
  `ops_check_reconcile_gave_up` warning carrying App/scope/work id and reason.
  The row stays visible with its remote id and `external_id` — never dropped,
  never cleared, never reported as remote completion.
- **Operator retry.** The row-scoped retry reopens recovery of the **same
  historical identity** — no new generation, no model replay — and refuses a
  live lease, a newer active generation or a suspended App. It is not
  permission to replay a review.

Pause semantics for this lane mirror the lifecycle lane: a paused App may adopt
read-only and terminalize an already-known run, but a never-sent attempt is
never created while paused. The same-name duplicate-run possibility above
(§ GitHub App permissions) is the visible consequence of RL-12 in this lane.

### Secrets inventory delta

- `ALERT_WEBHOOK_URL` (NEW, optional, secret class): generic alert webhook
  for the sweep — set as a GitHub Secret (the Deploy workflow writes it to
  the Worker when set and deletes it when unset, so removing the GitHub
  Secret returns the Worker to log-only alerting; `.dev.vars` locally).
  Unset = log-only alerting.

## Maintenance (DEBT-01)

`review_failures` is an append-only per-attempt event log: a DLQ'd message
leaves up to 4 rows (1 initial delivery + max_retries = 3 retries), so the
table grows with every failed attempt. Retention is **runbook-executed** —
the cron sweep **stage** is read-only by design (AL-6) and must never mutate
D1 (the separate lifecycle-recovery stage owns its own journal rows).

Monthly (or when the table grows noticeably), delete rows older than 30
days:

```bash
wrangler d1 execute mstar-inspector-db --remote --command \
  "DELETE FROM review_failures WHERE created_at < datetime('now','-30 days')"
```

Notes:

- The DELETE is bounded by `idx_review_failures_created` (migration 0010) —
  the same index the sweep's trailing-window scan uses, so the maintenance
  cost stays proportional to the deleted window, not the table size.
- `created_at` is ALWAYS the column DEFAULT `datetime('now')` format
  (`YYYY-MM-DD HH:MM:SS` UTC) — the TEXT comparison above depends on it
  (see `src/store/failure-store.ts` header, BUG-03 contract).
- The sweep's 24h window is unaffected: 30-day retention never touches
  in-window rows.
