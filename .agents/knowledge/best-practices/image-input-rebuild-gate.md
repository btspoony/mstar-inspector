---
module: sandbox-image
date: 2026-11-03
last_updated: 2026-11-18
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

- Make the gate a value question, not a prose question: the build definition records a hash of
  its own inputs, and the gate compares that recorded value with what the tree hashes to. A
  comment saying "I changed an input" is neither checkable nor repair-able; a value is both.
- Keep one declared vocabulary in code (`IMAGE_INPUT_FAMILIES`) and derive both the matchers
  and the printed instruction from it. Prose copies in `AGENTS.md` and `docs/deploy.md` are
  inputs to a parity test, not independent sources of truth.
- Derive the build-definition path(s) from `wrangler.jsonc`
  (`containers[].images.sandbox.dockerfile`) instead of hardcoding them; fail closed when the
  config declares none.
- Treat the build context as an input: the root `.dockerignore` decides what reaches the image.
  For the container config itself, compare the parsed `containers[].images` block (dockerfile,
  build context, image entries) between base and head rather than treating the whole
  `wrangler.jsonc` file as an input path, so an unrelated var, cron or queue edit does not force
  an image rebuild.
- Read EVERY container block, not just the top-level one: a named environment does not inherit
  resource keys, so `env.production` declares its own container with its own `dockerfile` and
  `build_context`. Record the fingerprint in each declared Dockerfile and require every one of
  them to match, or a production-only repoint ships unguarded.
- Prove completeness from the artifact, not from memory: parse every `COPY` source in the
  Dockerfile (skipping `COPY --from=`) and require each to match a family. A new `COPY` line
  must either be covered or fail the test.
- Exclude the Dockerfile from its own hash. The line that records the value lives in that file,
  so covering it makes every write invalidate the value it just wrote.
- Make the hash machine-independent: sorted repo-relative paths, normalized newlines, no
  absolute path, mtime or platform fact. Enumerate the files through `git ls-files` so ignored
  trees never enter it, and so the value is the same in CI and on a laptop.
- Read git output defensively: `--no-renames` keeps a move out of an input family visible as a
  delete, and `-z` avoids the quoting that non-ASCII paths would otherwise incur.
- Keep the base revision out of the verdict. A force-push orphans the previous tip, and a gate
  whose pass/fail depends on resolving it turns an unrelated git fact into a build decision.
  Use the base for the MESSAGE only — which families moved — and let the recorded value decide.
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

A gate script exposes the pure decisions and a CLI:

```ts
imageInputFingerprint(files: {path, content}[], containerBlock: string): string
readImageInputsMarker(dockerfileText: string): string | undefined
withImageInputsMarker(dockerfileText: string, fingerprint: string): string
evaluateImageGate(recorded: string | undefined, fingerprint: string, families?: string[]):
  { ok: true; fingerprint } | { ok: false; reason: "image-inputs-stale"; ... }
```

The CLI hashes the tree, compares it with the `# image-inputs:` line in every configured
Dockerfile, and exits non-zero on a mismatch with the changed families and the exact repair
command. Tests pin both directions: a recorded tree passes, a changed input without re-recording
fails, `--write` repairs it, a rename out of a family fails, and a non-ASCII path is hashed.
`--write` is also the documented repair, so the convention has no hand-edit step at all.

**The line is the whole convention.** An earlier version of this gate asked for a human-written
`# rebuild:` comment line per change, and 51 of them accumulated in the Dockerfile. The gate only
checked that *some* such line was added or removed — not that it described anything — so the
convention was both noise and bypassable: any unrelated prose edit cleared it. Replacing the
comment with a value removed the judgement call entirely. Note the gate hashes the working tree
via `git ls-files`, so it sees uncommitted changes too; a stale line fails before the commit
that would have fixed it. A separate test derives the Dockerfile `COPY` sources and fails when
one is not covered, and another compares the code list against the `AGENTS.md` and
`docs/deploy.md` bullets so prose cannot drift silently.
