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
# The failure diagnostic names the commit from `/opt/mstar-harness-ref`, which
# the clone layer writes from the checked-out HEAD, so no second copy of the
# sha exists to drift from the fetch line.
#
# Offline, no node: uses only the POSIX shell and grep from the Debian base.
set -eu

root="${HARNESS_PLUGIN_ROOT:-/opt/mstar-harness}"
reference="$root/skills/mstar-audit/references/pr-review.md"
ref="$(cat /opt/mstar-harness-ref 2>/dev/null || true)"
[ -n "$ref" ] || ref="unknown (no /opt/mstar-harness-ref)"

if [ ! -f "$reference" ]; then
  echo "FAIL seat-supervision: no review reference at $reference (harness ref $ref)" >&2
  exit 1
fi

if ! grep -q '^## Seat supervision' "$reference"; then
  echo "FAIL seat-supervision: $reference has no '## Seat supervision' section" \
    "at the pinned harness ref $ref" >&2
  exit 1
fi
echo "SEAT_SUPERVISION=pass ($reference, harness ref $ref)"
