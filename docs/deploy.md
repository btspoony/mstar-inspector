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

## Production environment

Two Workers, two deploy paths, nothing shared — both in Cloudflare account
`f68fcd78e7c5c10f0466788bb9e85b8e`:

| | Staging | Production |
|---|---|---|
| Worker | `mstar-inspector` | `mstar-inspector-production` |
| URL | `https://mstar-inspector.42ch.dev` (Workers Custom Domain) | `https://inspector.mstar.page` (Workers Custom Domain) |
| Deploy trigger | every push to `main` — [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | the Release workflow **dispatches** [`.github/workflows/deploy-prod.yml`](../.github/workflows/deploy-prod.yml) on a **non-prerelease** tag; a human-published non-prerelease Release triggers it directly, and `workflow_dispatch` on a **tag** ref serves bring-up / rollback — every run then **pauses for the owner's approval** before the first step (§ Production approval gate and the tag gate) |
| GitHub environment | `staging` | `production` |
| Config block | top level of `wrangler.jsonc` | `env.production` (`wrangler deploy --env production`) |
| D1 (`DB`) | `mstar-inspector-db` (`7a737173-e202-430f-8b47-e087d5e885c4`) | `mstar-inspector-prod-db` (`7c06fce1-6126-49e9-aeac-e92d527ff1c4`) |
| KV (`IDEMPOTENCY_KV`) | `554c5cd446e4401fa878570ac66bbba4` | `7bd2996bf0a44704950371ed75a35ecc` |
| Queues | `review-queue` / `review-dlq` | `review-queue-prod` / `review-dlq-prod` |
| Container application | `mstar-inspector-sandbox-v2` | `mstar-inspector-production-sandboxv1-sandbox` |

The two Workers share **no** resource: separate D1, KV namespace, queue pair,
Durable Object namespaces, and container application. Production D1 starts
**empty** — staging data and its dashboard Apps are never migrated; every App
is registered again through the production dashboard's manifest flow, so its
webhook URL points at `inspector.mstar.page` from creation (§ Multi-App
go-live). Production secrets are its own (§ One-time bring-up step 3) — never
copy staging's `DASHBOARD_ENCRYPTION_KEY`.

A tag containing `-` (a prerelease) is never dispatched to production by the
**automated chain** — the Release workflow's dispatch step is guarded on a
version without `-` — and staging verifies those. A **manual**
`workflow_dispatch` on a prerelease tag ref is the supported exception: the
deploy job's guard passes a dispatch through unconditionally, and the first
production bring-up depends on exactly that — against a tag cut **after** this
change ships, because the workflow must exist at the dispatched ref
(§ One-time bring-up step 5). The production workflow has **no `paths-ignore`**;
it runs from the Release workflow's dispatch (the normal path), from a
`release: published` event for a Release published by a human or any actor
other than the repository `GITHUB_TOKEN`, or from a manual `workflow_dispatch`
on a **tag** ref (a dispatch on a branch is refused — § The run's ref is the
deployed checkout). Its job-level guard requires **both** properties on that
release-event path — the Release is not flagged prerelease **and** its tag
carries no `-` — so a prerelease published that way starts a run whose deploy
job is skipped — never a production deploy.

Whatever the trigger, an admitted run then **pauses at job start for the
owner's approval** on the `production` environment: no step runs and no
`production` secret is injected until it is granted
(§ Production approval gate and the tag gate). The release→production path is
therefore release-gated **and** human-approved — it never proceeds unattended.

**What an admitted run checks before it mutates.** Two guards sit on the
production path itself, both ahead of its first mutating command:

- **Tag↔version validation.** The `Validate the tag against the checked-out
  version surfaces` step runs directly after `Resolve deploy tag` and before
  `Apply prod D1 migrations (remote)`: it re-runs the repository's own release
  gate (`bun run release:validate -- "$TAG"`,
  `scripts/validate-release-version.ts`) against the checked-out tree, so every
  version surface (`package.json#version`, `src/version.ts`) must carry exactly
  the tag's bare version. A hand-cut or re-pointed `v*` tag whose commit does
  not carry that version — the paths that never pass through the release
  chain's own validation — fails the run **before** any migration or deploy, so
  a tag that lies about its contents never half-mutates production. The
  post-deploy healthz smoke confirms the same identity on the live Worker
  afterwards.
- **Step-scoped secrets and SHA-pinned actions.** No `production` secret sits
  on the job: the job-level `env` carries only the two public variables
  (`CLOUDFLARE_ACCOUNT_ID`, `OAUTH_CLIENT_ID`). Each secret is declared on
  exactly the steps that consume it — `CLOUDFLARE_API_TOKEN` on the
  wrangler-authenticating steps (account verification, D1 migrations, the
  deploy, both `wrangler secret bulk` steps, the post-secret version
  re-capture), `OAUTH_CLIENT_SECRET` / `DASHBOARD_SESSION_SECRET` /
  `DASHBOARD_ENCRYPTION_KEY` on the required-secret preflight and the
  required-secrets write, and `ALERT_WEBHOOK_URL` on its single
  bind-or-null-delete step — never on the job. No step that runs third-party
  action code (`actions/checkout`, `oven-sh/setup-bun`,
  `actions/upload-artifact`) therefore has a secret in its environment, and
  those three actions are pinned to commit SHAs — the release tag kept in a
  trailing comment — so a re-pointed upstream tag cannot substitute the code
  that runs beside those secrets.

**Why the dispatch:** a Release published with the Release workflow's
`GITHUB_TOKEN` does **not** create a `release: published` run — GitHub
suppresses workflow events caused by `GITHUB_TOKEN` (`workflow_dispatch` and
`repository_dispatch` are the exempt trigger types) — so the Release workflow
runs `gh workflow run deploy-prod.yml --ref <tag>` itself, and the dispatched
run's head SHA is the tag's commit. That step is fail-fast **after** the tag and
Release are created, and it needs `actions: write` on the release job; the
dispatched run is then approved like any other production run
(§ Production approval gate and the tag gate). The
`release: published` trigger stays declared and **does** deploy when a human
publishes a non-prerelease Release in the UI (its job-level guard requires the
Release to be non-prerelease **and** its tag to carry no `-`). The release chain,
the prerelease guard and the Deploy evidence section are in
[`docs/release.md`](release.md).

### The run's ref is the deployed checkout

The production workflow takes **no `ref` input**. It checks out the run's own
**immutable SHA** — `github.sha`, the commit the tag pointed at when the run
was created — not the tag name, and an assertion step before any repository
code runs (install / test / build) fails the run unless the checked-out `HEAD`
equals that SHA. A tag moved during the approval wait can therefore no longer
change what the approved run executes.
A run whose ref is not a tag (e.g. a bare dispatch on a branch) fails with an
`::error::` and a non-zero exit **before any mutating
step**. A production run therefore deploys exactly the commit it was dispatched
on — nothing else can be selected, and nothing can be substituted afterwards —
and a manual `workflow_dispatch` is explicit human
intent: it **may** deploy a prerelease tag, which is how the first production
bring-up happens (§ One-time bring-up step 5).

That structural identity, not a match heuristic, is what makes the
[Deploy evidence](release.md#deploy-evidence-release--deploy-reconciliation)
section's run match on the release tag proof of what shipped — and the
collector states the opposite explicitly (a `- Run identity:` bullet) whenever
no run carries that ref.

### Production approval gate and the tag gate

Two independent layers gate a production deploy. They are not substitutes:
the approval gate decides **who authorizes** a run, the tag gate decides
**which ref shape** may be admitted.

**The approval gate (applied).** The `production` environment carries a
**required reviewers** protection rule with the owner (`btspoony`) as
reviewer (`prevent_self_review: false`), alongside its `v*` **tag**
deployment policy (both applied through the environments API). Every
production run — including the one the release chain dispatches
automatically — **pauses at job start for the owner's approval** before any
step runs and before any `production` secret is injected. No production
deploy proceeds unattended.

**The tag gate.** The secrets-free `guard-tag-ref` job runs first (no
`environment`, no secrets, no repository checkout, so no dispatched ref's code
executes in it) and the secret-holding `deploy` job `needs:` it. It asserts
the run is on a **tag** ref, and the environment's `v*` tag policy admits only
tag refs — together with the workflow's own checks (prerelease guard, dispatch
rules, run-ref identity) they constrain the **shape** of an admitted ref.

**The environment marker (applied).** The workflow asserts the
environment **variable** `PROD_ENV_MARKER` (`production`) before its first
mutating step; that proves the **effective** value resolved to `production`,
not which level supplied it — `vars` resolves environment → repository →
organization, so a repository- or organization-level
`PROD_ENV_MARKER=production` satisfies the same assertion, and a run that
resolved repository-level values does **not** fail here. It says nothing about
where a *secret value* came from either, which is not observable from inside
the run — see § One-time bring-up step 3. **Operational rule: never define
`PROD_ENV_MARKER` outside the `production` environment**, so the assertion
stays a bring-up aid rather than a value another scope can satisfy.

**What neither layer constrains.** They do not decide *which commit* a tag may
point at, and an in-workflow check cannot: the workflow that runs is read from
the dispatched tag, so on a repository with write collaborators that file is
itself attacker-controlled. A writer can push a `v*` tag at an arbitrary
commit carrying a modified `deploy-prod.yml` and dispatch it — but such a run
still cannot obtain the `production` secrets without the owner's approval. That
approval gate is the enforceable control for this class of risk, which includes
a tampered workflow and a compromised third-party action inside the workflow.

**What the approval gate does not constrain: the provider credential.** The
approval authorizes *this workflow's job*; it does not reduce the authority of
the Cloudflare API token that job authenticates with. That token is the
staging one reused today (step 3) — an
**account-scoped** token with Workers Scripts / D1 / Workers Containers
**Edit** in the single account both Workers live in (§ CI credentials — token
permissions), and the staging workflow runs repository code with it on every
`main` push. An actor who can merge to `main`, or who compromises the
automation writer, therefore already holds a credential that can replace the
production Worker or mutate production D1 **directly** — no `v*` tag, no
production run and no approval involved. The shared token is therefore an
**accepted residual with no technical mitigation currently applied** (owner
decision, 2026-10-14): neither the tag gate nor the production approval
compensates, because the staging workflow holds the same token on every `main`
push and that path can target production **directly** — without the production
environment approval and without any tag. The **future remedy only** (not
applied today) is to scope the provider credential per environment — a
**production-only token** (ideally in a separate Cloudflare account) with the
same account-level groups (§ CI credentials — token permissions), rotating the
shared one once production has its own. Read the account token as production
authority regardless of how the approval gate is configured.

**Current exposure and the remaining alternative.** Exactly two accounts have
write access — the owner (`btspoony`, a User account) and one automation
account (`auto-wood`). The `default` branch ruleset protects the default
branch (`non_fast_forward`, no deletion, pull request with **0** required
approvals); tags are unprotected. **Trimming write access** for accounts that
do not need it remains the live alternative for shrinking the same surface. A
`v*` tag-creation ruleset is **not available** on this repository: it is owned
by a User account, and keeping the release chain working requires the GitHub
Actions app as a bypass actor, which the API refuses for a user-owned
repository (`422 Actor GitHub Actions integration must be part of the ruleset
source or owner organization`); a restriction without that bypass would block
the release chain's own `git push origin "$TAG"`. It becomes available only by
moving the repository into an organization (then the Actions app can be an
allowed bypass actor) or by switching the release chain's tag push to a
user-attributable token the ruleset bypasses — both larger changes than this
plan, and both rejected for now in favour of the applied approval gate.

### One-time bring-up (operator)

1. **Cloudflare resources** — created once in the deploy account;
   `env.production` of `wrangler.jsonc` references them by id / name:

   ```bash
   wrangler kv namespace create mstar-inspector-prod-IDEMPOTENCY_KV
   wrangler d1 create mstar-inspector-prod-db --location apac
   wrangler queues create review-queue-prod
   wrangler queues create review-dlq-prod
   ```

   **The D1 primary region is fixed at creation.** `wrangler d1 create`
   takes a `--location` hint (`weur` / `eeur` / `apac` / `oc` / `wnam` /
   `enam`) and Cloudflare cannot change it afterwards; this account's
   `mstar-inspector-prod-db` was created in **APAC**. A locality requirement
   (the data must sit near the Workers traffic) therefore means creating a new
   database and re-pointing `env.production` at it — not altering this one; so
   choose the location deliberately at create time (`--location apac`).

   Then apply the migration chain to the new D1
   (`wrangler d1 migrations apply mstar-inspector-prod-db --remote --env
   production`, forward-only — the same chain as staging). `--env production`
   is not optional: the production database is declared only inside the
   `env.production` block of `wrangler.jsonc`, so without it the command
   resolves the top-level (staging) database.

2. **GitHub environment `production`** — Settings → Environments. On this
   repo the environment is **already configured with a deployment policy that
   allows `v*` tags only** (no branch policies) **and a required reviewers
   protection rule** (reviewer: the owner `btspoony`,
   `prevent_self_review: false`), both applied through the environments API.
   That is what the production
   workflow needs: a branch-only policy (staging's `main` policy is the
   example) rejects a tag-ref deployment, while an unrestricted environment
   would let a branch dispatch start the secret-bearing job before the
   workflow's own tag gate. The required reviewer makes every admitted run
   pause for the owner's approval before any step runs (§ Production approval
   gate and the tag gate). When mirroring this chain on a fork, create the
   environment with that same `v*` **tag** policy and the reviewer rule. Keep
   that policy: it
   refuses a non-tag ref before any `production` secret is injected, and it
   still admits every `v*` release, prerelease and rollback tag. The policy is
   defense in depth — the workflow's own ref gate (§ The run's ref is the
   deployed checkout) is the structural check that a policy change cannot
   remove. § Production approval gate and the tag gate states what those layers
   do not protect against — and which risk the approval controls versus which
   one only a per-environment provider credential can close.

