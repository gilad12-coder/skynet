#!/usr/bin/env bash
# Moves skynet/<env>/app back to an earlier Secrets Manager version, then
# redeploys the services that read it. No value is read or printed: the
# script moves only the AWSCURRENT label.
#
#   infra/terraform/scripts/secret-rollback.sh <env> [PRE_INFISICAL|AWSPREVIOUS|<version-id>]
#
# PRE_INFISICAL (default): the version before the first Infisical sync
#   (infisical-sync-guard.sh --enable sets this label).
# AWSPREVIOUS: the version before the last write. CAUTION: each Infisical
#   sync writes a new version, also when no value changed (Infisical v0.166.8
#   compares its default KMS alias with the KMS key ID that DescribeSecret
#   omits for the AWS managed key). After a sync with no change, AWSPREVIOUS
#   holds the same values as AWSCURRENT.
# <version-id>: an exact version. The script lists the versions (ID, date,
#   labels; never values) before it asks you to confirm.
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
  *)
    [[ "$target" =~ ^[A-Za-z0-9-]{32,64}$ ]] ||
      die "target must be PRE_INFISICAL, AWSPREVIOUS or a version ID"
    ;;
esac
secret="skynet/$env/app"

if [[ -n "${INFISICAL_TOKEN:-}" && -n "${INFISICAL_PROJECT_ID:-}" ]]; then
  sync_json="$(get_sync "$env")" || exit 1
  [[ "$(jq -r .isAutoSyncEnabled <<<"$sync_json")" == "false" ]] ||
    die "the sync $(sync_name "$env") is enabled. Disable it in Infisical first."
  echo "sync $(sync_name "$env") is disabled"
else
  read -r -p "Is the Infisical sync $(sync_name "$env") disabled? Type 'disabled': " answer
  [[ "$answer" == "disabled" ]] || die "disable the sync first"
fi

versions="$(aws secretsmanager list-secret-version-ids --secret-id "$secret" --include-deprecated --output json)"
echo "versions of $secret (newest first; IDs, dates and labels only):"
jq -r '.Versions | sort_by(.CreatedDate) | reverse[]
  | "  \(.VersionId)  \(.CreatedDate)  \((.VersionStages // []) | join(","))"' <<<"$versions"
current="$(jq -r '.Versions[] | select((.VersionStages // []) | index("AWSCURRENT")) | .VersionId' <<<"$versions")"
to="$(jq -r --arg t "$target" '.Versions[]
  | select(.VersionId == $t or ((.VersionStages // []) | index($t))) | .VersionId' <<<"$versions")"
[[ -n "$current" ]] || die "$secret has no AWSCURRENT version"
[[ -n "$to" ]] || die "$secret has no version with ID or label $target"
[[ "$to" != "$current" ]] || die "$target is already the current version ($to)"

now_names="$(sm_key_names "$env" "" "$current")"
to_names="$(sm_key_names "$env" "" "$to")"
echo "$secret: AWSCURRENT $current -> $to ($target)"
echo "key names now: $(grep -c . <<<"$now_names" || true); key names after: $(grep -c . <<<"$to_names" || true)"
read -r -p "Type '$env' to move AWSCURRENT: " answer
[[ "$answer" == "$env" ]] || die "not confirmed"

aws secretsmanager update-secret-version-stage --secret-id "$secret" \
  --version-stage AWSCURRENT --move-to-version-id "$to" --remove-from-version-id "$current" >/dev/null
echo "AWSCURRENT is now $to. The old current version is AWSPREVIOUS."

users="$(app_secret_users "$env" "*")"
services=()
while IFS= read -r s; do
  [[ -n "$s" ]] && services+=("$s")
done <<<"$users"
echo "services that read $secret: ${services[*]:-none}"
redeploy_and_check "$env" ${services[@]+"${services[@]}"}
echo "rollback done. Keep the sync disabled until the Infisical values are fixed."
