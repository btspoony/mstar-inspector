# mstar-inspector review sandbox image (review-runner containerization).
#
# REBUILD TRIGGER (read before editing packages/runner): this Dockerfile
# COPYs packages/{runner,shared}/src, but the image hash wrangler compares on
# `wrangler deploy` covers THIS file, not the copied sources. A runner change
# that is not accompanied by a Dockerfile touch therefore deploys the Worker
# without rebuilding the image, and the container keeps running stale code.
# Touch this comment whenever the copied runner sources change.
#
# rebuild: the two GitHub release-asset fetches (Bun, gh CLI) moved off that CDN
# after it answered 504 to every retry from the build network — Bun now comes
# from the official Docker Hub image copied at a pinned digest (declared as
# `bunImageDigest`), gh installs from GitHub's own apt pool unpinned because that
# pool keeps only two releases. `unzip` is gone with the Bun zip, and the
# build-context inventory now names verify-seat-supervision.sh.
# rebuild: the runner's OMP SDK pin moves to 18.18.1; its package and lockfile are image inputs, so the image must rebuild.
# rebuild: the runner's anchored review deadline now IS the OUTER exec deadline
# the Worker derived: the input carries `outerDeadlineEpochMs` (that absolute
# worker-clock instant, not a duration) and `anchorRecheckDeadline` anchors to
# it verbatim, so a shortened round plans its seats and its synthesis inside the
# exec that would otherwise kill it. The exec's own timeout is recomputed from
# the same instant after the input write, so the write and the runner's parse
# time spend it instead of extending it. Both modules are image inputs
# (`packages/runner/src/recheck.ts`, `packages/shared/src/runtime.ts`); a stale
# image anchors the whole tier cap (or adds a duration onto its own late start),
# waits out the shortened exec, and publishes nothing while still paying the
# model round.
#
# rebuild: both recheck failure exits now share the existing attribution chain in
# `packages/runner/src/recheck.ts`: the `single.error` short-circuit no longer
# pre-empts the child's `abortReason`, stderr tail and exit code, and the catch
# unwraps the settled result the SDK's rejection carries instead of keeping only
# the rejection message. A stale image still returns the bare seat-failed text
# from those two exits, so a dead round loses that cause again (I-000431).
#
# rebuild: the recheck seat's budget is the anchored TIER's wall clock (quick
# 300s / default 600s / deep 900s, bounded by the outer guard's 60s publication
# tail) instead of a fixed 180s, and a failed round's status now names the
# child's `abortReason` and then its exit code. Both live in
# `packages/runner/src/recheck.ts`: a stale image still kills the seat at 180s
# while it is reading prior findings and still records a bare
# "(status unavailable)" with no attribution (I-000431).
#
# rebuild: the recheck seat fits its ask to the operator's byte budget and validates
# the yield against the catalog the seat actually received. Both behaviours live in
# `packages/runner/src/recheck.ts` (the fitting and the received-catalog validation,
# plus the skip/fit records), and the optional runner-input field that carries the
# budget is in `packages/shared/src/runtime.ts`; no manifest, lockfile or CLI pin
# moved. A stale image loses those two behaviours separately. First, no fitting: it
# sends the whole up-to-512 KiB `mstar.recheck-input/v1` document in one assignment,
# the observed shape of the lost rounds (`failed`/`seat-failed`, status `unavailable`;
# the RCA could not separate context pressure from the seat's own time cap). Second,
# no received-catalog validation: it accepts a citation of a slice the seat never
# received, publishing that row `addressed`. The Worker cannot repair either from
# outside (I-000396).
#
# rebuild: the runner's pinned engine moves to 4.2.0 (`packages/runner/package.json`
# and its lockfile are image inputs, so the container must be rebuilt with them).
# rebuild: the image's CLI pin and harness clone ref move to 4.2.0
# (`sandbox-image/cli-global/**` and the pinned ref are image inputs too).
# rebuild: the runner engine pin and the image's CLI pin + harness clone ref move
# to 4.2.2 (`packages/runner/**`, `sandbox-image/cli-global/**` and the pinned
# ref are image inputs; 4.2.2 supersedes the 4.2.0 pin above).
# rebuild: the runner's engine pin, the CLI pin and the harness clone ref move
# to 4.2.3, and the runner's omp SDK pin moves to 18.17.0, together with the
# root manifest and both lockfiles (`packages/runner/**`,
# `sandbox-image/cli-global/**` and the pinned ref are image inputs; a stale
# image would run the previous engine and SDK against this Worker).
# rebuild: the report document is now bound to the reviewed head — the runner
# writes `headSha` from the envelope's `target.head_sha` and the Worker refuses
# a document bound to another head, so a file left at the fixed path by an
# earlier run can never publish its narrative under this review. A stale image
# writes an unbound document that the Worker renders as `none`. The report seat
# also degrades to no report when its definition is missing or the envelope
# carries no head, instead of failing a review that already settled.
# rebuild: the runner stopped requiring a seat summary — the review body is the
# engine's own layout now instead of a consumer rebuild of it, so the two halves
# of that change (the 4.1.6 harness pin and the no-longer-required output field)
# must ship together.
# rebuild: the runner hands the SDK a callable extension-roots accessor — the
# pinned SDK reads a getter and calls it as a method, which killed every seat
# before its first model turn.
# rebuild: the shim COPY is digest-pinned, so a rebuild no longer depends on what
# the mutable 1.0.0 tag resolves to at build time.
# rebuild: the runner marks its `incomplete`-cause composition as engine-owned
# staging (the engine should derive the fact from seat results, not accept a
# consumer's string), so the removal is scheduled rather than discovered.
# rebuild: a rejected seat promise's own reason now rides the declared
# `incomplete` cause; without it the only diagnosis of a dead seat is lost with
# the promise.
# rebuild: the declared `incomplete` reason now carries the lost seat's own
# failure message, so a wave that produced nothing names its cause in the
# durable review row instead of restating the symptom.
# rebuild: runner stdin bound + sandbox instance probe
# rebuild: the image-rebuild gate compares the wrangler.jsonc container blocks
# by VALUE (each container's name and its images entry) rather than treating the
# whole file as an input family — a config-only change to that block still needs
# this marker, as this one did.
# rebuild: credential stdin ends at a complete payload rather than at EOF, and
# the review setup stages trace themselves. Both are runner-source changes that
# landed without touching this file, so the deployed image kept the unbounded
# `Bun.stdin.text()` read: the worker sends a complete document and no longer
# relies on the write side closing, so that read never returned, the run emitted
# nothing on either stream, and the outer exec bound killed it at exit 124.
# rebuild: the recheck seat now writes a status document beside its findings
# document, and a single failed row is dropped in place instead of failing the
# whole round. A stale runner writes no status at all, so the worker reads
# `absent` and the round loses its seat-supplied reason — it lands in
# `review_failures` only when its document is also missing or invalid (or the
# seat reported `failed`), never merely because the status is absent.
# rebuild: the runner's status redaction now uses the shared credential-pattern
# list (`packages/shared/src/secret-shapes.ts`) instead of a narrow local
# subset, and a recheck document-write failure now exits 1 with no stdout (the
# Worker's runner-failure path) instead of writing any status: the status is
# written only once the document has landed. A stale image instead reports the
# seat's optimistic `ok` for a round whose document never reached the Worker.
# rebuild: evidence slices now carry `addedNewLines`, so a `current-code` proof
# must cite a line the hunk added, and the status `reason` is a closed
# vocabulary with `rejected_unnamed` counting the drops no row id could name.
# rebuild: incremental rounds and the narrative report seat. The runner gains
# `--report-out` (a second side document, `mstar.report/v1`, written beside the
# recheck document) and the report seat itself; the Worker's compare gate and
# its `since <base>` reconFact assume a runner that understands a delta
# universe. A stale image does NOT degrade to `none`: its runner rejects the
# unknown `--report-out` flag with a usage error, exits 2 with no stdout, and
# the round fails as a runner failure — so the image must be rebuilt before the
# Worker sends that flag.
# rebuild: the report validator now rejects a document that is over the read's
# BYTE bound (character budgets alone cannot bound UTF-8 bytes) with an explicit
# reason, and the report seat honours a caller signal aborted before the call
# instead of running to its own timeout. A stale image accepts the over-byte
# document, writes it, and loses it to the Worker's overflow read.
# rebuild: the report seat now receives the run's teardown signal (joined with a
# caller abort), so a torn-down run stops an in-flight seat, and the shared
# report gate no longer echoes the seat's own keys/values in its rejection
# reason. A stale image runs the seat to its full timer after teardown and logs
# seat-authored text into the structured report diagnostics.
# rebuild: the report file's byte bound is now DERIVED from the per-field
# character budgets (6 bytes × 16,500 chars + 256 bytes of envelope), so a
# maximal document the budgets allow can no longer be rejected by the byte gate.
# A stale image still enforces the retired 64 KiB bound: its runner rejects the
# document and writes nothing, so the Worker renders `none` for a report the
# current shared gate accepts.
# rebuild: the shared seat definition is installed for EVERY dispatch that needs
# it — the recheck seat and the report seat, which runs on the PR context alone.
# A deep report round without a recheck used to install nothing yet dispatch the
# seat anyway, so the SDK resolved no agent and the seat failed anonymously; the
# runtime now refuses to dispatch a report seat whose definition is missing.
# rebuild: `packages/shared/src/recheck-wire.ts` now carries a type-only engine
# type import (`MergeClass`) plus the note saying how that type resolves from
# the root install. Nothing in it changes at runtime — the import is erased —
# but the container copies `packages/shared/src/**`, so this marker must move
# with the module.
# rebuild: the discussion wire shape splits the issue coverage into FETCH
# (`issueCoverage`) and model-view (`issueModelCoverage`) — the Worker no
# longer relabels a complete fetch as truncated when the model caps drop old
# issue items — and adds `ownAuthor` (authenticated `viewerDidAuthor`
# provenance) to each captured item. The container copies
# `packages/shared/src/**`, so a stale image would run a runner built against
# the previous shape.
# rebuild: the runner's omp SDK pin moves to 18.17.0 along with the root
# manifest, so both lockfiles resolve the same SDK (`packages/runner/
# package.json` and its lockfile are image inputs).
# rebuild: a comment-only edit — the CLI pin note no longer cites the deleted
# pin suite. No build input changes; the marker exists because wrangler hashes
# this file, so any textual change still rebuilds the image.
# rebuild: the runner's engine pin and the harness clone ref move to 4.4.0
# (`packages/runner/package.json` and its lockfile are image inputs, and the
# pinned ref is the tree the skills are cloned from; a stale image would run
# the previous engine against this Worker).
# rebuild: the runner's engine pin, the CLI global-install pin and the harness
# clone ref move to 4.4.1 (`packages/runner/package.json`, its lockfile and
# `sandbox-image/cli-global/package.json` are image inputs, and the pinned ref
# is the tree the skills are cloned from; a stale image would run the previous
# engine and skills against this Worker).
# rebuild: custom providers now carry per-model metadata (`models_meta`) from
# the declaration through the runner input, and the runner's input guard
# validates it instead of ignoring it. Both copied trees changed
# (`packages/shared/src/runtime.ts`, `packages/runner/src/runner.ts`): a stale
# image accepts the new input but keeps an id-only entry in the synthesized
# models.yml, so the failover candidate is unjudgeable again.
# rebuild: the synthesized models.yml now writes a custom provider's declared
# per-model facts (name / reasoning / input / contextWindow / maxTokens) in the
# capability-host key order, and only the facts the owner stated. A stale image
# still emits `- id:` alone, so omp's registry falls back to ITS defaults and
# the model is judged against numbers nobody declared.
# rebuild: the runner ships a one-shot seat-failover probe
# (`packages/runner/src/seat-failover-probe.ts`). It is a diagnostic, not a
# runtime path: it builds the round's own inputs and names which gate drops a
# chain candidate. No in-image code imports it, but it IS copied into the image
# with the runner tree — a stale image would not carry the probe whose verdict
# is the input to the next change.
# rebuild: a failed round now prints its per-selector chain attribution after
# the provider's own error (`runner.ts` calls the probe's gate walker over the
# run's synthesized models.yml and loaded pool). A stale image keeps ending the
# round with only the first provider's message, so the dropped candidate and
# its gate stay invisible in `review_failures`.
# rebuild: a successful round now records WHICH provider served it. The runner
# observes the session's model and writes `/workspace/review-applied-model.json`
# beside the recheck/report side documents (`packages/runner/src/runtime-omp.ts`,
# `runner.ts`); the Worker reads it into `reviews.provider`. A stale image writes
# no such document, so the column stays NULL — the round is attributed to nobody.
# rebuild: the runner now attributes a served seat to the SDK's OWN serving model
# (`AgentSession.servingModel`, captured the moment the seat settles) and deletes
# a leftover applied-model document when no model served. A stale image writes a
# stale or missing document, so the Worker records the wrong provider or none.
# rebuild: a failed round now emits ONE bounded failure block — the original
# cause first, then each configured selector's own eligibility (never a
# "served" claim it did not observe), folded with a counted marker to fit the
# Worker's 600-character stderr tail. A stale image keeps asserting the
# configured head as served and lets a long chain evict the cause.
# rebuild: the attribution's own exception path now shares that budget too — its
# diagnostic is one truncated entry under the same formatter. A stale image
# concatenates a multi-kilobyte stack trace after the cause and evicts it again.
# rebuild: the failover probe's unresolved-selector verdict now reports "context not evaluated"
# (null) instead of "does not fit". A stale image keeps telling an operator an unresolved
# (registry-gate) candidate failed the window gate.
# rebuild: the runner's engine pin, the CLI global-install pin and the harness
# clone ref move to 4.5.2 (`packages/runner/package.json`, its lockfile and
# `sandbox-image/cli-global/package.json` are image inputs, and the pinned ref
# is the tree the skills are cloned from; a stale image would run the previous
# engine and skills against this Worker).
#
# Version pinning (compass contracts E): base digest, Bun (image tag + digest),
# mstar-harness ref, the mstar-harness CLI, and the omp SDK (via
# packages/runner/package.json and its committed bun.lock) are pinned to exact
# versions. `gh` is the documented exception — it installs from GitHub's apt pool
# unpinned, because that pool does not guarantee an old release stays reachable;
# its resolved version is recorded inside the image (see the version file the gh
# layer writes) rather than in the contract.
#
# NO SECRETS (HARD): this image is built with no build args, no env values, no
# credentials. Tokens/keys enter only at runtime — the sandbox-read token via
# exec env, the provider keys as the runner's STDIN credential payload (compass
# contracts D). The runner loads that payload into an IN-MEMORY credential
# store for the run — the per-review agent dir holds only the non-secret
# models.yml — no key value is ever in the image, its build
# context, or any exec process environment.
#
# Outbound egress (architect verdict AL-4 — DOCUMENTED, NOT
# enforced): the Sandbox SDK 1.0 container takes its egress posture from
# `container.start({ enableInternet: true })` (src/pipeline/sandbox.ts) — this
# repo relies on provider egress, so it is explicitly ON. The 1.0 DO Container
# API's finer control surface (`interceptOutboundHttp` /
# `interceptAllOutboundHttp`) is NOT activated: the host
# inventory has no SSOT in this repo (18 built-in provider API hosts resolve
# in omp's registry, outside the repo; the ark capability host is declared in
# src/contracts/sandbox-images.ts — the omp registry entry, synthesized at
# review time), per-App BYOK keeps the provider set open,
# and a missing host fails CLOSED (review failure → DLQ) — a worse
# failure mode than the documented de-facto boundary. See docs/deploy.md
# § Network egress for the de-facto allowlist and the activation prerequisite
# (provider-host SSOT + staging verification). No fake controls are installed
# here — documentation only.
#
# Runtime provisioning (generic omp runtime, NO App
# model configuration):
#   - mstar-harness plugin preinstalled at a pinned ref (build-time clone);
#   - an EMPTY omp agent dir (PI_CODING_AGENT_DIR) — no baked
#     in-image models.yml; the runner synthesizes the COMPLETE per-review
#     models.yml (capability hosts + App custom providers) at execution time;
#   - runner + omp SDK deps installed via `bun install --frozen-lockfile`.
#
# Build context: repo root (wrangler containers `images.sandbox.build_context`), so
# the Dockerfile COPYs the runner package (manifest + frozen lockfile), the two
# in-image package source trees, the runner's verify script, and this directory's
# CLI-shim assertion:
#   packages/runner/{package.json,bun.lock}
#   packages/{shared,runner}/src
#   packages/runner/verify-synthesis.sh
#   sandbox-image/{verify-cli-shim.sh,verify-cli-lock.sh,verify-seat-supervision.sh,cli-global/{package.json,bun.lock}}
# A repo-root .dockerignore keeps the context lean (node_modules and tests excluded).