3. **Variables and secrets** — the repository **variables**
   `CLOUDFLARE_ACCOUNT_ID` (`f68fcd78e7c5c10f0466788bb9e85b8e`) and
   `OAUTH_CLIENT_ID` are shared by both environments (an environment-level
   value overrides the repository one); the **secrets** are per-environment,
   so every one of them must also exist under `production`:

   | Name | Kind | Value |
   |---|---|---|
   | `CLOUDFLARE_API_TOKEN` | secret | CI credential, never injected into the Worker — **the account-level token is reused from staging, and that residual is accepted** (owner decision, 2026-10-14): Cloudflare has no per-script scoping for Workers Scripts, so staging and production cannot be separated inside the one account both Workers live in, and **no technical mitigation is currently applied** — neither the release/tag gate nor the required reviewer on the `production` environment compensates, because the staging workflow holds the same token on every `main` push and can target production directly. Future remedy only if the decision is revisited: a production-only token (ideally in a separate Cloudflare account) with the same account-level groups, then rotate the shared one (§ CI credentials — the account-scoped authority it carries is not mediated by the approval gate: § Production approval gate and the tag gate) |
   | `OAUTH_CLIENT_SECRET` | secret | **copy** the secret of whichever OAuth App production's `OAUTH_CLIENT_ID` names — the shared App by default, or production's own App (step 4) — it is a provider credential, not a generated value |
   | `DASHBOARD_SESSION_SECRET` | secret | **new** random (`openssl rand -base64 32`) |
   | `DASHBOARD_ENCRYPTION_KEY` | secret | **new** random (`openssl rand -base64 32`) — production D1 starts empty (step 1) |
   | `ALERT_WEBHOOK_URL` | secret | optional; unset = log-only alerting (§ Ops config) |

   **Resolution order — environment, then repository, then organization.**
   GitHub resolves `secrets.X` for a job under `environment: production` as
   the `production` environment secret if one exists, else a **repository**
   secret of the same name, else an organization secret. A
   `DASHBOARD_SESSION_SECRET` left at the repository level alone would
   therefore satisfy the prod job silently — its session payload carries no
   host binding, so staging-issued cookies would verify on production, and
   reusing `DASHBOARD_ENCRYPTION_KEY` would break the per-instance envelope
   isolation. The workflow's non-emptiness assertions (`:?required`) cannot
   see this: they check a value is present, never where it came from.

   **The applied guard, and what it cannot prove.** The workflow asserts the
   environment variable `PROD_ENV_MARKER` (`production`) before its first
   mutating step; that proves the **effective** value resolved to
   `production`, not which level supplied it — `vars` resolves environment →
   repository → organization, so a repository- or organization-level
   `PROD_ENV_MARKER=production` satisfies the same assertion. **Never define
   `PROD_ENV_MARKER` outside the `production` environment**
   (§ Production approval gate and the tag gate). Secret **provenance** is
   still not observable from inside the run: a same-named repository-level
   secret is indistinguishable from the environment one by any assertion the
   workflow can make. Confirm at bring-up — and on any later secret rotation —
   that the three secrets above (`OAUTH_CLIENT_SECRET`,
   `DASHBOARD_SESSION_SECRET`, `DASHBOARD_ENCRYPTION_KEY`) are defined under
   **Settings → Environments → `production` → Secrets**, not merely at the
   repository level; and if a repository-level (or organization-level)
   fallback ever fired, **rotate both keys** — the session secret invalidates
   the cookies it signed, the encryption key needs the stored App credentials
   re-encrypted — because the two environments would have shared them.

