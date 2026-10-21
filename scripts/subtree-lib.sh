#!/usr/bin/env bash
# Shared helpers for add-subtree.sh and update-subtree.sh. Sourced, not executed.
#
# Registry format: <prefix>\t<url>\t<ref>\t<package>=<tag-template>
# The fourth field is optional and drives `update-subtree.sh --sync`: <package>
# is looked up in pnpm-lock.yaml and its version substituted for {v} in
# <tag-template>, e.g. `payload=v{v}` -> `v3.86.0`.

subtree_registry=".agents/repos/.subtrees"

# git subtree imports upstream submodules as gitlinks, but the vendored
# .gitmodules paths are relative to the upstream root, so nothing here maps
# them. `git submodule foreach --recursive` — which actions/checkout runs when
# stripping credentials — then aborts and fails CI before anything is built.
# The gitlinks are empty directories, so drop them on every import.
subtree_strip_gitlinks() {
  local prefix="$1" links
  links="$(git ls-files -s -- "$prefix" | awk '$1 == "160000" { print $4 }')"
  [[ -z "$links" ]] && return 0
  while IFS= read -r link; do
    git rm -q --cached -- "$link"
    rm -rf -- "$link"
  done <<< "$links"
  git commit -q -m "chore: drop unresolvable gitlinks from $prefix" --no-verify
  echo ">> stripped $(grep -c '' <<< "$links") gitlink(s) from $prefix"
}

subtree_installed_version() {
  local pkg="$1"
  # Scoped names are quoted in pnpm-lock.yaml; peer suffixes follow the version.
  grep -oP "^  '?\Q${pkg}\E@\K[^(:']+" pnpm-lock.yaml | sort -V -u | tail -n1
}

# Best effort: the exact tag if upstream published it, otherwise the closest
# lower tag sharing the template's literal prefix.
subtree_resolve_tag() {
  local url="$1" template="$2" version="$3"
  local want="${template//\{v\}/$version}"

  if git ls-remote --exit-code --tags "$url" "refs/tags/$want" >/dev/null 2>&1; then
    printf '%s\n' "$want"
    return 0
  fi

  local literal="${template%%\{v\}*}" candidates best
  candidates="$(git ls-remote --tags --refs "$url" \
    | sed 's|.*refs/tags/||' \
    | awk -v p="$literal" 'index($0, p) == 1')"
  best="$(printf '%s\n%s\n' "$candidates" "$want" | sort -V | grep -x -F -B1 -- "$want" | head -n1)"

  [[ -z "$best" || "$best" == "$want" ]] && return 1
  printf '%s\n' "$best"
}

# `git subtree pull` only merges forward, so moving onto a version pin that is
# older than or unrelated to the current import has to re-import from scratch.
subtree_repin() {
  local prefix="$1" url="$2" ref="$3"
  if [[ -e "$prefix" ]]; then
    git rm -rq --cached -- "$prefix"
    rm -rf -- "$prefix"
    git commit -q -m "chore: drop $prefix before re-pinning to $ref" --no-verify
  fi
  git subtree add --prefix="$prefix" "$url" "$ref" --squash
  subtree_strip_gitlinks "$prefix"
}

subtree_registry_set_ref() {
  local prefix="$1" ref="$2" tmp
  tmp="$(mktemp)"
  awk -v p="$prefix" -v r="$ref" 'BEGIN { FS = OFS = "\t" } $1 == p { $3 = r } { print }' \
    "$subtree_registry" > "$tmp"
  mv "$tmp" "$subtree_registry"
  git add "$subtree_registry"
  git diff --cached --quiet -- "$subtree_registry" \
    || git commit -q -m "chore: pin $prefix to $ref" --no-verify
}
