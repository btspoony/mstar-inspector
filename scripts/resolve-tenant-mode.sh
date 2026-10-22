#!/usr/bin/env bash
# resolve-tenant-mode.sh — the ONE resolver of a deploy run's tenant mode and
# of whether that run is a strict REPLAY.
#
# Usage:
#   bash scripts/resolve-tenant-mode.sh <input_mode> <steady_mode>
#
#   input_mode   dispatch input (`${{ inputs.tenant_mode }}`). `steady` — the
#                declared default — and an empty value (every non-dispatch arm:
#                `push`, `release: published`) both mean "take the variable".
#   steady_mode  repository/environment variable (`vars.WORKSPACE_TENANT_MODE`)
#
# Precedence: an EXPLICIT dispatch input (`off` / `strict`), then the
# steady-state variable, then `off`. `steady` is the default precisely so that
# a dispatch nobody filled in — which is what the Release workflow sends
# (`gh workflow run deploy-prod.yml --ref <tag>`, no fields) — cannot demote a
# strict installation: a declared `off` default would win over the variable on
# every ordinary release (PR #87 I-000070).
#
# A run that took the variable and still landed on `off` cannot prove the
# installation was not already serving `strict` — such a run never reads the
# live Worker — so it emits a `::warning::` and records
# `tenant_mode_change=unproven->off` rather than demoting silently.
#
# `replay=required` ONLY for a dispatch that explicitly asks for `strict`: that
# run IS Deploy B and must name the SHA Deploy A shipped. A `steady` run that
# serves `strict` from the variable is a routine steady-state deploy with no
# Deploy A to bind — requiring an expected SHA there would abort every ordinary
# release/push, and inventing one would fabricate a replay binding (PR #87 L2).
#
# Outputs: `mode=<mode>` and `replay=<required|none>` → `$GITHUB_OUTPUT`,
# `tenant_mode_change=<...>` → `$GITHUB_STEP_SUMMARY`, and a human line on
# stdout. An illegal value exits 1, so a typo reds the run before any
# deploy-capable step.
set -euo pipefail

input="${1:-}"
steady="${2:-}"

explicit=false
case "$input" in
  off|strict) mode="$input"; explicit=true ;;
  steady|"") mode="${steady:-off}" ;;
  *)
    echo "::error::invalid tenant mode '$input' — expected steady, off or strict (dispatch input tenant_mode)"
    exit 1
    ;;
esac
case "$mode" in
  off|strict) ;;
  *)
    echo "::error::invalid tenant mode '$mode' — expected off or strict (vars.WORKSPACE_TENANT_MODE)"
    exit 1
    ;;
esac

replay="none"
if [ "$input" = "strict" ]; then
  replay="required"
fi

echo "tenant_mode=$mode replay=$replay (input='${input}' steady-state='${steady}')"

change="none"
if [ "$explicit" = "false" ] && [ "$mode" = "off" ]; then
  change="unproven->off"
  echo "::warning::this run resolves tenant mode 'off' from WORKSPACE_TENANT_MODE (or its default) while the previously live mode was not observed — a 'strict' installation would be demoted. Set the repository/environment variable WORKSPACE_TENANT_MODE=strict for a strict installation."
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'mode=%s\nreplay=%s\n' "$mode" "$replay" >> "$GITHUB_OUTPUT"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf 'tenant_mode_change=%s\n' "$change" >> "$GITHUB_STEP_SUMMARY"
fi
