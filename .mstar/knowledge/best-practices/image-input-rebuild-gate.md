---
module: sandbox-image
date: 2026-11-03
last_updated: 2026-11-03
problem_type: best_practice
category: best-practices
severity: high
tags:
  - docker
  - wrangler
  - ci-gate
  - image-drift
  - build-context
applies_when:
  - "A deploy system hashes the build definition but copies source trees into the image"
  - "Adding or changing CI checks that decide when an image must be rebuilt"
  - "Reviewing a diff that touches runner/shared sources or the image build context"
---

# Gate image rebuilds on the inputs the hash does not cover

## Context

`wrangler` hashes `sandbox-image/Dockerfile` alone. The container it deploys also contains
whatever that Dockerfile `COPY`s: `packages/runner/src`, `packages/shared/src`, the runner
manifest and lockfile, `packages/runner/verify-synthesis.sh`, the `sandbox-image/` shims, and
the build context filtered by the repo-root `.dockerignore`. A change to any of those leaves
the hash unchanged, so a rollout ships a new Worker against the previous image. There is no
error, no warning, and no failing check; both halves run, they just disagree.

The same shape applies to any deploy system that reads a build definition but copies sources
into an artifact.

## Guidance

- Make the gate a diff question, not a build question: which path families did this change
  touch, and did the same change touch the marker the build definition actually hashes?
- Keep one declared vocabulary in code (`IMAGE_INPUT_FAMILIES`) and derive both the matchers
  and the printed instruction from it. Prose copies in `AGENTS.md` and `docs/deploy.md` are
  inputs to a parity test, not independent sources of truth.
- Derive the build-definition path from `wrangler.jsonc` (`containers[].images.sandbox.dockerfile`)
  instead of hardcoding it; fail closed when the config declares none.
- Treat the build context as an input: the root `.dockerignore` decides what reaches the image,
  and a `wrangler.jsonc` change can repoint `build_context` or the Dockerfile. Both belong in
  the vocabulary.
- Prove completeness from the artifact, not from memory: parse every `COPY` source in the
  Dockerfile (skipping `COPY --from=`) and require each to match a family. A new `COPY` line
  must either be covered or fail the test.
- Read git output defensively: `--no-renames` keeps a move out of an input family visible as a
  delete, and `-z` avoids the quoting that non-ASCII paths would otherwise incur.
- Run the gate wherever a change can reach the deploy path. A pull-request-only gate leaves a
  direct push to the default branch uncovered; `github.event.before` is the base for push
  events, and the all-zeros first-push SHA is a skip, not a failure.

## Why This Matters

Without the gate, a runner-source change can deploy a Worker that expects behaviour the image
does not have. The failure is silent and the two halves are individually healthy, so the first
symptom is a hung or empty review run. A gate that fails on the diff converts that into a red
check before deploy.

The gate is only as complete as its vocabulary. A hand-maintained list drifts from the
Dockerfile the first time someone adds a `COPY` line or changes the build context, and the
gate then passes on exactly the changes it exists to catch. Deriving coverage from the
Dockerfile and the config keeps the claim honest.

## When to Apply

- Any image or artifact whose deploy hash covers the build definition but not the sources it
  copies in.
- Any change to the image input vocabulary, the Dockerfile `COPY` set, `.dockerignore`, or the
  container config in `wrangler.jsonc`.
- Reviewing a diff that touches runner/shared sources without a Dockerfile change.

## Examples

A gate script exposes three pure decisions and a CLI:

```ts
touchesImageInput(paths: string[]): boolean
touchesRebuildMarker(dockerfileDiff: string): boolean
evaluateImageGate(paths: string[], dockerfileDiff: string): { ok: true } | { ok: false; reason: string }
```

The CLI takes `--base <sha>`, reads changed paths and the Dockerfile diff, and exits non-zero
with the instruction naming every covered family. Tests pin both directions: an input change
without the marker fails, the same change with a `# rebuild:` line passes, a rename out of a
family fails, and a non-ASCII path is matched. A separate test derives the Dockerfile `COPY`
sources and fails when one is not covered, and another compares the code list against the
`AGENTS.md` and `docs/deploy.md` bullets so prose cannot drift silently.
