#!/usr/bin/env bash
# Open (or show) the pull request that releases staging to production.
# Merge it with a merge commit, not a squash, so main and staging keep one
# history:  gh pr merge <number> --merge
set -euo pipefail

git fetch -q origin main staging

commits=$(git log --no-merges --format='- %s (%h)' origin/main..origin/staging)
if [ -z "$commits" ]; then
  echo "Nothing to release: production already has everything on staging."
  exit 0
fi

existing=$(gh pr list --base main --head staging --state open --json url --jq '.[0].url // empty')
if [ -n "$existing" ]; then
  echo "Release PR already open: $existing"
  exit 0
fi

gh pr create --base main --head staging \
  --title "release: staging to production ($(date +%Y-%m-%d))" \
  --body "$(printf 'Everything below was verified on staging.\n\n%s\n\nMerge with **Create a merge commit** so staging and main stay in sync.\n' "$commits")"
