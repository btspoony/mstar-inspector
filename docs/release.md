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
   `CHANGELOG.md` + `CHANGELOG_CN.md`, bumps `package.json#version`, validates
   (`release:validate`), typechecks and builds the SPA, pushes the
   `release/vX.Y.Z` branch, and opens (or updates) the `release vX.Y.Z` PR
   with the EN changelog section in its body.
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
   prerelease).
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
   commit; the GitHub Release `v1.0.0` is published with bilingual notes
   (+ the deploy-evidence section once plan 52's reconciliation lands; until
   then its absence is expected, never silent).
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

## Notes composition (deploy-evidence hook)

Release notes are assembled in the Release workflow's `$RUNNER_TEMP` as:
EN changelog section, blank line, `---`, blank line, CN changelog section.
Plan 52 appends the deploy-evidence section (Worker Version ID, sandbox image
digest, deploy run link) after the same separator and rewrites the Release
with a single idempotent `gh release edit --notes-file` — tag/Release creation
never waits for evidence, and a missing evidence section is stated
explicitly, never silently omitted.
