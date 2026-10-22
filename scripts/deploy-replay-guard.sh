#!/usr/bin/env bash
# deploy-replay-guard.sh — a strict REPLAY must bind the SHA Deploy A shipped.
#
# Usage:
#   bash scripts/deploy-replay-guard.sh <replay> <expected_deploy_sha> <github_sha> <resolved_ref_sha>
#
# `replay` is the resolver's `replay` output (`scripts/resolve-tenant-mode.sh`):
#   required  a dispatch explicitly asked for `strict` — this run IS Deploy B
#   none      anything else, including a ROUTINE arm serving `strict` from the
#             steady-state variable. Such a run has no Deploy A to bind, so
#             requiring an expected SHA here would abort every ordinary
#             release/push; fabricating one would invent a binding that was
#             never proven.
#
# Contract: exit 0 when `replay` is not `required`, OR when all three SHAs
# (expected_deploy_sha, github_sha, resolved_ref_sha) are non-empty and equal.
# Any other case prints the reason to stderr and exits 1 — a strict replay that
# cannot prove "same tree as Deploy A" must never deploy.
#
# `resolved_ref_sha` is supplied by the caller: the checked-out HEAD on staging,
# `git rev-parse refs/tags/<tag>^{commit}` on production. Comparing it with
# github.sha is what catches a tag/branch that MOVED between the two runs (both
# runs would otherwise read the new ref and agree with themselves).
set -euo pipefail

replay="${1:-}"
expected="${2:-}"
github_sha="${3:-}"
ref_sha="${4:-}"

# Splitting the two facts: the REF IDENTITY assertion applies to every run
# (a moved tag/branch must never deploy), while the Deploy-A binding applies
# only to a replay. `ref_sha` is empty only for a caller that supplies no ref
# identity at all, which no workflow does.
if [ -n "$ref_sha" ] && [ -n "$github_sha" ] && [ "$ref_sha" != "$github_sha" ]; then
  echo "deploy-replay-guard: the ref resolves to $ref_sha but this run executes $github_sha — the ref moved; cut a new release instead" >&2
  exit 1
fi

# Not a strict replay: identity was the whole contract.
if [ "$replay" != "required" ]; then
  exit 0
fi

for pair in "expected_deploy_sha:$expected" "github_sha:$github_sha" "resolved_ref_sha:$ref_sha"; do
  if [ -z "${pair#*:}" ]; then
    echo "deploy-replay-guard: strict replay requires the SHA deployed by Deploy A (expected_deploy_sha), this run's SHA and the ref's SHA — ${pair%%:*} is empty (Deploy A's run summary carries deployed_sha=<sha>)" >&2
    exit 1
  fi
done

if [ "$expected" != "$github_sha" ]; then
  echo "deploy-replay-guard: expected_deploy_sha $expected != this run's SHA $github_sha — dispatch Deploy B on the exact SHA Deploy A shipped" >&2
  exit 1
fi

echo "deploy-replay-guard: strict replay bound to $github_sha"
exit 0
