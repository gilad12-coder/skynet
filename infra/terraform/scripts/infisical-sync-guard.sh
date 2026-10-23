#!/usr/bin/env bash
# Guard for the first enable of the Infisical sync skynet-<env>-app.
# Infisical writes the WHOLE JSON of skynet/<env>/app from the Infisical
# environment (Many-To-One). A key that is only in Secrets Manager is dropped.
# This script refuses to enable the sync unless the key names match.
#
#   infra/terraform/scripts/infisical-sync-guard.sh <env>            check only
#   infra/terraform/scripts/infisical-sync-guard.sh <env> --enable   check, then enable
#   ... --enable --accept-changed-values   also allow keys whose values differ
#
# Checks (all must pass):
#   - the sync exists, is disabled, writes skynet/<env>/app in us-east-2,
#     Many-To-One;
#   - Infisical <env> "/" has no secret imports;
#   - the key NAMES in Infisical equal the key names in skynet/<env>/app;
#   - the values are equal, or --accept-changed-values is given (only the
#     NAMES of differing keys print).
# On --enable it also labels the current Secrets Manager version
# PRE_INFISICAL (kept until removed by hand), so secret-rollback.sh can go
# back to it after any number of syncs.
#
# Needs INFISICAL_TOKEN, INFISICAL_PROJECT_ID and the tunnel. Values stay in
# this process: they pass through bash variables and pipes into jq, never
# through the command line, a file or the terminal.

source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/infisical-lib.sh"
need aws jq curl
indent() { sed "s/^/  /"; }

env="${1:-}"
check_env "$env"
shift
enable=false
accept_values=false
for a in "$@"; do
  case "$a" in
    --enable) enable=true ;;
    --accept-changed-values) accept_values=true ;;
    *) die "unknown option: $a" ;;
  esac
done

secret="skynet/$env/app"
aws secretsmanager describe-secret --secret-id "$secret" --query Name --output text >/dev/null 2>&1 ||
  die "$secret does not exist. The sync role may not create it; apply the $env root first."

sync="$(get_sync "$env")"
sync_id="$(jq -r .id <<<"$sync")"
echo "sync: $(sync_name "$env") id=$sync_id"
jq -r '"  auto sync: \(.isAutoSyncEnabled)\n  environment: \(.environment.slug // "?") path: \(.folder.path // "?")\n  destination: \(.destinationConfig.secretName) region=\(.destinationConfig.region) mapping=\(.destinationConfig.mappingBehavior)\n  initial sync: \(.syncOptions.initialSyncBehavior)"' <<<"$sync"

fail=0
[[ "$(jq -r .isAutoSyncEnabled <<<"$sync")" == "false" ]] || {
  echo "FAIL: the sync is already enabled"
  fail=1
}
[[ "$(jq -r .destinationConfig.secretName <<<"$sync")" == "$secret" ]] || {
  echo "FAIL: destination secret is not $secret"
  fail=1
}
[[ "$(jq -r .destinationConfig.region <<<"$sync")" == "us-east-2" ]] || {
  echo "FAIL: destination region is not us-east-2"
  fail=1
}
[[ "$(jq -r .destinationConfig.mappingBehavior <<<"$sync")" == "many-to-one" ]] || {
  echo "FAIL: mapping is not many-to-one (one-to-one would create one secret per key)"
  fail=1
}
[[ "$(jq -r '.environment.slug // ""' <<<"$sync")" == "$env" ]] || {
  echo "FAIL: source environment is not $env"
  fail=1
}
[[ "$(jq -r '.folder.path // ""' <<<"$sync")" == "/" ]] || {
  echo "FAIL: source path is not /"
  fail=1
}

inf_keys="$(infisical_key_names "$env")"
sm_keys="$(sm_key_names "$env")"
only_inf="$(LC_ALL=C comm -23 <(echo "$inf_keys") <(echo "$sm_keys"))"
only_sm="$(LC_ALL=C comm -13 <(echo "$inf_keys") <(echo "$sm_keys"))"
echo "key names: Infisical=$(grep -c . <<<"$inf_keys") Secrets Manager=$(grep -c . <<<"$sm_keys")"
if [[ -n "$only_sm" ]]; then
  echo "FAIL: only in Secrets Manager (the sync would DROP these):"
  indent <<<"$only_sm"
  fail=1