# Sandbox SDK 1.0: the 0.12 `FROM docker.io/cloudflare/sandbox:<ver>` base is
# gone (1.0 ships no runtime base image — the 1.0 image is only a BLOCK source
# for the shim below). Base we control
# (Debian trixie — the distro the official 1.0 examples target; glibc for the
# pinned bun-linux-x64 / gh amd64 tarballs) + the `sandbox-shim` helper copied
# from the SAME 1.0.0 line as the `@cloudflare/sandbox` pin (package.json /
# bun.lock — the shim tag must match, `Files` needs it). The Debian base is
# pinned by DIGEST for linux/amd64 (the platform the pinned bun-linux-x64 /
# gh amd64 artifacts build for) — the rolling `trixie-slim` alias would let a
# rebuild silently change the base layer (libc and everything it carries)
# inside the production review executor; the apt-installed tools below still
# resolve from the rolling suite at build time. Digest taken 2026-10-13 (Debian build revision
# 2026-10-05); bump deliberately, never incidentally. Re-resolve with the
# read-only Docker Hub flow:
#   TOKEN=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/debian:pull" | jq -r .token)
#   curl -fsS -H "Authorization: Bearer $TOKEN" \
#     -H "Accept: application/vnd.oci.image.index.v1+json" \
#     https://registry-1.docker.io/v2/library/debian/manifests/trixie-slim
# (the response's docker-content-digest is the multi-arch index; read the
# linux/amd64 entry's .manifests[].digest from it for this pin).
FROM docker.io/library/debian:trixie-slim@sha256:918311b7b6c4c6f68b232ba516584925f6c78ad82b6fd534b98979df6438e483

