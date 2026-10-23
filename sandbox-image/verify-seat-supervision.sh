#!/bin/sh
#
# Build-time assertion: the cloned harness carries the Seat supervision section
# in the pr-review reference the in-image review flow reads.
#
# The image pins the harness by commit (sandbox-image/Dockerfile fetch line), so
# the reference is whatever that commit contains. This script proves the pinned
# tree ships `## Seat supervision` in
# `skills/mstar-audit/references/pr-review.md` — a ref that predates the
# section fails the build instead of silently shipping a review flow without it.
#
# The failure diagnostic names the pin from `/opt/mstar-harness-ref`, which the
# clone layer writes from the checkout itself (ref = the pinned object, commit =
# the tree actually cloned; they differ when the pin is an annotated tag). No
# second copy of the sha exists to drift from the fetch line.
#
# Offline, no node: uses only the POSIX shell and grep from the Debian base.
set -eu

root="${HARNESS_PLUGIN_ROOT:-/opt/mstar-harness}"
reference="$root/skills/mstar-audit/references/pr-review.md"
pin="$(tr '\n' ' ' < /opt/mstar-harness-ref 2>/dev/null || true)"
pin="${pin:-ref=unknown commit=unknown (no /opt/mstar-harness-ref)}"

if [ ! -f "$reference" ]; then
  echo "FAIL seat-supervision: no review reference at $reference ($pin)" >&2
  exit 1
fi

if ! grep -q '^## Seat supervision' "$reference"; then
  echo "FAIL seat-supervision: $reference has no '## Seat supervision' section" \
    "at pinned harness $pin" >&2
  exit 1
fi
echo "SEAT_SUPERVISION=pass ($reference, $pin)"
