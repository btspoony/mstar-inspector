#!/bin/sh
#
# Build-time assertion: the installed CLI dependency tree is exactly the
# committed lockfile's resolved set.
#
# The frozen install already refuses a manifest/lock mismatch, but it says
# nothing about what ended up on disk: a layer whose node_modules came from
# somewhere else, a partially-copied tree, or a lock edited after resolution
# would all install "successfully" while shipping versions the lock never
# named. This closes the loop against the installed tree:
#   - every lock entry is installed at the recorded version;
#   - no installed package — at ANY depth, including a package nested inside
#     another package's own node_modules — is absent from the lock;
#   - the lock is structurally complete (balanced braces, closing `}` as the
#     last non-empty line) and parses to at least as many rows as there are
#     installed top-level packages; either failure is a PARSE error, never a
#     pass and never a per-package drift message.
#
# Both sides are compared in the lockfile's own key form: a lock key is the
# install path with every `node_modules/` segment removed (`a/b` = b nested
# under a, scoped names keep their slash), which is why the installed path is
# collapsed rather than the key expanded — that direction is unambiguous at
# any nesting depth.
#
# Usage: verify-cli-lock.sh [install-root]
#   install-root  the global install dir holding bun.lock + node_modules;
#                 defaults to /root/.bun/install/global (where the build
#                 COPYs the committed manifest + lock).
#
# Offline, no node: POSIX shell plus sed/grep/head/wc/mktemp from the Debian base.
set -eu

root="${1:-/root/.bun/install/global}"
lock="$root/bun.lock"
modules="$root/node_modules"

if [ ! -f "$lock" ]; then
  echo "FAIL cli-lock-lockfile: no lockfile at $lock" >&2
  exit 1
fi
if [ ! -d "$modules" ]; then
  echo "FAIL cli-lock-nodemodules: no installed tree at $modules" >&2
  exit 1
fi

# F2 — the lock must be structurally complete before any row is trusted: a
# file truncated after its last package row still parses to the full row set
# and would pass every content comparison, so validate the object's shape.
opened="$(grep -o '{' "$lock" | wc -l | tr -d ' ' || true)"
closed="$(grep -o '}' "$lock" | wc -l | tr -d ' ' || true)"
lastline="$(grep -v '^[[:space:]]*$' "$lock" | tail -n 1 | sed 's/[[:space:]]*$//')"
if [ "$opened" != "$closed" ] || [ "$lastline" != "}" ]; then
  echo "FAIL cli-lock-parse: $lock is not a balanced object ($opened '{' vs" \
    "$closed '}', last non-empty line '${lastline}') — truncated or corrupt lock" >&2
  echo "CLI_LOCK_VERIFY=fail (parse)" >&2
  exit 1
fi

rows="$(mktemp)"      # "<lock key> <resolved spec>" per lock packages row
lockver="$(mktemp)"   # "<lock key> <version>"
installed="$(mktemp)" # "<path relative to node_modules>" per installed package
seen="$(mktemp)"      # lock keys the installed tree accounted for
trap 'rm -f "$rows" "$lockver" "$installed" "$seen"' EXIT

# Install path → lock key: drop every `node_modules/` separator segment.
collapse() {
  out=""
  rest="$1"
  while :; do
    case "$rest" in
      *"/node_modules/"*)
        out="$out${rest%%/node_modules/*}/"
        rest="${rest#*/node_modules/}"
        ;;
      *) break ;;
    esac
  done
  printf '%s' "$out$rest"
}

# --- the installed tree, walked recursively ------------------------------
# A package is a directory holding package.json; its own nested node_modules is
# walked too (bun resolves conflicting transitives that way), scoped names sit
# one level under @scope, and dot entries (.bin, caches) are not packages.
walk() {
  for entry in "$1"/*; do
    [ -d "$entry" ] || continue
    base="${entry##*/}"
    case "$base" in .*) continue ;; esac
    if [ -f "$entry/package.json" ]; then
      printf '%s\n' "${entry#"$modules"/}" >> "$installed"
      if [ -d "$entry/node_modules" ]; then walk "$entry/node_modules"; fi
    else
      case "$base" in
        @*)
          for sub in "$entry"/*; do
            [ -d "$sub" ] || continue
            [ -f "$sub/package.json" ] || continue
            printf '%s\n' "${sub#"$modules"/}" >> "$installed"
            if [ -d "$sub/node_modules" ]; then walk "$sub/node_modules"; fi
          done
          ;;
      esac
    fi
  done
}
walk "$modules"

installed_total="$(wc -l < "$installed" | tr -d ' ')"
# Top-level = not reached through another package's node_modules.
nested_installed="$(grep -c '/node_modules/' "$installed" || true)"
top_installed=$((installed_total - nested_installed))

# --- the lock's resolved set ---------------------------------------------
# Packages rows carry the resolved name@version in their first array element:
#   "name": ["name@version", "", { ... }, "sha512-…"],
# The workspaces block (a plain string value, no array) never matches, and a
# row whose spec lost its version is not parseable as resolved.
sed -n 's/^    "\([^"]*\)": \["\([^"]*\)".*/\1 \2/p' "$lock" > "$rows"
lock_rows="$(wc -l < "$rows" | tr -d ' ')"
while IFS=' ' read -r key spec; do
  [ -n "${key:-}" ] || continue
  printf '%s %s\n' "$key" "${spec##*@}" >> "$lockver"
done < "$rows"

# F2 (size) — a lock whose shape is intact can still be short: deleting whole
# package rows keeps the braces balanced. A row count below the installed
# top-level packages is a PARSE failure too, never a clean tree.
# (An installed top-level package the lock never names trips the same guard —
# the size relation covers both, and both mean lock and tree disagree.)
if [ "$lock_rows" -lt "$top_installed" ]; then
  echo "FAIL cli-lock-parse: $lock yields $lock_rows resolved rows, fewer than" \
    "the $top_installed top-level packages installed in $modules; the lock does" \
    "not cover the installed tree (truncated/corrupt lock, or an unexpected" \
    "installed package)" >&2
  echo "CLI_LOCK_VERIFY=fail (parse)" >&2
  exit 1
fi

drift=0
while IFS= read -r relative; do
  [ -n "$relative" ] || continue
  key="$(collapse "$relative")"
  entry="$(grep -F -- "$key " "$lockver" | head -n 1 || true)"
  if [ -z "$entry" ]; then
    echo "FAIL cli-lock-unexpected: $relative is installed but absent from $lock" >&2
    drift=$((drift + 1))
    continue
  fi
  printf '%s\n' "$key" >> "$seen"
  locked="${entry#* }"
  resolved="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$modules/$relative/package.json" | head -n 1)"
  if [ "$resolved" != "$locked" ]; then
    echo "FAIL cli-lock-version: $relative lock=$locked installed=${resolved:-none}" >&2
    drift=$((drift + 1))
  fi
done < "$installed"

while IFS=' ' read -r key locked; do
  [ -n "${key:-}" ] || continue
  if ! grep -Fxq -- "$key" "$seen"; then
    echo "FAIL cli-lock-missing: $key ($locked in lock) is not installed" >&2
    drift=$((drift + 1))
  fi
done < "$lockver"

if [ "$drift" -ne 0 ]; then
  echo "CLI_LOCK_VERIFY=fail ($drift drift(s) across $lock_rows lock entries and" \
    "$installed_total installed packages)" >&2
  exit 1
fi

echo "CLI_LOCK_VERIFY=pass ($lock_rows lock entries match $modules; $installed_total installed packages)"
