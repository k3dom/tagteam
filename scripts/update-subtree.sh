#!/usr/bin/env bash
# Update registered subtrees under .agents/repos/.
#
# Usage:
#   scripts/update-subtree.sh                  # interactive (fzf multi-select), pull registered ref
#   scripts/update-subtree.sh --all            # same for every registered subtree
#   scripts/update-subtree.sh --sync           # re-pin to the tag matching the installed package
#   scripts/update-subtree.sh --ref <ref>      # re-pin to an explicit branch/tag/commit
#
# --sync and --ref re-import the subtree instead of merging, so they can move a
# vendored repo backwards onto a released version.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
source "$repo_root/scripts/subtree-lib.sh"

all=0
sync=0
ref=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) all=1 ;;
    --sync) sync=1 ;;
    --ref)
      ref="${2:-}"
      [[ -z "$ref" ]] && {
        echo "error: --ref needs a value" >&2
        exit 1
      }
      shift
      ;;
    *)
      echo "usage: $(basename "$0") [--all] [--sync] [--ref <ref>]" >&2
      exit 1
      ;;
  esac
  shift
done

if [[ -n "$ref" && "$sync" == 1 ]]; then
  echo "error: --ref and --sync are mutually exclusive" >&2
  exit 1
fi

if [[ ! -f "$subtree_registry" ]]; then
  echo "error: registry not found at $subtree_registry" >&2
  exit 1
fi

if ! git diff-index --quiet HEAD --; then
  echo "error: working tree has uncommitted changes; commit or stash first" >&2
  exit 1
fi

entries="$(grep -v '^[[:space:]]*#' "$subtree_registry" | grep -v '^[[:space:]]*$' || true)"
if [[ -z "$entries" ]]; then
  echo "no subtrees registered" >&2
  exit 0
fi

if [[ "$all" == 1 ]]; then
  selection="$entries"
else
  if ! command -v fzf >/dev/null 2>&1; then
    echo "error: fzf is required for interactive mode; use --all to select everything" >&2
    exit 1
  fi
  selection="$(printf '%s\n' "$entries" | fzf \
    --multi \
    --delimiter=$'\t' \
    --with-nth=1 \
    --prompt='subtrees> ' \
    --header='TAB to multi-select, ENTER to confirm, ESC to cancel' \
    --preview='printf "url:     %s\nref:     %s\nversion: %s\n" {2} {3} {4}' \
    --preview-window=down:4:wrap)"
fi

if [[ -z "$selection" ]]; then
  echo "nothing selected" >&2
  exit 0
fi

fail=0
while IFS=$'\t' read -r prefix url registered_ref version_source; do
  [[ -z "$prefix" ]] && continue
  echo

  target="$ref"
  if [[ "$sync" == 1 ]]; then
    if [[ -z "$version_source" ]]; then
      echo ">> SKIP $prefix: no <package>=<tag-template> in the registry" >&2
      continue
    fi
    pkg="${version_source%%=*}"
    template="${version_source#*=}"
    version="$(subtree_installed_version "$pkg")"
    if [[ -z "$version" ]]; then
      echo ">> SKIP $prefix: $pkg is not installed" >&2
      continue
    fi
    if ! target="$(subtree_resolve_tag "$url" "$template" "$version")"; then
      echo ">> FAILED $prefix: no tag at or below ${template//\{v\}/$version}" >&2
      fail=1
      continue
    fi
    echo ">> $prefix: $pkg@$version -> $target (was $registered_ref)"
    if [[ "$target" == "$registered_ref" ]]; then
      echo ">> ok: $prefix already pinned to $target"
      continue
    fi
  fi

  if [[ -n "$target" ]]; then
    echo ">> re-pinning $prefix to $target from $url"
    if subtree_repin "$prefix" "$url" "$target" && subtree_registry_set_ref "$prefix" "$target"; then
      echo ">> ok: $prefix @ $target"
    else
      echo ">> FAILED: $prefix" >&2
      fail=1
    fi
    continue
  fi

  echo ">> pulling $prefix from $url ($registered_ref)"
  if git subtree pull --prefix="$prefix" "$url" "$registered_ref" --squash; then
    subtree_strip_gitlinks "$prefix"
    echo ">> ok: $prefix"
  else
    echo ">> FAILED: $prefix" >&2
    fail=1
  fi
done <<< "$selection"

exit "$fail"
