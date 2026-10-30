#!/usr/bin/env bash
# Creates the database roles on the environment's RDS instance and enables
# pgvector in the app database. Safe to run again.
#   - skynet_app: owner of the skynet database. backend, worker and migrate
#     connect as this role (REMOTE_DB_URL), never as the RDS master.
#   - litellm: owner of the litellm database.
# Each role can connect only to its own database.
#
#   infra/terraform/scripts/create-db-roles.sh <staging|production>
#
# Runs inside the VPC as the one-off dbadmin task, as the RDS master. The task
# reads the passwords from Secrets Manager; nothing secret passes through
# this shell or the task command.

source "$(dirname "$0")/lib.sh"
need aws jq

env="${1:-}"
check_env "$env"

# psql variables (:'pw') keep the passwords out of the SQL text and the logs.
# The master must be a member of a role to give it a database.
read -r -d '' script <<'SH' || true
set -eu
psql -v ON_ERROR_STOP=1 -v app_pw="$APP_DB_PASSWORD" -v llm_pw="$LITELLM_DB_PASSWORD" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
SELECT 'CREATE ROLE skynet_app LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'skynet_app') \gexec
ALTER ROLE skynet_app WITH LOGIN PASSWORD :'app_pw';
GRANT skynet_app TO CURRENT_USER;
ALTER DATABASE skynet OWNER TO skynet_app;
REVOKE ALL ON DATABASE skynet FROM PUBLIC;
SELECT 'CREATE ROLE litellm LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'litellm') \gexec
ALTER ROLE litellm WITH LOGIN PASSWORD :'llm_pw';
GRANT litellm TO CURRENT_USER;
SELECT 'CREATE DATABASE litellm OWNER litellm' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm') \gexec
REVOKE ALL ON DATABASE litellm FROM PUBLIC;
GRANT CONNECT ON DATABASE litellm TO litellm;
SQL
echo "skynet_app and litellm roles ready; vector enabled in $PGDATABASE"
SH

overrides="$(jq -n --arg s "$script" '{containerOverrides: [{name: "dbadmin", command: ["sh", "-c", $s]}]}')"
task="$(run_task "$env" dbadmin "$overrides")"
echo "started $task"
wait_task_ok "$env" "$task"
echo "done. Output: CloudWatch log group /ecs/skynet-$env/dbadmin"
