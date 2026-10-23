#!/bin/sh
#
# Build-time assertion: the installed CLI dependency tree is exactly the
# committed lockfile's resolved set.
#
# The frozen install already refuses a manifest/lock mismatch, but it says
# nothing about what ended up on disk: a layer whose node_modules came from
# somewhere else, a partially-copied tree, or a lock edited after resolution
# would all install "successfully" while shipping versions the lock never
# named. This closes the loop against the installed tree — every lock entry
# must be present at the recorded version, and no installed package may be
# absent from the lock.
#
# Usage: verify-cli-lock.sh [install-root]
#   install-root  the global install dir holding bun.lock + node_modules;
#                 defaults to /root/.bun/install/global (where the build
#                 COPYs the committed manifest + lock).
#
# Offline, no node: POSIX shell plus sed/grep/head/mktemp from the Debian base.
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

rows="$(mktemp)"
top="$(mktemp)"
trap 'rm -f "$rows" "$top"' EXIT

# Packages rows carry the resolved name@version in their first array element:
#   "name": ["name@version", "", { ... }, "sha512-…"],
# The workspaces block (a plain string value, no array) never matches, and a
# row whose spec lost its version is not parseable as resolved.
sed -n 's/^    "\([^"]*\)": \["\([^"]*\)".*/\1 \2/p' "$lock" > "$rows"
if [ ! -s "$rows" ]; then
  # An unparsed lock must not read as "nothing to check".
  echo "FAIL cli-lock-parse: no resolved packages rows found in $lock" >&2
  exit 1
fi

checked=0
drift=0
while IFS=' ' read -r key spec; do
  [ -n "${key:-}" ] || continue
  version="${spec##*@}"
  # The lock key is a bare name for top-level rows and `<parent key>/<dep>`
  # for bun's nested-disambiguation rows; derive the on-disk package path.
  rest="${key%/*}"
  package="${key##*/}"
  parent=""
  if [ "$rest" != "$key" ]; then
    previous="${rest##*/}"
    if [ "${previous#@}" != "$previous" ]; then
      # Scoped name: the dep is `<@scope>/<name>`, everything before it is
      # the parent's install path.
      if [ "$rest" = "$previous" ]; then
        parent=""
      else
        parent="${rest%"/$previous"}"
      fi
      package="$previous/$package"
    else
      parent="$rest"
    fi
  fi
  if [ -n "$parent" ]; then
    path="$modules/$parent/node_modules/$package"
  else
    path="$modules/$package"
    printf '%s\n' "$package" >> "$top"
  fi
  checked=$((checked + 1))
  if [ ! -f "$path/package.json" ]; then
    echo "FAIL cli-lock-missing: $package ($version in lock) is not installed at" \
      "${path#"$modules"/}" >&2
    drift=$((drift + 1))
    continue
  fi
  installed="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$path/package.json" | head -n 1)"
  if [ "$installed" != "$version" ]; then
    echo "FAIL cli-lock-version: $package lock=$version installed=${installed:-none}" >&2
    drift=$((drift + 1))
  fi
done < "$rows"

# The other direction: an installed top-level package the lock does not name
# means the tree is not the locked set (stale layer, hand-copied node_modules).
for entry in "$modules"/*; do
  [ -e "$entry" ] || continue
  base="${entry##*/}"
  if [ "${base#@}" != "$base" ]; then
    for sub in "$entry"/*; do
      [ -e "$sub" ] || continue
      if ! grep -Fxq "$base/${sub##*/}" "$top"; then
        echo "FAIL cli-lock-unexpected: $base/${sub##*/} is installed but absent" \
          "from $lock" >&2
        drift=$((drift + 1))
      fi
    done
  elif [ -d "$entry" ]; then
    if ! grep -Fxq "$base" "$top"; then
      echo "FAIL cli-lock-unexpected: $base is installed but absent from $lock" >&2
      drift=$((drift + 1))
    fi
  fi
done

if [ "$drift" -ne 0 ]; then
  echo "CLI_LOCK_VERIFY=fail ($drift drift(s) across $checked lock entries)" >&2
  exit 1
fi

echo "CLI_LOCK_VERIFY=pass ($checked lock entries match $modules)"
