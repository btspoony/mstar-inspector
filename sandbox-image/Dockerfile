# mstar-inspector review sandbox image (plan 06 Task 1, STOP gate).
#
# Version pinning (compass contracts E): base tag, Bun, and gh are pinned to
# exact versions. git is pinned implicitly by the base image tag
# (cloudflare/sandbox:0.12.8 = Ubuntu 22.04.5 LTS, git 2.34.1).
#
# NO SECRETS (HARD): this image is built with no build args, no env files,
# and no credentials. Tokens/keys enter only via ReviewSandbox.exec env
# injection at runtime (compass contracts D).
#
# T2 (review-runner containerization) will:
#   - COPY the mstar-harness plugin (pinned ref) into /opt/mstar-harness
#   - COPY the runner + omp deps and `bun install --frozen-lockfile`
# T1 reserves the directory structure only.

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

# Reserved preinstall root for mstar-harness (T2 copies the pinned ref here).
RUN mkdir -p /opt/mstar-harness
