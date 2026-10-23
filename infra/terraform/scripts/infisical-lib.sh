#!/usr/bin/env bash
# Shared helpers for the Infisical scripts. Source this file after lib.sh.
# Never print a secret value. Values pass only through pipes and process
# memory. The Infisical token goes to curl through a header file
# descriptor, never through the command line (other users could see that in ps).
#
# Environment:
#   INFISICAL_TOKEN       access token of the "skynet-ops" machine identity
#                         (INFISICAL.md step 10). Required for API calls.
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
  [[ -n "${INFISICAL_TOKEN:-}" ]] || die "INFISICAL_TOKEN is not set (INFISICAL.md step 10)"
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

# The sync for <env> is named skynet-<env>-app (INFISICAL.md step 13).
sync_name() { echo "skynet-$1-app"; }

# Prints the sync JSON object (no secret values in it).
# Each step has an explicit check: errexit does not apply inside a command
# substitution, so a failed step must not look like an empty result.
get_sync() {
  need_project
  local out
  out="$(inf_api GET "/api/v1/secret-syncs/aws-secrets-manager/sync-name/$(sync_name "$1")?projectId=$INFISICAL_PROJECT_ID")" ||
    die "Infisical API call failed (sync $(sync_name "$1"))"
  jq -e '.secretSync' <<<"$out" 2>/dev/null || die "Infisical response has no sync $(sync_name "$1")"
}

# Prints the sorted key names of the Infisical environment <env>, root path,
# without values (viewSecretValue=false). Fails if the path has secret
# imports: the sync would add their keys, and this check would miss them.
infisical_key_names() {
  need_project
  local out imports names
  out="$(inf_api GET "/api/v4/secrets?projectId=$INFISICAL_PROJECT_ID&environment=$1&secretPath=%2F&viewSecretValue=false&expandSecretReferences=false&includeImports=true&recursive=false")" ||
    die "Infisical API call failed (environment $1)"
  imports="$(jq '.imports // [] | length' <<<"$out" 2>/dev/null)" ||
    die "unexpected Infisical response (environment $1)"
  [[ "$imports" == "0" ]] ||
    die "Infisical $1 / has secret imports; remove them (INFISICAL.md uses none)"
  names="$(jq -r '.secrets[].secretKey' <<<"$out" 2>/dev/null)" ||
    die "unexpected Infisical response (environment $1)"
  [[ -z "$names" ]] || LC_ALL=C sort <<<"$names"
}

# Prints the sorted key names of the Secrets Manager secret skynet/<env>/app.
# Args: env [stage (default AWSCURRENT)] [version-id (overrides the stage)].
# jq reads the value; only keys print.
# The jq error text is fixed and jq stderr is dropped: a jq message about a
# non-object value can quote part of that value.
sm_key_names() {
  local env="$1" stage="${2:-AWSCURRENT}" version="${3:-}" names sel
  sel=(--version-stage "$stage")
  [[ -z "$version" ]] || { sel=(--version-id "$version"); stage="$version"; }
  names="$(aws secretsmanager get-secret-value --secret-id "skynet/$env/app" "${sel[@]}" \
    --query SecretString --output text |
    jq -r 'if type == "object" then keys[] else error("not a JSON object") end' 2>/dev/null)" ||
    die "skynet/$env/app ($stage): cannot read it, or it is not a JSON object"
  [[ -z "$names" ]] || LC_ALL=C sort <<<"$names"
}

# Prints the ID of the last finished job of the sync for <env> (empty if none).
# Call it BEFORE the trigger, and give the result to wait_sync.
last_sync_job() {
  local s
  s="$(get_sync "$1")" || exit 1
  jq -r '.lastSyncJobId // ""' <<<"$s"
}

# Waits until a new sync job of <env> finishes (lastSyncJobId differs from
# <job-before>). Infisical v0.166.8 writes lastSyncJobId together with the
# final status (succeeded, or failed after the last retry), and it does not
# change lastSyncedAt on a failure. So the job ID shows the end of a run.
wait_sync() {
  local env="$1" before="$2" s status job msg=""
  for _ in $(seq 1 60); do
    s="$(get_sync "$env")" || exit 1
    status="$(jq -r '.syncStatus // ""' <<<"$s")"
    job="$(jq -r '.lastSyncJobId // ""' <<<"$s")"
    msg="$(jq -r '.lastSyncMessage // ""' <<<"$s" | head -c 300)"
    if [[ "$job" != "$before" ]]; then
      case "$status" in
        succeeded)
          echo "sync $(sync_name "$env"): succeeded at $(jq -r '.lastSyncedAt // "?"' <<<"$s") (job $job)"
          return 0
          ;;
        failed) die "sync $(sync_name "$env") failed (job $job): $msg" ;;
      esac
    fi
    sleep 5
  done
  die "sync $(sync_name "$env") did not finish in 5 minutes (status=$status, last message: ${msg:-none})"
}

# Prints the ECS services in skynet-<env> whose current task definition reads
# KEY from skynet/<env>/app ("*" = any key of that secret). Reads only the
# task definitions (secret ARNs and key names), never a value.
app_secret_users() {
  local env="$1" key="$2" cluster="skynet-$1" list s td tdj match
  list="$(aws ecs list-services --cluster "$cluster" --query 'serviceArns[]' --output text)" ||
    die "cannot list the services of $cluster"
  while IFS= read -r s; do
    [[ -n "$s" && "$s" != "None" ]] || continue
    td="$(aws ecs describe-services --cluster "$cluster" --services "$s" \
      --query 'services[0].taskDefinition' --output text)" || die "cannot describe service ${s##*/}"
    tdj="$(aws ecs describe-task-definition --task-definition "$td" --output json)" ||
      die "cannot describe task definition of ${s##*/}"
    match="$(jq --arg env "$env" --arg key "$key" '
        [.taskDefinition.containerDefinitions[].secrets[]?
         | select(.valueFrom | test(":secret:skynet/" + $env + "/app-"))
         | select($key == "*" or .name == $key or (.valueFrom | endswith(":" + $key + "::")))]
        | length > 0' <<<"$tdj")" || die "cannot read task definition of ${s##*/}"
    [[ "$match" != true ]] || echo "${s##*/}"
  done < <(tr '\t' '\n' <<<"$list")
}

# Forces a new deployment of the given services (new tasks read the current
# Secrets Manager value), waits until stable, then checks load balancer
# target health. Args: env service...
redeploy_and_check() {
  local env="$1" cluster="skynet-$1" s tg tgs bad
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
    tgs="$(aws ecs describe-services --cluster "$cluster" --services "$s" \
      --query 'services[0].loadBalancers[].targetGroupArn' --output text)" || die "cannot describe service $s"
    for tg in $tgs; do
      bad="$(aws elbv2 describe-target-health --target-group-arn "$tg" \
        --query "length(TargetHealthDescriptions[?TargetHealth.State!='healthy'])" --output text)"
      [[ "$bad" == "0" ]] || die "$s: $bad target(s) not healthy in ${tg##*/}"
      echo "$s: all targets healthy in ${tg##*:targetgroup/}"
    done
  done
}
