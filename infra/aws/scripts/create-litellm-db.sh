#!/usr/bin/env bash
# Creates the litellm role and database on the environment's RDS instance and
# enables pgvector in the app database. Safe to run again.
#
#   infra/aws/scripts/create-litellm-db.sh <staging|production>
#
# Runs inside the VPC as the one-off dbadmin task. The task reads the master
# and litellm passwords from Secrets Manager; nothing secret passes through
# this shell or the task command.

source "$(dirname "$0")/lib.sh"
need aws jq

env="${1:-}"
check_env "$env"

# psql variables (:'pw') keep the password out of the SQL text and the logs.
read -r -d '' script <<'SH' || true
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$LITELLM_DB_PASSWORD" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
SELECT 'CREATE ROLE litellm LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'litellm') \gexec
ALTER ROLE litellm WITH LOGIN PASSWORD :'pw';
GRANT litellm TO CURRENT_USER;
SELECT 'CREATE DATABASE litellm OWNER litellm' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm') \gexec
REVOKE ALL ON DATABASE litellm FROM PUBLIC;
GRANT CONNECT ON DATABASE litellm TO litellm;
REVOKE CONNECT ON DATABASE skynet FROM PUBLIC;
SQL
echo "litellm role and database ready; vector enabled in $PGDATABASE"
SH

overrides="$(jq -n --arg s "$script" '{containerOverrides: [{name: "dbadmin", command: ["sh", "-c", $s]}]}')"
task="$(run_task "$env" dbadmin "$overrides")"
echo "started $task"
wait_task_ok "$env" "$task"
echo "done. Output: CloudWatch log group /ecs/skynet-$env/dbadmin"
