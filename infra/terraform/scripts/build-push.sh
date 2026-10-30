#!/usr/bin/env bash
# Builds the three images for linux/arm64 (Graviton) and pushes them to ECR.
#
#   infra/terraform/scripts/build-push.sh <staging|production> [git-sha]
#
# Tags: backend and litellm get <sha>; the frontend gets <sha>-<env>, because
# Next.js bakes NEXT_PUBLIC_* values into the bundle at build time.
# Tags are immutable in ECR, so an existing tag is skipped, not overwritten.
#
# Frontend build values come from the environment of this shell:
#   NEXT_PUBLIC_SENTRY_DSN, NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
#   NEXT_PUBLIC_FEATURE_GENERALIST_AGENT (optional)

source "$(dirname "$0")/lib.sh"
need aws docker git jq

env="${1:-}"
check_env "$env"
repo_root="$(git rev-parse --show-toplevel)"
sha="${2:-$(git -C "$repo_root" rev-parse HEAD)}"

case "$env" in
  staging) site_url="https://staging.skynetml.com" ;;
  production) site_url="https://skynetml.com" ;;
esac

# ECR URLs come from the global stack, so this runs before the environment exists.
cfg="$(aws ecr describe-repositories --repository-names skynet/backend skynet/frontend skynet/litellm \
  --query 'repositories[].[repositoryName,repositoryUri]' --output json |
  jq '{ecr: (map({key: (.[0] | ltrimstr("skynet/")), value: .[1]}) | from_entries)}')"
registry="$(jq -r '.ecr.backend' <<<"$cfg" | cut -d/ -f1)"
aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null

exists() {
  aws ecr describe-images --repository-name "$1" --image-ids "imageTag=$2" >/dev/null 2>&1
}

build() {
  local name="$1" tag="$2" context="$3"
  shift 3
  local url
  url="$(jq -r --arg n "$name" '.ecr[$n]' <<<"$cfg")"
  if exists "skynet/$name" "$tag"; then
    echo "skip: $url:$tag exists"
    return
  fi
  docker buildx build --platform linux/arm64 --provenance=false \
    -t "$url:$tag" --push "$@" "$context"
}

build backend "$sha" "$repo_root/backend" --build-arg "GIT_SHA=$sha"
build litellm "$sha" "$repo_root/deploy/litellm"

build frontend "$sha-$env" "$repo_root/frontend" \
  --build-arg "NEXT_PUBLIC_SITE_URL=$site_url" \
  --build-arg "NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN:-}" \
  --build-arg "NEXT_PUBLIC_SENTRY_ENVIRONMENT=$env" \
  --build-arg "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=${NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE:-}" \
  --build-arg "NEXT_PUBLIC_FEATURE_GENERALIST_AGENT=${NEXT_PUBLIC_FEATURE_GENERALIST_AGENT:-}" \
  --build-arg "APP_GIT_SHA=$sha" \
  --build-arg "APP_ENVIRONMENT=$env"

echo "pushed: backend:$sha litellm:$sha frontend:$sha-$env"
