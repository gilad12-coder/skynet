#!/usr/bin/env bash
# Rolls out one secret after a human changed its value in Infisical.
#   1. Triggers the Infisical sync skynet-<env>-app and waits for it.
#   2. Checks that skynet/<env>/app has KEY and the same key names as Infisical.
#   3. Forces a new ECS deployment of the services that read KEY, waits until
#      they are stable, and checks load balancer target health.
# It never reads, prints or changes a value. It changes no value in Infisical.
#
#   INFISICAL_TOKEN=... INFISICAL_PROJECT_ID=... \
#     infra/terraform/scripts/rotate-secret.sh <staging|production> <KEY>
#
# Open the tunnel first (scripts/infisical-tunnel.sh) in another terminal.
# The sync must be enabled (scripts/infisical-sync-guard.sh --enable).

source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/infisical-lib.sh"
need aws jq curl

env="${1:-}"
key="${2:-}"
check_env "$env"
[[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "usage: rotate-secret.sh <env> <KEY>"

sync="$(get_sync "$env")"
[[ "$(jq -r .isAutoSyncEnabled <<<"$sync")" == "true" ]] ||
  die "sync $(sync_name "$env") is disabled; run infisical-sync-guard.sh $env --enable first"
sync_id="$(jq -r .id <<<"$sync")"

inf_keys="$(infisical_key_names "$env")"
grep -qx "$key" <<<"$inf_keys" || die "$key is not in Infisical $env (root path)"

before="$(last_sync_job "$env")"
inf_api POST "/api/v1/secret-syncs/aws-secrets-manager/$sync_id/sync-secrets" >/dev/null
echo "sync $(sync_name "$env") triggered"
wait_sync "$env" "$before"

sm_keys="$(sm_key_names "$env")"
grep -qx "$key" <<<"$sm_keys" || die "$key is not in skynet/$env/app after the sync"
[[ "$inf_keys" == "$sm_keys" ]] || die "key names differ between Infisical and skynet/$env/app after the sync"
echo "skynet/$env/app: $(wc -l <<<"$sm_keys" | tr -d ' ') keys, same names as Infisical"

users="$(app_secret_users "$env" "$key")"
services=()
while IFS= read -r s; do [[ -n "$s" ]] && services+=("$s"); done <<<"$users"
echo "services that read $key: ${services[*]:-none}"
redeploy_and_check "$env" ${services[@]+"${services[@]}"}
echo "rotated $key in $env"
