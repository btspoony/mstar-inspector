# mstar-inspector review sandbox image (plan 06 Task 2, review-runner containerization).
#
# Version pinning (compass contracts E): base tag, Bun, gh, mstar-harness ref,
# and the omp SDK (via package.json/bun.lock) are all pinned to exact versions.
#
# NO SECRETS (HARD): this image is built with no build args, no env values, no
# credentials. Tokens/keys enter only via ReviewSandbox.exec env injection at
# runtime (compass contracts D). The omp models.yml references the ARK_API_KEY
# env var NAME — the key value itself is never in the image.
#
# T2 additions over T1:
#   - mstar-harness plugin preinstalled at a pinned ref (build-time clone);
#   - omp agent config (models.yml) for the ark-plan provider;
#   - runner + omp SDK deps installed via `bun install --frozen-lockfile`.
#
# Build context: repo root (wrangler containers `image_build_context: "."`), so
# the Dockerfile can COPY package.json/bun.lock and src/review from the repo.
# A repo-root .dockerignore keeps the context lean (node_modules excluded).

FROM docker.io/cloudflare/sandbox:0.12.8

# Bun 1.4.0 pinned (base image ships Bun 1.3.12; omp requires >=1.3.14).
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

# mstar-harness plugin, pinned ref c188934c807184f416656a80ca50adb61ccbd525.
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
    && git -C /opt/mstar-harness fetch --depth 1 origin c188934c807184f416656a80ca50adb61ccbd525 \
    && git -C /opt/mstar-harness checkout FETCH_HEAD \
    && rm -rf /opt/mstar-harness/.git

# omp agent config: models.yml declares the ark-plan provider. The apiKey field
# is the ENV VAR NAME (ARK_API_KEY) — the SDK resolves the value from the
# process env at request time (config-value resolution: env first, literal
# fallback). No secret material lives here.
RUN mkdir -p /opt/omp-agent
COPY sandbox-image/omp-models.yml /opt/omp-agent/models.yml
ENV PI_CODING_AGENT_DIR=/opt/omp-agent

# lockfile (omp SDK 18.0.4 = package.json). `--omit=optional` is NOT used:
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

# The runner resolves the harness root from this env (plan Clarify #5; the M0
# env name is unchanged). Model key (ARK_API_KEY) is injected per exec — never
# baked into the image.
ENV M0_HARNESS_PLUGIN_ROOT=/opt/mstar-harness