# Tools the pinned steps below need (coreutils incl. `timeout`, tar and the
# POSIX shell are Essential in the Debian base): curl + ca-certificates for the
# build-time fetches, git for the harness clone and the PR-head fetch at review
# time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# The shim is digest-pinned for the same reason as the base: the tag alone is
# mutable, so a rebuild could silently swap the helper binary inside the review
# executor. The digest moves ONLY together with the `@cloudflare/sandbox`
# version (package.json / bun.lock) — a version bump re-resolves both the tag
# and the digest in one change, never one without the other.
COPY --from=docker.io/cloudflare/sandbox:1.0.0@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# Bun 1.4.0 pinned (base ships no Bun; omp requires >=1.3.14).
# Sourced from the official Docker Hub image, NOT from a GitHub release asset:
# on 2026-11-08 `github.com/oven-sh/bun/releases/download/...` answered 504 for
# every one of eight retries from inside this build network while github.com,
# codeload and git stayed healthy, so a retry cannot recover it — the fetch had
# to leave that CDN. Docker Hub is already a hard dependency of this file (the
# base image and the sandbox shim are copied from it), and the digest pins the
# same Bun 1.4.0 the tag names — it is declared as `bunImageDigest` /
# `bunVersion` in src/contracts/sandbox-images.ts.
COPY --from=docker.io/oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef /usr/local/bin/bun /usr/local/bin/bun
# The tag and the digest are two independent literals and nothing else compares
# them, so the build asserts the binary is the declared version instead of only
# printing it — a tag bump without a digest re-resolution fails here.
RUN chmod +x /usr/local/bin/bun && test "$(/usr/local/bin/bun --version)" = "1.4.0"

