---
module: worker-runtime
date: 2026-10-16
problem_type: runtime_error
category: runtime-errors
severity: high
symptoms:
  - "The Workers runtime refuses to start: 'The Workers runtime failed to start.' with 'service core:user:<worker>: Uncaught TypeError: The argument 'path' The argument must be a file URL object, a file URL string, or an absolute path string.. Received 'undefined''"
  - "wrangler deploy aborts with 'A request to the Cloudflare API (/accounts/<account>/workers/scripts/<worker>) failed' and [code: 10021], after the container image push and the asset upload already succeeded"
  - "The failing stack frame names an installed dependency's dist file, not application code — e.g. node_modules/@mstar-harness/engine/dist/engine.js:49:33, reached from the app module that imports it"
  - "CI is green and 'wrangler deploy --dry-run' exits 0 on the same commit"
root_cause: "A Node-targeted dependency bundle carried a module-scope CJS-interop shim, `var __require = createRequire(import.meta.url)`, and its initialization path called it (`__require(\"tty\")`, `__require(\"util\")`). Workerd evaluates that banner with an undefined `import.meta.url`, so `createRequire` throws while the module graph is still initializing — before any fetch/scheduled handler exists."
resolution_type: dependency_update
tags:
  - workerd
  - wrangler
  - createrequire
  - bundler
  - dependency-upgrade
  - deploy-gate
related_components:
  - src/contracts/sandbox-images.ts
  - sandbox-image/omp/Dockerfile
---

# Workerd start-up crash from a Node-targeted bundle's CJS require shim

## Problem

A Cloudflare Worker stopped being deployable after a dependency upgrade and nothing in CI noticed. The
deploy job failed at the upload step with Cloudflare API error `10021`; locally the same commit failed even
harder — `wrangler dev` printed *"The Workers runtime failed to start."* and the stack pointed into an
installed package's bundle rather than into application code.

Because the failure happens at **module initialization**, it is not a bug in one code path: the Worker has no
handlers yet, so every route is down and every subsequent deploy of that Worker is blocked. The previous
release of the dependency worked, and the only thing that changed was its version.

## Symptoms

- `wrangler dev` → `✘ [ERROR] The Workers runtime failed to start.`, preceded by
  `Uncaught TypeError: The argument 'path' … Received 'undefined'`.
- The stack bottoms out in `createRequire` (`node:module`) and then names the dependency's `dist` file —
  `…/node_modules/<pkg>/dist/<bundle>.js:49:33` — entered from whichever application module imports the package.
- `wrangler deploy` fails only at the end of its run, as an API validation error, after the container image
  push and the asset upload have already succeeded. This is what makes the failure look like a transient
  platform problem when it is not.
- `wrangler deploy --dry-run` prints the bindings and exits 0.

## What Didn't Work

- **`wrangler deploy --dry-run` as the gate.** It builds and reports bindings, but it never evaluates the module
  graph, so it exits 0 on the broken revision. It is not a runtime gate.
- **`wrangler check startup`.** It refuses locally when the Worker has Durable Object bindings
  (*"The upload contains bindings that cannot be reproduced locally during startup profiling"*), so it is
  unavailable on exactly the Kind of Worker that hits this.
- **Guarding the banner alone.** Replacing `createRequire(import.meta.url)` with a lazy
  `(p) => createRequire(import.meta.url)(p)` in the installed `dist` did not fix the start-up crash — the
  throw simply moved from the banner to the `__require` call site, because the bundle's initialization path
  calls `__require("tty")` / `__require("util")` eagerly. The dist must have **no init-time `require` at all**.
- **Trusting a green CI.** Nothing in CI bundles for the Workers runtime, so a bundle-level defect is invisible
  to it. A passing test job is not evidence that the Worker can boot.

## Solution

The upstream package must ship a dist that carries neither the interop banner nor init-time builtin `require`
calls. The observable contract of the fixed release, in the installed `node_modules`:

| dist property | broken release | fixed release |
|---|---|---|
| `__require` occurrences | 1 banner + init-time calls | 0 |
| `__commonJS` occurrences | present | 0 |
| `createRequire(import.meta.url)` | module scope (line 49) | only inside function bodies, reached lazily |

Resolution here was a **dependency update** to that release, and it is a coupled version line: the repo
manifest range, the lockfile, and the sandbox image's plugin/CLI pins all move together, because the pin
contract binds them to one another. Moving only the lockfile leaves the pin suite and the image inconsistent.

A cheap static pre-check before trusting a new dependency build:

```sh
grep -cE '__require|__commonJS' node_modules/<pkg>/dist/<bundle>.js   # expect 0
```

## Prevention

- **Gate any change that can alter the Worker's module graph with `wrangler dev`**, and require it to reach
  `Ready on http://…`. This includes dependency bumps, bundler/config changes, and anything touching a package
  the Worker imports. `--dry-run` is a build gate, not a boot gate.
- **Check the installed bundle, not the changelog.** A dependency upgrade is verified by what its `dist`
  contains and what the runtime does with it, not by the release notes.
- **Keep the version line in one declaration home.** When several files must agree on a version, let one record
  own the value and let a test derive every other occurrence from it — that is what turns a partial bump into a
  failing test instead of a silent drift.
- **Related failure family:** `github-app-pem-workerd` — the same shape of defect (green under Bun, broken under
  workerd, because one dependency resolves differently per runtime), with a different root cause.
