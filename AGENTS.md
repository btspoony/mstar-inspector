# AGENTS.md — repo root

## Harness

Morning Star harness SSOT lives in [`.mstar/AGENTS.md`](.mstar/AGENTS.md) — path symbols, content boundaries, state gates, residual lifecycle. Read it before any plan/status/residual work.

## Source Priority

1. Current user instruction
2. This file
3. `.mstar/AGENTS.md`
4. `mstar-*` skills

## Git worktrees

Feature worktrees for this repo are created **under `./.worktrees/`** (repo-relative), not as sibling directories next to the clone.

Examples: `.worktrees/my-topic/`, `.worktrees/feat-foo/`.

`git worktree add .worktrees/<plan-id> -b feat/<plan-id> <base>`

The directory is gitignored. Do not `git add` it. Cleanup still uses `git worktree remove` on abandoned paths listed by `git worktree list`.

## No local process IDs in tracked content

`.mstar/` harness state (plans, iterations, SDD runs, workflows, status) is
gitignored local process data. Its identifiers must never appear in any
git-tracked file (docs, code comments, migration headers, config comments)
or in commit messages / PR titles / PR bodies:

- Banned: `plan NN` / `plan-NN` / `planNN`, `iter NNN` / `iter-NNN` /
  `iter0NN`, iteration slugs (`NNN-slug`, `iteration-vX.Y`, `NNN 迭代`),
  workflow/SDD directory names, and `.mstar/plans|sdd|iterations|workflows`
  path references.
- Write self-contained references instead: what it is + date + upstream
  tag/SHA when relevant. Provenance lives only under `.mstar/`.
- `AD-*` / `AL-*` and acceptance/finding-style IDs recorded in tracked docs
  are fine; local plan/iteration identifiers are not.
- Applies to all new work; existing pushed history is never rewritten.

## Sandbox image rebuild

The review container is built from `sandbox-image/Dockerfile`, and `wrangler`
hashes **that file alone** — not the sources the Dockerfile copies in. A change
to those sources therefore deploys the Worker without rebuilding the image, and
the container keeps running the previous build: no error, no warning, no
failing check.

Touch the `# rebuild:` marker block in `sandbox-image/Dockerfile` in the same
commit whenever you change any of:

- `packages/runner/src/**`
- `packages/shared/src/**`
- `packages/runner/package.json` or `packages/runner/bun.lock` (the image
  installs from them, so an omp SDK bump is an image change)
- `packages/runner/verify-synthesis.sh` (copied into the image at /opt/verify-synthesis.sh)
- `sandbox-image/**` — the CLI shims and their lockfiles
- `.dockerignore` — it decides which of these sources reach the build context

Also touch it when the container block in `wrangler.jsonc` changes — the
container's `name`, its `images` entry, or that entry's `dockerfile` /
`build_context` — because that block decides which tree the Dockerfile sees and
which file is hashed. Every other `wrangler.jsonc` edit (vars, queues, routes,
observability) leaves the image untouched and needs no marker.

Check before merging anything that touches those paths — the same gate CI runs,
against the revision the deploy builds on:

```bash
bun scripts/check-image-inputs.ts --base origin/main
```

Exit 0 means the diff needs no rebuild; exit 1 prints the family list above and
names the marker line it wanted, and it also covers the container-block rule and
every other family — a partial `git log` over two paths would miss the rest.
Pass `--base <rev>` to diff the deployed tip instead of the trunk.

### The failure this prevents

Worker and image disagreeing is silent. The observed shape: the Worker sends a
credential payload and no longer relies on the write side closing the pipe; the
stale runner still waits for EOF; the read never returns; both streams stay
empty; the outer exec bound kills the run at its full budget.

```
runner failed: exit 124, stdout 0B, stderr empty
```

`exit 124` with both streams empty is not a hung model call — check the image
age before reading runner logic. This cost two production review cycles in a
row, the second one 24 minutes after the first was "fixed" by touching this
same file. The tracing added to the runner (`traceStage`) cannot help while the
image does not contain it, which is how both runs stayed silent.

## Post-work cleanup

After a session that spawned **local** wrangler / Cloudflare Sandbox / Docker
(smoke, `wrangler dev`, image-size trials, worktree builds), inspect and tear
down **this repo's leftovers** before ending. Do not wait for the user to
notice. The live Cloudflare Worker is remote — it is not this checklist.

### Identify

- `docker ps -a` — names `workerd-mstar-inspector-*` / `mstar-inspector-*`, or
  image `mstar-inspector-sandbox:*` (including unnamed containers on those tags).
- local images tagged `mstar-inspector-sandbox:*` and
  `mstar-review-runner-test:*` (this repo's custom sandbox builds / trial tags).
- orphan `workerd` processes whose argv/cwd is this repo or a deleted
  `.worktrees/*` checkout (`ppid=1` after the parent wrangler died).
- leftover git worktrees: `git worktree list` — abandoned paths under
  `.worktrees/`, plus any local branches already merged to `origin/main`.

### Tear down

- `docker stop` then `docker rm` the identified containers.
- `docker rmi` the identified image tags (all of them, including intermediate
  trial tags like `omit-optional` / `pruned` / `test`). Then `docker image prune -f`
  **only** if dangling layers are left from those rmi's — never `docker image prune -a`.
- SIGTERM orphan workerd; SIGKILL only if they ignore TERM.
- `git worktree remove` abandoned worktrees; `git branch -d` merged locals.
  Remote feature branches GitHub already deleted on merge — do not fail the
  checklist on a missing remote ref.

### Do not

- touch other compose projects (`earnos-*`, `openviking`, anything whose name
  or compose label is not this repo).
- `docker image prune -a` / `docker system prune` (those sweep unrelated images).
- `docker rmi` Cloudflare **public / shared** images that wrangler and other
  projects reuse: `cloudflare/sandbox`, `cloudflare/proxy-everything`,
  `cloudflare-dev/sandbox`, any other `cloudflare/*` Hub image. Next
  `wrangler dev` / Sandbox smoke reuses them; deleting only forces a re-pull.
- pull, push, login, or `docker rmi` `registry.cloudflare.com/*`. That registry
  is wrangler's **deploy** staging/remote for Containers — not a local-dev
  leftover. `wrangler deploy` may also retag the same local image ID with a
  `registry.cloudflare.com/.../mstar-inspector-sandbox:<hash>` name; leave
  that tag. Untagging it does not delete the remote copy, and local-dev
  cleanup must not talk to that registry.
- disable, redeploy, or `wrangler` the live Worker as "cleanup".
- kill a `workerd` whose parent is a still-running `wrangler dev` the user owns.

### Report

List what was stopped/removed vs left running, including image tags and
reclaimed size.