# gh CLI from GitHub's own apt pool — deliberately NOT version-pinned. A
# filename-pinned URL is not durable: on 2026-11-08 four probes of that pool
# resolved 2.98.0 and 2.103.3 but returned 404 for 2.90.0 and 2.80.0, so an old
# release is not guaranteed to stay reachable and a pinned filename would turn a
# future cold build into a 404. The release-asset CDN this layer used before
# answered 504 to every retry. The resolved version is written into the image,
# not only the log, so a running executor can be asked what it actually ships.
RUN curl --retry 8 --retry-delay 5 --retry-all-errors -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && { echo "bun $(/usr/local/bin/bun --version)"; gh --version | head -1; } > /etc/mstar-image-versions \
    && cat /etc/mstar-image-versions

# mstar-harness plugin, pinned ref 1a6a90c3fe097e618ec6ebd154b630857ad1f3be (tag v4.5.2, bumped 2026-11-12).
# Choice: build-time shallow clone (NOT a git submodule, NOT COPY):
#   - the harness is a separate PUBLIC repo — a submodule would couple this
#     repo's git metadata to it and require submodule state inside the build
#     context; COPY would drag the 1.0G local checkout (node_modules included);
#   - a shallow fetch of the exact pinned commit is ~10MB, needs no
#     credentials, and the image only needs the working tree
#     (skills/ + plugin.json + .omp-plugin) at runtime.
# .git is removed after checkout to keep the image lean.
RUN git init /opt/mstar-harness \
    && git -C /opt/mstar-harness remote add origin https://github.com/btspoony/mstar-harness.git \
    && git -C /opt/mstar-harness fetch --depth 1 origin 1a6a90c3fe097e618ec6ebd154b630857ad1f3be \
    && git -C /opt/mstar-harness checkout FETCH_HEAD \
    && git -C /opt/mstar-harness rev-parse HEAD > /opt/mstar-harness-ref \
    && rm -rf /opt/mstar-harness/.git
