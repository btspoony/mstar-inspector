#!/usr/bin/env bash
# resolve-tenant-mode.sh — the ONE resolver of a deploy run's tenant mode and
# of whether that run is a strict REPLAY.
#
# Usage:
#   bash scripts/resolve-tenant-mode.sh <input_mode> <steady_mode> <routine>
#
#   input_mode   dispatch input (`${{ inputs.tenant_mode }}`) — empty on a routine arm
#   steady_mode  repository/environment variable (`vars.WORKSPACE_TENANT_MODE`)
#   routine      `true` on the `push` / `release` arms, `false` on a dispatch
#
# Precedence: an explicit dispatch input, then the steady-state variable, then
# `off`. A routine arm that lands on `off` cannot prove the installation was not
# already serving `strict` — such a run never reads the live Worker — so it
# emits a `::warning::` and records `tenant_mode_change=unproven->off` rather
# than demoting a strict installation silently (PR #87 I-000070).
#
# `replay=required` ONLY for a dispatch that explicitly asks for `strict`: that
# run IS Deploy B and must name the SHA Deploy A shipped. A routine arm can
# serve `strict` from the steady-state variable without any Deploy A to bind —
# requiring an expected SHA there would abort every ordinary release/push, and
# inventing one would fabricate a replay binding (PR #87 L2).
#
# Outputs: `mode=<mode>` and `replay=<required|none>` → `$GITHUB_OUTPUT`,
# `tenant_mode_change=<...>` → `$GITHUB_STEP_SUMMARY`, and a human line on
# stdout. An illegal value exits 1, so a typo reds the run before any
# deploy-capable step.
set -euo pipefail

input="${1:-}"
steady="${2:-}"
routine="${3:-}"

mode="${input:-${steady:-off}}"
case "$mode" in
  off|strict) ;;
  *)
    echo "::error::invalid tenant mode '$mode' — expected off or strict (dispatch input tenant_mode, else vars.WORKSPACE_TENANT_MODE)"
    exit 1
    ;;
esac

# A replay is an operator replaying a specific SHA, never a steady-state deploy:
# only the dispatch input can ask for one.
replay="none"
if [ "$routine" != "true" ] && [ "$input" = "strict" ]; then
  replay="required"
fi

echo "tenant_mode=$mode replay=$replay (input='${input}' steady-state='${steady}' routine='${routine}')"

change="none"
if [ "$routine" = "true" ] && [ "$mode" = "off" ]; then
  change="unproven->off"
  echo "::warning::this routine deploy resolves tenant mode 'off' while the previously live mode was not observed — a 'strict' installation would be demoted. Set the repository/environment variable WORKSPACE_TENANT_MODE=strict for a strict installation."
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'mode=%s\nreplay=%s\n' "$mode" "$replay" >> "$GITHUB_OUTPUT"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf 'tenant_mode_change=%s\n' "$change" >> "$GITHUB_STEP_SUMMARY"
fi
