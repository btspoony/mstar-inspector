---
title: Runtime-surface package boundaries
category: architecture-patterns
status: active
last_updated: 2026-10-23
---

# Runtime-surface package boundaries

The repository is split by **where code runs**, not by feature folder.

## Surfaces

| Surface | Code | Ships to |
|---|---|---|
| Worker (production) | `src/worker/**`, `src/pipeline/**` (except the smoke entry), `src/store/**`, `src/dashboard/**` | Cloudflare Worker |
| Worker (smoke) | `src/pipeline/smoke-entry.ts` | a separate `wrangler dev` worker |
| Browser | `src/spa/**` | Vite bundle |
| Sandbox | `packages/runner/src/**` + the shared subset | review container |

## Packages

- `packages/shared` — dual-surface wire modules (`recheck-wire.ts`, `credential-key.ts`, `runtime.ts`, `credential-payload.ts`). No runtime dependency on engine, omp SDK, zod, or `src/`. `import type` is allowed and erased.
- `packages/runner` — sandbox-only runtime (`runner.ts`, `runtime-omp.ts`, `recheck.ts`, `models-synthesis.ts`, `seat-agent.md`, `verify-synthesis.sh`). Own manifest, own version, own `bun.lock`.
- `src/review/schema.ts` stays in the Worker tree: it runtime-depends on engine + zod and the runner never imports it.

## Direction (enforced)

`packages/runner -> packages/shared`; `src/* -> packages/shared`. No reverse edges, no barrel re-exports.

Executable guards:

- `tests/contracts/shared-boundary.test.ts` — no runtime engine/omp/zod import, no path escaping `packages/shared/src`.
- `tests/contracts/bundle-boundary.test.ts` — `Bun.build` metafile `inputs`: Worker graph has no `node_modules/@oh-my-pi/`, runner graph has no `node_modules/hono` / `node_modules/@octokit/`.
- `tests/review/runtime-boundary.test.ts` — the image admits only `packages/runner/src` + `packages/shared/src`; a reappearing `COPY src/...` fails.
- `tests/review/pin.test.ts` — engine resolves to the same version in the root lock, the runner lock, and the image pin.

## Image layout

Keep the repository-relative prefix in the image:

```
packages/shared/src -> /opt/runner/packages/shared/src
packages/runner/src -> /opt/runner/packages/runner/src
```

Then `../../shared/src/*` resolves identically in the repository and in the container; no tsconfig paths are needed. The image installs from `packages/runner/package.json`, so Worker-side dependencies (hono, react, octokit) no longer ride along.

## Pitfalls

- `.dockerignore` patterns are root-anchored: add `**/node_modules` and `packages/**/tests`, but keep `*.md` root-anchored so `packages/runner/src/seat-agent.md` still ships.
- A `packages/runner/node_modules` materialized inside the checkout shadows the root omp SDK and breaks `mock.module` in `tests/review/*`. Verify the runner lockfile from a temporary copy instead of an in-repo install.
- Two engine copies (Worker and runner) must resolve to one version; a drift shows up as a silent envelope parse mismatch, not a compile error.
