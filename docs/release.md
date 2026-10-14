# Release — mstar-inspector

> **Releasing is a reviewable GitHub Actions chain that runs no deploy — it
> hands production off to its own workflow.**
> A human triggers **Release prep** → the workflow assembles the bilingual
> changelog, bumps the version surface, and opens a `release vX.Y.Z` PR →
> merging that PR makes the **Release** workflow tag the verified merge commit
> and publish the GitHub Release. Tags are only ever created by CI on an
> already-verified commit — never by hand.
>
> The release **also triggers the production deploy**: once the Release is
> created, the Release workflow **dispatches** the production workflow
> ([`.github/workflows/deploy-prod.yml`](../.github/workflows/deploy-prod.yml))
> on the tag (`gh workflow run deploy-prod.yml --ref <tag>` — the job's
> `actions: write` permission is what allows it, and the dispatched run deploys
> exactly the commit it was dispatched on: the workflow takes no `ref` input,
> checks out the run's own immutable SHA and refuses a non-tag ref). The
> dispatched run then **pauses for the owner's approval** before it deploys
> (step 5). The dispatch is required
> because a Release published with the workflow's `GITHUB_TOKEN` does **not**
> create a `release: published` run: GitHub suppresses workflow events caused
> by `GITHUB_TOKEN` (`workflow_dispatch` / `repository_dispatch` are the
> exempt trigger types). The dispatched run ships the tagged commit to the
> production Worker `mstar-inspector-production` at
> `https://inspector.mstar.page`. A prerelease (`-` in the version) is never
> dispatched by the automated chain, which starts no production deploy for it;
> staging verifies those. A manual `workflow_dispatch` on a prerelease tag ref
> is the supported exception and may deploy one — the first production bring-up
> does exactly that, on a tag cut **after** this workflow ships (a tag that
> predates it has no `deploy-prod.yml` at that ref to run); see
> [production bring-up](deploy.md#one-time-bring-up-operator). The `release: published` trigger stays declared and deploys
> a Release a human (or any non-`GITHUB_TOKEN` actor) publishes; on that path
> the job-level guard requires the Release to be non-prerelease **and** its tag
> to carry no `-`.
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
5. **Staging deploys automatically; production is dispatched automatically but
   waits for the owner's approval.** *Staging*: the merge's `main` push
   triggers the Deploy workflow (`package.json` is not in its `paths-ignore`
   set), so the version bump ships to staging; after it completes, `/healthz`
   and the dashboard report the new version. *Production*: the Release workflow
   dispatches the production workflow
   ([`deploy-prod.yml`](../.github/workflows/deploy-prod.yml)) on the tag — no
   `release: published` run is created by the bot's own Release (GITHUB_TOKEN
   event suppression), so the dispatch is what starts the production run for
   it — and that run then **pauses at job start for the owner's approval** on
   the `production` environment before a single step runs or any secret is
   injected ([production environment](deploy.md#production-environment)).
   Once approved it re-verifies the tag, applies the prod D1 migrations,
   deploys the prod Worker, writes the `production` secrets and asserts
   `https://inspector.mstar.page/healthz` returns `v<tag>`. **Nothing reaches
   production unattended**, so a release cut outside the owner's working hours
   sits at the approval prompt until it is granted — and the Release's Deploy
   evidence section records `pending` in the meantime (§ Deploy evidence).
   A prerelease is
   never dispatched by the automated chain — it starts no run for it (a
   prerelease published by hand in the UI does create a `release: published`
   run, but the job's guard requires the Release to be non-prerelease **and** its
   tag to carry no `-`, so it skips that deploy); bring-up and rollback
   dispatch it on a **tag** ref instead — the run's ref names the released tag
   and its checkout is pinned to the run's own SHA, so a non-tag ref is refused
   before any mutation — and a manual dispatch may
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
   status; never silently missing). **`Status: pending` is the normal state
   here, not a defect**: the production run pauses for the owner's approval,
   and unless that approval is granted inside the collector's ~15-minute
   bounded wait the section is written while the run is still waiting.
   Approve the production run, then complete this item through
   [manual reconciliation](#manual-reconciliation) — that backfill is the
   ordinary completion path for a release whose production deploy is approved
   after the wait.
4. **Live version** — after the post-merge deploy completes, staging
   `/healthz` returns the new `version` field and the SPA displays it
   (surface lands with the `src/version.ts` VERSION_SURFACES entry); once the
   **approved** production run finishes,
   `https://inspector.mstar.page/healthz` returns the
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
  the section by hand per [manual reconciliation](#manual-reconciliation).
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
the match unambiguous, and it prefers the newest run whose own dispatch ref
(`headBranch`) equals the release tag. **When the refs match, that match is
proof of identity, not a heuristic**: the
production workflow takes no `ref` input, checks out the run's own immutable
SHA and refuses a non-tag ref, so a run dispatched on this tag deployed
exactly the commit it was dispatched on. When instead no run carries the tag
ref, the collector falls back to the newest run for the commit and **says so**
with a `- Run identity: no run on ref \`vX.Y.Z\` for commit \`<sha>\` — the
newest run for the commit is reported instead, which is not that ref's deploy`
bullet: identity is then unproven, the cited run may not be this release's own
deploy, and the section should be confirmed per
[manual reconciliation](#manual-reconciliation). Notes are assembled in the
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

What the production run itself publishes: its own run summary carries the
heading **`## Production deploy evidence`** with the Worker, the Worker
version, the image digest and the run link, and its `deploy-evidence` artifact
holds the raw `deploy.log` / `version_id.txt` / `image_digest.txt` the
collector reads. The digest recorded — in `image_digest.txt`, in the run
summary and so in this section — is the **bare** `sha256:<hex>`: the workflow
strips the prefix off the account-scoped
`registry.cloudflare.com/<account>/<image>@sha256:<hex>` reference that run's
`wrangler deploy` printed, and that account-scoped form survives only in the
run's `deploy.log` — or the recorded digest is the literal
`unchanged (no push in this deploy)` when that deploy pushed no container
image (the digest step never fails the run).

The recorded **Worker version** is the one **live after the secret uploads**,
not the one `wrangler deploy` printed: each `wrangler secret bulk` call creates
and immediately deploys another version, so a capture taken from the deploy log
alone would name a predecessor of what is serving traffic. After the last
mutating step the run re-reads the live deployment
(`bunx wrangler deployments list --env production --json`) and writes that
version id over `version_id.txt`, keeping the deploy-log value only as a
noticed fallback (a failed read emits a `::notice::` and never fails the
deploy). The section's `Worker version` bullet is therefore the version to
compare against a live `deployments list` in
[manual reconciliation](#manual-reconciliation).

**Only the Release workflow appends this section.** A Release published by
hand in the UI deploys production through the retained `release: published`
trigger, but it starts no `pull_request: closed` run — so no collector runs for
it and its notes carry **no evidence section**. Reconcile such a Release by
hand (§ Manual reconciliation).

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
| `Status: deploy failed` | The production deploy run concluded non-success (conclusion is quoted). Follow the run link; see the [deploy runbook](deploy.md) and the [production rollback](deploy.md#rollback-production). The tag and Release stand — a failed deploy never rolls them back. A **skipped** deploy job does not land here: the run still concludes `success` (it surfaces as `Status: unavailable`, below). |
| `Status: pending` | The production deploy run had not concluded when the bounded wait expired — normally because it is still **waiting for the owner's approval** (step 5), which lands after the wait far more often than inside it. This is the expected state for a release approved late; approve the run, then follow [manual reconciliation](#manual-reconciliation) to backfill or confirm. |
| `Status: no deploy run for commit …` | **No** production run exists for the tagged commit after the bounded wait — nothing dispatched the production workflow for it and no `release: published` run was created. The production workflow has **no `paths-ignore`**, so a path filter is never the cause; a tag reaches production through the Release workflow's dispatch, a `release: published` event for a Release a human (or another non-`GITHUB_TOKEN` actor) published, or a manual `workflow_dispatch` ([production environment](deploy.md#production-environment)). Expected for a prerelease the automated chain never dispatches and which thus gets no run of its own (a manual dispatch on a prerelease tag ref **does** start a run — that is the bring-up path — while a prerelease published by hand creates a run whose deploy job the guard skips (it requires the Release to be non-prerelease **and** its tag to carry no `-`): that run still concludes `success`, so it lands in the `unavailable` row below, not here). Recover by dispatching the workflow for that tag. |
| `Status: unavailable` | Evidence collection itself errored (the error is quoted in the section). That includes a run which concluded `success` but carries no `deploy-evidence` artifact — how a **skipped** deploy job (a prerelease published by hand in the UI) surfaces: no deploy ran, so there is nothing to read. Otherwise rare; reconcile manually. |

### Manual reconciliation

**Pending is the normal evidence state for a production deploy approved after
the collector's wait, so this section is the usual completion path for such a
release — not an exception.** When the section is pending, unavailable, or
looks stale, reconcile by hand — the two checks the automation performs,
runnable directly:

1. **Worker Version ID** — `bunx wrangler deployments list --env production`: the newest
   deployment's Version ID (and its source commit) must match the tagged
   merge commit and the section's `Worker version` bullet.
2. **Image digest** — open the production Deploy run's summary (the section's run link,
   or the run's `deploy-evidence` artifact) and compare its "Production deploy
   evidence" bullets against the Release section. That baseline —
   the bare `sha256:<hex>` those bullets record, i.e. the account-scoped
   `registry.cloudflare.com/…@sha256:` reference `wrangler deploy` printed in
   that run's `deploy.log` — is the only recorded digest: `bunx wrangler containers list --json`
   returns an **empty** `image` for this Worker's 1.0 `durable_object`
   application, so the digest cannot be re-read from live container state and
   an independent live-digest comparison is not available. To re-derive the
   digest, deploy again and read it from the new run's summary (or the
   account-scoped reference out of that run's `deploy.log`); to
   confirm what is *live* at all, use the check in step 1 (`wrangler
   deployments list` → Worker Version ID) against the section's
   `Worker version` bullet.

If the section needs fixing, either re-run the Release workflow (idempotent
converge — simplest), or edit the Release directly:
`gh release edit vX.Y.Z --notes-file <notes>` with a body assembled the same
way (EN + `---` + CN + `---` + evidence section).
