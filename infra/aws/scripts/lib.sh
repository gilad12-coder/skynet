#!/usr/bin/env bash
# Shared helpers for the deploy scripts. Source this file; do not run it.
# Never print secret values here: these scripts handle secret names only.

set -euo pipefail

# Local runs use the `skynet` CLI profile; GitHub Actions uses OIDC credentials.
if [[ -z "${GITHUB_ACTIONS:-}" ]]; then
  export AWS_PROFILE="${AWS_PROFILE:-skynet}"
fi
export AWS_REGION="${AWS_REGION:-us-east-2}"
export AWS_PAGER=""

die() {
  echo "error: $*" >&2
  exit 1
}

need() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "missing command: $c"
  done
}

check_env() {
  case "${1:-}" in
    staging | production) ;;
    *) die "environment must be staging or production" ;;
  esac
}

# Prints the JSON that Terraform writes to SSM /skynet/<env>/deploy.
deploy_config() {
  aws ssm get-parameter --name "/skynet/$1/deploy" --query Parameter.Value --output text
}

# Runs a one-off task and waits for it to stop. Prints the task ARN.
# Args: env family [overrides-json]
run_task() {
  local env="$1" family="$2" overrides="${3:-}" cfg subnets sg cluster arn
  cfg="$(deploy_config "$env")"
  cluster="$(jq -r .cluster <<<"$cfg")"
  subnets="$(jq -r '.subnets | join(",")' <<<"$cfg")"
  sg="$(jq -r --arg f "$family" '.security_groups[$f]' <<<"$cfg")"
  local args=(
    --cluster "$cluster"
    --task-definition "$(jq -r --arg f "$family" '.families[$f]' <<<"$cfg")"
    --launch-type FARGATE
    --enable-execute-command
    --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sg],assignPublicIp=DISABLED}"
    --query 'tasks[0].taskArn' --output text
  )
  if [[ -n "$overrides" ]]; then
    args+=(--overrides "$overrides")
  fi
  arn="$(aws ecs run-task "${args[@]}")"
  [[ "$arn" == arn:* ]] || die "run-task did not start a task"
  echo "$arn"
}

# Waits for a task to stop and fails unless the container exit code is 0.
wait_task_ok() {
  local env="$1" arn="$2" cluster code reason
  cluster="$(deploy_config "$env" | jq -r .cluster)"
  # `aws ecs wait tasks-stopped` gives up after 10 minutes; migrations may run longer.
  local i status
  for ((i = 0; i < 360; i++)); do
    status="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$arn" --query 'tasks[0].lastStatus' --output text)"
    [[ "$status" == "STOPPED" ]] && break
    sleep 10
  done
  [[ "$status" == "STOPPED" ]] || die "task $arn still $status after 60 minutes"
  code="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$arn" --query 'tasks[0].containers[0].exitCode' --output text)"
  reason="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$arn" --query 'tasks[0].stoppedReason' --output text)"
  [[ "$code" == "0" ]] || die "task $arn failed (exit=$code, reason=$reason). Logs: CloudWatch /ecs/skynet-$env/*"
}
