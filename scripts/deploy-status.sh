#!/usr/bin/env bash
# deploy-status.sh — the ONE writer of a deploy run's status keys.
#
# Usage:
#   bash scripts/deploy-status.sh <deploy_outcome> <requested_sha> <deployed_sha> [serving_outcome]
#
# `serving_outcome` is the outcome of the step that creates the version actually
# serving traffic, when that is a DIFFERENT step from the first deploy
# (production: `steps.deploy` publishes the bindings, `steps.serving` re-deploys
# with the deployment-shape var last). `deployed_sha` is certified only when
# BOTH succeeded, so a failed serving deploy is never reported as deployed
# (PR #87 I-000071). Omitted = the first deploy is the serving one (staging).
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
serving="${4:-}"

# Two version-creating steps: the first deploy can succeed while the version
# that actually serves never lands (a secret write or the serving deploy
# fails). That SHA must not be reported as what this run shipped.
# The fourth argument is the caller declaring "a separate serving step exists",
# so an EMPTY outcome (the step never ran or was skipped) also refuses.
if [ "$outcome" = "success" ] && [ "$#" -ge 4 ] && [ "$serving" != "success" ]; then
  echo "deploy-status: the serving step did not succeed (outcome=${serving:-<empty>}) — refusing to certify $deployed as deployed" >&2
  outcome="serving-${serving:-empty}"
fi

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
