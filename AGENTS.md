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

Examples: `.worktrees/09-review-deep-parent/`, `.worktrees/feat-foo/`.

`git worktree add .worktrees/<plan-id> -b feat/<plan-id> <base>`

The directory is gitignored. Do not `git add` it. Cleanup still uses `git worktree remove` on abandoned paths listed by `git worktree list`.

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

<!--injected-by-void-v0.10.13-->
## Void

This project uses [Void](https://void.cloud) — a fullstack Vite plugin + deployment platform for Cloudflare. `voidPlugin()` in `vite.config.ts` gives you file-based API routing on Hono (`routes/`), Inertia-inspired server-rendered pages with co-located loaders/actions (`pages/` + `@void/vue` or `@void/react`), auto-provisioned D1/KV/R2 bindings, first-class Drizzle ORM integration (schema in `db/schema.ts` -> `void/db` Drizzle instance -> typed routes -> typed fetch client), built-in auth, queues, cron jobs, edge caching (ISR), and one-command deploys via `npx void deploy`. For first-time setup, prefer `npx void init`; in an empty directory, install `void` first and let the interactive flow scaffold the starter with Vite+ by default, add the matching framework adapter, configure project files, handle auth, and link or create the deploy project before the first deploy. In an existing app, `void init` configures Void in place by adding missing Vite scripts and creating or patching `vite.config.*` with `voidPlugin()`. Use `void` and `@void/*` package names in source code and package manifests.

Database: define Drizzle tables in `db/schema.ts`, import `db` from `void/db` and tables from `@schema`. Use `void db push` for prototyping, `void db generate` for production migrations. `drizzle-orm` and `drizzle-kit` ship with void (no extra install). Migrations live in `db/migrations/`.

Env: declare every env key in `env.ts` at the project root via `defineEnv({ KEY: string(), ... })` from `void/env`. Read values via `import { env } from "void/env"`. Schema validation runs at dev start (warns) and on `void deploy` (hard error on missing prod secrets). Use `VITE_*` prefix for keys that should be exposed to client code.

CI/editor prep: run `void prepare` to generate `.void/routes.d.ts`, `.void/db.d.ts`, `.void/queues.d.ts`, `.void/env.d.ts`, and `.void/tsconfig.json` without booting Vite. Run it after `npm install` in CI or a fresh clone before typechecking; `vite dev` and `vite build` regenerate these during normal workflows.

Rewrites and redirects: declare static rules in `void.json` under `routing.redirects` / `routing.rewrites` / `routing.fallbacks`, or in a `public/_redirects` file. For dynamic rewrites, call `c.rewrite(path)` in a `defineMiddleware`.

Logs: surface app-level errors that should show up under `void project logs --level error` via `import { logger } from "void/log"` and `logger.error(msg, fields?)` (also `.warn` / `.info`). Anything caught and only persisted to your own DB is invisible to Cloudflare Tail; route it through `logger.*` or `console.*` so the platform can see it.

Requests: `void project logs` only has rows when a worker actually ran. 5xx generated by the edge router, and every request to a static/SPA project, produce no log line at all. Use `void project requests --status 5xx --range 12h` to see those — it lists status, method, and duration for every request the edge served, whether or not a worker was invoked.

Self-host deploy: `void deploy` targets the Void platform; to deploy to the user's OWN Cloudflare account instead, use `void deploy --backend cloudflare` (add `--provision` on the first deploy to create the D1/KV/R2/Queues/Hyperdrive resources the source needs). It uses local wrangler auth, so pin an account (`account_id` in `wrangler.jsonc` or `CLOUDFLARE_ACCOUNT_ID`) and keep real secrets in `wrangler secret put` — every `.env*` file this backend loads (`.env`, `.env.local`, `.env.production`, `.env.production.local`) ships as plaintext worker vars, `.local` included. Provisioning a Hyperdrive config reads `DATABASE_URL` from the shell, not from `.env*`. v1 supports full Void apps on the Cloudflare Workers target only (D1/KV/R2/Queues/Hyperdrive; auth and ISR on D1/SQLite); framework SSR of every kind (TanStack Start, React Router, vinext, SvelteKit, Nuxt, Analog, Astro), static/SPA/SSG apps (including `output: "static"`), WebSocket/Durable Object apps (`*.ws.ts`), a custom `migrations_pattern`, node/bun/deno targets, and PostgreSQL apps with auth all fail closed with guidance. Auth apps must ship checked-in migrations that produce the Better Auth schema. `--provision` is a single-operator, dev-machine step and is disabled in CI.

Full docs are in `node_modules/void/docs/`. If you have the `void` skill available, use it for a complete API reference covering project structure, routing, pages mode, database, auth, typed fetch, KV, storage, queues, cron jobs, CLI, configuration, and deployment.

<!--/injected-by-void-->