4. **Production OAuth callback — required before the first production
   login.** The dashboard derives its callback from the request origin
   (`src/dashboard/index.ts` builds it as
   `new URL(request.url).origin + "/dashboard/oauth/callback"`), so on
   `https://inspector.mstar.page` the login flow sends GitHub
   `https://inspector.mstar.page/dashboard/oauth/callback`. That URL must be
   authorized on whichever OAuth App production's `OAUTH_CLIENT_ID` /
   `OAUTH_CLIENT_SECRET` belong to; no other value makes production login
   succeed. Pick one route and apply it before the first login:

   - **Shared App (current default)** — add
     `https://inspector.mstar.page/dashboard/oauth/callback` as a **second**
     callback URL on the staging dashboard OAuth App (GitHub allows several)
     and keep the repository-shared `OAUTH_CLIENT_ID` with the copied
     `OAUTH_CLIENT_SECRET` (step 3). No code or config change is needed.
   - **Production-only App** — create a separate OAuth App for production,
     register `https://inspector.mstar.page/dashboard/oauth/callback` on it,
     and set **environment-level** `OAUTH_CLIENT_ID` (variable) and
     `OAUTH_CLIENT_SECRET` (secret) under `production`; those override the
     repository-level values. Copy **that App's** secret — never generate one
     (step 3).

   Callback matching is **host-bound**: the registered URLs (and the wildcard
   toggle GitHub exposes per URL) permit subdomains and subdirectories of the
   registered host only, so a callback registered on the staging host can
   never match production, nor the reverse — `42ch.dev` and `mstar.page` are
   different registrable domains and no wildcard bridges them.

