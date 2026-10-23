#!/usr/bin/env bash
# Opens Infisical at http://localhost:18080 (its SITE_URL). It starts a tunnel
# task (no secrets, stops itself after 4 hours) in the Infisical cluster and
# forwards localhost:18080 through it to the Infisical task on port 8080.
# The Infisical task has no public IP and no ECS Exec.
#
#   infra/terraform/scripts/infisical-tunnel.sh
#
# Needs the Session Manager plugin: brew install --cask session-manager-plugin
# Press Ctrl-C to close the tunnel; the script then stops the tunnel task.
# Use port 18080 only: SITE_URL is http://localhost:18080, and the login
# cookies and email links use it.

source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/infisical-lib.sh"
need aws jq session-manager-plugin

cfg="$(infisical_config)"
cluster="$(jq -r .cluster <<<"$cfg")"
service="$(jq -r .service <<<"$cfg")"
port="$(jq -r .tunnel_port <<<"$cfg")"
remote_port="$(jq -r .infisical_port <<<"$cfg")"

ip="$(infisical_task_ip "$cluster" "$service")"
[[ -n "$ip" ]] || die "no running Infisical task (service desired count 0? see INFISICAL.md step 3)"

subnets="$(jq -r '.subnets | join(",")' <<<"$cfg")"
sg="$(jq -r .tunnel_sg <<<"$cfg")"
task="$(aws ecs run-task \
  --cluster "$cluster" \
  --task-definition "$(jq -r .tunnel_family <<<"$cfg")" \
  --launch-type FARGATE \
  --enable-execute-command \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sg],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)"
[[ "$task" == arn:* ]] || die "run-task did not start the tunnel task"
trap 'aws ecs stop-task --cluster "$cluster" --task "$task" --reason "tunnel closed" >/dev/null; echo "stopped $task"' EXIT
echo "started $task; waiting for it to run"
aws ecs wait tasks-running --cluster "$cluster" --tasks "$task"

task_id="${task##*/}"
runtime_id=""
agent=""
for _ in $(seq 1 30); do
  runtime_id="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
    --query 'tasks[0].containers[0].runtimeId' --output text)"
  agent="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
    --query "tasks[0].containers[0].managedAgents[?name=='ExecuteCommandAgent'].lastStatus | [0]" --output text)"
  [[ "$agent" == "RUNNING" && "$runtime_id" != "None" ]] && break
  sleep 5
done
[[ "$agent" == "RUNNING" ]] || die "ECS Exec agent did not start"

echo "tunnel: http://localhost:$port -> Infisical $ip:$remote_port"
aws ssm start-session \
  --target "ecs:${cluster}_${task_id}_${runtime_id}" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$ip\"],\"portNumber\":[\"$remote_port\"],\"localPortNumber\":[\"$port\"]}"
