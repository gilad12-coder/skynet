#!/usr/bin/env bash
# Deploys one commit to one environment:
#   1. registers a new revision of every task family with the new image tag
#      (environment and secrets carry over from the latest revision),
#   2. runs `python manage.py migrate` as a one-off task and stops on failure,
#   3. updates the services and waits until they are stable.
#
#   infra/aws/scripts/deploy.sh <staging|production> <git-sha> [--migrate-only]
#
# Build and push the images first (scripts/build-push.sh).
# Rollback: run this script again with the previous SHA. Migrations do not
# roll back; write them so the previous release still runs on the new schema.

source "$(dirname "$0")/lib.sh"
need aws jq

env="${1:-}"
sha="${2:-}"
mode="${3:-}"
check_env "$env"
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || die "second argument must be a git SHA"

cfg="$(deploy_config "$env")"
cluster="$(jq -r .cluster <<<"$cfg")"
sfx="$(jq -r .frontend_tag_sfx <<<"$cfg")"

image_for() {
  case "$1" in
    backend | worker | migrate) echo "$(jq -r .ecr.backend <<<"$cfg"):$sha" ;;
    frontend) echo "$(jq -r .ecr.frontend <<<"$cfg"):$sha$sfx" ;;
    litellm) echo "$(jq -r .ecr.litellm <<<"$cfg"):$sha" ;;
  esac
}

for repo_tag in "backend:$sha" "litellm:$sha" "frontend:$sha$sfx"; do
  aws ecr describe-images --repository-name "skynet/${repo_tag%%:*}" --image-ids "imageTag=${repo_tag#*:}" >/dev/null 2>&1 ||
    die "image skynet/$repo_tag is not in ECR. Run scripts/build-push.sh first."
done

# Prints the new task definition ARN. (No associative arrays: macOS bash 3.2.)
register() {
  local family_key="$1" family image td
  family="$(jq -r --arg f "$family_key" '.families[$f]' <<<"$cfg")"
  image="$(image_for "$family_key")"
  td="$(aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json)"
  td="$(jq --arg img "$image" --arg sha "$sha" '
      .containerDefinitions[0].image = $img
      | .containerDefinitions[0].environment |= map(if .name == "APP_GIT_SHA" then .value = $sha else . end)
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
            .registeredAt, .registeredBy, .deregisteredAt)' <<<"$td")"
  td="$(aws ecs register-task-definition --cli-input-json "$td" \
    --query taskDefinition.taskDefinitionArn --output text)"
  echo "registered $td" >&2
  echo "$td"
}

register migrate >/dev/null
echo "running migration"
task="$(run_task "$env" migrate)"
wait_task_ok "$env" "$task"
echo "migration ok"

[[ "$mode" == "--migrate-only" ]] && exit 0

services=()
while IFS= read -r s; do services+=("$s"); done < <(jq -r '.services[]' <<<"$cfg")

for s in "${services[@]}"; do
  arn="$(register "$s")"
  aws ecs update-service --cluster "$cluster" --service "$s" \
    --task-definition "$arn" --query service.serviceName --output text >/dev/null
  echo "updating $s"
done

echo "waiting for services to become stable"
aws ecs wait services-stable --cluster "$cluster" --services "${services[@]}"
echo "deployed $sha to $env"
