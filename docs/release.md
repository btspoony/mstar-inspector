# Release — mstar-inspector

> **Releasing is a reviewable GitHub Actions chain that runs no deploy — it
> hands production off to its own workflow.**
> A human triggers **Release prep** → the workflow assembles the bilingual
> changelog, bumps the version surface, and opens a `release vX.Y.Z` PR →
> merging that PR makes the **Release** workflow tag the verified merge commit
> and publish the GitHub Release. Tags are only ever created by CI on an
> already-verified commit — never by hand.
>
> The release **also deploys production**: once the Release is created, the
> Release workflow **dispatches** the production workflow
> ([`.github/workflows/deploy-prod.yml`](../.github/workflows/deploy-prod.yml))
> on the tag (`gh workflow run deploy-prod.yml --ref <tag>` — the job's
> `actions: write` permission is what allows it, and the dispatched run deploys
> exactly the tag it runs on: the workflow takes no `ref` input and refuses a
> non-tag ref). The dispatch is required
> because a Release published with the workflow's `GITHUB_TOKEN` does **not**
> create a `release: published` run: GitHub suppresses workflow events caused
> by `GITHUB_TOKEN` (`workflow_dispatch` / `repository_dispatch` are the
> exempt trigger types). The dispatched run ships the tagged commit to the
> production Worker `mstar-inspector-production` at
> `https://inspector.mstar.page`. A prerelease (`-` in the version) is never
> dispatched by the automated chain, which starts no production deploy for it;
> staging verifies those. A manual `workflow_dispatch` on a prerelease tag ref
> is the supported exception and may deploy one — the first production bring-up
> does exactly that. The `release: published` trigger stays declared and deploys
> a Release a human (or any non-`GITHUB_TOKEN` actor) publishes; on that path
> the job-level tag guard skips a prerelease tag.
> Independently, the same merge pushes to `main`, so the
> [Deploy workflow](deploy.md) ships the version bump to **staging** exactly
> as for any other change.

This document is the **living home of the cut-a-release steps** (including the
first-cut checklist and failure paths). The day-to-day changelog fragment
protocol lives in [`.changes/README.md`](../.changes/README.md) and is not
duplicated here.

## Version shapes (contract)

| Surface | Form | Example |
|---|---|---|
| Git tag / `release/` branch / PR title / GitHub Release | `v`-prefixed | `v1.0.0`, `release/v1.0.0`, `release v1.0.0` |
| Changelog section header / fragment archive dir | bare | `## [1.0.0]`, `.changes/archive/1.0.0/` |

## Cutting a release (operator steps)

**Prerequisite (once per repo):** the PR-creation step runs on the workflow's
`GITHUB_TOKEN`, which requires the repo setting **Settings → Actions →
General → Workflow permissions → "Allow GitHub Actions to create and approve
pull requests"** to be enabled — the workflow's `pull-requests: write` does
not bypass this repo-level gate (it is off by default). Enable it with
`gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -F can_approve_pull_request_reviews=true`.
Anyone mirroring this release chain on a fork must flip the same setting on
their repo.

1. **Actions → Release prep → Run workflow.** Optionally pass an explicit
   version (`1.0.0`, or a prerelease like `1.1.0-alpha.0`). Leave the input
   empty for an auto patch bump derived from `package.json#version` — never
   from tags. Preparations are serialized (`concurrency: release-prep`, no
   cancel-in-progress).
2. **The workflow** fails early if the requested tag already exists, then
   assembles `.changes/unreleased/*.md` into `## [X.Y.Z] - <date>` sections in
   `CHANGELOG.md` + `CHANGELOG_CN.md`, bumps every version surface
   (`package.json#version` and the generated `src/version.ts` — one
   `VERSION_SURFACES` list), validates (`release:validate`), typechecks and
   builds the SPA, pushes the `release/vX.Y.Z` branch, and opens (or updates
   the) `release vX.Y.Z` PR with the EN changelog section in its body.
3. **Review the PR — this is the versioning review face.** The diff should
   contain exactly: the two changelog sections, the version bump, and the
   fragment moves into `.changes/archive/<X.Y.Z>/`. **A release PR has no
   regular checks tab — that is expected** (AD-5: the bot's `GITHUB_TOKEN`
   events do not re-trigger `ci.yml`; the prep workflow's own validate +
   typecheck + build steps are the PR's verification face, and the Release
   workflow re-verifies everything on the merge commit before tagging).
