#!/usr/bin/env bash
# Add a new git subtree under .agents/repos/ and register it.
#
# Usage:
#   scripts/add-subtree.sh <git-url> [ref] [prefix] [package=tag-template]
#
# <ref> is any branch, tag or commit. <package>=<tag-template> ties the subtree
# to an installed npm package so `update-subtree.sh --sync` can re-pin it, where
# {v} is replaced by the installed version.
#
# Examples:
#   scripts/add-subtree.sh https://github.com/foo/bar
#   scripts/add-subtree.sh https://github.com/foo/bar v1.2.3
#   scripts/add-subtree.sh https://github.com/payloadcms/payload.git v3.86.0 '' 'payload=v{v}'

set -euo pipefail

url="${1:-}"
ref="${2:-}"
prefix="${3:-}"
version_source="${4:-}"

if [[ -z "$url" ]]; then
  echo "usage: $(basename "$0") <git-url> [ref] [prefix] [package=tag-template]" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
source "$repo_root/scripts/subtree-lib.sh"

if [[ -z "$prefix" ]]; then
  name="$(basename "$url" .git)"
  prefix=".agents/repos/$name"
fi

if [[ -z "$ref" ]]; then
  ref="$(git ls-remote --symref "$url" HEAD 2>/dev/null \
    | sed -n 's|^ref: refs/heads/\([^[:space:]]*\).*|\1|p')"
  ref="${ref:-main}"
fi

if [[ -e "$prefix" ]]; then
  echo "error: $prefix already exists" >&2
  exit 1
fi

if ! git diff-index --quiet HEAD --; then
  echo "error: working tree has uncommitted changes; commit or stash first" >&2
  exit 1
fi

echo ">> adding subtree: prefix=$prefix url=$url ref=$ref"
git subtree add --prefix="$prefix" "$url" "$ref" --squash
subtree_strip_gitlinks "$prefix"

if [[ ! -f "$subtree_registry" ]]; then
  printf '# Registry of git subtrees under .agents/repos/.\n' > "$subtree_registry"
  printf '# Managed by scripts/add-subtree.sh and scripts/update-subtree.sh.\n' >> "$subtree_registry"
  printf '# Format: <prefix>\\t<url>\\t<ref>\\t<package>=<tag-template>\n' >> "$subtree_registry"
fi

if grep -q -P "^$(printf '%s' "$prefix" | sed 's|[].[\^$*/|]|\\&|g')\t" "$subtree_registry"; then
  echo ">> registry already has $prefix, skipping update"
else
  printf '%s\t%s\t%s\t%s\n' "$prefix" "$url" "$ref" "$version_source" >> "$subtree_registry"
  git add "$subtree_registry"
  git commit -m "chore: register $prefix subtree" --no-verify
fi

echo ">> done: $prefix @ $ref"
