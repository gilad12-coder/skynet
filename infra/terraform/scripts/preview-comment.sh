#!/usr/bin/env bash
# Writes the preview status comment on a pull request (SKY-164). Each PR has
# one such comment; later runs edit it instead of adding new ones.
#
#   preview-comment.sh <pr> <body> [--update-only]
#
# --update-only edits the comment only if it exists (used when a preview is
# deleted, so PRs that never had a preview get no comment).
# Needs GH_TOKEN and GITHUB_REPOSITORY (set in GitHub Actions).

set -euo pipefail

pr="${1:?pr number}"
body="${2:?comment body}"
update_only="${3:-}"
marker="<!-- skynet-preview -->"

[[ "$pr" =~ ^[1-9][0-9]*$ ]] || {
  echo "error: PR number must be a positive integer" >&2
  exit 1
}

# The cla workflow locks a PR when it closes, so the delete job often finds
# the PR locked. A locked PR takes no comment; that is not a failure.
write() {
  gh api "$@" >/dev/null && return
  [[ "$(gh api "repos/$GITHUB_REPOSITORY/issues/$pr" --jq .locked)" == true ]] || return 1
  echo "::notice::PR #$pr is locked; the preview comment is not written."
}

id="$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$pr/comments" \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" |
  sed -n 1p)"

if [[ -n "$id" ]]; then
  write --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -f body="$marker"$'\n'"$body"
elif [[ "$update_only" != "--update-only" ]]; then
  write --method POST "repos/$GITHUB_REPOSITORY/issues/$pr/comments" -f body="$marker"$'\n'"$body"
fi
