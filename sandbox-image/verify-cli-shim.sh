#!/bin/sh
#
# Build-time assertion: the in-image `mstar` CLI shim is executable and pinned.
#
# The CLI dist ships `#!/usr/bin/env node` and the image ships no node, so the
# Dockerfile rewrites the installed shim to `#!/usr/bin/env bun`. This script
# proves that rewrite landed and that bun executes the shim at the pinned
# version — a shebang regression or a version drift fails the build instead of
# silently shipping a `mstar` that cannot run.
#
# Usage: verify-cli-shim.sh [expected-version]
#   expected-version  the pinned @mstar-harness/cli version; defaults to the
#                     pin in the committed global-install manifest
#                     (`cli-global/package.json` next to this script in the
#                     repo, else the COPYed copy the install consumed), so the
#                     assertion reads the very pin the build installed instead
#                     of restating it.
#
# Offline, no node: uses only the POSIX shell, head/sed from the Debian base.
set -eu

# The shim the install layer creates; PATH is consulted first so a caller can
# point the assertion at another install (build-time or a local stub).
shim="$(command -v mstar || true)"
[ -n "$shim" ] || shim=/root/.bun/bin/mstar

expected="${1:-}"
if [ -z "$expected" ]; then
  for manifest in \
    "$(dirname "$0")/cli-global/package.json" \
    /root/.bun/install/global/package.json; do
    [ -f "$manifest" ] || continue
    expected="$(sed -n 's/.*"@mstar-harness\/cli": *"\([0-9][0-9.]*\)".*/\1/p' "$manifest" | head -n 1)"
    if [ -n "$expected" ]; then break; fi
  done
fi
if [ -z "$expected" ]; then
  echo "FAIL expected-version: no version argument and no @mstar-harness/cli pin" \
    "found in a global-install manifest; pass the pinned version as \$1" >&2
  exit 1
fi

if [ ! -f "$shim" ]; then
  echo "FAIL shim-exists: no mstar shim at $shim" >&2
  exit 1
fi

shebang="$(head -n 1 "$shim")"
if [ "$shebang" != '#!/usr/bin/env bun' ]; then
  echo "FAIL shim-shebang: $shim starts with '$shebang', expected '#!/usr/bin/env bun'" >&2
  exit 1
fi
echo "CLI_SHIM_SHEBANG=pass ($shim)"

if ! actual="$("$shim" --version 2>&1)"; then
  echo "FAIL cli-version: '$shim --version' failed: $actual" >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo "FAIL cli-version: 'mstar --version' reported '$actual', expected '$expected'" >&2
  exit 1
fi
echo "CLI_SHIM_VERSION=pass ($actual)"

echo "CLI_SHIM_VERIFY=pass"
