# Deploy runbook — mstar-inspector

> Plan 19 status: T1 landed the ops-config surfaces (queue concurrency cap +
> cron failure sweep + optional alert webhook — SSOT in § Ops config below);
> T2 (this document) completed the full runbook; T3 executes it and fills the
> deployed image digest + deploy date in § Image pins and digest record.

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
  `sandbox-image/Dockerfile` at deploy time (`image_build_context: "."`,
  `instance_type: lite`, `max_instances: 1`).

### D1 migrations (0001–0013, forward-only)

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
| `0005_reviews_app_id` | `reviews.app_id` attribution (NULL = legacy global App) |
| `0006_app_provider_config` | per-App BYOK provider keys + model chain |
| `0007_reviews_app_id_index` | index on `reviews.app_id` |
| `0008_github_apps_ops` | per-App ops columns (`review_enabled` pause switch) |
| `0009_app_model_roles` | per-App per-role model overrides (plan 17) |
| `0010_review_failures` | all-stage failure table (plan 18) — the cron sweep's signal |
| `0011_webhook_deliveries` | per-App webhook delivery log (plan 20) |
| `0012_custom_providers_and_key_updated_at` | per-App custom provider declarations + provider-key `updated_at` (plan 23) |

Migrations are **forward-only** (0002 precedent): never hand-edit an applied
migration; add the next file.

### Secrets and vars inventory

Secrets — `wrangler secret put <NAME>`; `.dev.vars` for local `wrangler dev`;
never in git (full per-key notes in `.env.example`):