# The build proves the pinned tree serves the review flow it is pinned for:
# `verify-seat-supervision.sh` asserts the cloned pr-review reference carries
# `## Seat supervision`, naming the checked-out commit on failure.
# COPYed below the clone layer so editing the script never invalidates it.
COPY sandbox-image/verify-seat-supervision.sh /opt/verify-seat-supervision.sh
RUN sh /opt/verify-seat-supervision.sh

# mstar-harness CLI preinstall: CONTAINER-level availability
# per user instruction (2026-09-06) — NOT a review-session mechanism. Review
# sessions are restricted to read-only read/grep/glob
# (packages/runner/src/runtime-omp.ts REVIEW_TOOL_NAMES), so review-session toolcalls
# canNOT invoke the `mstar` CLI today; absent a wired invocation path, review
# behavior is unchanged (legacy, non-CLI). Wiring a sanctioned session
# toolcall path is a tracked follow-up — no such mechanism
# exists in this image. Exact CLI pin: image pinning
# discipline — the repo manifest `^` range exception does NOT extend to the
# image; the version lives only in the committed global-install manifest
# `sandbox-image/cli-global/package.json`, whose exact pin equals
# `HARNESS_VERSION` by hand. The CLI's OWN
# dependency tree is pinned by the committed `bun.lock` beside it: `bun add
# --global` re-resolved those caret ranges on every build (I-000009), while
# `bun install --frozen-lockfile` replays the recorded, integrity-hashed set
# and FAILS on any lock-external change instead of installing something new.
# There is no `bun install --global` in bun 1.4.0, so the replay targets the
# global install dir directly and the bins are linked onto PATH by hand.
#
# The CLI dist ships `#!/usr/bin/env node` (observed) and this image
# ships no node, so the build rewrites the installed shim to
# `#!/usr/bin/env bun` — the Bun 1.4.0 installed above executes it directly,
# no node is added. The global bin dir is put on PATH so sandbox exec
# resolves the `mstar` shim.
#
# The build PROVES both facts instead of expecting them: `verify-cli-shim.sh`
# (sandbox-image/verify-cli-shim.sh) reads the resolved shim's first line and
# runs it, failing the build on a shebang regression or a version drift. Its
# expected version is read from the manifest the install just consumed, so the
# assertion cannot drift from the pin.
COPY sandbox-image/cli-global/package.json sandbox-image/cli-global/bun.lock /root/.bun/install/global/
RUN cd /root/.bun/install/global \
    && bun install --frozen-lockfile --production \
    && mkdir -p /root/.bun/bin \
    && ln -sf ../install/global/node_modules/.bin/mstar /root/.bun/bin/mstar \
    && ln -sf ../install/global/node_modules/.bin/mstar-harness /root/.bun/bin/mstar-harness \
    && sed -i --follow-symlinks '1s|.*|#!/usr/bin/env bun|' /root/.bun/bin/mstar