5. **First deploy** — the release chain never dispatches a prerelease, so
   bring-up dispatches the production workflow
   (`.github/workflows/deploy-prod.yml`) on the tag itself:

   ```bash
   gh workflow run deploy-prod.yml --ref <tag>   # a tag cut after this change shipped
   ```

   The dispatch only queues the run: it **pauses for the owner's approval** on
   the `production` environment before any step runs or any `production` secret
   is injected, so bring-up needs the owner to approve it in the run's UI
   (§ Production approval gate and the tag gate). Every later re-dispatch
   pauses the same way.

   **Once approved, the run mutates in this order: assert the required
   `production` secrets (pure preflight, no mutation) → resolve the deploy tag
   and validate it against the checked-out version surfaces (pre-mutation,
   § Production environment) → apply the prod D1
   migrations → `wrangler deploy --env production` → write the `production`
   secrets → re-read the live Worker version → smoke.** Deploying *before* the
   secrets is deliberate: the
   earlier order wrote them first, and on a first bring-up that made wrangler
   materialise a **bound-less draft Worker** (`mstar-inspector-production`
   without its bindings) holding the production secrets until the deploy step
   landed in the same run. Deploying first creates the Worker with its real
   bindings and no secrets; neither the deploy nor the migrations read the
   Worker secrets (they authenticate with the CI token), and the smoke stays
   last. No step of the run depends on the secrets being written earlier.
   The required-secret assertion (`:?required`) is a **pure preflight beside
   the environment-marker assertion, before the first mutating command**: a
   missing `production` secret reds the run before production is migrated or
   deployed, never after. It is only the `wrangler secret bulk` **writes** that
   stay after the deploy — the assertion is not repeated there.

   **`<tag>` must be created after this change ships.** `gh workflow run`
   runs the workflow **as defined at that ref**, and the repository's existing
   prerelease tag `v1.0.0-alpha.2` predates this change: its tree has no
   `deploy-prod.yml` and no `env.production`, so `gh workflow run
   deploy-prod.yml --ref v1.0.0-alpha.2` cannot start this workflow at all.
   The bring-up tag must therefore be a tag whose tree contains the workflow —
   cut a fresh prerelease after the merge (e.g. Release prep with
   `1.0.0-alpha.3`), or any tag created on or after the merge commit. The
   release chain will not move the old tag onto the merge commit either
   (`release:validate` fails when `v<version>` already points at a different
   commit), so `v1.0.0-alpha.2` cannot be reused.

   A manual dispatch is explicit human intent and **may** deploy a prerelease
   tag; the run deploys exactly the commit it was dispatched on — the tag's
   commit, pinned as the run's SHA — and a dispatch on a branch
   is refused before any mutation (§ The run's ref is the deployed checkout).
   Its own smoke asserts `https://inspector.mstar.page/healthz` returns
   `{"ok":true,"version":"v<tag>"}`.

   **If the first run reds at that smoke, the deploy itself still
   succeeded.** This first run also creates the `inspector.mstar.page`
   Workers Custom Domain, and certificate/DNS provisioning can outlast the
   smoke's ~3.5-minute budget (5 attempts × `curl --max-time 30` + 10s
   sleeps), so healthz can still be unreachable when the loop gives up.
   Recovery is to re-dispatch the same tag
   (`gh workflow run deploy-prod.yml --ref <tag>`): the migrations are a
   no-op against the already-migrated database and the secrets are re-injected
   idempotently, and the smoke then sees the provisioned domain.

### `ADMIN_LOGINS` lives in the config, not the dashboard

`ADMIN_LOGINS` is declared in `wrangler.jsonc` `env.production.vars`; it
cannot be a dashboard-managed plain var. wrangler accepts `keep_vars` only at
the top level and **rejects it inside an environment block**
(`Unexpected fields found in env.production field: "keep_vars"`), so an
automated `wrangler deploy --env production` wipes dashboard-set plain vars.
Production D1 starts empty, and with `ADMIN_LOGINS` unset the first OAuth
login against that empty `dashboard_users` table self-promotes to admin
(§ Multi-App go-live, step 6). The value is therefore part of the config:
changing it means editing `env.production.vars` and redeploying.
`REVIEW_ENABLED` stays unset — per-App Pause/Resume is the review control — and
`REVIEW_LEVEL` (the review tier — `quick`/`default`/`deep`) is likewise unset and
configured nowhere. The same `keep_vars` limitation applies to both: a
`REVIEW_ENABLED=false` or a `REVIEW_LEVEL` set on the production Worker from the
dashboard is wiped by the next `wrangler deploy --env production`, so neither
can be relied on until it is declared in `env.production.vars` and redeployed.
Per-App Pause/Resume is the primary review control and is unaffected
(`.env.example`).

### Maintenance: `env.production` duplicates the resource keys

Wrangler named environments do not inherit resource keys, so `env.production`
repeats every one of them (KV, D1, queues, containers, Durable Objects +
migrations, cron triggers, assets, observability) with the production values.
**Every new binding, migration tag, cron or asset change made for staging must
be repeated inside `env.production` in the same change**, or production
deploys without it — `tests/contracts/wrangler-env-parity.test.ts` fails when a
restatable top-level key is not restated. That lock also pins the
`env.production` Worker **name** (`mstar-inspector-production`, distinct from
staging's), the binding **names**, crons and migration tags + class lists (set
equality with the top level), the container `class_name` and image keys, and the
prod-only D1 database / queue / route host values it points at, and rejects any
resource identity the two blocks share. The container image `dockerfile` /
`build_context` **values** stay guarded by `tests/contracts/sandbox-images.test.ts`.
What no test can see is value drift **inside** a restated key the lock compares
only by identity: a prod KV namespace id or D1 `database_id` swapped for another
value that is still distinct from staging passes both the set-equality and the
shared-identity checks, so that residue remains review discipline.

### Rollback (production)

Same manual-only policy as staging (§ Rollback): the production workflow never
rolls back. A failed run stops red; the operator investigates and, if needed,
restores by hand.

- **Code/config** — `wrangler versions deploy --env production
  <version-id>@100%` **is version-only**: it re-points production at an
  already-uploaded version and changes no secret, var or migration. It
  re-points the **Worker version only** — the sandbox **container image**
  keeps whatever the last `wrangler deploy` pushed, so a version-only rollback
  across a container-affecting release pairs the old Worker with the newer
  image. Use the re-dispatch door below (it ships the older tag's container
  image too) when the rollback spans such a release. Version ids
  come from `wrangler deployments list --env production` or the run's summary /
  `deploy-evidence` artifact.
- **Re-dispatching `deploy-prod.yml` on an older tag is NOT version-only** —
  `gh workflow run deploy-prod.yml --ref <older-tag>` deploys exactly the
  commit that tag pointed at when the run was created
  (§ The run's ref is the deployed checkout) and re-runs the whole job (after
  pausing for the owner's approval — § Production approval gate and the tag
  gate): it
  applies the D1 migrations (`--remote --env production`, forward-only),
  deploys the older tag's code, container image and
  `wrangler.jsonc` `env.production` **vars** — which overwrite every plain var
  set in the dashboard (§ `ADMIN_LOGINS` lives in the config, not the
  dashboard) — and then
  re-injects the **current `production` environment secrets** (all four
  required ones, plus
  `ALERT_WEBHOOK_URL` written when that secret is set and **deleted** when it is
  not). Before dispatching, review the `production` environment's secrets
  and `env.production.vars` **at that tag**; rotate anything the older values
  would silently restore.
- **D1 migrations are forward-only** — roll back code, never the schema; a
  rollback after migrations applied would be a schema mismatch (§ Rollback).
