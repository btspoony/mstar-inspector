#!/usr/bin/env bash
# deploy-status.sh — the ONE writer of a deploy run's status keys.
#
# Usage:
#   bash scripts/deploy-status.sh <deploy_outcome> <requested_sha> <deployed_sha>
#
# Prints exactly one mutually exclusive block on stdout (the workflow appends it
# to $GITHUB_STEP_SUMMARY):
#
#   outcome=success  →  deploy_status=deployed      + deployed_sha=<sha>
#   anything else    →  deploy_status=not-deployed  + requested_sha=<sha>
#
# The two shapes never mix: a failed/skipped deploy must not claim a deployed
# SHA, and a successful one must not be labelled not-deployed. A `success`
# outcome without a SHA exits 2 rather than emitting an empty `deployed_sha=`.
set -euo pipefail

outcome="${1:-}"
requested="${2:-}"
deployed="${3:-}"

if [ "$outcome" = "success" ]; then
  if [ -z "$deployed" ]; then
    echo "deploy-status: outcome=success but no deployed SHA was supplied" >&2
    exit 2
  fi
  printf 'deploy_status=deployed\ndeployed_sha=%s\n' "$deployed"
  exit 0
fi

printf 'deploy_status=not-deployed\nrequested_sha=%s\n' "$requested"
exit 0
