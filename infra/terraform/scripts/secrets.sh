#!/usr/bin/env bash
# Works with the hand-filled secrets skynet/<env>/{app,frontend,litellm}.
# It prints key NAMES only, never values.
#
#   secrets.sh template <env> <app|frontend|litellm>  > file.json
#       Prints a JSON object with every key the task definitions read, each
#       set to "". Fill the values in the file (keep it outside the repo).
#   secrets.sh put <env> <app|frontend|litellm> <file.json>
#       Stores the file as the secret value. Fails if a key is missing.
#   secrets.sh check <env>
#       Lists the keys that the task definitions read but the secrets lack.
#   secrets.sh check-empty <env>
#       Lists the keys of app, frontend and litellm whose value is empty or
#       only spaces (a template placeholder). Prints names only.
#
# The key list comes from the latest task definitions, so run Terraform first.

source "$(dirname "$0")/lib.sh"
need aws jq

cmd="${1:-}"
env="${2:-}"
check_env "$env"

# Families that read each secret.
families_for() {
  case "$1" in
    app) echo "backend worker migrate" ;;
    frontend) echo "frontend" ;;
    litellm) echo "litellm" ;;
    *) die "secret must be app, frontend or litellm" ;;
  esac
}

# Prints the sorted key names that task definitions read from skynet/<env>/<name>.
keys_for() {
  local name="$1" arn f
  arn="$(aws secretsmanager describe-secret --secret-id "skynet/$env/$name" --query ARN --output text)"
  for f in $(families_for "$name"); do
    aws ecs describe-task-definition --task-definition "skynet-$env-$f" \
      --query 'taskDefinition.containerDefinitions[0].secrets[].valueFrom' --output json |
      jq -r --arg a "$arn:" '.[] | select(startswith($a)) | ltrimstr($a) | split(":")[0]'
  done | sort -u
}

# Prints the key names that the stored secret value has (values are dropped in jq).
stored_keys() {
  aws secretsmanager get-secret-value --secret-id "skynet/$env/$1" --query SecretString --output text 2>/dev/null |
    jq -r 'keys[]' 2>/dev/null | sort -u || true
}

case "$cmd" in
  template)
    keys_for "${3:-}" | jq -R . | jq -s 'map({(.): ""}) | add'
    ;;
  put)
    name="${3:-}"
    file="${4:-}"
    [[ -f "$file" ]] || die "file not found: $file"
    jq -e 'type == "object" and all(.[]; type == "string")' "$file" >/dev/null ||
      die "$file must be a JSON object of string values"
    missing="$(comm -23 <(keys_for "$name") <(jq -r 'keys[]' "$file" | sort -u))"
    [[ -z "$missing" ]] || die "missing keys in $file: $(tr '\n' ' ' <<<"$missing")"
    aws secretsmanager put-secret-value --secret-id "skynet/$env/$name" \
      --secret-string "file://$file" --query VersionId --output text >/dev/null
    echo "stored skynet/$env/$name ($(jq 'length' "$file") keys)"
    ;;
  check)
    ok=1
    for name in app frontend litellm; do
      missing="$(comm -23 <(keys_for "$name") <(stored_keys "$name"))"
      if [[ -n "$missing" ]]; then
        ok=0
        echo "skynet/$env/$name is missing: $(tr '\n' ' ' <<<"$missing")"
      else
        echo "skynet/$env/$name: all keys present"
      fi
    done
    [[ "$ok" == 1 ]] || exit 1
    ;;
  check-empty)
    ok=1
    for name in app frontend litellm; do
      # jq stderr is dropped and the error text is fixed: a jq message can
      # quote part of a value.
      empty="$(aws secretsmanager get-secret-value --secret-id "skynet/$env/$name" \
        --query SecretString --output text |
        jq -r 'if type == "object" then to_entries[] | select(.value | tostring | test("^\\s*$")) | .key
               else error("not a JSON object") end' 2>/dev/null)" || {
        ok=0
        echo "skynet/$env/$name: cannot read it, or it is not a JSON object"
        continue
      }
      if [[ -n "$empty" ]]; then
        ok=0
        echo "skynet/$env/$name has empty values: $(sort <<<"$empty" | tr '\n' ' ')"
      else
        echo "skynet/$env/$name: no empty values"
      fi
    done
    [[ "$ok" == 1 ]] || exit 1
    ;;
  *)
    die "usage: secrets.sh template|put|check|check-empty <env> ..."
    ;;
esac