4. **Merge.** The Release workflow triggers on the closed+merged
   `release v…` PR: it re-validates, typechecks, tests, and builds on the
   merge commit, pushes the annotated `vX.Y.Z` tag (skipping idempotently if
   the tag already exists), and creates the GitHub Release with bilingual
   notes (EN section, `---`, CN section; a `-` in the version marks it as a
   prerelease). A final step then appends the [Deploy evidence
   section](#deploy-evidence-release--deploy-reconciliation) — it never
   postpones the tag and never fails the workflow.
5. **Both deploys happen automatically.** *Staging*: the merge's `main` push
   triggers the Deploy workflow (`package.json` is not in its `paths-ignore`
   set), so the version bump ships to staging; after it completes, `/healthz`
   and the dashboard report the new version. *Production*: the Release workflow
   dispatches the production workflow
   ([`deploy-prod.yml`](../.github/workflows/deploy-prod.yml)) on the tag — no
   `release: published` run is created by the bot's own Release (GITHUB_TOKEN
   event suppression), so the dispatch is what starts the production run for
   it — and
   that run re-verifies the tag, injects the `production` secrets, applies the
   prod D1 migrations, deploys the prod Worker and asserts
   `https://inspector.mstar.page/healthz` returns `v<tag>`. A prerelease is
   never dispatched by the automated chain — it starts no run for it (a
   prerelease published by hand in the UI does create a `release: published`
   run, but the job's tag guard skips its deploy); bring-up and rollback
   dispatch it on a **tag** ref instead — the run's ref is what it deploys, so
   a non-tag ref is refused before any mutation — and a manual dispatch may
   deploy a prerelease tag
   ([production environment](deploy.md#production-environment)). A red
   dispatch step fails the release run **after** the tag and Release exist —
   see [Failure paths](#failure-paths).

## Changelog fragment discipline

Every user-visible change ships with a bilingual fragment committed alongside
the code — format, categories, and the EN/`<!-- CN -->` pairing rules live in
[`.changes/README.md`](../.changes/README.md). Do not hand-edit `CHANGELOG.md`
/ `CHANGELOG_CN.md`; those files are assembled at release time.

## First cut: v1.0.0 live verification checklist

The first real `v1.0.0` cut can only happen **after this chain is merged to
`main`** (`workflow_dispatch` requires the workflow file on the default
branch; within an iteration the chain is verified by dry-runs only). The
first cut is the live acceptance event for the whole chain — pass the
explicit version `1.0.0` (not auto). Every item below must pass:

1. **Actions listing** — both **Release prep** and **Release** workflows
   appear in the Actions panel (default-branch listing).
2. **Release prep run** — dispatch with `1.0.0`; the `release v1.0.0` PR
   opens, and its diff contains the bilingual `## [1.0.0]` section (the
   curated baseline + this iteration's own delivery fragments) and the
   version-surface bump `0.1.0 → 1.0.0`.
3. **Merge → tag + Release** — the `v1.0.0` annotated tag lands on the merge
   commit; the GitHub Release `v1.0.0` is published with bilingual notes plus
   the Deploy evidence section for the **production** run (Worker Version ID +
   image digest + deploy run link — or an explicit pending/failed/no-run
   status; never silently missing).
4. **Live version** — after the post-merge deploy completes, staging
   `/healthz` returns the new `version` field and the SPA displays it
   (surface lands with the `src/version.ts` VERSION_SURFACES entry); once the
   production run finishes, `https://inspector.mstar.page/healthz` returns the
   same version — the run's own smoke gate asserts it.
5. **Fragments archived** — `.changes/unreleased/` is empty and the consumed
   fragments live under `.changes/archive/1.0.0/`.

**Any item failing is a chain defect → fix immediately (hotfix path), never
de-scope it into a "known issue".**

## Failure paths

- **Requested version already released** — Release prep fails early with
  `Tag vX.Y.Z already exists`. Pick a different version; re-releasing an
  existing version is a bug, not an operation.
- **Release run failed after the tag was pushed** (e.g. Release creation
  failed on a partial run) — **re-run the Release workflow**; the run
  converges by itself: the validate step's tag gate is self-healing (a
  `vX.Y.Z` tag already sitting on the checked-out merge commit passes with an
  explicit note; only a tag pointing at a *different* commit fails closed as
  `TAGEXISTS`), the tag step then skips idempotently (`Tag vX.Y.Z already
  exists; skipping tag creation.`), and Release creation proceeds. If the
  rerun itself cannot complete, recover by hand: the tag is already on the
  merge commit, so create the GitHub Release manually from it —
  `gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes>` (rebuild the
  bilingual notes with
  `bun run scripts/extract-changelog-section.ts X.Y.Z --lang en|cn`, joined by
  a blank-line-separated `---`).
- **Release PR could not be opened** (`gh pr create` fails — e.g. branch
  protection): the `release/vX.Y.Z` branch is already pushed. Open the PR
  manually: base `main`, head `release/vX.Y.Z`, title `release vX.Y.Z` (the
  title prefix is what the Release workflow's guard matches on — keep it
  exact).
- **PR creation blocked by workflow permissions** (the final "Open or update
  release PR" step fails with `GraphQL: GitHub Actions is not permitted to
  create or approve pull requests (createPullRequest)`) — the repo-level gate
  from the [prerequisite above](#cutting-a-release-operator-steps) is off.
  The `release/vX.Y.Z` branch is already pushed by then; after enabling the
  setting, either open the PR manually as described above, or delete the
  branch and re-dispatch Release prep with the same version.
- **Release PR shows no checks** — expected (AD-5, see step 3 above). The
  prep run's own log is the verification evidence for that PR.
- **Re-dispatching prep for the same version** — the `release/vX.Y.Z` branch
  is force-pushed (`--force-with-lease`) and the existing PR is updated in
  place (`gh pr edit`).
- **Staging deploy fails after merge** — independent of the release chain (tag
  and Release are already cut); follow the [deploy runbook](deploy.md) failure
  semantics. A failed deploy never rolls back a tag.
- **Production deploy fails** — the dispatched `deploy-prod.yml` run for the
  tag is red with the failing step named; the tag and Release stand and nothing
  is rolled back. Follow the
  [production rollback](deploy.md#rollback-production) — note what a
  re-dispatch re-runs — or re-dispatch the workflow on an older tag.
- **Production dispatch failed** (the "Dispatch production deploy on the
  release tag" step goes red — `gh workflow run` was refused, e.g. the dispatch
  permission is missing): the tag and the Release were both created **before**
  that step, so they stand, but **no production run was started**. Re-run the
  Release workflow (it converges idempotently), or dispatch by hand —
  `gh workflow run deploy-prod.yml --ref vX.Y.Z` (the run's own ref is the
  deploy tag, so its head SHA and its deployed checkout are both the tag's
  commit).
- **Deploy-evidence append failed** (the evidence **step** goes red —
  `::error::` annotation plus non-zero exit — while the job stays green via
  step-level `continue-on-error`, so evidence can never fail the release): a
  transient `gh release edit` failure left the Release without the evidence
  section. Re-run the Release workflow (it converges idempotently), or append
  the section by hand per [manual reconciliation](#manual-reconciliation-fallback).
- **Job timeout preempted the evidence step** (extreme case only: slow
  pre-steps plus a full-length bounded wait — the evidence step carries its
  own `timeout-minutes: 18` budget, 15-min wait default + margin, bounded
  below the job's 30-minute cap so the wait can never starve the pre-steps;
  the job cap can still fire mid-wait in a pathologically slow run): the run
  goes red **without losing the tag or the Release** — both are created
  before the evidence step. Re-run the Release workflow; it converges and
  re-appends the evidence section idempotently.

## Deploy evidence (release ↔ deploy reconciliation)

Every GitHub Release carries a **Deploy evidence** section pinning the tagged
commit to what actually shipped to **production**: the prod Worker Version ID,
the sandbox image digest, and the Actions run link of the
[production deploy workflow](../.github/workflows/deploy-prod.yml) run for the
tagged commit. The collector resolves that run — not staging's — for the tag
(`gh run list --workflow deploy-prod.yml --commit <sha>`); with both workflows
able to produce a run for the same commit, naming the workflow is what keeps
the match unambiguous. The tag match is proof of identity, not a heuristic: the
production workflow takes no `ref` input and refuses a non-tag ref, so a run
dispatched on this tag deployed exactly this tag. Notes are assembled in the
Release workflow's `$RUNNER_TEMP` as: EN changelog section, blank line, `---`,
blank line, CN changelog section — and after Release creation, the evidence
section is appended behind the same `---` separator. The step then rewrites
the Release **once** with a single idempotent `gh release edit --notes-file`
(AD-3: the body is recomposed from workspace artifacts, never read-modify-written from
the live body). Data comes entirely from the production run's
`deploy-evidence` artifact — no new credentials beyond the workflow's
`GITHUB_TOKEN`, declared with `actions: write` (the dispatch of
`deploy-prod.yml` requires it, and it covers the collector's `gh run list` /
`gh run download` reads).

**Body ownership window:** between Release creation and the evidence rewrite
(a minutes-scale window while the bounded wait runs), the body belongs to the
workflow — hand edits made in that window are overwritten by the rewrite.
Re-running the Release workflow is safe: the notes file is rebuilt from
scratch each run and the same-body rewrite is idempotent.

### Section semantics — a recording surface, never a gate

The collector (`scripts/collect-deploy-evidence.ts`) waits a bounded ~15 min
for the production deploy run of the tagged commit, then states one of these
explicitly. Nothing here can postpone the tag or fail the Release workflow — a
missing section is always *stated*, never silent:

| Section says | Meaning / operator action |
|---|---|
| `Worker version` + `Image digest` + `Actions run` | The production deploy run concluded successfully; IDs come from its `deploy-evidence` artifact. Nothing to do. |
| `Status: deploy failed` | The production deploy run concluded non-success (conclusion is quoted). A `release: published` event for a **prerelease** published in the UI lands here with `skipped` quoted — the run exists, but the job's tag guard skips the deploy. Follow the run link; see the [deploy runbook](deploy.md) and the [production rollback](deploy.md#rollback-production). The tag and Release stand — a failed deploy never rolls them back. |
| `Status: pending` | The production deploy is still in flight when the bounded wait expired. It usually finishes shortly after; see [manual reconciliation](#manual-reconciliation-fallback) to backfill or confirm. |
| `Status: no deploy run for commit …` | **No** production run exists for the tagged commit after the bounded wait — nothing dispatched the production workflow for it and no `release: published` run was created. The production workflow has **no `paths-ignore`**, so a path filter is never the cause; a tag reaches production through the Release workflow's dispatch, a `release: published` event for a Release a human (or another non-`GITHUB_TOKEN` actor) published, or a manual `workflow_dispatch` ([production environment](deploy.md#production-environment)). Expected for a prerelease the automated chain never dispatches and which thus gets no run of its own (a manual dispatch on a prerelease tag ref **does** start a run — that is the bring-up path — while a prerelease published by hand lands in the `deploy failed` row above as a skipped run). Recover by dispatching the workflow for that tag. |
| `Status: unavailable` | Evidence collection itself errored (the error is quoted in the section). Rare; reconcile manually. |

### Manual reconciliation (fallback)

When the section is pending, unavailable, or looks stale, reconcile by hand —
the two checks the automation performs, runnable directly:

1. **Worker Version ID** — `bunx wrangler deployments list --env production`: the newest
   deployment's Version ID (and its source commit) must match the tagged
   merge commit and the section's `Worker version` bullet.
2. **Image digest** — open the production Deploy run's summary (the section's run link,
   or the run's `deploy-evidence` artifact) and compare its "Production deploy
   evidence" bullets against the Release section. That baseline —
   the `registry.cloudflare.com/…@sha256:` reference `wrangler deploy` printed
   — is the only recorded digest: `bunx wrangler containers list --json`
   returns an **empty** `image` for this Worker's 1.0 `durable_object`
   application, so the digest cannot be re-read from live container state and
   an independent live-digest comparison is not available. To re-derive the
   digest, deploy again and read the reference from the new run's summary; to
   confirm what is *live* at all, use the check in step 1 (`wrangler
   deployments list` → Worker Version ID) against the section's
   `Worker version` bullet.

If the section needs fixing, either re-run the Release workflow (idempotent
converge — simplest), or edit the Release directly:
`gh release edit vX.Y.Z --notes-file <notes>` with a body assembled the same
way (EN + `---` + CN + `---` + evidence section).