- **Secrets/vars** — untouched by a version-only rollback; a re-dispatched older
  tag rewrites them from the `production` environment and that tag's config
  (previous bullet). Rotate explicitly when the rollback is
  security-motivated.

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
- Containers: no separate setup — the `SandboxV1` DO class (NEW class + namespace +
  `v2` `new_sqlite_classes` tag; a container application cannot change scheduling policy in
  place or reuse the 0.12 namespace) builds from `sandbox-image/omp/Dockerfile` at deploy time
  (`images.sandbox.build_context: "."`, lite instance via `container.start()`,
  `scheduling_policy: "durable_object"`, container app `mstar-inspector-sandbox-v2`). The old
  `mstar-inspector-sandbox` app is orphaned by the cutover — delete it after the switch.
  - **Fresh workers (new account, DR rebuild, recreated smoke worker)**: the retained `v1` tag still
    declares `new_sqlite_classes: ["Sandbox"]`, and wrangler 4.147.0 replays every unapplied migration
    on a first deploy. The worker entry therefore keeps exporting a MINIMAL compatibility `Sandbox`
    class — empty, serves no requests, no container, no binding traffic (`SandboxV1` is the only live
    implementation) — so the legacy migration stays replayable and a fresh deploy succeeds.
  - **The compatibility `Sandbox` export is a PERSISTENT requirement, not a temporary shim.** The retained
    `v1` tag (`new_sqlite_classes: ["Sandbox"]`) must stay declared forever (migration history is never
    edited), and any worker created from scratch replays *every* unapplied step — so this module must always
    export `Sandbox` for that replay to validate, whether or not a later `v3` tag unmounts the class from
    NEW namespaces. Ordered sequence: 1) ops deletes the orphaned `mstar-inspector-sandbox` container
    application; 2) a later `v3` tag with `deleted_classes: ["Sandbox"]` stops new namespaces from carrying
    it; 3) **the `Sandbox` class export stays** — it is what keeps `v1` replayable for any future fresh
    worker, and removing it re-arms the upload rejection this section exists to prevent. Removing the
    export would first require rewriting the retained `v1` history into a single consolidated migration
    chain and re-verifying BOTH an existing worker and a fresh one — explicitly out of scope for this
    change, not a casual follow-up.

### D1 migrations (0001–0024, forward-only)

The apply is **preceded by a Time Travel bookmark** — the pre-apply snapshot
every `0024` rollback refers to (§ Rollback). `0024` rebuilds
`app_provider_keys` and `app_custom_providers` (create → copy → drop → rename)
and the store promotes each carried-over row to the `key_id` pool key on its
first touch, so pre-`0024` code cannot read the live schema afterwards; the
bookmark is also the only recovery if the four-statement rebuild is
interrupted mid-file. **Keep the bookmark string** — it is the rollback's
restore point, and it expires 30 days after it was taken.

```bash
# 1. Snapshot FIRST — record the pre-apply bookmark. Time Travel is always on
#    and acts on the remote database; keep the printed bookmark string.
wrangler d1 time-travel info mstar-inspector-db

# 2. Then apply
wrangler d1 migrations apply mstar-inspector-db --remote   # remote (staging DB)
wrangler d1 migrations apply mstar-inspector-db            # local dev
```

Local dev has no Time Travel backend — the bookmark covers the remote
(`--remote`) database. On the automated path the workflow applies the
migrations, so take the bookmark **before pushing the merge** that carries
`0024` (§ Automated deploy).

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
| `0023_removed_logins` | `removed_logins` — removal tombstones: the key is `github_login` with the same NOCASE comparison as `users.github_login` (0016 parity), `removed_at` is required, `removed_by` is the acting admin's login (NULL when no actor was in scope). Written in the SAME transaction as the membership row delete, so `bootstrapDashboardAccess` can deny a removed login even when the `ADMIN_LOGINS` allowlist still lists it — an operator's removal is authoritative — while `createUser` clears the record on a deliberate re-invite |
| `0024_provider_multi_key` | `app_provider_keys` moves to the per-key pool primary key `(app_id, provider, key_id)`, and the new `app_custom_provider_keys` table takes over the custom-provider key material `app_custom_providers` no longer holds. SQLite cannot change a primary key in place, so both tables are rebuilt (create → copy → drop → rename); existing rows are carried across verbatim under the empty-string `key_id` sentinel and the store promotes each row on its first touch. Forward-only: a rollback means reverting the deploy AND restoring the Time Travel bookmark taken before the apply (§ Rollback). Must apply after `0004`/`0006`/`0012`/`0015` |

Migrations are **forward-only** (0002 precedent): never hand-edit an applied
migration; add the next file. Apply order matters for the newest pair: `0023`
must exist before the code that reads `removed_logins` runs (the Deploy
workflow applies migrations before deploying) — a code rollback to a version
predating `0023` stays safe, because that version ignores the new table,
while rolling the SCHEMA back is not supported. `0024` (the per-key provider
pool) applies last of all, and its own rollback needs the pre-apply Time
Travel bookmark (§ Rollback).
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

The four required secrets are asserted non-empty in the workflow **before the
first mutating command** (a pure preflight beside the environment-marker
assertion — a missing value reds the run before production is migrated or
deployed). The assertion must stay ahead of the mutations because
`wrangler secret bulk` treats a JSON `null` as a
secret **deletion**, so empty values must never reach it. `ALERT_WEBHOOK_URL`
is optional: when the GitHub Secret is set the workflow writes it to the
Worker; when it is absent the workflow **deletes** it from the Worker (a
previously set webhook does not linger) and the Worker falls back to log-only
alerting (§ Ops config).

**Recorded Worker version = the one live after the secret uploads.** Every
`wrangler secret bulk` call creates **and immediately deploys** a new Worker
version, so the `Current Version ID` line `wrangler deploy` prints names a
**predecessor** of the version actually serving traffic, and a `version_id.txt`
taken from that log alone would misreport the live version in the
`deploy-evidence` artifact and the Release notes. After the **last** mutating
step (the optional `ALERT_WEBHOOK_URL` write / delete) the workflow therefore
re-reads the live deployment with
`bunx wrangler deployments list --env production --json`, selects the **newest**
deployment by `created_on` — the CLI lists deployments **ascending**, so index 0
of the returned page is the *oldest*, not the live one — and overwrites
`version_id.txt` with that deployment's version id
(`[0].versions[0].version_id`, the shape verified against the live CLI; there is
no flat `[0].version_id` form).
When that lookup cannot confirm the version — an empty list, a missing field,
or the CLI itself failing — the file records the explicit marker
`unavailable (post-secret lookup failed)` and the step emits a `::notice::`; the
deploy-log predecessor is **never** left in place as if it were live. The
re-capture can never fail the deploy, and the healthz smoke proves the release
identity independently (`healthz.version == v<tag>`).

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
(`wrangler deploy` builds and pushes the sandbox image; the digest smoke
itself only reads `deploy.log`). A token that passes `wrangler whoami`
but lacks D1 access fails the migration step with
`The given account is not valid or is not authorized to access this service
[code: 7403]` — the account id is correct; the token's permissions are not.

**Token scoping (recorded alternative).** These scopes are account-wide and both
Workers live in the one account, so the token above — the staging one the
production run reuses today (§ One-time bring-up step 3) — is full authority
over **both** instances: it can replace the production Worker or mutate
production D1 with no tag, no production run and no approval. The owner
**accepted the shared token's residual on 2026-10-14, with no technical
mitigation currently applied** — the tag gate and the required reviewer
constrain the production deploy path only, while the staging workflow runs
repository code with the same token on every `main` push and that path can
target production **directly**; they do not compensate for the credential.
The **future remedy only** (not applied today) is a **production-only token**
(the same account-level groups, ideally in a separate Cloudflare account) set as
the `production` environment secret, with the shared token rotated once
production no longer uses it. The
deployment approval governs the workflow run, never the credential
(§ Production approval gate and the tag gate).