# The installed tree must BE the locked set: a stale/partial layer or a lock
# edited after resolution would install "cleanly" while shipping versions the
# lock never named. COPYed below the install layer so editing the script never
# re-resolves anything; the check itself runs against the tree just installed.
COPY sandbox-image/verify-cli-lock.sh /opt/verify-cli-lock.sh
RUN sh /opt/verify-cli-lock.sh
ENV PATH="/root/.bun/bin:${PATH}"
# The assertion script is COPYed below the install/PATH layer so editing it
# never invalidates the network install layer; the check stays adjacent to it.
COPY sandbox-image/verify-cli-shim.sh /opt/verify-cli-shim.sh
RUN sh /opt/verify-cli-shim.sh

# omp agent dir: PI_CODING_AGENT_DIR points at an EMPTY directory (no baked
# models.yml is an App-configuration artifact). The in-image runner
# (packages/runner/src/runner.ts) synthesizes the COMPLETE per-review models.yml under
# /tmp/omp-agent-<uuid>/ (capability hosts from the App's selected registry
# entry, src/contracts/sandbox-images.ts, + App custom providers), rides that
# directory as the session agentDir, and loads the transported credential
# payload (the runner's STDIN, packages/shared/src/credential-payload.ts) into the run's
# IN-MEMORY credential store as stored `login` api_key rows before the session
# starts. That directory holds only the non-secret models.yml and is removed
# after the run (defence in depth). The synthesized provider blocks pin NO
# apiKey (a tier-2 config override would suppress that pool) and authenticate
# via `auth: oauth`.
# No secret material and no App model config lives here.
RUN mkdir -p /opt/omp-agent
ENV PI_CODING_AGENT_DIR=/opt/omp-agent

