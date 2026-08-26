# AGENTS.md — repo root

## Harness

Morning Star harness SSOT lives in [`.mstar/AGENTS.md`](.mstar/AGENTS.md) — path symbols, content boundaries, state gates, residual lifecycle. Read it before any plan/status/residual work.

## Source Priority

1. Current user instruction
2. This file
3. `.mstar/AGENTS.md`
4. `mstar-*` skills

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
  `mstar-inspector-wt-*` worktree (`ppid=1` after the parent wrangler died).
- leftover git worktrees (`git worktree list`) and local branches already
  merged to `origin/main`.

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
