# image-inputs: a5322573f3946dac26b02caf8cad1761
# mstar-inspector review sandbox image (review-runner containerization).
#
# IMAGE INPUTS: this Dockerfile COPYs packages/{runner,shared}/src, but the
# image hash wrangler compares on `wrangler deploy` covers THIS file alone, so
# the `image-inputs:` line at the top records what those copied sources hash
# to. Change an input and `bun scripts/check-image-inputs.ts --write` updates
# it; CI fails a stale one.
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

# mstar-harness plugin, pinned ref bb5a2cc2a33158a9002203fbc9854c04d77e49a8 (tag v4.8.5, bumped 2026-11-23).
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
    && git -C /opt/mstar-harness fetch --depth 1 origin bb5a2cc2a33158a9002203fbc9854c04d77e49a8 \
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

# lockfile (omp SDK 18.22.2 = packages/runner/package.json). `--omit=optional` is NOT used:
# pi-natives ships its platform binary as an optional dep, so omitting optionals
# breaks the runner at load (T4 live smoke). The `rm -rf` below is a DEFENSIVE
# guard, not something this lock currently materialises: the 18.22.2 frozen lock
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
