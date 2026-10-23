#!/usr/bin/env bash
# Copies every key of skynet/<env>/app (AWSCURRENT) into the Infisical
# environment <env>, path "/". Values go from the AWS call through jq to curl
# on stdin; they are never printed, put on a command line or written to a file.
#
#   infra/terraform/scripts/infisical-import.sh <env>
#
# Refuses when the Infisical environment already has secrets, so it never
# overwrites an Infisical value. Infisical trims spaces at the start and end
# of each value; infisical-sync-guard.sh then reports that key as changed.
# Needs INFISICAL_TOKEN, INFISICAL_PROJECT_ID and the tunnel.

source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/infisical-lib.sh"
need aws jq curl

env="${1:-}"
check_env "$env"
need_project

existing="$(infisical_key_names "$env" | grep -c . || true)"
[[ "$existing" == "0" ]] || die "Infisical $env / already has $existing secret(s); this script only fills an empty environment"

count="$(sm_key_names "$env" | grep -c . || true)"
[[ "$count" -gt 0 ]] || die "skynet/$env/app has no keys"

aws secretsmanager get-secret-value --secret-id "skynet/$env/app" --query SecretString --output text |
  jq -c --arg p "$INFISICAL_PROJECT_ID" --arg e "$env" '{
    projectId: $p, environment: $e, secretPath: "/",
    secrets: [to_entries[] | {secretKey: .key, secretValue: (.value | if type == "string" then . else tojson end)}]
  }' |
  inf_api POST /api/v4/secrets/batch @- | jq -r '"imported \(.secrets | length) secret(s) (names only below)", (.secrets[].secretKey)'
echo "skynet/$env/app had $count key(s). Next: infisical-sync-guard.sh $env"
