# Image-declared capabilities need build-time assertions

**Status:** Active
**Scope:** sandbox image (`sandbox-image/`), its pins, and any Dockerfile comment that promises a runtime capability.
**Source:** sandbox-image build-assertion and harness-pin rework, 2026-10-24 (upstream `mstar-harness` v4.0.7, commit `db013c7`).

## Problem

Three separate defects had the same shape: the Dockerfile comment described a capability (an executable `mstar` shim, a seat-budget-aware engine, a reproducible CLI dependency set) while nothing in the build proved it. Two were real (the CLI layer resolved caret ranges live; the seat-supervision reference was never checked) and one was already true but unproven (the bun shebang rewrite). A comment cannot fail a build, so any of them could have regressed silently in either direction: the capability could be missing, or the comment could be stale.

## Pattern

For each capability the image claims, add a small assertion script plus one `RUN` line in the same build stage:

- the script reads the *installed* artifact, not the source tree (shebang line, `--version` output, reference file content, resolved dependency tree);
- it prints one machine-greppable line per check (`CLI_SHIM_SHEBANG=pass`, `SEAT_SUPERVISION=pass`, `CLI_LOCK_VERIFY=pass (6 lock entries …)`) and fails with a diagnostic naming the failed check and the pinned ref;
- the `COPY` sits *below* the expensive network layers so editing the script does not bust them;
- the negative path is recorded once (a log kept outside the tree) and shows a non-zero exit, because an assertion nobody has seen fail is an assertion nobody can trust.

## Pin discipline

- A harness pin is the **deref commit**, not the annotated tag object: `git rev-parse vX.Y.Z^{commit}`. For `v4.0.7` the annotated tag object was `37c0d5fc…` while the tree's commit was `db013c73…`; pinning the tag object produced a `skill_version` suffix that named a sha no checkout ever had.
- Keep a **single editable semver source** (a `HARNESS_VERSION` constant); the deref-commit `harnessRef` is a separate literal, not derived from it. Let the parity test bind each static copy to its own declaration: the Dockerfile fetch line to `harnessRef` (its tag comment to both halves), and the root and runner manifests, both lock rows and the derived `REVIEW_SKILL_VERSION` to `HARNESS_VERSION`. Static files cannot read a TS constant; the test is the link.

## Reproducible global installs

`bun add --global pkg@x.y.z` pins only the top level and resolves transitive caret ranges at build time. Commit a manifest plus its generated `bun.lock` and replay with `bun install --frozen-lockfile --production`; then assert the installed tree equals the lock in both directions. The assertion must fail closed on four distinct shapes: missing package, unexpected package (including one nested in another package's `node_modules`), version mismatch, and a structurally broken or short-parsed lock.
