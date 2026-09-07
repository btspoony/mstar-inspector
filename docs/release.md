# Release — mstar-inspector

> **Releasing is a reviewable GitHub Actions chain, decoupled from deploying.**
> A human triggers **Release prep** → the workflow assembles the bilingual
> changelog, bumps the version surface, and opens a `release vX.Y.Z` PR →
> merging that PR makes the **Release** workflow tag the verified merge commit
> and publish the GitHub Release. Tags are only ever created by CI on an
> already-verified commit — never by hand.
>
> Deploying is untouched: the same merge pushes to `main`, so the
> [Deploy workflow](deploy.md) ships the version bump to staging exactly as
> for any other change. A release never deploys anything itself.

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
5. **Deploy happens automatically.** The merge's `main` push triggers the
   Deploy workflow (`package.json` is not in its `paths-ignore` set), so the
   version bump ships to staging; after it completes, `/healthz` and the
   dashboard report the new version.

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
   the Deploy evidence section (Worker Version ID + image digest + deploy run
   link — or an explicit pending/failed/no-run status; never silently
   missing).
4. **Live version** — after the post-merge deploy completes, staging
   `/healthz` returns the new `version` field and the SPA displays it
   (surface lands with plan 51).
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
- **Release PR shows no checks** — expected (AD-5, see step 3 above). The
  prep run's own log is the verification evidence for that PR.
- **Re-dispatching prep for the same version** — the `release/vX.Y.Z` branch
  is force-pushed (`--force-with-lease`) and the existing PR is updated in
  place (`gh pr edit`).
- **Deploy fails after merge** — independent of the release chain (tag and
  Release are already cut); follow the [deploy runbook](deploy.md) failure
  semantics. A failed deploy never rolls back a tag.
- **Deploy-evidence append failed** (the run shows a `::error::deploy-evidence
  append failed` annotation but stays green — the step is deliberately
  `continue-on-error` so evidence can never fail a release): a transient
  `gh release edit` failure left the Release without the evidence section.
  Re-run the Release workflow (it converges idempotently), or append the
  section by hand per [manual reconciliation](#manual-reconciliation-fallback).

## Deploy evidence (release ↔ deploy reconciliation)

Every GitHub Release carries a **Deploy evidence** section pinning the tagged
commit to what actually shipped: the Worker Version ID, the sandbox image
digest, and the deploy Actions run link of the Deploy run for the merge
commit. Notes are assembled in the Release workflow's `$RUNNER_TEMP` as: EN
changelog section, blank line, `---`, blank line, CN changelog section — and
after Release creation, the evidence section is appended behind the same
`---` separator. The step then rewrites the Release **once** with a single
idempotent `gh release edit --notes-file` (AD-3: the body is recomposed from
workspace artifacts, never read-modify-written from the live body). Data comes
entirely from the existing Deploy workflow's `deploy-evidence` artifact — no
new credentials beyond the workflow's `GITHUB_TOKEN` (`actions: read` for the
artifact download).

**Body ownership window:** between Release creation and the evidence rewrite
(a minutes-scale window while the bounded wait runs), the body belongs to the
workflow — hand edits made in that window are overwritten by the rewrite.
Re-running the Release workflow is safe: the notes file is rebuilt from
scratch each run and the same-body rewrite is idempotent.

### Section semantics — a recording surface, never a gate

The collector (`scripts/collect-deploy-evidence.ts`) waits a bounded ~15 min
for the Deploy run of the merge commit, then states one of these explicitly.
Nothing here can postpone the tag or fail the Release workflow — a missing
section is always *stated*, never silent:

| Section says | Meaning / operator action |
|---|---|
| `Worker version` + `Image digest` + `Actions run` | The Deploy run concluded successfully; IDs come from its `deploy-evidence` artifact. Nothing to do. |
| `Status: deploy failed` | The Deploy run concluded non-success (conclusion is quoted). Follow the run link; see the [deploy runbook](deploy.md). The tag and Release stand — a failed deploy never rolls them back. |
| `Status: pending` | Deploy still in flight when the bounded wait expired. The deploy usually finishes shortly after; see [manual reconciliation](#manual-reconciliation-fallback) to backfill or confirm. |
| `Status: no deploy run for commit …` | No Deploy run matched the merge commit (e.g. everything it touched is in `paths-ignore`). Expected for changelog-only cuts. |
| `Status: unavailable` | Evidence collection itself errored (the error is quoted in the section). Rare; reconcile manually. |

### Manual reconciliation (fallback)

When the section is pending, unavailable, or looks stale, reconcile by hand —
the two checks the automation performs, runnable directly:

1. **Worker Version ID** — `bunx wrangler deployments list`: the newest
   deployment's Version ID (and its source commit) must match the tagged
   merge commit and the section's `Worker version` bullet.
2. **Image digest** — open the Deploy run's summary (the section's run link)
   and compare its "Deploy evidence (DOCS-01 baseline)" bullets against the
   Release section; live truth is `bunx wrangler containers list --json`
   (the sandbox image digest).

If the section needs fixing, either re-run the Release workflow (idempotent
converge — simplest), or edit the Release directly:
`gh release edit vX.Y.Z --notes-file <notes>` with a body assembled the same
way (EN + `---` + CN + `---` + evidence section).