Provider API keys and the review model chain are **not** Worker env — they
live per App in D1 (`app_provider_keys` per-key pools since `0024`, custom
credentials in `app_custom_provider_keys`; the chains in `app_model_chains` /
`app_model_chain_seats` since `0017`), configured on each App's dashboard
Settings page and injected into the
review container from the App's config only (AL-24-5: the
`OMP_MODEL_KEY` / `OMP_REVIEW_MODEL` / `bun run keys` Worker-secret surface
was retired with the global fallback — an App missing its chain or a chain
provider's key fails its reviews closed).

Plain vars — `wrangler.jsonc` `vars` or the dashboard's Worker variable
settings; redeploy to change (except `ADMIN_LOGINS`, which the Deploy workflow
sources from a GitHub Actions variable — see below):

| Name | Default | Purpose |
|---|---|---|
| `REVIEW_ENABLED` | unset | **emergency brake only**: per-App `github_apps.review_enabled` is the primary review control; only the exact `"false"` (case-sensitive, untrimmed) stops ALL reviews — unset / `""` / `"true"` / `"TRUE"` / other → per-App governs |
| `ADMIN_LOGINS` | **required** | comma-separated GitHub logins **bootstrapped** as dashboard admin — the "at least one" list that lets the first admin reach the dashboard; sourced from the GitHub Actions **variable** `ADMIN_LOGINS` (`staging` env or repo-level), injected by the Deploy workflow with `wrangler deploy --var`, and passed explicitly by the documented manual deploys. It is **not** the membership SSOT and is not consumed once: after the first admin exists, membership lives in the dashboard's `users` table / Members page. It bootstraps a listed login that has **no `users` row and was never removed** — an existing row always wins (no promotion), and a login an operator removed stays denied even while the list still spells it; only an explicit re-invite on the Members page clears that record. Missing/blank/comma-only fails the deploy **before** it ships — see § 6 |

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

**No versioned Preview URLs.** The Worker implements the `SandboxV1` Durable
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

Caveats for this container Worker: only ONE version of the SandboxV1 DO runs
at a time (per-DO assignment, single global class) — a 0% version pinned via
override still boots the container; keep DO-class lifecycle changes out of
verified versions (uploads with lifecycle changes are rejected; deploy them
only via `wrangler deploy`).

## Deploy steps (manual reference)

> The automated path (§ Automated deploy) runs the same sequence in CI —
> typecheck/test → required-input gate → secrets → D1 migrations →
> `wrangler deploy` → smoke → digest record. The steps below are the manual
> equivalent, kept as reference for local runs and for recovering from a
> failed automated deploy.

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
   closed — plus the required
   `INSTALLATION_ID` (the App installation id to mint the token for) and
   `GH_REPO` (the `owner/repo` the smoke runs against), and the
   optional `SMOKE_ROUTE` (default `/smoke`),
   `ARK_API_KEY` (the operator's own key; required when
   `SMOKE_ROUTE=/smoke-review`, where the orchestrator forwards it into the
   container as the `MSTAR_POOL_ARK_01` slot with `MSTAR_POOL_ARK_COUNT=1` —
   the same pool env the production consumer builds):
   ```bash
   SMOKE_APP_ID=… SMOKE_PRIVATE_KEY=… INSTALLATION_ID=… GH_REPO=owner/repo \
     bun run scripts/sandbox-smoke.ts
   # /smoke: getSandbox → runCommand(gh pr diff) → destroy
   SMOKE_APP_ID=… SMOKE_PRIVATE_KEY=… INSTALLATION_ID=… GH_REPO=owner/repo \
     SMOKE_ROUTE=/smoke-review ARK_API_KEY=… bun run scripts/sandbox-smoke.ts
   # /smoke-review: full in-image runner (clone + omp review + parse) → destroy
   ```
   `INSTALLATION_ID` / `GH_REPO` are required inputs with no default.
   **The smoke target is fixed, not arbitrary**, and the code *assumes* the
   repository shape rather than verifying it: the PR number is the constant
   `#1`, and the configured repository must carry PR **#1 whose head is the
   `mstar-inspector-seed` branch, based against `main`** — there is no "works
   for any accessible repository" behaviour. `/smoke-review` clones that seed
   branch, fetches `main`, and diffs against it. `/smoke` only reaches the
   clone in its **fallback** path; its primary path runs
   `gh pr diff 1 --repo <repo>` on the same PR.
4. `bun run build:spa && wrangler deploy --var "ADMIN_LOGINS:alice,bob"` —
   build the SPA assets first
   (`dist/spa` is gitignored — a fresh clone has none, and `wrangler.jsonc`
   serves them via `assets`), then deploy the Worker (webhook face + queue
   consumer + cron trigger). The step also rebuilds/pushes the container
   image when the build context changed. **Copy the image digest from the
   deploy output.** The `--var` is required and carries the same value the
   Deploy workflow injects (`--var "ADMIN_LOGINS:$ADMIN_LOGINS"`): a manual
   `wrangler deploy` that omits it leaves the first OAuth login on an empty
   `users` table as admin (§ 6).
