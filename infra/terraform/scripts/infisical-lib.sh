#!/usr/bin/env bash
# Shared helpers for the Infisical scripts. Source this file after lib.sh.
# Never print a secret value. Values pass only through pipes and process
# memory. The Infisical token goes to curl through a header file
# descriptor, never through the command line (other users could see that in ps).
#
# Environment:
#   INFISICAL_TOKEN       access token of the "skynet-ops" machine identity
#                         (INFISICAL.md step 7). Required for API calls.
#   INFISICAL_PROJECT_ID  ID of the Infisical project "skynet". Required for API calls.
#   INFISICAL_API_URL     default http://localhost:18080 (open the tunnel first)

INFISICAL_API_URL="${INFISICAL_API_URL:-http://localhost:18080}"

# Prints the JSON that Terraform writes to SSM /skynet/infisical/config.
infisical_config() {
  aws ssm get-parameter --name /skynet/infisical/config --query Parameter.Value --output text
}

# Prints the private IP of the running Infisical task (empty if none).
infisical_task_ip() {
  local cluster="$1" service="$2" task
  task="$(aws ecs list-tasks --cluster "$cluster" --service-name "$service" --desired-status RUNNING \
    --query 'taskArns[0]' --output text)"
  [[ "$task" == arn:* ]] || return 0
  aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
    --query "tasks[0].attachments[0].details[?name=='privateIPv4Address'].value | [0]" --output text
}

# Calls the Infisical API. Prints the response body; fails on HTTP >= 400.
# Args: METHOD PATH [JSON-BODY]
# A body that holds a secret value must come on stdin: pass "@-" as JSON-BODY.
# A body given as an argument shows in the process list.
inf_api() {
  local method="$1" path="$2" body="${3:-}"
  [[ -n "${INFISICAL_TOKEN:-}" ]] || die "INFISICAL_TOKEN is not set (INFISICAL.md step 7)"
  local args=(--silent --show-error --fail-with-body --request "$method"
    --header @<(printf 'Authorization: Bearer %s\n' "$INFISICAL_TOKEN"))
  if [[ -n "$body" ]]; then
    args+=(--header "Content-Type: application/json" --data-binary "$body")
  fi
  curl "${args[@]}" "$INFISICAL_API_URL$path"
}

need_project() {
  [[ -n "${INFISICAL_PROJECT_ID:-}" ]] || die "INFISICAL_PROJECT_ID is not set"
}

# The sync for <env> is named skynet-<env>-app (INFISICAL.md step 8).
sync_name() { echo "skynet-$1-app"; }

# Prints the sync JSON object (no secret values in it).
get_sync() {
  need_project
  inf_api GET "/api/v1/secret-syncs/aws-secrets-manager/sync-name/$(sync_name "$1")?projectId=$INFISICAL_PROJECT_ID" |
    jq '.secretSync'
}

# Prints the sorted key names of the Infisical environment <env>, root path,
# without values (viewSecretValue=false). Fails if the path has secret
# imports: the sync would add their keys, and this check would miss them.
infisical_key_names() {
  need_project
  local out
  out="$(inf_api GET "/api/v4/secrets?projectId=$INFISICAL_PROJECT_ID&environment=$1&secretPath=%2F&viewSecretValue=false&expandSecretReferences=false&includeImports=true&recursive=false")"
  [[ "$(jq '.imports // [] | length' <<<"$out")" == "0" ]] ||
    die "Infisical $1 / has secret imports; remove them (INFISICAL.md uses none)"
  jq -r '.secrets[].secretKey' <<<"$out" | LC_ALL=C sort
}

# Prints the sorted key names of the Secrets Manager secret skynet/<env>/app
# (version stage default AWSCURRENT). jq reads the value; only keys print.
sm_key_names() {
  local env="$1" stage="${2:-AWSCURRENT}"
  aws secretsmanager get-secret-value --secret-id "skynet/$env/app" --version-stage "$stage" \
    --query SecretString --output text | jq -r 'keys[]' | LC_ALL=C sort
}

# Waits until the sync for <env> reports succeeded after <since> (ISO time).
wait_sync() {
  local env="$1" since="$2" s status synced msg
  for _ in $(seq 1 60); do
    s="$(get_sync "$env")"
    status="$(jq -r .syncStatus <<<"$s")"
    synced="$(jq -r '.lastSyncedAt // ""' <<<"$s")"
    if [[ "$status" == "succeeded" && "$synced" > "$since" ]]; then
      echo "sync $(sync_name "$env"): succeeded at $synced"
      return 0
    fi
    if [[ "$status" == "failed" && "$synced" > "$since" ]]; then
      msg="$(jq -r '.lastSyncMessage // ""' <<<"$s" | head -c 300)"
      die "sync $(sync_name "$env") failed: $msg"
    fi
    sleep 5
  done
  die "sync $(sync_name "$env") did not finish in 5 minutes (status=$status)"
}

# Prints the ECS services in skynet-<env> whose current task definition reads
# KEY from skynet/<env>/app ("*" = any key of that secret). Reads only the
# task definitions (secret ARNs and key names), never a value.
app_secret_users() {
  local env="$1" key="$2" cluster="skynet-$1" s td
  while IFS= read -r s; do
    [[ -n "$s" && "$s" != "None" ]] || continue
    td="$(aws ecs describe-services --cluster "$cluster" --services "$s" \
      --query 'services[0].taskDefinition' --output text)"
    if aws ecs describe-task-definition --task-definition "$td" --output json |
      jq -e --arg env "$env" --arg key "$key" '
        [.taskDefinition.containerDefinitions[].secrets[]?
         | select(.valueFrom | test(":secret:skynet/" + $env + "/app-"))
         | select($key == "*" or .name == $key or (.valueFrom | endswith(":" + $key + "::")))]
        | length > 0' >/dev/null; then
      echo "${s##*/}"
    fi
  done < <(aws ecs list-services --cluster "$cluster" --query 'serviceArns[]' --output text | tr '\t' '\n')
}

# Forces a new deployment of the given services (new tasks read the current
# Secrets Manager value), waits until stable, then checks load balancer
# target health. Args: env service...
redeploy_and_check() {
  local env="$1" cluster="skynet-$1" s tg bad
  shift
  [[ $# -gt 0 ]] || { echo "no service uses this secret key; nothing to redeploy"; return 0; }
  for s in "$@"; do
    aws ecs update-service --cluster "$cluster" --service "$s" --force-new-deployment \
      --query service.serviceName --output text >/dev/null
    echo "redeploying $s"
  done
  echo "waiting for services to become stable"
  aws ecs wait services-stable --cluster "$cluster" --services "$@"
  for s in "$@"; do
    for tg in $(aws ecs describe-services --cluster "$cluster" --services "$s" \
      --query 'services[0].loadBalancers[].targetGroupArn' --output text); do
      bad="$(aws elbv2 describe-target-health --target-group-arn "$tg" \
        --query "length(TargetHealthDescriptions[?TargetHealth.State!='healthy'])" --output text)"
      [[ "$bad" == "0" ]] || die "$s: $bad target(s) not healthy in ${tg##*/}"
      echo "$s: all targets healthy in ${tg##*:targetgroup/}"
    done
  done
}