fi
if [[ -n "$only_inf" ]]; then
  echo "FAIL: only in Infisical (the sync would ADD these):"
  indent <<<"$only_inf"
  fail=1
fi

if [[ "$fail" == 0 ]]; then
  # Compare values in jq. The sync writes every value as a JSON string, so
  # compare as strings. Only key names print.
  inf_json="$(inf_api GET "/api/v4/secrets?projectId=$INFISICAL_PROJECT_ID&environment=$env&secretPath=%2F&viewSecretValue=true&expandSecretReferences=true&includeImports=false&recursive=false" |
    jq -c '[.secrets[] | {key: .secretKey, value: .secretValue}] | from_entries')"
  sm_json="$(aws secretsmanager get-secret-value --secret-id "$secret" --query SecretString --output text)"
  changed="$({ printf '%s\n' "$inf_json"; printf '%s\n' "$sm_json"; } | jq -rs '
    .[0] as $i | .[1] as $s
    | $s | keys[]
    | select(($s[.] | if type == "string" then . else tojson end) != $i[.])')"
  non_string="$(printf '%s\n' "$sm_json" | jq -r 'to_entries[] | select(.value | type != "string") | .key')"
  unset inf_json sm_json
  if [[ -n "$non_string" ]]; then
    echo "note: these Secrets Manager values are not JSON strings; the sync writes them as strings:"
    indent <<<"$non_string"
  fi
  if [[ -n "$changed" ]]; then
    echo "values differ for $(grep -c . <<<"$changed") key(s) (names only):"
    indent <<<"$changed"
    if [[ "$accept_values" != true ]]; then
      echo "FAIL: a sync would change these values. Fix them in Infisical, or pass --accept-changed-values."
      fail=1
    fi
  else
    echo "values: all equal"
  fi
fi

[[ "$fail" == 0 ]] || die "guard failed; the sync stays disabled"
echo "guard passed"
[[ "$enable" == true ]] || {
  echo "check only. Run again with --enable to enable the sync."
  exit 0
}

# Keep the pre-sync version reachable after many syncs.
current="$(aws secretsmanager describe-secret --secret-id "$secret" --output json |
  jq -r '.VersionIdsToStages | to_entries[] | select(.value | index("AWSCURRENT")) | .key')"
labelled="$(aws secretsmanager describe-secret --secret-id "$secret" --output json |
  jq -r '.VersionIdsToStages | to_entries[] | select(.value | index("PRE_INFISICAL")) | .key')"
if [[ -z "$labelled" ]]; then
  aws secretsmanager update-secret-version-stage --secret-id "$secret" \
    --version-stage PRE_INFISICAL --move-to-version-id "$current" >/dev/null
  echo "labelled version $current PRE_INFISICAL"
else
  echo "PRE_INFISICAL already on version $labelled (kept)"
fi

read -r -p "Type '$env' to enable the sync for $secret: " answer
[[ "$answer" == "$env" ]] || die "not confirmed; the sync stays disabled"

since="$(date -u +%Y-%m-%dT%H:%M:%S)"
inf_api PATCH "/api/v1/secret-syncs/aws-secrets-manager/$sync_id" '{"isAutoSyncEnabled":true}' >/dev/null
echo "sync enabled; Infisical starts the first sync now"
wait_sync "$env" "$since"

after="$(sm_key_names "$env")"
if [[ "$after" != "$inf_keys" ]]; then
  echo "ERROR: key names differ after the sync. Roll back now:"
  echo "  infra/terraform/scripts/secret-rollback.sh $env PRE_INFISICAL"
  exit 1
fi
echo "after sync: skynet/$env/app has the same $(grep -c . <<<"$after") key names"
echo "Running tasks keep their old values until the next deployment (rotate-secret.sh or deploy.sh)."
