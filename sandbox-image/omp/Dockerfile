# mstar-inspector review sandbox image (review-runner containerization).
#
# Version pinning (compass contracts E): base digest, Bun, gh, mstar-harness ref,
# the mstar-harness CLI, and the omp SDK (via package.json/bun.lock) are all
# pinned to exact versions.
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
# the Dockerfile can COPY package.json/bun.lock and src/review from the repo.
# A repo-root .dockerignore keeps the context lean (node_modules excluded).

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
# POSIX shell are Essential in the Debian base): curl + ca-certificates for
# the Bun/gh downloads, unzip for the Bun zip, git for the harness clone and
# the PR-head fetch at review time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git unzip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# Bun 1.4.0 pinned (base ships no Bun; omp requires >=1.3.14).
RUN curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64.zip -o /tmp/bun.zip \
    && unzip -o /tmp/bun.zip -d /tmp/bun \
    && mv /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && chmod +x /usr/local/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip

# gh CLI 2.98.0 pinned (not present in the base image — ASSUMPTION confirmed).
RUN curl -fsSL https://github.com/cli/cli/releases/download/v2.98.0/gh_2.98.0_linux_amd64.tar.gz -o /tmp/gh.tar.gz \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && mv /tmp/gh_2.98.0_linux_amd64/bin/gh /usr/local/bin/gh \
    && chmod +x /usr/local/bin/gh \
    && rm -rf /tmp/gh_2.98.0_linux_amd64 /tmp/gh.tar.gz

# mstar-harness plugin, pinned ref 3ed42ba7563f9daed890b61408a425ef4547f751 (tag v4.0.2, bumped 2026-10-18).
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
    && git -C /opt/mstar-harness fetch --depth 1 origin 3ed42ba7563f9daed890b61408a425ef4547f751 \
    && git -C /opt/mstar-harness checkout FETCH_HEAD \
    && rm -rf /opt/mstar-harness/.git

# mstar-harness CLI preinstall: CONTAINER-level availability
# per user instruction (2026-09-06) — NOT a review-session mechanism. Review
# sessions are restricted to read-only read/grep/glob
# (src/review/runtime-omp.ts REVIEW_TOOL_NAMES), so review-session toolcalls
# canNOT invoke the `mstar` CLI today; absent a wired invocation path, review
# behavior is unchanged (legacy, non-CLI). Wiring a sanctioned session
# toolcall path is a tracked follow-up — no such mechanism
# exists in this image. Exact pin `@mstar-harness/cli@4.0.2`: image pinning
# discipline — the repo manifest `^4.0.2` exception does NOT extend to the
# image. The CLI dist ships `#!/usr/bin/env bun` (verified) and the Bun 1.4.0
# installed above executes it directly, so no node is added. The global bin
# dir is put on PATH so sandbox exec resolves the `mstar` shim.
RUN bun add --global @mstar-harness/cli@4.0.2
ENV PATH="/root/.bun/bin:${PATH}"

# omp agent dir: PI_CODING_AGENT_DIR points at an EMPTY directory (no baked
# models.yml is an App-configuration artifact). The in-image runner
# (src/review/runner.ts) synthesizes the COMPLETE per-review models.yml under
# /tmp/omp-agent-<uuid>/ (capability hosts from the App's selected registry
# entry, src/contracts/sandbox-images.ts, + App custom providers), rides that
# directory as the session agentDir, and loads the transported credential
# payload (the runner's STDIN, src/review/credential-payload.ts) into the run's
# IN-MEMORY credential store as stored `login` api_key rows before the session
# starts. That directory holds only the non-secret models.yml and is removed
# after the run (defence in depth). The synthesized provider blocks pin NO
# apiKey (a tier-2 config override would suppress that pool) and authenticate
# via `auth: oauth`.
# No secret material and no App model config lives here.
RUN mkdir -p /opt/omp-agent
ENV PI_CODING_AGENT_DIR=/opt/omp-agent

# lockfile (omp SDK 18.11.1 = package.json). `--omit=optional` is NOT used:
# pi-natives ships its platform binary as an optional dep, so omitting optionals
# breaks the runner at load (T4 live smoke). Size control instead prunes the
# transformers tree (local-embedding models only — the runner uses the remote
# ark provider; SDK guards the optional-dep imports, verified live in-image).
WORKDIR /opt/runner
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
    && rm -rf node_modules/@huggingface node_modules/onnxruntime-node \
          node_modules/onnxruntime-web node_modules/sharp node_modules/@img \
    && rm -rf /root/.bun/install/cache
COPY src/review /opt/runner/src/review
# Zero-runtime-dependency wire contract (PM amendment
# 2026-09-13; narrowed in QC wave B): the recheck seat runtime-imports the §7.3
# wire module and NOTHING else, so exactly that ONE file is copied — not the
# directory. src/pipeline, src/store and every other workerd face stay out, and
# a future file under src/contracts cannot join the image graph silently
# (tests/review/runtime-boundary.test.ts derives the admitted set from these
# COPY lines and re-asserts dependency freedom per admitted file).
COPY src/contracts/recheck.ts /opt/runner/src/contracts/recheck.ts
# Same admission rule, same reason: the `!`-prefixed-key refusal is ONE
# predicate shared by the runner's payload decoder and the dashboard's key
# routes, so the zero-dependency contract file that holds it rides the image.
COPY src/contracts/credential-key.ts /opt/runner/src/contracts/credential-key.ts

# The runner resolves the harness root from this env (plan Clarify #5). Provider
# keys arrive as the runner's STDIN payload — never baked in, never in the env.
ENV HARNESS_PLUGIN_ROOT=/opt/mstar-harness
# U-001 in-image models.yml synthesis verification (AL-25-3):
# the script ships inside the image so the evidence replays on the exact
# digest being verified. Not a build gate — run manually in a container:
#   docker run --rm --entrypoint /opt/verify-synthesis.sh <image>
COPY sandbox-image/verify-synthesis.sh /opt/verify-synthesis.sh
RUN chmod +x /opt/verify-synthesis.sh

# 1.0 container model: the DO-managed container's MAIN process is the image
# default command — it must be long-lived (main exit stops the instance and
# every exec'd process with it).
CMD ["sleep", "infinity"]