| Name | Required | Purpose |
|---|---|---|
| `APP_ID` | yes | GitHub App ID (numeric) |
| `PRIVATE_KEY` | yes | GitHub App private key PEM (PKCS#1 or PKCS#8) |
| `WEBHOOK_SECRET` | yes | webhook HMAC secret (fail-closed when empty/`"development"`) |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | dashboard | user OAuth login (distinct from the review App) |
| `DASHBOARD_SESSION_SECRET` | dashboard | session-cookie HMAC key |
| `DASHBOARD_ENCRYPTION_KEY` | multi-App | AES-256-GCM master key for D1-stored App credentials |
| `OMP_MODEL_KEY` | review | ark-plan provider key; forwarded into the container as `ARK_API_KEY` |
| `ALERT_WEBHOOK_URL` | no — **NEW (plan 19)** | ops sweep alert webhook; unset = log-only alerting (§ Ops config) |
| 18 built-in provider keys | no | fallback provider auth — `bun run keys` sets them on the Worker (see README § Setting provider keys) |

Plain vars — `wrangler.jsonc` `vars` or the dashboard's Worker variable
settings; redeploy to change:

| Name | Default | Purpose |
|---|---|---|
| `REVIEW_ENABLED` | **off** | fail-closed kill-switch; exactly `"true"` enables reviews |
| `ADMIN_LOGINS` | unset | comma-separated GitHub logins bootstrapped as dashboard admin |
| `OMP_REVIEW_MODEL` | unset | global model chain override (first selector = primary; unset = in-image default, § Image pins) |

GitHub App setup (permissions, webhook events, installation):
`.mstar/iterations/v0.2/guides/github-app-runbook.md`.

### Local tooling

- Bun ≥ 1.3.14 (`package.json` engines) + `bun install`.
- wrangler 4.125.0 (pinned devDependency — `bunx wrangler` resolves it; a
  bare `wrangler` works when the global install matches).
- Authenticated to the target Cloudflare account (`wrangler login`, or
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in CI).

## Deploy steps (ordered)

Order lock (plan Clarify #5): code merge → `wrangler deploy` (the container
image auto-rebuilds when the Dockerfile/build context changed) → post-deploy
smoke → record the digest.

1. `bun install`
2. `bun run typecheck && bun test` — both must exit 0.
3. Local sandbox smoke — builds the image and exercises the real sandbox path
   via `wrangler dev` (config `wrangler.smoke.jsonc`, entry
   `src/pipeline/smoke-entry.ts`; requires `APP_ID` + `PRIVATE_KEY` in the
   shell env for the installation-token mint):
   ```bash
   bun run scripts/sandbox-smoke.ts
   # /smoke: getSandbox → exec gh pr diff → destroy
   SMOKE_ROUTE=/smoke-review ARK_API_KEY=… bun run scripts/sandbox-smoke.ts
   # /smoke-review: full in-image runner (clone + omp review + parse) → destroy
   ```
4. `wrangler deploy` — deploys the Worker (webhook face + queue consumer +
   cron trigger) and rebuilds/pushes the container image when the build
   context changed. **Copy the image digest from the deploy output.**
5. Record the digest + deploy date in § Image pins and digest record below.
   **Digest drift check (DOCS-01):** after every deploy, verify the live
   version + image against the recorded line —
   ```bash
   wrangler deployments list   # or: wrangler versions list
   ```
   Compare the live Worker version and the container image digest with the
   record in § Image pins and digest record; update the record on EVERY
   deploy (a stale record makes the "which image is live" audit wrong).

## Post-deploy smoke

1. **Cron trigger registered** — the `wrangler deploy` output lists the cron
   trigger `*/15 * * * *` (also visible in the dashboard under Workers →
   mstar-inspector → Settings → Triggers). The sweep is quiet below
   threshold: no log line is expected on a healthy system
   (`src/worker/sweep.ts` emits only the breach event / warns).
2. **D1 migration check (real D1)** — verifies plan 18's 0010 applied and the
   sweep's signal table is queryable:
   ```bash
   wrangler d1 execute mstar-inspector-db --remote --command \
     "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
   wrangler d1 execute mstar-inspector-db --remote --command \
     "SELECT COUNT(*) AS n FROM review_failures"
   ```
   `review_failures` must be present and the count queryable.
3. **End-to-end review (v0.6 `modelOverrides` pin)** — with
   `REVIEW_ENABLED=true`, open or update a test PR on an installed repo and
   confirm the review comment lands. To pin per-role overrides end-to-end,
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

## Rollback

- Worker code/config: redeploy the previous version — `wrangler rollback`
  (or check out the previous commit and `wrangler deploy`). Rollback restores
  Worker code + cron triggers + consumer config; the container image follows
  the checked-out Dockerfile.
- D1 migrations are **forward-only**: never reverse a migration on rollback
  (0002 precedent — new code tolerates the prior schema; roll back code
  only).
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
Evidence: iteration spec `.mstar/iterations/v0.7/specs/m3-production-grade.md`
§1.3 + §4 AL-4.

It is deliberately NOT activated. Reasons (AL-4):

- The host inventory has no SSOT in this repo: the 18 built-in provider API
  hosts resolve in omp's registry (outside the repo); only the ark custom
  host is pinned in-repo (`sandbox-image/omp-models.yml`).
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
    hosts resolve in omp's registry (omp SDK 18.0.4, outside this repo); the
    ark custom host `ark.cn-beijing.volces.com` is pinned in
    `sandbox-image/omp-models.yml`.
- **Runner tool whitelist:** the in-image review session restricts agent
  tools to read-only `read` / `grep` / `glob`
  (`src/review/runtime-omp.ts` `REVIEW_TOOL_NAMES`) — no write/exec tool
  inside the review session.
- **Worker-side egress** (outside the container, for completeness):
  `api.github.com` via Octokit (token mint, comment posting) and the optional
  `ALERT_WEBHOOK_URL` host (cron sweep alert POST).

## Image pins and digest record

Four pins — re-verified this iteration, **no bump** (plan 19 constraint;
upgrading any pin is a future iteration's explicit decision):

| Pin | Value | Where |
|---|---|---|
| base image | `docker.io/cloudflare/sandbox:0.12.8` | `sandbox-image/Dockerfile` FROM |
| Bun | `1.4.0` | `sandbox-image/Dockerfile` |
| gh CLI | `2.98.0` | `sandbox-image/Dockerfile` |
| mstar-harness | `f1b60df0b3b2e29b9a904edb4077e52cf6d7ca66` (3.5.0) | `sandbox-image/Dockerfile` |

**In-image DEFAULT model selector: `ark-plan/deepseek-v4-flash`** (pins:
`src/review/runtime-omp.ts` `DEFAULT_MODEL_PATTERN` +
`sandbox-image/omp-models.yml`). This line is the record for architect
verdict AL-2: when neither the App's `modelChain` nor `OMP_REVIEW_MODEL` is
set, the runner falls back to this selector and the Worker records
`reviews.model = NULL` rather than duplicating the constant — audits resolve
NULL against THIS line.

Deployed image record (executed plan 19 T3, 2026-08-31 UTC):

- Image digest: `sha256:09724a204ef38dab02b88a6537bdd3f051997ac144f0aeff7d5901d9d75aa57d`
  (registry.cloudflare.com/f68fcd78e7c5c10f0466788bb9e85b8e/mstar-inspector-sandbox;
  replaces `sha256:4dae83cd…ccad2ada`)
- Deploy date: 2026-08-31 (Worker version `62c18d0a` — the digest-carrying
  deploy; post-deploy smoke PASS: cron registered, D1 0001–0010 complete,
  e2e review on btspoony/todo-bots#1 landed with in-image runner
  `skill_version 3.5.0+f1b60df0`, `reviews.envelope` written, `reviews.model
  = NULL` → the default selector above)

## Ops config (plan 19 T1)

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
  (src/worker/sweep.ts): counts `review_failures` rows over the trailing 24h
  across ALL stages (parse + runner/sandbox/pipeline; the per-attempt rows
  written by plan 18 T2 make this table the sufficient failure signal).
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
- The sweep is read-only: D1 query + log/webhook only — no queue/KV/D1
  mutation.

### Secrets inventory delta

- `ALERT_WEBHOOK_URL` (NEW, optional, secret class): generic alert webhook
  for the sweep — set via `wrangler secret put ALERT_WEBHOOK_URL`
  (`.dev.vars` locally). Unset = log-only alerting.

## Maintenance (DEBT-01)

`review_failures` is an append-only per-attempt event log: a DLQ'd message
leaves up to 4 rows (1 initial delivery + max_retries = 3 retries), so the
table grows with every failed attempt. Retention is **runbook-executed** —
the cron sweep is read-only by design (AL-6) and must never mutate D1.

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