# lockfile (omp SDK 18.18.1 = packages/runner/package.json). `--omit=optional` is NOT used:
# pi-natives ships its platform binary as an optional dep, so omitting optionals
# breaks the runner at load (T4 live smoke). The `rm -rf` below is a DEFENSIVE
# guard, not something this lock currently materialises: the 18.18.1 frozen lock
# pulls none of those trees (@oh-my-pi/pi-mnemopi lists fastembed/onnxruntime as
# optional peers only). It stays so a future SDK resolving them non-optionally
# cannot silently bloat the image, and it would need revisiting then — the
# local-embedding models are unused here because the runner reaches the remote
# ark provider, and the SDK guards the optional-dep imports (verified live
# in-image).
WORKDIR /opt/runner
LABEL io.mstar.runner-package-version=0.1.0
COPY packages/runner/package.json packages/runner/bun.lock ./
RUN bun install --frozen-lockfile --production \
    && rm -rf node_modules/@huggingface node_modules/onnxruntime-node \
          node_modules/onnxruntime-web node_modules/sharp node_modules/@img \
    && rm -rf /root/.bun/install/cache
# The image mirrors the repository's `packages/` layout so a runner module's
# `../../shared/src/*` import resolves to the same file here as it does in
# the repo. src/pipeline, src/store and every other workerd face stay out, and
# every admitted shared file must stay dependency-free
# (tests/review/runtime-boundary.test.ts derives the admitted set from these
# COPY lines and re-asserts that per file).
COPY packages/shared/src /opt/runner/packages/shared/src
COPY packages/runner/src /opt/runner/packages/runner/src

# The runner resolves the harness root from this env (plan Clarify #5). Provider
# keys arrive as the runner's STDIN payload — never baked in, never in the env.
ENV HARNESS_PLUGIN_ROOT=/opt/mstar-harness
# U-001 in-image models.yml synthesis verification (AL-25-3):
# the script ships inside the image so the evidence replays on the exact
# digest being verified. Not a build gate — run manually in a container:
#   docker run --rm --entrypoint /opt/verify-synthesis.sh <image>
COPY packages/runner/verify-synthesis.sh /opt/verify-synthesis.sh
RUN chmod +x /opt/verify-synthesis.sh

# 1.0 container model: the DO-managed container's MAIN process is the image
# default command — it must be long-lived (main exit stops the instance and
# every exec'd process with it).
CMD ["sleep", "infinity"]