5. Record the digest baseline — on the automated path the workflow greps it
   out of the deploy log (`Smoke: image digest`), then writes it to the run
   summary (`$GITHUB_STEP_SUMMARY`) and uploads `deploy-evidence` artifacts;
   the manual equivalent is to copy the digest from the `wrangler deploy`
   output's container summary block (the `registry.cloudflare.com/…@sha256:`
   line).
   **Digest drift check (DOCS-01):** after every deploy, check the live
   version against the recorded baseline —
   ```bash
   wrangler deployments list   # or: wrangler versions list
   ```
   The **baseline** is the latest successful run's summary / `deploy-evidence`
   artifact (see § Image pins and digest record) — its digest is the bare
   `sha256:<hex>` the run records; the
   `registry.cloudflare.com/…@sha256:` reference that run's `wrangler deploy`
   printed survives in that run's `deploy.log` (the workflow strips the prefix
   when it writes `image_digest.txt`). There is **no independent live-digest
   source** to compare it
   against: `wrangler containers list --json` reports an empty `image` for
   this Worker's 1.0 `durable_object` application (only the orphaned
   default-policy `mstar-inspector-sandbox` app still carries a reference) —
   it remains useful for application **state** (`name` / `state` /
   `instances` / `version`), not for the digest. Drift is therefore detected by
   deploying and diffing the new run's digest against the baseline; a stale
   baseline makes the "which image is live" audit wrong.

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
# --entrypoint is required — the image's default command is long-lived
# (`sleep infinity` keeps the container alive) and would never
# surface this one-shot script's exit code.
```

## Post-deploy smoke

> The Deploy workflow runs the automated smoke on every deploy: healthz
> (3 attempts, 5s apart), cron registration (grep of the deploy log for
> `schedule: */15 * * * *`), and image-digest extraction (grep of the same
> deploy log for the container summary's
> `registry.cloudflare.com/<account>/mstar-inspector…@sha256:<64hex>`
> reference, sorted unique — zero matches or several distinct digests fail
> the run red). Any failure turns the run red and stops. The manual checks
> below are extra / local investigation steps, not the workflow smoke — for
> local runs and for investigating a red run.
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
   first configure a seat chain on the dashboard (a named chain in
   `app_model_chains` plus the seat's reference row in
   `app_model_chain_seats`, 0017) for the test App: the consumer
   materializes it into the runner input JSON
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
> `0024`** must be live); the live execution is QA-coordinated. Historical
> note: the go-live originally required `0001–0011`; the chain now extends
> to `0024` (`0019` profile columns, `0020`
> finding lifecycle, `0021` Check registry, `0022` per-App trigger mode,
> `0023` removal tombstones, `0024` the per-key provider pool).

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
`OAUTH_CLIENT_SECRET`), `DASHBOARD_SESSION_SECRET`, an admin login — a login
on the required `ADMIN_LOGINS` bootstrap list that has **no removal record**
(the empty-table fallback cannot
arm: the Deploy gate requires the list to parse to at least one login),
`DASHBOARD_ENCRYPTION_KEY` set, and D1 migrations applied **through
`0024`** — the full forward-only chain above, not a historical prefix.
`0020` supplies the finding-lifecycle/publication journal, `0021` the
Check registry, `0022` the per-App trigger-mode column the webhook
face reads on every delivery, `0023` the removal tombstones the
OAuth bootstrap reads before the allowlist, and `0024` the per-key provider
pool (`app_provider_keys` + `app_custom_provider_keys`) every App's provider
keys are stored in. A missing `0022` does NOT stop reviews:
the webhook face degrades to `every_push` semantics (the row's mode
reads as `undefined`, which the classifier treats as every_push). What
fails closed instead is the dashboard: the Settings page
(`parseSettings` rejects the payload without the mode field) and the
trigger-mode POST (its D1 UPDATE errors on the missing column). A missing
`0023` also fails the dashboard closed, not open: the bootstrap's tombstone
read and the members-remove batch both error out (500) instead of quietly
dropping the removal record. A missing `0024` fails the provider faces
closed instead: the per-key pool tables it creates are the only shape the
store writes to.

1. **Admin login** — open `/dashboard/login` and complete the GitHub OAuth
   flow. Precedence (`bootstrapDashboardAccess`, `src/dashboard/users.ts`):
   an existing `dashboard_users` row wins (allow, no promotion); a login
   whose removal is on record is denied — the allowlist never resurrects it;
   otherwise a
   login on the `ADMIN_LOGINS` list gets an admin row; the empty-table
   first-login fallback applies **only** when the parsed list is empty — which
   the required deploy gate prevents — so any other login is denied
   (invite-only, zero cookies). `ADMIN_LOGINS` exists so this first admin can
   reach the dashboard at all — that is its purpose, not its only effect: the
   Members page is the membership SSOT, a listed login with no `users`
   row remains eligible for admin bootstrap, and a removal there is
   authoritative (the record survives every later deploy until an admin
   re-invites the login).
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
Per-role overrides (the seat references in `app_model_chain_seats`, 0017; the
pre-`0017` `app_model_roles` rows were backfilled into named chains and are
read-retired) are deliberately NOT
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
  (the chain head is `0024`). The code-only precedent (0002 — new code
  tolerates the prior schema) covers additive migrations; `0024` rebuilt
  tables, so pre-`0024` code does not run against the live schema and its
  rollback needs the pre-apply Time Travel bookmark as well (§ D1 migrations,
  § Rollback). The `0023` removal tombstones stay safe on a code rollback: a
  version predating `removed_logins` simply ignores the table.
- **Secrets untouched** — rollback does not remove
  `DASHBOARD_ENCRYPTION_KEY`; rotate it explicitly when the rollback is
  security-motivated. A registered App's encrypted credentials stay valid
  across a Worker rollback (the key is unchanged).

### 6. ADMIN_LOGINS is required (deploy-time gate + assertion)

`ADMIN_LOGINS` is **required**. It is a GitHub Actions **variable** (login
names are public identity, so never a secret), configured for the `staging`
environment or repo-wide (Settings → Environments → `staging` → **Variables**,
or Settings → Secrets and variables → Actions → Variables).

**What it is:** an **"at least one" bootstrap list** — its job is to let the
first admin reach the dashboard at all. It is **not** a second
membership-management surface, and it is **not** consumed once: the runtime
still bootstraps any listed login that has **no `users` row** (an existing row
always wins, without promotion). Once any user row exists, the dashboard's
`users` table — the Members page — is the authorization SSOT.

The Deploy workflow:

1. **Fails closed before any deploy-capable step** when the variable is missing, blank,
   whitespace-only, or comma-only — the `Verify required ADMIN_LOGINS variable`
   step runs before the **first** `wrangler` invocation of any kind
   (`wrangler whoami`, the secret writes, and the final `wrangler deploy`):
   `wrangler secret bulk` publishes a Worker version of its own, so a gate
   placed after it would already have shipped a version without the required
   binding. A misconfigured operator therefore never ships a Worker with the
   first-login-becomes-admin fallback silently armed. The
   step imports and calls the runtime parser itself
   (`parseAdminLogins`, `src/dashboard/users.ts`) and fails when it yields zero
   logins, so the deploy gate cannot drift from the Worker's own rule.
2. **Is passed explicitly on every manual deploy too** — the documented
   manual paths ([`README.md`](../README.md) Path A step 5 / Path B step 1 and
   § Deploy steps step 4 above) deploy with
   `wrangler deploy --var "ADMIN_LOGINS:<comma-separated logins>"`, the same
   value this workflow injects. `wrangler.jsonc` defines no `ADMIN_LOGINS`, so
   a bare `wrangler deploy` is **not** a supported deploy path: it would ship
   with the fallback armed. There is no second deployment path — the manual
   commands are the workflow's equivalent, not an alternative to it.
3. **Injects it into the Worker** at deploy time via
   `wrangler deploy --var "ADMIN_LOGINS:$ADMIN_LOGINS"`, so the value no longer
   depends on the Cloudflare dashboard (a comma-separated multi-login value
   survives intact: wrangler splits `--var` on the first colon only).
4. **Asserts it on the deployed Worker** after the deploy: the step reads the
   Worker's live settings via the Cloudflare API (NOT `wrangler secret list` —
   `ADMIN_LOGINS` is a plain var, so a secret listing never shows it), feeds the
   observed value through the same `parseAdminLogins` runtime rule, and fails
   the job (`::error::` + non-zero exit) when it yields zero logins. The curl is
   bounded (`--max-time 30 --connect-timeout 5`)
   and a `jq -e '.success == true'` guard ensures a malformed payload is never
   read as a positive observation. A **transport failure fails the job** —
   failing to read the settings means the value cannot be confirmed, and a
   silent pass there would turn a flaky API read into a false green.

Why it matters: `ADMIN_LOGINS` is the **"at least one" bootstrap list** — its
purpose is to ensure the first admin can access the dashboard. It is not
ongoing membership management: the `users` table / Members page is the
membership SSOT, and the list is not consumed once — it bootstraps a listed
login that has no `users` row **and was never removed**, while an existing row
always wins without promotion. A login an operator removed is denied even
while the list still spells it: the removal is recorded in `removed_logins`
(migration `0023`, written in the same transaction as the row delete) and the
bootstrap consults it before the allowlist, so the record survives every later
deploy until an admin deliberately re-invites the login on the Members page.
The bootstrap insert itself refuses while the record exists — a write-boundary
check inside the `INSERT` (`WHERE NOT EXISTS (removal record)`), not a
read-then-write window — so a sign-in already in flight when the removal lands
is denied instead of resurrecting the login.
The empty-table first-login fallback needs a
genuinely empty parsed list, which this required gate prevents — so the
fallback can no longer be silently armed by a blank value. Logins that are
neither on the list nor in the table are denied (403, zero cookies) until an
admin invites them on the Members page.

To change the value, update the GitHub Actions variable and re-run the deploy
(the workflow injects it again); `keep_vars: true` in `wrangler.jsonc` only
preserves the other dashboard-managed var (`REVIEW_ENABLED`) across deploys.

## Rollback

> Rollback is a **manual human action** — the Deploy workflow never rolls
> back automatically. A failed deploy stops red; the operator investigates
> and, if needed, rolls back by hand.

- Worker code/config: redeploy the previous version — `wrangler rollback`
  (or check out the previous commit and `wrangler deploy`). Rollback restores
  Worker code + cron triggers + consumer config; the container image follows
  the checked-out Dockerfile.
- D1 migrations are **forward-only**: never reverse a migration on rollback.
  The 0002 code-only precedent (new code tolerates the prior schema; roll back
  code only) holds for additive migrations. Because migrations apply before
  deploy in the automated path, a failed run may have already applied them —
  and `0024` rebuilt `app_provider_keys` and `app_custom_providers`, so the
  current code needs the `key_id` column and `app_custom_provider_keys` that
  the pre-`0024` schema lacks. Reverting to pre-`0024` code therefore requires
  restoring the pre-apply Time Travel bookmark **as well as** reverting
  the code; the schema is never reversed by hand.
  ```bash
  # Revert the code first (Worker rollback above), then restore the database
  # to the pre-apply bookmark recorded in § D1 migrations. Destructive and
  # in-place; prints an undo bookmark before it runs.
  wrangler d1 time-travel restore mstar-inspector-db --bookmark=<pre-apply-bookmark>
  ```
  The bookmark is valid for 30 days after the apply and is the only restore
  point for this migration — without it, a pre-`0024` rollback is a
  credential-loss event for every App (the promoted rows are unreadable to the
  old code: three-segment AAD + real `key_id`).
- Secrets/vars are untouched by rollback — rotate explicitly when the
  rollback is security-motivated.

## Network egress (architect verdict AL-4 — FINAL)

### Verified control surface (real, NOT activated this iteration)

A real egress control surface exists and is verified: the Sandbox SDK 1.0
DO Container API (`this.ctx.container`,
`developers.cloudflare.com/containers/api/durable-object-container/`) exposes
the outbound face — `interceptOutboundHttp(addr, binding)` /
`interceptAllOutboundHttp(binding)` (deny-by-default once wired), plus
`enableInternet` on `container.start()` (set explicitly `true` in
src/pipeline/sandbox.ts — this repo relies on provider egress; 0.12's
`allowedHosts`/`deniedHosts`/`interceptHttps` superclass fields are gone with
the SDK's `Container` class). Enforcement lives in the runtime's
container-proxy fetch chain. Evidence: iteration spec m3-production-grade
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
- A missing host fails CLOSED (review failure → retry → DLQ) — a worse
  failure mode than the documented status quo.
- The 1.0 outbound-rule API's TLS/CA interception behavior on this base image
  is unverified (0.12's `interceptHttps` counterpart is gone; the 1.0
  `interceptOutboundHttps` face is not activated either).

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
preinstall is container-level only (`container exec` resolves the `mstar`
shim): review sessions stay restricted to the read-only `read` / `grep` /
`glob` whitelist (Runner tool whitelist above), so the review-session model
cannot invoke the CLI today — a sanctioned session toolcall path is a
tracked follow-up, not a shipped mechanism. Bun / gh pins carried forward
unchanged; the base image moved with the Sandbox SDK 1.0 migration (the SDK no
longer ships a runtime base — controlled Debian base + the 1.0.0
`sandbox-shim`):

| Pin | Value | Where |
|---|---|---|
| base image | `docker.io/library/debian:trixie-slim@sha256:918311b7b6c4c6f68b232ba516584925f6c78ad82b6fd534b98979df6438e483` (linux/amd64; + `sandbox-shim` from `docker.io/cloudflare/sandbox:1.0.0`) | `sandbox-image/omp/Dockerfile` FROM / COPY --from |
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
> actor, timestamp). The digest is the container reference the deploying
> `wrangler deploy` printed, recorded in its bare `sha256:<hex>` form (the
> account-scoped `registry.cloudflare.com/…@sha256:` line stays in that run's
> `deploy.log`) — `wrangler containers list --json` does **not**
> carry it for the 1.0 `durable_object` app (the record reports
> `"image": ""`; only the orphaned default-policy `mstar-inspector-sandbox`
> app still shows a reference), which is why no side-by-side live compare is
> possible: the run summary is the deploy-time baseline for the DOCS-01
> drift check — diff the new run's digest against it after any deploy.
> Historical record (2026-08-31 manual deploy):
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
  by backlog. With a unique sandbox id per attempt (each attempt gets its own
  Durable-Object-managed container — `scheduling_policy: "durable_object"`
  has no `max_instances` cap), >1 concurrency would run containers
  concurrently. Pinned, NOT env-configurable.

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
- `PROD_ENV_MARKER` (NEW, environment **variable** — not a secret, never
  Worker env): the `production` environment carries it with the value
  `production`, and no other scope may define it. The production workflow
  asserts it before its first mutating step, which proves the **effective**
  value resolved to `production` — not which level supplied it (`vars`
  resolves environment → repository → organization, so another scope's
  `PROD_ENV_MARKER=production` would satisfy the assertion); it does not prove
  where a secret *value* came from either
  (§ Production approval gate and the tag gate, § One-time bring-up step 3).

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
