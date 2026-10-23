#!/usr/bin/env bash
# Moves skynet/<env>/app back to an earlier Secrets Manager version, then
# redeploys the services that read it. No value is read or printed: the
# script moves only the AWSCURRENT label.
#
#   infra/terraform/scripts/secret-rollback.sh <env> [PRE_INFISICAL|AWSPREVIOUS]
#
# PRE_INFISICAL (default): the version before the first Infisical sync
#   (infisical-sync-guard.sh --enable sets this label).
# AWSPREVIOUS: the version before the last write.
#
# Disable the Infisical sync FIRST. Each sync writes a new version, so an
# enabled sync undoes the rollback. With INFISICAL_TOKEN set, the script
# checks this through the API. Without it, the script asks you to confirm.

source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/infisical-lib.sh"
need aws jq

env="${1:-}"
check_env "$env"
target="${2:-PRE_INFISICAL}"
case "$target" in
  PRE_INFISICAL | AWSPREVIOUS) ;;
  *) die "target must be PRE_INFISICAL or AWSPREVIOUS" ;;
esac
secret="skynet/$env/app"

if [[ -n "${INFISICAL_TOKEN:-}" && -n "${INFISICAL_PROJECT_ID:-}" ]]; then
  [[ "$(get_sync "$env" | jq -r .isAutoSyncEnabled)" == "false" ]] ||
    die "the sync $(sync_name "$env") is enabled. Disable it in Infisical first."
  echo "sync $(sync_name "$env") is disabled"
else
  read -r -p "Is the Infisical sync $(sync_name "$env") disabled? Type 'disabled': " answer
  [[ "$answer" == "disabled" ]] || die "disable the sync first"
fi

stages="$(aws secretsmanager describe-secret --secret-id "$secret" --output json | jq '.VersionIdsToStages')"
current="$(jq -r 'to_entries[] | select(.value | index("AWSCURRENT")) | .key' <<<"$stages")"
to="$(jq -r --arg t "$target" 'to_entries[] | select(.value | index($t)) | .key' <<<"$stages")"
[[ -n "$to" ]] || die "$secret has no version with label $target"
[[ "$to" != "$current" ]] || die "$target is already the current version ($to)"

echo "$secret: AWSCURRENT $current -> $to ($target)"
echo "key names now: $(sm_key_names "$env" | grep -c .); key names after: $(sm_key_names "$env" "$target" | grep -c .)"
read -r -p "Type '$env' to move AWSCURRENT: " answer
[[ "$answer" == "$env" ]] || die "not confirmed"

aws secretsmanager update-secret-version-stage --secret-id "$secret" \
  --version-stage AWSCURRENT --move-to-version-id "$to" --remove-from-version-id "$current" >/dev/null
echo "AWSCURRENT is now $to. The old current version is AWSPREVIOUS."

services=()
while IFS= read -r s; do
  [[ -n "$s" ]] && services+=("$s")
done < <(app_secret_users "$env" "*")
echo "services that read $secret: ${services[*]:-none}"
redeploy_and_check "$env" ${services[@]+"${services[@]}"}
echo "rollback done. Keep the sync disabled until the Infisical values are fixed."
