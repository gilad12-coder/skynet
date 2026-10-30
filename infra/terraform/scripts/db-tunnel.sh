#!/usr/bin/env bash
# Forwards localhost:<port> to the environment's RDS instance through a
# dbadmin task (ECS Exec / SSM). The task stops itself after 4 hours.
#
#   infra/terraform/scripts/db-tunnel.sh <staging|production> [local-port=15432]
#
# Needs the Session Manager plugin: brew install --cask session-manager-plugin
# Press Ctrl-C to close the tunnel; the script then stops the task.

source "$(dirname "$0")/lib.sh"
need aws jq session-manager-plugin

env="${1:-}"
port="${2:-15432}"
check_env "$env"

cfg="$(deploy_config "$env")"
cluster="$(jq -r .cluster <<<"$cfg")"
db_host="$(aws rds describe-db-instances --db-instance-identifier "skynet-$env" \
  --query 'DBInstances[0].Endpoint.Address' --output text)"

task="$(run_task "$env" dbadmin)"
trap 'aws ecs stop-task --cluster "$cluster" --task "$task" --reason "tunnel closed" >/dev/null; echo "stopped $task"' EXIT
echo "started $task; waiting for it to run"
aws ecs wait tasks-running --cluster "$cluster" --tasks "$task"

task_id="${task##*/}"
runtime_id=""
for _ in $(seq 1 30); do
  runtime_id="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
    --query 'tasks[0].containers[0].runtimeId' --output text)"
  agent="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
    --query 'tasks[0].containers[0].managedAgents[?name==`ExecuteCommandAgent`].lastStatus | [0]' --output text)"
  [[ "$agent" == "RUNNING" && "$runtime_id" != "None" ]] && break
  sleep 5
done
[[ "$agent" == "RUNNING" ]] || die "ECS Exec agent did not start"

echo "tunnel: localhost:$port -> $db_host:5432"
echo "credentials: aws secretsmanager get-secret-value --secret-id skynet/$env/db-admin"
aws ssm start-session \
  --target "ecs:${cluster}_${task_id}_${runtime_id}" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$db_host\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$port\"]}"
